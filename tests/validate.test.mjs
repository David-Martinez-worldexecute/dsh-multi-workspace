import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CODE,
  checkRoot,
  denialReason,
  detectForm,
  isWithin,
  normalizeKey,
  samePath,
  stripTrailingSeparators,
} from '../src/validate.mjs'

const PLATFORM = 'win32'

/**
 * Fake filesystem: a map from path string to 'dir' | 'file' | 'symlink'.
 *
 * Lookups are case-insensitive on purpose: a real Windows filesystem resolves
 * "d:\foo" to "D:\Foo", and a fake that matched exact bytes would reject valid
 * spellings (and hide the behaviour we ship).
 *
 * @param {Record<string, 'dir' | 'file' | 'symlink'>} entries
 */
function fakeFs(entries) {
  /** @type {Map<string, 'dir' | 'file' | 'symlink'>} */
  const index = new Map()
  for (const [p, kind] of Object.entries(entries)) index.set(p.toLowerCase(), kind)
  return {
    lstatSync(p) {
      const kind = index.get(String(p).toLowerCase())
      if (!kind) {
        const error = new Error('ENOENT: ' + p)
        error.code = 'ENOENT'
        throw error
      }
      return {
        isDirectory: () => kind === 'dir',
        isSymbolicLink: () => kind === 'symlink',
        isFile: () => kind === 'file',
      }
    },
  }
}

test('detectForm classifies windows forms', () => {
  assert.equal(detectForm('D:\\projects\\foo', PLATFORM).form, 'win-abs')
  assert.equal(detectForm('D:/projects/foo', PLATFORM).form, 'win-abs')
  assert.equal(detectForm('\\\\server\\share', PLATFORM).form, 'unc')
  assert.equal(detectForm('\\\\?\\D:\\projects\\foo', PLATFORM).form, 'win-long')
  assert.equal(detectForm('D:projects', PLATFORM).form, 'drive-relative')
  assert.equal(detectForm('projects\\foo', PLATFORM).form, 'win-relative')
  assert.equal(detectForm('   ', PLATFORM).form, 'empty')
  assert.equal(detectForm(undefined, PLATFORM).form, 'empty')
})

test('long path prefix is not mistaken for UNC', () => {
  assert.equal(detectForm('\\\\?\\UNC\\server\\share', PLATFORM).form, 'win-long')
})

test('stripTrailingSeparators keeps the drive root', () => {
  assert.equal(stripTrailingSeparators('D:\\'), 'D:\\')
  assert.equal(stripTrailingSeparators('D:/'), 'D:\\')
  assert.equal(stripTrailingSeparators('D:\\a\\'), 'D:\\a')
  assert.equal(stripTrailingSeparators('D:\\a\\\\'), 'D:\\a')
  assert.equal(stripTrailingSeparators('D:\\a'), 'D:\\a')
})

test('normalizeKey is case-insensitive on win32 and keeps POSIX case', () => {
  assert.equal(normalizeKey('D:\\Foo\\Bar', 'win32'), normalizeKey('d:\\foo\\bar', 'win32'))
  assert.notEqual(normalizeKey('/Foo/Bar', 'linux'), normalizeKey('/foo/bar', 'linux'))
})

test('samePath ignores case and trailing separators', () => {
  assert.equal(samePath('D:\\Foo', 'd:/foo/', PLATFORM), true)
  assert.equal(samePath('D:\\Foo', 'D:\\Bar', PLATFORM), false)
})

test('isWithin respects segment boundaries', () => {
  // The classic trap: string prefix would say true.
  assert.equal(isWithin('D:\\ab', 'D:\\a', PLATFORM), false)
  assert.equal(isWithin('D:\\a\\b', 'D:\\a', PLATFORM), true)
  assert.equal(isWithin('D:\\a', 'D:\\a', PLATFORM), false, 'equal paths are not "within"')
  assert.equal(isWithin('E:\\a', 'D:\\a', PLATFORM), false)
})

test('denialReason rejects drive roots, OS trees, home root and DSH home', () => {
  assert.ok(denialReason('D:\\', { platform: PLATFORM }))
  assert.ok(denialReason('C:\\Windows', { platform: PLATFORM }))
  assert.ok(denialReason('C:\\Windows\\System32', { platform: PLATFORM }))
  assert.ok(denialReason('C:\\Program Files\\x', { platform: PLATFORM }))
  assert.ok(denialReason('C:\\ProgramData', { platform: PLATFORM }))
  assert.ok(denialReason('C:\\Users\\lin', { platform: PLATFORM, home: 'C:\\Users\\lin' }))
  assert.ok(denialReason('C:\\Users\\lin\\.dsh', { platform: PLATFORM, dshHome: 'C:\\Users\\lin\\.dsh' }))
  assert.equal(denialReason('D:\\projects\\foo', { platform: PLATFORM, home: 'C:\\Users\\lin' }), null)
})

