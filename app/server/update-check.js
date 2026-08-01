// ─── 应用包版本更新检查 ─────────────────────────────────────────────────
// 提供 GET /api/update/check 的核心逻辑：读取本地应用包版本（区别于
// hermes 引擎版本），从 GitHub Releases 获取最新正式发布版本并逐段比较。
// 工厂式设计，fetch/时钟可注入以便测试。

import { readFileSync, existsSync } from "fs";

// 在线数据源：GitHub Releases API（以正式发布为准）与请求/缓存参数
const RELEASES_LATEST_URL = "https://api.github.com/repos/iranee/fnos-hermes-agent/releases/latest";
const FETCH_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 3600000;     // 成功结果缓存 1 小时
const FAIL_CACHE_TTL_MS = 300000; // 失败/404 短缓存 5 分钟（防匿名限流 60 次/小时被打爆）

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

/** 从 GitHub Release 响应 JSON 提取版本号（tag_name 剥离 v/V 前缀），无效返回 null */
export function parseReleaseTag(data) {
  const tag = String((data && data.tag_name) || "").trim();
  if (!tag) return null;
  return tag.replace(/^v/i, "") || null;
}

/**
 * 创建更新检查器
 * @param {{ appDir: string, log?: Function, fetchFn?: Function, nowFn?: Function }} opts
 *   appDir: 应用部署根目录（TRIM_APPDEST，含 config/bootstrap/）
 *   fetchFn/nowFn: 测试注入用，缺省为全局 fetch / Date.now
 */
export function createUpdateChecker({ appDir, log, fetchFn, nowFn }) {
  const logFn = log || (() => {});
  const doFetch = fetchFn || ((url, init) => fetch(url, init));
  const now = nowFn || (() => Date.now());

  let localVersion = null;   // 首次读取后缓存（安装期内不变）
  let cachedLatest = null;   // 上次成功获取的最新版本
  let cachedAt = 0;          // 上次成功获取的时间戳
  let failCachedKind = null; // 短缓存的失败态："none"（404 无发布）/ "fail"（网络/其他失败）
  let failCachedAt = 0;      // 失败态缓存时间戳

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
  //   kind: "ok"（成功，命中 1h 缓存或新获取）/ "none"（404 暂无正式发布）/ "fail"（失败）
  //   失败与 404 均短缓存 5 分钟，避免频繁重试打爆匿名限流
  async function fetchLatest() {
    const t = now();
    if (cachedLatest && t - cachedAt < CACHE_TTL_MS) return { latest: cachedLatest, kind: "ok" };
    if (failCachedKind && t - failCachedAt < FAIL_CACHE_TTL_MS) return { latest: null, kind: failCachedKind };
    try {
      const r = await doFetch(RELEASES_LATEST_URL, {
        headers: {
          "User-Agent": "fnos-hermes-agent-update-check",
          "Accept": "application/vnd.github+json",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (r.status === 404) {
        // 仓库暂无正式 release：视为暂无可比版本，非错误
        failCachedKind = "none"; failCachedAt = now();
        return { latest: null, kind: "none" };
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const v = parseReleaseTag(await r.json());
      if (!v) throw new Error("release 无有效 tag_name");
      cachedLatest = v;
      cachedAt = now();
      failCachedKind = null;
      return { latest: v, kind: "ok" };
    } catch (e) {
      logFn(`[update-check] 获取远端版本失败: ${e?.message || e}`);
      failCachedKind = "fail"; failCachedAt = now();
      return { latest: null, kind: "fail" };
    }
  }

  // 检查更新：本地版本始终返回；ok 恒为 true；
  //   成功→latest/has_update；404→latest:null 无 error；失败→latest:null + error 标记
  async function check() {
    const local = getLocalVersion();
    const { latest, kind } = await fetchLatest();
    const has_update = !!(latest && local !== "unknown" && compareVersions(latest, local) > 0);
    const out = { ok: true, local, latest, has_update, checked_at: now() };
    if (kind === "fail") out.error = "fetch_failed";
    return out;
  }

  return { getLocalVersion, check };
}
