import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./helpers/pi-fixture.js";
import * as presentation from "../src/presentation.js";
import * as storage from "../src/storage.js";
import { createRuntime } from "../src/pi-runtime.js";
import { InteractiveMode, AgentSessionRuntime, initTheme } from "@earendil-works/pi-coding-agent";

test("bundled CoThink notes provide the installed version and a short summary with full history", () => {
  assert.equal(typeof presentation.releaseNotes, "function");
  const notes = presentation.releaseNotes();
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  assert.equal(notes.version, version);
  assert.match(notes.summary, /CoThink/);
  assert.match(notes.summary, /\/changelog/);
  assert.equal(notes.summary.split("\n").filter((line) => line.startsWith("- ")).length, 3);
  assert.match(notes.full, /0\.2\.0-pi\.1/);
  assert.doesNotMatch(notes.summary, /pi update|pi\.dev/);
});

test("seen releases persist across launches and do not repeat after a rollback", async (t) => {
  const f = await fixture(t);
  assert.equal(typeof storage.releaseNotesSeen, "function");
  assert.equal(storage.releaseNotesSeen(f.home, "0.2.0-pi.5"), false);
  storage.markReleaseNotesSeen(f.home, "0.2.0-pi.5");
  storage.markReleaseNotesSeen(f.home, "0.2.0-pi.6");
  assert.equal(storage.releaseNotesSeen(f.home, "0.2.0-pi.5"), true);
  assert.equal(storage.releaseNotesSeen(f.home, "0.2.0-pi.6"), true);
  assert.equal(storage.releaseNotesSeen(f.home, "0.2.0-pi.7"), false);
  const path = join(f.home, "ui-state.json"), before = readFileSync(path, "utf8");
  storage.markReleaseNotesSeen(f.home, "0.2.0-pi.5");
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(f.calls.length, 0);
});

test("a damaged announcement state is not overwritten", async (t) => {
  const f = await fixture(t);
  assert.equal(typeof storage.markReleaseNotesSeen, "function");
  for (const invalid of ["{broken", '{"shownReleaseVersions":false}']) {
    const path = join(f.home, "ui-state.json");
    writeFileSync(path, invalid);
    assert.throws(() => storage.releaseNotesSeen(f.home, "v"));
    assert.throws(() => storage.markReleaseNotesSeen(f.home, "v"));
    assert.equal(readFileSync(path, "utf8"), invalid);
  }
});

test("hosted Pi does not supply its own startup changelog or package update checks", async (t) => {
  const f = await fixture(t);
  const rt = await createRuntime({ home: f.home, cwd: f.cwd, modelRef: f.models.main });
  t.after(() => rt.dispose());
  initTheme("dark");
  rt.services.settingsManager.setLastChangelogVersion("0.0.1");
  rt.services.settingsManager.setPackages(["npm:cothink-update-check-fixture"]);
  const runtime = new AgentSessionRuntime(rt.session, rt.services, async () => { throw Error("unused"); });
  const terminal = { columns: 80, rows: 24, write() {}, start() {}, stop() {}, hideCursor() {}, showCursor() {}, clearLine() {}, moveBy() {}, clearScreen() {}, setTitle() {} };
  const mode = new InteractiveMode(runtime, { terminal, host: { submit() {}, isBusy: () => false, cancel() {} } });
  const previous = process.env.PI_OFFLINE;
  delete process.env.PI_OFFLINE;
  const fetch = globalThis.fetch;
  let checks = 0;
  globalThis.fetch = async () => { checks++; return Response.json({ version: "999.0.0" }); };
  try {
    assert.equal(mode.getChangelogForDisplay(), undefined);
    assert.deepEqual(await mode.checkForPackageUpdates(), []);
    assert.equal(checks, 0);
    assert.equal(f.calls.length, 0);
  } finally {
    globalThis.fetch = fetch;
    if (previous === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previous;
  }
});
