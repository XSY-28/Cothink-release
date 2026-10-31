import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

function candidateFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "CoThink candidate 中文 ")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, "custom output"), metadata = join(root, "result.json"), exported = join(root, "github.env");
  mkdirSync(output);
  writeFileSync(join(output, "candidate.tgz"), "candidate fixture bytes");
  writeFileSync(metadata, JSON.stringify([{ version: "9.8.7-candidate.1", filename: "candidate.tgz" }]));
  writeFileSync(exported, "EXISTING=value\n");
  const env = { ...process.env, COTHINK_EXPECT_VERSION: "9.8.7-candidate.1", GITHUB_ENV: exported };
  return {
    root, output, metadata, exported, env,
    run: (args = [metadata, output]) => spawnSync(process.execPath,
      [fileURLToPath(new URL("../scripts/npm-candidate.mjs", import.meta.url)), ...args],
      { env, cwd: root, encoding: "utf8" }),
  };
}
test("candidate driver exports only the validated exact path and preserves existing environment entries", (t) => {
  const f = candidateFixture(t), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.exported, "utf8"), `EXISTING=value\nCOTHINK_TARBALL=${join(f.output, "candidate.tgz")}\n`);
});
for (const [name, change, diagnostic] of [
  ["stale version", (f) => writeFileSync(f.metadata, JSON.stringify([{ version: "9.8.6-stale.1", filename: "candidate.tgz" }])), /ERR_ASSERTION/],
  ["empty result", (f) => writeFileSync(f.metadata, "[]"), /ERR_ASSERTION/],
  ["multiple results", (f) => writeFileSync(f.metadata, JSON.stringify(Array(2).fill({ version: "9.8.7-candidate.1", filename: "candidate.tgz" }))), /ERR_ASSERTION/],
  ["parent path even when it exists", (f) => {
    writeFileSync(join(f.root, "outside.tgz"), "outside candidate");
    writeFileSync(f.metadata, JSON.stringify([{ version: "9.8.7-candidate.1", filename: "../outside.tgz" }]));
  }, /ERR_ASSERTION/],
  ["missing candidate", (f) => rmSync(join(f.output, "candidate.tgz")), /ENOENT/],
  ["directory instead of candidate", (f) => {
    rmSync(join(f.output, "candidate.tgz"));
    mkdirSync(join(f.output, "candidate.tgz"));
  }, /ERR_ASSERTION/],
  ["malformed JSON", (f) => writeFileSync(f.metadata, "not JSON"), /SyntaxError/],
  ["missing independent expected version", (f) => { delete f.env.COTHINK_EXPECT_VERSION; }, /COTHINK_EXPECT_VERSION/],
  ["missing explicit environment output", (f) => { delete f.env.GITHUB_ENV; }, /GITHUB_ENV/],
]) {
  test(`candidate driver rejects ${name} before exporting a path`, (t) => {
    const f = candidateFixture(t);
    change(f);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, diagnostic);
    assert.equal(readFileSync(f.exported, "utf8"), "EXISTING=value\n");
  });
}
test("candidate driver defaults select pack-result.json and dist from the invoking directory", (t) => {
  const f = candidateFixture(t), output = join(f.root, "dist");
  mkdirSync(output);
  writeFileSync(join(f.root, "pack-result.json"), readFileSync(f.metadata));
  writeFileSync(join(output, "candidate.tgz"), "default candidate bytes");
  const result = f.run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.exported, "utf8"), `EXISTING=value\nCOTHINK_TARBALL=${join(output, "candidate.tgz")}\n`);
});
