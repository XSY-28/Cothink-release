import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "typebox";
import { fixture } from "./helpers/pi-fixture.js";
const packageRoot = resolve(process.env.COTHINK_TEST_PACKAGE_ROOT ?? fileURLToPath(new URL("../", import.meta.url)));
const load = name => import(pathToFileURL(join(packageRoot, "src", name)).href);
const { createModelRuntime, createRuntime } = await load("pi-runtime.js");
const { createTask } = await load("task.js");
const { validateModelThinking } = await load("thinking.js");

const id = "kimi-k3.1-pro";
const providers = ["moonshotai-cn", "moonshotai"];

test("K3.1 Pro is selectable offline beside existing Moonshot models and survives refresh", async (t) => {
  const f = await fixture(t);
  const path = join(f.home, "pi/models.json"), before = readFileSync(path);
  const auth = join(f.home, "pi/auth.json");
  writeFileSync(auth, "{}");
  const runtime = await createModelRuntime(f.home);
  for (const provider of providers) {
    const model = runtime.getModel(provider, id);
    assert.ok(model, `${provider} must include K3.1 Pro`);
    assert.equal(model.api, "openai-completions");
    assert.equal(model.contextWindow, 1048576);
    assert.equal(model.maxTokens, 1048576);
    assert.deepEqual(await validateModelThinking(model), ["low", "high", "max"]);
    for (const level of ["off", "medium", "xhigh"])
      await assert.rejects(validateModelThinking(model, level));
    assert.ok(runtime.getModel(provider, "kimi-k3"));
    assert.ok(runtime.getModel(provider, "kimi-k2.6"));
  }
  await runtime.refresh({ allowNetwork: false });
  for (const provider of providers) assert.ok(runtime.getModel(provider, id));
  assert.deepEqual(readFileSync(path), before, "managed catalog must not rewrite user models");
  assert.equal(readFileSync(auth, "utf8"), "{}");
  assert.equal(f.calls.length, 0);
});

test("an imported official Moonshot identity keeps its key and K3 while gaining Pro; proxies stay explicit", async (t) => {
  const f = await fixture(t), path = join(f.home, "pi/models.json");
  const data = JSON.parse(readFileSync(path));
  const entry = {
    api: "openai-completions", baseUrl: "https://api.moonshot.cn/v1", apiKey: "local-existing-key",
    models: [{ id: "kimi-k3", name: "saved K3", reasoning: true, contextWindow: 32000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  };
  data.providers["imported-kimi"] = entry;
  data.providers["kimi-proxy"] = { ...entry, baseUrl: "https://example.invalid/v1" };
  data.providers["kimi-anthropic"] = { ...entry, api: "anthropic-messages" };
  writeFileSync(path, JSON.stringify(data));
  const before = readFileSync(path), runtime = await createModelRuntime(f.home);
  assert.ok(runtime.getModel("imported-kimi", id));
  assert.equal(runtime.getModel("imported-kimi", "kimi-k3").name, "saved K3");
  assert.ok(runtime.hasConfiguredAuth("imported-kimi"));
  assert.equal(runtime.getModel("kimi-proxy", id), undefined);
  assert.equal(runtime.getModel("kimi-anthropic", id), undefined);
  await runtime.refresh({ allowNetwork: false });
  assert.ok(runtime.getModel("imported-kimi", id));
  assert.deepEqual(readFileSync(path), before);
  assert.equal(f.calls.length, 0);
});

async function wire(t, handler, level, options = {}) {
  const f = await fixture(t, handler), path = join(f.home, "pi/models.json");
  const data = JSON.parse(readFileSync(path));
  data.providers["moonshotai-cn"] = {
    api: "openai-completions", baseUrl: f.endpoint, apiKey: "local-kimi-key",
  };
  writeFileSync(path, JSON.stringify(data));
  const ref = { provider: "moonshotai-cn", modelId: id, ...(level === undefined ? {} : { thinkingLevel: level }) };
  const task = createTask({ home: f.home, input: "Kimi adapter fixture", models: { main: ref, secondary: [] }, singleModel: true });
  const rt = await createRuntime({ home: f.home, cwd: f.cwd, modelRef: ref, ...options });
  t.after(() => rt.dispose());
  rt.bindTask(task, task.beginPhase("draft", "main", ref));
  return { f, rt, task };
}

for (const level of [undefined, "low", "high", "max"]) {
  test(`Pro uses only supported reasoning_effort and omits fixed sampling / default output limits (${level ?? "default"})`, async (t) => {
    const { f, rt, task } = await wire(t, () => ({ text: "done" }), level);
    await rt.prompt("short fixture");
    assert.equal(f.calls.length, 1);
    const body = f.calls[0].body;
    assert.equal(body.model, id);
    if (level !== undefined) assert.equal(body.reasoning_effort, level);
    else assert.equal(body.reasoning_effort, "high");
    for (const field of ["thinking", "temperature", "top_p", "max_tokens", "max_completion_tokens"])
      assert.equal(field in body, false, field);
    assert.equal(task.usage().cost, null, "unknown catalog pricing is never reported as free");
  });
}

test("Pro explicit output cap uses max_completion_tokens", async (t) => {
  const { f, rt } = await wire(t, () => ({ text: "done" }), "high", { maxOutputTokens: 321 });
  await rt.prompt("fixture");
  assert.equal(f.calls[0].body.max_completion_tokens, 321);
  assert.equal("max_tokens" in f.calls[0].body, false);
});

test("Pro preserves streamed reasoning through two tool calls and the next user turn", async (t) => {
  const reasoning = ["先检查证据。", "再进行第二步。", "核对结果。"];
  const handler = (call, n, req, res) => {
    if (n <= 3) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta, finish_reason = null) => res.write("data: " + JSON.stringify({
        id: "kimi-preserved", model: id, choices: [{ index: 0, delta, finish_reason }],
      }) + "\n\n");
      chunk({ role: "assistant", reasoning_content: reasoning[n - 1] });
      if (n <= 2) {
        chunk({ tool_calls: [{ index: 0, id: `probe-${n}`, type: "function", function: { name: "probe", arguments: JSON.stringify({ step: n }) } }] });
        chunk({}, "tool_calls");
      } else { chunk({ content: "finished" }); chunk({}, "stop"); }
      res.end("data: [DONE]\n\n");
      return null;
    }
    return { text: "follow-up finished" };
  };
  const tools = [{
    name: "probe", label: "probe", description: "fixture-only observation", parameters: Type.Object({ step: Type.Number() }),
    async execute(_id, args) { return { content: [{ type: "text", text: `step ${args.step} observed` }], details: {} }; },
  }];
  const { f, rt, task } = await wire(t, handler, "max", { toolDefinitions: tools, activeToolNames: ["probe"] });
  // Work policy permits the existing SDK tool loop; no delegation or host shell.
  task.record.mode = "work"; task.record.maxCalls = null; task.save();
  await rt.prompt("use the fixture probe twice");
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls[2].body.messages.filter(m => m.role === "assistant").map(m => m.reasoning_content), reasoning.slice(0, 2));
  assert.deepEqual(f.calls[2].body.messages.filter(m => m.role === "tool").map(m => m.tool_call_id), ["probe-1", "probe-2"]);
  await rt.prompt("continue using the existing context");
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.calls[3].body.messages.filter(m => m.role === "assistant").map(m => m.reasoning_content), reasoning);
  assert.ok(f.calls.every(c => c.body.reasoning_effort === "max"));
});

