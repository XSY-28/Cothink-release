import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import tty from 'node:tty';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { openTerminal } from '../src/terminal.js';
import { listPackages, runPackageCommand } from '../src/packages.js';
import { fixture } from './helpers/pi-fixture.js';
import { managed } from './helpers/agent-sync-fixture.js';
import { getNativeClipboard } from '@earendil-works/pi-tui';
import { atomic } from '../packages/agent-sync/src/storage.js';
import { entries, assertProjection, scan } from '../packages/agent-sync/src/git.js';
import { repository, git } from './helpers/git-fixture.js';
import * as executor from '../packages/agent-sync/src/executor.js';
import { tmpdir } from 'node:os';
import { writePrivateJson } from '../src/storage.js';
import { runTurn } from '../src/discussion.js';
const realWait = Atomics.wait;

function recordFile(t) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'cothink-record-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dest = path.join(dir, 'request.json');
  fs.writeFileSync(dest, JSON.stringify({ text: 'old saved answer' }));
  return { dir, dest };
}

function renameBoundary(t, handler, platform = 'win32') {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const rename = fs.renameSync, waits = [];
  Object.defineProperty(process, 'platform', { value: platform });
  t.mock.method(fs, 'renameSync', (from, to) => handler(rename, from, to));
  t.mock.method(Atomics, 'wait', (array, index, value, delay) => {
    waits.push(delay);
    return realWait(array, index, value, delay);
  });
  syncBuiltinESMExports();
  t.after(() => { Object.defineProperty(process, 'platform', descriptor); t.mock.restoreAll(); syncBuiltinESMExports(); });
  return waits;
}

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`Windows record replacement tolerates temporary ${code} without rewriting or deleting the old record`, t => {
    const { dir, dest } = recordFile(t), sources = [], old = fs.readFileSync(dest, 'utf8');
    let attempts = 0, guards = 0;
    const waits = renameBoundary(t, (rename, from, to) => {
      assert.equal(fs.readFileSync(dest, 'utf8'), old);
      sources.push(from);
      if (++attempts <= 2) throw Object.assign(Error('sharing violation'), { code });
      return rename(from, to);
    });
    writePrivateJson(dest, { text: '完整新回答' }, () => guards++);
    assert.equal(attempts, 3);
    assert.equal(guards, 3, 'ownership is checked again after each wait');
    assert.equal(new Set(sources).size, 1, 'the same flushed candidate is retried');
    assert.deepEqual(waits, [10, 20]);
    assert.deepEqual(JSON.parse(fs.readFileSync(dest)), { text: '完整新回答' });
    assert.deepEqual(fs.readdirSync(dir), ['request.json']);
  });
}

test('persistent Windows record denial stays bounded, preserves old bytes and reports the original error', t => {
  const { dir, dest } = recordFile(t), old = fs.readFileSync(dest);
  const denied = Object.assign(Error('persistent sharing violation'), { code: 'EPERM' });
  let attempts = 0;
  const waits = renameBoundary(t, () => { attempts++; throw denied; });
  assert.throws(() => writePrivateJson(dest, { text: 'not published' }), e => e === denied);
  assert.ok(attempts > 1 && attempts <= 9);
  assert.ok(waits.reduce((sum, n) => sum + n, 0) <= 1100);
  assert.deepEqual(fs.readFileSync(dest), old);
  assert.deepEqual(fs.readdirSync(dir), ['request.json']);
});

for (const [platform, code] of [['darwin', 'EPERM'], ['win32', 'EIO'], ['win32', 'ENOSPC'], ['win32', 'ENOENT']]) {
  test(`record replacement does not retry ${code} on ${platform}`, t => {
    const { dest } = recordFile(t);
    let attempts = 0;
    const waits = renameBoundary(t, () => { attempts++; throw Object.assign(Error('write denied'), { code }); }, platform);
    assert.throws(() => writePrivateJson(dest, { value: 2 }), { code });
    assert.equal(attempts, 1);
    assert.deepEqual(waits, []);
    assert.equal(JSON.parse(fs.readFileSync(dest)).text, 'old saved answer');
  });
}

