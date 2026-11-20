/**
 * tests/http.test.mjs —— 面板 HTTP 路由的守卫与写入行为。
 *
 * 这层最怕的不是"功能少"，是"没守住"：`/plugins/<包名>/...` 不经过 session cookie，
 * 所以本机回环 + 同源这两道检查一旦漏一个，局域网里任何人都能改你的可写根。
 * 所以下面第一组用例专门盯着这两道闸。
 *
 * 用法：`node tests/http.test.mjs`（或 `node tests/run-all.mjs` 一起跑）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createRoutes, isLoopback, originMatchesHost, ROUTE_BASE } from '../src/http.mjs';

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

/** 假 store：只实现 HTTP 层真正用到的那几个方法。 */
function makeStore(initial = []) {
  const state = {
    version: 2,
    roots: initial.map((root) => ({
      path: root.path,
      capabilities: [...(root.capabilities ?? ['read', 'write'])],
      mode: root.mode ?? 'rw',
      include: [],
      exclude: [],
    })),
  };
  let loads = 0;
  return {
    get doc() {
      return state;
    },
    get loads() {
      return loads;
    },
    async load() {
      loads += 1;
    },
    async add(entry) {
      state.roots.push({
        path: entry.path,
        capabilities: [...(entry.capabilities ?? ['read', 'write'])],
        mode: entry.mode ?? 'rw',
        include: [],
        exclude: [],
      });
      return { ok: true, code: 'ADDED', message: '已添加' };
    },
    async remove(target) {
      const index = state.roots.findIndex((root) => root.path.toLowerCase() === target.toLowerCase());
      if (index < 0) return { ok: false, code: 'NOT_FOUND', message: '没找到这条根' };
      state.roots.splice(index, 1);
      return { ok: true, code: 'REMOVED', message: '已移除' };
    },
    async update(target, patch) {
      const root = state.roots.find((item) => item.path.toLowerCase() === target.toLowerCase());
      if (!root) return { ok: false, code: 'NOT_FOUND', message: '没找到这条根' };
      if (Array.isArray(patch.capabilities)) root.capabilities = [...patch.capabilities];
      if (patch.mode === 'rw' || patch.mode === 'ro') root.mode = patch.mode;
      return { ok: true, code: 'UPDATED', message: '已更新' };
    },
    undoDepth() {
      return state.undoDepth ?? 0;
    },
    async undo() {
      if (!(state.undoDepth > 0)) return { ok: false, code: 'NOTHING_TO_UNDO', message: '没有可撤销的改动' };
      state.undoDepth -= 1;
      return { ok: true, code: 'UNDONE', message: '已撤销' };
    },
    exportJson() {
      return JSON.stringify(state);
    },
    async importDoc(input) {
      const parsed = typeof input === 'string' ? JSON.parse(input) : input;
      if (!parsed || !Array.isArray(parsed.roots)) return { ok: false, code: 'BAD_DOC', message: '规则文档必须是对象' };
      state.roots = parsed.roots.map((root) => ({
        path: root.path,
        capabilities: [...(root.capabilities ?? ['read'])],
        mode: root.mode ?? 'rw',
        include: [],
        exclude: [],
      }));
      return { ok: true, code: 'IMPORTED', message: '已导入' };
    },
  };
}

/** 假文件系统：只认识列出来的目录，其余 ENOENT。 */
function makeFs(directories) {
  const dirs = new Set(directories.map((path) => path.toLowerCase()));
  return {
    lstatSync(target) {
      if (!dirs.has(String(target).toLowerCase())) {
        const error = new Error(`ENOENT: no such file or directory, lstat '${target}'`);
        error.code = 'ENOENT';
        throw error;
      }
      return { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false };
    },
  };
}

const WORK = 'D:\\work\\main';

