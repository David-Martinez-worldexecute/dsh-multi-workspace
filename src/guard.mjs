/**
 * dsh-multi-workspace · 工具级文件权限闸（guard）—— V2 精简版
 *
 * V1 时这个文件里同时住着"路径判定"和"能力判定"。V2 把它们拆开了：
 *   - 路径判定 → `paths.mjs`（唯一来源，按平台分流）
 *   - 规则判定 → `rules.mjs`（自由规则：根/能力/只读/限时/exclude/include/敏感名单/shell）
 *   - 本文件 → 只做「DSH ToolGuard 形状」的适配 + 向后兼容的旧接口
 *
 * 为什么保留旧接口（`normalizeRules` / `matchRule` / `decide` / `createGuard`）：
 * 那 22 条测试是 V1 的行为契约，V2 不允许它们悄悄改变含义。所以旧名字都还在，
 * 内部实现改成调用 `rules.mjs`，语义由新引擎兜底。
 *
 * 事实依据（DSH 0.2.2-rc.3，读源码得出）：
 *   - `@deepseek-ai/dsh-tools/src/contracts.ts:410`
 *       export type ToolGuard = (execution: Readonly<ToolExecution>) => string | ToolGuardDenial | undefined
 *   - `@deepseek-ai/dsh-tools/src/contracts.ts:175-203` ToolExecutionInput 带 `name` 与 `arguments`
 *     ⇒ **guard 能看到工具名和调用参数**，所以"按路径分级"在插件层可行。
 *   - `@deepseek-ai/dsh-tools/src/index.ts:384` `guard(guard)`；`:393` `checkGuards` 取第一个 denial，
 *     且在 pre-execute policy 与 approval **之后**执行 ⇒ 挡不住审批弹窗，但挡得住真正落盘。
 *
 * 三条诚实的边界：
 *   1. 只管工具调用。`pwsh`/`bash` 的 `Remove-Item`、`del`、`rm` 看不见路径 ⇒ 默认直接拒。
 *   2. 策略栅栏，不是内核边界：原生进程、别的插件直连 fs 照旧能写。
 *   3. `read-only` 模式下沙箱本身就不授予写权限，guard 只是多一道。
 */

import {
  canonical,
  keyOf,
  samePathOf,
  withinOf,
  extractPaths as extractPathsImpl,
} from './paths.mjs'
import {
  CAP as CAP_V2,
  RULE_CODE,
  TOOL_SPECS,
  SHELL_TOOLS as SHELL_TOOLS_LIST,
  normalizeRoot,
  compileDoc,
  resolve,
} from './rules.mjs'

/** 四种能力。键名保持小写，和 V1 完全一致（测试与板子都按它取值）。 */
export const CAP = {
  read: CAP_V2.READ,
  write: CAP_V2.WRITE,
  delete: CAP_V2.DELETE,
  move: CAP_V2.MOVE,
}

/** 拒绝码。V1 的四个 + V2 新加的（旧名字一律不变，否则调用方会静默失配）。 */
export const GUARD_CODE = {
  PATH_OUTSIDE_SCOPE: RULE_CODE.PATH_OUTSIDE_SCOPE,
  CAPABILITY_DENIED: RULE_CODE.CAPABILITY_DENIED,
  SHELL_UNCONTROLLED: RULE_CODE.SHELL_UNCONTROLLED,
  READ_ONLY_MODE: RULE_CODE.READ_ONLY_MODE,
  SENSITIVE_DENIED: RULE_CODE.SENSITIVE_DENIED,
  READ_ONLY_ROOT: RULE_CODE.READ_ONLY_ROOT,
  EXCLUDED_PATH: RULE_CODE.EXCLUDED_PATH,
  NOT_INCLUDED: RULE_CODE.NOT_INCLUDED,
  GRANT_EXPIRED: RULE_CODE.GRANT_EXPIRED,
}

/** 工具名 → { cap, paths }（`rules.mjs` 的同一张表，转导出给老代码用）。 */
export const TOOL_RULES = TOOL_SPECS

/** 命令类工具名单。 */
export const SHELL_TOOLS = new Set(SHELL_TOOLS_LIST)

/** 路径工具：全部转导出 `paths.mjs`，不在这里重写第二份。 */
export { canonical, keyOf, samePathOf, withinOf }

/**
 * 从工具参数里抽路径（V1 签名，数组形态 `files[].path` 也支持）。
 * @param {unknown} args
 * @param {string[]} dotted
 * @param {'win32'|'posix'} [platform]
 */
export function extractPaths(args, dotted = [], platform = defaultPlatform()) {
  return extractPathsImpl(args, dotted, platform)
}

function defaultPlatform() {
  return process.platform === 'win32' ? 'win32' : 'posix'
}

