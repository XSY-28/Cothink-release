import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { backend, begin, replace, accept, git } from "./helpers/repository.js";
const execution = JSON.parse(
  readFileSync(
    new URL(
      "../execution-manifest.json",
      import.meta.url,
    ),
  ),
).execution;
test("C02/C03/C11 unrelated latest-tip changes compose; waiter obtains actual accepted tip; two rounds and restore", async (t) => {
  const { v, baseVersion } = await backend(t),
    a = await begin(v, "a", ["a.txt"]),
    b = await begin(v, "b", ["b.txt"]);
  const waiting = begin(v, "wait", ["a.txt"]);
  await replace(v, a, "a.txt", "new A", "edit-a");
  await replace(v, b, "b.txt", "new B", "edit-b");
  const ar = await accept(v, a, "accept-a");
  assert.equal(ar.status, "accepted");
  assert.equal(ar.verification, "unverified");
  const next = await waiting;
  assert.equal(next.baseVersion, ar.acceptedVersion);
  await v.abandonChange(next.changeId);
  const br = await accept(v, b, "accept-b");
  assert.equal(br.status, "accepted");
  assert.notEqual(br.acceptedVersion, ar.acceptedVersion);
  const history = await v.inspect({ history: { limit: 2 } });
  assert.equal(history.versions.length, 2);
  assert.ok(history.nextCursor);
  assert.equal(
    (await v.inspect({ history: { limit: 2, cursor: history.nextCursor } }))
      .versions[0].version,
    baseVersion,
  );
  const restore = await begin(v, "restore", ["a.txt"], {
    restoreFrom: baseVersion,
  });
  const rr = await accept(v, restore, "restore-accept");
  assert.equal(rr.status, "accepted");
  assert.equal(
    Buffer.from(
      (await v.read({ version: rr.acceptedVersion, path: "a.txt" }))
        .contentBase64,
      "base64",
    ).toString(),
    "base A\n",
  );
  assert.equal(
    Buffer.from(
      (await v.read({ version: rr.acceptedVersion, path: "b.txt" }))
        .contentBase64,
      "base64",
    ).toString(),
    "new B",
  );
});
test("C04 file/missing/tree/negative search bases change explicitly, refresh retains entire draft", async (t) => {
  const { v } = await backend(t),
    a = await begin(v, "reader-writer", ["a.txt"]);
  for (const [path, kind] of [
    ["b.txt", "file"],
    ["new.txt", "file"],
    [".", "tree"],
  ])
    await v.read({ changeId: a.changeId, path, kind });
  await replace(v, a, "a.txt", "keep this", "keep");
  const p = await v.prepareChange(a.changeId, { requestId: "freeze" });
  const b = await begin(v, "other", ["b.txt", "new.txt"]);
  await replace(v, b, "b.txt", "changed basis", "change-b");
  await replace(v, b, "new.txt", "new file", "create");
  assert.equal((await accept(v, b, "accept-other")).status, "accepted");
  const rejected = await v.acceptChange({
    changeId: a.changeId,
    candidateVersion: p.candidateVersion,
    requestId: "basis-reject",
  });
  assert.equal(rejected.status, "basis_changed");
  assert.ok(rejected.changes.length >= 3);
  const refreshed = await v.refreshChange(a.changeId, {
    requestId: "refresh",
    reason: "Reviewed concrete changed inputs",
  });
  assert.equal(refreshed.status, "open");
  assert.equal(
    Buffer.from(
      (await v.read({ changeId: a.changeId, path: "a.txt" })).contentBase64,
      "base64",
    ).toString(),
    "keep this",
  );
  assert.equal((await accept(v, a, "accept-refreshed")).status, "accepted");
});
test("C06 stale candidate/new read rejected; old policy cannot authorize reopened draft", async (t) => {
  const { v, project, home } = await backend(t),
    c = await begin(v, "c");
  await replace(v, c, "a.txt", "x", "x");
  const p = await v.prepareChange(c.changeId, { requestId: "p" });
  await v.read({ changeId: c.changeId, path: "b.txt" });
  assert.equal(
    (
      await v.acceptChange({
        changeId: c.changeId,
        candidateVersion: p.candidateVersion,
        requestId: "stale",
      })
    ).status,
    "stale",
  );
  await v.close();
  const { createAgentSync } = await import("../src/index.js");
  const next = await createAgentSync({
    project,
    home,
    checks: [{ command: "false" }],
    execution,
  });
  t.after(() => next.close());
  await next.refreshChange(c.changeId, {
    requestId: "recover",
    reason: "new owner explicitly resumes",
  });
  assert.equal(
    (
      await next.acceptChange({
        changeId: c.changeId,
        candidateVersion: p.candidateVersion,
        requestId: "old-policy",
      })
    ).status,
    "stale",
  );
});
test("C09 actual combined check fails after individually passing; repair same draft succeeds; complete project checked", async (t) => {
  const checks = [
    {
      command: "node",
      args: [
        "-e",
        "const f=require('fs');process.exit(f.readFileSync('a.txt','utf8')==='1'&&f.readFileSync('b.txt','utf8')==='1'?1:0)",
      ],
    },
  ];
  const { v } = await backend(t, { execution, checks }),
    a = await begin(v, "a", ["a.txt"], { readScope: ["a.txt"] }),
    b = await begin(v, "b", ["b.txt"], { readScope: ["b.txt"] });
  await replace(v, a, "a.txt", "1", "ea");
  await replace(v, b, "b.txt", "1", "eb");
  const pa = await v.prepareChange(a.changeId, {
      requestId: "pa",
      check: true,
    }),
    pb = await v.prepareChange(b.changeId, { requestId: "pb", check: true });
  assert.equal(pa.candidates.at(-1).precheck.verification, "passed");
  assert.equal(pb.candidates.at(-1).precheck.verification, "passed");
  assert.equal(
    (
      await v.acceptChange({
        changeId: a.changeId,
        candidateVersion: pa.candidateVersion,
        requestId: "aa",
      })
    ).status,
    "accepted",
  );
  const fail = await v.acceptChange({
    changeId: b.changeId,
    candidateVersion: pb.candidateVersion,
    requestId: "ab",
  });
  assert.equal(fail.status, "check_failed");
  assert.equal(fail.checks[0].exitCode, 1);
  await replace(v, b, "b.txt", "2", "repair");
  assert.equal((await accept(v, b, "ab-fixed")).verification, "passed");
});
test("C09 checker source mutation cannot authorize acceptance; empty policy remains unverified", async (t) => {
  const { v, baseVersion } = await backend(t, {
    execution,
    checks: [{ command: "bash", args: ["-lc", "printf tampered > a.txt"] }],
  });
  const c = await begin(v, "c");
  await replace(v, c, "a.txt", "candidate", "e");
  const r = await accept(v, c, "check-modified");
  assert.equal(r.status, "check_failed");
  assert.equal(r.reason, "CHECK_MODIFIED_SOURCE");
  assert.equal((await v.inspect()).version, baseVersion);
});
