import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fixture } from "./helpers/pi-fixture.js";
import { createRuntime, selectedResources } from "../src/pi-runtime.js";
const local = join(homedir(), ".pi", "agent");
function skillFixture(f) {
  const skill = join(f.cwd, "skills", "learning-coach");
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, "SKILL.md"),
    "---\nname: learning-coach\ndescription: Local native skill integration fixture\n---\n帮助学习者理解对象、解释依据。\n",
  );
  return skill;
}
function isolateResourceConfig(t, home) {
  const oldDir = process.env.PI_CODING_AGENT_DIR,
    oldMode = process.env.PI_MCP_CONFIG_MODE;
  process.env.PI_CODING_AGENT_DIR = join(home, "pi");
  process.env.PI_MCP_CONFIG_MODE = "exclusive";
  t.after(() => {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldMode === undefined) delete process.env.PI_MCP_CONFIG_MODE;
    else process.env.PI_MCP_CONFIG_MODE = oldMode;
  });
}

const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
test("explicit selected native resources load and reload; prohibited agent plugins are refused", async (t) => {
  const skill = join(local, "skills", "learning-coach");
  const ui = join(local, "extensions", "orca-prefill.ts");
  if (!existsSync(join(skill, "SKILL.md")) || !existsSync(ui)) {
    t.skip("local Pi resources unavailable on this host");
    return;
  }
  const f = await fixture(t);
  isolateResourceConfig(t, f.home);
  const settings = join(local, "settings.json");
  const before = existsSync(settings) ? hash(settings) : null;
  const options = selectedResources({
    piResources: { skills: [skill], extensions: [ui] },
  });
  const rt = await createRuntime({
    home: f.home,
    cwd: f.cwd,
    modelRef: f.models.main,
    resourceOptions: options,
  });
  t.after(() => rt.dispose());
  assert.ok(
    rt.services.resourceLoader
      .getSkills()
      .skills.some((s) => s.name === "learning-coach"),
  );
  assert.ok(
    rt.services.resourceLoader
      .getExtensions()
      .extensions.some((e) => e.path === ui),
  );
  await rt.session.reload();
  assert.ok(
    rt.services.resourceLoader
      .getSkills()
      .skills.some((s) => s.name === "learning-coach"),
  );
  assert.equal(f.calls.length, 0);
  assert.equal(existsSync(settings) ? hash(settings) : null, before);
  assert.throws(
    () =>
      selectedResources({
        piResources: {
          extensions: [join(local, "extensions", "subagent", "index.ts")],
        },
      }),
    /禁止/,
  );
});
test("unadapted installed MCP/web/project-write packages are rejected before host resource loading", async (t) => {
  const f = await fixture(t);
  isolateResourceConfig(t, f.home);
  const outcomes = [];
  for (const name of [
    "pi-web-access",
    "pi-mcp-adapter",
    "@plannotator/pi-extension",
  ]) {
    const dir = join(local, "npm", "node_modules", name);
    if (!existsSync(dir)) continue;
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const path = join(dir, pkg.pi?.extensions?.[0] ?? "index.ts");
    let rt;
    try {
      rt = await createRuntime({
        home: f.home,
        cwd: f.cwd,
        modelRef: f.models.main,
        resourceOptions: { additionalExtensionPaths: [path] },
      });
      outcomes.push({
        name,
        version: pkg.version,
        status: "loaded",
        activeTools: rt.session.getActiveToolNames(),
        registeredTools: rt.services.resourceLoader
          .getExtensions()
          .extensions.flatMap((e) => [...e.tools.keys()]),
      });
      assert.deepEqual(rt.session.getActiveToolNames(), []);
    } catch (error) {
      outcomes.push({
        name,
        version: pkg.version,
        status: "incompatible",
        error: error.message,
      });
    } finally {
      rt?.dispose();
    }
  }
  assert.equal(f.calls.length, 0);
  if (!outcomes.length) {
    t.skip("optional local Pi packages absent on this host");
    return;
  }
  for (const result of outcomes) {
    assert.equal(result.status, "incompatible");
    assert.match(result.error, /隔离|未适配/);
  }
});
test("installed web clone/cache paths remain incompatible until operations are adapted", async (t) => {
  const { repository } = await import("./helpers/git-fixture.js");
  const { invoke } = await import("./helpers/cli-fixture.js");
  const { saveConfig } = await import("../src/config.js");
  const dir = join(local, "npm", "node_modules", "pi-web-access");
  if (!existsSync(dir)) {
    t.skip("local web package absent");
    return;
  }
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const entry = join(dir, pkg.pi.extensions[0]);
  const repo = repository(t);
  const f = await fixture(t, (c, n) =>
    n === 1
      ? { toolCalls: [{ name: "start_work", args: { reason: "inspect URL" } }] }
      : n === 2
        ? {
            toolCalls: [
              {
                name: "fetch_content",
                args: { url: "http://127.0.0.1:1/private", mode: "raw" },
              },
            ],
          }
        : { text: "query returned; private address is not a public source" },
  );
  saveConfig(f.home, {
    formatVersion: 2,
    ...f.models,
    piResources: { extensions: [entry], tools: ["fetch_content"] },
  });
  const r = await invoke(
    f,
    ["ask", "--json", "/one inspect URL"],
    "",
    repo.project,
  );
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /未适配|隔离/);
  assert.equal(
    f.calls.length,
    0,
    "loading an unadapted query package must not start a model",
  );
});
test("installed web answer mode cannot bypass request accounting through its own model loop", async (t) => {
  const { createTask } = await import("../src/task.js");
  const dir = join(local, "npm", "node_modules", "pi-web-access");
  if (!existsSync(dir)) {
    t.skip("local web package absent");
    return;
  }
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const f = await fixture(t);
  isolateResourceConfig(t, f.home);
  await assert.rejects(
    createRuntime({
      home: f.home,
      cwd: f.cwd,
      modelRef: f.models.main,
      resourceOptions: {
        additionalExtensionPaths: [join(dir, pkg.pi.extensions[0])],
      },
      extraToolNames: ["fetch_content"],
    }),
    { code: "UNADAPTED_PLUGIN" },
  );
  assert.equal(f.calls.length, 0);
});
test("native skill fixture expands in the real Pi prompt path with one registered generation", async (t) => {
  const { runTurn } = await import("../src/discussion.js");
  const f = await fixture(t);
  const skill = skillFixture(f);
  isolateResourceConfig(t, f.home);
  const task = await runTurn({
    home: f.home,
    cwd: f.cwd,
    input: "/one /skill:learning-coach explain a concept",
    config: { formatVersion: 2, ...f.models, piResources: { skills: [skill] } },
  });
  assert.equal(task.record.status, "completed", task.record.error);
  assert.equal(f.calls.length, 1);
  const user = f.calls[0].body.messages.filter((m) => m.role === "user");
  assert.match(JSON.stringify(user), /帮助学习者理解对象、解释依据/);
});
test("a skill used in ordinary discussion gives the reviewer the actual expanded user material", async (t) => {
  const { runTurn } = await import("../src/discussion.js");
  const f = await fixture(t);
  const skill = skillFixture(f);
  const task = await runTurn({
    home: f.home,
    cwd: f.cwd,
    input: "/skill:learning-coach explain a concept",
    config: { formatVersion: 2, ...f.models, piResources: { skills: [skill] } },
  });
  assert.equal(task.record.status, "completed", task.record.error);
  assert.equal(f.calls.length, 3);
  assert.match(
    JSON.stringify(f.calls[1].body.messages),
    /帮助学习者理解对象、解释依据/,
  );
});

