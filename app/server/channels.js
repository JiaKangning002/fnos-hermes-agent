// channels.js — 通讯平台（频道 bot）配置模块（完整版：含三套扫码流程）
// 移植自 veenyi-fnos-hermes-agent 项目
// ESM，外接于 monitor.js。
// 职责：平台元数据、env/.yaml 配置读写、GET/POST 路由处理、三套扫码流程路由。
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, unlinkSync } from "fs";
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { Readable } from "stream";
import { resolve as resolvePath, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── 平台元数据（10 平台）─────────────────────────────────────
export const CHANNEL_DEFS = {
  weixin: {
    name: "微信", icon: "💬", qrLogin: true,
    fields: [],
    toggles: [{ path: "require_mention", label: "需 @提及 才回复" }],
    behavior: [],
    note: "通过腾讯 iLink 官方接口扫码登录。",
  },
  qqbot: {
    name: "QQ 机器人", icon: "🐧",
    fields: [
      { env: "QQ_APP_ID", path: "extra.app_id", label: "App ID", placeholder: "..." },
      { env: "QQ_CLIENT_SECRET", path: "extra.client_secret", label: "AppSecret", placeholder: "...", secret: true },
    ],
    toggles: [{ path: "allow_all_users", label: "允许所有用户" }, { path: "qq_markdown", label: "使用 Markdown 消息" }],
    behavior: [{ path: "allowed_users", label: "允许的用户 (留空=仅创建者)", placeholder: "openid1,openid2" }],
  },
  feishu: {
    name: "飞书", icon: "🪽",
    fields: [
      { env: "FEISHU_APP_ID", path: "extra.app_id", label: "App ID", placeholder: "cli_..." },
      { env: "FEISHU_APP_SECRET", path: "extra.app_secret", label: "App Secret", placeholder: "...", secret: true },
      { env: "FEISHU_ENCRYPT_KEY", path: "extra.encrypt_key", label: "Encrypt Key (可选)", placeholder: "..." },
      { env: "FEISHU_VERIFICATION_TOKEN", path: "extra.verification_token", label: "Verification Token (可选)", placeholder: "..." },
    ],
    toggles: [{ path: "require_mention", label: "需 @提及 才回复" }],
    behavior: [{ path: "free_response_chats", label: "自由回复的会话", placeholder: "chat_id1,chat_id2" }],
  },
  dingtalk: {
    name: "钉钉", icon: "🔔",
    fields: [
      { env: "DINGTALK_CLIENT_ID", path: "extra.client_id", label: "Client ID (AppKey)", placeholder: "ding..." },
      { env: "DINGTALK_CLIENT_SECRET", path: "extra.client_secret", label: "Client Secret", placeholder: "...", secret: true },
    ],
    toggles: [{ path: "require_mention", label: "需 @提及 才回复" }, { path: "allow_all_users", label: "允许所有用户" }],
    behavior: [
      { path: "allowed_users", label: "允许的用户 (留空=仅创建者)", placeholder: "user_id1,user_id2" },
      { path: "free_response_chats", label: "自由回复的会话", placeholder: "chat_id1,chat_id2" },
    ],
  },
  wecom: {
    name: "企业微信", icon: "💼",
    fields: [
      { env: "WECOM_BOT_ID", path: "extra.bot_id", label: "Bot ID", placeholder: "..." },
      { env: "WECOM_SECRET", path: "extra.secret", label: "Secret", placeholder: "...", secret: true },
    ],
    toggles: [{ path: "require_mention", label: "需 @提及 才回复" }],
    behavior: [],
  },
  telegram: {
    name: "Telegram", icon: "✈️", qrLogin: true,
    fields: [
      { env: "TELEGRAM_BOT_TOKEN", path: "token", label: "Bot Token", placeholder: "BotFather Token", secret: true },
      { env: "TELEGRAM_PROXY", path: "proxy", label: "代理 (可选)", placeholder: "socks5://127.0.0.1:7890" },
    ],
    toggles: [{ path: "require_mention", label: "需 @提及 才回复" }, { path: "reactions", label: "启用消息反应" }],
    behavior: [
      { path: "free_response_chats", label: "自由回复的会话 (多个用逗号分隔)", placeholder: "chat_id1,chat_id2" },
      { path: "mention_patterns", label: "提及匹配规则 (正则，多个用逗号分隔)", placeholder: "@hermes,hermes" },
    ],
  },
  whatsapp: {
    name: "WhatsApp", icon: "💬", qrLogin: true,
    fields: [],
    toggles: [{ path: "require_mention", label: "需 @提及 才回复" }],
    behavior: [{ path: "free_response_chats", label: "自由回复的会话", placeholder: "chat_id1,chat_id2" }],
    note: "通过本地 Baileys 桥接扫码配对，消息在本机处理。",
  },
  discord: {
    name: "Discord", icon: "🎮",
    fields: [
      { env: "DISCORD_BOT_TOKEN", path: "token", label: "Bot Token", placeholder: "Bot token...", secret: true },
      { env: "DISCORD_PROXY", path: "proxy", label: "代理 (可选)", placeholder: "socks5://127.0.0.1:7890" },
    ],
    toggles: [{ path: "require_mention", label: "需 @提及 才回复" }, { path: "auto_thread", label: "自动线程" }, { path: "reactions", label: "启用反应" }],
    behavior: [
      { path: "free_response_channels", label: "自由回复的频道 (多个用逗号分隔)", placeholder: "channel_id1,channel_id2" },
      { path: "allowed_channels", label: "仅允许的频道 (留空=全部)", placeholder: "channel_id1,channel_id2" },
      { path: "ignored_channels", label: "忽略的频道", placeholder: "channel_id1,channel_id2" },
    ],
  },
  slack: {
    name: "Slack", icon: "💼",
    fields: [{ env: "SLACK_BOT_TOKEN", path: "token", label: "Bot Token", placeholder: "xoxb-...", secret: true }],
    toggles: [{ path: "require_mention", label: "需 @提及 才回复" }, { path: "allow_bots", label: "允许机器人消息" }],
    behavior: [{ path: "free_response_channels", label: "自由回复的频道", placeholder: "channel_id1,channel_id2" }],
  },
  matrix: {
    name: "Matrix", icon: "🔷",
    fields: [
      { env: "MATRIX_ACCESS_TOKEN", path: "token", label: "Access Token", placeholder: "syt_...", secret: true },
      { env: "MATRIX_PROXY", path: "proxy", label: "代理 (可选)", placeholder: "socks5://127.0.0.1:7890" },
      { env: "MATRIX_HOMESERVER", path: "extra.homeserver", label: "Homeserver", placeholder: "https://matrix.org" },
      { env: "MATRIX_USER_ID", path: "extra.user_id", label: "User ID (可选)", placeholder: "@user:matrix.org" },
    ],
    toggles: [{ path: "require_mention", label: "需 @提及 才回复" }, { path: "auto_thread", label: "自动线程" }],
    behavior: [{ path: "free_response_rooms", label: "自由回复的房间", placeholder: "room_id1,room_id2" }],
  },
};

// ─── 初始化：由 monitor.js 传入共享路径与回调 ─────────────────────────────
let DATA_DIR = "";
let logFn = () => {};
let restartGatewayFn = null;
let resolvedNodeBin = null;
let resolvedNodeDir = null;

/**
 * 初始化模块（monitor.js 启动时调用一次）
 * @param {{ dataDir: string, log: Function, restartGateway: Function, nodeBin?: string, nodeDir?: string }} opts
 */
export function initChannels({ dataDir, log, restartGateway, nodeBin, nodeDir }) {
  DATA_DIR = dataDir;
  logFn = log || (() => {});
  restartGatewayFn = restartGateway || null;
  resolvedNodeBin = nodeBin || null;
  resolvedNodeDir = nodeDir || null;
}

// ─── 常量 ─────────────────────────────────────────────────────────────────
const WEIXIN_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com"; // iLink 默认接入点，扫码响应缺 base_url 时兜底
const TELEGRAM_ONBOARDING_URL = (process.env.TELEGRAM_ONBOARDING_URL || "https://setup.hermes-agent.nousresearch.com").replace(/\/+$/, "");
const WHATSAPP_ONBOARDING_TTL = 600000; // 10 分钟

// ─── 内存状态 ─────────────────────────────────────────────────────────────
const _telegramPairings = new Map(); // pairing_id -> {poll_token, expires_at_ts, bot_token, bot_username, owner_user_id}
const _whatsappPairings = new Map(); // pairing_id -> {proc, status, qr_payload, mode, account_id, account_name, account_phone, error, expires_at_ts}

// ─── env 文件读写（DATA_DIR/.env）───────────────────────────────────────
function hermesEnvPath() { return `${DATA_DIR}/.env`; }
function hermesConfigPath() { return `${DATA_DIR}/config.yaml`; }

function readEnvFile() {
  try { if (existsSync(hermesEnvPath())) return readFileSync(hermesEnvPath(), "utf8"); } catch {}
  return "";
}
function writeEnvFile(content) {
  try { writeFileSync(hermesEnvPath(), content, { mode: 0o600 }); return true; } catch { return false; }
}
function getEnvValue(content, key) {
  const m = content.match(new RegExp("^" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*=\\s*(.+)$", "m"));
  return m ? m[1].trim() : "";
}
function setEnvValue(content, key, value) {
  const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const line = key + "=" + (value || "");
  if (content.match(new RegExp("^" + safeKey + "\\s*=", "m"))) {
    return content.replace(new RegExp("^" + safeKey + "\\s*=.*$", "m"), line);
  }
  return (content ? content.replace(/\n?$/, "\n") : "") + line + "\n";
}

// ─── 渠道停用：#_# 注释式凭证屏蔽 ─────────────────────────────────────────
// 停用 = 把凭证行整行加 #_# 前缀（形态 #_#KEY=value）；启用 = 精确剥掉行首 #_#。
// #_# 为本面板专用停用标记，启用/停用只按渠道 env 键白名单精确匹配到 = 边界。
const ENV_DISABLED_PREFIX = "#_#";

function escapeEnvKey(key) {
  return key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 读取键值：活跃行优先，其次 #_# 停用行（用于判定"已配置但停用"）
function getEnvValueAny(content, key) {
  const active = getEnvValue(content, key);
  if (active) return active;
  const m = content.match(new RegExp("^" + ENV_DISABLED_PREFIX + escapeEnvKey(key) + "\\s*=\\s*(.+)$", "m"));
  return m ? m[1].trim() : "";
}

/**
 * 停用一组 env 键：把活跃的 KEY=... 行整行前缀成 #_#KEY=...。
 * 若已存在同键的 #_# 旧标记行，先删除再打标记，保证同键最多一条停用行。
 * 其余行（用户注释、其它键）原样保留；无任何变化时不写文件。
 */
function disableEnvKeys(keys) {
  const content = readEnvFile();
  if (!content) return true;
  let lines = content.split("\n");
  let changed = false;
  for (const key of keys) {
    const activeRe = new RegExp("^" + escapeEnvKey(key) + "\\s*=");
    const disabledRe = new RegExp("^" + ENV_DISABLED_PREFIX + escapeEnvKey(key) + "\\s*=");
    if (!lines.some(l => activeRe.test(l))) continue;
    lines = lines.filter(l => { if (disabledRe.test(l)) { changed = true; return false; } return true; });
    lines = lines.map(l => { if (activeRe.test(l)) { changed = true; return ENV_DISABLED_PREFIX + l; } return l; });
  }
  return changed ? writeEnvFile(lines.join("\n")) : true;
}

/**
 * 启用一组 env 键：找 #_#KEY=... 行剥掉行首 #_# 还原为活跃行。
 * 若同键同时存在活跃行与 #_# 标记行，以活跃行为准并清掉标记行；
 * 同键多条标记行只还原第一条，其余清除。
 */
function enableEnvKeys(keys) {
  const content = readEnvFile();
  if (!content) return true;
  let lines = content.split("\n");
  let changed = false;
  for (const key of keys) {
    const activeRe = new RegExp("^" + escapeEnvKey(key) + "\\s*=");
    const disabledRe = new RegExp("^" + ENV_DISABLED_PREFIX + escapeEnvKey(key) + "\\s*=");
    const hasActive = lines.some(l => activeRe.test(l));
    let restored = false;
    lines = lines.reduce((acc, l) => {
      if (!disabledRe.test(l)) { acc.push(l); return acc; }
      changed = true;
      if (!hasActive && !restored) { acc.push(l.slice(ENV_DISABLED_PREFIX.length)); restored = true; }
      return acc; // 活跃行已存在或多余标记行：直接清除
    }, []);
  }
  return changed ? writeEnvFile(lines.join("\n")) : true;
}

// 判断 env 文本中是否存在指定键的 #_# 停用行
function hasDisabledEnvLines(content, keys) {
  return keys.some(k => new RegExp("^" + ENV_DISABLED_PREFIX + escapeEnvKey(k) + "\\s*=", "m").test(content));
}

// 从 env 文本中移除指定键的 #_# 停用行，返回处理后文本
function stripDisabledEnvLines(content, keys) {
  let lines = content.split("\n");
  for (const key of keys) {
    const disabledRe = new RegExp("^" + ENV_DISABLED_PREFIX + escapeEnvKey(key) + "\\s*=");
    lines = lines.filter(l => !disabledRe.test(l));
  }
  return lines.join("\n");
}

// ─── config.yaml 读写 ────────────────────────────────────────────────────
function readHermesConfig() {
  try { if (existsSync(hermesConfigPath())) return readFileSync(hermesConfigPath(), "utf8"); } catch {}
  return "";
}
function writeHermesConfig(content) {
  try { writeFileSync(hermesConfigPath(), content, { mode: 0o644 }); return true; } catch { return false; }
}

// ─── YAML 辅助（最小实现，仅用于 platforms 段）────────────────────────────
function yamlQuote(v) {
  if (v === true) return "true";
  if (v === false) return "false";
  if (v === null || v === undefined) return '""';
  const s = String(v);
  if (s === "") return '""';
  if (/[:#[\]{}&*!|>'"%@`,]/.test(s) || /^\s|\s$/.test(s) || /[\n\r\t]/.test(s)) {
    return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  }
  return s;
}
function yamlUnquote(s) {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~" || s === "") return null;
  if ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'")) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return s;
}
function objToYaml(obj, spaces) {
  const pad = " ".repeat(spaces);
  let out = "";
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    if (typeof v === "object" && !Array.isArray(v)) {
      out += pad + k + ":\n" + objToYaml(v, spaces + 2);
    } else if (Array.isArray(v)) {
      out += pad + k + (v.length ? ":\n" + v.map(x => pad + "  - " + yamlQuote(x) + "\n").join("") : ": []\n");
    } else {
      out += pad + k + ": " + yamlQuote(v) + "\n";
    }
  }
  return out;
}

// ─── 嵌套 path 存取 ─────────────────────────────────────────────────────
function setValByPath(obj, path, val) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) { const p = parts[i]; cur[p] = (cur[p] && typeof cur[p] === "object") ? cur[p] : {}; cur = cur[p]; }
  cur[parts[parts.length - 1]] = val;
}
function getValByPath(obj, path) {
  const parts = path.split("."); let cur = obj;
  for (const p of parts) { if (cur == null || typeof cur !== "object") return undefined; cur = cur[p]; }
  return cur;
}
// 删除嵌套 path 对应字段；中间对象变空时一并删除
function deleteValByPath(obj, path) {
  const parts = path.split(".");
  const parents = [];
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null || typeof cur !== "object") return;
    parents.push(cur); cur = cur[parts[i]];
  }
  if (cur == null || typeof cur !== "object") return;
  delete cur[parts[parts.length - 1]];
  for (let i = parts.length - 2; i >= 0; i--) {
    const child = parents[i][parts[i]];
    if (child && typeof child === "object" && !Array.isArray(child) && Object.keys(child).length === 0) delete parents[i][parts[i]];
    else break;
  }
}

