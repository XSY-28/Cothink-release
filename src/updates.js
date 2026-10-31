// SemVer comparison follows Pi's public approach; no private Pi implementation is imported.
// semver is ISC licensed (bundled license retained in node_modules/semver/LICENSE).
import semver from 'semver';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { privateDirectory, writePrivateJson } from './storage.js';

const endpoint = 'https://registry.npmjs.org/cothink-v2/latest';
const releaseUrl = 'https://github.com/XSY-28/Cothink-release/releases';
const npmUrl = 'https://www.npmjs.com/package/cothink-v2';
const interval = 24 * 60 * 60 * 1000;
const maxBytes = 256 * 1024;
export const installedVersion = () => JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
// Require a literal safe version, without semver's permissive v/= prefixes or controls.
const validVersion = value => typeof value === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?$/.test(value) && !!semver.valid(value);
const validTime = (value, now) => Number.isSafeInteger(value) && value >= 0 && value <= now;
const freshState = () => ({schemaVersion:1, automatic:true, lastAttemptAt:null, lastSuccessAt:null, latestVersion:null});

export function createUpdateService({home, currentVersion = installedVersion(), fetchImpl = fetch, now = Date.now, env = process.env}) {
  const path = join(home, 'update-state.json'), listeners = new Set();
  let data = freshState(), status = 'unchecked', error = null, storageError = null,
    protectedState = false, closed = false, inflight = null, abort = null, verified = null;
  const offline = () => !!env.PI_OFFLINE && env.PI_OFFLINE !== '0';
  const automatic = () => data.automatic && env.COTHINK_NO_UPDATE_CHECK !== '1' && !offline() && !protectedState;
  function emit() {
    if (closed) return;
    for (const listener of listeners) {
      try { listener(snapshot()); } catch { /* UI callbacks cannot fail a check. */ }
    }
  }
  function storageFailure() {
    protectedState = true;
    storageError = '更新状态损坏或无法保存，原文件已保留；本次进程停用自动检查，手动结果仅在内存可用，偏好未保存。';
  }
  function readState() {
    if (protectedState) return;
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'));
      if (!value || Array.isArray(value) || value.schemaVersion !== 1 || typeof value.automatic !== 'boolean') throw Error('schema');
      const time = now();
      const success = validTime(value.lastSuccessAt, time) && validVersion(value.latestVersion);
      data = {schemaVersion:1, automatic:value.automatic,
        lastAttemptAt:validTime(value.lastAttemptAt,time) ? value.lastAttemptAt : null,
        lastSuccessAt:success ? value.lastSuccessAt : null,
        latestVersion:success ? value.latestVersion : null};
    } catch (e) { if (e.code !== 'ENOENT') storageFailure(); }
  }
  function save() {
    if (protectedState) return false;
    try {
      privateDirectory(home);
      writePrivateJson(path, data);
      return true;
    } catch { storageFailure(); return false; }
  }
  function compared() {
    if (!data.latestVersion) return 'unchecked';
    if (!validVersion(currentVersion)) return 'unavailable';
    const difference = semver.compare(data.latestVersion, currentVersion);
    return difference > 0 ? 'available' : difference < 0 ? 'ahead' : 'current';
  }
  function snapshot() {
    const cached = validTime(data.lastSuccessAt, now()) && validVersion(data.latestVersion);
    return {currentVersion, latestVersion:cached ? data.latestVersion : null,
      status:offline() ? 'disabled' : status, checkedAt:cached ? data.lastSuccessAt : null,
      stale:!!cached && (verified !== `${data.lastSuccessAt}:${data.latestVersion}` || now()-data.lastSuccessAt >= interval || ['unavailable','checking','disabled'].includes(status) || offline()),
      automatic:automatic(), preference:data.automatic, offline:offline(),
      environmentDisabled:env.COTHINK_NO_UPDATE_CHECK === '1',
      error:offline() ? 'PI_OFFLINE 已启用，所有更新检查均已关闭。' : error,
      storageError, releaseUrl, npmUrl, prerelease:cached && !!semver.prerelease(data.latestVersion),
      programPath:resolve(process.argv[1] || process.execPath)};
  }
  readState(); status = compared();
  function check({manual = false} = {}) {
    if (closed) return Promise.resolve(snapshot());
    if (inflight) return inflight;
    readState();
    if (offline() || (!manual && !automatic())) return Promise.resolve(snapshot());
    const time = now();
    if (!manual && validTime(data.lastAttemptAt,time) && time-data.lastAttemptAt < interval) return Promise.resolve(snapshot());
    data.lastAttemptAt = time;
    const saved = save();
    if (!manual && !saved) return Promise.resolve(snapshot());
    status = 'checking'; error = null;
    abort = new AbortController();
    const requestAbort = abort;
    let reader, timedOut = false;
    let timer;
    const aborted = new Promise((_,reject) => {
      requestAbort.signal.addEventListener('abort',()=>reject(Error(timedOut ? 'timeout' : 'closed')), {once:true});
    });
    timer = setTimeout(()=>{timedOut=true;requestAbort.abort();},5000);
    const request = (async()=>{
      const response = await fetchImpl(endpoint, {method:'GET',redirect:'error',credentials:'omit',
        headers:{Accept:'application/json'},signal:requestAbort.signal});
      if (requestAbort.signal.aborted) { void response.body?.cancel().catch(()=>{}); throw Error('closed'); }
      if (!response.ok || response.redirected || Number(response.headers.get('content-length')) > maxBytes || !response.body) {
        void response.body?.cancel().catch(()=>{}); throw Error('response');
      }
      reader = response.body.getReader();
      let bytes = 0;
      const chunks = [];
      while (true) {
        const {done,value} = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) throw Error('size');
        chunks.push(value);
      }
      const meta = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (meta?.name !== 'cothink-v2' || !validVersion(meta.version)) throw Error('metadata');
      return meta.version;
    })();
    inflight = Promise.race([request,aborted]).then(version=>{
      if (closed) return snapshot();
      data.latestVersion=version;data.lastSuccessAt=now();verified=`${data.lastSuccessAt}:${version}`;status=compared();
      if (status === 'unavailable') error='当前版本不是有效 SemVer，暂时无法判断是否需要更新。';
      save();return snapshot();
    }).catch(()=>{
      if (!closed) { status='unavailable';error=timedOut ? '暂时无法检查：更新请求超时（5 秒总期限）。' : '暂时无法检查：网络或官方发布元数据不可用。'; }
      return snapshot();
    }).finally(()=>{
      clearTimeout(timer);
      // Do not await cancellation: an uncooperative body must not hold the UI/exit.
      void reader?.cancel().catch(()=>{});
      inflight=null;abort=null;emit();
    });
    emit();
    return inflight;
  }
  return {snapshot,check,
    subscribe(listener) { if (!closed) listeners.add(listener);return ()=>listeners.delete(listener); },
    setAutomatic(value) {
      if (closed) throw Error('更新检查已关闭。');
      if (typeof value !== 'boolean') throw Error('自动检查设置必须是布尔值。');
      readState();
      if (protectedState) throw Error(storageError);
      const before=data.automatic;data.automatic=value;
      if (!save()) {data.automatic=before;emit();throw Error(storageError);}
      emit();return snapshot();
    },
    close() { closed=true;abort?.abort();listeners.clear(); },
  };
}

