import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../src/config.js";
import { fixture } from "./helpers/pi-fixture.js";
import { managed, execution } from "./helpers/agent-sync-fixture.js";
import { inspectWork, finalText } from "../src/presentation.js";
test("A01 configuration freezes explicit Docker policy and rejects host check paths/secret env", async (t) => {
  const base = {
    formatVersion: 2,
    main: { provider: "fixture", modelId: "main" },
    secondary: [],
  };
  for (const work of [
    { checks: [{ command: process.execPath }] },
    { execution: { ...execution, network: "host" } },
    { checks: [{ command: "node", env: { SECRET: "do-not-log" } }] },
  ])
    assert.throws(() => validateConfig({ ...base, work }));
  assert.equal(
    validateConfig({ ...base, work: { checks: [], execution } }).work.execution
      .network,
    "none",
  );
});
test("A01/A08 new history reader uses saved home/backend with no Docker or model", async (t) => {
  const f = await managed(t);
  const p = await f.v.inspect();
  const fact = await inspectWork(f.home, {
    work: {
      ...p,
      backend: "agent-sync",
      toolHome: f.v.toolHome,
      acceptance: [],
    },
  });
  assert.equal(fact.backend, "agent-sync");
  assert.equal(fact.version, p.version);
});
test("A04 unreviewed plugin top-level code is rejected before import and no host side effect occurs", async (t) => {
  const { writeFileSync, existsSync } = await import("node:fs"),
    { join } = await import("node:path"),
    { createRuntime } = await import("../src/pi-runtime.js");
  const f = await fixture(t),
    canary = join(f.home, "must-not-exist"),
    plugin = join(f.home, "plugin.mjs");
  writeFileSync(
    plugin,
    `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(canary)},'unsafe');export default function(pi){}`,
  );
  let rt;
  try {
    await assert.rejects(
      async () => {
        rt = await createRuntime({
          home: f.home,
          cwd: f.cwd,
          modelRef: f.models.main,
          resourceOptions: { additionalExtensionPaths: [plugin] },
        });
      },
      { code: "UNADAPTED_PLUGIN" },
    );
  } finally {
    rt?.dispose();
  }
  assert.equal(existsSync(canary), false);
  assert.equal(f.calls.length, 0);
});
