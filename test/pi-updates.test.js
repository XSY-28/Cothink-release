import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpdateService, formatUpdateStatus, updateInstructions } from '../src/updates.js';

const reply = (version = '0.8.3', extra = {}) => new Response(JSON.stringify({name:'cothink-v2',version,...extra}));
function setup(t, options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cothink-updates-'));
  let time = 1000000000, calls = 0;
  const service = createUpdateService({home, currentVersion:'0.8.3-delegation.1',
    now: () => time, env: {}, ...options, fetchImpl: async (...args) => { calls++; return (options.fetchImpl ?? (()=>reply()))(...args); }});
  t.after(()=>{service.close();rmSync(home,{recursive:true,force:true});});
  return {home, service, calls:()=>calls, advance:ms=>time+=ms};
}

test('SemVer distinguishes equal, ahead, prereleases, stable and metadata', async t => {
  for (const [local, remote, status] of [
    ['1.0.0','1.0.0','current'], ['2.0.0','1.0.0','ahead'],
    ['1.0.0-pre.2','1.0.0-pre.10','available'], ['1.0.0-pre.10','1.0.0','available'],
    ['1.0.0+local','1.0.0+remote','current'], ['0.8.3-delegation.1','0.8.3','available'],
    ['dev','1.0.0','unavailable'],
  ]) {
    const {service}=setup(t,{currentVersion:local,fetchImpl:async()=>reply(remote)});
    assert.equal((await service.check({manual:true})).status,status,`${local} → ${remote}`);
  }
});
test('one anonymous fixed GET; concurrent checks join; failed attempts persist throttle; manual bypasses', async t => {
  let release, requests=0;
  const {home,service,advance} = setup(t,{fetchImpl:(url,opts)=>{
    requests++;
    assert.equal(url,'https://registry.npmjs.org/cothink-v2/latest');
    assert.equal(opts.redirect,'error'); assert.equal(opts.credentials,'omit');
    assert.equal(opts.method,'GET'); assert.deepEqual(Object.keys(opts.headers),['Accept']);
    return new Promise(r=>release=r);
  }});
  const first=service.check(), second=service.check({manual:true});
  release(new Response('oops',{status:500}));
  assert.equal((await first).status,'unavailable'); await second;
  assert.equal(requests,1); await service.check(); assert.equal(requests,1);
  const reopened=createUpdateService({home,currentVersion:'0.8.3-delegation.1',now:()=>1000000000,env:{},fetchImpl:async()=>{requests++;return reply();}});
  t.after(()=>reopened.close()); await reopened.check(); assert.equal(requests,1);
  const manual=service.check({manual:true}); release(reply()); await manual;
  assert.equal(requests,2); advance(86400001);
  const due=service.check();release(reply());assert.equal((await due).status,'available');
  assert.equal(requests,3);
});
test('rejects unsafe metadata and oversized response without offering commands', async t => {
  for (const body of [JSON.stringify({name:'other',version:'2.0.0'}),'{',
    ...['oops','1.0.0\n','1.0.0; echo x','v1.0.0'].map(version=>JSON.stringify({name:'cothink-v2',version})), 'x'.repeat(262145)]) {
    const {service}=setup(t,{fetchImpl:async()=>new Response(body)});
    const s=await service.check({manual:true});
    assert.equal(s.status,'unavailable');assert.equal(s.latestVersion,null);
    assert.equal(updateInstructions(s).npm,null);assert.match(formatUpdateStatus(s),/无法检查/);
  }
});
test('5 second deadline includes a hung response body and never retries', async t => {
  let cancelled=false;
  const {service,calls}=setup(t,{fetchImpl:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}))});
  const start=Date.now(), s=await service.check({manual:true});
  assert.equal(s.status,'unavailable');assert.match(s.error,/超时/);
  assert.ok(Date.now()-start>=4900);assert.ok(Date.now()-start<6500);
  assert.equal(calls(),1); assert.equal(cancelled,true);
});
test('automatic preference, environment suppression and explicit offline respect network boundaries', async t => {
  const {home,service,calls}=setup(t);
  service.setAutomatic(false);await service.check();assert.equal(calls(),0);
  assert.equal((await service.check({manual:true})).status,'available');
  const s=createUpdateService({home,currentVersion:'0.8.0',env:{COTHINK_NO_UPDATE_CHECK:'1'},fetchImpl:async()=>{throw Error('no auto');}});
  t.after(()=>s.close());await s.check();assert.equal(s.snapshot().automatic,false);
  const offline=setup(t,{env:{PI_OFFLINE:'1'}});
  assert.equal((await offline.service.check({manual:true})).status,'disabled');assert.equal(offline.calls(),0);
});
test('corrupt/unwritable cache remains intact; manual works in memory and preference cannot claim saved', async t => {
  const {home,service}=setup(t);
  const path=join(home,'update-state.json');writeFileSync(path,'{ damaged');
  await service.check();assert.equal(service.snapshot().automatic,false);
  assert.equal((await service.check({manual:true})).status,'available');
  assert.match(service.snapshot().storageError,/保存|损坏/);
  assert.throws(()=>service.setAutomatic(false),/保存|损坏/);
  assert.equal(readFileSync(path,'utf8'),'{ damaged');
  const blocked=setup(t);mkdirSync(join(blocked.home,'update-state.json'));
  assert.equal((await blocked.service.check({manual:true})).status,'available');
  assert.throws(()=>blocked.service.setAutomatic(false));
});
test('future/invalid times cannot suppress checking; cached success stays explicitly stale after failure', async t => {
  const {home,service,calls}=setup(t);
  writeFileSync(join(home,'update-state.json'),JSON.stringify({schemaVersion:1,automatic:true,lastAttemptAt:2000000000,lastSuccessAt:'bad',latestVersion:'2.0.0'}));
  await service.check();assert.equal(calls(),1);
  const failed=createUpdateService({home,currentVersion:'0.8.0',now:()=>1000000001,env:{},fetchImpl:async()=>{throw Error('private path must not echo');}});
  t.after(()=>failed.close());const s=await failed.check({manual:true});
  assert.equal(s.status,'unavailable');assert.equal(s.latestVersion,'0.8.3');assert.equal(s.stale,true);
  assert.equal(s.checkedAt,1000000000);assert.doesNotMatch(s.error,/private path/);
});
test('closing cancels pending work and suppresses late changes and notifications', async t => {
  let release, signal;
  const {service}=setup(t,{fetchImpl:(_,options)=>{signal=options.signal;return new Promise(r=>release=r);}});
  let events=0;service.subscribe(()=>events++);
  const pending=service.check();service.close();const before=events;
  release(reply());await pending;
  assert.equal(signal.aborted,true);assert.equal(events,before);assert.notEqual(service.snapshot().status,'available');
});
test('installation guides require an exact verified version and honor user-selected installation', async t => {
  const {service}=setup(t);const s=await service.check({manual:true});
  for (const platform of ['darwin','linux'])
    assert.equal(updateInstructions(s,platform).npm,'npm install -g cothink-v2@0.8.3');
  assert.equal(updateInstructions(s,'win32').npm,'npm.cmd install -g cothink-v2@0.8.3');
  assert.match(updateInstructions(s).zip,/新目录/);assert.match(updateInstructions(s).source,/原方式/);
  assert.ok(s.programPath);assert.match(s.releaseUrl,/XSY-28\/Cothink-release\/releases$/);
});
