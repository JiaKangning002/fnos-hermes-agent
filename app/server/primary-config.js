// primary-config.js — 主模型（active provider）配置读写模块
// 职责：providers-state.yaml 解析 / 序列化写入、config.yaml 的 model 段 + providers 段
// 构建与写入、.env.providers 保存与旧格式迁移、active provider key 同步到 Hermes .env、
// 已删除服务商的 key 清理，以及真实 API key 解析（resolveRealApiKey）。
// 路径 / 日志 / 本机令牌等共用设施由 monitor.js 经 initPrimaryConfig 注入，本模块不重复定义。
import { readFileSync, writeFileSync, existsSync } from "fs";
import { PROVIDER_PRESETS, PROVIDER_API_KEYS, PROVIDER_CLASSES, PROVIDER_HERMES_IDS } from "./provider-config.js";
import { detectApiFormat, apiModeForFormat, normalizeApiFormat } from "./api-format.js";
import { buildFallbackBlock, applyFallbackToYaml } from "./fallback-config.js";
import { customEnvKey, legacyCustomEnvKey, yamlScalar } from "./config-utils.js";

// ─── 注入的运行时依赖 ─────────────────────────────────────────────────────
let P = {
  varDir: "",           // VAR_DIR（providers-state.yaml / .env.providers 所在目录）
  dataDir: "",          // DATA_DIR（config.yaml / Hermes .env 所在目录）
  log: () => {},        // monitor.js 的日志函数
  monitorToken: "",     // 本机监控令牌（LOCAL / hermes provider 直接用它鉴权）
};

export function initPrimaryConfig(deps) {
  P = { ...P, ...deps };
}

// ─── 真实 API key 解析 ────────────────────────────────────────────────────
// 优先级：LOCAL/hermes → 明文 api_key → 进程环境变量 → .env.providers（含旧名兜底）
// → Hermes .env（含旧名兜底）；任何读取异常一律返回 null（非致命）。
export function resolveRealApiKey(provider) {
  if (provider.base_url === "LOCAL" || provider.id === "hermes") {
    return P.monitorToken;
  }
  if (provider.api_key && !provider.api_key.startsWith("****")) {
    return provider.api_key;
  }
  const envKey = PROVIDER_API_KEYS[provider.id] || PROVIDER_API_KEYS[provider.name] || customEnvKey(provider.id);
  try {
    const fromEnv = process.env[envKey];
    if (fromEnv) return fromEnv;
    const envProvPath = `${P.varDir}/.env.providers`;
    if (existsSync(envProvPath)) {
      const provEnv = readFileSync(envProvPath, "utf8");
      const m = provEnv.match(new RegExp(`^${envKey}=(.*)$`, "m"));
      if (m && m[1]) return m[1].trim();
      // 兼容旧名 CUSTOM_PROVIDER_*
      if (!PROVIDER_API_KEYS[provider.id] && !PROVIDER_API_KEYS[provider.name]) {
        const legKey = legacyCustomEnvKey(provider.id);
        const m2 = provEnv.match(new RegExp(`^${legKey}=(.*)$`, "m"));
        if (m2 && m2[1]) return m2[1].trim();
      }
    }
    // 兜底：DATA_DIR/.env
    const hermesEnvPath = `${P.dataDir}/.env`;
    if (existsSync(hermesEnvPath)) {
      const hEnv = readFileSync(hermesEnvPath, "utf8");
      const mh = hEnv.match(new RegExp(`^${envKey}=(.*)$`, "m"));
      if (mh && mh[1]) return mh[1].trim();
      if (!PROVIDER_API_KEYS[provider.id] && !PROVIDER_API_KEYS[provider.name]) {
        const legKey = legacyCustomEnvKey(provider.id);
        const m2 = hEnv.match(new RegExp(`^${legKey}=(.*)$`, "m"));
        if (m2 && m2[1]) return m2[1].trim();
      }
    }
    return null;
  } catch { return null; }
}

