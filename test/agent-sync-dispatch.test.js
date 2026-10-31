import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/pi-fixture.js";
import { repository, git } from "./helpers/git-fixture.js";
import { resolve, join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { execution } from "./helpers/agent-sync-fixture.js";
const { runTurn } = await import(process.env.COTHINK_TEST_PACKAGE_ROOT
  ? pathToFileURL(resolve(process.env.COTHINK_TEST_PACKAGE_ROOT, "src/discussion.js")).href
  : new URL("../src/discussion.js", import.meta.url).href);
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
function isPreparation(body) {
  const user = body.messages.findLast(m => m.role === 'user');
  return JSON.stringify(user?.content).includes('Independent task preparation');
}
function memberExecutionInfo(body) {
  const content = body.messages.findLast((m) => m.role === "user").content;
  const text = typeof content === "string"
    ? content
    : content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  const material = JSON.parse(text);
  return { ...material.execution, reason: material.reason?.text };

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
  const checks = [];
  let leader = 0;
  const f = await fixture(t, (c) => {
    if (isPreparation(c.body)) return {text: "Independent goal understood; inspect the original task within scope."};
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
        assignment: "edit B",
        implementationAdvice: "B must say member",
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
    config: { formatVersion: 2, ...f.models, work: { checks, execution } },
  });
  assert.equal(task.record.status, "completed", task.record.error);
  assert.equal(task.record.members[0].status, "accepted");
  const workSystem = f.calls[1].body.messages.find(m => m.role === "system").content;
  assert.match(workSystem, /CoThink collaborative work mode/);
  assert.match(workSystem, /scheduling preferences/);
  assert.doesNotMatch(workSystem, /ONE single-model work mode/);

  assert.equal(task.record.members[0].model.modelId, "r3");
  for (const call of f.calls.filter((c) => c.body.model === "r3" && !isPreparation(c.body))) {
    const info = memberExecutionInfo(call.body);
    assert.equal(info.reason, "independent task");
    assert.equal(info.readOnly, false);
    assert.deepEqual(info.scope, ["b.txt"]);
    assert.deepEqual(info.readScope, ["."]);
    assert.deepEqual(info.checks, checks);
    assert.equal(info.execution.engine, "docker");
    assert.equal(info.execution.image, execution.image);
    assert.equal(info.execution.network, "none");
  }
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
    if (isPreparation(c.body)) return {text: "Independent goal understood; inspect the original task within scope."};
    if (c.body.model === "r1") return workerReply(c, "base A", "first");
    if (c.body.model === "r2") return workerReply(c, "first", "second");
    n++;
    if (n === 1) return tool("start_work", { reason: "ordered overlap" });
    if (n === 2)
      return tool("delegate", {
        model: "fixture/r1",
        assignment: "A first",
        implementationAdvice: "change A to first",
        reason: "first change",
        scope: ["a.txt"],
      });
    if (n === 3) {
      aId = latest(c.body, (r) => r.memberId).memberId;
      return tool("delegate", {
        model: "fixture/r2",
        assignment: "B next",
        implementationAdvice: "change first to second after A",
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
    if (isPreparation(c.body)) return {text: "Independent goal understood; inspect the original task within scope."};
      assert.equal(c.body.model, "main");
      n++;
      if (n === 1)
        return tool("start_work", { reason: "cycle", scope: ["a.txt"] });
      if (n === 2)
        return tool("delegate", {
          model: "fixture/r1",
          assignment: "blocked",
          implementationAdvice: "needs a",
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
    assert.equal(f.calls.filter((c) => c.body.model === "r1" && !isPreparation(c.body)).length, 0);
    assert.equal(task.record.work.capacity.at(-1).active, 0);
  },
);
test("A05 feedback retains one draft and one member SDK session; dependent work starts from real accepted version", async (t) => {
  const repo = repository(t);
  let n = 0,
    id,
    dependent;
  const f = await fixture(t, (c) => {
    if (isPreparation(c.body)) return {text: "Independent goal understood; inspect the original task within scope."};
    if (c.body.model === "r1") {
      const user = c.body.messages.findLast((m) => m.role === "user").content;
      return JSON.stringify(user).includes("a.txt is wrong; replace wrong with correct")
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
        assignment: "fix A",
        implementationAdvice: "must say correct",
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
        assignment: "dependent B",
        implementationAdvice: "derive B after A",
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
    if (isPreparation(c.body)) return {text: "Independent goal understood; inspect the original task within scope."};
    if (c.body.model === "r1") {
      const user = JSON.stringify(
        c.body.messages.findLast((m) => m.role === "user").content,
      );
      return user.includes("Review the provided new input/scope and preserve your complete draft")
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
        assignment: "keep draft",
        implementationAdvice: "edit A",
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
  for (const call of f.calls.filter((c) => c.body.model === "r1" && !isPreparation(c.body))) {
    const feedback = JSON.stringify(call.body.messages.findLast((m) => m.role === "user").content).includes("Review the provided new input/scope and preserve your complete draft");
    const info = memberExecutionInfo(call.body);
    assert.deepEqual(info.scope, feedback ? ["a.txt", "new.txt"] : ["a.txt"]);
    assert.deepEqual(info.readScope, ["."]);
  }
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
    if (isPreparation(c.body)) return {text: "Independent goal understood; inspect the original task within scope."};
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
    if (isPreparation(c.body)) return {text: "Independent goal understood; inspect the original task within scope."};
    if (c.body.model === "r1") {
      const user = JSON.stringify(
          c.body.messages.findLast((m) => m.role === "user").content,
        ),
        writes = c.body.tools.some((x) => x.function.name === "edit");
      if (user.includes("Now explicitly edit A in the agreed scope")) {
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
        assignment: "inspect then fix A",
        implementationAdvice: "first determine scope",
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
  for (const call of f.calls.filter((c) => c.body.model === "r1" && !isPreparation(c.body))) {
    const feedback = JSON.stringify(call.body.messages.findLast((m) => m.role === "user").content).includes("Now explicitly edit A in the agreed scope");
    const info = memberExecutionInfo(call.body);
    assert.equal(info.reason, "investigation");
    assert.equal(info.readOnly, !feedback);
    assert.deepEqual(info.scope, feedback ? ["a.txt"] : []);
    assert.deepEqual(info.readScope, ["."]);
    assert.deepEqual(info.checks, []);
  }
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
    if (isPreparation(c.body)) return {text: "Independent goal understood; inspect the original task within scope."};
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
              assignment: "inspect " + model,
              implementationAdvice: "read actual file",
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
    if (isPreparation(c.body)) return {text: "Independent goal understood; inspect the original task within scope."};
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
        assignment: "A",
        implementationAdvice: "change A",
        reason: "independent",
        scope: ["a.txt"],
      });
    if (n === 3) return tool("collect");
    if (n === 4) {
      a = latest(c.body, (r) => r.members).members[0].memberId;
      return tool("delegate", {
        model: "fixture/r2",
        assignment: "B",
        implementationAdvice: "change B",
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
      oldCalls = f.calls.filter((c) => c.body.model === "r1" && !isPreparation(c.body)).length;
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
        f.calls.filter((c) => c.body.model === "r1" && !isPreparation(c.body)).length,
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
  assert.equal(stages.length, 4);
  assert.equal(new Set(stages.map((s) => s.sessionFile)).size, 1);
  const changes = task.record.work.changes.filter(
    (c) => c.actor === "member:" + a,
  );
  assert.equal(changes.length, 2);
  assert.equal(changes[1].baseVersion, changes[0].acceptedVersion);
});

test("delegation blocks main across providers and known vendor-qualified aliases before transport", async t => {
  const {readFileSync, writeFileSync} = await import('node:fs');
  const {join} = await import('node:path');
  const repo = repository(t);
  let step = 0;
  const f = await fixture(t, c => {
    if (isPreparation(c.body)) return {text: "Independent goal understood; inspect the original task within scope."};
    step++;
    if(step === 1) return tool('start_work',{reason:'identity guards'});
    if(step === 2) return tool('delegate',{model:'mirror/openai/main',assignment:'alias clone',implementationAdvice:'inspect',reason:'inspect',scope:[],readOnly:true});
    if(step === 3) return tool('delegate',{model:'mirror/main',assignment:'provider clone',implementationAdvice:'inspect',reason:'inspect',scope:[],readOnly:true});
    return {text:'Identity checks complete'};
  });
  const p = join(f.home,'pi','models.json'), catalog = JSON.parse(readFileSync(p));
  catalog.providers.mirror = {...catalog.providers.fixture,models:['main','openai/main'].map(id=>({...catalog.providers.fixture.models[0],id,name:id}))};
  writeFileSync(p,JSON.stringify(catalog));
  const task = await runTurn({home:f.home,cwd:repo.project,input:'inspect',config:{formatVersion:2,...f.models,secondary:[{provider:'mirror',modelId:'main'},{provider:'mirror',modelId:'openai/main'}],work:{checks:[]}}});
  assert.equal(task.record.status,'completed',task.record.error);
  assert.equal(task.record.members.length,0);
  assert.equal(task.requests().filter(r=>r.phase==='worker').length,0);
  assert.equal(outputs(f.calls.at(-1).body).filter(o=>o.error?.code==='MODEL_UNAVAILABLE').length,2);
});

test("model occupancy blocks renamed clones and feedback switching without discarding drafts, then permits sequential reuse", async t => {
  const {readFileSync,writeFileSync}=await import('node:fs');
  const {join}=await import('node:path');
  const repo=repository(t); let step=0;
  const f=await fixture(t,c=>{
    if (isPreparation(c.body)) return {text: "Independent goal understood; inspect the original task within scope."};
    if(c.body.model==='r2') {
      const n=c.body.messages.filter(m=>m.role==='tool').length;
      return n===0?tool('read',{path:'a.txt'}):n===1?tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'preserved draft'}]}):{text:'Draft complete'};
    }
    if(c.body.model!=='main') return {text:'Inspection complete'};
    step++;
    const results=outputs(c.body), delegated=results.filter(o=>o.memberId && !o.changeId);
    const first=delegated[0]?.memberId, second=delegated[1]?.memberId;
    const delegate=model=>tool('delegate',{model,assignment:'inspect '+step,implementationAdvice:'Inspect source',reason:'different bounded task',scope:model==='fixture/r2'?['a.txt']:[],readOnly:model!=='fixture/r2'});
    if(step===1) return tool('start_work',{reason:'occupancy'});
    if(step===2) return delegate('fixture/kimi-k3.1-pro');
    if(step===3) return delegate('fixture/moonshotai/k3.1-pro');
    if(step===4) return delegate('fixture/r2');
    if(step===5) return tool('collect',{memberId:second});
    if(step===6) return tool('feedback',{memberId:second,model:'fixture/moonshotai/k3.1-pro',feedback:'Check a.txt specifically'});
    if(step===7) return tool('accept_change',{memberId:second});
    if(step===8) return tool('collect',{memberId:first});
    if(step===9) return delegate('fixture/moonshotai/k3.1-pro');
    if(step===10) return tool('collect',{});
    return {text:'done'};
  });
  const path=join(f.home,'pi','models.json'),catalog=JSON.parse(readFileSync(path));
  catalog.providers.fixture.models.push(...['kimi-k3.1-pro','moonshotai/k3.1-pro'].map(id=>({...catalog.providers.fixture.models[0],id,name:id})));
  writeFileSync(path,JSON.stringify(catalog));
  const secondary=[{provider:'fixture',modelId:'kimi-k3.1-pro'},{provider:'fixture',modelId:'moonshotai/k3.1-pro'},...f.models.secondary];
  const task=await runTurn({home:f.home,cwd:repo.project,input:'inspect',config:{formatVersion:2,...f.models,secondary,work:{checks:[]}}});
  assert.equal(task.record.status,'completed',task.record.error);
  assert.equal(task.record.members.length,3);
  assert.equal(task.record.members[1].model.modelId,'r2');
  assert.deepEqual(task.record.members[1].feedback,[]);
  assert.equal(task.record.members[1].status,'accepted');
  assert.equal(git(repo.project,'show',task.record.work.version+':a.txt'),'preserved draft');
  assert.equal(f.calls.filter(c=>c.body.model==='kimi-k3.1-pro').length,2);
  assert.equal(f.calls.filter(c=>c.body.model==='moonshotai/k3.1-pro').length,2);
  const errors=outputs(f.calls.at(-1).body).filter(o=>o.error?.code==='MEMBER_BUSY');
  assert.equal(errors.length,2);
  assert.ok(errors.every(o=>o.error.message.includes(task.record.members[0].memberId)));
  const context=f.calls[1].body.messages.flatMap(m=>typeof m.content==='string'?[m.content]:m.content.map(part=>part.text??'')).join('\n');
  assert.match(context,/Leader identity and catalog facts/);
  assert.match(context,/Eligible secondary models/);
  assert.match(context,/not independent experts/);
  assert.equal(context.match(/"actualModelIdentity":"kimi-k3.1-pro"/g)?.length,2);
  assert.match(context,/Reasoning is not enabled for this model/);
  assert.match(context,/Claude Opus5.5/);
  assert.match(context,/provisional choice/);
});

test("unknown model request cannot be bypassed by renamed delegation or abandoning the member", async t=>{
  const repo=repository(t);let step=0;
  const f=await fixture(t,(c,n,req,res)=>{
    if (isPreparation(c.body)) return {text: "Independent goal understood; inspect the original task within scope."};
    if(c.body.model==='r1'){res.destroy();return null;}
    if(c.body.model==='r2')return {text:'Other inspection completed'};
    step++;
    const delegated=outputs(c.body).filter(o=>o.memberId&&!o.changeId), member=delegated[1]?.memberId, other=delegated[0]?.memberId;
    if(step===1)return tool('start_work',{reason:'unknown request'});
    if(step===2)return tool('delegate',{model:'fixture/r2',assignment:'other model',implementationAdvice:'inspect',reason:'inspect',scope:[],readOnly:true});
    if(step===3)return tool('delegate',{model:'fixture/r1',assignment:'original',implementationAdvice:'inspect',reason:'inspect',scope:[],readOnly:true});
    if(step===4)return tool('collect',{memberId:member});
    if(step===5)return tool('delegate',{model:'fixture/r1',assignment:'renamed',implementationAdvice:'other',reason:'inspect again',scope:[],readOnly:true});
    if(step===6)return tool('abandon_member',{memberId:member,reason:'retain unknown evidence'});
    if(step===7)return tool('delegate',{model:'fixture/r1',assignment:'third name',implementationAdvice:'other',reason:'inspect again',scope:[],readOnly:true});
    if(step===8)return tool('collect',{memberId:other});
    if(step===9)return tool('feedback',{memberId:other,model:'fixture/r1',feedback:'Inspect a.txt instead'});
    return {text:'unknown remains unknown'};
  });
  const task=await runTurn({home:f.home,cwd:repo.project,input:'inspect',config:{formatVersion:2,...f.models,work:{checks:[]}}});
  assert.equal(f.calls.filter(c=>c.body.model==='r1').length,2);
  assert.equal(task.record.members.length,2);
  assert.equal(task.requests().filter(r=>r.phase==='worker'&&r.status==='outcome_unknown').length,1);
  assert.equal(outputs(f.calls.at(-1).body).filter(o=>o.error?.code==='MEMBER_BUSY').length,3);
});

test("/one rejects a forged delegate tool call without member transport", async t=>{
  const repo=repository(t);let step=0;
  const f=await fixture(t,()=>++step===1?tool('start_work',{reason:'single model'}):step===2?tool('delegate',{model:'fixture/r1',assignment:'forged',implementationAdvice:'inspect',reason:'inspect',scope:[],readOnly:true}):{text:'done'});
  const task=await runTurn({home:f.home,cwd:repo.project,input:'/one inspect',config:{formatVersion:2,...f.models,work:{checks:[]}}});
  assert.equal(task.record.status,'completed',task.record.error);
  assert.equal(task.record.members.length,0);
  assert.ok(f.calls.every(c=>c.body.model==='main'));
  assert.ok(f.calls.slice(1).every(c=>!c.body.tools.some(tool=>tool.function.name==='delegate')));
});

test('known aliases are blocked while distinct version IDs remain eligible', async t=>{
  const {readFileSync,writeFileSync}=await import('node:fs');
  const {join}=await import('node:path');
  for(const [mainId,targetId,allowed] of [
    ['kimi-k3.1-pro','moonshotai/kimi-k3.1-pro',false],
    ['kimi-k3.1-pro','k3.1-pro',false],
    ['kimi-k3.1-pro','moonshotai/k3.1-pro',false],
    ['k3.1-pro','moonshotai/kimi-k3.1-pro',false],
    ['kimi-k3.1-pro','k3.1-pro-highspeed',true],
    ['claude-opus-5-5','anthropic/claude-opus-5.5',false],
    ['claude-opus-5-5','anthropic.claude-opus-5-5',false],
    ['deepseek-v4.1-flash-1017','deepseek/deepseek-v4.1-flash1017',false],
    ['kimi-k3.1-pro','kimi-k3.1-pro-20261026',true],
  ]) await t.test(targetId,async t=>{
    const repo=repository(t);let step=0;
    const f=await fixture(t,c=>{
    if (isPreparation(c.body)) return {text: "Independent goal understood; inspect the original task within scope."};
      if(c.body.model===targetId)return {text:'Distinct version inspected'};
      step++;
      if(step===1)return tool('start_work',{reason:'known identity'});
      if(step===2)return tool('delegate',{model:'fixture/'+targetId,assignment:'inspect',implementationAdvice:'Inspect actual files',reason:'bounded inspection',scope:[],readOnly:true});
      if(step===3)return tool('collect',{});
      return {text:'done'};
    });
    const p=join(f.home,'pi','models.json'),catalog=JSON.parse(readFileSync(p));
    catalog.providers.fixture.models=[mainId,targetId].map(id=>({...catalog.providers.fixture.models[0],id,name:id}));
    writeFileSync(p,JSON.stringify(catalog));
    const task=await runTurn({home:f.home,cwd:repo.project,input:'inspect',config:{formatVersion:2,main:{provider:'fixture',modelId:mainId},secondary:[{provider:'fixture',modelId:targetId}],work:{checks:[]}}});
    assert.equal(task.record.status,'completed',task.record.error);
    assert.equal(f.calls.filter(c=>c.body.model===targetId).length,allowed?2:0);
    assert.equal(task.record.members.length,allowed?1:0);
  });
});

for (const original of ['制作自行车骑鹈鹕的动画。', '制作鹈鹕骑自行车的动画。']) {
  test(`fidelity: preparation sees verbatim source before delegated interpretation: ${original}`, async t => {
    const repo = repository(t);
    let mainN = 0, workerN = 0, memberId;
    const advice = '错误委派哨兵：按另一种骑乘关系制作';
    const f = await fixture(t, c => {
      if (c.body.model === 'r1') {
        workerN++;
        const payload = JSON.stringify(c.body.messages);
        assert.ok(payload.includes(original));
        assert.match(payload, /user.*language/is);
        if (workerN === 1) {
          assert.ok(!payload.includes(advice));
          assert.ok(!payload.includes('职责哨兵'));
          assert.ok(!payload.includes('理由哨兵'));
          assert.ok(!payload.includes('伪造原题覆盖'));
          assert.match(payload,/中文技能原文/);
          assert.deepEqual(c.body.tools.map(x=>x.function.name).sort(), ['find','grep','ls','read']);
          return {text: '独立理解：'+original};
        }
        assert.ok(payload.includes(advice));
        assert.ok(payload.includes('职责哨兵'));
        return {text: '只读调查结果，原题保持。'};
      }
      mainN++;
      if(mainN===1)return tool('start_work',{reason:'inspect task'});
      if(mainN===2)return tool('delegate',{model:'fixture/r1',assignment:'职责哨兵：只读调查',implementationAdvice:advice,reason:'理由哨兵',originalTask:'伪造原题覆盖',scope:[],readOnly:true});
      if(mainN===3){memberId=outputs(c.body).at(-1).memberId;return tool('collect',{memberId});}
      return {text:'调查已结束'};
    });
    const skill=join(f.home,'fidelity-skill.md');
    writeFileSync(skill,'---\nname: source-fidelity\ndescription: Check the original task\n---\n中文技能原文：保留主体、动作和方向。');
    const task=await runTurn({home:f.home,cwd:repo.project,input:original,config:{formatVersion:2,...f.models,piResources:{skills:[skill]},work:{checks:[]}}});
    assert.equal(task.record.status,'completed',task.record.error);
    assert.equal(workerN,2);
    assert.equal(task.record.members[0].understanding,'独立理解：'+original);
    assert.ok(task.record.members[0].understandingCallId);
    assert.equal(task.requests().filter(r=>r.phase==='worker-prepare').length,1);
    mkdirSync('work/task-fidelity/requests',{recursive:true});
    writeFileSync('work/task-fidelity/requests/member-'+(original.startsWith('制作自行车')?'bicycle':'pelican')+'.json',JSON.stringify({original,calls:f.calls.filter(c=>c.body.model==='r1').map(c=>c.body),understanding:task.record.members[0].understanding},null,2));
  });
}

for(const failure of ['empty','503'])test(`fidelity: ${failure} preparation cannot enable writes or replay`,async t=>{
  const repo=repository(t);let mainN=0, workerN=0;
  const f=await fixture(t,c=>{
    if(c.body.model==='r1'){workerN++;assert.ok(!c.body.tools.some(x=>['write','edit','bash','preview_html'].includes(x.function.name)));return failure==='503'?{error:503}:{text:''};}
    mainN++;
    if(mainN===1)return tool('start_work',{reason:'work'});
    if(mainN===2)return tool('delegate',{model:'fixture/r1',assignment:'edit a',reason:'bounded',scope:['a.txt']});
    if(mainN===3)return tool('collect');
    return {text:'已有失败，保留草稿'};
  });
  const task=await runTurn({home:f.home,cwd:repo.project,input:'原题',config:{formatVersion:2,...f.models,work:{checks:[]}}});
  assert.equal(workerN,1);assert.notEqual(task.record.status,'completed');
  assert.equal(task.record.members[0].status,'failed');
  assert.equal(task.record.work.acceptance.length,0);
  assert.ok(!task.record.tools?.some(x=>['write','edit','bash'].includes(x.name)));
});

for(const resolves of [false,true])test(`fidelity conflict: preserves draft, blocks acceptance, member confirmation=${resolves}`,async t=>{
  const repo=repository(t);let mainN=0, workerN=0, memberId;
  const original='自行车骑鹈鹕';
  const correction='撤回“鹈鹕骑车”的错误建议，请按原题自行车骑鹈鹕继续。';
  const f=await fixture(t,c=>{
    if(c.body.model==='r1'){
      workerN++;
      if(workerN===1)return {text:'自行车是骑乘者，鹈鹕承载它。'};
      if(workerN===2)return tool('write',{path:'draft.txt',content:'preserved draft'});
      if(workerN===3)return {toolCalls:[
        {name:'report_task_conflict',args:{message:'原题“自行车骑鹈鹕”，建议却是“鹈鹕骑车”。'}},
        {name:'write',args:{path:'draft.txt',content:'MUST NOT WRITE AFTER CONFLICT'}},
      ]};
      if(workerN===4){
        assert.ok(JSON.stringify(c.body).includes(correction));
        assert.ok(!c.body.tools.some(t=>t.function.name==='write'));
        return resolves?tool('report_task_conflict',{message:'已核对原题与更正，自行车是骑乘者。',resolved:true}):{text:'尚未确认'};
      }
      assert.equal(workerN,5);
      return {text:'保留现有草稿完成交接'};
    }
    mainN++;
    if(mainN===1)return tool('start_work',{reason:'work'});
    if(mainN===2)return tool('delegate',{model:'fixture/r1',assignment:'负责 draft.txt',implementationAdvice:'鹈鹕骑车',reason:'bounded',scope:['draft.txt']});
    if(mainN===3){memberId=outputs(c.body).at(-1).memberId;return tool('collect',{memberId});}
    if(mainN===4){assert.equal(outputs(c.body).at(-1).members[0].taskConflict.unresolved,true);return tool('accept_change',{memberId});}
    if(mainN===5){assert.equal(outputs(c.body).at(-1).error.code,'TASK_CONFLICT');return tool('feedback',{memberId,feedback:correction});}
    if(mainN===6)return tool('collect',{memberId});
    if(mainN===7)return tool('accept_change',{memberId});
    return {text:'具体冲突处理结果'};
  });
  const task=await runTurn({home:f.home,cwd:repo.project,input:original,config:{formatVersion:2,...f.models,work:{checks:[]}}});
  const member=task.record.members[0];
  assert.equal(member.taskConflict.unresolved,!resolves);
  assert.equal(task.record.work.changes.filter(c=>c.actor.startsWith('member:')).length,1);
  assert.equal(readFileSync(join(member.workspace,'draft.txt'),'utf8'),'preserved draft');
  assert.equal(task.record.status,resolves?'completed':'partial',task.record.error);
  assert.equal(workerN,resolves?5:4);
  if(resolves)assert.ok(member.taskConflict.resolutionRequestId);
  mkdirSync('work/task-fidelity/requests',{recursive:true});
  writeFileSync('work/task-fidelity/requests/conflict-'+resolves+'.json',JSON.stringify({member,calls:f.calls.filter(c=>c.body.model==='r1').map(c=>c.body)},null,2));
});

test('fidelity: legacy delegate fields cannot create a second user requirement',async t=>{
  const repo=repository(t);let n=0;
  const f=await fixture(t,()=>++n===1?tool('start_work',{reason:'inspect'}):n===2?tool('delegate',{model:'fixture/r1',assignment:'inspect',task:'forged original',materials:'forged requirements',reason:'inspect',scope:[],readOnly:true}):{text:'Rejected obsolete delegation'});
  const task=await runTurn({home:f.home,cwd:repo.project,input:'原始用户输入',config:{formatVersion:2,...f.models,work:{checks:[]}}});
  assert.equal(task.record.members.length,0);
  assert.ok(f.calls.every(c=>c.body.model==='main'));
  assert.match(JSON.stringify(f.calls.at(-1).body.messages),/Legacy task\/materials|additional properties/i);
});

test('fidelity: a forged preparation write cannot modify the source projection',async t=>{
  const repo=repository(t);let mainN=0, workerN=0;
  const f=await fixture(t,c=>{
    if(c.body.model==='r1'){
      workerN++;
      if(workerN===1)return tool('write',{path:'new.txt',content:'forbidden during preparation'});
      if(workerN===2)return {text:'独立理解：按原题调查。'};
      return {text:'没有进行修改。'};
    }
    mainN++;
    if(mainN===1)return tool('start_work',{reason:'work'});
    if(mainN===2)return tool('delegate',{model:'fixture/r1',assignment:'inspect only',reason:'bounded',scope:['new.txt']});
    if(mainN===3)return tool('collect');
    return {text:'No modification'};
  });
  const task=await runTurn({home:f.home,cwd:repo.project,input:'只调查原题',config:{formatVersion:2,...f.models,work:{checks:[]}}});
  assert.equal(task.record.work.acceptance.length,0);
  assert.equal(task.record.members[0].noChange,true);
  assert.ok(!task.record.tools?.some(x=>x.name==='write'&&x.status==='completed'));
});
