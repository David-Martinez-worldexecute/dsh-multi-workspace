#!/usr/bin/env node
/**
 * scripts/doctor.mjs —— 零依赖体检 CLI。
 *
 *   node scripts/doctor.mjs
 *   node scripts/doctor.mjs --profile "%USERPROFILE%/.dsh/profiles/desktop"
 *   node scripts/doctor.mjs --json
 *
 * 它解决的问题：插件「装好了、面板也在，但写文件还是被拒」这类现象，
 * 很多时候不是规则配错，而是 DSH 启动时压根没把插件加载进来
 * （最常见：仓库目录改名后 profile 里的 link / junction 指向旧路径）。
 * 那种情况下插件自己的 doctor 永远不会执行，只能从磁盘上查。
 *
 * 只读，不修改任何文件。退出码 0 = 通过，1 = 有问题。
 */

import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { diagnose, render } from '../src/doctor.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

const packageDir = flag('--package') ?? fileURLToPath(new URL('..', import.meta.url));
const profileDir = flag('--profile') ?? path.join(homedir(), '.dsh', 'profiles', 'desktop');
const asJson = argv.includes('--json');

const report = diagnose({ profileDir, packageDir, fs });

if (asJson) {
  console.log(JSON.stringify({ profileDir, packageDir, ...report }, null, 2));
} else {
  console.log(`profile: ${profileDir}`);
  console.log(`package: ${packageDir}`);
  console.log('');
  console.log(render(report));
}

process.exitCode = report.ok ? 0 : 1;