// ─── 读取 config.yaml 中 platforms.<id> 段 ───────────────────────────────
function readPlatformConfig(id) {
  const yml = readHermesConfig();
  const re = new RegExp("^  " + id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":(?:\\n((?:    .*(?:\\n      .*)*\\n?)*))?", "m");
  const m = yml.match(re);
  if (!m || !m[1]) return {};
  const obj = {};
  let curObj = null;
  m[1].split("\n").forEach(l => {
    if (!l.trim()) return;
    const mm = l.match(/^    ([a-zA-Z_][\w-]*):\s*(.*)$/);
    if (mm) {
      const key = mm[1], val = mm[2].trim();
      if (val === "") { obj[key] = {}; curObj = obj[key]; }
      else { obj[key] = yamlUnquote(val); curObj = null; }
    } else {
      const em = l.match(/^      ([a-zA-Z_][\w-]*):\s*(.*)$/);
      if (em && curObj && typeof curObj === "object") { curObj[em[1]] = yamlUnquote(em[2].trim()); }
    }
  });
  return obj;
}

// ─── 重建 platforms 段中的指定平台块 ─────────────────────────────────────
function setPlatformConfig(id, obj) {
  const block = "  " + id + ":\n" + objToYaml(obj, 4);
  let yml = readHermesConfig();
  if (!/^platforms:/m.test(yml)) {
    yml = (yml ? yml.replace(/\n?$/, "\n") : "") + "platforms:\n" + block;
    return yml;
  }
  const lines = yml.split("\n");
  let header = -1;
  for (let i = 0; i < lines.length; i++) { if (/^platforms:\s*$/.test(lines[i])) { header = i; break; } }
  if (header < 0) { yml = yml.replace(/\n?$/, "\n") + "platforms:\n" + block; return yml; }
  const order = [];
  const blocks = {};
  let curId = null, suffixStart = lines.length;
  for (let i = header + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^[a-zA-Z_]/.test(l)) {
      if (curId !== null) blocks[curId].e = i - 1;
      suffixStart = i; break;
    }
    const mm = l.match(/^  ([a-zA-Z_][\w-]*):/);
    if (mm) {
      if (curId !== null) blocks[curId].e = i - 1;
      curId = mm[1];
      if (!blocks[curId]) { blocks[curId] = { s: i, e: i }; if (order[order.length - 1] !== curId) order.push(curId); }
    } else if (curId !== null) { blocks[curId].e = i; }
  }
  if (curId !== null && suffixStart === lines.length) blocks[curId].e = lines.length - 1;
  const newLines = [];
  for (let i = 0; i <= header; i++) newLines.push(lines[i]);
  let wroteTarget = false;
  order.forEach(pid => {
    if (pid === id) { newLines.push(block.replace(/\n$/, "")); wroteTarget = true; }
    else { for (let i = blocks[pid].s; i <= blocks[pid].e; i++) newLines.push(lines[i]); }
  });
  if (!wroteTarget) newLines.push(block.replace(/\n$/, ""));
  for (let i = suffixStart; i < lines.length; i++) newLines.push(lines[i]);
  return newLines.join("\n") + "\n";
}

