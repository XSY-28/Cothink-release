import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { backend, begin } from "./helpers/repository.js";
const execution = JSON.parse(
  readFileSync(
    new URL(
      "../execution-manifest.json",
      import.meta.url,
    ),
  ),
).execution;
test("C07 forbidden source imports preserve entire prior draft, explicit reset archives evidence", async (t) => {
  const { v } = await backend(t, { execution }),
    c = await begin(v, "bounds", ["a.txt"], { readScope: ["a.txt"] });
  const r = await v.exec(c.changeId, {
    requestId: "out",
    expectedVersion: c.privateVersion,
    command: "printf legal > a.txt; printf forbidden > b.txt",
  });
  assert.equal(r.status, "rejected");
  assert.equal(
    (await v.inspect({ changeId: c.changeId })).privateVersion,
    c.privateVersion,
  );
  await assert.rejects(
    v.exec(c.changeId, {
      requestId: "continue",
      expectedVersion: c.privateVersion,
      command: "true",
    }),
    { code: "EXECUTION_NEEDS_RESET" },
  );
  const refreshed = await v.refreshChange(c.changeId, {
    requestId: "reset",
    resetExecution: true,
    reason: "explicitly preserve and discard unimported scratch",
  });
  assert.ok(refreshed.executionArchive);
});
test("C07 container cannot access host, refs, socket, network, root or capabilities; symlink/hardlink/.git rejected", async (t) => {
  const { v, root, project, home } = await backend(t, { execution }),
    c = await begin(v, "isolation", ["a.txt"], { readScope: ["a.txt"] });
  const command = `test ! -e '${root}' && test ! -e '${project}' && test ! -e '${home}' && test ! -e /var/run/docker.sock && test ! -e /work/.git && test ! -e /root/.ssh && test "$(id -u)" != 0 && ! touch /usr/escape && ! node -e "fetch('http://1.1.1.1').then(()=>process.exit(0)).catch(()=>process.exit(1))"`;
  let r = await v.exec(c.changeId, {
    requestId: "probe",
    expectedVersion: c.privateVersion,
    command,
    timeoutMs: 10000,
  });
  assert.equal(r.status, "completed");
  assert.equal(r.exitCode, 0);
  for (const [id, command] of [
    ["link", "ln -s /etc/passwd a-link"],
    ["hard", "ln a.txt alias"],
    ["git", "mkdir .git; printf bad > .git/config"],
  ]) {
    const cc = await begin(v, "negative-" + id, ["a.txt"], {
      wait: false,
      readScope: ["a.txt"],
    });
    assert.equal(cc.status, "blocked");
  }
  await v.abandonChange(c.changeId);
  for (const [id, command] of [
    ["link", "ln -s /etc/passwd a-link"],
    ["hard", "ln a.txt alias"],
    ["git", "mkdir .git; printf bad > .git/config"],
  ]) {
    const cc = await begin(v, "probe-" + id, ["a.txt"], {
      readScope: ["a.txt"],
    });
    r = await v.exec(cc.changeId, {
      requestId: id,
      expectedVersion: cc.privateVersion,
      command,
    });
    assert.equal(r.status, "rejected");
    await v.abandonChange(cc.changeId);
  }
});
test("C08 cancellation kills detached descendants before releasing scope; request is never replayed", async (t) => {
  const { v } = await backend(t, { execution }),
    c = await begin(v, "cancel");
  const controller = new AbortController();
  let started;
  const barrier = new Promise((resolve) => (started = resolve));
  const running = v.exec(
    c.changeId,
    {
      requestId: "cancel-run",
      expectedVersion: c.privateVersion,
      command:
        'echo started; setsid bash -c "sleep 1000" >/tmp/detached.log 2>&1 & wait',
    },
    { signal: controller.signal, onData: () => started() },
  );
  await barrier;
  controller.abort();
  const r = await running;
  assert.ok(["cancelled", "unknown"].includes(r.status));
  const again = await v.exec(c.changeId, {
    requestId: "cancel-run",
    expectedVersion: c.privateVersion,
    command:
      'echo started; setsid bash -c "sleep 1000" >/tmp/detached.log 2>&1 & wait',
  });
  assert.deepEqual(again, r);
  const next = await begin(v, "after-cancel");
  assert.equal(next.status, "open");
});

