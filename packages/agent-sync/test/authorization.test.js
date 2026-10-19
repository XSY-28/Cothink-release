import test from "node:test";
import assert from "node:assert/strict";
import { backend, begin, replace } from "./helpers/repository.js";
test("C03/C05 released authorization cannot edit while expanded scope is blocked; same request can later reacquire", async (t) => {
  const { v } = await backend(t),
    a = await begin(v, "a", ["a.txt"]);
  await replace(v, a, "a.txt", "preserved draft", "edit-a");
  const b = await begin(v, "b", ["b.txt"]);
  const input = {
      requestId: "expand",
      scope: ["a.txt", "b.txt"],
      reason: "explicit expansion",
    },
    blocked = await v.refreshChange(a.changeId, input, { wait: false });
  assert.equal(blocked.status, "blocked");
  const state = await v.inspect({ changeId: a.changeId });
  assert.equal(state.status, "waiting");
  const d = await begin(v, "d", ["a.txt"], { wait: false });
  assert.equal(d.status, "open");
  const old = await v.read({ changeId: a.changeId, path: "a.txt" });
  await assert.rejects(
    v.edit(a.changeId, {
      requestId: "late-old-authorization",
      expectedVersion: state.privateVersion,
      edits: [
        { path: "a.txt", oldHash: old.contentHash, contentBase64: "bm8=" },
      ],
    }),
    { code: "CHANGE_CLOSED" },
  );
  assert.equal(
    (await v.inspect({ changeId: a.changeId })).privateVersion,
    state.privateVersion,
  );
  await v.abandonChange(d.changeId);
  await v.abandonChange(b.changeId);
  const refreshed = await v.refreshChange(a.changeId, input, { wait: false });
  assert.equal(refreshed.status, "open");
  assert.equal(
    Buffer.from(
      (await v.read({ changeId: a.changeId, path: "a.txt" })).contentBase64,
      "base64",
    ).toString(),
    "preserved draft",
  );
});
test("C03/C05 readonly observation cannot acquire hidden write authority through refresh", async (t) => {
  const { v } = await backend(t),
    c = await begin(v, "observe", [], { readOnly: true });
  const old = await v.read({ changeId: c.changeId, path: "a.txt" });
  await assert.rejects(
    v.refreshChange(
      c.changeId,
      {
        requestId: "readonly-expand",
        scope: ["a.txt"],
        reason: "not a writable change",
      },
      { wait: false },
    ),
    { code: "SCOPE" },
  );
  await assert.rejects(
    v.edit(c.changeId, {
      requestId: "readonly-write",
      expectedVersion: c.privateVersion,
      edits: [
        { path: "a.txt", oldHash: old.contentHash, contentBase64: "bm8=" },
      ],
    }),
    { code: "NO_WRITE_CHANGE" },
  );
  const writer = await begin(v, "writer", ["a.txt"], { wait: false });
  assert.equal(writer.status, "open");
});