// ─── providers-state.yaml 解析（GET/POST 共用） ─────────────────────────
// 解析格式: providers:\n  id:\n    model: xxx\n    base_url: yyy\n    name: "zzz"
export function parseProvidersState(stateYaml) {
  const map = {};
  const blockMatch = String(stateYaml || "").match(/^providers:\n([\s\S]*)$/m);
  if (!blockMatch) return map;
  const lines = blockMatch[1].split("\n");
  let curId = null, curModel = "", curBase = "", curName = "", curTemp = null, curMax = null, curFmt = "";
  const flush = () => {
    if (curId && curModel) {
      map[curId] = { model: curModel, base_url: curBase || "", name: curName || "", temperature: curTemp, max_tokens: curMax, api_format: curFmt };
    }
  };
  lines.forEach(line => {
    const keyMatch = line.match(/^  ([a-zA-Z0-9_-]+):\s*$/);
    if (keyMatch) {
      // 保存上一个
      flush();
      curId = keyMatch[1]; curModel = ""; curBase = ""; curName = ""; curTemp = null; curMax = null; curFmt = "";
      return;
    }
    const m = line.match(/^    model:\s*(.+)\s*$/);
    if (m && curId) { curModel = m[1].trim(); return; }
    const b = line.match(/^    base_url:\s*(.+)\s*$/);
    if (b && curId) { curBase = b[1].trim(); return; }
    const n = line.match(/^    name:\s*(.+)\s*$/);
    if (n && curId) { try { curName = JSON.parse(n[1].trim()); } catch { curName = n[1].trim(); } }
    const t = line.match(/^    temperature:\s*(.+)\s*$/);
    if (t && curId) { const tv = parseFloat(t[1].trim()); if (!isNaN(tv)) curTemp = tv; }
    const x = line.match(/^    max_tokens:\s*(.+)\s*$/);
    if (x && curId) { const xv = parseInt(x[1].trim(), 10); if (!isNaN(xv)) curMax = xv; }
    const f = line.match(/^    api_format:\s*(.+)\s*$/);
    if (f && curId) { curFmt = normalizeApiFormat(f[1]); }
  });
  flush();
  return map;
}

// 读取并解析 providers-state.yaml；文件不存在返回空映射，读取异常向上抛出由调用方决定处置
export function loadProvidersState() {
  const statePath = `${P.varDir}/providers-state.yaml`;
  if (!existsSync(statePath)) return {};
  return parseProvidersState(readFileSync(statePath, "utf8"));
}

// ─── providers-state.yaml 序列化写入（写失败为非致命，静默忽略） ──────────
export function writeProvidersState(allProvConfig, activeProviderId) {
  try {
    const stateLines = Object.entries(allProvConfig)
      .sort(([a], [b]) => {
        // active provider 排第一，其余按 id 字母排序
        if (a === activeProviderId) return -1;
        if (b === activeProviderId) return 1;
        return a.localeCompare(b);
      })
      .map(([id, cfg]) => {
        let entry = `  ${id}:\n    model: ${cfg.model}`;
        if (cfg.base_url) entry += `\n    base_url: ${cfg.base_url}`;
        if (cfg.name) entry += `\n    name: ${JSON.stringify(cfg.name)}`;
        if (cfg.temperature != null) entry += `\n    temperature: ${cfg.temperature}`;
        if (cfg.max_tokens != null) entry += `\n    max_tokens: ${cfg.max_tokens}`;
        if (cfg.api_format) entry += `\n    api_format: ${cfg.api_format}`;
        return entry;
      })
      .join("\n");
    const stateContent = `providers:\n${stateLines}\n`;
    writeFileSync(`${P.varDir}/providers-state.yaml`, stateContent);
  } catch (e) {}
}

