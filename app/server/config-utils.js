// config-utils.js — provider env 命名与 YAML 标量序列化的共享工具
// 供 primary-config.js / fallback-config.js 等配置模块共用，无任何运行时状态。

// 自定义 provider 环境变量名：剥离 id 中 "custom-" 前缀后规范化大写
export function customEnvKey(id) {
  const bare = String(id).replace(/^custom-/i, '');
  return `CUSTOM_${bare.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}_API_KEY`;
}
// 兼容旧格式（CUSTOM_PROVIDER_*_API_KEY）用于读取迁移
export function legacyCustomEnvKey(id) {
  const bare = String(id).replace(/^custom-/i, '');
  return `CUSTOM_PROVIDER_${bare.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}_API_KEY`;
}

// YAML 标量安全序列化：含 YAML 特殊字符时加引号，否则保持 plain
export function yamlScalar(val) {
  const s = String(val == null ? "" : val);
  const risky = s === "" ||
    /^[\s>|@`"'%#&*!?\[\]{},-]/.test(s) ||   // 危险起始字符
    /\s$/.test(s) ||                          // 结尾空白
    /:(\s|$)/.test(s) ||                      // 冒号后接空格/行尾
    /\s#/.test(s);                            // 空格+井号（YAML 行内注释）
  return risky ? JSON.stringify(s) : s;
}
