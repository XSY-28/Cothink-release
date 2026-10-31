"""Actual CLI PTY continuation of an existing GUI session; no provider server here."""
import os,sys,pty,fcntl,termios,struct,subprocess,time,select,json,signal
home,cli,cwd=sys.argv[1:4]
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',30,110,0,0))
env=dict(os.environ,COTHINK_HOME=home,PI_OFFLINE='1',TERM='xterm-256color');env.pop('COTHINK_NO_TTY',None)
p=subprocess.Popen(['node',cli,'-c'],cwd=cwd,env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True);out=bytearray()
def wait(fn):
 deadline=time.monotonic()+15
 while not fn():
  if select.select([master],[],[],.025)[0]:
   try:out.extend(os.read(master,65536))
   except OSError:pass
  assert time.monotonic()<deadline, out.decode(errors='replace')[-4000:]
try:
 wait(lambda:'预算：纯答'.encode() in out)
 wait(lambda:'ONE · 单模型'.encode() in out)
 if len(sys.argv)>4:
  ready=sys.argv[4];open(ready,'w').write('PTY writer ready')
  wait(lambda:not os.path.exists(ready))
 os.write(master,b'CLI_ROUNDTRIP_BOUNDARY\r')
 def completed():
  records=[json.load(open(os.path.join(home,'tasks',f)))for f in os.listdir(os.path.join(home,'tasks'))if f.endswith('.json')]
  return any(r.get('input')=='CLI_ROUNDTRIP_BOUNDARY' and r['status']=='completed' for r in records)
 wait(completed)
 print(json.dumps({'actualCliPty':True,'completed':True}))
finally:
 p.terminate()
 deadline=time.monotonic()+8
 while p.poll() is None and time.monotonic()<deadline:
  if select.select([master],[],[],.025)[0]:
   try:out.extend(os.read(master,65536))
   except OSError:pass
 assert p.poll() is not None, 'CLI did not finish signal cleanup'
 os.close(master);os.close(slave)
