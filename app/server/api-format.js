// api-format.js — 模型端点 API 格式（OpenAI 兼容 / Anthropic Messages）识别模块
// 识别规则与 Hermes 网关运行时的 URL 自动判定保持一致（api.anthropic.com 主机、
// /anthropic 路径后缀等），另补充 API key 前缀（sk-ant-）与 /v1/messages 路径启发式。
// 网关侧 api_mode 合法值：chat_completions / codex_responses / anthropic_messages /
// bedrock_converse；本模块只在 OpenAI 兼容（chat_completions，缺省不写）与
// anthropic_messages 两种之间做判定。

// 从 base_url 提取主机名（小写）；解析失败返回空串
function hostnameOf(baseUrl) {
  try {
    return new URL(String(baseUrl || "").trim()).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// 从 base_url 提取路径（小写、去尾斜杠）；解析失败返回空串
function pathOf(baseUrl) {
  try {
    return new URL(String(baseUrl || "").trim()).pathname.toLowerCase().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

// ── 启发式识别 ──────────────────────────────────────────────────────────
// 返回 { format: "openai"|"anthropic", source: 命中的规则标识 }。
// 规则优先级：URL 主机 > URL 路径 > key 前缀 > 默认 OpenAI 兼容。
export function detectApiFormat(baseUrl, apiKey) {
  const host = hostnameOf(baseUrl);
  const path = pathOf(baseUrl);
  // 官方 Anthropic / Claude 主机（精确匹配主机名，防子域名仿冒）
  if (host === "api.anthropic.com" || host.endsWith(".anthropic.com") || host.endsWith(".claude.com")) {
    return { format: "anthropic", source: "url-host" };
  }
  // 第三方 Anthropic 兼容网关惯例：/anthropic 或 /anthropic/v1 路径后缀
  if (path.endsWith("/anthropic") || path.endsWith("/anthropic/v1")) {
    return { format: "anthropic", source: "url-path" };
  }
  // 用户直接把 /v1/messages 端点填进 base_url 的情况
  if (path.endsWith("/v1/messages") || path.endsWith("/messages")) {
    return { format: "anthropic", source: "url-path" };
  }
  // Anthropic 官方 key 前缀
  const key = String(apiKey || "").trim();
  if (key.startsWith("sk-ant-")) {
    return { format: "anthropic", source: "key-prefix" };
  }
  // 其余（含 /v1 惯例路径）默认 OpenAI 兼容
  return { format: "openai", source: "default" };
}

// ── 在线探测（可选增强，由面板"检测"按钮触发）────────────────────────────
// 先 GET {base}/models 判 OpenAI 兼容，失败再 POST {base}/messages 判 Anthropic；
// 每步 5s 超时。由后端代理发起，规避前端跨域限制。
export async function probeApiFormat(baseUrl, apiKey, timeoutMs = 5000) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) {
    return { ok: false, error: "base_url 必须以 http(s):// 开头" };
  }
  const key = String(apiKey || "").trim();
  // 第一步：OpenAI 兼容端点惯例暴露 GET /models（base 通常已含 /v1）
  try {
    const headers = key ? { "Authorization": `Bearer ${key}` } : {};
    const r = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      if (j && (Array.isArray(j.data) || Array.isArray(j.models))) {
        return { ok: true, format: "openai", method: "GET /models" };
      }
    }
  } catch { /* 超时/网络错误：继续下一种探测 */ }
  // 第二步：Anthropic Messages 端点——无论成功还是鉴权失败，
  // 响应体都携带 type 字段（"message" 或 "error"），以此识别协议
  try {
    const headers = { "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
    if (key) headers["x-api-key"] = key;
    const r2 = await fetch(`${base}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j2 = await r2.json().catch(() => null);
    if (j2 && (j2.type === "message" || (j2.type === "error" && j2.error))) {
      return { ok: true, format: "anthropic", method: "POST /messages" };
    }
  } catch { /* 超时/网络错误：落入未识别分支 */ }
  return { ok: false, error: "两种协议探测均未命中，请检查地址或手动选择格式" };
}

// ── config.yaml providers 条目的格式化辅助 ─────────────────────────────
// 显式声明为 anthropic 时返回网关认识的 api_mode 值；OpenAI 兼容维持缺省（返回空串，不写字段）
export function apiModeForFormat(format) {
  return format === "anthropic" ? "anthropic_messages" : "";
}

// 规范化面板传入的 api_format 值：仅接受 openai / anthropic，其余视为未指定（自动识别）
export function normalizeApiFormat(value) {
  const v = String(value || "").trim().toLowerCase();
  return (v === "openai" || v === "anthropic") ? v : "";
}
