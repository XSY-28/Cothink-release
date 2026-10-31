// Verify the installed dependency tree, not the source checkout's dependencies.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
const root = resolve(process.argv[2]);
const pkg = JSON.parse(readFileSync(join(root, 'package.json')));
const expectedVersion = process.env.COTHINK_EXPECT_VERSION ??
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).version;
assert.equal(pkg.version, expectedVersion);
assert.equal(pkg.overrides, undefined);
const requireAgent = createRequire(join(root, 'node_modules/@earendil-works/pi-coding-agent/package.json'));
const probe = mkdtempSync(join(tmpdir(), 'cothink-installed-ts-'));
try {
  const file = join(probe, 'extension.ts');
  writeFileSync(file, 'export enum Probe { Value = 1 }');
  const jiti = requireAgent('jiti').createJiti(join(root, 'package.json'), {
    fsCache: false, moduleCache: false,
  });
  assert.equal((await jiti.import(file)).Probe.Value, 1);
} finally {
  rmSync(probe, { recursive: true, force: true });
}
const sdk = JSON.parse(readFileSync(join(root, 'node_modules/@earendil-works/pi-coding-agent/package.json')));
assert.equal(sdk.version, '1.4.0-cothink.1');
for (const name of ['openai', '@anthropic-ai/sdk']) {
  const requireRoot = createRequire(join(root, 'package.json'));
  const client = join(dirname(requireRoot.resolve(name)), 'client.js');
  assert.match(readFileSync(client, 'utf8'), /ms === 0 \? undefined : setTimeout\(abort, ms\)/);
}
console.log(JSON.stringify({ version: pkg.version, platform: process.platform, arch: process.arch,
  typescriptLoader: true, patchedSDKs: true }));
