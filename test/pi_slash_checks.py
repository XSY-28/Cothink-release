"""Local-command regression through actual CLI/PTY; no paid providers or physical-terminal claims."""
import errno, fcntl, json, os, pty, select, signal, struct, subprocess, tempfile, termios, threading, time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
CLI = Path(os.environ.get('COTHINK_TEST_CLI', str(ROOT / 'bin/cothink.js')))
checks = []
calls = []
hold = threading.Event()
release = threading.Event()

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        calls.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
        if hold.is_set(): release.wait(10)
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        for delta, reason in [({'role': 'assistant', 'content': 'FIXTURE_REPLY'}, None), ({}, 'stop')]:
            self.wfile.write(('data: ' + json.dumps({'id': 'fixture', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': reason}]}) + '\n\n').encode())
        self.wfile.write(b'data: [DONE]\n\n')
    def log_message(self, *args):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
with tempfile.TemporaryDirectory(prefix='cothink-slash-') as folder:
    home = Path(folder)
    (home / 'pi').mkdir()
    extension = home / 'local-extension.ts'
    extension.write_text('import {writeFileSync} from "node:fs"; writeFileSync('+json.dumps(str(home / 'extension-loaded'))+',"unexpected"); export default function(pi) { pi.registerCommand("local-test", {description:"Local fixture", handler: async (args, ctx) => {ctx.ui.notify("LOCAL_DONE:" + args);}}); pi.registerCommand("forward-local", {description:"Host fallback fixture", handler: async () => {pi.sendUserMessage("/settings");}}); }')
    skill = home / 'skills/fixture-skill'
    skill.mkdir(parents=True)
    (skill / 'SKILL.md').write_text('---\nname: fixture-skill\ndescription: Local test skill\n---\nSKILL_MATERIAL_UNIQUE\n')
    prompt = home / 'fixture-prompt.md'
    prompt.write_text('---\ndescription: Local test prompt\n---\nPROMPT_MATERIAL_UNIQUE $@\n')
    (home / 'config.json').write_text(json.dumps({'formatVersion': 2, 'main': {'provider': 'fixture', 'modelId': 'main'}, 'secondary': [{'provider': 'fixture', 'modelId': 'r1'}], 'piResources': {'extensions': [str(extension)], 'skills': [str(skill)], 'prompts': [str(prompt)]}}))
    (home / 'pi/models.json').write_text(json.dumps({'providers': {'fixture': {'api': 'openai-completions', 'apiKey': 'local-only', 'baseUrl': f'http://127.0.0.1:{server.server_port}/v1', 'models': [{'id': m, 'name': m, 'reasoning': False, 'input': ['text'], 'contextWindow': 32000, 'maxTokens': 4096, 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}} for m in ['main', 'r1']]}}}))
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 110, 0, 0))
    env = dict(os.environ, COTHINK_HOME=folder, PI_OFFLINE='1', TERM='xterm-256color')
    env.pop('COTHINK_NO_TTY', None)
    rejected = subprocess.run(['node', str(CLI), 'ask', '--json', '/one boundary probe'], cwd=home, env=dict(env, COTHINK_NO_TTY='1'), capture_output=True, text=True)
    assert rejected.returncode != 0 and '扩展尚未适配agent-sync隔离合同，加载前拒绝' in (rejected.stdout + rejected.stderr), rejected.stdout + rejected.stderr
    assert not (home / 'extension-loaded').exists(), 'unadapted extension imported before rejection'
    assert calls == [], 'plugin rejection must happen before provider send'
    checks.append({'boundary': 'unadapted extension rejected before import', 'calls': 0})
    config = json.loads((home / 'config.json').read_text())
    config['piResources'].pop('extensions')
    (home / 'config.json').write_text(json.dumps(config))
    child = subprocess.Popen(['node', str(CLI)], cwd=home, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
    transcript = bytearray()
    def pump():
        if select.select([master], [], [], .03)[0]:
            try: transcript.extend(os.read(master, 65536))
            except OSError as e:
                if e.errno != errno.EIO: raise
    def wait(condition):
        end = time.monotonic() + 8
        while not condition():
            pump()
            assert time.monotonic() < end, transcript.decode(errors='replace')[-3000:]
            assert child.poll() is None, 'CLI exited early\n' + transcript.decode(errors='replace')[-4000:]
    def records():
        return list((home / 'tasks').glob('*.json'))
    def command(text, marker):
        start = len(transcript)
        os.write(master, ('\x15\x1b[200~' + text + '\x1b[201~\r').encode())
        wait(lambda: marker.encode() in transcript[start:] or calls or records())
        time.sleep(.05)
        pump()
        assert not calls, f'{text!r} generated {len(calls)} requests'
        assert not records(), f'{text!r} created a model task'
        checks.append({'input': text, 'calls': 0, 'tasks': 0})
    try:
        wait(lambda: '预算：纯答'.encode() in transcript)
        for name in ['settings', 'scoped-models', 'copy', 'session', 'changelog', 'hotkeys', 'fork', 'clone', 'tree', 'trust', 'logout', 'new', 'reload', 'debug', 'resume', 'quit', 'chat', 'models', 'model', 'help']:
            command('/' + name + ' unexpected', '/' + ('models' if name == 'model' else name) + ' 不接受参数')
        for text in ['/setting', '/unknown arg', '/skill:missing arg', '/MODEL main', '/', '/share', '/bug', '/arminsayshi', '/dementedelves', '/compact arg']:
            command(text, '未发送' if text != '/compact arg' else '尚未')
        command('/local-test hello', '未发送')
        command('/local-test\tworld', '未发送')
        command('/forward-local', '未发送')
        command('/name\tSLASH_AUDIT', 'Session name set: SLASH_AUDIT')
        def finished():
            return [json.loads(p.read_text()) for p in records() if json.loads(p.read_text())['status'] == 'completed']
        for text, count, material in [('/one plain question', 1, 'plain question'), ('/skill:fixture-skill explain', 3, 'SKILL_MATERIAL_UNIQUE'), ('/fixture-prompt explain', 3, 'PROMPT_MATERIAL_UNIQUE')]:
            before_calls, before_tasks = len(calls), len(finished())
            os.write(master, ('\x15' + text + '\r').encode())
            wait(lambda: len(finished()) == before_tasks + 1)
            assert len(calls) - before_calls == count
            assert material in json.dumps(calls[before_calls], ensure_ascii=False)
            checks.append({'input': text, 'calls': count, 'completed': True})
        # Pi buffers a new empty session; verify persistence after the first answer.
        assert any('SLASH_AUDIT' in p.read_text() for p in (home / 'pi/sessions/main').rglob('*.jsonl'))
        hold.set()
        before_calls = len(calls)
        os.write(master, b'\x15/one pending question\r')
        wait(lambda: len(calls) == before_calls + 1)
        for text in ['/new', '/settings', '/models', '/model', '/unknown', '/local-test busy']:
            start = len(transcript)
            os.write(master, ('\x15' + text + '\r').encode())
            wait(lambda: '任务仍在运行'.encode() in transcript[start:])
            assert len(calls) == before_calls + 1
        os.write(master, b'\x03')
        wait(lambda: any(json.loads(p.read_text())['status'] == 'cancelled' for p in records()))
        hold.clear(); release.set()
        time.sleep(.1); pump()
        assert len(calls) == before_calls + 1
        checks.append({'scenario': 'busy-local-commands-not-queued', 'calls': 1, 'cancelled': True})
        os.write(master, b'\x15/quit\r')
        end = time.monotonic() + 5
        while child.poll() is None and time.monotonic() < end: pump()
        assert child.poll() == 0
        assert termios.tcgetattr(slave) == original
    finally:
        release.set()
        if child.poll() is None: child.kill(); child.wait()
        os.close(master); os.close(slave)
server.shutdown(); server.server_close()
print(json.dumps({'checks': checks, 'realGenerations': 0, 'termiosRestored': True}, ensure_ascii=False, indent=2))
