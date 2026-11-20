/**
 * load-check.mjs —— 装进 profile **之前**的最后一道自检。
 *
 * 它用假的 ctx 真调一次 `apply()`，回答三个问题：
 *   ① 入口能不能被 import（语法错、循环依赖、导出名写错都会在这里炸）
 *   ② 守卫和工具能不能注册上（ctx.tools.guard / register 有没有被调用）
 *   ③ 守卫真的会拒绝吗（拿一个越界写操作试一发，看它是不是返回 denial）
 *
 * 为什么不在 profile 里试：插件在 DSH 启动时加载，一个抛异常的插件
 * 可能让整个 profile 起不来 —— 那时候连"改回来"都要靠手改文件。
 * 所以能提前在进程内验的，绝不留到装上去之后验。
 *
 * 用法：`node scripts/load-check.mjs`，全过 exit 0，任何一项不过 exit 1。
 */

import { readFileSync } from 'node:fs';
import { apply, createInstance, name, version } from '../src/index.mjs';
import { ACTION_LIST, TOOL_NAME } from '../src/tool.mjs';

const problems = [];
const checks = [];

function check(label, ok, detail) {
  checks.push({ label, ok, detail });
  if (!ok) problems.push(`${label}${detail ? `：${detail}` : ''}`);
}

// ---- 一个假 ctx：只提供插件会用到的那几个面，并记录调用 ----
const calls = { guards: 0, tools: [] };
const fakeCtx = {
  workspaceRoot: process.cwd(),
  tools: {
    guard(fn) {
      calls.guards += 1;
      fakeCtx.__guard = fn;
      return () => {};
    },
    register(definition) {
      calls.tools.push(definition?.name ?? '(no name)');
      return () => {};
    },
    defineTool(definition) {
      return definition;
    },
  },
  // 故意不给 configEditor / sandboxPolicy：验证"缺依赖时降级并把问题写进 status"这条路径。
};

const instance = apply(fakeCtx, {
  workspaceRoot: process.cwd(),
  requireApproval: false,
  // 规则里造一个「只读的 D 盘根」，用来验证守卫确实会拒
  config: {
    version: 2,
    roots: [{ path: 'D:\\load-check-root', capabilities: ['read'] }],
    shell: { mode: 'deny', allowlist: [] },
    sensitive: { deny: ['.env'] },
    audit: { enabled: false, file: 'load-check-audit.jsonl' },
  },
});

// 期望值从 package.json 现读：改名/升版时它会自己跟上，而不是写死一个字符串等它过期。
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
check('插件名与版本和 package.json 一致', name === pkg.name && version === pkg.version, `${name}@${version} vs ${pkg.name}@${pkg.version}`);
check('apply() 返回实例', !!instance && typeof instance.snapshot === 'function');
check('守卫已注册', calls.guards === 1, `guard 调用 ${calls.guards} 次`);
check('工具已注册', calls.tools.includes('workspace_roots'), `注册了 ${JSON.stringify(calls.tools)}`);

// ---- 守卫真的会拒吗 ----
const guard = fakeCtx.__guard;
check('守卫函数拿到了', typeof guard === 'function');

if (typeof guard === 'function') {
  const outside = guard({ name: 'write', arguments: { file_path: 'D:\\other\\x.txt', content: 'x' } });
  check('越界写被拒', typeof outside === 'string' && outside.length > 0, String(outside));

  const insideReadOnly = guard({ name: 'write', arguments: { file_path: 'D:\\load-check-root\\a.txt' } });
  check('只读根上的写被拒', typeof insideReadOnly === 'string', String(insideReadOnly));

  const semantic = guard({ name: 'read', arguments: { file_path: 'D:\\load-check-root\\a.txt' } });
  check('只读根上的读放行', semantic === undefined, String(semantic));

  const shell = guard({ name: 'pwsh', arguments: { command: 'del D:\\other\\x' } });
  check('shell 默认被拒', typeof shell === 'string', String(shell));
}

// ---- 缺 configEditor 时必须"看得见地降级"，而不是静默 ----
const snapshot = instance.snapshot();
check(
  '缺 configEditor 时 status 里有问题说明',
  snapshot.status.persistent === false && snapshot.status.problems.length > 0,
  JSON.stringify(snapshot.status.problems),
);

// ---- createInstance 也能单独用（不注册）----
const bare = createInstance({}, {});
check('createInstance 独立可用', typeof bare.guard === 'function' && !!bare.store);