/** 造一套路由。 */
function build({ roots = [], dirs = ['D:\\work\\proj-a', WORK], store, session, evaluate } = {}) {
  const audit = { entries: [], record(entry) { this.entries.push(entry); } };
  const routes = createRoutes({
    store: store ?? makeStore(roots),
    platform: 'win32',
    workspaceRoot: WORK,
    fs: makeFs(dirs),
    audit,
    session,
    evaluate,
  });
  return { routes, state: routes[0], roots: routes[1], audit };
}

/** 发一个假请求，拿到 { status, body }。 */
function call(route, options = {}) {
  const {
    url = '/',
    body,
    raw,
    remoteAddress = '127.0.0.1',
    headers = {},
  } = options;

  const req = new EventEmitter();
  req.socket = { remoteAddress };
  req.headers = { host: '127.0.0.1:55805', ...headers };
  req.url = url;
  req.destroy = () => {};

  const res = { statusCode: 0, headers: {}, setHeader(key, value) { this.headers[key] = value; } };
  const done = new Promise((resolve) => {
    res.end = (text) => {
      let parsed = null;
      try {
        parsed = JSON.parse(String(text));
      } catch {
        parsed = String(text);
      }
      resolve({ status: res.statusCode, headers: res.headers, body: parsed });
    };
  });

  route.handler(req, res);

  if (raw !== undefined) {
    queueMicrotask(() => {
      req.emit('data', Buffer.from(raw));
      req.emit('end');
    });
  } else if (body !== undefined) {
    queueMicrotask(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
  }

  return done;
}

/* ------------------------------------------------------------------ */
/* 一、安全闸：本机 + 同源                                              */
/* ------------------------------------------------------------------ */

test('isLoopback：只认回环地址的三种写法', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(isLoopback('192.168.1.20'), false);
  assert.equal(isLoopback('::ffff:192.168.1.20'), false);
  assert.equal(isLoopback(undefined), false);
});

test('originMatchesHost：同源才通过', () => {
  assert.equal(originMatchesHost('http://127.0.0.1:55805', '127.0.0.1:55805'), true);
  assert.equal(originMatchesHost('http://evil.example', '127.0.0.1:55805'), false);
  assert.equal(originMatchesHost('http://127.0.0.1:9999', '127.0.0.1:55805'), false);
  assert.equal(originMatchesHost('not a url', '127.0.0.1:55805'), false);
  assert.equal(originMatchesHost('http://127.0.0.1:55805', undefined), false);
});

test('GET /state：非回环来源一律 403 NOT_LOOPBACK', async () => {
  const { state } = build();
  const result = await call(state, { remoteAddress: '192.168.1.20' });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'NOT_LOOPBACK');
});

test('GET /state：跨源来源 403 CROSS_ORIGIN', async () => {
  const { state } = build();
  const result = await call(state, { headers: { origin: 'http://evil.example' } });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'CROSS_ORIGIN');
});

