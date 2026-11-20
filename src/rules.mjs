/**
 * rules.mjs —— 自由规则引擎（V2 的核心）。
 *
 * 它只做一件事：**拿"这次工具调用"去对一套规则，回答"准不准"**。
 * 不读写配置、不碰沙箱、不联网，所以能被纯函数测试锁住。
 *
 * 与平台的关系（这是最容易误解的一点）：
 *   - 平台（DSH 内核）只认「哪些根可写」，没有"单个文件能不能删"这种概念；
 *   - 这里的规则是**本项目自己的想法**，靠 `ctx.tools.guard()` 在工具层执行；
 *   - 所以规则比平台细，但它挡不住 shell、也挡不住绕过 guard 的原生写入。
 *
 * 判定顺序（写死在 resolve 里，顺序变了就是行为变了）：
 *   1. 不认识的工具 → 放行（不干预）
 *   2. shell 类工具 → 按 shell.mode 判（默认 deny）
 *   3. 抽路径，抽不到 → 放行
 *   4. 全局 read-only 模式 → 非读一律拒 READ_ONLY_MODE
 *   5. 敏感名单 → 拒 SENSITIVE_DENIED（**先于**根匹配，因为根里也可能有秘密）
 *   6. 最长前缀找根 → 找不到 PATH_OUTSIDE_SCOPE
 *   7. 过期 GRANT_EXPIRED → exclude EXCLUDED_PATH → include 不含 NOT_INCLUDED → ro READ_ONLY_ROOT → 能力 CAPABILITY_DENIED
 */

import {
  canonical,
  keyOf,
  withinOf,
  relativeTo,
  matchesAnyGlob,
  extractPaths,
} from './paths.mjs';

export const CAP = Object.freeze({
  READ: 'read',
  WRITE: 'write',
  DELETE: 'delete',
  MOVE: 'move',
});

export const ALL_CAPS = Object.freeze([CAP.READ, CAP.WRITE, CAP.DELETE, CAP.MOVE]);

export const RULE_CODE = Object.freeze({
  OK: 'OK',
  SENSITIVE_DENIED: 'SENSITIVE_DENIED',
  PATH_OUTSIDE_SCOPE: 'PATH_OUTSIDE_SCOPE',
  CAPABILITY_DENIED: 'CAPABILITY_DENIED',
  READ_ONLY_ROOT: 'READ_ONLY_ROOT',
  EXCLUDED_PATH: 'EXCLUDED_PATH',
  NOT_INCLUDED: 'NOT_INCLUDED',
  GRANT_EXPIRED: 'GRANT_EXPIRED',
  SHELL_UNCONTROLLED: 'SHELL_UNCONTROLLED',
  READ_ONLY_MODE: 'READ_ONLY_MODE',
  BAD_RULE: 'BAD_RULE',
  // store.mjs 里一直在用 `${RULE_CODE.BAD_DOC}` 前缀拼错因，但这里从来没定义过它
  // → 实际错误信息是 "undefined: 规则文档必须是对象"，既看不出是哪一类错、也没法被 /BAD_DOC/ 判据抓到。
  BAD_DOC: 'BAD_DOC',
});

/** 默认敏感名单：**先于**根规则生效，所以在任何根里都拦得住。 */
export const DEFAULT_SENSITIVE = Object.freeze([
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa',
  'id_ed25519',
  'credentials.json',
  '.git/config',
  '.ssh/**',
  '.dsh/**',
  '.aws/credentials',
  '.npmrc',
  '.pypirc',
]);

/**
 * 工具 → 参数里的路径字段 + 需要的能力。
 * **显式表，不靠猜**：猜错一个字段名就是既漏判（放行）又误判（拦无关调用）。
 */
