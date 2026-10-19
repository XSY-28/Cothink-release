import { THINKING_LEVELS } from './thinking.js';
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync, readdirSync, chmodSync, unlinkSync, realpathSync, statSync, linkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

const validId = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
const problem = (code, message) => Object.assign(new Error(message), { code });
function checkId(id) { if (!validId(id)) throw problem('INVALID_ID', '无效的运行或会话 ID。请查看历史列表。'); }

/** Replace credential values, including credentials echoed in a provider response. */
export function redact(value, secrets) {
  if (typeof value === 'string') {
    for (const secret of secrets.filter(Boolean)) value = value.replaceAll(secret, '[REDACTED]');
    return value;
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, secrets)]));
  return value;
}

/** A single atomic snapshot keeps earlier replies readable if the process dies. */
export function writePrivateJson(path, value, beforeCommit = () => {}) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    beforeCommit();
    renameSync(tmp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function readUiState(home) {
  let state;
  try { state = JSON.parse(readFileSync(join(home, 'ui-state.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { shownReleaseVersions: [] }; throw error; }
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      !Array.isArray(state.shownReleaseVersions) || state.shownReleaseVersions.some(v => typeof v !== 'string'))
    throw Error('更新摘要显示状态损坏，原文件已保留。');
  return state;
}

export function releaseNotesSeen(home, version) {
  return readUiState(home).shownReleaseVersions.includes(version);
}

export function markReleaseNotesSeen(home, version) {
  const state = readUiState(home);
  if (state.shownReleaseVersions.includes(version)) return;
  privateDirectory(home);
  writePrivateJson(join(home, 'ui-state.json'), {
    ...state, shownReleaseVersions: [...state.shownReleaseVersions, version],
  });
}

export function saveRun(home, run, secrets = [], beforeCommit = () => {}) {
  checkId(run.id);
  validateRunThinking(run);
  beforeCommit();
  privateDirectory(home);
  privateDirectory(join(home, 'runs'));
  writePrivateJson(join(home, 'runs', `${run.id}.json`), redact(run, secrets), beforeCommit);
}

export function readRun(home, id) {
  checkId(id);
  const run = JSON.parse(readFileSync(join(home, 'runs', `${id}.json`), 'utf8'));
  validateRunThinking(run);
  // A running process may still own this snapshot. Never declare a lost request failed or replay it.
  if (run.status === 'running') {
    run.status = 'outcome_unknown';
    run.error = '此记录尚未终结，进程可能仍在运行或已意外中断；远端结果未知，不自动重发。';
    for (const stage of run.stages) if (stage.status === 'in_flight') stage.status = 'outcome_unknown';
  }
  return run;
}

/** Only existing directories have a stable identity; missing paths are rejected. */
export function normalizeCwd(cwd) {
  let path;
  try { path = realpathSync(resolve(cwd)); } catch (error) { throw problem('INVALID_CWD', `会话目录不存在或无法读取：${cwd} (${error.code})`); }
  if (!statSync(path).isDirectory()) throw problem('INVALID_CWD', `会话目录不是目录：${cwd}`);
  return path;
}

function validateRunThinking(run) {
  if (!Object.hasOwn(run, 'thinkingLevel')) return; // Historic facts are not inferred.
  if (run.thinkingLevel !== null && !THINKING_LEVELS.includes(run.thinkingLevel)) throw problem('SESSION_CORRUPT', `运行 ${run.id} 的思考档位损坏；原文件保留。`);
  if (!Array.isArray(run.stages)) throw problem('SESSION_CORRUPT', `运行 ${run.id} 的思考请求记录损坏。`);
  for (const stage of run.stages) {
    const body = stage?.request?.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || (run.thinkingLevel === null ? Object.hasOwn(body, 'reasoning_effort') : body.reasoning_effort !== run.thinkingLevel)) throw problem('SESSION_CORRUPT', `运行 ${run.id} 的思考档位与请求不一致；原文件保留。`);
  }
}

function validateSession(value, id) {
  if (!value || value.id !== id || !validId(value.id) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.cwd !== 'string' || !value.cwd.startsWith('/')) throw problem('SESSION_CORRUPT', `会话 ${id} 信息损坏；原文件保留。`);
  if (typeof value.title !== 'string' || !value.title.trim()) throw problem('SESSION_CORRUPT', `会话 ${id} 标题为空或损坏；原文件保留。`);
  if (Object.hasOwn(value, 'thinkingLevel') && !THINKING_LEVELS.includes(value.thinkingLevel)) throw problem('SESSION_CORRUPT', `会话 ${id} 的思考档位损坏；原文件保留。`);
  return { id: value.id, createdAt: value.createdAt, cwd: value.cwd, title: value.title, ...(Object.hasOwn(value, 'thinkingLevel') ? { thinkingLevel: value.thinkingLevel } : {}) };
}

export function saveSession(home, metadata, beforeCommit = () => {}) {
  checkId(metadata.id);
  const value = validateSession({ ...metadata, cwd: normalizeCwd(metadata.cwd) }, metadata.id);
  beforeCommit(); privateDirectory(home); privateDirectory(join(home, 'sessions'));
  writePrivateJson(join(home, 'sessions', `${value.id}.json`), value, beforeCommit);
}

export function readSession(home, sessionId) {
  checkId(sessionId);
  let value;
  try { value = JSON.parse(readFileSync(join(home, 'sessions', `${sessionId}.json`), 'utf8')); }
  catch (error) { throw problem('SESSION_CORRUPT', `会话 ${sessionId} 信息缺失或损坏 (${error.code ?? 'JSON'})；原文件保留。`); }
  return validateSession(value, sessionId);
}

function scanRuns(home) {
  let names;
  try { names = readdirSync(join(home, 'runs')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.filter(name => name.endsWith('.json')).map(name => {
    let value;
    try { value = JSON.parse(readFileSync(join(home, 'runs', name), 'utf8')); }
    catch { throw problem('SESSION_CORRUPT', `运行 ${name} 损坏，无法判定会话归属；禁止构造不完整历史，原文件保留。`); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || !validId(value.id) || `${value.id}.json` !== name) throw problem('SESSION_CORRUPT', `运行 ${name} 损坏，无法可信判定归属；原文件保留。`);
    // A detached latest turn produces no detectable gap after filtering. Treat
    // either ownership field as evidence of a session Run, requiring both.
    if ((Object.hasOwn(value, 'sessionId') || Object.hasOwn(value, 'turnIndex')) && (!validId(value.sessionId) || !Number.isSafeInteger(value.turnIndex) || value.turnIndex < 1)) throw problem('SESSION_CORRUPT', `运行 ${name} 的会话归属与轮序不完整或无效；禁止构造不完整历史，原文件保留。`);
    return value;
  });
}

function sessionRuns(values, sessionId) {
  const runs = values.filter(run => run.sessionId === sessionId).sort((a, b) => a.turnIndex - b.turnIndex);
  const turns = new Set();
  for (const [index, run] of runs.entries()) {
    validateRunThinking(run);
    if (!Number.isSafeInteger(run.turnIndex) || run.turnIndex < 1 || typeof run.question !== 'string' || !run.question.trim() || !['running', 'completed', 'cancelled', 'partial', 'failed', 'outcome_unknown'].includes(run.status) || !Array.isArray(run.stages) || typeof run.createdAt !== 'string' || !Number.isFinite(Date.parse(run.createdAt))) throw problem('SESSION_CORRUPT', `会话 ${sessionId} 的运行 ${run.id} 损坏；原文件保留。`);
    if (turns.has(run.turnIndex)) throw problem('SESSION_CORRUPT', `会话 ${sessionId} 有重复轮序 ${run.turnIndex}；禁止继续。`);
    turns.add(run.turnIndex);
    if (run.turnIndex !== index + 1) throw problem('SESSION_CORRUPT', `会话 ${sessionId} 缺少第 ${index + 1} 轮；禁止继续。`);
    const names = ['draft', 'review', 'revision'];
    if (run.status === 'completed' && (run.stages.length !== 3 || run.stages.some((stage, index) => stage?.name !== names[index] || stage.status !== 'completed'))) throw problem('SESSION_CORRUPT', `会话 ${sessionId} 的完整运行 ${run.id} 缺少正确的三阶段回复；原文件保留。`);
    // Every saved Run is a prefix of the sole discussion path, including failures.
    // Never coerce malformed text into history or skip a missing intermediate reply.
    if (run.stages.length > 3 || run.stages.some((stage, index) =>
      !stage || typeof stage !== 'object' || Array.isArray(stage) ||
      stage.name !== names[index] || stage.role !== (index === 1 ? 'reviewer' : 'main') ||
      !['in_flight', 'completed', 'cancelled', 'partial', 'failed', 'outcome_unknown'].includes(stage.status) ||
      (index < run.stages.length - 1 && stage.status !== 'completed') ||
      (stage.response != null && (typeof stage.response !== 'object' || Array.isArray(stage.response) || typeof stage.response.text !== 'string')) ||
      (stage.status === 'completed' && (typeof stage.response?.text !== 'string' || !stage.response.text.trim()))
    )) throw problem('SESSION_CORRUPT', `会话 ${sessionId} 的运行 ${run.id} 阶段顺序、身份、状态或回复文本损坏；原文件保留。`);
    if (run.status === 'running') {
      run.status = 'outcome_unknown';
      run.error = '此轮尚未终结；远端结果未知，不自动重发。';
    }
    for (const stage of run.stages) {
      if (stage.status === 'in_flight') stage.status = 'outcome_unknown';
    }
  }
  return runs;
}

export function readSessionRuns(home, sessionId) {
  readSession(home, sessionId);
  return sessionRuns(scanRuns(home), sessionId);
}

export function listSessions(home, { cwd, all = false } = {}) {
  const directory = all ? undefined : normalizeCwd(cwd ?? process.cwd());
  let names;
  try { names = readdirSync(join(home, 'sessions')); } catch (error) { if (error.code === 'ENOENT') names = []; else throw error; }
  const values = scanRuns(home);
  const ids = new Set([...names.filter(n => n.endsWith('.json')).map(n => n.slice(0, -5)), ...values.map(r => r.sessionId).filter(Boolean)]);
  const sessions = [];
  for (const id of ids) {
    const metadata = readSession(home, id);
    if (!all && metadata.cwd !== directory) continue;
    const runs = sessionRuns(values, id);
    if (!runs.length) continue;
    const dates = runs.flatMap(run => [run.createdAt, run.endedAt, ...run.stages.flatMap(stage => [stage.startedAt, stage.endedAt])]).filter(date => typeof date === 'string' && Number.isFinite(Date.parse(date)));
    sessions.push({ ...metadata, turnCount: runs.length, updatedAt: dates.reduce((a, b) => Date.parse(a) > Date.parse(b) ? a : b), status: runs.at(-1).status });
  }
  return sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
}

/** Local trusted filesystem only. Claims never expire and never delete a successor.
 * Atomic hard-link publication avoids half-written owners. A dead owner's next
 * generation is a create-if-absent election, avoiding stale-lock unlink races.
 */
export function acquireSessionWriter(home, sessionId, onLost = () => {}) {
  checkId(sessionId);
  privateDirectory(home); privateDirectory(join(home, 'sessions'));
  const directory = join(home, 'sessions', `${sessionId}.locks`); privateDirectory(directory);
  const claims = () => readdirSync(directory).filter(name => /^[1-9]\d*\.json$/.test(name)).map(name => Number(name.slice(0, -5))).sort((a, b) => a - b);
  const readClaim = generation => {
    let owner;
    try { owner = JSON.parse(readFileSync(join(directory, `${generation}.json`), 'utf8')); }
    catch { throw problem('SESSION_LOCK_UNKNOWN', '会话写入归属无法确认；拒绝接管，原锁保留。'); }
    if (owner?.hostname !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || !validId(owner.token)) throw problem('SESSION_LOCK_UNKNOWN', '会话锁不属于可确认的本机进程；拒绝接管。');
    return owner;
  };
  const numbers = claims(); const previous = numbers.at(-1) ?? 0;
  if (previous) {
    const owner = readClaim(previous);
    let released = false;
    try { released = JSON.parse(readFileSync(join(directory, `${previous}.released`), 'utf8')).token === owner.token; }
    catch (error) { if (error.code !== 'ENOENT') throw problem('SESSION_LOCK_UNKNOWN', '会话释放记录损坏；拒绝接管。'); }
    if (!released) {
      try { process.kill(owner.pid, 0); throw problem('SESSION_BUSY', `会话正在由本机进程 ${owner.pid} 使用；请先关闭该实例。`); }
      catch (error) { if (error.code !== 'ESRCH') throw error.code === 'SESSION_BUSY' ? error : problem('SESSION_LOCK_UNKNOWN', '无法确认原进程已退出；拒绝接管。'); }
    }
  }
  const generation = previous + 1;
  const owner = { pid: process.pid, hostname: hostname(), token: randomUUID() };
  const claimPath = join(directory, `${generation}.json`);
  const temporary = join(directory, `${owner.token}.tmp`);
  try {
    writePrivateJson(temporary, owner);
    try { linkSync(temporary, claimPath); } catch (error) { if (error.code === 'EEXIST') throw problem('SESSION_BUSY', '另一个实例已取得会话写入权。'); throw error; }
  } finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  let released = false;
  let lost;
  const assertOwned = () => {
    if (lost) throw lost;
    try {
      if (released || claims().at(-1) !== generation || readClaim(generation).token !== owner.token || existsSync(join(directory, `${generation}.released`))) throw new Error('owner changed');
    } catch {
      lost = problem('SESSION_LOCK_LOST', '会话写入权已丢失；停止本地等待，禁止后续请求和保存。');
      clearInterval(watch); onLost(lost); throw lost;
    }
  };
  const watch = setInterval(() => { try { assertOwned(); } catch { /* onLost already notified */ } }, 100);
  watch.unref();
  return {
    assertOwned,
    release() {
      clearInterval(watch);
      if (released || lost) return;
      try { assertOwned(); } catch { return; }
      writePrivateJson(join(directory, `${generation}.released`), { token: owner.token }, assertOwned);
      released = true;
    },
  };
}

export function listRuns(home) {
  let files;
  try { files = readdirSync(join(home, 'runs')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return files.filter(n => n.endsWith('.json')).map(name => {
    try { return readRun(home, name.slice(0, -5)); }
    catch { return { id: name.slice(0, -5), status: 'unreadable', createdAt: '', question: '记录损坏或无法读取；原文件保留。' }; }
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
