import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { setupIO } from "../src/terminal.js";

// This narrow renderer models readline's current-line cursor/erase operations.
// Searching raw output is insufficient: a later CSI 0J can erase the prompt.
function visibleLine(raw) {
  let cells = [], cursor = 0;
  for (const token of raw.matchAll(/\x1b\[([0-9;]*)([A-Za-z])|([^\x1b])/gu)) {
    if (token[2] === "G") cursor = Math.max(0, Number(token[1] || 1) - 1);
    else if (token[2] === "J" || token[2] === "K") cells.length = cursor;
    else if (token[3] === "\n") { cells = []; cursor = 0; }
    else if (token[3] === "\r") cursor = 0;
    else if (token[3]) cells[cursor++] = token[3];
  }
  return cells.join("").trimEnd();
}
function fixture(t) {
  const previous = process.env.TERM;
  process.env.TERM = "xterm-256color";
  const input = new PassThrough(), chunks = [];
  input.setRawMode = () => {};
  const output = new Writable({ write(chunk, encoding, done) { chunks.push(chunk.toString()); done(); } });
  const io = setupIO({ input, output });
  t.after(() => { io.close(); input.destroy(); if (previous === undefined) delete process.env.TERM; else process.env.TERM = previous; });
  return { io, input, raw: () => chunks.join("") };
}

test("setup text prompt remains visible after terminal cursor/erase redraw", async (t) => {
  const f = fixture(t);
  const answer = f.io.prompt({ type: "text", message: "team 名称" });
  assert.match(visibleLine(f.raw()), /team 名称:$/);
  f.input.write("日常讨论\n");
  assert.equal(await answer, "日常讨论");
});

test("setup selection prompt remains visible and accepts an ID", async (t) => {
  const f = fixture(t);
  const answer = f.io.select("确认保存 team", [{ id: "save", label: "保存" }, { id: "cancel", label: "取消" }]);
  assert.match(visibleLine(f.raw()), /输入编号或 ID:$/);
  f.input.write("save\n");
  assert.equal(await answer, "save");
});

test("secret setup input keeps its label visible and never echoes the key", async (t) => {
  const f = fixture(t);
  const answer = f.io.prompt({ type: "secret", message: "API Key" });
  assert.match(visibleLine(f.raw()), /API Key:$/);
  f.input.write("fixture-private-key\n");
  assert.equal(await answer, "fixture-private-key");
  assert.doesNotMatch(f.raw(), /fixture-private-key/);
});
