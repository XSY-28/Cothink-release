import { join, resolve, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { privateDirectory } from "./storage.js";
import { loadConfig, updateConfig } from "./config.js";
import {
  readSessionTeam,
  snapshotTeam,
  resolveTeamConfig,
  selectTeam,
} from "./teams.js";
import { validateModelRefs } from "./setup.js";

// References, in selected branch order, are shared by CLI details and GUI history.
export function conversationTaskIds(manager) {
  return [...new Set(manager.getBranch().flatMap((entry) =>
    entry.message?.cothinkTaskId ? [entry.message.cothinkTaskId]
      : entry.details?.taskId ? [entry.details.taskId]
        : entry.type === "custom" && entry.customType === "cothink-task"
          ? [entry.data?.taskId] : [],
  ).filter(Boolean))];
}

export function readSessionMode(manager) {
  const entry = manager
    .getBranch()
    .findLast((e) => e.type === "custom" && e.customType === "cothink-mode");
  if (!entry) return false;
  if (typeof entry.data?.singleModel !== "boolean")
    throw Error("会话模式记录损坏；请保留原记录并修复。");
  return entry.data.singleModel;
}
export function readSessionProject(manager) {
  const entry = manager
    .getBranch()
    .findLast((e) => e.type === "custom" && e.customType === "cothink-project");
  if (!entry) return manager.getCwd(); // Legacy CLI sessions retain their original project boundary.
  const project = entry.data?.project;
  if (
    project !== null &&
    (typeof project !== "string" ||
      !isAbsolute(project) ||
      resolve(project) !== project)
  )
    throw Error("会话项目关联损坏；保留原记录。");
  return project;
}
export function neutralDirectory(home) {
  const path = join(
    tmpdir(),
    "cothink-chat",
    createHash("sha256").update(resolve(home)).digest("hex").slice(0, 24),
  );
  privateDirectory(path);
  // Match process.cwd() and Pi session discovery even when tmpdir is a symlink (macOS /var).
  return realpathSync(path);
}
export function conversationCwd(manager, home) {
  return readSessionProject(manager) ?? neutralDirectory(home);
}
export function appendConversationEntry(owner, type, data) {
  if (owner.selectionError) throw Error(owner.selectionError);
  const manager = owner.sessionManager,
    previous = manager.getLeafId();
  try {
    owner.assertOwned();
    return manager.appendCustomEntry(type, data);
  } catch (error) {
    if (previous) manager.branch(previous);
    else manager.resetLeaf();
    owner.selectionError =
      "会话选择保存失败，请重新打开对话；草稿保留：" + error.message;
    throw Error(owner.selectionError);
  }
}
export function saveSessionMode(owner, singleModel) {
  if (typeof singleModel !== "boolean") throw Error("模式无效");
  if (owner.selectionError) throw Error(owner.selectionError);
  if (readSessionMode(owner.sessionManager) !== singleModel) {
    try {
      appendConversationEntry(owner, "cothink-mode", { singleModel });
    } catch (error) {
      owner.selectionError = error.message.replace(
        "会话选择保存失败",
        "模式保存失败",
      );
      throw Error(owner.selectionError);
    }
  }
  owner.singleModel = singleModel;
  return singleModel;
}
export function saveSessionTeam(owner, team) {
  const selected = snapshotTeam(team);
  if (
    JSON.stringify(readSessionTeam(owner.sessionManager.getBranch())) !==
    JSON.stringify(selected)
  )
    appendConversationEntry(owner, "cothink-team", { team: selected });
}
export function resolveConversationConfig(
  config,
  manager,
  { fresh = false, inheritedTeam } = {},
) {
  const saved = readSessionTeam(manager.getBranch());
  if (config?.formatVersion !== 3)
    return { config: structuredClone(config), needsTeam: !saved };
  const effective = resolveTeamConfig(config, saved ?? inheritedTeam);
  if (!fresh && !saved) delete effective.team;
  return { config: effective, needsTeam: !fresh && !saved };
}
export function rememberRecentTeam(home, team) {
  const latest = loadConfig(home);
  if (
    latest?.formatVersion === 3 &&
    team &&
    latest.teams.some((t) => t.id === team.id) &&
    latest.lastUsedTeamId !== team.id
  )
    updateConfig(home, (c) => selectTeam(c, team.id));
}
export async function selectConversationTeam({
  home,
  owner,
  team,
  busy = false,
}) {
  if (busy) throw Error("当前任务尚未结束，请先取消或等待。");
  if (owner.selectionError) throw Error(owner.selectionError);
  const latest = loadConfig(home),
    selected = snapshotTeam(team);
  if (!latest?.teams?.some((t) => t.id === selected.id))
    throw Error("team 已被其他实例删除，请刷新列表。");
  const next = resolveTeamConfig(latest, selected),
    before = owner.effectiveConfig;
  await validateModelRefs(next, owner.modelRuntime);
  try {
    owner.assertOwned();
    await owner.selectModel(next.main);
    saveSessionTeam(owner, selected);
  } catch (error) {
    if (sessionWriteIncomplete(owner))
      owner.selectionError ??=
        "模型/会话记录保存失败，请重新打开对话；草稿保留。";
    if (!owner.selectionError && before?.main)
      try {
        await owner.selectModel(before.main);
      } catch {
        owner.selectionError = "模型恢复失败，请重新打开对话。";
      }
    throw error;
  }
  owner.effectiveConfig = next;
  owner.needsTeam = false;
  owner.recentTeamError = null;
  try {
    rememberRecentTeam(home, selected);
  } catch (error) {
    owner.recentTeamError =
      "当前对话已切换，新对话默认未更新：" + error.message;
  }
  return next;
}
export function readConversationMetadata(manager) {
  const entries = manager.getBranch();
  const last = (type) =>
    entries.findLast((e) => e.type === "custom" && e.customType === type)?.data;
  return {
    title: last("cothink-title")?.title ?? manager.getSessionName() ?? "",
    draft: last("cothink-draft")?.text ?? "",
    thinking: last("cothink-thinking")?.level,
  };
}

export function sessionWriteIncomplete(owner) {
  const path = owner.sessionManager.getSessionFile();
  if (!path || !existsSync(path)) return false;
  try {
    return !readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .some((e) => e.id === owner.sessionManager.getLeafId());
  } catch {
    return true;
  }
}