// ─── config.yaml 的 model 段 + providers 段 + fallback 段构建与写入 ────────
// 返回 { ok: true } 或 { ok: false, error }（写失败属致命，由调用方返回 500）。
export function writeConfigYaml({ allProvConfig, providerId, fallbackIds }) {
  const resolvedModel = allProvConfig[providerId]?.model || "auto";
  const yamlPath = `${P.dataDir}/config.yaml`;

  // ── 构建 providers: 段（A/B 分类，详见 provider-config.js 的 PROVIDER_CLASSES） ──
  //   A 类内置服务商仅写 model 段，端点与原生协议交给 Hermes 内置 PROVIDER_REGISTRY；
  //   B 类内置服务商（siliconflow / mistral / ollama-cloud）与所有非预设 custom-* 必须写 providers 段。
  const customEntries = Object.entries(allProvConfig)
    .sort(([a], [b]) => {
      if (a === providerId) return -1;
      if (b === providerId) return 1;
      return a.localeCompare(b);
    })
    .filter(([id]) => !PROVIDER_PRESETS[id] || PROVIDER_CLASSES[id] === "B")
    .map(([id, pcfg]) => {
      const baseUrl = String(pcfg.base_url || "").trim();
      if (!baseUrl) {
        P.log(`跳过 provider "${id}"：缺少 base_url，未写入 config.yaml providers 段`);
        return null;
      }
      // 本地模型（local-* 动态 id）：本地 OpenAI 兼容服务无需鉴权，
      // 仅写 base_url + default_model，完全省略 api_key（Hermes config.py 支持缺省，
      // runtime_provider.py 会自动兜底 "no-key-required" 占位）。
      if (String(id).indexOf("local-") === 0) {
        return `  ${id}:\n` +
               `    base_url: ${yamlScalar(baseUrl)}\n` +
               `    default_model: ${yamlScalar(pcfg.model || "auto")}`;
      }
      // env 名：B 类预设用 PROVIDER_API_KEYS[id]，custom-* 用 customEnvKey(id)
      const envVar = PROVIDER_API_KEYS[id] || customEnvKey(id);
      // API 格式：显式选择优先，未选时按 URL 启发式自动识别；
      // Anthropic 形态追加 api_mode: anthropic_messages（网关运行时支持的字段），
      // OpenAI 兼容形态维持现状不写 api_mode，保证存量配置行为不变。
      const effFormat = pcfg.api_format || detectApiFormat(baseUrl, "").format;
      const modeVal = apiModeForFormat(effFormat);
      // 实机验证格式：base_url + api_key（${ENV} 插值）+ default_model
      return `  ${id}:\n` +
             `    base_url: ${yamlScalar(baseUrl)}\n` +
             `    api_key: \${${envVar}}\n` +
             `    default_model: ${yamlScalar(pcfg.model || "auto")}` +
             (modeVal ? `\n    api_mode: ${modeVal}` : "");
    })
    .filter(Boolean);
  const providersBlock = customEntries.length > 0 ? `providers:\n${customEntries.join("\n")}\n` : "";

  try {
    let ymlContent = existsSync(yamlPath) ? readFileSync(yamlPath, "utf8") : "";
    // model.provider 经 PROVIDER_HERMES_IDS 映射（openai → openai-api，其余用自身 id）
    const hermesProvider = PROVIDER_HERMES_IDS[providerId] || providerId;
    const newModel = `model:\n  provider: ${hermesProvider}\n  default: ${resolvedModel}\n`;
    const modelRegex = /^model:[\t ]*\n(?:[\t ]+[^\n]*\n)*/m;
    if (ymlContent.match(modelRegex)) {
      ymlContent = ymlContent.replace(modelRegex, newModel);
    } else {
      ymlContent = newModel + "\n" + ymlContent;
    }

    // 同步 providers: 段——兼容模板里的 `providers: {}` 空映射与已存在的多行块两种形态，
    // 避免产生重复的 providers 顶层键。无 B/custom 条目时整段省略 providers 节，
    // A 类 active 且无自定义服务商时 config.yaml 只保留 model 段（贴合实机验证格式）。
    const _NL = String.fromCharCode(10);
    const _TAB = String.fromCharCode(9);
    const _yl = ymlContent.split(_NL);
    let _ps = -1;
    for (let _i = 0; _i < _yl.length; _i++) {
      if (_yl[_i].indexOf("providers:") === 0) { _ps = _i; break; }
    }
    if (_ps >= 0) {
      let _pe = _ps + 1;
      while (_pe < _yl.length && (_yl[_pe].startsWith(" ") || _yl[_pe].startsWith(_TAB))) _pe++;
      const _before = _yl.slice(0, _ps).join(_NL);
      const _after = _yl.slice(_pe).join(_NL);
      if (providersBlock) {
        ymlContent = (_before ? _before + _NL : "") + providersBlock + _after;
      } else {
        // 无 B/custom 条目：纯删除原 providers 段，仅拼接 _before + _after
        ymlContent = _before + (_after ? _NL + _after : _NL);
      }
    } else if (providersBlock) {
      // 将 providers 段插入 model 段正下方（而非追加到文件末尾）
      const _modelBlockRe = /(^model:[\t ]*\n(?:[\t ]+[^\n]*\n)*)/m;
      const _modelMatch = ymlContent.match(_modelBlockRe);
      if (_modelMatch) {
        const _insertPos = _modelMatch.index + _modelMatch[0].length;
        ymlContent = ymlContent.slice(0, _insertPos) + providersBlock + ymlContent.slice(_insertPos);
      } else {
        // model 段也不存在时，退化为插到文件开头
        ymlContent = providersBlock + ymlContent;
      }
    }

    // 同步顶层 fallback_providers 段（外接模块处理：兼容 [] 单行与多行块两种形态，
    // 内含写入自检，异常时保持原内容不变，防止写坏 config.yaml）
    if (fallbackIds) {
      ymlContent = applyFallbackToYaml(ymlContent, buildFallbackBlock(fallbackIds, allProvConfig));
    }

    writeFileSync(yamlPath, ymlContent);
  } catch (e) {
    return { ok: false, error: "write config.yaml: " + e.message };
  }
  return { ok: true };
}