test('lost ownership during a Windows rename wait prevents another publication attempt', t => {
  const { dest } = recordFile(t);
  let attempts = 0, guards = 0;
  renameBoundary(t, () => { attempts++; throw Object.assign(Error('sharing'), { code: 'EPERM' }); });
  assert.throws(() => writePrivateJson(dest, { value: 2 }, () => {
    if (++guards === 2) throw Object.assign(Error('writer no longer owns session'), { code: 'STALE_WRITER' });
  }), { code: 'STALE_WRITER' });
  assert.equal(attempts, 1);
  assert.equal(JSON.parse(fs.readFileSync(dest)).text, 'old saved answer');
});

test('a transient Windows review-record rename failure completes the same three model calls', async t => {
  const text = '完整长回答\n'.repeat(2500);
  const f = await fixture(t, () => ({ text }));
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const rename = fs.renameSync;
  let injected = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.dirname(to) === path.join(f.home, 'requests')) {
      const saved = JSON.parse(fs.readFileSync(from, 'utf8'));
      if (saved.phase === 'review' && saved.sent && saved.events.length && injected < 2) {
        injected++;
        Object.defineProperty(process, 'platform', { value: 'win32' });
        throw Object.assign(Error('Windows request snapshot sharing violation'), { code: 'EPERM' });
      }
    }
    const result = rename(from, to);
    Object.defineProperty(process, 'platform', descriptor);
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => { Object.defineProperty(process, 'platform', descriptor); t.mock.restoreAll(); syncBuiltinESMExports(); });
  const task = await runTurn({ home: f.home, cwd: f.cwd, input: 'question', config: { formatVersion: 2, ...f.models } });
  assert.equal(injected, 2);
  assert.equal(task.record.status, 'completed', task.record.error);
  assert.equal(f.calls.length, 3, 'only the filesystem rename is repeated');
  assert.deepEqual(task.requests().map(c => c.text), [text, text, text]);
});

for (const holdMs of [400, 3000]) {
  test(`real Windows file sharing lock (${holdMs}ms) preserves atomic record publication`,
    { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
      t.diagnostic(JSON.stringify({ parentPlatform: process.platform,
        parentRenameMocked: Boolean(fs.renameSync.mock), parentWaitMocked: Boolean(Atomics.wait.mock) }));
      const helper = new URL('./helpers/windows-record-lock.mjs', import.meta.url);
      const { fileURLToPath } = await import('node:url');
      const stdout = await new Promise((resolve, reject) => {
        childProcess.execFile(process.execPath, [fileURLToPath(helper), String(holdMs)],
          { env: process.env, timeout: 14000 }, (error, stdout, stderr) =>
            error ? reject(Error(stderr || stdout || error.message)) : resolve(stdout));
      });
      const result = JSON.parse(stdout);
      assert.equal(result.platform, 'win32');
      assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(result.lockError));
      assert.equal(result.updated, holdMs === 400);
      assert.equal(result.oldBytesPreserved, holdMs === 3000);
      t.diagnostic(stdout.trim());
    });
}

test('Windows installed native helper loads without modifying clipboard contents', { skip: process.platform !== 'win32' }, () => {
  const native = getNativeClipboard();
  assert.equal(typeof native?.setText, 'function');
  assert.equal(typeof native?.enableVirtualTerminalInput, 'function');
});

