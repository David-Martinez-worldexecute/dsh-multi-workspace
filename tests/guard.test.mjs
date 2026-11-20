import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CAP,
  GUARD_CODE,
  createGuard,
  decide,
  extractPaths,
  matchRule,
  normalizeRules,
} from '../src/guard.mjs'

const W = 'win32'

/** 造一组"骨架"规则（不走 normalizeRules 的默认四能力，全部显式写清楚）。 */
const rules = normalizeRules([
  { path: 'D:\\work\\proj-a', capabilities: [CAP.read, CAP.write, CAP.delete, CAP.move] },
  { path: 'D:\\work\\proj-a\\secret', capabilities: [CAP.read] },
  { path: 'D:\\shared', capabilities: [CAP.read, CAP.write] },
], W)

/** 判定一次调用，返回 code（没有 code 表示放行）。 */
function codeOf(name, args, extra = {}) {
  return decide({ name, args, rules, platform: W, mode: 'workspace-write', allowShell: false, ...extra }).code
}

test('extractPaths 支持普通字段', () => {
  assert.deepEqual(extractPaths({ path: 'D:\\a' }, 'path'), ['D:\\a'])
  assert.deepEqual(extractPaths({ file_path: 'D:\\b' }, 'file_path'), ['D:\\b'])
  assert.deepEqual(extractPaths({ to: '' }, 'to'), [], '空串不算一条路径')
  assert.deepEqual(extractPaths(null, 'path'), [])
})

test('extractPaths 支持 files[].path 数组写法', () => {
  const args = { files: [{ path: 'D:\\a\\1.txt' }, { path: 'D:\\a\\2.txt' }, { nope: 1 }] }
  assert.deepEqual(extractPaths(args, 'files[].path'), ['D:\\a\\1.txt', 'D:\\a\\2.txt'])
})

test('matchRule 取最长前缀（更具体的授权优先）', () => {
  const hit = matchRule('D:\\work\\proj-a\\secret\\k.txt', rules, W)
  assert.equal(hit.path, 'D:\\work\\proj-a\\secret')
  const other = matchRule('D:\\work\\proj-a\\src\\a.js', rules, W)
  assert.equal(other.path, 'D:\\work\\proj-a')
})

test('已授权根内的写操作放行', () => {
  assert.equal(codeOf('write', { file_path: 'D:\\work\\proj-a\\src\\a.js' }), undefined)
})

test('根外写操作被拒，且码是 PATH_OUTSIDE_SCOPE', () => {
  assert.equal(codeOf('write', { file_path: 'D:\\work\\proj-b\\src\\a.js' }), GUARD_CODE.PATH_OUTSIDE_SCOPE)
})

test('前缀相似但不是同一棵树时不被误放行', () => {
  // D:\work\proj-ab 不该被 D:\work\proj-a 覆盖
  assert.equal(codeOf('write', { file_path: 'D:\\work\\proj-ab\\x.txt' }), GUARD_CODE.PATH_OUTSIDE_SCOPE)
})

test('大小写不同的同一路径算命中（Windows 语义）', () => {
  assert.equal(codeOf('write', { file_path: 'd:\\WORK\\Proj-A\\x.txt' }), undefined)
})

test('只读能力根：写被拒，码是 CAPABILITY_DENIED', () => {
  assert.equal(codeOf('write', { file_path: 'D:\\work\\proj-a\\secret\\k.txt' }), GUARD_CODE.CAPABILITY_DENIED)
})

test('删需要 delete 能力，shared 根没有 → 拒绝', () => {
  assert.equal(codeOf('ops_remove', { path: 'D:\\shared\\old.txt' }), GUARD_CODE.CAPABILITY_DENIED)
})

test('删在 proj-a 根上放行（四种能力都有）', () => {
  assert.equal(codeOf('ops_remove', { path: 'D:\\work\\proj-a\\old.txt' }), undefined)
})