test('GET /state：同源 + 回环放行，并返回规则与三层能力说明', async () => {
  const { state } = build({ roots: [{ path: 'D:\\work\\proj-a', capabilities: ['read', 'write'] }] });
  const result = await call(state, {
    url: `${ROUTE_BASE}/state`,
    headers: { origin: 'http://127.0.0.1:55805' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.roots.length, 1);
  assert.equal(result.body.roots[0].path, 'D:\\work\\proj-a');
  assert.deepEqual(result.body.roots[0].caps, ['read', 'write']);
  assert.equal(result.body.workspaceRoot, WORK);
  // 三条 limits 是"我这一层管到哪"的自我说明，缺一条就等于对用户失明。
  for (const key of ['fileTools', 'shellTools', 'readTools']) {
    assert.equal(typeof result.body.limits[key], 'string');
  }
  assert.match(result.body.limits.shellTools, /不认额外根/);
});

/* ------------------------------------------------------------------ */
/* 二、写入：add / remove / update                                      */
/* ------------------------------------------------------------------ */

test('POST add：合法目录 → 落进 store，并回显新列表', async () => {
  const { roots } = build();
  const result = await call(roots, {
    url: `${ROUTE_BASE}/roots`,
    body: { op: 'add', path: 'D:\\work\\proj-a', caps: ['read', 'write'] },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.code, 'ADDED');
  assert.equal(result.body.roots.length, 1);
  assert.deepEqual(result.body.roots[0].caps, ['read', 'write']);
});

test('POST add：目录不存在 → PATH_MISSING，且不写 store', async () => {
  const store = makeStore();
  const { roots } = build({ store });
  const result = await call(roots, { url: `${ROUTE_BASE}/roots`, body: { op: 'add', path: 'D:\\work\\不存在' } });
  assert.equal(result.body.ok, false);
  assert.equal(result.body.code, 'PATH_MISSING');
  assert.equal(store.doc.roots.length, 0);
});

test('POST add：工作区之内的目录 → 明确说"不需要添加"，不是错误', async () => {
  const { roots } = build({ dirs: ['D:\\work\\main\\sub', WORK] });
  const result = await call(roots, { url: `${ROUTE_BASE}/roots`, body: { op: 'add', path: 'D:\\work\\main\\sub' } });
  assert.equal(result.body.ok, true);
  assert.equal(result.body.code, 'PATH_INSIDE_WORKSPACE');
  assert.equal(result.body.roots.length, 0);
});

test('POST add：缺 path / path 不是字符串 → PATH_MISSING_ARG', async () => {
  const { roots } = build();
  const missing = await call(roots, { url: `${ROUTE_BASE}/roots`, body: { op: 'add' } });
  assert.equal(missing.body.code, 'PATH_MISSING_ARG');
  const wrongType = await call(roots, { url: `${ROUTE_BASE}/roots`, body: { op: 'add', path: 123 } });
  assert.equal(wrongType.body.code, 'PATH_MISSING_ARG');
});

test('POST remove：删掉已有根 → REMOVED，列表变空', async () => {
  const { roots } = build({ roots: [{ path: 'D:\\work\\proj-a' }] });
  const result = await call(roots, { url: `${ROUTE_BASE}/roots`, body: { op: 'remove', path: 'D:\\work\\proj-a' } });
  assert.equal(result.body.code, 'REMOVED');
  assert.equal(result.body.roots.length, 0);
});

test('POST update：只改能力位，模式不动', async () => {
  const store = makeStore([{ path: 'D:\\work\\proj-a', capabilities: ['read', 'write'], mode: 'rw' }]);
  const { roots } = build({ store });
  const result = await call(roots, {
    url: `${ROUTE_BASE}/roots`,
    body: { op: 'update', path: 'D:\\work\\proj-a', caps: ['read'] },
  });
  assert.equal(result.body.code, 'UPDATED');
  assert.deepEqual(result.body.roots[0].caps, ['read']);
  assert.equal(result.body.roots[0].mode, 'rw');
});

test('POST：坏 JSON → 400 BAD_BODY（不崩、不写）', async () => {
  const { roots } = build();
  const result = await call(roots, { url: `${ROUTE_BASE}/roots`, raw: '{oops' });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'BAD_BODY');
});

test('POST：不认识的 op → UNKNOWN_OP', async () => {
  const { roots } = build();
  const result = await call(roots, { url: `${ROUTE_BASE}/roots`, body: { op: 'launch-missiles' } });
  assert.equal(result.body.ok, false);
  assert.equal(result.body.code, 'UNKNOWN_OP');
});

/* ------------------------------------------------------------------ */
/* 三、新鲜度与审计                                                     */
/* ------------------------------------------------------------------ */

test('每次请求都重新读配置：避免面板拿到启动那一刻的旧规则', async () => {
  const store = makeStore();
  const { state, roots } = build({ store });
  await call(state, { url: `${ROUTE_BASE}/state` });
  await call(roots, { url: `${ROUTE_BASE}/roots`, body: { op: 'remove', path: 'D:\\work\\proj-a' } });
  assert.equal(store.loads, 2);
});

test('面板写入会留审计：tool=panel，code 形如 add:ADDED', async () => {
  const { roots, audit } = build();
  await call(roots, { url: `${ROUTE_BASE}/roots`, body: { op: 'add', path: 'D:\\work\\proj-a' } });
  await call(roots, { url: `${ROUTE_BASE}/roots`, body: { op: 'remove', path: 'D:\\work\\proj-a' } });
  assert.equal(audit.entries.length, 2);
  assert.equal(audit.entries[0].tool, 'panel');
  assert.equal(audit.entries[0].code, 'add:ADDED');
  assert.equal(audit.entries[1].code, 'remove:REMOVED');
});


/* ------------------------------------------------------------------ */
/* 五、v0.5 新增：会话级临时根 / 试算 / 记录 / 导入导出 / 撤销          */
/* ------------------------------------------------------------------ */

/** 按路径尾巴取一条路由（新增路由后 routes 的顺序不该成为测试的隐式契约）。 */
function byPath(routes, suffix) {
  const found = routes.find((route) => String(route.path).endsWith(suffix));
  assert.ok(found, `缺少路由 ${suffix}`);
  return found;
}

/** 假会话层：记住谁加过什么，能证明"传了 sessionId"。 */
function makeSessionLayer() {
  const buckets = new Map();
  const calls = [];
  return {
    calls,
    buckets,
    add(input) {
      calls.push({ op: 'add', input });
      if (!input.sessionId) return { ok: false, code: 'SESSION_UNAVAILABLE', message: '没有 sessionId' };
      const list = buckets.get(input.sessionId) ?? [];
      list.push({ path: input.path, caps: ['read'], mode: 'rw', scope: 'session' });
      buckets.set(input.sessionId, list);
      return { ok: true, code: 'SESSION_ADDED', message: '已加临时根' };
    },
    remove(sessionId, target) {
      calls.push({ op: 'remove', sessionId, target });
      const list = buckets.get(sessionId) ?? [];
      const at = list.findIndex((item) => item.path.toLowerCase() === String(target).toLowerCase());
      if (at < 0) return { ok: false, code: 'SESSION_ROOT_NOT_FOUND', message: '没找到临时根' };
      list.splice(at, 1);
      return { ok: true, code: 'SESSION_REMOVED', message: '已移除临时根' };
    },
    list(sessionId) {
      return buckets.get(sessionId) ?? [];
    },
  };
}

test('GET /state：带 rev / undoDepth / sessionRoots（面板靠 rev 决定要不要重绘）', async () => {
  const session = makeSessionLayer();
  session.add({ sessionId: 's1', path: 'D:\\work\\proj-a' });
  const { routes } = build({ session });
  const result = await call(byPath(routes, '/state'), { url: '/plugins/dsh-multi-workspace/state?sessionId=s1' });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(typeof result.body.rev, 'string');
  assert.equal(result.body.rev.length > 0, true);
  assert.equal(result.body.undoDepth, 0);
  assert.equal(result.body.sessionRoots.length, 1);
});

test('POST /roots scope=session：必须带 sessionId，且只走临时层', async () => {
  const session = makeSessionLayer();
  const { routes } = build({ session });
  const withoutId = await call(byPath(routes, '/roots'), {
    body: { op: 'add', path: 'D:\\work\\proj-a', scope: 'session' },
  });
  assert.equal(withoutId.body.code, 'SESSION_UNAVAILABLE');
  assert.equal(withoutId.body.ok, false);

  const withId = await call(byPath(routes, '/roots'), {
    body: { op: 'add', path: 'D:\\work\\proj-a', scope: 'session', sessionId: 's1' },
  });
  assert.equal(withId.body.ok, true);
  assert.equal(withId.body.code, 'SESSION_ADDED');
  assert.equal(session.list('s1').length, 1);
});

test('POST /roots scope=session 的 update → SESSION_UPDATE_UNSUPPORTED（临时根不能原地改）', async () => {
  const session = makeSessionLayer();
  const { routes } = build({ session });
  const result = await call(byPath(routes, '/roots'), {
    body: { op: 'update', path: 'D:\\work\\proj-a', scope: 'session', sessionId: 's1' },
  });
  assert.equal(result.body.ok, false);
  assert.equal(result.body.code, 'SESSION_UPDATE_UNSUPPORTED');
});

test('POST /roots op=undo：走 store.undo，并把新的 undoDepth 带回去', async () => {
  const store = makeStore();
  store.doc.undoDepth = 2;
  const { routes } = build({ store });
  const result = await call(byPath(routes, '/roots'), { body: { op: 'undo' } });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.code, 'UNDONE');
  assert.equal(result.body.undoDepth, 1);
});

test('POST /evaluate：只判不执行，返回 decision/code/reason', async () => {
  const seen = [];
  const { routes } = build({
    evaluate(input) {
      seen.push(input);
      return { decision: 'deny', code: 'PATH_OUTSIDE_SCOPE', reason: '不在任何根里', path: input.args.file_path };
    },
  });
  const result = await call(byPath(routes, '/evaluate'), {
    body: { toolName: 'write', args: { file_path: 'D:\\other\\a.txt' } },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.result.decision, 'deny');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].toolName, 'write');
});

