"""Long CoThink menus through the installed CLI/PTY; only temporary fixture data."""
import errno, fcntl, json, os, pty, select, signal, struct, subprocess, tempfile, termios, time, uuid
from pathlib import Path
from terminal_screen import visible_rows
from team_fixture import team_config

ROOT = Path(__file__).resolve().parents[2]
CLI = Path(os.environ.get('COTHINK_TEST_CLI', str(ROOT / 'bin/cothink.js')))
checks, screens = [], {}

class Session:
    def __init__(self, home):
        self.home = home; self.rows, self.columns = 24, 80
        self.master, self.slave = pty.openpty(); self.original = termios.tcgetattr(self.slave)
        self.size(self.rows, self.columns)
        env = dict(os.environ, COTHINK_HOME=str(home), PI_OFFLINE='1', TERM='xterm-256color')
        env.pop('COTHINK_NO_TTY', None)
        for key in list(env):
            if any(token in key.upper() for token in ['API_KEY', 'AUTH_TOKEN', 'ACCESS_KEY', 'CREDENTIAL', 'AWS_']): env.pop(key, None)
        self.child = subprocess.Popen(['node', str(CLI)], cwd=home, stdin=self.slave, stdout=self.slave, stderr=self.slave, env=env, start_new_session=True)
        self.out = bytearray(); self.cache = None
        self.see('预算：纯答')
    def size(self, rows, columns):
        self.rows, self.columns = rows, columns
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
        if hasattr(self, 'child'): os.kill(self.child.pid, signal.SIGWINCH)
    def pump(self):
        if select.select([self.master], [], [], .025)[0]:
            try: self.out.extend(os.read(self.master, 65536))
            except OSError as error:
                if error.errno != errno.EIO: raise
    def screen(self):
        key = (len(self.out), self.rows, self.columns)
        if self.cache is None or self.cache[0] != key:
            self.cache = (key, '\n'.join(visible_rows(self.out, self.rows, self.columns)))
        return self.cache[1]
    def wait(self, condition):
        deadline = time.monotonic() + 12
        while not condition():
            self.pump()
            assert self.child.poll() is None, self.out.decode(errors='replace')[-4000:]
            assert time.monotonic() < deadline, self.screen()
    def see(self, text): self.wait(lambda: text in self.screen())
    def selected(self, text): self.wait(lambda: any('→' in line and text in line for line in self.screen().splitlines()))
    def send(self, text): os.write(self.master, text.encode()); self.pump()
    def command(self, text, marker): self.send('\x15' + text + '\r'); self.see(marker)
    def pick(self, index, marker): self.send('\x1b[H' + '\x1b[B' * index + '\r'); self.see(marker)
    def close_menu(self):
        self.send('\x1b'); self.wait(lambda: 'Esc取消' not in self.screen()); self.see('预算：纯答')
    def record(self, name):
        self.see('Esc取消')
        footer = next(line for line in self.screen().splitlines() if 'Esc取消' in line)
        assert footer.lstrip().startswith('↑↓/滚轮移动'), self.screen()
        screens[name] = self.screen(); checks.append(name)
    def stop(self):
        if self.child.poll() is None: self.child.terminate()
        deadline = time.monotonic() + 5
        while self.child.poll() is None and time.monotonic() < deadline: self.pump()
        assert self.child.poll() is not None, 'CLI did not exit after SIGTERM'
        assert termios.tcgetattr(self.slave) == self.original
        os.close(self.master); os.close(self.slave)

