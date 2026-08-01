// fallback-config.js — 模型回退（config.yaml 顶层 fallback_providers）配置读写模块
// 职责：解析 / 生成 / 替换 config.yaml 顶层 fallback_providers 块，并把回退服务商的
// API key 同步到网关 .env（网关触发回退时按 key_env / 内置环境变量读取真实 key）。
import { readFileSync, writeFileSync, existsSync } from "fs";
import { PROVIDER_PRESETS, PROVIDER_API_KEYS, PROVIDER_HERMES_IDS } from "./provider-config.js";
import { customEnvKey, legacyCustomEnvKey, yamlScalar } from "./config-utils.js";

// 可直接作为网关内置回退服务商的面板 provider id 白名单：
// 这些 id 网关原生认识，条目直接写 provider: <hermes_id> + model；
// 其余（B 类 / custom-* / 不在名单的 A 类 / local-*）一律降级为 custom 形态
// （provider: custom + model + base_url + key_env），保守策略保证条目可用。
const FALLBACK_NATIVE_IDS = new Set([
  "zai", "kimi-coding", "kimi-coding-cn", "minimax", "minimax-cn", "openrouter",
]);

// 回退服务商环境变量名：内置服务商查 PROVIDER_API_KEYS，非内置走 custom 规则；local-* 无鉴权返回空
function fallbackEnvKey(id) {
  if (String(id).indexOf("local-") === 0) return "";
  return PROVIDER_API_KEYS[id] || customEnvKey(id);
}

// ── 解析 config.yaml 顶层 fallback_providers 块 → 面板 provider id 数组 ─────
// 兼容两种形态：单行空列表 `fallback_providers: []` 与多行列表块。
// 面板 id 优先取写入时附带的 `# panel:<id>` 注释；无注释时若 provider 值
// 恰好是白名单内置服务商 id 则直接采用，否则该条目无法反查、跳过。
export function parseFallback(yamlContent) {
  const lines = String(yamlContent || "").split("\n");
  const ids = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^fallback_providers:/.test(lines[i])) continue;
    // 单行形态：fallback_providers: []（含尾随空白/注释）
    if (/^fallback_providers:\s*\[\s*\]\s*(#.*)?$/.test(lines[i])) return [];
    // 多行块形态：吃掉后续缩进行与顶格 "- " 列表项行
    for (let j = i + 1; j < lines.length; j++) {
      const ln = lines[j];
      if (!(/^[ \t]/.test(ln) || /^- /.test(ln))) break;
      const pm = ln.match(/#\s*panel:([A-Za-z0-9_-]+)/);
      if (pm) {
        if (ids.indexOf(pm[1]) === -1) ids.push(pm[1]);
        continue;
      }
      const provM = ln.match(/^[-\s]*provider:\s*([A-Za-z0-9._-]+)\s*$/);
      if (provM && FALLBACK_NATIVE_IDS.has(provM[1]) && ids.indexOf(provM[1]) === -1) {
        ids.push(provM[1]);
      }
    }
    break;
  }
  return ids;
}

// ── 生成 fallback_providers YAML 块 ────────────────────────────────────────
// entries: 面板 provider id 数组（首期单选，调用方已截断为最多 1 项）；
// provState: { <id>: { model, base_url, ... } }（monitor.js 的 allProvConfig 形态）。
// 每个条目末尾附 `# panel:<id>` 注释供 parseFallback 回读反查。
export function buildFallbackBlock(entries, provState) {
  const items = (entries || [])
    .map((id) => {
      const cfg = (provState && provState[id]) || {};
      const model = cfg.model || "auto";
      if (FALLBACK_NATIVE_IDS.has(id)) {
        const hermesId = PROVIDER_HERMES_IDS[id] || id;
        return `- provider: ${yamlScalar(hermesId)}  # panel:${id}\n` +
               `  model: ${yamlScalar(model)}`;
      }
      // custom 形态：base_url 取面板保存值，缺省回落到内置预设默认地址
      const baseUrl = String(cfg.base_url || (PROVIDER_PRESETS[id] ? PROVIDER_PRESETS[id].base_url : "") || "").trim();
      if (!baseUrl) return null;   // 无法构造有效端点，跳过该条目
      let entry = `- provider: custom  # panel:${id}\n` +
                  `  model: ${yamlScalar(model)}\n` +
                  `  base_url: ${yamlScalar(baseUrl)}`;
      const envKey = fallbackEnvKey(id);   // local-* 本地端点无鉴权，省略 key_env
      if (envKey) entry += `\n  key_env: ${envKey}`;
      return entry;
    })
    .filter(Boolean);
  if (items.length === 0) return "fallback_providers: []\n";
  return `fallback_providers:\n${items.join("\n")}\n`;
}

// ── 把 fallback_providers 块替换 / 插入到 config.yaml 文本 ─────────────────
// 手法与 monitor.js providers 段一致：定位顶层键 → 吃掉块内行 → 整块替换；
// 键不存在时插到 model / providers 段之后。写入前后做正则自检，异常时
// 原样返回旧内容，绝不写坏 config.yaml。
export function applyFallbackToYaml(ymlContent, block) {
  const src = String(ymlContent == null ? "" : ymlContent);
  const blk = String(block || "fallback_providers: []\n");
  const lines = src.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf("fallback_providers:") === 0) { start = i; break; }
  }
  let out;
  if (start >= 0) {
    // 吃掉块内行：缩进行 + 顶格 "- " 列表项行（兼容 [] 单行形态——此时块内行数为 0）
    let end = start + 1;
    while (end < lines.length && (/^[ \t]/.test(lines[end]) || /^- /.test(lines[end]))) end++;
    const before = lines.slice(0, start).join("\n");
    const after = lines.slice(end).join("\n");
    out = (before ? before + "\n" : "") + blk + after;
  } else {
    // 键不存在：优先插到 providers 段之后，其次 model 段之后，最后追加文件末尾
    const anchorRe = /(^providers:[\t ]*\n(?:(?:[\t ]+[^\n]*|)\n)*)/m;
    const modelRe = /(^model:[\t ]*\n(?:[\t ]+[^\n]*\n)*)/m;
    const m = src.match(anchorRe) || src.match(modelRe);
    if (m) {
      const pos = m.index + m[1].length;
      out = src.slice(0, pos) + blk + src.slice(pos);
    } else {
      out = src + (src.endsWith("\n") || src === "" ? "" : "\n") + blk;
    }
  }
  // 自检：顶层 fallback_providers 键必须恰好 1 个，且 model 顶层键数量不变
  const count = (s, re) => (s.match(re) || []).length;
  const fbRe = /^fallback_providers:/gm;
  const mdRe = /^model:/gm;
  if (count(out, fbRe) !== 1 || count(out, mdRe) !== count(src, mdRe)) {
    return src;   // 自检失败：放弃改动，保持原内容
  }
  return out;
}