export const TOOL_SPECS = new Map([
  // —— 读 ——
  ['read', { cap: CAP.READ, paths: ['file_path'] }],
  ['glob', { cap: CAP.READ, paths: ['path'] }],
  ['grep', { cap: CAP.READ, paths: ['path'] }],
  ['ops_inspect_local_file', { cap: CAP.READ, paths: ['path'] }],
  ['ops_glob', { cap: CAP.READ, paths: ['path'] }],
  ['ops_grep', { cap: CAP.READ, paths: ['path'] }],
  ['ops_read_files', { cap: CAP.READ, paths: ['files[].path'] }],
  ['ops_read_table', { cap: CAP.READ, paths: ['path'] }],
  ['ops_read_docx', { cap: CAP.READ, paths: ['path'] }],
  ['ops_read_pdf', { cap: CAP.READ, paths: ['path'] }],
  ['word_read', { cap: CAP.READ, paths: ['path'] }],
  ['ppt_read', { cap: CAP.READ, paths: ['path'] }],
  ['excel_read', { cap: CAP.READ, paths: ['path'] }],

  // —— 写 ——
  ['write', { cap: CAP.WRITE, paths: ['file_path'] }],
  ['edit', { cap: CAP.WRITE, paths: ['file_path'] }],
  ['ops_write_file', { cap: CAP.WRITE, paths: ['path'] }],
  ['ops_edit_file', { cap: CAP.WRITE, paths: ['path'] }],
  ['ops_replace', { cap: CAP.WRITE, paths: ['path'] }],
  ['word_create', { cap: CAP.WRITE, paths: ['path'] }],
  ['word_update', { cap: CAP.WRITE, paths: ['path'] }],
  ['excel_create', { cap: CAP.WRITE, paths: ['path'] }],
  ['excel_update', { cap: CAP.WRITE, paths: ['path'] }],
  ['ppt_create', { cap: CAP.WRITE, paths: ['path'] }],
  ['office_convert', { cap: CAP.WRITE, paths: ['input'] }],
  ['office_recalculate', { cap: CAP.WRITE, paths: ['input'] }],

  // —— 删 / 移 ——
  ['ops_remove', { cap: CAP.DELETE, paths: ['path'] }],
  ['ops_move', { cap: CAP.MOVE, paths: ['path', 'to'] }],
  ['ops_copy', { cap: CAP.MOVE, paths: ['path', 'to'] }],
]);

/** 命令类工具：默认一律拒（命令是一整条字符串，路径藏在里面，没法安全解析）。 */
export const SHELL_TOOLS = Object.freeze(['pwsh', 'bash', 'ops_bash', 'python', 'node']);

/** 把一条根规则规范化成内部形状。接受 `capabilities` 或 `caps`，允许字符串=四能力全给。 */
export function normalizeRoot(entry, platform = process.platform) {
  if (typeof entry === 'string') {
    const allCaps = new Set(ALL_CAPS);
    return {
      path: entry,
      key: keyOf(entry, platform),
      caps: allCaps,
      // 同一份 Set 暴露两个名字：V1 的 normalizeRules 用 `capabilities`，V2 内部用 `caps`。
      // 只留一个名字就会让调用方静默拿到 undefined —— 那等于"这个根没有任何能力"。
      capabilities: allCaps,
      mode: 'rw',
      include: [],
      exclude: [],
      expiresAt: null,
      note: '',
    };
  }
  if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' || entry.path.length === 0) {
    throw new TypeError(`${RULE_CODE.BAD_RULE}: 根规则必须有非空的 path`);
  }
  const rawCaps = entry.caps ?? entry.capabilities ?? ALL_CAPS;
  const capsList = rawCaps instanceof Set ? [...rawCaps] : Array.isArray(rawCaps) ? rawCaps : [rawCaps];
  const caps = new Set(capsList.filter((c) => ALL_CAPS.includes(c)));
  return {
    path: entry.path,
    key: keyOf(entry.path, platform),
    caps,
    capabilities: caps,
    mode: entry.mode === 'ro' ? 'ro' : 'rw',
    include: Array.isArray(entry.include) ? [...entry.include] : [],
    exclude: Array.isArray(entry.exclude) ? [...entry.exclude] : [],
    expiresAt: typeof entry.expiresAt === 'number' ? entry.expiresAt : null,
    note: typeof entry.note === 'string' ? entry.note : '',
  };
}

