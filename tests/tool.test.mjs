/**
 * tests/tool.test.mjs —— `workspace_roots` 工具面的测试。
 *
 * 全部用假 fs + 假 configEditor + 假审批：
 * 不碰真 profile、不碰真磁盘（除了 probe 用的是假 fs，也就没真写）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { win32 } from 'node:path';

import { createStore } from '../src/store.mjs';
import { createAudit } from '../src/audit.mjs';
import { createWorkspaceRootsTool } from '../src/tool.mjs';

const W = 'win32';

/** 假 fs：只够 checkRoot（lstat）与 probe（write/unlink）用。 */
function fakeFs(entries = {}) {
  const kinds = new Map(Object.entries(entries).map(([path, kind]) => [path.toLowerCase(), kind]));
  const written = [];
  const removed = [];
  return {
    written,
    removed,
    lstatSync(target) {
      const kind = kinds.get(String(target).toLowerCase());
      if (!kind) {
        const err = new Error(`ENOENT: no such file or directory, lstat '${target}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return {
        isSymbolicLink: () => kind === 'symlink',
        isDirectory: () => kind === 'dir',
        isFile: () => kind === 'file',
      };
    },
    writeFileSync(path, data, opts) {
      written.push({ path, data, opts });
    },
    unlinkSync(path) {
      removed.push(path);
    },
  };
}

function fakeEditor(initial = { roots: [] }) {
  const state = { config: JSON.parse(JSON.stringify(initial)), edits: [] };
  return {
    state,
    async edit(entry, change) {
      state.edits.push(entry);
      state.config = change(state.config, state.config);
    },
    async read() {
      return state.config;
    },
  };
}

function build({ entries = { 'D:\\work\\a': 'dir', 'D:\\work\\b': 'dir' }, config, approve, requireApproval, session, evaluate, doctor } = {}) {
  const editor = fakeEditor(config ?? { roots: [] });
  const fs = fakeFs(entries);
  const store = createStore({ configEditor: editor, readConfig: () => editor.state.config, platform: W });
  const audit = createAudit({ enabled: false });
  const tool = createWorkspaceRootsTool({
    store,
    audit,
    fs,
    platform: W,
    workspaceRoot: 'D:\\work\\Desktop\\ws',
    approve,
    requireApproval,
    session,
    evaluate,
    doctor,
  });
  return { editor, fs, store, tool };
}

const approveYes = async () => true;
const approveNo = async () => false;

test('list：空文档也能给出可读结果', async () => {
  const { tool } = build();
  const out = await tool.execute({ action: 'list' });
  assert.equal(out.ok, true);
  assert.equal(out.data.roots.length, 0);
  assert.match(out.data.shell.mode, /deny/);
});

test('不认识 action → UNKNOWN_ACTION（不是静默 ok）', async () => {
  const { tool } = build();
  const out = await tool.execute({ action: 'explode' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'UNKNOWN_ACTION');
});

test('add 缺 path → PATH_MISSING_ARG', async () => {
  const { tool } = build({ approve: approveYes });
  const out = await tool.execute({ action: 'add' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'PATH_MISSING_ARG');
});

test('add 相对路径 → PATH_NOT_ABSOLUTE，且不写配置', async () => {
  const { tool, editor } = build({ approve: approveYes });
  const out = await tool.execute({ action: 'add', path: 'work\\a' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'PATH_NOT_ABSOLUTE');
  assert.equal(editor.state.edits.length, 0);
});

test('add 不存在的目录 → PATH_MISSING，且不写配置', async () => {
  const { tool, editor } = build({ approve: approveYes });
  const out = await tool.execute({ action: 'add', path: 'D:\\nope' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'PATH_MISSING');
  assert.equal(editor.state.edits.length, 0);
});

test('add 合法目录 + 已批准 → ADDED，只 edit 一次', async () => {
  const { tool, editor } = build({ approve: approveYes });
  const out = await tool.execute({ action: 'add', path: 'D:/work/a/' });
  assert.equal(out.ok, true);
  assert.equal(out.code, 'ADDED');
  assert.equal(editor.state.config.roots.length, 1);
  assert.equal(editor.state.config.roots[0].path, 'D:\\work\\a');
});

test('add 用户拒批 → APPROVAL_DENIED，配置零改动', async () => {
  const { tool, editor } = build({ approve: approveNo });
  const out = await tool.execute({ action: 'add', path: 'D:\\work\\a' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'APPROVAL_DENIED');
  assert.equal(editor.state.edits.length, 0);
});

test('add 没有审批入口时 fail closed（不给默认放行）', async () => {
  const { tool } = build({ approve: undefined });
  const out = await tool.execute({ action: 'add', path: 'D:\\work\\a' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'APPROVAL_UNAVAILABLE');
});

test('requireApproval=false 时不需要审批（本地控制台用）', async () => {
  const { tool } = build({ requireApproval: false });
  const out = await tool.execute({ action: 'add', path: 'D:\\work\\a' });
  assert.equal(out.ok, true);
  assert.equal(out.code, 'ADDED');
});

test('add 工作区内的路径 → 返回 PATH_INSIDE_WORKSPACE 且 ok:true（"不用加"，不是错误）', async () => {
  const { tool, editor } = build({
    entries: { 'D:\\work\\Desktop\\ws': 'dir', 'D:\\work\\Desktop\\ws\\sub': 'dir' },
    approve: approveYes,
  });
  const out = await tool.execute({ action: 'add', path: 'D:\\work\\Desktop\\ws\\sub' });
  assert.equal(out.ok, true);
  assert.equal(out.code, 'PATH_INSIDE_WORKSPACE');
  assert.equal(editor.state.edits.length, 0);
});

test('add 有能力的根再 add 一次 → UPDATED（幂等，不重复登记）', async () => {
  const { tool } = build({
    approve: approveYes,
    config: { roots: [{ path: 'D:\\work\\a', capabilities: ['read'] }] },
  });
  const out = await tool.execute({ action: 'add', path: 'D:\\work\\a', capabilities: ['write'] });
  assert.equal(out.ok, true);
  assert.equal(out.code, 'UPDATED');
});

test('remove 没登记过 → NOT_FOUND', async () => {
  const { tool } = build({ approve: approveYes });
  const out = await tool.execute({ action: 'remove', path: 'D:\\work\\a' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'NOT_FOUND');
});

test('remove 已登记 → REMOVED', async () => {
  const { tool, editor } = build({ approve: approveYes, config: { roots: ['D:\\work\\a'] } });
  const out = await tool.execute({ action: 'remove', path: 'D:\\work\\a' });
  assert.equal(out.ok, true);
  assert.equal(out.code, 'REMOVED');
  assert.equal(editor.state.config.roots.length, 0);
});

test('update 改能力位为只读', async () => {
  const { tool, editor } = build({ approve: approveYes, config: { roots: ['D:\\work\\a'] } });
  const out = await tool.execute({ action: 'update', path: 'D:\\work\\a', capabilities: ['read'], mode: 'ro' });
  assert.equal(out.ok, true);
  assert.equal(out.code, 'UPDATED');
  assert.deepEqual(editor.state.config.roots[0].capabilities, ['read']);
  assert.equal(editor.state.config.roots[0].mode, 'ro');
});

test('validate：合法目录 ok:true，且**不改**任何东西', async () => {
  const { tool, editor } = build();
  const out = await tool.execute({ action: 'validate', path: 'D:\\work\\b' });
  assert.equal(out.ok, true);
  assert.equal(editor.state.edits.length, 0);
});

test('probe：真写成功 → PROBE_OK，且临时文件被删掉', async () => {
  const { tool, fs } = build({ approve: approveYes });
  const out = await tool.execute({ action: 'probe', path: 'D:\\work\\a' });
  assert.equal(out.ok, true);
  assert.equal(out.code, 'PROBE_OK');
  assert.equal(fs.written.length, 1);
  assert.equal(fs.removed.length, 1);
  assert.equal(fs.removed[0], fs.written[0].path);
});

test('probe：写被拒 → PROBE_DENIED（把原因带回来）', async () => {
  const { tool, fs } = build({ approve: approveYes });
  fs.writeFileSync = () => {
    const err = new Error('EPERM: operation not permitted');
    err.code = 'EPERM';
    throw err;
  };
  const out = await tool.execute({ action: 'probe', path: 'D:\\work\\a' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'PROBE_DENIED');
  assert.match(out.message, /EPERM/);
});

test('status：授权层缺根 → DRIFT，并列出缺哪些', async () => {
  const { tool } = build({ config: { roots: ['D:\\work\\a'] } });
  const out = await tool.execute({ action: 'status', actualRoots: [] });
  assert.equal(out.data.diff.missing.length, 1);
  assert.equal(out.code, 'DRIFT');
});

test('status：一致 → IN_SYNC', async () => {
  const { tool } = build({ config: { roots: ['D:\\work\\a'] } });
  const out = await tool.execute({ action: 'status', actualRoots: ['D:\\work\\a'] });
  assert.equal(out.code, 'IN_SYNC');
});

test('sync dryRun：只演算，不调 policy edit', async () => {
  const { tool, editor } = build({ approve: approveYes, config: { roots: ['D:\\work\\a'] } });
  const out = await tool.execute({ action: 'sync', dryRun: true, actualRoots: [] });
  assert.equal(out.code, 'DRY_RUN');
  assert.equal(editor.state.edits.length, 0);
  assert.deepEqual(out.data.diff.missing, ['D:\\work\\a']);
});

test('audit：返回最近记录容器（enabled:false 时为空）', async () => {
  const { tool } = build();
  const out = await tool.execute({ action: 'audit', limit: 5 });
  assert.equal(out.ok, true);
  assert.ok(Array.isArray(out.data.lines));
});


/* ------------------------------------------------------------------ */
/* v0.5 新增 action：试算 / 自检 / 撤销 / 导入导出 / 会话临时根          */
/* ------------------------------------------------------------------ */

test('evaluate：只判不执行，返回 decision 与命中的根', async () => {
  const { tool } = build({
    evaluate(input) {
      return { decision: 'allow', code: 'OK', reason: '命中根', path: input.args.file_path, matchedRoot: 'D:\\work\\a' };
    },
  });
  const out = await tool.execute({ action: 'evaluate', toolName: 'write', argsJson: '{"file_path":"D:\\\\work\\\\a\\\\x.txt"}' });
  assert.equal(out.ok, true);
  assert.equal(out.data.decision, 'allow');
  assert.equal(out.data.matchedRoot, 'D:\\work\\a');
});

test('evaluate：没有接 evaluate → EVALUATE_UNAVAILABLE（不假装通过）', async () => {
  const { tool } = build();
  const out = await tool.execute({ action: 'evaluate', toolName: 'write', path: 'D:\\work\\a\\x.txt' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'EVALUATE_UNAVAILABLE');
});

test('evaluate：argsJson 坏掉 → BAD_ARGS（不能当成"没有路径"放行）', async () => {
  const { tool } = build({ evaluate: () => ({ decision: 'allow' }) });
  const out = await tool.execute({ action: 'evaluate', toolName: 'write', argsJson: '{oops' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'BAD_ARGS');
});

test('doctor：汇总检查项，任一不过就是 DEGRADED', async () => {
  const { tool } = build({
    doctor: () => ({ ok: false, checks: [{ id: 'webServer', ok: false, detail: '没注入' }], problems: ['webServer'] }),
  });
  const out = await tool.execute({ action: 'doctor' });
  assert.equal(out.ok, true);
  assert.equal(out.code, 'DEGRADED');
  assert.equal(out.data.checks.length, 1);
});

test('doctor：没有接 doctor → DOCTOR_UNAVAILABLE', async () => {
  const { tool } = build();
  const out = await tool.execute({ action: 'doctor' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'DOCTOR_UNAVAILABLE');
});

test('undo：先加一条再撤销，文档回到空，且要过审批', async () => {
  const { tool } = build({ approve: approveYes });
  await tool.execute({ action: 'add', path: 'D:\\work\\a' });
  const undone = await tool.execute({ action: 'undo' });
  assert.equal(undone.ok, true);
  assert.equal(undone.code, 'UNDONE');
  const listed = await tool.execute({ action: 'list' });
  assert.equal(listed.data.roots.length, 0);
});

test('undo：没东西可撤 → NOTHING_TO_UNDO（不是静默成功）', async () => {
  const { tool } = build({ approve: approveYes });
  const out = await tool.execute({ action: 'undo' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'NOTHING_TO_UNDO');
});

test('export / import：导出的 JSON 能原样导入回来', async () => {
  const { tool } = build({ approve: approveYes });
  await tool.execute({ action: 'add', path: 'D:\\work\\a', capabilities: ['read', 'write'] });
  const exported = await tool.execute({ action: 'export' });
  assert.equal(exported.ok, true);
  assert.match(exported.data.json, /D:\\\\work\\\\a/i);

  const imported = await tool.execute({ action: 'import', json: exported.data.json });
  assert.equal(imported.ok, true);
  assert.equal(imported.code, 'IMPORTED');
});

test('import：坏 JSON → BAD_DOC，且不落盘', async () => {
  const { tool, editor } = build({ approve: approveYes });
  const before = JSON.stringify(editor.state.config);
  const out = await tool.execute({ action: 'import', json: '{nope' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'BAD_DOC');
  assert.equal(JSON.stringify(editor.state.config), before);
});

test('session-add / session-list / session-remove：临时根走会话层，需要 sessionId', async () => {
  const buckets = new Map();
  const session = {
    add(input) {
      if (!input.sessionId) return { ok: false, code: 'SESSION_UNAVAILABLE', message: '没有 sessionId' };
      buckets.set(input.sessionId, [{ path: input.path, caps: ['read'], mode: 'rw', scope: 'session' }]);
      return { ok: true, code: 'SESSION_ADDED', message: '已加临时根' };
    },
    remove(sessionId, target) {
      buckets.delete(sessionId);
      return { ok: true, code: 'SESSION_REMOVED', message: '已移除临时根' };
    },
    list(sessionId) {
      return buckets.get(sessionId) ?? [];
    },
  };
  const { tool } = build({ approve: approveYes, session });

  const added = await tool.execute({ action: 'session-add', path: 'D:\\work\\a', sessionId: 's1' });
  assert.equal(added.ok, true);
  assert.equal(added.code, 'SESSION_ADDED');

  const listed = await tool.execute({ action: 'session-list', sessionId: 's1' });
  assert.equal(listed.data.roots.length, 1);

  const removed = await tool.execute({ action: 'session-remove', path: 'D:\\work\\a', sessionId: 's1' });
  assert.equal(removed.code, 'SESSION_REMOVED');
});

test('session-add：实例没接会话层 → SESSION_UNAVAILABLE（不假装加上了）', async () => {
  const { tool } = build({ approve: approveYes });
  const out = await tool.execute({ action: 'session-add', path: 'D:\\work\\a', sessionId: 's1' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'SESSION_UNAVAILABLE');
});

test('session-add 也要过审批：approve 说不 → APPROVAL_DENIED', async () => {
  const session = { add: () => ({ ok: true, code: 'SESSION_ADDED' }), remove: () => ({ ok: true }), list: () => [] };
  const { tool } = build({ approve: approveNo, session });
  const out = await tool.execute({ action: 'session-add', path: 'D:\\work\\a', sessionId: 's1' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'APPROVAL_DENIED');
});
