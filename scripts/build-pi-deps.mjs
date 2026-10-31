/** Rebuild fixed Pi + narrowly patched SDKs without changing global Pi or product node_modules. */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const spec = JSON.parse(readFileSync(join(root, "vendor/pi-patches/source.json"), "utf8"));
const cache = resolve(
  process.env.COTHINK_PI_BUILD_CACHE ?? join(root, "work/pi-agent-build", spec.upstream.tag, "upstream"),
);
const work = dirname(cache),
  out = join(root, "vendor/pi-deps");
mkdirSync(out, { recursive: true });
mkdirSync(work, { recursive: true });
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
function run(command, args, cwd = work) {
  try {
    return execFileSync(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    }).toString();
  } catch (error) {
    throw Error(
      `Build step failed: ${command} ${args.join(" ")}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`,
    );
  }
}
function check(path, expected) {
  if (hash(path) !== expected) throw Error("Source hash mismatch: " + path);
}
const piVersion = spec.upstream.tag.slice(1);
const archive = join(work, `pi-${spec.upstream.tag}.tar.gz`);
if (!existsSync(archive)) run("curl", ["-fL", "--retry", "0", spec.upstream.archiveUrl, "-o", archive]);
check(archive, spec.upstream.archiveSha256);
if (!existsSync(join(cache, "package-lock.json"))) {
  mkdirSync(cache, { recursive: true });
  run("tar", ["-xzf", archive, "-C", cache, "--strip-components=1"]);
}
if (!existsSync(join(cache, "node_modules/.package-lock.json")))
  writeFileSync(
    join(work, "build-source-install.log"),
    run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], cache),
  );
const data = join(cache, "packages/ai/src/providers/data");
if (!existsSync(data)) {
  const packed = JSON.parse(
    run("npm", [
      "pack",
      spec.catalog.package,
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      work,
    ]),
  );
  const path = join(work, packed[0].filename);
  check(path, spec.catalog.sha256);
  const catalog = join(work, "fixed-catalog");
  mkdirSync(catalog, { recursive: true });
  run("tar", ["-xzf", path, "-C", catalog, "--strip-components=1"]);
  cpSync(join(catalog, "dist/providers/data"), data, { recursive: true });
}
const states = Object.entries(spec.patchFiles).map(([file, ids]) => {
  const actual = hash(join(cache, file));
  if (actual !== ids.original && actual !== ids.patched) throw Error("Unexpected source edit: " + file);
  return actual === ids.patched;
});
if (states.every((v) => !v))
  run("patch", ["-p1", "-i", join(root, "vendor/pi-patches/interactive-host.patch")], cache);
else if (!states.every(Boolean))
  throw Error("Partial UI patch state. Use a fresh isolated COTHINK_PI_BUILD_CACHE.");
for (const [file, ids] of Object.entries(spec.patchFiles)) check(join(cache, file), ids.patched);
writeFileSync(join(work, "build-fixed-source.log"), run("npm", ["run", "build:offline"], cache));
const artifacts = [],
  sourceRequire = createRequire(join(cache, "packages/ai/package.json"));
const pack = (target) =>
  JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", out], target))[0];
for (const [name, version, sourceHash] of [
  ["openai", "7.19.0", "d7a153e93818d025cc1ae82bf5f09c89d615dfe7a223474f3e0b7c558af12ab4"],
  ["@anthropic-ai/sdk", "0.129.0", "8624fbfefebcd5613cc430b38e238f4d88f9c97bf7f394016a077d8193a72f6e"],
]) {
  const original = dirname(sourceRequire.resolve(name)),
    pkg = JSON.parse(readFileSync(join(original, "package.json")));
  if (pkg.version !== version) throw Error("Unexpected dependency " + name);
  check(join(original, "src/client.ts"), sourceHash);
  const target = join(cache, "cothink-sdk-build", name.replaceAll("/", "-"));
  rmSync(target, { recursive: true, force: true });
  cpSync(original, target, { recursive: true });
  for (const file of ["src/client.ts", "client.js", "client.mjs"]) {
    const path = join(target, file),
      source = readFileSync(path, "utf8"),
      before = "const timeout = setTimeout(abort, ms);";
    if (source.split(before).length !== 2) throw Error("Timeout patch does not apply uniquely: " + path);
    writeFileSync(
      path,
      source.replace(before, "const timeout = ms === 0 ? undefined : setTimeout(abort, ms);"),
    );
  }
  const packed = pack(target);
  artifacts.push({
    package: name,
    version,
    patch: "timeout-zero",
    sourceSha256: sourceHash,
    path: "vendor/pi-deps/" + packed.filename,
    sha256: hash(join(out, packed.filename)),
    integrity: packed.integrity,
  });
}
const tuiSource = join(cache, "packages/tui"),
  tuiTarget = join(cache, "cothink-tui-build");
