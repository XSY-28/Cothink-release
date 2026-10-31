/** Isolated localhost demo. --package-root MUST point at the installed candidate for installed QA.
 * --empty starts with no model catalog/config; configure two custom providers using control.json.
 * Prompts: GUI_NORMAL (math/code/GFM), GUI_WORK (real read/edit/Docker/accept),
 * GUI_CANCEL_REVIEW, GUI_CANCEL_MEMBER (30 second fixture delay; Cancel stops the task).
 * Control file intentionally carries ephemeral credentials, mode 0600; ordinary stdout redacts URL fragment.
 */
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { fixture } from "./pi-fixture.js";
import { repository } from "./git-fixture.js";
import { randomUUID } from "node:crypto";
const args = process.argv.slice(2);
const option = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const packageRoot = resolve(
  option("--package-root", fileURLToPath(new URL("../..", import.meta.url))),
);
const controlFile = resolve(option("--control", "work/gui/demo-control.json"));
const load = (path) => import(pathToFileURL(join(packageRoot, path)));
const { startGuiServer } = await load("src/gui-server.js");
const { saveConfig } = await load("src/config.js");
const { createTeamConfig } = await load("src/teams.js");
const cleanups = [];
const lifecycle = { after: (fn) => cleanups.push(fn) };
const repo = repository(lifecycle);
const counts = new Map();
let f;
const trace = [];
const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
const normal =
  "# 本地演示 · GUI_NORMAL\n\n中文与 emoji 👩🏽‍💻。这是固定 fixture，不是模型质量结论。\n\n设 $x=2$，则\n\n$$\\sum_{k=1}^{3} k^2=14$$\n\n```js\nconst square = x => x * x;\nconsole.log(square(2));\n```\n\n| 路径 | 调用 |\n| --- | --- |\n| CoThink | 3 |\n| ONE | 1 |\n\n- [x] 本地固定回复\n\n## 对评审意见的处理说明\n保留推导与代码，并说明这只是机制演示。";
f = await fixture(lifecycle, async (call, n, req, res) => {
  const body = call.body,
    text = JSON.stringify(body.messages),
    member = body.model === "r1" || body.model === "review";
  const work = /GUI_WORK|GUI_CANCEL_MEMBER/.test(text);
  trace.push({
    n,
    model: body.model,
    work,
    toolNames: (body.tools ?? []).map((x) => x.function?.name),
    time: Date.now(),
  });
  writeFileSync(
    controlFile + ".stats.json",
    JSON.stringify({ calls: trace.length, trace }, null, 2),
  );
  if (
    member &&
    (/GUI_CANCEL_REVIEW/.test(text) || /GUI_CANCEL_MEMBER/.test(text))
  ) {
    await new Promise((done) => {
      const timer = setTimeout(done, 30000);
      res.once("close", () => {
        clearTimeout(timer);
        done();
      });
    });
    if (res.destroyed) return null;
  }
  if (member)
    return {
      text: work
        ? "成员已检查原始文件，保留 main 的独立修改范围。"
        : "独立评审：请保留公式、代码和 fixture 证据边界。",
    };
  if (work) {
    const isStart = (body.tools ?? []).some(
      (x) => x.function?.name === "start_work",
    );
    if (isStart) {
      counts.set("work", 0);
      return tool("start_work", {
        reason: "isolated fixture project change",
        scope: ["a.txt"],
        readScope: ["."],
      });
    }
    const k = (counts.get("work") ?? 0) + 1;
    counts.set("work", k);
    if (k === 1)
      return tool("delegate", {
        model: args.includes("--empty") ? "demo-review/review" : "fixture/r1",
        assignment: "Inspect original a.txt",
        implementationAdvice: "read only fixture inspection",
        reason: "independent inspection",
        scope: [],
        readScope: ["."],
        readOnly: true,
      });
    if (k === 2) return tool("collect");
    if (k === 3) return tool("read", { path: "a.txt" });
    if (k === 4)
      return tool("write", {
        path: "a.txt",
        content: "GUI fixture accepted output\n",
      });
    if (k === 5 || k === 6) return tool("accept_change");
    return {
      text: "# 项目成果\n\n已通过本地 Docker fixture 检查，独立成果中的 a.txt 已更新。原项目目录没有写回。",
    };
  }
  return { text: normal };
});
if (args.includes("--empty")) rmSync(join(f.home, "pi/models.json"));
else if (!args.includes("--setup"))
  saveConfig(
    f.home,
    createTeamConfig(
      { formatVersion: 2, ...f.models },
      "本地 GUI 验收",
      randomUUID(),
    ),
  );
const execution = JSON.parse(
  (await import("node:fs")).readFileSync(
    new URL(
      "../../packages/agent-sync/execution-manifest.json",
      import.meta.url,
    ),
  ),
).execution;
if (!args.includes("--empty") && !args.includes("--setup")) {
  const cfg = JSON.parse(
    (await import("node:fs")).readFileSync(join(f.home, "config.json")),
  );
  saveConfig(f.home, {
    ...cfg,
    work: {
      execution,
      checks: [
        {
          command: "node",
          args: [
            "-e",
            "if(require('fs').readFileSync('a.txt','utf8')!=='GUI fixture accepted output\\n')process.exit(1);console.log('GUI fixture Docker check passed')",
          ],
        },
      ],
    },
  });
}
const host = await startGuiServer({
  home: f.home,
  cwd: repo.project,
  open: false,
});
mkdirSync(join(controlFile, ".."), { recursive: true });
writeFileSync(
  controlFile,
  JSON.stringify(
    {
      packageRoot,
      home: f.home,
      project: repo.project,
      url: host.url,
      endpoint: f.endpoint,
      dummyKey: "localhost-only-dummy",
      models: ["main", "r1"],
      empty: args.includes("--empty"),
      execution,
      checks: [
        {
          command: "node",
          args: [
            "-e",
            "if(require('fs').readFileSync('a.txt','utf8')!=='GUI fixture accepted output\\n')process.exit(1);console.log('GUI fixture Docker check passed')",
          ],
        },
      ],
      prompts: [
        "GUI_NORMAL",
        "GUI_WORK",
        "GUI_CANCEL_REVIEW",
        "GUI_CANCEL_MEMBER",
      ],
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
chmodSync(controlFile, 0o600);
console.log(
  JSON.stringify({
    packageRoot,
    controlFile,
    origin: new URL(host.url).origin,
    paidModelCalls: 0,
  }),
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await host.close();
  for (const fn of cleanups.toReversed()) await fn();
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, close);
