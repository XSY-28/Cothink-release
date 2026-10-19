import test from "node:test";
import assert from "node:assert/strict";
import { backend, begin } from "./helpers/repository.js";
test("C01 exported API, source fields, read-only observation and async close", async (t) => {
  const { v, baseVersion } = await backend(t);
  for (const name of [
    "beginChange",
    "read",
    "edit",
    "exec",
    "prepareChange",
    "refreshChange",
    "acceptChange",
    "inspect",
    "abandonChange",
    "checkCurrent",
    "close",
  ])
    assert.equal(typeof v[name], "function", name);
  const p = await v.inspect();
  assert.equal(p.backend, "agent-sync");
  assert.equal(p.protocolVersion, 1);
  assert.equal(p.version, baseVersion);
  for (const k of ["projectId", "root", "directory", "integrationRef"])
    assert.equal(typeof v[k], "string");
  const c = await begin(v, "observation", [], { readOnly: true });
  assert.equal(c.baseVersion, baseVersion);
  assert.equal(Object.hasOwn(c, "owner"), false);
  assert.equal(Object.hasOwn(c, "privateRef"), false);
  const r = await v.read({ changeId: c.changeId, path: "a.txt" });
  assert.equal(Buffer.from(r.contentBase64, "base64").toString(), "base A\n");
  assert.ok(v.close() instanceof Promise);
  await v.close();
});
test("C03 queued cancellation and independent writers", async (t) => {
  const { v } = await backend(t),
    c = await begin(v, "a");
  const controller = new AbortController();
  const queued = v.beginChange(
    { requestId: "b", actor: "b", intent: "blocked", scope: ["a.txt"] },
    { signal: controller.signal },
  );
  const independent = await begin(v, "independent", ["b.txt"]);
  assert.equal(independent.status, "open");
  controller.abort();
  await assert.rejects(queued, { code: "CANCELLED" });
  await v.abandonChange(c.changeId);
});
