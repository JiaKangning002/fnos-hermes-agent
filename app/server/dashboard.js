// Dashboard 集成模块 — 集中承载 monitor.js 中所有 Dashboard 专属逻辑：
//   端口常量 / 进程启停(spawn 参数) / 健康探测 / HTTP 反代(前缀改写 + 注入脚本)
//   / WS 反代(升级路由 + open/message/close 分支 + 反代加固：重连/心跳/缓冲)
//
// 使用方式（monitor.js）：
//   initDashboard({ port, gatewayPort, basePath, pidFile, log, readPid,
//                   stopPid, spawnHermes, restartGateway })
// 共用基础设施（端口探测 / 进程管理 / 日志 / PID 读写）保留在 monitor.js，
// 由上面的依赖注入传入，本模块不复制实现；Dashboard 相关问题只需修改本文件。
import { spawn, WebSocketClient } from "./node-adapter.js";

// ─── Dashboard 端口常量（monitor.js 的 gateway/dashboard 联合端口决策会引用） ───
export const DEFAULT_DASHBOARD_PORT = 9119;
export const ALTERNATE_DASHBOARD_PORT = 29119;
export const DASHBOARD_BIND = "127.0.0.1";

// ─── 注入的运行时依赖与解析后配置 ─────────────────────────────────────
let D = {
  port: DEFAULT_DASHBOARD_PORT,   // 解析后的 Dashboard 端口
  gatewayPort: 0,                 // 网关端口（反代层网关重启收尾判定用）
  basePath: "",                   // BASE_PATH（fnOS 反代前缀）
  pidFile: "",                    // dashboard.pid 路径
  log: () => {},
  readPid: () => null,
  stopPid: async () => {},
  spawnHermes: () => ({ ok: false }),
  restartGateway: async () => ({ ok: false, error: "not_configured" }),
};

export function initDashboard(deps) {
  D = { ...D, ...deps };
}

export function getDashboardPort() {
  return D.port;
}

// ─── 进程启停 ───────────────────────────────────────────────────────
export function spawnDashboard() {
  return D.spawnHermes("dashboard", D.pidFile, ["dashboard", "--host", DASHBOARD_BIND, "--port", String(D.port), "--no-open", "--insecure"]);
}

// POST /api/dashboard/start
export function handleDashboardStart(jsonHeaders) {
  const r = spawnDashboard();
  return new Response(JSON.stringify({ dashboard: r }), { headers: jsonHeaders() });
}

// POST /api/dashboard/stop
export async function handleDashboardStop(jsonHeaders) {
  const dbAlive = D.readPid(D.pidFile);
  await D.stopPid(D.pidFile);
  // 强制杀掉残留的 dashboard 进程（PID 文件可能已失效）
  try {
    const proc = spawn(["pkill", "-SIGKILL", "-f", "hermes-agent.*dashboard"]);
    await proc.exited;
  } catch {}
  if (dbAlive) D.log("Dashboard stopped (pid=" + dbAlive + ")");
  return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders() });
}

// ─── 健康探测（getStatus 在 PID 存活时调用） ─────────────────────────
export async function checkDashboardHealth() {
  try {
    const r = await fetch(`http://${DASHBOARD_BIND}:${D.port}/`, {
      signal: AbortSignal.timeout(300),
    });
    return r.ok;
  } catch { return false; }
}

// ─── HTTP 反代 ──────────────────────────────────────────────────────
let managedRestartAction = null;

