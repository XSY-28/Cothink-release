// Run the real OS boundary in a fresh process, independent of test-runner fs/platform mocks.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const { writePrivateJson } = await import(process.env.COTHINK_TEST_CLI
  ? pathToFileURL(resolve(dirname(process.env.COTHINK_TEST_CLI), '../src/storage.js')).href
  : new URL('../../src/storage.js', import.meta.url).href);
assert.equal(process.platform, 'win32');
const holdMs = Number(process.argv[2]);
assert.ok([400, 3000].includes(holdMs));
const dir = fs.mkdtempSync(join(tmpdir(), 'cothink-native-record-'));
const dest = join(dir, '中文 request.json');
fs.writeFileSync(dest, JSON.stringify({ text: 'old saved answer' }));
const script = "$s=[IO.File]::Open($env:COTHINK_TEST_LOCK_PATH,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); [Console]::WriteLine('LOCKED'); Start-Sleep -Milliseconds ([int]$env:COTHINK_TEST_LOCK_MS); $s.Dispose(); [Console]::WriteLine('RELEASED')";
const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
  env: { ...process.env, COTHINK_TEST_LOCK_PATH: dest, COTHINK_TEST_LOCK_MS: String(holdMs) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '', stderr = '', lockError;
const closed = new Promise(resolve => child.once('close', resolve));
child.stderr.on('data', d => stderr += d);
try {
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', d => { stdout += d; if (stdout.includes('LOCKED')) resolve(); });
    child.once('close', () => { if (!stdout.includes('LOCKED')) reject(Error(stderr || 'locker exited before ready')); });
  });
  assert.throws(() => fs.renameSync(dest, dest + '.probe'), e => {
    lockError = e.code;
    return ['EPERM', 'EACCES', 'EBUSY'].includes(e.code);
  }, 'the actual OS must reject rename while the lock is held');
  const started = performance.now();
  if (holdMs === 400) writePrivateJson(dest, { text: '完整新回答' });
  else assert.throws(() => writePrivateJson(dest, { text: 'not published' }), e => ['EPERM', 'EACCES', 'EBUSY'].includes(e.code));
  const operationMs = performance.now() - started;
  const text = JSON.parse(fs.readFileSync(dest)).text;
  assert.equal(text, holdMs === 400 ? '完整新回答' : 'old saved answer');
  assert.deepEqual(fs.readdirSync(dir), ['中文 request.json']);
  console.log(JSON.stringify({ platform: process.platform, holdMs, lockError,
    operationMs, updated: holdMs === 400, oldBytesPreserved: holdMs === 3000 }));
} finally {
  child.kill();
  await closed;
  fs.rmSync(dir, { recursive: true, force: true });
}
