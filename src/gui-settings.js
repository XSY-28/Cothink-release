import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createModelRuntime } from "./pi-runtime.js";
import { updateConfig, positiveInteger } from "./config.js";
import {
  addTeam,
  createTeamConfig,
  normalizeTeamName,
  removeTeam,
} from "./teams.js";
import { validateModelRefs, selectModelRef } from "./setup.js";
import { acquireSessionWriter, writePrivateJson } from "./storage.js";
import { validateModelThinking } from "./thinking.js";
export async function saveGuiTeam(home, { name, main, secondary }) {
  const team = {
    id: randomUUID(),
    name: normalizeTeamName(name),
    main,
    secondary,
  };
  const runtime = await createModelRuntime(home);
  await validateModelRefs({ formatVersion: 2, main, secondary }, runtime);
  updateConfig(home, (current) =>
    current?.formatVersion === 3
      ? addTeam(current, team)
      : current
        ? createTeamConfig({ ...current, main, secondary }, team.name, team.id)
        : createTeamConfig(
            { formatVersion: 2, main, secondary },
            team.name,
            team.id,
          ),
  );
  return team;
}
export function removeGuiTeam(home, teamId, currentTeam) {
  return updateConfig(home, (c) =>
    removeTeam(c, { targetId: teamId, currentTeam }),
  );
}
export function saveGuiWork(home, work) {
  if (
    !work ||
    typeof work !== "object" ||
    Array.isArray(work) ||
    Object.keys(work).some((k) => !["checks", "execution"].includes(k))
  )
    throw Error("工作设置只接受 checks 与 execution。");
  return updateConfig(home, (c) => {
    if (!c) throw Error("请先保存 Team。");
    return { ...c, work: structuredClone(work) };
  }).work;
}
export async function saveGuiProvider(home, { providerId, apiKey, custom }) {
  if (
    typeof providerId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(providerId)
  )
    throw Error("服务商 ID 无效。");
  if (typeof apiKey !== "string" || !apiKey.trim() || /[\r\n]/.test(apiKey))
    throw Error("API key 不能为空或包含换行。");
  if (custom) {
    if (!["openai-completions", "anthropic-messages"].includes(custom.api))
      throw Error("协议无效。");
    if (typeof custom.modelId !== "string" || !custom.modelId.trim())
      throw Error("模型 ID 不能为空。");
    if (custom.contextWindow !== undefined)
      positiveInteger(custom.contextWindow, "contextWindow");
    if (custom.maxTokens !== undefined)
      positiveInteger(custom.maxTokens, "maxTokens");
  }
  const lock = acquireSessionWriter(
    join(home, "provider-write"),
    "48b7614a-e0b7-4c05-925a-d33b7deed1d0",
  );
  try {
    const runtime = await createModelRuntime(home);
    if (custom) {
      // Use the same catalog conflict, endpoint and Pi authentication path as CLI setup.
      const values = {
        "自定义配置 ID": providerId,
        "API 根地址": custom.baseUrl,
        "模型 ID": custom.modelId,
      };
      await selectModelRef({
        runtime,
        home,
        role: "GUI",
        io: {
          select: async (label) => (label === "协议" ? custom.api : "custom"),
          prompt: async (p) =>
            p.type === "secret" ? apiKey : values[p.message],
          notify() {},
        },
      });
      const path = join(home, "pi/models.json"),
        models = JSON.parse(readFileSync(path, "utf8"));
      const model = models.providers[providerId].models[0];
      if (custom.name !== undefined) model.name = String(custom.name);
      if (custom.contextWindow !== undefined)
        model.contextWindow = Number(custom.contextWindow);
      if (custom.maxTokens !== undefined)
        model.maxTokens = Number(custom.maxTokens);
      writePrivateJson(path, models, lock.assertOwned);
    } else {
      const provider = runtime.getProvider(providerId);
      if (!provider) throw Error("服务商不可用。");
      if (!provider.auth?.apiKey?.login)
        throw Error(
          "此服务商需要 OAuth 或环境认证；请在 CLI 使用 cothink 后 /login。已有 OAuth 可直接复用。",
        );
      try {
        await runtime.login(providerId, "api_key", {
          prompt: async () => apiKey,
          notify() {},
        });
      } catch {
        throw Error("认证未完成；请检查服务商认证方式和本机存储权限。");
      }
    }
    return { providerId, saved: true, verified: false };
  } finally {
    lock.release();
  }
}
export async function validateGuiThinking(home, team, level) {
  const runtime = await createModelRuntime(home);
  await validateModelThinking(
    runtime.getModel(team.main.provider, team.main.modelId),
    level,
  );
  return level;
}
