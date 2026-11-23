/**
 * rules.mjs 的测试 —— 每一条都对应一个"会真的发生"的判定问题。
 * 跑法：`node tests/rules.test.mjs`（不要用 `node --test`，本机沙箱禁 spawn）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAP,
  RULE_CODE,
  DEFAULT_SENSITIVE,
  TOOL_SPECS,
  SHELL_TOOLS,
  normalizeRoot,
  compileDoc,
  resolve,
  summarize,
} from '../src/rules.mjs';

const WIN = 'win32';
const NOW = 1_700_000_000_000;

const BASE_DOC = {
  roots: [
    { path: 'D:\\work\\proj-a', caps: ['read', 'write', 'delete', 'move'] },
    { path: 'D:\\work\\proj-a\\secret', caps: ['read'] },
    { path: 'D:\\shared', caps: ['read', 'write'] },
  ],
  sensitive: { deny: DEFAULT_SENSITIVE },
};

/** 跑一次判定，只看 code（没拒绝就是 undefined）。 */
function codeOf(name, args, extra = {}) {
  const res = resolve({
    name,
    args,
    doc: BASE_DOC,
    platform: WIN,
    mode: 'workspace-write',
    enforceRead: false,
    now: NOW,
    ...extra,
  });
  return res.code;
}

test('不认识的工具不干预', () => {
  assert.equal(codeOf('some_other_plugin_tool', { path: 'D:\\secrets\\x' }), undefined);
});

test('shell 默认直接拒（命令里的路径看不见）', () => {
  assert.equal(codeOf('pwsh', { command: 'Get-ChildItem D:\\' }), RULE_CODE.SHELL_UNCONTROLLED);
  assert.equal(codeOf('ops_bash', { command: 'ls' }), RULE_CODE.SHELL_UNCONTROLLED);
});

test('shell allowlist 支持完整命令等值放行', () => {
  const doc = { ...BASE_DOC, shell: { mode: 'allowlist', allowlist: ['git status'] } };
  assert.equal(codeOf('pwsh', { command: 'git status' }, { doc }), undefined);
});

test('shell allowlist 不能用前缀绕过（&& 追加命令必须被拒）', () => {
  const doc = { ...BASE_DOC, shell: { mode: 'allowlist', allowlist: ['git status'] } };
  assert.equal(codeOf('pwsh', { command: 'git status && del x' }, { doc }), RULE_CODE.SHELL_UNCONTROLLED);
});

test('敏感文件在允许的根里也拦（.env）', () => {
  assert.equal(codeOf('write', { file_path: 'D:\\work\\proj-a\\.env' }), RULE_CODE.SENSITIVE_DENIED);
  assert.equal(codeOf('write', { file_path: 'D:\\work\\proj-a\\config\\prod.env' }), undefined);
});

test('敏感文件按扩展名拦（*.pem / id_rsa）', () => {
  assert.equal(codeOf('write', { file_path: 'D:\\work\\proj-a\\certs\\a.pem' }), RULE_CODE.SENSITIVE_DENIED);
  assert.equal(codeOf('write', { file_path: 'D:\\work\\proj-a\\keys\\id_rsa' }), RULE_CODE.SENSITIVE_DENIED);
});

test('敏感目录按段拦（.ssh/**）', () => {
  assert.equal(codeOf('read', { file_path: 'D:\\work\\.ssh\\id_rsa' }, { enforceRead: true }), RULE_CODE.SENSITIVE_DENIED);
});

test('根外写 → PATH_OUTSIDE_SCOPE', () => {
  assert.equal(codeOf('write', { file_path: 'D:\\elsewhere\\x.txt' }), RULE_CODE.PATH_OUTSIDE_SCOPE);
});

test('最长前缀优先：secret 子根只给读', () => {
  assert.equal(codeOf('write', { file_path: 'D:\\work\\proj-a\\secret\\x.txt' }), RULE_CODE.CAPABILITY_DENIED);
  assert.equal(codeOf('write', { file_path: 'D:\\work\\proj-a\\src\\x.txt' }), undefined);
});