test('checkRoot rejects relative, unsupported forms and empty input', () => {
  const fs = fakeFs({})
  assert.equal(checkRoot({ target: 'foo\\bar', platform: PLATFORM, fs }).code, CODE.NOT_ABSOLUTE)
  assert.equal(checkRoot({ target: '', platform: PLATFORM, fs }).code, CODE.NOT_ABSOLUTE)
  assert.equal(checkRoot({ target: '\\\\server\\share', platform: PLATFORM, fs }).code, CODE.UNSUPPORTED_FORM)
  assert.equal(checkRoot({ target: '\\\\?\\D:\\a', platform: PLATFORM, fs }).code, CODE.UNSUPPORTED_FORM)
  assert.equal(checkRoot({ target: 'D:foo', platform: PLATFORM, fs }).code, CODE.UNSUPPORTED_FORM)
})

test('checkRoot rejects missing paths and files', () => {
  const fs = fakeFs({ 'D:\\a.txt': 'file' })
  assert.equal(checkRoot({ target: 'D:\\nope', platform: PLATFORM, fs }).code, CODE.MISSING)
  assert.equal(checkRoot({ target: 'D:\\a.txt', platform: PLATFORM, fs }).code, CODE.NOT_DIR)
})

test('checkRoot rejects symlinks without resolving them', () => {
  const fs = fakeFs({ 'D:\\link': 'symlink' })
  assert.equal(checkRoot({ target: 'D:\\link', platform: PLATFORM, fs }).code, CODE.IS_SYMLINK)
})

test('checkRoot rejects duplicates regardless of case and trailing slash', () => {
  const fs = fakeFs({ 'D:\\Foo': 'dir' })
  const result = checkRoot({
    target: 'd:\\foo\\',
    existingRoots: ['D:\\Foo'],
    platform: PLATFORM,
    fs,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, CODE.DUPLICATE)
  assert.match(result.message, /D:\\Foo/, 'the existing spelling is echoed back')
})

test('checkRoot rejects a directory already covered by an existing root', () => {
  const fs = fakeFs({ 'D:\\a\\b': 'dir' })
  const result = checkRoot({
    target: 'D:\\a\\b',
    existingRoots: ['D:\\a'],
    platform: PLATFORM,
    fs,
  })
  assert.equal(result.code, CODE.COVERED)
})

test('checkRoot warns when the new root swallows an existing one', () => {
  const fs = fakeFs({ 'D:\\a': 'dir' })
  const result = checkRoot({
    target: 'D:\\a',
    existingRoots: ['D:\\a\\b'],
    platform: PLATFORM,
    fs,
  })
  assert.equal(result.ok, true)
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /D:\\a\\b/)
})

test('checkRoot reports the workspace as already writable instead of an error', () => {
  const fs = fakeFs({ 'C:\\ws': 'dir', 'C:\\ws\\sub': 'dir' })
  const atRoot = checkRoot({
    target: 'C:\\ws',
    workspaceRoot: 'C:\\ws',
    platform: PLATFORM,
    fs,
  })
  assert.equal(atRoot.ok, true)
  assert.equal(atRoot.code, CODE.INSIDE_WORKSPACE)

  const inSub = checkRoot({
    target: 'C:\\ws\\sub',
    workspaceRoot: 'C:\\ws',
    platform: PLATFORM,
    fs,
  })
  assert.equal(inSub.ok, true)
  assert.equal(inSub.code, CODE.INSIDE_WORKSPACE)
})

test('checkRoot accepts a valid directory and returns the cleaned spelling', () => {
  const fs = fakeFs({ 'D:\\projects\\中文 目录': 'dir' })
  const result = checkRoot({
    target: 'D:/projects/中文 目录/',
    platform: PLATFORM,
    fs,
  })
  assert.equal(result.ok, true)
  assert.equal(result.code, CODE.OK)
  assert.equal(result.path, 'D:\\projects\\中文 目录', 'separators normalized, trailing slash dropped')
  assert.equal(result.key, 'd:\\projects\\中文 目录')
  assert.deepEqual(result.warnings, [])
})
