/**
 * tests/docs.test.mjs —— 开源仓库「形状」的守卫。
 *
 * 为什么需要它：README 里的截图路径、TOC 锚点、许可证名称、issue 模板，
 * 全都是"写了但不会报错"的东西 —— 断链只在读者点开时 404。
 * 这组断言把"看起来规范"变成"机器能检查"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const has = (rel) => existsSync(join(ROOT, rel));

test('README 首屏有徽章、双语定位与面板截图', () => {
  const md = read('README.md');
  assert.match(md, /badge\.svg/, '缺 CI 徽章');
  assert.match(md, /img\.shields\.io\/badge\/license-MIT/, '缺 license 徽章');
  assert.match(md, /docs\/panel-preview\.png/, '缺面板截图引用');
  assert.match(md, /DeepSeek Harness/, '缺项目定位');
  // 双语：标题行里同时有中文与英文短语
  assert.match(md, /^# dsh-multi-workspace$/m);
  assert.match(md, /给 DeepSeek Harness 的 Agent/);
  assert.match(md, /Multiple writable workspaces for DSH agents/);
});

test('面板截图真的存在，而且不是空壳', () => {
  const file = join(ROOT, 'docs', 'panel-preview.png');
  assert.equal(existsSync(file), true, 'docs/panel-preview.png 不存在');
  const size = statSync(file).size;
  assert.ok(size > 20 * 1024, `截图只有 ${size} 字节，像是空白页`);
  const head = readFileSync(file).subarray(0, 8);
  assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], '不是 PNG 魔数');
});

test('README 的本地链接与图片都能落地（断链只有读者会撞到）', () => {
  const md = read('README.md');
  const links = [...md.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
  const local = links
    .filter((l) => !/^(https?:|mailto:|#)/i.test(l))
    .map((l) => l.split('#')[0])
    .filter(Boolean);
  assert.ok(local.length >= 5, `本地链接只有 ${local.length} 个，README 看起来没接上`);
  const missing = local.filter((l) => !existsSync(resolve(ROOT, l)));
  assert.deepEqual(missing, [], `README 里有断链：${missing.join(', ')}`);
});

test('README 的 TOC 与正文二级标题数量对得上', () => {
  const md = read('README.md');
  const headings = [...md.matchAll(/^## (.+)$/gm)]
    .map((m) => m[1])
    .filter((t) => !/^(目录|快速开始)/.test(t));
  const tocRows = [...md.matchAll(/^\| \[(\d+) ·/gm)].map((m) => m[1]);
  assert.ok(headings.length >= 15, `正文二级标题只有 ${headings.length} 个`);
  assert.equal(tocRows.length, headings.length, 'TOC 行数与正文标题数不一致');
});

test('开源必备文件齐全（许可证 / 贡献 / 行为准则 / 安全 / 变更）', () => {
  for (const rel of ['LICENSE', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md', 'CHANGELOG.md']) {
    assert.equal(has(rel), true, `缺 ${rel}`);
    assert.ok(read(rel).trim().length > 200, `${rel} 内容太短，像是占位`);
  }
  assert.match(read('LICENSE'), /MIT License/, 'LICENSE 不是 MIT');
});

test('GitHub issue / PR 模板齐全且是结构化表单', () => {
  const bug = read('.github/ISSUE_TEMPLATE/bug_report.yml');
  const feat = read('.github/ISSUE_TEMPLATE/feature_request.yml');
  for (const [name, text] of [['bug_report', bug], ['feature_request', feat]]) {
    assert.match(text, /^name: /m, `${name} 缺 name`);
    assert.match(text, /^description: /m, `${name} 缺 description`);
    assert.match(text, /^body:/m, `${name} 不是 issue forms 结构`);
    assert.match(text, /type: textarea/, `${name} 缺输入区`);
  }
  assert.match(read('.github/ISSUE_TEMPLATE/config.yml'), /contact_links:/);
  assert.ok(has('.github/PULL_REQUEST_TEMPLATE.md'));
  assert.match(read('.github/PULL_REQUEST_TEMPLATE.md'), /node tests\/run-all\.mjs/);
});

test('package.json 是"可发布"的形状（不是 private 玩具包）', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.private, undefined, '还留着 private');
  assert.equal(pkg.license, 'MIT');
  assert.ok(pkg.repository?.url?.includes('github.com'), '缺 repository');
  assert.ok(pkg.homepage && pkg.bugs?.url, '缺 homepage/bugs');
  assert.ok(pkg.files.includes('docs/'), 'files 里没有 docs/，npm 包会丢截图');
  assert.ok(pkg.files.includes('CONTRIBUTING.md'), 'files 里没有 CONTRIBUTING.md');
  assert.ok(pkg.engines.node, '缺 engines.node');
  assert.equal(pkg.dependencies, undefined, '不要引入运行时依赖');
});

test('两个入口都在 exports 里（缺 ./client 就是"装了但没界面"）', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.exports['.'], './src/index.mjs');
  assert.equal(pkg.exports['./client'], './lib/client.js');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.ok(has('lib/client.js') && has('src/index.mjs') && has('cordis.patch.yml'));
});
