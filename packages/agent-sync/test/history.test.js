import test from "node:test";
import assert from "node:assert/strict";
import { backend } from "./helpers/repository.js";
test("C11 fixed tree/file/missing/binary API and bounded history/diff", async (t) => {
  const { v, baseVersion } = await backend(t);
  const missing = await v.read({ version: baseVersion, path: "missing" });
  assert.equal(missing.contentHash, null);
  assert.equal(missing.contentBase64, null);
  const tree = await v.read({ version: baseVersion, path: ".", kind: "tree" });
  assert.equal(tree.entries.length, 3);
  assert.ok(tree.fingerprint);
  const h = await v.inspect({ history: { limit: 1 } });
  assert.equal(h.versions[0].version, baseVersion);
  await assert.rejects(v.inspect({ history: { limit: 101 } }), {
    code: "INPUT",
  });
  const diff = await v.inspect({
    fromVersion: baseVersion,
    toVersion: baseVersion,
  });
  assert.deepEqual(diff.files, []);
  await assert.rejects(v.read({ version: "HEAD~999", path: "a.txt" }), {
    code: "VERSION",
  });
});
