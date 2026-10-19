import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/pi-fixture.js";
const api = await import("../src/discussion.js");
for (const [reviewers, want, singleModel] of [
  [0, 1, true],
  [1, 3, false],
  [3, 3, false],
])
  test(`unified real Pi path completes ${want} calls with ${reviewers} configured reviewers`, async (t) => {
    assert.equal(typeof api.runTurn, "function");
    const f = await fixture(t, (call, n) => ({
      text:
        call.body.model === "main"
          ? n === 1
            ? "DRAFT"
            : "FINAL\n\n## 对评审意见的处理说明\nhandled"
          : "REVIEW " + call.body.model,
    }));
    const result = await api.runTurn({
      home: f.home,
      cwd: f.cwd,
      input: "question",
      singleModel,
      config: {
        formatVersion: 2,
        main: f.models.main,
        secondary: f.models.secondary.slice(0, reviewers),
      },
    });
    assert.equal(result.record.status, "completed");
    assert.equal(f.calls.length, want);
    assert.ok(f.calls.every((c) => c.body.model !== "r3"));
    if (reviewers) {
      const reviews = f.calls.filter((c) => c.body.model !== "main");
      for (const r of reviews) {
        const body = JSON.stringify(r.body.messages);
        assert.match(body, /DRAFT/);
        assert.doesNotMatch(body, /REVIEW r[12]/);
      }
      const revision = f.calls.at(-1).body.messages;
      assert.ok(revision.some((m) => JSON.stringify(m).includes("REVIEW r1")));
      assert.equal(revision.filter((m) => m.role === "user" && m.content === "question").length, 0);
    }
  });
test("missing reviewers refuse default input before any request", async (t) => {
  assert.equal(typeof api.runTurn, "function");
  const f = await fixture(t);
  await assert.rejects(
    api.runTurn({
      home: f.home,
      cwd: f.cwd,
      input: "q",
      config: { formatVersion: 2, main: f.models.main, secondary: [] },
    }),
    /one|副模型/,
  );
  assert.equal(f.calls.length, 0);
});
test("review failure preserves draft and never selects a replacement reviewer or revises", async (t) => {
  assert.equal(typeof api.runTurn, "function");
  const f = await fixture(t, (c) =>
    c.body.model === "r1" ? { error: 400 } : { text: c.body.model },
  );
  const result = await api.runTurn({
    home: f.home,
    cwd: f.cwd,
    input: "q",
    config: { formatVersion: 2, ...f.models },
  });
  assert.notEqual(result.record.status, "completed");
  assert.equal(f.calls.length, 2);
  assert.ok(result.requests().some((r) => r.text === "main"));
});
test("global cancellation aborts the active reviewer and starts no revision", async (t) => {
  let ready;
  const entered = new Promise((r) => (ready = r));
  let reviewers = 0;
  const f = await fixture(t, (c) => {
    if (c.body.model !== "main") {
      if (++reviewers === 1) ready();
      return null;
    }
    return { text: "DRAFT" };
  });
  const controller = new AbortController();
  const running = api.runTurn({
    home: f.home,
    cwd: f.cwd,
    input: "q",
    config: { formatVersion: 2, ...f.models },
    signal: controller.signal,
  });
  await entered;
  controller.abort();
  const task = await running;
  assert.equal(task.record.status, "cancelled");
  assert.equal(f.calls.length, 2);
  assert.equal(task.record.finalCallId, null);
  assert.equal(task.record.stages.filter((s) => s.phase === "review").length, 1);
});
test("changing native selected model during review cannot change frozen revision author", async (t) => {
  const { createRuntime } = await import("../src/pi-runtime.js");
  let rt;
  const f = await fixture(t, async (c) => {
    if (c.body.model === "r1") await rt.session.setModel(rt.modelRuntime.getModel("fixture", "r3"));
    return { text: "answer" };
  });
  rt = await createRuntime({ home: f.home, cwd: f.cwd, modelRef: f.models.main });
  t.after(() => rt.dispose());
  const result = await api.runTurn({
    home: f.home,
    cwd: f.cwd,
    input: "q",
    config: { formatVersion: 2, ...f.models },
    mainRuntime: rt,
  });
  assert.equal(result.record.status, "completed");
  assert.equal(f.calls.at(-1).body.model, "main");
});
test("the next turn sees an explicit partial-task state instead of treating the old draft as final", async (t) => {
  const { createRuntime } = await import("../src/pi-runtime.js");
  const f = await fixture(t, (c) =>
    c.body.model === "r1" ? { error: 400 } : { text: "saved reply" },
  );
  const rt = await createRuntime({ home: f.home, cwd: f.cwd, modelRef: f.models.main });
  t.after(() => rt.dispose());
  const config = { formatVersion: 2, ...f.models };
  const first = await api.runTurn({
    home: f.home,
    cwd: f.cwd,
    input: "first",
    config,
    mainRuntime: rt,
  });
  assert.equal(first.record.status, "partial");
  const second = await api.runTurn({
    home: f.home,
    cwd: f.cwd,
    input: "follow-up",
    singleModel: true,
    config,
    mainRuntime: rt,
  });
  assert.equal(second.record.status, "completed");
  assert.equal(f.calls.length, 3);
  assert.match(JSON.stringify(f.calls.at(-1).body.messages), /status=partial/);
});
test("latest user rule uses only the first reviewer and exactly three requests even with later configured models", async (t) => {
  const f = await fixture(t, (c) => ({ text: c.body.model === "main" ? "answer" : "review" }));
  const task = await api.runTurn({
    home: f.home,
    cwd: f.cwd,
    input: "q",
    config: { formatVersion: 2, ...f.models },
  });
  assert.equal(task.record.status, "completed");
  assert.equal(task.record.maxCalls, 3);
  assert.deepEqual(
    f.calls.map((c) => c.body.model),
    ["main", "r1", "main"],
  );
});
test("unavailable unused later reviewer does not block the selected first reviewer", async (t) => {
  const f = await fixture(t);
  const task = await api.runTurn({
    home: f.home,
    cwd: f.cwd,
    input: "q",
    config: {
      formatVersion: 2,
      main: f.models.main,
      secondary: [f.models.secondary[0], { provider: "fixture", modelId: "unused-missing" }],
    },
  });
  assert.equal(task.record.status, "completed");
  assert.equal(f.calls.length, 3);
});

