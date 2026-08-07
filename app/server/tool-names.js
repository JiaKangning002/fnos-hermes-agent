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
// 5) MCP 动态工具：支持 mcp__server__tool 双下划线新格式，兼容 mcp_ 旧格式，
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
  skills_list: "列出技能",
  skill_list: "列出技能",
  skill_view: "查看技能",
  skill_manage: "管理技能",
  // 终端/进程
  process: "进程管理",
  read_terminal: "读取终端",
  close_terminal: "关闭终端",
  open_preview: "打开预览",
  focus_pane: "聚焦面板",
  // 网络
  web_extract: "提取网页",
  x_search: "搜索 X",
  // 视觉/媒体
  vision_analyze: "视觉分析",
  image_generate: "生成图像",
  video_analyze: "分析视频",
  video_generate: "生成视频",
  xai_video_edit: "编辑视频",
  xai_video_extend: "延长视频",
  text_to_speech: "文字转语音",
  // 调度/桌面/项目
  cronjob: "定时任务",
  computer_use: "电脑操作",
  project_create: "创建项目",
  project_list: "项目列表",
  project_switch: "切换项目",
  // 浏览器（CDP）
  browser_cdp: "浏览器调试协议",
  browser_dialog: "处理浏览器弹窗",
  // 智能家居（Home Assistant）
  ha_call_service: "调用家居服务",
  ha_get_state: "查询设备状态",
  ha_list_entities: "列出家居设备",
  ha_list_services: "列出家居服务",
  // 看板（Kanban）
  kanban_show: "查看看板任务",
  kanban_list: "看板任务列表",
  kanban_complete: "完成看板任务",
  kanban_block: "阻塞看板任务",
  kanban_heartbeat: "看板心跳",
  kanban_comment: "看板评论",
  kanban_create: "创建看板任务",
  kanban_link: "关联看板任务",
  kanban_unblock: "解除看板阻塞",
  kanban_attach: "看板附件上传",
  kanban_attach_url: "看板附件链接",
  kanban_attachments: "看板附件列表",
  // 飞书（Feishu）
  feishu_doc_read: "读取飞书文档",
  feishu_drive_add_comment: "飞书添加评论",
  feishu_drive_list_comments: "飞书评论列表",
  feishu_drive_list_comment_replies: "飞书评论回复列表",
  feishu_drive_reply_comment: "飞书回复评论",
  // Discord
  discord: "Discord 操作",
  discord_admin: "Discord 管理",
  // Spotify
  spotify_playback: "Spotify 播放",
  spotify_devices: "Spotify 设备",
  spotify_queue: "Spotify 队列",
  spotify_search: "Spotify 搜索",
  spotify_playlists: "Spotify 歌单",
  spotify_albums: "Spotify 专辑",
  spotify_library: "Spotify 音乐库",
  // 元宝（Yuanbao）
  yb_query_group_info: "查询群信息",
  yb_query_group_members: "查询群成员",
  yb_send_dm: "发送私信",
  yb_search_sticker: "搜索表情",
  yb_send_sticker: "发送表情",
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
  skills_list: "🎯",
  skill_list: "🎯",
  skill_view: "🎯",
  skill_manage: "🎯",
  // 终端/进程
  process: "⚙️",
  read_terminal: "💻",
  close_terminal: "💻",
  open_preview: "🖥️",
  focus_pane: "🖥️",
  // 网络
  web_extract: "📄",
  x_search: "🐦",
  // 视觉/媒体
  vision_analyze: "👁️",
  image_generate: "🎨",
  video_analyze: "🎬",
  video_generate: "🎬",
  xai_video_edit: "🎬",
  xai_video_extend: "🎬",
  text_to_speech: "🔊",
  // 调度/桌面/项目
  cronjob: "⏰",
  computer_use: "🖥️",
  project_create: "📂",
  project_list: "📂",
  project_switch: "📂",
  // 浏览器（CDP）
  browser_cdp: "🧭",
  browser_dialog: "🧭",
  // 智能家居（Home Assistant）
  ha_call_service: "🏠",
  ha_get_state: "🏠",
  ha_list_entities: "🏠",
  ha_list_services: "🏠",
  // 看板（Kanban）
  kanban_show: "📋",
  kanban_list: "📋",
  kanban_complete: "📋",
  kanban_block: "📋",
  kanban_heartbeat: "📋",
  kanban_comment: "📋",
  kanban_create: "📋",
  kanban_link: "📋",
  kanban_unblock: "📋",
  kanban_attach: "📋",
  kanban_attach_url: "📋",
  kanban_attachments: "📋",
  // 飞书（Feishu）
  feishu_doc_read: "📄",
  feishu_drive_add_comment: "💬",
  feishu_drive_list_comments: "💬",
  feishu_drive_list_comment_replies: "💬",
  feishu_drive_reply_comment: "💬",
  // Discord
  discord: "💬",
  discord_admin: "💬",
  // Spotify
  spotify_playback: "🎵",
  spotify_devices: "🎵",
  spotify_queue: "🎵",
  spotify_search: "🎵",
  spotify_playlists: "🎵",
  spotify_albums: "🎵",
  spotify_library: "🎵",
  // 元宝（Yuanbao）
  yb_query_group_info: "💬",
  yb_query_group_members: "💬",
  yb_send_dm: "💬",
  yb_search_sticker: "💬",
  yb_send_sticker: "💬",
};

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// 取工具中文显示名；未命中兜底：mcp__server__tool 新格式 → "MCP·<tool>"（取末段工具名），
// mcp_ 旧格式 → "MCP·原名"，其余显示英文原名，空值显示"工具调用"，
// 保证任何情况下不出现 undefined/空白徽章
export function toolDisplayName(tool) {
  const name = String(tool || "").trim();
  if (!name) return "工具调用";
  if (hasOwn(TOOL_NAME_ZH, name)) return TOOL_NAME_ZH[name];
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const tail = parts[parts.length - 1];
    return tail ? `MCP·${tail}` : `MCP·${name}`;
  }
  if (name.startsWith("mcp_")) return `MCP·${name.slice(4)}`;
  return name;
}

// 取工具徽章图标（未命中兜底 🔧 / MCP 🔌，mcp__ 与 mcp_ 两种前缀均回退 🔌）
export function toolEmoji(tool) {
  const name = String(tool || "").trim();
  if (hasOwn(TOOL_EMOJI, name)) return TOOL_EMOJI[name];
  if (name.startsWith("mcp__") || name.startsWith("mcp_")) return "🔌";
  return "🔧";
}
