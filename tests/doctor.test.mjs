/**
 * tests/doctor.test.mjs —— 离线体检的回归测试。
 *
 * 为什么值得有测试：这个体检的价值全在「能不能抓到那个静默失效」。
 * 所以这里不测“能打印”，而是用假 profile 造出三种真实状态：
 *   ① 一切正常；
 *   ② node_modules 里的链接指向一个已被删除的目录（就是这次真机踩到的坑）；
 *   ③ 规则文件存在但 roots 为空。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { diagnose, hasConfigRow, lastTraceAt, linkTarget, render } from '../src/doctor.mjs';

const NAME = 'dsh-multi-workspace';

/** 造一个假 profile + 假 package 目录。 */
function fixture({ brokenLink = false, roots = 1 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-doctor-'));
  const profileDir = path.join(root, 'profile');
  const packageDir = path.join(root, 'package');
  fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(packageDir, '.dsh'), { recursive: true });
  fs.mkdirSync(path.join(packageDir, 'src'), { recursive: true });

  const realDir = path.join(root, 'real-package');
  fs.mkdirSync(realDir, { recursive: true });

  const link = path.join(profileDir, 'node_modules', NAME);
  if (brokenLink) {
    // 先建一个 junction，再把目标删掉 —— 这就是「目录改名后」的真实状态
    fs.symlinkSync(realDir, link, 'junction');
    fs.rmdirSync(realDir);
  } else {
    fs.symlinkSync(realDir, link, 'junction');
  }

  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-test',
    private: true,
    dependencies: { [NAME]: `link:${realDir}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', NAME] } },
  }, null, 2));

  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), `- id: ${NAME}\n  roots: []\n`);

  fs.writeFileSync(path.join(packageDir, '.dsh', 'multi-workspace-rules.json'), JSON.stringify({
    version: 2,
    roots: Array.from({ length: roots }, (_, index) => ({
      path: `C:/tmp/root-${index}`, capabilities: ['read', 'write'], mode: 'persistent',
    })),
    shell: { mode: 'deny', allowlist: [] },
    sensitive: { deny: ['.env', '*.pem'] },
    audit: { enabled: true, file: '.dsh/multi-workspace-audit.jsonl' },
  }, null, 2));

  fs.writeFileSync(path.join(packageDir, '.dsh', 'multi-workspace-audit.jsonl'),
    `${JSON.stringify({ ts: new Date().toISOString(), tool: 'panel', code: 'add:ADDED' })}\n`);

  // 源码文件：mtime 设为过去，保证“加载轨迹比源码新”
  const entry = path.join(packageDir, 'src', 'index.mjs');
  fs.writeFileSync(entry, 'export const name = "x";\n');
  const past = Date.now() - 60_000;
  fs.utimesSync(entry, past / 1000, past / 1000);

  fs.writeFileSync(path.join(packageDir, '.dsh', 'load-trace.log'),
    `${JSON.stringify({ at: new Date().toISOString(), event: 'registered', version: '0.0.0-test' })}\n`);

  return { root, profileDir, packageDir };
}

test('healthy profile reports no problems', () => {
  const { profileDir, packageDir } = fixture();
  const report = diagnose({ profileDir, packageDir, fs });
  assert.equal(report.ok, true, report.problems.map((p) => p.code).join(','));
  assert.equal(report.info.roots, 1);
  assert.equal(report.info.bundlesListed, true);
  assert.match(render(report), /体检通过/);
});

test('a link pointing at a deleted directory is reported as LINK_BROKEN', () => {
  const { profileDir, packageDir } = fixture({ brokenLink: true });
  const report = diagnose({ profileDir, packageDir, fs });
  assert.equal(report.ok, false);
  const codes = report.problems.map((p) => p.code);
  assert.ok(codes.includes('LINK_BROKEN'), codes.join(','));
  const broken = report.problems.find((p) => p.code === 'LINK_BROKEN');
  assert.match(broken.fix, /mklink/);
  assert.equal(report.info.resolvedTo, null);
});

test('zero roots is called out even when everything else is fine', () => {
  const { profileDir, packageDir } = fixture({ roots: 0 });
  const report = diagnose({ profileDir, packageDir, fs });
  assert.equal(report.ok, false);
  assert.deepEqual(report.problems.map((p) => p.code), ['ROOTS_EMPTY']);
});

test('helpers: config row, link target and last activation time', () => {
  assert.equal(hasConfigRow(`- id: ${NAME}\n`), true);
  assert.equal(hasConfigRow(`- id: something-else\n`), false);
  assert.equal(linkTarget(`link:C:/a/b`), 'C:/a/b');
  assert.equal(linkTarget('^0.5.3'), null);
  const text = [
    JSON.stringify({ at: '2026-01-01T00:00:00.000Z', event: 'registered' }),
    JSON.stringify({ at: '2026-02-01T00:00:00.000Z', event: 'apply-enter' }),
    JSON.stringify({ at: '2026-03-01T00:00:00.000Z', event: 'module-evaluated' }),
  ].join('\n');
  assert.equal(lastTraceAt(text), '2026-02-01T00:00:00.000Z');
});
