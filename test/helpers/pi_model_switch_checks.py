"""Exercise host roster persistence through the real native model UI; localhost only."""
import errno, fcntl, json, os, pty, select, signal, struct, subprocess, tempfile, termios, threading, time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[2]
CLI = Path(os.environ.get('COTHINK_TEST_CLI', str(ROOT / 'bin/cothink.js')))
calls = []
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        calls.append(json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0')))))
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        for delta, reason in [({'role': 'assistant', 'content': 'Local fixture reply'}, None), ({}, 'stop')]:
            self.wfile.write(('data: ' + json.dumps({'id': 'fixture', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': reason}]}) + '\n\n').encode())
        self.wfile.write(b'data: [DONE]\n\n')
    def log_message(self, *args): pass
server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
with tempfile.TemporaryDirectory(prefix='cothink-model-switch-') as folder:
    home = Path(folder); (home / 'pi').mkdir()
    old = {'provider': 'fixture', 'modelId': 'main', 'thinkingLevel': 'high', 'maxOutputTokens': 2048}
    reviewer = {'provider': 'fixture', 'modelId': 'r1', 'maxOutputTokens': 4096}
    outside = {'provider': 'fixture', 'modelId': 'outside'}
    path = home / 'config.json'
    path.write_text(json.dumps({'formatVersion': 2, 'main': old, 'secondary': [reviewer]}))
    (home / 'pi/models.json').write_text(json.dumps({'providers': {'fixture': {
        'api': 'openai-completions', 'apiKey': 'local-only', 'baseUrl': f'http://127.0.0.1:{server.server_port}/v1',
        'models': [{'id': m, 'name': m, 'reasoning': m == 'main', 'input': ['text'], 'contextWindow': 32000, 'maxTokens': 4096,
                    'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}} for m in ['main', 'r1', 'outside']]
    }}}))
    master, slave = pty.openpty(); original = termios.tcgetattr(slave)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
    env = dict(os.environ, COTHINK_HOME=folder, PI_OFFLINE='1', TERM='xterm-256color')
    env.pop('COTHINK_NO_TTY', None)
    child = subprocess.Popen(['node', str(CLI)], cwd=home, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
    transcript = bytearray()
    def pump():
        if select.select([master], [], [], .02)[0]:
            try: transcript.extend(os.read(master, 65536))
            except OSError as e:
                if e.errno != errno.EIO: raise
    def wait(condition):
        end = time.monotonic() + 15
        while not condition():
            pump()
            assert time.monotonic() < end, transcript.decode(errors='replace')[-2000:]
            assert child.poll() is None, 'CLI exited before a selection was saved'
    def send(value):
        os.write(master, value.encode()); pump()
    def read(): return json.loads(path.read_text())
    def menu(command, offset=0):
        before = read(); start = len(transcript)
        send('\x15' + command + '\r')
        wait(lambda: '追加副模型'.encode() in transcript[start:] or b'Select model' in transcript[start:])
        assert '追加副模型'.encode() in transcript[start:], 'the alias must open the full model management menu'
        send('\r'); start = len(transcript)
        wait(lambda: '选择模型'.encode() in transcript[start:])
        if offset: send('\x1b[B' * offset)
        send('\r')
        wait(lambda: read() != before or '此协议要求'.encode() in transcript[start:])
        if read() == before: send('1024\r')
        wait(lambda: read() != before)
        return before
    try:
        wait(lambda: '预算：纯答'.encode() in transcript)
        start = len(transcript); send('/help\r')
        wait(lambda: '/models 设置'.encode() in transcript[start:])
        assert b'/model ' not in transcript[start:], 'help advertised the compatibility alias'
        menu('/model ')
        assert read()['secondary'] == [old, reviewer], 'alias discarded the previous primary or its settings'
        previous = read()['main']; menu('/models', 1)
        assert read()['secondary'] == [previous, old, reviewer], 'canonical menu discarded a model'
        saved = path.read_bytes(); start = len(transcript)
        send('\x15/models\r'); wait(lambda: '追加副模型'.encode() in transcript[start:]); send('\x1b')
        time.sleep(.05); pump(); assert path.read_bytes() == saved, 'cancelling changed the roster'
        for command in ['/model fixture/r1', '/models fixture/r1']:
            start = len(transcript); send('\x15' + command + '\r')
            wait(lambda: '/models 不接受参数'.encode() in transcript[start:])
            assert path.read_bytes() == saved
        for reload in [False, True]:
            if reload:
                start = len(transcript); send('\x15/reload\r')
                wait(lambda: b'Reloaded keybindings' in transcript[start:])
            start = len(transcript); send('\x15/mod')
            wait(lambda: '设置主模型和有序副模型'.encode() in transcript[start:])
            assert b'Select model (opens selector UI)' not in transcript[start:], 'completion exposed /model'
            send('\x03'); send('\x15')
        assert not calls and not list((home / 'requests').glob('*.json')), 'management generated a request'
        os.kill(child.pid, signal.SIGTERM)
        end = time.monotonic() + 5
        while child.poll() is None and time.monotonic() < end: pump()
        assert child.poll() == 0 and termios.tcgetattr(slave) == original
    finally:
        if child.poll() is None: child.kill(); child.wait()
        os.close(master); os.close(slave)
server.shutdown(); server.server_close()
print(json.dumps({'canonicalAndAliasMenus': 'passed', 'helpAndCompletion': 'canonical only, including reload', 'fixtureGenerations': len(calls), 'paidGenerations': 0, 'termiosRestored': True}))