// ─── 保存 API key 到控制面板专属 .env.providers（含旧格式一次性迁移） ─────
export function saveProviderKeysToEnv(providers) {
  const envUpdates = [];
  (providers || []).forEach(p => {
    if (!p.id) return;
    // 本地模型（local-*）无需 API Key，跳过任何环境变量写入
    if (String(p.id).indexOf("local-") === 0) return;
    let envKey = PROVIDER_API_KEYS[p.id];
    if (!envKey) {
      envKey = customEnvKey(p.id);
    }
    let rawKey = null;
    if (p._raw_api_key && !String(p._raw_api_key).startsWith('****')) {
      rawKey = p._raw_api_key;
    } else if (p.api_key && !String(p.api_key).startsWith('****') && p.api_key !== 'none') {
      rawKey = p.api_key;
    }
    if (rawKey && rawKey.length > 0) {
      envUpdates.push({ key: envKey, value: rawKey });
    }
  });
  if (envUpdates.length > 0) {
    try {
      const envProvPath = `${P.varDir}/.env.providers`;
      let envContent = existsSync(envProvPath) ? readFileSync(envProvPath, "utf8") : "";
      envUpdates.forEach(({ key, value }) => {
        const envRegex = new RegExp(`^${key}=.*$`, "m");
        if (envRegex.test(envContent)) {
          envContent = envContent.replace(envRegex, `${key}=${value}`);
        } else {
          envContent += `${key}=${value}\n`;
        }
      });
      writeFileSync(envProvPath, envContent);
    } catch (e) {}
  }

  // ── 一次性迁移 .env.providers 旧格式 CUSTOM_PROVIDER_* → CUSTOM_* ──
  try {
    const _migPath = `${P.varDir}/.env.providers`;
    if (existsSync(_migPath)) {
      let _migContent = readFileSync(_migPath, "utf8");
      const _migRe = /^CUSTOM_PROVIDER_([A-Z0-9_]+_API_KEY)=(.+)$/gm;
      let _migM;
      let _migDirty = false;
      while ((_migM = _migRe.exec(_migContent)) !== null) {
        const _nk = `CUSTOM_${_migM[1]}`;
        if (!new RegExp(`^${_nk}=`, "m").test(_migContent)) {
          _migContent += `${_nk}=${_migM[2]}\n`;
        }
        _migDirty = true;
      }
      if (_migDirty) {
        _migContent = _migContent.split("\n").filter(l => !/^CUSTOM_PROVIDER_[A-Z0-9_]+_API_KEY=/.test(l)).join("\n");
        writeFileSync(_migPath, _migContent);
      }
    }
  } catch {}
}

