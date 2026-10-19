import test from "node:test";
import assert from "node:assert/strict";
import { repository } from "./helpers/git-fixture.js";
import { createVersioning } from "../src/versioning.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

test("A01 factory consumes real protocol1 kernel in independent toolHome; edits and awaited close", async (t) => {
  const repo = repository(t),
    v = await createVersioning(repo);
  try {
    const p = await v.inspect();
    assert.equal(p.backend, "agent-sync");
    assert.equal(p.protocolVersion, 1);
    assert.equal(v.toolHome, join(repo.home, "agent-sync"));
    const c = await v.beginChange({
      requestId: "begin",
      actor: "main",
      intent: "edit",
      scope: ["a.txt"],
    });
    const old = await v.read({ changeId: c.changeId, path: "a.txt" });
    await v.edit(c.changeId, {
      requestId: "edit",
      expectedVersion: c.privateVersion,
      edits: [
        { path: "a.txt", oldHash: old.contentHash, contentBase64: "bmV3" },
      ],
    });
    const fixed = await v.prepareChange(c.changeId, { requestId: "prepare" });
    const r = await v.acceptChange({
      requestId: "accept",
      changeId: c.changeId,
      candidateVersion: fixed.candidateVersion,
    });
    assert.equal(r.status, "accepted");
    assert.equal(r.verification, "unverified");
    assert.notEqual(r.acceptedVersion, repo.baseVersion);
    assert.equal(readFileSync(join(repo.project, "a.txt"), "utf8"), "base A\n");
  } finally {
    assert.ok(v.close() instanceof Promise);
    await v.close();
  }
});
test("A01/A07 new readOnly history uses saved toolHome and cannot perform mutations", async (t) => {
  const repo = repository(t),
    v = await createVersioning(repo);
  const p = await v.inspect();
  await v.close();
  const ro = await createVersioning({
    ...repo,
    toolHome: v.toolHome,
    backend: "agent-sync",
    readOnly: true,
  });
  try {
    assert.equal((await ro.inspect()).version, p.version);
    await assert.rejects(
      ro.beginChange({
        requestId: "bad",
        actor: "x",
        intent: "x",
        scope: ["a.txt"],
      }),
      { code: "READ_ONLY" },
    );
  } finally {
    await ro.close();
  }
});
