#!/usr/bin/env node
/**
 * 隐私检查器：防止把本机私人信息推进公开仓库。
 *
 * 设计要点
 * - 零依赖，只用 Node 内置模块。
 * - 默认扫描 git 追踪的文件；仓库尚未 git init 时退化为扫描工作区（仍排除 .git）。
 * - 命中即非零退出，并打印「文件:行号 + 命中原因」。
 * - 规则本身不写死任何真实姓名，避免检查器自己成为泄露源；
 *   规则用正则描述「不该出现在公开仓库里的形状」。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative, extname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.cwd()

// 只扫这些扩展名，避免把二进制当文本读。
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.json', '.yml', '.yaml',
  '.md', '.txt', '.html', '.css', '.sh',
])

// 永远不扫的目录。
const SKIP_DIRS = new Set(['.git', 'node_modules', 'coverage', 'dist', '.github-cache'])

/**
 * 禁止形状清单。每条 = { reason, pattern }
 * 原则：描述「形状」而不是列举真实值，检查器自身不携带敏感字符串。
 */
export const RULES = [
  {
    reason: '本机绝对路径（Windows 用户目录）',
    pattern: /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[^\\/\s"'`]+/i,
  },
  {
    reason: '本机绝对路径（类 Unix home）',
    pattern: /(?:\/home\/|\/Users\/)[A-Za-z0-9._-]+/,
  },
  {
    reason: '疑似 GitHub 令牌',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  },
  {
    reason: '疑似 OpenAI/通用 API 密钥',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}/,
  },
  {
    reason: '疑似私钥块',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  {
    reason: '疑似硬编码密钥赋值',
    pattern: /\b(?:api[_-]?key|secret|password|passwd|token)\b\s*[:=]\s*["'][^"']{8,}["']/i,
  },
  {
    reason: '真实姓名占位（上一个人设残留）',
    // 用 Unicode 转义拼出关键词，检查器源码里不出现字面姓名。
    pattern: new RegExp('[\\u6797][\\u4e91]'),
  },
  {
    reason: '私人角色名残留',
    pattern: new RegExp('[\\u53e4][\\u6cb3][\\u6e1a]|[\\u6e1a]\\u52a0'),
  },
]

/** 该路径是否在跳过集合内。 */
function shouldSkip(rel) {
  return rel.split(sep).some(part => SKIP_DIRS.has(part))
}

/** 递归收集待扫描文件；优先用 git 追踪清单，保证「发什么就查什么」。 */
export function collectFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const tracked = out.split('\0').filter(Boolean)
    if (tracked.length > 0) return tracked.filter(f => TEXT_EXT.has(extname(f).toLowerCase()))
  } catch {
    // 不是 git 仓库或没有 git：退回文件系统遍历。
  }

  const acc = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry)
      const rel = relative(ROOT, abs)
      if (shouldSkip(rel)) continue
      const st = statSync(abs)
      if (st.isDirectory()) walk(abs)
      else if (TEXT_EXT.has(extname(entry).toLowerCase())) acc.push(rel)
    }
  }
  walk(ROOT)
  return acc
}

/** 扫描单个文件内容，返回命中列表。 */
export function scanText(text) {
  const hits = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    // 行内豁免：仅用于「演示/夹具里必须出现敏感形状」的明确标注，真实泄漏不该用它
    if (line.includes('privacy-check: allow')) continue
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        hits.push({ line: i + 1, reason: rule.reason, snippet: line.trim().slice(0, 100) })
      }
    }
  }
  return hits
}

function main() {
  if (!existsSync(ROOT)) {
    console.error('privacy-check: 工作目录不存在')
    process.exit(2)
  }

  const files = collectFiles()
  if (files.length === 0) {
    console.error('privacy-check: 没有找到可扫描的文本文件')
    process.exit(2)
  }

  let failures = 0
  for (const rel of files) {
    const abs = join(ROOT, rel)
    let text
    try {
      text = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    for (const hit of scanText(text)) {
      failures += 1
      console.error(`✗ ${rel}:${hit.line}  [${hit.reason}]`)
      console.error(`    ${hit.snippet}`)
    }
  }

  if (failures > 0) {
    console.error(`\nprivacy-check: 失败 — ${failures} 处命中（共扫描 ${files.length} 个文件）`)
    console.error('这些内容不应进入公开仓库。请脱敏后重试。')
    process.exit(1)
  }

  console.log(`privacy-check: 通过 — 扫描 ${files.length} 个文件，0 处命中`)
  process.exit(0)
}

// 仅在直接执行时跑 main；被 import 时只导出函数（便于测试）。
const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
if (invokedDirectly || process.argv[1]?.endsWith('privacy-check.mjs')) {
  main()
}
