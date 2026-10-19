import { createAgentSync } from "../../src/index.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const config = JSON.parse(readFileSync(process.argv[2])),
  scenario = process.argv[3];
const realDocker = execFileSync("which", ["docker"], {
    encoding: "utf8",
  }).trim(),
  bin = join(config.root, "bin"),
  mode = join(config.root, "mode");
mkdirSync(bin);
writeFileSync(mode, "");
writeFileSync(
  join(bin, "docker"),
  `#!${process.execPath}\nconst fs=require('fs'),cp=require('child_process');const args=process.argv.slice(2),mode=fs.readFileSync(${JSON.stringify(mode)},'utf8');if((mode==='pause'&&args[0]==='pause')||(mode==='daemon'&&args[0]==='inspect')){process.stderr.write('injected Docker transport failure');process.exit(1);}const r=cp.spawnSync(${JSON.stringify(realDocker)},args,{stdio:'inherit'});process.exit(r.status??1);\n`,
  { mode: 0o755 },
);
const priorPath = process.env.PATH;
process.env.PATH = bin + ":" + priorPath;
let armed = false;
const v = await createAgentSync(config);
try {
  const c = await v.beginChange({
    requestId: "fault-begin",
    actor: "fault",
    intent: scenario,
    scope: ["a.txt"],
  });
  const r = await v.exec(
    c.changeId,
    {
      requestId: "fault-command",
      expectedVersion: c.privateVersion,
      command: "printf pending > a.txt; echo armed",
    },
    {
      onData: () => {
        armed = true;
        writeFileSync(mode, scenario);
      },
    },
  );
  assert.equal(armed, true);
  assert.equal(r.status, "unknown");
  assert.equal(
    (await v.inspect({ changeId: c.changeId })).privateVersion,
    c.privateVersion,
  );
  assert.equal(
    (await v.inspect({ requestId: "fault-command" })).status,
    "unknown",
  );
  if (scenario === "daemon") {
    const blocked = await v.beginChange({
      requestId: "blocked",
      actor: "blocked",
      intent: "no early release",
      scope: ["a.txt"],
      wait: false,
    });
    assert.equal(blocked.status, "blocked");
    await assert.rejects(v.close());
  }
  writeFileSync(mode, "");
  await v.close();
  console.log(JSON.stringify({ scenario, status: "passed" }));
} finally {
  writeFileSync(mode, "");
  await v.close();
  process.env.PATH = priorPath;
}
