import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { readFileSync, existsSync, linkSync, unlinkSync, realpathSync } from "node:fs";
import { privateDirectory, writePrivateJson, acquireSessionWriter } from "./storage.js";
import { validateScope, inScope } from "./versioning.js";
const exec = promisify(execFile);
const options = [
  "--no-optional-locks",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "user.name=CoThink",
  "-c",
  "user.email=cothink@localhost",
];
const error = (code, message) => Object.assign(Error(message), { code });
const id = (value) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,120}$/.test(value))
    throw error("INVALID_ID", "修改/接纳 ID 无效");
  return value;
};
async function git(cwd, args, signal, input) {
  const child = exec("git", [...options, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    signal,
  });
  if (input !== undefined) {
    child.child.stdin.end(input);
  }
  return (await child).stdout;
}
function parseStatus(raw) {
  const entries = raw.split("\0"),
    files = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    files.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) files.push(entries[++i]);
  }
  return [...new Set(files)];
}
function executeCheck(check, cwd, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(error("CANCELLED", "检查已取消"));
      return;
    }
    const child = spawn(check.command, check.args ?? [], {
      cwd,
      env: { ...process.env, ...check.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "",
      stderr = "",
      escalation;
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const kill = () => {
      try {
        if (process.platform === "win32") child.kill();
        else process.kill(-child.pid, "SIGTERM");
      } catch (e) {
        if (e.code !== "ESRCH") throw e;
      }
      escalation = setTimeout(() => {
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 1000);
      escalation.unref();
    };
    signal?.addEventListener("abort", kill, { once: true });
    child.once("error", reject);
    child.once("close", (code, termSignal) => {
      clearTimeout(escalation);
      signal?.removeEventListener("abort", kill);
      resolve({
        command: check.command,
        args: check.args ?? [],
        code,
        signal: termSignal,
        stdout,
        stderr,
      });
    });
  });
}
export async function createGitVersioning({
  project,
  home,
  signal,
  onOperation = () => {},
  checks = [],
  afterUpdate,
  beforeUpdate,
  readOnly = false,
}) {
  checks = structuredClone(checks);
  if (
    !Array.isArray(checks) ||
    checks.some(
      (c) =>
        typeof c.command !== "string" ||
        !c.command ||
        (c.args != null && (!Array.isArray(c.args) || c.args.some((a) => typeof a !== "string"))),
    )
  )
    throw error("CHECK_POLICY", "检查策略需要 command 和字符串 args");
  const cwd = realpathSync(resolve(project));
  let root, common;
  try {
    root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    common = (await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  } catch {
    throw error("NOT_GIT", "工作目录不是 Git 仓库；请显式初始化 Git 后再工作。");
  }
  const projectId = createHash("sha256").update(realpathSync(common)).digest("hex").slice(0, 24),
    directory = join(home, "projects", projectId),
    metaPath = join(directory, "project.json");
  const established = existsSync(metaPath);
  if (readOnly) {
    if (!established) throw error("NO_PROJECT", "尚无受管项目");
  } else {
    privateDirectory(directory);
    privateDirectory(join(directory, "changes"));
    privateDirectory(join(directory, "acceptance"));
    privateDirectory(join(directory, "worktrees"));
  }
  if (!established) {
    const initial = (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    const meta = {
      projectId,
      root,
      common,
      ownerId: randomUUID(),
      integrationRef: "refs/heads/codex/cothink-" + projectId,
      createdFrom: initial,
    };
    const temporary = join(directory, randomUUID() + ".tmp");
    writePrivateJson(temporary, meta);
    try {
      linkSync(temporary, metaPath);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    } finally {
      unlinkSync(temporary);
    }
  }
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  if (meta.common !== common) throw error("PROJECT_MISMATCH", "项目身份不一致");
  const owner = readOnly ? null : acquireSessionWriter(directory, meta.ownerId);
  let closed = false,
    queue = Promise.resolve();
  const assertActive = () => {
    if (closed || readOnly) throw error("CLOSED", "版本宿主不可写");
    owner.assertOwned();
    if (signal?.aborted) throw error("CANCELLED", "任务已取消，禁止新的版本修改/接纳");
  };
  const audit = async (action, where = root) => {
    const changedFiles = parseStatus(
      await git(where, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    );
    await onOperation({
      action,
      cwd: where,
      changedFiles,
      explanation: `Git ${action}：已检查变化文件；只操作受管分支/工作区，保留用户原目录，不推送。`,
    });
    return changedFiles;
  };
  const mutate = async (action, where, args, input) => {
    assertActive();
    await audit(action, where);
    assertActive();
    return git(where, args, signal, input);
  };
  const version = async () => {
    try {
      return (await git(root, ["rev-parse", "--verify", meta.integrationRef + "^{commit}"])).trim();
    } catch {
      return null;
    }
  };
  try {
    if (!(await version())) {
      if (established || readOnly)
        throw error(
          "INTEGRATION_MISSING",
          "正式集成 ref 丢失；保留历史与回执，请显式核对恢复，拒绝自动重建主线。",
        );
      await mutate("initialize", root, [
        "update-ref",
        meta.integrationRef,
        meta.createdFrom,
        "0".repeat(meta.createdFrom.length),
      ]);
    }
  } catch (error) {
    owner?.release();
    throw error;
  }
  const file = (changeId) => join(directory, "changes", id(changeId) + ".json");
  const read = (changeId) => JSON.parse(readFileSync(file(changeId), "utf8"));
  const save = (c) => writePrivateJson(file(c.changeId), c);
  const receiptPath = (requestId) => join(directory, "acceptance", id(requestId) + ".json");
  const getReceipt = (requestId) =>
    existsSync(receiptPath(requestId))
      ? JSON.parse(readFileSync(receiptPath(requestId), "utf8"))
      : null;
  const verifyCommit = async (oid) => {
    if (typeof oid !== "string" || !/^[a-f0-9]+$/i.test(oid))
      throw error("VERSION", "需要完整 commit 版本");
    const actual = (await git(root, ["rev-parse", "--verify", oid + "^{commit}"])).trim();
    if (actual !== oid) throw error("VERSION", "需要完整 commit 版本");
    return actual;
  };
  const acceptanceFact = async (r) => {
    if (!r?.acceptedVersion) return r;
    const tip = await version();
    try {
      await git(root, ["merge-base", "--is-ancestor", r.acceptedVersion, tip]);
      const message = await git(root, ["show", "-s", "--format=%B", r.acceptedVersion]);
      if (
        !message.includes("CoThink-Request: " + r.requestId) ||
        !message.includes("CoThink-Candidate: " + r.candidateVersion)
      )
        throw error("CORRUPT", "接纳历史与回执不一致");
      return { ...r, status: "accepted", recovered: r.status !== "accepted" };
    } catch (e) {
      if (e.code === "CORRUPT") throw e;
      return r.status === "accepted"
        ? { ...r, status: "unknown", error: "正式 Git 历史不再包含接纳版本" }
        : r;
    }
  };
  const api = {
    projectId,
    root,
    directory,
    integrationRef: meta.integrationRef,
    async beginChange({ actor, baseVersion, scope, intent }) {
      assertActive();
      const base = await verifyCommit(baseVersion ?? (await version()));
      const changeId = randomUUID(),
        workspace = join(directory, "worktrees", changeId),
        branch = "codex/cothink-change-" + changeId;
      const c = {
        changeId,
        actor,
        baseVersion: base,
        scope: validateScope(scope),
        intent,
        workspace,
        branch,
        status: "creating",
        createdAt: new Date().toISOString(),
      };
      save(c);
      try {
        await mutate("begin", root, ["worktree", "add", "-b", branch, workspace, base]);
        c.status = "open";
        save(c);
        return c;
      } catch (e) {
        c.status = "unknown";
        c.error = e.message;
        save(c);
        throw e;
      }
    },
    async prepareChange(changeId) {
      assertActive();
      const c = read(changeId);
      if (c.status === "abandoned" || c.status === "accepted")
        throw error("CHANGE_CLOSED", "修改已结束");
      const files = await audit("prepare", c.workspace);
      assertActive();
      if (files.some((p) => !inScope(p, c.scope)))
        throw error(
          "SCOPE",
          "候选包含超出声明范围的文件：" + files.filter((p) => !inScope(p, c.scope)).join(", "),
        );
      if (files.length) {
        await mutate("stage", c.workspace, ["add", "--", ...files]);
        await mutate("candidate", c.workspace, [
          "commit",
          "-m",
          `CoThink candidate\n\nCoThink-Change: ${c.changeId}`,
        ]);
      }
      c.candidateVersion = (await git(c.workspace, ["rev-parse", "HEAD"])).trim();
      const names = (
        await git(root, [
          "diff",
          "--no-renames",
          "--name-only",
          "-z",
          c.baseVersion,
          c.candidateVersion,
        ])
      )
        .split("\0")
        .filter(Boolean);
      if (names.some((p) => !inScope(p, c.scope))) throw error("SCOPE", "候选版本越界");
      c.ignoredFiles = (
        await git(c.workspace, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])
      )
        .split("\0")
        .filter(Boolean);
      c.status = "prepared";
      c.diff = {
        files: names,
        text: await git(root, [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          c.baseVersion,
          c.candidateVersion,
        ]),
      };
      save(c);
      return c;
    },
    async inspect({ changeId, requestId } = {}) {
      if (requestId) {
        const r = getReceipt(requestId);
        return r ? await acceptanceFact(r) : { status: "not_found", requestId };
      }
      if (changeId) {
        const c = read(changeId);
        return {
          ...c,
          workingFiles: parseStatus(
            await git(c.workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
          ),
          privateVersion: (await git(c.workspace, ["rev-parse", "HEAD"])).trim(),
          version: await version(),
        };
      }
      return {
        projectId,
        root,
        integrationRef: meta.integrationRef,
        version: await version(),
        originalChanges: parseStatus(
          await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
        ),
        checks: structuredClone(checks),
      };
    },
    async acceptChange(input) {
      const run = () => accept(input);
      const result = queue.then(run, run);
      queue = result.catch(() => {});
      return result;
    },
    async abandonChange(changeId) {
      assertActive();
      const c = read(changeId);
      if (c.status === "accepted") return c;
      c.status = "abandoned";
      save(c);
      return c;
    },
    async checkCurrent() {
      assertActive();
      const tip = await version();
      const workspace = join(directory, "worktrees", "check-" + randomUUID());
      await mutate("check-worktree", root, ["worktree", "add", "--detach", workspace, tip]);
      const result = await runChecks(workspace);
      return {
        ...result,
        status: (await version()) === tip ? result.status : "stale",
        version: tip,
        workspace,
      };
    },
    close() {
      closed = true;
      owner?.release();
    },
  };
  async function runChecks(workspace) {
    const tree = (await git(workspace, ["write-tree"])).trim();
    const unknownBefore = await git(workspace, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    const results = [];
    for (const check of checks) {
      assertActive();
      const r = await executeCheck(check, workspace, signal);
      results.push(r);
      if (r.code !== 0) return { status: "check_failed", checks: results, tree };
    }
    const after = (await git(workspace, ["write-tree"])).trim();
    let dirty = false;
    try {
      await git(workspace, ["diff", "--exit-code", "--no-ext-diff"]);
    } catch {
      dirty = true;
    }
    const unknownAfter = await git(workspace, ["ls-files", "--others", "--exclude-standard", "-z"]);
    if (tree !== after || dirty || unknownBefore !== unknownAfter)
      return {
        status: "check_failed",
        reason: "检查改变了源文件；需要重新固定候选并检查",
        checks: results,
        tree,
      };
    return {
      status: "passed",
      verification: checks.length ? "passed" : "unverified",
      checks: results,
      tree,
    };
  }
  async function accept({ changeId, candidateVersion, requestId }) {
    id(requestId);
    const existing = getReceipt(requestId);
    if (existing) {
      if (existing.changeId !== changeId || existing.candidateVersion !== candidateVersion)
        throw error("REQUEST_MISMATCH", "接纳 ID 已用于另一候选");
      return await acceptanceFact(existing);
    }
    if (signal?.aborted) return { status: "cancelled", requestId };
    assertActive();
    const c = read(changeId);
    if (c.status === "abandoned") return { status: "cancelled", requestId };
    if (c.candidateVersion !== candidateVersion || c.status !== "prepared")
      throw error("CANDIDATE", "只能接纳此修改已经保存的候选");
    await verifyCommit(candidateVersion);
    const tip = await version(),
      checkedOut = await git(root, ["worktree", "list", "--porcelain"]);
    if (checkedOut.split("\n").includes("branch " + meta.integrationRef))
      throw error("CHECKED_OUT", "集成分支已被 checkout，拒绝条件更新以免工作区失配");
    const r = {
      requestId,
      changeId,
      candidateVersion,
      expectedTip: tip,
      status: "preparing",
      workspace: join(directory, "worktrees", "integrate-" + requestId),
      checksPolicy: structuredClone(checks),
    };
    writePrivateJson(receiptPath(requestId), r);
    try {
      await mutate("integrate-worktree", root, ["worktree", "add", "--detach", r.workspace, tip]);
      try {
        await mutate("merge", r.workspace, ["merge", "--no-commit", "--no-ff", candidateVersion]);
      } catch (e) {
        if (signal?.aborted) throw e;
        r.status = "conflict";
        r.error = e.stderr ?? e.message;
        writePrivateJson(receiptPath(requestId), r);
        return r;
      }
      const result = await runChecks(r.workspace);
      Object.assign(r, result);
      if (result.status === "check_failed") {
        writePrivateJson(receiptPath(requestId), r);
        return r;
      }
      await mutate("integration-commit", r.workspace, [
        "commit",
        "--allow-empty",
        "-m",
        `CoThink accepted candidate\n\nCoThink-Request: ${requestId}\nCoThink-Candidate: ${candidateVersion}\nCoThink-Expected: ${tip}`,
      ]);
      r.acceptedVersion = (await git(r.workspace, ["rev-parse", "HEAD"])).trim();
      const committed = (await git(r.workspace, ["rev-parse", "HEAD^{tree}"])).trim();
      if (committed !== result.tree) throw error("TREE_CHANGED", "被检查 tree 与整合提交不一致");
      r.status = "prepared";
      writePrivateJson(receiptPath(requestId), r);
      await beforeUpdate?.(r);
      assertActive();
      try {
        await mutate("accept", root, ["update-ref", meta.integrationRef, r.acceptedVersion, tip]);
      } catch (e) {
        if (signal?.aborted) throw e;
        r.status = "stale";
        r.error = e.stderr ?? e.message;
        writePrivateJson(receiptPath(requestId), r);
        return r;
      }
      await afterUpdate?.(r);
      r.status = "accepted";
      c.status = "accepted";
      c.acceptedVersion = r.acceptedVersion;
      save(c);
      writePrivateJson(receiptPath(requestId), r);
      await onOperation({
        action: "accepted",
        cwd: r.workspace,
        changedFiles: c.diff.files,
        acceptedVersion: r.acceptedVersion,
        explanation: "组合检查已完成；Git 集成 ref 已条件推进，用户原分支未改变。",
      });
      return r;
    } catch (e) {
      r.status = signal?.aborted ? "cancelled" : "unknown";
      r.error = e.message;
      try {
        writePrivateJson(receiptPath(requestId), r);
      } catch {}
      return r;
    }
  }
  return api;
}
