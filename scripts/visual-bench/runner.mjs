import { fork, execFileSync } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  openSync,
  closeSync,
  unlinkSync,
  createWriteStream,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createModelRuntime } from "../../src/pi-runtime.js";
import { resolveModelThinking } from "../../src/thinking.js";
import {
  loadRound,
  save,
  ROOT,
  fingerprint,
  readJson,
  validateConfig,
} from "./core.mjs";
import { startRelay } from "./relay.mjs";
export function modelSnapshot(model, ref) {
  return {
    provider: ref.provider,
    modelId: ref.modelId,
    name: model.name,
    api: model.api,
    baseUrl: model.baseUrl,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    input: model.input,
    compat: model.compat,
    thinkingLevelMap: model.thinkingLevelMap,
    thinkingLevel: ref.thinkingLevel,
    routing: ref.routing,
  };
}
export async function resolveConfig(config) {
  const home = resolve(config.sourceHome ?? join(homedir(), ".cothink"));
  const runtime = await createModelRuntime(home);
  return {
    ...config,
    sourceHome: home,
    models: await Promise.all(config.models.map(async (ref) => {
      const m = runtime.getModel(ref.provider, ref.modelId);
      if (!m)
        throw Error("找不到配置中的模型 " + ref.provider + "/" + ref.modelId);
      const thinkingLevel = await resolveModelThinking(m, ref.thinkingLevel);
      return modelSnapshot(m, m.reasoning || ref.thinkingLevel !== undefined ? {...ref,thinkingLevel} : ref);
    })),
  };
}
export async function runRound(dir, { onProgress = () => {}, signal } = {}) {
  dir = resolve(dir);
  const round = await loadRound(dir);
  validateConfig(round.config);
  if(round.workRequest?.kind!=="html-svg")throw Error("旧轮次仅供查看/报告；请prepare新的制作轮次，不重跑旧结果。");
  if (fingerprint() !== round.runtime.hash)
    throw Error(
      "脚本、CoThink 或依赖清单已变化，请 prepare 新轮次；旧结果不覆盖",
    );
  const attempts = round.attempts.filter(
    (a) => !existsSync(join(dir, "attempts", a.id, "status.json")),
  );
  const prior = round.attempts
    .filter((a) => existsSync(join(dir, "attempts", a.id, "status.json")))
    .map((a) => readJson(join(dir, "attempts", a.id, "status.json")));
  if (prior.some((s) => ["preparing", "running", "unknown"].includes(s.status)))
    throw Error("存在中断或未知任务，拒绝自动重发；请检查记录或建立新轮次");
  if (!attempts.length) return { status: "already-finished", attempts: 0 };
  const lock = join(dir, "run.lock");
  const fd = openSync(lock, "wx", 0o600);
  closeSync(fd);
  let relay;
  const children = [];
  let stop = false,
    rejectCancelled;
  const cancelled = new Promise((_, reject) => {
    rejectCancelled = reject;
  });
  cancelled.catch(() => {});
  const cancel = () => {
    stop = true;
    rejectCancelled(Error("已取消"));
    for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (signal?.aborted) throw Error("已取消");
    execFileSync("docker", ["image", "inspect", round.config.execution.image], {
      stdio: "pipe",
    });
    const runtime = await createModelRuntime(
      round.config.sourceHome ?? join(homedir(), ".cothink"),
    );
    const auth = [];
    for (const ref of round.config.models) {
      const m = runtime.getModel(ref.provider, ref.modelId);
      if (
        !m ||
        m.api !== ref.api ||
        m.baseUrl !== ref.baseUrl ||
        m.contextWindow !== ref.contextWindow
      )
        throw Error("模型目录发生变化，请 prepare 新轮次");
      const a = await runtime.getAuth(m);
      if (!a?.auth?.apiKey) throw Error("缺少 API key：" + ref.provider);
      auth.push(a.auth);
    }
    relay = await startRelay({ round, dir, auth, onProgress });
    relay.ledger.preflight(attempts);
    const pending = attempts.map((a) => {
      const root = join(dir, "attempts", a.id);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      save(join(root, "status.json"), { status: "preparing" });
      const env = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        SystemRoot: process.env.SystemRoot,
        TMPDIR: process.env.TMPDIR,
        TEMP: process.env.TEMP,
        COTHINK_HOME: join(root, "home"),
        PI_OFFLINE: "1",
        COTHINK_NO_UPDATE_CHECK: "1",
      };
      for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
      const child = fork(join(ROOT, "scripts/visual-bench/worker.mjs"), [], {
        cwd: root,
        env,
        execArgv: [],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      children.push(child);
      const log = createWriteStream(join(root, "worker.log"), {
        flags: "a",
        mode: 0o600,
      });
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      let finished = false,
        readyResolve,
        readyReject;
      const ready = new Promise((r, j) => {
        readyResolve = r;
        readyReject = j;
      });
      const done = new Promise((resolve) => {
        child.on("message", (m) => {
          if (m.type === "ready") readyResolve();
          if (m.type === "fatal") {
            readyReject(Error(m.error));
            save(join(root, "status.json"), {
              status: "failed",
              error: m.error,
            });
          }
          if (m.type === "done") {
            finished = true;
            onProgress({
              attempt: a.id,
              type: "done",
              status: m.outcome.status,
            });
          }
        });
        child.on("error", (e) => readyReject(e));
        child.on("exit", (code, exitSignal) => {
          log.end();
          if (!finished) {
            const status = {
              status: "unknown",
              error: `子进程退出 (${code ?? exitSignal})；未自动重发`,
            };
            save(join(root, "status.json"), status);
            readyReject(Error(status.error));
          }
          resolve();
        });
      });
      child.send({
        type: "init",
        round,
        attempt: a,
        dir,
        relay: relay.origin,
        token: relay.tokens.get(a.id),
      });
      return { child, ready, done };
    });
    let setupTimer;
    try {
      await Promise.race([
        Promise.all(pending.map((p) => p.ready)),
        cancelled,
        new Promise((_, reject) => {
          if (round.config.limits.maxMinutes !== null)
            setupTimer = setTimeout(
              () => reject(Error("初始化未在60秒内完成；未放行模型请求")),
              60000,
            );
        }),
      ]);
    } finally {
      clearTimeout(setupTimer);
    }
    if (stop || signal?.aborted) throw Error("已取消");
    const releasedAt = new Date().toISOString();
    save(join(dir, "run.json"), {
      releasedAt,
      attempts: attempts.map((a) => a.id),
      simultaneous: true,
    });
    for (const p of pending) p.child.send({ type: "go" });
    onProgress({ type: "released", count: pending.length, releasedAt });
    let watchdog;
    try {
      await Promise.race([
        Promise.all(pending.map((p) => p.done)),
        cancelled,
        new Promise((_, reject) => {
          if (round.config.limits.maxMinutes !== null)
            watchdog = setTimeout(
              () => reject(Error("子进程超过任务时限与清理宽限；保留未知结果")),
              round.config.limits.maxMinutes * 60000 + 30000,
            );
        }),
      ]);
    } finally {
      clearTimeout(watchdog);
    }
    const result = {
      status: "finished",
      attempts: attempts.length,
      budget: relay.ledger.summary(),
      endedAt: new Date().toISOString(),
    };
    save(join(dir, "run.json"), {
      ...readJson(join(dir, "run.json")),
      ...result,
    });
    return result;
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
    // Graceful cleanup first; a stuck worker must not survive the coordinator.
    await Promise.all(
      children.map((c) =>
        c.exitCode !== null || c.signalCode
          ? null
          : new Promise((r) => {
              const timer = setTimeout(() => {
                c.kill("SIGKILL");
                r();
              }, 5000);
              c.once("exit", () => {
                clearTimeout(timer);
                r();
              });
            }),
      ),
    );
    await relay?.close();
    unlinkSync(lock);
  }
}