// ─── WhatsApp Bridge 辅助 ─────────────────────────────────────────────────
function _findWhatsAppBridgeDir() {
  // 使用项目内置的 vendor/whatsapp-bridge 目录
  const bundled = resolvePath(__dirname, "vendor", "whatsapp-bridge");
  if (existsSync(`${bundled}/bridge.js`)) return bundled;
  return null;
}

function _findNpmBin() {
  // 1) Hermes 自带 node 同目录下的 npm（nodeBin 由 initChannels 传入）
  if (resolvedNodeBin) {
    const nodeDir = resolvedNodeBin.replace(/[\\/][^\\/]+$/, "");
    for (const name of ["npm", "npm.cmd"]) {
      const sibling = `${nodeDir}/${name}`;
      if (existsSync(sibling)) return { npm: sibling, isScript: false, node: resolvedNodeBin };
    }
  }
  // 2) 系统安装：交给 PATH 解析（spawn 时不带路径）
  return { npm: "npm", isScript: false, node: resolvedNodeBin };
}

// 异步安装 bridge 依赖：原同步 spawnSync 最长冻结事件循环 5 分钟，改为异步执行，
// 错误分类与文案与原同步版本保持一致
async function _ensureWhatsAppBridgeDeps(bridgeDir) {
  if (existsSync(`${bridgeDir}/node_modules`)) return true;
  if (!resolvedNodeBin) throw new Error("未找到 Node.js，无法启动 WhatsApp bridge");
  const npmInfo = _findNpmBin();
  const env = { ...process.env, PATH: (resolvedNodeDir ? resolvedNodeDir + ":" : "") + (process.env.PATH || "") };
  const args = ["install", "--silent"];
  const [cmd, fullArgs] = npmInfo.isScript
    ? [npmInfo.node, [npmInfo.npm, ...args]]
    : [npmInfo.npm, args];
  const result = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, fullArgs, { cwd: bridgeDir, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) { resolve({ status: null, error: e, stderr: "" }); return; }
    let stderr = "", settled = false, timer = null;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(payload);
    };
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish({ status: null, error: new Error("npm install 超时（300 秒）已强制终止"), stderr });
    }, 300000);
    if (child.stdout) child.stdout.on("data", () => {}); // 排空管道，避免缓冲区写满阻塞 npm
    if (child.stderr) child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => finish({ status: null, error: e, stderr }));
    child.on("close", (code) => finish({ status: code, error: null, stderr }));
  });
  if (result.error && result.error.code === "ENOENT") {
    throw new Error("未找到 npm：node 同目录及系统 PATH 中均不存在。WhatsApp 配对需要 npm 安装依赖。(node路径: " + (resolvedNodeBin || "null") + ")");
  }
  if (result.error) {
    throw new Error("执行 npm install 失败：" + result.error.message);
  }
  if (result.status !== 0) {
    const err = (result.stderr || "").toString().trim() || "npm install 返回非零退出码";
    throw new Error("安装 WhatsApp bridge 依赖失败：" + err);
  }
  return true;
}