// /proxy/dashboard 路由入口：前缀剥离守卫 + 未运行 503 + 反代
export function handleDashboardHttp(req, path) {
  const subPath = path.replace(/^\/proxy\/dashboard/, "") || "/";
  if (subPath.includes("..")) return new Response("Forbidden", { status: 403 });

  // Dashboard 未运行时直接返回 503，不进入 proxy 避免打错误日志
  if (!D.readPid(D.pidFile)) {
    return new Response(JSON.stringify({ error: "Dashboard is not running" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
  return proxyDashboard(req);
}

async function proxyDashboard(req) {
  const url     = new URL(req.url);
  // req.url 仍含 BASE_PATH 前缀（handleFetch 只剥了 path 变量），需先去掉
  const subPath = url.pathname
    .replace(new RegExp(`^${D.basePath.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}`), "")
    .replace(/^\/proxy\/dashboard/, "") || "/";
  const target  = `http://${DASHBOARD_BIND}:${D.port}${subPath}${url.search}`;

  const prefix = `${D.basePath || ""}/proxy/dashboard`;

  if (req.method === "POST" && subPath === "/api/gateway/restart") {
    if (managedRestartAction?.running) {
      return new Response(JSON.stringify({
        ok: true,
        pid: managedRestartAction.pid,
        name: "gateway-restart",
        reused: true,
      }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    managedRestartAction = {
      running: true,
      exit_code: null,
      pid: null,
      lines: [`=== fnOS gateway restart started ${new Date().toISOString()} ===`],
    };
    try {
      const result = await D.restartGateway();
      if (!result?.ok || !result?.pid) {
        throw new Error(result?.error || "gateway did not start");
      }
      managedRestartAction.pid = result.pid;
      managedRestartAction.running = false;
      managedRestartAction.exit_code = 0;
      managedRestartAction.lines.push(
        `Gateway restarted by fnOS process manager: ${result.old_pid || "none"} -> ${result.pid}`,
      );
      D.log(`[restart] fnOS 网关重启完成 ${result.old_pid || "none"} -> ${result.pid}`);
      return new Response(JSON.stringify({
        ok: true,
        pid: result.pid,
        name: "gateway-restart",
      }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    } catch (e) {
      managedRestartAction.running = false;
      managedRestartAction.exit_code = 1;
      managedRestartAction.lines.push(`Gateway restart failed: ${e?.message || e}`);
      D.log(`[restart] fnOS 网关重启失败：${e?.message || e}`);
      return new Response(JSON.stringify({
        ok: false,
        error: e?.message || String(e),
      }), { status: 500, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
  }

  if (req.method === "GET" && subPath === "/api/actions/gateway-restart/status" && managedRestartAction) {
    return new Response(JSON.stringify({
      name: "gateway-restart",
      running: managedRestartAction.running,
      exit_code: managedRestartAction.exit_code,
      pid: managedRestartAction.pid,
      lines: managedRestartAction.lines,
    }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }

  try {
    const headers = new Headers(req.headers);
    headers.delete("host");
    const hasReqBody = req.method !== "GET" && req.method !== "HEAD";
    const upstream = await fetch(target, {
      method:  req.method,
      headers,
      body:    hasReqBody ? req.body : undefined,
      duplex:  hasReqBody ? "half" : undefined,
      signal:  AbortSignal.timeout(10000),
    });

    const respHeaders = new Headers(upstream.headers);

    // ── 3xx 重定向：改写 Location 头 ──
    if (upstream.status >= 300 && upstream.status < 400) {
      const loc = respHeaders.get("location");
      if (loc) {
        try {
          const abs = new URL(loc, target);
          respHeaders.set("location", prefix + abs.pathname + abs.search);
        } catch {}
      }
      return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
    }

    const contentType = respHeaders.get("content-type") || "";

    // ── CSS 响应：改写 url(/...) 加前缀，让字体等 url() 引用能正确路由 ──
    if (contentType.includes("text/css") || subPath.endsWith(".css")) {
      let css = await upstream.text();
      css = css.replace(/url\((\/[^)'"]+)\)/g, `url(${prefix}$1)`);
      respHeaders.delete("content-length");
      return new Response(css, { status: upstream.status, headers: respHeaders });
    }

    // ── HTML 响应：注入 <base> + 路径改写脚本 ──
    if (contentType.includes("text/html")) {
      let html = await upstream.text();

      // <base> 处理相对路径（CSS url()、相对 src 等）—— 多模式兼容
      if (!/<base\s[^>]*>/i.test(html)) {
        // 尝试：<head attr="value"> / <head/> / <head \n...>
        const headMatch = html.match(/<head(?:\s[^>]*)?>/i);
        if (headMatch) {
          const endIdx = headMatch.index + headMatch[0].length;
          html = html.slice(0, endIdx) + `<base href="${prefix}/">` + html.slice(endIdx);
        } else {
          // 兜底：在最接近开头的位置插入
          const htmlIdx = html.indexOf('<html');
          const idx = htmlIdx !== -1 ? htmlIdx : 0;
          const baseTag = `<base href="${prefix}/">`;
          if (idx === -1) {
            html = baseTag + html;
          } else {
            html = html.slice(0, idx) + `<div>${baseTag}</div>` + html.slice(idx);
          }
        }
      }

      // 静态重写 src 属性中的绝对路径（脚本、图片等）
      html = html.replace(/\bsrc="\/(?!\/)/g, `src="${prefix}/`);
      // 静态重写 <link href>（CSS 样式表），不改写 <a href>（SPA 路由需要原始路径）
      html = html.replace(/<link(\s[^>]*)href="\/(?!\/)/g, (m, a) => `<link${a}href="${prefix}/`);
      
      // 额外补漏：把模块 preload links 也加前缀（上游很多 modulepreload）
      // ⚠️ 只改写 /assets/开头的，避免重复加前缀（<base>已生效时会自动解析相对路径）
      html = html.replace(/<link(\s[^>]*)rel="modulepreload"(\s[^>]*)href="\/assets\//g,
        (match, before, after) => `<link${before}rel="modulepreload"${after}href="${prefix}/assets/`);

      // 注入 CSS：小屏 UI 修正（只在代理层注入覆盖，不改上游 Dashboard 本体）
      //   1. 侧边栏浮层背景：<1024px(lg) 时 #app-sidebar 是 fixed 浮层，上游内联 style 的
      //      --component-sidebar-background 是半透明玻璃色，会透出后面正文。这里用主题背景色
      //      --background-base（ThemeProvider 换主题时重写，深浅色自适应）打底 80% 不透明
      //      + 毛玻璃模糊；须 !important 才能压过内联 style；桌面态(≥lg)不受影响。
      //   2. 小屏字号基准：--theme-base-size 是全局 rem/字号基准（html{font-size:var(...)}），
      //      上游默认 18px 在手机上偏大。≤768px（与上游 index.css 自身的移动态断点一致）
      //      统一降为 15px（上游 :root 默认值，设计体系内现成的可读档位）；
      //      ThemeProvider 会把该变量写成内联 style，须 !important 才能压过；
      //      再对 html 直接补一道 font-size 兜底，防上游内联写死 font-size 的情况。
      //   3. 语言切换按钮：其文字 label 带 Tailwind hidden sm:inline，<640px(sm) 时按钮内
      //      只剩被隐藏的文字、无任何图标 → 整个按钮不可见。恢复文字显示即可（点击行为不变）。
      //      用 :not(:has(svg)) 精确区分它与旁边带调色板图标的主题切换按钮；
      //      不支持 :has 的浏览器走 @supports 兜底，放宽到两个按钮的文字都恢复显示。
      const styleInject = `<style>
@media (max-width: 1023.98px) {
  #app-sidebar {
    background: var(--background-base, #041c1c) !important;
    background: color-mix(in srgb, var(--background-base, #041c1c) 80%, transparent) !important;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }
}
@media (max-width: 768px) {
  :root {
    --theme-base-size: 15px !important;
  }
  html {
    font-size: var(--theme-base-size, 15px) !important;
  }
}
@media (max-width: 639.98px) {
  #app-sidebar button[aria-haspopup="listbox"]:not(:has(svg)) .hidden {
    display: inline !important;
  }
}
@supports not selector(:has(*)) {
  @media (max-width: 639.98px) {
    #app-sidebar button[aria-haspopup="listbox"] .hidden {
      display: inline !important;
    }
  }
}
/* Dashboard 模型管理区按钮对齐：统一 Refresh Models / Cancel / Switch 三个按钮的高度 */
.lucide-refresh-cw,
[class*="lucide-"] svg {
  width: 1rem !important;
  height: 1rem !important;
}
.font-mono.group.relative.grid.cursor-pointer.flex.items-center.gap-2.mx-auto button {
  min-height: 2.5rem !important;
  padding: 0.625em 1em !important;
}
</style>`;

      // 注入 JS：智能前缀管理（pushState剥离+导航感知恢复+popstate拦截）
      const inject = `<script>
(function(){
  var P="${prefix}";
  function rw(u){
    if(typeof u!=="string")return u;
    if(u.indexOf("//")===0)return u;
    if(/^[a-z]+:/i.test(u)){
      try{
        var a=new URL(u,location.origin);
        if(a.origin===location.origin&&a.pathname.charAt(0)==="/"&&a.pathname.indexOf(P)!==0){
          a.pathname=P+a.pathname;
          return a.href;
        }
      }catch(e){}
      return u;
    }
    if(u.charAt(0)==="/"){if(u.indexOf(P)===0)return u;return P+u;}
    return u;
  }
  function strip(u){
    if(typeof u!=="string")return u;
    if(u.indexOf(P)===0)return u.substring(P.length)||"/";
    return u;
  }
  var _ps=history.pushState,_rs=history.replaceState;
  var _pn=location.pathname;
  /* ── 安全恢复前缀（微任务，比 rAF 更快恢复前缀） ── */
  function sched(){
    Promise.resolve().then(function(){
      if(location.pathname===_pn){
        var s=location.search||"",h=location.hash||"";
        _rs.call(history,history.state,"",rw(_pn)+s+h);
      }
    });
  }
  /* ── 初始加载：清理 URL 让 SPA 路由启动 ── */
  if(_pn.indexOf(P)===0){
    var cl=_pn.substring(P.length)||"/";
    _rs.call(history,history.state,"",cl+location.search+location.hash);
    _pn=cl;
    sched();
  }
  /* ── pushState：剥离前缀给路由，微任务恢复前缀给地址栏 ── */
  history.pushState=function(s,t,u){
    _pn=u?(u.split("?")[0].split("#")[0]):location.pathname;
    var c=u?strip(u):u;
    _ps.call(this,s,t,c);
    if(u)sched();
  };
  history.replaceState=function(s,t,u){
    _pn=u?(u.split("?")[0].split("#")[0]):location.pathname;
    var c=u?strip(u):u;
    _rs.call(this,s,t,c);
    if(u)sched();
  };
  /* ── popstate：后退/前进时临时清理 URL ── */
  var _ae=EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener=function(type,fn,opt){
    if(type==="popstate"&&fn){
      var w=function(ev){
        var cp=location.pathname;
        var cl=cp.indexOf(P)===0?(cp.substring(P.length)||"/"):cp;
        _rs.call(history,history.state,"",cl+location.search+location.hash);
        _pn=cl;
        fn.call(this,ev);
        _rs.call(history,history.state,"",cp+location.search+location.hash);
        _pn=cp;
      };
      return _ae.call(this,type,w,opt);
    }
    return _ae.call(this,type,fn,opt);
  };
  /* ── fetch / XHR：添加前缀 ── */
  var _f=window.fetch;
  window.fetch=function(i,o){
    if(typeof i==="string")i=rw(i);
    else if(i&&i.url)return _f(new Request(rw(i.url),i),o);
    return _f.call(this,i,o);
  };
  var _xo=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(){
    if(arguments.length>1)arguments[1]=rw(arguments[1]);
    return _xo.apply(this,arguments);
  };
  /* ── MutationObserver：只改写 src ── */
  function rwEl(el){
    if(el.hasAttribute("src")){var s=el.getAttribute("src");if(s&&s.charAt(0)==="/"&&s.indexOf(P)!==0)el.setAttribute("src",P+s);}
  }
  new MutationObserver(function(ms){ms.forEach(function(m){if(m.type==="childList")m.addedNodes.forEach(function(n){if(n.nodeType===1){rwEl(n);n.querySelectorAll&&n.querySelectorAll("[src]").forEach(rwEl);}});});}).observe(document.documentElement,{childList:true,subtree:true});
  document.querySelectorAll("[src]").forEach(rwEl);
  /* ── hook HTMLScriptElement.src setter：createElement("script") 后 v.src=...
     走的不是 fetch/XHR，需要在这里加前缀 ── */
  var _sp=HTMLScriptElement.prototype,_sd=Object.getOwnPropertyDescriptor(_sp,"src");
  if(_sd&&_sd.set){var _ss=_sd.set,_sg=_sd.get;Object.defineProperty(_sp,"src",{get:function(){return _sg?_sg.call(this):undefined;},set:function(v){_ss.call(this,rw(v));},configurable:true,enumerable:_sd.enumerable});}
  /* ── hook HTMLLinkElement.href setter：createElement("link") 后 x.href=...
     走的不是 fetch/XHR，需要在这里加前缀 ── */
  var _lp=HTMLLinkElement.prototype,_ld=Object.getOwnPropertyDescriptor(_lp,"href");
  if(_ld&&_ld.set){var _ls=_ld.set,_lg=_ld.get;Object.defineProperty(_lp,"href",{get:function(){return _lg?_lg.call(this):undefined;},set:function(v){_ls.call(this,rw(v));},configurable:true,enumerable:_ld.enumerable});}
  /* ── hook WebSocket：给 dashboard WS URL 加前缀，路由到 monitor 反代 ── */
  var _WS=window.WebSocket;
  /* iOS 第三方输入法(如百度)在 xterm 终端无法输入的补偿所需：
     捕获 /api/pty 连接并包裹其 send 以记录 xterm 实际发出的输入 */
  var _activePty=null, _ptySent=[];
  function _hookPty(sock, pathname){
    try{
      if(!sock||!pathname||pathname.indexOf("/api/pty")===-1)return sock;
      _activePty=sock;
      var _os=sock.send;
      sock.send=function(d){
        try{
          var s=(typeof d==="string")?d:(d?new TextDecoder().decode(d):"");
          if(s){_ptySent.push({t:Date.now(),s:s});if(_ptySent.length>80)_ptySent.shift();}
        }catch(e){}
        return _os.apply(this,arguments);
      };
      sock.addEventListener("close",function(){if(_activePty===sock)_activePty=null;});
    }catch(e){}
    return sock;
  }
  window.WebSocket=function(url,protocols){
    try{
      if(typeof url==="string"){
        var u=new URL(url,location.origin);
        if(u.pathname.charAt(0)==="/"&&u.pathname.indexOf(P)!==0){
          var newUrl=(location.protocol==="https:"?"wss:":"ws:")+"//"+location.host+P+u.pathname+(u.search||"")+(u.hash||"");
          return _hookPty(new _WS(newUrl,protocols),u.pathname);
        }
        return _hookPty(new _WS(url,protocols),u.pathname);
      }
    }catch(e){}
    return new _WS(url,protocols);
  };
  window.WebSocket.prototype=_WS.prototype;
  /* 关键：保留构造器静态常量（CONNECTING/OPEN/CLOSING/CLOSED）。
     dashboard 前端发送输入前常用 ws.readyState===WebSocket.OPEN 做门禁；
     覆盖构造器若丢掉这些常量，OPEN 变 undefined → 门禁永不成立 → 输入帧发不出去
     （服务端推来的输出仍走 onmessage，故表现为“画面能显示、但无法输入/发送”）。 */
  window.WebSocket.CONNECTING=_WS.CONNECTING;
  window.WebSocket.OPEN=_WS.OPEN;
  window.WebSocket.CLOSING=_WS.CLOSING;
  window.WebSocket.CLOSED=_WS.CLOSED;
  /* ── iOS 第三方输入法(百度等)组合输入补偿 ──
     现象：iPhone 上用第三方 IME 在 Dashboard 终端(xterm)对话打不出字，自带键盘正常。
     根因：部分第三方 IME 的组合提交未触发 xterm 期望的事件序列，组合文字从不经
     /api/pty 发出。这里在组合结束/插入后核对：若该文字未被 xterm 经 pty socket 发出，
     则由我们补发到 /api/pty（服务端 pty_ws 同时接受 text/bytes 帧，text 按 UTF-8 编码）。
     去重：仅当“事件发生之后”pty 未发出该文字才补发；xterm 正常处理会在事件后立即发出，
     且我们自己的补发也会被记录，天然避免重复；不同次提交按时间戳区分，允许连续重复字。 */
  function _isTermTarget(t){
    try{return !!(t&&((t.classList&&t.classList.contains("xterm-helper-textarea"))||(t.closest&&t.closest(".xterm"))));}
    catch(e){return false;}
  }
  function _ptyReconcileSend(text,mark){
    if(!text||!_activePty||_activePty.readyState!==1)return;
    setTimeout(function(){
      try{
        if(!_activePty||_activePty.readyState!==1)return;
        var after="";
        for(var i=0;i<_ptySent.length;i++){if(_ptySent[i].t>=mark-5)after+=_ptySent[i].s;}
        if(after.indexOf(text)!==-1)return;   /* xterm 已发出，勿重复 */
        _activePty.send(text);
      }catch(e){}
    },80);
  }
  var _isIosTouch=/iP(hone|ad|od)/.test(navigator.userAgent)||
    (navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1);
  if(_isIosTouch){
    document.addEventListener("compositionend",function(ev){
      try{if(ev&&ev.data&&_isTermTarget(ev.target))_ptyReconcileSend(String(ev.data),Date.now());}catch(e){}
    },true);
    document.addEventListener("input",function(ev){
      try{
        if(!ev||ev.isComposing||!ev.data||!_isTermTarget(ev.target))return;
        if(ev.inputType&&ev.inputType!=="insertText"&&ev.inputType!=="insertCompositionText")return;
        _ptyReconcileSend(String(ev.data),Date.now());
      }catch(e){}
    },true);
  }
})();
<\/script>`;

      html = html.replace("</head>", styleInject + inject + "\n</head>");

      respHeaders.delete("content-length");
      respHeaders.delete("content-encoding");
      return new Response(html, { status: upstream.status, headers: respHeaders });
    }

    // ── 非 HTML 响应：原样透传 ──
    return new Response(upstream.body, {
      status:  upstream.status,
      headers: respHeaders,
    });
  } catch (e) {
    // 连接拒绝/Dashboard 未就绪属正常现象（启动期间），仅非预期错误才记录
    const msg = e?.message || '';
    if (msg && !/connect|refused|abort|ECONN/i.test(msg)) D.log(`proxy error: ${msg}`);
    return new Response(JSON.stringify({ error: "Dashboard unavailable" }), {
      status:  502,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// ─── WS 反代 ────────────────────────────────────────────────────────
// Dashboard WebSocket 反代路径：/proxy/dashboard/api/(ws|events|pty)
export function matchDashboardWsPath(wsPath) {
  return wsPath.startsWith("/proxy/dashboard/api/ws") ||
         wsPath.startsWith("/proxy/dashboard/api/events") ||
         wsPath.startsWith("/proxy/dashboard/api/pty");
}

// WS 升级路由：未运行 503 / 升级失败 500 / 升级成功返回 undefined
export function upgradeDashboardWs(req, server, wsPath, url) {
  if (!D.readPid(D.pidFile)) {
    return new Response(JSON.stringify({ error: "Dashboard is not running" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
  const subPath = wsPath.replace(/^\/proxy\/dashboard/, "");
  const targetUrl = `ws://${DASHBOARD_BIND}:${D.port}${subPath}${url.search}`;
  const upgraded = server.upgrade(req, { data: { type: "dashboard-proxy", targetUrl } });
  if (!upgraded) return new Response("WebSocket upgrade failed", { status: 500 });
  return;
}

// wsHandler.open 的 dashboard-proxy 分支
export function handleDashboardWsOpen(ws) {
  const { targetUrl } = ws.data;
  if (!targetUrl) {
    // 防御性兜底：正常情况下 node-adapter.js 已经不会再产出没有
    // targetUrl 的连接了，这里只是避免万一出现该情况时直接把 null
    // 传给 WebSocketClient 构造函数，导致 ws 库内部访问
    // options.autoPong 时抛出 TypeError。
    D.log(`[WS-PROXY] open with empty targetUrl, closing`);
    try { ws.close(1011, "no target url"); } catch {}
    return;
  }
  D.log(`[WS-PROXY] open → ${targetUrl}`);
  // 加固接入：上游断线重连（4409 静默重挂 / 异常码指数退避）、
  // 双向 30s 心跳、重连窗口内浏览器消息缓冲；message()/close()
  // 分支照旧读 ws.data.upstream，无需感知重连过程
  wrapDashboardProxy(ws, () => new WebSocketClient(targetUrl, {
    // 显式传 Host header 匹配上游 loopback 校验（_is_accepted_host）
    headers: { "Host": `${DASHBOARD_BIND}:${D.port}` },
  }), { log: D.log });
}

// wsHandler.message 的 dashboard-proxy 分支：客户端 → 上游
export function handleDashboardWsMessage(ws, msg) {
  if (ws.data.upstream && ws.data.upstream.readyState === 1) {
    try { ws.data.upstream.send(msg); } catch {}
  }
}

// wsHandler.close 的 dashboard-proxy 分支
export function handleDashboardWsClose(ws) {
  if (ws.data.upstream) {
    try { ws.data.upstream.close(); } catch {}
  }
  D.log(`[WS-PROXY] client closed`);
}

// ─── WS 反代加固 — 上游重连 / 关闭码分类 / 双向心跳 / 断线消息缓冲 ───────
//
// 由上方 handleDashboardWsOpen 在 open() 一处接入：
//   wrapDashboardProxy(ws, upstreamFactory, { log })
//
// 依赖约定（与 node-adapter.js 的 ws 抽象一致，不引第三方库）：
//   - ws        浏览器侧连接：send / close / ping / on("pong") / on("close")
//   - upstream  由 upstreamFactory() 每次新建（相同 URL 与鉴权头重新拨号）：
//               addEventListener(open/message/close/error)、send / close，
//               可选 ping / on("pong") / terminate
//
// 与 message()/close() 分支的配合方式：分支保持原样——转发分支只认
// ws.data.upstream.readyState === 1 后调用 send()，因此重连窗口内本模块把
// ws.data.upstream 换成一个 readyState=1 的缓冲桩，消息自然落入 sendQueue，
// 重连成功后按原顺序 flush，转发分支无需感知重连过程。

// 指数退避延迟：baseMs 起步，每次 ×2，封顶 maxMs
function backoffDelay(attempt, baseMs = 500, maxMs = 8000) {
  return Math.min(baseMs * Math.pow(2, Math.max(0, attempt)), maxMs);
}

// 上游关闭码分类：
//   1000/1001       正常关闭（用户主动离开）→ 原样透传给浏览器，不重连
//   4409            会话被新连接顶替 → 静默快速重连，不通知浏览器
//   其余（含 1006） 异常断开 → 指数退避重连，超限才向浏览器上报关闭
function classifyClose(code) {
  if (code === 1000 || code === 1001) return "passthrough";
  if (code === 4409) return "silent-reconnect";
  return "backoff-reconnect";
}

// ─── /api/ws 控制通道「秒关重连风暴」诊断（仅观测，不改变任何反代行为）───
// 单窗口下上游常以 code=1000 秒关控制通道，官方 SPA 随即无限重连直至卡死。
// 现有日志看不出单连接存活时长与单位时间重连频次，此处补齐这两项确证数据。
const CTRL_WS_DIAG_WINDOW_MS = 10000;   // 重连次数统计的滚动窗口
const CTRL_WS_SHORT_LIFE_MS = 2000;     // 判定「秒关」的存活时长阈值
const ctrlWsRecentCloses = [];          // 近期秒关时刻（毫秒时间戳），仅诊断用

// token 脱敏：仅保留首尾各若干位，避免诊断日志泄露完整凭证
function maskToken(token) {
  if (!token) return "none";
  const s = String(token);
  if (s.length <= 8) return s.slice(0, 2) + "…";
  return s.slice(0, 4) + "…" + s.slice(-4);
}

function wrapDashboardProxy(ws, upstreamFactory, opts = {}) {
  const {
    log = () => {},
    pingIntervalMs = 30000,   // 双向心跳间隔
    pongTimeoutMs = 10000,    // ping 后等待 pong 的超时
    reconnectBaseMs = 500,    // 退避起步延迟
    reconnectMaxMs = 8000,    // 退避封顶延迟
    maxAttempts = 10,         // 连续重连上限
    silentRetryMs = 200,      // 4409 静默重连的固定短延迟
    maxQueue = 256,           // 断线缓冲队列上限（超出丢弃最新消息）
    stableResetMs = 5000,     // 连接保持该时长后重连计数归零
  } = opts;

  const state = {
    closed: false,   // 整条反代链路已终止
    attempts: 0,     // 连续重连次数（连接稳定后归零）
    queue: [],       // 重连窗口内浏览器侧待发消息（FIFO）
  };
  let clientPingTimer = null, clientPongTimer = null, reconnectTimer = null;
  let clearUpstreamTimers = () => {};

  // ── /api/ws 控制通道诊断上下文（仅观测）──
  // openTs 记录本连接首次建立时刻，供上游秒关时计算存活时长；
  // ctrlWsDiag 仅在控制通道 /api/ws 时非空，避免污染 /api/events、/api/pty 日志。
  const openTs = Date.now();
  let ctrlWsDiag = null;
  try {
    const tu = new URL(ws.data && ws.data.targetUrl);
    if (tu.pathname.startsWith("/api/ws")) {
      ctrlWsDiag = {
        path: tu.pathname,
        token: tu.searchParams.get("token"),
        channel: tu.searchParams.get("channel"),
      };
    }
  } catch {}

  // 终止整条链路：清定时器、清队列、关掉真实上游（幂等）
  function shutdown() {
    if (state.closed) return;
    state.closed = true;
    state.queue.length = 0;
    clearInterval(clientPingTimer);
    clearTimeout(clientPongTimer);
    clearTimeout(reconnectTimer);
    clearUpstreamTimers();
    const up = ws.data && ws.data.upstream;
    if (up && !up.isReconnectBuffer) { try { up.close(); } catch {} }
  }

  // 重连窗口内的缓冲桩：readyState=1 让转发分支照常调用 send()，
  // 消息进入队列；close() 表示浏览器侧主动断开，直接终止链路
  function bufferStub() {
    return {
      readyState: 1,
      isReconnectBuffer: true,
      send: (msg) => { if (state.queue.length < maxQueue) state.queue.push(msg); },
      close: () => shutdown(),
    };
  }

  function flushQueue(upstream) {
    while (state.queue.length > 0) {
      const msg = state.queue.shift();
      try { upstream.send(msg); } catch { break; }
    }
  }

  function scheduleReconnect(kind, code, reason) {
    if (state.closed) return;
    if (state.attempts >= maxAttempts) {
      // 重连彻底失败：丢弃缓冲并向浏览器上报关闭
      // （1006/1005 等码不允许出现在主动发送的关闭帧里，统一用 1011）
      log(`[WS-PROXY] reconnect gave up after ${state.attempts} attempts (last code=${code})`);
      try { ws.close(1011, String(reason || "upstream unavailable")); } catch {}
      shutdown();
      return;
    }
    const delay = kind === "silent-reconnect"
      ? silentRetryMs
      : backoffDelay(state.attempts, reconnectBaseMs, reconnectMaxMs);
    state.attempts += 1;
    ws.data.upstream = bufferStub();
    log(`[WS-PROXY] upstream lost (code=${code}), reconnect #${state.attempts} in ${delay}ms`);
    reconnectTimer = setTimeout(dial, delay);
  }

  function dial() {
    if (state.closed) return;
    let upstream;
    try {
      upstream = upstreamFactory();
    } catch (e) {
      log(`[WS-PROXY] upstream dial failed: ${e?.message || e}`);
      scheduleReconnect("backoff-reconnect", 1006, "dial failed");
      return;
    }
    attach(upstream);
  }

  function attach(upstream) {
    let upPingTimer = null, upPongTimer = null, stableTimer = null;
    let settled = false; // 同一连接的 close 只处理一次
    const clearUp = () => {
      clearInterval(upPingTimer);
      clearTimeout(upPongTimer);
      clearTimeout(stableTimer);
    };
    clearUpstreamTimers = clearUp;

    upstream.addEventListener("open", () => {
      if (state.closed) { try { upstream.close(); } catch {} return; }
      log(`[WS-PROXY] upstream connected${state.attempts ? ` (reconnect #${state.attempts})` : ""}`);
      // 连上后才把真实上游暴露给转发分支，并把缓冲队列按原顺序补发
      ws.data.upstream = upstream;
      flushQueue(upstream);
      // 连接稳定一段时间后重连计数归零，避免抖动/顶替循环耗尽次数
      stableTimer = setTimeout(() => { state.attempts = 0; }, stableResetMs);
      // 上游侧 30s 心跳（抽象层无 ping 能力时自动跳过）
      if (typeof upstream.ping === "function") {
        upPingTimer = setInterval(() => {
          try { upstream.ping(); } catch { return; }
          if (!upPongTimer) {
            upPongTimer = setTimeout(() => {
              log("[WS-PROXY] upstream pong timeout, terminating");
              try { (upstream.terminate || upstream.close).call(upstream); } catch {}
            }, pongTimeoutMs);
          }
        }, pingIntervalMs);
        if (typeof upstream.on === "function") {
          upstream.on("pong", () => { clearTimeout(upPongTimer); upPongTimer = null; });
        }
      }
    });

    upstream.addEventListener("message", (event) => {
      try { ws.send(event.data); } catch {}
    });

    upstream.addEventListener("close", (event) => {
      if (settled) return;
      settled = true;
      clearUp();
      if (state.closed) return;
      const code = event && event.code;
      const reason = event && event.reason;
      const decision = classifyClose(code);
      log(`[WS-PROXY] upstream closed code=${code} → ${decision}`);
      // ── /api/ws 控制通道秒关诊断（仅观测，不影响下方关闭/重连决策）──
      // 上游以 code=1000 关闭且本连接存活不足阈值时，输出确证数据：脱敏 token、
      // 请求 path（带 channel 参数时一并记录）、首次 open 时刻、关闭码与原因、
      // 存活毫秒数，并附带近 10 秒滚动窗口内的秒关重连次数。
      if (ctrlWsDiag && code === 1000) {
        const aliveMs = Date.now() - openTs;
        if (aliveMs < CTRL_WS_SHORT_LIFE_MS) {
          const now = Date.now();
          ctrlWsRecentCloses.push(now);
          // 裁剪窗口外的历史项，避免数组无限增长
          while (ctrlWsRecentCloses.length && now - ctrlWsRecentCloses[0] > CTRL_WS_DIAG_WINDOW_MS) {
            ctrlWsRecentCloses.shift();
          }
          const chan = ctrlWsDiag.channel ? ` channel=${ctrlWsDiag.channel}` : "";
          log(`[WS-PROXY][diag] /api/ws 秒关 token=${maskToken(ctrlWsDiag.token)} path=${ctrlWsDiag.path}${chan} openAt=${new Date(openTs).toISOString()} code=${code} reason=${reason || ""} alive=${aliveMs}ms 近10s重连${ctrlWsRecentCloses.length}次`);
        }
      }
      if (decision === "passthrough") {
        try { ws.close(code, reason); } catch {}
        shutdown();
      } else {
        scheduleReconnect(decision, code, reason);
      }
    });

    upstream.addEventListener("error", () => {
      // 拨号失败/传输异常随后必有 close 事件走重连决策，这里仅吞掉避免未捕获异常
    });
  }

  // 浏览器侧 30s 心跳：pong 超时视为浏览器已死，终止链路
  if (typeof ws.ping === "function") {
    clientPingTimer = setInterval(() => {
      try { ws.ping(); } catch { return; }
      if (!clientPongTimer) {
        clientPongTimer = setTimeout(() => {
          log("[WS-PROXY] client pong timeout, closing");
          try { ws.close(1011, "client pong timeout"); } catch {}
          shutdown();
        }, pongTimeoutMs);
      }
    }, pingIntervalMs);
    if (typeof ws.on === "function") {
      ws.on("pong", () => { clearTimeout(clientPongTimer); clientPongTimer = null; });
    }
  }
  // 浏览器断开兜底清理（wsHandler close 分支之外再挂一道，幂等）
  if (typeof ws.on === "function") ws.on("close", () => shutdown());

  // 首连前先挂缓冲桩：上游握手完成前浏览器发来的消息不丢
  ws.data.upstream = bufferStub();
  dial();

  return { state, shutdown };
}
