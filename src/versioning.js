import { join, resolve } from "node:path";
import { createAgentSync } from "../packages/agent-sync/src/index.js";
import { legacyProjectInfo, createGitVersioning } from "./git-versioning.js";
import { problem } from "./task.js";
/** One production writer; only legacy records retain a separate read-only interpretation. */
export async function createVersioning({
  home,
  toolHome,
  backend,
  readOnly = false,
  ...options
}) {
  const legacy = await legacyProjectInfo({ project: options.project, home });
  if (readOnly && backend !== "agent-sync" && !toolHome && legacy)
    return createGitVersioning({ ...options, home, readOnly: true });
  if (!readOnly && legacy && legacy.meta.ownerId !== "agent-sync:v1")
    throw problem(
      "MIGRATION_REQUIRED",
      "此项目仍由旧Git格式管理；请先明确迁移，旧记录与原目录保持不变。",
    );
  if (
    !readOnly &&
    legacy?.meta.ownerId === "agent-sync:v1" &&
    legacy.meta.migration?.status !== "ready"
  )
    throw problem(
      "MIGRATION_INCOMPLETE",
      "旧写入口已停用但迁移尚未完成；请显式重新运行migrate-work核对登记，普通工作/查询不自动完成迁移。",
    );
  const directory = resolve(
    toolHome ?? legacy?.meta.toolHome ?? join(home, "agent-sync"),
  );
  const v = await createAgentSync({
    ...options,
    home: directory,
    readOnly,
    ...(legacy?.meta.ownerId === "agent-sync:v1"
      ? { integrationRef: legacy.meta.integrationRef }
      : {}),
  });
  return Object.assign(v, { toolHome: directory });
}
export const inScope = (path, scope) =>
  scope.some((p) => p === "." || p === path || path.startsWith(p + "/"));

/** Explicit CoThink legacy handoff. No model, checks, merge or user checkout mutation. */
export async function migrateLegacyProject({
  project,
  home,
  toolHome,
  ...options
}) {
  const { readFileSync, writeFileSync, readdirSync, existsSync } = await import(
    "node:fs"
  );
  const { randomUUID } = await import("node:crypto");
  const { writePrivateJson, acquireSessionWriter } = await import(
    "./storage.js"
  );
  const { legacyGit } = await import("./git-versioning.js");
  const info = await legacyProjectInfo({ project, home });
  if (!info) throw problem("NO_PROJECT", "没有可迁移的旧项目。");
  let current = JSON.parse(readFileSync(info.path, "utf8")),
    snapshot,
    lock,
    v;
  if (current.ownerId === "agent-sync:v1") {
    if (!current.migration?.snapshot)
      throw problem("LEGACY_CORRUPT", "迁移缺少原始快照；保持旧写入口停用。");
    snapshot = JSON.parse(readFileSync(current.migration.snapshot, "utf8"));
  } else {
    lock = acquireSessionWriter(info.directory, current.ownerId);
    try {
      const ro = await createGitVersioning({ project, home, readOnly: true });
      const receipts = [];
      for (const name of readdirSync(join(info.directory, "acceptance")).filter(
        (n) => n.endsWith(".json"),
      ))
        receipts.push(await ro.inspect({ requestId: name.slice(0, -5) }));
      const changes = [];
      for (const name of readdirSync(join(info.directory, "changes")).filter(
        (n) => n.endsWith(".json"),
      )) {
        const c = JSON.parse(
          readFileSync(join(info.directory, "changes", name), "utf8"),
        );
        changes.push(c);
      }
      const unresolved = changes.filter(
        (c) =>
          !["accepted", "abandoned"].includes(c.status) &&
          !receipts.some(
            (r) =>
              r.status === "accepted" &&
              r.changeId === c.changeId &&
              r.candidateVersion === c.candidateVersion,
          ),
      );
      if (
        unresolved.length ||
        receipts.some((r) =>
          ["unknown", "preparing", "prepared", "pending"].includes(r.status),
        )
      )
        throw problem(
          "MIGRATION_BLOCKED",
          "先核对旧open/prepared/unknown成果，不能自动放弃：" +
            JSON.stringify(
              unresolved.map((c) => ({
                changeId: c.changeId,
                status: c.status,
              })),
            ),
        );
      const originalText = readFileSync(info.path, "utf8"),
        version = (await ro.inspect()).version;
      snapshot = {
        projectId: info.projectId,
        originalText,
        originalMeta: current,
        changes,
        receipts,
        expectedTip: version,
        originalChanges: await legacyGit(info.root, [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ]),
        createdAt: new Date().toISOString(),
      };
      const path = join(info.directory, "migration-" + randomUUID() + ".json");
      writePrivateJson(path, snapshot);
      lock.assertOwned();
      if (readFileSync(info.path, "utf8") !== originalText)
        throw problem("LEGACY_CORRUPT", "迁移前元数据变化，停止。");
      current = {
        ...current,
        ownerId: "agent-sync:v1",
        backend: "agent-sync",
        toolHome: resolve(toolHome ?? join(home, "agent-sync")),
        migration: {
          status: "legacy_disabled",
          snapshot: path,
          expectedTip: version,
          originalOwnerId: current.ownerId,
        },
      };
      writePrivateJson(info.path, current);
      await ro.close();
    } finally {
      lock.release();
      lock = null;
    }
  }
  try {
    v = await createAgentSync({
      project,
      home: current.toolHome,
      checks: options.checks ?? [],
      execution: options.execution,
      integrationRef: current.integrationRef,
    });
    const fact = await v.inspect();
    if (fact.integrationRef !== current.integrationRef)
      throw problem(
        "MIGRATION_AUTHORITY",
        "正式引用不一致，保持停用旧写入口。",
      );
    if (
      current.migration.status !== "ready" &&
      fact.version !== snapshot.expectedTip
    )
      throw problem(
        "MIGRATION_AUTHORITY",
        "未完成迁移期间正式版本变化，必须人工核对。",
      );
    current.migration.status = "ready";
    current.migration.newProjectId = fact.projectId;
    writePrivateJson(info.path, current);
    return {
      status: "ready",
      version: fact.version,
      integrationRef: fact.integrationRef,
      toolHome: current.toolHome,
      snapshot: current.migration.snapshot,
      legacyProjectId: info.projectId,
      projectId: fact.projectId,
    };
  } finally {
    await v?.close();
  }
}
export async function rollbackLegacyMigration({ project, home }) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { acquireSessionWriter, writePrivateBytes } = await import(
    "./storage.js"
  );
  const info = await legacyProjectInfo({ project, home });
  if (info?.meta.ownerId !== "agent-sync:v1" || !info.meta.migration?.snapshot)
    throw problem("MIGRATION_STATE", "没有待回退的迁移。");
  const snapshot = JSON.parse(
    readFileSync(info.meta.migration.snapshot, "utf8"),
  );
  const lock = acquireSessionWriter(
    info.directory,
    snapshot.originalMeta.ownerId,
  );
  let v;
  try {
    v = await createAgentSync({
      project,
      home: info.meta.toolHome,
      integrationRef: info.meta.integrationRef,
    });
    const current = await v.inspect();
    if (current.version !== snapshot.expectedTip)
      throw problem(
        "MIGRATION_FORWARD_ONLY",
        "已有新正式历史；不能reset或直接恢复旧写程序。",
      );
    lock.assertOwned();
    writePrivateBytes(info.path, snapshot.originalText, lock.assertOwned);
    return {
      status: "rolled_back",
      version: current.version,
      snapshot: info.meta.migration.snapshot,
    };
  } finally {
    await v?.close();
    lock.release();
  }
}
