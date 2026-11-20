#!/usr/bin/env node
/**
 * bin/mw.mjs —— 本地控制台入口。
 *
 * 用法（不装任何依赖）：
 *   node bin/mw.mjs list
 *   node bin/mw.mjs add "D:\projects\foo" --caps read,write
 *   node bin/mw.mjs probe "D:\projects\foo"
 *   node bin/mw.mjs diff --profile "%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml"
 *
 * 它只改工作区里的 `.dsh/workspace-roots.json`。要写进 DSH 的 profile，
 * 必须走插件的 `workspace_roots sync` 且由用户批准 —— 这个脚本故意不做那一步。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { createCli, CLI_DEFAULT_FILE } from '../src/cli.mjs';

const argv = process.argv.slice(2);
const flagIndex = argv.indexOf('--profile');
const profileFlag = flagIndex === -1 ? undefined : argv[flagIndex + 1];
const rest = flagIndex === -1 ? argv : [...argv.slice(0, flagIndex), ...argv.slice(flagIndex + 2)];

const workspaceRoot = process.cwd();
const profilePatch = profileFlag
  ?? join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');

const cli = createCli({ workspaceRoot, rootFile: join(workspaceRoot, CLI_DEFAULT_FILE), profilePatch });
const result = cli.run(rest);

for (const line of result.lines) console.log(line);
if (!result.ok) {
  console.log(`\n[${result.code}]`);
  process.exitCode = result.code === 'PATH_MISSING_ARG' || result.code === 'UNKNOWN_COMMAND' ? 2 : 1;
}