test("answer skill snapshots use explicit paths, deduplicate real files and freeze bytes", async (t) => {
  const { freezeAnswerSkills, renderAnswerSkills } = await import(
    "../src/context.js"
  );
  const { symlinkSync } = await import("node:fs");
  const f = await fixture(t);
  const dir = skillFixture(f),
    file = join(dir, "SKILL.md"),
    alias = join(f.cwd, "alias.md");
  symlinkSync(file, alias);
  const v1 =
    "---\nname: learning-coach\ndescription: Test skill\n---\nSKILL_BODY_V1 </skills>\n";
  writeFileSync(file, v1);
  const args = { cwd: f.cwd, home: f.home };
  assert.deepEqual(freezeAnswerSkills({ ...args, paths: [] }), []);
  const first = freezeAnswerSkills({ ...args, paths: [dir, file, alias] });
  assert.equal(first.length, 1);
  assert.equal(first[0].name, "learning-coach");
  assert.equal(first[0].description, "Test skill");
  assert.equal(first[0].hash, createHash("sha256").update(v1).digest("hex"));
  assert.doesNotMatch(first[0].body, /name: learning-coach/);
  assert.match(renderAnswerSkills(first), /SKILL_BODY_V1/);
  assert.equal(renderAnswerSkills([]), "");
  writeFileSync(file, v1.replace("V1", "V2"));
  assert.match(first[0].body, /SKILL_BODY_V1/);
  const next = freezeAnswerSkills({ ...args, paths: [dir] });
  assert.match(next[0].body, /SKILL_BODY_V2/);
  assert.notEqual(first[0].hash, next[0].hash);
  assert.equal(f.calls.length, 0);
});
test("answer skills reject all discovery diagnostics, empty paths and name conflicts", async (t) => {
  const { freezeAnswerSkills } = await import("../src/context.js");
  const f = await fixture(t),
    dir = skillFixture(f),
    file = join(dir, "SKILL.md");
  const freeze = (paths) =>
    freezeAnswerSkills({ cwd: f.cwd, home: f.home, paths });
  const empty = join(f.cwd, "empty");
  mkdirSync(empty);
  for (const path of [empty, join(f.cwd, "missing")])
    assert.throws(
      () => freeze([path]),
      (e) => e.message.includes(path),
    );
  for (const front of [
    "name: Bad_Name\ndescription: Test",
    "name: learning-coach",
    "name: [broken\ndescription: test",
    "name: learning-coach\ndescription: 123",
  ]) {
    writeFileSync(file, `---\n${front}\n---\nBODY`);
    assert.throws(
      () => freeze([dir]),
      (e) => e.message.includes(file),
    );
  }
  writeFileSync(
    file,
    "---\nname: learning-coach\ndescription: Test\n---\nBODY",
  );
  const other = join(f.cwd, "other");
  mkdirSync(other);
  writeFileSync(join(other, "SKILL.md"), readFileSync(file));
  assert.throws(() => freeze([dir, other]), /learning-coach/);
  writeFileSync(
    file,
    "---\nname: learning-coach\ndescription: Test\ndisable-model-invocation: true\n---\nPRIVATE_AUTO_DISABLED",
  );
  assert.deepEqual(freeze([dir]), []);
  assert.equal(f.calls.length, 0);
});