export function formatUpdateStatus(s) {
  const messages = {unchecked:'尚未检查更新',checking:'正在检查更新…',available:`有新版本：${s.currentVersion} → ${s.latestVersion}${s.prerelease ? '（预发布版本）' : ''}`,
    current:'已是最新版本',ahead:'当前版本高于发布渠道版本',unavailable:s.error || '暂时无法检查',disabled:s.error || '自动检查已关闭'};
  return messages[s.status] || '暂时无法检查';
}
export function updateInstructions(s, platform = process.platform) {
  return {npm:validVersion(s.latestVersion) && validVersion(s.currentVersion) && s.status === 'available'
    ? `${platform === 'win32' ? 'npm.cmd' : 'npm'} install -g cothink-v2@${s.latestVersion}` : null,
    zip:'打开官方 Releases，选择适配架构的 Windows ZIP；退出旧程序，在新目录安装启动，保留原数据目录。',
    source:'源码、托管目录或无法判断：打开官方指引，按原方式更新。',
    note:'命令仅供阅读/复制。自定义 prefix 沿用原 prefix；退出旧进程后重开，保留 COTHINK_HOME。'};
}
export function updatePanelText(s) {
  const guides=updateInstructions(s);
  return [`当前版本：${s.currentVersion}`,formatUpdateStatus(s),
    `已知发布版本：${s.latestVersion ?? '未知'}${s.prerelease ? '（预发布版本）' : ''}`,
    `最近成功检查：${s.checkedAt == null ? '尚无' : new Date(s.checkedAt).toISOString()}${s.stale ? '（旧缓存，不代表本次在线结论）' : ''}`,
    `自动检查：${s.automatic ? '开启' : '关闭'}（默认访问 npm，每 24 小时尝试一次）`,
    s.error,s.storageError,`当前程序：${s.programPath}`,`官方说明 / 下载：${s.releaseUrl}`,`npm：${s.npmUrl}`,
    '\n请选择原安装方式阅读指引：',`npm 全局：${guides.npm ?? '暂无已验证的更高目标版本，不建议执行升级命令。'}`,
    guides.zip,guides.source,guides.note].filter(Boolean).join('\n');
}
