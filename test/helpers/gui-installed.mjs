/** Actual installed CLI/static smoke; no source-module imports. */
import assert from "node:assert/strict";
import {
  readFileSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = resolve(process.argv[2]),
  pkg = JSON.parse(readFileSync(join(root, "package.json")));
const source = resolve(process.argv[3] ?? fileURLToPath(new URL("../..", import.meta.url)));
const expectedVersion = process.env.COTHINK_EXPECT_VERSION ??
  JSON.parse(readFileSync(join(source, "package.json"))).version;
assert.equal(pkg.version, expectedVersion);
assert.equal(pkg.overrides, undefined);
for (const p of [
  "conversation",
  "final-answer",
  "gui-controller",
  "gui-projection",
  "gui-settings",
  "gui-work",
  "gui-server",
])
  await import(pathToFileURL(join(root, "src", p + ".js")));
let comparedFiles = 0;
if (process.argv[3]) {
  function compare(path) {
    const a = join(source, path),
      b = join(root, path);
    if (statSync(a).isDirectory()) {
      for (const name of readdirSync(a)) {
        // npm prunes transitive dependency documentation while bundling. Compare
        // the frozen SDK itself; its original vendored tarball is also checked above.
        if (path.startsWith("node_modules/@earendil-works/pi-coding-agent") && name === "node_modules") continue;
        compare(join(path, name));
      }
    } else {
      assert.deepEqual(readFileSync(b), readFileSync(a), path);
      comparedFiles++;
    }
  }
  for (const path of pkg.files) compare(path);
  // Bundled frozen SDK must preserve exactly the previously locked runtime bytes.
  compare("node_modules/@earendil-works/pi-coding-agent");
}
const home = mkdtempSync(join(tmpdir(), "CoThink 安装 home "));
const run = (args) =>
  spawn(process.execPath, [join(root, "bin/cothink.js"), ...args], {
    cwd: home,
    env: { ...process.env, COTHINK_HOME: home, PI_OFFLINE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
const version = run(["--version"]);
let text = "";
version.stdout.on("data", (x) => (text += x));
assert.equal((await once(version, "close"))[0], 0);
assert.equal(text.trim(), pkg.version);
const child = run(["gui", "--no-open"]);
let stdout = "",
  stderr = "";
child.stdout.on("data", (x) => (stdout += x));
child.stderr.on("data", (x) => (stderr += x));
const exit = once(child, "close");
try {
  let url;
  for (let i = 0; i < 500; i++) {
    url = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[\w-]+/)?.[0];
    if (url) break;
    assert.equal(child.exitCode, null, stderr);
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(url, "installed CLI startup URL");
  const u = new URL(url),
    token = new URLSearchParams(u.hash.slice(1)).get("token"),
    headers = { Authorization: `Bearer ${token}` };
  const bootstrap = await fetch(u.origin + "/api/bootstrap", { headers });
  assert.equal(bootstrap.status, 200);
  assert.equal((await bootstrap.json()).version, pkg.version);
  assert.equal((await fetch(u.origin + "/api/bootstrap")).status, 403);
  const html = await fetch(u.origin);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /assets\/index-/);
  const assets = readdirSync(join(root, "gui/dist/assets"));
  assert.ok(assets.some((x) => x.endsWith(".woff2")));
  for (const name of assets) {
    const response = await fetch(u.origin + "/assets/" + name);
    assert.equal(response.status, 200, name);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
  console.log(
    JSON.stringify({
      installedRoot: root,
      version: pkg.version,
      actualCli: true,
      staticAssets: assets.length,
      comparedFiles,
      authentication: true,
      paidModelCalls: 0,
    }),
  );
} finally {
  child.kill("SIGTERM");
  await exit;
  rmSync(home, { recursive: true, force: true });
}
