// C10: trusted local storage. Atomic snapshots and non-expiring owner generations.
// Algorithm adapted from CoThink src/storage.js; no application imports.
import {
  mkdirSync,
  chmodSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
  readFileSync,
  readdirSync,
  linkSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { hostname } from "node:os";
import { problem } from "./scope.js";
export function directory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}
export function atomic(path, value) {
  const tmp = path + "." + randomUUID() + ".tmp";
  let fd;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value) + "\n");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    const parent = openSync(dirname(path), "r");
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
}
export function load(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw problem(
      "CORRUPT",
      "Missing or corrupt metadata; original files preserved",
      { path, cause: e.code },
    );
  }
}
export const digest = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
    )
    .digest("hex");
export function ownerAt(path) {
  directory(path);
  const generations = () =>
    readdirSync(path)
      .filter((n) => /^[1-9]\d*\.json$/.test(n))
      .map((n) => Number(n.slice(0, -5)))
      .sort((a, b) => a - b);
  const previous = generations().at(-1) ?? 0;
  if (previous) {
    const p = load(join(path, previous + ".json"));
    if (
      p.hostname !== hostname() ||
      !Number.isSafeInteger(p.pid) ||
      p.pid < 1 ||
      typeof p.token !== "string"
    )
      throw problem("OWNER_UNKNOWN", "Cannot confirm previous owner");
    if (!existsSync(join(path, previous + ".released"))) {
      try {
        process.kill(p.pid, 0);
        throw problem("OWNER_BUSY", `Project owned by local pid ${p.pid}`);
      } catch (e) {
        if (e.code !== "ESRCH")
          throw e.code === "OWNER_BUSY"
            ? e
            : problem(
                "OWNER_UNKNOWN",
                "Previous owner cannot be confirmed dead",
              );
      }
    } else if (load(join(path, previous + ".released")).token !== p.token)
      throw problem("OWNER_UNKNOWN", "Invalid release record");
  }
  const generation = previous + 1,
    token = randomUUID(),
    claim = { generation, token, pid: process.pid, hostname: hostname() };
  const temp = join(path, token + ".tmp");
  atomic(temp, claim);
  try {
    linkSync(temp, join(path, generation + ".json"));
  } catch (e) {
    throw e.code === "EEXIST"
      ? problem("OWNER_BUSY", "Concurrent owner won the election")
      : e;
  } finally {
    unlinkSync(temp);
  }
  let released = false;
  function assert() {
    if (
      released ||
      generations().at(-1) !== generation ||
      load(join(path, generation + ".json")).token !== token ||
      existsSync(join(path, generation + ".released"))
    )
      throw problem("OWNER_LOST", "Owner generation is no longer authorized");
  }
  return {
    generation,
    token,
    assert,
    release() {
      if (released) return;
      assert();
      atomic(join(path, generation + ".released"), { token });
      released = true;
    },
  };
}
