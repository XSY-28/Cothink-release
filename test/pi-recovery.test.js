import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/pi-fixture.js";
import { createRuntime } from "../src/pi-runtime.js";
import { runTurn } from "../src/discussion.js";
import { cothinkExtension } from "../src/extensions/cothink.js";
import { AgentSessionRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { readTask } from "../src/task.js";
test("Pi new/resume/fork rebind persistent sessions with zero automatic generation", async (t) => {
  const f = await fixture(t);
  const all = [];
  const factory = async (options) => {
    const rt = await createRuntime({
      home: f.home,
      cwd: f.cwd,
      modelRef: f.models.main,
      sessionManager: options?.sessionManager,
      extensionFactories: [{ name: "cothink", factory: cothinkExtension({}) }],
    });
    all.push(rt);
    return { session: rt.session, services: rt.services, diagnostics: [] };
  };
  const first = await factory();
  const runtime = all[0];
  const completed = await runTurn({
    home: f.home,
    cwd: f.cwd,
    input: "first",
    singleModel: true,
    config: { formatVersion: 2, ...f.models },
    mainRuntime: runtime,
  });
  assert.equal(completed.record.status, "completed");
  const file = runtime.sessionManager.getSessionFile(),
    leaf = runtime.sessionManager.getLeafId();
  const host = new AgentSessionRuntime(first.session, first.services, factory);
  let rebound = 0;
  host.setRebindSession(async () => {
    rebound++;
  });
  t.after(async () => {
    await host.dispose();
    for (const rt of all) rt.dispose();
  });
  await host.newSession();
  assert.notEqual(host.session.sessionManager.getSessionId(), completed.record.sessionId);
  await host.switchSession(file);
  assert.equal(host.session.sessionManager.getLeafId(), leaf);
  await host.fork(leaf, { position: "at" });
  assert.notEqual(host.session.sessionManager.getSessionId(), completed.record.sessionId);
  assert.equal(f.calls.length, 1);
  assert.equal(rebound, 3);
  await host.session.navigateTree(
    host.session.sessionManager.getBranch().find((e) => e.type === "message" && e.message.role === "user").id,
    { summarize: false },
  );
  assert.equal(f.calls.length, 1);
  assert.equal(readTask(f.home, completed.record.id).status, "completed");
});
test("two runtime writers cannot open the same active Pi session", async (t) => {
  const f = await fixture(t);
  const rt = await createRuntime({ home: f.home, cwd: f.cwd, modelRef: f.models.main });
  t.after(() => rt.dispose());
  const task = await runTurn({
    home: f.home,
    cwd: f.cwd,
    input: "q",
    singleModel: true,
    config: { formatVersion: 2, ...f.models },
    mainRuntime: rt,
  });
  assert.equal(task.record.status, "completed");
  await assert.rejects(
    createRuntime({
      home: f.home,
      cwd: f.cwd,
      modelRef: f.models.main,
      sessionManager: SessionManager.open(rt.sessionManager.getSessionFile()),
    }),
    /使用|写入|进程/,
  );
  assert.equal(f.calls.length, 1);
});
test("reload keeps the managed request policy and extension failure propagation", async (t) => {
  let broken = false;
  const f = await fixture(t);
  const rt = await createRuntime({
    home: f.home,
    cwd: f.cwd,
    modelRef: f.models.main,
    extensionFactories: [
      (pi) =>
        pi.on("before_provider_request", () => {
          if (broken) throw Error("reload hook failed");
        }),
    ],
  });
  t.after(() => rt.dispose());
  await rt.session.reload();
  broken = true;
  const { createTask } = await import("../src/task.js");
  const task = createTask({ home: f.home, input: "q", models: f.models });
  rt.bindTask(task, task.beginPhase("draft", "main", f.models.main));
  await assert.rejects(rt.prompt("q"), /reload hook failed/);
  assert.equal(f.calls.length, 0);
});

test("preload refreshes per turn and follows new/resume/fork/reload without prompt accumulation", async (t) => {
  const { mkdirSync, writeFileSync, unlinkSync } = await import("node:fs");
  const { join } = await import("node:path");
  const f = await fixture(t, (c, n) => ({ text: c.body.model === "r1" ? "REVIEW" : "ANSWER" }));
  const dir = join(f.cwd, "answer-test"); mkdirSync(dir); const file = join(dir, "SKILL.md");
  const update = (v) => writeFileSync(file, `---\nname: answer-test\ndescription: Test\n---\nSKILL_BODY_${v}`);
  update("V1");
  const config = { formatVersion: 2, ...f.models, piResources: { skills: [dir] } }, all = [];
  const factory = async (options) => {
    const context = {};
    const rt = await createRuntime({ home: f.home, cwd: f.cwd, modelRef: f.models.main,
      sessionManager: options?.sessionManager,
      extensionFactories: [{ name: "cothink", factory: cothinkExtension(context) }],
      resourceOptions: { additionalSkillPaths: [dir] } });
    rt.hostContext = (task) => { context.task = task; context.runtime = rt; };
    all.push(rt);
    return { session: rt.session, services: rt.services, diagnostics: [] };
  };
  const initial = await factory(); let rt = all.at(-1);
  const turn = (input, singleModel = false) => runTurn({ home: f.home, cwd: f.cwd, input, config, mainRuntime: rt, singleModel });
  const first = await turn("first"); assert.equal(first.record.status, "completed", first.record.error);
  const oldRequest = JSON.stringify(first.requests()), fileName = rt.sessionManager.getSessionFile(), leaf = rt.sessionManager.getLeafId();
  update("V2"); const second = await turn("second"); assert.equal(second.record.status, "completed", second.record.error);
  assert.equal(f.calls.length, 6);
  for (const c of f.calls.slice(3, 4)) {
    const system = c.body.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    assert.equal(system.match(/SKILL_BODY_V2/g)?.length, 1);
    assert.doesNotMatch(system, /SKILL_BODY_V1/);
  }
  assert.equal(JSON.stringify(first.requests()), oldRequest);
  assert.notEqual(first.record.answerSkills[0].hash, second.record.answerSkills[0].hash);
  assert.deepEqual(first.answerSkills, []); assert.deepEqual(second.answerSkills, []);
  const host = new AgentSessionRuntime(initial.session, initial.services, factory);
  host.setRebindSession(async () => { rt = all.at(-1); });
  t.after(async () => { await host.dispose(); for (const r of all) r.dispose(); });
  for (const operation of [() => host.newSession(), () => host.switchSession(fileName), () => host.fork(leaf, { position: "at" }), () => host.session.reload()]) {
    const before = f.calls.length;
    await operation(); assert.equal(f.calls.length, before);
    const next = await turn("after native operation", true);
    assert.equal(next.record.status, "completed", next.record.error);
    assert.equal(f.calls.length, before + 1);
    assert.match(JSON.stringify(f.calls.at(-1).body.messages[0]), /SKILL_BODY_V2/);
  }
  unlinkSync(file);
  assert.match(JSON.stringify(readTask(f.home, first.record.id)), /answer-test/);
  assert.equal(JSON.stringify(first.requests()), oldRequest);
});

test("cancelling a preloaded review clears bindings and leaves no stale next-turn material", async (t) => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  let entered; const ready = new Promise((r) => { entered = r; });
  const f = await fixture(t, (c) => { if (c.body.model === "r1") { entered(); return null; } return { text: "DRAFT" }; });
  const dir = join(f.cwd, "answer-test"); mkdirSync(dir);
  writeFileSync(join(dir, "SKILL.md"), "---\nname: answer-test\ndescription: Test\n---\nCANCEL_SKILL_BODY");
  const context = {}, rt = await createRuntime({ home: f.home, cwd: f.cwd, modelRef: f.models.main,
    extensionFactories: [{ name: "cothink", factory: cothinkExtension(context) }] });
  rt.hostContext = (task) => { context.task = task; context.runtime = rt; };
  t.after(() => rt.dispose());
  const controller = new AbortController();
  const pending = runTurn({ home: f.home, cwd: f.cwd, input: "q", config: { formatVersion: 2, ...f.models, piResources: { skills: [dir] } },
    mainRuntime: rt, signal: controller.signal });
  await ready; controller.abort(); const task = await pending;
  assert.equal(task.record.status, "cancelled"); assert.equal(f.calls.length, 2);
  assert.deepEqual(task.answerSkills, []); assert.equal(context.task, undefined);
  assert.equal(task.record.answerSkills[0].name, "answer-test");
  const next = await runTurn({ home: f.home, cwd: f.cwd, input: "/one next", config: { formatVersion: 2, ...f.models }, mainRuntime: rt });
  assert.equal(next.record.status, "completed", next.record.error);
  assert.equal(f.calls.length, 3);
  assert.doesNotMatch(JSON.stringify(f.calls[2].body.messages[0]), /CANCEL_SKILL_BODY/);
});
