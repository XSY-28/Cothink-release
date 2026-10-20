import { thinkingLabel } from './thinking.js';
import { createInterface } from 'node:readline/promises';
import { PassThrough, Writable } from 'node:stream';
import { openSync, closeSync } from 'node:fs';
import { ReadStream, WriteStream } from 'node:tty';
import { saveConfig } from './config.js';

/** Prompts use the controlling terminal so piped questions never become configuration. */
export function openTerminal() {
  if (process.env.COTHINK_NO_TTY === '1') return null;
  if (process.stdin.isTTY && process.stderr.isTTY) return { input: process.stdin, output: process.stderr, close() {} };
  let readFd, writeFd;
  try {
    readFd = openSync('/dev/tty', 'r');
    writeFd = openSync('/dev/tty', 'w');
    const input = new ReadStream(readFd);
    const output = new WriteStream(writeFd);
    return { input, output, close() { input.destroy(); output.destroy(); } };
  } catch {
    if (readFd !== undefined) closeSync(readFd);
    if (writeFd !== undefined) closeSync(writeFd);
    return null;
  }
}

export async function configure(home, old, terminal, signal) {
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!muted) terminal.output.write(chunk, encoding); callback(); } });
  const rl = createInterface({ input: terminal.input, output, terminal: true });
  rl.on('SIGINT', () => process.emit('SIGINT'));
  const ask = async (label, fallback = '', hidden = false) => {
    terminal.output.write(`${label}${fallback && !hidden ? ` [${fallback}]` : ''}: `);
    muted = hidden;
    try {
      const result = (await rl.question('', { signal })).trim();
      return result || fallback;
    } finally { muted = false; if (hidden) terminal.output.write('\n'); }
  };
  try {
    terminal.output.write('分别配置主答模型与评审模型。此过程不发送模型请求。\n默认固定三次调用，不设置本地输出上限或超时，不自动重试。\n');
    const config = {};
    for (const [role, label, envDefault] of [['main', '主答', 'COTHINK_MAIN_API_KEY'], ['reviewer', '评审', 'COTHINK_REVIEW_API_KEY']]) {
      const previous = old?.[role] ?? {};
      terminal.output.write(`\n${label}模型\n`);
      const baseUrl = await ask('服务 base URL（到 /v1 等 API 根路径）', previous.baseUrl ?? 'https://api.openai.com/v1');
      let model = '';
      while (!model) model = await ask('模型名称', previous.model ?? '');
      const method = await ask('凭据方式（env=环境变量，key=本机保存密钥）', previous.apiKey ? 'key' : 'env');
      if (!['env', 'key'].includes(method)) throw new Error('凭据方式应为 env 或 key。');
      const profile = { baseUrl, model };
      if (method === 'env') profile.apiKeyEnv = await ask('密钥环境变量名', previous.apiKeyEnv ?? envDefault);
      else {
        profile.apiKey = await ask(previous.apiKey ? 'API key（隐藏输入，留空保留）' : 'API key（隐藏输入）', previous.apiKey ?? '', true);
      }
      profile.tokenParameter = previous.tokenParameter ?? 'max_completion_tokens';
      profile.maxOutputTokens = previous.maxOutputTokens ?? null;
      if (previous.supportsThinkingLevels !== undefined) profile.supportsThinkingLevels = previous.supportsThinkingLevels;
      if (previous.temperature !== undefined) profile.temperature = previous.temperature;
      config[role] = profile;
    }
    saveConfig(home, config);
    terminal.output.write('\n配置已保存（仅当前用户可读写）。env 方式请先在当前 shell 设置对应变量。\n');
    return config;
  } finally { rl.close(); }
}

