import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url)),
);
test("candidate manifest explicitly distributes GUI source, shared final-answer and built assets", () => {
  for (const file of [
    "src/conversation.js",
    "src/final-answer.js",
    "src/gui-controller.js",
    "src/gui-projection.js",
    "src/gui-server.js",
    "src/gui-settings.js",
    "src/gui-work.js",
    "gui/dist",
    "gui/src",
    "gui/index.html",
    "gui/vite.config.js",
    "gui/THIRD_PARTY_NOTICES.txt",
  ])
    assert.ok(pkg.files.includes(file), file);
});

// A stale installed package must fail before imports/startup, even without an
// explicit expected version. The expectation comes from this checkout/caller.
for (const [helper, oldVersion] of [["gui-installed.mjs", "0.8.0-gui.1"], ["npm-installed.mjs", "0.6.0-windows.2"]]) {
  for (const explicit of [false, true]) {
    test(`${helper} rejects a stale installed version (${explicit ? "caller" : "source"} expectation)`, (t) => {
      const root = mkdtempSync(join(tmpdir(), "CoThink stale 中文 "));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      writeFileSync(join(root, "package.json"), JSON.stringify({ version: oldVersion }));
      const env = { ...process.env };
      delete env.COTHINK_EXPECT_VERSION;
      if (explicit) env.COTHINK_EXPECT_VERSION = "9.8.7-caller.1";
      const result = spawnSync(process.execPath, [fileURLToPath(new URL(`./helpers/${helper}`, import.meta.url)), root], { env, cwd: tmpdir(), encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /ERR_ASSERTION/);
      assert.ok(result.stderr.includes(explicit ? "9.8.7-caller.1" : pkg.version), result.stderr);
      assert.ok(result.stderr.includes(oldVersion), result.stderr);
    });
  }
}
test("GUI installed check takes its independent source version from the caller's source root", (t) => {
  const root = mkdtempSync(join(tmpdir(), "CoThink source 中文 "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "installed"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "9.8.7-source.1" }));
  writeFileSync(join(root, "installed/package.json"), JSON.stringify({ version: pkg.version }));
  const env = { ...process.env };
  delete env.COTHINK_EXPECT_VERSION;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./helpers/gui-installed.mjs", import.meta.url)), join(root, "installed"), root], { env, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ERR_ASSERTION/);
  assert.match(result.stderr, /9.8.7-source.1/);
});
test("terminal installed smoke resolves setup code from the installed CLI root", (t) => {
  const root = mkdtempSync(join(tmpdir(), "CoThink unavailable installed 中文 "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, COTHINK_TEST_CLI: join(root, "bin/cothink.js") };
  delete env.COTHINK_TEST_PACKAGE_ROOT;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./helpers/pi-manual-terminal.mjs", import.meta.url)), "--smoke"], { env, encoding: "utf8", timeout: 15000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ERR_MODULE_NOT_FOUND/);
  assert.ok(result.stderr.includes("teams.js"), result.stderr);
  assert.ok(result.stderr.includes("CoThink%20unavailable%20installed") || result.stderr.includes("CoThink unavailable installed"), result.stderr);
});
