/** Run in a physical Terminal for manual IME/keys/clipboard checks. Only localhost SSE, no real credentials. */
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
const cli = process.env.COTHINK_TEST_CLI ?? fileURLToPath(new URL("../../bin/cothink.js", import.meta.url));
const packageRoot = resolve(process.env.COTHINK_TEST_PACKAGE_ROOT ?? join(dirname(cli), ".."));
const { createTeamConfig } = await import(pathToFileURL(join(packageRoot, "src/teams.js")));
if (process.argv.includes("--keys")) {
  if (!process.stdin.isTTY) throw Error("请在交互终端运行 --keys");
  const labels = ["Return", "Shift+Return", "Ctrl+J"];
  let index = 0;
  process.stdout.write(
    "按键探针：只依次按下面三个键，不输入密码或其他文字。Ctrl+C 退出。\n请按 Return\n",
  );
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (chunk) => {
    if (chunk.includes(3)) {
      process.stdin.setRawMode(false);
      process.exit(130);
    }
    process.stdout.write(labels[index] + " bytes=" + chunk.toString("hex") + "\n");
    index++;
    if (index === labels.length) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.exit(0);
    }
    process.stdout.write("请按 " + labels[index] + "\n");
  });
  await new Promise(() => {});
}
const home = mkdtempSync(join(tmpdir(), "cothink-pi-manual-"));
if (process.env.COTHINK_TEST_HOME_REPORT) writeFileSync(process.env.COTHINK_TEST_HOME_REPORT, home);
let count = 0,
  mainCount = 0;
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  count++;
  const isMain = body.model === "main";
  if (isMain) mainCount++;
  const text = isMain
    ? mainCount % 2 === 1
      ? "隐藏初稿 FIXTURE_DRAFT"
      : "本地验收最终稿：中文、emoji 👩🏽‍💻、多行与空白。\n可选中本段，粘贴到另一个应用检查。\n\n## 对评审意见的处理说明\n仅为本地固定回复 FIXTURE_NOTES；不是模型质量证据。"
    : "独立评审原文 FIXTURE_REVIEW";
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [delta, finish_reason] of [
    [{ role: "assistant", content: text }, null],
    [{}, "stop"],
  ])
    res.write(
      "data: " +
        JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason }] }) +
        "\n\n",
    );
  res.end("data: [DONE]\n\n");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
mkdirSync(join(home, "pi"), { recursive: true });
writeFileSync(
  join(home, "config.json"),
  JSON.stringify(createTeamConfig({
    formatVersion: 2,
    ...(process.argv.includes("--skill-check")
      ? { piResources: { skills: [join(homedir(), ".pi/agent/skills/learning-coach")] } }
      : {}),
    main: { provider: "fixture", modelId: "main" },
    secondary: [
      { provider: "fixture", modelId: "r1" },
      { provider: "fixture", modelId: "r2" },
    ],
  }, "本地终端验收", randomUUID())),
);
writeFileSync(
  join(home, "pi", "models.json"),
  JSON.stringify({
    providers: {
      fixture: {
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: "localhost-fixture-only",
        models: ["main", "r1", "r2"].map((id) => ({
          id,
          name: id,
          reasoning: false,
          input: ["text"],
          contextWindow: 32000,
          maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        })),
      },
    },
  }),
);
const smoke = process.argv.includes("--smoke");
if (process.argv.includes("--skill-check")) {
  if (!existsSync(join(homedir(), ".pi/agent/skills/learning-coach/SKILL.md")))
    throw Error("本机 learning-coach 不存在");
  process.stderr.write(
    "资源验收：输入 /skill:learning-coach explain a concept，确认不被当作未知命令且可完成。\n",
  );
}
process.stderr.write(
  `本地固定回复，无真实模型；记录保留在 ${home}\n实按 Shift+Enter / Ctrl+J、中文 IME、缩放、Ctrl+O/Esc 与跨应用粘贴。/quit 退出。\n`,
);
const child = spawn(
  process.execPath,
  [
    cli,
    ...(smoke ? ["ask", "--json", "local fixture"] : []),
  ],
  {
    stdio: smoke ? ["ignore", "pipe", "pipe"] : "inherit",
    env: {
      ...process.env,
      COTHINK_HOME: home,
      PI_OFFLINE: "1",
      ...(smoke ? { COTHINK_NO_TTY: "1" } : {}),
    },
  },
);
let stdout = "",
  stderr = "";
if (smoke) {
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
}
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => {
  server.closeAllConnections();
  server.close();
  if (smoke) {
    try {
      const result = JSON.parse(stdout);
      if (code !== 0 || result.task.status !== "completed" || count !== 3)
        throw Error(stderr || "smoke failed");
      console.log(JSON.stringify({ calls: count, status: result.task.status, realGenerations: 0 }));
    } catch (e) {
      console.error(e.message);
      process.exitCode = 1;
    }
  } else process.exitCode = code ?? 1;
});
