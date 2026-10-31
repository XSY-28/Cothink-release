import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture } from "./helpers/pi-fixture.js";
import { repository, git } from "./helpers/git-fixture.js";
import { invoke } from "./helpers/cli-fixture.js";
import { saveConfig } from "../src/config.js";
import { runTurn } from "../src/discussion.js";
import { execution } from "./helpers/agent-sync-fixture.js";
const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
function result(body) {
  for (const m of body.messages.filter((m) => m.role === "tool").toReversed()) {
    try {
      return JSON.parse(m.content);
    } catch {}
  }
}
const samples = [];
function sample(name, task, repo, calls) {
  if (!process.env.COTHINK_TEST_EVIDENCE_DIR) return;
  const evidence = resolve(process.env.COTHINK_TEST_EVIDENCE_DIR);
  mkdirSync(join(evidence, "samples"), { recursive: true });
  const artifact = join(evidence, "samples", name);
  // Explicit exports use a fresh directory and cannot overwrite an older sample.
  mkdirSync(artifact);
  mkdirSync(join(artifact, "result"));
  writeFileSync(
    join(artifact, "task.json"),
    JSON.stringify(task.record, null, 2) + "\n",
  );
  writeFileSync(
    join(artifact, "wire.json"),
    JSON.stringify(
      calls.map((c) => ({ url: c.url, body: c.body })),
      null,
      2,
    ) + "\n",
  );
  const paths = git(
    repo.project,
    "ls-tree",
    "-r",
    "--name-only",
    task.record.work.version,
  )
    .split("\n")
    .filter(Boolean);
  for (const path of paths) {
    const target = join(artifact, "result", path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(
      target,
      readFileSync(join(task.record.work.resultWorkspace, path)),
    );
  }
  samples.push({
    name,
    status: task.record.status,
    modelProvider: "localhost_fixture",
    modelRequests: calls.length,
    paidModelRequests: 0,
    coreVersion: task.record.work.kernelVersion,
    sourceFiles: git(
      repo.project,
      "ls-tree",
      "-r",
      "--name-only",
      task.record.work.version,
    )
      .split("\n")
      .filter(Boolean).length,
    historyLength: Number(
      git(
        repo.project,
        "rev-list",
        "--first-parent",
        "--count",
        task.record.work.version,
      ),
    ),
    requests: task.record.work.requests.map((r) => ({
      action: r.action,
      status: r.status,
      attempts: r.attempts,
      durationMs: r.durationMs,
    })),
    tools: task.record.tools?.map((t) => ({
      name: t.name,
      status: t.status,
      durationMs: t.durationMs,
      outputRef: t.outputRef,
    })),
    execution: task.record.work.execution,
    actualMoneyCost: null,
  });
  writeFileSync(
    join(evidence, "costs.json"),
    JSON.stringify(
      {
        notes: [
          "Localhost mechanism samples, not real model quality or price evidence.",
          "RPC/tool durations are inclusive; do not add to infer wall time.",
          "Cold/reuse containers reported separately; no comparison winner threshold.",
        ],
        samples,
      },
      null,
      2,
    ) + "\n",
  );
}
test("A04/A05/A09 Markdown+JSON checked CLI work reads failed-check log and repairs only one file on same draft", async (t) => {
  const repo = repository(t);
  const checks = [
    {
      command: "node",
      args: [
        "-e",
        "const f=require('fs');if(JSON.parse(f.readFileSync('settings.json')).value!==2){console.log('value must be 2');process.exit(1)}if(f.readFileSync('guide.md','utf8')!=='# Guide\\n')process.exit(2)",
      ],
    },
  ];
  const f = await fixture(t, (c, n) =>
    n === 1
      ? tool("start_work", {
          reason: "Markdown JSON",
          scope: ["guide.md", "settings.json"],
        })
      : n === 2
        ? tool("write", { path: "guide.md", content: "# Guide\n" })
        : n === 3
          ? tool("write", { path: "settings.json", content: '{"value":1}' })
          : n === 4
            ? tool("accept_change")
            : n === 5
              ? tool("read", {
                  path: "output:" + result(c.body).checks[0].outputRef,
                })
              : n === 6
                ? tool("edit", {
                    path: "settings.json",
                    edits: [{ oldText: "1", newText: "2" }],
                  })
                : n === 7
                  ? tool("accept_change")
                  : { text: "Correct Markdown and JSON delivered" },
  );
  saveConfig(f.home, {
    formatVersion: 2,
    ...f.models,
    work: { checks, execution },
  });
  const r = await invoke(f, ["ask", "--json", "/one docs"], "", repo.project);
  assert.equal(r.code, 0, r.stderr);
  const saved = JSON.parse(r.stdout);
  assert.equal(saved.taskEnd, "completed");
  const workSystem = f.calls[1].body.messages.find(m => m.role === "system").content;
  assert.match(workSystem, /ONE single-model work mode/);
  assert.match(workSystem, /agent-sync owns formal versions/);
  assert.doesNotMatch(workSystem, /scheduling preferences|For delegate|TASK_CONFLICT|collect returns/);
  assert.ok(!f.calls[1].body.tools.some(t => t.function.name === "delegate"));

  assert.equal(saved.task.work.finalCheck.verification, "passed");
  assert.deepEqual(
    saved.task.work.acceptance.map((r) => r.status),
    ["check_failed", "accepted"],
  );
  assert.equal(
    saved.task.work.changes.filter((c) => c.actor === "main" && !c.readOnly)
      .length,
    1,
  );
  assert.equal(
    git(repo.project, "show", saved.task.work.version + ":settings.json"),
    '{"value":2}',
  );
  assert.equal(
    git(repo.project, "show", saved.task.work.version + ":guide.md"),
    "# Guide",
  );
  const count = f.calls.length;
  const show = await invoke(f, ["show", saved.task.id, "--all"]);
  assert.match(show.stdout, /完整执行日志/);
  assert.match(show.stdout, /value must be 2/);
  assert.equal(f.calls.length, count);
  sample("markdown-json-repair", { record: saved.task }, repo, f.calls);
});
test("A04/A06/A09 binary artifact uses isolated Shell and real diff review before acceptance", async (t) => {
  const repo = repository(t),
    checks = [
      {
        command: "node",
        args: [
          "-e",
          "if(!require('fs').readFileSync('asset.bin').equals(Buffer.from([0,255,1])))process.exit(1)",
        ],
      },
    ];
  const f = await fixture(t, (c, n) =>
    n === 1
      ? tool("start_work", { reason: "binary output", scope: ["asset.bin"] })
      : n === 2
        ? tool("bash", {
            command:
              "node -e \"require('fs').writeFileSync('asset.bin',Buffer.from([0,255,1]))\"",
          })
        : n === 3
          ? tool("accept_change")
          : n === 4
            ? (assert.equal(result(c.body).status, "review_required"),
              tool("accept_change"))
            : { text: "Binary delivered" },
  );
  const task = await runTurn({
    home: f.home,
    cwd: repo.project,
    input: "/one binary",
    config: { formatVersion: 2, ...f.models, work: { checks, execution } },
  });
  assert.equal(task.record.status, "completed", task.record.error);
  assert.deepEqual(
    readFileSync(join(task.record.work.resultWorkspace, "asset.bin")),
    Buffer.from([0, 255, 1]),
  );
  assert.equal(task.record.work.execution.workContainers, 1);
  assert.equal(task.record.work.finalCheck.verification, "passed");
  sample("binary", task, repo, f.calls);
});
test("A04/A09 controlled background service and consecutive commands share one work container; final source can be read directly", async (t) => {
  const repo = repository(t),
    checks = [
      {
        command: "node",
        args: [
          "-e",
          "if(require('fs').readFileSync('result.txt','utf8')!=='ready')process.exit(1)",
        ],
      },
    ];
  const start =
    "node -e \"require('http').createServer((q,s)=>s.end('ready')).listen(8123,'127.0.0.1',()=>require('fs').writeFileSync('/tmp/ready','yes'))\" >/tmp/server.log 2>&1 & while [ ! -f /tmp/ready ]; do sleep 0.01; done";
  const f = await fixture(t, (_, n) =>
    n === 1
      ? tool("start_work", {
          reason: "background then fetch",
          scope: ["result.txt"],
          readScope: ["result.txt"],
        })
      : n === 2
        ? tool("bash", { command: start })
        : n === 3
          ? tool("bash", {
              command:
                "node -e \"fetch('http://127.0.0.1:8123').then(r=>r.text()).then(s=>require('fs').writeFileSync('result.txt',s))\"",
            })
          : n === 4 || n === 5
            ? tool("accept_change")
            : { text: "Background output delivered" },
  );
  const task = await runTurn({
    home: f.home,
    cwd: repo.project,
    input: "/one background",
    config: { formatVersion: 2, ...f.models, work: { checks, execution } },
  });
  assert.equal(task.record.status, "completed", task.record.error);
  assert.equal(
    readFileSync(join(task.record.work.resultWorkspace, "result.txt"), "utf8"),
    "ready",
  );
  assert.equal(task.record.work.execution.workContainers, 1);
  assert.equal(task.record.work.execution.checkContainers, 2);
  sample("background-reuse", task, repo, f.calls);
});
test("A04 candidate .pi extension is never auto-discovered by answer or work runtime", async (t) => {
  const repo = repository(t),
    canary = join(repo.root, "never-created");
  mkdirSync(join(repo.project, ".pi/extensions"), { recursive: true });
  writeFileSync(
    join(repo.project, ".pi/extensions/evil.mjs"),
    `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(canary)},'unsafe');export default function(){}`,
  );
  git(repo.project, "add", "--", ".pi/extensions/evil.mjs");
  git(repo.project, "commit", "-m", "untrusted candidate resource");
  const f = await fixture(t, (_, n) =>
    n === 1
      ? tool("start_work", { reason: "observe only" })
      : { text: "Observed without executing project extensions" },
  );
  const task = await runTurn({
    home: f.home,
    cwd: repo.project,
    input: "/one observe",
    config: { formatVersion: 2, ...f.models, work: { checks: [] } },
  });
  assert.equal(task.record.status, "completed", task.record.error);
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(canary), false);
  assert.equal(f.calls.length, 2);
});
