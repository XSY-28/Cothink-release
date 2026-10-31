import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { fixture } from "./helpers/pi-fixture.js";
import { repository, git } from "./helpers/git-fixture.js";
const execution = JSON.parse(
  readFileSync(
    new URL("../packages/agent-sync/execution-manifest.json", import.meta.url),
  ),
).execution;
const root = resolve(
  process.env.COTHINK_TEST_PACKAGE_ROOT ??
    fileURLToPath(new URL("..", import.meta.url)),
);
const load = (p) => import(pathToFileURL(join(root, p)));
const { startGuiServer } = await load("src/gui-server.js");
const { neutralDirectory } = await load("src/conversation.js");
const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
async function host(t, f) {
  const h = await startGuiServer({ home: f.home, cwd: f.cwd, open: false });
  t.after(() => h.close());
  const origin = new URL(h.url).origin,
    headers = { Authorization: `Bearer ${h.token}` };
  const get = async (path) => {
    const r = await fetch(origin + path, { headers });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  const action = async (action, args) => {
    const r = await fetch(origin + "/api/action", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ action, args }),
    });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  return { h, origin, headers, get, action };
}
async function done(h, id) {
  for (let i = 0; i < 1500; i++) {
    const r = await h.get("/api/task?id=" + id);
    if (r.status !== "running") return r;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error("fixture task did not settle");
}
async function setup(h, f) {
  await h.action("provider.save", {
    providerId: "configured",
    apiKey: "dummy-local-key",
    custom: {
      baseUrl: f.endpoint,
      api: "openai-completions",
      modelId: "main",
      name: "main",
      contextWindow: 32000,
      maxTokens: 4096,
    },
  });
  return h.action("team.save", {
    name: "HTTP integration",
    main: { provider: "configured", modelId: "main" },
    secondary: [f.models.secondary[0]],
  });
}
async function run(command, args, env = {}) {
  return new Promise((yes, no) => {
    const childEnv = { ...process.env, ...env };
    delete childEnv.NODE_TEST_CONTEXT;
    const p = spawn(command, args, {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    p.stdout.on("data", (x) => (out += x));
    p.stderr.on("data", (x) => (err += x));
    p.on("error", no);
    p.on("close", (code) => yes({ code, out, err }));
  });
}

test("blank HTTP setup -> three calls -> ONE -> actual CLI PTY -> GUI preserves null project and context", async (t) => {
  const f = await fixture(t, (_, n) => ({ text: "ROUNDTRIP_REPLY " + n }));
  writeFileSync(join(f.cwd, "AGENTS.md"), "UNBOUND_AGENTS_CANARY");
  let h = await host(t, f);
  assert.equal((await h.get("/api/bootstrap")).configured, false);
  const team = await setup(h, f);
  assert.equal(f.calls.length, 0);
  const s = await h.action("session.create", { project: null });
  const a = await h.action("task.submit", {
    sessionId: s.id,
    input: "GUI first question",
    submissionId: "first",
  });
  assert.equal((await done(h, a.taskId)).status, "completed");
  assert.deepEqual(
    f.calls.map((x) => x.body.model),
    ["main", "r1", "main"],
  );
  await h.action("session.mode", { sessionId: s.id, mode: "one" });
  const b = await h.action("task.submit", {
    sessionId: s.id,
    input: "GUI ONE second question",
    submissionId: "second",
  });
  await done(h, b.taskId);
  assert.equal(f.calls.length, 4);
  // Releasing host is essential: the CLI must acquire the same real writer lock.
  await h.h.close();
  const ready = join(f.home, "pty-writer-ready");
  const cliPending = run("python3", [
    fileURLToPath(new URL("./helpers/gui-cli-roundtrip.py", import.meta.url)),
    f.home,
    join(root, "bin/cothink.js"),
    neutralDirectory(f.home),
    ready,
  ]);
  for (let n = 0; n < 500 && !existsSync(ready); n++)
    await new Promise((r) => setTimeout(r, 10));
  assert.ok(existsSync(ready), "actual CLI writer acquired");
  h = await host(t, f);
  assert.equal((await h.get("/api/session?id=" + s.id)).readOnly, true);
  const blocked = await fetch(h.origin + "/api/action", {
    method: "POST",
    headers: { ...h.headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "task.submit",
      args: {
        sessionId: s.id,
        input: "must not race CLI",
        submissionId: "writer-blocked",
      },
    }),
  });
  assert.equal(blocked.status, 400);
  assert.equal(f.calls.length, 4);
  rmSync(ready);
  const cli = await cliPending;
  assert.equal(cli.code, 0, cli.err);
  assert.match(cli.out, /actualCliPty/);
  assert.equal(f.calls.length, 5);
  assert.match(JSON.stringify(f.calls[4].body.messages), /GUI first question/);
  assert.match(
    JSON.stringify(f.calls[4].body.messages),
    /GUI ONE second question/,
  );
  assert.doesNotMatch(
    JSON.stringify(f.calls),
    /UNBOUND_AGENTS_CANARY|"name":"start_work"/,
  );
  const restored = await h.get("/api/session?id=" + s.id);
  assert.equal(restored.project, null);
  assert.equal(restored.mode, "one");
  assert.equal(restored.team.id, team.id);
  assert.equal(restored.turns.length, 3);
  assert.equal(
    (
      await h.action("task.submit", {
        sessionId: s.id,
        input: "GUI first question",
        submissionId: "first",
      })
    ).taskId,
    a.taskId,
  );
  assert.equal(f.calls.length, 5);
});

test("HTTP cancellation in real review/member saves partial content without extra calls after SSE disconnect", async (t) => {
  for (const member of [false, true]) {
    let entered;
    const barrier = new Promise((r) => (entered = r));
    const f = await fixture(t, async (call, n, req, res) => {
      if (call.body.model === "r1") {
        entered();
        await new Promise((r) => {
          const timer = setTimeout(r, 30000);
          res.once("close", () => {
            clearTimeout(timer);
            r();
          });
        });
        return res.destroyed ? null : { text: "delayed member" };
      }
      if (member) {
        if (n === 1)
          return tool("start_work", { reason: "member cancellation" });
        if (n === 2)
          return tool("delegate", {
            model: "fixture/r1",
            assignment: "slow member",
            implementationAdvice: "read only fixture",
            reason: "inspection",
            scope: [],
            readScope: ["."],
            readOnly: true,
          });
        return tool("collect");
      }
      return { text: "saved draft" };
    });
    const h = await host(t, f);
    await setup(h, f);
    await h.action("settings.work", { work: { checks: [] } });
    const repo = member ? repository(t) : null;
    const s = await h.action("session.create", {
      project: repo?.project ?? null,
    });
    const a = await h.action("task.submit", {
      sessionId: s.id,
      input: member ? "member cancel" : "review cancel",
      submissionId: "cancel",
    });
    let timer;
    try {
      await Promise.race([
        barrier,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error("fixture did not enter reviewer/member")),
            15000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const abort = new AbortController();
    const events = await fetch(h.origin + "/api/events", {
      headers: h.headers,
      signal: abort.signal,
    });
    await events.body.getReader().read();
    abort.abort();
    assert.equal((await h.get("/api/task?id=" + a.taskId)).status, "running");
    const n = f.calls.length;
    await h.action("task.cancel", { taskId: a.taskId });
    const task = await done(h, a.taskId);
    assert.notEqual(task.status, "completed");
    assert.equal(f.calls.length, n);
    assert.ok(task.messages.some((x) => x.text === "saved draft") || member);
    if (member)
      assert.ok(
        task.participants.some((x) => x.role === "member" && x.participated),
      );
  }
});

test("HTTP Docker work patch reconstructs binary/delete/mode and old task diff stays fixed after later acceptance", async (t) => {
  const repo = repository(t);
  let round = 0,
    k = 0;
  const original = git(repo.project, "status", "--porcelain=v1");
  const f = await fixture(t, (call) => {
    if (
      (call.body.tools ?? []).some((x) => x.function?.name === "start_work")
    ) {
      round++;
      k = 0;
      return tool("start_work", {
        reason: "full patch",
        scope: ["a.txt", "b.txt", "asset.bin", "run.sh"],
        readScope: ["."],
      });
    }
    k++;
    if (k === 1)
      return tool("bash", {
        command:
          round === 1
            ? "node -e \"const f=require('fs');f.writeFileSync('a.txt','first accepted\\n');f.unlinkSync('b.txt');f.writeFileSync('asset.bin',Buffer.from([0,255,1]));f.writeFileSync('run.sh','#!/bin/sh\\necho fixture\\n');f.chmodSync('run.sh',0o755)\""
            : "node -e \"require('fs').writeFileSync('a.txt','second accepted\\n')\"",
      });
    if (k === 2 || k === 3) return tool("accept_change");
    return { text: "delivered" };
  });
  const h = await host(t, f);
  await setup(h, f);
  await h.action("settings.work", {
    work: {
      execution,
      checks: [
        {
          command: "node",
          args: [
            "-e",
            "if(!require('fs').readFileSync('asset.bin').equals(Buffer.from([0,255,1])))process.exit(1);console.log('PATCH_CHECK')",
          ],
        },
      ],
    },
  });
  const s = await h.action("session.create", { project: repo.project });
  await h.action("session.mode", { sessionId: s.id, mode: "one" });
  const a = await h.action("task.submit", {
    sessionId: s.id,
    input: "first full patch",
    submissionId: "patch1",
  });
  const first = await done(h, a.taskId);
  assert.equal(first.status, "completed", first.error);
  assert.equal(first.work.finalCheck.verification, "passed");
  const d = await h.get("/api/diff?id=" + a.taskId);
  assert.match(d.text, /GIT binary patch/);
  assert.match(d.text, /deleted file mode/);
  assert.match(d.text, /new file mode 100755/);
  const clone = join(repo.root, "rebuild");
  git(repo.root, "clone", "--no-hardlinks", repo.project, clone);
  git(clone, "checkout", "--detach", d.fromVersion);
  writeFileSync(join(repo.root, "patch.diff"), d.text);
  git(clone, "apply", "--index", "--binary", join(repo.root, "patch.diff"));
  assert.equal(
    git(clone, "write-tree"),
    git(repo.project, "rev-parse", d.toVersion + "^{tree}"),
  );
  const b = await h.action("task.submit", {
    sessionId: s.id,
    input: "second advance",
    submissionId: "patch2",
  });
  assert.equal((await done(h, b.taskId)).status, "completed");
  assert.deepEqual(await h.get("/api/diff?id=" + a.taskId), d);
  assert.equal(readFileSync(join(repo.project, "a.txt"), "utf8"), "base A\n");
  assert.equal(git(repo.project, "status", "--porcelain=v1"), original);
});

test("HTTP distinguishes an empty unverified policy from configured checks without execution", async (t) => {
  for (const checks of [
    [],
    [{ command: "node", args: ["-e", "process.exit(0)"] }],
  ]) {
    const repo = repository(t);
    const f = await fixture(t, (_, n) =>
      n === 1
        ? tool("start_work", { reason: "check boundary", scope: ["a.txt"] })
        : n === 2
          ? tool("read", { path: "a.txt" })
          : n === 3
            ? tool("write", { path: "a.txt", content: "policy change\n" })
            : n === 4 || n === 5
              ? tool("accept_change")
              : { text: "policy result" },
    );
    const h = await host(t, f);
    await setup(h, f);
    await h.action("settings.work", { work: { checks } });
    const s = await h.action("session.create", { project: repo.project });
    await h.action("session.mode", { sessionId: s.id, mode: "one" });
    const a = await h.action("task.submit", {
      sessionId: s.id,
      input: "policy test",
      submissionId: "policy",
    });
    const task = await done(h, a.taskId);
    if (!checks.length) {
      assert.equal(task.status, "completed", task.error);
      assert.equal(task.work.finalCheck.verification, "unverified");
    } else {
      assert.notEqual(task.work?.finalCheck?.verification, "passed");
      assert.notEqual(task.status, "completed");
      assert.match(JSON.stringify(task), /Docker|EXECUTOR_CONFIG|execution/i);
    }
  }
});

test("missing Docker isolated child refuses host Shell fallback", async (t) => {
  if (!process.env.COTHINK_GUI_NO_DOCKER_CHILD) {
    const { mkdtempSync, symlinkSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const bin = mkdtempSync(join(tmpdir(), "gui-no-docker-"));
    t.after(() => rmSync(bin, { recursive: true, force: true }));
    // Only this child sees the restricted PATH. Docker Desktop and host config are untouched.
    const gitPath = (await run("/usr/bin/which", ["git"])).out.trim();
    symlinkSync(gitPath, join(bin, "git"));
    const r = await run(
      process.execPath,
      [
        "--test",
        "--test-name-pattern=missing Docker isolated child",
        fileURLToPath(import.meta.url),
      ],
      { PATH: bin, COTHINK_GUI_NO_DOCKER_CHILD: "1" },
    );
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /missing Docker isolated child/);
    return;
  }
  const repo = repository(t);
  let f;
  f = await fixture(t, (_, n) =>
    n === 1
      ? tool("start_work", { reason: "unavailable executor", scope: ["a.txt"] })
      : n === 2
        ? tool("bash", {
            command: `echo forbidden > '${join(f.home, "HOST_FALLBACK_CANARY")}'`,
          })
        : { text: "cannot execute" },
  );
  const h = await host(t, f);
  await setup(h, f);
  await h.action("settings.work", {
    work: {
      execution,
      checks: [{ command: "node", args: ["-e", "process.exit(0)"] }],
    },
  });
  const s = await h.action("session.create", { project: repo.project });
  await h.action("session.mode", { sessionId: s.id, mode: "one" });
  const a = await h.action("task.submit", {
    sessionId: s.id,
    input: "missing engine",
    submissionId: "missing",
  });
  const task = await done(h, a.taskId);
  assert.equal(existsSync(join(f.home, "HOST_FALLBACK_CANARY")), false);
  assert.notEqual(task.work?.finalCheck?.verification, "passed");
  assert.notEqual(task.status, "completed");
  assert.match(JSON.stringify(task), /docker|ENOENT|executor/i);
});