rmSync(tuiTarget, { recursive: true, force: true });
mkdirSync(tuiTarget, { recursive: true });
for (const name of ["dist", "native", "README.md"])
  if (existsSync(join(tuiSource, name)))
    cpSync(join(tuiSource, name), join(tuiTarget, name), { recursive: true });
const tuiPkg = JSON.parse(readFileSync(join(tuiSource, "package.json")));
delete tuiPkg.scripts;
tuiPkg.version = piVersion;
tuiPkg.cothinkPatch = "preserve-whitespace-v1";
writeFileSync(join(tuiTarget, "package.json"), JSON.stringify(tuiPkg, null, 2));
cpSync(join(cache, "LICENSE"), join(tuiTarget, "LICENSE"));
tuiPkg.files.push("LICENSE");
writeFileSync(join(tuiTarget, "package.json"), JSON.stringify(tuiPkg, null, 2));
const tuiPack = pack(tuiTarget);
artifacts.push({
  package: tuiPkg.name,
  version: tuiPkg.version,
  path: "vendor/pi-deps/" + tuiPack.filename,
  sha256: hash(join(out, tuiPack.filename)),
  integrity: tuiPack.integrity,
  build: "fixed upstream TypeScript build; preserveWhitespace defaults false",
});
// moduleCache:false must also refresh asynchronous ESM dependencies; preserve Jiti's normal cached mode.
const jitiSpec=spec.jitiPatch;
if(jitiSpec) {
  const resolveJiti=createRequire(join(cache,"packages/coding-agent/package.json"));
  const original=dirname(dirname(resolveJiti.resolve("jiti"))),target=join(cache,"cothink-jiti-build");
  const pkg=JSON.parse(readFileSync(join(original,"package.json")));
  if(pkg.version!==jitiSpec.version)throw Error("Unexpected Jiti version");
  check(join(original,jitiSpec.file),jitiSpec.originalSha256);
  rmSync(target,{recursive:true,force:true});cpSync(original,target,{recursive:true});
  const path=join(target,jitiSpec.file),text=readFileSync(path,"utf8");
  if(text.split(jitiSpec.before).length!==2)throw Error("Jiti patch must match exactly once");
  writeFileSync(path,text.replace(jitiSpec.before,jitiSpec.after));check(path,jitiSpec.patchedSha256);
  pkg.version=jitiSpec.revision;delete pkg.scripts;writeFileSync(join(target,"package.json"),JSON.stringify(pkg,null,2));
  const result=pack(target);
  artifacts.push({package:pkg.name,version:pkg.version,path:"vendor/pi-deps/"+result.filename,sha256:hash(join(out,result.filename)),integrity:result.integrity,build:"Pinned MIT Jiti; one exact moduleCache:false async ESM condition patch",source:jitiSpec});
}
const agentSource = join(cache, "packages/coding-agent"),
  target = join(cache, "cothink-agent-build");
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const name of ["dist", "docs", "examples", "schemas", "containerization.md", "README.md", "CHANGELOG.md"])
  if (existsSync(join(agentSource, name)))
    cpSync(join(agentSource, name), join(target, name), { recursive: true });
cpSync(join(cache, "LICENSE"), join(target, "LICENSE"));
const pkg = JSON.parse(readFileSync(join(agentSource, "package.json")));
delete pkg.scripts;
pkg.version = `${piVersion}-${spec.agentRevision ?? "cothink.1"}`;
if(spec.jitiPatch)pkg.dependencies.jiti=spec.jitiPatch.revision;
pkg.files = pkg.files.filter((p) => p !== "npm-shrinkwrap.json");
pkg.files.push("LICENSE", "README.md");
for (const name of Object.keys(pkg.dependencies))
  if (name.startsWith("@earendil-works/")) pkg.dependencies[name] = piVersion;
writeFileSync(join(target, "package.json"), JSON.stringify(pkg, null, 2));
const packed = pack(target);
artifacts.push({
  package: pkg.name,
  version: pkg.version,
  path: "vendor/pi-deps/" + packed.filename,
  sha256: hash(join(out, packed.filename)),
  integrity: packed.integrity,
  build: "fixed upstream TypeScript full offline build; consumer package-lock pins transitive dependencies",
});
const patches = ["interactive-host.patch", "timeout-zero.patch"].map((path) => ({
  path: "vendor/pi-patches/" + path,
  sha256: hash(join(root, "vendor/pi-patches", path)),
}));
writeFileSync(
  join(root, "vendor/pi-patches/manifest.json"),
  JSON.stringify(
    {
      version: 1,
      piVersion,
      sourceArchiveSha256: spec.upstream.archiveSha256,
      catalogArchiveSha256: spec.catalog.sha256,
      sourceFiles: spec.patchFiles,
      patches,
      artifacts,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify(
    artifacts.map(({ package: p, path, sha256 }) => ({ package: p, path, sha256 })),
    null,
    2,
  ),
);
