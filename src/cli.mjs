/**
 * cli.mjs —— 本地控制台的全部逻辑（不依赖 DSH 运行时）。
 *
 * 为什么要有它：DSH 插件面板要么得装进 profile、要么得构建客户端 bundle，
 * 在"还没决定要不要装"的阶段，用户需要一个**现在就能用**的入口。
 * 规则存在工作区里的 `.dsh/workspace-roots.json`；它只影响本地这份文件与
 * `sync` 的演算结果，**不碰 profile**（写 profile 是 M4 的事，得用户拍板）。
 *
 * 三条硬边界，代码里也写着：
 * ① 这里不校验"DSH 到底允不允许写"，只校验路径本身合不合法；
 * ② `diff` 对 profile 的解析是**逐行文本扫描**，不是 YAML 解析器 —— 解析失败就明说；
 * ③ `probe` 只在目标目录真写一个临时文件再删，写不进去就是写不进去。
 */

import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CAP, ALL_CAPS, normalizeRoot, compileDoc, resolve, summarize } from './rules.mjs';
import { checkRoot, normalizeKey } from './validate.mjs';
import { planAuthorization, diffAuthorization, normalizeDoc, DOC_VERSION } from './store.mjs';

export const CLI_DEFAULT_FILE = '.dsh/workspace-roots.json';

const REAL_FS = {
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  randomBytes,
};

/** `--caps read,write` / `--caps=read` / `--mode ro` 的极简解析（够用即可）。 */
export function parseArgs(argv = []) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      // `--mode ro` 与 `--mode=ro` 都要认。
      // 只认 `=` 形式时 `--mode ro` 会把 `ro` 变成位置参数 —— 于是 `ro` 被当成路径，
      // 而 `flags.mode` 恒为 true，模式静默退回 `rw`。这类"解析器吞掉一个值"的 bug
      // 不会报错，只会让用户以为自己设了只读、其实没有。
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[body] = next;
        i += 1;
      } else {
        flags[body] = true;
      }
    } else {
      positional.push(token);
    }
  }
  const [command = 'help', ...rest] = positional;
  return { command, positional: rest, flags };
}

function splitCaps(value) {
  if (value === undefined || value === true) return undefined;
  const list = String(value)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return list.length === 0 ? undefined : list;
}

/**
 * 从 profile 的 cordis.patch.yml 文本里尽力挖出 additionalWritableRoots。
 * 这是**扫描**不是解析：只认 `additionalWritableRoots:` 之后缩进的 `- 路径` 行。
 * 挖不到就返回 `{found:false}` —— 让调用方说"看不到"，而不是假装"是空的"。
 */
