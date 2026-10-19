import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/pi-fixture.js";
const runtime = await import("../src/pi-runtime.js").catch(() => ({}));
const tasks = await import("../src/task.js").catch(() => ({}));
async function stage(t, handler, options = {}) {
  assert.equal(typeof runtime.createRuntime, "function", "Pi host is implemented");
  const f = await fixture(t, handler);
  const task = tasks.createTask({ home: f.home, input: "question", models: f.models, ...options });
  const rt = await runtime.createRuntime({
    home: f.home,
    cwd: f.cwd,
    modelRef: f.models.main,
    ...options,
  });
  t.after(() => rt.dispose());
  task.beginPhase("draft", "main", f.models.main);
  rt.bindTask(task, task.record.stages.at(-1));
  return { f, task, rt };
}
test("before-send storage failure stops the provider and remains visible", async (t) => {
  const { f, task, rt } = await stage(t, undefined, {
    writeRequest: () => {
      throw Error("disk full");
    },
  });
  await assert.rejects(rt.prompt("question"), /disk full/);
  assert.equal(f.calls.length, 0);
  assert.notEqual(task.record.status, "completed");
});
test("actual wire omits optional output cap, disables retries and counts missing usage as unknown", async (t) => {
  const { f, task, rt } = await stage(t, () => ({ text: "answer fixture-secret", noUsage: true }));
  await rt.prompt("question");
  assert.equal(f.calls.length, 1);
  assert.ok(!("max_tokens" in f.calls[0].body));
  assert.ok(!("max_completion_tokens" in f.calls[0].body));
  assert.equal(task.usage().unknownCalls, 1);
  assert.equal(task.usage().cost, null);
  assert.equal(task.requests()[0].usage, null);
  assert.doesNotMatch(JSON.stringify(task.requests()), /fixture-secret/);
});
test("wire usage is counted once and truncation is partial", async (t) => {
  const { f, task, rt } = await stage(t, () => ({ text: "partial", finish: "length" }));
  await assert.rejects(rt.prompt("question"), /截断|partial/);
  assert.equal(f.calls.length, 1);
  assert.equal(task.requests()[0].status, "partial");
  assert.equal(task.usage().known.input, 12);
});
test("HTTP errors are never automatically retried", async (t) => {
  const { f, task, rt } = await stage(t, () => ({ error: 429 }));
  await assert.rejects(rt.prompt("question"));
  assert.equal(f.calls.length, 1);
  assert.notEqual(task.record.status, "completed");
});
test("cancel ends the entire bound runtime; reopening does not replay unknown requests", async (t) => {
  let entered;
  const started = new Promise((r) => (entered = r));
  const { f, task, rt } = await stage(t, async (call, n, req, res) => {
    entered();
    return null;
  });
  const p = rt.prompt("question");
  await started;
  await task.cancel();
  await assert.rejects(p);
  const stored = tasks.readTask(f.home, task.record.id);
  assert.notEqual(stored.status, "completed");
  assert.equal(f.calls.length, 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(f.calls.length, 1);
});
test("Pi session persistence error prevents the next phase and preserves request data", async (t) => {
  const { f, task, rt } = await stage(t, () => ({ text: "saved HTTP response" }));
  const original = rt.sessionManager.appendMessage.bind(rt.sessionManager);
  rt.sessionManager.appendMessage = (message) => {
    if (message.role === "assistant") throw Error("session disk failed");
    return original(message);
  };
  await assert.rejects(rt.prompt("question"), /session disk failed/);
  assert.equal(f.calls.length, 1);
  assert.equal(task.requests()[0].text, "saved HTTP response");
});
test("explicit finite timeout still cancels a delayed request without retry", async (t) => {
  const { f, rt } = await stage(
    t,
    async () => {
      await new Promise((r) => setTimeout(r, 80));
      return { text: "late" };
    },
    { timeout: 10 },
  );
  await assert.rejects(rt.prompt("q"));
  assert.ok(f.calls.length <= 1);
});
test("required Anthropic output cap is explicit on the wire and the same Pi host counts usage", async (t) => {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const f = await fixture(t, (call, n, req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg",
          type: "message",
          role: "assistant",
          content: [],
          model: "main",
          stop_reason: null,
          usage: { input_tokens: 7, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "anthropic answer" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 3 },
      },
      { type: "message_stop" },
    ];
    for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.end();
    return null;
  });
  const path = join(f.home, "pi", "models.json");
  const catalog = JSON.parse(readFileSync(path, "utf8"));
  catalog.providers.fixture.api = "anthropic-messages";
  writeFileSync(path, JSON.stringify(catalog));
  const ref = { ...f.models.main, maxOutputTokens: 100 };
  const task = tasks.createTask({
    home: f.home,
    input: "q",
    models: { main: ref, secondary: [] },
    singleModel: true,
  });
  const rt = await runtime.createRuntime({ home: f.home, cwd: f.cwd, modelRef: ref });
  t.after(() => rt.dispose());
  rt.bindTask(task, task.beginPhase("draft", "main", ref));
  await rt.prompt("q");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.max_tokens, 100);
  assert.equal(task.requests()[0].limits.maxOutputTokens, 100);
  assert.equal(task.usage().known.input, 7);
  assert.equal(task.usage().known.output, 3);
});
test("cancel still aborts provider when saving cancellation fails, with an explicit recovery copy", async (t) => {
  let fail = false,
    entered;
  const started = new Promise((r) => (entered = r));
  const { f, task, rt } = await stage(
    t,
    () => {
      entered();
      return null;
    },
    {
      persist() {
        if (fail) throw Error("cancel disk full");
      },
    },
  );
  const p = rt.prompt("q").catch((e) => e);
  await started;
  fail = true;
  await task.cancel();
  assert.ok(task.signal.aborted);
  await p;
  assert.equal(f.calls.length, 1);
  assert.ok(task.recovery);
  assert.match(task.record.error, /保存失败|disk full/);
});
test("completeSimple through a virtual route records the physical request only once", async (t) => {
  const f = await fixture(t);
  const rt = await runtime.createRuntime({ home: f.home, cwd: f.cwd, modelRef: f.models.main });
  t.after(() => rt.dispose());
  const model = rt.modelRuntime.getModel("fixture", "main");
  rt.modelRuntime.registerVirtualModel({
    provider: "fixture",
    id: "virtual-main",
    name: "virtual",
    route: () => ({ model, thinkingLevel: "off" }),
  });
  const ref = { provider: "fixture", modelId: "virtual-main" };
  const task = tasks.createTask({
    home: f.home,
    input: "q",
    models: { main: ref, secondary: [] },
    singleModel: true,
  });
  rt.bindTask(task, task.beginPhase("draft", "main", ref));
  const reply = await rt.modelRuntime.completeSimple(
    rt.modelRuntime.getModel("fixture", "virtual-main"),
    {
      messages: [{ role: "user", content: "q", timestamp: Date.now() }],
    },
  );
  assert.equal(reply.stopReason, "stop");
  assert.equal(f.calls.length, 1);
  assert.equal(task.requests().length, 1);
  assert.equal(task.usage().calls, 1);
  assert.equal(task.requests()[0].requestedModel.modelId, "virtual-main");
  assert.equal(task.requests()[0].actualModel.modelId, "main");
});
test("explicit per-model output cap remains on an optional-cap protocol wire", async (t) => {
  const f = await fixture(t);
  const ref = { ...f.models.main, maxOutputTokens: 77 };
  const task = tasks.createTask({
    home: f.home,
    input: "q",
    models: { main: ref, secondary: [] },
    singleModel: true,
  });
  const rt = await runtime.createRuntime({ home: f.home, cwd: f.cwd, modelRef: ref });
  t.after(() => rt.dispose());
  rt.bindTask(task, task.beginPhase("draft", "main", ref));
  await rt.prompt("q");
  assert.equal(f.calls[0].body.max_completion_tokens ?? f.calls[0].body.max_tokens, 77);
  assert.equal(task.requests()[0].limits.maxOutputTokens, 77);
  assert.equal(f.calls.length, 1);
});
