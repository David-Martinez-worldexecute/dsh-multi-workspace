/**
 * tests/cli.test.mjs —— 本地控制台的测试。
 *
 * 全部用假 fs：CLI 的价值是"在还没装进 DSH 的时候就能用"，
 * 所以它的测试也不应该依赖真磁盘或真 profile。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createCli, parseArgs, scanAdditionalRoots, CLI_DEFAULT_FILE } from '../src/cli.mjs';

const WS = 'D:\\work\\Desktop\\ws';
const ROOT = `${WS}\\.dsh\\workspace-roots.json`;

function memFs(seed = {}) {
  const files = new Map(Object.entries(seed));
  const calls = [];
  return {
    files,
    calls,
    lstatSync(path) {
      if (!files.has(path)) {
        const err = new Error(`ENOENT: ${path}`);
        err.code = 'ENOENT';
        throw err;
      }
      return { isDirectory: () => true, isSymbolicLink: () => false };
    },
    readFileSync(path) {
      if (!files.has(path)) {
        const err = new Error(`ENOENT: ${path}`);
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(path);
    },
    writeFileSync(path, data) {
      calls.push(['write', path]);
      files.set(path, String(data));
    },
    mkdirSync(path) {
      calls.push(['mkdir', path]);
    },
    unlinkSync(path) {
      calls.push(['unlink', path]);
      files.delete(path);
    },
    randomBytes: (n) => Buffer.alloc(n, 7),
  };
}

// 夹具默认把 profile patch 指到 `C:\profile.yml`：三条 diff 用例都往这个路径种内容，
// 不传 profilePatch 就会一律回 NO_PROFILE_PATH —— 那是夹具漏参数，不是 CLI 的缺陷。
function build({ fs = memFs(), profilePatch = 'C:\\profile.yml' } = {}) {
  const cli = createCli({ platform: 'win32', fs, workspaceRoot: WS, rootFile: ROOT, profilePatch });
  return { cli, fs };
}

const docWith = (roots) => ({ version: 2, roots });

test('list：没有登记时给一句人话，而不是空表格', () => {
  const { cli } = build();
  const out = cli.run(['list']);
  assert.equal(out.ok, true);
  assert.match(out.lines.join('\n'), /还没有登记/);
});

test('add：合法目录 → ADDED，并真的写入规则文件', () => {
  const { cli, fs } = build({ fs: memFs({ 'D:\\work\\a': '' }) });
  const out = cli.run(['add', 'D:\\work\\a', '--caps', 'read,write']);
  assert.equal(out.ok, true);
  assert.equal(out.code, 'ADDED');
  const saved = JSON.parse(fs.files.get(ROOT));
  assert.equal(saved.roots.length, 1);
  assert.deepEqual([...saved.roots[0].capabilities].sort(), ['read', 'write']);
});

test('add：同一个根再加一次 → UPDATED 且能力位合并（幂等）', () => {
  const { cli, fs } = build({
    fs: memFs({
      'D:\\work\\a': '',
      [ROOT]: JSON.stringify(docWith([{ path: 'D:\\work\\a', capabilities: ['read'] }])),
    }),
  });
  const out = cli.run(['add', 'D:\\work\\a', '--caps', 'write']);
  assert.equal(out.code, 'UPDATED');
  const saved = JSON.parse(fs.files.get(ROOT));
  assert.deepEqual([...saved.roots[0].capabilities].sort(), ['read', 'write']);
});

test('add：工作区内的路径 → PATH_INSIDE_WORKSPACE，不写文件', () => {
  const { cli, fs } = build({ fs: memFs({ [`${WS}\\sub`]: '' }) });
  const out = cli.run(['add', `${WS}\\sub`]);
  assert.equal(out.ok, true);
  assert.equal(out.code, 'PATH_INSIDE_WORKSPACE');
  assert.equal(fs.files.has(ROOT), false);
});

test('add：相对路径被拒（PATH_NOT_ABSOLUTE）', () => {
  const { cli } = build();
  const out = cli.run(['add', 'work\\a']);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'PATH_NOT_ABSOLUTE');
});

test('add：不存在的目录被拒（PATH_MISSING）', () => {
  const { cli } = build();
  const out = cli.run(['add', 'D:\\nope']);
  assert.equal(out.code, 'PATH_MISSING');
});

test('remove：已登记 → REMOVED，未登记 → NOT_FOUND', () => {
  const { cli, fs } = build({
    fs: memFs({ 'D:\\work\\a': '', [ROOT]: JSON.stringify(docWith([{ path: 'D:\\work\\a' }])) }),
  });
  assert.equal(cli.run(['remove', 'D:\\work\\a']).code, 'REMOVED');
  assert.equal(JSON.parse(fs.files.get(ROOT)).roots.length, 0);
  assert.equal(cli.run(['remove', 'D:\\work\\a']).code, 'NOT_FOUND');
});

test('validate 只校验，不写文件', () => {
  const { cli, fs } = build({ fs: memFs({ 'D:\\work\\a': '' }) });
  const out = cli.run(['validate', 'D:\\work\\a']);
  assert.equal(out.code, 'OK');
  assert.equal(fs.calls.some((call) => call[0] === 'write'), false);
});

test('probe：写不进去 → PROBE_DENIED，并把底层错误带出来', () => {
  const { cli } = build({
    fs: {
      ...memFs(),
      writeFileSync() {
        const err = new Error('EPERM: operation not permitted');
        err.code = 'EPERM';
        throw err;
      },
    },
  });
  const out = cli.run(['probe', 'D:\\locked']);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'PROBE_DENIED');
  assert.match(out.lines.join('\n'), /EPERM/);
});

test('diff：profile 里没有 additionalWritableRoots → PROFILE_NO_KEY（不是"一致"）', () => {
  const { cli } = build({
    fs: memFs({ 'C:\\profile.yml': 'rows:\n  - id: x\n' }),
  });
  const out = cli.run(['diff']);
  assert.equal(out.code, 'PROFILE_NO_KEY');
});

test('diff：profile 与规则都空 → IN_SYNC', () => {
  const { cli } = build({
    fs: memFs({ 'C:\\profile.yml': 'rows:\n  - id: sandbox-policy\n    additionalWritableRoots: []\n' }),
  });
  assert.equal(cli.run(['diff']).code, 'IN_SYNC');
});

test('diff：规则有、profile 没有 → DRIFT 并列出缺失项', () => {
  const seeded = memFs({
    'D:\\work\\a': '',
    'C:\\profile.yml': 'rows:\n  - id: sandbox-policy\n    additionalWritableRoots: []\n',
    [ROOT]: JSON.stringify(docWith([{ path: 'D:\\work\\a', capabilities: ['read', 'write'] }])),
  });
  const { cli } = build({ fs: seeded });
  const out = cli.run(['diff']);
  assert.equal(out.code, 'DRIFT');
  assert.match(out.lines.join('\n'), /缺（规则有、profile 没有）：D:\\work\\a/);
});

test('scanAdditionalRoots：认块列表，也认行内数组', () => {
  const block = scanAdditionalRoots('x:\n  additionalWritableRoots:\n    - D:\\a\n    - D:\\b\n  next: 1\n');
  assert.deepEqual(block, { found: true, roots: ['D:\\a', 'D:\\b'] });
  const inline = scanAdditionalRoots('additionalWritableRoots: ["D:\\a"]\n');
  assert.deepEqual(inline, { found: true, roots: ['D:\\a'] });
});

test('parseArgs：--caps=read 与位置参数都能拆开', () => {
  const parsed = parseArgs(['add', 'D:\\a', '--caps=read', '--mode', 'ro']);
  assert.equal(parsed.command, 'add');
  assert.deepEqual(parsed.positional, ['D:\\a']);
  assert.equal(parsed.flags.caps, 'read');
  assert.equal(parsed.flags.mode, 'ro');
});

test('默认规则文件路径在工作区的 .dsh 下（不写到用户目录）', () => {
  const { cli } = build();
  assert.equal(cli.rootFile, `${WS}\\${CLI_DEFAULT_FILE.replace('/', '\\')}`);
});
