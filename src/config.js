import { readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { privateDirectory, writePrivateJson, acquireSessionWriter } from "./storage.js";
import { validateTeamConfig } from "./teams.js";

export function positiveInteger(value, name) {
  const number = Number(value);
  if (
    !Number.isSafeInteger(number) ||
    number < 1 ||
    number > Math.floor(Number.MAX_SAFE_INTEGER / 3)
  )
    throw new Error(`${name} 必须是正整数。`);
  return number;
}

export function validateConfig(config) {
  if (config?.formatVersion === 3) return validateTeamConfig(config);
  if (config?.formatVersion !== undefined && config.formatVersion !== 2)
    throw new Error("未知配置版本；原文件保留，请使用匹配版本。");
  if (config?.formatVersion === 2) {
    if (!config.main || !Array.isArray(config.secondary))
      throw new Error("新配置需要主模型和有序副模型列表。");
    const identities = new Set();
    for (const ref of [config.main, ...config.secondary]) {
      if (
        !ref ||
        typeof ref.provider !== "string" ||
        !ref.provider.trim() ||
        typeof ref.modelId !== "string" ||
        !ref.modelId.trim()
      )
        throw new Error("模型引用需要 provider 与 modelId。");
      if (
        Object.keys(ref).some(
          (key) =>
            ![
              "provider",
              "modelId",
              "thinkingLevel",
              "maxOutputTokens",
            ].includes(key),
        )
      )
        throw new Error("角色配置只保存模型引用；凭据与端点由 Pi 管理。");
      const identity = `${ref.provider}/${ref.modelId}`;
      if (identities.has(identity))
        throw new Error(
          `重复模型身份：${identity}；不能占据另一独立评审席位。`,
        );
      identities.add(identity);
      if (ref.maxOutputTokens !== undefined)
        positiveInteger(ref.maxOutputTokens, "maxOutputTokens");
    }
    if (config.work !== undefined) {
      const { checks, execution } = config.work;
      if (
        checks !== undefined &&
        (!Array.isArray(checks) ||
          checks.some(
            (c) =>
              !c ||
              typeof c.command !== "string" ||
              !c.command ||
              isAbsolute(c.command) ||
              c.env !== undefined ||
              (c.args !== undefined &&
                (!Array.isArray(c.args) ||
                  c.args.some((x) => typeof x !== "string"))),
          ))
      )
        throw new Error(
          "工作检查必须是容器内命令（如node/npm），不能使用宿主绝对路径或秘密env。",
        );
      if (
        execution !== undefined &&
        (execution.engine !== "docker" ||
          execution.network !== "none" ||
          !/^(?:[a-zA-Z0-9._/:-]+@)?sha256:[0-9a-f]{64}$/.test(
            execution.image,
          ) ||
          !execution.limits ||
          Object.keys(execution).some(
            (k) =>
              ![
                "engine",
                "image",
                "network",
                "limits",
                "artifactPaths",
              ].includes(k),
          ))
      )
        throw new Error(
          "execution需要固定Docker digest、network:none和明确资源限额；不接受自定义宿主env/挂载。",
        );
    }
    return config;
  }
  for (const role of ["main", "reviewer"]) {
    const p = config?.[role];
    if (!p || typeof p.model !== "string" || !p.model.trim())
      throw new Error(`${role} 必须配置模型名称。`);
    let url;
    try {
      url = new URL(p.baseUrl);
    } catch {
      throw new Error(`${role} 的 baseUrl 无效。`);
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        `${role} 的 baseUrl 必须是无凭据、无查询参数的 HTTP(S) 地址。`,
      );
    p.baseUrl = url.href.replace(/\/+$/, "");
    p.model = p.model.trim();
    p.tokenParameter ??= "max_completion_tokens";
    if (!["max_tokens", "max_completion_tokens"].includes(p.tokenParameter))
      throw new Error(
        `${role} 的 tokenParameter 应为 max_tokens 或 max_completion_tokens。`,
      );
    if (
      p.supportsThinkingLevels !== undefined &&
      typeof p.supportsThinkingLevels !== "boolean"
    )
      throw new Error(`${role}.supportsThinkingLevels 必须是布尔值。`);
    p.maxOutputTokens =
      p.maxOutputTokens == null
        ? null
        : positiveInteger(p.maxOutputTokens, `${role}.maxOutputTokens`);
    if (
      p.apiKey !== undefined &&
      (typeof p.apiKey !== "string" || !p.apiKey.trim())
    )
      throw new Error(`${role} 的 apiKey 不能为空。`);
    if (
      p.apiKeyEnv !== undefined &&
      (typeof p.apiKeyEnv !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.apiKeyEnv))
    )
      throw new Error(`${role} 的 apiKeyEnv 不是有效的环境变量名。`);
    if (p.apiKey && p.apiKeyEnv)
      throw new Error(`${role} 的 apiKey 和 apiKeyEnv 只能设置一种。`);
    if (
      p.temperature !== undefined &&
      (typeof p.temperature !== "number" ||
        !Number.isFinite(p.temperature) ||
        p.temperature < 0 ||
        p.temperature > 2)
    )
      throw new Error(`${role}.temperature 必须在 0 到 2 之间。`);
  }
  return config;
}

