import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/pi-fixture.js";
const api = await import("../src/pi-runtime.js").catch(() => ({}));
test("required extension load failure rejects host creation with zero requests", async (t) => {
  assert.equal(typeof api.createRuntime, "function", "Pi host is implemented");
  const f = await fixture(t);
  await assert.rejects(
    api.createRuntime({
      home: f.home,
      cwd: f.cwd,
      modelRef: f.models.main,
      extensionFactories: [
        () => {
          throw Error("broken extension");
        },
      ],
    }),
    /broken extension/,
  );
  assert.equal(f.calls.length, 0);
});
test("extension runtime failure is visible and blocks the provider send", async (t) => {
  const { createTask } = await import("../src/task.js");
  const f = await fixture(t);
  const rt = await api.createRuntime({
    home: f.home,
    cwd: f.cwd,
    modelRef: f.models.main,
    extensionFactories: [
      (pi) =>
        pi.on("before_provider_request", () => {
          throw Error("hook failed");
        }),
    ],
  });
  t.after(() => rt.dispose());
  const task = createTask({ home: f.home, input: "q", models: f.models });
  rt.bindTask(task, task.beginPhase("draft", "main", f.models.main));
  await assert.rejects(rt.prompt("q"), /hook failed/);
  assert.equal(f.calls.length, 0);
});

test("model catalog stays offline for native startup, reload and provider refresh", async (t) => {
  const f = await fixture(t);
  const originalFetch = globalThis.fetch;
  const offline = process.env.PI_OFFLINE;
  const calls = [];
  delete process.env.PI_OFFLINE;
  globalThis.fetch = async (input) => {
    calls.push(String(input?.url ?? input));
    return new Response("", { status: 404 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = offline;
  });
  const runtime = await api.createModelRuntime(f.home);
  await runtime.refresh();
  await runtime.refresh({ allowNetwork: true, providers: ["openrouter"] });
  assert.deepEqual(calls, [], "catalog refresh must use only the pinned local data");
});

test('model switching defaults to high, preserves explicit levels and rejects unsupported high',async t=>{
  const {readFileSync,writeFileSync}=await import('node:fs');const {join}=await import('node:path');
  const f=await fixture(t);const path=join(f.home,'pi/models.json'),data=JSON.parse(readFileSync(path));
  for(const m of data.providers.fixture.models.slice(0,3)){m.reasoning=true;m.compat={supportsReasoningEffort:true,thinkingFormat:'openai'};}
  data.providers.fixture.models[2].thinkingLevelMap={off:null,minimal:null,low:'low',medium:null,high:null,xhigh:null,max:null};
  writeFileSync(path,JSON.stringify(data));
  const rt=await api.createRuntime({home:f.home,cwd:f.cwd,modelRef:{...f.models.main,thinkingLevel:'low'}});t.after(()=>rt.dispose());
  assert.equal(rt.session.thinkingLevel,'low');
  await rt.selectModel(f.models.secondary[0]);assert.equal(rt.session.thinkingLevel,'high');
  await rt.selectModel({...f.models.secondary[0],thinkingLevel:'low'});assert.equal(rt.session.thinkingLevel,'low');
  await rt.selectModel(f.models.secondary[2]);assert.equal(rt.session.thinkingLevel,'off');
  await assert.rejects(rt.selectModel(f.models.secondary[1]),/不支持.*high/);
  assert.equal(f.calls.length,0);
});
