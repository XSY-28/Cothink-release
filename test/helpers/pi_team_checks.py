"""Team lifecycle through the actual CoThink CLI and Pi UI; localhost models only."""
import errno, fcntl, hashlib, json, os, pty, select, signal, struct, subprocess, tempfile, termios, threading, time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from team_fixture import team_config, TEAM_ID
ROOT = Path(__file__).resolve().parents[2]
CLI = Path(os.environ.get('COTHINK_TEST_CLI', str(ROOT / 'bin/cothink.js')))
B_ID = '7d51ceaf-2b56-4c1d-a34f-dd51da8b36c5'
calls, checks = [], []
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        calls.append(json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0')))))
        self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.end_headers()
        for delta, reason in [({'role':'assistant','content':'LOCAL_FINAL'},None),({},'stop')]:
            self.wfile.write(('data: '+json.dumps({'id':'fixture','choices':[{'index':0,'delta':delta,'finish_reason':reason}]})+'\n\n').encode())
        self.wfile.write(b'data: [DONE]\n\n')
    def log_message(self,*args): pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
class Session:
    def __init__(self,home,args=(),extra_env=None,ready="预算：纯答"):
        self.home=home; self.master,self.slave=pty.openpty(); self.original=termios.tcgetattr(self.slave)
        fcntl.ioctl(self.slave,termios.TIOCSWINSZ,struct.pack('HHHH',42,140,0,0))
        env=dict(os.environ,COTHINK_HOME=str(home),PI_OFFLINE='1',TERM='xterm-256color');env.pop('COTHINK_NO_TTY',None)
        for key in list(env):
            if any(token in key.upper() for token in ['API_KEY','AUTH_TOKEN','ACCESS_KEY','CREDENTIAL','AWS_']): env.pop(key,None)
        if extra_env: env.update(extra_env)
        self.child=subprocess.Popen(['node',str(CLI),*args],cwd=home,stdin=self.slave,stdout=self.slave,stderr=self.slave,env=env,start_new_session=True)
        self.out=bytearray(); self.wait_text(ready)
    def pump(self):
        if select.select([self.master],[],[],.025)[0]:
            try:self.out.extend(os.read(self.master,65536))
            except OSError as e:
                if e.errno!=errno.EIO:raise
    def wait(self,fn):
        deadline=time.monotonic()+12
        while not fn():
            self.pump()
            assert time.monotonic()<deadline,self.out.decode(errors='replace')[-5000:]
            assert self.child.poll() is None or fn(),'early exit\n'+self.out.decode(errors='replace')[-4000:]
    def wait_text(self,text,start=0):self.wait(lambda:text.encode() in self.out[start:])
    def send(self,text):os.write(self.master,text.encode());self.pump()
    def command(self,text,marker):
        start=len(self.out);self.send('\x15'+text+'\r');self.wait_text(marker,start)
    def pick(self,index,marker):
        start=len(self.out);self.send('\x1b[B'*index+'\r');self.wait_text(marker,start)
    def stop(self):
        if self.child.poll() is None:
            os.kill(self.child.pid,signal.SIGTERM)
            deadline=time.monotonic()+5
            while self.child.poll() is None and time.monotonic()<deadline:self.pump()
        assert self.child.poll() is not None
        assert termios.tcgetattr(self.slave)==self.original,'terminal settings not restored'
        os.close(self.master);os.close(self.slave)
    def read(self):return json.loads((self.home/'config.json').read_text())
    def current(self):
        c=self.read();return next(t for t in c['teams'] if t['id']==c['lastUsedTeamId'])
    def delete(self,index,finish='confirm'):
        self.command('/team','选择 team');self.pick(3,'删除 team（保留')
        if finish=='current':return self.pick(index,'当前对话正在使用')
        if finish=='last':return self.pick(index,'至少保留一个 team')
        self.pick(index,'删除 team「')
        start=len(self.out);self.send('\x1b' if finish=='cancel' else '\r')
        if finish!='cancel':self.wait_text('team 已删除',start)
    def save_edit(self,name):
        self.pick(4,'新 team 名称')
        start=len(self.out);self.send(name+'\r');self.wait_text('从下一条任务生效',start)

def seed(home):
    (home/'pi').mkdir()
    c=team_config(dict(formatVersion=2,main=dict(provider='fixture',modelId='main'),secondary=[dict(provider='fixture',modelId='r1')]),'A')
    c['teams'].append(dict(id=B_ID,name='B',main=dict(provider='fixture',modelId='r1'),secondary=[dict(provider='fixture',modelId='main')]))
    (home/'config.json').write_text(json.dumps(c))
    (home/'pi/models.json').write_text(json.dumps({'providers':{'fixture':{
        'api':'openai-completions','apiKey':'local-only','baseUrl':f'http://127.0.0.1:{server.server_port}/v1',
        'models':[dict(id=m,name=m,reasoning=False,input=['text'],contextWindow=32000,maxTokens=4096,cost=dict(input=0,output=0,cacheRead=0,cacheWrite=0)) for m in ['main','r1','r2']]}}}))
    return hashlib.sha256((home/'pi/models.json').read_bytes()).hexdigest()
with tempfile.TemporaryDirectory(prefix='cothink-team-pty-') as folder:
    home=Path(folder);auth_hash=seed(home);s=Session(home)
    try:
        before=(home/'config.json').read_bytes();s.delete(0,'current');assert (home/'config.json').read_bytes()==before
        s.delete(1,'cancel');time.sleep(.07);s.pump();assert (home/'config.json').read_bytes()==before
        s.delete(1);assert len(s.read()['teams'])==1
        s.delete(0,'last');assert len(s.read()['teams'])==1
        checks.append('current/last deletion protected; 2→1; cancellation')
        # Create C: choose reviewer as main, former main as deputy.
        s.command('/team','选择 team');s.pick(1,'选择模型');s.pick(1,'选择模型');s.pick(0,'保存为新 team');s.save_edit('中文 C')
        c=s.current();assert c['main']['modelId']=='r1' and c['secondary'][0]['modelId']=='main';assert len(s.read()['teams'])==2
        checks.append('new team with reused authentication')
        # Edit C and append r2; duplicate naming must preserve the registry.
        s.command('/models','追加副模型');s.pick(1,'选择模型');s.pick(2,'保存为新 team');s.pick(4,'新 team 名称')
        before=(home/'config.json').read_bytes();start=len(s.out);s.send('A\r');s.wait_text('名称重名',start);s.wait_text('新 team 名称',start)
        assert (home/'config.json').read_bytes()==before
        start=len(s.out);s.send('D\r');s.wait_text('从下一条任务生效',start)
        d=s.current();assert len(d['secondary'])==2;assert len(s.read()['teams'])==3
        assert next(t for t in s.read()['teams'] if t['id']==c['id'])==c
        checks.append('roster edits save under a new name and keep original')
        # An unchanged roster must not create a team.
        s.command('/model','追加副模型');s.pick(4,'阵容没有变化');assert len(s.read()['teams'])==3
        # Native model cycle must follow the same editor and cancel cleanly.
        before=(home/'config.json').read_bytes();start=len(s.out);s.send('\x10');s.wait_text('追加副模型',start)
        start=len(s.out);s.send('\x1b');s.wait_text('预算：纯答',start)
        assert (home/'config.json').read_bytes()==before
        checks.append('canonical/alias/native model controls share save/cancel rules')
        for text in ['/team anything',' /team anything ', '/models anything']:
            s.command(text,'不接受参数')
        s.command('/reload','Reloaded keybindings');s.command('/team','选择 team');s.send('\x1b');time.sleep(.1);s.pump()
        assert not calls and not list((home/'requests').glob('*.json'))
        checks.append('local management and reload generate zero model requests')
        # A fresh /new must keep D; check actual frozen task and wire.
        s.command('/new','New session started');s.send('/one first user\r')
        def completed():
            return [json.loads(p.read_text()) for p in (home/'tasks').glob('*.json') if json.loads(p.read_text())['status']=='completed']
        s.wait(lambda:len(completed())==1)
        record=completed()[0];assert record['team']['id']==d['id'];assert calls[-1]['model']=='r1'
        session_path=next(p for p in (home/'pi/sessions/main').rglob('*.jsonl') if d['id'] in p.read_text())
        entries=[json.loads(line) for line in session_path.read_text().splitlines()]
        assert [e['data']['team']['id'] for e in entries if e.get('customType')=='cothink-team'][-1]==d['id']
        checks.append('new conversation inherits team and freezes effective roster')
    finally:s.stop()
    # Restart restores the default; -c restores the saved conversation.
    for args in [(),('-c',)]:
        s=Session(home,args)
        try:
            s.command('/team','Team · D');s.send('\x1b')
            assert s.current()['id']==d['id']
        finally:s.stop()
    assert hashlib.sha256((home/'pi/models.json').read_bytes()).hexdigest()==auth_hash
    checks.append('fresh-process and resume selection; credentials unchanged')
# Other windows and persisted snapshots survive catalog deletion.
with tempfile.TemporaryDirectory(prefix='cothink-team-windows-') as folder:
    home=Path(folder);seed(home);first=Session(home)
    c=first.read();c['lastUsedTeamId']=B_ID;(home/'config.json').write_text(json.dumps(c))
    second=Session(home)
    try:
        first.delete(1)
        assert first.read()['lastUsedTeamId']==TEAM_ID
        start=len(second.out);second.send('/one detached B\r')
        def tasks():return [json.loads(p.read_text()) for p in (home/'tasks').glob('*.json')]
        second.wait(lambda:any(t['status']=='completed' for t in tasks()))
        assert tasks()[0]['team']['id']==B_ID and calls[-1]['model']=='r1'
        assert len(first.read()['teams'])==1
    finally:first.stop();second.stop()
    s=Session(home,('-c',))
    try:
        s.wait_text('已从列表删除');s.command('/team','Team · B');s.send('\x1b');time.sleep(.1);s.pump()
        s.command('/new','New session started');s.wait_text('已从列表删除')
        assert s.read()['lastUsedTeamId']==TEAM_ID
    finally:s.stop()
    s=Session(home)
    try:s.command('/team','Team · A');s.send('\x1b')
    finally:s.stop()
    checks.append('two windows keep independent snapshots; deleted team resumes without resurrection')

# Real append/rename failures at the persistence boundary, without production test hooks.
def seed_conversation(home, bind=True):
    module=(CLI.parent.parent/'node_modules/@earendil-works/pi-coding-agent/dist/index.js').as_uri()
    script='import {SessionManager} from '+json.dumps(module)+'; import {readFileSync} from "node:fs"; import {join} from "node:path"; const h=process.argv[1]; const c=JSON.parse(readFileSync(join(h,"config.json"))); const sm=SessionManager.create(h,join(h,"pi/sessions/main")); if(process.argv[2]==="bound")sm.appendCustomEntry("cothink-team",{team:c.teams[0]}); sm.appendMessage({role:"user",content:"prior local message",timestamp:Date.now()}); sm.appendMessage({role:"assistant",content:[{type:"text",text:"prior local reply"}],api:"openai-completions",provider:"fixture",model:"main",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"stop",timestamp:Date.now()}); console.log(sm.getSessionFile());'
    result=subprocess.run(['node','--input-type=module','-e',script,str(home.resolve()),"bound" if bind else "legacy"],cwd=ROOT,text=True,capture_output=True)
    assert result.returncode==0,result.stderr
    return Path(result.stdout.strip())

def fault_preload(home):
    path=home/'faults.mjs';flag=home/'fault-mode'
    path.write_text("import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const flag="+json.dumps(str(flag))+"; const append=fs.appendFileSync, rename=fs.renameSync; const mode=()=>fs.existsSync(flag)?fs.readFileSync(flag,'utf8'):''; fs.appendFileSync=(p,v,...rest)=>{const text=String(v); if((mode()==='session' && String(p).includes('/sessions/main/') && text.includes('cothink-team')) || (mode()==='model' && text.includes('model_change') && text.includes('r1'))) throw Error('INJECTED_'+mode()); return append(p,v,...rest);}; fs.renameSync=(a,b)=>{if(mode()==='config' && String(b).endsWith('/config.json')) throw Error('INJECTED_config'); return rename(a,b);}; syncBuiltinESMExports();")
    return flag,{'NODE_OPTIONS':'--import '+str(path)}

for fault in ['session','config','model']:
    with tempfile.TemporaryDirectory(prefix='cothink-team-fault-') as folder:
        home=Path(folder);seed(home);session_file=seed_conversation(home);flag,env=fault_preload(home)
        s=Session(home,('-c',),env);s.wait_text('team：A');before=(home/'config.json').read_bytes();before_calls=len(calls)
        try:
            flag.write_text(fault)
            s.command('/team','选择 team');s.pick(0,'选择 team（下一条生效）')
            marker={'session':'会话选择保存失败','config':'新对话默认未更新','model':'INJECTED_model'}[fault]
            s.pick(1,marker)
            assert (home/'config.json').read_bytes()==before
            if fault in ['session','model']:
                start=len(s.out);s.send('/one must not send\r');s.wait_text('请重新打开对话',start)
                assert len(calls)==before_calls
                persisted=[json.loads(line) for line in session_file.read_text().splitlines()]
                assert [e['data']['team']['id'] for e in persisted if e.get('customType')=='cothink-team'][-1]==TEAM_ID
            else:
                s.send('/one after partial\r')
                def completed():return [json.loads(p.read_text()) for p in (home/'tasks').glob('*.json') if json.loads(p.read_text())['status']=='completed']
                s.wait(lambda:bool(completed()))
                expected=B_ID if fault=='config' else TEAM_ID
                assert completed()[0]['team']['id']==expected
                assert calls[-1]['model']==('r1' if fault=='config' else 'main')
                assert len(calls)==before_calls+1
            flag.unlink()
        finally:s.stop()
        if fault in ['session','model']:
            s=Session(home,('-c',))
            try:s.command('/team','Team · A');s.send('\x1b')
            finally:s.stop()
        checks.append(fault+' failure preserves committed facts and prevents incorrect generation')

# Saving a newly edited team can fail before any session selection is changed.
with tempfile.TemporaryDirectory(prefix='cothink-team-save-fault-') as folder:
    home=Path(folder);seed(home);flag,env=fault_preload(home);s=Session(home,extra_env=env)
    try:
        s.command('/models','追加副模型');s.pick(1,'选择模型');s.pick(2,'保存为新 team');s.pick(4,'新 team 名称')
        before=(home/'config.json').read_bytes();before_calls=len(calls);flag.write_text('config')
        start=len(s.out);s.send('not saved\r');s.wait_text('INJECTED_config',start);s.wait_text('新 team 名称',start)
        assert (home/'config.json').read_bytes()==before and len(calls)==before_calls
        flag.unlink();s.send('\x1b');time.sleep(.1);s.pump()
        assert len(s.read()['teams'])==2
    finally:s.stop()
    checks.append('failed creation leaves old roster/default intact')

# Production resume must not invent a roster for sessions created before team metadata.
with tempfile.TemporaryDirectory(prefix='cothink-team-legacy-session-') as folder:
    home=Path(folder);seed(home);seed_conversation(home,False);s=Session(home,('-c',))
    try:
        before_calls=len(calls);s.command('/one old conversation','尚未绑定 team');assert len(calls)==before_calls
        s.command('/team','选择 team');s.pick(0,'选择 team（下一条生效）');s.pick(0,'从下一条任务生效')
        s.send('/one explicitly bound\r')
        s.wait(lambda:any(json.loads(p.read_text())['status']=='completed' for p in (home/'tasks').glob('*.json')))
        task=next(json.loads(p.read_text()) for p in (home/'tasks').glob('*.json'))
        assert task['team']['id']==TEAM_ID and len(calls)==before_calls+1
    finally:s.stop()
    checks.append('legacy session remains readable and requires explicit team binding before generation')

# Native clone and fork use the branch origin rather than the latest global selection.
with tempfile.TemporaryDirectory(prefix='cothink-team-branches-') as folder:
    home=Path(folder);seed(home);seed_conversation(home);s=Session(home,('-c',))
    try:
        s.command('/team','选择 team');s.pick(0,'选择 team（下一条生效）');s.pick(1,'从下一条任务生效')
        s.command('/clone','Cloned to new session');s.command('/team','Team · B');s.send('\x1b');time.sleep(.1);s.pump()
        s.command('/fork','Fork from Message');s.pick(0,'Forked to new session')
        # There is one original user message, so forking before it must recover A.
        s.command('/team','Team · A');s.send('\x1b');time.sleep(.1);s.pump()
        s.send('\x15/one branch-origin\r')
        s.wait(lambda:any(json.loads(p.read_text())['status']=='completed' for p in (home/'tasks').glob('*.json')))
        task=next(json.loads(p.read_text()) for p in (home/'tasks').glob('*.json'))
        assert task['team']['id']==TEAM_ID and calls[-1]['model']=='main'
        before_calls=len(calls)
        s.command('/team','选择 team');s.pick(0,'选择 team（下一条生效）');s.pick(1,'从下一条任务生效')
        s.command('/tree','Session Tree');s.send('branch-origin');s.pick(0,'Summarize branch?');s.pick(0,'Navigated to selected point')
        s.command('/team','Team · A');s.send('\x1b');time.sleep(.1);s.pump()
        assert len(calls)==before_calls, 'tree navigation without summary generated a request'
    finally:s.stop()
    checks.append('native clone keeps current team; fork and tree restore their ancestry without generation')

# Import copies session metadata, never registers a team or imports auth.
with tempfile.TemporaryDirectory(prefix='cothink-team-import-') as folder:
    home=Path(folder);seed(home);other=home/'external';other.mkdir();seed(other)
    config=json.loads((other/'config.json').read_text());import_id='72b8663f-a049-42ea-9695-d0632d639fee'
    config['teams'][0]['id']=import_id;config['teams'][0]['name']='Imported';config['lastUsedTeamId']=import_id
    (other/'config.json').write_text(json.dumps(config));source=seed_conversation(other)
    original_auth=(home/'pi/models.json').read_bytes();s=Session(home)
    try:
        s.command('/import '+str(source),'Import session');s.pick(0,'Session imported from:')
        s.command('/team','Team · Imported');s.send('\x1b');time.sleep(.1);s.pump()
        assert len(s.read()['teams'])==2 and s.read()['lastUsedTeamId']==TEAM_ID
        assert (home/'pi/models.json').read_bytes()==original_auth
        s.send('/one imported roster\r')
        s.wait(lambda:any(json.loads(p.read_text())['status']=='completed' for p in (home/'tasks').glob('*.json')))
        task=next(json.loads(p.read_text()) for p in (home/'tasks').glob('*.json'))
        assert task['team']['id']==import_id
    finally:s.stop()
    checks.append('native import preserves snapshot without registering the team or importing credentials')

# First setup and migration use the actual CLI wizard, not a parallel test-only path.
with tempfile.TemporaryDirectory(prefix='cothink-team-first-setup-') as folder:
    home=Path(folder);auth_hash=seed(home);(home/'config.json').unlink();s=Session(home,ready='主服务商')
    try:
        s.send('fixture\r');s.wait_text('主模型');s.send('main\r');s.wait_text('副服务商')
        s.send('fixture\r');s.wait_text('副模型');s.send('r1\r');s.wait_text('添加副模型')
        s.send('no\r');s.wait_text('team 名称');s.send('首个中文队伍\r');s.wait_text('确认保存 team')
        s.send('save\r');s.wait_text('预算：纯答')
        assert s.current()['name']=='首个中文队伍' and s.current()['main']['modelId']=='main'
        assert len(s.current()['secondary'])==1
        assert hashlib.sha256((home/'pi/models.json').read_bytes()).hexdigest()==auth_hash
    finally:s.stop()
    checks.append('actual first-run CLI creates the named team without repeating existing auth')

for cancel in [False,True]:
    with tempfile.TemporaryDirectory(prefix='cothink-team-migration-') as folder:
        home=Path(folder);auth_hash=seed(home)
        old={'formatVersion':2,'main':{'provider':'fixture','modelId':'main','maxOutputTokens':321},'secondary':[{'provider':'fixture','modelId':'r1'}],'piResources':{'skills':[]}}
        path=home/'config.json';path.write_text(json.dumps(old));before=path.read_bytes();before_calls=len(calls)
        s=Session(home,ready='team 名称')
        try:
            if cancel:
                s.send('\x03');s.wait(lambda:s.child.poll() is not None)
                assert path.read_bytes()==before
            else:
                s.send('升级队伍\r');s.wait_text('确认保存 team');s.send('save\r');s.wait_text('预算：纯答')
                assert s.current()['main']==old['main'] and s.current()['secondary']==old['secondary']
                assert s.read()['piResources']==old['piResources']
                assert any(p.read_bytes()==before for p in (home/'backups').glob('*.json'))
            assert len(calls)==before_calls
            assert hashlib.sha256((home/'pi/models.json').read_bytes()).hexdigest()==auth_hash
        finally:s.stop()
    checks.append('actual CLI migration '+('cancel preserves bytes' if cancel else 'backs up and preserves settings'))

server.shutdown();server.server_close()
print(json.dumps({'checks':checks,'localhostRequests':len(calls),'paidRequests':0,'termiosRestored':True},ensure_ascii=False,indent=2))
