import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { backend, begin, replace } from "./helpers/repository.js";
test("C05 all-or-nothing batch, idempotence, binary/mode/create/delete and private authority", async (t) => {
  const { v, project } = await backend(t),
    c = await begin(v, "batch", ["a.txt", "b.txt", "bin"]);
  const a = await v.read({ changeId: c.changeId, path: "a.txt" });
  await assert.rejects(
    v.edit(c.changeId, {
      requestId: "bad-batch",
      expectedVersion: c.privateVersion,
      edits: [
        {
          path: "a.txt",
          oldHash: a.contentHash,
          contentBase64: Buffer.from("changed").toString("base64"),
        },
        { path: "b.txt", oldHash: null, contentBase64: "Yg==" },
      ],
    }),
    { code: "PRECONDITION" },
  );
  assert.equal(
    (await v.inspect({ changeId: c.changeId })).privateVersion,
    c.privateVersion,
  );
  const input = {
    requestId: "binary",
    expectedVersion: c.privateVersion,
    edits: [
      {
        path: "bin",
        oldHash: null,
        contentBase64: Buffer.from([0, 1, 255]).toString("base64"),
        mode: "100755",
      },
    ],
  };
  const r = await v.edit(c.changeId, input);
  assert.deepEqual(await v.edit(c.changeId, input), r);
  await assert.rejects(v.edit(c.changeId, { ...input, edits: [] }), {
    code: "REQUEST_MISMATCH",
  });
  const binary = await v.read({ changeId: c.changeId, path: "bin" });
  assert.deepEqual(
    Buffer.from(binary.contentBase64, "base64"),
    Buffer.from([0, 1, 255]),
  );
  assert.equal(binary.mode, "100755");
  await replace(v, c, "b.txt", null, "delete");
  assert.equal(
    (await v.read({ changeId: c.changeId, path: "b.txt" })).contentHash,
    null,
  );
  await assert.rejects(
    v.edit(c.changeId, {
      requestId: "late",
      expectedVersion: c.privateVersion,
      edits: [],
    }),
    { code: "STALE_PRIVATE" },
  );
  assert.equal(
    (await import("node:fs")).readFileSync(join(project, "a.txt"), "utf8"),
    "base A\n",
  );
});
test("C06 immutable candidates, new read invalidation, repair keeps other work and unmanaged projection rejected", async (t) => {
  const { v } = await backend(t),
    c = await begin(v, "revise", ["a.txt", "b.txt"]);
  await replace(v, c, "a.txt", "fixed", "fix-1");
  const p = await v.prepareChange(c.changeId, { requestId: "p1" });
  await replace(v, c, "b.txt", "other", "fix-2");
  const q = await v.prepareChange(c.changeId, { requestId: "p2" });
  assert.notEqual(q.candidateVersion, p.candidateVersion);
  assert.equal(q.changeId, c.changeId);
  assert.equal(
    Buffer.from(
      (await v.read({ version: p.candidateVersion, path: "b.txt" }))
        .contentBase64,
      "base64",
    ).toString(),
    "base B\n",
  );
  writeFileSync(join(c.workspace, "a.txt"), "bypass");
  await assert.rejects(v.prepareChange(c.changeId, { requestId: "bypass" }), {
    code: "UNMANAGED_WRITE",
  });
});

test("C06 refresh expanding scope waits without partial locks and preserves draft; merge conflict retains both sides", async (t) => {
  const { v, project } = await backend(t),
    c = await begin(v, "expand", ["a.txt"]);
  await replace(v, c, "a.txt", "ours", "ours");
  const b = await begin(v, "blocker", ["b.txt"]);
  const waiting = v.refreshChange(c.changeId, {
    requestId: "expand-scope",
    scope: ["a.txt", "b.txt"],
    reason: "need second file",
  });
  const state = await v.inspect({ changeId: c.changeId });
  assert.ok(["waiting", "open"].includes(state.status));
  await v.abandonChange(b.changeId);
  await waiting;
  assert.equal(
    Buffer.from(
      (await v.read({ changeId: c.changeId, path: "a.txt" })).contentBase64,
      "base64",
    ).toString(),
    "ours",
  );
  const { git } = await import("./helpers/repository.js");
  // External trusted host advancement models a true same-file rebase conflict.
  const original = git(project, "rev-parse", v.integrationRef);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(project, "a.txt"), "theirs");
  git(project, "add", "--", "a.txt");
  git(project, "commit", "-m", "external source change");
  const external = git(project, "rev-parse", "HEAD");
  git(project, "update-ref", v.integrationRef, external, original);
  const refreshed = await v.refreshChange(c.changeId, {
    requestId: "conflict",
    reason: "inspect conflicting host change",
  });
  assert.equal(refreshed.status, "conflict");
  const raw = Buffer.from(
    (await v.read({ changeId: c.changeId, path: "a.txt" })).contentBase64,
    "base64",
  ).toString();
  assert.match(raw, /ours/);
  assert.match(raw, /theirs/);
  assert.ok(refreshed.feedback.merge.details);
});
