import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
export const git = (cwd, ...args) =>
  execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=CoThink fixture",
      "-c",
      "user.email=fixture@invalid",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  ).trim();
export function repository(t, { cleanup = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cothink-sync-")),
    project = join(root, "project"),
    home = join(root, "home");
  mkdirSync(project);
  mkdirSync(home);
  git(project, "init", "-b", "main");
  writeFileSync(join(project, "a.txt"), "base A\n");
  writeFileSync(join(project, "b.txt"), "base B\n");
  writeFileSync(join(project, ".gitignore"), "ignored/\n");
  git(project, "status", "--porcelain");
  git(project, "add", "--", "a.txt", "b.txt", ".gitignore");
  git(project, "commit", "-m", "fixture base");
  const baseVersion = git(project, "rev-parse", "HEAD");
  if (cleanup) t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, project, home, baseVersion };
}
export async function backend(t, extra = {}) {
  const assert = await import("node:assert/strict");
  const api = await import("../../src/git-versioning.js").catch(() => ({}));
  assert.equal(
    typeof api.createGitVersioning,
    "function",
    "Git version adapter is implemented",
  );
  const f = repository(t),
    events = [];
  const v = await api.createGitVersioning({
    ...f,
    onOperation: (e) => events.push(e),
    ...extra,
  });
  t.after(() => v.close());
  return { ...f, v, events };
}
