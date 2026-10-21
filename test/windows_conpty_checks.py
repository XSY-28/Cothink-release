"""Windows ConPTY + installed CLI; fixed localhost replies, no paid requests."""
import json
import os
import queue
import shutil
import threading
import time
import tempfile
import sys
from pathlib import Path
from winpty import PtyProcess
import pyte

root = Path(__file__).resolve().parents[1]
probe = PtyProcess.spawn([shutil.which('node'), str(root / 'test/helpers/windows-console.mjs')],
                         cwd=str(root), env=os.environ.copy(), dimensions=(32, 110), backend=1)
probe_chunks = queue.Queue()
probe_screen = pyte.Screen(110, 32)
probe_screen.write_process_input = probe.write
probe_stream = pyte.Stream(probe_screen)
def read_probe():
    try:
        while True:
            data = probe.read(8192)
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
            probe.terminate(force=True)
        except PermissionError:
            if probe.isalive():
                raise
if '--console-only' in sys.argv:
    print('Windows console probe passed')
    sys.exit(0)

report_dir = Path(tempfile.mkdtemp(prefix='cothink-conpty-'))
report = report_dir / 'home.txt'
env = {**os.environ, 'COTHINK_TEST_HOME_REPORT': str(report)}
proc = PtyProcess.spawn([shutil.which('node'), str(root / 'test/helpers/pi-manual-terminal.mjs')],
                        cwd=str(root), env=env, dimensions=(32, 110), backend=1)
chunks = queue.Queue()
transcript = ''
# ConPTY expects its host terminal to answer cursor-position queries. Without
# a screen emulator it can hold input after rendering an overlay, unlike WT.
screen = pyte.Screen(110, 32)
screen.write_process_input = proc.write
stream = pyte.Stream(screen)

def reader():
    try:
        while True:
            data = proc.read(8192)
            stream.feed(data)
            chunks.put(data)
    except EOFError:
        pass

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
    raise AssertionError(label + '\n' + transcript[-6000:])

try:
    wait_for(lambda: 'COTHINK' in transcript, 'interactive startup')
    home = Path(report.read_text(encoding='utf-8'))
    prompt = '中文输入\n第二行'
    proc.write('\x1b[200~' + prompt + '\x1b[201~')
    time.sleep(0.3)
    assert not list((home / 'tasks').glob('*.json')), 'paste submitted before Enter'
    proc.write('\r')
    wait_for(lambda: '本地验收最终稿' in transcript, 'complete three-stage answer')
    proc.write('/chat\r')
    wait_for(lambda: 'FIXTURE_REVIEW' in transcript, 'discussion details')
    proc.write('\x1b')
    time.sleep(0.3)
    proc.write('/one\r')
    wait_for(lambda: 'ONE' in transcript, 'local mode switch')
    proc.write('CtrlJ\n第二行\r')
    def completed():
        rows = [json.loads(p.read_text(encoding='utf-8')) for p in (home / 'tasks').glob('*.json')]
        return len(rows) == 2 and all(r['status'] == 'completed' for r in rows)
    wait_for(completed, 'single model multiline input')
    rows = [json.loads(p.read_text(encoding='utf-8')) for p in (home / 'tasks').glob('*.json')]
    assert {r['input'] for r in rows} == {prompt, 'CtrlJ\n第二行'}
    proc.write('/quit\r')
    wait_for(lambda: not proc.isalive(), 'clean exit')
    print(json.dumps({'conpty': True, 'consoleReopen': True, 'tasks': 2, 'chineseMultiline': True,
                      'details': True, 'modeSwitch': True, 'realGenerations': 0}))
finally:
    if proc.isalive():
        proc.terminate(force=True)
    shutil.rmtree(report_dir)
