import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  lstatSync,
  cpSync,
  rmSync,
} from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { runTurn } from "../../src/discussion.js";
import { save, extractHtml, hash } from "./core.mjs";
const emptyPackages = {
  packages: [],
  extensions: [],
  skills: [],
  prompts: [],
  themes: [],
  diagnostics: [],
};
const isolation = {
  noContextFiles: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  additionalExtensionPaths: [],
  additionalSkillPaths: [],
  additionalPromptPaths: [],
  additionalThemePaths: [],
};
const initial =
  '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>\n';
const aborter = new AbortController();
let task;
process.on("SIGTERM", () => aborter.abort(Error("任务已取消")));
process.on("disconnect", () =>
  aborter.abort(Error("协调进程断开；不再发送新请求")),
);
const receive = (type) =>
  new Promise((resolve) => {
    const listener = (m) => {
      if (m.type === type) {
        process.off("message", listener);
        resolve(m);
      }
    };
    process.on("message", listener);
  });
try {
  const { round, attempt, dir, relay, token } = await receive("init");
  const root = join(dir, "attempts", attempt.id),
    home = join(root, "home"),
    project = join(root, "project");
  mkdirSync(join(home, "pi"), { recursive: true, mode: 0o700 });
  mkdirSync(project, { recursive: true, mode: 0o700 });
  const providers = {};
  for (let slot = 0; slot < 2; slot++) {
    if (attempt.group !== 2 && attempt.group !== slot) continue;
    const m = round.config.models[slot];
    providers["visual-" + slot] = {
      api: "openai-completions",
      baseUrl: `${relay}/${attempt.id}/${slot}/v1`,
      apiKey: token,
      models: [
        {
          id: m.modelId,
          name: m.name ?? m.modelId,
          reasoning: m.reasoning,
          input: m.input ?? ["text"],
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat: m.compat,
          ...(m.thinkingLevelMap
            ? { thinkingLevelMap: m.thinkingLevelMap }
            : {}),
        },
      ],
    };
  }
  save(join(home, "pi/models.json"), { providers });
  save(join(home, "pi/auth.json"), {});
  writeFileSync(join(project, "index.html"), initial);
  const git = (...args) =>
    execFileSync("git", ["-C", project, ...args], {
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
  git("init", "--quiet");
  git("add", "index.html");
  git(
    "-c",
    "user.name=Visual benchmark",
    "-c",
    "user.email=benchmark@localhost",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "Blank visual task",
  );
  const question = round.questions.find((q) => q.id === attempt.question);
  if (hash(question.prompt) !== question.promptHash)
    throw Error("提示词校验失败");
  const ref = (slot) => ({
    provider: "visual-" + slot,
    modelId: round.config.models[slot].modelId,
    ...(round.config.models[slot].thinkingLevel
      ? { thinkingLevel: round.config.models[slot].thinkingLevel }
      : {}),
    ...(round.config.limits.outputTokens === null ? {} : {maxOutputTokens: round.config.limits.outputTokens}),
  });
  const skillPaths=(round.visualWorkflow?.skills??[]).map((s,i)=>{
    if(hash(s.source)!==s.hash)throw Error("冻结技能哈希不匹配");
    const path=join(home,'skills',String(i),'SKILL.md');mkdirSync(join(home,'skills',String(i)),{recursive:true});writeFileSync(path,s.source);return path;
  });
  const config = {
    formatVersion: 2,
    main: ref(attempt.group === 1 ? 1 : 0),
    secondary: attempt.group === 2 ? [ref(1)] : [],
    work: { checks: [], execution: round.config.execution },
    piResources:{skills:skillPaths},
  };
  process.send({ type: "ready" });
  await receive("go");
  const startedAt = new Date().toISOString();
  save(join(root, "status.json"), { status: "running", startedAt });
  const timer = round.config.limits.maxMinutes === null ? undefined : setTimeout(
    () => aborter.abort(Error("达到本轮预先设置的时间上限")),
    round.config.limits.maxMinutes * 60000,
  );
  let outcome;
  try {
    task = await runTurn({
      home,
      cwd: project,
      input: question.prompt,
      workRequest:round.workRequest,
      config,
      singleModel: attempt.group !== 2,
      signal: aborter.signal,
      ...(round.config.limits.outputTokens === null ? {} : {maxOutputTokens: round.config.limits.outputTokens}),
      resourceOptions: isolation,
      packageSnapshot: emptyPackages,
      onProgress: (e) => {
        if (e.type === "started") task = e.task;
      },
    });
    outcome = {
      status: task.record.status,
      error: task.record.error ?? null,
      startedAt,
      endedAt: new Date().toISOString(),
      productTaskId: task.record.id,
      delivered: !!task.record.work?.resultWorkspace,
      members: (task.record.members ?? []).map((m) => ({
        model: m.model,
        status: m.status,
      })),
      requests: task.requests().map((c) => ({
        id: c.id,
        status: c.status,
        role: c.role,
        usage: c.usage,
        actualModel: c.actualModel,
      })),
    };
    const output = join(root, "artifact");
    let selected = null;
    const workspace = task.record.work?.resultWorkspace;
    // Capture an accepted workspace as one result; never cherry-pick member drafts.
    if (workspace && existsSync(workspace)) {
      const html = [];
      const walk = (p) => {
        for (const n of readdirSync(p)) {
          if (n === ".git" || n === "node_modules") continue;
          const path = join(p, n),
            s = lstatSync(path);
          if (s.isSymbolicLink()) throw Error("产物包含符号链接");
          if (s.isDirectory()) walk(path);
          else if (
            s.isFile() &&
            /\.html?$/i.test(n) &&
            readFileSync(path, "utf8") !== initial
          )
            html.push(relative(workspace, path));
        }
      };
      walk(workspace);
      selected = html.includes("index.html")
        ? "index.html"
        : html.length === 1
          ? html[0]
          : null;
      if (selected)
        cpSync(workspace, output, {
          recursive: true,
          filter: (p) =>
            ![".git", "node_modules"].includes(p.split(/[\\/]/).at(-1)),
        });
      else if (html.length > 1)
        outcome.artifactError = "多个 HTML 入口且无 index.html；未自动挑选";
    }
    if (!round.workRequest && !selected && !outcome.artifactError) {
      const call = task
        .requests()
        .find((c) => c.id === task.record.finalCallId);
      const html = extractHtml(call?.text ?? "");
      if (html) {
        mkdirSync(output, { recursive: true });
        writeFileSync(join(output, "index.html"), html);
        selected = "index.html";
        outcome.artifactSource = "final-response";
      }
    }
    if (selected) {
      outcome.artifact = selected;
      outcome.artifactHash = hash(readFileSync(join(output, selected)));
      outcome.artifactSource ??= "delivered-workspace";
    } else
      outcome.artifactError ??= "没有可明确识别的最终 HTML；原始记录已保留";
  } catch (e) {
    outcome = {
      status: aborter.signal.aborted ? "cancelled" : "failed",
      error: e.message,
      startedAt,
      endedAt: new Date().toISOString(),
      artifactError: "未完成；原始记录已保留",
    };
  } finally {
    clearTimeout(timer);
    for (const n of ["models.json", "auth.json"])
      rmSync(join(home, "pi", n), { force: true });
  }
  save(join(root, "status.json"), outcome);
  process.send({ type: "done", outcome });
  process.disconnect();
} catch (e) {
  process.send?.({ type: "fatal", error: e.message });
  process.disconnect?.();
  process.exitCode = 1;
}