for (const [prefix, count] of [["", 3], ["/one ", 1]])
  test(`natural answer preload reaches main without adding requests (${count})`, async (t) => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const f = await fixture(t, (c, n) => ({ text: n === 1 ? "DRAFT" : c.body.model === "r1" ? "REVIEW" : "FINAL" }));
    const dir = join(f.cwd, "answer-test"); mkdirSync(dir);
    writeFileSync(join(dir, "SKILL.md"), "---\nname: answer-test\ndescription: Test learning\n---\nSKILL_BODY_V1");
    const task = await api.runTurn({ home: f.home, cwd: f.cwd,
      input: prefix + "请从直觉解释这个概念", config: { formatVersion: 2, ...f.models, piResources: { skills: [dir] } } });
    assert.equal(task.record.status, "completed", task.record.error);
    assert.equal(task.record.mode, "answer");
    assert.equal(task.record.input, "请从直觉解释这个概念");
    assert.equal(f.calls.length, count);
    assert.match(JSON.stringify(f.calls[0].body.messages), /SKILL_BODY_V1/);
    assert.deepEqual(f.calls[0].body.tools.map((x) => x.function.name), ["start_work"]);
    assert.equal(task.record.answerSkills[0].name, "answer-test");
    assert.ok(!Object.hasOwn(task.record.answerSkills[0], "body"));
    assert.deepEqual(task.answerSkills, []);
  });
test("preload read errors and snapshot persistence errors stop before generation", async (t) => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const f = await fixture(t), config = { formatVersion: 2, ...f.models, piResources: { skills: [join(f.cwd, "missing")] } };
  await assert.rejects(api.runTurn({ home: f.home, cwd: f.cwd, input: "q", config }), /missing/);
  const dir = join(f.cwd, "answer-test"); mkdirSync(dir);
  writeFileSync(join(dir, "SKILL.md"), "---\nname: answer-test\ndescription: Test\n---\nSKILL_BODY_V1");
  config.piResources.skills = [dir];
  const task = await api.runTurn({ home: f.home, cwd: f.cwd, input: "q", config,
    persist: (record) => { if (record.answerSkills?.length) throw Error("snapshot persistence failed"); } });
  assert.notEqual(task.record.status, "completed");
  assert.match(task.record.error, /保存失败/);
  assert.equal(f.calls.length, 0);
});

test("draft, independent review and revision receive one frozen skill version", async (t) => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  let file;
  const bytes = (v) => `---\nname: answer-test\ndescription: Test\n---\nSKILL_BODY_${v}`;
  const f = await fixture(t, (c, n) => {
    if (n === 1) writeFileSync(file, bytes("V2"));
    return { text: n === 1 ? "DRAFT" : n === 2 ? "REVIEW" : "FINAL" };
  });
  const dir = join(f.cwd, "answer-test"); mkdirSync(dir); file = join(dir, "SKILL.md"); writeFileSync(file, bytes("V1"));
  const task = await api.runTurn({ home: f.home, cwd: f.cwd, input: "请从直觉解释这个概念",
    config: { formatVersion: 2, ...f.models, piResources: { skills: [dir] } } });
  assert.equal(task.record.status, "completed", task.record.error);
  assert.equal(f.calls.length, 3);
  for (const call of f.calls) {
    const sent = JSON.stringify(call.body.messages);
    assert.match(sent, /SKILL_BODY_V1/);
    assert.doesNotMatch(sent, /SKILL_BODY_V2/);
  }
  assert.ok(task.record.answerSkills.every((s) => !Object.hasOwn(s, "body")));
  const { taskJson } = await import("../src/presentation.js");
  assert.match(JSON.stringify(taskJson(f.home, task.record)), /SKILL_BODY_V1/);
});
