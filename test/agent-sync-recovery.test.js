import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./helpers/pi-fixture.js";
import { repository, git } from "./helpers/git-fixture.js";
import { runTurn } from "../src/discussion.js";
import { inspectWork } from "../src/presentation.js";
import { execution } from "./helpers/agent-sync-fixture.js";
const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
function replies(body) {
  return body.messages
    .filter((m) => m.role === "tool")
    .flatMap((m) => {
      try {
        return [JSON.parse(m.content)];
      } catch {
        return [];
      }
    });
}
function editFlow(_, n) {
  return n === 1
    ? tool("start_work", { reason: "edit A", scope: ["a.txt"] })
    : n === 2
      ? tool("read", { path: "a.txt" })
      : n === 3
        ? tool("edit", {
            path: "a.txt",
            edits: [{ oldText: "base A", newText: "candidate" }],
          })
        : n === 4
          ? tool("accept_change")
          : { text: "final model text" };
}
test("A05/A07 saved acceptance ID is queried after lost response; no second acceptance or model retry", async (t) => {
  const repo = repository(t);
  let lost = false;
  const f = await fixture(t, (c, n) =>
    n === 5
      ? tool("inspect_change", {
          requestId: replies(c.body).find((r) => r.status === "unknown")
            .requestId,
        })
      : editFlow(c, n),
  );
  const task = await runTurn({
    home: f.home,
    cwd: repo.project,
    input: "/one edit",
    config: { formatVersion: 2, ...f.models, work: { checks: [] } },
    onProgress: (e) => {
      if (e.type === "git" && e.operation.action === "ref_updated" && !lost) {
        lost = true;
        assert.ok(
          e.task.record.work.acceptance.some(
            (r) =>
              r.requestId === e.operation.requestId && r.status === "pending",
          ),
        );
        throw Error("fixture response lost");
      }
    },
  });
  assert.equal(task.record.status, "completed", task.record.error);
  assert.equal(task.record.work.acceptance.length, 1);
  assert.equal(task.record.work.acceptance[0].status, "accepted");
  assert.equal(task.record.work.acceptance[0].reportedStatus, "unknown");
  assert.equal(
    task.record.work.operations.filter((e) => e.action === "ref_updated")
      .length,
    1,
  );
  assert.equal(f.calls.length, 6);
});
test("A05 unknown acceptance cannot be bypassed by prepare/accept with new ID", async (t) => {
  const repo = repository(t);
  let lost = false;
  const f = await fixture(t, (c, n) =>
    n === 5
      ? tool("prepare_change")
      : n === 6
        ? tool("accept_change")
        : editFlow(c, n),
  );
  const task = await runTurn({
    home: f.home,
    cwd: repo.project,
    input: "/one edit",
    config: { formatVersion: 2, ...f.models, work: { checks: [] } },
    onProgress: (e) => {
      if (e.type === "git" && e.operation.action === "ref_updated" && !lost) {
        lost = true;
        throw Error("lost acknowledgement");
      }
    },
  });
  assert.equal(task.record.status, "partial");
  assert.equal(task.record.finalCallId, null);
  assert.equal(task.record.work.acceptance.length, 1);
  assert.equal(task.record.work.acceptance[0].status, "unknown");
  assert.equal(
    task.record.work.operations.filter((e) => e.action === "ref_updated")
      .length,
    1,
  );
});
test("A07 cancellation at file tool intent prevents mutations and later provider sends", async (t) => {
  const repo = repository(t),
    controller = new AbortController();
  const f = await fixture(t, editFlow);
  const task = await runTurn({
    home: f.home,
    cwd: repo.project,
    input: "/one cancel",
    config: { formatVersion: 2, ...f.models, work: { checks: [] } },
    signal: controller.signal,
    onProgress: (e) => {
      if (e.type === "tool" && e.tool.name === "edit") controller.abort();
    },
  });
  assert.equal(task.record.status, "cancelled");
  assert.equal(task.record.work.version, repo.baseVersion);
  assert.equal(f.calls.length, 3);
  assert.equal(task.record.work.acceptance.length, 0);
  assert.equal(readFileSync(join(repo.project, "a.txt"), "utf8"), "base A\n");
});
test("A05 private ref success followed by consumer I/O failure remains partial and query reveals applied fact without execution", async (t) => {
  const repo = repository(t),
    f = await fixture(t, editFlow);
  const task = await runTurn({
    home: f.home,
    cwd: repo.project,
    input: "/one IO",
    config: { formatVersion: 2, ...f.models, work: { checks: [] } },
    persist: (r) => {
      if (r.work?.operations?.some((e) => e.action === "private_ref_updated"))
        throw Error("fixture consumer record full");
    },
  });
  assert.equal(task.record.status, "partial");
  assert.ok(task.recovery);
  assert.equal(task.record.finalCallId, null);
  const count = f.calls.length;
  const fact = await inspectWork(f.home, task.record);
  assert.ok(fact.requests.some((r) => r.status === "applied"));
  assert.equal(f.calls.length, count);
  assert.equal(
    git(repo.project, "rev-parse", task.record.work.integrationRef),
    repo.baseVersion,
  );
});
test("A07 failed result-location persistence cannot make accepted history disappear or publish final", async (t) => {
  const repo = repository(t),
    f = await fixture(t, editFlow);
  const task = await runTurn({
    home: f.home,
    cwd: repo.project,
    input: "/one publish",
    config: { formatVersion: 2, ...f.models, work: { checks: [] } },
    persist: (r) => {
      if (r.work?.resultWorkspace)
        throw Error("fixture result location save failure");
    },
  });
  assert.equal(task.record.status, "partial");
  assert.ok(task.recovery);
  assert.equal(task.record.finalCallId, null);
  assert.notEqual(task.record.work.version, repo.baseVersion);
  assert.equal(
    git(repo.project, "show", task.record.work.version + ":a.txt"),
    "candidate",
  );
  const fact = await inspectWork(f.home, task.record);
  assert.equal(fact.acceptance[0].status, "accepted");
});
test(
  "A07 global cancellation aborts two in-flight SDK members and retains unknown request accounting",
  { timeout: 12000 },
  async (t) => {
    const repo = repository(t),
      controller = new AbortController();
    let n = 0,
      entered = 0,
      ready;
    const started = new Promise((r) => (ready = r));
    const f = await fixture(t, (c) => {
      if (c.body.model !== "main") {
        if (++entered === 2) ready();
        return null;
      }
      n++;
      if (n === 1) return tool("start_work", { reason: "parallel" });
      if (n === 2)
        return {
          toolCalls: ["r1", "r2"].map((m) => ({
            name: "delegate",
            args: {
              model: "fixture/" + m,
              task: "inspect " + m,
              materials: "read",
              reason: "parallel",
              scope: [],
              readOnly: true,
            },
          })),
        };
      return tool("collect");
    });
    const running = runTurn({
      home: f.home,
      cwd: repo.project,
      input: "cancel members",
      config: { formatVersion: 2, ...f.models, work: { checks: [] } },
      signal: controller.signal,
    });
    await started;
    controller.abort();
    const task = await running;
    assert.equal(task.record.status, "cancelled");
    assert.equal(
      task.record.members.filter((m) => m.status === "cancelled").length,
      2,
    );
    assert.equal(f.calls.length, 5);
    assert.ok(task.requests().some((r) => r.status === "outcome_unknown"));
    assert.equal(task.record.work.capacity.at(-1).active, 0);
  },
);
test("A07 real Docker cancellation stops whole container before task cleanup and never imports late output", async (t) => {
  const repo = repository(t),
    controller = new AbortController();
  const f = await fixture(t, (_, n) =>
    n === 1
      ? tool("start_work", { reason: "shell cancel", scope: ["a.txt"] })
      : tool("bash", { command: "sleep 1000; printf late > a.txt" }),
  );
  let once = false;
  const task = await runTurn({
    home: f.home,
    cwd: repo.project,
    input: "/one shell",
    config: { formatVersion: 2, ...f.models, work: { checks: [], execution } },
    signal: controller.signal,
    onProgress: (e) => {
      if (e.type === "git" && e.operation.action === "command_start" && !once) {
        once = true;
        controller.abort();
      }
    },
  });
  assert.equal(task.record.status, "cancelled");
  assert.equal(task.record.work.version, repo.baseVersion);
  assert.equal(f.calls.length, 2);
  assert.equal(readFileSync(join(repo.project, "a.txt"), "utf8"), "base A\n");
});
test("A05 applied private edit is confirmed by its original ID, then explicit refresh repairs projection without replay", async (t) => {
  const { chmodSync } = await import("node:fs");
  const repo = repository(t);
  let once = false,
    editId,
    dir;
  const f = await fixture(t, (c, n) =>
    n === 4
      ? tool("inspect_change", { requestId: editId })
      : n === 5
        ? tool("refresh_change", {
            reason:
              "Rematerialize confirmed draft after private record failure",
            resetExecution: true,
          })
        : n === 6 || n === 7
          ? tool("accept_change")
          : editFlow(c, n),
  );
  const task = await runTurn({
    home: f.home,
    cwd: repo.project,
    input: "/one private recovery",
    config: { formatVersion: 2, ...f.models, work: { checks: [] } },
    onProgress: (e) => {
      if (
        e.type === "git" &&
        e.operation.action === "private_ref_updated" &&
        !once
      ) {
        once = true;
        editId = e.operation.requestId;
        dir = join(e.task.record.work.directory, "changes");
        assert.ok(dir.startsWith(f.home));
        chmodSync(dir, 0o500);
        setImmediate(() => chmodSync(dir, 0o700));
      }
    },
  });
  assert.equal(task.record.status, "completed", task.record.error);
  assert.equal(task.record.tools.filter((t) => t.name === "edit").length, 1);
  assert.equal(
    task.record.work.operations.filter(
      (t) => t.action === "private_ref_updated",
    ).length,
    1,
  );
  assert.equal(
    git(repo.project, "show", task.record.work.version + ":a.txt"),
    "candidate",
  );
  assert.ok(
    task.record.tools.some(
      (t) =>
        t.name === "edit" &&
        t.reportedStatus === "unknown" &&
        t.resolvedByQuery,
    ),
  );
});
