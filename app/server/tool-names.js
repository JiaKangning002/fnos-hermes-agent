// Hermes 工具徽章显示名/图标 — 唯一数据源（bridge IPC 链路与 SSE 降级链路共用）
//
// 工具名来源（均为磁盘上可查证的事实）：
// 1) 本项目 gateway hermes.tool.progress 实际上报名与上游 KNOWN 工具集名单：
//    execute_code / code_execution / terminal / file / web / browser / vision /
//    memory / todo / skills / clarify / delegation 等
// 2) 写门控（write-gate）相关工具：
//    patch / write_file / remove_file
// 3) bridge 运行/群聊链路工具：
//    delegate_task / workspace_diff
// 4) Agent 工具定义：
//    terminal_exec / browser_navigate 等 browser_* 十项 / skill_list / skill_view / skill_manage
// 5) MCP 动态工具统一带 mcp_ 前缀（agent-bridge bridge_runtime.py _mcp_tool_names_from_names），
//    数量不定，不逐一收录，由 toolDisplayName 前缀规则兜底
//
// 维护说明：Hermes 官方升级新增/改名工具时，只需在下方 TOOL_NAME_ZH / TOOL_EMOJI
// 各加一行（key 为工具英文名，译名保持简短动宾式，如"执行代码"）；未收录的工具名
// 会自动回退显示英文原名，不影响使用。

// 工具英文名 → 中文显示名
export const TOOL_NAME_ZH = {
  // 代码/终端
  execute_code: "执行代码",
  code_execution: "执行代码",
  terminal: "终端命令",
  terminal_exec: "终端命令",
  // 文件
  read_file: "读取文件",
  write_file: "写入文件",
  patch: "修改文件",
  remove_file: "删除文件",
  search_files: "搜索文件",
  file: "文件操作",
  workspace_diff: "工作区变更",
  // 网络/浏览器
  web: "网页搜索",
  web_search: "联网搜索",
  browser: "浏览器自动化",
  browser_navigate: "打开网页",
  browser_snapshot: "页面快照",
  browser_click: "点击页面",
  browser_type: "页面输入",
  browser_scroll: "滚动页面",
  browser_back: "页面后退",
  browser_press: "按键操作",
  browser_get_images: "提取页面图片",
  browser_vision: "识图分析",
  browser_console: "页面控制台",
  vision: "视觉分析",
  // 任务/会话
  delegate_task: "委派任务",
  delegation: "委派任务",
  session_search: "会话搜索",
  clarify: "追问澄清",
  // 记忆/技能/待办
  memory: "记忆管理",
  todo: "待办事项",
  skills: "技能调用",
  skill_list: "列出技能",
  skill_view: "查看技能",
  skill_manage: "管理技能",
};

// 工具英文名 → 徽章图标（未收录回退 🔧，mcp_ 前缀回退 🔌）
export const TOOL_EMOJI = {
  execute_code: "🧮",
  code_execution: "🧮",
  terminal: "💻",
  terminal_exec: "💻",
  read_file: "📄",
  write_file: "📝",
  patch: "🩹",
  remove_file: "🗑️",
  search_files: "🔎",
  file: "📁",
  workspace_diff: "📋",
  web: "🌐",
  web_search: "🌐",
  browser: "🧭",
  browser_navigate: "🧭",
  browser_snapshot: "📸",
  browser_click: "🖱️",
  browser_type: "⌨️",
  browser_scroll: "📜",
  browser_back: "↩️",
  browser_press: "⌨️",
  browser_get_images: "🖼️",
  browser_vision: "👁️",
  browser_console: "🖥️",
  vision: "👁️",
  delegate_task: "🤝",
  delegation: "🤝",
  session_search: "🗂️",
  clarify: "❓",
  memory: "🧠",
  todo: "✅",
  skills: "🎯",
  skill_list: "🎯",
  skill_view: "🎯",
  skill_manage: "🎯",
};

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// 取工具中文显示名；未命中兜底：mcp_ 前缀 → "MCP·原名"，其余显示英文原名，
// 空值显示"工具调用"，保证任何情况下不出现 undefined/空白徽章
export function toolDisplayName(tool) {
  const name = String(tool || "").trim();
  if (!name) return "工具调用";
  if (hasOwn(TOOL_NAME_ZH, name)) return TOOL_NAME_ZH[name];
  if (name.startsWith("mcp_")) return `MCP·${name.slice(4)}`;
  return name;
}

// 取工具徽章图标（未命中兜底 🔧 / MCP 🔌）
export function toolEmoji(tool) {
  const name = String(tool || "").trim();
  if (hasOwn(TOOL_EMOJI, name)) return TOOL_EMOJI[name];
  if (name.startsWith("mcp_")) return "🔌";
  return "🔧";
}