export async function questionFromTerminal(terminal, signal) {
  // Keep readline's editing on the current line; only question entry needs
  // to distinguish a logical newline from submission. Configuration stays single-line.
  const input = new PassThrough();
  const rl = createInterface({ input, output: terminal.output, terminal: true, historySize: 0 });
  const wasRaw = Boolean(terminal.input.isRaw);
  const wasFlowing = terminal.input.readableFlowing;
  const lines = [];
  let continuing = false, finished = false, pending = '', pasting = false;
  let resolveQuestion, rejectQuestion;
  const answer = new Promise((resolve, reject) => { resolveQuestion = resolve; rejectQuestion = reject; });
  const fail = error => { if (!finished) { finished = true; rejectQuestion(error); } };
  const onAbort = () => fail(signal.reason ?? new Error('已取消输入。'));
  const onEnd = () => fail(new Error('输入已结束，问题未发送。'));
  const newline = () => {
    const tail = rl.line.slice(rl.cursor);
    rl.write(null, { ctrl: true, name: 'k' });
    continuing = true;
    rl.write(null, { name: 'return' });
    continuing = false;
    rl.write(tail);
    rl.write(null, { ctrl: true, name: 'a' });
  };
  rl.on('line', line => {
    if (continuing) {
      lines.push(line);
      rl.setPrompt('… ');
      rl.prompt();
    } else if (!finished) {
      finished = true;
      resolveQuestion([...lines, line].join('\n'));
    }
  });
  rl.on('SIGINT', () => process.emit('SIGINT'));
  rl.on('close', onEnd);

  const keySequence = sequence => {
    // CSI-u (Kitty/fixterms) and xterm modifyOtherKeys encode modified Return differently.
    const kitty = /^\x1b\[(\d+)(?:;(\d+)(?::(\d+))?)?u$/.exec(sequence);
    const xterm = /^\x1b\[27;(\d+);(\d+)~$/.exec(sequence);
    if (!kitty && !xterm) { input.write(sequence); return; }
    const code = Number(kitty ? kitty[1] : xterm[2]);
    const modifiers = Number(kitty ? kitty[2] ?? 1 : xterm[1]) - 1;
    if (kitty?.[3] === '3') return; // A release event must not insert/send a second time.
    if (code === 13 && (modifiers & 3)) newline();
    else if (code === 13) input.write('\r');
    else if (modifiers & 4 && code >= 64 && code <= 127) {
      if ((code & 31) === 10) newline();
      else input.write(String.fromCharCode(code & 31));
    }
    else if ([9, 27, 127].includes(code)) input.write(String.fromCharCode(code));
    else if (code >= 32 && code <= 0x10ffff && !(code >= 0xe000 && code <= 0xf8ff)) {
      input.write((modifiers & 2 ? '\x1b' : '') + String.fromCodePoint(code));
    }
  };
  const onData = chunk => {
    pending += chunk;
    while (pending && !finished) {
      if (pasting) {
        const end = pending.indexOf('\x1b[201~');
        if (end === -1) return;
        const parts = pending.slice(0, end).split(/\r\n|\r|\n/);
        pending = pending.slice(end + 6);
        pasting = false;
        for (const [index, part] of parts.entries()) {
          if (index) newline();
          rl.write(part);
        }
      } else if (pending.startsWith('\x1b[')) {
        const match = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(pending);
        if (!match) {
          if (/^\x1b\[[0-?]*[ -/]*$/.test(pending)) return;
          // Drop a malformed/incomplete key prefix, but still process Ctrl-C/Return.
          const invalid = pending.slice(2).search(/[^0-? -/]/);
          pending = pending.slice(invalid < 0 ? 2 : invalid + 2);
          continue;
        }
        const sequence = match[0];
        pending = pending.slice(sequence.length);
        if (sequence === '\x1b[200~') pasting = true;
        else keySequence(sequence);
      } else if (pending === '\x1b') return;
      else if (/^\x1b[\r\n]/.test(pending)) { pending = pending.slice(2); newline(); }
      else if (pending[0] === '\n') { pending = pending.slice(1); newline(); }
      else if (pending[0] === '\r') { pending = pending.slice(1); input.write('\r'); }
      else {
        const text = /^[^\x1b\r\n]+/.exec(pending)?.[0] ?? pending[0];
        pending = pending.slice(text.length);
        input.write(text);
      }
    }
  };
  try {
    terminal.input.setEncoding('utf8');
    terminal.input.setRawMode(true);
    terminal.input.on('data', onData);
    terminal.input.on('end', onEnd);
    terminal.input.on('error', fail);
    signal.addEventListener('abort', onAbort, { once: true });
    // Kitty's stack restores the previous keyboard mode; unsupported terminals ignore it.
    terminal.output.write('\x1b[>1u\x1b[?2004h');
    rl.setPrompt('请输入问题（Shift+Return 换行，Return 发送）：');
    rl.prompt();
    terminal.input.resume();
    if (signal.aborted) onAbort();
    return await answer;
  } finally {
    terminal.input.off('data', onData);
    terminal.input.off('end', onEnd);
    terminal.input.off('error', fail);
    signal.removeEventListener('abort', onAbort);
    terminal.output.write('\x1b[?2004l\x1b[<u');
    rl.close();
    input.destroy();
    terminal.input.setRawMode(wasRaw);
    if (!wasFlowing) terminal.input.pause();
  }
}

/** External text is literal content, never terminal instructions (including C1/bidi). */
export function safeText(value) {
  return String(value ?? '').replace(/\r\n|\r/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, char => `⟦U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4,'0')}⟧`).replace(/\t/g, '    ');
}


/** Presentation only: preserve the raw reply for details, exports and future turns. */
export function finalAnswerText(text) {
  const lines = text.split(/\r?\n/);
  let fence = null, section = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const code = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (code && code[1][0] === fence[0] && code[1].length >= fence.length && !code[2].trim()) fence = null;
      continue;
    }
    if (code) { fence = code[1]; continue; }
    if (section?.kind === 'details') {
      if (/^ {0,3}<details(?:[ \t]+open)?[ \t]*>[ \t]*$/i.test(line)) section.depth++;
      if (/^ {0,3}<\/details>[ \t]*$/i.test(line) && --section.depth === 0) {
        section.end = index + 1;
        break;
      }
      continue;
    }
    if (!section && /^ {0,3}<details(?:[ \t]+open)?[ \t]*>[ \t]*$/i.test(line)) {
      let summaryIndex = index + 1;
      while (summaryIndex < lines.length && !lines[summaryIndex].trim()) summaryIndex++;
      const summary = /^ {0,3}<summary>[ \t]*(.*?)[ \t]*<\/summary>[ \t]*$/i.exec(lines[summaryIndex] ?? '');
      const title = summary?.[1].replace(/^#{1,6}[ \t]+/, '').replace(/^\*\*(.*?)\*\*$/, '$1').replace(/[：:]$/, '');
      if (title === '对评审意见的处理说明') {
        section = { kind: 'details', start: index, end: null, depth: 1 };
        index = summaryIndex;
        continue;
      }
    }
    const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    const title = (heading ? heading[2] : /^ {0,3}(\S.*?)[ \t]*$/.exec(line)?.[1] ?? '')
      .replace(/^\*\*(.*?)\*\*$/, '$1').replace(/[：:]$/, '');
    if (section && heading && heading[1].length <= section.level) {
      section.end = index;
      break;
    }
    if (!section && title === '对评审意见的处理说明') {
      section = { start: index, end: lines.length, level: heading ? heading[1].length : 6 };
    }
  }
  if (!section || section.end === null) return text;
  const before = lines.slice(0, section.start).join('\n').trimEnd();
  // Never replace an answerless/malformed reply with an empty screen.
  if (!before.trim()) return text;
  const after = lines.slice(section.end).join('\n').trimStart();
  return before + (after ? '\n\n' + after : '');
}

export function renderRun(run, all = false) {
  if (run.status === 'completed' && !all) return finalAnswerText(run.stages[2].response.text) + '\n';
  const names = { draft: '主答初稿', review: '完整评审', revision: '主答修订' };
  const lines = [run.status === 'completed' ? '# 完整讨论' : `# 部分结果（${run.status}；尚未完整交付）`, `运行 ID：${run.id}`];
  lines.push(run.thinkingLevel === undefined ? '思考：当时未指定' : run.thinkingLevel === null ? '思考：未启用统一档位' : `思考：${thinkingLabel(run.thinkingLevel)}（${run.thinkingLevel}）`);
  if (all) lines.push(`\n## 原始问题\n${run.question}`);
  if (run.error) lines.push(`\n${run.error}`);
  for (const stage of run.stages) {
    lines.push(`\n## ${names[stage.name]}（${stage.status}）`);
    lines.push(`请求模型：${safeText(stage.model ?? '未知')}；实际模型：${safeText(stage.response?.model || '未知')}`);
    if (stage.response?.text) lines.push(stage.response.text);
    else lines.push('尚无可用回答文本。');
    if (stage.error) lines.push(`阶段错误：${stage.error}`);
    if (stage.status !== 'completed' && stage.response?.rawBody) lines.push(`服务原始回复（错误或未完整交付）：\n${safeText(stage.response.rawBody)}`);
  }
  return lines.join('\n') + '\n';
}

/** Local first-run UI. Authentication secrets are entered through Pi's login callbacks. */
export function setupIO(terminal, signal) {
  let muted=false;
  const output=new Writable({write(chunk,encoding,callback){if(!muted)terminal.output.write(chunk,encoding);callback();}});
  const rl=createInterface({input:terminal.input,output,terminal:true});
  const prompt=async p=>{
    const hidden=p.type==='secret', label=p.message+': ';
    // Readline redraws its own prompt. A separately written text label would
    // be erased by question('') on real terminals (CSI 1G / CSI 0J).
    if(hidden)terminal.output.write(label);
    muted=hidden;
    try{
      const value=await rl.question(hidden?'':label,{signal:p.signal??signal});
      if(!value.trim())throw Error('设置已取消，旧配置保留。');
      return value.trim();
    }finally{if(muted)terminal.output.write('\n');muted=false;}
  };
  return {prompt,notify:text=>terminal.output.write(safeText(text)+'\n'),async select(title,options){terminal.output.write(`\n${title}\n`+options.map((o,i)=>`${i+1}. ${safeText(o.label)}`).join('\n')+'\n');const choice=await prompt({type:'text',message:'输入编号或 ID'});const option=options.find(o=>o.id===choice)??options[Number(choice)-1];if(!option)throw Error('无效选择，设置未切换。');return option.id;},close(){rl.close();}};
}
