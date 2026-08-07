// Hermes Agent 引导进程 — Node.js HTTP 服务（Unix Socket 拥有者）
//
// 设计目标：本文件极简、稳定、几乎不再改动。它独占 unix socket 的绑定，
// 无论业务模块 monitor.js 是否成功加载，都能对外提供 UI 静态资源与诊断页，
// 从而避免 monitor.js 语法错误 / import 崩溃 / 初始化异常时整页白屏。
//
// 加载成功：所有请求转发给 monitor.js 导出的 handleServe / websocket 处理器。
// 加载失败：由本文件内置的兜底静态服务与诊断接口（/api/boot/diag、/debug）接管。
//
// 为保证引导层足够稳定，这里只依赖运行时适配层与少量 Node 核心模块，
// 不引入任何业务模块（channels / dashboard / primary-config 等）。

import { serve, file } from "./node-adapter.js";
import { readFileSync, existsSync, statSync, unlinkSync, chmodSync, appendFileSync } from "fs";
import { fileURLToPath } from "url";
import net from "net";

// ─── 路径解析（仅复刻 monitor.js 中最小必要的推导）─────────────────────
// 生产环境由 cmd/main 注入 APP_DIR，此处优先取环境变量；缺失时从本文件
// 所在目录（<APP_DIR>/server）回退推导，保证脱离 cmd/main 直接运行也可用。
function bootDir() {
  try { return fileURLToPath(new URL(".", import.meta.url)).replace(/[/\\]+$/, ""); }
  catch { return ""; }
}

let APP_DIR = process.env.APP_DIR;
if (!APP_DIR) {
  const dir = bootDir(); // 形如 <APP_DIR>/server
  APP_DIR = dir ? dir.replace(/[/\\][^/\\]+$/, "") : "/vol1/@appcenter/hermes-agent";
}

const DATA_DIR   = process.env.DATA_DIR || `${APP_DIR}/data`;
const VAR_DIR    = process.env.VAR_DIR  || `${APP_DIR}/var`;
const STATIC_DIR = `${APP_DIR}/ui`;
const BASE_PATH  = (process.env.BASE_PATH || "").replace(/\/+$/, "");

const SOCKET_PATH = (process.env.MONITOR_SOCKET_PATH || "").trim();
if (!SOCKET_PATH) {
  console.error("[boot][FATAL] MONITOR_SOCKET_PATH is required — unix socket mode only");
  process.exit(1);
}

const INFO_LOG        = `${VAR_DIR}/info.log`;    // 由 cmd/main 重定向 stdout/stderr 的启动日志
const MONITOR_LOG     = `${VAR_DIR}/monitor.log`; // monitor.js 自身日志文件
const DIAG_TAIL_LINES = 200;                       // 诊断接口读取日志末尾行数上限

// ─── 运行状态 ───────────────────────────────────────────────────────────
let mon = null;        // 成功加载的 monitor.js 模块命名空间
let loadError = null;  // monitor.js 加载 / 初始化失败时的错误对象

// ─── 日志：追加北京时间戳，同时写 info.log 与 monitor.log，并在控制台打印 ──
// 说明：cmd/main 已将本进程 stdout/stderr 重定向进 info.log，故 console 输出
// 会在 info.log 中额外留存一份，属预期内的少量冗余；显式追加则保证脱离重定向
// 运行时两份日志文件依然可见。
function beijingTime() {
  const d = new Date(Date.now() + 8 * 3600000);
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}
function bootLog(msg) {
  const line = `[boot] ${beijingTime()} ${msg}\n`;
  try { appendFileSync(INFO_LOG, line); } catch {}
  try { appendFileSync(MONITOR_LOG, line); } catch {}
  console.log(line.replace(/\n$/, ""));
}

// ─── 进程级兜底：boot 现为 socket 拥有者，绑定冲突时退出交由外部重启 ──────
process.on("uncaughtException", (err) => {
  bootLog(`[FATAL] uncaughtException: ${err?.message || err}\n${err?.stack || ""}`);
  if (err?.code === "EADDRINUSE") {
    // 真正的竞态：另一个实例几乎同时通过了下方的存活探测并抢先绑定。
    // 此时不能继续运行成僵尸实例，直接退出，交给外部重启策略处理。
    bootLog("[FATAL] socket 绑定冲突，退出进程");
    process.exit(1);
  }
});
process.on("unhandledRejection", (err) => {
  bootLog(`[FATAL] unhandledRejection: ${err?.message || err}\n${err?.stack || ""}`);
});

