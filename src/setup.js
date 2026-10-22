import { copyFileSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CredentialSynchronizationError } from "@earendil-works/pi-coding-agent";
import { saveConfig, loadConfig, updateConfig, validateConfig, credentials } from "./config.js";
import { createModelRuntime } from "./pi-runtime.js";
import { privateDirectory, writePrivateJson, writePrivateBytes } from "./storage.js";
import { createTeamConfig, addTeam, normalizeTeamName } from "./teams.js";
import { validateModelThinking } from "./thinking.js";
export const nativeCommands = new Set([
  "settings",
  "scoped-models",
  "thinking",
  "export",
  "import",
  "copy",
  "name",
  "session",
  "changelog",
  "hotkeys",
  "fork",
  "clone",
  "tree",
  "trust",
  "login",
  "logout",
  "new",
  "reload",
  "debug",
  "resume",
  "quit",
]);
export const nativeArgumentCommands = new Set(["thinking", "export", "import", "name", "login"]);
export const hostLocalCommands = new Set(["chat", "team", "models", "model", "help", "cothink"]);
export const singleLineCommand = (text) => {
  const command = text.trim();
  return !/[\r\n]/.test(command) ? /^\/([^\s]*)(?:\s+([\s\S]*))?$/.exec(command) : null;
};
/** Keep the legacy alias callable, without advertising a second model UI. */
export function modelsAutocomplete(current) {
  return {
    triggerCharacters: current.triggerCharacters,
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const prefix = (lines[cursorLine] ?? "").slice(0, cursorCol);
      if (options.force) return current.getSuggestions(lines, cursorLine, cursorCol, options);
      if (/^\s*\/(?:models?|team)[ \t]/.test(prefix)) return null;
      const result = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      if (!result || !/^\s*\/[^\s]*$/.test(prefix)) return result;
      const items = result.items.filter((item) => item.value !== "model" && item.value !== "/model");
      return items.length ? { ...result, items } : null;
    },
    applyCompletion(...args) {
      return current.applyCompletion(...args);
    },
    shouldTriggerFileCompletion(...args) {
      return current.shouldTriggerFileCompletion?.(...args) ?? false;
    },
  };
}
export function isGenerationCommand(name, runtime) {
  if (nativeCommands.has(name) || hostLocalCommands.has(name) || name === "compact") return false;
  if (runtime.session.extensionRunner.getRegisteredCommands().some((c) => c.name === name)) return false;
  return (
    (name.startsWith("skill:") && runtime.services.resourceLoader.getSkills().skills.some((s) => s.name === name.slice(6))) ||
    runtime.services.resourceLoader.getPrompts().prompts.some((p) => p.name === name)
  );
}
export function parseTurnInput(text) {
  const command = singleLineCommand(text);
  if (command) {
    if (nativeCommands.has(command[1]) || hostLocalCommands.has(command[1]) || command[1] === "compact")
      return { local: true, message: "本地命令请在 CoThink 交互界面使用；未发送模型请求。" };
    if (text.trim() === "/one")
      return { local: true, message: "请在交互界面使用 /one 切换单模型模式；一次性入口使用 /one <任务> 或 --one。未发送模型请求。" };
    if (/^\/one[ \t]+/.test(text.trimStart()))
      return { input: text.trimStart().replace(/^\/one[ \t]+/, ""), singleModel: true };
  }
  return { input: text, singleModel: false };
}
export async function validateModelRefs(config, runtime, { singleModel = false } = {}) {
  validateConfig(config);
  if (!singleModel && !config.secondary.length) throw Error("请配置副模型，或使用 /one <任务>。");
  for (const ref of [config.main, ...(singleModel ? [] : config.secondary.slice(0, 1))]) {
    const model = runtime.getModel(ref.provider, ref.modelId);
    if (!model) throw Error(`模型不可用：${ref.provider}/${ref.modelId}；不会自动跳过。`);
    await validateModelThinking(model, ref.thinkingLevel);
    if (!runtime.hasConfiguredAuth(ref.provider))
      throw Error(`服务商 ${ref.provider} 缺少凭据，请 /login。`);
    if (["anthropic-messages"].includes(model.api) && ref.maxOutputTokens == null)
      throw Error(`${model.api} 协议要求 maxOutputTokens，请明确配置后再发送。`);
  }
  return config;
}
async function authValue(io, prompt, signal) {
  signal?.throwIfAborted();
  prompt.signal?.throwIfAborted();
  const value = prompt.type === "select"
    ? await io.select(prompt.message, prompt.options)
    : await io.prompt(prompt);
  signal?.throwIfAborted();
  prompt.signal?.throwIfAborted();
  if (value == null) throw new DOMException("已取消认证", "AbortError");
  if (prompt.type === "secret" && !String(value).trim())
    throw Object.assign(Error("API key 不能为空；未保存认证。"), { code: "AUTH_EMPTY" });
  return prompt.type === "secret" ? String(value).trim() : value;
}

