// Assemble a Windows download from the exact tarball tested by the workflow.
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const archive = resolve(process.argv[2]);
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
assert.equal(process.platform, 'win32', 'Build Windows downloads on a Windows runner');
assert.equal(basename(archive), `cothink-v2-${version}.tgz`, 'Tarball must match the release version');
const directory = resolve('dist', `CoThink-${version}-windows-${process.arch}`);
mkdirSync(directory, { recursive: true });
copyFileSync(archive, join(directory, basename(archive)));
const cmd = (name, lines) => writeFileSync(join(directory, name), lines.join('\r\n') + '\r\n');
cmd('install.cmd', [
  '@echo off', 'setlocal',
  'where node.exe >nul 2>nul',
  'if errorlevel 1 (echo Install Node.js 22.19 or newer from https://nodejs.org/ first. & exit /b 1)',
  'node -e "const [a,b]=process.versions.node.split(\'.\').map(Number);process.exit(a>22 || a===22 && b>=19 ? 0 : 1)"',
  'if errorlevel 1 (echo Node.js 22.19 or newer is required. & exit /b 1)',
  'where tar.exe >nul 2>nul',
  'if errorlevel 1 (echo Windows tar.exe is required. Install Git for Windows or update Windows. & exit /b 1)',
  'if exist "%~dp0app" (echo The app directory already exists. Use a freshly extracted ZIP to reinstall. & exit /b 1)',
  'mkdir "%~dp0app"',
  `tar.exe -xzf "%~dp0${basename(archive)}" -C "%~dp0app"`,
  'if errorlevel 1 exit /b %errorlevel%',
  'echo Installed. Run cothink.cmd in this folder or from your project directory.',
]);
cmd('cothink.cmd', [
  '@echo off', 'setlocal',
  'if exist "%~dp0app\\package\\bin\\cothink.js" goto run',
  'call "%~dp0install.cmd"',
  'if errorlevel 1 exit /b %errorlevel%',
  ':run',
  'node "%~dp0app\\package\\bin\\cothink.js" %*',
  'exit /b %errorlevel%',
]);
writeFileSync(join(directory, 'README.txt'), `CoThink ${version} — Windows ${process.arch}\n\n` +
  '需要 Node.js >=22.19 和 Git for Windows。此包不含 Node.js。\n' +
  '1. 将整个 ZIP 解压到自己的目录（支持中文和空格路径）。\n' +
  '2. 在 Windows Terminal 的 PowerShell 中运行 .\\install.cmd（离线安装，不改执行策略）。\n' +
  '3. 运行 .\\cothink.cmd init 配置 Team，然后 .\\cothink.cmd 开始对话。\n' +
  '4. 若已在项目目录中，可用 & "D:\\CoThink\\cothink.cmd" 启动，保留当前项目目录。\n\n' +
  'Enter 发送；Ctrl+J 换行；Shift+Enter 识别受终端配置影响。Ctrl+Shift+V 粘贴。\n' +
  '选区自动复制使用 Windows 原生剪贴板；/chat 或 Ctrl+O 查看讨论，Esc 返回/取消。\n' +
  '数据默认在 %USERPROFILE%\\.cothink，升级程序不要删除数据。\n' +
  '已有 Git 执行位在 Windows 文件投影中保留；新文件默认非可执行。\n' +
  '工作 Shell 使用 Linux Docker 隔离，不在宿主 PowerShell 执行；Windows Docker 另需验证。\n' +
  '自动化检查不代替中文输入法和物理键盘现场体验。\n\n' +
  '源码、完整说明和反馈：https://github.com/XSY-28/Cothink-release\n');
const files = [basename(archive), 'install.cmd', 'cothink.cmd', 'README.txt'];
writeFileSync(join(directory, 'SHA256SUMS.txt'), files.map(name =>
  createHash('sha256').update(readFileSync(join(directory, name))).digest('hex') + '  ' + name).join('\n') + '\n');
console.log(directory);
