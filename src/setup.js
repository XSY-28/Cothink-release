import { copyFileSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { saveConfig, validateConfig, credentials } from "./config.js";
import { createModelRuntime } from "./pi-runtime.js";
import { privateDirectory, writePrivateJson } from "./storage.js";
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
export const hostLocalCommands = new Set(["chat", "models", "model", "help"]);
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
      if (/^\s*\/models?[ \t]/.test(prefix)) return null;
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
      return { local: true, message: "用法：/one <任务>；仅本条使用主模型。" };
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
export async function setupModels({ home, modelRuntime, io, signal }) {
  const runtime = modelRuntime ?? (await createModelRuntime(home));
  const config = { formatVersion: 2, main: null, secondary: [] };
  const selectModel = async (role) => {
    const providers = runtime
      .getProviders()
      .filter((p) => p.getModels().length)
      .map((p) => ({ id: p.id, label: p.name ?? p.id }));
    providers.push({ id: "custom", label: "自定义服务商" });
    const provider = await io.select(`${role}服务商`, providers);
    if (!provider) throw Error("已取消设置");
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
      if (models.providers?.[providerId]) throw Error("该服务商配置 ID 已存在，请使用现有服务商");
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
      await runtime.login(providerId, "api_key", {
        signal,
        prompt: (p) => io.prompt(p),
        notify: (e) => io.notify?.(e.message ?? e.url ?? ""),
      });
      return { provider: providerId, modelId };
    }
    const source = runtime.getProvider(provider);
    if (!source) throw Error("服务商不可用");
    if (!runtime.hasConfiguredAuth(provider)) {
      const methods = ["api_key", "oauth"]
        .filter((type) => source.auth?.[type === "api_key" ? "apiKey" : "oauth"]?.login)
        .map((id) => ({ id, label: id === "api_key" ? "API Key（隐藏输入）" : "OAuth 登录" }));
      if (!methods.length) throw Error("该服务商需要先配置其环境认证");
      const auth = methods.length === 1 ? methods[0].id : await io.select("认证方式", methods);
      await runtime.login(provider, auth, {
        signal,
        prompt: (p) => io.prompt(p),
        notify: (e) => io.notify?.(e.message ?? e.url ?? ""),
      });
    }
    const modelId = await io.select(
      `${role}模型`,
      runtime
        .getModels(provider)
        .filter((m) => !m.type || m.type === "chat")
        .map((m) => ({ id: m.id, label: m.name ?? m.id })),
    );
    if (!modelId) throw Error("已取消设置");
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
  };
  config.main = await selectModel("主");
  while (
    (await io.select("添加副模型？（按追加顺序确定第一位问答评审）", [
      { id: "no", label: "完成" },
      { id: "yes", label: "添加" },
    ])) === "yes"
  ) {
    config.secondary.push(await selectModel("副"));
    validateConfig(config);
  }
  validateConfig(config);
  const oldPath = join(home, "config.json");
  if (existsSync(oldPath)) {
    privateDirectory(join(home, "backups"));
    const path = join(home, "backups", `config-${randomUUID()}.json`);
    copyFileSync(oldPath, path);
    chmodSync(path, 0o600);
  }
  saveConfig(home, config);
  return config;
}
/** Explicit legacy import. Keys only go into Pi auth, not role config or diagnostics. */
export async function importLegacyConfig({
  home,
  source = join(home, "config.json"),
  env = process.env,
}) {
  const legacy = validateConfig(JSON.parse(readFileSync(source, "utf8")));
  if (legacy.formatVersion === 2) throw Error("源已经是 Pi 配置");
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
