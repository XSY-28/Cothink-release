"""Conversation modes through real CLI/PTY and localhost SSE; no physical Terminal claim."""
import errno, fcntl, json, os, pty, re, select, signal, struct, subprocess, tempfile, termios, threading, time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from team_fixture import team_config
from terminal_screen import visible_rows

ROOT = Path(__file__).resolve().parents[2]
CLI = Path(os.environ.get('COTHINK_TEST_CLI', str(ROOT / 'bin/cothink.js')))
calls, checks, screens = [], [], {}
hold, release = threading.Event(), threading.Event()

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        calls.append(body)
        if hold.is_set(): release.wait(10)
        try:
            self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
            for delta, reason in [({'role': 'assistant', 'content': 'MODE_LOCAL_REPLY'}, None), ({}, 'stop')]:
                self.wfile.write(('data: ' + json.dumps({'id': 'fixture', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': reason}]}) + '\n\n').encode())
            self.wfile.write(b'data: [DONE]\n\n')
        except (BrokenPipeError, ConnectionResetError): pass
    def log_message(self, *args): pass

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()

def seed(home):
    (home / 'pi').mkdir()
    config = team_config(dict(formatVersion=2, main=dict(provider='fixture', modelId='main'), secondary=[dict(provider='fixture', modelId='r1')]))
    (home / 'config.json').write_text(json.dumps(config))
    (home / 'pi/models.json').write_text(json.dumps({'providers': {'fixture': {
        'api': 'openai-completions', 'apiKey': 'local-only', 'baseUrl': f'http://127.0.0.1:{server.server_port}/v1',
        'models': [dict(id=m, name=m, reasoning=False, input=['text'], contextWindow=32000, maxTokens=4096,
                        cost=dict(input=0, output=0, cacheRead=0, cacheWrite=0)) for m in ['main', 'r1']]}}}))

class Session:
    def __init__(self, home, args=(), extra_env=None):
        self.home = home; self.master, self.slave = pty.openpty(); self.original = termios.tcgetattr(self.slave)
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 110, 0, 0))
        env = dict(os.environ, COTHINK_HOME=str(home), PI_OFFLINE='1', TERM='xterm-256color'); env.pop('COTHINK_NO_TTY', None)
        for key in list(env):
            if any(token in key.upper() for token in ['API_KEY', 'AUTH_TOKEN', 'ACCESS_KEY', 'CREDENTIAL', 'AWS_']): env.pop(key, None)
        if extra_env: env.update(extra_env)
        self.child = subprocess.Popen(['node', str(CLI), *args], cwd=home, stdin=self.slave, stdout=self.slave, stderr=self.slave, env=env, start_new_session=True)
        self.out = bytearray(); self.wait_text('预算：纯答')
    def pump(self):
        if select.select([self.master], [], [], .025)[0]:
            try: self.out.extend(os.read(self.master, 65536))
            except OSError as e:
                if e.errno != errno.EIO: raise
    def wait(self, condition):
        deadline = time.monotonic() + 8
        while not condition():
            self.pump()
            assert time.monotonic() < deadline, self.out.decode(errors='replace')[-5000:]
            assert self.child.poll() is None or condition(), self.out.decode(errors='replace')[-5000:]
    def wait_text(self, text, start=0): self.wait(lambda: text.encode() in self.out[start:])
    def send(self, text): os.write(self.master, text.encode()); self.pump()
    def command(self, text, marker):
        start = len(self.out); self.send('\x15' + text + '\r'); self.wait_text(marker, start)
    def assert_mode(self, label, count):
        self.wait(lambda: any('模式：' in line and label in line for line in visible_rows(self.out)))
        self.wait(lambda: any(f'预算：纯答 {count} 次' in line for line in visible_rows(self.out)))
        lines = visible_rows(self.out); mode_rows = [i for i, line in enumerate(lines) if '模式：' in line]
        assert len(mode_rows) == 1, lines
        assert mode_rows[0] >= len(lines) - 12, lines  # Near the editor, not an old chat message.
    def records(self):
        return [json.loads(p.read_text()) for p in (self.home / 'tasks').glob('*.json')]
    def ask(self, text, expected_models):
        before, n = len(calls), len(self.records())
        self.send('\x15' + text + '\r')
        self.wait(lambda: len(self.records()) == n + 1 and all(r['status'] == 'completed' for r in self.records()))
        self.wait(lambda: b'completed' in self.out)  # Allow host cleanup before the next command.
        time.sleep(.06); self.pump()
        assert [c['model'] for c in calls[before:]] == expected_models
    def stop(self):
        if self.child.poll() is None:
            os.kill(self.child.pid, signal.SIGTERM)
            deadline = time.monotonic() + 5
            while self.child.poll() is None and time.monotonic() < deadline: self.pump()
        assert self.child.poll() is not None
        assert termios.tcgetattr(self.slave) == self.original
        os.close(self.master); os.close(self.slave)

try:
    with tempfile.TemporaryDirectory(prefix='cothink-mode-pty-') as folder:
        home = Path(folder); seed(home); original = (home / 'config.json').read_bytes(); s = Session(home)
        try:
            s.assert_mode('COTHINK · 讨论', 3)
            screens['cothink'] = visible_rows(s.out)
            s.send('shortcut draft')
            s.send('\x1bm'); s.assert_mode('ONE · 单模型', 1)
            assert any('shortcut draft' in row for row in visible_rows(s.out))
            s.send('\x1bm'); s.assert_mode('COTHINK · 讨论', 3)
            s.send('\x1b[109;3u'); s.assert_mode('ONE · 单模型', 1)
            s.send('\x1b[200~µ\x1b[201~'); s.assert_mode('ONE · 单模型', 1)
            assert any('µ' in row for row in visible_rows(s.out))
            s.send('\x15')
            screens['one'] = visible_rows(s.out)
            s.send('/one\r'); time.sleep(.06); s.pump(); s.assert_mode('ONE · 单模型', 1)
            assert not calls and not s.records()
            s.ask('first persistent question', ['main']); s.ask('second persistent question', ['main'])
            assert all(r['singleModel'] and len(r['team']['secondary']) == 1 for r in s.records())
            assert 'first persistent question' in json.dumps(calls[-1], ensure_ascii=False)
            assert (home / 'config.json').read_bytes() == original
            checks.append('local idempotent switch, persistent one, shared context and unchanged team')
            s.command('/cothink', 'COTHINK · 讨论'); s.assert_mode('COTHINK · 讨论', 3)
            s.ask('/one temporary question', ['main']); s.assert_mode('COTHINK · 讨论', 3)
            s.ask('discussion after override', ['main', 'r1', 'main'])
            s.send('\x15\x1b[200~material\n/one\n/cothink\x1b[201~\r')
            s.wait(lambda: len(s.records()) == 5 and all(r['status'] == 'completed' for r in s.records()))
            assert len(calls) == 9
            s.assert_mode('COTHINK · 讨论', 3)
            s.command('/cothink unexpected', '不接受参数'); assert len(calls) == 9
            checks.append('cothink restores review; one-shot override and pasted commands do not change mode')
            s.command('/one', 'ONE · 单模型'); s.command('/reload', 'Reloaded keybindings'); s.assert_mode('ONE · 单模型', 1)
            session_path = next(p for p in (home / 'pi/sessions/main').rglob('*.jsonl'))
        finally: s.stop()
        s = Session(home, ('-c',))
        try:
            s.assert_mode('ONE · 单模型', 1); s.ask('after resume', ['main'])
            leaked = [m for c in calls for m in c['messages'] if re.search(r'customType.{0,12}cothink-mode', json.dumps(m))]
            assert not leaked, str(leaked)[:4000]
            checks.append('reload and resumed conversation restore mode without leaking control metadata')
            s.command('/clone', 'Cloned to new session'); s.assert_mode('ONE · 单模型', 1)
            s.command('/fork', 'Fork from Message'); s.send('\r'); s.wait_text('Forked to new session')
            s.assert_mode('ONE · 单模型', 1)
            s.command('/cothink', 'COTHINK · 讨论'); s.ask('branch question', ['main', 'r1', 'main'])
            before = len(calls); s.command('/one', 'ONE · 单模型')
            s.command('/tree', 'Session Tree'); s.send('branch question\r'); s.wait_text('Summarize branch?'); s.send('\r'); s.wait_text('Navigated to selected point')
            s.assert_mode('COTHINK · 讨论', 3); assert len(calls) == before
            s.command('/one', 'ONE · 单模型'); s.assert_mode('ONE · 单模型', 1)
            s.command('/new', 'New session started'); s.assert_mode('COTHINK · 讨论', 3)
            checks.append('clone/fork/tree follow branch ancestry; new conversation resets to cothink')
        finally: s.stop()
        # Remove only the mode entries while keeping a valid ancestry for an old conversation.
        entries = [json.loads(line) for line in session_path.read_text().splitlines()]
        removed = {e['id']: e.get('parentId') for e in entries if e.get('customType') == 'cothink-mode'}
        kept = [e for e in entries if e.get('customType') != 'cothink-mode']
        for entry in kept:
            while entry.get('parentId') in removed: entry['parentId'] = removed[entry['parentId']]
        session_path.write_text(''.join(json.dumps(e) + '\n' for e in kept))
        os.utime(session_path, (time.time() + 5, time.time() + 5))
        s = Session(home, ('-c',))
        try: s.assert_mode('COTHINK · 讨论', 3)
        finally: s.stop()
        checks.append('legacy conversation without mode metadata defaults to cothink')

    with tempfile.TemporaryDirectory(prefix='cothink-mode-busy-') as folder:
        home = Path(folder); seed(home); s = Session(home); before = len(calls)
        try:
            hold.set(); s.send('frozen discussion\r'); s.wait(lambda: len(calls) == before + 1)
            start = len(s.out); s.send('\x1bm'); s.wait_text('ONE · 单模型', start); s.assert_mode('ONE · 单模型', 3)
            assert len(calls) == before + 1
            hold.clear(); release.set(); s.wait(lambda: any(r['status'] == 'completed' for r in s.records()))
            s.assert_mode('ONE · 单模型', 1)
            assert [c['model'] for c in calls[before:]] == ['main', 'r1', 'main']
            s.ask('next solo', ['main'])
        finally: hold.clear(); release.set(); s.stop()
        checks.append('running task keeps frozen calls; mode switch and budget apply to next task')

    with tempfile.TemporaryDirectory(prefix='cothink-mode-fault-') as folder:
        home = Path(folder); seed(home); s = Session(home)
        try: s.ask('/one seed persisted session', ['main'])
        finally: s.stop()
        flag = home / 'fail-mode-write'; preload = home / 'fault.mjs'
        preload.write_text("import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const append=fs.appendFileSync; fs.appendFileSync=(p,v,...rest)=>{if(fs.existsSync(" + json.dumps(str(flag)) + ") && String(p).includes('/sessions/main/') && String(v).includes('cothink-mode')) throw Error('INJECTED_MODE_WRITE'); return append(p,v,...rest);};syncBuiltinESMExports();")
        s = Session(home, ('-c',), {'NODE_OPTIONS': '--import ' + str(preload)}); before = len(calls)
        try:
            flag.touch(); start = len(s.out); s.send('\x1bm'); s.wait_text('模式保存失败', start); s.assert_mode('COTHINK · 讨论', 3)
            flag.unlink(); s.command('/one must not send', '请重新打开对话'); assert len(calls) == before
        finally: s.stop()
        s = Session(home, ('-c',))
        try: s.assert_mode('COTHINK · 讨论', 3); s.ask('safe after reopen', ['main', 'r1', 'main'])
        finally: s.stop()
        checks.append('write failure keeps visible old mode, blocks unsafe continuation and reopens safely')

    with tempfile.TemporaryDirectory(prefix='cothink-mode-small-') as folder:
        home = Path(folder); seed(home); s = Session(home)
        try:
            s.command('/one', 'ONE · 单模型')
            start = len(s.out)
            fcntl.ioctl(s.slave, termios.TIOCSWINSZ, struct.pack('HHHH', 12, 40, 0, 0)); os.kill(s.child.pid, signal.SIGWINCH)
            s.wait(lambda: b'\x1b[?2026l' in s.out[start:])
            s.wait(lambda: any('模式：' in line and 'ONE' in line for line in visible_rows(s.out, 12, 40)))
            s.send('draft')
            s.wait(lambda: any('draft' in line for line in visible_rows(s.out, 12, 40)))
            assert any('模式：' in line and 'ONE' in line for line in visible_rows(s.out, 12, 40)), visible_rows(s.out, 12, 40)
            screens['one_40x12_with_draft'] = visible_rows(s.out, 12, 40)
        finally: s.stop()
        checks.append('mode remains visible next to editor after minimum-size terminal redraw')
finally:
    server.shutdown(); server.server_close()
print(json.dumps({'checks': checks, 'paidRequests': 0, 'localhostCalls': len(calls), 'screens': screens}, ensure_ascii=False, indent=2))
