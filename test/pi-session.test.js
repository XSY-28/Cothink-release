import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers/pi-fixture.js";
import { invoke as invokeBytes } from "./helpers/cli-fixture.js";
import { saveConfig } from "../src/config.js";
import { request } from "node:http";

test("HTTP fixture preserves UTF-8 characters split between request chunks", async (t) => {
  const f = await fixture(t);
  const content = '中文"quoted"\nnext line';
  const body = Buffer.from(JSON.stringify({ model: "main", messages: [{ role: "user", content }] }));
  const split = body.indexOf(Buffer.from("中")) + 1;
  await new Promise((resolve, reject) => {
    const req = request(f.endpoint + "/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", "Content-Length": body.length },
    }, res => { res.resume(); res.once("end", resolve); res.once("error", reject); });
    req.once("error", reject);
    req.write(body.subarray(0, split));
    setTimeout(() => req.end(body.subarray(split)), 30);
  });
  assert.equal(f.calls[0].body.messages[0].content, content);
});
const cli = process.env.COTHINK_TEST_CLI ?? fileURLToPath(new URL("../bin/cothink.js", import.meta.url));
export function invoke(f, args, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, COTHINK_HOME: f.home, COTHINK_NO_TTY: "1", PI_OFFLINE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
test("CLI parameter/pipe/JSON/history/show share Pi host completion and query is zero calls", async (t) => {
  const f = await fixture(t, (c, n) => ({
    text:
      n === 1
        ? "DRAFT"
        : c.body.model === "main"
          ? "FINAL\n\n## 对评审意见的处理说明\nNOTES"
          : "REVIEW",
  }));
  saveConfig(f.home, { formatVersion: 2, ...f.models });
  const answer = await invoke(f, ["ask", "--json", "q"]);
  assert.equal(answer.code, 0, answer.stderr);
  const result = JSON.parse(answer.stdout);
  assert.equal(result.task.status, "completed");
  assert.equal(result.requests.length, 3);
  assert.equal(f.calls.length, 3);
  const show = await invoke(f, ["show", result.task.id]);
  assert.equal(show.stdout.trim(), "FINAL");
  const all = await invoke(f, ["show", result.task.id, "--all"]);
  assert.match(all.stdout, /DRAFT/);
  assert.match(all.stdout, /NOTES/);
  const history = await invoke(f, ["history", "--json"]);
  assert.ok(JSON.parse(history.stdout).some((r) => r.id === result.task.id));
  assert.equal(f.calls.length, 3);
});
test("partial print exits nonzero and does not print draft as final", async (t) => {
  const f = await fixture(t, (c) =>
    c.body.model === "r1" ? { error: 400 } : { text: "DRAFT OR REVIEW" },
  );
  saveConfig(f.home, { formatVersion: 2, ...f.models });
  const result = await invoke(f, ["ask", "question"]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /show|未完成/);
  assert.equal(f.calls.length, 2);
});
test("long streamed replies survive discussion, JSON export and history unchanged", async (t) => {
  const text = '长回答 {"text":"引号和换行\\n"} 😄\n'.repeat(1800) + "LONG_REPLY_END";
  const f = await fixture(t, (call, n, req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (content, finish_reason = null) =>
      res.write("data: " + JSON.stringify({
        id: "long-reply",
        object: "chat.completion.chunk",
        model: call.body.model,
        choices: [{ index: 0, delta: { content }, finish_reason }],
      }) + "\n\n");
    for (let i = 0; i < text.length; i += 512) chunk(text.slice(i, i + 512));
    chunk("", "stop");
    res.end("data: [DONE]\n\n");
    return null;
  });
  saveConfig(f.home, { formatVersion: 2, ...f.models });
  const run = await invokeBytes(f, ["ask", "--json", "长回答"]);
  assert.equal(run.code, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.taskEnd, "completed");
  assert.equal(result.requests.length, 3);
  for (const call of result.requests) {
    assert.equal(call.text, text);
    assert.equal(call.response.content[0].text, text);
    assert.equal(call.limits.maxOutputTokens, null);
    assert.ok(!("max_tokens" in call.payload));
    assert.ok(!("max_completion_tokens" in call.payload));
  }
  const contentText = (content) => typeof content === "string"
    ? content : content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
  const review = JSON.parse(contentText(f.calls[1].body.messages.findLast((m) => m.role === "user").content));
  assert.equal(review.draft.text, text);
  assert.ok(f.calls[2].body.messages.some((m) => m.role === "assistant" && contentText(m.content) === text));
  const show = await invokeBytes(f, ["show", result.task.id]);
  assert.equal(show.stdout.trimEnd(), text);
  const saved = JSON.parse((await invokeBytes(f, ["show", result.task.id, "--json"])).stdout);
  assert.deepEqual(saved.requests.map((r) => r.text), [text, text, text]);
  assert.equal(f.calls.length, 3, "history never generates again");
});
for (const [phase, index] of [["draft", 1], ["review", 2], ["revision", 3]]) {
  test(`provider default limit produces honest partial at ${phase}; explicit cap completes`, async (t) => {
    const text = "完整长回答".repeat(1500) + "END";
    let attemptCalls = 0;
    const f = await fixture(t, (call, n) => {
      const cap = call.body.max_tokens ?? call.body.max_completion_tokens;
      return ++attemptCalls === index && cap === undefined
        ? { text: text.slice(0, 4096), finish: "length" }
        : { text };
    });
    saveConfig(f.home, { formatVersion: 2, ...f.models });
    const run = await invokeBytes(f, ["ask", "--json", "长回答"]);
    assert.equal(run.code, 1);
    const result = JSON.parse(run.stdout);
    assert.equal(result.taskEnd, "partial");
    assert.equal(result.task.finalCallId, null);
    assert.equal(f.calls.length, index, "no retry or later phase after truncation");
    const last = result.requests.at(-1);
    assert.equal(last.phase, phase);
    assert.equal(last.text, text.slice(0, 4096));
    assert.equal(last.response.stopReason, "length");
    assert.match(result.task.error, /length/);
    assert.match(result.task.error, /服务商默认/);
    assert.match(run.stderr, /--max-output-tokens/);
    const show = JSON.parse((await invokeBytes(f, ["show", result.task.id, "--json"])).stdout);
    assert.equal(show.taskEnd, "partial");
    assert.equal(show.requests.at(-1).text, last.text);
    assert.equal(f.calls.length, index);
    attemptCalls = 0;
    const complete = await invokeBytes(f, ["ask", "--json", "--max-output-tokens", "32768", "长回答"]);
    assert.equal(complete.code, 0, complete.stderr);
    assert.equal(JSON.parse(complete.stdout).taskEnd, "completed");
    assert.deepEqual(f.calls.slice(index).map((c) => c.body.max_tokens ?? c.body.max_completion_tokens), [32768, 32768, 32768]);
  });
}