export function scanAdditionalRoots(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*additionalWritableRoots\s*:/.test(line));
  if (start === -1) return { found: false, roots: [] };
  const inline = lines[start].split(':').slice(1).join(':').trim();
  if (inline.startsWith('[') && inline.endsWith(']')) {
    const inner = inline.slice(1, -1).trim();
    const roots = inner === '' ? [] : inner.split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, ''));
    return { found: true, roots };
  }
  const indent = (lines[start].match(/^\s*/) ?? [''])[0].length;
  const roots = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const lineIndent = (line.match(/^\s*/) ?? [''])[0].length;
    if (lineIndent <= indent) break; // 回到同一层级 → 这一段结束了
    const match = line.match(/^\s*-\s*(.+?)\s*$/);
    if (match) roots.push(match[1].replace(/^['"]|['"]$/g, ''));
  }
  return { found: true, roots };
}

export function createCli(options = {}) {
  const platform = options.platform ?? process.platform;
  const fs = options.fs ?? REAL_FS;
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const rootFile = options.rootFile ?? join(workspaceRoot, CLI_DEFAULT_FILE);
  const profilePatch = options.profilePatch;

  function readDoc() {
    try {
      const text = fs.readFileSync(rootFile, 'utf8');
      return normalizeDoc(JSON.parse(text), platform);
    } catch (error) {
      if (error && error.code === 'ENOENT') return normalizeDoc({ version: DOC_VERSION }, platform);
      throw error;
    }
  }

  function writeDoc(doc) {
    const dir = dirname(rootFile);
    if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(rootFile, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  }

  function ok(code, lines, data) {
    return { ok: true, code, lines, data };
  }
  function bad(code, lines, data) {
    return { ok: false, code, lines, data };
  }

  function describeRoot(root) {
    const caps = [...root.capabilities].join('/');
    const bits = [`${root.path}`, `[${caps}]`];
    if (root.mode === 'ro') bits.push('只读');
    if (root.expiresAt) bits.push(`到 ${root.expiresAt}`);
    if (root.exclude.length) bits.push(`排除 ${root.exclude.length} 条`);
    return bits.join(' ');
  }

  function cmdList() {
    const doc = readDoc();
    if (doc.roots.length === 0) return ok('OK', ['还没有登记任何额外根。用 `add <路径>` 加一个。']);
    const lines = [doc.roots.map((root) => `- ${describeRoot(root)}`).join('\n')];
    lines.push(`shell: ${doc.shell.mode}${doc.shell.allowlist.length ? `（白名单 ${doc.shell.allowlist.length} 条）` : ''}`);
    lines.push(`敏感名单: ${doc.sensitive.deny.length} 条`);
    return ok('OK', lines, doc);
  }

  function cmdAdd(pathArg, flags) {
    if (!pathArg) return bad('PATH_MISSING_ARG', ['add 需要一个绝对路径']);
    const doc = readDoc();
    // 同路径判定统一走 normalizeKey（大小写 / 尾斜杠归一）。
    // 不归一就会出现：`D:\work\a\` 与 `D:\work\a` 被 checkRoot 当成"已被覆盖/重复"而拒绝，
    // 用户只是想"再加一次（顺便补个能力位）"，却收到一条看不懂的拒绝。
    const keyOfPath = (value) => {
      try {
        return normalizeKey(value, platform);
      } catch {
        return undefined;
      }
    };
    const targetKey = keyOfPath(pathArg);
    const checked = checkRoot({
      target: pathArg,
      // 同路径的旧登记必须从"已有根"里摘掉：add 同一个根的正确语义是**合并能力位**。
      existingRoots: doc.roots.map((root) => root.path).filter((value) => keyOfPath(value) !== targetKey),
      workspaceRoot,
      platform,
      fs,
    });
    if (checked.code === 'PATH_INSIDE_WORKSPACE') {
      return ok('PATH_INSIDE_WORKSPACE', [`${checked.path} 在当前工作区里，不需要额外添加。`]);
    }
    if (!checked.ok) return bad(checked.code, [checked.message]);
    const entry = {
      path: checked.path,
      capabilities: splitCaps(flags.caps) ?? [...ALL_CAPS],
      mode: flags.mode === 'ro' ? 'ro' : 'rw',
      expiresAt: typeof flags.expires === 'string' ? flags.expires : undefined,
      note: typeof flags.note === 'string' ? flags.note : undefined,
    };
    const normalized = normalizeRoot(entry, platform);
    const index = doc.roots.findIndex((root) => keyOfPath(root.path) === targetKey);
    const nextRoots = [...doc.roots];
    if (index === -1) nextRoots.push(normalized);
    else {
      const old = nextRoots[index];
      nextRoots[index] = {
        ...old,
        capabilities: [...new Set([...old.capabilities, ...normalized.capabilities])],
        mode: normalized.mode === 'ro' ? 'ro' : old.mode,
      };
    }
    writeDoc(normalizeDoc({ ...doc, roots: nextRoots }, platform));
    return ok(index === -1 ? 'ADDED' : 'UPDATED', [
      `${index === -1 ? '已添加' : '已合并'}：${describeRoot(nextRoots[index === -1 ? nextRoots.length - 1 : index])}`,
      '注意：这一步只改本地规则文件；要真正生效还得 `sync` + 装进 DSH。',
    ]);
  }

  function cmdRemove(pathArg) {
    if (!pathArg) return bad('PATH_MISSING_ARG', ['remove 需要一个绝对路径']);
    const doc = readDoc();
    const index = doc.roots.findIndex((root) => root.path.toLowerCase() === String(pathArg).toLowerCase());
    if (index === -1) return bad('NOT_FOUND', [`没有登记过 ${pathArg}`]);
    const next = doc.roots.filter((_, i) => i !== index);
    writeDoc(normalizeDoc({ ...doc, roots: next }, platform));
    return ok('REMOVED', [`已移除 ${pathArg}`, '已解析的权限与已在跑的进程不会因此改变；要收窄得重启。']);
  }

  function cmdValidate(pathArg) {
    if (!pathArg) return bad('PATH_MISSING_ARG', ['validate 需要一个绝对路径']);
    const doc = readDoc();
    const checked = checkRoot({
      target: pathArg,
      existingRoots: doc.roots.map((root) => root.path),
      workspaceRoot,
      platform,
      fs,
    });
    return checked.ok
      ? ok(checked.code, [`可以加：${checked.path}`, ...checked.warnings.map((w) => `注意：${w}`)])
      : bad(checked.code, [checked.message]);
  }

  function cmdProbe(pathArg) {
    const target = pathArg ?? workspaceRoot;
    const name = `.dsh-probe-${Date.now()}-${(fs.randomBytes ?? randomBytes)(3).toString('hex')}.tmp`;
    const file = join(target, name);
    try {
      fs.writeFileSync(file, 'probe', { flag: 'wx' });
    } catch (error) {
      return bad('PROBE_DENIED', [`写不进 ${target}：${String(error?.message ?? error)}`, '这说明这一层（进程/沙箱）不认这个目录的写权限。']);
    }
    try {
      fs.unlinkSync(file);
    } catch (error) {
      return ok('PROBE_WRITABLE_CLEANUP_FAILED', [`能写入 ${target}，但临时文件删不掉：${String(error?.message ?? error)}`]);
    }
    return ok('PROBE_WRITABLE', [`能写入 ${target}（已清理临时文件）。这只是当前进程的写权限，不等于 DSH 子进程也认。`]);
  }

  function cmdDiff() {
    if (!profilePatch) return bad('NO_PROFILE_PATH', ['没有给 profile patch 的路径，无法对比。']);
    let text;
    try {
      text = fs.readFileSync(profilePatch, 'utf8');
    } catch (error) {
      return bad('PROFILE_UNREADABLE', [`读不到 ${profilePatch}：${String(error?.message ?? error)}`]);
    }
    const scanned = scanAdditionalRoots(text);
    if (!scanned.found) {
      return ok('PROFILE_NO_KEY', [
        `在 ${profilePatch} 里没有找到 additionalWritableRoots 这一段。`,
        '这不是错误：意味着 DSH 侧现在只有工作区根，没有任何额外根。',
      ]);
    }
    const doc = readDoc();
    const desired = planAuthorization(doc, platform);
    const diff = diffAuthorization(desired.roots, scanned.roots, platform);
    const lines = [
      `profile 里现有 ${scanned.roots.length} 个额外根；规则里有 ${desired.roots.length} 个可授权根。`,
      diff.missing.length ? `缺（规则有、profile 没有）：${diff.missing.join(', ')}` : '缺：无',
      diff.extra.length ? `多（profile 有、规则没有）：${diff.extra.join(', ')}` : '多：无',
      '注意：这是逐行扫描的结果，不是 YAML 解析；复杂写法（锚点/多行块）可能扫不到。',
    ];
    return ok(diff.missing.length === 0 && diff.extra.length === 0 ? 'IN_SYNC' : 'DRIFT', lines, { diff, desired, actual: scanned.roots });
  }

  function cmdStatus() {
    const doc = readDoc();
    const compiled = compileDoc(doc, platform);
    const summary = summarize(compiled);
    return ok('OK', [
      `根 ${summary.roots} 个；敏感名单 ${doc.sensitive.deny.length} 条；shell=${doc.shell.mode}`,
      '记住两条：Windows 上 pwsh/bash 子进程不认额外根；读本来就不围栏，只有写被管。',
    ], { summary, doc });
  }

  function cmdHelp() {
    return ok('OK', [
      '用法：node bin/mw.mjs <命令> [参数]',
      '  list                       看本地规则文件里登记了什么',
      '  status                     一句话概括当前规则',
      '  add <绝对路径> [--caps read,write,delete,move] [--mode ro] [--expires 2026-12-31T00:00:00Z]',
      '  remove <绝对路径>',
      '  validate <绝对路径>        只校验，不改文件',
      '  probe [目录]               真写一个临时文件再删，验证当前进程能不能写',
      '  diff                       与 profile 的 additionalWritableRoots 对比（只读那一份配置）',
      '  help',
      '',
      '规则文件：' + rootFile + '（只影响本地，写入 profile 需要用户批准）',
    ]);
  }

  function run(argv = []) {
    const { command, positional, flags } = parseArgs(argv);
    try {
      switch (command) {
        case 'list': return cmdList();
        case 'status': return cmdStatus();
        case 'add': return cmdAdd(positional[0], flags);
        case 'remove': return cmdRemove(positional[0]);
        case 'validate': return cmdValidate(positional[0]);
        case 'probe': return cmdProbe(positional[0]);
        case 'diff': return cmdDiff();
        case 'help':
        case '--help':
        case '-h': return cmdHelp();
        default: return bad('UNKNOWN_COMMAND', [`不认识的命令：${command}。用 help 看能做什么。`]);
      }
    } catch (error) {
      return bad('CLI_ERROR', [String(error?.message ?? error)]);
    }
  }

  /** 让 `resolve` 也能被 CLI 复用（给"这个调用会不会被拒"的问题用）。 */
  function explain(name, args) {
    const doc = readDoc();
    return resolve({ name, args, doc, platform, mode: 'workspace-write', enforceRead: false });
  }

  return { rootFile, profilePatch, run, explain, readDoc };
}

export { CAP };