// ── 同步回退服务商 API key 到网关 .env ────────────────────────────────────────
// 现有逻辑只同步 active provider 的 key；回退触发时网关按环境变量取回退服务商 key，
// 缺失会导致 401，故保存回退配置时必须把回退服务商 key 一并写入 hermesEnvPath。
export function syncFallbackKeysToHermesEnv(fallbackIds, envProvidersPath, hermesEnvPath) {
  const ids = (fallbackIds || []).filter((id) => String(id).indexOf("local-") !== 0);
  if (ids.length === 0) return false;
  if (!existsSync(envProvidersPath)) return false;
  const provEnv = readFileSync(envProvidersPath, "utf8");
  let hermesEnv = existsSync(hermesEnvPath) ? readFileSync(hermesEnvPath, "utf8") : "";
  let dirty = false;
  ids.forEach((id) => {
    const envKey = fallbackEnvKey(id);
    if (!envKey) return;
    let m = provEnv.match(new RegExp(`^${envKey}=(.*)$`, "m"));
    // 非内置服务商兜底读取旧格式变量名
    if (!m && !PROVIDER_API_KEYS[id]) {
      m = provEnv.match(new RegExp(`^${legacyCustomEnvKey(id)}=(.*)$`, "m"));
    }
    if (!m || m[1].length === 0) return;
    const lineRe = new RegExp(`^${envKey}=.*$`, "m");
    const newLine = `${envKey}=${m[1]}`;
    if (lineRe.test(hermesEnv)) {
      if (hermesEnv.match(lineRe)[0] !== newLine) {
        hermesEnv = hermesEnv.replace(lineRe, newLine);
        dirty = true;
      }
    } else {
      hermesEnv += (hermesEnv.endsWith("\n") || hermesEnv === "" ? "" : "\n") + newLine + "\n";
      dirty = true;
    }
  });
  if (dirty) writeFileSync(hermesEnvPath, hermesEnv);
  return dirty;
}
