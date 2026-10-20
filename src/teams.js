import { validateConfig } from "./config.js";

const fail = (message) => { throw new Error(message); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function normalizeTeamName(name) {
  if (typeof name !== "string" || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(name))
    fail("team 名称不能包含换行或控制字符。");
  const value = name.trim().normalize("NFC");
  if (!value || [...value].length > 80) fail("team 名称需要 1—80 个字符。");
  return value;
}

export function validateTeam(team) {
  if (!team || typeof team.id !== "string" || !uuid.test(team.id)) fail("team ID 无效。");
  if (Object.keys(team).some((key) => !["id", "name", "main", "secondary"].includes(key)))
    fail("team 只保存名称、ID 和模型引用，不能包含凭据或其他字段。");
  if (normalizeTeamName(team.name) !== team.name) fail("team 名称未规范化。");
  if (!Array.isArray(team.secondary) || !team.secondary.length)
    fail("team 至少需要一个副模型。");
  validateConfig({ formatVersion: 2, main: team.main, secondary: team.secondary });
  return team;
}

export function validateTeamConfig(config) {
  if (config?.formatVersion !== 3 || !Array.isArray(config.teams) || !config.teams.length)
    fail("team 配置必须是 v3 且至少保留一个 team。");
  if (Object.hasOwn(config, "main") || Object.hasOwn(config, "secondary") || Object.hasOwn(config, "team"))
    fail("v3 配置不能重复保存顶层阵容字段。");
  const names = new Set(), ids = new Set();
  for (const team of config.teams) {
    validateTeam(team);
    if (names.has(team.name)) fail("team 名称重名，请另起名字。");
    if (ids.has(team.id)) fail("team ID 重复。");
    names.add(team.name); ids.add(team.id);
  }
  if (!ids.has(config.lastUsedTeamId)) fail("最近 team 不存在；请修复配置，原文件保留。");
  validateConfig({ ...config, formatVersion: 2, main: config.teams[0].main, secondary: config.teams[0].secondary });
  return config;
}

export function createTeamConfig(legacyConfig, name, id) {
  if (legacyConfig?.formatVersion !== 2) fail("只有 v2 配置可升级为首个 team。");
  validateConfig(legacyConfig);
  const { main, secondary, team: ignored, ...global } = structuredClone(legacyConfig);
  const result = { ...global, formatVersion: 3, lastUsedTeamId: id,
    teams: [{ id, name: normalizeTeamName(name), main, secondary }] };
  return validateTeamConfig(result);
}

export function addTeam(config, team) {
  validateTeamConfig(config);
  const next = structuredClone(config);
  next.teams.push({ ...structuredClone(team), name: normalizeTeamName(team.name) });
  return validateTeamConfig(next);
}

export function removeTeam(config, { targetId, currentTeam }) {
  validateTeamConfig(config);
  if (config.teams.length <= 1) fail("至少保留一个 team。");
  if (targetId === currentTeam?.id) fail("当前对话正在使用，请先切换 team。");
  if (!config.teams.some((t) => t.id === targetId)) fail("team 不存在或已删除，请刷新列表。");
  const next = structuredClone(config);
  next.teams = next.teams.filter((t) => t.id !== targetId);
  if (next.lastUsedTeamId === targetId)
    next.lastUsedTeamId = next.teams.find((t) => t.id === currentTeam?.id)?.id ?? next.teams[0].id;
  return validateTeamConfig(next);
}

export function selectTeam(config, teamId) {
  validateTeamConfig(config);
  if (!config.teams.some((t) => t.id === teamId)) fail("team 不存在或已删除，请刷新列表。");
  return { ...structuredClone(config), lastUsedTeamId: teamId };
}

export function snapshotTeam(team) {
  validateTeam(team);
  return structuredClone(team);
}

export function resolveTeamConfig(config, team = null) {
  validateTeamConfig(config);
  const selected = snapshotTeam(team ?? config.teams.find((t) => t.id === config.lastUsedTeamId));
  const { teams, lastUsedTeamId, ...global } = structuredClone(config);
  return { ...global, formatVersion: 2, main: structuredClone(selected.main),
    secondary: structuredClone(selected.secondary), team: selected };
}

export function readSessionTeam(entries) {
  const entry = entries.findLast((e) => e.type === "custom" && e.customType === "cothink-team");
  if (!entry) return null;
  try { return snapshotTeam(entry.data?.team); }
  catch (error) { throw new Error("会话 team 快照损坏：" + error.message); }
}