test("explicit user Pro metadata remains authoritative", async (t) => {
  const f = await fixture(t), path = join(f.home, "pi/models.json");
  const data = JSON.parse(readFileSync(path));
  data.providers["moonshotai-cn"] = {
    models: [{ id, name: "User Pro", reasoning: true, contextWindow: 12345, maxTokens: 2345 }],
  };
  writeFileSync(path, JSON.stringify(data));
  const runtime = await createModelRuntime(f.home);
  assert.equal(runtime.getModel("moonshotai-cn", id).name, "User Pro");
  assert.equal(runtime.getModel("moonshotai-cn", id).contextWindow, 12345);
  assert.equal(runtime.getModel("moonshotai-cn", id).maxTokens, 2345);
  assert.ok(runtime.getModel("moonshotai-cn", "kimi-k3"));
  data.providers["moonshotai-cn"].models = [];
  writeFileSync(path, JSON.stringify(data));
  await runtime.refresh({ allowNetwork: false });
  assert.equal(runtime.getModel("moonshotai-cn", id)?.name, "Kimi K3.1 Pro");
});

function replyWithThinking(res, reply, thinking) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta, finish_reason = null) => res.write("data: " + JSON.stringify({
    id: "kimi-integration", model: id, choices: [{ index: 0, delta, finish_reason }],
  }) + "\n\n");
  chunk({ role: "assistant", reasoning_content: thinking });
  if (reply.toolCalls) {
    chunk({ tool_calls: reply.toolCalls.map((c, index) => ({ index, id: `call-${thinking}-${index}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) });
    chunk({}, "tool_calls");
  } else { chunk({ content: reply.text }); chunk({}, "stop"); }
  res.end("data: [DONE]\n\n");
  return null;
}

for (const singleModel of [true, false]) {
  test(`Pro follows actual CoThink ${singleModel ? "ONE" : "discussion"} request policy and preserves draft reasoning`, async (t) => {
    const { runTurn } = await load("discussion.js");
    const f = await fixture(t, (c, n, req, res) => c.body.model === id
      ? replyWithThinking(res, { text: n === 1 ? "PRO_DRAFT" : "PRO_FINAL" }, `reason-${n}`)
      : { text: "REVIEW" });
    const path = join(f.home, "pi/models.json"), data = JSON.parse(readFileSync(path));
    data.providers["moonshotai-cn"] = { baseUrl: f.endpoint, apiKey: "kimi-local" };
    writeFileSync(path, JSON.stringify(data));
    const task = await runTurn({ home: f.home, cwd: f.cwd, input: "new model question", singleModel,
      config: { formatVersion: 2, main: { provider: "moonshotai-cn", modelId: id, thinkingLevel: "high" }, secondary: [f.models.secondary[0]] } });
    assert.equal(task.record.status, "completed");
    assert.equal(f.calls.length, singleModel ? 1 : 3);
    assert.equal(task.record.maxCalls, singleModel ? 1 : 3);
    if (!singleModel) {
      assert.deepEqual(f.calls.map(c => c.body.model), [id, "r1", id]);
      assert.equal(f.calls[2].body.messages.find(m => m.role === "assistant").reasoning_content, "reason-1");
    }
  });
}

test("Pro crosses start_work and completes real agent-sync read/edit/accept with preserved tool reasoning", async (t) => {
  const { repository } = await import("./helpers/git-fixture.js");
  const { runTurn } = await load("discussion.js");
  const repo = repository(t);
  const calls = [
    { toolCalls: [{ name: "start_work", args: { reason: "fixture text update", scope: ["a.txt"] } }] },
    { toolCalls: [{ name: "read", args: { path: "a.txt" } }] },
    { toolCalls: [{ name: "edit", args: { path: "a.txt", edits: [{ oldText: "base A", newText: "Pro changed" }] } }] },
    { toolCalls: [{ name: "accept_change", args: {} }] },
    { text: "DELIVERED" },
  ];
  const f = await fixture(t, (c, n, req, res) => replyWithThinking(res, calls[n - 1] ?? { text: "DELIVERED" }, `work-${n}`));
  const path = join(f.home, "pi/models.json"), data = JSON.parse(readFileSync(path));
  data.providers["moonshotai-cn"] = { baseUrl: f.endpoint, apiKey: "kimi-local" };
  writeFileSync(path, JSON.stringify(data));
  const task = await runTurn({ home: f.home, cwd: repo.project, input: "change a.txt using managed tools", singleModel: true,
    config: { formatVersion: 2, main: { provider: "moonshotai-cn", modelId: id, thinkingLevel: "max" }, secondary: [], work: { checks: [] } } });
  assert.equal(task.record.status, "completed", JSON.stringify(task.record.error));
  assert.equal(task.record.maxCalls, null);
  assert.equal(f.calls.length, 5);
  assert.equal(readFileSync(join(repo.project, "a.txt"), "utf8"), "base A\n");
  assert.equal(readFileSync(join(task.record.work.resultWorkspace, "a.txt"), "utf8"), "Pro changed\n");
  for (const c of f.calls) {
    assert.equal(c.body.reasoning_effort, "max");
    for (const m of c.body.messages.filter(m => m.role === "assistant" && m.tool_calls?.length))
      assert.match(m.reasoning_content, /^work-\d+$/);
  }
});

test("refresh does not retain a removed imported credential or removed user models", async (t) => {
  const f = await fixture(t), path = join(f.home, "pi/models.json");
  const data = JSON.parse(readFileSync(path));
  data.providers["import-revocation"] = {
    api: "openai-completions", baseUrl: "https://api.moonshot.cn/v1", apiKey: "revoked-fixture-key",
    headers: { "X-Configured-Secret": "removed-header" },
    models: [{ id: "kimi-k3", name: "old imported model" }],
  };
  writeFileSync(path, JSON.stringify(data));
  const runtime = await createModelRuntime(f.home);
  assert.ok(runtime.getModel("import-revocation", id));
  assert.ok(await runtime.getAuth(runtime.getModel("import-revocation", id)));
  data.providers["import-revocation"].apiKey = "replacement-fixture-key";
  delete data.providers["import-revocation"].headers;
  writeFileSync(path, JSON.stringify(data));
  await runtime.refresh({ allowNetwork: false });
  const replaced = await runtime.getAuth(runtime.getModel("import-revocation", id));
  assert.equal(replaced.auth.apiKey, "replacement-fixture-key");
  assert.equal(replaced.auth.headers?.["X-Configured-Secret"], undefined);
  delete data.providers["import-revocation"].apiKey;
  writeFileSync(path, JSON.stringify(data));
  await runtime.refresh({ allowNetwork: false });
  assert.equal(await runtime.getAuth(runtime.getModel("import-revocation", id)), undefined);
  data.providers["import-revocation"].models = [];
  writeFileSync(path, JSON.stringify(data));
  await runtime.refresh();
  assert.equal(runtime.getModel("import-revocation", "kimi-k3"), undefined);
  assert.equal(runtime.getModel("import-revocation", id), undefined);
});

test("the existing model selector reuses imported authentication when choosing Pro", async (t) => {
  const { selectModelRef } = await load("setup.js");
  const f = await fixture(t), path = join(f.home, "pi/models.json");
  const data = JSON.parse(readFileSync(path));
  data.providers["selector-kimi"] = { api: "openai-completions", baseUrl: "https://api.moonshot.cn/v1", apiKey: "selector-local-key", models: [{ id: "kimi-k3" }] };
  writeFileSync(path, JSON.stringify(data));
  const before = readFileSync(path), runtime = await createModelRuntime(f.home);
  let secretPrompts = 0;
  const ref = await selectModelRef({ home: f.home, runtime, role: "main", io: {
    select: async (label, choices) => {
      if (label.endsWith("服务商")) return "selector-kimi";
      assert.ok(choices.some(choice => choice.id === id && choice.label === "Kimi K3.1 Pro"));
      return id;
    },
    prompt: async () => { secretPrompts++; throw Error("Existing key must be reused"); },
  } });
  assert.deepEqual(ref, { provider: "selector-kimi", modelId: id });
  assert.equal(secretPrompts, 0);
  assert.deepEqual(readFileSync(path), before);
  assert.equal(f.calls.length, 0);
});

test("GUI bootstrap exposes Pro and only low/high/max without generating", async (t) => {
  const { createGuiController } = await load("gui-controller.js");
  const f = await fixture(t), controller = await createGuiController({ home: f.home, cwd: f.cwd });
  t.after(() => controller.close());
  const bootstrap = await controller.bootstrap();
  for (const provider of providers) {
    const model = bootstrap.models.find(model => model.provider === provider && model.modelId === id);
    assert.ok(model); assert.deepEqual(model.thinkingLevels, ["low", "high", "max"]);
  }
  assert.equal(f.calls.length, 0);
});

test("refresh reconciles new, changed, and deleted imported identities without stale Pro", async (t) => {
  const f = await fixture(t), path = join(f.home, "pi/models.json");
  const data = JSON.parse(readFileSync(path));
  const entry = { api: "openai-completions", baseUrl: "https://api.moonshot.cn/v1", apiKey: "fixture-key",
    models: [{ id: "kimi-k3", name: "old K3", reasoning: true, contextWindow: 32000, maxTokens: 4096 }] };
  const runtime = await createModelRuntime(f.home);
  data.providers["live-import"] = entry;
  writeFileSync(path, JSON.stringify(data));
  await runtime.refresh({ providers: ["live-import"], allowNetwork: true });
  assert.ok(runtime.getModel("live-import", id), "new imports should gain Pro without restart");
  for (const patch of [{ baseUrl: "https://example.invalid/v1" }, { api: "anthropic-messages" }]) {
    data.providers["live-import"] = { ...entry, ...patch };
    writeFileSync(path, JSON.stringify(data));
    await runtime.refresh({ providers: ["live-import"], allowNetwork: false });
    assert.equal(runtime.getModel("live-import", id), undefined, "ineligible imports should lose only the managed model");
    assert.equal(runtime.getModel("live-import", "kimi-k3").name, "old K3");
    data.providers["live-import"] = entry;
    writeFileSync(path, JSON.stringify(data));
    await runtime.refresh();
    assert.ok(runtime.getModel("live-import", id));
  }
  delete data.providers["live-import"];
  writeFileSync(path, JSON.stringify(data));
  await Promise.all([runtime.refresh(), runtime.refresh({ providers: ["moonshotai-cn"] })]);
  assert.equal(runtime.getProvider("live-import"), undefined);
  assert.ok(runtime.getModel("moonshotai-cn", id));
  assert.equal(f.calls.length, 0);
});

test("Moonshot URL over a different builtin identity keeps the original builtin catalog", async (t) => {
  const f = await fixture(t), path = join(f.home, "pi/models.json");
  const data = JSON.parse(readFileSync(path));
  const runtime = await createModelRuntime(f.home);
  const before = runtime.getProvider("deepseek").getModels().map(m => m.id);
  data.providers.deepseek = { api: "openai-completions", baseUrl: "https://api.moonshot.cn/v1", apiKey: "fixture-key" };
  writeFileSync(path, JSON.stringify(data));
  const restarted = await createModelRuntime(f.home);
  assert.deepEqual(restarted.getProvider("deepseek").getModels().map(m => m.id), before);
  assert.equal(restarted.getModel("deepseek", id), undefined);
  assert.equal(f.calls.length, 0);
});