async function _spawnWhatsAppPairing(sessionDir, mode) {
  const bridgeDir = _findWhatsAppBridgeDir();
  if (!bridgeDir) throw new Error("未找到 WhatsApp bridge 脚本，请确认 hermes-agent 已正确安装");
  if (!resolvedNodeBin) throw new Error("未找到 Node.js，无法启动 WhatsApp bridge");
  await _ensureWhatsAppBridgeDeps(bridgeDir);
  try { mkdirSync(sessionDir, { recursive: true }); } catch {}
  const env = { ...process.env, WHATSAPP_MODE: mode || "self-chat", WHATSAPP_DM_POLICY: "pairing" };
  return spawn(
    resolvedNodeBin,
    [`${bridgeDir}/bridge.js`, "--pair-only", "--pair-json", "--session", sessionDir],
    { cwd: bridgeDir, stdio: ["ignore", "pipe", "pipe"], env }
  );
}

function _terminateProc(proc) {
  if (!proc) return;
  try { if (proc.pid) process.kill(proc.pid, "SIGTERM"); } catch {}
  try { proc.kill(); } catch {}
}

function _watchWhatsAppPairing(pairingId, proc) {
  if (!proc || !proc.stdout) return;
  try {
    let buf = "";
    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const raw of lines) {
        const line = raw.trim(); if (!line) continue;
        try {
          const payload = JSON.parse(line);
          const event = String(payload.event || "").trim();
          const rec = _whatsappPairings.get(pairingId);
          if (!rec || rec.proc !== proc) return;
          if (event === "qr") {
            const qr = String(payload.qr || "").trim();
            if (qr) { rec.qr_payload = qr; rec.status = "waiting"; rec.error = null; }
          } else if (event === "connected") {
            const user = payload.user || {};
            rec.account_id = String(user.id || "").trim() || null;
            rec.account_name = String(user.name || "").trim() || null;
            rec.account_phone = rec.account_id ? rec.account_id.replace(/[^0-9]/g, "").replace(/^\d+?:(\d+)@s\.whatsapp\.net$/, "$1") : null;
            rec.status = "connected"; rec.error = null;
          } else if (event === "error") {
            rec.status = "error"; rec.error = String(payload.error || "WhatsApp 配对失败");
          }
        } catch {}
      }
    });
    proc.on("exit", () => {
      const rec = _whatsappPairings.get(pairingId);
      if (!rec || rec.proc !== proc) return;
      if (!["connected", "error", "expired", "cancelled"].includes(rec.status)) {
        rec.status = "error"; rec.error = "WhatsApp 配对进程意外退出";
      }
    });
  } catch {}
}

// ─── Telegram / WhatsApp 辅助 ─────────────────────────────────────────────
function _pruneTelegramPairings() {
  const now = Date.now();
  for (const [id, rec] of _telegramPairings) { if (rec.expires_at_ts <= now) _telegramPairings.delete(id); }
}
function _pruneWhatsAppPairings() {
  const now = Date.now();
  const terminal = { connected: 1, error: 1, expired: 1, cancelled: 1 };
  for (const [id, rec] of _whatsappPairings) {
    if (!terminal[rec.status] && rec.expires_at_ts <= now) {
      rec.status = "expired"; rec.error = "二维码已过期，请重新配对";
      _terminateProc(rec.proc);
    }
    if (terminal[rec.status] && rec.expires_at_ts + 300000 <= now) _whatsappPairings.delete(id);
  }
}
function _normalizeTelegramUserId(value) {
  const s = String(value || "").trim();
  if (/^\d+$/.test(s)) return s;
  return null;
}
function _normalizeWhatsAppAllowedUsers(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  const parts = s.split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (p === "*") { out.push("*"); continue; }
    const digits = p.replace(/\D/g, "");
    if (digits) out.push(digits);
  }
  return out.join(",");
}

// ─── 路由处理器 ──────────────────────────────────────────────────────────
/**
 * 判定平台是否已配置（凭证存在即视为已配置，与 enabled 开关无关）。
 * 凭证行为活跃形态（KEY=）或 #_# 停用形态（#_#KEY=）均计入。
 */
function isChannelConfigured(id, def, env, cfg) {
  let configured = false;
  (def.fields || []).forEach(f => { if (f.env && getEnvValueAny(env, f.env)) configured = true; });
  // WhatsApp/微信 特殊判定
  if (id === "whatsapp" && (getEnvValueAny(env, "WHATSAPP_ENABLED") || cfg.enabled === "true" || cfg.enabled === true)) configured = true;
  if (id === "weixin" && (getEnvValueAny(env, "WEIXIN_TOKEN") || cfg.token || (cfg._stash && cfg._stash.token))) configured = true;
  return configured;
}

// ─── 渠道 env 键集：toggle 停用/启用时屏蔽/恢复的全部凭证键 ───────────────
// 含 fields[].env 与扫码渠道 Apply 流程直写 .env 的固定键。
const CHANNEL_EXTRA_ENV_KEYS = {
  weixin: ["WEIXIN_TOKEN", "WEIXIN_ACCOUNT_ID", "WEIXIN_BASE_URL"],
  telegram: ["TELEGRAM_ALLOWED_USERS"],
  whatsapp: ["WHATSAPP_MODE", "WHATSAPP_DM_POLICY", "WHATSAPP_ALLOWED_USERS", "WHATSAPP_ENABLED"],
};
function channelEnvKeys(id, def) {
  const keys = (def.fields || []).map(f => f.env).filter(Boolean);
  for (const k of CHANNEL_EXTRA_ENV_KEYS[id] || []) { if (!keys.includes(k)) keys.push(k); }
  return keys;
}

