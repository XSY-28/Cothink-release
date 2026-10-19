import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { backend, begin, replace } from "./helpers/repository.js";
export const execution = JSON.parse(
  readFileSync(
    new URL(
      "../execution-manifest.json",
      import.meta.url,
    ),
  ),
).execution;
test("C07 real Docker reuses one paused container for ten Shell commands; nonzero exit preserves legal output", async (t) => {
  const { v, project } = await backend(t, { execution }),
    c = await begin(v, "shell");
  let version = c.privateVersion;
  let output = "";
  for (let i = 0; i < 10; i++) {
    const r = await v.exec(
      c.changeId,
      {
        requestId: "cmd-" + i,
        expectedVersion: version,
        command: `printf '${i}\\n' >> a.txt; printf warning >&2; exit 7`,
      },
      {
        onData: (b) => {
          output += Buffer.from(b).toString();
        },
      },
    );
    assert.equal(r.status, "completed");
    assert.equal(r.exitCode, 7);
    assert.notEqual(r.privateVersion, version);
    version = r.privateVersion;
    assert.equal(
      (await v.inspect({ changeId: c.changeId })).executionState,
      "paused",
    );
  }
  const c2 = await v.inspect({ changeId: c.changeId });
  assert.equal(c2.containerCreates, 1);
  assert.match(output, /warning/);
  assert.equal(readFileSync(join(project, "a.txt"), "utf8"), "base A\n");
  const log = await v.read({ outputRef: "cmd-0", limit: 4 });
  assert.equal(Buffer.from(log.contentBase64, "base64").toString(), "warn");
});
test("C07 paused background server survives next command; edits synchronize; continuously written source is stable or rejected", async (t) => {
  const { v } = await backend(t, { execution }),
    c = await begin(v, "bg");
  const r = await v.exec(c.changeId, {
    requestId: "bg-start",
    expectedVersion: c.privateVersion,
    command:
      "node -e \"require('http').createServer((q,s)=>s.end('ready')).listen(8123,'127.0.0.1')\" >/tmp/server.log 2>&1 &",
  });
  assert.equal(r.status, "completed");
  await replace(v, c, "a.txt", "edited", "edit-paused");
  let current = await v.inspect({ changeId: c.changeId });
  const next = await v.exec(c.changeId, {
    requestId: "bg-next",
    expectedVersion: current.privateVersion,
    command:
      "node -e \"fetch('http://127.0.0.1:8123').then(r=>r.text()).then(console.log)\"; cat a.txt",
  });
  assert.equal(next.status, "completed");
  assert.equal(next.exitCode, 0);
  const log = await v.read({ outputRef: next.outputRef });
  assert.match(
    Buffer.from(log.contentBase64, "base64").toString(),
    /ready[\s\S]*edited/,
  );
  current = await v.inspect({ changeId: c.changeId });
  const writer = await v.exec(c.changeId, {
    requestId: "writer",
    expectedVersion: current.privateVersion,
    command:
      "node -e \"const f=require('fs');setInterval(()=>f.writeFile('a.txt','tick'+Date.now(),()=>f.writeFileSync('/tmp/writer-ready','ready')),1)\" >/tmp/writer.log 2>&1 &",
  });
  assert.ok(["completed", "rejected"].includes(writer.status));
  const first = await v.read({ changeId: c.changeId, path: "a.txt" });
  const second = await v.read({ changeId: c.changeId, path: "a.txt" });
  assert.equal(first.contentHash, second.contentHash);
});

test("C03/C07 independent source scopes execute simultaneously in separate containers", async (t) => {
  const { v } = await backend(t, { execution }),
    a = await begin(v, "parallel-a", ["a.txt"], { readScope: [] }),
    b = await begin(v, "parallel-b", ["b.txt"], { readScope: [] });
  let readyA, readyB;
  const barrierA = new Promise((r) => (readyA = r)),
    barrierB = new Promise((r) => (readyB = r));
  const command = (path) =>
    `mkdir -p node_modules; echo ready; while [ ! -f node_modules/release ]; do sleep 0.01; done; printf private > ${path}`;
  const ra = v.exec(
    a.changeId,
    {
      requestId: "parallel-exec-a",
      expectedVersion: a.privateVersion,
      command: command("a.txt"),
    },
    { onData: () => readyA() },
  );
  const rb = v.exec(
    b.changeId,
    {
      requestId: "parallel-exec-b",
      expectedVersion: b.privateVersion,
      command: command("b.txt"),
    },
    { onData: () => readyB() },
  );
  await Promise.all([barrierA, barrierB]);
  const ca = await v.inspect({ changeId: a.changeId }),
    cb = await v.inspect({ changeId: b.changeId });
  assert.equal(ca.executionState, "running");
  assert.equal(cb.executionState, "running");
  assert.notEqual(ca.containerName, cb.containerName);
  const { writeFileSync, existsSync } = await import("node:fs");
  assert.equal(existsSync(join(ca.scratch, "b.txt")), false);
  assert.equal(existsSync(join(cb.scratch, "a.txt")), false);
  for (const c of [ca, cb])
    writeFileSync(join(c.scratch, "node_modules", "release"), "go");
  for (const r of await Promise.all([ra, rb]))
    assert.equal(r.status, "completed");
  assert.equal((await v.inspect()).execution.workContainers, 2);
});
