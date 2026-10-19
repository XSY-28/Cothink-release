import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repository, git } from "./helpers/git-fixture.js";
import * as adapter from "../src/versioning.js";
import { createGitVersioning as oldFactory } from "../archive/agent-sync-git-20261019/src/git-versioning.js";
async function oldProject(t, { open = false } = {}) {
  const repo = repository(t),
    old = await oldFactory(repo);
  const c = await old.beginChange({
    actor: "old",
    scope: ["a.txt"],
    intent: "legacy fixture",
  });
  writeFileSync(join(c.workspace, "a.txt"), "old accepted");
  let accepted;
  if (!open) {
    const p = await old.prepareChange(c.changeId);
    accepted = await old.acceptChange({
      requestId: "old-accept",
      changeId: c.changeId,
      candidateVersion: p.candidateVersion,
    });
    assert.equal(accepted.status, "accepted");
  }
  const directory = old.directory,
    ref = old.integrationRef;
  await old.close();
  return { ...repo, old, c, accepted, directory, ref };
}
test("A08 explicit migration preserves formal ref and dirty root; pinned old writer rejects; new acceptance extends same chain", async (t) => {
  assert.equal(typeof adapter.migrateLegacyProject, "function");
  const f = await oldProject(t);
  writeFileSync(join(f.project, "a.txt"), "user dirty");
  await assert.rejects(adapter.createVersioning(f), {
    code: "MIGRATION_REQUIRED",
  });
  const moved = await adapter.migrateLegacyProject(f);
  assert.equal(moved.status, "ready");
  assert.equal(moved.version, f.accepted.acceptedVersion);
  await assert.rejects(oldFactory(f), (e) =>
    ["INVALID_ID", "SESSION_LOCK_UNKNOWN"].includes(e.code),
  );
  const v = await adapter.createVersioning(f);
  try {
    assert.equal(v.integrationRef, f.ref);
    const c = await v.beginChange({
      requestId: "new-begin",
      actor: "main",
      intent: "new",
      scope: ["a.txt"],
    });
    const a = await v.read({ changeId: c.changeId, path: "a.txt" });
    await v.edit(c.changeId, {
      requestId: "edit",
      expectedVersion: c.privateVersion,
      edits: [{ path: "a.txt", oldHash: a.contentHash, contentBase64: "bmV3" }],
    });
    const p = await v.prepareChange(c.changeId, { requestId: "prepare" }),
      r = await v.acceptChange({
        requestId: "accept",
        changeId: c.changeId,
        candidateVersion: p.candidateVersion,
      });
    assert.equal(r.status, "accepted");
    assert.equal(
      git(f.project, "rev-parse", r.acceptedVersion + "^"),
      f.accepted.acceptedVersion,
    );
    assert.equal(readFileSync(join(f.project, "a.txt"), "utf8"), "user dirty");
    const ro = await adapter.createVersioning({ ...f, readOnly: true });
    try {
      assert.equal(
        (await ro.inspect({ requestId: "old-accept" })).status,
        "accepted",
      );
    } finally {
      await ro.close();
    }
  } finally {
    await v.close();
  }
  await assert.rejects(adapter.rollbackLegacyMigration(f), {
    code: "MIGRATION_FORWARD_ONLY",
  });
});
test("A08 open/prepared legacy work blocks migration without dropping draft or poisoning old writer", async (t) => {
  assert.equal(typeof adapter.migrateLegacyProject, "function");
  const f = await oldProject(t, { open: true }),
    path = join(f.directory, "project.json"),
    before = readFileSync(path, "utf8");
  await assert.rejects(adapter.migrateLegacyProject(f), {
    code: "MIGRATION_BLOCKED",
  });
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(
    readFileSync(join(f.c.workspace, "a.txt"), "utf8"),
    "old accepted",
  );
});
test("A08 rollback is explicit and restores exact old metadata only before new formal acceptance", async (t) => {
  assert.equal(typeof adapter.rollbackLegacyMigration, "function");
  const f = await oldProject(t),
    path = join(f.directory, "project.json"),
    before = readFileSync(path, "utf8");
  await adapter.migrateLegacyProject(f);
  await adapter.rollbackLegacyMigration(f);
  assert.equal(readFileSync(path, "utf8"), before);
  const old = await oldFactory(f);
  await old.close();
  await assert.rejects(adapter.createVersioning(f), {
    code: "MIGRATION_REQUIRED",
  });
});
test("A01/A08 proposed acceptedVersion in an old failure cannot masquerade as accepted history; missing ref never resets", async (t) => {
  const f = await oldProject(t);
  writeFileSync(
    join(f.directory, "acceptance", "fake.json"),
    JSON.stringify({
      requestId: "fake",
      status: "check_failed",
      candidateVersion: f.baseVersion,
      acceptedVersion: f.baseVersion,
    }),
  );
  const ro = await adapter.createVersioning({ ...f, readOnly: true });
  try {
    const r = await ro.inspect({ requestId: "fake" });
    assert.equal(r.status, "check_failed");
    assert.equal(r.acceptedVersion, undefined);
    assert.equal(r.proposedVersion, f.baseVersion);
  } finally {
    await ro.close();
  }
  git(f.project, "update-ref", "-d", f.ref);
  await assert.rejects(adapter.createVersioning({ ...f, readOnly: true }), {
    code: "INTEGRATION_MISSING",
  });
  assert.throws(() => git(f.project, "show-ref", "--verify", f.ref));
});
test("A08 interrupted handoff stays legacy-disabled until explicit resume; read-only never completes migration", async (t) => {
  const { mkdirSync, chmodSync } = await import("node:fs");
  const f = await oldProject(t),
    toolHome = join(f.root, "new-home");
  mkdirSync(toolHome, { mode: 0o500 });
  try {
    await assert.rejects(adapter.migrateLegacyProject({ ...f, toolHome }));
    const meta = JSON.parse(
      readFileSync(join(f.directory, "project.json"), "utf8"),
    );
    assert.equal(meta.ownerId, "agent-sync:v1");
    assert.equal(meta.migration.status, "legacy_disabled");
    await assert.rejects(adapter.createVersioning(f), {
      code: "MIGRATION_INCOMPLETE",
    });
  } finally {
    chmodSync(toolHome, 0o700);
  }
  await adapter.migrateLegacyProject(f);
  const v = await adapter.createVersioning(f);
  try {
    assert.equal(v.toolHome, toolHome);
    assert.equal((await v.inspect()).version, f.accepted.acceptedVersion);
  } finally {
    await v.close();
  }
});
test("A08 legacy active owner and corrupt metadata block handoff without silently rebuilding state", async (t) => {
  const repo = repository(t),
    old = await oldFactory(repo),
    path = join(old.directory, "project.json"),
    raw = readFileSync(path, "utf8");
  try {
    await assert.rejects(adapter.migrateLegacyProject(repo), {
      code: "SESSION_BUSY",
    });
    assert.equal(readFileSync(path, "utf8"), raw);
  } finally {
    await old.close();
  }
  writeFileSync(path, "{broken");
  await assert.rejects(adapter.createVersioning({ ...repo, readOnly: true }), {
    code: "LEGACY_CORRUPT",
  });
  assert.equal(readFileSync(path, "utf8"), "{broken");
});
