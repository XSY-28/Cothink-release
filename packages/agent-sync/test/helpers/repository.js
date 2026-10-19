import { after } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
export function git(cwd, ...args) {
  const opts = [
    "--no-optional-locks",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=agent-sync fixture",
    "-c",
    "user.email=fixture@invalid",
  ];
  if (args[0] !== "init")
    execFileSync("git", [...opts, "status", "--porcelain"], {
      cwd,
      stdio: "pipe",
    });
  return execFileSync("git", [...opts, ...args], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
export function repository(t) {
  const root = mkdtempSync(join(tmpdir(), "agent-sync-")),
    project = join(root, "project"),
    home = join(root, "home");
  mkdirSync(project);
  mkdirSync(home);
  git(project, "init", "-b", "main");
  for (const [p, s] of Object.entries({
    "a.txt": "base A\n",
    "b.txt": "base B\n",
    ".gitignore": "ignored/\n",
  }))
    writeFileSync(join(project, p), s);
  git(project, "add", "--", "a.txt", "b.txt", ".gitignore");
  git(project, "commit", "-m", "fixture base");
  roots.push(root);
  return {
    root,
    project,
    home,
    baseVersion: git(project, "rev-parse", "HEAD"),
  };
}
export async function backend(t, extra = {}) {
  const m = await import("../../src/index.js").catch(() => ({}));
  assert.equal(
    typeof m.createAgentSync,
    "function",
    "C01: standalone createAgentSync export",
  );
  const repo = repository(t),
    events = [];
  const v = await m.createAgentSync({
    ...repo,
    onOperation: (e) => events.push(e),
    ...extra,
  });
  t.after(() => v.close());
  return { ...repo, v, events };
}
export const begin = (v, requestId, scope = ["a.txt"], extra = {}) =>
  v.beginChange({
    requestId,
    actor: requestId,
    intent: "fixture change",
    scope,
    ...extra,
  });
export async function replace(v, c, path, text, requestId, extra = {}) {
  const r = await v.read({ changeId: c.changeId, path });
  return v.edit(c.changeId, {
    requestId,
    expectedVersion: (await v.inspect({ changeId: c.changeId })).privateVersion,
    edits: [
      {
        path,
        oldHash: r.contentHash,
        contentBase64:
          text === null ? null : Buffer.from(text).toString("base64"),
        ...extra,
      },
    ],
  });
}
export async function accept(v, c, id) {
  const p = await v.prepareChange(c.changeId, { requestId: id + "-prepare" });
  return v.acceptChange({
    changeId: c.changeId,
    candidateVersion: p.candidateVersion,
    requestId: id,
  });
}