// ─── 设为默认时，同步 active provider 的 key 到 Hermes .env（非致命） ─────
export function syncActiveKeyToHermesEnv(providerId) {
  try {
    const hermesEnvPath = `${P.dataDir}/.env`;
    let hermesEnv = existsSync(hermesEnvPath) ? readFileSync(hermesEnvPath, "utf8") : "";
    // 从已有的 .env.providers 中找到 active provider 的 key
    Object.keys(PROVIDER_API_KEYS).forEach(id => {
      if (id !== providerId) return;
      const envKey = PROVIDER_API_KEYS[id];
      // 从 .env.providers 读取真实 key
      const envProvPath = `${P.varDir}/.env.providers`;
      if (existsSync(envProvPath)) {
        const provEnv = readFileSync(envProvPath, "utf8");
        const m = provEnv.match(new RegExp(`^${envKey}=(.*)$`, "m"));
        if (m && m[1].length > 0) {
          const hermesRegex = new RegExp(`^${envKey}=.*$`, "m");
          if (hermesRegex.test(hermesEnv)) {
            hermesEnv = hermesEnv.replace(hermesRegex, `${envKey}=${m[1]}`);
          } else {
            hermesEnv += `\n${envKey}=${m[1]}\n`;
          }
        }
      }
    });
    // 同时检查自定义 provider
    const _cKey = customEnvKey(providerId);
    if (!PROVIDER_API_KEYS[providerId]) {
      const envProvPath2 = `${P.varDir}/.env.providers`;
      if (existsSync(envProvPath2)) {
        const provEnv2 = readFileSync(envProvPath2, "utf8");
        let m2 = provEnv2.match(new RegExp(`^${_cKey}=(.*)$`, "m"));
        // 兼容旧名
        if (!m2) m2 = provEnv2.match(new RegExp(`^${legacyCustomEnvKey(providerId)}=(.*)$`, "m"));
        if (m2 && m2[1].length > 0) {
          const hermesRegex2 = new RegExp(`^${_cKey}=.*$`, "m");
          if (hermesRegex2.test(hermesEnv)) {
            hermesEnv = hermesEnv.replace(hermesRegex2, `${_cKey}=${m2[1]}`);
          } else {
            hermesEnv += `\n${_cKey}=${m2[1]}\n`;
          }
        }
      }
    }
    // 清理 Hermes .env 中旧格式 CUSTOM_PROVIDER_* 行
    hermesEnv = hermesEnv.split("\n").filter(l => !/^CUSTOM_PROVIDER_[A-Z0-9_]+_API_KEY=/.test(l)).join("\n");
    writeFileSync(hermesEnvPath, hermesEnv);
  } catch (e) {}
}

// ─── bridge 对话主模型解析 ─────────────────────────────────────
// 将面板 active provider 解析为 bridge chat 请求的 {model, provider} 字段：
// provider 经 PROVIDER_HERMES_IDS 映射，与 writeConfigYaml 写 config.yaml model 段
// 同源（即与网关/微信链路一致）；base_url/api_key 由 hermes 侧 runtime_provider
// 自行从 config.yaml providers 段 + .env 解析，无需随请求传递。
// LOCAL/hermes（本地引擎默认）或解析失败返回 null，调用方不传字段，
// bridge 回落 config.yaml 默认模型（现状行为）。
export function resolveBridgePrimary(provider) {
  try {
    if (!provider || typeof provider !== "object") return null;
    if (provider.base_url === "LOCAL" || provider.id === "hermes") return null;
    const model = String(provider.model || "").trim();
    const id = String(provider.id || "").trim();
    if (!model || !id) return null;
    return { model, provider: PROVIDER_HERMES_IDS[id] || id };
  } catch { return null; }
}

// ─── 删除已移除 provider 的 .env.providers key（非致命） ──────────────────
export function cleanupRemovedProviderKeys(providers) {
  try {
    const envProvPath = `${P.varDir}/.env.providers`;
    if (existsSync(envProvPath)) {
      const envContent = readFileSync(envProvPath, "utf8");
      const keepKeys = new Set();
      (providers || []).forEach(p => {
        if (!p.id) return;
        const k = PROVIDER_API_KEYS[p.id] || customEnvKey(p.id);
        keepKeys.add(k);
      });
      const lines = envContent.split("\n");
      const filtered = lines.filter(line => {
        const m = line.match(/^([A-Z_][A-Z0-9_]*API_KEY|.+_API_KEY)=/);
        if (!m) return true;
        return keepKeys.has(m[1]);
      });
      if (filtered.join("\n") !== envContent) {
        writeFileSync(envProvPath, filtered.join("\n"));
      }
    }
  } catch (e) {}
}