with tempfile.TemporaryDirectory(prefix='cothink-selectors-') as folder:
    home = Path(folder); (home / 'pi').mkdir()
    ref = lambda i: dict(provider='fixture', modelId=f'model-{i:03}')
    config = team_config(dict(formatVersion=2, main=ref(0), secondary=[ref(i) for i in range(1, 61)]), 'T00')
    for i in range(1, 70):
        config['teams'].append(dict(id=str(uuid.uuid4()), name=f'T{i:02}', main=ref(0), secondary=[ref(j) for j in range(1, 61)]))
    (home / 'config.json').write_text(json.dumps(config))
    # An unreachable localhost endpoint: management must create no generation records.
    provider = dict(api='openai-completions', apiKey='local-only', baseUrl='http://127.0.0.1:1/v1', models=[
        dict(id=f'model-{i:03}', name=f'model-{i:03}', reasoning=False, input=['text'], contextWindow=32000,
             maxTokens=4096, cost=dict(input=0, output=0, cacheRead=0, cacheWrite=0)) for i in range(180)])
    (home / 'pi/models.json').write_text(json.dumps(dict(providers=dict(fixture=provider))))
    s = Session(home)
    try:
        original = (home / 'config.json').read_bytes()
        auth = {p: p.read_bytes() for p in [home / 'pi/models.json', home / 'pi/auth.json'] if p.exists()}
        s.command('/team', '选择 team'); s.pick(2, '追加副模型'); s.pick(1, '选择模型')
        s.send('\x1b[B' * 65); s.selected('fixture/model-065'); s.record('model keyboard beyond first page at 80x24')
        s.send('\x1b[6~'); s.wait(lambda: 'model-065' not in next(line for line in s.screen().splitlines() if '→ fixture/' in line))
        s.send('\x1b[F'); s.selected('配置服务商或模型'); s.record('model tail and page navigation')
        s.send('\x1b[H'); s.selected('fixture/model-000')
        s.send('\x1b[<65;5;10M' * 70); s.selected('fixture/model-070')
        s.send('\x1b[<64;5;10M'); s.selected('fixture/model-069'); s.record('real SGR wheel down and up')
        s.size(12, 40); s.selected('fixture/model-069'); s.record('resize keeps selected model at 40x12')
        s.send('\x1b[F'); s.selected('配置服务商或模型'); s.send('\x1b[A'); s.selected('fixture/model-179')
        s.size(24, 80); s.selected('fixture/model-179')
        # Enter selects the model and saving is still an explicit new-Team action.
        s.send('\r'); s.see('保存为新 team'); s.pick(4, '新 team 名称'); s.send('Added deputy\r'); s.see('从下一条任务生效')
        saved = json.loads((home / 'config.json').read_text())
        assert saved['teams'][:70] == config['teams']
        assert saved['teams'][-1]['secondary'][-1] == ref(179)
        assert len(saved['teams'][-1]['secondary']) == 61
        checks.append('model at tail saves exactly and original teams remain')
        original = (home / 'config.json').read_bytes()
        # Both model selection routes and new-Team creation share the viewport.
        s.command('/models', '追加副模型'); s.pick(1, '选择模型'); s.send('\x1b[F\r'); s.see('副服务商')
        s.send('\x1b[F'); s.selected('自定义服务商'); s.record('provider list tail')
        # Cancelling provider setup returns to the unsaved roster, then Esc closes that editor.
        s.send('\x1b'); s.see('保存为新 team'); s.close_menu(); assert (home / 'config.json').read_bytes() == original
        s.command('/team', '选择 team'); s.pick(1, '选择模型'); s.send('\x1b[F'); s.selected('配置服务商或模型'); s.record('new team model list'); s.close_menu()
        # Long team titles, selection and deletion lists cannot cover their controls.
        s.command('/team', '选择 team'); s.record('long team title bounded'); s.pick(0, '选择 team（下一条生效）')
        s.send('\x1b[F'); s.selected('Added deputy'); s.record('team list tail'); s.close_menu()
        s.command('/team', '选择 team'); s.pick(3, '删除 team（保留')
        s.send('\x1b[F\x1b[A'); s.selected('T69'); s.record('delete team list tail'); s.send('\r'); s.see('删除 team「T69」')
        s.selected('Yes'); s.record('long roster confirmation retains choices'); s.close_menu()
        # Removal/reordering need to reach the last deputy; cancellation never saves drafts.
        for index, title in [(2, '移除后后位自然补位'), (3, '移到第一位')]:
            s.command('/models', '追加副模型'); s.pick(index, title); s.send('\x1b[F'); s.selected('fixture/model-179')
            s.record(title); s.send('\r'); s.see('保存为新 team'); s.close_menu()
        assert (home / 'config.json').read_bytes() == original
        assert all(p.read_bytes() == content for p, content in auth.items())
        assert not list((home / 'requests').glob('*.json')) and not list((home / 'tasks').glob('*.json'))
        checks.append('cancel preserves config/auth; management creates zero tasks or requests')
    finally: s.stop()

print(json.dumps(dict(checks=checks, screens=screens), ensure_ascii=False, indent=2))
