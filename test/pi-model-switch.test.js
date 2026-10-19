import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as config from "../src/config.js";

const kimi = { provider: "moonshot", modelId: "kimi-k3", thinkingLevel: "off", maxOutputTokens: 2048 };
const deepseek = { provider: "deepseek", modelId: "deepseek-flash", maxOutputTokens: 4096 };
const other = { provider: "fixture", modelId: "other" };
const openrouter = { provider: "openrouter", modelId: "deepseek/deepseek-v4.1-flash" };
const change = (...args) => {
  assert.equal(typeof config.switchMainModel, "function", "main selection must preserve the model roster");
  return config.switchMainModel(...args);
};

test("a new primary model keeps the former primary as first reviewer", () => {
  const before = { formatVersion: 2, main: kimi, secondary: [deepseek, other], piResources: { skills: ["local"] } };
  const snapshot = structuredClone(before);
  const after = change(before, openrouter);
  assert.deepEqual(after, { ...snapshot, main: openrouter, secondary: [kimi, deepseek, other] });
  assert.deepEqual(before, snapshot, "frozen prior tasks must not be mutated");
});

test("promoting an existing secondary swaps its slot without duplicates or lost settings", () => {
  const before = { formatVersion: 2, main: kimi, secondary: [other, deepseek] };
  const after = change(before, { provider: "deepseek", modelId: "deepseek-flash" });
  assert.deepEqual(after.main, deepseek);
  assert.deepEqual(after.secondary, [other, kimi]);
  assert.doesNotThrow(() => config.validateConfig(after));
});

test("reselecting the primary keeps its settings and secondary order", () => {
  const before = { formatVersion: 2, main: kimi, secondary: [deepseek, other] };
  assert.deepEqual(change(before, { provider: "moonshot", modelId: "kimi-k3" }), before);
});

test("switching a single-model roster retains the former primary", () => {
  assert.deepEqual(change({ formatVersion: 2, main: kimi, secondary: [] }, deepseek), {
    formatVersion: 2, main: deepseek, secondary: [kimi],
  });
});

test("the canonical model menu and its hidden alias preserve roles without generation", () => {
  execFileSync("python3", [new URL("./helpers/pi_model_switch_checks.py", import.meta.url).pathname], {
    env: process.env,
    stdio: "pipe",
    timeout: 60000,
  });
});

test("the former primary reviews the next answer after a role exchange", async (t) => {
  const { fixture } = await import("./helpers/pi-fixture.js");
  const { runTurn } = await import("../src/discussion.js");
  const f = await fixture(t);
  const next = change({ formatVersion: 2, main: f.models.main, secondary: [f.models.secondary[0]] }, f.models.secondary[0]);
  const task = await runTurn({ home: f.home, cwd: f.cwd, input: "check swapped roles", config: next });
  assert.equal(task.record.status, "completed");
  assert.deepEqual(f.calls.map((c) => c.body.model), ["r1", "main", "r1"]);
});
