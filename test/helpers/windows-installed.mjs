import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const root = resolve(process.argv[2]);
const req = createRequire(join(root, 'package.json'));
const { getNativeClipboard } = await import(pathToFileURL(req.resolve('@earendil-works/pi-tui')));
const native = getNativeClipboard();
assert.equal(typeof native?.setText, 'function');
assert.equal(typeof native?.enableVirtualTerminalInput, 'function');
const { createClipboardWriter } = await import(pathToFileURL(join(root, 'src/clipboard.js')));
// This runs only on the disposable Windows CI desktop and replaces its clipboard.
const text = 'CoThink 中文 👩🏽‍💻\n  第二行  ';
await createClipboardWriter()(text);
assert.equal(await native.getText(), text);
console.log(JSON.stringify({ version: JSON.parse(readFileSync(join(root, 'package.json'))).version,
  platform: process.platform, arch: process.arch, nativeClipboardRoundTrip: true }));
