// C07/C08/C09. Only Docker can execute candidate commands. No host Shell fallback.
import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  rmSync,
  cpSync,
  lstatSync,
  openSync,
  writeSync,
  closeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { request as httpRequest } from "node:http";
import { directory, digest, atomic } from "./storage.js";
import { entries, materialize, scan, git } from "./git.js";
import { pathName, scopeList, covers, intersects, problem } from "./scope.js";
function appendLog(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw problem("IO", "Command log write made no progress");
    offset += written;
  }
}
export function validateExecution(value) {
  if (value === undefined) return undefined;
  const e = structuredClone(value);
  if (
    !e ||
    Object.keys(e).some(
      (k) =>
        !["engine", "image", "network", "limits", "artifactPaths"].includes(k),
    )
  )
    throw problem(
      "EXECUTOR_CONFIG",
      "Unknown execution fields; container env and mounts are fixed",
    );
  if (
    e.engine !== "docker" ||
    e.network !== "none" ||
    typeof e.image !== "string" ||
    !/^([a-zA-Z0-9._/:\-]+@sha256:[0-9a-f]{64}|sha256:[0-9a-f]{64})$/.test(
      e.image,
    )
  )
    throw problem(
      "EXECUTOR_CONFIG",
      "A fixed Docker image digest and network:none are required",
    );
  if (
    !e.limits ||
    !Number.isSafeInteger(e.limits.memoryBytes) ||
    e.limits.memoryBytes < 16777216 ||
    !Number.isFinite(e.limits.cpus) ||
    e.limits.cpus <= 0 ||
    !Number.isSafeInteger(e.limits.pids) ||
    e.limits.pids < 2
  )
    throw problem(
      "EXECUTOR_CONFIG",
      "Visible memory/cpu/pid limits are required",
    );
  e.artifactPaths = scopeList(e.artifactPaths, ["node_modules"]);
  if (e.artifactPaths.includes("."))
    throw problem("EXECUTOR_CONFIG", "Artifacts cannot cover all source");
  return e;
}
function docker(args, { onData, signal, log } = {}) {
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME };
    // Docker context credentials stay in the trusted CLI; never passed to the container.
    const p = spawn("docker", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let aborted = false,
      ioError;
    const abort = () => {
      aborted = true;
      p.kill("SIGKILL");
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const data = (b) => {
      chunks.push(b);
      try {
        log?.(b);
        onData?.(b);
      } catch (e) {
        ioError = e;
        p.kill("SIGKILL");
      }
    };
    p.stdout.on("data", data);
    p.stderr.on("data", data);
    p.on("error", reject);
    p.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (ioError) reject(ioError);
      else resolve({ code, output: Buffer.concat(chunks).toString(), aborted });
    });
  });
}
async function required(args) {
  let r;
  try {
    r = await docker(args);
  } catch (e) {
    throw problem("EXECUTOR_UNAVAILABLE", "Docker CLI/engine unavailable", {
      cause: e.message,
    });
  }
  if (r.code !== 0)
    throw problem("EXECUTOR_UNAVAILABLE", "Docker operation failed", {
      operation: args[0],
      output: r.output,
    });
  return r.output.trim();
}
export function createExecutor({ execution: e, data, root, onOperation }) {
  let ready, socketPath;
  const guards = new Map(),
    stats = { workContainers: 0, checkContainers: 0 };
  const summary = () => ({
    ...(e ?? { engine: "docker", available: false }),
    ...stats,
  });
  async function preflight() {
    if (!e)
      throw problem(
        "EXECUTOR_UNAVAILABLE",
        "Fixed Docker execution config required for Shell/checks",
      );
    // Always verify daemon reachability, even when image input was previously validated.
    await required(["version", "--format", "{{.Server.Version}}"]);
    const identity = await required([
      "image",
      "inspect",
      e.image,
      "--format",
      "{{.Id}}",
    ]);
    if (!/^sha256:[0-9a-f]{64}$/.test(identity))
      throw problem(
        "EXECUTOR_UNAVAILABLE",
        "Immutable local image identity missing",
      );
    ready = identity;
    return identity;
  }
  async function endpoint() {
    const host = JSON.parse(
      await required([
        "context",
        "inspect",
        "--format",
        "{{json .Endpoints.docker.Host}}",
      ]),
    );
    if (typeof host !== "string" || !host.startsWith("unix:///"))
      throw problem(
        "EXECUTOR_UNAVAILABLE",
        "First release requires the local Docker Unix socket",
      );
    socketPath = host.slice("unix://".length);
    return socketPath;
  }
  async function engine(method, path, body, { signal, onFrame } = {}) {
    if (!socketPath) await endpoint();
    return new Promise((resolve, reject) => {
      let frame = Buffer.alloc(0);
      const chunks = [];
      const encoded = method === "GET" ? "" : JSON.stringify(body ?? {});
      const req = httpRequest(
        {
          socketPath,
          method,
          path,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(encoded),
          },
        },
        (res) => {
          const streaming = onFrame && res.statusCode < 300;
          res.on("data", (b) => {
            try {
              if (!streaming) {
                chunks.push(b);
                return;
              }
              frame = Buffer.concat([frame, b]);
              while (frame.length >= 8) {
                const size = frame.readUInt32BE(4);
                if (size > 16 * 1024 * 1024)
                  throw problem(
                    "EXECUTION_UNKNOWN",
                    "Invalid Docker output frame",
                  );
                if (frame.length < 8 + size) break;
                onFrame(frame.subarray(8, 8 + size));
                frame = frame.subarray(8 + size);
              }
            } catch (e) {
              req.destroy(e);
            }
          });
          res.on("error", reject);
          res.on("end", () => {
            if (streaming) {
              if (frame.length)
                reject(
                  problem("EXECUTION_UNKNOWN", "Truncated Docker exec stream"),
                );
              else resolve(null);
              return;
            }
            const raw = Buffer.concat(chunks).toString();
            if (res.statusCode >= 300) {
              reject(
                problem("EXECUTION_UNKNOWN", "Docker exec API failed", {
                  status: res.statusCode,
                  body: raw,
                }),
              );
              return;
            }
            try {
              resolve(raw ? JSON.parse(raw) : null);
            } catch {
              reject(
                problem("EXECUTION_UNKNOWN", "Invalid Docker exec response"),
              );
            }
          });
        },
      );
      const abort = () =>
        req.destroy(problem("CANCELLED", "Docker exec cancelled"));
      req.on("error", (e) =>
        reject(
          e.code === "CANCELLED"
            ? e
            : problem("EXECUTION_UNKNOWN", "Docker exec transport lost", {
                cause: e.message,
              }),
        ),
      );
      req.on("close", () => signal?.removeEventListener("abort", abort));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      req.end(encoded);
    });
  }
  async function runCommand(
    name,
    command,
    { cwd = "/work", signal, onData, log, onExec } = {},
  ) {
    // Use Docker's exec primitive with its authoritative exec ID/exit inspection.
    // A broken local CLI/stream is never confused with a normal Shell exit code.
    const created = await engine(
      "POST",
      "/containers/" + encodeURIComponent(name) + "/exec",
      {
        AttachStdout: true,
        AttachStderr: true,
        AttachStdin: false,
        Tty: false,
        Cmd: command,
        WorkingDir: cwd,
      },
      { signal },
    );
    if (!created?.Id || !/^[0-9a-f]+$/.test(created.Id))
      throw problem("EXECUTION_UNKNOWN", "Missing Docker exec identity");
    onExec?.(created.Id);
    await engine(
      "POST",
      "/exec/" + created.Id + "/start",
      { Detach: false, Tty: false },
      {
        signal,
        onFrame: (b) => {
          log?.(b);
          onData?.(b);
        },
      },
    );
    const fact = await engine("GET", "/exec/" + created.Id + "/json");
    if (fact.Running || !Number.isSafeInteger(fact.ExitCode))
      throw problem(
        "EXECUTION_UNKNOWN",
        "Docker exec result cannot be confirmed",
      );
    return { code: fact.ExitCode, aborted: false };
  }
  async function state(name) {
    const r = await docker(["inspect", "--format", "{{json .State}}", name]);
    if (r.code !== 0) {
      if (/No such (object|container)/i.test(r.output)) return null;
      throw problem("EXECUTION_UNKNOWN", "Cannot confirm container state", {
        name,
        output: r.output,
      });
    }
    try {
      return JSON.parse(r.output);
    } catch {
      throw problem("EXECUTION_UNKNOWN", "Invalid container state", { name });
    }
  }
  async function terminate(name) {
    if (!name) return;
    const before = await state(name);
    if (!before) return;
    const removed = await docker(["rm", "--force", name]);
    if (removed.code !== 0)
      throw problem(
        "EXECUTION_UNKNOWN",
        "Could not remove container and all descendants",
        { name, output: removed.output },
      );
    if ((await state(name)) !== null)
      throw problem(
        "EXECUTION_UNKNOWN",
        "Container termination not confirmed",
        { name },
      );
    guards.get(name)?.stdin.end();
    guards.delete(name);
  }
  async function stopRecorded(c) {
    if (c.containerName) {
      await terminate(c.containerName);
      c.executionState =
        c.executionState === "needs_reset" ? "needs_reset" : "stopped";
    }
  }
  function sourceMap(c, map) {
    return new Map(
      [...map].filter(([p]) => covers([...c.scope, ...c.readScope], p)),
    );
  }
  function checkArtifacts(map, c) {
    for (const p of e.artifactPaths) {
      if (
        [...map.keys()].some((q) => intersects([p], [q])) ||
        (c &&
          [...c.scope, ...c.readScope].some((q) => q !== "." && covers([p], q)))
      )
        throw problem(
          "EXECUTOR_CONFIG",
          "Artifact paths cannot hide tracked source or explicit source contracts",
          { path: p },
        );
    }
  }
  function args(name, scratch) {
    const uid = process.getuid?.() ?? 1000,
      gid = process.getgid?.() ?? 1000;
    return [
      "create",
      "--interactive",
      "--name",
      name,
      "--label",
      "agent-sync=1",
      "--init",
      "--user",
      `${uid}:${gid}`,
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--network=none",
      "--ipc=private",
      "--memory",
      String(e.limits.memoryBytes),
      "--memory-swap",
      String(e.limits.memoryBytes),
      "--cpus",
      String(e.limits.cpus),
      "--pids-limit",
      String(e.limits.pids),
      "--mount",
      `type=bind,source=${scratch},target=/work`,
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,mode=1777",
      "--tmpfs",
      `/home/agent:rw,nosuid,nodev,mode=700,uid=${uid},gid=${gid}`,
      "--env",
      "HOME=/home/agent",
      "--env",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "--workdir",
      "/work",
      "--entrypoint",
      "/usr/local/bin/node",
      e.image,
      "-e",
      "process.on('SIGTERM',()=>process.exit(0));process.stdin.resume();process.stdin.on('end',()=>process.exit(0));setInterval(()=>{},2147483647)",
    ];
  }
  async function create(name, scratch) {
    await required(args(name, scratch));
    // This private stdin is the owner liveness channel. EOF on host death makes trusted
    // PID1 exit, which terminates the namespace including detached descendants.
    const guard = spawn(
      "docker",
      ["start", "--attach", "--interactive", name],
      {
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    guards.set(name, guard);
    let error;
    guard.stdin.on("error", () => {});
    guard.on("error", (e) => {
      error = e;
    });
    guard.stdout.resume();
    guard.stderr.resume();
    for (let i = 0; i < 200; i++) {
      if (error || guard.exitCode !== null)
        throw problem("EXECUTOR_UNAVAILABLE", "Owner liveness channel failed");
      if ((await state(name))?.Running) {
        await pause(name);
        return;
      }
      await delay(10);
    }
    throw problem("EXECUTOR_UNAVAILABLE", "Container failed to start");
  }
  async function pause(name) {
    const s = await state(name);
    if (!s?.Running)
      throw problem(
        "EXECUTION_UNKNOWN",
        "Work container stopped unexpectedly",
        { name },
      );
    if (!s.Paused) await required(["pause", name]);
    if (!(await state(name))?.Paused)
      throw problem(
        "EXECUTION_UNKNOWN",
        "Whole-container pause not confirmed",
        { name },
      );
  }
  async function resume(name) {
    const s = await state(name);
    if (!s?.Running || !s.Paused)
      throw problem("EXECUTION_UNKNOWN", "Expected running paused container", {
        name,
      });
    await required(["unpause", name]);
  }
  function signature(map) {
    return digest([...map].map(([p, v]) => [p, v.hash, v.mode]));
  }
  function stable(scratch) {
    // lstat scans never follow links. Freeze + two complete identical reads; any observed
    // async mutation refuses the entire import. This is source consistency, not DB consistency.
    const a = scan(scratch, { artifacts: e.artifactPaths }),
      b = scan(scratch, { artifacts: e.artifactPaths });
    if (signature(a.map) !== signature(b.map))
      throw problem("UNSTABLE_SNAPSHOT", "Source changed while frozen");
    return b;
  }
  async function syncSources(scratch, map) {
    // Container is paused. Preserve only the host-declared auxiliary directories.
    function prune(path, prefix = "") {
      for (const name of readdirSync(path)) {
        const rel = prefix + name,
          target = join(path, name);
        if (e.artifactPaths.includes(rel)) continue;
        if (e.artifactPaths.some((a) => a.startsWith(rel + "/"))) {
          if (!lstatSync(target).isDirectory())
            throw problem(
              "UNSUPPORTED",
              "Artifact ancestor is not a directory",
            );
          prune(target, rel + "/");
        } else rmSync(target, { recursive: true, force: true });
      }
    }
    prune(scratch);
    for (const [p, item] of map) {
      const target = join(scratch, p);
      mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(target, await git(root, ["cat-file", "blob", item.oid]), {
        mode: item.mode === "100755" ? 0o755 : 0o644,
      });
    }
  }
  async function archive(c) {
    if (!c.scratch || !existsSync(c.scratch)) return c.executionArchive ?? null;
    const destination = join(
      data,
      "execution",
      "archive-" + c.changeId + "-" + randomUUID(),
    );
    // rename the original directory: includes unsupported entries without following any link.
    const { renameSync } = await import("node:fs");
    renameSync(c.scratch, destination);
    return {
      path: destination,
      reason: "Unimported source preserved; commands are never replayed",
    };
  }
  async function exec(
    c,
    input,
    { signal, onData, save, request, persistRequest },
  ) {
    if (
      typeof input.command !== "string" ||
      !input.command ||
      (input.timeoutMs !== undefined &&
        (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0))
    )
      throw problem(
        "INPUT",
        "command and optional positive timeoutMs required",
      );
    const cwd = input.cwd === undefined ? "." : pathName(input.cwd, true);
    if (!covers([...c.scope, ...c.readScope], cwd) && cwd !== ".")
      throw problem("SCOPE", "cwd outside source projection");
    await preflight();
    const all = await entries(root, c.privateVersion);
    checkArtifacts(all, c);
    const before = sourceMap(c, all);
    c.scratch ??= join(data, "execution", "work-" + c.changeId);
    c.containerName ??= "agent-sync-work-" + c.changeId;
    request.containerName = c.containerName;
    request.expectedVersion = c.privateVersion;
    request.outputRef = input.requestId;
    persistRequest(request);
    save(c);
    let logFd,
      timeout,
      started = false;
    const timerAbort = new AbortController(),
      opSignal = signal
        ? AbortSignal.any([signal, timerAbort.signal])
        : timerAbort.signal;
    try {
      if (!(await state(c.containerName))) {
        await materialize(root, before, c.scratch);
        c.executionState = "creating";
        save(c);
        await create(c.containerName, c.scratch);
        stats.workContainers++;
        c.containerCreates = (c.containerCreates ?? 0) + 1;
      } else {
        await pause(c.containerName);
        await syncSources(c.scratch, before);
      }
      c.executionState = "running";
      save(c);
      logFd = openSync(
        join(data, "logs", input.requestId + ".log"),
        "wx",
        0o600,
      );
      if (input.timeoutMs !== undefined)
        timeout = setTimeout(() => timerAbort.abort(), input.timeoutMs);
      if (opSignal.aborted)
        throw problem("CANCELLED", "Cancelled before command start");
      await resume(c.containerName);
      started = true;
      onOperation({
        action: "command_start",
        changeId: c.changeId,
        requestId: input.requestId,
      });
      const result = await runCommand(
        c.containerName,
        ["/bin/bash", "-lc", input.command],
        {
          cwd: cwd === "." ? "/work" : "/work/" + cwd,
          signal: opSignal,
          onData,
          log: (b) => appendLog(logFd, b),
          onExec: (execId) => {
            request.execId = execId;
            persistRequest(request);
          },
        },
      );
      if (result.aborted || opSignal.aborted) {
        await terminate(c.containerName);
        c.executionState = "stopped";
        save(c);
        return {
          status: "cancelled",
          requestId: input.requestId,
          exitCode: null,
          privateVersion: c.privateVersion,
          changedFiles: [],
          ignoredFiles: [],
          outputRef: input.requestId,
        };
      }
      // Docker transport errors cannot masquerade as a command's ordinary nonzero exit.
      await pause(c.containerName);
      const frozen = stable(c.scratch);
      if (!(await state(c.containerName))?.Paused)
        throw problem("EXECUTION_UNKNOWN", "Freeze lost during extraction");
      const source = new Map(),
        allPaths = new Set([...before.keys(), ...frozen.map.keys()]);
      for (const p of allPaths) {
        const old = before.get(p),
          now = frozen.map.get(p);
        if (!old && !now) continue;
        const differs =
          !old ||
          !now ||
          old.mode !== now.mode ||
          digest(await git(root, ["cat-file", "blob", old.oid])) !== now.hash;
        if (differs) {
          if (!covers(c.scope, p))
            throw problem("SCOPE", "Shell changed source outside write scope", {
              path: p,
            });
          source.set(p, now ?? null);
        }
      }
      // A third content pass binds the imported bytes to the still-frozen live projection.
      if (
        signature(scan(c.scratch, { artifacts: e.artifactPaths }).map) !==
        signature(frozen.map)
      )
        throw problem("UNSTABLE_SNAPSHOT", "Snapshot changed before import");
      c.executionState = "paused";
      save(c);
      onOperation({
        action: "command_end",
        changeId: c.changeId,
        requestId: input.requestId,
        exitCode: result.code,
        changedFiles: [...source.keys()],
      });
      // Evaluate ignore rules from the *pre-command* projection; generated ignored
      // source stays in the import and is also reported. A command cannot hide it.
      let ignored = [];
      if (frozen.map.size) {
        try {
          ignored = (
            await git(
              root,
              [
                "--work-tree=" + c.workspace,
                "check-ignore",
                "--no-index",
                "-z",
                "--stdin",
              ],
              [...frozen.map.keys()].join("\0") + "\0",
            )
          )
            .toString()
            .split("\0")
            .filter(Boolean);
        } catch (e) {
          if (e.exitCode !== 1) throw e;
        }
      }
      return {
        status: "completed",
        exitCode: result.code,
        source,
        ignoredFiles: [...new Set([...frozen.ignored, ...ignored])],
        outputRef: input.requestId,
      };
    } catch (error) {
      if (opSignal.aborted) {
        await terminate(c.containerName);
        c.executionState = "stopped";
        save(c);
        return {
          status: "cancelled",
          requestId: input.requestId,
          outputRef: input.requestId,
          exitCode: null,
          privateVersion: c.privateVersion,
          changedFiles: [],
          ignoredFiles: [],
        };
      }
      if (!started) {
        await terminate(c.containerName);
        throw error;
      }
      if (error.code === "EXECUTION_UNKNOWN") {
        await terminate(c.containerName);
        c.executionState = "needs_reset";
        save(c);
        return {
          status: "unknown",
          requestId: input.requestId,
          privateVersion: c.privateVersion,
          outputRef: input.requestId,
          error: { code: error.code, message: error.message },
          evidence: { scratch: c.scratch },
        };
      }
      try {
        await pause(c.containerName);
        c.executionState = "needs_reset";
        save(c);
        return {
          status: "rejected",
          requestId: input.requestId,
          privateVersion: c.privateVersion,
          exitCode: null,
          changedFiles: [],
          ignoredFiles: [],
          outputRef: input.requestId,
          error: {
            code: error.code ?? "IO",
            message: error.message,
            details: error.details,
          },
          evidence: { scratch: c.scratch },
        };
      } catch {
        await terminate(c.containerName);
        c.executionState = "needs_reset";
        save(c);
        return {
          status: "unknown",
          requestId: input.requestId,
          outputRef: input.requestId,
          error: { code: error.code ?? "IO", message: error.message },
        };
      }
    } finally {
      clearTimeout(timeout);
      if (logFd !== undefined) closeSync(logFd);
    }
  }
  async function check(tree, checks, signal, binding, onContainer) {
    const workspace = join(data, "execution", "check-" + randomUUID()),
      name = "agent-sync-check-" + randomUUID();
    if (!checks.length)
      return {
        status: "passed",
        verification: "unverified",
        tree,
        workspace: null,
        checks: [],
        binding,
      };
    onContainer?.(name);
    await preflight();
    const map = await entries(root, tree);
    checkArtifacts(map);
    directory(workspace);
    await materialize(root, map, workspace);
    const sourcePolicy = digest([...map]),
      results = [];
    try {
      await create(name, workspace);
      stats.checkContainers++;
      for (const c of checks) {
        if (signal?.aborted)
          return {
            status: "cancelled",
            verification: "unverified",
            checks: results,
            tree,
            workspace,
            binding,
          };
        const outputRef = "check-" + randomUUID(),
          fd = openSync(join(data, "logs", outputRef + ".log"), "wx", 0o600),
          local = new AbortController();
        let timeout;
        if (c.timeoutMs) timeout = setTimeout(() => local.abort(), c.timeoutMs);
        const combined = signal
          ? AbortSignal.any([signal, local.signal])
          : local.signal;
        let r;
        try {
          await resume(name);
          r = await runCommand(name, [c.command, ...(c.args ?? [])], {
            signal: combined,
            log: (b) => appendLog(fd, b),
          });
        } catch (error) {
          if (!combined.aborted) throw error;
          r = { code: null, aborted: true };
        } finally {
          clearTimeout(timeout);
          closeSync(fd);
        }
        if (combined.aborted)
          return {
            status: signal?.aborted ? "cancelled" : "check_failed",
            verification: "unverified",
            checks: [
              ...results,
              {
                command: c.command,
                args: c.args ?? [],
                exitCode: null,
                outputRef,
                cancelled: true,
              },
            ],
            tree,
            workspace,
            binding,
          };
        await pause(name);
        const snapshot = stable(workspace),
          expected = new Map([...map].map(([p, e]) => [p, e]));
        let modified = snapshot.map.size !== map.size;
        for (const [p, item] of expected) {
          const actual = snapshot.map.get(p);
          if (
            !actual ||
            actual.mode !== item.mode ||
            actual.hash !==
              digest(await git(root, ["cat-file", "blob", item.oid]))
          )
            modified = true;
        }
        results.push({
          command: c.command,
          args: c.args ?? [],
          exitCode: r.code,
          outputRef,
          sourceChanged: modified,
        });
        if (r.code !== 0 || modified)
          return {
            status: "check_failed",
            verification: "unverified",
            checks: results,
            tree,
            workspace,
            binding: { ...binding, sourcePolicy, image: ready },
            reason: modified ? "CHECK_MODIFIED_SOURCE" : "CHECK_EXIT",
          };
      }
      return {
        status: "passed",
        verification: "passed",
        checks: results,
        tree,
        workspace,
        binding: { ...binding, sourcePolicy, image: ready },
      };
    } finally {
      await terminate(name);
    }
  }
  return {
    summary,
    preflight,
    exec,
    check,
    stopRecorded,
    stopName: terminate,
    archive,
  };
}