// ---- v0.5：工具面把新 action 都暴露出来了吗 ----
const EXPECTED_ACTIONS = [
  'evaluate', 'doctor', 'undo', 'export', 'import',
  'session-list', 'session-add', 'session-remove',
];
const missingActions = EXPECTED_ACTIONS.filter((a) => !ACTION_LIST.includes(a));
check('工具名与旧名一致', TOOL_NAME === 'workspace_roots', TOOL_NAME);
check('v0.5 的 8 个新 action 都在枚举里', missingActions.length === 0, missingActions.join(','));

// ---- v0.5：试算（只判不执行）----
const allowed = instance.evaluateCall({ toolName: 'read', args: { file_path: 'D:\\load-check-root\\a.txt' } });
check('试算：只读根上的读 → allow', allowed.decision === 'allow', JSON.stringify(allowed));
const denied = instance.evaluateCall({ toolName: 'write', args: { file_path: 'D:\\nope\\a.txt' } });
check('试算：根外写 → deny 且带原因', denied.decision === 'deny' && !!denied.code, JSON.stringify(denied));

// ---- v0.5：自检报告（缺依赖时是"看得见的降级"，不是抛异常）----
const doctor = instance.doctorReport();
check('自检报告有 8 个接线点', Array.isArray(doctor.checks) && doctor.checks.length === 8, `checks=${doctor.checks?.length}`);
check('缺依赖时自检 ok=false 并列出问题', doctor.ok === false && doctor.problems.length > 0, doctor.problems.join(','));

// ---- v0.5：撤销（空栈要说清楚，不能假装成功）----
const emptyUndo = await bare.store.undo();
check('空栈撤销 → NOTHING_TO_UNDO', emptyUndo.code === 'NOTHING_TO_UNDO', emptyUndo.code);

// ---- v0.5：导出是合法 JSON 且带版本 ----
const exported = bare.store.exportJson(0);
let exportedOk = false;
try {
  const parsed = JSON.parse(exported);
  exportedOk = parsed.version === 2 && Array.isArray(parsed.roots);
} catch { exportedOk = false; }
check('导出的是合法 JSON（version=2 + roots 数组）', exportedOk);

// ---- v0.5：会话临时根（有宿主依赖时要真注册；没有时如实报不可用）----
const sessionCalls = { registered: [], disposed: 0 };
const sessionCtx = {
  workspaceRoot: process.cwd(),
  tools: fakeCtx.tools,
  configEditor: { edit: async () => {} },
  sandboxPolicy: {
    registerWritableRoot(session, directory) {
      sessionCalls.registered.push({ session, directory });
      return () => { sessionCalls.disposed += 1; };
    },
  },
  sessions: { get: (id) => (id === 'sess-a' ? { id: 'sess-a' } : undefined) },
};
const withSession = apply(sessionCtx, { requireApproval: false, audit: false });
const added = withSession.registerSessionRoot({ sessionId: 'sess-a', path: 'E:\\scratch', capabilities: ['read', 'write'] });
check('临时根：能注册 → SESSION_ADDED 且带上宿主注册回调', added.code === 'SESSION_ADDED' && sessionCalls.registered.length === 1, added.code);
check('临时根：列表里能看到它', withSession.listSessionRoots('sess-a').length === 1);
const removed = withSession.removeSessionRoot('sess-a', 'E:\\scratch');
check('临时根：移除会调用 disposer', removed.ok !== false && sessionCalls.disposed === 1, JSON.stringify(removed));
withSession.disposeAllSessionRoots();

const noSession = bare.registerSessionRoot({ sessionId: 'x', path: 'E:\\scratch' });
check('没有 sandboxPolicy 时临时根如实报 POLICY_UNAVAILABLE', noSession.code === 'POLICY_UNAVAILABLE', noSession.code);
// 有 sandboxPolicy、但没有 sessions：这时才应该落到 SESSION_UNAVAILABLE
// （检查顺序是 policy → sessions，两个都缺时报的是更靠前那个，这是故意的）
const policyOnly = apply(
  { workspaceRoot: process.cwd(), tools: fakeCtx.tools, sandboxPolicy: { registerWritableRoot: () => () => {} } },
  { requireApproval: false, audit: false },
);
const noSessions = policyOnly.registerSessionRoot({ sessionId: 'x', path: 'E:\\scratch' });
check('有 policy 但没有 sessions.get → SESSION_UNAVAILABLE', noSessions.code === 'SESSION_UNAVAILABLE', noSessions.code);

const failed = problems.length > 0;
for (const item of checks) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}${item.ok || !item.detail ? '' : `  → ${item.detail}`}`);
}
console.log(failed ? `\nLOAD CHECK FAILED（${problems.length} 项）` : `\nLOAD CHECK OK（${checks.length} 项全过）`);
process.exitCode = failed ? 1 : 0;
