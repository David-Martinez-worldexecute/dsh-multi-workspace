/**
 * tests/panel.test.mjs —— 面板的结构守卫。
 *
 * 为什么静态页面也要测：`panel/preview.html` 是用户唯一能"看见"的东西，
 * 它坏了不会抛异常、不会红 —— 只会点不动。而"点不动"是最难被自己发现的失败。
 *
 * 这里不跑浏览器，只做四件机械但有效的事：
 * ① 每个 `el('xxx')` / `getElementById('xxx')` 引用的 id，必须在 HTML 里真的存在；
 * ② 关键控件 id 一个不少（删了某个按钮会被这里拦住）；
 * ③ 不许出现内联 `onclick=`（内联回调在 CSP 下会失效，且无法测试）；
 * ④ 不许有任何外部网络依赖（这是一张"不联网"的本地页面，这条要守住）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL = join(HERE, '..', 'panel', 'preview.html');

function readPanel() {
  return readFileSync(PANEL, 'utf8');
}

test('panel：文件存在且不是空壳', () => {
  const html = readPanel();
  assert.ok(html.length > 20_000, `preview.html 只有 ${html.length} 字节，像是被写空过`);
  assert.ok(html.includes('<style>'), '缺少内联样式块');
  assert.ok(html.includes('<script>'), '缺少脚本块');
  assert.ok(html.trimEnd().endsWith('</html>'), '文件结尾被截断');
});

test('panel：脚本引用到的每个 id 都真实存在', () => {
  const html = readPanel();
  // id 有两种来源：HTML 属性，以及脚本里动态赋值（`section.id = 'sec-order'`）。
  // 只认前者会把"动态插入的区块"误判成缺失 —— 这是扫描器的盲区，不是页面的缺陷。
  const declared = new Set([
    ...[...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/\.id\s*=\s*'([^']+)'/g)].map((m) => m[1]),
  ]);
  const referenced = new Set([
    ...[...html.matchAll(/\bel\('([^']+)'\)/g)].map((m) => m[1]),
    ...[...html.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]),
  ]);

  const missing = [...referenced].filter((id) => !declared.has(id));
  assert.deepEqual(missing, [], `脚本引用了不存在的 id：${missing.join(', ')}`);
  assert.ok(referenced.size >= 15, `只找到 ${referenced.size} 个 id 引用，脚本可能没生效`);
});

test('panel：关键控件一个不少', () => {
  const html = readPanel();
  const required = [
    'page-panel', 'page-help', 'tab-panel', 'tab-help', 'fab-help',
    'roots-list', 'roots-empty', 'roots-hint', 'path-input', 'btn-add',
    'sim-tool', 'sim-path', 'btn-sim', 'sim-out', 'sim-steps',
    'status-list', 'help-sheet', 'toast',
    'btn-reset', 'btn-export', 'btn-focus-add',
    'help-roots', 'help-sim', 'help-limits', 'help-matrix',
    'page-matrix', 'tab-matrix', 'matrix-body', 'matrix-empty', 'matrix-hint',
    'matrix-sum', 'matrix-only-writable',
  ];
  const missing = required.filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `缺少控件：${missing.join(', ')}`);
});

test('panel：没有内联事件处理器（CSP 下会失效）', () => {
  const html = readPanel();
  const inline = [...html.matchAll(/\son(click|change|input|keydown|keyup|submit)\s*=/gi)].map((m) => m[0].trim());
  assert.deepEqual(inline, [], `发现内联事件处理器：${inline.join(', ')}`);
});

test('panel：四个能力位与 12 步判定都在（文案不能悄悄少一条）', () => {
  const html = readPanel();
  for (const cap of ['read', 'write', 'delete', 'move']) {
    assert.ok(html.includes(`${cap}:`), `能力位 ${cap} 的元数据不见了`);
  }
  // 判定顺序是安全语义：SENSITIVE_DENIED 必须被写明"先于根匹配"
  assert.ok(html.includes('SENSITIVE_DENIED'), '缺少敏感名单错误码说明');
  assert.ok(html.includes('PATH_OUTSIDE_SCOPE'), '缺少越界错误码说明');
  assert.ok(html.includes('12 步'), '判定顺序标题被改掉了');
});

test('panel：FAQ 正好 8 条（用户要求的疑问页）', () => {
  const html = readPanel();
  const start = html.indexOf('const FAQ = [');
  assert.ok(start > 0, '找不到 FAQ 定义');
  const end = html.indexOf('];', start);
  const body = html.slice(start, end);
  const count = [...body.matchAll(/^\s{2}\{\s*$/gm)].length;
  assert.equal(count, 8, `FAQ 条目数变成 ${count} 条`);
});

test('panel：不联网、不读本地文件、不写任何东西', () => {
  const html = readPanel();
  assert.ok(!/https?:\/\/[^\s"'<)]+/i.test(html.replace(/lang="zh-CN"/g, '')), '页面里出现了外部 URL');
  assert.ok(!/\bfetch\s*\(/.test(html), '出现了 fetch( —— 这个页面必须是纯本地');
  assert.ok(!/XMLHttpRequest/.test(html), '出现了 XMLHttpRequest');
  assert.ok(!/require\s*\(|from\s+'node:/.test(html), '页面里不该有 Node 模块引用');
});

test('panel：只把演示数据存在 localStorage 的固定键上', () => {
  const html = readPanel();
  assert.ok(html.includes("const STORE_KEY = 'mw-panel-demo-v1'"), 'localStorage 键被改了（会让老数据失效）');
  assert.ok(html.includes('localStorage.setItem(STORE_KEY'), '没有持久化演示数据');
});


test('panel：内联脚本能编译（语法错会让整页点不动，且不报错）', () => {
  const html = readPanel();
  const match = /<script>([\s\S]*)<\/script>/.exec(html);
  assert.ok(match, '找不到脚本块');
  // new Function 只编译不执行：能过就说明至少在语法上是完整的。
  assert.doesNotThrow(() => new Function(match[1]), '内联脚本有语法错误');
});

test('panel：能力对比表的实现与说明都在', () => {
  const html = readPanel();
  assert.ok(html.includes('renderMatrix('), '缺少 renderMatrix 实现');
  assert.ok(html.includes('matrix-only-writable'), '缺少「只看可写」开关');
  assert.ok(html.includes('最长前缀优先'), '缺少嵌套根的读法说明');
  assert.ok(html.includes('包含 ${children.length} 个子根'), '缺少子根徽标');
});

test('panel：第一次使用的引导卡在（离线预览也得让人知道从哪儿开始）', () => {
  const html = readPanel();
  assert.ok(html.includes('guide-card'), '缺少引导卡');
  assert.ok(html.includes('第一次用？三步就够'), '缺少引导卡标题');
  assert.ok(html.includes('guide-ok'), '缺少「知道了」按钮');
  assert.ok(
    html.includes('加一个根') && html.includes('选能力位') && html.includes('让 Agent 用它'),
    '引导卡三步不全',
  );
  // 收起必须走 addEventListener；内联 onclick 一律不要（与面板其它按钮一致）
  assert.ok(!/\sonclick\s*=/.test(html), '出现了内联 onclick');
});
