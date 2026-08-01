/**
 * Node.js 运行时适配层 — fnOS Hermes Agent
 *
 * 提供 Web API 风格的 serve / file / spawn / spawnSync / WebSocketClient。
 */

import { Readable } from "stream";
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import { WebSocket as WsClient, WebSocketServer } from "./vendor/ws/wrapper.mjs";

// ──────────────────────────────────────────────────────────────────────────
// 全局日志工具
// ──────────────────────────────────────────────────────────────────────────

let globalLog = () => {};
const log = (...args) => { try { globalLog(...args); } catch {} };

export function setGlobalLogger(fn) {
  globalLog = fn || (() => {});
}

// ──────────────────────────────────────────────────────────────────────────
// spawn / spawnSync
// ──────────────────────────────────────────────────────────────────────────

function optsOrEnv(env) {
  if (env === undefined) return process.env;
  if (env === "inherit") return process.env;
  return { ...process.env, ...env };
}

/**
 * 兼容 Bun.spawn 调用约定的进程启动器。
 * 支持数组式 spawn(["cmd","arg"]) 和对象式 spawn({cmd:[],env,...})。
 */
function spawn(optsOrCmd) {
  let cmd, env, stdout, stderr, stdin;

  if (Array.isArray(optsOrCmd)) {
    const [executable, ...args] = optsOrCmd;
    const proc = nodeSpawn(executable, args);
    return {
      pid: proc.pid,
      stdin: proc.stdin,
      stdout: proc.stdout,
      stderr: proc.stderr,
      // error 事件（如可执行文件不存在）也要收尾 exited，否则未监听的 error 会直接崩进程
      exited: new Promise((resolve) => { proc.on("exit", (code) => resolve(code)); proc.on("error", () => resolve(-1)); }),
      kill: (sig) => proc.kill(sig),
      unref: () => proc.unref(),
    };
  }

  cmd = optsOrCmd.cmd;
  env = optsOrEnv(optsOrCmd.env);
  stdout = optsOrCmd.stdout;
  stderr = optsOrCmd.stderr;
  stdin = optsOrCmd.stdin || "pipe";

  const options = { encoding: null, env };

  // file() 返回 ReadStream（带 isFileRef+path），用作 stdout/stderr 时转为可写 fd
  if (stdout === "pipe") stdout = "pipe";
  else if (stdout && stdout.isFileRef && stdout.path) stdout = fs.openSync(stdout.path, "a");
  else if (typeof stdout === "string" && fs.existsSync(stdout)) stdout = fs.openSync(stdout, "a");

  if (stderr === "pipe") stderr = "pipe";
  else if (stderr && stderr.isFileRef && stderr.path) stderr = fs.openSync(stderr.path, "a");
  else if (typeof stderr === "string" && fs.existsSync(stderr)) stderr = fs.openSync(stderr, "a");

  const proc = nodeSpawn(cmd[0], cmd.slice(1), { ...options, stdio: [stdin, stdout, stderr] });

  return {
    pid: proc.pid,
    stdin: proc.stdin,
    stdout: proc.stdout ? Readable.toWeb(proc.stdout) : null,
    stderr: proc.stderr ? Readable.toWeb(proc.stderr) : null,
    // error 事件（如可执行文件不存在）也要收尾 exited，否则未监听的 error 会直接崩进程
    exited: new Promise((resolve) => { proc.on("exit", (code) => resolve(code)); proc.on("error", () => resolve(-1)); }),
    kill: (sig) => proc.kill(sig),
    unref: () => proc.unref(),
  };
}

/**
 * 兼容 Bun.spawnSync 调用约定的同步进程启动器。
 */
