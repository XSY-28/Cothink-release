import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const cli =
  process.env.COTHINK_TEST_CLI ??
  fileURLToPath(new URL("../../bin/cothink.js", import.meta.url));
export function invoke(f, args, input = "", cwd = f.cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: {
        ...process.env,
        COTHINK_HOME: f.home,
        COTHINK_NO_TTY: "1",
        PI_OFFLINE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [],
      stderr = [];
    child.stdout.on("data", (d) => stdout.push(d));
    child.stderr.on("data", (d) => stderr.push(d));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
    child.stdin.end(input);
  });
}
