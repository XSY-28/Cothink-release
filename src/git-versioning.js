/** Legacy interpretation only. The former write implementation is retained in the I0 snapshot/archive. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { problem } from "./task.js";
const exec = promisify(execFile);
export async function legacyGit(root, args) {
  return (
    await exec(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        ...args,
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    )
  ).stdout.trim();
}
export async function legacyProjectInfo({ project, home }) {
  let root, common;
  try {
    const cwd = realpathSync(resolve(project));
    root = await legacyGit(cwd, ["rev-parse", "--show-toplevel"]);
    common = realpathSync(
      await legacyGit(root, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
    );
  } catch {
    throw problem("NOT_GIT", "工作目录不是 Git 仓库；请显式初始化后工作。");
  }
  const projectId = createHash("sha256")
      .update(common)
      .digest("hex")
      .slice(0, 24),
    directory = join(home, "projects", projectId),
    path = join(directory, "project.json");
  if (!existsSync(path)) return null;
  let meta;
  try {
    meta = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw problem("LEGACY_CORRUPT", "旧项目元数据损坏，保留原文件。");
  }
  if (
    meta.common !== common ||
    typeof meta.integrationRef !== "string" ||
    !meta.integrationRef.startsWith("refs/")
  )
    throw problem("LEGACY_CORRUPT", "旧项目来源/正式引用不一致。");
  await legacyGit(root, [
    "rev-parse",
    "--verify",
    meta.integrationRef + "^{commit}",
  ]).catch(() => {
    throw problem("INTEGRATION_MISSING", "旧正式ref缺失，禁止按HEAD重建。");
  });
  return { projectId, root, common, directory, path, meta };
}
export async function createGitVersioning(options) {
  if (!options.readOnly)
    throw problem("LEGACY_READ_ONLY", "旧Git adapter已退出生产写路径。");
  const info = await legacyProjectInfo(options);
  if (!info) throw problem("NO_PROJECT", "没有旧项目记录。");
  const { root, directory, meta } = info;
  const id = (x) => {
    if (typeof x !== "string" || !/^[a-zA-Z0-9_-]{1,120}$/.test(x))
      throw problem("INVALID_ID", "无效旧记录ID");
    return x;
  };
  const load = (kind, x) =>
    JSON.parse(readFileSync(join(directory, kind, id(x) + ".json"), "utf8"));
  const version = () =>
    legacyGit(root, [
      "rev-parse",
      "--verify",
      meta.integrationRef + "^{commit}",
    ]);
  async function receipt(r) {
    if (!r?.acceptedVersion) return r;
    const proposedVersion = r.acceptedVersion;
    let confirmed = false;
    try {
      const chain = (
        await legacyGit(root, ["rev-list", "--first-parent", await version()])
      ).split("\n");
      const lines = (
        await legacyGit(root, ["show", "-s", "--format=%B", proposedVersion])
      ).split(/\r?\n/);
      const parents = (
        await legacyGit(root, ["show", "-s", "--format=%P", proposedVersion])
      ).split(" ");
      confirmed =
        chain.includes(proposedVersion) &&
        lines.includes("CoThink-Request: " + r.requestId) &&
        lines.includes("CoThink-Candidate: " + r.candidateVersion) &&
        (!r.expectedTip || parents[0] === r.expectedTip);
    } catch {}
    if (confirmed)
      return {
        ...r,
        status: "accepted",
        acceptedVersion: proposedVersion,
        recovered: r.status !== "accepted",
      };
    const { acceptedVersion, ...rest } = r;
    return {
      ...rest,
      status: r.status === "accepted" ? "unknown" : r.status,
      proposedVersion,
    };
  }
  return {
    projectId: info.projectId,
    root,
    directory,
    integrationRef: meta.integrationRef,
    backend: "git-legacy",
    async inspect({ changeId, requestId } = {}) {
      if (requestId) {
        const p = join(directory, "acceptance", id(requestId) + ".json");
        return existsSync(p)
          ? receipt(load("acceptance", requestId))
          : { status: "not_found", requestId };
      }
      if (changeId)
        return { ...load("changes", changeId), version: await version() };
      return {
        backend: "git-legacy",
        protocolVersion: 0,
        projectId: info.projectId,
        root,
        directory,
        integrationRef: meta.integrationRef,
        version: await version(),
        checks: options.checks ?? [],
      };
    },
    async beginChange() {
      throw problem("READ_ONLY", "旧格式仅支持只读查询。");
    },
    async close() {},
  };
}
