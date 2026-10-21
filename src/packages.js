import { parseArgs } from "node:util";
import {
  readFileSync,
  existsSync,
  realpathSync,
  readdirSync,
  lstatSync,
  readlinkSync,
  cpSync,
  renameSync,
  unlinkSync,
  rmSync,
  openSync,
  closeSync,
  writeSync,
} from "node:fs";
import {
  join,
  resolve,
  relative,
  isAbsolute,
  basename,
  extname,
} from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DefaultPackageManager,
  SettingsManager,
  loadSkills,
  parseFrontmatter,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  privateDirectory,
  writePrivateJson,
  writePrivateBytes,
  acquirePackageLock,
  assertNoActivePiSessions,
} from "./storage.js";

const commands = new Set(["install", "list", "remove"]);
const reserved = new Set(["update", "uninstall", "config"]);
const failure = (code, message) => Object.assign(new Error(message), { code });
const kinds = ["extensions", "skills", "prompts", "themes"];
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const sourceOf = (entry) => (typeof entry === "string" ? entry : entry.source);
const inside = (root, path) => {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!/^\.\.(?:[\\/]|$)/.test(rel) && !isAbsolute(rel))
  );
};
const npmCommand = (offline) => [
  "npm",
  "--ignore-scripts",
  "--save-exact",
  "--no-audit",
  "--no-fund",
  "--no-update-notifier",
  ...(offline ? ["--offline"] : []),
];
function packageManager(agentDir, entries, offline = true) {
  const settings = SettingsManager.inMemory(
    { packages: entries, npmCommand: npmCommand(offline) },
    { projectTrusted: false },
  );
  return {
    settings,
    manager: new DefaultPackageManager({
      cwd: agentDir,
      agentDir,
      settingsManager: settings,
      builtinExtensions: [],
    }),
  };
}
function readSettings(agentDir) {
  let value;
  try {
    value = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw failure(
      "PACKAGE_SETTINGS",
      "包登记无法读取或 JSON 损坏；原文件保留。",
    );
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value.packages !== undefined && !Array.isArray(value.packages))
  )
    throw failure("PACKAGE_SETTINGS", "包登记格式损坏；原文件保留。");
  const names = new Set();
  for (const entry of value.packages ?? []) {
    if (
      typeof entry !== "string" &&
      (!entry || typeof entry !== "object" || Array.isArray(entry))
    )
      throw failure("PACKAGE_SETTINGS", "包登记项目无效。");
    const parsed = parsePackageSource(sourceOf(entry));
    if (!exactVersion.test(parsed.version ?? "") || names.has(parsed.name))
      throw failure("PACKAGE_SETTINGS", "包登记必须使用唯一包身份与精确版本。");
    names.add(parsed.name);
    if (typeof entry === "object") {
      for (const key of kinds)
        if (
          entry[key] !== undefined &&
          (!Array.isArray(entry[key]) ||
            entry[key].some((x) => typeof x !== "string"))
        )
          throw failure("PACKAGE_SETTINGS", "包登记资源过滤无效。");
      if (entry.autoload !== undefined && typeof entry.autoload !== "boolean")
        throw failure("PACKAGE_SETTINGS", "包登记 autoload 无效。");
    }
  }
  return value;
}
function manualResources(home) {
  let config;
  try {
    config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw failure(
      "PACKAGE_CONFIG",
      "本地 config.json 无法读取；包管理不启动设置向导。",
    );
  }
  const r = config?.piResources === undefined ? {} : config.piResources;
  if (!r || typeof r !== "object" || Array.isArray(r))
    throw failure("PACKAGE_CONFIG", "piResources 格式无效。");
  for (const k of [...kinds, "tools"])
    if (
      r[k] !== undefined &&
      (!Array.isArray(r[k]) ||
        r[k].some((p) => typeof p !== "string" || !p.trim()))
    )
      throw failure("PACKAGE_CONFIG", "piResources 必须使用非空字符串数组。");
  return r;
}
function checkTree(root, path = root, seen = new Set()) {
  const real = realpathSync(path);
  if (!inside(root, real))
    throw failure("PACKAGE_RESOURCE_ESCAPE", "包资源含有包外符号链接。");
  if (seen.has(real)) return;
  seen.add(real);
  const stat = lstatSync(real);
  if (stat.isDirectory())
    for (const name of readdirSync(real))
      checkTree(root, join(real, name), seen);
  else if (!stat.isFile())
    throw failure("PACKAGE_RESOURCE_INVALID", "包资源不是普通文件。");
}
function checkManifest(root, manifest) {
  if (
    manifest.pi !== undefined &&
    (!manifest.pi ||
      typeof manifest.pi !== "object" ||
      Array.isArray(manifest.pi))
  )
    throw failure("PACKAGE_RESOURCE_INVALID", "Pi manifest 无效。");
  for (const kind of kinds) {
    const entries = manifest.pi?.[kind];
    if (entries === undefined) continue;
    if (!Array.isArray(entries) || entries.some((p) => typeof p !== "string"))
      throw failure(
        "PACKAGE_RESOURCE_INVALID",
        "Pi manifest 路径必须是字符串数组。",
      );
    for (const entry of entries) {
      const p = entry.replace(/^[!+-]/, "");
      if (
        !p ||
        isAbsolute(p) ||
        p.includes("\\") ||
        !inside(root, resolve(root, p))
      )
        throw failure(
          "PACKAGE_RESOURCE_ESCAPE",
          "Pi manifest 引用了包外路径。",
        );
      if (
        !/^[!+-]/.test(entry) &&
        !/[?*\[\]{}]/.test(p) &&
        !existsSync(resolve(root, p))
      )
        throw failure(
          "PACKAGE_RESOURCE_INVALID",
          "包声明的资源尚未生成或缺失：" + p,
        );
    }
  }
  checkTree(root);
}
function themeName(path) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  const required =
    "accent border borderAccent borderMuted success error warning muted dim text thinkingText selectedBg userMessageBg userMessageText customMessageBg customMessageText customMessageLabel toolPendingBg toolSuccessBg toolErrorBg toolTitle toolOutput mdHeading mdLink mdLinkUrl mdCode mdCodeBlock mdCodeBlockBorder mdQuote mdQuoteBorder mdHr mdListBullet toolDiffAdded toolDiffRemoved toolDiffContext syntaxComment syntaxKeyword syntaxFunction syntaxVariable syntaxString syntaxNumber syntaxType syntaxOperator syntaxPunctuation thinkingOff thinkingMinimal thinkingLow thinkingMedium thinkingHigh thinkingXhigh bashMode".split(
      " ",
    );
  if (
    typeof data.name !== "string" ||
    !data.name.trim() ||
    !data.colors ||
    required.some((k) => !Object.hasOwn(data.colors, k)) ||
    (data.appearance !== undefined &&
      !["dark", "light"].includes(data.appearance))
  )
    throw failure("PACKAGE_RESOURCE_INVALID", "Pi 主题格式无效：" + path);
  const color = (value, seen = new Set()) => {
    if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= 255
    )
      return value;
    if (typeof value !== "string")
      throw failure("PACKAGE_RESOURCE_INVALID", "主题颜色格式无效。");
    if (Object.hasOwn(data.vars ?? {}, value)) {
      if (seen.has(value))
        throw failure("PACKAGE_RESOURCE_INVALID", "主题变量循环。");
      return color(data.vars[value], new Set([...seen, value]));
    }
    return value;
  };
  const colors = Object.fromEntries(
    Object.entries(data.colors).map(([k, v]) => [k, color(v)]),
  );
  new Theme(colors, colors, "truecolor", { name: data.name });
  return data.name;
}
function dataIdentities(kind, path, cwd, home) {
  if (kind === "skills") {
    const found = loadSkills({
      cwd,
      agentDir: join(home, "pi"),
      skillPaths: [path],
      includeDefaults: false,
    });
    if (found.diagnostics.length || !found.skills.length)
      throw failure(
        "PACKAGE_RESOURCE_INVALID",
        "技能无法解析：" +
          path +
          " " +
          found.diagnostics.map((d) => d.message).join("；"),
      );
    return found.skills.map((s) => ({
      name: s.name,
      path: realpathSync(s.filePath),
    }));
  }
  if (lstatSync(path).isDirectory())
    return readdirSync(path).flatMap((n) =>
      dataIdentities(kind, join(path, n), cwd, home),
    );
  if (kind === "prompts") {
    if (extname(path) !== ".md") return [];
    parseFrontmatter(readFileSync(path, "utf8"));
    return [{ name: basename(path, ".md"), path: realpathSync(path) }];
  }
  return extname(path) === ".json"
    ? [{ name: themeName(path), path: realpathSync(path) }]
    : [];
}
// Same command namespace as the native host, including its hidden compatibility alias.
const localNames = new Set(
  "one cothink chat team models model help settings scoped-models thinking export import copy name session changelog hotkeys fork clone tree trust login logout new reload debug resume quit compact install list remove update uninstall config".split(
    " ",
  ),
);
function validateDataResources(rows, manual, cwd, home) {
  for (const kind of ["skills", "prompts", "themes"]) {
    const names = new Map();
    const add = (path) => {
      for (const item of dataIdentities(kind, path, cwd, home)) {
        if (
          kind === "prompts" &&
          (localNames.has(item.name) || item.name.startsWith("skill:"))
        )
          throw failure(
            "PACKAGE_RESOURCE_CONFLICT",
            "提示模板不能覆盖本地命令：/" + item.name,
          );
        if (names.has(item.name) && names.get(item.name) !== item.path)
          throw failure(
            "PACKAGE_RESOURCE_CONFLICT",
            `${kind} 名称冲突 ${item.name}：${names.get(item.name)}；${item.path}`,
          );
        names.set(item.name, item.path);
      }
    };
    for (const p of manual[kind] ?? []) add(resolve(cwd, p));
    for (const row of rows)
      for (const r of row.resources)
        if (r.kind === kind && r.enabled) add(r.path);
  }
}

