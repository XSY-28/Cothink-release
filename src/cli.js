import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig, positiveInteger } from "./config.js";
import { setupModels, migrateTeamConfig, importLegacyConfig, parseTurnInput } from "./setup.js";
import { resolveTeamConfig } from "./teams.js";
import { runTurn } from "./discussion.js";
import { listTasks, readTask } from "./task.js";
import { listRuns, readRun } from "./storage.js";
import {
  budgetText,
  renderTask,
  taskJson,
  inspectWork,
} from "./presentation.js";
import {
  renderRun,
  safeText,
  openTerminal,
  setupIO,
  questionFromTerminal,
} from "./terminal.js";
const help = `CoThink
用法：cothink | cothink -c | cothink -r
  cothink init                       选择主副模型、复用 Pi 认证并命名 team
  cothink init --import-legacy        显式备份并导入旧配置（不生成）
  cothink [ask] [--one] [--all|--json] [问题]
  cothink history [--json] | cothink show ID [--all|--json]
  cothink migrate-work 项目路径 [--rollback] [--json]  显式旧格式迁移/无新接纳时回退
  cat question.txt | cothink
/one <任务>：仅本条使用主模型；纯答一次。默认第一位副模型评审，主模型修订，共三次。
/chat 或 Ctrl+O 查看完整讨论；Esc 返回。Esc / Ctrl+C 取消整条任务。
/changelog 查看随安装包提供的 CoThink 完整更新记录；升级后首次启动显示摘要。
/new /resume /fork /tree /reload 复用 Pi；运行时拒绝切换并保留草稿。
/team 选择、新建、调整、删除组合；/models 编辑阵容并另存 team；/login /logout 认证，/thinking 实际支持档位。
Enter 发送，Shift+Enter / Ctrl+J 换行；多行粘贴保留。至少 40×12。
无自动重试、压缩或预热；无默认本地模型超时或可省略输出额度上限。
工作使用 agent-sync 独立快照；文件原子编辑、隔离Shell、最新组合检查后接纳，原目录保持原样。\n/one 工作可独自使用工具，不委派；work 配置可声明固定检查策略。
COTHINK_HOME 默认 ~/.cothink。旧配置须显式导入；旧历史只读。
`;
export async function main(args = process.argv.slice(2)) {
  const home = resolve(process.env.COTHINK_HOME || join(homedir(), ".cothink"));
  process.env.PI_CODING_AGENT_DIR = join(home, "pi");
  let terminal, io, task;
  const controller = new AbortController();
  let signalCode;
  const cancel = (signal) => {
    signalCode = signal === "SIGTERM" ? 143 : 130;
    controller.abort();
  };
  const onInt = () => cancel("SIGINT"),
    onTerm = () => cancel("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  const pipeError = (e) => {
    if (e.code === "EPIPE") controller.abort();
    else throw e;
  };
  process.stdout.on("error", pipeError);
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        one: { type: "boolean" },
        print: { type: "boolean", short: "p" },
        json: { type: "boolean" },
        all: { type: "boolean" },
        continue: { type: "boolean", short: "c" },
        resume: { type: "boolean", short: "r" },
        thinking: { type: "string" },
        "import-legacy": { type: "boolean" },
        "max-output-tokens": { type: "string" },
        timeout: { type: "string" },
        rollback: { type: "boolean" },
      },
    });
    if (values.version) {
      process.stdout.write(
        JSON.parse(
          readFileSync(new URL("../package.json", import.meta.url), "utf8"),
        ).version + "\n",
      );
      return 0;
    }
    if (values.help) {
      process.stdout.write(help);
      return 0;
    }
    if (values.json && values.all) throw Error("--json 与 --all 互斥");
    const command = ["ask", "init", "history", "show", "migrate-work"].includes(
      positionals[0],
    )
      ? positionals.shift()
      : "ask";
    if (values.rollback && command !== "migrate-work")
      throw Error("--rollback仅用于migrate-work");
    if (command === "migrate-work") {
      if (positionals.length !== 1)
        throw Error(
          "用法：cothink migrate-work 项目路径 [--rollback] [--json]",
        );
      const { migrateLegacyProject, rollbackLegacyMigration } = await import(
        "./versioning.js"
      );
      const result = await (
        values.rollback ? rollbackLegacyMigration : migrateLegacyProject
      )({ project: resolve(positionals[0]), home });
      process.stdout.write(
        values.json
          ? JSON.stringify(result, null, 2) + "\n"
          : `迁移状态：${result.status}；正式版本：${result.version}；原目录和历史保留。\n`,
      );
      return 0;
    }
    if (command === "history") {
      const rows = [...listTasks(home), ...listRuns(home)].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
      process.stdout.write(
        values.json
          ? JSON.stringify(rows, null, 2) + "\n"
          : rows
              .map(
                (r) =>
                  `${r.id}\t${r.status}\t${r.createdAt}\t${safeText(
                    r.input ?? r.question,
                  )
                    .replace(/\n/g, " ")
                    .slice(0, 100)}`,
              )
              .join("\n") + "\n",
      );
      return 0;
    }
    if (command === "show") {
      if (positionals.length !== 1)
        throw Error("用法：cothink show ID [--all|--json]");
      const id = positionals[0];
      if (existsSync(join(home, "tasks", id + ".json"))) {
        const record = readTask(home, id);
        if (record.work)
          record.workFacts = await inspectWork(home, record, {
            includeOutputs: values.all || values.json,
          });
        process.stdout.write(
          values.json
            ? JSON.stringify(taskJson(home, record), null, 2) + "\n"
            : renderTask(home, record, values.all),
        );
      } else {
        const record = readRun(home, id);
        process.stdout.write(
          values.json
            ? JSON.stringify(record, null, 2) + "\n"
            : renderRun(record, values.all),
        );
      }
      return 0;
    }
    const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY && process.env.COTHINK_NO_TTY !== "1");
    if (values["import-legacy"]) {
      if (command !== "init") throw Error("--import-legacy 仅用于 init");
      await importLegacyConfig({ home });
      if (tty) {
        terminal = openTerminal(); io = setupIO(terminal, controller.signal);
        await migrateTeamConfig({ home, io, signal: controller.signal });
        io.close(); io = null; terminal.close(); terminal = null;
      }
      process.stderr.write("旧配置已私有备份并导入 Pi；未发送生成请求。\n");
      return 0;
    }
    let config = loadConfig(home);
    if (config && ![2, 3].includes(config.formatVersion) && command !== "init")
      throw Error(
        "检测到旧配置。请运行 cothink init --import-legacy 显式备份导入，或 cothink init 重新设置；history/show 仍可只读查看。",
      );
    if (command === "init" || !config) {
      terminal = openTerminal();
      if (!terminal) throw Error("首次配置需要交互终端，请运行 cothink init。");
      io = setupIO(terminal, controller.signal);
      config = config?.formatVersion === 2
        ? await migrateTeamConfig({ home, io, signal: controller.signal })
        : await setupModels({ home, io, signal: controller.signal });
      io.close();
      io = null;
      terminal.close();
      terminal = null;
      if (command === "init") return 0;
    }
    const maxOutputTokens =
      values["max-output-tokens"] === undefined
        ? undefined
        : positiveInteger(values["max-output-tokens"], "输出额度");
    const timeout =
      values.timeout === undefined
        ? undefined
        : positiveInteger(values.timeout, "超时");
    if (timeout > 2147483647) throw Error("超时超过 Node 定时器范围");

    if (
      (values.continue || values.resume) &&
      (!tty || positionals.length || values.json || values.all || values.print)
    )
      throw Error("-c/-r 仅用于双 TTY 持续交互");
    if (values.continue && values.resume) throw Error("-c 与 -r 互斥");
    if (
      tty &&
      !positionals.length &&
      !values.json &&
      !values.all &&
      !values.print &&
      args[0] !== "ask"
    ) {
      if (config.formatVersion === 2) {
        terminal = openTerminal(); io = setupIO(terminal, controller.signal);
        config = await migrateTeamConfig({ home, io, signal: controller.signal });
        io.close(); io = null; terminal.close(); terminal = null;
      }
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      const { runInteractive } = await import("./interactive.js");
      return await runInteractive({
        home,
        config,
        continueRecent: values.continue,
        resume: values.resume,
        thinkingLevel: values.thinking,
        maxOutputTokens,
        timeout,
      });
    }
    if (config.formatVersion === 3) config = resolveTeamConfig(config);
    else process.stderr.write("旧 v2 阵容仅用于本条；请稍后运行 cothink init 命名升级 team。\n");
    if (values.thinking !== undefined) {
      config = structuredClone(config);
      for (const ref of [config.main, ...config.secondary]) ref.thinkingLevel = values.thinking;
    }
    let input = positionals.join(" ");
    if (!positionals.length) {
      if (process.stdin.isTTY) {
        terminal = openTerminal();
        input = await questionFromTerminal(terminal, controller.signal);
      } else {
        process.stdin.setEncoding("utf8");
        const chunks = [];
        const stopReading = () => process.stdin.destroy();
        controller.signal.addEventListener("abort", stopReading, {
          once: true,
        });
        try {
          for await (const chunk of process.stdin) chunks.push(chunk);
          input = chunks.join("");
        } finally {
          controller.signal.removeEventListener("abort", stopReading);
        }
      }
    }
    const parsed = parseTurnInput(input);
    if (parsed.local) {
      process.stdout.write(parsed.message + "\n");
      return 0;
    }
    process.stderr.write(
      budgetText(config, values.one || parsed.singleModel, {
        maxOutputTokens,
        timeout,
      }) + "\n",
    );
    task = await runTurn({
      home,
      input,
      config,
      singleModel: values.one,
      signal: controller.signal,
      maxOutputTokens,
      timeout,
      onProgress: (e) => {
        if (e.type === "git")
          process.stderr.write(
            safeText(e.operation.explanation) +
              " 文件：" +
              safeText(e.operation.changedFiles.join(", ") || "无变化") +
              "\n",
          );
      },
    });
    if (values.json)
      process.stdout.write(
        JSON.stringify(
          {
            task: task.record,
            requests: task.requests(),
            taskEnd: task.record.status,
          },
          null,
          2,
        ) + "\n",
      );
    else if (values.all)
      process.stdout.write(
        safeText(
          (await import("./presentation.js")).detailsText(
            task.record,
            task.requests(),
          ),
        ) + "\n",
      );
    else if (task.record.status === "completed")
      process.stdout.write(renderTask(home, task.record));
    if (task.record.status !== "completed") {
      process.stderr.write(
        `未完成（${task.record.status}）：${safeText(task.record.error)}\n查看已保存内容：cothink show ${task.record.id} --all\n`,
      );
      if (task.recovery)
        process.stderr.write(
          "恢复副本（尚未完整交付）：\n" +
            safeText(JSON.stringify(task.recovery)) +
            "\n",
        );
    }
    return signalCode ?? (task.record.status === "completed" ? 0 : 1);
  } catch (error) {
    process.stderr.write(safeText(error.message) + "\n");
    return signalCode ?? 2;
  } finally {
    io?.close();
    terminal?.close();
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    process.stdout.off("error", pipeError);
  }
}
