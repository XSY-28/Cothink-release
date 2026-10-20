"""Package/Team through a real PTY. Called by the localhost Node registry fixture.
This proves terminal protocol behavior, not physical Terminal/IME operation.
"""
import errno,fcntl,json,os,pty,select,signal,struct,subprocess,termios,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
CLI=Path(os.environ.get('COTHINK_TEST_CLI',str(ROOT/'bin/cothink.js')))
home=Path(os.environ['COTHINK_PACKAGE_HOME'])
env=dict(os.environ,COTHINK_HOME=str(home),PI_OFFLINE='1',TERM='xterm-256color');env.pop('COTHINK_NO_TTY',None)
master,slave=pty.openpty();original=termios.tcgetattr(slave)
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,140,0,0))
child=subprocess.Popen(['node',str(CLI)],cwd=home,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True)
out=bytearray()
def pump():
 if select.select([master],[],[],.025)[0]:
  try:out.extend(os.read(master,65536))
  except OSError as e:
   if e.errno!=errno.EIO:raise
def wait(fn):
 deadline=time.monotonic()+15
 while not fn():
  pump();assert time.monotonic()<deadline,out.decode(errors='replace')[-6000:]
  assert child.poll() is None or fn(),out.decode(errors='replace')[-6000:]
def text(marker,start=0):wait(lambda:marker.encode() in out[start:])
def send(value):os.write(master,value.encode());pump()
def command(value,marker):
 start=len(out);send('\x15'+value+'\r');text(marker,start)
def manage(*args):return subprocess.run(['node',str(CLI),*args,'--json'],cwd=home,env=env,text=True,capture_output=True,timeout=15)
def completed():
 return [json.loads(p.read_text()) for p in (home/'tasks').glob('*.json') if json.loads(p.read_text())['status']=='completed']
settings=(home/'pi/settings.json').read_bytes()
try:
 text('预算：纯答')
 listed=manage('list');assert listed.returncode==0,listed.stderr;assert json.loads(listed.stdout)['packages'][0]['status']=='partial'
 blocked=manage('remove','npm:@cothink-fixtures/mixed');assert blocked.returncode==1;assert json.loads(blocked.stdout)['error']['code']=='PACKAGE_SESSION_BUSY'
 command('/team','选择 team');send('\x1b');time.sleep(.1);pump()
 command('/package-prompt supplied','fixture answer');wait(lambda:len(completed())==1)
 command('/new','New session started');send('/one package once\r');wait(lambda:len(completed())==2)
 command('/reload','Reloaded keybindings')
 command('/team','选择 team');send('\x1b');time.sleep(.1);pump()
 assert (home/'pi/settings.json').read_bytes()==settings
 # A damaged registration must preserve local Team/history controls and block generation.
 (home/'pi/settings.json').write_text(json.dumps({'packages':['npm:missing@1.0.0']}))
 send('blocked question\r');text('缺失');time.sleep(.1);pump();assert len(completed())==2
 command('/team','选择 team');send('\x1b');time.sleep(.1);pump()
 print('package PTY: list/idle lock/template/three calls/new/one/reload/fault/team controls passed')
finally:
 if child.poll() is None:os.kill(child.pid,signal.SIGTERM)
 deadline=time.monotonic()+5
 while child.poll() is None and time.monotonic()<deadline:pump()
 assert child.poll() is not None
 assert termios.tcgetattr(slave)==original
 os.close(master);os.close(slave)
 (home/'pi/settings.json').write_bytes(settings)
