"""Actual terminal command dispatch against the Node test's localhost provider."""
import os,pty,subprocess,sys,fcntl,termios,struct,select,time,json,signal
from pathlib import Path
home,project,cli=sys.argv[1:]
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',35,120,0,0))
env=dict(os.environ,COTHINK_HOME=home,PI_OFFLINE='1',TERM='xterm-256color');env.pop('COTHINK_NO_TTY',None)
child=subprocess.Popen(['node',cli],cwd=project,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True)
out=bytearray()
def pump():
 if select.select([master],[],[],.05)[0]:
  try:out.extend(os.read(master,65536))
  except OSError:pass
def wait(predicate):
 end=time.monotonic()+35
 while not predicate():
  pump()
  if time.monotonic()>end:raise RuntimeError(out.decode(errors='replace')[-4000:])
def records():return [json.loads(p.read_text()) for p in Path(home,'tasks').glob('*.json')]
try:
 wait(lambda:'预算：纯答'.encode() in out)
 os.write(master,b'/one\r');wait(lambda:b'ONE' in out)
 os.write(master,b'/make-html blue rectangle\r')
 wait(lambda:len(records())==1 and records()[0]['status']!='running')
 first=records()[0];assert first['status']=='completed',first.get('error');assert first['input']=='blue rectangle';assert first['singleModel'];assert first['workRequest']=={'kind':'html-svg'}
 # Wait for host cleanup and input readiness, then verify the single-shot action did not replace ONE.
 for _ in range(8):pump()
 os.write(master,b'followup\r')
 wait(lambda:len(records())==2 and all(r['status']!='running' for r in records()))
 second=next(r for r in records() if r['input']=='followup');assert second['singleModel'];assert second['mode']=='answer';assert second['status']=='completed';assert 'workRequest' not in second
 print(json.dumps({'firstMode':first['mode'],'secondMode':second['mode'],'singleModel':True,'paidRequests':0}))
finally:
 if child.poll() is None:child.send_signal(signal.SIGTERM)
 deadline=time.monotonic()+10
 while child.poll() is None and time.monotonic()<deadline:pump()
 if child.poll() is None:
  child.kill();child.wait();raise RuntimeError('TUI failed graceful cleanup')
 os.close(master);os.close(slave)