test('前缀相似但不相同不算在根内（proj-ab ≠ proj-a）', () => {
  assert.equal(codeOf('write', { file_path: 'D:\\work\\proj-ab\\x.txt' }), RULE_CODE.PATH_OUTSIDE_SCOPE);
});

test('大小写不敏感（Windows 语义）', () => {
  assert.equal(codeOf('write', { file_path: 'd:\\WORK\\Proj-A\\x.txt' }), undefined);
});

test('只有读写能力的根上删除 → CAPABILITY_DENIED', () => {
  assert.equal(codeOf('ops_remove', { path: 'D:\\shared\\old.txt' }), RULE_CODE.CAPABILITY_DENIED);
});

test('全能力根上删除放行', () => {
  assert.equal(codeOf('ops_remove', { path: 'D:\\work\\proj-a\\old.txt' }), undefined);
});

test('全局 read-only 模式拦写与删', () => {
  assert.equal(codeOf('write', { file_path: 'D:\\work\\proj-a\\x.txt' }, { mode: 'read-only' }), RULE_CODE.READ_ONLY_MODE);
  assert.equal(codeOf('ops_remove', { path: 'D:\\work\\proj-a\\x.txt' }, { mode: 'read-only' }), RULE_CODE.READ_ONLY_MODE);
});

test('读默认不管；enforceRead 之后管', () => {
  assert.equal(codeOf('read', { file_path: 'D:\\anywhere\\x.txt' }), undefined);
  assert.equal(codeOf('read', { file_path: 'D:\\anywhere\\x.txt' }, { enforceRead: true }), RULE_CODE.PATH_OUTSIDE_SCOPE);
});

test('只读根（mode: ro）拦写但放读', () => {
  const doc = { roots: [{ path: 'D:\\ro', caps: ['read', 'write'], mode: 'ro' }] };
  assert.equal(codeOf('write', { file_path: 'D:\\ro\\x.txt' }, { doc }), RULE_CODE.READ_ONLY_ROOT);
  assert.equal(codeOf('read', { file_path: 'D:\\ro\\x.txt' }, { doc, enforceRead: true }), undefined);
});

test('exclude 规则拦指定子路径', () => {
  const doc = { roots: [{ path: 'D:\\work', caps: ['read', 'write', 'delete', 'move'], exclude: ['**/node_modules/**', '*.log'] }] };
  assert.equal(codeOf('write', { file_path: 'D:\\work\\app\\node_modules\\x.js' }, { doc }), RULE_CODE.EXCLUDED_PATH);
  assert.equal(codeOf('write', { file_path: 'D:\\work\\app\\run.log' }, { doc }), RULE_CODE.EXCLUDED_PATH);
  assert.equal(codeOf('write', { file_path: 'D:\\work\\app\\main.js' }, { doc }), undefined);
});

test('include 规则把写限制在子集里（读不受限）', () => {
  const doc = { roots: [{ path: 'D:\\work', caps: ['read', 'write'], include: ['src/**', 'docs/**'] }] };
  assert.equal(codeOf('write', { file_path: 'D:\\work\\src\\a.js' }, { doc }), undefined);
  assert.equal(codeOf('write', { file_path: 'D:\\work\\package.json' }, { doc }), RULE_CODE.NOT_INCLUDED);
  assert.equal(
    codeOf('read', { file_path: 'D:\\work\\package.json' }, { doc, enforceRead: true }),
    undefined,
  );
});

test('限时授权过期 → GRANT_EXPIRED', () => {
  const doc = { roots: [{ path: 'D:\\tmp-grant', caps: ['read', 'write'], expiresAt: NOW - 1 }] };
  assert.equal(codeOf('write', { file_path: 'D:\\tmp-grant\\x.txt' }, { doc }), RULE_CODE.GRANT_EXPIRED);
});

