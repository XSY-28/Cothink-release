import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
const view = await import("../gui/src/view.js").catch(() => ({}));
const api = await import("../gui/src/api.js").catch(() => ({}));
const markdown = await import("../gui/src/Markdown.js").catch(() => ({}));

test("composer only sends unmodified Enter outside IME composition", () => {
  assert.equal(
    typeof view.shouldSubmit,
    "function",
    "composer key policy exists",
  );
  for (const event of [
    { key: "Enter", isComposing: true },
    { key: "Enter", keyCode: 229 },
    { key: "Enter", shiftKey: true },
    { key: "Enter", ctrlKey: true },
    { key: "Enter", altKey: true },
    { key: "a" },
  ])
    assert.equal(view.shouldSubmit(event), false);
  assert.equal(view.shouldSubmit({ key: "Enter" }), true);
});
test("elapsed time uses persisted start/end and keeps absent terminal timestamps unknown", () => {
  assert.equal(typeof view.elapsedLabel, "function");
  assert.equal(
    view.elapsedLabel(
      { status: "running", createdAt: "2026-10-23T00:00:00Z" },
      Date.parse("2026-10-23T00:01:05Z"),
    ),
    "1分05秒",
  );
  assert.equal(
    view.elapsedLabel({
      status: "completed",
      createdAt: "2026-10-23T00:00:00Z",
      endedAt: "2026-10-23T00:00:08Z",
    }),
    "8秒",
  );
  assert.equal(
    view.elapsedLabel({
      status: "outcome_unknown",
      createdAt: "2026-10-23T00:00:00Z",
    }),
    "用时未知",
  );
});
test("pending confirmation uses GET only and exact durable submission identity after reload", async () => {
  assert.equal(typeof api.createApi, "function", "API client exists");
  const requests = [];
  const client = api.createApi("tab-only-token", async (url, options) => {
    requests.push({ url, options });
    return new Response(
      JSON.stringify({
        id: "s",
        turns: [
          { taskId: "wrong", submissionId: "other" },
          { taskId: "accepted", submissionId: "pending" },
        ],
      }),
    );
  });
  const pending = JSON.parse(
    JSON.stringify({ sessionId: "s", submissionId: "pending" }),
  );
  assert.equal((await client.recover(pending)).taskId, "accepted");
  assert.equal(
    await client.recover({ sessionId: "s", submissionId: "unseen" }),
    null,
  );
  assert.deepEqual(
    requests.map((r) => r.options.method),
    ["GET", "GET"],
  );
  assert.equal(
    requests[0].options.headers.Authorization,
    "Bearer tab-only-token",
  );
});
test("unknown action response never retries and remains distinguishable from a rejection", async () => {
  assert.equal(typeof api.createApi, "function");
  let calls = 0;
  const client = api.createApi("token", async () => {
    calls++;
    throw Error("connection lost");
  });
  await assert.rejects(
    client.action("task.submit", { submissionId: "one" }),
    (e) => e.unknown === true,
  );
  assert.equal(calls, 1);
  const rejected = api.createApi(
    "token",
    async () =>
      new Response(JSON.stringify({ error: "Team missing" }), { status: 400 }),
  );
  await assert.rejects(
    rejected.action("task.submit", {}),
    (e) => e.unknown === false && /Team missing/.test(e.message),
  );
});
test("startup token is removed from address and kept only in the current tab", () => {
  assert.equal(typeof api.consumeToken, "function");
  const win = new Window({ url: "http://127.0.0.1:9000/#token=secret" });
  assert.equal(api.consumeToken(win), "secret");
  assert.equal(win.location.hash, "");
  assert.equal(win.localStorage.length, 0);
  assert.equal(api.consumeToken(win), "secret");
});
test("untrusted Markdown keeps math and code readable while excluding HTML and image requests", () => {
  assert.equal(typeof markdown.Markdown, "function", "safe renderer exists");
  const html = renderToStaticMarkup(
    React.createElement(markdown.Markdown, {
      text: '# 标题\n\n<script>alert(1)</script>\n\n<img src="https://private/image">\n\n![secret](https://private/pixel)\n\n[bad](javascript:alert(1))\n\n```js\n<img onerror=alert(1)>\n```\n\n$x^2$',
    }),
  );
  assert.doesNotMatch(html, /<script|<img|href="javascript:/);
  assert.match(html, /&lt;img onerror/);
  assert.match(html, /katex/);
  assert.match(html, /标题/);
});
test("empty check policies never become passed and unknown revision headings retain original text", () => {
  assert.equal(typeof view.checkLabel, "function");
  assert.match(
    view.checkLabel({ status: "passed", verification: "unverified" }),
    /未验证/,
  );
  assert.match(
    view.checkLabel({ status: "passed", verification: "passed" }),
    /通过/,
  );
  assert.doesNotMatch(view.checkLabel(null), /通过/);
  assert.equal(
    view.revisionExplanation("Final\n\n## Unknown heading\nOriginal"),
    null,
  );
  assert.equal(
    view.revisionExplanation(
      "Answer\n\n## 对评审意见的处理说明\nKept this reason\n\n## Next\nMore",
    ),
    "Kept this reason",
  );
  assert.equal(
    view.revisionExplanation(
      "```\n## 对评审意见的处理说明\nnot a section\n```",
    ),
    null,
  );
});
test("draft refreshes and delayed submission acknowledgements preserve newer typing and session ownership", () => {
  assert.equal(typeof view.createDraftBook, "function");
  const book = view.createDraftBook();
  book.load("a", "saved");
  book.edit("a", "sending");
  const submitted = book.snapshot("a");
  book.edit("a", "next unsent thought");
  book.load("a", "saved");
  book.load("b", "other session");
  book.accepted(submitted);
  assert.equal(book.snapshot("a").text, "next unsent thought");
  assert.equal(book.snapshot("b").text, "other session");
  book.accepted(book.snapshot("b"));
  assert.equal(book.snapshot("b").text, "");
});

test('the observed work_starting phase has a readable Chinese label',()=>{
 assert.equal(view.phaseLabel('work_starting'),'准备项目');
});
