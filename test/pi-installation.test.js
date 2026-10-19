import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fixture } from "./helpers/pi-fixture.js";
import { invoke } from "./helpers/cli-fixture.js";
test("version is available without loading configuration or generating a request", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.home, "config.json"), "invalid private configuration");
  const r = await invoke(f, ["--version"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  assert.equal(f.calls.length, 0);
  assert.equal(readFileSync(join(f.home, "config.json"), "utf8"), "invalid private configuration");
});
test("legacy history/show remain read-only after the old online executor is archived", async (t) => {
  const f = await fixture(t);
  mkdirSync(join(f.home, "runs"));
  const id = randomUUID(),
    run = {
      id,
      createdAt: "2026-10-18T00:00:00Z",
      question: "old question",
      status: "completed",
      stages: [
        { name: "draft", status: "completed", response: { text: "LEGACY_DRAFT" } },
        { name: "review", status: "completed", response: { text: "LEGACY_REVIEW" } },
        { name: "revision", status: "completed", response: { text: "LEGACY_FINAL" } },
      ],
    };
  const path = join(f.home, "runs", id + ".json");
  writeFileSync(path, JSON.stringify(run));
  const hash = () => createHash("sha256").update(readFileSync(path)).digest("hex"),
    before = hash();
  writeFileSync(join(f.home, "config.json"), "unreadable old credentials");
  const show = await invoke(f, ["show", id]);
  assert.equal(show.code, 0, show.stderr);
  assert.equal(show.stdout.trim(), "LEGACY_FINAL");
  const detail = await invoke(f, ["show", id, "--all"]);
  assert.match(detail.stdout, /LEGACY_DRAFT/);
  const history = await invoke(f, ["history", "--json"]);
  assert.ok(JSON.parse(history.stdout).some((r) => r.id === id));
  assert.equal(hash(), before);
  assert.equal(f.calls.length, 0);
});