async function inspectPackages({
  home,
  cwd = process.cwd(),
  agentDir = join(home, "pi"),
  settings = readSettings(agentDir),
  manual = manualResources(home),
}) {
  const rows = [];
  for (const entry of settings.packages ?? []) {
    const source = sourceOf(entry),
      { name, version } = parsePackageSource(source);
    const row = { source, name, version, status: "missing", resources: [] };
    rows.push(row);
    const expected = join(agentDir, "npm", "node_modules", name);
    if (!existsSync(expected)) {
      row.reason = "受管安装缺失；不读取普通 Pi/global npm 回退。";
      continue;
    }
    try {
      const prefix = realpathSync(agentDir),
        root = realpathSync(expected);
      if (root !== join(prefix, "npm", "node_modules", name))
        throw failure("PACKAGE_RESOURCE_ESCAPE", "包安装不属于受管 prefix。");
      row.installedPath = root;
      const manifest = JSON.parse(
        readFileSync(join(root, "package.json"), "utf8"),
      );
      if (manifest.name !== name || manifest.version !== version)
        throw failure(
          "PACKAGE_CONTENT_MISMATCH",
          "安装内容不符：登记版本与文件不一致。",
        );
      checkManifest(root, manifest);
      const { manager } = packageManager(agentDir, [entry]);
      const configured = manager.listConfiguredPackages();
      if (
        configured.length !== 1 ||
        manager.getInstalledPath(source, "user") !== expected
      )
        throw failure(
          "PACKAGE_CONTENT_MISMATCH",
          "安装内容不符：Pi 来源定位不一致。",
        );
      const found = await manager.resolve(async () => "error");
      for (const kind of kinds)
        for (const r of found[kind]) {
          if (
            r.metadata.origin !== "package" ||
            r.metadata.source !== source ||
            !r.metadata.packageRoot ||
            realpathSync(r.metadata.packageRoot) !== root
          )
            continue;
          const path = realpathSync(r.path);
          if (!inside(root, path))
            throw failure("PACKAGE_RESOURCE_ESCAPE", "包资源 realpath 越界。");
          row.resources.push({
            kind,
            path,
            enabled: kind !== "extensions" && r.enabled,
            ...(kind === "extensions"
              ? { reason: "JavaScript 扩展尚未适配 agent-sync；未加载。" }
              : !r.enabled
                ? { reason: "包资源过滤已禁用。" }
                : {}),
          });
        }
      if (!row.resources.length)
        throw failure("NO_PI_RESOURCES", "包没有可识别的 Pi 资源。");
      validateDataResources([row], {}, cwd, home);
      const enabled = row.resources.filter((r) => r.enabled).length;
      row.status =
        enabled === row.resources.length
          ? "enabled"
          : enabled
            ? "partial"
            : "blocked";
    } catch (error) {
      row.status = "broken";
      row.reason = error.message;
      row.code =
        error.code?.startsWith("PACKAGE_") || error.code === "NO_PI_RESOURCES"
          ? error.code
          : "PACKAGE_RESOURCE_INVALID";
      row.resources.forEach((r) => (r.enabled = false));
    }
  }
  try {
    validateDataResources(rows, manual, cwd, home);
  } catch (error) {
    for (const row of rows.filter(
      (r) => r.status !== "missing" && r.status !== "broken",
    )) {
      row.status = "broken";
      row.reason = error.message;
      row.code = error.code ?? "PACKAGE_RESOURCE_INVALID";
      row.resources.forEach((r) => (r.enabled = false));
    }
    if (!rows.length) throw error;
  }
  return rows;
}
export async function listPackages(options) {
  const lock = acquirePackageLock(options.home);
  try {
    if (existsSync(join(options.home, "pi", "package-operation.json")))
      throw failure(
        "PACKAGE_RECOVERY_REQUIRED",
        "包提交尚未完成；请明确执行 install/remove 恢复。",
      );
    return await inspectPackages(options);
  } finally {
    lock.release();
  }
}
export async function resolvePackageResources(options) {
  const rows = await inspectPackages(options);
  const invalid = rows.filter((r) => ["missing", "broken"].includes(r.status));
  if (invalid.length)
    throw failure(
      "PACKAGE_UNAVAILABLE",
      invalid.map((r) => `${r.source}：${r.reason}`).join("\n"),
    );
  const snapshot = {
    packages: rows.map(({ source, name, version }) => ({
      source,
      name,
      version,
    })),
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
    diagnostics: [],
  };
  for (const row of rows)
    for (const r of row.resources) {
      if (r.enabled) snapshot[r.kind].push(r.path);
      else
        snapshot.diagnostics.push({
          source: row.source,
          path: r.path,
          reason: r.reason,
        });
    }
  return snapshot;
}