test('Windows metadata publication syncs the file without opening an unsupported directory handle', async t => {
  const f = await fixture(t), dest = path.join(f.home, 'metadata.json');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (name, ...args) => {
    if (fs.existsSync(name) && fs.statSync(name).isDirectory())
      throw Object.assign(Error('Windows directory handle'), { code: 'EPERM' });
    return open(name, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { Object.defineProperty(process, 'platform', platform); t.mock.restoreAll(); syncBuiltinESMExports(); });
  Object.defineProperty(process, 'platform', { value: 'win32' });
  atomic(dest, { version: 1 });
  atomic(dest, { version: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(dest)), { version: 2 });
});

test('Windows projections retain executable Git modes while still rejecting changed bytes', async t => {
  const f = repository(t);
  git(f.project, 'status', '--porcelain');
  git(f.project, 'update-index', '--chmod=+x', 'a.txt');
  git(f.project, 'commit', '-m', 'fixture executable');
  const map = await entries(f.project, 'HEAD');
  const projection = path.join(f.root, 'projection');
  fs.mkdirSync(projection);
  for (const name of map.keys()) fs.copyFileSync(path.join(f.project, name), path.join(projection, name));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  t.after(() => Object.defineProperty(process, 'platform', platform));
  Object.defineProperty(process, 'platform', { value: 'win32' });
  await assertProjection(f.project, map, projection);
  assert.equal(scan(projection, { modes: map }).map.get('a.txt').mode, '100755');
  fs.writeFileSync(path.join(projection, 'a.txt'), 'unmanaged');
  await assert.rejects(assertProjection(f.project, map, projection), { code: 'UNMANAGED_WRITE' });
});

test('Docker accepts local Windows named pipes but refuses remote or malformed endpoints', () => {
  assert.equal(typeof executor.localDockerSocket, 'function');
  assert.equal(executor.localDockerSocket('npipe:////./pipe/dockerDesktopLinuxEngine', 'win32'), '\\\\.\\pipe\\dockerDesktopLinuxEngine');
  assert.equal(executor.localDockerSocket('unix:///var/run/docker.sock', 'darwin'), '/var/run/docker.sock');
  for (const host of ['tcp://127.0.0.1:2375', 'npipe:////remote/pipe/docker', 'npipe:////./pipe/../outside', 'unix://remote/socket'])
    assert.throws(() => executor.localDockerSocket(host, 'win32'), { code: 'EXECUTOR_UNAVAILABLE' });
});

// Only the OS console boundary is substituted; the product owns FD selection/cleanup.
function consoleFixture(t, { failOutput = false } = {}) {
  const opened = [], closed = [], destroyed = [];
  t.mock.method(fs, 'openSync', (name, flags) => {
    opened.push([name, flags]);
    return opened.length + 40;
  });
  t.mock.method(fs, 'closeSync', fd => closed.push(fd));
  t.mock.method(tty, 'ReadStream', function (fd) {
    return { isTTY: true, destroy() { destroyed.push(fd); } };
  });
  t.mock.method(tty, 'WriteStream', function (fd) {
    if (failOutput) throw Error('fixture console unavailable');
    return { isTTY: true, destroy() { destroyed.push(fd); } };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { opened, closed, destroyed };
}

test('Windows pipe setup opens a read/write console without consuming stdin; close is idempotent', t => {
  const f = consoleFixture(t);
  const terminal = openTerminal({ platform: 'win32', env: {}, stdin: {}, stderr: {} });
  assert.deepEqual(f.opened, [['\\\\?\\GLOBALROOT\\Device\\ConDrv\\CurrentIn', 'r+'], ['\\\\?\\GLOBALROOT\\Device\\ConDrv\\CurrentOut', 'r+']]);
  assert.ok(terminal);
  terminal.close(); terminal.close();
  assert.deepEqual(f.destroyed, [41, 42]);
  assert.deepEqual(f.closed, []);
});

test('console construction failure releases both the owned stream and unopened stream FD', t => {
  const f = consoleFixture(t, { failOutput: true });
  assert.equal(openTerminal({ platform: 'win32', env: {}, stdin: {}, stderr: {} }), null);
  assert.deepEqual(f.destroyed, [41]);
  assert.deepEqual(f.closed, [42]);
});

test('headless mode never opens a console; direct terminal streams are borrowed', t => {
  const f = consoleFixture(t);
  assert.equal(openTerminal({ platform: 'win32', env: { COTHINK_NO_TTY: '1' }, stdin: {}, stderr: {} }), null);
  const input = { isTTY: true }, output = { isTTY: true };
  const terminal = openTerminal({ platform: 'win32', env: {}, stdin: input, stderr: output });
  assert.equal(terminal.input, input);
  assert.equal(terminal.output, output);
  terminal.close();
  assert.deepEqual(f.opened, []);
});

test('Windows relative paths cannot let package resources escape their installed root', async t => {
  const f = await fixture(t);
  const root = path.join(f.home, 'pi', 'npm', 'node_modules', 'fixture-package');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture-package', version: '1.0.0', pi: { skills: ['../outside'] } }));
  fs.writeFileSync(path.join(f.home, 'pi', 'settings.json'), JSON.stringify({ packages: ['npm:fixture-package@1.0.0'] }));
  const relative = path.relative;
  t.mock.method(path, 'relative', (...args) => relative(...args).replaceAll('/', '\\'));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await listPackages({ home: f.home });
  assert.equal(result[0].status, 'broken');
  assert.equal(result[0].code, 'PACKAGE_RESOURCE_ESCAPE');
});

test('Windows workspace child paths reach the kernel as portable paths and .git stays blocked', async t => {
  const f = await managed(t, { scope: ['dir/a.txt'] });
  const relative = path.relative;
  t.mock.method(path, 'relative', (...args) => relative(...args).replaceAll('/', '\\'));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await f.call('write', 'windows-child', { path: 'dir/a.txt', content: '中文\n' });
  const read = await f.v.read({ changeId: f.binding.current.changeId, path: 'dir/a.txt' });
  assert.equal(Buffer.from(read.contentBase64, 'base64').toString(), '中文\n');
  await assert.rejects(f.call('read', 'windows-git', { path: '.git/config' }), { code: 'WORKSPACE_ESCAPE' });
});

test('Windows package cancellation terminates the process tree, and termination failure is not reported as cancelled', async t => {
  const f = await fixture(t);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  t.after(() => { Object.defineProperty(process, 'platform', platform); t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (const mode of ['success', 'close', 'error', 'throw', 'no-close']) {
    const fails = mode !== 'success';
    const controller = new AbortController(), calls = [];
    const child = new EventEmitter();
    child.pid = 424242;
    child.unref = () => {};
    child.kill = () => {
      if (mode === 'throw') throw Object.assign(Error('kill denied'), { code: 'EPERM' });
      if (mode === 'error') { setImmediate(() => child.emit('error', Object.assign(Error('kill denied'), { code: 'EPERM' }))); return false; }
      if (mode === 'no-close') return false;
      setImmediate(() => child.emit('close', null)); return true;
    };
    t.mock.method(childProcess, 'spawn', () => child);
    t.mock.method(childProcess, 'execFileSync', (command, args) => {
      calls.push({ command, args });
      if (fails) throw Object.assign(Error('fixture taskkill denied'), { status: 1 });
      setImmediate(() => child.emit('close', null));
      return Buffer.alloc(0);
    });
    syncBuiltinESMExports();
    const result = await runPackageCommand({ home: f.home, cwd: f.cwd, command: 'install',
      source: 'npm:fixture-package@1.0.0', signal: controller.signal,
      onProgress(event) { if (event.type === 'start') { Object.defineProperty(process, 'platform', { value: 'win32' }); controller.abort(); } },
    });
    Object.defineProperty(process, 'platform', platform);
    assert.equal(calls.length, 1);
    assert.match(calls[0].command, /taskkill\.exe$/);
    assert.deepEqual(calls[0].args, ['/F', '/T', '/PID', '424242']);
    assert.equal(result.result.error.code, fails ? 'PACKAGE_CANCEL_UNKNOWN' : 'PACKAGE_CANCELLED');
    if (fails) assert.equal(JSON.parse(fs.readFileSync(path.join(result.result.recoveryPath, 'cancellation.json'))).outcome, 'unknown');
    assert.equal(fs.existsSync(path.join(f.home, 'pi', 'npm')), false);
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
});
