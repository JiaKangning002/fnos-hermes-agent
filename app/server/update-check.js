// ─── 应用包版本更新检查 ─────────────────────────────────────────────────
// 提供 GET /api/update/check 的核心逻辑：读取本地应用包版本（区别于
// hermes 引擎版本），从 GitHub Releases 获取最新发布版本并逐段比较。
// 工厂式设计，fetch/时钟可注入以便测试。
// 实时查询模式：移除成功结果缓存，每次请求都带时间戳 + no-cache 头；仅失败态短缓存 5 分钟。

import { readFileSync, existsSync, writeFileSync } from "fs";

// 在线数据源：GitHub Releases API
const RELEASES_LIST_URL = "https://api.github.com/repos/iranee/fnos-hermes-agent/releases?per_page=1";
const RELEASES_LATEST_URL = "https://api.github.com/repos/iranee/fnos-hermes-agent/releases/latest";
const FETCH_TIMEOUT_MS = 5000;
const FAIL_CACHE_TTL_MS = 300000; // 失败/404 短缓存 5 分钟（防匿名限流）

/** GitHub 统一请求头 */
const GH_HEADERS = {
  "User-Agent": "fnos-hermes-agent/update-check",
  "Accept": "application/vnd.github+json",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache"
};

/** 为 URL 追加时间戳参数，避开 CDN/代理缓存 */
function addTimestampParam(url) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}_t=${Date.now()}`;
}

/**
 * 逐段数字比较版本号，"." 与 "-" 均视为段分隔（支持 0.20.27-3 后缀段）。
 * 返回 1（a>b）/ -1（a<b）/ 0（相等）；缺段按 0 补齐；非数字段按字符串比较。
 */
export function compareVersions(a, b) {
  const segs = (v) => String(v || "").trim().replace(/^v/i, "").split(/[.\-]/);
  const sa = segs(a), sb = segs(b);
  const len = Math.max(sa.length, sb.length);
  for (let i = 0; i < len; i++) {
    const x = sa[i] ?? "0", y = sb[i] ?? "0";
    const nx = Number(x), ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx > ny ? 1 : -1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

/** 从 fnOS manifest 文本解析 version 字段值，解析失败返回 null */
export function parseManifestVersion(text) {
  const m = String(text || "").match(/^version\s*=\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

/** 从 app-version.env 文本解析 APP_VERSION 值，解析失败返回 null */
export function parseAppVersionEnv(text) {
  const m = String(text || "").match(/^APP_VERSION\s*=\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

/** 从 GitHub Release 响应 JSON 提取版本号（tag_name 支持多种前缀格式），无效返回 null */
export function parseReleaseTag(data) {
  const tag = String((data && data.tag_name) || "").trim();
  if (!tag) return null;
  return tag.replace(/^(fnos-hermes-agent_)?v/i, "") || null;
}

/**
 * 创建更新检查器
 * @param {{ appDir: string, log?: Function, fetchFn?: Function, nowFn?: Function, cacheFile?: string }} opts
 *   appDir: 应用部署根目录（TRIM_APPDEST，含 config/bootstrap/）
 *   cacheFile: 持久化“上次成功获取的在线版本”的文件路径（可写，如 VAR_DIR/update-latest.txt）
 *   fetchFn/nowFn: 测试注入用，缺省为全局 fetch / Date.now
 */
export function createUpdateChecker({ appDir, log, fetchFn, nowFn, cacheFile }) {
  const logFn = log || (() => {});
  const doFetch = fetchFn || ((url, init) => fetch(url, init));
  const now = nowFn || (() => Date.now());

  let localVersion = null;   // 首次读取后缓存（安装期内不变）
  let failCachedKind = null; // 短缓存的失败态："none"（404 无发布）/ "fail"（网络/其他失败）
  let failCachedAt = 0;      // 失败态缓存时间戳
  // 上次成功获取的在线版本：成功即保存，失败时回退显示，直到下次成功才更新
  let lastGoodLatest = null;

  // 启动时从缓存文件恢复上次成功的在线版本（跨重启保留）
  if (cacheFile) {
    try {
      if (existsSync(cacheFile)) {
        const v = readFileSync(cacheFile, "utf8").trim();
        if (v) lastGoodLatest = v;
      }
    } catch {}
  }

  // 持久化上次成功版本到缓存文件（失败不阻断流程）
  function persistLastGood(v) {
    if (!cacheFile || !v) return;
    try { writeFileSync(cacheFile, v, { mode: 0o644 }); } catch (e) {
      logFn(`[update-check] 写入在线版本缓存失败: ${e?.message || e}`);
    }
  }

  // 本地版本来源：优先部署态 config/bootstrap/app-version.env，
  // 开发态回退仓库根 manifest（appDir 为 <repo>/app 时其上级存在 manifest）
  function getLocalVersion() {
    if (localVersion) return localVersion;
    const sources = [
      { path: `${appDir}/config/bootstrap/app-version.env`, parse: parseAppVersionEnv },
      { path: `${appDir}/../manifest`, parse: parseManifestVersion },
    ];
    for (const s of sources) {
      try {
        if (!existsSync(s.path)) continue;
        const v = s.parse(readFileSync(s.path, "utf8"));
        if (v) { localVersion = v; return v; }
      } catch {}
    }
    return "unknown";
  }

  // 获取远端最新版本：返回 { latest, kind }
  //   kind: "ok"（新获取）/ "cached"（回退上次成功值）/ "none"（404 且无历史值）/ "fail"（失败且无历史值）
  //   成功即保存并持久化；失败/404 时若有上次成功值则回退显示，否则短缓存 5 分钟
  async function fetchLatest({ bypassCache = false } = {}) {
    const t = now();
    if (!bypassCache && failCachedKind && t - failCachedAt < FAIL_CACHE_TTL_MS) {
      // 失败短缓存期内：有上次成功值仍优先回退显示，避免“未获取”
      if (lastGoodLatest) return { latest: lastGoodLatest, kind: "cached" };
      return { latest: null, kind: failCachedKind };
    }
    try {
      // 实时查询：先尝试列表端点，再兜底到最新版；追加时间戳 bypass CDN
      let version = null;
      let attemptList = false;
      
      // 尝试 RELEASES_LIST_URL (first page)
      try {
        attemptList = true;
        const listR = await doFetch(addTimestampParam(RELEASES_LIST_URL), {
          headers: GH_HEADERS,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        });
        if (listR.ok) {
          const json = await listR.json();
          if (Array.isArray(json) && json.length > 0) {
            version = parseReleaseTag(json[0]);
          }
        }
      } catch (e) {
        logFn(`[update-check] 列表端点失败，将尝试兜底：${e?.message || e}`);
      }
      
      // 若列表为空或非 2xx，兜底到 RELEASES_LATEST_URL
      if (!version) {
        const latestR = await doFetch(addTimestampParam(RELEASES_LATEST_URL), {
          headers: GH_HEADERS,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        });
        if (latestR.status === 404) {
          failCachedKind = "none"; failCachedAt = now();
          // 404 无发布：若有上次成功值仍回退显示
          if (lastGoodLatest) return { latest: lastGoodLatest, kind: "cached" };
          return { latest: null, kind: "none" };
        }
        if (!latestR.ok) throw new Error(`HTTP ${latestR.status}`);
        version = parseReleaseTag(await latestR.json());
      }
      
      if (!version) throw new Error("release 无有效 tag_name");
      failCachedKind = null;
      // 成功：更新并持久化上次成功版本
      lastGoodLatest = version;
      persistLastGood(version);
      return { latest: version, kind: "ok" };
    } catch (e) {
      logFn(`[update-check] 获取远端版本失败: ${e?.message || e}`);
      failCachedKind = "fail"; failCachedAt = now();
      // 失败：若有上次成功值则回退显示，否则才报失败
      if (lastGoodLatest) return { latest: lastGoodLatest, kind: "cached" };
      return { latest: null, kind: "fail" };
    }
  }

  // 检查更新：本地版本始终返回；ok 恒为 true；
  //   成功/回退→latest/has_update；404无历史→latest:null 无 error；失败无历史→latest:null + error 标记
  async function check({ force = false } = {}) {
    const local = getLocalVersion();
    const { latest, kind } = await fetchLatest({ bypassCache: force });
    const has_update = !!(latest && local !== "unknown" && compareVersions(latest, local) > 0);
    const out = { ok: true, local, latest, has_update, checked_at: now(), force_checked: !!force };
    if (kind === "cached") out.cached = true; // 回退展示上次成功值（非本次新获取）
    if (kind === "fail") out.error = "fetch_failed";
    return out;
  }

  return { getLocalVersion, check };
}