test("C08 killed host stops running container; new owner queries unknown without replay", async (t) => {
  const { repository } = await import("./helpers/repository.js");
  const { writeFileSync } = await import("node:fs");
  const { spawn, execFileSync } = await import("node:child_process");
  const { once } = await import("node:events");
  const { createAgentSync } = await import("../src/index.js");
  const { setTimeout: delay } = await import("node:timers/promises");
  const repo = repository(t),
    config = repo.root + "/host.json";
  writeFileSync(config, JSON.stringify({ ...repo, execution }));
  const p = spawn(
    process.execPath,
    [
      new URL("./helpers/shell-crash-worker.js", import.meta.url).pathname,
      config,
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  let changeId;
  let err = "";
  p.stderr.on("data", (b) => (err += b));
  await new Promise((resolve, reject) => {
    p.on("message", (m) => {
      if (m.changeId) changeId = m.changeId;
      if (m.started) resolve();
    });
    p.on("exit", () => reject(Error(err)));
  });
  p.kill("SIGKILL");
  await once(p, "exit");
  let running = true;
  try {
    for (let i = 0; i < 100; i++) {
      const raw = execFileSync(
        "docker",
        [
          "inspect",
          "--format",
          "{{.State.Running}}",
          "agent-sync-work-" + changeId,
        ],
        { encoding: "utf8" },
      );
      running = raw.trim() === "true";
      if (!running) break;
      await delay(25);
    }
    assert.equal(
      running,
      false,
      "trusted PID1 must see owner pipe EOF and exit",
    );
  } finally {
    const v = await createAgentSync({ ...repo, execution });
    try {
      assert.equal(
        (await v.inspect({ requestId: "host-command" })).status,
        "unknown",
      );
      assert.equal((await v.inspect({ changeId })).status, "interrupted");
    } finally {
      await v.close();
    }
  }
});

test("C07 declared pid/memory limits contain resource exhaustion; source authority stays intact", async (t) => {
  const { v } = await backend(t, {
      execution: {
        ...execution,
        limits: { ...execution.limits, pids: 24, memoryBytes: 134217728 },
      },
    }),
    c = await begin(v, "resources");
  const pids = await v.exec(c.changeId, {
    requestId: "pids",
    expectedVersion: c.privateVersion,
    command: `node -e 'const cp=require("child_process");let errors=0;const children=[];for(let i=0;i<64;i++){const c=cp.spawn("sleep",["20"]);children.push(c);c.on("error",()=>errors++);}setTimeout(()=>{for(const c of children)c.kill();console.log("limited",errors);process.exit(errors>0?0:1)},100)'`,
    timeoutMs: 10000,
  });
  assert.equal(pids.status, "completed");
  assert.equal(pids.exitCode, 0);
  const memory = await v.exec(c.changeId, {
    requestId: "memory",
    expectedVersion: pids.privateVersion,
    command: `node -e 'Buffer.alloc(600*1024*1024,1)'`,
    timeoutMs: 10000,
  });
  assert.ok(["completed", "unknown"].includes(memory.status));
  if (memory.status === "completed") assert.notEqual(memory.exitCode, 0);
  const actual = await v.read({ changeId: c.changeId, path: "a.txt" });
  assert.equal(
    Buffer.from(actual.contentBase64, "base64").toString(),
    "base A\n",
  );
});

test("C08 lost command transport preserves unimported effects and never replays unknown command", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { v } = await backend(t, { execution }),
    c = await begin(v, "transport");
  let killed = false;
  const input = {
    requestId: "lost-command",
    expectedVersion: c.privateVersion,
    command: "printf unique-unimported > a.txt; echo barrier; sleep 1000",
  };
  const r = await v.exec(c.changeId, input, {
    onData: () => {
      if (!killed) {
        killed = true;
        const path = join(v.directory, "changes", c.changeId + ".json");
        const state = JSON.parse(readFileSync(path));
        execFileSync("docker", ["rm", "--force", state.containerName], {
          stdio: "pipe",
        });
      }
    },
  });
  assert.equal(r.status, "unknown");
  assert.equal(
    (await v.inspect({ changeId: c.changeId })).privateVersion,
    c.privateVersion,
  );
  assert.deepEqual(await v.exec(c.changeId, input), r);
  assert.equal(
    (await v.inspect({ requestId: input.requestId })).status,
    "unknown",
  );
  const reset = await v.refreshChange(c.changeId, {
    requestId: "recover-lost",
    resetExecution: true,
    reason: "preserve transport-loss scratch",
  });
  assert.equal(
    readFileSync(join(reset.executionArchive.path, "a.txt"), "utf8"),
    "unique-unimported",
  );
});
