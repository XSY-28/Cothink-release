import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from './helpers/pi-fixture.js';
import {createUpdateService} from '../src/updates.js';
import {createGuiController} from '../src/gui-controller.js';
import {startGuiServer} from '../src/gui-server.js';

test('GUI bootstrap is usable while request hangs, subscription reports completion, drafts and selection stay intact',async t=>{
  const f=await fixture(t);let release, calls=0;
  const updates=createUpdateService({home:f.home,currentVersion:'0.8.0',env:{},fetchImpl:()=>{calls++;return new Promise(r=>release=r);}});
  const c=await createGuiController({home:f.home,cwd:f.cwd,updateService:updates});t.after(()=>c.close());
  const s=await c.action('session.create',{project:null});
  await c.action('session.draft',{sessionId:s.id,text:'draft stays'});
  let events=0;c.subscribe(()=>events++);
  const checking=c.checkForUpdates();
  const first=await c.bootstrap();assert.equal(first.updates.status,'checking');assert.equal(calls,1);
  assert.equal((await c.session(s.id)).draft,'draft stays');
  const checking2=c.action('updates.check');
  release(new Response(JSON.stringify({name:'cothink-v2',version:'0.8.1-pre.2'})));
  await checking;await checking2;
  const b=await c.bootstrap();assert.equal(b.updates.status,'available');assert.equal(events>=2,true);
  assert.match(b.updates.instructions.npm,/@0.8.1-pre.2$/);
  assert.equal((await c.session(s.id)).draft,'draft stays');assert.equal(f.calls.length,0);
  await c.action('updates.configure',{automatic:false});
  assert.equal((await c.bootstrap()).updates.automatic,false);
  assert.equal(JSON.parse(readFileSync(join(f.home,'update-state.json'))).automatic,false);
});
test('authenticated update actions reject endpoint/package injection and malformed preferences; errors do not mean latest',async t=>{
  const f=await fixture(t);const updates=createUpdateService({home:f.home,currentVersion:'0.8.0',env:{COTHINK_NO_UPDATE_CHECK:'1'},fetchImpl:async()=>new Response('error',{status:500})});
  const c=await createGuiController({home:f.home,cwd:f.cwd,updateService:updates});
  const host=await startGuiServer({home:f.home,controller:c,open:false});t.after(()=>host.close());
  const base=host.url.split('/#')[0];
  const post=(name,args,auth=true)=>fetch(base+'/api/action',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+host.token}:{})},body:JSON.stringify({action:name,args})});
  assert.equal((await post('updates.check',{},false)).status,403);
  for(const [name,args] of [['updates.check',{endpoint:'http://bad'}],['updates.configure',{automatic:'false'}],['updates.configure',{automatic:true,package:'bad'}]]) {
    assert.equal((await post(name,args)).status,400);
  }
  const res=await post('updates.check',{});assert.equal(res.status,200);
  const body=await res.json();assert.equal(body.status,'unavailable');assert.doesNotMatch(body.message,/已是最新/);
  writeFileSync(join(f.home,'update-state.json'),'{bad');
  const failed=await post('updates.configure',{automatic:false});assert.equal(failed.status,400);
  assert.equal(readFileSync(join(f.home,'update-state.json'),'utf8'),'{bad');
  assert.equal(f.calls.length,0);
});
test('closing GUI host cancels request; late completion cannot invalidate a closed page',async t=>{
  const f=await fixture(t);let release,signal;
  const updates=createUpdateService({home:f.home,currentVersion:'0.8.0',env:{},fetchImpl:(_,o)=>{signal=o.signal;return new Promise(r=>release=r);}});
  const c=await createGuiController({home:f.home,updateService:updates});
  let events=0;c.subscribe(()=>events++);
  const check=c.checkForUpdates();await c.close();const before=events;
  release(new Response(JSON.stringify({name:'cothink-v2',version:'2.0.0'})));await check;
  assert.equal(signal.aborted,true);assert.equal(events,before);
});
