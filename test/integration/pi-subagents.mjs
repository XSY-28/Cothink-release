// Explicit network integration: npm install into disposable COTHINK_HOME.
// Run: node --test test/integration/pi-subagents.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture } from "../helpers/pi-fixture.js";
import { invoke } from "../helpers/cli-fixture.js";
import { createRuntime } from "../../src/pi-runtime.js";
import { createTask } from "../../src/task.js";

const source = "npm:pi-subagents@0.84.0";
const integrity = "sha512-IagE1hcBxLi82jTxTmcy/pIWckBuqhMH1GfAOe6/aIMVfnopMybCbcTMUS5K0CNy4tqSwHGleaXabaDmJS1QOg==";

test("public pi-subagents installs, registers commands/tools, runs and cancels a real SDK child", { timeout: 60000 }, async (t) => {
  let cancelMode = false, childStarted, childClosed;
  const started = new Promise((r) => { childStarted = r; });
  const closed = new Promise((r) => { childClosed = r; });
  const dispatch = {
    toolCalls: [{ name: "subagent", args: {
      agent: "stage1", task: "Return CHILD_RESULT from the supplied reference",
      model: "fixture/main", async: false, options: { context: "fresh" },
    } }],
  };
  const f = await fixture(t, (_call, n, _req, res) => {
    if (cancelMode) {
      if (n === 5) return dispatch;
      res.on("close", childClosed);
      childStarted();
      return null;
    }
    if (n === 1) return dispatch;
    if (n === 2) return {
      toolCalls: [{ name: "read", args: { path: join(f.cwd, "skill-reference.txt") } }],
    };
    return { text: n === 3 ? "CHILD_RESULT" : "PARENT_RESULT" };
  });
  const install = await invoke(f, ["install", source, "--json"]);
  assert.equal(install.code, 0, install.stdout + install.stderr);
  const pkg = JSON.parse(install.stdout).packages.find((x) => x.name === "pi-subagents");
  assert.equal(pkg.version, "0.84.0");
  const lock = JSON.parse(readFileSync(join(f.home, "pi/npm/package-lock.json"), "utf8"));
  const locked = Object.entries(lock.packages).find(([path]) => /(^|\/)pi-subagents$/.test(path));
  assert.equal(locked?.[1]?.integrity, integrity);
  assert.ok(pkg.resources.some((x) => x.kind === "extensions" && x.enabled));

  // Stage 1 scaffolding only. Production inheritance belongs to the work adapter.
  const oldEnv = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.PI_CODING_AGENT_DIR = join(f.home, "pi");
  process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = resolve("node_modules/@earendil-works/pi-coding-agent");
  mkdirSync(join(f.home, "pi/agents"), { recursive: true });
  writeFileSync(join(f.home, "pi/agents/stage1.md"),
    "---\nname: stage1\ndescription: deterministic isolated child\nmodel: fixture/main\ntools: read\n---\nReturn the requested answer.\n");
  writeFileSync(join(f.home, "pi/settings.json"), JSON.stringify({
    packages: [{ source }], retry: { enabled: false }, compaction: { enabled: false },
    cacheWarming: "off", httpIdleTimeoutMs: 0,
  }));
  writeFileSync(join(f.cwd, "skill-reference.txt"), "ACTUAL_REFERENCE_CONTENT");
  const rt = await createRuntime({
    home: f.home, cwd: f.cwd, modelRef: f.models.main, nativePluginTools: true,
  });
  t.after(() => rt.dispose());
  const loaded = rt.services.resourceLoader.getExtensions().extensions;
  assert.ok(loaded.some((x) => x.tools.has("subagent")));
  assert.ok(loaded.some((x) => x.commands.has("subagents")));
  assert.ok(rt.session.getActiveToolNames().includes("subagent"));
  const task = createTask({ home: f.home, input: "Use helper", models: f.models, workRequest: {} });
  rt.bindTask(task, task.beginPhase("work", "main", f.models.main));
  const result = await rt.prompt("Use the stage1 helper once, then return its result.");
  console.log(JSON.stringify({ calls: f.calls.length, tools: task.record.tools,
    result: result.text, loaded: loaded.map((x) => x.path) }));
  assert.equal(f.calls.length, 4);
  assert.match(JSON.stringify(f.calls[2].body.messages), /ACTUAL_REFERENCE_CONTENT/);
  assert.match(JSON.stringify(f.calls[3].body.messages), /CHILD_RESULT/);
  assert.equal(task.record.tools.find((x) => x.name === "subagent").status, "completed");
  assert.equal(task.requests().length, 2, "child usage stays plugin-owned, not fabricated as a host request");

  cancelMode = true;
  const cancelled = createTask({ home: f.home, input: "Cancel helper", models: f.models, workRequest: {} });
  rt.bindTask(cancelled, cancelled.beginPhase("work", "main", f.models.main));
  const rejected = assert.rejects(rt.prompt("Launch one helper then wait"));
  await started;
  await cancelled.cancel();
  await rejected;
  await closed;
  assert.equal(f.calls.length, 6, "no retry or parent continuation after cancellation");
  assert.equal(cancelled.record.tools[0].status, "cancelled");
  console.log("foreground cancellation: child HTTP closed, parent aborted, no retry");
});
