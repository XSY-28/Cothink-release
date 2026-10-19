import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { repository } from "./helpers/repository.js";
const source = new URL("../", import.meta.url).pathname;
function run(command, args, cwd) {
  const r = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.stdout;
}
test("C01/C12 dry-run whitelist, real pack, clean prefix JS and executable stdio with no model dependency", async (t) => {
  const repo = repository(t),
    pkg = JSON.parse(readFileSync(join(source, "package.json")));
  assert.equal(pkg.dependencies, undefined);
  const dry = JSON.parse(
    run("npm", ["pack", "--dry-run", "--json"], source),
  )[0];
  assert.ok(
    dry.files.every(
      (f) =>
        ["package.json", "README.md", "LICENSE"].includes(f.path) ||
        f.path.startsWith("src/"),
    ),
  );
  assert.ok(!dry.files.some((f) => /test|work|node_modules/.test(f.path)));
  const packs = join(repo.root, "packs"),
    prefix = join(repo.root, "prefix");
  mkdirSync(packs);
  mkdirSync(prefix);
  const packed = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", packs], source),
  )[0];
  run(
    "npm",
    [
      "install",
      "--prefix",
      prefix,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(packs, packed.filename),
    ],
    repo.root,
  );
  const module = join(
    prefix,
    "node_modules",
    "@cothink",
    "agent-sync",
    "src",
    "index.js",
  );
  const script = join(repo.root, "installed.mjs");
  writeFileSync(
    script,
    `import {createAgentSync} from ${JSON.stringify(module)};const v=await createAgentSync(${JSON.stringify(repo)});const c=await v.beginChange({requestId:'install-begin',actor:'install',intent:'fixture',scope:['a.txt']});const old=await v.read({changeId:c.changeId,path:'a.txt'});await v.edit(c.changeId,{requestId:'install-edit',expectedVersion:c.privateVersion,edits:[{path:'a.txt',oldHash:old.contentHash,contentBase64:'aW5zdGFsbGVk'}]});const p=await v.prepareChange(c.changeId,{requestId:'install-prep'});console.log(JSON.stringify(await v.acceptChange({changeId:c.changeId,candidateVersion:p.candidateVersion,requestId:'install-accept'})));await v.close();`,
  );
  const installed = JSON.parse(run(process.execPath, [script], repo.root));
  assert.equal(installed.status, "accepted");
  const bin = join(prefix, "node_modules", ".bin", "agent-sync");
  const stdin =
    JSON.stringify({
      id: "query",
      method: "inspect",
      params: { requestId: "install-accept" },
    }) + "\n";
  const r = spawnSync(
    bin,
    ["--project", repo.project, "--home", repo.home, "--read-only"],
    {
      input: stdin,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    JSON.parse(r.stdout.trim()).result.acceptedVersion,
    installed.acceptedVersion,
  );
});
