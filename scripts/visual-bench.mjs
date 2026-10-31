#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { prepareRound, readJson, ROOT } from "./visual-bench/core.mjs";
import { resolveConfig, runRound } from "./visual-bench/runner.mjs";
const help = `Visual benchmark (only run sends model requests)
  node scripts/visual-bench.mjs init --config bench.json
  node scripts/visual-bench.mjs prepare --tasks tasks.txt --config bench.json [--out round-directory]
  node scripts/visual-bench.mjs run --round round-directory
  node scripts/visual-bench.mjs view --round round-directory
  node scripts/visual-bench.mjs report --round round-directory
  node scripts/visual-bench.mjs summary --runs runs-directory

Prompt: 做一个{题目}的动态html界面，svg，不允许联网
All question × group attempts launch together. No automatic retry or old-session continuation.
`;
export async function main(args = process.argv.slice(2)) {
  const [command] = args;
  const value = (name, fallback) => {
    const i = args.indexOf(name);
    if (i < 0) return fallback;
    if (!args[i + 1] || args[i + 1].startsWith("--"))
      throw Error("缺少 " + name + " 参数");
    return args[i + 1];
  };
  if (!command || command === "--help") {
    console.log(help);
    return;
  }
  if (command === "init") {
    const path = resolve(value("--config", "bench.json"));
    if (existsSync(path)) throw Error("配置已存在，不覆盖");
    const sourceHome = join(homedir(), ".cothink"),
      saved = readJson(join(sourceHome, "config.json"));
    const team =
      saved.teams?.find((t) => t.id === saved.lastUsedTeamId) ?? saved;
    const config = {
      sourceHome,
      piResources:{skills:saved.piResources?.skills??[]},
      models: [team.main, team.secondary?.[0]].map((m) => {
        if (!m) throw Error("当前 CoThink 尚未配置两个模型");
        return {
          provider: m.provider,
          modelId: m.modelId,
          ...(m.thinkingLevel ? { thinkingLevel: m.thinkingLevel } : {}),
        };
      }),
      limits: { maxMinutes: null, maxCalls: null, outputTokens: null },
      budgets: [
        {
          currency: "USD",
          limit: null,
          inputPerMillion: null,
          outputPerMillion: null,
        },
        {
          currency: "CNY",
          limit: null,
          inputPerMillion: null,
          outputPerMillion: null,
        },
      ],
      execution: {
        ...readJson(join(ROOT, "packages/agent-sync/execution-manifest.json"))
          .execution,
        image:readJson(join(ROOT,"docker/visual-preview-manifest.json")).image,
        limits: { memoryBytes: 2147483648, cpus: 1, pids: 256 },
        artifactPaths: [],
      },
    };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(config, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      "已写入 " +
        path +
        "；核对两个图像模型、显式技能路径并填写计价信息后 prepare。金额、时间、调用次数和输出token默认均不设本地上限；可在 prepare 前显式修改。",
    );
    return;
  }
  if (command === "prepare") {
    const tasks = readFileSync(resolve(value("--tasks", "tasks.txt")), "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const config = await resolveConfig(
      readJson(resolve(value("--config", "bench.json"))),
    );
    const out = resolve(
      value(
        "--out",
        join(
          ROOT,
          "work/visual-bench/runs",
          new Date().toISOString().replace(/[:.]/g, "-"),
        ),
      ),
    );
    const { mkdirSync } = await import("node:fs");
    mkdirSync(resolve(out, ".."), { recursive: true });
    const r = await prepareRound({ out, tasks, config });
    console.log(
      JSON.stringify(
        {
          round: out,
          version: r.runtime.version,
          attempts: r.attempts.length,
          prompts: r.questions.map((q) => q.prompt),
          limits: config.limits,
          budgets: config.budgets,
          paidRequests: 0,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "summary") {
    const { summarize } = await import("./visual-bench/viewer.mjs");
    console.log(
      JSON.stringify(
        await summarize(
          resolve(value("--runs", join(ROOT, "work/visual-bench/runs"))),
        ),
        null,
        2,
      ),
    );
    return;
  }
  const dir = value("--round");
  if (!dir) throw Error("需要 --round");
  if (command === "run") {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      console.log(
        JSON.stringify(
          await runRound(dir, {
            signal: controller.signal,
            onProgress: (e) => console.log(JSON.stringify(e)),
          }),
          null,
          2,
        ),
      );
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    return;
  }
  if (command === "view") {
    const { openViewer } = await import("./visual-bench/viewer.mjs");
    await openViewer(resolve(dir));
    return;
  }
  if (command === "report") {
    const { report } = await import("./visual-bench/viewer.mjs");
    console.log(JSON.stringify(await report(resolve(dir)), null, 2));
    return;
  }
  throw Error("未知命令\n" + help);
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
