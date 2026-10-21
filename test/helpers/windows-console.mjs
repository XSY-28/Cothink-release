// Run under ConPTY. The child has piped stdin and must reopen its real console.
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';
if (process.argv.includes('--probe')) {
  assert.equal(Boolean(process.stdin.isTTY), false);
  const cli = process.env.COTHINK_TEST_CLI ?? fileURLToPath(new URL('../../bin/cothink.js', import.meta.url));
  const { openTerminal } = await import(pathToFileURL(resolve(dirname(cli), '../src/terminal.js')));
  const terminal = openTerminal();
  assert.ok(terminal, 'piped Windows stdin must reopen CONIN$/CONOUT$');
  terminal.input.setRawMode(true);
  terminal.input.setRawMode(false);
  terminal.close();
  console.log('CONSOLE_REOPEN_OK');
} else {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--probe'], { stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end('pipe material, not configuration');
  child.once('error', error => { throw error; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
}
