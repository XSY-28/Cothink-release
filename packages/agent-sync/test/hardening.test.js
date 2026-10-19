import test from "node:test";
import assert from "node:assert/strict";
import { backend, begin, replace, accept, git } from "./helpers/repository.js";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const execution = JSON.parse(
  readFileSync(
    new URL(
      "../execution-manifest.json",
      import.meta.url,
    ),
  ),
).execution;
test("C10 live read-only query sees new request facts and performs no recovery", async (t) => {
  const { v, project, home } = await backend(t),
    { createAgentSync } = await import("../src/index.js"),
    ro = await createAgentSync({ project, home, readOnly: true });
  t.after(() => ro.close());
  const c = await begin(v, "live");
  await replace(v, c, "a.txt", "live", "e");
  const p = await v.prepareChange(c.changeId, { requestId: "p" });
  const accepted = await v.acceptChange({
    changeId: c.changeId,
    candidateVersion: p.candidateVersion,
    requestId: "accepted",
  });
  assert.equal(
    (await ro.inspect({ requestId: "accepted" })).acceptedVersion,
    accepted.acceptedVersion,
  );
  assert.equal(
    (await ro.inspect({ history: { limit: 1 } })).versions[0].verification,
    "unverified",
  );
});
test("C03 simultaneous case aliases are never granted independently; blocked begin retry and stale base do not poison history", async (t) => {
  const { v } = await backend(t);
  const a = await begin(v, "a", ["new"]);
  const b = await begin(v, "b", ["NEW"], { wait: false });
  assert.equal(b.status, "blocked");
  await v.abandonChange(a.changeId);
  await assert.rejects(
    begin(v, "old", ["a.txt"], { baseVersion: "not-current" }),
    { code: "STALE_BASE" },
  );
  assert.ok((await v.inspect({ history: { limit: 1 } })).versions.length);
});
test("C01/C09 frozen execution configuration rejects unknown or secret fields", async (t) => {
  const { project, home } = await backend(t);
  const { createAgentSync } = await import("../src/index.js");
  await assert.rejects(
    createAgentSync({
      project,
      home,
      execution: { ...execution, env: { SECRET: "canary" } },
    }),
    { code: "EXECUTOR_CONFIG" },
  );
});
test("C06 explicit refresh reset preserves unmanaged projection before rematerializing authority", async (t) => {
  const { v } = await backend(t),
    c = await begin(v, "projection");
  await replace(v, c, "a.txt", "authoritative", "edit");
  writeFileSync(join(c.workspace, "a.txt"), "unmanaged unique bytes");
  await assert.rejects(v.prepareChange(c.changeId, { requestId: "bad" }), {
    code: "UNMANAGED_WRITE",
  });
  const r = await v.refreshChange(c.changeId, {
    requestId: "reset-projection",
    resetExecution: true,
    reason: "preserve bypass evidence and restore confirmed draft",
  });
  assert.equal(
    readFileSync(join(r.projectionArchive, "a.txt"), "utf8"),
    "unmanaged unique bytes",
  );
  assert.equal(
    Buffer.from(
      (await v.read({ changeId: c.changeId, path: "a.txt" })).contentBase64,
      "base64",
    ).toString(),
    "authoritative",
  );
});
test("C04 shell dependency includes file prefixes and Git ignored source cannot evade scope", async (t) => {
  const { v } = await backend(t, { execution }),
    c = await begin(v, "shell-basis", ["a.txt"], { readScope: ["b.txt"] });
  const r = await v.exec(c.changeId, {
    requestId: "shell-read",
    expectedVersion: c.privateVersion,
    command: "cat b.txt; printf changed > a.txt",
  });
  assert.equal(r.status, "completed");
  const b = await begin(v, "b", ["b.txt"]);
  await replace(v, b, "b.txt", "basis change", "edit-b");
  await accept(v, b, "accept-b");
  assert.equal(
    (await accept(v, c, "reject-shell-basis")).status,
    "basis_changed",
  );
  const d = await begin(v, "ignored", ["ignored"]);
  const ignored = await v.exec(d.changeId, {
    requestId: "ignored-command",
    expectedVersion: d.privateVersion,
    command: "mkdir ignored; printf output > ignored/output",
  });
  assert.equal(ignored.status, "completed");
  assert.ok(ignored.ignoredFiles.includes("ignored/output"));
});

test("C10 read-only instance refreshes a pending command receipt after cancellation", async (t) => {
  const { v, project, home } = await backend(t, { execution }),
    c = await begin(v, "pending");
  const ctrl = new AbortController();
  let ready;
  const barrier = new Promise((r) => (ready = r));
  const running = v.exec(
    c.changeId,
    {
      requestId: "pending-command",
      expectedVersion: c.privateVersion,
      command: "echo ready; sleep 1000",
    },
    { signal: ctrl.signal, onData: () => ready() },
  );
  await barrier;
  const { createAgentSync } = await import("../src/index.js"),
    ro = await createAgentSync({ project, home, readOnly: true });
  t.after(() => ro.close());
  assert.equal(
    (await ro.inspect({ requestId: "pending-command" })).status,
    "unknown",
  );
  ctrl.abort();
  assert.equal((await running).status, "cancelled");
  assert.equal(
    (await ro.inspect({ requestId: "pending-command" })).status,
    "cancelled",
  );
});
