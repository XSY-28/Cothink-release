"""Windows ConPTY + installed CLI; fixed localhost replies, no paid requests."""
import json
import os
import queue
import re
import shutil
import threading
import time
from pathlib import Path
from winpty import PtyProcess

root = Path(__file__).resolve().parents[1]
proc = PtyProcess.spawn([shutil.which('node'), str(root / 'test/helpers/pi-manual-terminal.mjs')],
                        cwd=str(root), env=os.environ.copy(), dimensions=(32, 110), backend=1)
chunks = queue.Queue()
transcript = ''

def reader():
    try:
        while True:
            chunks.put(proc.read(8192))
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
    clean = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', transcript)
    match = re.search(r'记录保留在 ([^\r\n]+)', clean)
    assert match, 'fixture data path missing'
    home = Path(match.group(1).strip())
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
    print(json.dumps({'conpty': True, 'tasks': 2, 'chineseMultiline': True,
                      'details': True, 'modeSwitch': True, 'realGenerations': 0}))
finally:
    if proc.isalive():
        proc.terminate(force=True)
