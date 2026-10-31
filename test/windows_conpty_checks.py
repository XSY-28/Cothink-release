"""Windows ConPTY + installed CLI; fixed localhost replies, no paid requests."""
import json
import os
import queue
import shutil
import threading
import time
import tempfile
import sys
import signal
import subprocess
from pathlib import Path
from winpty import PTY, WinptyError
from winpty.enums import Backend
import pyte

root = Path(__file__).resolve().parents[1]
# Select the named native backend: pywinpty ConPTY=0, legacy WinPTY=1.
# Read its output channel directly without a socket relay or extra pipe EOF peeks.
def spawn(args, env):
    child = PTY(110, 32, backend=Backend.ConPTY)
    child.spawn(args[0], cmdline=subprocess.list2cmdline(args[1:]), cwd=str(root),
                env='\0'.join(f'{key}={value}' for key, value in env.items()) + '\0')
    return child

def terminate(child):
    if child.isalive():
        os.kill(child.pid, signal.SIGINT)
        time.sleep(0.1)
    if child.isalive():
        try:
            os.kill(child.pid, signal.SIGTERM)
        except PermissionError:
            if child.isalive():
                raise

def read_output(child):
    exited_at = None
    while True:
        try:
            data = child.read(blocking=False)
        except WinptyError:
            if child.get_exitstatus() is not None:
                return
            raise
        if data:
            exited_at = None
            yield data
        else:
            # The process can exit before its final native read reaches the channel.
            # Drain that channel without calling the pipe-peeking iseof() method.
            if child.get_exitstatus() is not None:
                exited_at = exited_at or time.monotonic()
                if time.monotonic() - exited_at >= 0.1:
                    return
            time.sleep(0.005)

probe = spawn([shutil.which('node'), str(root / 'test/helpers/windows-console.mjs')], os.environ.copy())
probe_chunks = queue.Queue()
probe_screen = pyte.Screen(110, 32)
probe_screen.write_process_input = probe.write
probe_stream = pyte.Stream(probe_screen)
def read_probe():
    try:
        for data in read_output(probe):
            probe_stream.feed(data)
            probe_chunks.put(data)
    except EOFError:
        pass
threading.Thread(target=read_probe, daemon=True).start()
probe_text = ''
probe_deadline = time.monotonic() + 40
try:
    while time.monotonic() < probe_deadline and 'CONSOLE_REOPEN_OK' not in probe_text:
        try:
            probe_text += probe_chunks.get(timeout=0.1)
        except queue.Empty:
            pass
    assert 'CONSOLE_REOPEN_OK' in probe_text, probe_text
finally:
    # The success marker precedes Node's normal handle cleanup. Let it exit;
    # immediately signalling a process that is already exiting can get WinError 5.
    exit_deadline = time.monotonic() + 2
    while probe.isalive() and time.monotonic() < exit_deadline:
        time.sleep(0.01)
    if probe.isalive():
        try:
            terminate(probe)
        except PermissionError:
            if probe.isalive():
                raise
if '--console-only' in sys.argv:
    print(json.dumps({'backend': 'ConPTY', 'backendId': Backend.ConPTY, 'consoleReopen': True}))
    sys.exit(0)

report_dir = Path(tempfile.mkdtemp(prefix='cothink-conpty-'))
report = report_dir / 'home.txt'
env = {**os.environ, 'COTHINK_TEST_HOME_REPORT': str(report)}
args = [shutil.which('node'), str(root / 'test/helpers/pi-manual-terminal.mjs')]
proc = spawn(args, env)
chunks = queue.Queue()
transcript = ''
# ConPTY expects its host terminal to answer cursor-position queries. Without
# a screen emulator it can hold input after rendering an overlay, unlike WT.
screen = pyte.Screen(110, 32)
screen.write_process_input = proc.write
stream = pyte.Stream(screen)
screen_lock = threading.Lock()
reader_errors = []
def visible():
    with screen_lock:
        return "\n".join(screen.display)

def reader():
    try:
        for data in read_output(proc):
            with screen_lock:
                stream.feed(data)
            chunks.put(data)
    except Exception as error:
        reader_errors.append(repr(error))

threading.Thread(target=reader, daemon=True).start()

def wait_for(predicate, label, seconds=40):
    global transcript
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            transcript += chunks.get(timeout=0.1)
        except queue.Empty:
            pass
        if predicate():
            return
    raise AssertionError(label + '\n' + transcript[-6000:] + '\nvisible screen:\n' + visible() + '\nreader errors=' + repr(reader_errors) + '\nprocessAlive=' + str(proc.isalive()))

try:
    wait_for(lambda: 'COTHINK' in visible() and '预算' in visible(), 'interactive startup')
    home = Path(report.read_text(encoding='utf-8'))
    prompt = '中文输入\n第二行'
    proc.write('\x1b[200~' + prompt + '\x1b[201~')
    time.sleep(0.3)
    assert not list((home / 'tasks').glob('*.json')), 'paste submitted before Enter'
    proc.write('\r')
    wait_for(lambda: '本地验收最终稿' in visible(), 'complete three-stage answer')
    proc.write('/chat\r')
    wait_for(lambda: 'FIXTURE_REVIEW' in visible(), 'discussion details')
    proc.write('\x1b')
    time.sleep(0.3)
    proc.write('/one\r')
    wait_for(lambda: 'ONE' in visible(), 'local mode switch')
    proc.write('CtrlJ\n第二行\r')
    snapshot_busy = 0
    def completed():
        global snapshot_busy
        try:
            rows = [json.loads(p.read_text(encoding='utf-8')) for p in (home / 'tasks').glob('*.json')]
        except PermissionError:
            # Windows can deny an open while Node atomically replaces the snapshot.
            # Re-observe within wait_for's original deadline; persistent denial fails.
            snapshot_busy += 1
            return False
        return len(rows) == 2 and all(r['status'] == 'completed' for r in rows)
    wait_for(completed, 'single model multiline input')
    rows = [json.loads(p.read_text(encoding='utf-8')) for p in (home / 'tasks').glob('*.json')]
    assert {r['input'] for r in rows} == {prompt, 'CtrlJ\n第二行'}
    proc.write('/quit\r')
    wait_for(lambda: not proc.isalive(), 'clean exit')
    print(json.dumps({'backend': 'ConPTY', 'backendId': Backend.ConPTY, 'conpty': True, 'consoleReopen': True, 'tasks': 2, 'chineseMultiline': True,
                      'details': True, 'modeSwitch': True, 'snapshotBusyObservations': snapshot_busy, 'realGenerations': 0}))
finally:
    if proc.isalive():
        terminate(proc)
    shutil.rmtree(report_dir)
