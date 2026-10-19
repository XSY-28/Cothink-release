import test from "node:test";
import assert from "node:assert/strict";
import { backend, begin } from "./helpers/repository.js";
test("C03 whole-set fair W/W wait, independent bypass, snapshots do not lock writes", async (t) => {
  const { v, events } = await backend(t);
  await begin(v, "reader", [], { readOnly: true });
  const a = await begin(v, "a", ["dir"]);
  const blocked = await begin(v, "retry", ["dir/child"], { wait: false });
  assert.equal(blocked.status, "blocked");
  let granted = false;
  const b = begin(v, "b", ["dir/child", "b.txt"]).then((c) => {
    granted = true;
    return c;
  });
  await begin(v, "independent", ["a.txt"]);
  assert.equal(granted, false);
  const third = await begin(v, "third", ["b.txt"], { wait: false });
  assert.equal(third.status, "blocked");
  await v.abandonChange(a.changeId);
  const second = await b;
  assert.equal(second.status, "open");
  assert.ok(events.some((e) => e.action === "queued"));
  await v.abandonChange(second.changeId);
  const retried = await begin(v, "retry", ["dir/child"], { wait: false });
  assert.equal(retried.status, "open");
});
test("C05 invalid/ambiguous/alias paths never gain write access", async (t) => {
  const { v } = await backend(t);
  for (const path of [
    "../a",
    "/tmp/a",
    ".git/config",
    "A/../../x",
    "a\\b",
    "a//b",
    "a/./b",
    "a\0b",
    "a:stream",
    "a.",
    "a ",
  ])
    await assert.rejects(
      begin(v, "bad-" + Buffer.from(path).toString("hex"), [path]),
      (e) => ["PATH", "SCOPE"].includes(e.code),
      path,
    );
  await assert.rejects(begin(v, "case", ["a.txt", "A.TXT"]), { code: "SCOPE" });
});