// ─── 单实例保护：绑定 unix socket 前先探测是否已有存活实例（自 monitor.js 迁入）──
// serve() 对 unix socket 的 listen 是异步的，EADDRINUSE 只会以 uncaughtException
// 的形式滞后出现，无法同步发现重复启动。因此启动前主动探测 socket 文件是否真的
// 有进程在监听：若有则直接退出避免抢占；若只是上次进程非正常终止残留的旧文件，
// 先删除再正常绑定。
function checkSocketAlive(path) {
  return new Promise((resolve) => {
    const sock = net.connect(path);
    const finish = (alive) => {
      try { sock.destroy(); } catch {}
      resolve(alive);
    };
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    setTimeout(() => finish(false), 1000);
  });
}

if (existsSync(SOCKET_PATH)) {
  const alive = await checkSocketAlive(SOCKET_PATH);
  if (alive) {
    bootLog(`[FATAL] 检测到另一个实例已在监听 ${SOCKET_PATH}，本进程退出以避免重复启动`);
    process.exit(1);
  } else {
    bootLog(`[启动清理] 发现残留的 socket 文件（无进程监听），已删除：${SOCKET_PATH}`);
    try { unlinkSync(SOCKET_PATH); } catch (e) {
      bootLog(`[启动清理] 删除残留 socket 文件失败: ${e.message}`);
    }
  }
}

// ─── 兜底静态服务 ───────────────────────────────────────────────────────
// content-type 扩展名映射与 monitor.js handleFetch 中的静态资源逻辑保持一致。
function contentTypeOf(fp) {
  const ext = fp.split(".").pop()?.toLowerCase();
  return ext === "html" ? "text/html; charset=utf-8"
       : ext === "js"   ? "application/javascript"
       : ext === "css"  ? "text/css"
       : ext === "png"  ? "image/png"
       : ext === "svg"  ? "image/svg+xml"
       : ext === "webp" ? "image/webp"
       : ext === "gif"  ? "image/gif"
       : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
       : ext === "json" ? "application/json"
       : "text/plain; charset=utf-8";
}

// 读文件并整体载入 Response（沿用 monitor.serveFile 的 file() 流式读取方式）。
async function serveStatic(filePath, contentType) {
  if (!existsSync(filePath)) return new Response("Not Found", { status: 404 });
  try {
    const chunks = [];
    for await (const chunk of file(filePath)) chunks.push(chunk);
    return new Response(Buffer.concat(chunks), {
      headers: { "Content-Type": contentType || contentTypeOf(filePath) },
    });
  } catch (e) {
    return new Response("Internal Server Error", { status: 500 });
  }
}

// 读取日志文件末尾若干行，供诊断接口使用；用 statSync 附带文件大小信息。
function readLogTail(path, maxLines) {
  try {
    if (!existsSync(path)) return "(文件不存在)";
    const size = statSync(path).size;
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    const tail = lines.slice(-maxLines).join("\n");
    return `# size=${size} bytes，末尾 ${maxLines} 行\n${tail}`;
  } catch (e) {
    return `(读取失败: ${e?.message || e})`;
  }
}

