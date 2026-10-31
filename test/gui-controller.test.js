import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join,resolve } from "node:path";
import {pathToFileURL,fileURLToPath} from "node:url";
const productRoot=resolve(process.env.COTHINK_TEST_PACKAGE_ROOT??fileURLToPath(new URL("..",import.meta.url)));
const load=path=>import(pathToFileURL(join(productRoot,path)));
const sdkUrl=pathToFileURL(join(productRoot,"node_modules/@earendil-works/pi-coding-agent/dist/index.js"));
const {SessionManager}=await import(sdkUrl);
import { fixture } from "./helpers/pi-fixture.js";
import { repository } from "./helpers/git-fixture.js";
const {saveConfig}=await load("src/config.js");
const {createTeamConfig}=await load("src/teams.js");
const {readTask}=await load("src/task.js");
const teamId = "7c8094cd-3476-4bfa-8f53-055d87972896";
const controllerModule = await load("src/gui-controller.js").catch(
  () => ({}),
);
async function controller(t, f) {
  assert.equal(
    typeof controllerModule.createGuiController,
    "function",
    "GUI controller must exist",
  );
  saveConfig(
    f.home,
    createTeamConfig({ formatVersion: 2, ...f.models }, "Fixture", teamId),
  );
  const c = await controllerModule.createGuiController({
    home: f.home,
    cwd: f.cwd,
  });
  t.after(() => c.close());
  return c;
}
async function finished(c, id) {
  for (let n = 0; n < 500; n++) {
    const task = await c.task(id);
    if (task.status !== "running") return task;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("fixture task did not settle");
}

test("discussion uses three original calls, deduplicates durable submissions and keeps continuous context", async (t) => {
  const f = await fixture(t, (_, n) => ({ text: `original reply ${n}` })),
    c = await controller(t, f);
  const s = await c.action("session.create", { project: null });
  const first = await c.action("task.submit", {
    sessionId: s.id,
    input: "first question",
    submissionId: "first",
  });
  const duplicate = await c.action("task.submit", {
    sessionId: s.id,
    input: "first question",
    submissionId: "first",
  });
  assert.equal(duplicate.taskId, first.taskId);
  const task = await finished(c, first.taskId);
  assert.equal(task.status, "completed", task.error);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(
    task.messages.map((m) => m.text),
    ["original reply 1", "original reply 2", "original reply 3"],
  );
  assert.equal(task.participants.filter((p) => p.participated).length, 2);
  const second = await c.action("task.submit", {
    sessionId: s.id,
    input: "second question",
    submissionId: "second",
  });
  await finished(c, second.taskId);
  assert.equal(f.calls.length, 6);
  assert.match(JSON.stringify(f.calls[3].body.messages), /first question/);
  await c.close();
  const restored = await controllerModule.createGuiController({
    home: f.home,
    cwd: f.cwd,
  });
  t.after(() => restored.close());
  assert.equal(
    (
      await restored.action("task.submit", {
        sessionId: s.id,
        input: "first question",
        submissionId: "first",
      })
    ).taskId,
    first.taskId,
  );
  assert.equal(f.calls.length, 6);
  assert.equal((await restored.session(s.id)).turns.length, 2);
  assert.equal((await restored.session(s.id)).turns[0].submissionId, "first");
});
test("unbound project neither loads startup AGENTS nor exposes work tools; ONE is durable", async (t) => {
  const f = await fixture(t),
    c = await controller(t, f);
  writeFileSync(join(f.cwd, "AGENTS.md"), "STARTUP_PRIVATE_CANARY");
  const s = await c.action("session.create", { project: null });
  await c.action("session.mode", { sessionId: s.id, mode: "one" });
  const r = await c.action("task.submit", {
    sessionId: s.id,
    input: "plain chat",
    submissionId: "plain",
  });
  await finished(c, r.taskId);
  assert.equal(f.calls.length, 1);
  const catalog = await c.bootstrap();
  assert.ok(catalog.models.every((m) => Array.isArray(m.thinkingLevels)));
  assert.doesNotMatch(
    JSON.stringify(f.calls),
    /STARTUP_PRIVATE_CANARY|"name":"start_work"/,
  );
  assert.equal((await c.session(s.id)).mode, "one");
  assert.equal((await c.session(s.id)).project, null);
});
test("one global active task rejects concurrent submission, reads live status and cancels on host close", async (t) => {
  const f = await fixture(t, async () => {
      await new Promise((r) => setTimeout(r, 350));
      return { text: "slow" };
    }),
    c = await controller(t, f);
  const s = await c.action("session.create", { project: null });
  const r = await c.action("task.submit", {
    sessionId: s.id,
    input: "slow",
    submissionId: "slow",
  });
  assert.equal((await c.task(r.taskId)).status, "running");
  await assert.rejects(
    c.action("task.submit", {
      sessionId: s.id,
      input: "other",
      submissionId: "other",
    }),
    /任务|busy/i,
  );
  await c.action("session.mode", { sessionId: s.id, mode: "one" });
  assert.equal((await c.task(r.taskId)).singleModel, false);
  await c.close();
  assert.notEqual(readTask(f.home, r.taskId).status, "completed");
});
test("historical sessions without team need explicit binding, and read-only viewing takes no writer", async (t) => {
  const f = await fixture(t),
    c = await controller(t, f);
  const m = SessionManager.create(f.cwd, join(f.home, "pi/sessions/main"));
  m.appendMessage({ role: "user", content: "old", timestamp: Date.now() });
  const s = await c.session(m.getSessionId());
  assert.equal(s.team, null);
  await assert.rejects(
    c.action("task.submit", {
      sessionId: s.id,
      input: "continue",
      submissionId: "old",
    }),
    /team|Team/,
  );
  await c.action("session.team", { sessionId: s.id, teamId });
  const r = await c.action("task.submit", {
    sessionId: s.id,
    input: "/one continue",
    submissionId: "bound",
  });
  assert.equal((await finished(c, r.taskId)).status, "completed");
});
test("bound project invokes real runWork and fixed version diff, leaves original checkout unchanged", async (t) => {
  const repo = repository(t);
  const f = await fixture(t, (_, n) =>
      n === 1
        ? { toolCalls: [{ name: "start_work", args: { reason: "observe" } }] }
        : { text: "observed" },
    ),
    c = await controller(t, f);
  await c.action("settings.work", { work: { checks: [] } });
  const p = await c.action("project.inspect", { path: repo.project });
  assert.equal(p.valid, true);
  const s = await c.action("session.create", { project: repo.project });
  await c.action("session.mode", { sessionId: s.id, mode: "one" });
  const r = await c.action("task.submit", {
      sessionId: s.id,
      input: "observe project",
      submissionId: "project",
    }),
    task = await finished(c, r.taskId);
  assert.equal(task.status, "completed", task.error);
  assert.equal(f.calls.length, 2);
  assert.ok(task.work.startVersion);
  assert.equal((await c.diff(r.taskId)).fromVersion, task.work.startVersion);
  assert.equal(await c.patch(r.taskId), (await c.diff(r.taskId)).text);
  await assert.rejects(
    c.output(r.taskId, "unrelated", 0, 10),
    /任务|归属|output/,
  );
});
test("settings initialize custom API key and named team without model requests or credential return", async (t) => {
  const f = await fixture(t);
  assert.equal(typeof controllerModule.createGuiController, "function");
  const c = await controllerModule.createGuiController({
    home: f.home,
    cwd: f.cwd,
  });
  t.after(() => c.close());
  assert.equal((await c.bootstrap()).configured, false);
  await c.action("provider.save", {
    providerId: "localcustom",
    apiKey: "never-return-this-key",
    custom: {
      baseUrl: f.endpoint,
      api: "openai-completions",
      modelId: "newmodel",
      name: "New",
      contextWindow: 32000,
      maxTokens: 4096,
    },
  });
  await c.action("team.save", {
    name: "New team",
    main: { provider: "localcustom", modelId: "newmodel" },
    secondary: [f.models.main],
  });
  const b = await c.bootstrap();
  assert.equal(b.configured, true);
  assert.doesNotMatch(
    JSON.stringify(b),
    /never-return-this-key|fixture-secret/,
  );
  await assert.rejects(
    c.action("provider.save", {
      providerId: "localcustom",
      apiKey: "replacement",
      custom: {
        baseUrl: f.endpoint,
        api: "openai-completions",
        modelId: "oops",
      },
    }),
    /存在/,
  );
  assert.equal(f.calls.length, 0);
});

test("read-only historical browsing creates no lock files or runtime", async (t) => {
  const { existsSync } = await import("node:fs");
  const f = await fixture(t),
    c = await controller(t, f);
  const manager = SessionManager.create(
    f.cwd,
    join(f.home, "pi/sessions/main"),
  );
  manager.appendMessage({
    role: "user",
    content: "history",
    timestamp: Date.now(),
  });
  const lock = join(f.home, "pi/sessions", manager.getSessionId() + ".locks");
  assert.equal(existsSync(lock), false);
  await c.session(manager.getSessionId());
  assert.equal(
    existsSync(lock),
    false,
    "history reading must not acquire a writer",
  );
  assert.equal(f.calls.length, 0);
});

test("failed mode persistence retains prior mode and blocks generation until reopened", async (t) => {
  const { renameSync, rmSync } = await import("node:fs");
  const f = await fixture(t),
    c = await controller(t, f);
  const s = await c.action("session.create", { project: null });
  await c.action("session.mode", { sessionId: s.id, mode: "one" });
  const r = await c.action("task.submit", {
    sessionId: s.id,
    input: "initial",
    submissionId: "initial",
  });
  await finished(c, r.taskId);
  const record = readTask(f.home, r.taskId),
    path = record.stages[0].sessionFile;
  renameSync(path, path + ".backup");
  mkdirSync(path);
  try {
    await assert.rejects(
      c.action("session.mode", { sessionId: s.id, mode: "cothink" }),
      /保存失败|不可用/,
    );
    assert.equal((await c.session(s.id)).mode, "one");
    await assert.rejects(
      c.action("task.submit", {
        sessionId: s.id,
        input: "must not send",
        submissionId: "blocked",
      }),
      /保存失败|不可用/,
    );
    assert.equal(f.calls.length, 1);
  } finally {
    rmSync(path, { recursive: true, force: true });
    renameSync(path + ".backup", path);
  }
});

test("project work reads edits checks accepts and returns task-bound logs and immutable diff", async (t) => {
  const { execution } = await import("./helpers/agent-sync-fixture.js");
  const { git } = await import("./helpers/git-fixture.js");
  const repo = repository(t);
  const original = git(repo.project, "status", "--porcelain=v1");
  const f = await fixture(t, (_call, n) => {
    const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
    if (n === 1)
      return tool("start_work", {
        reason: "change a source file",
        scope: ["a.txt"],
        readScope: ["a.txt"],
      });
    if (n === 2) return tool("read", { path: "a.txt" });
    if (n === 3)
      return tool("write", { path: "a.txt", content: "GUI accepted output\n" });
    if (n === 4 || n === 5) return tool("accept_change");
    return { text: "Delivered original reply" };
  });
  const c = await controller(t, f);
  await c.action("settings.work", {
    work: {
      execution,
      checks: [
        {
          command: "node",
          args: [
            "-e",
            "if(require('fs').readFileSync('a.txt','utf8')!=='GUI accepted output\\n')process.exit(1);console.log('GUI check log')",
          ],
        },
      ],
    },
  });
  const s = await c.action("session.create", { project: repo.project });
  await c.action("session.mode", { sessionId: s.id, mode: "one" });
  const r = await c.action("task.submit", {
      sessionId: s.id,
      input: "change source",
      submissionId: "edit",
    }),
    task = await finished(c, r.taskId);
  assert.equal(task.status, "completed", task.error);
  assert.equal(task.work.finalCheck.verification, "passed");
  const d = await c.diff(r.taskId);
  assert.match(d.text, /GUI accepted output/);
  const ref = task.work.finalCheck.checks[0].outputRef;
  const page = await c.output(r.taskId, ref, 0, 3),
    rest = await c.output(r.taskId, ref, page.nextOffset, 65536);
  assert.match(page.text + rest.text, /GUI check log/);
  assert.equal(
    readFileSync(join(task.work.resultWorkspace, "a.txt"), "utf8"),
    "GUI accepted output\n",
  );
  assert.equal(git(repo.project, "status", "--porcelain=v1"), original);
  await c.close();
  assert.deepEqual(await c.diff(r.taskId), d);
});

test("delegated work exposes actual member calls and only evidence-linked handoffs", async (t) => {
  const repo = repository(t);
  let leader = 0;
  const f = await fixture(t, (call) => {
    const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
    if (call.body.model === "r1")
      return { text: "Member inspected original text" };
    leader++;
    if (leader === 1)
      return tool("start_work", { reason: "independent inspection" });
    if (leader === 2)
      return tool("delegate", {
        model: "fixture/r1",
        assignment: "Inspect",
        implementationAdvice: "Read only",
        reason: "independent source inspection",
        scope: [],
        readScope: ["."],
        readOnly: true,
      });
    if (leader === 3) return tool("collect");
    return { text: "Leader deliverable" };
  });
  const c = await controller(t, f);
  await c.action("settings.work", { work: { checks: [] } });
  const s = await c.action("session.create", { project: repo.project });
  const r = await c.action("task.submit", {
      sessionId: s.id,
      input: "inspect with member",
      submissionId: "delegate",
    }),
    task = await finished(c, r.taskId);
  assert.equal(task.status, "completed", task.error);
  const member = task.participants.find((p) => p.role === "member");
  assert.equal(member.participated, true);
  assert.equal(member.model.modelId, "r1");
  // A worker is actual participation even though that model never reviewed.
  assert.equal(task.participants.find((p) => p.role === "reviewer-1").participated, false);
  assert.ok(
    task.messages.some(
      (m) =>
        m.text === "Member inspected original text" && m.model.modelId === "r1",
    ),
  );
  const handoffs = task.work.activities.filter((a) => a.type === "handoff");
  assert.ok(
    handoffs.some((a) => a.action === "delegate" && a.memberId === member.id),
  );
  assert.ok(
    handoffs.some(
      (a) =>
        a.action === "collect" &&
        a.memberId === member.id &&
        a.text.includes("Member inspected original text"),
    ),
  );
});

test("one corrupt task surfaces its error while healthy history and settings remain readable", async (t) => {
  const f = await fixture(t),
    c = await controller(t, f);
  const s = await c.action("session.create", { project: null });
  await c.action("session.mode", { sessionId: s.id, mode: "one" });
  const r = await c.action("task.submit", {
    sessionId: s.id,
    input: "healthy",
    submissionId: "healthy",
  });
  await finished(c, r.taskId);
  const bad = "ea869a12-0612-4bda-8bbe-b30404f74f53";
  writeFileSync(join(f.home, "tasks", bad + ".json"), "{invalid JSON");
  const boot = await c.bootstrap();
  assert.ok(boot.historyErrors.some((error) => error.taskId === bad));
  assert.equal((await c.session(s.id)).turns[0].taskId, r.taskId);
  assert.equal((await c.task(r.taskId)).status, "completed");
});

function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test("accepted submit freezes mode and thinking before immediately following changes, with a cached runtime", async (t) => {
  const f = await fixture(t);
  const catalogPath = join(f.home, "pi/models.json");
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  catalog.providers.fixture.models[0].reasoning = true;
  writeFileSync(catalogPath, JSON.stringify(catalog));
  const c = await controller(t, f),
    s = await c.action("session.create", { project: null });
  await c.action("session.thinking", { sessionId: s.id, level: "low" });
  const warm = await c.action("task.submit", {
    sessionId: s.id,
    input: "warm context",
    submissionId: "freeze-warm",
  });
  await finished(c, warm.taskId);
  const pending = c.action("task.submit", {
    sessionId: s.id,
    input: "accepted before edits",
    submissionId: "freeze-current",
  });
  const mode = c.action("session.mode", { sessionId: s.id, mode: "one" });
  const thinking = c.action("session.thinking", {
    sessionId: s.id,
    level: "high",
  });
  const current = await pending;
  await Promise.all([mode, thinking]);
  const task = await finished(c, current.taskId);
  assert.equal(
    task.singleModel,
    false,
    "accepted current task keeps its three-call mode",
  );
  assert.equal(task.team.main.thinkingLevel, "low");
  assert.equal(f.calls.length, 6);
  const next = await c.action("task.submit", {
    sessionId: s.id,
    input: "next snapshot",
    submissionId: "freeze-next",
  });
  const nextTask = await finished(c, next.taskId);
  assert.equal(nextTask.singleModel, true);
  assert.equal(nextTask.team.main.thinkingLevel, "high");
  assert.equal(f.calls.length, 7);
});

test("runtime initialization handoff allows concurrent metadata saves without losing writer ownership", async (t) => {
  const { ModelRuntime } = await import(sdkUrl);
  const f = await fixture(t),
    c = await controller(t, f),
    s = await c.action("session.create", { project: null });
  const entered = deferred(),
    release = deferred(),
    original = ModelRuntime.create;
  let first = true;
  t.mock.method(ModelRuntime, "create", async function (...args) {
    if (first) {
      first = false;
      entered.resolve();
      await release.promise;
    }
    return original.apply(this, args);
  });
  const pending = c.action("task.submit", {
    sessionId: s.id,
    input: "first initialization",
    submissionId: "handoff-current",
  });
  await entered.promise;
  const saves = Promise.allSettled([
    c.action("session.draft", {
      sessionId: s.id,
      text: "typed during initialization",
    }),
    c.action("session.mode", { sessionId: s.id, mode: "one" }),
    c.action("session.name", {
      sessionId: s.id,
      title: "Saved during opening",
    }),
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  release.resolve();
  const outcomes = await saves,
    current = await pending;
  for (const result of outcomes)
    assert.equal(result.status, "fulfilled", result.reason?.message);
  const task = await finished(c, current.taskId);
  assert.equal(task.singleModel, false);
  assert.equal(f.calls.length, 3);
  const restored = await c.session(s.id);
  assert.equal(restored.mode, "one");
  assert.equal(restored.draft, "typed during initialization");
  assert.equal(restored.title, "Saved during opening");
});

test("async Team switching reserves management until native model selection has completed", async (t) => {
  const { AgentSession } = await import(sdkUrl);
  const f = await fixture(t),
    c = await controller(t, f),
    s = await c.action("session.create", { project: null });
  const warm = await c.action("task.submit", {
    sessionId: s.id,
    input: "warm context",
    submissionId: "team-warm",
  });
  await finished(c, warm.taskId);
  const team = await c.action("team.save", {
    name: "Reversed",
    main: f.models.secondary[0],
    secondary: [f.models.main],
  });
  const entered = deferred(),
    release = deferred(),
    original = AgentSession.prototype.setModel;
  t.mock.method(
    AgentSession.prototype,
    "setModel",
    async function (model, ...args) {
      if (model.id === "r1") {
        entered.resolve();
        await release.promise;
      }
      return original.call(this, model, ...args);
    },
  );
  const selecting = c.action("session.team", {
    sessionId: s.id,
    teamId: team.id,
  });
  await entered.promise;
  try {
    await assert.rejects(
      c.action("task.submit", {
        sessionId: s.id,
        input: "must not race Team",
        submissionId: "team-overlap",
      }),
      /任务|设置/,
    );
    assert.equal(
      f.calls.length,
      3,
      "selection overlap must not begin generation",
    );
  } finally {
    release.resolve();
    await selecting;
  }
  assert.equal((await c.session(s.id)).team.id, team.id);
  const next = await c.action("task.submit", {
    sessionId: s.id,
    input: "/one after selection",
    submissionId: "team-next",
  });
  assert.equal((await finished(c, next.taskId)).team.id, team.id);
});

test("provider saves refresh idle cached catalog and auth while preserving context and managed requests", async (t) => {
  const f = await fixture(t),
    c = await controller(t, f),
    s = await c.action("session.create", { project: null });
  const warm = await c.action("task.submit", {
    sessionId: s.id,
    input: "previous context must survive",
    submissionId: "catalog-warm",
  });
  await finished(c, warm.taskId);
  await c.action("provider.save", {
    providerId: "added-later",
    apiKey: "first-local-key",
    custom: {
      baseUrl: f.endpoint,
      api: "openai-completions",
      modelId: "new-main",
    },
  });
  const team = await c.action("team.save", {
    name: "Added provider",
    main: { provider: "added-later", modelId: "new-main" },
    secondary: [f.models.main],
  });
  await c.action("session.team", { sessionId: s.id, teamId: team.id });
  await c.action("provider.save", {
    providerId: "added-later",
    apiKey: "replacement-local-key",
  });
  const next = await c.action("task.submit", {
      sessionId: s.id,
      input: "/one after adding provider",
      submissionId: "catalog-next",
    }),
    task = await finished(c, next.taskId);
  assert.equal(task.status, "completed", task.error);
  assert.equal(task.messages.length, 1);
  assert.equal(task.messages[0].model.provider, "added-later");
  assert.equal(task.usage.calls, 1);
  assert.match(
    JSON.stringify(f.calls[3].body.messages),
    /previous context must survive/,
  );
  assert.equal(
    f.calls[3].headers.authorization,
    "Bearer replacement-local-key",
  );
  assert.doesNotMatch(
    JSON.stringify(task),
    /replacement-local-key|first-local-key/,
  );
});

test('HTML action without associated project preserves draft and sends zero model requests',async t=>{
 const f=await fixture(t), c=await controller(t,f);
 const s=await c.action('session.create',{project:null});
 await c.action('session.draft',{sessionId:s.id,text:'make my HTML'});
 await assert.rejects(c.action('task.submit',{sessionId:s.id,input:'make my HTML',submissionId:'html-no-project',workRequest:{kind:'html-svg'}}),/项目/);
 assert.equal(f.calls.length,0);
 assert.equal((await c.session(s.id)).draft,'make my HTML');
});


test("English role prompts follow each frozen turn and stage across mode switches and one-shot overrides", async (t) => {
  let c, sessionId, switchDuringDraft = false;
  const f = await fixture(t, async () => {
    if (switchDuringDraft) {
      switchDuringDraft = false;
      await c.action("session.mode", { sessionId, mode: "one" });
    }
    return { text: "answer" };
  });
  c = await controller(t, f);
  sessionId = (await c.action("session.create", { project: null })).id;
  const submit = async (input, count, expected) => {
    const start = f.calls.length;
    const r = await c.action("task.submit", { sessionId, input, submissionId: String(start) });
    const task = await finished(c, r.taskId);
    assert.equal(task.status, "completed", task.error);
    const calls = f.calls.slice(start);
    assert.equal(calls.length, count);
    const system = call => call.body.messages.filter(m => m.role === "system").map(m => m.content).join("\n");
    assert.match(system(calls[0]), expected);
    if (count === 3) {
      assert.doesNotMatch(system(calls[0]), /ONE single-model mode|CoThink revision stage/);
      assert.match(system(calls[1]), /independent reviewer/);
      assert.doesNotMatch(system(calls[1]), /CoThink initial-answer stage|ONE single-model mode/);
      assert.match(system(calls[2]), /CoThink revision stage/);
      assert.doesNotMatch(system(calls[2]), /CoThink initial-answer stage|ONE single-model mode/);
    } else {
      assert.doesNotMatch(system(calls[0]), /CoThink initial-answer stage|CoThink revision stage/);
      assert.match(system(calls[0]), /complete final answer/);
    }
  };
  await submit("/one temporary", 1, /ONE single-model mode/);
  assert.equal((await c.session(sessionId)).mode, "cothink");
  switchDuringDraft = true;
  await submit("discussion frozen before switch", 3, /CoThink initial-answer stage/);
  await submit("next turn uses one", 1, /ONE single-model mode/);
  await c.action("session.mode", { sessionId, mode: "cothink" });
  await submit("discussion again", 3, /CoThink initial-answer stage/);
});

test("native GUI command dialogs, cancellation, unsupported TUI and idle reload are real zero-model operations", async t=>{
  const f=await fixture(t),root=join(f.home,'gui-plugin');mkdirSync(root);
  const extension=join(root,'index.js');
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'gui-native',version:'1.0.0',type:'module',pi:{extensions:['index.js']}}));
  writeFileSync(join(root,'helper.js'),"export const label=await Promise.resolve('VISIBLE_NOTICE');");
  writeFileSync(extension,`import {label} from './helper.js';export default pi=>{
    pi.registerCommand('dialog',{description:'Choose, enter and confirm',handler:async(_args,ctx)=>{
      ctx.ui.notify(label);ctx.ui.setStatus('fixture','PLUGIN_STATUS');
      const selected=await ctx.ui.select('Choose',['A','B']);
      const input=await ctx.ui.input('Enter','value');
      const confirmed=await ctx.ui.confirm('Confirm','Proceed?');
      ctx.ui.notify(JSON.stringify({selected,input,confirmed}));
    }});
    pi.registerCommand('terminal-only',{handler:async(_args,ctx)=>ctx.ui.custom(()=>{throw Error('must not execute TUI factory');})});
    pi.registerCommand('wait-input',{handler:async(_args,ctx)=>{await ctx.ui.input('Waiting');}});
    pi.registerCommand('generate',{handler:async()=>pi.sendUserMessage('Unbound model request')});
  };`);
  const {runPackageCommand}=await load('src/packages.js');assert.equal((await runPackageCommand({home:f.home,cwd:f.cwd,command:'install',source:root})).exitCode,0);
  const c=await controller(t,f),s=await c.action('session.create',{project:null});
  assert.ok((await c.action('extension.commands',{sessionId:s.id})).some(command=>command.name==='dialog'));
  const prompt=async kind=>{for(let n=0;n<300;n++){const p=(await c.bootstrap()).extensionUI.prompts[0];if(p?.kind===kind)return p;await new Promise(r=>setTimeout(r,5));}throw Error('Missing '+kind+' dialog');};
  const pending=c.action('extension.command',{sessionId:s.id,input:'/dialog'});
  let p=await prompt('select');await assert.rejects(c.action('extension.respond',{sessionId:'other',promptId:p.id,value:'B'}));
  await c.action('extension.respond',{sessionId:s.id,promptId:p.id,value:'B'});
  p=await prompt('input');await c.action('extension.respond',{sessionId:s.id,promptId:p.id,value:'<script>literal</script>'});
  p=await prompt('confirm');await c.action('extension.respond',{sessionId:s.id,promptId:p.id,value:true});await pending;
  const ui=(await c.bootstrap()).extensionUI;assert.ok(ui.notifications.some(n=>n.message==='VISIBLE_NOTICE'));assert.ok(ui.notifications.some(n=>n.message.includes('"selected":"B"')&&n.message.includes('"confirmed":true')));assert.equal(ui.statuses[0].text,'PLUGIN_STATUS');
  await assert.rejects(c.action('extension.command',{sessionId:s.id,input:'/terminal-only'}),error=>error.code==='EXTENSION_UI_UNSUPPORTED'&&/custom.*terminal/.test(error.message));
  await c.action('extension.reload',{sessionId:s.id});
  await assert.rejects(c.action('extension.command',{sessionId:s.id,input:'/generate'}),{code:'UNADAPTED_PLUGIN'});assert.equal(f.calls.length,0);
  writeFileSync(join(root,'helper.js'),"export const label=await Promise.resolve('FRESH_HELPER');");
  globalThis.__stage3SharedSessionManager=SessionManager;t.after(()=>{delete globalThis.__stage3SharedSessionManager;});
  writeFileSync(extension,`import {label} from './helper.js';import {SessionManager} from '@earendil-works/pi-coding-agent';export default pi=>pi.registerCommand('fresh',{handler:async(_args,ctx)=>{pi.registerCommand('late',{handler:async(_a,c)=>c.ui.notify('LATE_COMMAND')});ctx.ui.notify(label);ctx.ui.notify('SHARED_IDENTITY:'+String(SessionManager===globalThis.__stage3SharedSessionManager));}});`);
  await c.action('extension.reload',{sessionId:s.id});
  let commands=await c.action('extension.commands',{sessionId:s.id});assert.ok(commands.some(command=>command.name==='fresh'),JSON.stringify(commands));assert.ok(!commands.some(command=>command.name==='dialog'));assert.equal((await c.bootstrap()).extensionUI.statuses.length,0);
  await c.action('extension.command',{sessionId:s.id,input:'/fresh'});assert.ok((await c.bootstrap()).extensionUI.notifications.some(n=>n.message==='FRESH_HELPER'));assert.ok((await c.bootstrap()).extensionUI.notifications.some(n=>n.message==='SHARED_IDENTITY:true'));commands=await c.action('extension.commands',{sessionId:s.id});assert.ok(commands.some(command=>command.name==='late'));await c.action('extension.command',{sessionId:s.id,input:'/late'});
  assert.equal(f.calls.length,0);
  writeFileSync(extension,'export default (');await assert.rejects(c.action('extension.reload',{sessionId:s.id}));
  const blocked=await c.action('task.submit',{sessionId:s.id,input:'must not generate after failed reload',submissionId:'failed-reload'});
  const failed=await finished(c,blocked.taskId);assert.notEqual(failed.status,'completed');assert.equal(f.calls.length,0);
  writeFileSync(extension,'export default pi=>pi.registerCommand("wait",{handler:async(_a,ctx)=>{await ctx.ui.input("Waiting");}});');
  await c.action('extension.reload',{sessionId:s.id});const waiting=c.action('extension.command',{sessionId:s.id,input:'/wait'});await prompt('input');await c.close();await waiting;assert.equal(f.calls.length,0);
});