/**
 * 归一化规则（V1 形状：`{ path, key, capabilities: Set }`）。
 * V2 的能力位、只读、限时等更细的字段走 `rules.normalizeRoot`，
 * 这里只保证老调用方拿到的形状不变。
 *
 * @param {Array<string | { path: string, capabilities?: string[] }>} roots
 * @param {'win32'|'posix'} platform
 */
export function normalizeRules(roots, platform = defaultPlatform()) {
  const list = Array.isArray(roots) ? roots : []
  const out = []
  for (const raw of list) {
    const p = typeof raw === 'string' ? raw : raw?.path
    if (typeof p !== 'string' || p.length === 0) continue
    const caps =
      Array.isArray(raw?.capabilities) && raw.capabilities.length > 0
        ? new Set(raw.capabilities)
        : new Set([CAP.read, CAP.write, CAP.delete, CAP.move])
    out.push({
      path: canonical(p, platform),
      key: keyOf(p, platform),
      capabilities: caps,
    })
  }
  return out
}

/**
 * 找出覆盖某路径的"最长前缀"规则（= 最具体的授权）。
 */
export function matchRule(target, rules, platform = defaultPlatform()) {
  let best
  for (const rule of rules) {
    if (samePathOf(target, rule.path, platform) || withinOf(target, rule.path, platform)) {
      if (best === undefined || rule.key.length > best.key.length) best = rule
    }
  }
  return best
}

/**
 * 造一个 DSH 可用的 ToolGuard。
 *
 * @param {object} options
 * @param {Array<string | { path: string, capabilities?: string[] }>} options.roots
 * @param {string} [options.mode] 'read-only' | 'workspace-write' | 'danger-full-access'
 * @param {boolean} [options.allowShell] 放行 shell 类工具（默认 false；V2 建议改用 shell.allowlist）
 * @param {'win32'|'posix'} [options.platform]
 * @param {(event: object) => void} [options.onDecision] 审计回调
 * @param {boolean} [options.enforceRead] 连读也管（默认 false）
 */
export function createGuard(options = {}) {
  const platform = options.platform ?? defaultPlatform()
  const rules = normalizeRules(options.roots, platform)
  const mode = options.mode ?? 'workspace-write'
  const allowShell = options.allowShell === true
  // 读默认不管：DSH 本来就不围栏读，管了会先把"看 asar / 看日志"这类正常操作弄坏。
  const enforceRead = options.enforceRead === true
  const onDecision = typeof options.onDecision === 'function' ? options.onDecision : () => {}

  return function guard(exec) {
    const name = typeof exec?.name === 'string' ? exec.name : ''
    const result = decide({
      name,
      args: exec?.arguments,
      rules,
      platform,
      mode,
      allowShell,
      enforceRead,
    })
    onDecision({ tool: name, args: exec?.arguments, ...result })
    return result.denial
  }
}

/**
 * 纯函数判定（测试直接调它，不用构造完整 ToolExecution）。
 * 内部一律走 `rules.resolve`，所以 V1 与 V2 的判定**不会漂移**。
 *
 * @returns {{ denial?: string, code?: string, cap?: string, path?: string, rule?: object, sensitive?: boolean }}
 */
export function decide({ name, args, rules, platform = defaultPlatform(), mode, allowShell = false, enforceRead = false, now = Date.now() }) {
  if (name === '') return {}

  // 兼容 V1：allowShell=true 表示"这个调用方自己承担 shell 风险"，直接跳过 shell 判定。
  // V2 的细粒度做法是 shell.allowlist（完整命令等值匹配），见 rules.mjs。
  if (allowShell && SHELL_TOOLS.has(name)) return {}

  const doc = compileDoc({ roots: rules ?? [] }, platform)
  const result = resolve({ name, args, doc, platform, mode, enforceRead, now })
  if (result.code === undefined) return {}
  return {
    denial: result.denial,
    code: result.code,
    cap: result.cap,
    path: result.path,
    rule: result.rule,
  }
}

/** 把 V2 的规则文档直接变成 guard（新代码用这个入口，比 createGuard 更细）。 */
export function createGuardFromDoc(doc, options = {}) {
  const platform = options.platform ?? defaultPlatform()
  const compiled = compileDoc(doc, platform)
  const mode = options.mode ?? 'workspace-write'
  const enforceRead = options.enforceRead === true
  const onDecision = typeof options.onDecision === 'function' ? options.onDecision : () => {}
  return function guard(exec) {
    const name = typeof exec?.name === 'string' ? exec.name : ''
    const result = resolve({ name, args: exec?.arguments, doc: compiled, platform, mode, enforceRead })
    onDecision({ tool: name, args: exec?.arguments, ...result })
    return result.denial
  }
}

export { normalizeRoot }