// ─── config.yaml 凭证暂存/恢复（全渠道通用）───────────────────────────
// 停用时把 platforms.<id> 下的凭证字段移入 _stash 子字段并清空原字段，
// 启用时从 _stash 对称恢复并删除该字段。_stash 键为凭证 path，"." 以 "__" 编码。
function channelConfigCredPaths(id, def) {
  const paths = (def.fields || []).map(f => f.path).filter(Boolean);
  if (id === "weixin") {
    for (const p of ["token", "extra.account_id", "extra.base_url"]) { if (!paths.includes(p)) paths.push(p); }
  }
  return paths;
}
function stashConfigCreds(id, def, cfg) {
  const stash = (cfg._stash && typeof cfg._stash === "object") ? cfg._stash : {};
  for (const p of channelConfigCredPaths(id, def)) {
    const v = getValByPath(cfg, p);
    if (v !== undefined && v !== null && v !== "") stash[p.replace(/\./g, "__")] = v;
    deleteValByPath(cfg, p);
  }
  if (Object.keys(stash).length) cfg._stash = stash;
}
function restoreConfigCreds(id, cfg) {
  const stash = (cfg._stash && typeof cfg._stash === "object") ? cfg._stash : null;
  if (!stash) return;
  for (const key of Object.keys(stash)) {
    // weixin 的 account_id/base_url 键按 extra.<键> 路径恢复
    let path = key.replace(/__/g, ".");
    if (id === "weixin" && (key === "account_id" || key === "base_url")) path = "extra." + key;
    const cur = getValByPath(cfg, path);
    if (cur === undefined || cur === null || cur === "") setValByPath(cfg, path, stash[key]);
  }
  delete cfg._stash;
}

// ─── 网关重启请求：同步异常与异步 rejection 统一捕获，不中断请求处理 ───────
function _requestGatewayRestart(reason) {
  if (!restartGatewayFn) return { restarting: false, failed: false };
  try {
    const r = restartGatewayFn(reason);
    if (r && typeof r.catch === "function") r.catch(e => logFn(`[channels] 重启网关失败: ${e?.message || e}`));
    return { restarting: true, failed: false };
  } catch (e) {
    logFn(`[channels] 重启网关失败: ${e?.message || e}`);
    return { restarting: false, failed: true };
  }
}

/**
 * GET /api/channels — 列出所有平台及配置状态
 */
export function handleGetChannels() {
  const env = readEnvFile();
  const out = {};
  Object.keys(CHANNEL_DEFS).forEach(id => {
    const def = CHANNEL_DEFS[id];
    const cfg = readPlatformConfig(id);
    const configured = isChannelConfigured(id, def, env, cfg);
    delete cfg._stash; // 停用暂存的明文凭证不下发前端
    out[id] = {
      id, name: def.name, icon: def.icon, configured, qrLogin: !!def.qrLogin, note: def.note || "",
      // enabled 缺省视为 true（历史配置无该字段 = 已配置即启用）
      enabled: !(cfg.enabled === false || cfg.enabled === "false"),
      // 凭证展示用 getEnvValueAny：停用态（#_# 注释行）仍显示为已填写
      fields: (def.fields || []).map(f => ({
        env: f.env, path: f.path, label: f.label, placeholder: f.placeholder || "",
        secret: !!f.secret, has_value: !!getEnvValueAny(env, f.env),
        masked: f.secret && getEnvValueAny(env, f.env) ? "****" + getEnvValueAny(env, f.env).slice(-4) : "",
      })),
      toggles: def.toggles || [],
      behavior: def.behavior || [],
      config: cfg,
    };
  });
  return out;
}

/**
 * POST /api/channels/:id/toggle — 启用/停用平台（真停用语义）
 * body: { enabled: boolean }
 * 停用 = #_# 注释该渠道全部 env 凭证键，并把 config.yaml 凭证移入 _stash；
 * 启用 = 剥掉 #_# 并从 _stash 恢复。enabled 字段供面板显示；
 * 切换后不自动重启网关，由用户手动重启生效（响应 needs_restart 提示前端）。
 */
export function handleToggleChannel(id, body) {
  const def = CHANNEL_DEFS[id];
  if (!def) return { ok: false, error: "unknown channel" };
  const env = readEnvFile();
  const cfg = readPlatformConfig(id);
  if (!isChannelConfigured(id, def, env, cfg)) return { ok: false, error: "平台尚未配置，无法切换启用状态" };
  const enabled = body && body.enabled === true;
  const keys = channelEnvKeys(id, def);
  if (enabled) {
    if (!enableEnvKeys(keys)) return { ok: false, error: "写入 .env 失败，未变更启用状态" };
    restoreConfigCreds(id, cfg);
  } else {
    if (!disableEnvKeys(keys)) return { ok: false, error: "写入 .env 失败，未变更启用状态" };
    stashConfigCreds(id, def, cfg);
  }
  cfg.enabled = enabled;
  cfg.updated_at = Date.now();
  if (!writeHermesConfig(setPlatformConfig(id, cfg))) return { ok: false, error: "写入 config.yaml 失败" };
  return { ok: true, id, configured: true, enabled, needs_restart: true };
}

/**
 * POST /api/channels/:id — 保存平台配置
 */
export function handleSaveChannel(id, body) {
  const def = CHANNEL_DEFS[id];
  if (!def) return { ok: false, error: "unknown channel" };

  let env = readEnvFile();
  const cfg = readPlatformConfig(id);

  // 渠道处于 #_# 停用态时：先解除全键停用并恢复 config.yaml 凭证，保存后以完整凭证上线
  let reEnabled = false;
  const keys = channelEnvKeys(id, def);
  if (hasDisabledEnvLines(env, keys)) {
    if (!enableEnvKeys(keys)) return { ok: false, error: "写入 .env 失败，未变更配置" };
    env = readEnvFile();
    restoreConfigCreds(id, cfg);
    cfg.enabled = true;
    reEnabled = true;
  }

  // 凭证字段 → .env + config.yaml
  (def.fields || []).forEach(f => {
    if (!f.env) return;
    const v = (body.credentials && body.credentials[f.env] != null) ? body.credentials[f.env]
            : (body.config && getValByPath(body.config, f.path) != null ? getValByPath(body.config, f.path) : null);
    if (v == null || v === "****keep****") return;
    env = setEnvValue(env, f.env, v || "");
    if (f.path) setValByPath(cfg, f.path, v || "");
  });
  if (!writeEnvFile(env)) return { ok: false, error: "写入 .env 失败，未变更既有配置" };

  // 行为开关
  if (body.toggles && typeof body.toggles === "object") {
    Object.keys(body.toggles).forEach(p => { const v = body.toggles[p]; if (v != null) setValByPath(cfg, p, v); });
  }
  // 其余行为配置
  if (body.config && typeof body.config === "object") {
    Object.keys(body.config).forEach(p => {
      if ((def.fields || []).some(f => f.path === p)) return;
      const v = body.config[p]; if (v != null) setValByPath(cfg, p, v);
    });
  }

  cfg.updated_at = Date.now();
  if (!writeHermesConfig(setPlatformConfig(id, cfg))) return { ok: false, error: "写入 config.yaml 失败" };

  // 保存后重启网关使配置生效
  const restart = _requestGatewayRestart(`channel-${id}`);
  return { ok: true, re_enabled: reEnabled, gateway_restarting: restart.restarting, gateway_restart_failed: restart.failed };
}

