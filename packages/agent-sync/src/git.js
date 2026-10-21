// C02/C05/C06/C09/C11: Git objects, never the user's index or checkout.
import { spawn } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  readdirSync,
  lstatSync,
  readFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { pathName, aliases, covers, problem } from "./scope.js";
import { digest } from "./storage.js";
const flags = [
  "--no-optional-locks",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "user.name=agent-sync",
  "-c",
  "user.email=agent-sync@localhost",
  "-c",
  "core.quotePath=false",
];
export function git(root, args, input, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    // No inherited Git selectors, hooks, credentials or config injected by a caller shell.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
    );
    const child = spawn("git", [...flags, ...args], {
      cwd: root,
      env: {
        ...env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out = [],
      err = [];
    child.stdout.on("data", (b) => out.push(b));
    child.stderr.on("data", (b) => err.push(b));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(out),
        stderr = Buffer.concat(err).toString();
      if (code === 0) resolve(stdout);
      else
        reject(
          Object.assign(problem("GIT", stderr), {
            exitCode: code,
            stdout,
            stderr,
          }),
        );
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
export const textGit = async (root, args, input) =>
  (await git(root, args, input)).toString().trim();
export async function entries(root, version) {
  const raw = await git(root, ["ls-tree", "-rz", "--full-tree", version]);
  const map = new Map();
  for (const record of raw.toString().split("\0").filter(Boolean)) {
    const [meta, path] = [
        record.slice(0, record.indexOf("\t")),
        record.slice(record.indexOf("\t") + 1),
      ],
      [mode, type, oid] = meta.split(" ");
    pathName(path);
    if (type !== "blob" || !["100644", "100755"].includes(mode))
      throw problem("UNSUPPORTED", "Source symlink/gitlink is unsupported", {
        path,
        mode,
      });
    map.set(path, { mode, oid });
  }
  aliases([...map.keys()], "PATH");
  return map;
}
export const sameEntry = (a, b) =>
  (a?.oid ?? null) === (b?.oid ?? null) &&
  (a?.mode ?? null) === (b?.mode ?? null);
export const changed = (a, b) =>
  [...new Set([...a.keys(), ...b.keys()])]
    .filter((p) => !sameEntry(a.get(p), b.get(p)))
    .sort();
export async function writeTree(root, map) {
  aliases([...map.keys()], "PATH");
  const tree = new Map();
  for (const [path, item] of map) {
    pathName(path);
    const parts = path.split("/");
    let at = tree;
    for (const part of parts.slice(0, -1)) {
      if (at.has(part) && !(at.get(part) instanceof Map))
        throw problem("PATH", "File/directory collision");
      if (!at.has(part)) at.set(part, new Map());
      at = at.get(part);
    }
    if (at.get(parts.at(-1)) instanceof Map)
      throw problem("PATH", "File/directory collision");
    at.set(parts.at(-1), item);
  }
  async function store(at) {
    const lines = [];
    for (const [name, value] of [...at].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const dir = value instanceof Map,
        oid = dir ? await store(value) : value.oid;
      lines.push(
        `${dir ? "040000" : value.mode} ${dir ? "tree" : "blob"} ${oid}\t${name}\0`,
      );
    }
    return textGit(root, ["mktree", "-z"], lines.join(""));
  }
  return store(tree);
}
export async function commit(root, tree, parents, metadata) {
  return textGit(
    root,
    ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p])],
    `agent-sync/1\n${JSON.stringify(metadata)}\n`,
  );
}
export async function metadata(root, version) {
  const raw = (await git(root, ["show", "-s", "--format=%B", version]))
    .toString()
    .trim();
  if (!raw.startsWith("agent-sync/1\n")) return null;
  try {
    return JSON.parse(raw.slice("agent-sync/1\n".length));
  } catch {
    return null;
  }
}
export async function merge(root, base, ours, theirs) {
  try {
    return {
      status: "merged",
      tree: await textGit(root, [
        "merge-tree",
        "--write-tree",
        "--merge-base=" + base,
        ours,
        theirs,
      ]),
    };
  } catch (e) {
    if (e.exitCode !== 1) throw e;
    return {
      status: "conflict",
      tree: e.stdout.toString().split("\n")[0],
      details: e.stdout.toString(),
    };
  }
}
export async function materialize(root, map, path) {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true, mode: 0o700 });
  for (const [name, item] of map) {
    const target = join(path, name);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, await git(root, ["cat-file", "blob", item.oid]), {
      mode: item.mode === "100755" ? 0o755 : 0o644,
    });
  }
}
export function scan(path, { artifacts = [], modes } = {}) {
  const map = new Map(),
    ignored = [];
  function walk(dir, prefix = "") {
    for (const name of readdirSync(dir).sort()) {
      const rel = prefix + name,
        full = join(dir, name),
        s = lstatSync(full);
      pathName(rel);
      if (covers(artifacts, rel)) {
        ignored.push(rel);
        continue;
      }
      if (s.isDirectory()) walk(full, rel + "/");
      else {
        if (!s.isFile() || s.nlink !== 1)
          throw problem(
            "UNSUPPORTED",
            "Only regular non-aliased source files may be imported",
            { path: rel },
          );
        const data = readFileSync(full);
        map.set(rel, {
          data,
          hash: digest(data),
          // NTFS stat does not represent Git's executable bit. Preserve the
          // authoritative tree mode; new Windows files default to non-executable.
          mode: process.platform === "win32"
            ? modes?.get(rel)?.mode ?? "100644"
            : s.mode & 0o111 ? "100755" : "100644",
        });
      }
    }
  }
  walk(path);
  aliases([...map.keys()], "PATH");
  return { map, ignored };
}
export async function assertProjection(root, map, path) {
  const actual = scan(path, { modes: map }).map;
  if (actual.size !== map.size)
    throw problem(
      "UNMANAGED_WRITE",
      "Workspace changed outside the managed interface",
      { path },
    );
  for (const [p, e] of map) {
    const a = actual.get(p);
    if (
      !a ||
      a.mode !== e.mode ||
      a.hash !== digest(await git(root, ["cat-file", "blob", e.oid]))
    )
      throw problem(
        "UNMANAGED_WRITE",
        "Workspace changed outside the managed interface",
        { path: p },
      );
  }
}
export async function diff(root, from, to) {
  const files = (
    await git(root, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--name-only",
      "-z",
      from,
      to,
      "--",
    ])
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  const stat = (
    await git(root, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--numstat",
      from,
      to,
      "--",
    ])
  ).toString();
  return {
    files,
    text: (
      await git(root, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--binary",
        from,
        to,
        "--",
      ])
    ).toString(),
    binaryFiles: stat
      .split("\n")
      .filter((l) => l.startsWith("-\t-\t"))
      .map((l) => l.slice(4)),
  };
}
