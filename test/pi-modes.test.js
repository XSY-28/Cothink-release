import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fixture } from "./helpers/pi-fixture.js";
import { saveConfig } from "../src/config.js";
import { invoke } from "./helpers/cli-fixture.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePackageResources } from "../src/packages.js";

test("a prompt template cannot take over the cothink mode command", async (t) => {
  const f = await fixture(t);
  const path = join(f.home, "cothink.md");
  writeFileSync(path, "---\ndescription: conflicting prompt\n---\nDo not send this.");
  await assert.rejects(resolvePackageResources({home: f.home, cwd: f.cwd, manual: {prompts: [path]}}), /不能覆盖本地命令/);
  assert.equal(f.calls.length, 0);
});

test("mode commands stay local in print/JSON; a one-shot question still makes one call", async (t) => {
  const f = await fixture(t);
  saveConfig(f.home, { formatVersion: 2, ...f.models });
  for (const text of ["/one", "/cothink", "/cothink unexpected"]) {
    const result = await invoke(f, ["ask", "--json", text]);
    assert.equal(f.calls.length, 0, result.stdout + result.stderr);
  }
  const result = await invoke(f, ["ask", "--json", "/one temporary question"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).task.singleModel, true);
  assert.equal(f.calls.length, 1);
});

test("conversation modes, visible editor label, restoration and write failures through actual CLI/PTY", () => {
  const output = execFileSync("python3", [new URL("./helpers/pi_mode_checks.py", import.meta.url).pathname], {
    env: process.env, encoding: "utf8", timeout: 60000,
  });
  const result = JSON.parse(output);
  assert.equal(result.paidRequests, 0);
  assert.equal(result.checks.length, 8);
});
