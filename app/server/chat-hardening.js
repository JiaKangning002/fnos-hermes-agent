// chat-hardening.js — 聊天加固模块（增量 checkpoint / finalize / resume）
// 移植自 veenyi-fnos-hermes-agent 项目
// ESM，与项目 monitor.js 一致。无外部依赖。
//
// 设计意图：流式回复期间周期性持久化半成品（带 _streaming 标记），
// 正常完成或出错时转正，避免断电/崩溃丢内容。
// 与多会话 liveRuns 运行表互不干扰（各管各的关切）。

const CHECKPOINT_INTERVAL_MS = 1000;   // 定时器检查周期
const CHECKPOINT_MIN_CHARS = 1000;     // 距上次 checkpoint 的字符增量阈值
const CHECKPOINT_MIN_TIME_MS = 5000;   // 距上次 checkpoint 的时间间隔阈值（ms）
const DEDUP_WINDOW_MS = 60000;         // WS→XHR 回退去重窗口（与 monitor.js 现有逻辑一致）

/**
 * 创建流式 checkpoint 工厂。
 *
 * @param {string} sessionId — 会话 ID（仅用于日志）
 * @param {object} session  — 调用方已加载的 in-memory session 对象引用；
 *   checkpoint 和 finalize 直接操作其 messages 数组然后调 saveSession。
 * @param {{ saveSession: (s: any) => void, log?: (msg: string) => void }} deps
 * @returns {{ onDelta: (text: string) => void, getReply: () => string,
 *             finalize: (content?: string) => void, dispose: () => void }}
 */
export function createCheckpointer(sessionId, session, { saveSession, log }) {
  let fullReply = "";
  let lastCkptLen = 0;
  let lastCkptTs = Date.now();
  let timer = null;
  let disposed = false;

  function doCheckpoint() {
    if (disposed || fullReply.length === 0) return;
    const charDelta = fullReply.length - lastCkptLen;
    const timeDelta = Date.now() - lastCkptTs;
    if (charDelta < CHECKPOINT_MIN_CHARS && timeDelta < CHECKPOINT_MIN_TIME_MS) return;
    try {
      const last = session.messages[session.messages.length - 1];
      if (last && last.role === "assistant" && last._streaming) {
        // 已有 checkpoint 消息 → 原地更新
        last.content = fullReply;
        last.ts = Date.now();
      } else if (last && last.role === "assistant" && (Date.now() - last.ts) < DEDUP_WINDOW_MS) {
        // WS→XHR 回退去重：最近一条 assistant 在窗口内 → 替换为 streaming
        last.content = fullReply;
        last.ts = Date.now();
        last._streaming = true;
      } else {
        // 首次 checkpoint → 追加新的 _streaming 消息
        session.messages.push({ role: "assistant", content: fullReply, ts: Date.now(), _streaming: true });
      }
      saveSession(session);
      lastCkptLen = fullReply.length;
      lastCkptTs = Date.now();
    } catch (e) {
      if (log) log(`[checkpoint] ${sessionId}: ${e?.message || e}`);
    }
  }

  timer = setInterval(doCheckpoint, CHECKPOINT_INTERVAL_MS);

  return {
    /** 追加增量文本（每次 onDelta 回调时调用） */
    onDelta(text) {
      if (text) fullReply += text;
    },

    /** 当前 checkpointer 内部累积全文（调试/备用） */
    getReply() { return fullReply; },

    /**
     * 流结束时转正 _streaming 消息（移除标记）。
     * 若尚无 _streaming 消息则追加正式消息。
     *
     * @param {string} [content] — 最终内容；缺省时用 checkpointer 累积文本
     */
    finalize(content) {
      if (disposed) return;
      disposed = true;
      if (timer) { clearInterval(timer); timer = null; }
      const finalContent = (content != null && content !== "") ? String(content) : fullReply;
      if (!finalContent) {
        // 没有任何内容：若之前有 _streaming 消息也转正（保留 checkpoint 内容）
        const last = session.messages[session.messages.length - 1];
        if (last && last.role === "assistant" && last._streaming) {
          delete last._streaming;
          last.ts = Date.now();
          try { saveSession(session); } catch {}
        }
        return;
      }
      try {
        const last = session.messages[session.messages.length - 1];
        if (last && last.role === "assistant" && last._streaming) {
          last.content = finalContent;
          last.ts = Date.now();
          delete last._streaming;
        } else if (last && last.role === "assistant" && (Date.now() - last.ts) < DEDUP_WINDOW_MS) {
          // WS→XHR 回退去重：最近 assistant 在窗口内 → 原地替换
          last.content = finalContent;
          last.ts = Date.now();
          if (last._streaming) delete last._streaming;
        } else {
          session.messages.push({ role: "assistant", content: finalContent, ts: Date.now() });
        }
        saveSession(session);
      } catch (e) {
        if (log) log(`[finalize] ${sessionId}: ${e?.message || e}`);
      }
    },

    /** 仅释放定时器，不做持久化（异常出口用；先前 checkpoint 保留给 resume 处理） */
    dispose() {
      disposed = true;
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}

/**
 * 会话 resume：把残留的 _streaming 消息转正（去掉标记，保留内容）。
 * 适用于加载/切换会话时调用——覆盖上次崩溃/断电留下的半成品状态。
 *
 * @param {object} session — 完整 session 对象
 * @param {(s: any) => void} saveSession
 * @returns {boolean} 是否执行了 resume
 */
export function resumeStreamingMessages(session, saveSession) {
  if (!session || !Array.isArray(session.messages) || session.messages.length === 0) return false;
  const last = session.messages[session.messages.length - 1];
  if (last && last.role === "assistant" && last._streaming) {
    delete last._streaming;
    last.ts = Date.now();
    saveSession(session);
    return true;
  }
  return false;
}
