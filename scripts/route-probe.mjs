/**
 * route-probe.mjs —— 用一个假 ctx 真跑一遍 apply()，把注册结果打出来。
 *
 * 它回答的问题很具体：**代码本身**有没有把守卫、工具、两条 HTTP 路由交给 DSH。
 * 如果这里全绿、而真进程里 /plugins/dsh-multi-workspace/state 还是 404，
 * 那问题就在"插件有没有被加载"，不在写错 API。
 */
import { apply } from '../src/index.mjs';

const registered = [];
const guards = [];
const tools = [];

const ctx = {
  tools: {
    guard: (fn) => { guards.push(fn); return () => {}; },
    register: (def) => { tools.push(def); return () => {}; },
    defineTool: (def) => def,
  },
  configEditor: { async edit() {} },
  sandboxPolicy: { registerWritableRoot: () => () => {} },
  sessions: { get: () => ({ id: 'fake' }) },
  effect: (fn) => { fn(); return () => {}; },
  inject: (names, cb) => {
    const scope = {
      ...ctx,
      webServer: { register: (route) => { registered.push(route.path); return () => {}; } },
      effect: (fn) => { fn(); return () => {}; },
    };
    if (names.includes('webServer')) cb(scope);
  },
};

const instance = apply(ctx, { roots: [] });

const checks = [
  ['守卫已注册', guards.length === 1],
  ['工具已注册', tools.length === 1 && tools[0].name === 'workspace_roots'],
  ['路由已注册（6 条：state/roots/evaluate/events/export/import）', registered.length === 6],
  ['/state 路由存在', registered.some((p) => p.endsWith('/state'))],
  ['/roots 路由存在', registered.some((p) => p.endsWith('/roots'))],
  ['status 无 problems', Array.isArray(instance.status?.problems) && instance.status.problems.length === 0],
];

let failed = 0;
for (const [label, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
}
console.log('ROUTES', JSON.stringify(registered));
console.log('STATUS', JSON.stringify(instance.status));
console.log(failed === 0 ? 'ROUTE PROBE OK' : `ROUTE PROBE FAILED（${failed} 项）`);
if (failed > 0) process.exitCode = 1;
