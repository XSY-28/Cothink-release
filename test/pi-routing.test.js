import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/pi-fixture.js";
const api = await import("../src/discussion.js");
test("start_work counts routing once and explicitly refuses non-Git project work", async (t) => {
  assert.equal(typeof api.runTurn, "function");
  const f = await fixture(t, (call, n, req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const delta of [
      {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "route-work",
            type: "function",
            function: { name: "start_work", arguments: '{"reason":"edit project"}' },
          },
        ],
      },
      {},
    ])
      res.write(
        "data: " +
          JSON.stringify({
            id: "x",
            choices: [{ index: 0, delta, finish_reason: delta.role ? null : "tool_calls" }],
          }) +
          "\n\n",
      );
    res.end("data: [DONE]\n\n");
    return null;
  });
  const result = await api.runTurn({
    home: f.home,
    cwd: f.cwd,
    input: "edit project",
    singleModel: true,
    config: { formatVersion: 2, ...f.models },
  });
  assert.equal(result.record.mode, "work");
  assert.equal(result.record.status, "failed");
  assert.match(result.record.error,/不是 Git 仓库/);
  assert.equal(result.record.maxCalls, null);
  assert.equal(f.calls.length, 1);
});
