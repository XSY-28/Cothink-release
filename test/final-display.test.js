import test from 'node:test';
import assert from 'node:assert/strict';
import { renderRun } from '../src/terminal.js';

const run = text => ({ id: 'fixture', status: 'completed', stages: [
  { name: 'draft', status: 'completed', response: { text: '初稿' } },
  { name: 'review', status: 'completed', response: { text: '评审' } },
  { name: 'revision', status: 'completed', response: { text } },
] });

test('default answer hides only the explicit review-handling section; full record is unchanged', () => {
  for (const title of ['## 对评审意见的处理说明', '**对评审意见的处理说明**', '对评审意见的处理说明：']) {
    const text = `完整答案，结论仍有不确定性。\n\n${title}\n采纳 A；拒绝 B，因为证据不足。`;
    const record = run(text);
    assert.equal(renderRun(record), '完整答案，结论仍有不确定性。\n');
    assert.ok(renderRun(record, true).includes(text));
    assert.equal(record.stages[2].response.text, text);
  }
});

test('a later peer section stays visible while nested handling subsections are folded', () => {
  const text = '答案\n\n## 对评审意见的处理说明\n### 采纳\n修改了计算。\n## 适用边界\n仅适用于有限集合。';
  assert.equal(renderRun(run(text)), '答案\n\n## 适用边界\n仅适用于有限集合。\n');
});

test('HTML review details are folded without removing later answer content or raw records', () => {
  for (const summary of ['## 对评审意见的处理说明', '对评审意见的处理说明', '**对评审意见的处理说明**']) {
    const text = `答案与分歧。\n\n<details>\n<summary>${summary}</summary>\n\n采纳说明。\n## 处理细节\n理由。\n</details>\n\n## 适用边界\n边界正文。`;
    const record = run(text);
    assert.equal(renderRun(record), '答案与分歧。\n\n## 适用边界\n边界正文。\n');
    assert.ok(renderRun(record, true).includes(text));
    assert.equal(record.stages[2].response.text, text);
  }
});

test('ambiguous, unclosed, quoted and code HTML details remain visible', () => {
  const block = '<details>\n<summary>## 对评审意见的处理说明</summary>\n说明\n</details>';
  for (const text of [
    block,
    `答案\n\n${block.replace('</details>', '')}`,
    `答案\n\n${block.replace('对评审意见的处理说明', '补充证明')}`,
    `答案\n\n\`\`\`html\n${block}\n\`\`\``,
    `答案\n\n${block.split('\n').map(line => '> ' + line).join('\n')}`,
  ]) assert.equal(renderRun(run(text)), text + '\n');
});

test('quoted, fenced, inline, ambiguous, or answerless notes remain intact', () => {
  for (const text of [
    '答案提到了“对评审意见的处理说明”，这是正文。',
    '答案\n> ## 对评审意见的处理说明\n> 引用内容',
    '答案\n```markdown\n## 对评审意见的处理说明\n样例\n```',
    '答案\n~~~~\n## 对评审意见的处理说明\n~~~\n仍是代码\n~~~~',
    '答案\n    ## 对评审意见的处理说明\n    缩进代码',
    '答案\n## 修改说明\n语义不明，不猜测',
    '## 对评审意见的处理说明\n这是唯一可用内容。',
  ]) assert.equal(renderRun(run(text)), text + '\n');
});

test('incomplete delivery retains all received text', () => {
  const text = '部分答案\n## 对评审意见的处理说明\n未写完';
  const record = run(text); record.status = 'partial'; record.stages[2].status = 'partial';
  assert.ok(renderRun(record).includes(text));
});
