/** Independent local agent-sync API (protocolVersion 1).
 * C01-C06/C09-C11. Callers own actors/plans/models; this module owns versions.
 */
import {
  existsSync,
  realpathSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  renameSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  git,
  textGit,
  entries,
  writeTree,
  commit,
  metadata,
  merge,
  materialize,
  assertProjection,
  sameEntry,
  changed,
  diff,
} from "./git.js";
import { directory, atomic, load, digest, ownerAt } from "./storage.js";
import {
  problem,
  pathName,
  scopeList,
  covers,
  intersects,
  aliases,
  identifier,
} from "./scope.js";
import { createExecutor, validateExecution } from "./executor.js";
const canonical = (x) => JSON.stringify(sort(x));
function sort(x) {
  return Array.isArray(x)
    ? x.map(sort)
    : x && typeof x === "object"
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, sort(x[k])]),
        )
      : x;
}
const signalOf = (...signals) => {
  const list = signals.filter(Boolean);
  return list.length ? AbortSignal.any(list) : undefined;
};
const copy = (x) => structuredClone(x);
function publicChange(change) {
  const value = copy(change);
  delete value.owner;
  delete value.privateRef;
  return value;
}
const checkAbort = (signal) => {
  if (signal?.aborted) throw problem("CANCELLED", "Operation cancelled");
};
function checksPolicy(checks) {
  if (
    !Array.isArray(checks) ||
    checks.some(
      (c) =>
        !c ||
        Object.keys(c).some(
          (k) => !["command", "args", "timeoutMs"].includes(k),
        ) ||
        typeof c.command !== "string" ||
        !c.command ||
        (c.args !== undefined &&
          (!Array.isArray(c.args) ||
            c.args.some((a) => typeof a !== "string"))) ||
        c.env !== undefined ||
        (c.timeoutMs !== undefined &&
          (!Number.isSafeInteger(c.timeoutMs) || c.timeoutMs <= 0)),
    )
  )
    throw problem(
      "CHECK_POLICY",
      "checks require command, string args and optional positive timeoutMs; secret env is unsupported",
    );
  return copy(checks);
}
/** @returns {Promise<object>} A local owner. Always await close(). */
export async function createAgentSync({
  project,
  home,
  checks = [],
  execution,
  signal,
  onOperation = () => {},
  readOnly = false,
  integrationRef,
} = {}) {
  checks = checksPolicy(checks);
  execution = validateExecution(execution);
  if (
    typeof project !== "string" ||
    typeof home !== "string" ||
    typeof onOperation !== "function" ||
    typeof readOnly !== "boolean"
  )
    throw problem(
      "INPUT",
      "project/home and valid factory options are required",
    );
  let root, common;
  try {
    root = await textGit(realpathSync(resolve(project)), [
      "rev-parse",
      "--show-toplevel",
    ]);
    common = realpathSync(
      await textGit(root, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
    );
  } catch {
    throw problem(
      "NOT_GIT",
      "Existing Git repository required; initialization is explicit",
    );
  }
  home = resolve(home);
  if (home === root || home.startsWith(root + "/"))
    throw problem("INPUT", "home must be outside the source checkout");
  if (
    integrationRef !== undefined &&
    (!/^refs\/(heads|agent-sync)\/[a-zA-Z0-9_./-]+$/.test(integrationRef) ||
      integrationRef.includes(".."))
  )
    throw problem("INPUT", "Invalid integrationRef");
  const projectId = digest(common).slice(0, 24),
    data = join(home, "projects", projectId),
    metaPath = join(data, "project.json"),
    registry = join(common, "agent-sync");
  // Validate source types before creating owner/data. Git never executes a source hook/driver.
  try {
    const custom = await textGit(root, [
      "config",
      "--local",
      "--get-regexp",
      "^merge\\..*\\.driver$",
    ]);
    if (custom)
      throw problem(
        "UNSUPPORTED",
        "External Git merge drivers require an isolated merge implementation",
      );
  } catch (e) {
    if (e.code === "UNSUPPORTED") throw e;
    if (e.exitCode !== 1) throw e;
  }
  const initial = await textGit(root, [
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ]);
  await entries(root, initial);
  let meta = existsSync(metaPath) ? load(metaPath) : null;
  if (
    meta &&
    (meta.projectId !== projectId ||
      meta.common !== common ||
      meta.protocolVersion !== 1 ||
      (integrationRef && integrationRef !== meta.integrationRef))
  )
    throw problem("CORRUPT", "Project identity/ref mismatch");
  if (readOnly && !meta)
    throw problem("NO_PROJECT", "No initialized managed project");
  if (meta) await verifyCommit(meta.integrationRef, true);
  const shutdown = new AbortController();
  let closeFailed = false;
  let owner,
    closed = false,
    closing,
    watch;
  const changes = new Map(),
    requests = new Map(),
    pending = new Map(),
    queues = new Map(),
    waiters = [],
    aborts = new Map(),
    allWork = new Set(),
    reservations = new Map();
  const policy = digest({ checks, execution: execution ?? null });
  const executor = createExecutor({
    execution,
    data,
    root,
    onOperation: (e) => emit(e),
  });
  const file = (kind, id) => join(data, kind, identifier(id) + ".json");
  const emit = (e) => {
    try {
      onOperation({ cwd: root, changedFiles: [], explanation: e.action, ...e });
    } catch {
      /* observer cannot alter authority */
    }
  };
  function active() {
    if (closed || closing || closeFailed)
      throw problem("OWNER_LOST", "Instance closed/closing");
    if (readOnly) throw problem("READ_ONLY", "Read-only instance");
    owner.assert();
  }
  function save(c) {
    owner.assert();
    atomic(file("changes", c.changeId), c);
  }
  function persistRequest(r) {
    owner.assert();
    atomic(file("requests", r.requestId), r);
  }
  if (readOnly) {
    for (const name of readdirSync(join(data, "requests")).filter((n) =>
      n.endsWith(".json"),
    )) {
      const r = load(join(data, "requests", name));
      requests.set(r.requestId, r);
    }
  }
  if (!readOnly) {
    owner = ownerAt(join(registry, "owners"));
    try {
      for (const p of [
        data,
        join(data, "changes"),
        join(data, "requests"),
        join(data, "workspaces"),
        join(data, "logs"),
        join(data, "execution"),
      ])
        directory(p);
      const registration = join(registry, "project.json"),
        registered = existsSync(registration) ? load(registration) : null;
      if (
        registered &&
        registered.integrationRef !==
          (meta?.integrationRef ?? integrationRef ?? registered.integrationRef)
      )
        throw problem("PROJECT_MISMATCH", "One formal ref per project");
      if (!meta) {
        const ref =
          integrationRef ??
          registered?.integrationRef ??
          "refs/agent-sync/" + projectId + "/main";
        if (registered && !integrationRef)
          throw problem(
            "PROJECT_MISMATCH",
            "Different home requires explicit existing integrationRef",
          );
        let start = initial;
        if (integrationRef || registered) start = await verifyCommit(ref, true);
        else {
          await git(root, [
            "update-ref",
            ref,
            initial,
            "0".repeat(initial.length),
          ]);
        }
        meta = {
          protocolVersion: 1,
          projectId,
          common,
          root,
          integrationRef: ref,
          createdFrom: start,
        };
        atomic(metaPath, meta);
      }
      atomic(registration, {
        projectId,
        integrationRef: meta.integrationRef,
        home,
      });
      for (const name of readdirSync(join(data, "changes")).filter((n) =>
        n.endsWith(".json"),
      )) {
        const c = load(join(data, "changes", name));
        identifier(c.changeId);
        changes.set(c.changeId, c);
      }
      for (const name of readdirSync(join(data, "requests")).filter((n) =>
        n.endsWith(".json"),
      )) {
        const r = load(join(data, "requests", name));
        requests.set(r.requestId, r);
      }
      // Recovery has side effects only here in a new writer, never inspect/read.
      for (const c of changes.values()) {
        c.privateVersion = await textGit(root, ["rev-parse", c.privateRef]);
        const privateMeta = await metadata(root, c.privateVersion);
        if (privateMeta?.kind === "refresh") {
          const request = requests.get(privateMeta.requestId);
          if (
            request?.privateVersion === c.privateVersion &&
            request.refreshState &&
            canonical(privateMeta) === canonical(request.commitMetadata) &&
            privateMeta.stateDigest === digest(request.refreshState)
          ) {
            Object.assign(c, copy(request.refreshState));
          }
        }
        const fact = await acceptedChange(c.changeId);
        if (fact) {
          c.status = "accepted";
          c.acceptedVersion = fact.acceptedVersion;
        } else if (!["accepted", "abandoned"].includes(c.status)) {
          await executor.stopRecorded(c);
          c.status = "interrupted";
          c.executionState =
            c.executionState === "needs_reset" ? "needs_reset" : "stopped";
        }
        save(c);
      }
      for (const r of requests.values())
        if (r.checkContainerName) await executor.stopName(r.checkContainerName);
      for (const r of requests.values())
        if (r.status === "pending") {
          r.status = "unknown";
          persistRequest(r);
        }
    } catch (e) {
      owner.release();
      throw e;
    }
    watch = setInterval(() => {
      try {
        owner.assert();
      } catch {
        shutdown.abort();
        for (const a of aborts.values()) a.abort();
      }
    }, 100);
    watch.unref();
  }
  const api = {
    projectId,
    root,
    directory: data,
    integrationRef: meta.integrationRef,
    beginChange,
    read,
    edit,
    exec: execute,
    prepareChange,
    refreshChange,
    acceptChange,
    inspect,
    abandonChange,
    checkCurrent,
    close,
  };
  return api;
  async function verifyCommit(version, ref = false) {
    if (
      !ref &&
      (typeof version !== "string" || !/^([0-9a-f]{20,128})$/.test(version))
    )
      throw problem("VERSION", "Opaque version identifier required");
    try {
      return await textGit(root, [
        "rev-parse",
        "--verify",
        version + "^{commit}",
      ]);
    } catch {
      throw problem("VERSION", "Unknown or missing project version");
    }
  }
  async function tip() {
    return verifyCommit(meta.integrationRef, true);
  }
  function getChange(id) {
    identifier(id);
    if (changes.has(id)) return changes.get(id);
    const p = file("changes", id);
    if (!existsSync(p)) throw problem("CHANGE", "Unknown change");
    return load(p);
  }
  function assertChange(c, { recover = false } = {}) {
    active();
    if (!recover && c.owner !== owner.token)
      throw problem(
        "OWNER_LOST",
        "Change authorization belongs to an old owner; refresh explicitly",
      );
    if (
      ["accepted", "abandoned", "interrupted", "waiting"].includes(c.status) &&
      !recover
    )
      throw problem("CHANGE_CLOSED", "Change is closed");
    checkAbort(
      signalOf(signal, shutdown.signal, aborts.get(c.changeId)?.signal),
    );
  }
  function serial(id, fn) {
    const prev = queues.get(id) ?? Promise.resolve(),
      run = prev.catch(() => {}).then(fn);
    queues.set(id, run);
    allWork.add(run);
    run
      .finally(() => {
        allWork.delete(run);
        if (queues.get(id) === run) queues.delete(id);
      })
      .catch(() => {});
    return run;
  }
  function operation(method, id, payload, fn) {
    active();
    identifier(id);
    const hash = digest(canonical({ method, payload }));
    const old = requests.get(id);
    if (old && old.hash !== hash)
      return Promise.reject(
        problem("REQUEST_MISMATCH", "requestId bound to different payload"),
      );
    if (pending.has(id)) return pending.get(id);
    if (old && old.status !== "blocked")
      return requestFact(old).then((f) => {
        if (f.error && !old.result && old.status === "rejected")
          throw problem(f.error.code, f.error.message);
        return copy(f);
      });
    const r = {
      requestId: id,
      method,
      hash,
      status: "pending",
      owner: owner.token,
      nonce: randomUUID(),
      payload: copy(payload),
    };
    persistRequest(r);
    requests.set(id, r);
    const task = (async () => {
      try {
        const result = await fn(r);
        r.status = result.status ?? "completed";
        r.result = copy(result);
        persistRequest(r);
        if (method === "acceptChange")
          emit({ action: "before_response", requestId: id });
        return result;
      } catch (e) {
        if (
          method === "acceptChange" &&
          e.code === "CANCELLED" &&
          !r.committed
        ) {
          const result = {
            status: "cancelled",
            requestId: id,
            changeId: payload.changeId ?? r.changeId,
          };
          r.result = result;
          r.status = "cancelled";
          try {
            persistRequest(r);
          } catch {}
          return result;
        }
        if (r.committed || e.code === "EXECUTION_UNKNOWN") {
          r.status = "unknown";
          try {
            persistRequest(r);
          } catch {}
          return {
            status: "unknown",
            requestId: id,
            changeId: payload.changeId ?? r.changeId,
          };
        }
        r.status = "rejected";
        r.error = { code: e.code ?? "IO", message: e.message };
        try {
          persistRequest(r);
        } catch {}
        throw e;
      } finally {
        pending.delete(id);
      }
    })();
    pending.set(id, task);
    allWork.add(task);
    task.finally(() => allWork.delete(task)).catch(() => {});
    return task;
  }
  function currentStatus(c) {
    if (c.status === "accepted" || c.status === "abandoned") return c.status;
    return !readOnly && c.owner === owner.token ? c.status : "interrupted";
  }
  async function formalHistory() {
    return (await textGit(root, ["rev-list", "--first-parent", await tip()]))
      .split("\n")
      .filter(Boolean);
  }
  async function acceptedRequest(r) {
    if (r.method !== "acceptChange" || !r.proposedVersion) return null;
    const history = await formalHistory();
    if (!history.includes(r.proposedVersion)) return null;
    const m = await metadata(root, r.proposedVersion);
    if (!m || canonical(m) !== canonical(r.commitMetadata)) return null;
    const parent = await textGit(root, ["rev-parse", r.proposedVersion + "^"]);
    if (
      parent !== r.expectedTip ||
      m.nonce !== r.nonce ||
      m.projectId !== projectId ||
      m.requestId !== r.requestId ||
      m.policy !== r.policy
    )
      return null;
    return {
      requestId: r.requestId,
      changeId: r.payload.changeId,
      candidateVersion: r.payload.candidateVersion,
      expectedTip: r.expectedTip,
      status: "accepted",
      acceptedVersion: r.proposedVersion,
      verification: r.verification,
      checks: r.checks ?? [],
    };
  }
  function requestRecord(id) {
    return readOnly
      ? existsSync(file("requests", id))
        ? load(file("requests", id))
        : null
      : requests.get(id);
  }
  async function acceptedChange(id) {
    const records = readOnly
      ? readdirSync(join(data, "requests"))
          .filter((n) => n.endsWith(".json"))
          .map((n) => load(join(data, "requests", n)))
      : requests.values();
    for (const r of records)
      if (r.method === "acceptChange" && r.payload.changeId === id) {
        const f = await acceptedRequest(r);
        if (f) return f;
      }
    return null;
  }
  async function requestFact(r) {
    const accepted = await acceptedRequest(r);
    if (accepted) return accepted;
    if (r.method === "acceptChange" && r.result?.status === "accepted") {
      return {
        status: "unknown",
        requestId: r.requestId,
        changeId: r.payload.changeId,
        proposedVersion: r.proposedVersion,
        reason: "HISTORY_CHANGED",
      };
    }
    if (r.method === "edit" && r.privateVersion) {
      const c = getChange(r.payload.changeId),
        head = await textGit(root, ["rev-parse", c.privateRef]);
      const chain = (
        await textGit(root, ["rev-list", "--first-parent", head])
      ).split("\n");
      if (
        chain.includes(r.privateVersion) &&
        canonical(await metadata(root, r.privateVersion)) ===
          canonical(r.commitMetadata)
      )
        return {
          status: "applied",
          requestId: r.requestId,
          privateVersion: r.privateVersion,
          files: r.files,
        };
    }
    if (r.result) return copy(r.result);
    if (r.error)
      return { status: r.status, error: r.error, requestId: r.requestId };
    return {
      status: r.status === "pending" ? "unknown" : r.status,
      requestId: r.requestId,
      changeId: r.payload?.changeId ?? r.changeId,
    };
  }
  async function known(version) {
    const v = await verifyCommit(version),
      history = await formalHistory();
    if (history.includes(v)) return v;
    for (const c of allChanges()) {
      if (
        c.baseVersion === v ||
        c.privateVersion === v ||
        c.candidates?.some((p) => p.candidateVersion === v)
      )
        return v;
      const head = await textGit(root, ["rev-parse", c.privateRef]);
      if ((await textGit(root, ["rev-list", head])).split("\n").includes(v))
        return v;
    }
    throw problem("VERSION", "Version is outside this project history");
  }
  function allChanges() {
    return readOnly
      ? readdirSync(join(data, "changes"))
          .filter((n) => n.endsWith(".json"))
          .map((n) => load(join(data, "changes", n)))
      : [...changes.values()];
  }
  function blockers(scope, id) {
    return [
      ...changes.values(),
      ...[...reservations].map(([changeId, scope]) => ({
        changeId,
        scope,
        owner: owner.token,
        status: "reserved",
      })),
    ]
      .filter(
        (c) =>
          c.changeId !== id &&
          c.owner === owner.token &&
          !c.readOnly &&
          !["accepted", "abandoned", "interrupted", "waiting"].includes(
            c.status,
          ) &&
          intersects(c.scope, scope),
      )
      .map((c) => ({ changeId: c.changeId, scope: c.scope }));
  }
  function wake() {
    for (const waiter of [...waiters]) waiter.tryGrant();
  }
  function acquire(scope, id, wait, opSignal) {
    checkAbort(opSignal);
    return new Promise((resolve, reject) => {
      const w = {
        scope,
        id,
        tryGrant() {
          try {
            active();
            checkAbort(opSignal);
            const b = blockers(scope, id),
              earlier = waiters
                .slice(0, waiters.indexOf(w))
                .filter((q) => intersects(q.scope, scope));
            if (b.length || earlier.length) {
              if (!wait) {
                remove();
                resolve({
                  status: "blocked",
                  blockers: [
                    ...b,
                    ...earlier.map((q) => ({ changeId: q.id, scope: q.scope })),
                  ],
                });
              }
              return;
            }
            reservations.set(id, scope);
            remove();
            resolve({ status: "granted" });
          } catch (e) {
            remove();
            reject(e);
          }
        },
      };
      const cancel = () => {
        remove();
        reject(problem("CANCELLED", "Waiting authorization cancelled"));
        wake();
      };
      function remove() {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        opSignal?.removeEventListener("abort", cancel);
      }
      waiters.push(w);
      opSignal?.addEventListener("abort", cancel, { once: true });
      w.tryGrant();
    });
  }
  function visible(c, map) {
    return new Map(
      [...map].filter(([p]) => covers([...c.scope, ...c.readScope], p)),
    );
  }
  async function projection(c) {
    await assertProjection(
      root,
      visible(c, await entries(root, c.privateVersion)),
      c.workspace,
    );
  }
  async function projectChange(c) {
    await materialize(
      root,
      visible(c, await entries(root, c.privateVersion)),
      c.workspace,
    );
    c.projectionVersion = c.privateVersion;
  }
  function fingerprint(map, path, kind) {
    return digest(
      [...map]
        .filter(([p]) =>
          kind === "file"
            ? p === path
            : path === "." || p === path || p.startsWith(path + "/"),
        )
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  async function register(c, path, kind) {
    const key = kind + ":" + path;
    if (!Object.hasOwn(c.basis, key)) {
      const map = await entries(root, c.baseVersion);
      c.basis[key] = { path, kind, fingerprint: fingerprint(map, path, kind) };
      c.basisRevision++;
      if (c.status === "prepared") c.status = "open";
    }
  }
  async function basisChanges(c, latest) {
    const current = await entries(root, latest),
      old = await entries(root, c.baseVersion),
      items = [];
    for (const b of Object.values(c.basis))
      if (fingerprint(current, b.path, b.kind) !== b.fingerprint)
        items.push({
          ...b,
          changedPaths: changed(old, current).filter((p) =>
            b.kind === "file" ? p === b.path : covers([b.path], p),
          ),
        });
    return items;
  }
  async function beginChange(input, options = {}) {
    active();
    const scope = scopeList(input.scope, []),
      readScope = scopeList(input.readScope, ["."]);
    if (!input.readOnly && !scope.length)
      throw problem("SCOPE", "Writable change needs a nonempty scope");
    if (input.readOnly && scope.length)
      throw problem("SCOPE", "Read-only changes have no write scope");
    if (
      typeof input.actor !== "string" ||
      !input.actor ||
      typeof input.intent !== "string" ||
      !input.intent
    )
      throw problem("INPUT", "actor and intent required");
    return operation("beginChange", input.requestId, input, async (r) => {
      const id = randomUUID(),
        controller = new AbortController(),
        opSignal = signalOf(
          signal,
          shutdown.signal,
          options.signal,
          controller.signal,
        );
      r.changeId = id;
      persistRequest(r);
      aborts.set(id, controller);
      emit({ action: "queued", changeId: id, changedFiles: scope });
      const grant = await acquire(scope, id, input.wait !== false, opSignal);
      if (grant.status === "blocked") return grant;
      // Reservation is inserted synchronously before the next acquire observes grants.
      const c = {
        changeId: id,
        actor: input.actor,
        intent: input.intent,
        readOnly: !!input.readOnly,
        scope,
        readScope,
        owner: owner.token,
        status: "open",
        basisStatus: "current",
        basis: {},
        basisRevision: 0,
        candidates: [],
        executionState: "absent",
        workspace: join(data, "workspaces", id),
        privateRef: "refs/agent-sync/" + projectId + "/private/" + id,
      };
      changes.set(id, c);
      reservations.delete(id);
      try {
        c.baseVersion = await tip();
        if (input.baseVersion && input.baseVersion !== c.baseVersion)
          throw problem(
            "STALE_BASE",
            "Explicit base is not the granted current version",
            { version: c.baseVersion },
          );
        c.privateVersion = c.baseVersion;
        const source = await entries(root, c.baseVersion);
        aliases([...source.keys(), ...scope, ...readScope], "SCOPE");
        if (input.restoreFrom) {
          const old = await entries(root, await known(input.restoreFrom));
          for (const p of new Set([...source.keys(), ...old.keys()]))
            if (covers(scope, p)) {
              if (old.has(p)) source.set(p, old.get(p));
              else source.delete(p);
            }
          c.privateVersion = await commit(
            root,
            await writeTree(root, source),
            [c.baseVersion],
            {
              kind: "restore",
              projectId,
              changeId: id,
              restoreFrom: input.restoreFrom,
            },
          );
        }
        await git(root, [
          "update-ref",
          c.privateRef,
          c.privateVersion,
          "0".repeat(c.privateVersion.length),
        ]);
        r.committed = true;
        await projectChange(c);
        save(c);
        checkAbort(opSignal);
        const cancel = () => {
          controller.abort();
          serial(id, () => abandonInternal(c, "interrupted")).catch(() => {});
        };
        options.signal?.addEventListener("abort", cancel, { once: true });
        signal?.addEventListener("abort", cancel, { once: true });
        c.cancelCleanup = undefined; // listeners are process-local, never part of saved authorization.
        emit({
          action: "granted",
          changeId: id,
          changedFiles: scope,
          version: c.baseVersion,
        });
        return publicChange(c);
      } catch (e) {
        c.status = "interrupted";
        if (c.privateVersion) save(c);
        else changes.delete(id);
        wake();
        throw e;
      }
    });
  }
  async function read(input) {
    if (input.outputRef !== undefined) {
      identifier(input.outputRef);
      const offset = input.offset ?? 0,
        limit = input.limit ?? 65536;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 1048576
      )
        throw problem("INPUT", "Invalid log range");
      const content = readFileSync(
          join(data, "logs", input.outputRef + ".log"),
        ),
        page = content.subarray(offset, offset + limit);
      return {
        contentBase64: page.toString("base64"),
        nextOffset: Math.min(content.length, offset + page.length),
        eof: offset + page.length >= content.length,
      };
    }
    if ((input.changeId === undefined) === (input.version === undefined))
      throw problem("INPUT", "Choose changeId or version");
    if (input.changeId !== undefined)
      return serial(input.changeId, async () => {
        const c = getChange(input.changeId),
          path = pathName(input.path, true),
          kind = input.kind ?? "file";
        if (!covers([...c.scope, ...c.readScope], path))
          throw problem("SCOPE", "Read outside visible source projection");
        const authority = await textGit(root, ["rev-parse", c.privateRef]);
        const result = await readAt(authority, path, kind);
        if (
          !readOnly &&
          c.owner === owner.token &&
          !["accepted", "abandoned", "interrupted"].includes(c.status)
        )
          await register(c, path, kind);
        return result;
      });
    return readAt(
      await known(input.version),
      pathName(input.path, true),
      input.kind ?? "file",
    );
  }
  async function readAt(version, path, kind) {
    const map = await entries(root, version);
    if (kind === "directory" || kind === "tree") {
      const selected = [...map].filter(
        ([p]) => path === "." || p.startsWith(path + "/"),
      );
      const list =
        kind === "tree"
          ? selected.map(([path, e]) => ({ path, mode: e.mode, object: e.oid }))
          : Array.from(
              new Set(
                selected.map(
                  ([p]) =>
                    p.slice(path === "." ? 0 : path.length + 1).split("/")[0],
                ),
              ),
            )
              .sort()
              .map((name) => ({
                path: path === "." ? name : path + "/" + name,
              }));
      return {
        version,
        entries: list,
        fingerprint: fingerprint(map, path, kind),
      };
    }
    if (kind !== "file" || path === ".")
      throw problem("INPUT", "Unknown read kind or file path");
    const e = map.get(path),
      content = e ? await git(root, ["cat-file", "blob", e.oid]) : null;
    return {
      version,
      contentBase64: content?.toString("base64") ?? null,
      contentHash: content === null ? null : digest(content),
      mode: e?.mode ?? null,
    };
  }
  async function edit(changeId, input, options = {}) {
    return operation("edit", input.requestId, { changeId, ...input }, (r) =>
      serial(changeId, async () => {
        const c = getChange(changeId);
        assertChange(c);
        if (c.readOnly)
          throw problem(
            "NO_WRITE_CHANGE",
            "Read-only observation has no write authorization",
          );
        checkAbort(options.signal);
        if (input.expectedVersion !== c.privateVersion)
          throw problem("STALE_PRIVATE", "Private version changed");
        await projection(c);
        if (!Array.isArray(input.edits) || !input.edits.length)
          throw problem("INPUT", "Nonempty edits required");
        const map = await entries(root, c.privateVersion),
          seen = new Set();
        for (const e of input.edits) {
          const p = pathName(e.path);
          if (seen.has(p)) throw problem("INPUT", "Duplicate edit path");
          seen.add(p);
          if (!covers(c.scope, p))
            throw problem("SCOPE", "Edit outside write authorization", {
              path: p,
            });
          const old = map.get(p),
            hash = old
              ? digest(await git(root, ["cat-file", "blob", old.oid]))
              : null;
          if (e.oldHash !== hash)
            throw problem("PRECONDITION", "Old content differs", { path: p });
          if (e.mode !== undefined && !["100644", "100755"].includes(e.mode))
            throw problem("UNSUPPORTED", "Unsupported source mode");
          if (
            e.contentBase64 !== null &&
            (typeof e.contentBase64 !== "string" ||
              Buffer.from(e.contentBase64, "base64").toString("base64") !==
                e.contentBase64)
          )
            throw problem("INPUT", "Canonical base64 content required");
        }
        for (const e of input.edits) await register(c, e.path, "file");
        for (const e of input.edits) {
          if (e.contentBase64 === null) map.delete(e.path);
          else
            map.set(e.path, {
              mode: e.mode ?? map.get(e.path)?.mode ?? "100644",
              oid: await textGit(
                root,
                ["hash-object", "-w", "--stdin"],
                Buffer.from(e.contentBase64, "base64"),
              ),
            });
        }
        return importTree(c, map, r, options.signal);
      }),
    );
  }
  async function importTree(c, map, r, opSignal) {
    const before = c.privateVersion,
      tree = await writeTree(root, map),
      files = changed(await entries(root, before), map);
    for (const p of files)
      if (!covers(c.scope, p))
        throw problem("SCOPE", "Changed source outside write authorization", {
          path: p,
        });
    const m = {
      kind: "private",
      projectId,
      changeId: c.changeId,
      requestId: r.requestId,
      nonce: r.nonce,
      hash: r.hash,
    };
    const version = await commit(root, tree, [before], m);
    r.privateVersion = version;
    r.files = files;
    r.commitMetadata = m;
    persistRequest(r);
    assertChange(c);
    checkAbort(opSignal);
    await git(root, ["update-ref", c.privateRef, version, before]);
    r.committed = true;
    emit({
      action: "private_ref_updated",
      requestId: r.requestId,
      changeId: c.changeId,
    });
    c.privateVersion = version;
    c.status = "open";
    save(c);
    try {
      await projectChange(c);
    } catch (e) {
      c.projectionError = e.message;
      save(c);
      throw e;
    }
    emit({ action: "edit", changeId: c.changeId, changedFiles: files });
    return {
      status: "applied",
      requestId: r.requestId,
      privateVersion: version,
      files,
    };
  }
  async function prepareChange(changeId, options = {}) {
    const requestId = options.requestId ?? randomUUID();
    return operation(
      "prepareChange",
      requestId,
      { changeId, check: options.check ?? false },
      (r) =>
        serial(changeId, async () => {
          const c = getChange(changeId);
          assertChange(c);
          checkAbort(options.signal);
          if (c.readOnly)
            throw problem("NO_WRITE_CHANGE", "Observation cannot be prepared");
          await projection(c);
          if (c.executionState === "needs_reset")
            throw problem(
              "EXECUTION_NEEDS_RESET",
              "Preserve/reset failed environment before continuing",
            );
          const delta = await diff(root, c.baseVersion, c.privateVersion);
          if (!delta.files.length)
            throw problem("NO_WRITE_CHANGE", "No source changes");
          const p = {
            privateVersion: c.privateVersion,
            tree: await textGit(root, [
              "rev-parse",
              c.privateVersion + "^{tree}",
            ]),
            basis: copy(c.basis),
            basisRevision: c.basisRevision,
            policy,
          };
          p.candidateVersion = await commit(root, p.tree, [c.privateVersion], {
            kind: "candidate",
            projectId,
            changeId,
            requestId: r.requestId,
            binding: digest(p),
            nonce: r.nonce,
          });
          c.candidates.push(p);
          c.candidateVersion = p.candidateVersion;
          c.status = "prepared";
          c.diff = delta;
          c.ignoredFiles ??= [];
          save(c);
          if (options.check) {
            const result = await executor.check(
              p.tree,
              checks,
              signalOf(signal, shutdown.signal, options.signal),
              { candidateVersion: p.candidateVersion, policy },
              (name) => {
                r.checkContainerName = name;
                persistRequest(r);
              },
            );
            p.precheck = result;
            save(c);
          }
          return publicChange(c);
        }),
    );
  }
  async function refreshChange(changeId, input, options = {}) {
    if (typeof input.reason !== "string" || !input.reason.trim())
      throw problem("INPUT", "Explicit refresh reason required");
    return operation(
      "refreshChange",
      input.requestId,
      { changeId, ...input },
      (r) =>
        serial(changeId, async () => {
          const c = getChange(changeId);
          assertChange(c, { recover: true });
          if (["accepted", "abandoned"].includes(c.status))
            throw problem("CHANGE_CLOSED", "Cannot refresh ended change");
          const scope = scopeList(input.scope, c.scope),
            readScope = scopeList(input.readScope, c.readScope),
            oldBase = c.baseVersion;
          if (c.readOnly && scope.length)
            throw problem(
              "SCOPE",
              "Read-only observation cannot become a writer through refresh; start an explicit writable change",
            );
          const beforeMap = await entries(root, c.privateVersion),
            baseMap = await entries(root, oldBase);
          if (changed(baseMap, beforeMap).some((p) => !covers(scope, p)))
            throw problem("SCOPE", "New scope must retain every draft change");
          if (c.executionState === "needs_reset" && !input.resetExecution)
            throw problem(
              "EXECUTION_NEEDS_RESET",
              "Explicit resetExecution required; unimported files preserved",
            );
          if (c.owner === owner.token && c.executionState !== "needs_reset") {
            try {
              await projection(c);
            } catch (e) {
              if (!input.resetExecution) throw e;
              const archive = join(
                data,
                "execution",
                "projection-" + changeId + "-" + randomUUID(),
              );
              renameSync(c.workspace, archive);
              c.projectionArchive = archive;
              save(c);
            }
          }
          await executor.stopRecorded(c);
          if (input.resetExecution)
            c.executionArchive = await executor.archive(c);
          const expanded =
            scope.some((p) => !covers(c.scope, p)) || c.owner !== owner.token;
          if (expanded) {
            c.status = "waiting";
            save(c);
            wake();
            const g = await acquire(
              scope,
              changeId,
              options.wait !== false,
              signalOf(signal, shutdown.signal, options.signal),
            );
            if (g.status === "blocked") return g;
          }
          reservations.delete(changeId);
          c.owner = owner.token;
          c.scope = scope;
          c.readScope = readScope;
          c.status = "open";
          const latest = await tip(),
            combo = await merge(root, oldBase, c.privateVersion, latest);
          const current = await entries(root, latest),
            newBasis = copy(c.basis);
          for (const b of Object.values(newBasis))
            b.fingerprint = fingerprint(current, b.path, b.kind);
          const feedback = {
            oldBase,
            newBase: latest,
            changes: await diff(root, oldBase, latest),
            merge: combo,
          };
          r.refreshState = {
            baseVersion: latest,
            scope,
            readScope,
            basis: newBasis,
            basisRevision: c.basisRevision + 1,
            basisStatus: "current",
            refresh: feedback,
            executionState: "stopped",
            executionArchive: c.executionArchive ?? null,
            projectionArchive: c.projectionArchive ?? null,
            conflicts: combo.status === "conflict" ? combo.details : null,
          };
          r.commitMetadata = {
            kind: "refresh",
            projectId,
            changeId,
            requestId: r.requestId,
            oldBase,
            latest,
            nonce: r.nonce,
            stateDigest: digest(r.refreshState),
          };
          const oldPrivate = c.privateVersion,
            mergedVersion = await commit(
              root,
              combo.tree,
              [oldPrivate, latest],
              r.commitMetadata,
            );
          r.privateVersion = mergedVersion;
          persistRequest(r);
          await git(root, [
            "update-ref",
            c.privateRef,
            mergedVersion,
            oldPrivate,
          ]);
          r.committed = true;
          emit({
            action: "refresh_ref_updated",
            requestId: r.requestId,
            changeId,
          });
          c.privateVersion = mergedVersion;
          Object.assign(c, copy(r.refreshState));
          save(c);
          await projectChange(c);
          return {
            ...publicChange(c),
            status: combo.status === "conflict" ? "conflict" : "open",
            feedback,
          };
        }),
    );
  }
  async function execute(changeId, input, options = {}) {
    return operation("exec", input.requestId, { changeId, ...input }, (r) =>
      serial(changeId, async () => {
        const c = getChange(changeId);
        assertChange(c);
        if (c.readOnly)
          throw problem(
            "NO_WRITE_CHANGE",
            "Read-only change cannot execute Shell",
          );
        if (input.expectedVersion !== c.privateVersion)
          throw problem("STALE_PRIVATE", "Private version changed");
        await projection(c);
        if (c.executionState === "needs_reset")
          throw problem("EXECUTION_NEEDS_RESET", "Explicit reset required");
        for (const p of [...new Set([...c.scope, ...c.readScope])])
          await register(c, p, "tree");
        save(c);
        const result = await executor.exec(c, input, {
          signal: signalOf(
            signal,
            shutdown.signal,
            options.signal,
            aborts.get(changeId)?.signal,
          ),
          onData: options.onData,
          save,
          request: r,
          persistRequest,
        });
        if (result.status !== "completed") {
          if (result.status === "cancelled" || result.status === "unknown")
            await abandonInternal(c, "interrupted");
          return result;
        }
        const map = await entries(root, c.privateVersion);
        for (const [p, e] of result.source) {
          if (e === null) map.delete(p);
          else
            map.set(p, {
              mode: e.mode,
              oid: await textGit(
                root,
                ["hash-object", "-w", "--stdin"],
                e.data,
              ),
            });
        }
        const imported = await importTree(c, map, r, options.signal);
        c.ignoredFiles = result.ignoredFiles;
        save(c);
        return {
          status: "completed",
          requestId: input.requestId,
          exitCode: result.exitCode,
          privateVersion: imported.privateVersion,
          changedFiles: imported.files,
          ignoredFiles: result.ignoredFiles,
          outputRef: result.outputRef,
        };
      }),
    );
  }
  async function acceptChange(input, options = {}) {
    return operation("acceptChange", input.requestId, input, (r) =>
      serial(input.changeId, async () => {
        const c = getChange(input.changeId),
          fact = await acceptedChange(c.changeId);
        if (fact) return fact;
        assertChange(c);
        checkAbort(options.signal);
        await projection(c);
        const p = c.candidates.find(
          (p) => p.candidateVersion === input.candidateVersion,
        );
        if (
          !p ||
          c.status !== "prepared" ||
          p.privateVersion !== c.privateVersion ||
          p.basisRevision !== c.basisRevision ||
          p.policy !== policy
        )
          return {
            status: "stale",
            requestId: r.requestId,
            changeId: c.changeId,
          };
        const worktrees = await textGit(root, [
          "worktree",
          "list",
          "--porcelain",
        ]);
        if (worktrees.split("\n").includes("branch " + meta.integrationRef))
          throw problem(
            "CHECKED_OUT",
            "Formal ref is checked out; conditional ref update would desynchronize its checkout",
          );
        const expectedTip = await tip(),
          basis = await basisChanges(c, expectedTip);
        if (basis.length) {
          c.basisStatus = "changed";
          save(c);
          return {
            status: "basis_changed",
            requestId: r.requestId,
            changeId: c.changeId,
            oldVersion: c.baseVersion,
            newVersion: expectedTip,
            changes: basis,
          };
        }
        const combo = await merge(
          root,
          c.baseVersion,
          input.candidateVersion,
          expectedTip,
        );
        if (combo.status === "conflict")
          return {
            status: "conflict",
            requestId: r.requestId,
            changeId: c.changeId,
            ...combo,
          };
        const before = await entries(root, expectedTip),
          after = await entries(root, combo.tree);
        if (changed(before, after).some((p) => !covers(c.scope, p)))
          throw problem("SCOPE", "Composition delta exceeds write scope");
        r.expectedTip = expectedTip;
        r.policy = policy;
        r.tree = combo.tree;
        persistRequest(r);
        emit({
          action: "prepared_receipt",
          requestId: r.requestId,
          changeId: c.changeId,
        });
        const checked = await executor.check(
          combo.tree,
          checks,
          signalOf(
            signal,
            shutdown.signal,
            options.signal,
            aborts.get(c.changeId)?.signal,
          ),
          { candidateVersion: p.candidateVersion, expectedTip, policy },
          (name) => {
            r.checkContainerName = name;
            persistRequest(r);
          },
        );
        r.checks = checked.checks;
        r.verification = checked.verification;
        r.expectedTip = expectedTip;
        r.policy = policy;
        r.tree = combo.tree;
        persistRequest(r);
        emit({
          action: "checks_complete",
          requestId: r.requestId,
          changeId: c.changeId,
        });
        if (checked.status !== "passed")
          return { ...checked, requestId: r.requestId, changeId: c.changeId };
        const m = {
          kind: "accepted",
          projectId,
          requestId: r.requestId,
          changeId: c.changeId,
          candidateVersion: p.candidateVersion,
          expectedTip,
          tree: combo.tree,
          policy,
          result: digest(checked),
          nonce: r.nonce,
        };
        r.commitMetadata = m;
        r.proposedVersion = await commit(root, combo.tree, [expectedTip], m);
        persistRequest(r);
        await executor.stopRecorded(c);
        emit({
          action: "before_ref_update",
          requestId: r.requestId,
          changeId: c.changeId,
          expectedTip,
        });
        // No await between final cancellation/owner decision and spawning the sole ref CAS.
        assertChange(c);
        checkAbort(options.signal);
        try {
          await git(root, [
            "update-ref",
            meta.integrationRef,
            r.proposedVersion,
            expectedTip,
          ]);
        } catch (e) {
          return {
            status: "stale",
            requestId: r.requestId,
            expectedTip,
            proposedVersion: r.proposedVersion,
          };
        }
        r.committed = true;
        emit({
          action: "ref_updated",
          requestId: r.requestId,
          changeId: c.changeId,
          acceptedVersion: r.proposedVersion,
        });
        c.status = "accepted";
        c.acceptedVersion = r.proposedVersion;
        save(c);
        wake();
        emit({
          action: "records_saved",
          requestId: r.requestId,
          changeId: c.changeId,
        });
        emit({
          action: "accepted",
          changeId: c.changeId,
          changedFiles: changed(before, after),
          acceptedVersion: r.proposedVersion,
        });
        return {
          status: "accepted",
          requestId: r.requestId,
          changeId: c.changeId,
          candidateVersion: p.candidateVersion,
          expectedTip,
          acceptedVersion: r.proposedVersion,
          verification: checked.verification,
          checks: checked.checks,
        };
      }),
    );
  }
  async function abandonInternal(c, status) {
    const fact = await acceptedChange(c.changeId);
    if (fact) return fact;
    await executor.stopRecorded(c);
    c.status = status;
    c.executionState =
      c.executionState === "needs_reset" ? "needs_reset" : "stopped";
    save(c);
    wake();
    return { status, changeId: c.changeId, privateVersion: c.privateVersion };
  }
  async function abandonChange(changeId, options = {}) {
    active();
    aborts.get(changeId)?.abort();
    return operation(
      "abandonChange",
      options.requestId ?? randomUUID(),
      { changeId },
      () =>
        serial(changeId, () => {
          const c = getChange(changeId);
          return abandonInternal(c, "abandoned");
        }),
    );
  }
  async function inspect(input = {}) {
    if (
      Object.keys(input).filter((k) =>
        ["changeId", "requestId", "history", "fromVersion"].includes(k),
      ).length > 1
    )
      throw problem("INPUT", "Inspection modes are mutually exclusive");
    if (input.requestId) {
      identifier(input.requestId);
      const r = requestRecord(input.requestId);
      return r
        ? requestFact(r)
        : { status: "not_found", requestId: input.requestId };
    }
    if (input.changeId) {
      const c = copy(getChange(input.changeId)),
        fact = await acceptedChange(c.changeId);
      c.status = fact ? "accepted" : currentStatus(c);
      if (fact) c.acceptedVersion = fact.acceptedVersion;
      else if (c.status === "accepted") {
        c.status = "outcome_unknown";
        c.proposedVersion = c.acceptedVersion;
        delete c.acceptedVersion;
        c.reason = "HISTORY_CHANGED";
      }
      c.privateVersion = await textGit(root, ["rev-parse", c.privateRef]);
      c.basisStatus = (await basisChanges(c, await tip())).length
        ? "changed"
        : "current";
      c.blockers = readOnly ? [] : blockers(c.scope, c.changeId);
      return publicChange(c);
    }
    if (input.history) {
      const limit = input.history.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw problem("INPUT", "history.limit must be 1..100");
      const chain = await formalHistory(),
        cursor = input.history.cursor;
      const start = cursor ? chain.indexOf(cursor) + 1 : 0;
      if (cursor && !start) throw problem("VERSION", "Unknown history cursor");
      const versions = [];
      for (const version of chain.slice(start, start + limit)) {
        const m = await metadata(root, version);
        let fact = null;
        if (m?.requestId) {
          const r = requestRecord(m.requestId);
          if (r) fact = await acceptedRequest(r);
        }
        const c = fact ? getChange(fact.changeId) : null;
        versions.push({
          version,
          parents: (await textGit(root, ["show", "-s", "--format=%P", version]))
            .split(" ")
            .filter(Boolean),
          changeId: c?.changeId ?? null,
          actor: c?.actor ?? null,
          verification: fact?.verification ?? "unverified",
        });
      }
      return {
        versions,
        nextCursor:
          start + limit < chain.length ? versions.at(-1).version : null,
      };
    }
    if (input.fromVersion !== undefined || input.toVersion !== undefined)
      return diff(
        root,
        await known(input.fromVersion),
        await known(input.toVersion),
      );
    return {
      backend: "agent-sync",
      protocolVersion: 1,
      projectId,
      root,
      directory: data,
      integrationRef: meta.integrationRef,
      version: await tip(),
      checks: copy(checks),
      execution: executor.summary(),
      policy,
    };
  }
  async function checkCurrent(options = {}) {
    return operation(
      "checkCurrent",
      options.requestId ?? randomUUID(),
      {},
      (request) =>
        serial("$formal", async () => {
          const version = await tip(),
            tree = await textGit(root, ["rev-parse", version + "^{tree}"]);
          const r = await executor.check(
            tree,
            checks,
            signalOf(signal, shutdown.signal, options.signal),
            { version, policy },
            (name) => {
              request.checkContainerName = name;
              persistRequest(request);
            },
          );
          return {
            ...r,
            status: (await tip()) === version ? r.status : "stale",
            version,
            requestId: request.requestId,
          };
        }),
    );
  }
  async function close() {
    if (closed) return;
    if (closing) return closing;
    closing = (async () => {
      if (readOnly) {
        closed = true;
        return;
      }
      shutdown.abort();
      for (const a of aborts.values()) a.abort();
      wake();
      await Promise.allSettled([...allWork]);
      for (const c of changes.values())
        if (
          c.owner === owner.token &&
          !["accepted", "abandoned", "interrupted"].includes(c.status)
        )
          await abandonInternal(c, "interrupted");
      clearInterval(watch);
      owner.release();
      closed = true;
    })().catch((error) => {
      // Keep ownership and the stopped/unknown state. An explicit close retry can
      // finish cleanup after the engine returns; no mutation is re-enabled.
      closeFailed = true;
      closing = undefined;
      throw error;
    });
    return closing;
  }
}