/** Credentials remain provider-owned; notices and model references never contain keys. */
export async function ensureProviderAuth({ runtime, provider, io, signal }) {
  signal?.throwIfAborted();
  const source = runtime.getProvider(provider);
  if (!source) throw Error("服务商不可用");
  const label = source.name && source.name !== provider ? `${source.name}（${provider}）` : provider;
  if (runtime.hasConfiguredAuth(provider)) {
    const status = runtime.getProviderAuthStatus(provider);
    const auth = runtime.isUsingOAuth(provider) ? "OAuth 登录" :
      status.source === "environment" ? `环境认证${status.label ? `：${status.label}` : ""}` :
      source.auth?.apiKey ? `${status.source === "stored" ? "已保存" : "已配置"}的 API key` : "已配置认证";
    io.notify?.(`将复用 ${label} 的${auth}。`);
    return;
  }
  const method = source.auth?.apiKey?.login ? "api_key" : source.auth?.oauth?.login ? "oauth" : null;
  if (!method) throw Error(`${label} 需要配置其环境认证；此服务商不提供交互式 API key 登录。`);
  io.notify?.(`${label} 尚未配置认证；${method === "api_key" ? "请在此输入 API key（隐藏输入）" : "请完成 OAuth 登录"}。`);
  try {
    await runtime.login(provider, method, {
      signal,
      prompt: prompt => authValue(io, { ...prompt, message: `${label} · ${prompt.message}` }, signal),
      notify: event => io.notify?.(event.type === "device_code"
        ? `${event.verificationUri}\n验证码：${event.userCode}`
        : [event.message, event.url, event.instructions].filter(Boolean).join("\n")),
    });
  } catch (error) {
    if (signal?.aborted || error.name === "AbortError") throw new DOMException("已取消认证", "AbortError");
    if (error.code === "AUTH_EMPTY") throw error;
    if (error instanceof CredentialSynchronizationError)
      throw Error(`${label} 的认证已保存，但本地模型状态同步失败；请重新打开对话后继续添加。`);
    // Provider/storage errors can contain credentials. Never echo them into the UI.
    throw Error(`${label} 的认证未完成；请检查服务商认证方式和本机存储权限。当前 Team 未更改。`);
  }
  io.notify?.(`已保存 ${label} 的${method === "api_key" ? " API key" : " OAuth 登录"}；后续选择该服务商会复用。`);
}

