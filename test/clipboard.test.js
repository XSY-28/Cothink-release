import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { createClipboardWriter } = await import(process.env.COTHINK_TEST_PACKAGE
  ? pathToFileURL(join(process.env.COTHINK_TEST_PACKAGE,'src/clipboard.js')).href
  : new URL('../src/clipboard.js',import.meta.url).href);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const writer = getClipboard => createClipboardWriter({ getClipboard, platform: 'darwin', env: {} });
const errorIs = code => error => {
  assert.equal(error.code, code);
  assert.ok(!error.message.includes('private'));
  assert.equal(error.cause, undefined);
  return true;
};

test('preserves Unicode, multiline text and whitespace and waits for native completion', async () => {
  const started = deferred(), finished = deferred();
  const text = '  中文 👩🏽‍💻 e\u0301\n第二行  \n';
  const clipboard = { setText(value) {
    assert.equal(this, clipboard);
    assert.equal(value, text);
    started.resolve();
    return finished.promise;
  } };
  let settled = false;
  const result = writer(() => clipboard)(text);
  result.then(() => { settled = true; });
  await started.promise;
  assert.equal(settled, false);
  finished.resolve('ignored native return value');
  assert.equal(await result, undefined);
  assert.equal(settled, true);
});

test('missing or throwing helpers are unavailable without exposing raw errors', async () => {
  for (const getClipboard of [() => undefined, () => null, () => ({}), () => ({ setText: true }),
    () => { throw new Error('private module path'); },
    () => ({ get setText() { throw new Error('private getter'); } })]) {
    await assert.rejects(writer(getClipboard)('private selected text'), errorIs('CLIPBOARD_UNAVAILABLE'));
  }
});

test('synchronous and asynchronous native failures are write errors', async () => {
  for (const setText of [() => { throw new Error('private write'); },
    () => Promise.reject(new Error('private write'))]) {
    await assert.rejects(writer(() => ({ setText }))('private selected text'), errorIs('CLIPBOARD_WRITE'));
  }
});

test('each remote marker refuses before loading the helper', async () => {
  for (const marker of ['SSH_CONNECTION', 'SSH_CLIENT', 'MOSH_CONNECTION']) {
    const copy = createClipboardWriter({ platform: 'darwin', env: { [marker]: 'remote' },
      getClipboard() { assert.fail('must not load remote clipboard'); } });
    await assert.rejects(copy('text'), errorIs('CLIPBOARD_REMOTE'));
  }
});

test('unsupported platforms refuse before loading the helper', async () => {
  for (const platform of ['linux', 'freebsd']) {
    const copy = createClipboardWriter({ platform, env: {},
      getClipboard() { assert.fail('must not load unsupported clipboard'); } });
    await assert.rejects(copy('text'), errorIs('CLIPBOARD_PLATFORM'));
  }
});

test('Windows native clipboard preserves Chinese and multiline text and reports completion', async () => {
  const finished = deferred();
  const text = '中文 👩🏽‍💻\r\n  第二行\n';
  let received, settled = false;
  const copy = createClipboardWriter({ platform: 'win32', env: {},
    getClipboard: () => ({ setText(value) { received = value; return finished.promise; } }) });
  const result = copy(text).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received, text);
  assert.equal(settled, false);
  finished.resolve();
  await result;
  assert.equal(settled, true);
});

test('Windows remote clipboard is refused and missing native components fail visibly', async () => {
  await assert.rejects(createClipboardWriter({ platform: 'win32', env: { SSH_CONNECTION: 'remote' },
    getClipboard() { assert.fail('remote must not load native clipboard'); } })('text'), errorIs('CLIPBOARD_REMOTE'));
  await assert.rejects(createClipboardWriter({ platform: 'win32', env: {}, getClipboard: () => undefined })('text'), errorIs('CLIPBOARD_UNAVAILABLE'));
});

test('A finishes before B starts, with B becoming the final value', async () => {
  const aStarted = deferred(), aFinished = deferred(), bStarted = deferred(), bFinished = deferred();
  const calls = [];
  let value;
  const copy = writer(() => ({ async setText(text) {
    calls.push(text);
    if (text === 'A') { aStarted.resolve(); await aFinished.promise; }
    else { bStarted.resolve(); await bFinished.promise; }
    value = text;
  } }));
  const a = copy('A'), b = copy('B');
  await aStarted.promise;
  assert.deepEqual(calls, ['A']);
  aFinished.resolve();
  await a;
  await bStarted.promise;
  assert.equal(value, 'A');
  bFinished.resolve();
  await b;
  assert.deepEqual(calls, ['A', 'B']);
  assert.equal(value, 'B');
});

test('A rejection preserves its failure and permits queued B', async () => {
  const aStarted = deferred(), aFinished = deferred(), bStarted = deferred(), bFinished = deferred();
  const calls = [];
  const copy = writer(() => ({ async setText(text) {
    calls.push(text);
    if (text === 'A') { aStarted.resolve(); await aFinished.promise; }
    else { bStarted.resolve(); await bFinished.promise; }
  } }));
  const a = copy('A');
  const failed = assert.rejects(a, errorIs('CLIPBOARD_WRITE'));
  const b = copy('B');
  await aStarted.promise;
  assert.deepEqual(calls, ['A']);
  aFinished.reject(new Error('private failure'));
  await failed;
  await bStarted.promise;
  assert.deepEqual(calls, ['A', 'B']);
  bFinished.resolve();
  await b;
});