// ═══════════════════════════════════════════════════════════════════════════
// 三套扫码流程路由处理器
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 统一 JSON 响应生成
 */
function jsonRes(data, status = 200) {
  return { status, body: data };
}

/**
 * 微信 iLink 扫码：获取二维码
 * GET /api/channels/weixin/qr
 */
export async function handleWeixinQr() {
  try {
    const res = await fetch("https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3", { signal: AbortSignal.timeout(15000) });
    const data = await res.json().catch(() => ({}));
    if (!data || !data.qrcode) return jsonRes({ ok: false, error: "无法获取微信二维码，请检查网络后重试" }, 502);
    const deepLink = data.qrcode_img_content || "";
    return jsonRes({ ok: true, qrcode: data.qrcode, qrcode_url: deepLink, qrcode_img: deepLink, use_render_qr: true });
  } catch (e) {
    return jsonRes({ ok: false, error: e.message || "网络请求失败" }, 502);
  }
}

/**
 * 微信 iLink 扫码：轮询状态
 * GET /api/channels/weixin/qr/status?qrcode=...
 */
export async function handleWeixinQrStatus(qrcode) {
  if (!qrcode) return jsonRes({ ok: false, error: "缺少 qrcode 参数" }, 400);
  try {
    const res = await fetch("https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=" + encodeURIComponent(qrcode), { signal: AbortSignal.timeout(35000) });
    const data = await res.json().catch(() => ({}));
    const status = data?.status || "wait";
    if (status === "confirmed") {
      return jsonRes({ ok: true, status, account_id: data.ilink_bot_id, token: data.bot_token, base_url: data.baseurl });
    }
    return jsonRes({ ok: true, status });
  } catch (e) {
    return jsonRes({ ok: false, error: e.message || "网络请求失败" }, 502);
  }
}

/**
 * 清理网关账号缓存（DATA_DIR/weixin/accounts/ 下每账号三件套）：
 * - <account_id>.json：凭证备份，无条件用新 token/base_url 覆写；
 * - <account_id>.sync.json：长轮询游标，删除后网关会重建；
 * - <account_id>.context-tokens.json：会话 token 缓存。
 * 先成功写入新账号 <accountId>.json，再执行一切删除：同账号重扫且 token 变化时
 * 删除 .sync.json 重置游标；换绑时删除旧账号三件套。写入失败不触动任何缓存文件。
 * account_id 仅允许 [A-Za-z0-9._@-]，拒绝纯 "."/".." 与超长值，非法值跳过清理不参与路径拼接。
 * 文件/目录不存在时静默跳过，不抛错。
 * 返回 { wrote: boolean, error: string|null }：新账号 json 是否写入成功及失败信息。
 */
const WEIXIN_ACCOUNT_ID_RE = /^[A-Za-z0-9._@-]+$/;
const WEIXIN_ACCOUNT_ID_MAX = 128;
function _safeWeixinAccountId(id) {
  const s = String(id || "").trim();
  if (!s) return null;
  if (s === "." || s === ".." || s.length > WEIXIN_ACCOUNT_ID_MAX
      || !WEIXIN_ACCOUNT_ID_RE.test(s) || s.includes("..") || s.includes("/") || s.includes("\\")) {
    logFn(`[channels] 非法微信 account_id，跳过账号缓存清理: ${JSON.stringify(s.slice(0, 160))}`);
    return null;
  }
  return s;
}
function _cleanWeixinAccountCache(accountId, prevAccountId, token, baseUrl) {
  const accDir = `${DATA_DIR}/weixin/accounts`;
  const curId = _safeWeixinAccountId(accountId);
  if (!curId) return { wrote: false, error: "account_id 非法，已跳过账号缓存写入" };
  let wroteNew = false;
  let writeError = null;
  let tokenChanged = false;
  const curFile = `${accDir}/${curId}.json`;
  try {
    let old = {};
    try { if (existsSync(curFile)) old = JSON.parse(readFileSync(curFile, "utf8")) || {}; } catch {}
    tokenChanged = !!(old.token && old.token !== token);
    try { mkdirSync(accDir, { recursive: true }); } catch {}
    const payload = { ...old, token, base_url: baseUrl, saved_at: new Date().toISOString().replace(/\.\d+Z$/, "Z") };
    writeFileSync(curFile, JSON.stringify(payload), { mode: 0o600 });
    wroteNew = true;
    logFn(`[channels] 微信账号缓存已写入: ${curFile}`);
  } catch (e) {
    writeError = (e && e.code ? e.code + ": " : "") + (e && e.message ? e.message : String(e));
    logFn(`[channels] 微信账号缓存写入失败: ${curFile} (${writeError})`);
  }
  if (!wroteNew) return { wrote: false, error: writeError };
  if (tokenChanged) {
    try {
      const syncFile = `${accDir}/${curId}.sync.json`;
      if (existsSync(syncFile)) unlinkSync(syncFile);
    } catch {}
  }
  const prevId = _safeWeixinAccountId(prevAccountId);
  if (prevId && prevId !== curId) {
    for (const suffix of [".json", ".sync.json", ".context-tokens.json"]) {
      try {
        const oldFile = `${accDir}/${prevId}${suffix}`;
        if (existsSync(oldFile)) unlinkSync(oldFile);
      } catch {}
    }
  }
  return { wrote: true, error: null };
}

/**
 * 微信扫码确认后保存凭证
 * POST /api/channels/weixin  (body: { credentials: {WEIXIN_TOKEN, WEIXIN_ACCOUNT_ID, WEIXIN_BASE_URL} })
 */
