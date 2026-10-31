import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fixture } from "./helpers/pi-fixture.js";

// Use the distributed runtime as well as the distributed controller in installed checks.
const root = resolve(process.env.COTHINK_TEST_PACKAGE_ROOT ?? fileURLToPath(new URL("..", import.meta.url)));
const load = (path) => import(pathToFileURL(join(root, path)));
const { SessionManager } = await load("node_modules/@earendil-works/pi-coding-agent/dist/index.js");
const { startGuiServer } = await load("src/gui-server.js");
const { saveConfig } = await load("src/config.js");
const { createTeamConfig } = await load("src/teams.js");
const { readTask } = await load("src/task.js");
const { createApi } = await load("gui/src/api.js");

async function host(t, f) {
  const h = await startGuiServer({ home: f.home, cwd: f.cwd, open: false });
  t.after(() => h.close());
  const origin = new URL(h.url).origin;
  async function request(path, body) {
    return fetch(origin + path, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${h.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function json(path, body) {
    const response = await request(path, body);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  const reads = [];
  const api = createApi(h.token, (path, options) => { reads.push(options.method); return fetch(origin + path, options); });
  return { close: h.close, get: json, action: (action, args) => json("/api/action", { action, args }), reads, recover: api.recover,
    reject: async (action, args) => {
      const response = await request("/api/action", { action, args });
      assert.equal(response.status, 400, await response.clone().text());
      assert.match(await response.text(), /损坏|缺失|不可用|修复/);
    } };
}
async function setup(t) {
  const f = await fixture(t, (_, n) => ({ text: `HISTORY_REPLY_${n}` }));
  saveConfig(f.home, createTeamConfig({ formatVersion: 2, ...f.models }, "History fixture", "7c8094cd-3476-4bfa-8f53-055d87972896"));
  return f;
}
async function send(h, sessionId, input, submissionId = input) {
  const accepted = await h.action("task.submit", { sessionId, input, submissionId });
  for (let i = 0; i < 500; i++) {
    const task = await h.get("/api/task?id=" + accepted.taskId);
    if (task.status !== "running") {
      assert.equal(task.status, "completed", task.error);
      return task;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("history fixture did not settle");
}
async function newSession(h) {
  const s = await h.action("session.create", { project: null });
  await h.action("session.mode", { sessionId: s.id, mode: "one" });
  return s.id;
}

test("real Pi selected-branch fork inherits ancestor turns and keeps submission identity independent when continuing", async (t) => {
  const f = await setup(t);
  let h = await host(t, f);
  const id = await newSession(h), first = await send(h, id, "FORK_ANCESTOR");
  const source = readTask(f.home, first.id).stages[0].sessionFile;
  const ancestorLeaf = SessionManager.open(source).getLeafId();
  await send(h, id, "FORK_EXCLUDED_SIBLING");
  await h.close();
  const manager = SessionManager.open(source);
  manager.createBranchedSession(ancestorLeaf);
  // This is the SDK's other actual fork entry point; task origins keep the old ID.
  const fork = SessionManager.forkFrom(manager.getSessionFile(), manager.getCwd(), join(f.home, "pi/sessions/main"));
  const forkId = fork.getSessionId();
  h = await host(t, f);
  const restored = await h.get("/api/session?id=" + forkId);
  assert.deepEqual(restored.turns.map((x) => x.taskId), [first.id]);
  assert.equal(restored.title, "FORK_ANCESTOR");
  assert.deepEqual(restored.submissions, [], "inherited turns retain their original submission ownership");
  assert.equal(await h.recover({ sessionId: forkId, submissionId: "FORK_ANCESTOR" }), null);
  const next = await send(h, forkId, "FORK_CONTINUE", "FORK_ANCESTOR");
  assert.notEqual(next.id, first.id, "a different session owns an independent submission key");
  assert.match(JSON.stringify(f.calls[2].body.messages), /FORK_ANCESTOR/);
  assert.doesNotMatch(JSON.stringify(f.calls[2].body.messages), /FORK_EXCLUDED_SIBLING/);
  assert.deepEqual((await h.get("/api/session?id=" + forkId)).turns.map((x) => x.taskId), [first.id, next.id]);
  assert.equal((await h.recover({ sessionId: forkId, submissionId: "FORK_ANCESTOR" })).taskId, next.id);
});

test("real Pi same-session branch displays branch order, excludes sibling turns and retains durable deduplication", async (t) => {
  const f = await setup(t);
  let h = await host(t, f);
  const id = await newSession(h), first = await send(h, id, "TREE_ANCESTOR");
  const source = readTask(f.home, first.id).stages[0].sessionFile;
  const ancestorLeaf = SessionManager.open(source).getLeafId();
  const sibling = await send(h, id, "TREE_EXCLUDED_SIBLING");
  await h.close();
  const manager = SessionManager.open(source);
  manager.branch(ancestorLeaf);
  manager.appendCustomEntry("cothink-draft", { text: "new selected branch" });
  h = await host(t, f);
  assert.deepEqual((await h.get("/api/session?id=" + id)).turns.map((x) => x.taskId), [first.id]);
  assert.equal((await h.recover({ sessionId: id, submissionId: "TREE_EXCLUDED_SIBLING" })).taskId, sibling.id);
  assert.deepEqual(h.reads, ["GET"], "confirmation recovery observes durable association without mutation");
  const replay = await h.action("task.submit", { sessionId: id, input: "TREE_EXCLUDED_SIBLING", submissionId: "TREE_EXCLUDED_SIBLING" });
  assert.equal(replay.taskId, sibling.id);
  assert.equal(f.calls.length, 2);
  const next = await send(h, id, "TREE_CONTINUE");
  assert.match(JSON.stringify(f.calls[2].body.messages), /TREE_ANCESTOR/);
  assert.doesNotMatch(JSON.stringify(f.calls[2].body.messages), /TREE_EXCLUDED_SIBLING/);
  assert.deepEqual((await h.get("/api/session?id=" + id)).turns.map((x) => x.taskId), [first.id, next.id]);
});

for (const damage of ["truncated session", "missing request", "corrupt request"]) {
  test(`${damage} stays unavailable without breaking healthy bootstrap/settings or changing original bytes`, async (t) => {
    const f = await setup(t);
    let h = await host(t, f);
    const healthyId = await newSession(h), healthy = await send(h, healthyId, "HEALTHY_HISTORY");
    const badId = await newSession(h), bad = await send(h, badId, "DAMAGED_HISTORY");
    await h.close();
    const record = readTask(f.home, bad.id), sessionPath = record.stages[0].sessionFile;
    const requestPath = join(f.home, "requests", record.requestIds[0] + ".json");
    if (damage === "truncated session") appendFileSync(sessionPath, '{"type":"message","id":"crash');
    else if (damage === "missing request") rmSync(requestPath);
    else writeFileSync(requestPath, '{"id":"truncated');
    const beforeSession = readFileSync(sessionPath), beforeRequest = damage === "missing request" ? null : readFileSync(requestPath);
    h = await host(t, f);
    const boot = await h.get("/api/bootstrap");
    assert.equal(boot.configured, true);
    assert.equal(boot.sessions.find((s) => s.id === badId).readOnly, true);
    assert.ok(boot.historyErrors.some((e) => e.sessionId === badId));
    const damaged = await h.get("/api/session?id=" + badId);
    assert.equal(damaged.readOnly, true);
    assert.match(damaged.selectionError, /损坏|缺失|不可用|修复/);
    assert.equal((await h.get("/api/session?id=" + healthyId)).turns[0].taskId, healthy.id);
    assert.equal((await h.get("/api/task?id=" + healthy.id)).status, "completed");
    await h.action("settings.work", { work: { checks: [] } });
    assert.deepEqual((await h.get("/api/bootstrap")).work.checks, []);
    await h.reject("task.submit", { sessionId: badId, input: "MUST_NOT_SEND", submissionId: "blocked" });
    await h.reject("session.mode", { sessionId: badId, mode: "cothink" });
    const old = await h.action("task.submit", { sessionId: badId, input: "DAMAGED_HISTORY", submissionId: "DAMAGED_HISTORY" });
    assert.equal(old.taskId, bad.id, "known association may be queried, never replayed");
    assert.equal(f.calls.length, 2);
    assert.deepEqual(readFileSync(sessionPath), beforeSession);
    if (beforeRequest) assert.deepEqual(readFileSync(requestPath), beforeRequest);
    else assert.throws(() => readFileSync(requestPath), { code: "ENOENT" });
  });
}

test("completed live caches cannot hide newly damaged durable session or request facts", async (t) => {
  const f = await setup(t), h = await host(t, f);
  const id = await newSession(h), task = await send(h, id, "CACHED_HISTORY");
  const record = readTask(f.home, task.id), sessionPath = record.stages[0].sessionFile;
  const requestPath = join(f.home, "requests", record.requestIds[0] + ".json");
  for (const path of [sessionPath, requestPath]) {
    const original = readFileSync(path);
    appendFileSync(path, '{"broken');
    const damaged = readFileSync(path);
    assert.equal((await h.get("/api/session?id=" + id)).readOnly, true);
    await h.reject("task.submit", { sessionId: id, input: "NO_CACHED_CONTINUATION", submissionId: "blocked-cache" });
    assert.deepEqual(readFileSync(path), damaged);
    assert.equal(f.calls.length, 1);
    writeFileSync(path, original);
    assert.equal((await h.get("/api/session?id=" + id)).readOnly, false);
  }
});

test("same-process GUI close and reopen leaves released parent and fork sessions writable", async (t) => {
  const f = await setup(t);
  let h = await host(t, f);
  const parentId = await newSession(h), first = await send(h, parentId, "REOPEN_PARENT");
  const source = readTask(f.home, first.id).stages[0].sessionFile;
  await h.close();
  const fork = SessionManager.forkFrom(source, SessionManager.open(source).getCwd(), join(f.home, "pi/sessions/main"));
  const forkId = fork.getSessionId();
  h = await host(t, f);
  assert.equal((await h.get("/api/session?id=" + parentId)).readOnly, false);
  assert.equal((await h.get("/api/bootstrap")).sessions.find((s) => s.id === parentId).readOnly, false);
  await send(h, forkId, "REOPEN_FORK");
  await h.close();
  h = await host(t, f);
  for (const id of [parentId, forkId]) {
    assert.equal((await h.get("/api/session?id=" + id)).readOnly, false);
    assert.equal((await h.get("/api/bootstrap")).sessions.find((s) => s.id === id).readOnly, false);
  }
  await send(h, parentId, "REOPEN_PARENT_CONTINUE");
  await send(h, forkId, "REOPEN_FORK_CONTINUE");
  assert.equal(f.calls.length, 4);
  assert.match(JSON.stringify(f.calls[3].body.messages), /REOPEN_FORK/);
  assert.doesNotMatch(JSON.stringify(f.calls[3].body.messages), /REOPEN_PARENT_CONTINUE/);
});
