import test from "node:test";
import assert from "node:assert/strict";
import { InteractiveMode, AgentSessionRuntime, initTheme } from "@earendil-works/pi-coding-agent";
import { createRuntime } from "../src/pi-runtime.js";
import { fixture } from "./helpers/pi-fixture.js";
import { invoke } from "./helpers/cli-fixture.js";
import { saveConfig } from "../src/config.js";
import { readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import * as setup from "../src/setup.js";

test("model command completion offers only the canonical management command", async (t) => {
  const f = await fixture(t);
  const base = new CombinedAutocompleteProvider([
    { name: "model", description: "Select model", getArgumentCompletions: () => [{ value: "fixture/main", label: "main" }] },
    { name: "models", description: "Manage model roles" },
    { name: "thinking", description: "Thinking level" },
  ], f.cwd);
  assert.equal(typeof setup.modelsAutocomplete, "function");
  const provider = setup.modelsAutocomplete(base);
  const options = { signal: new AbortController().signal };
  for (const prefix of ["/mod", "/model"]) {
    const result = await provider.getSuggestions([prefix], 0, prefix.length, options);
    assert.deepEqual(result.items.map((item) => item.value), ["models"]);
    const completed = provider.applyCompletion([prefix], 0, prefix.length, result.items[0], result.prefix);
    assert.equal(completed.lines[0].trim(), "/models");
  }
  const all = await provider.getSuggestions(["/"], 0, 1, options);
  assert.ok(all.items.some((item) => item.value === "thinking"));
  assert.ok(!all.items.some((item) => item.value === "model"));
  for (const input of ["/model ", "/model fixture/", "/models "]) {
    assert.equal(await provider.getSuggestions([input], 0, input.length, options), null);
  }
  const multiline = await provider.getSuggestions(["material", "/mod"], 1, 4, options);
  assert.deepEqual(multiline.items.map((item) => item.value), ["models"]);
  writeFileSync(join(f.cwd, "model-notes.txt"), "fixture");
  const files = await provider.getSuggestions(["./model-n"], 0, 9, { ...options, force: true });
  const file = files.items.find((item) => item.label === "model-notes.txt");
  assert.ok(file, "filtering command aliases must keep file completion");
  assert.equal(provider.applyCompletion(["./model-n"], 0, 9, file, files.prefix).lines[0].trim(), "./model-notes.txt");
  assert.equal(f.calls.length, 0);
});

test("native local commands with surrounding whitespace and tab arguments reach local handlers, not prompt fallback", async (t) => {
  const f = await fixture(t);
  const rt = await createRuntime({ home: f.home, cwd: f.cwd, modelRef: f.models.main });
  t.after(() => rt.dispose());
  initTheme("dark");
  const terminal = { columns: 80, rows: 24, write() {}, start() {}, stop() {}, hideCursor() {}, showCursor() {}, clearLine() {}, moveBy() {}, clearScreen() {}, setTitle() {} };
  const runtime = new AgentSessionRuntime(rt.session, rt.services, async () => { throw Error("unused"); });
  const generated = [];
  const mode = new InteractiveMode(runtime, {
    terminal,
    host: { submit: async (text) => generated.push(text), isBusy: () => false, cancel() {} },
  });
  // Stub UI/IO side effects only: the real patched editor dispatcher is under test.
  const handlers = {
    settings: "showSettingsSelector", "scoped-models": "showModelsSelector", model: "handleModelCommand",
    thinking: "handleThinkingCommand", export: "handleExportCommand", import: "handleImportCommand",
    copy: "handleCopyCommand", name: "handleNameCommand", session: "handleSessionCommand",
    changelog: "handleChangelogCommand", hotkeys: "handleHotkeysCommand", fork: "showUserMessageSelector",
    clone: "handleCloneCommand", tree: "showTreeSelector", trust: "showTrustSelector",
    login: "handleLoginCommand", logout: "showOAuthSelector", new: "handleClearCommand",
    reload: "handleReloadCommand", debug: "handleDebugCommand", resume: "showSessionSelector", quit: "shutdown",
  };
  const reached = [];
  for (const method of Object.values(handlers)) mode[method] = (...args) => reached.push({ method, args });
  mode.onInputCallback = (text) => generated.push(text);
  mode.setupEditorSubmitHandler();
  for (const [name, method] of Object.entries(handlers)) {
    reached.length = 0;
    await mode.defaultEditor.onSubmit(`  /${name}  `);
    assert.deepEqual(reached.map((r) => r.method), [method], name);
    assert.equal(generated.length, 0, name);
  }
  for (const name of ["model", "thinking", "export", "import", "name", "login"]) {
    reached.length = 0;
    await mode.defaultEditor.onSubmit(`/${name}\targument`);
    assert.deepEqual(reached.map((r) => r.method), [handlers[name]], name);
    assert.equal(generated.length, 0, name);
  }
});

test("ask and pipe reject standalone local and unknown slash commands before creating any model task", async (t) => {
  const f = await fixture(t);
  saveConfig(f.home, { formatVersion: 2, ...f.models });
  for (const text of ["/settings", "/settings\n", "/new extra", "/model\tmain", "/chat", "/unknown", "/skill:missing"]) {
    for (const pipe of [false, true]) {
      const result = await invoke(f, pipe ? ["--print"] : ["ask", text], pipe ? text : "");
      assert.match(result.stdout + result.stderr, /本地命令|未知命令|未发送模型请求/, text);
      assert.equal(f.calls.length, 0, text);
      const tasks = join(f.home, "tasks");
      assert.equal(existsSync(tasks) ? readdirSync(tasks).length : 0, 0, text);
    }
  }
});