function spawnSync(cmd, opts = {}) {
  const out = opts.stdout === "pipe" ? "buffer" : opts.stdout;
  const err = opts.stderr === "pipe" ? "buffer" : opts.stderr;
  const res = nodeSpawnSync(cmd[0], cmd.slice(1), {
    encoding: "buffer",
    stdio: ["ignore", out, err],
    ...(opts.env ? { env: opts.env } : {}),
  });
  return {
    stdout: res.stdout,
    stderr: res.stderr,
    status: res.status,
    signal: res.signal,
    pid: res.pid,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// file — 返回带 isFileRef+path 标记的 ReadStream
// ──────────────────────────────────────────────────────────────────────────

function file(path) {
  const rs = fs.createReadStream(path);
  return Object.assign(rs, { isFileRef: true, path });
}

// ──────────────────────────────────────────────────────────────────────────
// serve — http.createServer + Unix socket + WebSocket upgrade + Web API 桥接
// ──────────────────────────────────────────────────────────────────────────

/**
 * @param {{fetch:(req,server)=>any, websocket:{open?,message?,close?,error?}, error:(err)=>any, unix:string, idleTimeout?:number}} config
 */
function serve(config) {
  const serverOptions = { keepAlive: true, keepAliveTimeout: (config.idleTimeout ?? 60) * 1000 };
  const httpServer = http.createServer(serverOptions);
  const wss = new WebSocketServer({ noServer: true });

  // 每次连接独立存储 customData（用 Request 对象引用做 key，
  // 彻底避免多个并发升级请求共用同一个 pathname 字符串 key 时互相抢占数据）
  const pendingData = new WeakMap();

  wss.on("connection", (ws, req) => {
    const parsed = new URL(req.url, "http://localhost");
    const pathname = (parsed.pathname || "").replace(/^\/app\/[^/]+/, "") || "/";
    const handler = config.websocket || {};

    // ws 库 handleUpgrade 完成后连接已处于 OPEN 状态，
    // open 事件不会再触发，须直接调用 handler.open
    if (handler.open) {
      handler.open(ws);
    } else if (pathname.startsWith("/proxy/dashboard/api/") && ws.data) {
      log(`[WS-PROXY] open → ${ws.data.targetUrl}`);
    }

    ws.on("message", (data, isBinary) => {
      // 二进制帧保持 Buffer，文本帧转为 string，避免下游误判帧类型
      const msg = isBinary ? data : data.toString();
      if (handler.message) handler.message(ws, msg);
    });

    ws.on("close", (code, reason) => {
      if (handler.close) handler.close(ws);
      else if (pathname.startsWith("/proxy/dashboard/api/") && ws.data) {
        log(`[WS-PROXY] close code=${code}`);
      }
    });

    ws.on("error", (err) => {
      if (handler.error) handler.error(ws, err);
      else (typeof log === "function" ? log : console.log)(`WS error: ${err?.message || err}`);
    });
  });

  httpServer.on("upgrade", async (req, socket, head) => {
    let request;
    try {
      // 先调 config.fetch() 填充 pendingData
      const reqUrl = `http://localhost${req.url}`;
      const headers = req.headers || {};
      request = new Request(reqUrl, { method: req.method, headers });
      await config.fetch(request, serveInstance);
    } catch (err) {
      console.error("[WS upgrade] fetch error:", err);
      socket.destroy(err);
      return;
    }

    const parsed = new URL(req.url, "http://localhost");
    // fnOS gateway 不剥 /app/{appname}/ 前缀，此处统一剥离
    const pathname = (parsed.pathname || "").replace(/^\/app\/[^/]+/, "") || "/";

    // 用 Request 对象引用取回 config.fetch() 里通过 server.upgrade() 存下的数据，
    // 一次性取用即焚，天然按连接隔离，不存在多连接抢占同一份数据的问题
    const data = pendingData.get(request);
    pendingData.delete(request);

    if (pathname === "/api/chat/ws") {
      if (!data) { socket.destroy(new Error("No upgrade data")); return; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.data = data;
        wss.emit("connection", ws, req);
      });
      return;
    }

    if (pathname.startsWith("/proxy/dashboard/api/ws") ||
        pathname.startsWith("/proxy/dashboard/api/events") ||
        pathname.startsWith("/proxy/dashboard/api/pty")) {
      if (!data) {
        // 此时没有代理目标，不能拿 targetUrl: null 去创建注定会崩溃的连接——
        // 走到这里通常意味着 config.fetch() 里判定 dashboard 未运行、
        // 鉴权失败等，直接以正常的 WS 关闭码拒绝升级即可
        log(`[WS-PROXY] No upgrade data for ${pathname}, rejecting upgrade`);
        socket.destroy(new Error("No upgrade data"));
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.data = data;
        wss.emit("connection", ws, req);
      });
      return;
    }

    socket.destroy(new Error("Not an upgrade"));
  });

  // ─── HTTP 请求桥接：IncomingMessage → Web Request → config.fetch() → Web Response → ServerResponse ───
  httpServer.on("request", async (req, res) => {
    try {
      const reqUrl = `http://localhost${req.url}`;
      const headers = req.headers || {};
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const request = new Request(reqUrl, {
        method: req.method,
        headers,
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: hasBody ? "half" : undefined,
      });

      const response = await config.fetch(request, serveInstance);

      if (response) {
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        if (response.body) {
          const nodeStream = Readable.fromWeb(response.body);
          nodeStream.pipe(res);
        } else {
          res.end();
        }
      } else {
        res.end();
      }
    } catch (err) {
      const errorHandler = config.error || console.error;
      errorHandler(err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal Server Error");
      } else {
        try { res.end(); } catch {}
      }
    }
  });

  const serveInstance = {
    fetch: config.fetch,
    upgrade: function (req, options) {
      pendingData.set(req, options?.data || null);
      return true;
    },
  };

  if (config.unix) {
    try { fs.unlinkSync(config.unix); } catch {}
    httpServer.listen(config.unix, () => {
      (typeof log === "function" ? log : console.log)(`HTTP server listening on unix:${config.unix}`);
    });
  }

  return serveInstance;
}

// ──────────────────────────────────────────────────────────────────────────
// WebSocketClient — ws 库的 WebSocket 客户端
// ──────────────────────────────────────────────────────────────────────────

const WebSocketClient = WsClient;

// ──────────────────────────────────────────────────────────────────────────
// 导出
// ──────────────────────────────────────────────────────────────────────────

export { serve, file, spawn, spawnSync, WebSocketClient };