export async function selectModelRef({ runtime, home, io, role, signal }) {
  const providers = runtime
    .getProviders()
    .filter((p) => p.getModels().length)
    .map((p) => ({ id: p.id, label: p.name ?? p.id }));
  providers.push({ id: "custom", label: "自定义服务商" });
  const provider = await io.select(`${role}服务商`, providers);
  if (!provider) throw new DOMException("已取消设置", "AbortError");
  if (provider === "custom") {
    const providerId = await io.prompt({ type: "text", message: "自定义配置 ID" }),
      baseUrl = await io.prompt({ type: "text", message: "API 根地址" }),
      api = await io.select("协议", [
        { id: "openai-completions", label: "OpenAI Chat Completions" },
        { id: "anthropic-messages", label: "Anthropic Messages" },
      ]),
      modelId = await io.prompt({ type: "text", message: "模型 ID" });
    const url = new URL(baseUrl);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw Error("服务地址无效");
    const path = join(home, "pi", "models.json");
    let models = { providers: {} };
    if (existsSync(path)) models = JSON.parse(readFileSync(path, "utf8"));
    if (models.providers?.[providerId] || runtime.getProvider(providerId) || runtime.getProviderAuthStatus(providerId).configured)
      throw Error("该服务商或认证 ID 已存在，请使用现有服务商，或为新地址选择不同的配置 ID。");
    // Collect the secret before publishing the catalog so cancellation leaves no provider behind.
    const key = await authValue(io, { type: "secret", message: `${providerId} · API key（隐藏输入）`, signal }, signal);
    // Input can take minutes. Preserve catalog changes made by another window in the meantime.
    models = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { providers: {} };
    if (models.providers?.[providerId]) throw Error("该服务商配置 ID 已被其他窗口添加；未保存新认证，请重新选择。");
    models.providers ??= {};
    models.providers[providerId] = {
      baseUrl,
      api,
      models: [
        {
          id: modelId,
          name: modelId,
          reasoning: false,
          input: ["text"],
          contextWindow: 32000,
          maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    };
    writePrivateJson(path, models);
    await runtime.refresh({ allowNetwork: false });
    await ensureProviderAuth({ runtime, provider: providerId, signal, io: { ...io, prompt: async () => key } });
    return { provider: providerId, modelId };
  }
  const source = runtime.getProvider(provider);
  if (!source) throw Error("服务商不可用");
  await ensureProviderAuth({ runtime, provider, io, signal });
  const modelId = await io.select(
    `${role}模型`,
    runtime
      .getModels(provider)
      .filter((m) => !m.type || m.type === "chat")
      .map((m) => ({ id: m.id, label: m.name ?? m.id })),
  );
  if (!modelId) throw new DOMException("已取消设置", "AbortError");
  const ref = { provider, modelId };
  const model = runtime.getModel(provider, modelId);
  if (model.api === "anthropic-messages")
    ref.maxOutputTokens = Number(
      await io.prompt({
        type: "text",
        message: `${model.api} 要求输出额度，请明确输入 maxOutputTokens`,
      }),
    );
  return ref;
}

function configBytes(home) {
  try { return readFileSync(join(home, "config.json"), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function backupConfig(home, bytes) {
  if (bytes === null) return;
  privateDirectory(join(home, "backups"));
  writePrivateBytes(join(home, "backups", `config-${randomUUID()}.json`), bytes);
}
async function teamName(io) {
  const name = await io.prompt({ type: "text", message: "team 名称（1—80 字符）" });
  if (name == null) throw Error("已取消设置");
  return normalizeTeamName(name);
}
async function confirmTeam(io, team) {
  io.notify?.(`team「${team.name}」：主 ${team.main.provider}/${team.main.modelId}；有序副模型 ${team.secondary.map(r => `${r.provider}/${r.modelId}`).join("、")}。普通纯答三次，/one纯答一次，工作调用次数不设上限。`);
  if (io.select && (await io.select("确认保存 team", [{id:"save",label:"保存"},{id:"cancel",label:"取消"}])) !== "save")
    throw Error("已取消设置，原配置保留。");
}

export async function setupModels({ home, modelRuntime, io, signal }) {
  const runtime = modelRuntime ?? (await createModelRuntime(home));
  const before = configBytes(home);
  const original = loadConfig(home);
  const draft = { formatVersion: 2, main: await selectModelRef({runtime,home,io,role:"主",signal}), secondary: [] };
  draft.secondary.push(await selectModelRef({runtime,home,io,role:"副",signal}));
  validateConfig(draft);
  while ((await io.select("添加副模型？（第一位为问答评审）", [
    { id: "no", label: "完成" }, { id: "yes", label: "添加" },
  ])) === "yes") {
    draft.secondary.push(await selectModelRef({runtime,home,io,role:"副",signal}));
    validateConfig(draft);
  }
  const name = await teamName(io), id = randomUUID();
  await confirmTeam(io, {name,main:draft.main,secondary:draft.secondary});
  return updateConfig(home, (current) => {
    if (original?.formatVersion === 3 && current?.formatVersion === 3) {
      const next = addTeam(current, {id,name,main:draft.main,secondary:draft.secondary});
      next.lastUsedTeamId = id;
      return next;
    }
    if (configBytes(home) !== before) throw Error("配置已变化，请刷新后重试。");
    backupConfig(home, before);
    return createTeamConfig({...(current?.formatVersion === 2 ? current : {}), ...draft}, name, id);
  });
}

export async function migrateTeamConfig({ home, io, signal }) {
  const before = configBytes(home), original = loadConfig(home);
  if (original?.formatVersion === 3) return original;
  if (original?.formatVersion !== 2) throw Error("请先显式导入旧配置。");
  const draft = structuredClone(original);
  if (!draft.secondary.length) {
    io.notify?.("创建 team 需要至少一个副模型；取消保留旧配置，仍可 /one 使用。");
    const runtime = await createModelRuntime(home);
    draft.secondary.push(await selectModelRef({runtime,home,io,role:"副",signal}));
  }
  io.notify?.("为当前主模型与有序副模型命名；已有认证将继续复用。");
  const name = await teamName(io), id = randomUUID();
  await confirmTeam(io, {name,main:draft.main,secondary:draft.secondary});
  return updateConfig(home, () => {
    if (configBytes(home) !== before) throw Error("配置已变化，请刷新后重试。");
    backupConfig(home, before);
    return createTeamConfig(draft, name, id);
  });
}
/** Explicit legacy import. Keys only go into Pi auth, not role config or diagnostics. */
export async function importLegacyConfig({
  home,
  source = join(home, "config.json"),
  env = process.env,
}) {
  const legacy = validateConfig(JSON.parse(readFileSync(source, "utf8")));
  if ([2,3].includes(legacy.formatVersion)) throw Error("源已经是 Pi 配置");
  const keys = credentials(legacy, env);
  privateDirectory(join(home, "backups"));
  const backup = join(home, "backups", `legacy-${randomUUID()}.json`);
  copyFileSync(source, backup);
  chmodSync(backup, 0o600);
  privateDirectory(join(home, "pi"));
  const path = join(home, "pi", "models.json");
  const catalog = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { providers: {} };
  const config = { formatVersion: 2, main: null, secondary: [] };
  for (const role of ["main", "reviewer"]) {
    const old = legacy[role],
      provider = `import-${role}-${randomUUID().slice(0, 8)}`;
    catalog.providers[provider] = {
      api: "openai-completions",
      baseUrl: old.baseUrl,
      models: [
        {
          id: old.model,
          name: old.model,
          reasoning: old.supportsThinkingLevels === true,
          input: ["text"],
          contextWindow: 32000,
          maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat: {
            maxTokensField:
              old.tokenParameter === "max_tokens" ? "max_tokens" : "max_completion_tokens",
          },
        },
      ],
    };
    const ref = {
      provider,
      modelId: old.model,
      ...(old.maxOutputTokens == null ? {} : { maxOutputTokens: old.maxOutputTokens }),
    };
    if (role === "main") config.main = ref;
    else config.secondary.push(ref);
  }
  writePrivateJson(path, catalog);
  const runtime = await createModelRuntime(home);
  for (const [i, ref] of [config.main, ...config.secondary].entries())
    await runtime.login(ref.provider, "api_key", {
      prompt: async () => keys[i === 0 ? "main" : "reviewer"],
      notify() {},
    });
  saveConfig(home, config);
  return { config, backup };
}
