import { createHash } from "node:crypto";
import { realpathSync, readFileSync, lstatSync } from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createVersioning } from "./versioning.js";
import { taskOutputRefs } from "./gui-projection.js";
const exec = promisify(execFile);
async function git(path, args) {
  return (
    await exec("git", ["-C", path, ...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
  ).stdout.trimEnd();
}
export async function inspectGuiProject(home, path, work = {}) {
  let normalized;
  try {
    if (typeof path !== "string" || !path.trim())
      throw Error("请输入项目路径。");
    normalized = realpathSync(resolve(path));
    // Inspection is read only; dirty files are reported before any versioning call.
    const changes = await git(normalized, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    const root = await git(normalized, ["rev-parse", "--show-toplevel"]);
    normalized = realpathSync(root);
    const head = await git(normalized, ["rev-parse", "HEAD"]);
    let checks = work.checks;
    if (checks === undefined) {
      try {
        const pkg = JSON.parse(
          readFileSync(resolve(normalized, "package.json"), "utf8"),
        );
        checks = pkg.scripts?.test ? [{ command: "npm", args: ["test"] }] : [];
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
        checks = [];
      }
    }
    let version = head,
      execution = work.execution ?? null,
      error = null;
    try {
      const v = await createVersioning({
        home,
        project: normalized,
        readOnly: true,
      });
      try {
        const fact = await v.inspect();
        version = fact.version;
        execution = fact.execution;
      } finally {
        await v.close();
      }
    } catch (e) {
      if (!["NO_PROJECT", "ENOENT"].includes(e.code)) error = e.message;
    }
    return {
      path: normalized,
      valid: true,
      dirty: changes.length > 0,
      head,
      version,
      execution,
      checks,
      error,
    };
  } catch (error) {
    return {
      path: normalized ?? (typeof path === "string" ? resolve(path) : null),
      valid: false,
      dirty: null,
      head: null,
      version: null,
      execution: null,
      checks: [],
      error: error.message,
    };
  }
}
export async function withGuiWork(home, record, fn) {
  const work = record.work;
  if (!work?.root) throw Error("任务没有已保存的工作项目。");
  const v = await createVersioning({
    home,
    project: work.root,
    readOnly: true,
    backend: work.backend,
    toolHome: work.toolHome,
  });
  try {
    return await fn(v, work);
  } finally {
    await v.close();
  }
}
export async function guiDiff(home, record) {
  return withGuiWork(home, record, async (v, w) => {
    let from = w.startVersion,
      to = w.version;
    if (!from) throw Error("旧任务未记录可信起点，无法生成任务差异。");
    if (!w.resultWorkspace) {
      const receipts = await Promise.all(
        (w.acceptance ?? []).map((r) =>
          r.requestId ? v.inspect({ requestId: r.requestId }) : r,
        ),
      );
      to =
        receipts.findLast((r) => r.status === "accepted")?.acceptedVersion ??
        to;
    }
    if (!to) throw Error("任务未记录可信终点；未知接纳不自动重发。");
    const diff = await v.inspect({ fromVersion: from, toVersion: to });
    return {
      fromVersion: from,
      toVersion: to,
      files: diff.files,
      text: diff.text ?? diff.patch ?? "",
      binaryFiles: diff.binaryFiles ?? [],
    };
  });
}
export async function guiOutput(
  home,
  record,
  outputRef,
  offset = 0,
  limit = 65536,
) {
  if (!taskOutputRefs(record).includes(outputRef))
    throw Error("outputRef 不属于此任务。");
  return withGuiWork(home, record, async (v) => {
    const page = await v.read({ outputRef, offset, limit });
    return {
      text: Buffer.from(page.contentBase64, "base64").toString("utf8"),
      nextOffset: page.nextOffset,
      eof: page.eof,
    };
  });
}
export async function revealGuiTask(record) {
  if (!record.work?.resultWorkspace) throw Error("任务尚无可信成果目录。");
  const path = realpathSync(record.work.resultWorkspace);
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer.exe"
        : "xdg-open";
  await exec(command, [path]);
  return { path };
}

export function guiArtifact(home,record,ref,index) {
 if(typeof ref!=="string"||!Number.isSafeInteger(index)||index<0)throw Error("截图引用无效。");
 const evidence=record.work?.visualEvidence?.find(e=>e.outputRef===ref), image=evidence?.images?.[index];
 if(!image)throw Error("截图不属于此任务。");
 const expected=resolve(home,"artifacts",record.id,ref,`${index}.png`);
 const root=realpathSync(join(home,"artifacts")), taskRoot=realpathSync(join(root,record.id));
 const inside=(base,path)=>{const rel=relative(base,path);return rel&&!isAbsolute(rel)&&rel!==".."&&!rel.startsWith("../")&&!rel.startsWith("..\\");};
 if(!inside(root,taskRoot)||resolve(image.path)!==expected)throw Error("截图路径无效。");
 const path=realpathSync(image.path),info=lstatSync(image.path);
 if(!inside(taskRoot,path)||!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>4*1024*1024)throw Error("截图路径或大小无效。");
 const bytes=readFileSync(path);
 if(bytes.subarray(0,8).toString("hex")!=="89504e470d0a1a0a"||createHash("sha256").update(bytes).digest("hex")!==image.sha256)throw Error("截图类型或哈希不匹配。");
 return bytes;
}