test('POST /evaluate：实例没接 evaluate → EVALUATE_UNAVAILABLE（不假装放行）', async () => {
  const { routes } = build();
  const result = await call(byPath(routes, '/evaluate'), { body: { toolName: 'write', args: {} } });
  assert.equal(result.body.ok, false);
  assert.equal(result.body.code, 'EVALUATE_UNAVAILABLE');
});

test('GET /events：limit 被夹在 1–200，且走 audit.tail', async () => {
  const audit = { entries: [], asked: [], record() {}, tail(limit) { this.asked.push(limit); return this.entries; } };
  const routes = createRoutes({
    store: makeStore(),
    platform: 'win32',
    workspaceRoot: WORK,
    fs: makeFs([WORK]),
    audit,
  });
  const result = await call(byPath(routes, '/events'), { url: '/plugins/dsh-multi-workspace/events?limit=9999' });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(audit.asked[0], 200);
});

test('GET /export → 明文 JSON；POST /import 把文本交给 store.importDoc', async () => {
  const store = makeStore([{ path: 'D:\\work\\proj-a', capabilities: ['read'] }]);
  const { routes } = build({ store });
  const exported = await call(byPath(routes, '/export'));
  assert.equal(exported.body.ok, true);
  assert.equal(typeof exported.body.json, 'string');
  assert.match(exported.body.json, /proj-a/i);

  const docText = JSON.stringify({ version: 2, roots: [{ path: 'D:\\work\\proj-b', capabilities: ['read', 'write'] }] });
  const imported = await call(byPath(routes, '/import'), { body: { json: docText } });
  assert.equal(imported.body.ok, true);
  assert.equal(imported.body.code, 'IMPORTED');
  assert.equal(store.doc.roots.length, 1);
  assert.match(store.doc.roots[0].path, /proj-b/i);
});

test('GET /export：store 没有 exportJson 时明确报 STORE_EXPORT_UNSUPPORTED', async () => {
  const bare = {
    get doc() { return { roots: [] }; },
    async load() {},
  };
  const { routes } = build({ store: bare });
  const result = await call(byPath(routes, '/export'));
  assert.equal(result.body.ok, false);
  assert.equal(result.body.code, 'EXPORT_UNAVAILABLE');
});

test('POST /roots：caps 与 capabilities 两个字段名都认 —— 面板发 caps，工具发 capabilities', async () => {
  const store = makeStore([]);
  const { routes } = build({ store });

  const res = await call(routes[1], {
    body: { op: 'add', scope: 'persistent', path: 'D:\\work\\proj-a', capabilities: ['read'] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true, 'capabilities 别名要能被认出来');
  assert.deepEqual(store.doc.roots[0].capabilities, ['read'], '不能悄悄退回四个能力位全给');
});