export function loadConfig(home) {
  try {
    return validateConfig(
      JSON.parse(readFileSync(join(home, "config.json"), "utf8")),
    );
  } catch (error) {
    if (error.code === "ENOENT") return null;
    // Don't print malformed configuration text: it may contain credentials.
    if (error instanceof SyntaxError)
      throw new Error(
        "config.json 不是有效 JSON，请执行 cothink init 重新配置。",
      );
    throw error;
  }
}

export function saveConfig(home, config) {
  return updateConfig(home, (current) => {
    if (current?.formatVersion === 3 && config.formatVersion !== 3)
      throw new Error("不能用旧配置覆盖 team 配置；回退须显式保存备份。");
    return config;
  });
}

/** Short, synchronous read/change/validate/write; never hold this across UI input. */
export function updateConfig(home, change) {
  let writer;
  try {
    writer = acquireSessionWriter(join(home, "config-write"), "184df297-b389-43af-8635-e71dfac90f52");
  } catch (error) {
    if (error.code === "SESSION_BUSY") throw new Error("配置正在被其他实例修改，请重试。");
    throw error;
  }
  try {
    const next = change(structuredClone(loadConfig(home)));
    if (next && typeof next.then === "function") throw new Error("配置变更必须同步完成。");
    validateConfig(next);
    privateDirectory(home);
    writePrivateJson(join(home, "config.json"), next, writer.assertOwned);
    return structuredClone(next);
  } finally { writer.release(); }
}

/** Change roles without losing a model or its saved generation settings. */
export function switchMainModel(config, selected) {
  const next = structuredClone(config);
  const same = (a, b) => a.provider === b.provider && a.modelId === b.modelId;
  const previous = next.main;
  const index = next.secondary.findIndex((ref) => same(ref, selected));
  next.main = {
    ...(same(previous, selected)
      ? previous
      : index >= 0
        ? next.secondary[index]
        : {}),
    ...structuredClone(selected),
  };
  if (!same(previous, selected)) {
    if (index >= 0) next.secondary[index] = previous;
    else next.secondary.unshift(previous);
  }
  validateConfig(next);
  return next;
}

export function credentials(config, env = process.env) {
  const keys = {};
  for (const role of ["main", "reviewer"]) {
    const p = config[role];
    const key = p.apiKeyEnv ? env[p.apiKeyEnv] : p.apiKey;
    if (typeof key !== "string" || !key.trim())
      throw new Error(
        `${role} 缺少凭据${p.apiKeyEnv ? `：请设置环境变量 ${p.apiKeyEnv}` : "：请运行 cothink init"}。`,
      );
    if (/[\r\n]/.test(key))
      throw new Error(`${role} 的凭据含有换行，请重新配置。`);
    keys[role] = key;
  }
  return keys;
}
