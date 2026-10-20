// Private localhost npm registry: genuine metadata/tarballs consumed by real npm.
import { createServer } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
export const themeColors =
  "accent border borderAccent borderMuted success error warning muted dim text thinkingText selectedBg userMessageBg userMessageText customMessageBg customMessageText customMessageLabel toolPendingBg toolSuccessBg toolErrorBg toolTitle toolOutput mdHeading mdLink mdLinkUrl mdCode mdCodeBlock mdCodeBlockBorder mdQuote mdQuoteBorder mdHr mdListBullet toolDiffAdded toolDiffRemoved toolDiffContext syntaxComment syntaxKeyword syntaxFunction syntaxVariable syntaxString syntaxNumber syntaxType syntaxOperator syntaxPunctuation thinkingOff thinkingMinimal thinkingLow thinkingMedium thinkingHigh thinkingXhigh bashMode".split(
    " ",
  );
export async function packageRegistry(t, { markerRoot } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cothink-npm-fixture-")),
    packages = new Map(),
    registryRequests = [],
    pending = [];
  let delayName, failName, endpoint;
  const put = (name, version, files, extra = {}) => {
    const dir = join(
      root,
      name.replaceAll("/", "-") + "-" + version,
      "package",
    );
    mkdirSync(dir, { recursive: true });
    const manifest = { name, version, ...extra };
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    for (const [path, bytes] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), bytes);
    }
    const tar = join(dirname(dir), "package.tgz");
    execFileSync("tar", ["-czf", tar, "-C", dirname(dir), "package"]);
    const bytes = readFileSync(tar);
    const versions = packages.get(name) ?? new Map();
    versions.set(version, {
      directory: dir,
      manifest,
      bytes,
      integrity:
        "sha512-" + createHash("sha512").update(bytes).digest("base64"),
    });
    packages.set(name, versions);
  };
  const staticFiles = {
    "skills/package-skill/SKILL.md":
      "---\nname: package-skill\ndescription: Package fixture skill\n---\nPACKAGE_SKILL_BODY: reason from the supplied facts.\n",
    "prompts/package-prompt.md":
      "---\ndescription: package prompt\n---\nPACKAGE_PROMPT $ARGUMENTS",
    "themes/fixture.json": JSON.stringify({
      name: "fixture-theme",
      colors: Object.fromEntries(themeColors.map((k) => [k, ""])),
    }),
  };
  const pi = {
    skills: ["skills"],
    prompts: ["prompts/package-prompt.md"],
    themes: ["themes/fixture.json"],
  };
  for (const v of ["1.0.0", "2.0.0"])
    put("@cothink-fixtures/static", v, staticFiles, {
      pi,
      keywords: ["pi-package"],
    });
  put(
    "@cothink-fixtures/mixed",
    "1.0.0",
    {
      ...staticFiles,
      "extensions/side-effect.js": `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(join(markerRoot ?? root, "import-marker"))},'bad');export default()=>{};`,
    },
    {
      pi: { ...pi, extensions: ["extensions/side-effect.js"] },
      keywords: ["pi-package"],
    },
  );
  const script = (name) =>
    `require('fs').writeFileSync(${JSON.stringify(join(markerRoot ?? root, name))},'bad');`;
  put(
    "@cothink-fixtures/hook-dep",
    "1.0.0",
    { "postinstall.cjs": script("dependency-script-marker") },
    { scripts: { postinstall: "node postinstall.cjs" } },
  );
  put(
    "@cothink-fixtures/hook",
    "1.0.0",
    {
      "postinstall.cjs": script("root-script-marker"),
      "skills/hook-skill/SKILL.md":
        "---\nname: hook-skill\ndescription: Hook fixture skill\n---\nHOOK_SKILL_BODY",
    },
    {
      pi: { skills: ["skills"] },
      scripts: { postinstall: "node postinstall.cjs" },
      dependencies: { "@cothink-fixtures/hook-dep": "1.0.0" },
    },
  );
  put("@cothink-fixtures/conflict", "1.0.0", staticFiles, { pi });
  for (const v of ["2.0.0", "3.0.0", "4.0.0"]) {
    const command = { "2.0.0": "team", "3.0.0": "models", "4.0.0": "model" }[v];
    put(
      "@cothink-fixtures/conflict",
      v,
      { [`prompts/${command}.md`]: "collision" },
      { pi: { prompts: [`prompts/${command}.md`] } },
    );
  }
  put(
    "@cothink-fixtures/escape",
    "1.0.0",
    {},
    { pi: { skills: ["../outside"] } },
  );
  put("@cothink-fixtures/not-pi", "1.0.0", { "index.js": "export const n=1" });
  put(
    "@cothink-fixtures/js-only",
    "1.0.0",
    { "extensions/x.js": 'throw Error("MUST_NOT_IMPORT")' },
    { pi: { extensions: ["extensions/x.js"] } },
  );
  const server = createServer(async (req, res) => {
    registryRequests.push({ url: req.url, method: req.method });
    const path = decodeURIComponent(req.url.split("?")[0]).slice(1);
    const name = path.split("/-/")[0];
    if (name === delayName) {
      pending.push(res);
      return;
    }
    if (name === failName) {
      res.writeHead(503);
      res.end("fixture unavailable");
      return;
    }
    const versions = packages.get(name);
    if (!versions) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":"fixture not found"}');
      return;
    }
    if (path.includes("/-/")) {
      const version = path.split("/-/")[1].replace(".tgz", "");
      const item = versions.get(version);
      if (!item) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(item.bytes);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        name,
        "dist-tags": { latest: [...versions.keys()].at(-1) },
        versions: Object.fromEntries(
          [...versions].map(([v, item]) => [
            v,
            {
              ...item.manifest,
              dist: {
                tarball: endpoint + "/" + name + "/-/" + v + ".tgz",
                integrity: item.integrity,
              },
            },
          ]),
        ),
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${server.address().port}`;
  const old = {
    registry: process.env.npm_config_registry,
    userconfig: process.env.npm_config_userconfig,
    cache: process.env.npm_config_cache,
  };
  const userconfig = join(root, "npmrc");
  writeFileSync(userconfig, "fetch-retries=0\n");
  Object.assign(process.env, {
    npm_config_registry: endpoint,
    npm_config_userconfig: userconfig,
    npm_config_cache: join(root, "cache"),
  });
  t.after(async () => {
    if (process.env.COTHINK_PACKAGE_EVIDENCE_DIR) {
      const destination = process.env.COTHINK_PACKAGE_EVIDENCE_DIR;
      mkdirSync(destination, { recursive: true });
      writeFileSync(
        join(destination, randomUUID() + ".json"),
        JSON.stringify(
          {
            fixtureTarballs: [...packages].flatMap(([name, versions]) =>
              [...versions].map(([version, p]) => ({
                name,
                version,
                integrity: p.integrity,
                bytes: p.bytes.length,
              })),
            ),
            registryRequests,
            serverType: "localhost npm registry",
          },
          null,
          2,
        ) + "\n",
      );
    }
    for (const r of pending) r.destroy();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    for (const [k, v] of Object.entries(old)) {
      const env = "npm_config_" + k;
      if (v === undefined) delete process.env[env];
      else process.env[env] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    endpoint,
    put,
    registryRequests,
    packages,
    delay(name) {
      delayName = name;
    },
    fail(name) {
      failName = name;
    },
  };
}