export function handleWeixinSave(body) {
  try {
    const creds = body.credentials || body;
    const token = String(creds.WEIXIN_TOKEN || "").trim();
    const accountId = String(creds.WEIXIN_ACCOUNT_ID || "").trim();
    // token 或 accountId 缺失：拒绝保存，返回指引文案
    if (!token || !accountId) {
      return jsonRes({ ok: false, error: "该微信 bot 可能已绑定，iLink 未下发新凭证；请在微信侧解绑后重新扫码，或稍后重试" }, 502);
    }
    const baseUrl = String(creds.WEIXIN_BASE_URL || "").trim() || WEIXIN_DEFAULT_BASE_URL;
    let env = readEnvFile();
    const cfg = readPlatformConfig("weixin");
    // 旧账号 ID：活跃/停用行均可读，.env 缺失时回退 config.yaml extra/_stash
    const prevAccountId = getEnvValueAny(env, "WEIXIN_ACCOUNT_ID")
      || String((cfg.extra && cfg.extra.account_id) || "").trim()
      || String((cfg._stash && (cfg._stash.extra__account_id || cfg._stash.account_id)) || "").trim();
    // 清除本渠道遗留的 #_# 停用行后无条件覆盖写入
    env = stripDisabledEnvLines(env, channelEnvKeys("weixin", CHANNEL_DEFS.weixin));
    env = setEnvValue(env, "WEIXIN_TOKEN", token);
    env = setEnvValue(env, "WEIXIN_ACCOUNT_ID", accountId);
    env = setEnvValue(env, "WEIXIN_BASE_URL", baseUrl);
    if (!writeEnvFile(env)) return jsonRes({ ok: false, error: "写入 .env 失败，未变更既有配置" }, 500);
    // 同步写 config.yaml：双写覆盖旧凭证
    cfg.token = token;
    const extra = (cfg.extra && typeof cfg.extra === "object") ? cfg.extra : {};
    cfg.extra = { ...extra, account_id: accountId, base_url: baseUrl };
    delete cfg._stash;
    cfg.enabled = true;
    cfg.updated_at = Date.now();
    if (!writeHermesConfig(setPlatformConfig("weixin", cfg))) return jsonRes({ ok: false, error: "写入 config.yaml 失败" }, 500);
    // 凭证与双写均成功后才清理账号缓存；缓存写入结果随响应下发
    const cache = _cleanWeixinAccountCache(accountId, prevAccountId, token, baseUrl);
    const restart = _requestGatewayRestart("weixin-bind");
    return jsonRes({
      ok: true,
      cache_written: !!(cache && cache.wrote),
      cache_error: (cache && cache.error) || null,
      gateway_restarting: restart.restarting,
      gateway_restart_failed: restart.failed,
    });
  } catch (e) {
    return jsonRes({ ok: false, error: e.message }, 500);
  }
}

/**
 * Telegram 扫码：创建配对
 * GET /api/channels/telegram/qr?bot_name=...
 */
