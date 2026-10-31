import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const patch = JSON.parse(readFileSync(new URL("../vendor/pi-patches/pi-subagents-0.84.0-foreground-unlimited-v1.json", import.meta.url), "utf8"));
const previous = JSON.parse(readFileSync(new URL("../vendor/pi-patches/pi-subagents-0.84.0-foreground-unlimited-v1.base.json", import.meta.url), "utf8"));
export const pluginCompatibilityRevision = patch.revision;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (message) => { throw Object.assign(new Error(message), { code: "PLUGIN_COMPATIBILITY" }); };

/** Version-specific candidate transform, never an import-time mutation or category allowlist. */
export function preparePluginCompatibility(agentDir) {
  const root = join(agentDir, "npm/node_modules", patch.package);
  if (!existsSync(join(root, "package.json"))) return;
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (manifest.version !== patch.version) return;
  const lock = JSON.parse(readFileSync(join(agentDir, "npm/package-lock.json"), "utf8"));
  const identity = Object.entries(lock.packages).find(([path]) => /(^|\/)pi-subagents$/.test(path))?.[1];
  if (identity?.integrity !== patch.integrity) fail("pi-subagents 0.84.0 upstream integrity differs; candidate preserved");
  const provenancePath = join(root, 'cothink-compatibility.json');
  const saved = existsSync(provenancePath) ? JSON.parse(readFileSync(provenancePath, 'utf8')) : null;
  const migratePrevious = saved?.revision === previous.revision;
  if (migratePrevious) {
    const expected = {package:previous.package, version:previous.version, revision:previous.revision, upstreamIntegrity:previous.integrity,
      files:previous.files.map(({path,before,after})=>({path,upstreamSha256:before,patchedSha256:after}))};
    if (JSON.stringify(saved) !== JSON.stringify(expected)) fail('pi-subagents previous compatibility provenance differs');
    for (const file of previous.files)
      if (digest(readFileSync(join(root,file.path))) !== file.after) fail('pi-subagents previous patched artifact differs: ' + file.path);
  }
  const transformed = patch.files.map((file) => {
    const path = join(root, file.path);
    if (file.before === null) {
      const bytes = readFileSync(new URL('../vendor/pi-patches/' + file.source, import.meta.url));
      if (digest(bytes) !== file.after) fail('pi-subagents host integration source differs: ' + file.path);
      if (existsSync(path) && digest(readFileSync(path)) !== file.after) fail('pi-subagents added artifact differs: ' + file.path);
      return { file, bytes };
    }
    const bytes = readFileSync(path), hash = digest(bytes);
    if (hash === file.after) return { file, bytes };
    let text = bytes.toString("utf8");
    const prior = migratePrevious && previous.files.find(prior=>prior.path===file.path);
    if (prior && hash === prior.after) {
      for (const [before,after] of prior.replacements.toReversed()) {
        if (text.split(after).length !== 2) fail('pi-subagents previous compatibility reverse match differs: ' + file.path);
        text = text.replace(after,before);
      }
    }
    if (digest(text) !== file.before) fail("pi-subagents compatibility preimage differs: " + file.path);
    for (const [before, after] of file.replacements) {
      if (text.split(before).length !== 2) fail("pi-subagents compatibility match is ambiguous: " + file.path);
      text = text.replace(before, after);
    }
    if (digest(text) !== file.after) fail("pi-subagents compatibility postimage differs: " + file.path);
    return { file, bytes: Buffer.from(text) };
  });
  for (const { file, bytes } of transformed) writeFileSync(join(root, file.path), bytes);
  writeFileSync(join(root, "cothink-compatibility.json"), JSON.stringify({
    package: patch.package, version: patch.version, revision: patch.revision,
    upstreamIntegrity: patch.integrity,
    files: patch.files.map(({ path, before, after }) => ({ path, upstreamSha256: before, patchedSha256: after })),
  }, null, 2) + "\n");
}

export function inspectPluginCompatibility(root) {
  const path = join(root, "cothink-compatibility.json");
  if (!existsSync(path)) return null;
  const saved = JSON.parse(readFileSync(path, "utf8"));
  if (saved.package !== patch.package || saved.version !== patch.version || saved.revision !== patch.revision || saved.upstreamIntegrity !== patch.integrity)
    fail("pi-subagents compatibility provenance differs");
  for (const file of patch.files)
    if (digest(readFileSync(join(root, file.path))) !== file.after)
      fail("pi-subagents patched artifact differs: " + file.path);
  return saved;
}
