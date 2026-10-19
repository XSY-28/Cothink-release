import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { managed, execution } from "./helpers/agent-sync-fixture.js";
test("A04 native file operations require actual reads and atomically advance private tree", async (t) => {
  const f = await managed(t);
  await assert.rejects(
    f.call("write", "blind", { path: "a.txt", content: "blind" }),
    { code: "NEED_READ" },
  );
  await f.call("read", "read-a", { path: "a.txt" });
  await f.call("write", "write-a", { path: "a.txt", content: "old" });
  await f.call("edit", "edit-a", {
    path: "a.txt",
    edits: [{ oldText: "old", newText: "edited" }],
  });
  assert.equal(
    Buffer.from(
      (await f.v.read({ changeId: f.binding.current.changeId, path: "a.txt" }))
        .contentBase64,
      "base64",
    ).toString(),
    "edited",
  );
  assert.equal(readFileSync(join(f.project, "a.txt"), "utf8"), "base A\n");
  assert.ok(f.task.record.tools.every((x) => x.requestId));
});
test("A04 tool definitions resolve current change on every call; no stale cwd or shared oldHash", async (t) => {
  const f = await managed(t);
  await f.call("write", "new1", { path: "new.txt", content: "first" });
  const old = f.binding.current;
  await f.v.abandonChange(old.changeId, { requestId: "abandon" });
  f.binding.current = await f.v.beginChange({
    requestId: "second",
    actor: "main",
    intent: "second",
    scope: ["new.txt"],
  });
  await f.call("write", "new2", { path: "new.txt", content: "second" });
  assert.equal(readFileSync(join(old.workspace, "new.txt"), "utf8"), "first");
  assert.equal(
    readFileSync(join(f.binding.current.workspace, "new.txt"), "utf8"),
    "second",
  );
});
test("A04 directory/search tools use scoped snapshot and capture negative search basis", async (t) => {
  const f = await managed(t, { scope: ["new.txt"], readScope: ["a.txt"] });
  const ls = await f.call("ls", "ls", { path: "." });
  assert.match(JSON.stringify(ls), /a.txt/);
  assert.doesNotMatch(JSON.stringify(ls), /b.txt/);
  const grep = await f.call("grep", "grep", { pattern: "NO_MATCH", path: "." });
  assert.match(JSON.stringify(grep), /No matches|无匹配/);
  await assert.rejects(
    f.call("read", "escape", { path: join(f.project, "b.txt") }),
  );
  await f.call("write", "create", { path: "new.txt", content: "new" });
  const p = await f.v.prepareChange(f.binding.current.changeId, {
    requestId: "prepare",
  });
  assert.ok(Object.keys(p.candidates.at(-1).basis).length);
});
test("A04 real Docker Shell exit, seconds conversion and full Unicode logs are correctly bridged", async (t) => {
  const f = await managed(t, { scope: ["a.txt"], execution });
  const r = await f.call("bash", "bash", {
    command: "printf changed > a.txt; printf warning >&2; exit 7",
    timeout: 1.5,
  });
  assert.equal(r.structuredContent.exit_code, 7);
  assert.equal(r.isError, true);
  assert.equal(f.task.record.tools.at(-1).timeoutMs, 1500);
  const large = await f.call("bash", "large", {
    command:
      "node -e \"for(let i=0;i<3500;i++)console.log('第'+i+'行 Unicode 正文')\"",
  });
  const ref = large.details.fullOutputPath;
  assert.match(ref, /^output:/);
  const page = await f.call("read", "log", {
    path: ref,
    offset: 3000,
    limit: 2,
  });
  assert.match(JSON.stringify(page), /第2999行/);
  assert.doesNotMatch(JSON.stringify(page), /�/);
  assert.equal(readFileSync(join(f.project, "a.txt"), "utf8"), "base A\n");
  await assert.rejects(
    f.call("write", "log-write", { path: ref, content: "bad" }),
  );
  await assert.rejects(
    f.call("read", "other-log", { path: "output:not-from-this-task" }),
  );
});
