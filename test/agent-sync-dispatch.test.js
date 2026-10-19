import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/pi-fixture.js";
import { repository, git } from "./helpers/git-fixture.js";
import { runTurn } from "../src/discussion.js";
const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
function outputs(body) {
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
test("A02/A06 known scope /one goes read/edit/automatic accept with no mandatory prepare call", async (t) => {
  const repo = repository(t),
    f = await fixture(t, (_, n) =>
      n === 1
        ? tool("start_work", { reason: "edit A", scope: ["a.txt"] })
        : n === 2
          ? tool("read", { path: "a.txt" })
          : n === 3
            ? tool("edit", {
                path: "a.txt",
                edits: [{ oldText: "base A", newText: "delivered" }],
              })
            : n === 4
              ? tool("accept_change")
              : { text: "Delivered A" },
    );
  const task = await runTurn({
    home: f.home,
    cwd: repo.project,
    input: "/one edit A",
    config: { formatVersion: 2, ...f.models, work: { checks: [] } },
  });
  assert.equal(task.record.status, "completed", task.record.error);
  assert.equal(f.calls.length, 5);
  assert.equal(task.record.work.backend, "agent-sync");
  assert.ok(
    task.record.work.acceptance.every(
      (r) => r.requestId && r.status === "accepted",
    ),
  );
  assert.equal(
    git(repo.project, "show", task.record.work.version + ":a.txt"),
    "delivered",
  );
  assert.ok(task.record.work.resultWorkspace);
  assert.equal(task.record.stages.filter((s) => s.phase === "work").length, 1);
});
test("A02/A04 unknown scope starts as observation then first exact edit acquires a single file in same Pi session", async (t) => {
  const repo = repository(t),
    f = await fixture(t, (_, n) =>
      n === 1
        ? tool("start_work", { reason: "inspect then edit" })
        : n === 2
          ? tool("read", { path: "a.txt" })
          : n === 3
            ? tool("edit", {
                path: "a.txt",
                edits: [{ oldText: "base A", newText: "single path" }],
              })
            : n === 4
              ? tool("accept_change")
              : { text: "done" },
    );
  const task = await runTurn({
    home: f.home,
    cwd: repo.project,
    input: "/one edit",
    config: { formatVersion: 2, ...f.models, work: { checks: [] } },
  });
  assert.equal(task.record.status, "completed", task.record.error);
  const changes = task.record.work.changes.filter((c) => c.actor === "main");
  assert.equal(changes[0].readOnly, true);
  assert.deepEqual(changes[0].scope, []);
  assert.deepEqual(changes.filter((c) => !c.readOnly).at(-1).scope, ["a.txt"]);
  assert.equal(
    new Set(
      task.record.stages
        .filter((s) => s.phase === "work")
        .map((s) => s.sessionFile),
    ).size,
    1,
  );
});
test("A02/A03 leader with dirty independent draft collects third configured model and accepts both", async (t) => {
  const repo = repository(t);
  let leader = 0;
  const f = await fixture(t, (c) => {
    if (c.body.model === "r3") {
      const n = c.body.messages.filter((m) => m.role === "tool").length;
      return n === 0
        ? tool("read", { path: "b.txt" })
        : n === 1
          ? tool("edit", {
              path: "b.txt",
              edits: [{ oldText: "base B", newText: "member" }],
            })
          : { text: "member done" };
    }
    leader++;
    if (leader === 1)
      return tool("start_work", { reason: "two scopes", scope: ["a.txt"] });
    if (leader === 2)
      return tool("delegate", {
        model: "fixture/r3",
        task: "edit B",
        materials: "B must say member",
        reason: "independent task",
        scope: ["b.txt"],
      });
    if (leader === 3) return tool("read", { path: "a.txt" });
    if (leader === 4)
      return tool("edit", {
        path: "a.txt",
        edits: [{ oldText: "base A", newText: "leader" }],
      });
    if (leader === 5) return tool("collect");
    if (leader === 6)
      return tool("accept_change", {
        memberId: outputs(c.body)
          .find((r) => r.members)
          ?.members.find((m) => m.status === "completed").memberId,
      });
    if (leader === 7) return tool("accept_change");
    return { text: "combined" };
  });
  const task = await runTurn({
    home: f.home,
    cwd: repo.project,
    input: "edit two",
    config: { formatVersion: 2, ...f.models, work: { checks: [] } },
  });
  assert.equal(task.record.status, "completed", task.record.error);
  assert.equal(task.record.members[0].status, "accepted");
  assert.equal(task.record.members[0].model.modelId, "r3");
  assert.equal(
    git(repo.project, "show", task.record.work.version + ":b.txt"),
    "member",
  );
  assert.ok(task.record.work.capacity.every((s) => s.active <= 2));
  assert.ok(
    f.calls
      .filter((c) => c.body.model === "r3")
      .every(
        (c) =>
          !c.body.tools.some((t) =>
            ["delegate", "accept_change", "start_work"].includes(
              t.function.name,
            ),
          ),
      ),
  );
});
function latest(body, predicate) {
  return outputs(body).findLast(predicate);
}
function workerReply(call, oldText, newText, path = "a.txt") {
  const last = call.body.messages.findLastIndex((m) => m.role === "user"),
    count = call.body.messages
      .slice(last + 1)
      .filter((m) => m.role === "tool").length;
  return count === 0
    ? tool("read", { path })
    : count === 1
      ? tool("edit", { path, edits: [{ oldText, newText }] })
      : { text: "member stopped with actual diff" };
}
test("A03 prepared A blocking B is returned by collect(B); B grant uses actual accepted A", async (t) => {
  const repo = repository(t);
  let n = 0,
    aId,
    bId;
  const f = await fixture(t, (c) => {
    if (c.body.model === "r1") return workerReply(c, "base A", "first");
    if (c.body.model === "r2") return workerReply(c, "first", "second");
    n++;
    if (n === 1) return tool("start_work", { reason: "ordered overlap" });
    if (n === 2)
      return tool("delegate", {
        model: "fixture/r1",
        task: "A first",
        materials: "change A to first",
        reason: "first change",
        scope: ["a.txt"],
      });
    if (n === 3) {
      aId = latest(c.body, (r) => r.memberId).memberId;
      return tool("delegate", {
        model: "fixture/r2",
        task: "B next",
        materials: "change first to second after A",
        reason: "conflicting followup",
        scope: ["a.txt"],
      });
    }
    if (n === 4) {
      bId = latest(c.body, (r) => r.memberId).memberId;
      return tool("collect", { memberId: bId });
    }
    if (n === 5) {
      const r = latest(c.body, (r) => r.members);
      assert.ok(r.members.some((m) => m.memberId === aId));
      return tool("accept_change", { memberId: aId });
    }
    if (n === 6) return tool("collect", { memberId: bId });
    if (n === 7) return tool("accept_change", { memberId: bId });
    return { text: "ordered delivery" };
  });
  const task = await runTurn({
    home: f.home,
    cwd: repo.project,
    input: "ordered changes",
    config: { formatVersion: 2, ...f.models, work: { checks: [] } },
  });
  assert.equal(task.record.status, "completed", task.record.error);
  const [a, b] = task.record.members;
  assert.equal(b.baseVersion, a.acceptedVersion);
  assert.equal(
    git(repo.project, "show", task.record.work.version + ":a.txt"),
    "second",
  );
  assert.ok(task.record.work.capacity.every((e) => e.active <= 2));
});
test(
  "A03 real leadership wait cycle is reported and queued member cancellation sends no member request",
  { timeout: 12000 },
  async (t) => {
    const repo = repository(t);
    let n = 0,
      id;
    const f = await fixture(t, (c) => {
      assert.equal(c.body.model, "main");
      n++;
      if (n === 1)
        return tool("start_work", { reason: "cycle", scope: ["a.txt"] });
      if (n === 2)
        return tool("delegate", {
          model: "fixture/r1",
          task: "blocked",
          materials: "needs a",
          reason: "cycle probe",
          scope: ["a.txt"],
        });
      if (n === 3) {
        id = latest(c.body, (r) => r.memberId).memberId;
        return tool("collect", { memberId: id });
      }
      if (n === 4) {
        assert.equal(
          latest(c.body, (r) => r.error).error.code,
          "WOULD_DEADLOCK",
        );
        return tool("abandon_member", {
          memberId: id,
          reason: "cancel blocked member",
        });
      }
      return { text: "No modification; blocked member explicitly abandoned" };
    });
    const task = await runTurn({
      home: f.home,
      cwd: repo.project,
      input: "cycle",
      config: { formatVersion: 2, ...f.models, work: { checks: [] } },
    });
    assert.equal(task.record.status, "completed", task.record.error);
    assert.equal(task.record.members[0].status, "abandoned");
    assert.equal(f.calls.filter((c) => c.body.model === "r1").length, 0);
    assert.equal(task.record.work.capacity.at(-1).active, 0);
  },
);
test("A05 feedback retains one draft and one member SDK session; dependent work starts from real accepted version", async (t) => {
  const repo = repository(t);
  let n = 0,
    id,
    dependent;
  const f = await fixture(t, (c) => {
    if (c.body.model === "r1") {
      const user = c.body.messages.findLast((m) => m.role === "user").content;
      return JSON.stringify(user).includes("具体反馈")
        ? workerReply(c, "wrong", "correct")
        : workerReply(c, "base A", "wrong");
    }
    if (c.body.model === "r2")
      return workerReply(c, "base B", "dependent", "b.txt");
    n++;
    if (n === 1) return tool("start_work", { reason: "feedback" });
    if (n === 2)
      return tool("delegate", {
        model: "fixture/r1",
        task: "fix A",
        materials: "must say correct",
        reason: "independent A",
        scope: ["a.txt"],
      });
    if (n === 3) return tool("collect");
    if (n === 4) {
      id = latest(c.body, (r) => r.members).members[0].memberId;
      return tool("feedback", {
        memberId: id,
        feedback: "a.txt is wrong; replace wrong with correct",
      });
    }
    if (n === 5) return tool("collect");
    if (n === 6) return tool("accept_change", { memberId: id });
    if (n === 7)
      return tool("delegate", {
        model: "fixture/r2",
        task: "dependent B",
        materials: "derive B after A",
        reason: "actual dependency",
        scope: ["b.txt"],
        dependsOn: [id],
      });
    if (n === 8) return tool("collect");
    if (n === 9) {
      dependent = latest(c.body, (r) => r.members).members.find(
        (m) => m.memberId !== id,
      ).memberId;
      return tool("accept_change", { memberId: dependent });
    }
    return { text: "correct dependency" };
  });
  const task = await runTurn({
    home: f.home,
    cwd: repo.project,
    input: "feedback",
    config: { formatVersion: 2, ...f.models, work: { checks: [] } },
  });
  assert.equal(task.record.status, "completed", task.record.error);
  const [a, b] = task.record.members;
  assert.equal(
    task.record.work.changes.filter((c) => c.actor === "member:" + a.memberId)
      .length,
    1,
  );
  assert.equal(
    new Set(
      task.record.stages
        .filter((s) => s.role === "member:" + a.memberId)
        .map((s) => s.sessionFile),
    ).size,
    1,
  );
  assert.equal(b.baseVersion, a.acceptedVersion);
  assert.equal(
    git(repo.project, "show", task.record.work.version + ":a.txt"),
    "correct",
  );
});
test("A05 member refresh is not acknowledged by leader requests; its own feedback request must contain actual marker", async (t) => {
  const repo = repository(t);
  let n = 0,
    id;
  const f = await fixture(t, (c) => {
    if (c.body.model === "r1") {
      const user = JSON.stringify(
        c.body.messages.findLast((m) => m.role === "user").content,
      );
      return user.includes("具体反馈")
        ? {
            text: "Reviewed actual refresh input; existing patch is still correct",
          }
        : workerReply(c, "base A", "kept");
    }
    n++;
    if (n === 1) return tool("start_work", { reason: "refresh guard" });
    if (n === 2)
      return tool("delegate", {
        model: "fixture/r1",
        task: "keep draft",
        materials: "edit A",
        reason: "A",
        scope: ["a.txt"],
      });
    if (n === 3) return tool("collect");
    if (n === 4) {
      id = latest(c.body, (r) => r.members).members[0].memberId;
      return tool("refresh_change", {
        memberId: id,
        reason: "expand input/scope",
        scope: ["a.txt", "new.txt"],
      });
    }
    if (n === 5) return tool("accept_change", { memberId: id });
    if (n === 6) {
      assert.equal(
        latest(c.body, (r) => r.error).error.code,
        "REFRESH_REQUIRES_REQUEST",
      );
      return tool("feedback", {
        memberId: id,
        feedback:
          "Review the provided new input/scope and preserve your complete draft",
      });
    }
    if (n === 7) return tool("collect");
    if (n === 8) return tool("accept_change", { memberId: id });
    return { text: "refresh reviewed by its author" };
  });
  const task = await runTurn({
    home: f.home,
    cwd: repo.project,
    input: "refresh",
    config: { formatVersion: 2, ...f.models, work: { checks: [] } },
  });
  assert.equal(task.record.status, "completed", task.record.error);
  assert.equal(task.record.members[0].status, "accepted");
  const role = "member:" + id;
  assert.ok(
    task
      .requests()
      .filter((r) => r.role === role)
      .some((r) => JSON.stringify(r.context).includes("refresh:")),
  );
});
test("A05 same assistant batch cannot refresh and immediately accept unseen input", async (t) => {
  const repo = repository(t);
  let n = 0;
  const f = await fixture(t, (c) => {
    n++;
    if (n === 1)
      return tool("start_work", { reason: "same batch", scope: ["a.txt"] });
    if (n === 2) return tool("read", { path: "a.txt" });
    if (n === 3)
      return tool("edit", {
        path: "a.txt",
        edits: [{ oldText: "base A", newText: "kept" }],
      });
    if (n === 4)
      return {
        toolCalls: [
          {
            name: "refresh_change",
            args: { reason: "expand scope", scope: ["a.txt", "new.txt"] },
          },
          { name: "accept_change", args: {} },
        ],
      };
    if (n === 5) {
      assert.ok(
        outputs(c.body).some(
          (r) => r.error?.code === "REFRESH_REQUIRES_REQUEST",
        ),
      );
      return tool("accept_change");
    }
    if (n === 6) return tool("accept_change");
    return { text: "actually reviewed" };
  });
  const task = await runTurn({
    home: f.home,
    cwd: repo.project,
    input: "/one batch",
    config: { formatVersion: 2, ...f.models, work: { checks: [] } },
  });
  assert.equal(task.record.status, "completed", task.record.error);
  assert.equal(
    task.record.work.acceptance.filter((r) => r.status === "accepted").length,
    1,
  );
});
test("A02 readonly investigation becomes an explicitly scoped writer without recreating its SDK session", async (t) => {
  const repo = repository(t);
  let n = 0,
    id;
  const f = await fixture(t, (c) => {
    if (c.body.model === "r1") {
      const user = JSON.stringify(
          c.body.messages.findLast((m) => m.role === "user").content,
        ),
        writes = c.body.tools.some((x) => x.function.name === "edit");
      if (user.includes("具体反馈")) {
        assert.equal(writes, true);
        return workerReply(c, "base A", "now writable");
      }
      assert.equal(writes, false);
      const last = c.body.messages.findLastIndex((m) => m.role === "user");
      return c.body.messages.slice(last + 1).some((m) => m.role === "tool")
        ? { text: "observed A; write a.txt needed" }
        : tool("read", { path: "a.txt" });
    }
    n++;
    if (n === 1)
      return tool("start_work", { reason: "investigate then write" });
    if (n === 2)
      return tool("delegate", {
        model: "fixture/r1",
        task: "inspect then fix A",
        materials: "first determine scope",
        reason: "investigation",
        scope: [],
        readOnly: true,
      });
    if (n === 3) return tool("collect");
    if (n === 4) {
      id = latest(c.body, (r) => r.members).members[0].memberId;
      return tool("feedback", {
        memberId: id,
        feedback: "Now explicitly edit A in the agreed scope",
        scope: ["a.txt"],
      });
    }
    if (n === 5) return tool("collect");
    if (n === 6) return tool("accept_change", { memberId: id });
    return { text: "same-session handoff" };
  });
  const task = await runTurn({
    home: f.home,
    cwd: repo.project,
    input: "investigate A",
    config: { formatVersion: 2, ...f.models, work: { checks: [] } },
  });
  assert.equal(task.record.status, "completed", task.record.error);
  assert.equal(
    new Set(
      task.record.stages
        .filter((s) => s.role === "member:" + id)
        .map((s) => s.sessionFile),
    ).size,
    1,
  );
  assert.equal(
    git(repo.project, "show", task.record.work.version + ":a.txt"),
    "now writable",
  );
});
test(
  "A03 two readonly SDK members are simultaneously in flight only after collect releases leader capacity",
  { timeout: 12000 },
  async (t) => {
    const repo = repository(t);
    let n = 0,
      entered = 0,
      release;
    const both = new Promise((r) => (release = r));
    const f = await fixture(t, async (c) => {
      if (c.body.model !== "main") {
        const toolMessages = c.body.messages.filter((m) => m.role === "tool");
        if (!toolMessages.length) {
          if (++entered === 2) release();
          await both;
          return tool("read", {
            path: c.body.model === "r1" ? "a.txt" : "b.txt",
          });
        }
        assert.match(JSON.stringify(toolMessages), /base [AB]/);
        return { text: "actual observation" };
      }
      n++;
      if (n === 1) return tool("start_work", { reason: "parallel reads" });
      if (n === 2)
        return {
          toolCalls: ["r1", "r2"].map((model) => ({
            name: "delegate",
            args: {
              model: "fixture/" + model,
              task: "inspect " + model,
              materials: "read actual file",
              reason: "independent",
              scope: [],
              readOnly: true,
            },
          })),
        };
      const collected = outputs(c.body)
        .filter((r) => r.members)
        .flatMap((r) => r.members)
        .filter((m) => m.status === "completed");
      if (new Set(collected.map((m) => m.memberId)).size < 2)
        return tool("collect");
      return { text: "both actual reads complete" };
    });
    const task = await runTurn({
      home: f.home,
      cwd: repo.project,
      input: "parallel readonly",
      config: { formatVersion: 2, ...f.models, work: { checks: [] } },
    });
    assert.equal(task.record.status, "completed", task.record.error);
    assert.equal(entered, 2);
    assert.equal(
      Math.max(...task.record.work.capacity.map((c) => c.active)),
      2,
    );
    assert.equal(task.record.work.capacity.at(-1).active, 0);
  },
);

test("A03/A05 scope-expanding feedback waits without occupying leader; accepted member continues a new change in same SDK session", async (t) => {
  const repo = repository(t);
  let n = 0,
    a,
    b,
    oldCalls;
  const f = await fixture(t, (c) => {
    if (c.body.model === "r2")
      return workerReply(c, "base B", "B accepted", "b.txt");
    if (c.body.model === "r1") {
      const i = c.body.messages.findLastIndex((m) => m.role === "user"),
        user = JSON.stringify(c.body.messages[i].content);
      if (user.includes("AFTER_ACCEPT_NEW"))
        return c.body.messages.slice(i + 1).some((m) => m.role === "tool")
          ? { text: "new work stopped" }
          : tool("write", {
              path: "new.txt",
              content: "same session new grant",
            });
      if (user.includes("EXPAND_WAIT_B"))
        return {
          text: "Reviewed actual refresh material; preserve patch A and accepted B",
        };
      return workerReply(c, "base A", "A kept");
    }
    n++;
    if (n === 1)
      return tool("start_work", { reason: "dynamic feedback scope" });
    if (n === 2)
      return tool("delegate", {
        model: "fixture/r1",
        task: "A",
        materials: "change A",
        reason: "independent",
        scope: ["a.txt"],
      });
    if (n === 3) return tool("collect");
    if (n === 4) {
      a = latest(c.body, (r) => r.members).members[0].memberId;
      return tool("delegate", {
        model: "fixture/r2",
        task: "B",
        materials: "change B",
        reason: "independent",
        scope: ["b.txt"],
      });
    }
    if (n === 5)
      return tool("collect", {
        memberId: latest(c.body, (r) => r.memberId).memberId,
      });
    if (n === 6) {
      b = latest(c.body, (r) => r.members).members[0].memberId;
      oldCalls = f.calls.filter((c) => c.body.model === "r1").length;
      return tool("feedback", {
        memberId: a,
        feedback: "EXPAND_WAIT_B: preserve A and inspect latest B",
        scope: ["a.txt", "b.txt"],
      });
    }
    if (n === 7) return tool("collect", { memberId: a });
    if (n === 8) {
      assert.equal(latest(c.body, (r) => r.members).members[0].memberId, b);
      assert.equal(
        f.calls.filter((c) => c.body.model === "r1").length,
        oldCalls,
      );
      return tool("accept_change", { memberId: b });
    }
    if (n === 9) return tool("collect", { memberId: a });
    if (n === 10) return tool("accept_change", { memberId: a });
    if (n === 11)
      return tool("feedback", {
        memberId: a,
        feedback: "AFTER_ACCEPT_NEW: now create new.txt",
        scope: ["new.txt"],
      });
    if (n === 12) return tool("collect", { memberId: a });
    if (n === 13) return tool("accept_change", { memberId: a });
    return { text: "All independent work and followup delivered" };
  });
  const task = await runTurn({
    home: f.home,
    cwd: repo.project,
    input: "expand feedback",
    config: { formatVersion: 2, ...f.models, work: { checks: [] } },
  });
  assert.equal(task.record.status, "completed", task.record.error);
  for (const [p, v] of [
    ["a.txt", "A kept"],
    ["b.txt", "B accepted"],
    ["new.txt", "same session new grant"],
  ])
    assert.equal(
      git(repo.project, "show", task.record.work.version + ":" + p),
      v,
    );
  const stages = task.record.stages.filter((s) => s.role === "member:" + a);
  assert.equal(stages.length, 3);
  assert.equal(new Set(stages.map((s) => s.sessionFile)).size, 1);
  const changes = task.record.work.changes.filter(
    (c) => c.actor === "member:" + a,
  );
  assert.equal(changes.length, 2);
  assert.equal(changes[1].baseVersion, changes[0].acceptedVersion);
});
