/**
 * dsh-multi-workspace — path validator.
 *
 * Design rules (see plan):
 *  - Pure logic except for the injected `fs` (defaults to node:fs). Tests pass a
 *    fake fs so no real symlink/ACL privileges are needed.
 *  - Every rejection returns a stable machine code plus a human-readable reason.
 *  - Comparison is case-insensitive on win32 but the ORIGINAL spelling is what
 *    gets stored; keys exist only for comparison.
 *  - Containment is decided by path-segment boundaries, never by string prefix
 *    ("D:\a" must not contain "D:\ab").
 */

import path from 'node:path'
import nodeFs from 'node:fs'

export const CODE = {
  OK: 'OK',
  NOT_ABSOLUTE: 'PATH_NOT_ABSOLUTE',
  UNSUPPORTED_FORM: 'PATH_UNSUPPORTED_FORM',
  MISSING: 'PATH_MISSING',
  NOT_DIR: 'PATH_NOT_DIR',
  IS_SYMLINK: 'PATH_IS_SYMLINK',
  TOO_WIDE: 'PATH_TOO_WIDE',
  DUPLICATE: 'PATH_DUPLICATE',
  COVERED: 'PATH_COVERED_BY_EXISTING',
  INSIDE_WORKSPACE: 'PATH_INSIDE_WORKSPACE',
}

const WIN_LONG = /^\\\\\?\\/
const WIN_UNC = /^\\\\[^\\]/
const WIN_ABS = /^[A-Za-z]:[\\/]/
const WIN_DRIVE_REL = /^[A-Za-z]:(?![\\/])/
const WIN_DRIVE_ROOT = /^[A-Za-z]:[\\/]$/

/**
 * Classify the *form* of a path string without touching the filesystem.
 * @param {unknown} input
 * @param {string} platform
 * @returns {{ form: string }}
 */
export function detectForm(input, platform = process.platform) {
  if (typeof input !== 'string' || input.trim() === '') return { form: 'empty' }
  const raw = input
  // Order matters: "\\?\C:\x" also looks like a UNC path.
  if (WIN_LONG.test(raw)) return { form: 'win-long' }
  if (WIN_UNC.test(raw)) return { form: 'unc' }
  if (platform === 'win32') {
    if (WIN_ABS.test(raw)) return { form: 'win-abs' }
    if (WIN_DRIVE_REL.test(raw)) return { form: 'drive-relative' }
    return { form: 'win-relative' }
  }
  return { form: path.posix.isAbsolute(raw) ? 'posix-abs' : 'relative' }
}

/**
 * Normalize separators and drop trailing separators, but keep a drive root as
 * "D:\" so it can never be mistaken for the drive-relative "D:".
 * @param {string} input
 * @returns {string}
 */