export function parsePackageSource(source) {
  const match =
    typeof source === "string" &&
    /^npm:((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@([a-zA-Z0-9][a-zA-Z0-9._+-]*))?$/.exec(
      source,
    );
  if (!match || match[1].split("/").some((p) => p === "." || p === ".."))
    throw failure(
      "PACKAGE_USAGE",
      "仅支持 npm:包名、npm:@scope/包名，可带精确版本或 tag；不支持 Git/URL/本地路径。",
    );
  if (/(^|[/@-])(subagents?|agent-teams)([-.]|$)/i.test(match[1]))
    throw failure(
      "PACKAGE_FORBIDDEN",
      "当前用户禁止安装或加载 subagent/agent-teams 插件。",
    );
  return { name: match[1], version: match[2] };
}

// Runs before the model/setup argument parser, including its error path.
export function parsePackageCommand(args) {
  let command;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") {
      command = args[i + 1];
      break;
    }
    if (["--thinking", "--max-output-tokens", "--timeout"].includes(args[i])) {
      i++;
      continue;
    }
    if (!args[i].startsWith("-")) {
      command = args[i];
      break;
    }
  }
  if (!commands.has(command) && !reserved.has(command)) return;
  const json = args.includes("--json");
  try {
    if (!commands.has(command))
      throw failure(
        "PACKAGE_USAGE",
        "包管理用法：cothink install npm:包名 | list | remove npm:包名 [--json]",
      );
    const parsed = parseArgs({
      args,
      allowPositionals: true,
      options: { json: { type: "boolean" } },
    });
    const [actual, ...sources] = parsed.positionals;
    if (actual !== command || sources.length !== (command === "list" ? 0 : 1))
      throw failure(
        "PACKAGE_USAGE",
        "包管理用法：cothink install npm:包名 | list | remove npm:包名 [--json]",
      );
    if (sources[0]) parsePackageSource(sources[0]);
    return { command, source: sources[0], json };
  } catch (error) {
    return {
      command,
      json,
      error: {
        code: error.code?.startsWith("PACKAGE_") ? error.code : "PACKAGE_USAGE",
        message: error.message,
      },
    };
  }
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function optionalBytes(path) {
  try {
    return readFileSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
const bytesHash = (bytes) => (bytes === null ? null : digest(bytes));
function treeHash(path) {
  if (!existsSync(path)) return null;
  const entries = [];
  const visit = (p) => {
    const stat = lstatSync(p),
      name = relative(path, p);
    if (stat.isSymbolicLink()) entries.push([name, "link", readlinkSync(p)]);
    else if (stat.isDirectory()) {
      entries.push([name, "dir"]);
      for (const n of readdirSync(p).sort()) visit(join(p, n));
    } else if (stat.isFile())
      entries.push([name, "file", stat.mode & 0o777, digest(readFileSync(p))]);
    else throw failure("PACKAGE_STORAGE", "受管安装中有不支持的文件类型。");
  };
  if (lstatSync(path).isSymbolicLink())
    throw failure("PACKAGE_STORAGE", "受管 npm prefix 不能是符号链接。");
  visit(path);
  return digest(JSON.stringify(entries));
}
function packageState(agentDir) {
  return {
    npm: treeHash(join(agentDir, "npm")),
    settings: bytesHash(optionalBytes(join(agentDir, "settings.json"))),
  };
}
function sameState(a, b) {
  return a.npm === b.npm && a.settings === b.settings;
}

// Recovery only rolls back a verified interrupted publication. No npm/model retry.
function recoverOperation(home, lock) {
  const agentDir = join(home, "pi"),
    path = join(agentDir, "package-operation.json");
  if (!existsSync(path)) return;
  let j;
  try {
    j = JSON.parse(readFileSync(path, "utf8"));
    if (
      j.version !== 1 ||
      !/^package-candidate-[0-9a-f-]{36}$/.test(basename(j.candidate)) ||
      resolve(j.candidate) !== join(resolve(agentDir), basename(j.candidate)) ||
      !j.before ||
      !j.after ||
      ![j.before.npm, j.before.settings, j.after.npm, j.after.settings].every(
        (h) => h === null || /^[a-f0-9]{64}$/.test(h),
      ) ||
      bytesHash(
        j.oldSettings === null ? null : Buffer.from(j.oldSettings, "base64"),
      ) !== j.before.settings
    )
      throw Error("invalid journal");
    lock.assertOwned();
    const current = packageState(agentDir),
      backup = join(j.candidate, "previous-npm"),
      backupHash = treeHash(backup);
    if (
      ![j.before.settings, j.after.settings].includes(current.settings) ||
      ![null, j.before.npm, j.after.npm].includes(current.npm)
    )
      throw Error("independent edit");
    if (
      j.before.npm !== null &&
      current.npm !== j.before.npm &&
      backupHash !== j.before.npm
    )
      throw Error("missing backup");
    if (backupHash !== null && backupHash !== j.before.npm)
      throw Error("backup changed");
    if (current.npm !== j.before.npm) {
      if (current.npm !== null)
        renameSync(
          join(agentDir, "npm"),
          join(j.candidate, "failed-published-npm"),
        );
      if (j.before.npm !== null) renameSync(backup, join(agentDir, "npm"));
    }
    if (j.oldSettings === null) {
      if (existsSync(join(agentDir, "settings.json")))
        unlinkSync(join(agentDir, "settings.json"));
    } else
      writePrivateBytes(
        join(agentDir, "settings.json"),
        Buffer.from(j.oldSettings, "base64"),
        lock.assertOwned,
      );
    if (!sameState(packageState(agentDir), j.before))
      throw Error("rollback verification failed");
    renameSync(path, join(j.candidate, "failed-operation.json"));
    writePrivateJson(join(j.candidate, "recovery.json"), {
      status: "restored",
      at: new Date().toISOString(),
      previous: j.before,
    });
    return j.candidate;
  } catch {
    throw failure(
      "PACKAGE_RECOVERY_REQUIRED",
      "恢复证据不完整或目录被独立修改；未覆盖现场。请检查 " + path,
    );
  }
}

async function candidateProcess({
  candidate,
  command,
  source,
  entries,
  signal,
  onProgress,
}) {
  const request = join(candidate, "request.json"),
    result = join(candidate, "result.json"),
    log = join(candidate, "npm.log");
  writePrivateJson(request, { candidate, command, source, entries });
  const fd = openSync(log, "wx", 0o600);
  let child;
  try {
    if (signal?.aborted)
      throw failure("PACKAGE_CANCELLED", "包操作已取消；候选未发布。");
    child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "--candidate", request, result],
      {
        cwd: candidate,
        env: process.env,
        detached: process.platform !== "win32",
        stdio: ["ignore", fd, fd],
      },
    );
    onProgress({ type: "start", action: command, source });
    let aborting = false,
      killTimer, cancellationError, windowsTreeStopped = false;
    let finishUnknown;
    const unknown = new Promise(resolve => { finishUnknown = resolve; });
    const exited = new Promise((resolve, reject) => {
      child.once("error", error => {
        if (aborting) {
          cancellationError ??= error;
          child.unref();
          finishUnknown(null);
        } else reject(error);
      });
      child.once("close", resolve);
    });
    const kill = (sig) => {
      try {
        if (process.platform === "win32") {
          if (windowsTreeStopped) return;
          // Killing only the candidate's Node process leaves npm descendants alive.
          execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
            ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true, stdio: "pipe", timeout: 5000 });
          windowsTreeStopped = true;
        } else process.kill(-child.pid, sig);
      } catch (error) {
        if (error.code === "ESRCH") return;
        // macOS can report EPERM for a reaped group. Verify that no live member
        // remains; a real permission failure still fails rather than claiming cancellation.
        if (error.code === "EPERM" && process.platform !== "win32") {
          const members = execFileSync("ps", ["-axo", "pid=,pgid=,stat="], {
            encoding: "utf8",
          })
            .trim()
            .split("\n")
            .filter((line) => {
              const [, group, state] = line.trim().split(/\s+/);
              return Number(group) === child.pid && !state.startsWith("Z");
            });
          if (!members.length) return;
          writePrivateJson(join(candidate, "cancellation.json"), {
            signal: sig,
            pid: child.pid,
            exitCode: child.exitCode,
            signalCode: child.signalCode,
            members,
          });
        }
        throw error;
      }
    };
    const abort = () => {
      aborting = true;
      const stop = (sig) => {
        try { kill(sig); }
        catch (error) {
          cancellationError = error;
          // Stop the leader as a best effort, but do not claim its descendants stopped.
          try { child.kill("SIGKILL"); } catch { /* Original tree failure remains authoritative. */ }
          // A refused kill may never produce close. Return the uncertainty and
          // keep the private candidate/log, rather than hanging cancellation.
          child.unref();
          finishUnknown(null);
        }
      };
      stop("SIGTERM");
      killTimer = setTimeout(() => stop("SIGKILL"), 1000);
      killTimer.unref();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let code;
    try {
      code = await Promise.race([exited, unknown]);
    } finally {
      signal?.removeEventListener("abort", abort);
      clearTimeout(killTimer);
    }
    if (aborting || signal?.aborted) {
      if (cancellationError) {
        writePrivateJson(join(candidate, "cancellation.json"), {
          pid: child.pid, outcome: "unknown", code: cancellationError.code ?? null,
          status: cancellationError.status ?? null,
        });
        throw failure("PACKAGE_CANCEL_UNKNOWN", "无法确认包操作的全部子进程已停止；候选未发布，请检查进程后再操作。私有日志：" + log);
      }
      // Darwin can briefly retain an exiting descendant after the leader's close
      // event. Wait for verifiable group disappearance; never call it cancelled
      // merely because the parent has exited.
      const deadline = Date.now() + 2000;
      for (;;) {
        try {
          kill("SIGKILL");
          break;
        } catch (error) {
          if (error.code !== "EPERM" || Date.now() >= deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      throw failure("PACKAGE_CANCELLED", "包操作已取消；候选未发布。");
    }
    if (code !== 0)
      throw failure(
        "PACKAGE_NPM_FAILED",
        "npm/Pi 候选操作失败；私有日志：" + log,
      );
    return JSON.parse(readFileSync(result, "utf8"));
  } finally {
    closeSync(fd);
  }
}

async function manageCandidate(requestPath, resultPath) {
  const { candidate, command, source, entries } = JSON.parse(
    readFileSync(requestPath, "utf8"),
  );
  const { manager, settings } = packageManager(
    candidate,
    entries,
    command === "remove",
  );
  if (command === "install") {
    const { name, version } = parsePackageSource(source);
    // npm install <name> otherwise keeps the old exact dependency instead of selecting latest.
    await manager.install(version ? source : source + "@latest");
    const manifest = JSON.parse(
      readFileSync(
        join(candidate, "npm", "node_modules", name, "package.json"),
        "utf8",
      ),
    );
    if (
      manifest.name !== name ||
      !exactVersion.test(manifest.version) ||
      (exactVersion.test(version ?? "") && version !== manifest.version)
    )
      throw Error("installed package identity mismatch");
    manager.addSourceToSettings(`npm:${name}@${manifest.version}`);
    settings.setPackages(
      settings.getGlobalSettings().packages.map((e) =>
        parsePackageSource(sourceOf(e)).name === name
          ? {
              ...(typeof e === "object" ? e : {}),
              source: `npm:${name}@${manifest.version}`,
              extensions: [],
            }
          : e,
      ),
    );
  } else {
    await manager.remove(source);
    manager.removeSourceFromSettings(source);
  }
  await settings.flush();
  if (settings.drainErrors().length) throw Error("Pi settings write failed");
  writePrivateJson(resultPath, {
    packages: settings.getGlobalSettings().packages ?? [],
  });
}

export async function runPackageCommand({
  home,
  cwd = process.cwd(),
  command,
  source,
  signal,
  onProgress = () => {},
}) {
  let lock, candidate, recoveryPath;
  const result = { command, packages: [] };
  try {
    if (!commands.has(command))
      throw failure("PACKAGE_USAGE", "未知包管理命令。");
    const parsed = command === "list" ? null : parsePackageSource(source);
    lock = acquirePackageLock(home);
    const agentDir = join(home, "pi"),
      journal = join(agentDir, "package-operation.json");
    if (command === "list") {
      if (existsSync(journal))
        throw failure(
          "PACKAGE_RECOVERY_REQUIRED",
          "包提交尚未完成；请明确执行 install/remove 恢复。",
        );
      result.packages = await inspectPackages({ home, cwd });
      return { exitCode: 0, result };
    }
    assertNoActivePiSessions(home);
    recoveryPath = recoverOperation(home, lock);
    const original = readSettings(agentDir),
      manual = manualResources(home),
      oldSettings = optionalBytes(join(agentDir, "settings.json"));
    const before = packageState(agentDir),
      entry = (original.packages ?? []).find(
        (e) => parsePackageSource(sourceOf(e)).name === parsed.name,
      );
    if (before.npm !== null) checkTree(realpathSync(join(agentDir, "npm")));
    if (command === "remove" && !entry) {
      result.packages = await inspectPackages({ home, cwd });
      return { exitCode: 0, result };
    }
    if (
      command === "install" &&
      exactVersion.test(parsed.version ?? "") &&
      entry &&
      parsePackageSource(sourceOf(entry)).version === parsed.version
    ) {
      const rows = await inspectPackages({ home, cwd });
      if (rows.every((r) => !["missing", "broken"].includes(r.status))) {
        result.packages = rows;
        return { exitCode: 0, result };
      }
    }
    candidate = join(agentDir, `package-candidate-${randomUUID()}`);
    privateDirectory(candidate);
    if (before.npm !== null)
      cpSync(join(agentDir, "npm"), join(candidate, "npm"), {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
      });
    const changed = await candidateProcess({
      candidate,
      command,
      source,
      entries: original.packages ?? [],
      signal,
      onProgress,
    });
    const next = { ...original, packages: changed.packages };
    const rows = await inspectPackages({
      home,
      cwd,
      agentDir: candidate,
      settings: next,
      manual,
    });
    const bad = rows.find((r) => ["missing", "broken"].includes(r.status));
    if (bad)
      throw failure(
        bad.code ?? "PACKAGE_RESOURCE_INVALID",
        bad.reason ?? "候选包无效。",
      );
    if (signal?.aborted)
      throw failure("PACKAGE_CANCELLED", "包操作已取消；候选未发布。");
    lock.assertOwned();
    assertNoActivePiSessions(home);
    if (JSON.stringify(manualResources(home)) !== JSON.stringify(manual))
      throw failure(
        "PACKAGE_RESOURCE_CONFLICT",
        "安装期间全局 piResources 已改变；未发布候选。",
      );
    if (!sameState(packageState(agentDir), before))
      throw failure(
        "PACKAGE_CONFLICT",
        "正式包登记或目录被独立修改；未覆盖，候选保留。",
      );
    writePrivateJson(join(candidate, "next-settings.json"), next);
    const after = {
      npm: treeHash(join(candidate, "npm")),
      settings: bytesHash(readFileSync(join(candidate, "next-settings.json"))),
    };
    writePrivateJson(
      journal,
      {
        version: 1,
        candidate,
        before,
        after,
        oldSettings:
          oldSettings === null ? null : oldSettings.toString("base64"),
      },
      lock.assertOwned,
    );
    try {
      if (before.npm !== null)
        renameSync(join(agentDir, "npm"), join(candidate, "previous-npm"));
      if (after.npm !== null)
        renameSync(join(candidate, "npm"), join(agentDir, "npm"));
      writePrivateJson(join(agentDir, "settings.json"), next, lock.assertOwned);
      if (!sameState(packageState(agentDir), after))
        throw Error("publication verification failed");
      // Verify all paths after relocation, before declaring success or removing recovery evidence.
      result.packages = await inspectPackages({ home, cwd });
      if (result.packages.some((r) => ["missing", "broken"].includes(r.status)))
        throw Error("published resource validation failed");
      unlinkSync(journal);
    } catch (error) {
      recoveryPath = recoverOperation(home, lock);
      throw failure(
        "PACKAGE_COMMIT_FAILED",
        "发布失败，已核验回退到上一稳定包状态；失败现场保留。",
      );
    }
    rmSync(candidate, { recursive: true });
    candidate = undefined;
    return {
      exitCode: 0,
      result: { ...result, ...(recoveryPath ? { recoveryPath } : {}) },
    };
  } catch (error) {
    return {
      exitCode:
        error.code === "PACKAGE_CANCELLED"
          ? 130
          : ["PACKAGE_USAGE", "PACKAGE_FORBIDDEN"].includes(error.code)
            ? 2
            : 1,
      result: {
        ...result,
        error: {
          code: error.code ?? "PACKAGE_STORAGE",
          message: error.code
            ? error.message
            : "包存储操作失败；原安装或恢复记录保留。",
        },
        ...(candidate || recoveryPath
          ? { recoveryPath: candidate ?? recoveryPath }
          : {}),
      },
    };
  } finally {
    lock?.release();
  }
}

export function formatPackageResult(result) {
  if (result.error) return `${result.error.code}：${result.error.message}\n`;
  if (!result.packages.length)
    return result.command === "remove" ? "未安装。\n" : "尚未安装包。\n";
  return (
    result.packages
      .map(
        (p) =>
          `${p.name}@${p.version}：${p.status}${p.installedPath ? "\n安装路径：" + p.installedPath : ""}\n已启用 ${p.resources.filter((r) => r.enabled).length} 项资源${p.reason ? "；" + p.reason : ""}${p.resources
            .filter((r) => !r.enabled)
            .map((r) => "\n未启用 " + r.kind + "：" + r.reason)
            .join("")}`,
      )
      .join("\n") +
    (result.command === "list" ? "\n" : "\n下次启动 CoThink 后生效。\n")
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
  process.argv[2] === "--candidate"
) {
  try {
    await manageCandidate(process.argv[3], process.argv[4]);
  } catch {
    process.stderr.write("Pi/npm 候选处理失败。\n");
    process.exitCode = 1;
  }
}
