import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireSessionWriter, sessionWriterBusy } from "../src/storage.js";

const sessionId = "817e5d2b-a9a5-4b1f-9bd1-c626faeb8393";
function home(t) {
  const path = mkdtempSync(join(tmpdir(), "cothink-writer-inspect-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function snapshot(directory) {
  return readdirSync(directory).sort().map((name) => [name, readFileSync(join(directory, name)).toString("hex")]);
}

test("writer inspection recognizes a same-PID release without changing lock records", (t) => {
  const root = home(t);
  assert.equal(sessionWriterBusy(root, sessionId), false);
  const writer = acquireSessionWriter(root, sessionId);
  t.after(() => writer.release());
  const directory = join(root, "sessions", sessionId + ".locks");
  assert.equal(sessionWriterBusy(root, sessionId), true);
  writer.release();
  const before = snapshot(directory);
  assert.equal(sessionWriterBusy(root, sessionId), false);
  assert.deepEqual(snapshot(directory), before);
});

test("writer inspection uses only the latest generation and treats invalid current facts as busy", (t) => {
  const root = home(t), first = acquireSessionWriter(root, sessionId);
  first.release();
  const second = acquireSessionWriter(root, sessionId);
  t.after(() => second.release());
  const directory = join(root, "sessions", sessionId + ".locks");
  // The older claim's live PID cannot retain ownership after a successor exists.
  rmSync(join(directory, "1.released"));
  assert.equal(sessionWriterBusy(root, sessionId), true, "latest live writer remains exclusive");
  second.release();
  const before = snapshot(directory);
  assert.equal(sessionWriterBusy(root, sessionId), false, "superseded live claim is no longer authoritative");
  assert.deepEqual(snapshot(directory), before);
  writeFileSync(join(directory, "2.released"), JSON.stringify({ token: "wrong-token" }));
  assert.equal(sessionWriterBusy(root, sessionId), true);
  writeFileSync(join(directory, "2.released"), "{truncated");
  assert.equal(sessionWriterBusy(root, sessionId), true);
});
