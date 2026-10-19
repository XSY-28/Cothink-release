import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/pi-fixture.js";
const api = await import("../src/pi-runtime.js").catch(() => ({}));
test("required extension load failure rejects host creation with zero requests", async (t) => {
  assert.equal(typeof api.createRuntime, "function", "Pi host is implemented");
  const f = await fixture(t);
  await assert.rejects(
    api.createRuntime({
      home: f.home,
      cwd: f.cwd,
      modelRef: f.models.main,
      extensionFactories: [
        () => {
          throw Error("broken extension");
        },
      ],
    }),
    /broken extension/,
  );
  assert.equal(f.calls.length, 0);
});
test("extension runtime failure is visible and blocks the provider send", async (t) => {
  const { createTask } = await import("../src/task.js");
  const f = await fixture(t);
  const rt = await api.createRuntime({
    home: f.home,
    cwd: f.cwd,
    modelRef: f.models.main,
    extensionFactories: [
      (pi) =>
        pi.on("before_provider_request", () => {
          throw Error("hook failed");
        }),
    ],
  });
  t.after(() => rt.dispose());
  const task = createTask({ home: f.home, input: "q", models: f.models });
  rt.bindTask(task, task.beginPhase("draft", "main", f.models.main));
  await assert.rejects(rt.prompt("q"), /hook failed/);
  assert.equal(f.calls.length, 0);
});