export async function handleTelegramQr(botName) {
  try {
    const name = (botName || "Hermes Agent").trim() || "Hermes Agent";
    const res = await fetch(`${TELEGRAM_ONBOARDING_URL}/v1/telegram/pairings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ bot_name: name }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`onboarding service ${res.status}`);
    const data = await res.json().catch(() => ({}));
    const pairingId = String(data.pairing_id || "").trim();
    const pollToken = String(data.poll_token || "").trim();
    const expiresAt = String(data.expires_at || "").trim();
    const deepLink  = String(data.deep_link || "").trim();
    const qrPayload = String(data.qr_payload || deepLink || "").trim();
    if (!pairingId || !pollToken || !expiresAt || !deepLink) throw new Error("incomplete onboarding response");
    let expiresTs = Date.now() + 600000;
    try { const d = new Date(expiresAt.replace("Z", "+00:00")); if (!isNaN(d)) expiresTs = d.getTime(); } catch {}
    _pruneTelegramPairings();
    _telegramPairings.set(pairingId, { poll_token: pollToken, expires_at_ts: expiresTs, bot_token: null, bot_username: null, owner_user_id: null });
    return jsonRes({ ok: true, pairing_id: pairingId, qr_payload: qrPayload, deep_link: deepLink, expires_at: expiresAt });
  } catch (e) {
    return jsonRes({ ok: false, error: "无法创建 Telegram 配对：" + e.message }, 502);
  }
}

/**
 * Telegram 扫码：轮询状态
 * GET /api/channels/telegram/qr/status?pairing_id=...
 */
export async function handleTelegramQrStatus(pairingId) {
  if (!pairingId) return jsonRes({ ok: false, error: "缺少 pairing_id" }, 400);
  try {
    _pruneTelegramPairings();
    const rec = _telegramPairings.get(pairingId);
    if (!rec) return jsonRes({ ok: false, error: "配对会话不存在或已过期" }, 404);
    if (rec.bot_token) return jsonRes({ ok: true, status: "ready", bot_username: rec.bot_username, owner_user_id: rec.owner_user_id });
    const res = await fetch(`${TELEGRAM_ONBOARDING_URL}/v1/telegram/pairings/${encodeURIComponent(pairingId)}`, {
      headers: { "Authorization": `Bearer ${rec.poll_token}`, "Accept": "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`onboarding service ${res.status}`);
    const data = await res.json().catch(() => ({}));
    const status = String(data.status || "").trim();
    if (status === "waiting") return jsonRes({ ok: true, status: "waiting" });
    if (status === "ready") {
      const token = String(data.token || "").trim();
      if (!token) throw new Error("missing token in ready response");
      const botUsername = String(data.bot_username || "").trim() || null;
      const ownerId = (() => { const v = data.owner_user_id; if (typeof v === "number" && v > 0) return String(v); if (typeof v === "string" && /^\d+$/.test(v)) return v; return null; })();
      rec.bot_token = token; rec.bot_username = botUsername; rec.owner_user_id = ownerId;
      return jsonRes({ ok: true, status: "ready", bot_username: botUsername, owner_user_id: ownerId });
    }
    if (["expired", "claimed"].includes(status)) {
      _telegramPairings.delete(pairingId);
      return jsonRes({ ok: false, error: "配对已" + status + "，请重新扫码" }, 410);
    }
    return jsonRes({ ok: true, status: "waiting" });
  } catch (e) {
    return jsonRes({ ok: false, error: "轮询 Telegram 状态失败：" + e.message }, 502);
  }
}

/**
 * Telegram 扫码：应用凭证
 * POST /api/channels/telegram/qr/apply  body: {pairing_id, allowed_user_ids}
 */
export function handleTelegramQrApply(body) {
  try {
    const pairingId = String(body.pairing_id || "").trim();
    const rawAllowed = Array.isArray(body.allowed_user_ids) ? body.allowed_user_ids : String(body.allowed_user_ids || "").split(/[,;\s]+/);
    const allowedUserIds = [];
    for (const v of rawAllowed) {
      const norm = _normalizeTelegramUserId(v);
      if (norm && !allowedUserIds.includes(norm)) allowedUserIds.push(norm);
    }
    if (!pairingId) return jsonRes({ ok: false, error: "缺少 pairing_id" }, 400);
    if (allowedUserIds.length === 0) return jsonRes({ ok: false, error: "请至少填写一个允许的 Telegram 用户 ID（数字）" }, 400);
    _pruneTelegramPairings();
    const rec = _telegramPairings.get(pairingId);
    if (!rec) return jsonRes({ ok: false, error: "配对会话不存在或已过期" }, 404);
    if (!rec.bot_token) return jsonRes({ ok: false, error: "机器人尚未创建完成，请稍后再试" }, 409);
    let env = readEnvFile();
    // 清除本渠道遗留的 #_# 停用行后写入新凭证
    env = stripDisabledEnvLines(env, channelEnvKeys("telegram", CHANNEL_DEFS.telegram));
    env = setEnvValue(env, "TELEGRAM_BOT_TOKEN", rec.bot_token);
    env = setEnvValue(env, "TELEGRAM_ALLOWED_USERS", allowedUserIds.join(","));
    if (!writeEnvFile(env)) return jsonRes({ ok: false, error: "写入 .env 失败，未变更既有配置" }, 500);
    const cfg = readPlatformConfig("telegram");
    delete cfg._stash;
    cfg.enabled = true;
    cfg.allow_from = allowedUserIds.join(",");
    cfg.updated_at = Date.now();
    if (!writeHermesConfig(setPlatformConfig("telegram", cfg))) return jsonRes({ ok: false, error: "写入 config.yaml 失败" }, 500);
    _telegramPairings.delete(pairingId);
    // 写入 TELEGRAM_ALLOWED_USERS 后重启网关使白名单生效
    const restart = _requestGatewayRestart("telegram-bind");
    return jsonRes({ ok: true, bot_username: rec.bot_username, gateway_restarting: restart.restarting, gateway_restart_failed: restart.failed });
  } catch (e) {
    return jsonRes({ ok: false, error: e.message }, 500);
  }
}

/**
 * WhatsApp 扫码：启动配对
 * GET /api/channels/whatsapp/qr?mode=bot|self-chat
 */
export async function handleWhatsAppQr(mode) {
  try {
    const validMode = ["bot", "self-chat"].includes(mode) ? mode : "self-chat";
    if (!resolvedNodeBin) return jsonRes({ ok: false, error: "未找到 Node.js，无法启动 WhatsApp bridge" }, 500);
    const pairingId = randomBytes(16).toString("hex");
    const sessionDir = `${DATA_DIR}/whatsapp/session/${pairingId}`;
    const expiresTs = Date.now() + WHATSAPP_ONBOARDING_TTL;
    // 如果已有 creds.json，视为已配对
    if (existsSync(`${sessionDir}/creds.json`)) {
      _pruneWhatsAppPairings();
      _whatsappPairings.set(pairingId, { proc: null, status: "connected", qr_payload: "", mode: validMode, account_id: null, account_name: null, account_phone: null, error: null, expires_at_ts: expiresTs });
      return jsonRes({ ok: true, pairing_id: pairingId, status: "connected" });
    }
    const proc = await _spawnWhatsAppPairing(sessionDir, validMode);
    _pruneWhatsAppPairings();
    _whatsappPairings.set(pairingId, { proc, status: "starting", qr_payload: "", mode: validMode, account_id: null, account_name: null, account_phone: null, error: null, expires_at_ts: expiresTs });
    _watchWhatsAppPairing(pairingId, proc);
    // 等待一小段时间让 QR 出来
    let initialQr = "";
    for (let i = 0; i < 30 && !initialQr; i++) {
      await new Promise(r => setTimeout(r, 200));
      initialQr = (_whatsappPairings.get(pairingId) || {}).qr_payload || "";
    }
    return jsonRes({ ok: true, pairing_id: pairingId, status: initialQr ? "waiting" : "starting", qr_payload: initialQr });
  } catch (e) {
    return jsonRes({ ok: false, error: "无法启动 WhatsApp 配对：" + e.message }, 500);
  }
}

/**
 * WhatsApp 扫码：轮询状态
 * GET /api/channels/whatsapp/qr/status?pairing_id=...
 */
export function handleWhatsAppQrStatus(pairingId) {
  if (!pairingId) return jsonRes({ ok: false, error: "缺少 pairing_id" }, 400);
  _pruneWhatsAppPairings();
  const rec = _whatsappPairings.get(pairingId);
  if (!rec) return jsonRes({ ok: false, error: "配对会话不存在或已过期" }, 404);
  if (rec.status === "expired") return jsonRes({ ok: false, error: rec.error || "二维码已过期" }, 410);
  return jsonRes({
    ok: true, status: rec.status, qr_payload: rec.qr_payload,
    account_id: rec.account_id, account_name: rec.account_name, account_phone: rec.account_phone,
    error: rec.error,
  });
}

/**
 * WhatsApp 扫码：应用凭证
 * POST /api/channels/whatsapp/qr/apply  body: {pairing_id, allowed_users?}
 */
export function handleWhatsAppQrApply(body) {
  try {
    const pairingId = String(body.pairing_id || "").trim();
    if (!pairingId) return jsonRes({ ok: false, error: "缺少 pairing_id" }, 400);
    _pruneWhatsAppPairings();
    const rec = _whatsappPairings.get(pairingId);
    if (!rec) return jsonRes({ ok: false, error: "配对会话不存在或已过期" }, 404);
    if (rec.status !== "connected") return jsonRes({ ok: false, error: "WhatsApp 尚未配对完成" }, 409);
    const allowedUsers = _normalizeWhatsAppAllowedUsers(body.allowed_users != null ? body.allowed_users : (rec.account_phone || ""));
    let env = readEnvFile();
    // 清除本渠道遗留的 #_# 停用行后写入新凭证
    env = stripDisabledEnvLines(env, channelEnvKeys("whatsapp", CHANNEL_DEFS.whatsapp));
    env = setEnvValue(env, "WHATSAPP_MODE", rec.mode || "self-chat");
    env = setEnvValue(env, "WHATSAPP_DM_POLICY", "pairing");
    if (allowedUsers) env = setEnvValue(env, "WHATSAPP_ALLOWED_USERS", allowedUsers);
    env = setEnvValue(env, "WHATSAPP_ENABLED", "true");
    if (!writeEnvFile(env)) return jsonRes({ ok: false, error: "写入 .env 失败，未变更既有配置" }, 500);
    const cfg = readPlatformConfig("whatsapp");
    delete cfg._stash;
    cfg.enabled = true;
    cfg.allow_from = allowedUsers || "";
    cfg.updated_at = Date.now();
    if (!writeHermesConfig(setPlatformConfig("whatsapp", cfg))) return jsonRes({ ok: false, error: "写入 config.yaml 失败" }, 500);
    _whatsappPairings.delete(pairingId);
    // 写入后重启网关，确保白名单生效
    const restart = _requestGatewayRestart("whatsapp-bind");
    return jsonRes({ ok: true, account_id: rec.account_id, account_name: rec.account_name, gateway_restarting: restart.restarting, gateway_restart_failed: restart.failed });
  } catch (e) {
    return jsonRes({ ok: false, error: e.message }, 500);
  }
}
