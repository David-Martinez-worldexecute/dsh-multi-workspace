/**
 * 契约测试：**守卫与试算必须是同一个答案**。
 *
 * 真机上撞到过的事故：插件配置 `allowShell: true`，`ctx.tools.guard` 也真的放行了 shell，
 * 但面板「判定模拟器」和 `workspace_roots action=evaluate` 走的是另一条分支
 * （`evaluateCall()` 漏传 allowShell），于是回 `SHELL_UNCONTROLLED`。
 * 同一个问题两个出口两种答案 —— 另一个会话里的 Agent 就是照着这条假答案
 * 判断「shell 被禁、只能绕路」的，白耗了大量上下文。
 *
 * 这里不测"文案长什么样"，只测一条硬约束：
 * 对同一个调用，`guard()` 放行 <=> `evaluateCall()` 说 allow。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createInstance } from '../src/index.mjs'

/** 一个够用的假 ctx：只要 createInstance 摸得到的服务都在，且都不真做事。 */
function fakeCtx() {
  const ctx = {
    tools: { guard: () => () => {}, register: () => () => {}, defineTool: (d) => d },
    configEditor: { async edit() {} },
    sandboxPolicy: { registerWritableRoot: () => () => {} },
    sessions: { get: () => null },
    effect: (fn) => { fn(); return () => {} },
    inject: (names, cb) => {
      if (names.includes('webServer')) {
        cb({ ...ctx, webServer: { register: () => () => {} }, effect: (fn) => { fn(); return () => {} } })
      }
    },
  }
  return ctx
}

test('服务必须优先用 ctx.get(name) 找 —— 真机上的 configEditor/sandboxPolicy 就是这么暴露的', () => {
  // 真机证据：app.asar 里宿主自带文档的写法是 `const editor = ctx.get('configEditor')`，
  // 而它并没有把这些服务挂在 ctx 的属性上（没 inject 时直接读属性还会抛 without inject）。
  // 只提供 ctx.get 的假 ctx，模拟的正是真机的形状。
  const table = {
    configEditor: { async edit() {}, async read() {} },
    sandboxPolicy: { registerWritableRoot: () => () => {} },
    sessions: { get: () => null },
  }
  const inst = createInstance(
    { get: (name) => table[name] },
    { rulesFile: join(mkdtempSync(join(tmpdir(), 'mw-get-')), 'rules.json') },
  )
  const status = inst.snapshot().status
  assert.equal(status.persistent, true, '拿得到 configEditor.edit 就该算可持久化')
  assert.equal(status.sessionRootsSupported, true, '拿得到 registerWritableRoot 就该支持会话根')
  assert.deepEqual(status.problems, [], '两个服务都在，不该有任何降级说明')
})

/** 造一个隔离实例：规则文件落在临时目录，不碰仓库里的 .dsh。 */
function instance(config, doc) {
  const dir = mkdtempSync(join(tmpdir(), 'mw-contract-'))
  const rulesFile = join(dir, 'rules.json')
  // 规则要真落进文件：store.load() 每次判定前会从文件重读，内存里的 config 会被覆盖。
  if (doc) writeFileSync(rulesFile, JSON.stringify(doc), 'utf8')
  return createInstance(fakeCtx(), {
    roots: [],
    audit: false,
    requireApproval: false,
    rulesFile,
    ...config,
  })
}

/** 两个出口各判一次，返回 { guardDenied, evaluateDecision, code }。 */
function both(inst, name, args) {
  const guardDenied = inst.guard({ name, arguments: args }) !== undefined
  const ev = inst.evaluateCall({ toolName: name, args })
  return { guardDenied, evaluateDecision: ev.decision, code: ev.code, reason: ev.reason }
}

test('allowShell: true 时，守卫与试算都说 shell 放行（真机事故的回归）', () => {
  const inst = instance({ allowShell: true })
  const r = both(inst, 'ops_bash', { command: 'echo hi' })
  assert.equal(r.guardDenied, false, '守卫应放行 shell')
  assert.equal(r.evaluateDecision, 'allow', '试算也必须说 allow，否则面板在骗人')
  assert.equal(r.code, 'OK')
})

test('allowShell: false 时，守卫与试算都拒绝，而且码一致', () => {
  const inst = instance({ allowShell: false })
  const r = both(inst, 'ops_bash', { command: 'echo hi' })
  assert.equal(r.guardDenied, true, '守卫应拒绝 shell')
  assert.equal(r.evaluateDecision, 'deny')
  assert.equal(r.code, 'SHELL_UNCONTROLLED')
})

test('一个根都没配时，写外部路径两个出口都放行（空根 = 不围栏）', () => {
  const inst = instance({ allowShell: true })
  const r = both(inst, 'write', { file_path: 'D:\\outside\\a.txt' })
  assert.equal(r.guardDenied, false)
  assert.equal(r.evaluateDecision, 'allow')
})

// 注：围栏路径（根已配置、写根外被拒）不在这个文件里测。
// 原因很具体：createInstance 的内存 doc 只由 config 构造，guard()/evaluateCall() 走
// compiledDoc() 不触发 store.load()（只有 HTTP 路由的 guarded() 会 await store.load()），
// 所以这里塞 config.roots 或写 rulesFile 都进不了判定用的 doc —— 那是夹具假设错，
// 不是实现错。围栏本身的判定由 tests/rules.test.mjs 直接覆盖 resolve()，
// 而两个出口调的都是同一个 resolve()，契约由上面三条守住即可。