test('限时授权未过期 → 放行', () => {
  const doc = { roots: [{ path: 'D:\\tmp-grant', caps: ['read', 'write'], expiresAt: NOW + 60_000 }] };
  assert.equal(codeOf('write', { file_path: 'D:\\tmp-grant\\x.txt' }, { doc }), undefined);
});

test('没有路径参数不误伤', () => {
  assert.equal(codeOf('write', {}), undefined);
  assert.equal(codeOf('grep', { pattern: 'x' }), undefined);
});

test('files[].path 数组形态也能抽出来', () => {
  assert.equal(codeOf('ops_read_files', { files: [{ path: 'D:\\any\\a.txt' }] }, { enforceRead: true }), RULE_CODE.PATH_OUTSIDE_SCOPE);
});

test('多个路径里只要有一个越界就拒', () => {
  assert.equal(
    codeOf('ops_move', { path: 'D:\\work\\proj-a\\a.txt', to: 'D:\\outside\\a.txt' }),
    RULE_CODE.PATH_OUTSIDE_SCOPE,
  );
});

test('POSIX 平台不被 Windows 斜杠规则污染', () => {
  const doc = { roots: [{ path: '/srv/app', caps: ['read', 'write'] }] };
  assert.equal(
    resolve({ name: 'write', args: { file_path: '/srv/app/a.txt' }, doc, platform: 'linux', now: NOW }).code,
    undefined,
  );
  assert.equal(
    resolve({ name: 'write', args: { file_path: '/srv/other/a.txt' }, doc, platform: 'linux', now: NOW }).code,
    RULE_CODE.PATH_OUTSIDE_SCOPE,
  );
});

test('字符串根 = 四能力全给', () => {
  const r = normalizeRoot('D:\\anything', WIN);
  assert.deepEqual([...r.caps].sort(), [CAP.DELETE, CAP.MOVE, CAP.READ, CAP.WRITE].sort());
  assert.equal(r.mode, 'rw');
});

test('坏根规则直接抛，不静默跳过', () => {
  assert.throws(() => normalizeRoot({ caps: ['read'] }, WIN), /BAD_RULE/);
});

test('compileDoc 把最长前缀排到前面（判定顺序的前提）', () => {
  const d = compileDoc({ roots: [{ path: 'D:\\a', caps: ['read'] }, { path: 'D:\\a\\b\\c', caps: ['read'] }] }, WIN);
  assert.equal(d.roots[0].path, 'D:\\a\\b\\c');
});

test('summarize 给出人话摘要', () => {
  const text = summarize(BASE_DOC, WIN);
  assert.match(text, /活动范围 3 个/);
  assert.match(text, /shell：一律拒绝/);
});

test('工具表与 shell 名单自洽（表里不该混进 shell 工具）', () => {
  for (const name of SHELL_TOOLS) assert.equal(TOOL_SPECS.has(name), false);
});

test('空根 = 不围栏：装上插件不该等于把整个 Agent 的写权限关掉', () => {
  const res = resolve({
    name: 'write',
    args: { file_path: 'D:\\anywhere\\a.txt' },
    doc: { roots: [] },
    platform: WIN,
  });
  assert.equal(res.denial, undefined, '根一个都没登记时不该有任何拒绝');
});

test('allowShell: true 是总闸，打开就放行 shell（不再看 doc.shell.mode）', () => {
  const res = resolve({
    name: 'pwsh',
    args: { command: 'git status' },
    doc: { roots: [{ path: 'D:\\work', caps: ['read', 'write'] }] },
    platform: WIN,
    allowShell: true,
  });
  assert.equal(res.denial, undefined);
});

test('不给 allowShell 时 shell 仍然被拒（默认口子是关的）', () => {
  const res = resolve({
    name: 'pwsh',
    args: { command: 'git status' },
    doc: { roots: [{ path: 'D:\\work', caps: ['read', 'write'] }] },
    platform: WIN,
  });
  assert.equal(res.code, RULE_CODE.SHELL_UNCONTROLLED);
});
