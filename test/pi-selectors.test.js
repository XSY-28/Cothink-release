import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import * as api from "../src/selection.js";

const theme = { fg: (_color, text) => text, bold: text => text };
const options = Array.from({ length: 180 }, (_, i) => `fixture/model-${String(i).padStart(3, "0")}`);
function selector(rows = 24, labels = options, title = "选择模型") {
  assert.equal(typeof api.selectOption, "function", "host selections need a bounded, scrollable component");
  const tui = { terminal: { rows }, requestRender() {} };
  let component, settled = false, value;
  const promise = api.selectOption({ custom(factory) {
    return new Promise(resolve => {
      component = factory(tui, theme, getKeybindings(), result => {
        settled = true; value = result; resolve(result);
      });
    });
  } }, title, labels);
  return { tui, component, promise, settled: () => settled, value: () => value };
}
const mouse = (type, y, wheelDelta) => ({ type, button: type === "wheel" ? "none" : "left", x: 3, y,
  screenX: 3, screenY: y, width: 80, height: 22, shift: false, alt: false, ctrl: false, wheelDelta });

test("long model lists keep the selected item and controls inside the terminal", async () => {
  const f = selector();
  let frame = f.component.render(80);
  assert.ok(frame.length <= 22);
  assert.match(frame.join("\n"), /→.*model-000/);
  assert.doesNotMatch(frame.join("\n"), /model-179/);
  for (let i = 0; i < 60; i++) f.component.handleInput("\x1b[B");
  frame = f.component.render(80);
  assert.ok(frame.length <= 22);
  assert.match(frame.join("\n"), /→.*model-060/);
  assert.match(frame.at(-1), /Esc/);
  f.component.handleInput("\r");
  assert.equal(await f.promise, "fixture/model-060");
});

test("paging and first/last shortcuts reach options beyond the visible page", async () => {
  const f = selector(12);
  const count = f.component.render(80).filter(line => line.includes("fixture/model-")).length;
  f.component.handleInput("\x1b[6~");
  const expected = `fixture/model-${String(count).padStart(3, "0")}`;
  assert.ok(f.component.render(80).some(line => line.includes("→") && line.includes(expected)));
  f.component.handleInput("\x1b[F");
  assert.match(f.component.render(80).join("\n"), /→.*model-179/);
  f.component.handleInput("\x1b[5~");
  assert.doesNotMatch(f.component.render(80).find(line => line.includes("→")), /model-179/);
  f.component.handleInput("\x1b[H");
  assert.match(f.component.render(80).join("\n"), /→.*model-000/);
  f.component.handleInput("\x1b");
  assert.equal(await f.promise, undefined);
});

test("wheel navigation changes the visible selection without confirming it", async () => {
  const f = selector(); f.component.render(80);
  for (let i = 0; i < 70; i++) assert.equal(f.component.handleMouse(mouse("wheel", 3, 1))?.handled, true);
  assert.equal(f.settled(), false);
  assert.match(f.component.render(80).join("\n"), /→.*model-070/);
  f.component.handleMouse(mouse("wheel", 3, -1));
  assert.match(f.component.render(80).join("\n"), /→.*model-069/);
  f.component.handleInput("\r");
  assert.equal(await f.promise, "fixture/model-069");
});

test("mouse selection maps visible rows back to their original option", async () => {
  const f = selector(12);
  f.component.render(80); for (let i = 0; i < 60; i++) f.component.handleInput("\x1b[B");
  const frame = f.component.render(80), row = frame.findIndex(line => line.includes("model-061"));
  assert.ok(row > 0);
  f.component.handleMouse(mouse("press", row));
  f.component.render(80);
  f.component.handleMouse(mouse("click", row));
  assert.equal(await f.promise, "fixture/model-061");
});

test("resize preserves selection and bounds long Chinese titles and options", async () => {
  const labels = [...options]; labels[179] = "fixture/" + "很长的模型名称".repeat(25);
  const f = selector(24, labels, "当前阵容：" + "主副模型说明".repeat(150));
  f.component.render(80); f.component.handleInput("\x1b[F");
  for (const [rows, width] of [[24, 80], [12, 40], [8, 30], [30, 100]]) {
    f.tui.terminal.rows = rows;
    const frame = f.component.render(width);
    assert.ok(frame.length <= rows - 2, `${frame.length} rows in ${rows}`);
    assert.ok(frame.every(line => visibleWidth(line) <= width));
    assert.ok(frame.some(line => line.includes("→")));
  }
  f.component.handleInput("\r");
  assert.equal(await f.promise, labels[179]);
});

test("an unusably small window preserves selection and blocks accidental confirmation", async () => {
  const f = selector(); f.component.render(80); f.component.handleInput("\x1b[F");
  f.tui.terminal.rows = 3;
  assert.ok(f.component.render(10).length <= 3);
  f.component.handleInput("\r"); assert.equal(f.settled(), false);
  f.tui.terminal.rows = 24;
  assert.match(f.component.render(80).join("\n"), /→.*model-179/);
  f.component.handleInput("\r"); assert.equal(await f.promise, options[179]);
});

test("empty lists can cancel and cannot confirm a nonexistent option", async () => {
  const f = selector(12, []); f.component.render(40);
  f.component.handleInput("\r"); assert.equal(f.settled(), false);
  f.component.handleInput("\x03"); assert.equal(await f.promise, undefined);
});

test("long confirmation summaries keep both choices visible and cancellation means no", async () => {
  let component;
  const promise = api.confirmOption({ custom(factory) {
    return new Promise(resolve => { component = factory({ terminal: { rows: 12 }, requestRender() {} }, theme, getKeybindings(), resolve); });
  } }, "删除 team？", "很长的阵容、".repeat(100));
  const frame = component.render(40);
  assert.ok(frame.length <= 10);
  assert.ok(frame.some(line => line.includes("Yes")));
  assert.ok(frame.some(line => line.includes("No")));
  component.handleInput("\x1b");
  assert.equal(await promise, false);
});

test("long model/team/member/provider menus remain usable through actual CLI/PTY", { skip: process.platform === "win32" }, () => {
  const output = execFileSync("python3", [new URL("./helpers/pi_selector_checks.py", import.meta.url).pathname], {
    env: process.env, encoding: "utf8", timeout: 60000,
  });
  const result = JSON.parse(output);
  assert.equal(result.checks.length, 14);
  assert.match(result.screens["resize keeps selected model at 40x12"], /→ fixture\/model-069/);
});