/** 把「规则文档」编译成判定时用的形状。坏规则直接抛，不静默跳过。 */
export function compileDoc(input, platform = process.platform) {
  const doc = input && typeof input === 'object' ? input : {};
  const rawRoots = Array.isArray(doc.roots) ? doc.roots : [];
  const roots = rawRoots.map((r) => normalizeRoot(r, platform));
  // 最长前缀优先：路径更长的排前面；同长时按 key 排序保证确定性
  roots.sort((a, b) => b.key.length - a.key.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    __compiled: true,
    platform,
    roots,
    shell: {
      mode: doc.shell && doc.shell.mode === 'allowlist' ? 'allowlist' : 'deny',
      allowlist: Array.isArray(doc.shell?.allowlist) ? [...doc.shell.allowlist] : [],
    },
    sensitive: {
      deny: Array.isArray(doc.sensitive?.deny) ? [...doc.sensitive.deny] : [...DEFAULT_SENSITIVE],
    },
    audit: {
      enabled: doc.audit?.enabled !== false,
      file: typeof doc.audit?.file === 'string' ? doc.audit.file : null,
    },
    note: typeof doc.note === 'string' ? doc.note : '',
  };
}

/** 一个路径的全部"候选串"：basename、每一段开始的尾巴、以及相对根的路径。 */
function candidateStrings(target, root, platform) {
  const full = canonical(target, platform).replace(/\\/g, '/');
  const out = [full];
  const segs = full.split('/');
  for (let i = 1; i < segs.length; i += 1) out.push(segs.slice(i).join('/'));
  if (segs.length > 0) out.push(segs[segs.length - 1]);
  if (root) out.push(relativeTo(target, root.path, platform));
  return out;
}

function isSensitive(target, root, patterns, platform) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  return matchesAnyGlob(patterns, candidateStrings(target, root, platform));
}

function denial(code, message, extra = {}) {
  return { denial: message, code, ...extra };
}

/**
 * 核心判定。
 * @param {object} req
 * @param {string} req.name        工具名
 * @param {unknown} req.args       工具参数
 * @param {object} req.doc         规则文档（或 compileDoc 的产物）
 * @param {string} [req.platform]
 * @param {string} [req.mode]      'read-only' | 'workspace-write' | 'danger-full-access'
 * @param {boolean} [req.enforceRead] 是否连读也管（默认 false：读本来就不被平台围栏）
 * @param {number} [req.now]       判定时刻（毫秒），测试可注入
 * @returns {{denial?: string, code?: string, cap?: string, path?: string, rule?: object}}
 */