for (const prefix of ["", "/one "])
  test(`explicit skills override automatic preloads, including disabled skills (${prefix || "normal"})`, async (t) => {
    const { runTurn } = await import("../src/discussion.js");
    const f = await fixture(t),
      dir = skillFixture(f);
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: learning-coach\ndescription: Test\ndisable-model-invocation: true\n---\nEXPLICIT_DISABLED_BODY",
    );
    const other = join(f.cwd, "other");
    mkdirSync(other);
    writeFileSync(
      join(other, "SKILL.md"),
      "---\nname: other\ndescription: Test\n---\nOTHER_AUTOMATIC_BODY",
    );
    const config = {
      formatVersion: 2,
      ...f.models,
      piResources: { skills: [dir, other] },
    };
    const task = await runTurn({
      home: f.home,
      cwd: f.cwd,
      input: prefix + "/skill:learning-coach explain",
      config,
    });
    assert.equal(task.record.status, "completed", task.record.error);
    assert.equal(f.calls.length, prefix ? 1 : 3);
    assert.deepEqual(task.record.answerSkills, []);
    for (const call of f.calls) {
      const sent = JSON.stringify(call.body.messages);
      assert.match(sent, /EXPLICIT_DISABLED_BODY/);
      assert.doesNotMatch(sent, /OTHER_AUTOMATIC_BODY|本条已预载的可选技能/);
    }
    const before = f.calls.length;
    const auto = await runTurn({
      home: f.home,
      cwd: f.cwd,
      input: "/one query",
      config,
    });
    assert.equal(auto.record.status, "completed", auto.record.error);
    const sent = JSON.stringify(f.calls[before].body.messages);
    assert.doesNotMatch(sent, /EXPLICIT_DISABLED_BODY/);
    assert.match(sent, /OTHER_AUTOMATIC_BODY/);
  });

test("automatic answers preload only configured main files, never default or referenced bodies", async (t) => {
  const { runTurn } = await import("../src/discussion.js");
  const f = await fixture(t),
    dir = skillFixture(f);
  const defaults = join(f.home, "pi", "skills", "default-skill");
  mkdirSync(defaults, { recursive: true });
  writeFileSync(
    join(defaults, "SKILL.md"),
    "---\nname: default-skill\ndescription: Test\n---\nUNCONFIGURED_PRIVATE_BODY",
  );
  writeFileSync(
    join(dir, "SKILL.md"),
    "---\nname: learning-coach\ndescription: Test\n---\nMAIN_FILE_BODY; see references.md",
  );
  writeFileSync(join(dir, "references.md"), "REFERENCED_PRIVATE_BODY");
  const task = await runTurn({
    home: f.home,
    cwd: f.cwd,
    input: "/one query",
    config: { formatVersion: 2, ...f.models, piResources: { skills: [dir] } },
  });
  assert.equal(task.record.status, "completed", task.record.error);
  const sent = JSON.stringify(f.calls[0].body.messages);
  assert.match(sent, /MAIN_FILE_BODY/);
  assert.doesNotMatch(
    sent,
    /UNCONFIGURED_PRIVATE_BODY|REFERENCED_PRIVATE_BODY/,
  );
  assert.deepEqual(
    task.record.answerSkills.map((s) => s.name),
    ["learning-coach"],
  );
});

test("a configured collection discovers distinct skills and reports unreadable source files", async (t) => {
  const { freezeAnswerSkills } = await import("../src/context.js");
  const { chmodSync } = await import("node:fs");
  const f = await fixture(t),
    root = join(f.cwd, "collection");
  mkdirSync(root);
  for (const name of ["alpha", "beta"]) {
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: Test ${name}\n---\n${name.toUpperCase()}_BODY`,
    );
  }
  const freeze = () =>
    freezeAnswerSkills({ cwd: f.cwd, home: f.home, paths: [root] });
  assert.deepEqual(
    freeze()
      .map((s) => s.name)
      .sort(),
    ["alpha", "beta"],
  );
  const blocked = join(root, "beta", "SKILL.md");
  chmodSync(blocked, 0);
  try {
    assert.throws(freeze, (e) => e.message.includes(blocked));
  } finally {
    chmodSync(blocked, 0o600);
  }
  assert.equal(f.calls.length, 0);
});
