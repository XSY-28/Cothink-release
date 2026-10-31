import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import { fixture } from "./helpers/pi-fixture.js";
import { invoke } from "./helpers/cli-fixture.js";
const productRoot=resolve(process.env.COTHINK_TEST_PACKAGE_ROOT??fileURLToPath(new URL("..",import.meta.url)));
const load=path=>import(pathToFileURL(join(productRoot,path)));
const {createTeamConfig}=await load("src/teams.js");

// Removing the early management dispatcher must fail these checks before setup/model use.
test("P0 package commands dispatch without configuration, migration or model calls; preserve team/auth/session bytes", async (t) => {
  for (const kind of ["none", "v2", "v3", "unavailable", "legacy-session"]) {
    const f = await fixture(t);
    let config = { formatVersion: 2, ...f.models };
    if (kind === "v3" || kind === "unavailable")
      config = createTeamConfig(
        config,
        "A",
        "682c9457-227f-4201-b177-26b006e72896",
      );
    if (kind === "unavailable") config.teams[0].main.modelId = "absent";
    if (kind !== "none")
      writeFileSync(join(f.home, "config.json"), JSON.stringify(config));
    writeFileSync(join(f.home, "pi", "auth.json"), "{}\n");
    mkdirSync(join(f.home, "pi", "sessions", "main"), { recursive: true });
    const session = join(f.home, "pi", "sessions", "main", "legacy.jsonl");
    writeFileSync(session, '{"type":"session","version":3}\n');
    const protectedPaths = [
      "config.json",
      "pi/auth.json",
      "pi/models.json",
      "pi/sessions/main/legacy.jsonl",
    ];
    const before = protectedPaths.map((p) =>
      existsSync(join(f.home, p))
        ? readFileSync(join(f.home, p), "utf8")
        : null,
    );
    for (const args of [
      ["list", "--json"],
      ["remove", "npm:absent", "--json"],
      ["install", "./unsupported", "--json"],
    ]) {
      const r = await invoke(f, args);
      assert.equal(
        r.code,
        args[0] === "install" ? 2 : 0,
        `${kind}: ${r.stderr}`,
      );
      const result = JSON.parse(r.stdout);
      assert.equal(result.command, args[0]);
      assert.ok(Array.isArray(result.packages));
      assert.doesNotMatch(r.stderr, /预算|首次配置|命名 team|旧 v2/);
    }
    assert.deepEqual(
      protectedPaths.map((p) =>
        existsSync(join(f.home, p))
          ? readFileSync(join(f.home, p), "utf8")
          : null,
      ),
      before,
    );
    assert.equal(f.calls.length, 0);
  }
});
test("P0 invalid and forbidden management inputs stay local, with JSON errors and usage exit 2", async (t) => {
  const f = await fixture(t);
  const { packageRegistry } = await import("./helpers/package-registry.mjs");
  const registry = await packageRegistry(t);
  for (const args of [
    ["install"],
    ["install", "npm:x", "npm:y"],
    ["install", "https://example.test/x.zip"],
    ["install", "npm:../x"],
    ["install", "npm:x@https://example.test/a"],
    ["list", "npm:x"],
    ["list", "--one"],
    ["remove"],
    ["remove", "npm:x", "--unknown"],
    ["update"],
    ["uninstall", "npm:x"],
    ["config"],
  ]) {
    const r = await invoke(f, [...args, "--json"]);
    assert.equal(r.code, 2, JSON.stringify(args) + r.stderr);
    assert.ok(JSON.parse(r.stdout).error.code);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(registry.registryRequests.length, 0);
});
test("P0 explicit ask list these items remains an ordinary answer", async (t) => {
  const f = await fixture(t);
  writeFileSync(
    join(f.home, "config.json"),
    JSON.stringify({ formatVersion: 2, ...f.models }),
  );
  const r = await invoke(f, ["ask", "--one", "list these items"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(f.calls.length, 1);
});

// A missing/foreign install must never be repaired or imported by listing.
test("P1 list validates managed ownership/version and settings without importing local extensions or contacting models", async (t) => {
  const { listPackages, resolvePackageResources } =
    await load("src/packages.js");
  const f = await fixture(t);
  const pkg = join(
    f.home,
    "pi",
    "npm",
    "node_modules",
    "@cothink-fixtures",
    "mixed",
  );
  mkdirSync(join(pkg, "skills", "package-skill"), { recursive: true });
  mkdirSync(join(pkg, "extensions"), { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "@cothink-fixtures/mixed",
      version: "1.0.0",
      pi: { skills: ["skills"], extensions: ["extensions/side-effect.js"] },
    }),
  );
  writeFileSync(
    join(pkg, "skills", "package-skill", "SKILL.md"),
    "---\nname: package-skill\ndescription: Package fixture skill\n---\nPACKAGE_SKILL_BODY\n",
  );
  const marker = join(f.home, "imported");
  writeFileSync(
    join(pkg, "extensions", "side-effect.js"),
    `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'bad');`,
  );
  mkdirSync(join(f.cwd, ".pi", "extensions"), { recursive: true });
  writeFileSync(
    join(f.cwd, ".pi", "extensions", "evil.js"),
    readFileSync(join(pkg, "extensions", "side-effect.js")),
  );
  const settings = join(f.home, "pi", "settings.json");
  writeFileSync(
    settings,
    JSON.stringify({
      otherField: { keep: true },
      packages: [
        { source: "npm:@cothink-fixtures/mixed@1.0.0", extensions: [] },
      ],
    }),
  );
  let rows = await listPackages({ home: f.home, cwd: f.cwd });
  assert.equal(rows[0].status, "partial");
  assert.ok(rows[0].resources.some((r) => r.kind === "skills" && r.enabled));
  assert.ok(
    rows[0].resources.some(
      (r) => r.kind === "extensions" && !r.enabled && /禁用/.test(r.reason),
    ),
  );
  const snap = await resolvePackageResources({ home: f.home, cwd: f.cwd });
  assert.equal(snap.skills.length, 1);
  assert.equal(snap.extensions.length, 0);
  assert.equal(existsSync(marker), false);
  assert.equal(f.calls.length, 0);
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@cothink-fixtures/mixed", version: "2.0.0" }),
  );
  rows = await listPackages({ home: f.home, cwd: f.cwd });
  assert.equal(rows[0].status, "broken");
  await assert.rejects(
    resolvePackageResources({ home: f.home, cwd: f.cwd }),
    /安装内容不符/,
  );
  writeFileSync(settings, JSON.stringify({ packages: ["npm:absent@1.0.0"] }));
  rows = await listPackages({ home: f.home, cwd: f.cwd });
  assert.equal(rows[0].status, "missing");
  writeFileSync(settings, "{corrupt");
  await assert.rejects(listPackages({ home: f.home, cwd: f.cwd }), /登记/);
});

test("P2 real Pi/npm installs pin actual version, run lifecycle scripts without importing extensions, preserve unrelated packages, and remove idempotently", async (t) => {
  const { runPackageCommand } = await load("src/packages.js");
  const { packageRegistry } = await import("./helpers/package-registry.mjs");
  const f = await fixture(t),
    reg = await packageRegistry(t, { markerRoot: f.home });
  const run = (command, source) =>
    runPackageCommand({ home: f.home, cwd: f.cwd, command, source });
  let r = await run("install", "npm:@cothink-fixtures/mixed@1.0.0");
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  assert.equal(r.result.packages[0].status, "enabled");
  assert.equal(existsSync(join(f.home, "import-marker")), false);
  const settings = JSON.parse(readFileSync(join(f.home, "pi/settings.json")));
  assert.equal(
    settings.packages[0].source,
    "npm:@cothink-fixtures/mixed@1.0.0",
  );
  assert.equal(settings.packages[0].extensions, undefined);
  const count = reg.registryRequests.length;
  r = await run("install", "npm:@cothink-fixtures/mixed@1.0.0");
  assert.equal(r.exitCode, 0);
  assert.equal(reg.registryRequests.length, count);
  r = await run("list");
  assert.equal(r.exitCode, 0);
  assert.equal(reg.registryRequests.length, count);
  // Positive controls prove that both lifecycle fixtures can actually write.
  const { execFileSync } = await import("node:child_process");
  const { unlinkSync } = await import("node:fs");
  for (const [name, marker] of [
    ["hook", "root-script-marker"],
    ["hook-dep", "dependency-script-marker"],
  ]) {
    const item = reg.packages.get("@cothink-fixtures/" + name).get("1.0.0");
    execFileSync("sh", ["-c", item.manifest.scripts.postinstall], {
      cwd: item.directory,
    });
    assert.equal(readFileSync(join(f.home, marker), "utf8"), "bad");
    unlinkSync(join(f.home, marker));
  }
  r = await run("install", "npm:@cothink-fixtures/hook");
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  assert.equal(existsSync(join(f.home, "root-script-marker")), true);
  assert.equal(existsSync(join(f.home, "dependency-script-marker")), true);
  assert.ok(existsSync(join(f.home, "pi/npm/package-lock.json")));
  r = await run("remove", "npm:@cothink-fixtures/mixed");
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  assert.equal(r.result.packages.length, 1);
  assert.equal(r.result.packages[0].name, "@cothink-fixtures/hook");
  assert.equal(
    existsSync(join(f.home, "pi/npm/node_modules/@cothink-fixtures/mixed")),
    false,
  );
  const after = reg.registryRequests.length;
  r = await run("remove", "npm:@cothink-fixtures/mixed");
  assert.equal(r.exitCode, 0);
  assert.equal(reg.registryRequests.length, after);
  assert.equal(f.calls.length, 0);
});

test("P2 failed/conflicting/escaping/non-Pi candidates retain previous installation and never overwrite team/auth", async (t) => {
  const { runPackageCommand } = await load("src/packages.js");
  const { packageRegistry } = await import("./helpers/package-registry.mjs");
  const f = await fixture(t),
    reg = await packageRegistry(t);
  writeFileSync(
    join(f.home, "config.json"),
    JSON.stringify({ formatVersion: 2, ...f.models, keep: "untouched" }),
  );
  const before = readFileSync(join(f.home, "config.json"), "utf8");
  const run = (command, source) =>
    runPackageCommand({ home: f.home, cwd: f.cwd, command, source });
  assert.equal(
    (await run("install", "npm:@cothink-fixtures/static@1.0.0")).exitCode,
    0,
  );
  const settingsPath = join(f.home, "pi/settings.json"),
    stable = readFileSync(settingsPath, "utf8");
  for (const [source, code] of [
    ["npm:@cothink-fixtures/conflict@1.0.0", "PACKAGE_RESOURCE_CONFLICT"],
    ["npm:@cothink-fixtures/conflict@2.0.0", "PACKAGE_RESOURCE_CONFLICT"],
    ["npm:@cothink-fixtures/conflict@3.0.0", "PACKAGE_RESOURCE_CONFLICT"],
    ["npm:@cothink-fixtures/conflict@4.0.0", "PACKAGE_RESOURCE_CONFLICT"],
    ["npm:@cothink-fixtures/escape@1.0.0", "PACKAGE_RESOURCE_ESCAPE"],
    ["npm:@cothink-fixtures/not-pi@1.0.0", "NO_PI_RESOURCES"],
  ]) {
    const r = await run("install", source);
    assert.equal(r.exitCode, 1, JSON.stringify(r));
    assert.equal(r.result.error.code, code, JSON.stringify(r));
    assert.equal(readFileSync(settingsPath, "utf8"), stable);
  }
  reg.fail("@cothink-fixtures/js-only");
  const failed = await run("install", "npm:@cothink-fixtures/js-only@1.0.0");
  assert.equal(failed.exitCode, 1);
  assert.equal(readFileSync(settingsPath, "utf8"), stable);
  assert.equal(readFileSync(join(f.home, "config.json"), "utf8"), before);
  assert.equal(f.calls.length, 0);
});

test("P2 locks cover every idle team session; list works; config-write is separate; explicit install updates exact pin", async (t) => {
  const { runPackageCommand } = await load("src/packages.js");
  const { acquireSessionWriter, acquirePackageLock, assertPackageReadable } =
    await load("src/storage.js");
  const { packageRegistry } = await import("./helpers/package-registry.mjs");
  const f = await fixture(t);
  await packageRegistry(t);
  const run = (command, source) =>
    runPackageCommand({ home: f.home, cwd: f.cwd, command, source });
  for (const id of [
    "682c9457-227f-4201-b177-26b006e72896",
    "7d51ceaf-2b56-4c1d-a34f-dd51da8b36c5",
  ]) {
    const writer = acquireSessionWriter(join(f.home, "pi"), id);
    try {
      const r = await run("install", "npm:@cothink-fixtures/static@1.0.0");
      assert.equal(r.result.error.code, "PACKAGE_SESSION_BUSY");
      assert.equal((await run("list")).exitCode, 0);
    } finally {
      writer.release();
    }
  }
  const op = acquirePackageLock(f.home);
  try {
    assert.equal((await run("list")).result.error.code, "PACKAGE_BUSY");
    assert.throws(() => assertPackageReadable(f.home), /包操作/);
  } finally {
    op.release();
  }
  assert.equal(
    (await run("install", "npm:@cothink-fixtures/static@1.0.0")).exitCode,
    0,
  );
  const changed = await run("install", "npm:@cothink-fixtures/static");
  assert.equal(changed.exitCode, 0, JSON.stringify(changed));
  assert.equal(changed.result.packages[0].version, "2.0.0");
});

test("P2 publication rejects external settings/resource edits but allows team-only writes; cancellation leaves candidate unpublished", async (t) => {
  const { runPackageCommand } = await load("src/packages.js");
  const { packageRegistry } = await import("./helpers/package-registry.mjs");
  const f = await fixture(t),
    reg = await packageRegistry(t);
  const run = (source, onProgress, signal) =>
    runPackageCommand({
      home: f.home,
      cwd: f.cwd,
      command: "install",
      source,
      onProgress,
      signal,
    });
  let r = await run("npm:@cothink-fixtures/static@1.0.0", () =>
    writeFileSync(
      join(f.home, "pi/settings.json"),
      JSON.stringify({ packages: [], external: true }),
    ),
  );
  assert.equal(r.result.error.code, "PACKAGE_CONFLICT");
  assert.equal(
    JSON.parse(readFileSync(join(f.home, "pi/settings.json"))).external,
    true,
  );
  r = await run("npm:@cothink-fixtures/static@1.0.0", () =>
    writeFileSync(
      join(f.home, "config.json"),
      JSON.stringify({
        formatVersion: 3,
        teams: [],
        lastUsedTeamId: "different",
      }),
    ),
  );
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  r = await run("npm:@cothink-fixtures/static@2.0.0", () =>
    writeFileSync(
      join(f.home, "config.json"),
      JSON.stringify({ piResources: { prompts: ["changed.md"] } }),
    ),
  );
  assert.equal(r.result.error.code, "PACKAGE_RESOURCE_CONFLICT");
  writeFileSync(join(f.home, "config.json"), "{}");
  reg.delay("@cothink-fixtures/js-only");
  const controller = new AbortController();
  const pending = run(
    "npm:@cothink-fixtures/js-only@1.0.0",
    () => {},
    controller.signal,
  );
  const deadline = Date.now() + 10000;
  while (
    !reg.registryRequests.some((r) =>
      decodeURIComponent(r.url).includes("js-only"),
    ) &&
    Date.now() < deadline
  )
    await new Promise((r) => setTimeout(r, 10));
  const competing = await invoke(f, [
    "remove",
    "npm:@cothink-fixtures/static",
    "--json",
  ]);
  assert.equal(competing.code, 1);
  assert.equal(JSON.parse(competing.stdout).error.code, "PACKAGE_BUSY");
  controller.abort();
  r = await pending;
  const diagnostic =
    r.result.recoveryPath && join(r.result.recoveryPath, "cancellation.json");
  assert.equal(
    r.exitCode,
    130,
    JSON.stringify({
      r,
      diagnostic:
        diagnostic && existsSync(diagnostic)
          ? JSON.parse(readFileSync(diagnostic))
          : null,
    }),
  );
  assert.equal(
    JSON.parse(readFileSync(join(f.home, "pi/settings.json"))).packages.length,
    1,
  );
  assert.ok(existsSync(r.result.recoveryPath));
  assert.equal(f.calls.length, 0);
});

test("P3 package skill/prompt flows through real one/three-call host, frozen review and team snapshots; missing packages block generation only", async (t) => {
  const { runPackageCommand } = await load("src/packages.js");
  const { packageRegistry } = await import("./helpers/package-registry.mjs");
  const { runTurn } = await load("src/discussion.js");
  const f = await fixture(t);
  await packageRegistry(t);
  assert.equal(
    (
      await runPackageCommand({
        home: f.home,
        cwd: f.cwd,
        command: "install",
        source: "npm:@cothink-fixtures/static@1.0.0",
      })
    ).exitCode,
    0,
  );
  const config = { formatVersion: 2, ...f.models };
  writeFileSync(join(f.home, "config.json"), JSON.stringify(config));
  let task = await runTurn({
    home: f.home,
    cwd: f.cwd,
    input: "question",
    config,
  });
  assert.equal(task.record.status, "completed", task.record.error);
  assert.equal(task.record.answerSkills[0].name, "package-skill");
  for (const c of f.calls)
    assert.match(JSON.stringify(c.body), /PACKAGE_SKILL_BODY/);
  assert.deepEqual(
    f.calls.map((c) => c.body.model),
    ["main", "r1", "main"],
  );
  task = await runTurn({
    home: f.home,
    cwd: f.cwd,
    input: "/one /skill:package-skill explicit",
    config,
  });
  assert.equal(task.record.status, "completed", task.record.error);
  assert.equal(task.record.answerSkills.length, 0);
  assert.equal(f.calls.length, 4);
  task = await runTurn({
    home: f.home,
    cwd: f.cwd,
    input: "/one /package-prompt supplied",
    config,
  });
  assert.equal(task.record.status, "completed", task.record.error);
  assert.match(JSON.stringify(f.calls.at(-1).body), /PACKAGE_PROMPT supplied/);
  const id = task.record.id,
    settings = join(f.home, "pi/settings.json");
  writeFileSync(
    settings,
    JSON.stringify({ packages: ["npm:@cothink-fixtures/static@9.0.0"] }),
  );
  const before = f.calls.length;
  await assert.rejects(
    runTurn({ home: f.home, cwd: f.cwd, input: "blocked", config }),
    /安装内容不符/,
  );
  assert.equal(f.calls.length, before);
  const history = await invoke(f, ["show", id, "--json"]);
  assert.equal(history.code, 0);
  assert.match(history.stdout, /package-skill/);
  writeFileSync(
    settings,
    JSON.stringify({
      packages: [
        { source: "npm:@cothink-fixtures/static@1.0.0", extensions: [] },
      ],
    }),
  );
  assert.equal(
    (
      await runPackageCommand({
        home: f.home,
        cwd: f.cwd,
        command: "remove",
        source: "npm:@cothink-fixtures/static",
      })
    ).exitCode,
    0,
  );
  assert.equal((await invoke(f, ["show", id, "--json"])).code, 0);
  assert.equal(f.calls.length, before);
});

test("P2 real process death between directory renames blocks reads until explicit, verified rollback; write failure rolls back", async (t) => {
  const { runPackageCommand } = await load("src/packages.js");
  const { packageRegistry } = await import("./helpers/package-registry.mjs");
  const { spawn } = await import("node:child_process");
  const f = await fixture(t);
  await packageRegistry(t);
  const run = (command, source) =>
    runPackageCommand({ home: f.home, cwd: f.cwd, command, source });
  assert.equal(
    (await run("install", "npm:@cothink-fixtures/static@1.0.0")).exitCode,
    0,
  );
  const stable = readFileSync(join(f.home, "pi/settings.json"), "utf8");
  const preload = join(f.home, "interrupt.mjs");
  writeFileSync(
    preload,
    `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';const original=fs.renameSync;let once=true;fs.renameSync=(a,b)=>{if(once&&String(b).endsWith('/previous-npm')){once=false;original(a,b);process.kill(process.pid,'SIGKILL');}return original(a,b);};syncBuiltinESMExports();`,
  );
  const cli =
    process.env.COTHINK_TEST_CLI ??
    new URL("../bin/cothink.js", import.meta.url).pathname;
  const child = spawn(
    process.execPath,
    [
      "--import",
      preload,
      cli,
      "install",
      "npm:@cothink-fixtures/static@2.0.0",
      "--json",
    ],
    {
      cwd: f.cwd,
      env: { ...process.env, COTHINK_HOME: f.home },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await new Promise((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  assert.equal(child.signalCode, "SIGKILL");
  assert.ok(existsSync(join(f.home, "pi/package-operation.json")));
  let r = await run("list");
  assert.equal(r.exitCode, 1);
  assert.equal(r.result.error.code, "PACKAGE_RECOVERY_REQUIRED");
  r = await run("remove", "npm:absent");
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  assert.equal(readFileSync(join(f.home, "pi/settings.json"), "utf8"), stable);
  assert.equal(r.result.packages[0].version, "1.0.0");
  assert.equal(existsSync(join(f.home, "pi/package-operation.json")), false);
  writeFileSync(
    preload,
    `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';const original=fs.renameSync;let once=true;fs.renameSync=(a,b)=>{if(once&&String(b)===${JSON.stringify(join(f.home, "pi/settings.json"))}){once=false;throw Object.assign(Error('fixture disk write failure'),{code:'EIO'});}return original(a,b);};syncBuiltinESMExports();`,
  );
  const failing = spawn(
    process.execPath,
    [
      "--import",
      preload,
      cli,
      "install",
      "npm:@cothink-fixtures/static@2.0.0",
      "--json",
    ],
    {
      cwd: f.cwd,
      env: { ...process.env, COTHINK_HOME: f.home },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  failing.stdout.on("data", (c) => (output += c));
  const code = await new Promise((resolve, reject) => {
    failing.once("close", resolve);
    failing.once("error", reject);
  });
  assert.equal(code, 1);
  assert.equal(JSON.parse(output).error.code, "PACKAGE_COMMIT_FAILED");
  assert.equal(readFileSync(join(f.home, "pi/settings.json"), "utf8"), stable);
  assert.equal((await run("list")).result.packages[0].version, "1.0.0");
  assert.equal(f.calls.length, 0);
});

test("P2 package-external symlinks and corrupt recovery evidence fail closed without importing or overwriting", async (t) => {
  const { runPackageCommand, resolvePackageResources } =
    await load("src/packages.js");
  const { symlinkSync } = await import("node:fs");
  const f = await fixture(t);
  const pkg = join(f.home, "pi/npm/node_modules/escape");
  mkdirSync(join(pkg, "skills"), { recursive: true });
  const outside = join(f.home, "outside");
  mkdirSync(outside);
  writeFileSync(
    join(outside, "SKILL.md"),
    "---\nname: escaped\ndescription: outside\n---\nSECRET_OUTSIDE",
  );
  symlinkSync(outside, join(pkg, "skills", "escape"));
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "escape",
      version: "1.0.0",
      pi: { skills: ["skills"] },
    }),
  );
  writeFileSync(
    join(f.home, "pi/settings.json"),
    JSON.stringify({ packages: ["npm:escape@1.0.0"] }),
  );
  let r = await runPackageCommand({
    home: f.home,
    cwd: f.cwd,
    command: "list",
  });
  assert.equal(r.result.packages[0].status, "broken");
  await assert.rejects(
    resolvePackageResources({ home: f.home, cwd: f.cwd }),
    /符号链接/,
  );
  writeFileSync(
    join(f.home, "pi/package-operation.json"),
    JSON.stringify({ version: 1, candidate: "../../not-owned" }),
  );
  const before = readFileSync(join(f.home, "pi/settings.json"), "utf8");
  r = await runPackageCommand({
    home: f.home,
    cwd: f.cwd,
    command: "remove",
    source: "npm:escape",
  });
  assert.equal(r.result.error.code, "PACKAGE_RECOVERY_REQUIRED");
  assert.equal(readFileSync(join(f.home, "pi/settings.json"), "utf8"), before);
  assert.equal(f.calls.length, 0);
});

test("P3 runtime claims before any package read, blocks mutations while idle, and retains a usable local shell on package fault", async (t) => {
  const { createRuntime } = await load("src/pi-runtime.js");
  const { runPackageCommand } = await load("src/packages.js");
  const { packageRegistry } = await import("./helpers/package-registry.mjs");
  const { assertNoActivePiSessions, acquirePackageLock, acquireSessionWriter } =
    await load("src/storage.js");
  const { default: fs } = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const f = await fixture(t);
  await packageRegistry(t);
  assert.equal(
    (
      await runPackageCommand({
        home: f.home,
        cwd: f.cwd,
        command: "install",
        source: "npm:@cothink-fixtures/mixed@1.0.0",
      })
    ).exitCode,
    0,
  );
  const original = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (path, ...args) {
    if (String(path).includes("/node_modules/@cothink-fixtures/mixed/")) {
      reads++;
      assert.throws(() => assertNoActivePiSessions(f.home), /活跃/);
    }
    return original.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  let rt;
  try {
    rt = await createRuntime({
      home: f.home,
      cwd: f.cwd,
      modelRef: f.models.main,
    });
  } finally {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  }
  try {
    assert.ok(reads > 0);
    assert.equal(rt.packageSnapshot.skills.length, 1);
    const theme = rt.services.resourceLoader
      .getThemes()
      .themes.find((t) => t.name === "fixture-theme");
    assert.ok(theme);
    assert.match(
      theme.fg("text", "package theme render"),
      /package theme render/,
    );
    assert.equal(
      (
        await runPackageCommand({
          home: f.home,
          cwd: f.cwd,
          command: "remove",
          source: "npm:@cothink-fixtures/mixed",
        })
      ).result.error.code,
      "PACKAGE_SESSION_BUSY",
    );
    assert.equal(
      (await runPackageCommand({ home: f.home, cwd: f.cwd, command: "list" }))
        .exitCode,
      0,
    );
  } finally {
    await rt.dispose();
  }
  const configLock = acquireSessionWriter(
    join(f.home, "config-write"),
    "184df297-b389-43af-8635-e71dfac90f52",
  );
  try {
    assert.equal(
      (
        await runPackageCommand({
          home: f.home,
          cwd: f.cwd,
          command: "install",
          source: "npm:@cothink-fixtures/mixed@1.0.0",
        })
      ).exitCode,
      0,
    );
  } finally {
    configLock.release();
  }
  const lock = acquirePackageLock(f.home);
  try {
    await assert.rejects(
      createRuntime({ home: f.home, cwd: f.cwd, modelRef: f.models.main }),
      /包操作/,
    );
  } finally {
    lock.release();
  }
  writeFileSync(
    join(f.home, "pi/settings.json"),
    JSON.stringify({ packages: ["npm:missing@1.0.0"] }),
  );
  rt = await createRuntime({
    home: f.home,
    cwd: f.cwd,
    modelRef: f.models.main,
    allowPackageErrors: true,
  });
  try {
    assert.ok(rt.packageError);
    assert.equal(rt.services.resourceLoader.getSkills().skills.length, 0);
    await assert.rejects(rt.checkPackages(), /缺失/);
  } finally {
    await rt.dispose();
  }
  assert.equal(f.calls.length, 0);
});

test("P4 actual CLI install/list/PTY-use/remove; original Team lifecycle matrix also consumes globally shared package resources", async (t) => {
  const { packageRegistry } = await import("./helpers/package-registry.mjs");
  const { spawn } = await import("node:child_process");
  const f = await fixture(t);
  const reg = await packageRegistry(t, { markerRoot: f.home });
  const config = createTeamConfig(
    { formatVersion: 2, ...f.models },
    "A",
    "682c9457-227f-4201-b177-26b006e72896",
  );
  writeFileSync(join(f.home, "config.json"), JSON.stringify(config));
  const before = readFileSync(join(f.home, "config.json"), "utf8");
  let r = await invoke(f, [
    "install",
    "npm:@cothink-fixtures/mixed@1.0.0",
    "--json",
  ]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).packages[0].status, "enabled");
  assert.equal(readFileSync(join(f.home, "config.json"), "utf8"), before);
  const python = async (path, extra = {}) => {
    const child = spawn("python3", [new URL(path, import.meta.url).pathname], {
      env: { ...process.env, COTHINK_PACKAGE_HOME: f.home, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (x) => (output += x));
    child.stderr.on("data", (x) => (output += x));
    const code = await new Promise((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    assert.equal(code, 0, output);
    return output;
  };
  await python("./pi_package_checks.py");
  assert.deepEqual(
    f.calls.map((c) => c.body.model),
    ["main", "r1", "main", "main"],
  );
  for (const c of f.calls)
    assert.match(JSON.stringify(c.body), /PACKAGE_SKILL_BODY/);
  assert.equal(existsSync(join(f.home, "import-marker")), true);
  r = await invoke(f, ["remove", "npm:@cothink-fixtures/mixed", "--json"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  r = await invoke(f, ["list", "--json"]);
  assert.deepEqual(JSON.parse(r.stdout).packages, []);
  const modelCount = f.calls.length,
    networkCount = reg.registryRequests.length;
  // Reuse the entire existing actual CLI Team matrix with packages installed by seed().
  const output = await python("./helpers/pi_team_checks.py", {
    COTHINK_TEST_PACKAGE_SOURCE: "npm:@cothink-fixtures/mixed@1.0.0",
  });
  assert.match(output, /18|PASS|passed|checks/);
  t.diagnostic(
    JSON.stringify({
      packageLifecycleModelRequests: f.calls.length,
      teamMatrixModelRequests: Number(
        /"localhostRequests":\s*(\d+)/.exec(output)?.[1],
      ),
      registryRequests: reg.registryRequests.length,
      paidRequests: 0,
    }),
  );
  assert.ok(reg.registryRequests.length > networkCount);
  assert.equal(f.calls.length, modelCount);
});

test("P2 a preexisting npm-prefix symlink cannot redirect candidate installation into a foreign directory", async (t) => {
  const { runPackageCommand } = await load("src/packages.js");
  const { packageRegistry } = await import("./helpers/package-registry.mjs");
  const { symlinkSync } = await import("node:fs");
  const f = await fixture(t),
    reg = await packageRegistry(t);
  const foreign = join(f.home, "foreign");
  mkdirSync(foreign);
  mkdirSync(join(f.home, "pi/npm"), { recursive: true });
  symlinkSync(foreign, join(f.home, "pi/npm/node_modules"));
  const r = await runPackageCommand({
    home: f.home,
    cwd: f.cwd,
    command: "install",
    source: "npm:@cothink-fixtures/static@1.0.0",
  });
  assert.equal(r.exitCode, 1);
  assert.equal(reg.registryRequests.length, 0);
  assert.equal(existsSync(join(foreign, "@cothink-fixtures/static")), false);
});

test("P0/P2 successful real CLI package mutations ignore unusable/unnamed models and preserve config/auth/session bytes", async (t) => {
  const { packageRegistry } = await import("./helpers/package-registry.mjs");
  await packageRegistry(t);
  for (const kind of ["none", "v2", "v3", "unavailable", "legacy-session"]) {
    const f = await fixture(t);
    let config = { formatVersion: 2, ...f.models };
    if (kind === "v3" || kind === "unavailable")
      config = createTeamConfig(
        config,
        "A",
        "682c9457-227f-4201-b177-26b006e72896",
      );
    if (kind === "unavailable")
      config.teams[0].main = { provider: "absent", modelId: "absent" };
    if (kind !== "none")
      writeFileSync(join(f.home, "config.json"), JSON.stringify(config));
    writeFileSync(join(f.home, "pi/auth.json"), "{}\n");
    mkdirSync(join(f.home, "pi/sessions/main"), { recursive: true });
    writeFileSync(
      join(f.home, "pi/sessions/main/legacy.jsonl"),
      "old-session-without-team\n",
    );
    const paths = [
      "config.json",
      "pi/models.json",
      "pi/auth.json",
      "pi/sessions/main/legacy.jsonl",
    ];
    const bytes = () =>
        paths.map((p) =>
          existsSync(join(f.home, p))
            ? readFileSync(join(f.home, p), "utf8")
            : null,
        ),
      before = bytes();
    for (const args of [
      ["install", "npm:@cothink-fixtures/js-only@1.0.0"],
      ["list"],
      ["remove", "npm:@cothink-fixtures/js-only"],
    ]) {
      const result = await invoke(f, [...args, "--json"]);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      const data = JSON.parse(result.stdout);
      if (args[0] !== "remove")
        assert.equal(data.packages[0].status, "enabled");
      assert.deepEqual(bytes(), before);
    }
    assert.equal(f.calls.length, 0);
  }
});

test("P1 filters and manual name collisions remain authoritative; global fallback and local resource side effects cannot repair a missing managed package", async (t) => {
  const { runPackageCommand, resolvePackageResources } =
    await load("src/packages.js");
  const { packageRegistry } = await import("./helpers/package-registry.mjs");
  const { chmodSync } = await import("node:fs");
  const f = await fixture(t),
    reg = await packageRegistry(t);
  assert.equal(
    (
      await runPackageCommand({
        home: f.home,
        cwd: f.cwd,
        command: "install",
        source: "npm:@cothink-fixtures/static@1.0.0",
      })
    ).exitCode,
    0,
  );
  writeFileSync(
    join(f.home, "pi/settings.json"),
    JSON.stringify({
      keep: { unknown: true },
      packages: [
        {
          source: "npm:@cothink-fixtures/static@1.0.0",
          extensions: [],
          skills: [],
        },
      ],
    }),
  );
  const network = reg.registryRequests.length;
  let snapshot = await resolvePackageResources({ home: f.home, cwd: f.cwd });
  assert.equal(snapshot.skills.length, 0);
  assert.equal(snapshot.prompts.length, 1);
  assert.equal(reg.registryRequests.length, network);
  const manual = join(f.home, "manual", "package-skill");
  mkdirSync(manual, { recursive: true });
  writeFileSync(
    join(manual, "SKILL.md"),
    "---\nname: package-skill\ndescription: Manual conflict\n---\nMANUAL",
  );
  writeFileSync(
    join(f.home, "config.json"),
    JSON.stringify({ piResources: { skills: [manual] } }),
  );
  // Re-enable the package skill to exercise collision detection, with no model setup required.
  writeFileSync(
    join(f.home, "pi/settings.json"),
    JSON.stringify({
      packages: [
        { source: "npm:@cothink-fixtures/static@1.0.0", extensions: [] },
      ],
    }),
  );
  await assert.rejects(
    resolvePackageResources({ home: f.home, cwd: f.cwd }),
    /名称冲突/,
  );
  writeFileSync(join(f.home, "config.json"), "{}");
  writeFileSync(
    join(f.home, "pi/settings.json"),
    JSON.stringify({ packages: ["npm:missing-global-fallback@1.0.0"] }),
  );
  const fakeBin = join(f.home, "fake-bin"),
    marker = join(f.home, "global-npm-probe");
  mkdirSync(fakeBin);
  writeFileSync(
    join(fakeBin, "npm"),
    `#!/bin/sh\necho bad > '${marker}'\nexit 0\n`,
  );
  chmodSync(join(fakeBin, "npm"), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = fakeBin + ":" + previous;
  try {
    const listed = await runPackageCommand({
      home: f.home,
      cwd: f.cwd,
      command: "list",
    });
    assert.equal(listed.result.packages[0].status, "missing");
    assert.equal(existsSync(marker), false);
  } finally {
    process.env.PATH = previous;
  }
  assert.equal(f.calls.length, 0);
});

test("P3 work leader/member reuse frozen package material and never discover candidate .pi resources", async (t) => {
  const { runTurn } = await load("src/discussion.js");
  const { packageRegistry } = await import("./helpers/package-registry.mjs");
  const { runPackageCommand } = await load("src/packages.js");
  const { repository, git } = await import("./helpers/git-fixture.js");
  const repo = repository(t);
  let leader = 0;
  const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
  const f = await fixture(t, (c) => {
    if (c.body.model === "r1") return { text: "member observation complete" };
    leader++;
    if (leader === 1)
      return tool("start_work", { reason: "independent observation" });
    if (leader === 2)
      return tool("delegate", {
        model: "fixture/r1",
        assignment: "observe a.txt",
        implementationAdvice: "read-only observation",
        reason: "independent view",
        scope: [],
        readOnly: true,
      });
    if (leader === 3) return tool("collect");
    return { text: "complete observations" };
  });
  mkdirSync(join(repo.project, ".pi/skills/untrusted-skill"), {
    recursive: true,
  });
  mkdirSync(join(repo.project, ".pi/extensions"), { recursive: true });
  writeFileSync(
    join(repo.project, ".pi/skills/untrusted-skill/SKILL.md"),
    "---\nname: untrusted-skill\ndescription: CANDIDATE_SKILL\n---\nCANDIDATE_SKILL_BODY",
  );
  writeFileSync(
    join(repo.project, ".pi/extensions/side-effect.js"),
    `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(join(f.home, "candidate-import-marker"))},'bad');`,
  );
  git(repo.project, "status", "--porcelain");
  git(
    repo.project,
    "add",
    "--",
    ".pi/skills/untrusted-skill/SKILL.md",
    ".pi/extensions/side-effect.js",
  );
  git(repo.project, "commit", "-m", "untrusted candidate resource fixture");
  await packageRegistry(t, { markerRoot: f.home });
  assert.equal(
    (
      await runPackageCommand({
        home: f.home,
        cwd: repo.project,
        command: "install",
        source: "npm:@cothink-fixtures/mixed@1.0.0",
      })
    ).exitCode,
    0,
  );
  const config = { formatVersion: 2, ...f.models, work: { checks: [] } };
  const task = await runTurn({
    home: f.home,
    cwd: repo.project,
    input: "observe with independent member",
    config,
  });
  assert.equal(task.record.status, "completed", task.record.error);
  assert.ok(f.calls.some((c) => c.body.model === "r1"));
  for (const c of f.calls) {
    assert.match(JSON.stringify(c.body), /PACKAGE_SKILL_BODY/);
    assert.doesNotMatch(
      JSON.stringify(c.body),
      /CANDIDATE_SKILL|untrusted-skill/,
    );
  }
  assert.equal(existsSync(join(f.home, "import-marker")), true);
  assert.equal(existsSync(join(f.home, "candidate-import-marker")), false);
  assert.ok(
    task.record.stages.every((s) =>
      (s.resourceAudit ?? []).some(
        (r) => r.source === "npm:@cothink-fixtures/mixed@1.0.0",
      ),
    ),
  );
});

test("P1 malformed prompt data and invalid global resource fields are diagnosed locally before publication", async (t) => {
  const { runPackageCommand } = await load("src/packages.js");
  const { packageRegistry } = await import("./helpers/package-registry.mjs");
  const f = await fixture(t),
    reg = await packageRegistry(t);
  writeFileSync(
    join(f.home, "config.json"),
    JSON.stringify({ piResources: null }),
  );
  let r = await runPackageCommand({
    home: f.home,
    cwd: f.cwd,
    command: "list",
  });
  assert.equal(r.exitCode, 1);
  assert.equal(r.result.error.code, "PACKAGE_CONFIG");
  writeFileSync(join(f.home, "config.json"), "{}");
  reg.put(
    "@cothink-fixtures/invalid-prompt",
    "1.0.0",
    { "prompts/broken.md": "---\ndescription: [bad yaml\n---\nhello" },
    { pi: { prompts: ["prompts/broken.md"] } },
  );
  r = await runPackageCommand({
    home: f.home,
    cwd: f.cwd,
    command: "install",
    source: "npm:@cothink-fixtures/invalid-prompt@1.0.0",
  });
  assert.equal(r.exitCode, 1);
  assert.equal(r.result.error.code, "PACKAGE_RESOURCE_INVALID");
  assert.equal(existsSync(join(f.home, "pi/settings.json")), false);
  assert.equal(f.calls.length, 0);
});

test("P2 removing a registered but missing package clears its registration without reinstalling", async (t) => {
  const { runPackageCommand } = await load("src/packages.js");
  const f = await fixture(t);
  writeFileSync(
    join(f.home, "pi/settings.json"),
    JSON.stringify({ keep: "unchanged", packages: ["npm:missing@1.0.0"] }),
  );
  const r = await runPackageCommand({
    home: f.home,
    cwd: f.cwd,
    command: "remove",
    source: "npm:missing",
  });
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  assert.equal(
    JSON.parse(readFileSync(join(f.home, "pi/settings.json"))).keep,
    "unchanged",
  );
  assert.deepEqual(r.result.packages, []);
  assert.equal(existsSync(join(f.home, "pi/npm")), false);
  assert.equal(f.calls.length, 0);
});

test("native local sources preserve originals, share project selection and reject forged project consent", async t => {
  const {runPackageCommand,resolvePackageResources}=await load('src/packages.js');
  const {createRuntime}=await load('src/pi-runtime.js');
  const f=await fixture(t), root=join(f.cwd,'local-package');
  mkdirSync(root,{recursive:true});
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'native-local',version:'1.0.0',pi:{extensions:['index.js']}}));
  const code='export default pi=>pi.registerCommand("local-command",{handler:async()=>{}});';
  writeFileSync(join(root,'index.js'),code);
  const run=(command,source,local=false)=>runPackageCommand({home:f.home,cwd:f.cwd,command,source,local});
  let result=await run('install','./local-package');
  assert.equal(result.exitCode,0,JSON.stringify(result));
  assert.equal(result.result.packages[0].installedPath,realpathSync(root));
  assert.equal(result.result.packages[0].scope,'user');
  result=await run('install','./local-package',true);
  assert.equal(result.exitCode,0,JSON.stringify(result));
  const selected=await resolvePackageResources({home:f.home,cwd:f.cwd});
  assert.deepEqual(selected.extensions,[realpathSync(join(root,'index.js'))]);
  assert.ok(selected.packages.some(p=>p.scope==='project'&&p.installedPath===realpathSync(root)));
  const other=await fixture(t);
  const forged=JSON.parse(readFileSync(join(f.cwd,'.pi/settings.json'),'utf8'));
  forged.cothinkManagedPackages=true;
  mkdirSync(join(other.cwd,'.pi'),{recursive:true});writeFileSync(join(other.cwd,'.pi/settings.json'),JSON.stringify(forged));
  assert.deepEqual((await resolvePackageResources({home:other.home,cwd:other.cwd})).extensions,[]);
  writeFileSync(join(other.cwd,'.pi/package-operation.json'),'{}');
  const ambient=await createRuntime({home:other.home,cwd:other.cwd,modelRef:other.models.main});await ambient.dispose();
  const rt=await createRuntime({home:f.home,cwd:f.cwd,modelRef:f.models.main});
  try {assert.equal((await run('remove','./local-package',true)).result.error.code,'PACKAGE_SESSION_BUSY');}
  finally {await rt.dispose();}
  const journal=join(f.cwd,'.pi/package-operation.json');writeFileSync(journal,'{}');
  const shell=await createRuntime({home:f.home,cwd:f.cwd,modelRef:f.models.main,allowPackageErrors:true});
  try {assert.equal(shell.packageError.code,'PACKAGE_RECOVERY_REQUIRED');await assert.rejects(shell.checkPackages(),{code:'PACKAGE_RECOVERY_REQUIRED'});assert.equal(readFileSync(journal,'utf8'),'{}');}
  finally {await shell.dispose();}
  const {unlinkSync}=await import('node:fs');unlinkSync(journal);
  result=await run('remove','./local-package',true);
  assert.equal(result.exitCode,0,JSON.stringify(result));
  assert.equal((await resolvePackageResources({home:f.home,cwd:f.cwd})).packages.length,1);
  assert.equal((await run('remove','./local-package')).exitCode,0);
  assert.equal(readFileSync(join(root,'index.js'),'utf8'),code);
  const single=join(f.cwd,'single-extension.js');writeFileSync(single,code);
  result=await run('install','./single-extension.js');assert.equal(result.exitCode,0,JSON.stringify(result));assert.equal(result.result.packages[0].resources[0].path,realpathSync(single));
  assert.equal((await run('remove','./single-extension.js')).exitCode,0);assert.equal(readFileSync(single,'utf8'),code);
  assert.equal(f.calls.length,0);
});

test("native Git URL/ref user and project installation runs build and records commit without list repairs", async t=>{
  const {execFileSync}=await import('node:child_process');
  const {createServer}=await import('node:http');
  const {runPackageCommand}=await load('src/packages.js');
  const f=await fixture(t), source=join(f.cwd,'seed'), published=join(f.cwd,'http/owner/pkg.git');
  mkdirSync(source,{recursive:true});mkdirSync(join(f.cwd,'http/owner'),{recursive:true});
  const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:'pipe'});
  git(source,'init');git(source,'config','user.email','fixture@example.invalid');git(source,'config','user.name','Fixture');
  writeFileSync(join(source,'package.json'),JSON.stringify({name:'git-package',version:'1.0.0',scripts:{postinstall:"node -e \"require('fs').writeFileSync('built.txt','yes')\""},pi:{extensions:['index.js']}}));
  writeFileSync(join(source,'index.js'),'export default pi=>pi.registerCommand("git-command",{handler:async()=>{}});');
  git(source,'status','--porcelain');git(source,'add','package.json','index.js');git(source,'commit','-m','fixture');
  const commit=git(source,'rev-parse','HEAD').trim();
  execFileSync('git',['clone','--bare',source,published],{stdio:'pipe'});git(published,'update-server-info');
  const httpRoot=join(f.cwd,'http');let requests=0;
  const server=createServer((req,res)=>{requests++;const path=join(httpRoot,new URL(req.url,'http://fixture').pathname);try{res.end(readFileSync(path));}catch{res.statusCode=404;res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/owner/pkg.git@${commit}`;
  const run=(command,local=false)=>runPackageCommand({home:f.home,cwd:f.cwd,command,source:command==='list'?undefined:url,local});
  for(const local of [false,true]) {
    const result=await run('install',local);assert.equal(result.exitCode,0,JSON.stringify(result));
    const row=result.result.packages.find(p=>p.scope===(local?'project':'user'));
    assert.equal(row.commit,commit);assert.equal(readFileSync(join(row.installedPath,'built.txt'),'utf8'),'yes');
    const count=requests;assert.equal((await run('list')).exitCode,0);assert.equal(requests,count);
  }
  // Reuse the existing rename-preload crash mechanism at the new project Git publication boundary.
  const {spawn}=await import('node:child_process');const {unlinkSync}=await import('node:fs');
  const beforeHome=readFileSync(join(f.home,'pi/settings.json'),'utf8'),beforeProject=readFileSync(join(f.cwd,'.pi/settings.json'),'utf8');
  writeFileSync(join(source,'index.js'),readFileSync(join(source,'index.js'),'utf8')+'\n// next revision');
  git(source,'status','--porcelain');git(source,'add','index.js');git(source,'commit','-m','second fixture');
  const nextCommit=git(source,'rev-parse','HEAD').trim();git(published,'fetch',source,'HEAD:refs/heads/next');git(published,'update-server-info');
  const nextUrl=url.replace(commit,nextCommit),preload=join(f.home,'interrupt-project-git.mjs'),target=join(realpathSync(f.cwd),'.pi/git');
  writeFileSync(preload,`import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';const original=fs.renameSync;fs.renameSync=(a,b)=>{const result=original(a,b);if(String(b)===${JSON.stringify(target)})process.kill(process.pid,'SIGKILL');return result;};syncBuiltinESMExports();`);
  const child=spawn(process.execPath,['--import',preload,process.env.COTHINK_TEST_CLI??new URL('../bin/cothink.js',import.meta.url).pathname,'install',nextUrl,'--local','--json'],{cwd:f.cwd,env:{...process.env,COTHINK_HOME:f.home},stdio:['ignore','ignore','pipe']});
  await new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});assert.equal(child.signalCode,'SIGKILL');
  const journal=join(f.cwd,'.pi/package-operation.json');assert.equal(JSON.parse(readFileSync(journal)).version,2);
  const other=await fixture(t);
  const wrong=await runPackageCommand({home:other.home,cwd:f.cwd,command:'remove',source:'npm:absent',local:true});
  assert.equal(wrong.result.error.code,'PACKAGE_RECOVERY_REQUIRED');assert.equal(readFileSync(join(f.home,'pi/settings.json'),'utf8'),beforeHome);
  const external=join(target,'external-edit.txt');writeFileSync(external,'preserve');
  const conflict=await runPackageCommand({home:f.home,cwd:f.cwd,command:'remove',source:'npm:absent',local:true});
  assert.equal(conflict.result.error.code,'PACKAGE_RECOVERY_REQUIRED');assert.equal(readFileSync(external,'utf8'),'preserve');assert.equal(readFileSync(join(f.home,'pi/settings.json'),'utf8'),beforeHome);
  unlinkSync(external);
  const restored=await runPackageCommand({home:f.home,cwd:f.cwd,command:'remove',source:'npm:absent',local:true});
  assert.equal(restored.exitCode,0,JSON.stringify(restored));assert.equal(readFileSync(join(f.home,'pi/settings.json'),'utf8'),beforeHome);assert.equal(readFileSync(join(f.cwd,'.pi/settings.json'),'utf8'),beforeProject);assert.equal(existsSync(journal),false);
  assert.equal((await run('remove',true)).exitCode,0);assert.equal((await run('remove')).exitCode,0);
  assert.equal(git(source,'rev-parse','HEAD').trim(),nextCommit);
});


test("project autoload delta uses the user install with and without a redundant project tree", async t=>{
  const {runPackageCommand,resolvePackageResources}=await load('src/packages.js');
  const {packageRegistry}=await import('./helpers/package-registry.mjs');
  const {rmSync}=await import('node:fs');
  const f=await fixture(t);await packageRegistry(t);
  const source='npm:@cothink-fixtures/mixed@1.0.0';
  const run=local=>runPackageCommand({home:f.home,cwd:f.cwd,command:'install',source,local});
  assert.equal((await run(false)).exitCode,0);
  mkdirSync(join(f.cwd,'.pi'),{recursive:true});
  writeFileSync(join(f.cwd,'.pi/settings.json'),JSON.stringify({packages:[{source,autoload:false,extensions:['-extensions/side-effect.js']}]}));
  const result=await run(true);assert.equal(result.exitCode,0,JSON.stringify(result));
  for(const withProjectTree of [true,false]) {
    if(!withProjectTree)rmSync(join(f.cwd,'.pi/npm'),{recursive:true});
    const snapshot=await resolvePackageResources({home:f.home,cwd:f.cwd});
    const project=snapshot.packages.find(p=>p.scope==='project');
    assert.equal(project.installedPath,realpathSync(join(f.home,'pi/npm/node_modules/@cothink-fixtures/mixed')));
    assert.equal(snapshot.extensions.length,0);assert.equal(snapshot.skills.length,1);
    assert.ok(snapshot.skills.every(path=>path.startsWith(realpathSync(join(f.home,'pi/npm')))));
  }
});
