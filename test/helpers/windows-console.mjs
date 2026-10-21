// Run under ConPTY. The child has piped stdin and must reopen its real console.
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { openSync, closeSync } from 'node:fs';
import { ReadStream, WriteStream, isatty } from 'node:tty';
if (process.argv.includes('--probe')) {
  assert.equal(Boolean(process.stdin.isTTY), false);
  const cli = process.env.COTHINK_TEST_CLI ?? fileURLToPath(new URL('../../bin/cothink.js', import.meta.url));
  const { openTerminal } = await import(pathToFileURL(resolve(dirname(cli), '../src/terminal.js')));
  const terminal = openTerminal();
  if (!terminal) {
    console.error(JSON.stringify({ platform: process.platform, noTTY: process.env.COTHINK_NO_TTY, stdoutTTY: process.stdout.isTTY }));
    const devices = [
      ['\\\\?\\GLOBALROOT\\Device\\ConDrv\\CurrentIn', ReadStream],
      ['\\\\?\\GLOBALROOT\\Device\\ConDrv\\CurrentOut', WriteStream],
    ];
    for (const [name, Stream] of devices) {
      let fd, stream;
      try {
        fd = openSync(name, 'r+');
        console.error(JSON.stringify({ name, fd, isTTY: isatty(fd) }));
        stream = new Stream(fd);
        stream.setRawMode?.(true);
        stream.setRawMode?.(false);
        console.error(JSON.stringify({ name, initialized: true }));
      } catch (error) { console.error(JSON.stringify({ name, error: error.message, code: error.code, syscall: error.syscall })); }
      finally { if (stream) stream.destroy(); else if (fd !== undefined) closeSync(fd); }
    }
  }
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
