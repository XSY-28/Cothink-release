import { parseArgs } from "node:util";
import { preparePluginCompatibility, inspectPluginCompatibility, pluginCompatibilityRevision } from "./plugin-compatibility.js";
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
  dirname,
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
  assertPackageReadable,
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
  "--save-exact",
  "--no-audit",
  "--no-fund",
  "--no-update-notifier",
  ...(offline ? ["--offline"] : []),
];
function packageManager(agentDir, entries, offline = true, cwd = agentDir, projectEntries = []) {
  const settings = SettingsManager.inMemory(
    { packages: entries, npmCommand: npmCommand(offline) }, { projectTrusted: true });
  settings.setProjectPackages(projectEntries);
  return { settings, manager: new DefaultPackageManager({ cwd, agentDir, settingsManager: settings, builtinExtensions: [] }) };
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
    if ((parsed.type === "npm" && !exactVersion.test(parsed.version ?? "")) || names.has(parsed.name))
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
export const localNames = new Set(
  "one cothink make-html chat team models model help settings scoped-models thinking export import copy name session changelog updates check-update hotkeys fork clone tree trust login logout new reload debug resume quit compact install list remove update uninstall config".split(
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

async function inspectPackages({ home, cwd = process.cwd(), agentDir = join(home, "pi"),
  settings = readSettings(agentDir), projectSettings, manual = manualResources(home), authorizedProject = false, management = false }) {
  const projectKey=realpathSync(cwd), authorized=settings.cothinkProjects?.[projectKey];
  if(authorized && !management)assertPackageReadable(home,{agentDir:join(cwd,".pi")});
  projectSettings ??= authorized ? readSettings(join(cwd,".pi")) : {};
  const selectedProject = authorizedProject || authorized === digest(JSON.stringify(projectSettings.packages ?? [])) ? projectSettings.packages ?? [] : [];
  const {manager} = packageManager(agentDir, settings.packages ?? [], true, cwd, selectedProject);
  const registrations=[...(settings.packages??[]).map(entry=>({entry,scope:"user"})),...selectedProject.map(entry=>({entry,scope:"project"}))];
  const effective = registrations.map(({entry,scope})=>{
    let effectiveEntry=entry,installScope=scope;
    if(scope==="project" && typeof entry==="object" && entry.autoload===false) {
      const requested=absoluteSource(sourceOf(entry),join(cwd,".pi"));
      const probe=packageManager(agentDir,settings.packages??[],true,cwd);
      const before=probe.settings.getGlobalSettings().packages??[];
      probe.manager.removeSourceFromSettings(requested);
      const after=probe.settings.getGlobalSettings().packages??[];
      const user=before.find(e=>!after.includes(e));
      if(user){effectiveEntry=user;installScope="user";}
    }
    const source=sourceOf(entry), effectiveSource=sourceOf(effectiveEntry),parsed=parsePackageSource(effectiveSource);
    const expected=parsed.type==="npm"?join(installScope==="user"?agentDir:join(cwd,".pi"),"npm/node_modules",parsed.name):null;
    // Native getInstalledPath probes global npm when a managed npm tree is absent; never execute that fallback in list.
    const installedPath=expected?(existsSync(expected)?expected:undefined):manager.getInstalledPath(effectiveSource,installScope);
    return {source,effectiveSource,scope,installScope,delta:effectiveEntry!==entry,filtered:typeof entry!=="string",installedPath,
      name:parsed.name,version:parsed.version??null,type:parsed.type,status:"missing",resources:[]};
  });
  const rows=effective;
  for (const row of rows) {
    try {
      if (!row.installedPath || !existsSync(row.installedPath)) throw failure("PACKAGE_MISSING", "登记的包安装缺失；list 不安装或修复。");
      const root = realpathSync(row.installedPath); row.installedPath = root;
      const parsed = parsePackageSource(row.effectiveSource);
      if (parsed.type !== "local") {
        const managed = realpathSync(join(row.installScope === "user" ? agentDir : join(cwd, ".pi"), parsed.type));
        if (!inside(managed, root)) throw failure("PACKAGE_RESOURCE_ESCAPE", "安装不属于选定受管目录。");
      }
      if (lstatSync(root).isDirectory()) {
        const manifest = existsSync(join(root,"package.json")) ? JSON.parse(readFileSync(join(root,"package.json"),"utf8")) : {};
        if (parsed.type === "npm" && (manifest.name !== parsed.name || manifest.version !== parsed.version))
          throw failure("PACKAGE_CONTENT_MISMATCH", "安装内容不符：登记版本与文件不一致。");
        checkManifest(root, manifest);
        row.name = manifest.name ?? row.name; row.version = manifest.version ?? row.version;
        if (manifest.name === "pi-subagents" && manifest.version === "0.84.0") row.compatibility = inspectPluginCompatibility(root);
        if (parsed.type === "git") {
          row.commit = execFileSync("git", ["-C",root,"rev-parse","HEAD"],{encoding:"utf8"}).trim();
          if (Object.keys(manifest.dependencies ?? {}).some(name => !existsSync(join(root,"node_modules",name))))
            throw failure("PACKAGE_DEPENDENCIES_MISSING", "Git 包依赖缺失；请明确 install 修复，list 不运行依赖安装。");
        }
      }
      row.status = "blocked";
    } catch(error) { row.status = error.code === "PACKAGE_MISSING" ? "missing" : "broken"; row.reason = error.message; row.code = error.code ?? "PACKAGE_RESOURCE_INVALID"; }
  }
  // Native resolve supplies project override/delta semantics; never feed ambient top-level resources into the runtime.
  if (!rows.some(row => ["missing","broken"].includes(row.status))) {
    const found = await manager.resolve(async () => "error");
    for (const kind of kinds) for (const resource of found[kind]) {
      const row = rows.find(row => row.source === resource.metadata.source && row.scope === resource.metadata.scope);
      if (!row || resource.metadata.origin !== "package") continue;
      const path = realpathSync(resource.path), root = row.installedPath;
      if (!(path === root || (lstatSync(root).isDirectory() && inside(root,path))))
        throw failure("PACKAGE_RESOURCE_ESCAPE", "包资源 realpath 越界。");
      row.resources.push({kind,path,enabled:resource.enabled,...(!resource.enabled ? {reason:"包资源过滤已禁用。"}: {})});
    }
    for (const row of rows) {
      const n = row.resources.filter(r=>r.enabled).length;
      row.status = n ? (n === row.resources.length ? "enabled" : "partial") : "blocked";
      if(!row.resources.length && !row.delta && !rows.some(other=>other!==row && other.scope==="project" && other.name===row.name)) {row.status="broken";row.code="NO_PI_RESOURCES";row.reason="包没有可识别的 Pi 资源。";}
    }
  }
  try { validateDataResources(rows,manual,cwd,home); }
  catch(error) { if(!rows.length)throw error;for(const row of rows) { row.status="broken"; row.reason=error.message; row.code=error.code?.startsWith("PACKAGE_") ? error.code : "PACKAGE_RESOURCE_INVALID"; for(const r of row.resources)r.enabled=false; } }
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
    project: realpathSync(options.cwd ?? process.cwd()),
    packages: rows.map(({ source, name, version, compatibility, scope, installedPath, commit }) => ({
      scope, installedPath, ...(commit ? {commit} : {}),
      source,
      name,
      version,
      ...(compatibility ? {compatibility} : {}),
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
  if (typeof source !== "string" || !source.trim() || /[\x00-\x1f]/.test(source)) throw failure("PACKAGE_USAGE", "包来源不能为空或包含控制字符。");
  const match = /^npm:((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@([a-zA-Z0-9][a-zA-Z0-9._+-]*))?$/.exec(source);
  if(match) return {type:"npm", name:match[1], version:match[2]};
  if(source.startsWith("npm:")) throw failure("PACKAGE_USAGE","无效 npm 来源。");
  if (/^(git:|https?:\/\/|ssh:\/\/)/.test(source)) {
    try { const u=new URL(source.replace(/^git:/,"")); if(u.password || (/^https?:$/.test(u.protocol) && u.username))throw failure("PACKAGE_USAGE","Git URL 不接受内嵌凭据；请使用 Git credential helper。"); } catch(error) {if(error.code==="PACKAGE_USAGE")throw error;}
    if (/\.(?:zip|tgz|tar(?:\.gz)?)(?:[?#]|$)/i.test(source)) throw failure("PACKAGE_USAGE","URL 来源仅支持锁定 Pi 的 Git URL，不支持归档下载。");
    return {type:"git",name:source};
  }
  return {type:"local",name:source};
}
const absoluteSource = (source, base) => parsePackageSource(source).type === "local" ? resolve(base, source.replace(/^~(?=\/)/, process.env.HOME)) : source;
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
      options: { json: { type: "boolean" }, local: { type: "boolean" } },
    });
    const [actual, ...sources] = parsed.positionals;
    if (actual !== command || sources.length !== (command === "list" ? 0 : 1))
      throw failure(
        "PACKAGE_USAGE",
        "包管理用法：cothink install npm:包名 | list | remove npm:包名 [--json]",
      );
    if (sources[0]) parsePackageSource(sources[0]);
    return { command, source: sources[0], json, local: parsed.values.local === true };
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
    git: treeHash(join(agentDir, "git")),
    settings: bytesHash(optionalBytes(join(agentDir, "settings.json"))),
  };
}
function sameState(a, b) {
  return a.npm === b.npm && (a.git ?? null) === (b.git ?? null) && a.settings === b.settings;
}

// Recovery only rolls back a verified interrupted publication. No npm/model retry.
function recoverOperation(home, lock, agentDir = join(home, "pi")) {
  const
    path = join(agentDir, "package-operation.json");
  if (!existsSync(path)) return;
  let j;
  try {
    j = JSON.parse(readFileSync(path, "utf8"));
    if (
      ![1,2].includes(j.version) ||
      !/^package-candidate-[0-9a-f-]{36}$/.test(basename(j.candidate)) ||
      resolve(j.candidate) !== join(resolve(agentDir), basename(j.candidate)) ||
      (j.version===2 && ![j.before?.git,j.after?.git].every(h=>h===null||/^[a-f0-9]{64}$/.test(h))) ||
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
    if(j.homeSettings) {
      if(j.homeSettings.home!==realpathSync(home))throw Error("recovery belongs to another CoThink data root");
      const h=j.homeSettings, path=join(home,"pi/settings.json"), current=bytesHash(optionalBytes(path));
      if(![h.before,h.after].includes(current) || bytesHash(h.oldBytes===null?null:Buffer.from(h.oldBytes,"base64"))!==h.before)throw Error("independent home registration edit");

    }
    const current = packageState(agentDir);
    if (![j.before.settings,j.after.settings].includes(current.settings)) throw Error("independent settings edit");
    for (const slot of j.version === 1 ? ["npm"] : ["npm","git"]) {
      const before=j.before[slot], after=j.after[slot], backup=join(j.candidate,"previous-"+slot), backupHash=treeHash(backup);
      if (![null,before,after].includes(current[slot])) throw Error("independent edit");
      if (before !== null && current[slot] !== before && backupHash !== before) throw Error("missing backup");
      if (backupHash !== null && backupHash !== before) throw Error("backup changed");
    }
    if(j.homeSettings) {
      const h=j.homeSettings,path=join(home,"pi/settings.json");
      if(h.oldBytes===null) {if(existsSync(path))unlinkSync(path);} else writePrivateBytes(path,Buffer.from(h.oldBytes,"base64"),lock.assertOwned);
    }
    for (const slot of j.version === 1 ? ["npm"] : ["npm","git"]) {
      const before=j.before[slot],backup=join(j.candidate,"previous-"+slot);
      if(current[slot] !== before) {
        if(current[slot] !== null) renameSync(join(agentDir,slot),join(j.candidate,"failed-published-"+slot));
        if(before !== null) renameSync(backup,join(agentDir,slot));
      }
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
  originalCwd,
  local = false,
}) {
  const request = join(candidate, "request.json"),
    result = join(candidate, "result.json"),
    log = join(candidate, "npm.log");
  writePrivateJson(request, { candidate, command, source, entries, originalCwd, local });
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
  const { candidate, command, source, entries, originalCwd, local } = JSON.parse(readFileSync(requestPath,"utf8"));
  const candidateCwd = local ? join(candidate,"project") : originalCwd;
  if(local) privateDirectory(join(candidateCwd,".pi"));
  const {manager,settings} = packageManager(candidate, local ? [] : entries, command === "remove", candidateCwd, local ? entries : []);
  const options={local};
  if(command === "install") {
    const parsed=parsePackageSource(source);
    await manager.install(parsed.type === "npm" && !parsed.version ? source+"@latest" : source,options);
    let registered=source;
    if(parsed.type === "npm") {
      const root=manager.getInstalledPath(source,local?"project":"user");
      const manifest=JSON.parse(readFileSync(join(root,"package.json"),"utf8"));
      if(manifest.name!==parsed.name || !exactVersion.test(manifest.version) || (exactVersion.test(parsed.version??"") && parsed.version!==manifest.version)) throw Error("installed package identity mismatch");
      registered=`npm:${parsed.name}@${manifest.version}`;
    }
    manager.addSourceToSettings(registered,options);
  } else {
    await manager.remove(source,options); manager.removeSourceFromSettings(source,options);
  }
  // Serialize local links against their final settings location, never the candidate directory.
  const values=(local ? settings.getProjectSettings() : settings.getGlobalSettings()).packages ?? [];
  const corrected=values.map(entry=>{
    const raw=sourceOf(entry);
    if(parsePackageSource(raw).type!=="local")return typeof entry === "string" ? {source:entry} : entry;
    const original=absoluteSource(raw,local?join(candidateCwd,".pi"):candidate);
    return typeof entry === "string" ? {source:original} : {...entry,source:original};
  });
  if(local)settings.setProjectPackages(corrected);else settings.setPackages(corrected);
  await settings.flush();
  if (settings.drainErrors().length) throw Error("Pi settings write failed");
  writePrivateJson(resultPath, {
    packages: (local ? settings.getProjectSettings() : settings.getGlobalSettings()).packages ?? [],
  });
}

export async function runPackageCommand({
  home,
  cwd = process.cwd(),
  command,
  source,
  signal,
  onProgress = () => {},
  local = false,
}) {
  let lock, targetLock, candidate, recoveryPath;
  const result = { command, packages: [] };
  try {
    if (!commands.has(command))
      throw failure("PACKAGE_USAGE", "未知包管理命令。");
    if(source)source=absoluteSource(source,cwd);
    const parsed = command === "list" ? null : parsePackageSource(source);
    if(command === "install" && parsed.type === "local" && !existsSync(source))throw failure("PACKAGE_USAGE","本地包来源不存在。");
    lock = acquirePackageLock(home);
    const agentDir = local ? join(realpathSync(cwd), ".pi") : join(home, "pi"),
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
    if(local) {
      if(existsSync(agentDir) && lstatSync(agentDir).isSymbolicLink())throw failure("PACKAGE_STORAGE","项目 .pi 不能是符号链接。");
      privateDirectory(agentDir); targetLock=acquirePackageLock(home,{agentDir});
    }
    assertNoActivePiSessions(home);
    if(local)assertNoActivePiSessions(home,{agentDir});
    recoveryPath = recoverOperation(home, lock, agentDir);
    const original = readSettings(agentDir),
      manual = manualResources(home),
      oldSettings = optionalBytes(join(agentDir, "settings.json")),
      oldHomeSettings=local?optionalBytes(join(home,"pi/settings.json")):null;
    const before = packageState(agentDir);
    let entry = (original.packages ?? []).find(
        (e) => { const p=parsePackageSource(sourceOf(e)); return parsed.type === "npm" ? p.type === "npm" && p.name === parsed.name : absoluteSource(sourceOf(e),agentDir) === source; },
      );
    if(!entry && parsed.type!=="npm") {
      const probe=packageManager(agentDir,original.packages??[],true,dirname(agentDir));
      const sourcesBefore=probe.settings.getGlobalSettings().packages??[];
      probe.manager.removeSourceFromSettings(source);
      const sourcesAfter=probe.settings.getGlobalSettings().packages??[];
      entry=sourcesBefore.find(e=>!sourcesAfter.includes(e));
    }
    if (before.npm !== null) checkTree(realpathSync(join(agentDir, "npm")));
    if (command === "remove" && !entry) {
      result.packages = await inspectPackages({ home, cwd, management:true });
      return { exitCode: 0, result };
    }
    if (
      command === "install" &&
      parsed.type === "npm" && exactVersion.test(parsed.version ?? "") &&
      (!local || readSettings(join(home,"pi")).cothinkProjects?.[realpathSync(cwd)]===digest(JSON.stringify(original.packages??[]))) &&
      entry &&
      parsePackageSource(sourceOf(entry)).version === parsed.version
    ) {
      const rows = await inspectPackages({ home, cwd, management:true });
      if (rows.every((r) => !["missing", "broken"].includes(r.status) &&
        (r.name !== "pi-subagents" || r.version !== "0.84.0" || r.compatibility?.revision === pluginCompatibilityRevision))) {
        result.packages = rows;
        return { exitCode: 0, result };
      }
    }
    candidate = join(agentDir, `package-candidate-${randomUUID()}`);
    privateDirectory(candidate);
    if(local)privateDirectory(join(candidate,"project/.pi"));
    for(const slot of ["npm","git"]) if (before[slot] !== null)
      cpSync(join(agentDir, slot), join(local ? join(candidate,"project/.pi") : candidate, slot), {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
      });
    if(local)privateDirectory(join(candidate,"project/.pi"));
    const candidateAgent=local?join(candidate,"project/.pi"):candidate;
    // Validate/transition copied known bytes before npm can replace an up-to-date or
    // locally modified installed tree. The original installation is still untouched.
    if(command === "install") preparePluginCompatibility(candidateAgent);
    const changed = await candidateProcess({
      candidate,
      command,
      source,
      entries: original.packages ?? [],
      signal,
      onProgress, originalCwd:cwd, local,
    });
    const next = { ...original, packages: changed.packages };
    const homeValue=oldHomeSettings ? JSON.parse(oldHomeSettings.toString("utf8")) : {};
    const nextHome=local?{...homeValue,cothinkProjects:{...homeValue.cothinkProjects,[realpathSync(cwd)]:digest(JSON.stringify(changed.packages))}}:null;
    preparePluginCompatibility(candidateAgent);
    const rows = await inspectPackages({
      home, management:true,
      cwd: local ? join(candidate,"project") : cwd,
      agentDir: local ? join(home,"pi") : candidate,
      settings: local ? nextHome : next,
      ...(local ? {projectSettings:next} : {}),
      authorizedProject: local,
      manual,
    });
    next.cothinkPackageProvenance=rows.filter(r=>r.scope===(local?"project":"user")).map(({source,type,commit,compatibility})=>({source,type,...(commit?{commit}:{}),...(compatibility?{compatibility}:{})}));
    const bad = rows.find((r) => ["missing", "broken"].includes(r.status));
    if (bad)
      throw failure(
        bad.code ?? "PACKAGE_RESOURCE_INVALID",
        bad.reason ?? "候选包无效。",
      );
    if (signal?.aborted)
      throw failure("PACKAGE_CANCELLED", "包操作已取消；候选未发布。");
    lock.assertOwned();
    targetLock?.assertOwned();
    assertNoActivePiSessions(home);
    if(local)assertNoActivePiSessions(home,{agentDir});
    if (JSON.stringify(manualResources(home)) !== JSON.stringify(manual))
      throw failure(
        "PACKAGE_RESOURCE_CONFLICT",
        "安装期间全局 piResources 已改变；未发布候选。",
      );
    if(local && bytesHash(optionalBytes(join(home,"pi/settings.json")))!==bytesHash(oldHomeSettings))throw failure("PACKAGE_CONFLICT","个人包登记在项目安装期间被独立修改；未发布。");
    if (!sameState(packageState(agentDir), before))
      throw failure(
        "PACKAGE_CONFLICT",
        "正式包登记或目录被独立修改；未覆盖，候选保留。",
      );
    writePrivateJson(join(candidate, "next-settings.json"), next);
    const after = {
      npm: treeHash(join(candidateAgent, "npm")),
      git: treeHash(join(candidateAgent, "git")),
      settings: bytesHash(readFileSync(join(candidate, "next-settings.json"))),
    };
    writePrivateJson(
      journal,
      {
        version: 2,
        candidate,
        before,
        after,
        oldSettings:
          oldSettings === null ? null : oldSettings.toString("base64"),
        ...(local ? {homeSettings:{home:realpathSync(home),before:bytesHash(oldHomeSettings),oldBytes:oldHomeSettings?.toString("base64") ?? null,after:bytesHash(Buffer.from(JSON.stringify(nextHome,null,2)+"\n"))}} : {}),
      },
      lock.assertOwned,
    );
    try {
      for(const slot of ["npm","git"]) {
        if(before[slot]!==null)renameSync(join(agentDir,slot),join(candidate,"previous-"+slot));
        if(after[slot]!==null)renameSync(join(candidateAgent,slot),join(agentDir,slot));
      }
      writePrivateJson(join(agentDir, "settings.json"), next, lock.assertOwned);
      if (!sameState(packageState(agentDir), after))
        throw Error("publication verification failed");
      if(local)writePrivateJson(join(home,"pi/settings.json"),nextHome,lock.assertOwned);
      // Verify all paths after relocation, before declaring success or removing recovery evidence.
      result.packages = await inspectPackages({ home, cwd, management:true });
      if (result.packages.some((r) => ["missing", "broken"].includes(r.status)))
        throw Error("published resource validation failed");
      unlinkSync(journal);
    } catch (error) {
      recoveryPath = recoverOperation(home, lock, agentDir);
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
    targetLock?.release();
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
          `${p.name}${p.version ? "@"+p.version : ""} [${p.scope ?? "user"}]：${p.status}${p.installedPath ? "\n安装路径：" + p.installedPath : ""}\n已启用 ${p.resources.filter((r) => r.enabled).length} 项资源${p.reason ? "；" + p.reason : ""}${p.resources
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
