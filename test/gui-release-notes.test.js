import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./helpers/pi-fixture.js";
import { createGuiController } from "../src/gui-controller.js";
import { markReleaseNotesSeen, releaseNotesSeen } from "../src/storage.js";

test("GUI polls do not acknowledge notes; explicit acknowledgement is shared with CLI and version scoped", async (t) => {
  const f = await fixture(t),
    c = await createGuiController({ home: f.home, cwd: f.cwd });
  t.after(() => c.close());
  const first = await c.bootstrap();
  assert.equal(first.releaseNotes.unread, true);
  await c.bootstrap();
  assert.equal(existsSync(join(f.home, "ui-state.json")), false);
  await assert.rejects(
    c.action("releaseNotes.ack", { version: "not-installed" }),
    /版本/,
  );
  assert.equal(releaseNotesSeen(f.home, first.version), false);
  await c.action("releaseNotes.ack", { version: first.version });
  assert.equal(releaseNotesSeen(f.home, first.version), true);
  assert.equal((await c.bootstrap()).releaseNotes.unread, false);
  assert.equal(f.calls.length, 0);
});
test("CLI acknowledgement is honored and corrupt UI state stays preserved and visibly reported", async (t) => {
  const f = await fixture(t),
    c = await createGuiController({ home: f.home, cwd: f.cwd });
  t.after(() => c.close());
  const initial = await c.bootstrap();
  markReleaseNotesSeen(f.home, initial.version);
  assert.equal((await c.bootstrap()).releaseNotes.unread, false);
  const path = join(f.home, "ui-state.json");
  writeFileSync(path, "{ damaged");
  const b = await c.bootstrap();
  assert.equal(b.releaseNotes.unread, true);
  assert.match(b.releaseNotes.error, /损坏|状态/);
  await assert.rejects(c.action("releaseNotes.ack", { version: b.version }));
  assert.equal(readFileSync(path, "utf8"), "{ damaged");
});
