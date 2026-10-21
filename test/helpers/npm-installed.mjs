// Verify the installed dependency tree, not the source checkout's dependencies.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
const root = resolve(process.argv[2]);
const pkg = JSON.parse(readFileSync(join(root, 'package.json')));
assert.equal(pkg.version, process.env.COTHINK_EXPECT_VERSION ?? '0.6.0-windows.2');
assert.equal(pkg.overrides, undefined);
const requireAgent = createRequire(join(root, 'node_modules/@earendil-works/pi-coding-agent/package.json'));
const esbuild = requireAgent('esbuild');
assert.match(esbuild.transformSync('const value: number = 1', { loader: 'ts' }).code, /const value = 1/);
const sdk = JSON.parse(readFileSync(join(root, 'node_modules/@earendil-works/pi-coding-agent/package.json')));
assert.equal(sdk.version, '1.0.0-cothink.9');
for (const name of ['openai', '@anthropic-ai/sdk']) {
  const requireRoot = createRequire(join(root, 'package.json'));
  const client = join(dirname(requireRoot.resolve(name)), 'client.js');
  assert.match(readFileSync(client, 'utf8'), /ms === 0 \? undefined : setTimeout\(abort, ms\)/);
}
console.log(JSON.stringify({ version: pkg.version, platform: process.platform, arch: process.arch,
  nativeEsbuild: true, patchedSDKs: true }));
