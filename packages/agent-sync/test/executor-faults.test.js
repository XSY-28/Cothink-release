import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { repository } from "./helpers/repository.js";
const execution = JSON.parse(
  readFileSync(
    new URL(
      "../execution-manifest.json",
      import.meta.url,
    ),
  ),
).execution;
for (const scenario of ["pause", "daemon"])
  test(
    "C08 real Docker with injected " +
      scenario +
      " CLI failure is unknown and does not release unconfirmed execution",
    (t) => {
      const repo = repository(t),
        config = join(repo.root, "config.json");
      writeFileSync(config, JSON.stringify({ ...repo, execution }));
      const r = spawnSync(
        process.execPath,
        [
          new URL("./helpers/docker-fault-worker.js", import.meta.url).pathname,
          config,
          scenario,
        ],
        { encoding: "utf8", timeout: 20000 },
      );
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.equal(JSON.parse(r.stdout.trim()).status, "passed");
    },
  );

test("C08 partial filesystem writes cannot silently truncate the command log", async (t) => {
  const { backend, begin } = await import("./helpers/repository.js"),
    { createRequire, syncBuiltinESMExports } = await import("node:module");
  const fs = createRequire(import.meta.url)("node:fs");
  const { v } = await backend(t, { execution }),
    c = await begin(v, "short-log");
  const original = fs.writeSync;
  try {
    fs.writeSync = (
      fd,
      buffer,
      offset = 0,
      length = buffer.length - offset,
      position = null,
    ) => original(fd, buffer, offset, Math.min(length, 3), position);
    syncBuiltinESMExports();
    const r = await v.exec(c.changeId, {
      requestId: "short-write",
      expectedVersion: c.privateVersion,
      command: "printf 1234567890",
    });
    assert.equal(r.status, "completed");
    const log = await v.read({ outputRef: r.outputRef });
    assert.equal(
      Buffer.from(log.contentBase64, "base64").toString(),
      "1234567890",
    );
  } finally {
    fs.writeSync = original;
    syncBuiltinESMExports();
  }
});

test("C08 disk-full log failure stops execution and preserves partial output without importing effects", async (t) => {
  const { backend, begin } = await import("./helpers/repository.js"),
    { createRequire, syncBuiltinESMExports } = await import("node:module");
  const fs = createRequire(import.meta.url)("node:fs");
  const { v } = await backend(t, { execution }),
    c = await begin(v, "disk-full");
  const original = fs.writeSync,
    originalOpen = fs.openSync;
  let logDescriptor;
  let writes = 0;
  try {
    fs.openSync = (path, ...args) => {
      const fd = originalOpen(path, ...args);
      if (typeof path === "string" && path.endsWith("/full-log.log"))
        logDescriptor = fd;
      return fd;
    };
    fs.writeSync = (
      fd,
      buffer,
      offset = 0,
      length = buffer.length - offset,
      position = null,
    ) => {
      if (fd !== logDescriptor)
        return original(fd, buffer, offset, length, position);
      if (writes++ > 0) {
        logDescriptor = undefined;
        throw Object.assign(Error("injected disk full"), { code: "ENOSPC" });
      }
      return original(fd, buffer, offset, Math.min(length, 3), position);
    };
    syncBuiltinESMExports();
    const r = await v.exec(c.changeId, {
      requestId: "full-log",
      expectedVersion: c.privateVersion,
      command: "printf unimported > a.txt; printf 1234567890",
    });
    assert.equal(r.status, "unknown");
    assert.equal(
      (await v.inspect({ changeId: c.changeId })).privateVersion,
      c.privateVersion,
    );
    assert.equal(
      Buffer.from(
        (await v.read({ outputRef: "full-log" })).contentBase64,
        "base64",
      ).toString(),
      "123",
    );
  } finally {
    fs.openSync = originalOpen;
    fs.writeSync = original;
    syncBuiltinESMExports();
  }
});