// ─── 诊断页：卡片式响应式设计，随 boot 内嵌，经 unix socket 对外提供 ──────
// 经应用 socket 提供（路径 /debug），内外网访问一致，无需独立端口进程。
// 即使 monitor.js 加载失败此页仍可访问，用于查看加载错误、socket/node 状态与日志末尾。
const DIAG_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Hermes Agent 诊断</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:#f2f3f4;color:rgba(14,14,15,1);line-height:1.6}
header{background:#ffffff;padding:22px 20px;border-bottom:1px solid rgba(14,14,15,0.1);border-top:3px solid #5e6ad2;text-align:center}
h1{font-size:22px;font-weight:700;margin-bottom:6px;color:rgba(14,14,15,1);letter-spacing:.3px}
.subtitle{font-size:13px;color:rgba(14,14,15,0.65);margin-top:6px;word-break:break-all}
main{max-width:1100px;margin:0 auto;padding:20px}
.card-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:20px}
@media(max-width:600px){.card-grid{grid-template-columns:1fr}}
.card{background:#ffffff;border:1px solid rgba(14,14,15,0.1);border-radius:10px;padding:16px;box-shadow:0 2px 8px rgba(0,0,0,.06)}
.card-header{display:flex;align-items:center;margin-bottom:12px}
.card-icon{width:32px;height:32px;border-radius:6px;background:#5e6ad2;color:#fff;display:inline-flex;align-items:center;justify-content:center;margin-right:12px;font-size:16px}
.card-title{font-size:14px;font-weight:600;color:rgba(14,14,15,1)}
.card-value{font-size:18px;color:rgba(14,14,15,1);font-weight:600;word-break:break-all}
.card-sub{font-size:12px;color:rgba(14,14,15,0.35);margin-top:4px;word-break:break-all}
.log-section{margin:20px 0}
.log-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.log-title{font-size:15px;font-weight:600;color:rgba(14,14,15,1)}
.btn{background:#5e6ad2;color:#fff;border:none;border-radius:6px;padding:8px 14px;font-size:13px;cursor:pointer;font-weight:500}
.btn:hover{background:#4f5dbf}
.btn-outline{background:transparent;border:1px solid #5e6ad2;color:#5e6ad2}
.btn-outline:hover{background:#5e6ad2;color:#fff}
.log-box{background:#0a0c0f;border:1px solid #2a2f3a;border-radius:8px;padding:16px;font-family:ui-monospace,Menlo,Consolas,"Courier New",monospace;font-size:12px;line-height:1.5;max-height:280px;overflow-y:auto;white-space:pre-wrap;color:#cdd3df}
.suggestions{background:#ffffff;border:1px solid rgba(14,14,15,0.1);border-left:4px solid #5e6ad2;border-radius:6px;padding:14px;margin:16px 0}
.suggestion-list{list-style:none;margin:10px 0 0 0}
.suggestion-list li{margin:8px 0;padding-left:20px;position:relative;font-size:13px;color:rgba(14,14,15,0.65)}
.suggestion-list li:before{content:"✓";color:#26a641;position:absolute;left:0;font-weight:700}
.footer{text-align:center;padding:20px 0;color:rgba(14,14,15,0.35);font-size:12px}
.loading{color:rgba(14,14,15,0.35);font-style:italic}.err{color:#d1242f}.ok{color:#26a641}
@keyframes pulse{0%{opacity:.6}50%{opacity:1}100%{opacity:.6}}.pulse{animation:pulse 1.5s ease-in-out infinite}
</style></head>
<body>
<header><h1>🩺 Hermes Agent 诊断</h1>
<div class="subtitle">经应用 socket 提供，内外网一致可访问 · monitor.js 加载失败时此页仍可用</div></header>
<main>
  <div class="card-grid">
    <div class="card">
      <div class="card-header"><div class="card-icon">🧩</div><div class="card-title">monitor.js 状态</div></div>
      <div id="load-status" class="card-value loading">检测中...</div>
      <div class="card-sub">业务模块加载情况</div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-icon">🔌</div><div class="card-title">Socket 状态</div></div>
      <div id="socket-status" class="card-value loading">检测中...</div>
      <div class="card-sub">${SOCKET_PATH.replace(APP_DIR, '...')}</div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-icon">🔧</div><div class="card-title">Node 版本</div></div>
      <div id="node-version" class="card-value loading">检测中...</div>
      <div class="card-sub">运行时环境</div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-icon">⏰</div><div class="card-title">检测时间</div></div>
      <div id="check-time" class="card-value loading">等待加载</div>
      <div class="card-sub">每 10 秒自动刷新</div>
    </div>
  </div>

  <div class="card" id="error-card" style="border-left:4px solid #d1242f;display:none">
    <div class="log-title" style="margin-bottom:8px;color:#d1242f">⚠️ 加载错误</div>
    <div id="load-error" class="log-box" style="max-height:200px"></div>
  </div>

  <div class="log-section">
    <div class="log-header">
      <div class="log-title">📋 info.log（末尾）</div>
      <button class="btn btn-outline" onclick="refreshLogs()">🔄 刷新</button>
    </div>
    <div id="info-log" class="log-box">加载中...</div>
  </div>

  <div class="log-section">
    <div class="log-header"><div class="log-title">📋 monitor.log（末尾）</div></div>
    <div id="monitor-log" class="log-box">加载中...</div>
  </div>

  <div class="suggestions">
    <div class="log-title" style="margin-bottom:10px">💡 排查建议</div>
    <ul class="suggestion-list">
      <li>查看上方日志是否有报错，重点关注依赖加载失败或编译错误</li>
      <li>确认 Node.js 环境正常，可尝试在应用中心重启本应用</li>
      <li>若最近升级过，考虑回滚到上一个版本</li>
      <li>联系技术支持并附上以上诊断信息</li>
    </ul>
  </div>
</main>
<footer class="footer">Hermes Agent Diagnostic · 经 socket 提供，无需额外端口</footer>
<script>
async function loadInfo(){
  try{
    var r = await fetch("./api/boot/diag", {cache:"no-store"});
    if(!r.ok) throw new Error(r.status+" "+r.statusText);
    var d = await r.json();
    var ls = document.getElementById("load-status");
    ls.textContent = d.loaded ? "✓ 已加载" : "✗ 未加载";
    ls.className = "card-value "+(d.loaded?"ok":"err");
    var ss = document.getElementById("socket-status");
    ss.textContent = d.socketExists ? "✓ 存在" : "✗ 不存在";
    ss.className = "card-value "+(d.socketExists?"ok":"err");
    document.getElementById("node-version").textContent = d.nodeVersion || "未知";
    document.getElementById("node-version").className = "card-value";
    document.getElementById("check-time").textContent = new Date(d.checkTime).toLocaleString("zh-CN");
    document.getElementById("check-time").className = "card-value ok";
    document.getElementById("info-log").textContent = d.infoLogTail || "(无日志内容)";
    document.getElementById("monitor-log").textContent = d.monitorLogTail || "(无日志内容)";
    var ec = document.getElementById("error-card");
    if(d.error){ ec.style.display="block"; document.getElementById("load-error").textContent = d.error; }
    else { ec.style.display="none"; }
  }catch(e){
    document.getElementById("load-status").textContent = "检测失败";
    document.getElementById("info-log").textContent = "无法加载诊断信息：" + (e && e.message || e);
  }
}
function refreshLogs(){
  document.getElementById("info-log").innerHTML = '<span class="pulse">刷新中...</span>';
  loadInfo();
}
loadInfo();
setInterval(loadInfo, 10000);
</script>
</body></html>`;

// ─── 兜底请求处理（仅在 monitor.js 未加载时命中）─────────────────────────
// 统一剥离 fnOS 网关不剥离的 /app/{appname}/ 前缀后再匹配路径。
function bootFallback(req) {
  const url  = new URL(req.url);
  const path = url.pathname.replace(/^\/app\/[^/]+/, "").replace(/\/+$/, "") || "/";

  // 注：/debug 诊断页与 /api/boot/diag 诊断接口已上移至 handleDiag，
  // 在 fetch 调度最前端处理，任何加载状态下都经 socket 对外可访问。

  // 其它 API：monitor 未加载一律 503
  if (path.startsWith("/api/")) {
    return new Response(JSON.stringify({
      error: "monitor not loaded",
      detail: loadError ? (loadError.message || String(loadError)) : null,
    }), { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }

  // 静态资源：根路径与 index.html
  if (path === "/" || path === "/index.html") {
    return serveStatic(`${STATIC_DIR}/index.html`, "text/html; charset=utf-8");
  }
  // fnOS 应用描述文件
  if (path === "/config") {
    return serveStatic(`${STATIC_DIR}/config`, "application/json");
  }
  // /scripts/、/images/、/css/、/js/ 下的静态资源
  if (path.startsWith("/scripts/") || path.startsWith("/images/") ||
      path.startsWith("/css/") || path.startsWith("/js/")) {
    const rel = path.slice(1);
    if (rel.includes("..")) return new Response("Forbidden", { status: 403 });
    return serveStatic(`${STATIC_DIR}/${rel}`, contentTypeOf(rel));
  }
  // 其它路径：命中 STATIC_DIR 下真实存在的文件则返回，否则 404
  const rel = path.slice(1);
  if (rel && !rel.includes("..") && existsSync(`${STATIC_DIR}/${rel}`)) {
    return serveStatic(`${STATIC_DIR}/${rel}`, contentTypeOf(rel));
  }
  return new Response("Not Found", { status: 404 });
}

// ─── 诊断页/接口：始终由 boot 层直接响应，经 socket 对外提供 ─────────────
// 无论 monitor.js 是否加载成功，/debug 与 /api/boot/diag 都由本函数接管，
// 从而保证诊断入口与 hermes-agent 主页面一样走 unix socket，内外网访问一致、无需端口。
function socketAlive() {
  try { return existsSync(SOCKET_PATH) && statSync(SOCKET_PATH).isSocket(); }
  catch { return false; }
}
function handleDiag(req) {
  const url  = new URL(req.url);
  const path = url.pathname.replace(/^\/app\/[^/]+/, "").replace(/\/+$/, "") || "/";

  // 诊断接口：加载状态、socket/node 信息与两份日志末尾
  if (path === "/api/boot/diag") {
    const body = {
      loaded: mon !== null,
      error: loadError ? `${loadError.message || loadError}\n${loadError.stack || ""}` : null,
      checkTime: Date.now(),
      socketPath: SOCKET_PATH,
      socketExists: socketAlive(),
      nodeVersion: process.version,
      appDir: APP_DIR,
      infoLogTail: readLogTail(INFO_LOG, DIAG_TAIL_LINES),
      monitorLogTail: readLogTail(MONITOR_LOG, DIAG_TAIL_LINES),
    };
    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  // 诊断页
  if (path === "/debug") {
    return new Response(DIAG_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  return null;
}

// ─── 绑定 socket 并启动服务 ─────────────────────────────────────────────
// fetch / websocket 均为调度器：monitor 已加载则委派其导出处理器，未加载则走兜底。
serve({
  fetch(req, server) {
    // 诊断页/接口最先处理，确保任何状态下都能经 socket 外部访问
    const diag = handleDiag(req);
    if (diag) return diag;
    if (mon && typeof mon.handleServe === "function") {
      return mon.handleServe(req, server);
    }
    return bootFallback(req);
  },
  websocket: {
    open(ws)         { if (mon && mon.websocket && mon.websocket.open)    mon.websocket.open(ws); else { try { ws.close(); } catch {} } },
    message(ws, msg) { if (mon && mon.websocket && mon.websocket.message) mon.websocket.message(ws, msg); },
    close(ws)        { if (mon && mon.websocket && mon.websocket.close)   mon.websocket.close(ws); },
    drain(ws)        { if (mon && mon.websocket && mon.websocket.drain)   mon.websocket.drain(ws); },
  },
  error(err) {
    bootLog(`Server error: ${err?.message || err}`);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  },
  unix: SOCKET_PATH,
  idleTimeout: 255,
});

// socket 由 listen 异步创建，此处 chmod 可能早于文件生成而失败（吞掉即可），
// cmd/main 侦测到 socket 后会再兜底 chmod 777，两者行为与原 monitor.js 一致。
try { chmodSync(SOCKET_PATH, 0o777); } catch {}

// ─── 动态加载业务模块 monitor.js ────────────────────────────────────────
// 任何加载 / 初始化异常都被此处捕获：mon 保持为 null，服务自动进入兜底诊断模式。
try {
  const m = await import("./monitor.js");
  if (typeof m.startMonitor === "function") await m.startMonitor();
  mon = m;
  bootLog(`Monitor ready — unix:${SOCKET_PATH} (base=${BASE_PATH || "/"}) | dashboard proxied at /proxy/dashboard/`);
} catch (e) {
  loadError = e;
  bootLog(`[FATAL] monitor.js 加载失败，进入兜底诊断模式（可访问 /debug）: ${e?.message || e}\n${e?.stack || ""}`);
}