test('只读模式拦所有写/删，码是 READ_ONLY_MODE', () => {
  assert.equal(codeOf('write', { file_path: 'D:\\work\\proj-a\\a.js' }, { mode: 'read-only' }), GUARD_CODE.READ_ONLY_MODE)
  assert.equal(codeOf('ops_remove', { path: 'D:\\work\\proj-a\\a.js' }, { mode: 'read-only' }), GUARD_CODE.READ_ONLY_MODE)
})

test('读默认不管（DSH 本来就不围栏读）', () => {
  assert.equal(codeOf('read', { file_path: 'C:\\Users\\lin\\anything.txt' }), undefined)
})

test('显式 enforceRead 后，根外读被拦', () => {
  assert.equal(
    codeOf('read', { file_path: 'C:\\Users\\lin\\anything.txt' }, { enforceRead: true }),
    GUARD_CODE.PATH_OUTSIDE_SCOPE,
  )
})

test('shell 类工具默认被拒，码是 SHELL_UNCONTROLLED', () => {
  assert.equal(codeOf('pwsh', { command: 'Remove-Item D:\\x -Recurse' }), GUARD_CODE.SHELL_UNCONTROLLED)
  assert.equal(codeOf('ops_bash', { command: 'rm -rf /tmp/x' }), GUARD_CODE.SHELL_UNCONTROLLED)
})

test('allowShell 后放行（由调用方承担风险）', () => {
  assert.equal(codeOf('pwsh', { command: 'Get-Date' }, { allowShell: true }), undefined)
})

test('不认识的工具不干预', () => {
  assert.equal(codeOf('web_search', { queries: ['a'] }), undefined)
})

test('没有路径参数时不误伤（交给工具自己报错）', () => {
  assert.equal(codeOf('write', {}), undefined)
})

test('move 两个路径都要过：目标在根外就拒', () => {
  const args = { path: 'D:\\work\\proj-a\\a.txt', to: 'D:\\work\\proj-b\\a.txt' }
  const r = decide({ name: 'ops_move', args, rules, platform: W, mode: 'workspace-write', allowShell: false })
  assert.equal(r.code, GUARD_CODE.PATH_OUTSIDE_SCOPE)
  assert.equal(r.path, 'D:\\work\\proj-b\\a.txt')
})

test('createGuard 返回 denial 字符串（模型侧能读懂人话）', () => {
  const guard = createGuard({
    roots: ['D:\\work\\proj-a'],
    platform: W,
    mode: 'workspace-write',
  })
  const denial = guard({ name: 'write', arguments: { file_path: 'E:\\elsewhere\\x.txt' } })
  assert.equal(typeof denial, 'string')
  assert.match(denial, /不在已授权范围内/)
  assert.equal(guard({ name: 'write', arguments: { file_path: 'D:\\work\\proj-a\\x.txt' } }), undefined)
})

test('createGuard 的审计回调能看到每次判定', () => {
  const seen = []
  const guard = createGuard({
    roots: ['D:\\work\\proj-a'],
    platform: W,
    mode: 'workspace-write',
    onDecision: event => seen.push(event),
  })
  guard({ name: 'write', arguments: { file_path: 'D:\\work\\proj-a\\x.txt' } })
  guard({ name: 'ops_remove', arguments: { path: 'E:\\nope\\y.txt' } })
  assert.equal(seen.length, 2)
  assert.equal(seen[0].tool, 'write')
  assert.equal(seen[0].code, undefined)
  assert.equal(seen[1].code, GUARD_CODE.PATH_OUTSIDE_SCOPE)
})

test('纯字符串根 = 四种能力全给', () => {
  const r = normalizeRules(['D:\\plain'], W)
  for (const cap of [CAP.read, CAP.write, CAP.delete, CAP.move]) assert.ok(r[0].capabilities.has(cap))
})

test('POSIX 平台不被 Windows 的斜杠规则污染', () => {
  const posix = normalizeRules(['/home/lin/proj'], 'posix')
  assert.equal(posix[0].path, '/home/lin/proj')
  const r = decide({
    name: 'write',
    args: { file_path: '/home/lin/proj/a.txt' },
    rules: posix,
    platform: 'posix',
    mode: 'workspace-write',
    allowShell: false,
  })
  assert.equal(r.code, undefined)
})
