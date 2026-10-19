import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fixture } from "./helpers/pi-fixture.js";
import { saveConfig } from "../src/config.js";
const cli = process.env.COTHINK_TEST_CLI ?? new URL("../bin/cothink.js", import.meta.url).pathname;
export function invoke(f, args, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, COTHINK_HOME: f.home, COTHINK_NO_TTY: "1", PI_OFFLINE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
test("CLI parameter/pipe/JSON/history/show share Pi host completion and query is zero calls", async (t) => {
  const f = await fixture(t, (c, n) => ({
    text:
      n === 1
        ? "DRAFT"
        : c.body.model === "main"
          ? "FINAL\n\n## 对评审意见的处理说明\nNOTES"
          : "REVIEW",
  }));
  saveConfig(f.home, { formatVersion: 2, ...f.models });
  const answer = await invoke(f, ["ask", "--json", "q"]);
  assert.equal(answer.code, 0, answer.stderr);
  const result = JSON.parse(answer.stdout);
  assert.equal(result.task.status, "completed");
  assert.equal(result.requests.length, 3);
  assert.equal(f.calls.length, 3);
  const show = await invoke(f, ["show", result.task.id]);
  assert.equal(show.stdout.trim(), "FINAL");
  const all = await invoke(f, ["show", result.task.id, "--all"]);
  assert.match(all.stdout, /DRAFT/);
  assert.match(all.stdout, /NOTES/);
  const history = await invoke(f, ["history", "--json"]);
  assert.ok(JSON.parse(history.stdout).some((r) => r.id === result.task.id));
  assert.equal(f.calls.length, 3);
});
test("partial print exits nonzero and does not print draft as final", async (t) => {
  const f = await fixture(t, (c) =>
    c.body.model === "r1" ? { error: 400 } : { text: "DRAFT OR REVIEW" },
  );
  saveConfig(f.home, { formatVersion: 2, ...f.models });
  const result = await invoke(f, ["ask", "question"]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /show|未完成/);
  assert.equal(f.calls.length, 2);
});
