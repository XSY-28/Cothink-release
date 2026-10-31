"""CoThink release summaries across real CLI restarts; mocked management HTTP, zero model requests."""
import errno, fcntl, hashlib, json, os, pty, select, signal, struct, subprocess, tempfile, termios, time
from pathlib import Path
from helpers.team_fixture import team_config

ROOT = Path(__file__).resolve().parents[1]
CLI = Path(os.environ.get('COTHINK_TEST_CLI', str(ROOT / 'bin/cothink.js'))).resolve()
checks = []

with tempfile.TemporaryDirectory(prefix='cothink-changelog-') as folder:
    home = Path(folder)
    (home / 'pi').mkdir()
    (home / 'config.json').write_text(json.dumps({'formatVersion': 2, 'main': {'provider': 'fixture', 'modelId': 'main'}, 'secondary': [{'provider': 'fixture', 'modelId': 'review'}]}))
    (home / 'pi/models.json').write_text(json.dumps({'providers': {'fixture': {'api': 'openai-completions', 'apiKey': 'local-only', 'baseUrl': 'http://127.0.0.1:1/v1', 'models': [{'id': m, 'name': m, 'reasoning': False, 'input': ['text'], 'contextWindow': 32000, 'maxTokens': 4096, 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}} for m in ['main', 'review']]}}}))
    (home / 'config.json').write_text(json.dumps(team_config(json.loads((home / 'config.json').read_text()))))
    version = json.loads((CLI.parent.parent / 'package.json').read_text())['version']
    network = home / 'network.jsonl'
    preload = home / 'network-fixture.mjs'
    dispatcher = (CLI.parent.parent / 'node_modules/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js').as_uri()
    preload.write_text("await import(" + json.dumps(dispatcher) + "); import {appendFileSync} from 'node:fs'; globalThis.fetch=async(input)=>{const url=String(input?.url ?? input); appendFileSync(" + json.dumps(str(network)) + ",JSON.stringify(url)+'\\n'); return url.includes('/api/latest-version') ? Response.json({version:'999.0.0'}) : new Response('',{status:404});};")
    # This fixture isolates the local changelog; startup update behavior has its own tests.
    env = dict(os.environ, COTHINK_HOME=folder, COTHINK_NO_UPDATE_CHECK='1', TERM='xterm-256color', NODE_OPTIONS='--import ' + str(preload))
    for name in ['PI_OFFLINE', 'PI_SKIP_VERSION_CHECK', 'COTHINK_NO_TTY']:
        env.pop(name, None)
    state = home / 'ui-state.json'

    def launch(label, expect_summary, full_log=False):
        master, slave = pty.openpty()
        original = termios.tcgetattr(slave)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 110, 0, 0))
        child = subprocess.Popen(['node', str(CLI), '-c'], cwd=home, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
        transcript = bytearray()
        def pump():
            if select.select([master], [], [], .03)[0]:
                try: transcript.extend(os.read(master, 65536))
                except OSError as e:
                    if e.errno != errno.EIO: raise
        def wait(condition):
            deadline = time.monotonic() + 8
            while not condition():
                pump()
                assert time.monotonic() < deadline, transcript.decode(errors='replace')[-4000:]
                assert child.poll() is None, 'unexpected CLI exit'
        def send(text):
            os.write(master, text.encode())
            pump()
        try:
            wait(lambda: '预算：纯答'.encode() in transcript)
            if expect_summary:
                wait(lambda: f'CoThink {version} 本次更新'.encode() in transcript and state.exists())
                assert version in json.loads(state.read_text())['shownReleaseVersions']
            time.sleep(.12); pump()
            assert (f'CoThink {version} 本次更新'.encode() in transcript) == expect_summary
            if full_log:
                saved_state = state.read_bytes()
                send('/changelog unexpected\r')
                wait(lambda: '/changelog 不接受参数'.encode() in transcript)
                send('\x15/changelog\r')
                wait(lambda: 'CoThink 完整更新记录'.encode() in transcript)
                # Read to the original entry without assuming a fixed number of releases/pages.
                deadline = time.monotonic() + 8
                while b'## 0.2.0-pi.1' not in transcript:
                    send('\x1b[6~')
                    assert time.monotonic() < deadline, transcript.decode(errors='replace')[-4000:]
                    assert child.poll() is None, 'unexpected CLI exit'
                assert b'pi.dev' not in transcript and b"What's New" not in transcript
                returned = len(transcript)
                send('\x1b')
                wait(lambda: '预算：纯答'.encode() in transcript[returned:])
                send('DRAFT_AFTER_CHANGELOG')
                wait(lambda: b'DRAFT_AFTER_CHANGELOG' in transcript)
                assert state.read_bytes() == saved_state, '/changelog must not change display state'
            assert not list((home / 'tasks').glob('*.json'))
            assert not list((home / 'requests').glob('*.json'))
            text = transcript.decode(errors='replace')
            assert 'Update Available' not in text and 'pi update' not in text
            send('\x03')
            os.kill(child.pid, signal.SIGTERM)
            deadline = time.monotonic() + 5
            while child.poll() is None and time.monotonic() < deadline: pump()
            assert child.poll() is not None
            assert termios.tcgetattr(slave) == original
            checks.append({'scenario': label, 'summaryShown': expect_summary, 'fullLogRead': full_log, 'modelCalls': 0, 'termiosRestored': True})
        finally:
            if child.poll() is None: child.kill(); child.wait()
            os.close(master); os.close(slave)

    launch('first-install', True, True)
    launch('same-version-restart', False)
    # A previous release's acknowledgement must not hide this release.
    state.write_text(json.dumps({'shownReleaseVersions': ['0.2.0-pi.4']}))
    launch('upgrade-first-start', True)
    launch('upgrade-next-start', False)
    # Return to an already displayed version after a later version: no repeat.
    state.write_text(json.dumps({'shownReleaseVersions': [version, '0.2.0-pi.6']}))
    launch('rollback-already-seen', False)
    state.write_text('{broken')
    launch('damaged-state-kept-readable', False, True)
    assert state.read_text() == '{broken'
    urls = [json.loads(line) for line in network.read_text().splitlines()] if network.exists() else []
    assert not any('/api/latest-version' in url or '/api/report-install' in url or 'registry.npmjs.org' in url or '/v1/' in url for url in urls), urls
print(json.dumps({'checks': checks, 'onlineUpdateChecks': 0, 'realGenerations': 0}, ensure_ascii=False, indent=2))