export function resolve(req) {
  const {
    name,
    args,
    platform = process.platform,
    mode = 'workspace-write',
    enforceRead = false,
    now = Date.now(),
  } = req || {};
  const doc = req?.doc?.__compiled ? req.doc : compileDoc(req?.doc, platform);

  // 1) 不认识的工具：不干预（宁可漏管，也不误伤别的插件）
  const shellish = SHELL_TOOLS.includes(name);
  if (!shellish && !TOOL_SPECS.has(name)) return {};

  // 2) shell：默认拒；allowlist 只认**命令全等**（前缀匹配会被 `git status && del x` 绕过）
  if (shellish) {
    // allowShell 是插件配置里的总闸：打开就是「整个 shell 放行」，不再看规则文档的 shell.mode。
    if (req?.allowShell === true) return {};
    if (doc.shell.mode !== 'allowlist') {
      return denial(
        RULE_CODE.SHELL_UNCONTROLLED,
        `「${name}」是命令类工具，规则里默认不放开：命令字符串里的路径没法安全解析。两个放行口子：① 插件配置 allowShell: true（整个 shell 放行，围栏只剩文件工具）；② 规则文档 shell.mode: allowlist 里逐条写完整命令（只认命令全等，前缀匹配会被 \`git status && del x\` 绕过）。`,
      );
    }
    const cmd = typeof args?.command === 'string' ? args.command.trim() : '';
    if (cmd && doc.shell.allowlist.some((entry) => entry.trim() === cmd)) return {};
    return denial(
      RULE_CODE.SHELL_UNCONTROLLED,
      `「${name}」这条命令不在 allowlist 里（只支持完整命令等值匹配）：${cmd || '(空命令)'}`,
    );
  }

  const spec = TOOL_SPECS.get(name);
  const cap = spec.cap;

  // 3) 抽路径；抽不到就不干预
  const targets = extractPaths(args, spec.paths, platform);
  if (targets.length === 0) return {};

  // 4) 全局只读模式
  if (mode === 'read-only' && cap !== CAP.READ) {
    return denial(RULE_CODE.READ_ONLY_MODE, `当前是 read-only 模式，「${name}」需要 ${cap} 权限。`, { cap });
  }

  // 读默认不管（平台本来就不围栏读）
  if (cap === CAP.READ && enforceRead !== true) return {};

  // 根一个都没登记 = 这个插件还没被配置过，此时**不做围栏**。
  // 反过来（空根就全拒）会让"装上插件"等于"把整个 Agent 的写权限关掉"，
  // 用户连面板都打不开、连规则都改不了 —— 围栏必须先从内部能推开。
  if (doc.roots.length === 0) return {};

  for (const target of targets) {
    // 5) 敏感名单优先于根匹配
    if (isSensitive(target, null, doc.sensitive.deny, platform)) {
      return denial(
        RULE_CODE.SENSITIVE_DENIED,
        `「${target}」命中敏感文件名单（凭据/密钥类），即使在允许的根里也不放行。`,
        { cap, path: target },
      );
    }

    // 6) 最长前缀找根（roots 已按长度降序）
    const rule = doc.roots.find((r) => withinOf(target, r.path, platform) || keyOf(target, platform) === r.key);
    if (!rule) {
      return denial(
        RULE_CODE.PATH_OUTSIDE_SCOPE,
        `「${target}」不在已授权范围内（也没有任何已登记的活动范围覆盖它）。要用它，先加一个根（或把它挪进已有根）。`,
        { cap, path: target },
      );
    }

    // 7) 根内细分规则
    if (rule.expiresAt !== null && now > rule.expiresAt) {
      return denial(
        RULE_CODE.GRANT_EXPIRED,
        `「${rule.path}」是一条限时授权，已在 ${new Date(rule.expiresAt).toISOString()} 过期。`,
        { cap, path: target, rule },
      );
    }
    const rel = relativeTo(target, rule.path, platform);
    // exclude 用"全部候选串"匹配：`*.log` 要能命中 `app/run.log` 这种带子目录的路径，
    // 只拿相对路径去比会因为中间有 `/` 而永远失配（第一版就是这么错的）。
    if (rule.exclude.length > 0 && matchesAnyGlob(rule.exclude, candidateStrings(target, rule, platform))) {
      return denial(RULE_CODE.EXCLUDED_PATH, `「${target}」被这个根的 exclude 规则排除（${rule.exclude.join(', ')}）。`, {
        cap,
        path: target,
        rule,
      });
    }
    if (rule.include.length > 0 && cap !== CAP.READ && !matchesAnyGlob(rule.include, [rel])) {
      return denial(
        RULE_CODE.NOT_INCLUDED,
        `「${target}」不在这个根允许改动的子集里（include: ${rule.include.join(', ')}）。`,
        { cap, path: target, rule },
      );
    }
    if (rule.mode === 'ro' && cap !== CAP.READ) {
      return denial(RULE_CODE.READ_ONLY_ROOT, `「${rule.path}」登记为只读根，不能 ${cap}。`, { cap, path: target, rule });
    }
    if (!rule.caps.has(cap)) {
      return denial(
        RULE_CODE.CAPABILITY_DENIED,
        `「${rule.path}」没有给 ${cap} 权限（现有：${[...rule.caps].join('/') || '无'}）。`,
        { cap, path: target, rule },
      );
    }
  }

  return {};
}

/** 给面板/汇报用的一句话摘要。 */
export function summarize(doc, options = {}) {
  const d = doc?.__compiled ? doc : compileDoc(doc);
  const lines = d.roots.map((r) => {
    const caps = [...r.caps].join('/') || '无';
    const extra = [r.mode === 'ro' ? '只读' : null, r.expiresAt ? '限时' : null, r.exclude.length ? `排除${r.exclude.length}条` : null]
      .filter(Boolean)
      .join('，');
    return `- ${r.path}：${caps}${extra ? `（${extra}）` : ''}`;
  });
  // allowShell 是插件配置里的总闸，规则文档看不见它；摘要必须接受它，
  // 否则「shell 明明整体放行」时摘要还写「一律拒绝」（同一个谎话在第三个出口）。
  const shellLine =
    options.allowShell === true
      ? 'shell：整体放行（插件配置 allowShell: true）'
      : `shell：${d.shell.mode === 'allowlist' ? `白名单 ${d.shell.allowlist.length} 条` : '一律拒绝'}`;
  return [
    `活动范围 ${d.roots.length} 个：`,
    ...(lines.length ? lines : ['- （空）']),
    shellLine,
    `敏感名单：${d.sensitive.deny.length} 条`,
    `审计：${d.audit.enabled ? '开' : '关'}`,
  ].join('\n');
}
