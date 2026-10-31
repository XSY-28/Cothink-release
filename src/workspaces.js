import { createPreviewTool } from "./visual-preview.js";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, lstatSync, unlinkSync, realpathSync } from "node:fs";
import { relative, resolve, isAbsolute, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  createBashToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { inScope, withChangeQueue } from "./versioning.js";
import { problem } from "./task.js";
const exec = promisify(execFile),
  hash = (b) => createHash("sha256").update(b).digest("hex");
/** Pi schemas/rendering/matching with per-call operations; never raw host write or Shell. */
export function workspaceTools({
  task,
  stage,
  versioning,
  getChange,
  change,
  binding = {},
  ensureWrite,
  onChanged = () => {},
  readOnly = false,
  assertOwned = () => {},
  onProgress = () => {},
  visualPreview = false,
}) {
  if (!versioning)
    throw problem("VERSIONING_REQUIRED", "工作工具必须绑定agent-sync实例。");
  getChange ??= () => change;
  binding.reads ??= new Map();
  binding.observations ??= new Map();
  binding.failedMutations ??= new Map();
  const prototypes = [
    createReadToolDefinition("."),
    createGrepToolDefinition("."),
    createFindToolDefinition("."),
    createLsToolDefinition("."),
    ...(!readOnly
      ? [
          createWriteToolDefinition("."),
          createEditToolDefinition("."),
          createBashToolDefinition(".", { exposeSessionEnvironment: false }),
        ]
      : []),
  ];
  if (visualPreview && !readOnly) prototypes.push(createPreviewTool({task,stage,versioning,getChange,binding,onChanged,assertOwned,onProgress}));
  function save() {
    try {
      task.save();
    } catch (e) {
      task.ioError = e;
      throw e;
    }
  }
  function guard() {
    assertOwned();
    if (task.signal.aborted || task.record.status !== "running" || task.ioError)
      throw (
        task.signal.reason ??
        task.ioError ??
        problem("TASK_ENDED", "任务已停止。")
      );
  }
  function pathOf(path, c) {
    if (
      typeof path !== "string" ||
      path.includes("\0") ||
      path.split(/[\\/]/).includes("..") ||
      (path.includes("\\") && process.platform !== "win32")
    )
      throw problem("PATH", "需要无歧义的工作区相对路径。");
    if (path.startsWith("output:"))
      throw problem("PATH", "output:只用于read日志，不能作为源码路径。");
    if(isAbsolute(path))for(const context of task.record.tools??[]) {
      if(context.kind!=="native_plugin_context"||context.changeId!==c.changeId)continue;
      const roots=[resolve(context.cwd)];try{roots.push(realpathSync(context.cwd));}catch{}
      for(const root of roots) {
        const rel=relative(root,resolve(path));
        if(!isAbsolute(rel)&&rel!==".."&&!rel.startsWith("../")) {path=rel||".";break;}
      }
      if(!isAbsolute(path))break;
    }
    const nativeRel = relative(c.workspace, resolve(c.workspace, path));
    // The kernel uses portable repository paths; native Windows absolute paths
    // are accepted at the tool boundary, then normalized before scope checks.
    const rel = nativeRel.replaceAll("\\", "/");
    if (
      isAbsolute(nativeRel) ||
      rel === ".." ||
      rel.startsWith("../") ||
      rel.split("/").some((x) => x.toLowerCase() === ".git")
    )
      throw problem("WORKSPACE_ESCAPE", "文件路径不属于当前工作区。");
    return rel || ".";
  }
  const role = () => (typeof stage === "function" ? stage() : stage);
  async function logBuffer(ref) {
    const allowed = [
      ...(task.record.tools ?? []).map((t) => t.outputRef),
      ...(task.record.work?.acceptance ?? []).flatMap((r) =>
        (r.checks ?? []).map((c) => c.outputRef),
      ),
      ...(task.record.work?.finalCheck?.checks ?? []).map((c) => c.outputRef),
      ...(task.record.work?.changes ?? []).flatMap((c) =>
        (c.candidates ?? []).flatMap((p) =>
          (p.precheck?.checks ?? []).map((c) => c.outputRef),
        ),
      ),
    ];
    if (!allowed.includes(ref))
      throw problem("OUTPUT_SCOPE", "日志不属于当前任务/项目。");
    const chunks = [];
    let offset = 0;
    for (;;) {
      const page = await versioning.read({ outputRef: ref, offset });
      chunks.push(Buffer.from(page.contentBase64, "base64"));
      if (page.eof) break;
      offset = page.nextOffset;
    }
    return Buffer.concat(chunks);
  }
  async function perform(def, id, args, signal, onUpdate, ctx) {
    if (def.name === "preview_html") return def.execute(id,args,signal);
    const started = performance.now();
    guard();
    // Explicit selected skill references/scripts are read from the task copy, never the live home.
    // Script execution still uses the existing offline Docker Shell after reading its contents.
    const resource = def.name === "read" && typeof args.path === "string" &&
      (task.record.work?.skillResources ?? []).map(r=>{
        let requested=resolve(args.path);
        try {requested=realpathSync(requested);} catch {}
        const rel=relative(r.sourceDirectory,requested).replaceAll("\\","/");
        return rel && !rel.startsWith("../") && !isAbsolute(rel) && r.files[rel] ? {r,rel} : null;
      }).find(Boolean);
    if(resource) {
      const path=join(resource.r.root,resource.rel),bytes=readFileSync(path);
      if(hash(bytes)!==resource.r.files[resource.rel])throw problem("SKILL_CHANGED","Frozen task skill resource changed");
      const native=createReadToolDefinition(resource.r.root,{operations:{access:async()=>{},readFile:async()=>bytes,detectImageMimeType:async()=>null}});
      const result=await native.execute(id,{...args,path},signal,onUpdate,ctx);
      (task.record.tools??=[]).push({toolCallId:id,name:"read",stageId:role().id,status:"completed",resourcePath:args.path,resourceHash:hash(bytes)});
      save();return result;
    }
    const s = role(),
      combined = signal ? AbortSignal.any([signal, task.signal]) : task.signal;
    if (combined.aborted) throw combined.reason;
    const prior = (task.record.tools ?? []).find(
      (t) => t.toolCallId === id && t.stageId === s.id,
    );
    if (
      prior?.requestId &&
      ["completed", "unknown", "cancelled"].includes(prior.status)
    ) {
      const fact = await versioning.inspect({ requestId: prior.requestId });
      if (fact.status !== "not_found")
        return { content: [{ type: "text", text: JSON.stringify(fact) }] };
    }
    const trace = prior ?? {
      toolCallId: id,
      name: def.name,
      stageId: s.id,
      requestId: randomUUID(),
      status: "preparing",
      sessionFile: s.sessionFile,
    };
    if (!prior) (task.record.tools ??= []).push(trace);
    save();
    let c = getChange(),
      path,
      logRef,
      tempPaths = new Set(),
      lastKernel;
    if (binding.readChangeId !== c.changeId) {
      binding.reads.clear();
      binding.observations.clear();
      binding.reviewedVersion = null;
      binding.readChangeId = c.changeId;
    }
    const isWrite = ["write", "edit", "bash"].includes(def.name);
    if (binding.unknownOperation && isWrite)
      throw problem(
        "OPERATION_UNKNOWN",
        "先查询未知操作 " + binding.unknownOperation + "；禁止用新ID重发。",
      );
    if (def.name === "read" && args.path?.startsWith("output:"))
      logRef = args.path.slice(7);
    else if (def.name !== "bash") path = pathOf(args.path ?? ".", c);
    trace.sourcePath = path ?? null;
    if (isWrite) {
      if (ensureWrite)
        c = await ensureWrite(def.name === "bash" ? null : path, {
          signal: combined,
          trace,
          binding,
        });
      binding.readChangeId = c.changeId;
      if (c.readOnly)
        throw problem(
          "SCOPE_REQUIRED",
          "Shell/写入需要明确scope；请next_change或refresh_change说明范围。",
        );
      if (
        ["accepted", "abandoned", "interrupted", "outcome_unknown"].includes(
          c.status,
        )
      )
        throw problem(
          "CHANGE_CLOSED",
          "当前修改已结束，请next_change或明确恢复。",
        );
      if (def.name !== "bash" && !inScope(path, c.scope))
        throw problem(
          "SCOPE",
          "写入范围不足；refresh_change保留草稿后扩大范围。",
        );
    }
    trace.sourcePath = path ?? null;
    trace.changeId = c.changeId;
    trace.cwd = c.workspace;
    trace.status = "running";
    save();
    onProgress({ type: "tool", tool: trace, task });
    guard();
    const cache = new Map();
    let native;
    async function sourceRead(absolute) {
      const p = pathOf(absolute, c);
      if (cache.has(p)) return cache.get(p);
      const value = await versioning.read({ changeId: c.changeId, path: p });
      if (value.contentBase64 === null)
        throw Object.assign(problem("ENOENT", "文件不存在：" + p), { path: p });
      const bytes = Buffer.from(value.contentBase64, "base64");
      cache.set(p, bytes);
      binding.reads.set(p, { hash: value.contentHash, version: value.version });
      binding.observations.set("file:" + p, {
        path: p,
        kind: "file",
        fingerprint: value.contentHash,
        version: value.version,
      });
      return bytes;
    }
    async function imageType(absolute) {
      const b = logRef ? await logBuffer(logRef) : await sourceRead(absolute);
      if (
        b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        return "image/png";
      if (b[0] === 255 && b[1] === 216) return "image/jpeg";
      if (b.subarray(0, 3).toString() === "GIF") return "image/gif";
      if (
        b.subarray(0, 4).toString() === "RIFF" &&
        b.subarray(8, 12).toString() === "WEBP"
      )
        return "image/webp";
      return null;
    }
    async function writeSource(absolute, content) {
      guard();
      if (combined.aborted) throw combined.reason;
      const p = pathOf(absolute, c),
        actual = await versioning.read({ changeId: c.changeId, path: p });
      const old =
        def.name === "edit"
          ? { hash: hash(cache.get(p)), version: c.privateVersion }
          : binding.reads.get(p);
      if (actual.contentHash !== null && !old)
        throw problem("NEED_READ", "覆盖已有文件前先read：" + p);
      const input = {
        requestId: trace.requestId,
        expectedVersion: c.privateVersion,
        edits: [
          {
            path: p,
            oldHash: old?.hash ?? null,
            contentBase64: Buffer.from(content).toString("base64"),
          },
        ],
      };
      trace.kernelInput = input;
      save();
      lastKernel = await versioning.edit(c.changeId, input, {
        signal: combined,
      });
      if (lastKernel.status !== "applied")
        throw problem("OPERATION_UNKNOWN", JSON.stringify(lastKernel));
      Object.assign(c, await versioning.inspect({ changeId: c.changeId }));
      binding.reviewedVersion = c.privateVersion;
      binding.failedMutations.delete(p);
      binding.reads.set(p, {
        hash: hash(Buffer.from(content)),
        version: c.privateVersion,
      });
      onChanged(c);
    }
    async function tree(requested) {
      const visible = [...new Set([...c.scope, ...c.readScope])],
        ranges = inScope(requested, visible)
          ? [requested]
          : visible.filter(
              (p) => requested === "." || p.startsWith(requested + "/"),
            );
      if (!ranges.length) throw problem("SCOPE", "读取超出可见源码投影。");
      const map = new Map();
      for (const p of ranges) {
        if (p !== ".") {
          const file = await versioning.read({ changeId: c.changeId, path: p });
          binding.observations.set("file:" + p, {
            path: p,
            kind: "file",
            fingerprint: file.contentHash,
            version: file.version,
          });
          if (file.contentBase64 !== null) {
            map.set(p, { path: p, mode: file.mode });
            continue;
          }
        }
        const r = await versioning.read({
          changeId: c.changeId,
          path: p,
          kind: "tree",
        });
        binding.observations.set("tree:" + p, {
          path: p,
          kind: "tree",
          fingerprint: r.fingerprint,
          version: r.version,
        });
        for (const e of r.entries) map.set(e.path, e);
      }
      return [...map.keys()].sort();
    }
    async function stableFiles(p) {
      const list = await tree(p);
      for (const name of list) {
        const st = lstatSync(join(c.workspace, name));
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1)
          throw problem("UNMANAGED_WRITE", "投影存在不受管类型。");
        const bytes = await sourceRead(join(c.workspace, name));
        if (!bytes.equals(readFileSync(join(c.workspace, name))))
          throw problem("UNMANAGED_WRITE", "投影与权威tree不一致。");
      }
      return list;
    }
    async function rg(args) {
      try {
        return (
          await exec("rg", args, {
            cwd: c.workspace,
            encoding: "utf8",
            maxBuffer: 8 * 1024 * 1024,
            signal: combined,
          })
        ).stdout;
      } catch (e) {
        if (e.code === 1) return "";
        throw e;
      }
    }
    function scrub(result) {
      const old =
        result?.details?.fullOutputPath ??
        result?.structuredContent?.full_output_path;
      if (old && old !== `output:${trace.requestId}`) tempPaths.add(old);
      if (def.name !== "bash") return result;
      const ref = `output:${trace.requestId}`;
      return {
        ...result,
        content: result.content?.map((x) =>
          x.type === "text"
            ? {
                ...x,
                text: [...tempPaths].reduce(
                  (s, p) => s.replaceAll(p, ref),
                  x.text,
                ),
              }
            : x,
        ),
        ...(result.details
          ? {
              details: {
                ...result.details,
                ...(old ? { fullOutputPath: ref } : {}),
                environment: "Linux 隔离环境",
                outputRef: trace.requestId,
              },
            }
          : {}),
        ...(result.structuredContent
          ? {
              structuredContent: {
                ...result.structuredContent,
                ...(result.structuredContent.full_output_path
                  ? { full_output_path: ref }
                  : {}),
              },
            }
          : {}),
      };
    }
    try {
      if (def.name === "read")
        native = createReadToolDefinition(c.workspace, {
          operations: {
            access: async (p) => {
              if (logRef) await logBuffer(logRef);
              else await sourceRead(p);
            },
            readFile: (p) => (logRef ? logBuffer(logRef) : sourceRead(p)),
            detectImageMimeType: logRef ? async () => null : imageType,
          },
        });
      if (def.name === "write")
        native = createWriteToolDefinition(c.workspace, {
          operations: {
            mkdir: async (p) => {
              pathOf(p, c);
            },
            writeFile: writeSource,
          },
        });
      if (def.name === "edit")
        native = createEditToolDefinition(c.workspace, {
          operations: {
            access: sourceRead,
            readFile: sourceRead,
            writeFile: writeSource,
          },
        });
      if (def.name === "ls") {
        const list = await tree(path);
        const exists = (p) => {
          const q = pathOf(p, c);
          return (
            q === "." || list.some((x) => x === q || x.startsWith(q + "/"))
          );
        };
        native = createLsToolDefinition(c.workspace, {
          operations: {
            exists,
            stat: (p) => {
              const q = pathOf(p, c);
              return {
                isDirectory: () =>
                  q === "." || list.some((x) => x.startsWith(q + "/")),
              };
            },
            readdir: (p) => {
              const q = pathOf(p, c),
                prefix = q === "." ? "" : q + "/";
              return [
                ...new Set(
                  list
                    .filter((x) => x.startsWith(prefix))
                    .map((x) => x.slice(prefix.length).split("/")[0]),
                ),
              ];
            },
          },
        });
      }
      if (def.name === "find") {
        await stableFiles(path);
        native = createFindToolDefinition(c.workspace, {
          operations: {
            exists: () => true,
            glob: async (pattern, where, opts) =>
              (
                await rg([
                  "--files",
                  "--hidden",
                  "--glob",
                  pattern,
                  "--",
                  pathOf(where, c),
                ])
              )
                .trim()
                .split("\n")
                .filter(Boolean)
                .slice(0, opts.limit),
          },
        });
      }
      if (def.name === "grep") {
        const list = await stableFiles(path);
        let text = "";
        if (list.length) {
          const flags = [
            "--line-number",
            "--no-heading",
            "--hidden",
            "--no-follow",
            ...(args.ignoreCase ? ["--ignore-case"] : []),
            ...(args.literal ? ["--fixed-strings"] : []),
            ...(args.context ? ["--context", String(args.context)] : []),
            ...(args.glob ? ["--glob", args.glob] : []),
            "--",
            args.pattern,
            ...list,
          ];
          text = await rg(flags);
        }
        trace.status = "completed";
        return {
          content: [{ type: "text", text: text || "No matches found" }],
        };
      }
      if (def.name === "bash")
        native = createBashToolDefinition(c.workspace, {
          exposeSessionEnvironment: false,
          operations: {
            exec: async (command, _cwd, opts) => {
              guard();
              const input = {
                requestId: trace.requestId,
                expectedVersion: c.privateVersion,
                command,
                ...(opts.timeout === undefined
                  ? {}
                  : { timeoutMs: Math.ceil(opts.timeout * 1000) }),
              };
              trace.timeoutMs = input.timeoutMs ?? null;
              trace.kernelInput = input;
              trace.outputRef = trace.requestId;
              save();
              lastKernel = await versioning.exec(c.changeId, input, {
                signal: combined,
                onData: opts.onData,
              });
              trace.exitCode = lastKernel.exitCode ?? null;
              trace.executionStatus = lastKernel.status;
              Object.assign(
                c,
                await versioning.inspect({ changeId: c.changeId }),
              );
              onChanged(c);
              if (lastKernel.status !== "completed") {
                if (lastKernel.status === "unknown")
                  binding.unknownOperation = trace.requestId;
                throw problem(
                  lastKernel.status === "unknown"
                    ? "OPERATION_UNKNOWN"
                    : "EXECUTION_" + lastKernel.status.toUpperCase(),
                  JSON.stringify(lastKernel),
                );
              }
              for (const p of lastKernel.changedFiles ?? [])
                binding.failedMutations.delete(p);
              binding.reviewedVersion = null;
              return { exitCode: lastKernel.exitCode };
            },
          },
        });
      const result = await native.execute(
        id,
        args,
        combined,
        (u) => onUpdate?.(scrub(u)),
        { ...ctx, cwd: c.workspace },
      );
      trace.status = combined.aborted
        ? "cancelled"
        : result.isError
          ? "failed"
          : "completed";
      const shown = scrub(result);
      if (isWrite)
        shown.content = [
          ...(shown.content ?? []),
          {
            type: "text",
            text: `agent-sync源码投影：${c.workspace}；私有版本：${c.privateVersion}。${def.name === "bash" ? `Linux隔离命令 exitCode=${lastKernel?.exitCode}；实际源变化=${JSON.stringify(lastKernel?.changedFiles ?? [])}；未导入辅助产物=${JSON.stringify(lastKernel?.ignoredFiles ?? [])}；日志 output:${trace.outputRef}。` : ""}`,
          },
        ];
      return {
        ...shown,
        details: {
          ...shown.details,
          agentSync: {
            changeId: c.changeId,
            privateVersion: c.privateVersion,
            workspace: c.workspace,
            outputRef: trace.outputRef ?? null,
            changedFiles: lastKernel?.changedFiles ?? lastKernel?.files ?? [],
            ignoredFiles: lastKernel?.ignoredFiles ?? [],
          },
        },
      };
    } catch (e) {
      trace.status = combined.aborted
        ? "cancelled"
        : binding.unknownOperation
          ? "unknown"
          : "failed";
      trace.error = e.message;
      throw e;
    } finally {
      trace.durationMs = performance.now() - started;
      for (const path of tempPaths)
        try {
          unlinkSync(path);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
      save();
    }
  }
  return prototypes.map((def) => ({
    ...def,
    async execute(...args) {
      const run = withChangeQueue(versioning, getChange().changeId, () => perform(def, ...args))
        .catch((e) => {
          const trace = (task.record.tools ?? []).find(
            (t) => t.toolCallId === args[0] && t.stageId === role().id,
          );
          if (trace) {
            trace.status = task.signal.aborted
              ? "cancelled"
              : e.code === "OPERATION_UNKNOWN"
                ? "unknown"
                : "failed";
            trace.error = e.message;
            if (["write", "edit"].includes(def.name))
              binding.failedMutations.set(
                trace.sourcePath ?? args[1]?.path,
                trace.requestId,
              );
            if (e.code === "OPERATION_UNKNOWN")
              binding.unknownOperation = trace.requestId;
            save();
          }
          throw e;
        });
      return run;
    },
  }));
}
