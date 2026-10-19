"""Actual CoThink/Pi CLI on a PTY, local SSE provider only. This is not physical Terminal/IME acceptance."""
import errno,fcntl,json,os,pty,select,signal,struct,subprocess,tempfile,termios,threading,time,shutil,re
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
ROOT=Path(__file__).resolve().parents[1];CLI=Path(os.environ.get('COTHINK_TEST_CLI',str(ROOT/'bin/cothink.js')));NODE=shutil.which('node')
checks=[]
for scenario in os.environ.get('COTHINK_PTY_SCENARIOS','startup,settings,settings-spaces,settings-leading,setting-unknown,html-details,answer,cancel,small,multiline,keys,early-cancel,early-one-cancel,work,legacy-shift,skill,preload').split(','):
 calls=[];block=threading.Event()
 class Handler(BaseHTTPRequestHandler):
  def do_POST(self):
   body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));calls.append(body)
   if scenario=='cancel' and body['model']!='main':block.wait(10)
   n=len(calls);text='DRAFT_SECRET' if n==1 else 'FINAL_PUBLIC\n\n## 对评审意见的处理说明\nHANDLING_SECRET' if body['model']=='main' else 'REVIEW_SECRET'
   if scenario=='html-details' and n==3:text='FINAL_PUBLIC\n\n<details>\n<summary>## 对评审意见的处理说明</summary>\n\nHANDLING_SECRET\n</details>\n\nBOUNDARY_PUBLIC'
   try:
    self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
    action=None
    if scenario=='work':
     actions=[('start_work',{'reason':'edit local fixture'}),('write',{'path':'a.txt','content':'accepted work'}),('prepare_change',{}),('accept_change',{})]
     if n<=4:action=actions[n-1]
    delta={'role':'assistant','tool_calls':[{'index':0,'id':'work-'+str(n),'type':'function','function':{'name':action[0],'arguments':json.dumps(action[1])}}]} if action else {'role':'assistant','content':text}
    for delta,finish in [(delta,None),({},'tool_calls' if action else 'stop')]:
     self.wfile.write(('data: '+json.dumps({'id':'fixture','choices':[{'index':0,'delta':delta,'finish_reason':finish}]})+'\n\n').encode());self.wfile.flush()
    self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()
   except (BrokenPipeError,ConnectionResetError):pass
  def log_message(self,*args):pass
 server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
 with tempfile.TemporaryDirectory(prefix='cothink-native-pi-') as folder:
  home=Path(folder);(home/'pi').mkdir();(home/'config.json').write_text(json.dumps({'formatVersion':2,'main':{'provider':'fixture','modelId':'main'},'secondary':[{'provider':'fixture','modelId':'r1'},{'provider':'fixture','modelId':'r2'}]}));(home/'pi'/'models.json').write_text(json.dumps({'providers':{'fixture':{'api':'openai-completions','baseUrl':f'http://127.0.0.1:{server.server_port}/v1','apiKey':'local-only','models':[{'id':m,'name':m,'reasoning':False,'input':['text'],'cost':{'input':0,'output':0,'cacheRead':0,'cacheWrite':0},'contextWindow':32000,'maxTokens':4096} for m in ['main','r1','r2']]}}}))
  if scenario in ['skill','preload']:
   skill=home/'skills/learning-coach';skill.mkdir(parents=True);(skill/'SKILL.md').write_text('---\nname: learning-coach\ndescription: Local native skill integration fixture\n---\n帮助学习者理解对象、解释依据。\n')
   config=json.loads((home/'config.json').read_text());config['piResources']={'skills':[str(skill)]};(home/'config.json').write_text(json.dumps(config))
  master,slave=pty.openpty();original=termios.tcgetattr(slave);fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',30,110,0,0))
  env=dict(os.environ,COTHINK_HOME=folder,PI_OFFLINE='1',TERM='xterm-256color');env.pop('COTHINK_NO_TTY',None)
  if scenario=='startup':
   env.pop('PI_OFFLINE',None);env.pop('PI_SKIP_VERSION_CHECK',None)
   network=home/'network.jsonl';preload=home/'startup-network.mjs'
   preload.write_text("await import("+json.dumps((CLI.resolve().parent.parent/'node_modules/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js').as_uri())+"); import {appendFileSync} from 'node:fs'; const original=globalThis.fetch; globalThis.fetch=async(input,options)=>{const url=String(input?.url ?? input); if(url.startsWith('http://127.0.0.1:'))return original(input,options); appendFileSync("+json.dumps(str(network))+",JSON.stringify(url)+'\\n'); return url.includes('/api/latest-version') ? Response.json({version:'999.0.0',packageName:'@earendil-works/pi-coding-agent'}) : new Response('',{status:404});};")
   env['NODE_OPTIONS']='--import '+str(preload)
  project=home/'project'
  if scenario=='work':
   project.mkdir();(project/'base.txt').write_text('original')
   def git(*args):return subprocess.run(['git','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','user.name=fixture','-c','user.email=fixture@invalid',*args],cwd=project,capture_output=True,check=True)
   git('init','-b','main');git('status','--porcelain');git('add','--','base.txt');git('commit','-m','fixture base')
  child=subprocess.Popen([NODE,str(CLI)],cwd=project if scenario=='work' else ROOT,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True);transcript=bytearray();deadline=time.monotonic()+18
  def pump():
   if time.monotonic()>deadline:raise AssertionError('PTY fixture watchdog '+scenario+'\n'+transcript.decode(errors='replace')[-6000:])
   if select.select([master],[],[],.03)[0]:
    try:transcript.extend(os.read(master,65536))
    except OSError as e:
     if e.errno!=errno.EIO:raise
  def wait(condition):
   while not condition():
    pump()
    if child.poll() is not None and not condition():raise AssertionError('early native Pi exit '+str(child.returncode)+'\n'+transcript.decode(errors='replace')[-6000:])
  def send(text):os.write(master,text.encode());pump()
  def records():
   out=[]
   for p in (home/'tasks').glob('*.json'):
    try:out.append(json.loads(p.read_text()))
    except json.JSONDecodeError:pass
   return out
  try:
   wait(lambda:'预算：纯答'.encode() in transcript);time.sleep(.1);pump()
   command_only=scenario.startswith('settings') or scenario=='setting-unknown'
   if command_only:
    send({'settings':'/settings\r','settings-spaces':'/settings \r','settings-leading':'  /settings  \r','setting-unknown':'/setting\r'}[scenario])
    marker='未知命令' if scenario=='setting-unknown' else 'Auto-compact'
    wait(lambda:marker.encode() in transcript or bool(calls));assert calls==[],f'{scenario} generated {len(calls)} calls'
    assert marker.encode() in transcript;assert records()==[]
   elif scenario=='small':
    fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',10,32,0,0));os.kill(child.pid,signal.SIGWINCH);time.sleep(.1);send('small draft\r');time.sleep(.2);pump();assert calls==[]
    fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',30,110,0,0));os.kill(child.pid,signal.SIGWINCH);time.sleep(.1);send('\r')
   elif scenario=='skill':
    send('/skill:learning-coach explain a concept\r');wait(lambda:bool(records()) or '未知命令'.encode() in transcript);assert records(),'known skill command must enter the task host'
   elif scenario=='preload':send('请从直觉解释这个概念\r')
   elif scenario=='legacy-shift':
    send('first line');send('\x1b\r');time.sleep(.1);pump();assert calls==[],'Shift+Return must not submit';send('second line');send('\r')
   elif scenario=='keys':send('  中文 e\u0301');send('\x1b[13;2u');send('第二行');send('\n');send('third  ');send('\r')
   elif scenario=='multiline':send('\x1b[200~material\n/one stays material\n/new\ttext\x1b[201~\r')
   elif scenario=='early-cancel':send('question\r\x03')
   elif scenario=='early-one-cancel':send('/one question\r\x03')
   else:send('question\r')
   if command_only:pass
   elif scenario in ['early-cancel','early-one-cancel']:wait(lambda:any(r['status']=='cancelled' for r in records()));assert len(calls)<=1
   elif scenario=='cancel':
    wait(lambda:len(calls)==2);send('next draft\r');time.sleep(.1);pump();assert len(calls)==2
    send('\x0f');wait(lambda:b'DRAFT_SECRET' in transcript);assert '· running'.encode() in transcript,'live details should use the active task state';send('\x1b');time.sleep(.1);send('\x03');wait(lambda:any(r['status']=='cancelled' for r in records()));assert len(calls)==2
   else:
    wait(lambda:any(r['status']=='completed' for r in records()));time.sleep(.15);pump();assert len(calls)==(5 if scenario=='work' else 3)
    text=transcript.decode(errors='replace');assert 'DRAFT_SECRET' not in text and 'REVIEW_SECRET' not in text and 'HANDLING_SECRET' not in text,text[-4000:]
    assert 'FINAL_PUBLIC' in text
    if scenario=='startup':
     assert '本次更新' not in json.dumps(calls,ensure_ascii=False),'release notice must not enter model context'
     urls=network.read_text() if network.exists() else ''
     failures=[]
     if 'CoThink · Pi' in text:failures.append('header still contains Pi preview label')
     if '/api/latest-version' in urls:failures.append('still checks the upstream Pi version')
     if 'Update Available' in text or 'pi.dev/changelog' in text:failures.append('still displays Pi update banner')
     assert not failures,failures
    if scenario=='html-details':assert 'BOUNDARY_PUBLIC' in text and '<details>' not in text
    if scenario=='preload':
     assert records()[0]['input']=='请从直觉解释这个概念'
     assert records()[0]['answerSkills'][0]['name']=='learning-coach'
     for call in calls:assert '帮助学习者理解对象、解释依据' in json.dumps(call,ensure_ascii=False)
    if scenario=='skill':assert '帮助学习者理解对象、解释依据' in json.dumps(calls[1],ensure_ascii=False)
    if scenario=='legacy-shift':assert records()[0]['input']=='first line\nsecond line',records()[0]['input']
    if scenario=='keys':assert records()[0]['input']=='  中文 e\u0301\n第二行\nthird  ',records()[0]['input']
    if scenario=='multiline':assert records()[0]['input']=='material\n/one stays material\n/new    text',records()[0]['input']
    if scenario=='work':
     assert not (project/'a.txt').exists();assert records()[0]['work']['finalCheck']['verification']=='unverified'
     assert '正式版本' in text
    send('draft preserved');send('\x0f');time.sleep(.15);pump();wait(lambda:('完整讨论'.encode() if scenario=='work' else b'DRAFT_SECRET') in transcript)
    if scenario=='html-details':wait(lambda:b'HANDLING_SECRET' in transcript)
    if scenario=='preload':wait(lambda:'本条已预载技能'.encode() in transcript and b'learning-coach' in transcript)
    send('\x1b');time.sleep(.1)
    if scenario=='preload':
     send(' continued\r');wait(lambda:len(records())==2 and all(r['status']=='completed' for r in records()))
     assert any(r['input']=='draft preserved continued' for r in records()),records()
   os.kill(child.pid,signal.SIGTERM);wait(lambda:child.poll() is not None)
   assert termios.tcgetattr(slave)==original,'termios not restored'
   assert b'\x1b[?1049h' in transcript and b'\x1b[?1049l' in transcript
   checks.append({'scenario':scenario,'calls':len(calls),'status':records()[0]['status'] if records() else 'local-command','termiosRestored':True,'realGenerations':0})
  finally:
   block.set()
   if child.poll() is None:child.kill();child.wait()
   os.close(master);os.close(slave)
 server.shutdown();server.server_close()
print(json.dumps(checks,ensure_ascii=False,indent=2))
