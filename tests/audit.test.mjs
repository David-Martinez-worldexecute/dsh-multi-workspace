/**
 * tests/audit.test.mjs —— 审计器测试。
 *
 * 关键点不是"能写日志"，而是三件事：
 *   ① 参数值**不进磁盘**（只留形状）；
 *   ② 达到阈值真的会轮转（否则文档里那句"5MB 轮转"是空话）；
 *   ③ 写失败不抛异常（日志坏了不能让被审计的动作也失败）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { AUDIT_DEFAULT_FILE, createAudit, summarizeArgs } from '../src/audit.mjs';

/** 内存假 fs：拿一个 Map 当磁盘。 */
function memFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const calls = [];
  return {
    files,
    calls,
    existsSync(path) {
      return files.has(path);
    },
    statSync(path) {
      if (!files.has(path)) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return { size: Buffer.byteLength(files.get(path), 'utf8') };
    },
    mkdirSync(dir) {
      calls.push(['mkdir', dir]);
    },
    appendFileSync(path, data) {
      files.set(path, `${files.get(path) ?? ''}${data}`);
    },
    readFileSync(path) {
      if (!files.has(path)) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(path);
    },
    renameSync(from, to) {
      calls.push(['rename', from, to]);
      files.set(to, files.get(from));
      files.delete(from);
    },
    rmSync(path) {
      calls.push(['rm', path]);
      files.delete(path);
    },
  };
}

const FIXED_NOW = () => new Date('2026-11-20T03:00:00.000Z');

test('summarizeArgs：只给形状，不给值（凭据不进磁盘）', () => {
  // 夹具故意用一个看起来像凭据的串，验证它只被记录成形状；标记豁免以免误报
  const shape = summarizeArgs({ path: 'D:/x', token: 'sk-super-secret', n: 3, ok: true, list: [1, 2] }); // privacy-check: allow
  assert.deepEqual(shape, {
    path: 'string:4',
    token: 'string:15', // privacy-check: allow
    n: 'number',
    ok: 'boolean',
    list: 'array:2',
  });
  assert.equal(JSON.stringify(shape).includes('super-secret'), false);
});

test('record：写一行 JSONL，含 ts/tool/code', () => {
  const fs = memFs();
  const audit = createAudit({ file: 'a.jsonl', fs, now: FIXED_NOW });
  const result = audit.record({ tool: 'write', code: 'PATH_OUTSIDE_SCOPE', path: 'D:\\x' });
  assert.equal(result.written, true);
  const lines = fs.files.get('a.jsonl').trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.tool, 'write');
  assert.equal(parsed.code, 'PATH_OUTSIDE_SCOPE');
  assert.equal(parsed.ts, '2026-11-20T03:00:00.000Z');
});

test('record：enabled=false 时不写', () => {
  const fs = memFs();
  const audit = createAudit({ file: 'a.jsonl', fs, enabled: false });
  const result = audit.record({ tool: 'write', code: 'OK' });
  assert.equal(result.written, false);
  assert.equal(result.reason, 'DISABLED');
  assert.equal(fs.files.size, 0);
});

test('record：超过 maxBytes 会轮转成 .1（阈值真的会触发）', () => {
  const big = 'x'.repeat(64);
  const fs = memFs({ 'a.jsonl': `${big}\n` });
  const audit = createAudit({ file: 'a.jsonl', fs, maxBytes: 32, keep: 1, now: FIXED_NOW });
  audit.record({ tool: 'write', code: 'OK' });
  assert.equal(fs.files.has('a.jsonl.1'), true);
  // 新文件里只有新写的那一行
  const lines = fs.files.get('a.jsonl').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(audit.stats.rotated, 1);
});

test('record：轮转保留份数受 keep 限制（第 3 份起被删）', () => {
  const fs = memFs({ 'a.jsonl': 'old\n', 'a.jsonl.1': 'one\n', 'a.jsonl.2': 'two\n' });
  const audit = createAudit({ file: 'a.jsonl', fs, maxBytes: 1, keep: 2, now: FIXED_NOW });
  audit.record({ tool: 'write', code: 'OK' });
  // keep=2 = 只留 .1 与 .2：最老的 .2 被丢掉，.1 后移成 .2，当前文件变成 .1
  assert.equal(fs.calls.some((call) => call[0] === 'rm' && call[1] === 'a.jsonl.2'), true);
  assert.equal(fs.files.get('a.jsonl.1'), 'old\n');
  assert.equal(fs.files.get('a.jsonl.2'), 'one\n');
});

test('record：写盘失败不抛异常，只返回错误（日志坏了不能挡住业务）', () => {
  const fs = memFs();
  fs.appendFileSync = () => {
    throw new Error('EROFS: read-only file system');
  };
  const audit = createAudit({ file: 'a.jsonl', fs });
  const result = audit.record({ tool: 'write', code: 'OK' });
  assert.equal(result.written, false);
  assert.equal(result.reason, 'AUDIT_WRITE_FAILED');
  assert.match(result.error, /EROFS/);
  assert.equal(audit.stats.failed, 1);
});

test('tail：返回最近 n 行，文件不存在时返回空数组', () => {
  const fs = memFs({ 'a.jsonl': '{"i":1}\n{"i":2}\n{"i":3}\n' });
  const audit = createAudit({ file: 'a.jsonl', fs });
  assert.deepEqual(audit.tail(2), ['{"i":2}', '{"i":3}']);
  const missing = createAudit({ file: 'nope.jsonl', fs });
  assert.deepEqual(missing.tail(5), []);
});

test('默认值：文件路径在工作区内（不会往别处写）', () => {
  assert.equal(AUDIT_DEFAULT_FILE, '.dsh/multi-workspace-audit.jsonl');
  const audit = createAudit({ fs: memFs() });
  assert.equal(audit.file, AUDIT_DEFAULT_FILE);
});
