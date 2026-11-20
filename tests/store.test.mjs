/**
 * tests/store.test.mjs —— 规则文档与授权层同步的测试。
 *
 * 这里全部用**假 configEditor**：不需要真 profile、不会写你机器上任何配置。
 * 假 configEditor 的行为要跟真的对齐两件事：
 *   ① `edit(entry, change)` 里 change 收到的是"当前 config"，返回的是"整行新 config"；
 *   ② 被上层 patch 覆盖时抛 `... overridden by a home patch ...`。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STORE_CODE,
  createStore,
  diffAuthorization,
  emptyDoc,
  normalizeDoc,
  normalizeRootEntry,
  patchRoot,
  planAuthorization,
  removeRoot,
  serializableDoc,
  docFingerprint,
  exportJson,
  importJson,
  upsertRoot,
} from '../src/store.mjs';

const W = 'win32';

function fakeEditor(initial = {}) {
  const state = { config: { ...initial }, edits: [], throwOnEdit: null, readCount: 0 };
  return {
    state,
    async edit(entry, change) {
      state.edits.push(entry);
      if (state.throwOnEdit) throw new Error(state.throwOnEdit);
      const next = change(state.config, state.config);
      state.config = next;
      return undefined;
    },
    async read(entry) {
      state.readCount += 1;
      return state.config;
    },
  };
}

test('normalizeDoc 给默认值：shell=deny、敏感名单非空、audit 开', () => {
  const doc = normalizeDoc({}, W);
  assert.equal(doc.shell.mode, 'deny');
  assert.deepEqual(doc.shell.allowlist, []);
  assert.ok(doc.sensitive.deny.includes('.env'));
  assert.equal(doc.audit.enabled, true);
  assert.deepEqual(doc.roots, []);
});

test('normalizeRootEntry：字符串=四能力全给，对象可只给读', () => {
  const full = normalizeRootEntry('D:\\work\\a', W);
  assert.deepEqual(full.capabilities.sort(), ['delete', 'move', 'read', 'write']);
  assert.equal(full.mode, 'rw');
  const ro = normalizeRootEntry({ path: 'D:\\work\\b', capabilities: ['read'] }, W);
  assert.deepEqual(ro.capabilities, ['read']);
});

test('normalizeRootEntry：不认识的能力位抛 BAD_RULE（不是静默忽略）', () => {
  assert.throws(() => normalizeRootEntry({ path: 'D:\\x', capabilities: ['execute'] }, W), /BAD_RULE/);
});

test('normalizeRootEntry：缺 path 抛 BAD_RULE', () => {
  assert.throws(() => normalizeRootEntry({ mode: 'rw' }, W), /path/);
});

test('upsertRoot：新根返回 ADDED', () => {
  const doc = normalizeDoc({}, W);
  const result = upsertRoot(doc, 'D:\\work\\a', W);
  assert.equal(result.code, STORE_CODE.ADDED);
  assert.equal(result.doc.roots.length, 1);
  assert.equal(result.doc.roots[0].path, 'D:\\work\\a');
});

test('upsertRoot：同根不同大小写/尾斜杠算同一个（UPDATED 而不是重复）', () => {
  let doc = normalizeDoc({}, W);
  doc = upsertRoot(doc, 'D:\\work\\a', W).doc;
  const again = upsertRoot(doc, 'd:/work/A/', W);
  assert.equal(again.code, STORE_CODE.UPDATED);
  assert.equal(again.doc.roots.length, 1);
});

test('upsertRoot：合并能力位而不是替换（已给的全留）', () => {
  let doc = normalizeDoc({ roots: [{ path: 'D:\\work\\a', capabilities: ['read'] }] }, W);
  const merged = upsertRoot(doc, { path: 'D:\\work\\a', capabilities: ['write'] }, W);
  assert.deepEqual(merged.root.capabilities.sort(), ['read', 'write']);
});

test('removeRoot：不存在返回 NOT_FOUND 且不动文档', () => {
  const doc = normalizeDoc({ roots: ['D:\\work\\a'] }, W);
  const result = removeRoot(doc, 'D:\\other', W);
  assert.equal(result.code, STORE_CODE.NOT_FOUND);
  assert.equal(result.doc.roots.length, 1);
});

test('removeRoot：大小写混写也能删掉', () => {
  const doc = normalizeDoc({ roots: ['D:\\Work\\A'] }, W);
  const result = removeRoot(doc, 'd:\\work\\a', W);
  assert.equal(result.code, STORE_CODE.REMOVED);
  assert.equal(result.doc.roots.length, 0);
});

test('patchRoot：改能力位为只读', () => {
  const doc = normalizeDoc({ roots: [{ path: 'D:\\work\\a' }] }, W);
  const result = patchRoot(doc, 'D:\\work\\a', { capabilities: ['read'] }, W);
  assert.equal(result.code, STORE_CODE.UPDATED);
  assert.deepEqual(result.root.capabilities, ['read']);
});

test('patchRoot：expiresAt=null 能清掉过期时间', () => {
  const doc = normalizeDoc({ roots: [{ path: 'D:\\work\\a', expiresAt: '2030-01-01T00:00:00Z' }] }, W);
  const result = patchRoot(doc, 'D:\\work\\a', { expiresAt: null }, W);
  assert.equal(result.root.expiresAt, undefined);
});

test('planAuthorization：只有 rw + write 的根进授权层', () => {
  const doc = normalizeDoc({
    roots: [
      'D:\\work\\rw',
      { path: 'D:\\work\\ro', mode: 'ro' },
      { path: 'D:\\work\\readonly', capabilities: ['read'] },
    ],
  }, W);
  const plan = planAuthorization(doc, W);
  assert.deepEqual(plan.roots, ['D:\\work\\rw']);
  assert.equal(plan.skipped.length, 2);
  assert.ok(plan.skipped.some((item) => /ro/.test(item.reason)));
});

test('planAuthorization：过期根不进授权层，且理由里带时间', () => {
  const doc = normalizeDoc({ roots: [{ path: 'D:\\work\\old', expiresAt: '2000-01-01T00:00:00Z' }] }, W);
  const plan = planAuthorization(doc, W);
  assert.deepEqual(plan.roots, []);
  assert.match(plan.skipped[0].reason, /2000-01-01/);
});

test('diffAuthorization：missing/extra 都按段边界算（proj-ab 不算 proj-a）', () => {
  const diff = diffAuthorization(['D:\\work\\proj-a'], ['D:\\work\\proj-ab', 'D:\\work\\proj-a'], W);
  assert.deepEqual(diff.missing, []);
  assert.deepEqual(diff.extra, ['D:\\work\\proj-ab']);
  assert.equal(diff.matched, 1);
});

test('createStore：add 走 configEditor.edit 一次，并读回校验', async () => {
  const editor = fakeEditor(emptyDoc());
  const store = createStore({ configEditor: editor, readConfig: () => editor.state.config, platform: W });
  const result = await store.add('D:\\work\\a');
  assert.equal(result.ok, true);
  assert.equal(result.code, STORE_CODE.ADDED);
  assert.equal(editor.state.edits.length, 1);
  assert.equal(editor.state.config.roots.length, 1);
  assert.equal(store.doc.roots.length, 1);
});

test('createStore：configEditor 报"被上层覆盖"时映射成 EDIT_OVERRIDDEN', async () => {
  const editor = fakeEditor();
  editor.state.throwOnEdit = 'Configuration for "multi-workspace" is overridden by a home patch or command-line overlay';
  const store = createStore({ configEditor: editor, platform: W });
  const result = await store.add('D:\\work\\a');
  assert.equal(result.ok, false);
  assert.equal(result.code, STORE_CODE.EDIT_OVERRIDDEN);
});

test('createStore：没有 configEditor 时 EDIT_FAILED，且内存文档不变', async () => {
  const store = createStore({ platform: W });
  const before = docFingerprint(store.doc);
  const result = await store.add('D:\\work\\a');
  assert.equal(result.ok, false);
  assert.equal(result.code, STORE_CODE.EDIT_FAILED);
  assert.equal(docFingerprint(store.doc), before);
});

test('createStore：写后读回不一致时报 VERIFY_FAILED（不假装成功）', async () => {
  const editor = fakeEditor();
  const store = createStore({
    configEditor: editor,
    // 读回来的东西和刚写的不同 —— 模拟被别的 patch 覆盖
    readConfig: () => ({ roots: ['D:\\something-else'] }),
    platform: W,
  });
  const result = await store.add('D:\\work\\a');
  assert.equal(result.ok, false);
  assert.equal(result.code, STORE_CODE.VERIFY_FAILED);
});

test('createStore.sync(dryRun)：只演算，不调 edit', async () => {
  const editor = fakeEditor();
  const store = createStore({ configEditor: editor, config: { roots: ['D:\\work\\a'] }, platform: W });
  const result = await store.sync({ actual: [], dryRun: true });
  assert.equal(result.code, STORE_CODE.DRY_RUN);
  assert.equal(editor.state.edits.length, 0);
  assert.deepEqual(result.diff.missing, ['D:\\work\\a']);
});

test('createStore.sync：真正写 authorization 时基于 current 展开（不丢别的键）', async () => {
  const policy = fakeEditor({ mode: 'workspace-write', workspaceRoot: 'C:\\ws', additionalWritableRoots: [] });
  const store = createStore({
    configEditor: { edit: async () => {} },
    policyEditor: policy,
    config: { roots: ['D:\\work\\a'] },
    platform: W,
  });
  const result = await store.sync({ actual: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(policy.state.config.additionalWritableRoots, ['D:\\work\\a']);
  assert.equal(policy.state.config.mode, 'workspace-write');
  assert.equal(policy.state.config.workspaceRoot, 'C:\\ws');
});

test('serializableDoc：派生的 key 不落盘，空字段不写', () => {
  const doc = normalizeDoc({ roots: [{ path: 'D:\\work\\a', capabilities: ['read'], mode: 'ro' }] }, W);
  const plain = serializableDoc(doc);
  assert.equal(plain.roots[0].key, undefined);
  assert.equal(plain.roots[0].mode, 'ro');
  assert.equal(plain.roots[0].include, undefined);
  assert.equal(JSON.stringify(plain).includes('"key"'), false);
});

test('docFingerprint：同内容不同插入顺序 → 仍然稳定（只依赖顺序，不依赖对象引用的键序）', () => {
  const a = normalizeDoc({ roots: ['D:\\work\\a', 'D:\\work\\b'] }, W);
  const b = normalizeDoc({ roots: ['D:\\work\\a', 'D:\\work\\b'] }, W);
  assert.equal(docFingerprint(a), docFingerprint(b));
  const c = normalizeDoc({ roots: ['D:\\work\\b', 'D:\\work\\a'] }, W);
  assert.notEqual(docFingerprint(a), docFingerprint(c));
});

test('createStore.undo：撤销 add，根消失、code=OK、undone=add', async () => {
  const editor = fakeEditor(emptyDoc());
  const store = createStore({ configEditor: editor, readConfig: () => editor.state.config, platform: W });
  await store.add('D:\\work\\a');
  assert.equal(store.undoDepth(), 1);
  const undone = await store.undo();
  assert.equal(undone.ok, true);
  assert.equal(undone.code, STORE_CODE.OK);
  assert.equal(undone.undone, 'add');
  assert.equal(store.doc.roots.length, 0);
  assert.equal(store.undoDepth(), 0);
});

test('createStore.undo：栈空时 NOTHING_TO_UNDO（不假装成功）', async () => {
  const store = createStore({ platform: W });
  const result = await store.undo();
  assert.equal(result.ok, false);
  assert.equal(result.code, STORE_CODE.NOTHING_TO_UNDO);
});

test('createStore.undo：撤销写失败时把这一步还回栈（界面不能以为撤销成功）', async () => {
  const editor = fakeEditor(emptyDoc());
  const store = createStore({ configEditor: editor, platform: W });
  const added = await store.add('D:\\work\\a');
  assert.equal(added.ok, true);
  editor.state.throwOnEdit = 'disk full';
  const result = await store.undo();
  assert.equal(result.ok, false);
  assert.equal(result.code, STORE_CODE.EDIT_FAILED);
  // 关键：失败后这一步必须还在，否则用户点了撤销、什么都没变、也没机会再试。
  assert.equal(store.undoDepth(), 1);
});

test('createStore.undo：栈只保留最近 5 次', async () => {
  const store = createStore({ configEditor: { edit: async () => {} }, platform: W });
  for (let i = 0; i < 7; i += 1) await store.add(`D:\\work\\p${i}`);
  assert.equal(store.undoDepth(), 5);
});

test('exportJson / importJson：往返后规则指纹一致', () => {
  const doc = normalizeDoc({ roots: [{ path: 'D:\\work\\a', capabilities: ['read', 'write'], mode: 'ro', note: 'x' }] }, W);
  const text = exportJson(doc);
  const back = importJson(text, W);
  assert.equal(docFingerprint(back), docFingerprint(doc));
});

test('importJson：坏 JSON 抛 BAD_DOC 前缀（调用方据此回 BAD_DOC）', () => {
  assert.throws(() => importJson('{oops', W), /BAD_DOC/);
});

test('createStore.importDoc：整份导入可撤销；坏 JSON 不落盘', async () => {
  const editor = fakeEditor(emptyDoc());
  const store = createStore({ configEditor: editor, readConfig: () => editor.state.config, platform: W });
  await store.add('D:\\work\\a');
  const good = exportJson(normalizeDoc({ roots: ['D:\\work\\z'] }, W));
  const imported = await store.importDoc(good);
  assert.equal(imported.ok, true);
  assert.deepEqual(store.doc.roots.map((r) => r.path), ['D:\\work\\z']);

  const bad = await store.importDoc('{bad json');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, STORE_CODE.BAD_DOC);
  assert.deepEqual(store.doc.roots.map((r) => r.path), ['D:\\work\\z']);

  const undone = await store.undo();
  assert.equal(undone.ok, true);
  assert.deepEqual(store.doc.roots.map((r) => r.path), ['D:\\work\\a']);
});

test('createStore.replace：整份替换也进撤销栈', async () => {
  const editor = fakeEditor(emptyDoc());
  const store = createStore({ configEditor: editor, readConfig: () => editor.state.config, platform: W });
  await store.add('D:\\work\\a');
  await store.replace(normalizeDoc({ roots: ['D:\\work\\b'] }, W));
  assert.equal(store.undoDepth(), 2);
  const undone = await store.undo();
  assert.equal(undone.ok, true);
  assert.deepEqual(store.doc.roots.map((r) => r.path), ['D:\\work\\a']);
});

test('没有 configEditor 时写文件兜底 —— 否则面板「加根」永远 EDIT_FAILED', async () => {
  const files = new Map();
  const fakeFs = {
    mkdirSync() {},
    writeFileSync(p, text) {
      files.set(p, text);
    },
    renameSync(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
    },
    readFileSync(p) {
      if (!files.has(p)) {
        const err = new Error('ENOENT: no such file');
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(p);
    },
  };
  const store = createStore({ platform: W, rulesFile: 'D:\\x\\rules.json', fs: fakeFs });
  const res = await store.add({ path: 'D:\\work\\proj-a', caps: ['read', 'write'] });
  assert.equal(res.ok, true);
  // 叠加的是「动作码」（ADDED），不是 STORE_CODE.OK —— 两者本来就不同层。
  assert.equal(res.code, STORE_CODE.ADDED);
  assert.ok(files.has('D:\\x\\rules.json'), '规则应该真的落到文件里');

  // 新 store 从同一个文件读回来 —— 重启之后规则还在。
  const again = createStore({ platform: W, rulesFile: 'D:\\x\\rules.json', fs: fakeFs });
  await again.load();
  assert.equal(again.doc.roots.length, 1);
  assert.equal(again.doc.roots[0].path, 'D:\\work\\proj-a');
});

test('configEditor 找不到配置行时降级写文件 —— 行 id 与 patch 不一致的真实事故', async () => {
  const files = new Map();
  const fakeFs = {
    mkdirSync() {},
    writeFileSync(p, text) {
      files.set(p, text);
    },
    renameSync(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
    },
    readFileSync(p) {
      if (!files.has(p)) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(p);
    },
  };
  const editor = {
    edit: async () => {
      throw new Error('Configuration entry is no longer available');
    },
  };
  const store = createStore({
    platform: W,
    rulesFile: 'D:\\x\\rules.json',
    fs: fakeFs,
    configEditor: editor,
  });

  const res = await store.add({ path: 'D:\\work\\proj-a', caps: ['read'] });
  assert.equal(res.ok, true, '找不到配置行不该让「加根」直接失败');
  assert.equal(res.via, 'file', '应该明确告诉调用方这次是写文件落盘的');
  assert.ok(files.has('D:\\x\\rules.json'), '规则要真的落到文件里');
  assert.equal(store.doc.roots.length, 1, '内存文档也要跟上，否则界面刷新又会变空');
});