export function stripTrailingSeparators(input) {
  if (typeof input !== 'string') return input
  const s = input.replace(/\//g, '\\')
  if (WIN_DRIVE_ROOT.test(s)) return s.slice(0, 2) + '\\'
  return s.replace(/\\+$/, '')
}

/**
 * Comparison key. Never store this; it exists only so two spellings of the same
 * directory compare equal.
 * @param {string} input
 * @param {string} platform
 * @returns {string}
 */
export function normalizeKey(input, platform = process.platform) {
  const s = stripTrailingSeparators(input)
  return platform === 'win32' ? s.toLowerCase() : s
}

/**
 * @param {string} a
 * @param {string} b
 * @param {string} platform
 * @returns {boolean}
 */
export function samePath(a, b, platform = process.platform) {
  return normalizeKey(a, platform) === normalizeKey(b, platform)
}

/**
 * True when `child` lives strictly under `parent` (segment-boundary aware).
 * @param {string} child
 * @param {string} parent
 * @param {string} platform
 * @returns {boolean}
 */
export function isWithin(child, parent, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix
  const rel = p.relative(stripTrailingSeparators(parent), stripTrailingSeparators(child))
  if (rel === '') return false
  if (rel.startsWith('..')) return false
  return !p.isAbsolute(rel)
}

/**
 * Deny reasons that do not depend on which roots the user already has.
 * Drive roots, OS trees, the home root and the DSH profile tree.
 *
 * @param {string} target original spelling
 * @param {{ platform?: string, home?: string, dshHome?: string }} [opts]
 * @returns {{ denied: true, reason: string } | null}
 */
export function denialReason(target, opts = {}) {
  const platform = opts.platform ?? process.platform
  const raw = stripTrailingSeparators(target)
  const key = normalizeKey(raw, platform)

  if (platform === 'win32' && WIN_DRIVE_ROOT.test(raw)) {
    return { denied: true, reason: '这是一个磁盘根目录：整个分区可写，等于没有边界。' }
  }

  /** @type {{ path: string, reason: string }[]} */
  const rules = []
  if (platform === 'win32') {
    rules.push({ path: 'C:\\Windows', reason: '系统目录：可写会导致系统级破坏。' })
    rules.push({ path: 'C:\\Program Files', reason: '程序安装目录：修改会破坏其他软件的完整性。' })
    rules.push({ path: 'C:\\Program Files (x86)', reason: '程序安装目录：修改会破坏其他软件的完整性。' })
    rules.push({ path: 'C:\\ProgramData', reason: '系统共享数据目录：影响本机所有用户。' })
  }
  if (opts.home) {
    rules.push({ path: opts.home, reason: '用户主目录根：范围过大，请指定具体项目子目录。' })
  }
  if (opts.dshHome) {
    rules.push({ path: opts.dshHome, reason: 'DSH 自身配置/插件目录：写入会破坏工具链。' })
  }

  for (const rule of rules) {
    const ruleKey = normalizeKey(rule.path, platform)
    if (key === ruleKey || isWithin(raw, rule.path, platform)) {
      return { denied: true, reason: rule.reason }
    }
  }
  return null
}

/**
 * @typedef {object} CheckResult
 * @property {boolean} ok            true when the root may be added (or is redundant)
 * @property {string} code           one of CODE
 * @property {string} message        human-readable, Chinese
 * @property {string} [path]         cleaned original spelling (what to store)
 * @property {string} [key]          comparison key
 * @property {string[]} warnings     non-fatal advisories
 */

/** @returns {CheckResult} */
function fail(code, message) {
  return { ok: false, code, message, warnings: [] }
}

/**
 * Decide whether `target` is an acceptable extra writable root.
 *
 * @param {object} options
 * @param {string} options.target
 * @param {string[]} [options.existingRoots]
 * @param {string} [options.workspaceRoot]
 * @param {string} [options.platform]
 * @param {string} [options.home]
 * @param {string} [options.dshHome]
 * @param {{ lstatSync: (p: string) => { isDirectory(): boolean, isSymbolicLink(): boolean } }} [options.fs]
 * @returns {CheckResult}
 */
export function checkRoot(options) {
  const {
    target,
    existingRoots = [],
    workspaceRoot,
    platform = process.platform,
    home,
    dshHome,
    fs = nodeFs,
  } = options

  /** @type {string[]} */
  const warnings = []

  const { form } = detectForm(target, platform)
  if (form === 'empty') return fail(CODE.NOT_ABSOLUTE, '路径是空的。')
  if (form === 'unc') {
    return fail(CODE.UNSUPPORTED_FORM, '暂不支持网络共享路径（\\\\server\\share）。')
  }
  if (form === 'win-long') {
    return fail(CODE.UNSUPPORTED_FORM, '暂不支持 \\\\?\\ 长路径前缀。')
  }
  if (form === 'drive-relative') {
    return fail(CODE.UNSUPPORTED_FORM, '这是盘符相对路径（D:foo），请写成完整的 D:\\foo。')
  }
  if (form !== 'win-abs' && form !== 'posix-abs') {
    return fail(CODE.NOT_ABSOLUTE, '这是相对路径；额外根必须是绝对路径。')
  }

  const cleaned = stripTrailingSeparators(String(target))

  /** @type {{ isDirectory(): boolean, isSymbolicLink(): boolean }} */
  let stat
  try {
    stat = fs.lstatSync(cleaned)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return fail(CODE.MISSING, '目录不存在：' + cleaned)
    }
    throw error
  }

  // Reject links instead of resolving them: following a link would make the
  // checked path and the used path differ (TOCTOU surface).
  if (stat.isSymbolicLink()) {
    return fail(CODE.IS_SYMLINK, '这是符号链接/联接点；额外根必须是真实目录（不跟随链接）。')
  }
  if (!stat.isDirectory()) {
    return fail(CODE.NOT_DIR, '这不是目录，而是一个文件。')
  }

  const denial = denialReason(cleaned, { platform, home, dshHome })
  if (denial) return fail(CODE.TOO_WIDE, denial.reason)

  const key = normalizeKey(cleaned, platform)
  for (const existing of existingRoots) {
    if (normalizeKey(existing, platform) === key) {
      return fail(CODE.DUPLICATE, '这个目录已经在列表里了（现有写法：' + existing + '）。')
    }
  }
  for (const existing of existingRoots) {
    if (isWithin(cleaned, existing, platform)) {
      return fail(CODE.COVERED, '这个目录已经被现有根 ' + existing + ' 覆盖，不需要重复添加。')
    }
  }
  for (const existing of existingRoots) {
    if (isWithin(existing, cleaned, platform)) {
      warnings.push('新根包含已有的 ' + existing + '；添加后那条可能变成冗余。')
    }
  }

  if (workspaceRoot) {
    if (samePath(cleaned, workspaceRoot, platform)) {
      return {
        ok: true,
        code: CODE.INSIDE_WORKSPACE,
        message: '这就是当前工作区根目录，本来就允许写入。',
        path: cleaned,
        key,
        warnings,
      }
    }
    if (isWithin(cleaned, workspaceRoot, platform)) {
      return {
        ok: true,
        code: CODE.INSIDE_WORKSPACE,
        message: '这个目录位于当前工作区之内，本来就允许写入。',
        path: cleaned,
        key,
        warnings,
      }
    }
  }

  return { ok: true, code: CODE.OK, message: '校验通过。', path: cleaned, key, warnings }
}
