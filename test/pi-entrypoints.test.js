import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/pi-fixture.js";
import { repository } from "./helpers/git-fixture.js";
import { invoke } from "./helpers/cli-fixture.js";
import { saveConfig } from "../src/config.js";
const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
test("work ask/pipe/print/JSON/show/history use the same checked completion and zero-call queries", async (t) => {
  for (const args of [
    ["ask", "--json", "/one work"],
    ["--print"],
    ["ask", "/one work"],
  ]) {
    const repo = repository(t);
    const f = await fixture(t, (c, n) =>
      n === 1
        ? tool("start_work", { reason: "edit", scope: ["a.txt"] })
        : n === 2
          ? tool("read", { path: "a.txt" })
          : n === 3
            ? tool("edit", {
                path: "a.txt",
                edits: [{ oldText: "base A", newText: "done" }],
              })
            : n === 4
              ? tool("accept_change")
              : { text: "work final" },
    );
    saveConfig(f.home, { formatVersion: 2, ...f.models });
    const run = await invoke(
      f,
      args,
      args.includes("--print") ? "/one work" : "",
      repo.project,
    );
    assert.equal(run.code, 0, run.stderr);
    let id;
    if (args.includes("--json")) {
      const r = JSON.parse(run.stdout);
      assert.equal(r.taskEnd, "completed");
      assert.equal(r.requests.length, 5);
      id = r.task.id;
    } else {
      assert.match(run.stdout, /work final/);
      assert.match(run.stdout, /未验证/);
      id = JSON.parse((await invoke(f, ["history", "--json"])).stdout)[0].id;
    }
    const before = f.calls.length;
    const show = await invoke(f, ["show", id, "--all"]);
    assert.match(show.stdout, /Pi 工具原文/);
    assert.match(show.stdout, /candidateVersion|candidate/);
    const saved = JSON.parse((await invoke(f, ["show", id, "--json"])).stdout);
    assert.equal(saved.taskEnd, "completed");
    assert.equal(f.calls.length, before);
  }
});
test("failed work print/JSON return nonzero without presenting model assertion as final", async (t) => {
  const repo = repository(t);
  const f = await fixture(t, (c, n) =>
    n === 1
      ? tool("start_work", { reason: "edit" })
      : n === 2
        ? tool("write", { path: "a.txt", content: "unfinished" })
        : { text: "I finished all work" },
  );
  saveConfig(f.home, { formatVersion: 2, ...f.models });
  const r = await invoke(f, ["ask", "--json", "/one edit"], "", repo.project);
  assert.equal(r.code, 1);
  const saved = JSON.parse(r.stdout);
  assert.equal(saved.taskEnd, "partial");
  assert.equal(saved.task.finalCallId, null);
  assert.match(r.stderr, /未完成/);
});
test("CLI announces an explicit output cap and timeout that match the actual provider wire", async (t) => {
  const f = await fixture(t);
  saveConfig(f.home, { formatVersion: 2, ...f.models });
  const run = await invoke(f, [
    "ask",
    "--one",
    "--max-output-tokens",
    "99",
    "--timeout",
    "2000",
    "q",
  ]);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(
    f.calls[0].body.max_completion_tokens ?? f.calls[0].body.max_tokens,
    99,
  );
  assert.match(run.stderr, /输出额度 99 tokens/);
  assert.match(run.stderr, /模型超时 2000ms/);
  assert.equal(f.calls.length, 1);
});
