import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/pi-fixture.js";
import { createRuntime } from "../src/pi-runtime.js";
import { InteractiveMode, AgentSessionRuntime, initTheme } from "@earendil-works/pi-coding-agent";
const present = await import("../src/presentation.js").catch(() => ({}));
test("native Pi message projection suppresses draft during streaming and rebuild", async (t) => {
  const f = await fixture(t);
  const rt = await createRuntime({ home: f.home, cwd: f.cwd, modelRef: f.models.main });
  t.after(() => rt.dispose());
  initTheme("dark");
  const host = new AgentSessionRuntime(rt.session, rt.services, async () => {
    throw Error("unused");
  });
  const terminal = {
    columns: 80,
    rows: 24,
    write() {},
    start() {},
    stop() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    moveBy() {},
    clearScreen() {},
    setTitle() {},
    drainInput: async () => {},
  };
  const mode = new InteractiveMode(host, {
    terminal,
    host: { submit: async () => {}, isBusy: () => false, cancel() {}, project: () => null },
  });
  let submitted;
  mode.defaultEditor.onSubmit = (text) => {
    submitted = text;
  };
  mode.defaultEditor.setText("  α\nβ  ");
  mode.defaultEditor.handleInput("\r");
  assert.equal(submitted, "  α\nβ  ");
  const before = mode.chatContainer.children.length;
  mode.addMessageToChat({
    role: "assistant",
    content: [{ type: "text", text: "DRAFT LONG SECRET" }],
    stopReason: "stop",
    usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
  });
  assert.equal(mode.chatContainer.children.length, before, "native rebuild must use host projection");
  await mode.handleEvent({
    type: "message_start",
    message: { role: "assistant", content: [{ type: "text", text: "DRAFT" }] },
  });
  assert.equal(mode.chatContainer.children.length, before, "streaming must use same projection");
});
test("final projection keeps raw review notes and hides only at presentation", () => {
  assert.equal(typeof present.finalText, "function");
  const record = { status: "completed", finalCallId: "r" };
  const requests = [{ id: "r", text: "FINAL\n\n## 对评审意见的处理说明\nNOTES" }];
  assert.equal(present.finalText(record, requests), "FINAL");
  assert.match(present.detailsText(record, requests), /NOTES/);
  assert.match(requests[0].text, /NOTES/);
  requests[0].text = "FINAL\n\n<details>\n<summary>## 对评审意见的处理说明</summary>\nNOTES\n</details>";
  assert.equal(present.finalText(record, requests), "FINAL");
  assert.match(present.detailsText(record, requests), /<details>[\s\S]*NOTES/);
  assert.match(requests[0].text, /<details>[\s\S]*NOTES/);
});
test("native login secret prompt masks both typing and submitted value", async () => {
  const { LoginDialogComponent } = await import(
    new URL(
      "modes/interactive/components/login-dialog.js",
      import.meta.resolve("@earendil-works/pi-coding-agent"),
    )
  );
  initTheme("dark");
  const dialog = new LoginDialogComponent({ requestRender() {} }, "fixture", () => {});
  const entered = dialog.showPrompt("API Key", undefined, true);
  dialog.input.setValue("PRIVATE_KEY_UNIQUE");
  assert.doesNotMatch(dialog.render(80).join("\n"), /PRIVATE_KEY_UNIQUE/);
  dialog.input.onSubmit();
  assert.equal(await entered, "PRIVATE_KEY_UNIQUE");
  assert.doesNotMatch(dialog.render(80).join("\n"), /PRIVATE_KEY_UNIQUE/);
});
test("native host can emit the only recovery copy after terminal restoration", async (t) => {
  const f = await fixture(t);
  const rt = await createRuntime({ home: f.home, cwd: f.cwd, modelRef: f.models.main });
  t.after(() => rt.dispose());
  initTheme("dark");
  let emitted = false;
  const runtime = new AgentSessionRuntime(rt.session, rt.services, async () => {
    throw Error("unused");
  });
  const terminal = {
    columns: 80,
    rows: 24,
    write() {},
    start() {},
    stop() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    moveBy() {},
    clearScreen() {},
    setTitle() {},
    drainInput: async () => {},
  };
  const mode = new InteractiveMode(runtime, {
    terminal,
    host: {
      submit: async () => {},
      isBusy: () => false,
      cancel() {},
      afterStop() {
        emitted = true;
      },
    },
  });
  const exit = process.exit;
  process.exit = () => {
    throw Error("stubbed exit");
  };
  try {
    await assert.rejects(mode.shutdown({ fromSignal: true }), /stubbed exit/);
    assert.ok(emitted);
  } finally {
    process.exit = exit;
  }
});

test("details identify provided skill sources without claiming use or changing final output", () => {
  const record = { id: "test", input: "q", status: "completed", finalCallId: "r",
    answerSkills: [{ name: "answer-test", description: "test", path: "/fixture/SKILL.md", hash: "abc123" }] };
  const requests = [{ id: "r", text: "FINAL" }];
  const details = present.detailsText(record, requests);
  assert.match(details, /本条已预载技能/);
  for (const value of ["answer-test", "/fixture/SKILL.md", "abc123"]) assert.ok(details.includes(value));
  assert.equal(present.finalText(record, requests), "FINAL");
  for (const status of ["cancelled", "partial", "failed"]) assert.match(present.detailsText({ ...record, status }, []), /answer-test/);
  for (const answerSkills of [undefined, []]) assert.doesNotMatch(present.detailsText({ ...record, answerSkills }, requests), /本条已预载技能/);
});
