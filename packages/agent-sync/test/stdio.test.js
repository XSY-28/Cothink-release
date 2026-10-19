import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { repository } from "./helpers/repository.js";
export function client(t, repo, extra = [], configValue = { checks: [] }) {
  const config = join(repo.root, "config.json");
  writeFileSync(config, JSON.stringify(configValue));
  const p = spawn(
    process.execPath,
    [
      new URL("../src/stdio.js", import.meta.url).pathname,
      "--project",
      repo.project,
      "--home",
      repo.home,
      "--config",
      config,
      ...extra,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    },
  );
  let buffer = "",
    stderr = "";
  const events = [];
  const pending = new Map(),
    early = new Map();
  p.stderr.on("data", (b) => (stderr += b));
  p.stdout.on("data", (b) => {
    buffer += b;
    while (buffer.includes("\n")) {
      const n = buffer.indexOf("\n"),
        line = buffer.slice(0, n);
      buffer = buffer.slice(n + 1);
      const r = JSON.parse(line);
      if (r.event) {
        events.push(r);
        continue;
      }
      if (pending.has(r.id)) {
        pending.get(r.id)(r);
        pending.delete(r.id);
      } else early.set(r.id, r);
    }
  });
  p.on("exit", () => {
    for (const cb of pending.values())
      cb({ error: { code: "EXIT", message: stderr } });
    pending.clear();
  });
  const raw = (id, method, params = {}) => {
    p.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    return new Promise((resolve) => {
      if (early.has(id)) {
        resolve(early.get(id));
        early.delete(id);
      } else pending.set(id, resolve);
    });
  };
  const call = async (...args) => {
    const r = await raw(...args);
    if (r.error) throw Object.assign(new Error(r.error.message), r.error);
    return r.result;
  };
  t.after(async () => {
    if (p.exitCode === null) {
      p.stdin.end();
      await once(p, "exit");
    }
  });
  return { p, raw, call, events };
}
test("C01/C10 stdio does not serialize waiting begin; inspect/accept/cancel remain live; EOF and reopen", async (t) => {
  const repo = repository(t),
    { call, p } = client(t, repo);
  const a = await call("begin-a", "beginChange", {
    actor: "a",
    intent: "first",
    scope: ["a.txt"],
  });
  const wait = call("begin-wait", "beginChange", {
    actor: "b",
    intent: "wait",
    scope: ["a.txt"],
  });
  assert.equal((await call("inspect", "inspect")).protocolVersion, 1);
  const cancelled = await call("cancel", "cancel", { targetId: "begin-wait" });
  assert.equal(cancelled.status, "cancelled");
  await assert.rejects(wait, { code: "CANCELLED" });
  const r = await call("read-a", "read", {
    changeId: a.changeId,
    path: "a.txt",
  });
  await call("edit-a", "edit", {
    changeId: a.changeId,
    expectedVersion: a.privateVersion,
    edits: [
      { path: "a.txt", oldHash: r.contentHash, contentBase64: "ZG9uZQ==" },
    ],
  });
  const fixed = await call("prep", "prepareChange", { changeId: a.changeId });
  const input = {
    changeId: a.changeId,
    candidateVersion: fixed.candidateVersion,
  };
  const accepted = await call("accept-a", "acceptChange", input);
  assert.equal(accepted.status, "accepted");
  assert.equal(
    (await call("accept-a", "acceptChange", input)).acceptedVersion,
    accepted.acceptedVersion,
  );
  await assert.rejects(
    call("edit-a", "edit", {
      changeId: a.changeId,
      expectedVersion: a.privateVersion,
      edits: [],
    }),
    { code: "REQUEST_MISMATCH" },
  );
  const b = await call("begin-next", "beginChange", {
    actor: "b",
    intent: "next round",
    scope: ["b.txt"],
  });
  const rb = await call("read-b", "read", {
    changeId: b.changeId,
    path: "b.txt",
  });
  await call("edit-b", "edit", {
    changeId: b.changeId,
    expectedVersion: b.privateVersion,
    edits: [
      { path: "b.txt", oldHash: rb.contentHash, contentBase64: "c2Vjb25k" },
    ],
  });
  const pb = await call("prep-b", "prepareChange", { changeId: b.changeId });
  assert.equal(
    (
      await call("accept-b", "acceptChange", {
        changeId: b.changeId,
        candidateVersion: pb.candidateVersion,
      })
    ).status,
    "accepted",
  );
  p.stdin.end();
  await once(p, "exit");
  const next = client(t, repo, ["--read-only"]);
  assert.equal(
    (await next.call("old", "inspect", { requestId: "accept-a" })).status,
    "accepted",
  );
  await assert.rejects(
    next.call("no", "beginChange", {
      actor: "x",
      intent: "x",
      scope: ["a.txt"],
    }),
    { code: "READ_ONLY" },
  );
});

test("C07/C10 stdio real Shell output is framed; persistent check ID does not rerun checks", async (t) => {
  const { readFileSync } = await import("node:fs");
  const execution = JSON.parse(
    readFileSync(
      new URL(
        "../execution-manifest.json",
        import.meta.url,
      ),
    ),
  ).execution;
  const repo = repository(t),
    { call, events } = client(t, repo, [], {
      execution,
      checks: [{ command: "true" }],
    });
  const c = await call("begin-shell", "beginChange", {
    actor: "a",
    intent: "shell framing",
    scope: ["a.txt"],
  });
  const r = await call("shell", "exec", {
    changeId: c.changeId,
    expectedVersion: c.privateVersion,
    command: "echo structured-output; printf data > a.txt; exit 7",
  });
  assert.equal(r.status, "completed");
  assert.equal(r.exitCode, 7);
  assert.match(
    events
      .map((e) => Buffer.from(e.event.dataBase64, "base64").toString())
      .join(""),
    /structured-output/,
  );
  const first = await call("current-check", "checkCurrent");
  assert.equal(first.verification, "passed");
  const count = (await call("count1", "inspect")).execution.checkContainers;
  assert.deepEqual(await call("current-check", "checkCurrent"), first);
  assert.equal(
    (await call("count2", "inspect")).execution.checkContainers,
    count,
  );
});
