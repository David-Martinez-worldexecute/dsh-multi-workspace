/**
 * store.mjs —— 规则文档（本项目拥有的那一层）与「授权层」的同步计划。
 *
 * 三层结构，它站在中间：
 *   ① **规则层**（本项目拥有）：profile 里 `multi-workspace` 这一行的 config，
 *      描述"哪些根、每个根给哪些能力、哪些子路径排除、什么时候过期"。
 *   ② **授权层**（DSH 拥有）：`additionalWritableRoots`，只有它能真正让 DSH 允许写。
 *   ③ **执行层**（DSH 沙箱）：不改。
 *
 * 为什么不用自己拼 YAML：profile 的 patch 是"**整行 config 替换、不合并**"，
 * 而且里面可能有别人的注释和 `!!js` 表达式。手拼 YAML 迟早把人家的东西吃掉。
 * 所以落盘一律走 `ctx.configEditor.edit()`（原子写 + 写前校验 + 保留注释）。
 *
 * 这个文件里**没有文件 IO**，只有（可注入的）configEditor。
 * 这样规则逻辑与"怎么写到磁盘上"解耦，测试不需要真 profile。
 */

import { ALL_CAPS, CAP, DEFAULT_SENSITIVE, RULE_CODE, normalizeRoot } from './rules.mjs';
import { canonical, keyOf, samePathOf } from './paths.mjs';

export const STORE_CODE = Object.freeze({
  OK: 'OK',
  ADDED: 'ADDED',
  UPDATED: 'UPDATED',
  REMOVED: 'REMOVED',
  NOT_FOUND: 'NOT_FOUND',
  BAD_DOC: 'BAD_DOC',
  EDIT_FAILED: 'EDIT_FAILED',
  EDIT_OVERRIDDEN: 'EDIT_OVERRIDDEN',
  VERIFY_FAILED: 'VERIFY_FAILED',
  DRY_RUN: 'DRY_RUN',
  POLICY_ROW_UNAVAILABLE: 'POLICY_ROW_UNAVAILABLE',
  NOTHING_TO_UNDO: 'NOTHING_TO_UNDO',
});

/** 规则文档版本：以后改形状时要能识别旧文档。 */
export const DOC_VERSION = 2;
/** 本项目的行 id（profile patch 里那一行）。 */
// 配置行的 id 必须和 `cordis.patch.yml` 里的 `id:` 一致，否则 configEditor.edit
// 会报 "Configuration entry is no longer available"（插件装了、根却永远存不下去）。
export const DEFAULT_ROW_ID = 'dsh-multi-workspace';
/** 授权层的行 id。注意：base patch 里未必有这一行，`edit` 会抛错 —— 由调用方决定怎么办。 */
export const DEFAULT_POLICY_ROW_ID = 'sandbox-policy';

export const DEFAULT_SHELL = Object.freeze({ mode: 'deny', allowlist: [] });
export const DEFAULT_AUDIT = Object.freeze({
  enabled: true,
  file: '.dsh/multi-workspace-audit.jsonl',
});

export function emptyDoc() {
  return {
    version: DOC_VERSION,
    roots: [],
    shell: { mode: DEFAULT_SHELL.mode, allowlist: [] },
    sensitive: { deny: [...DEFAULT_SENSITIVE] },
    audit: { ...DEFAULT_AUDIT },
  };
}

function asStringArray(value) {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string');
  // `rules.normalizeRoot()` 交出来的能力位是 **Set**，不是数组。
  // 少了这一支，Set 会被当成"没有能力位"→ 落盘成 `[]` → 看着像"这个根没权限"，
  // 而判定的另一端（rules）又按 Set 正常工作 —— 这种"两边都对、合起来错"最难查。
  if (value instanceof Set) return [...value].filter((item) => typeof item === 'string');
  return [];
}

function uniqueStrings(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = item;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function normalizeCapabilities(entry) {
  const raw = entry.capabilities ?? entry.caps;
  if (raw === undefined) return [...ALL_CAPS]; // 省事写法：不给能力 = 全给
  const list = asStringArray(raw).map((cap) => String(cap).toLowerCase());
  const bad = list.filter((cap) => !ALL_CAPS.includes(cap));
  if (bad.length > 0) {
    throw new Error(`${RULE_CODE.BAD_RULE}: 不认识的能力位 ${bad.join(', ')}（只接受 ${ALL_CAPS.join('/')}）`);
  }
  return uniqueStrings(list);
}

/** 把一条根登记项规整成文档里存的样子。 */
export function normalizeRootEntry(entry, platform = process.platform) {
  if (typeof entry === 'string') entry = { path: entry };
  if (entry === null || typeof entry !== 'object') {
    throw new Error(`${RULE_CODE.BAD_RULE}: 根条目必须是字符串或对象`);
  }
  const path = entry.path;
  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error(`${RULE_CODE.BAD_RULE}: 根条目缺少 path`);
  }
  const base = normalizeRoot({ path, capabilities: normalizeCapabilities(entry) }, platform);
  const mode = entry.mode === 'ro' ? 'ro' : 'rw';
  const expiresAt = typeof entry.expiresAt === 'string' && entry.expiresAt.trim() !== '' ? entry.expiresAt : undefined;
  return {
    path: base.path,
    key: base.key,
    capabilities: [...base.capabilities],
    mode,
    include: uniqueStrings(asStringArray(entry.include)),
    exclude: uniqueStrings(asStringArray(entry.exclude)),
    ...(expiresAt ? { expiresAt } : {}),
    ...(typeof entry.note === 'string' && entry.note.trim() !== '' ? { note: entry.note } : {}),
  };
}

/** 规整整份文档；坏掉就抛（调用方负责转成 BAD_DOC）。 */
export function normalizeDoc(input, platform = process.platform) {
  const src = input === undefined || input === null ? {} : input;
  if (typeof src !== 'object') throw new Error(`${RULE_CODE.BAD_DOC}: 规则文档必须是对象`);
  const roots = asStringArrayOrObjects(src.roots).map((entry) => normalizeRootEntry(entry, platform));
  const shellMode = src.shell?.mode === 'allowlist' ? 'allowlist' : 'deny';
  const deny = src.sensitive?.deny === undefined ? [...DEFAULT_SENSITIVE] : asStringArray(src.sensitive.deny);
  return {
    version: Number.isFinite(src.version) ? src.version : DOC_VERSION,
    roots,
    shell: { mode: shellMode, allowlist: uniqueStrings(asStringArray(src.shell?.allowlist)) },
    sensitive: { deny: uniqueStrings(deny) },
    audit: {
      enabled: src.audit?.enabled !== false,
      file: typeof src.audit?.file === 'string' && src.audit.file.trim() !== '' ? src.audit.file : DEFAULT_AUDIT.file,
    },
  };
}

function asStringArrayOrObjects(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${RULE_CODE.BAD_DOC}: roots 必须是数组`);
  return value;
}

/** 文档里去掉派生的 `key`，只留可持久化的字段。 */
export function serializableDoc(doc) {
  return {
    version: doc.version,
    roots: doc.roots.map((root) => {
      const out = { path: root.path, capabilities: [...root.capabilities] };
      if (root.mode === 'ro') out.mode = 'ro';
      if (root.include.length > 0) out.include = [...root.include];
      if (root.exclude.length > 0) out.exclude = [...root.exclude];
      if (root.expiresAt) out.expiresAt = root.expiresAt;
      if (root.note) out.note = root.note;
      return out;
    }),
    shell: { mode: doc.shell.mode, allowlist: [...doc.shell.allowlist] },
    sensitive: { deny: [...doc.sensitive.deny] },
    audit: { enabled: doc.audit.enabled, file: doc.audit.file },
  };
}

/** 稳定指纹：用来判断"有没有真的写进去"，而不是"我以为写进去了"。 */
export function docFingerprint(doc) {
  return JSON.stringify(serializableDoc(doc));
}

/** 导出成可序列化对象（不含派生字段 key）。 */
export function exportDoc(doc) {
  return serializableDoc(doc);
}

/** 导出成 JSON 文本（面板下载 / 用户备份用）。 */
export function exportJson(doc, space = 2) {
  return JSON.stringify(serializableDoc(doc), null, space);
}

/** 从 JSON 文本导入；语法错与结构错都抛 `BAD_DOC:` 前缀的错，调用方据此回 BAD_DOC。 */
export function importJson(text, platform = process.platform) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${RULE_CODE.BAD_DOC}: 不是合法 JSON（${String(err?.message ?? err)}）`);
  }
  return normalizeDoc(parsed, platform);
}

function findRootIndex(doc, target, platform) {
  const wanted = { path: target, key: keyOf(target, platform) };
  return doc.roots.findIndex((root) => samePathOf(root.path, wanted.path, platform));
}

/**
 * 加一个根；已存在就合并能力位与子规则（幂等）。
 * @returns {{code: string, doc: object, root?: object, message?: string}}
 */
export function upsertRoot(doc, entry, platform = process.platform) {
  const normalized = normalizeRootEntry(entry, platform);
  const index = findRootIndex(doc, normalized.path, platform);
  if (index === -1) {
    const next = { ...doc, roots: [...doc.roots, normalized] };
    return { code: STORE_CODE.ADDED, doc: next, root: normalized };
  }
  const existing = doc.roots[index];
  const merged = {
    ...existing,
    capabilities: uniqueStrings([...existing.capabilities, ...normalized.capabilities]),
    mode: normalized.mode === 'ro' && existing.mode !== 'ro' ? 'ro' : existing.mode,
    include: uniqueStrings([...existing.include, ...normalized.include]),
    exclude: uniqueStrings([...existing.exclude, ...normalized.exclude]),
    expiresAt: normalized.expiresAt ?? existing.expiresAt,
    note: normalized.note ?? existing.note,
  };
  const roots = [...doc.roots];
  roots[index] = merged;
  return { code: STORE_CODE.UPDATED, doc: { ...doc, roots }, root: merged };
}

/** 删一个根。 */
export function removeRoot(doc, target, platform = process.platform) {
  const index = findRootIndex(doc, target, platform);
  if (index === -1) {
    return { code: STORE_CODE.NOT_FOUND, doc, message: `没有登记过 ${target}` };
  }
  const roots = doc.roots.filter((_, i) => i !== index);
  return { code: STORE_CODE.REMOVED, doc: { ...doc, roots }, root: doc.roots[index] };
}

/** 改一个根（能力位/子规则/模式/过期时间）。path 指定改哪一个。 */
export function patchRoot(doc, target, patch = {}, platform = process.platform) {
  const index = findRootIndex(doc, target, platform);
  if (index === -1) return { code: STORE_CODE.NOT_FOUND, doc, message: `没有登记过 ${target}` };
  const current = doc.roots[index];
  const mergedEntry = {
    path: current.path,
    capabilities: patch.capabilities ?? patch.caps ?? current.capabilities,
    mode: patch.mode ?? current.mode,
    include: patch.include ?? current.include,
    exclude: patch.exclude ?? current.exclude,
    expiresAt: patch.expiresAt ?? current.expiresAt,
    note: patch.note ?? current.note,
  };
  // 显式清空过期时间：patch.expiresAt === null
  if (patch.expiresAt === null) delete mergedEntry.expiresAt;
  const normalized = normalizeRootEntry(mergedEntry, platform);
  const roots = [...doc.roots];
  roots[index] = normalized;
  return { code: STORE_CODE.UPDATED, doc: { ...doc, roots }, root: normalized };
}

/**
 * 从规则文档算出「授权层应该长什么样」。
 * 只有真正需要写的根才进授权层：`ro` 根、没有 write 能力的根都不进 ——
 * 授权层是"能写哪些目录"，把只读根塞进去是自相矛盾的。
 */
export function planAuthorization(doc, platform = process.platform) {
  const roots = [];
  const skipped = [];
  for (const root of doc.roots) {
    if (root.mode === 'ro') {
      skipped.push({ path: root.path, reason: 'mode=ro（只读根不进授权层）' });
      continue;
    }
    if (!root.capabilities.includes(CAP.WRITE)) {
      skipped.push({ path: root.path, reason: '没有 write 能力（进了授权层就等于给了写权限）' });
      continue;
    }
    if (root.expiresAt && Date.parse(root.expiresAt) <= Date.now()) {
      skipped.push({ path: root.path, reason: `已过期（${root.expiresAt}）` });
      continue;
    }
    roots.push(canonical(root.path, platform));
  }
  return { roots, skipped };
}

/** 对比"应该有的授权根"与"现在实际有的授权根"。 */
export function diffAuthorization(desired, actual = [], platform = process.platform) {
  const missing = desired.filter((path) => !actual.some((other) => samePathOf(path, other, platform)));
  const extra = actual.filter((path) => !desired.some((other) => samePathOf(path, other, platform)));
  return { missing, extra, matched: desired.length - missing.length };
}

/** 只取目录部分（不引 node:path：store 也要能在纯浏览器/测试上下文里跑）。 */
function dirnameOf(file) {
  const idx = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return idx > 0 ? file.slice(0, idx) : '';
}

/**
 * 造一个 store。
 *
 * `configEditor` 是 DSH 的 `ctx.configEditor`：`edit(entry, change)`。
 * `readConfig` 是可选的读入口（不同 DSH 版本读法不同，由 index.mjs 注入）；
 * 没有读入口时，store 就以构造时给的 `config` 为起点工作 —— 这样测试不需要真 profile。
 */
export function createStore(options = {}) {
  const platform = options.platform ?? process.platform;
  const rowId = options.rowId ?? DEFAULT_ROW_ID;
  const policyRowId = options.policyRowId ?? DEFAULT_POLICY_ROW_ID;
  // 这两个编辑器可能"后到"：Cordis 的服务要靠 ctx.inject 才会出现，
  // 而 store 是在 apply 里同步建好的。所以用 let + setEditors 允许之后补进来。
  let configEditor = options.configEditor;
  let policyEditor = options.policyEditor ?? options.configEditor;
  const readConfig = options.readConfig;
  // 文件兜底：DSH 有些版本里插件拿不到 configEditor（服务没注入），
  // 那时规则就没法落盘 —— 面板「加根」会永远 EDIT_FAILED，围栏也就永远配不起来。
  // 所以 store 也认一个 JSON 文件：configEditor 可用时写配置行，不可用时写文件。
  const rulesFile = typeof options.rulesFile === 'string' ? options.rulesFile : undefined;
  const fsx = options.fs;
  const canFileRead = !!rulesFile && !!fsx && typeof fsx.readFileSync === 'function';
  const canFileWrite = !!rulesFile && !!fsx && typeof fsx.writeFileSync === 'function';
  let doc = normalizeDoc(options.config ?? emptyDoc(), platform);
  const log = [];
  // 撤销栈：只放"改动前的整份文档"，最多 5 份，且**只在内存里**（DSH 重启即清空）。
  const undoStack = [];
  const UNDO_DEPTH = 5;

  function remember(before, label) {
    undoStack.push({ doc: before, at: new Date().toISOString(), label });
    if (undoStack.length > UNDO_DEPTH) undoStack.shift();
  }

  async function load() {
    if (typeof readConfig === 'function') {
      const current = await readConfig(rowId);
      if (current && typeof current === 'object') doc = normalizeDoc(current, platform);
      return doc;
    }
    if (canFileRead) {
      try {
        const parsed = JSON.parse(fsx.readFileSync(rulesFile, 'utf8'));
        if (parsed && typeof parsed === 'object') doc = normalizeDoc(parsed, platform);
      } catch {
        // 文件不存在 / 不是 JSON / 没有读权限：保持当前文档（首次运行就是默认值）。
      }
    }
    return doc;
  }

  /**
   * 文件兜底写：先写 `.tmp` 再 rename，避免半份 JSON 把规则读坏。
   * 返回 { ok, code, fingerprint } —— 调用方负责把 doc 与 log 落到内存里。
   */
  function writeRulesFile(normalized) {
    try {
      const dir = dirnameOf(rulesFile);
      if (dir && typeof fsx.mkdirSync === 'function') fsx.mkdirSync(dir, { recursive: true });
      const text = JSON.stringify(serializableDoc(normalized), null, 2);
      const tmp = `${rulesFile}.${process.pid}.tmp`;
      fsx.writeFileSync(tmp, text, 'utf8');
      if (typeof fsx.renameSync === 'function') fsx.renameSync(tmp, rulesFile);
      else fsx.writeFileSync(rulesFile, text, 'utf8');
      return { ok: true, code: STORE_CODE.OK, fingerprint: docFingerprint(normalized), via: 'file' };
    } catch (err) {
      return { ok: false, code: STORE_CODE.EDIT_FAILED, message: `写规则文件失败：${String(err?.message ?? err)}` };
    }
  }

  async function save(next) {
    const normalized = normalizeDoc(next, platform);
    if (!configEditor || typeof configEditor.edit !== 'function') {
      // 没有 configEditor：走文件兜底（有就写，没有才如实报 EDIT_FAILED）。
      if (!canFileWrite) {
        return { ok: false, code: STORE_CODE.EDIT_FAILED, message: '没有可用的 configEditor（需要 ctx.configEditor），也没有可写的规则文件' };
      }
      const fileResult = writeRulesFile(normalized);
      if (!fileResult.ok) return fileResult;
      doc = normalized;
      const entry = { at: new Date().toISOString(), action: 'save-file', fingerprint: docFingerprint(doc) };
      log.push(entry);
      return { ok: true, code: STORE_CODE.OK, fingerprint: entry.fingerprint, via: 'file' };
    }
    const payload = serializableDoc(normalized);
    try {
      await configEditor.edit({ id: rowId }, () => payload);
    } catch (err) {
      const message = String(err?.message ?? err);
      const overridden = /overridden by a home patch or command-line overlay/i.test(message);
      // 行 id 对不上（不同 DSH 版本 patch 行的 id 不一样）不算"保存失败"，
      // 这时降级写文件：用户点的「加根」必须真的生效，而不是看到一句 EDIT_FAILED。
      const missingEntry = /no longer available|not found|unknown entry|cannot find/i.test(message);
      if (!overridden && missingEntry && canFileWrite) {
        const fileResult = writeRulesFile(normalized);
        if (fileResult.ok) {
          doc = normalized;
          const entry = { at: new Date().toISOString(), action: 'save-file', fingerprint: fileResult.fingerprint };
          log.push(entry);
          return fileResult;
        }
      }
      return {
        ok: false,
        code: overridden ? STORE_CODE.EDIT_OVERRIDDEN : STORE_CODE.EDIT_FAILED,
        message,
      };
    }
    doc = normalized;
    const entry = { at: new Date().toISOString(), action: 'save', fingerprint: docFingerprint(doc) };
    log.push(entry);
    return { ok: true, code: STORE_CODE.OK, fingerprint: entry.fingerprint };
  }

  /** 任何一次变更都是"先算新文档 → 再写 → 再读回比对"三步。 */
  async function mutate(operation, label = 'change') {
    const result = operation(doc);
    if (!result || result.doc === undefined) return result;
    if (result.code === STORE_CODE.NOT_FOUND || result.code === STORE_CODE.BAD_DOC) return result;
    const beforeDoc = doc;
    const before = docFingerprint(doc);
    const saved = await save(result.doc);
    if (!saved.ok) return { ...result, ...saved, code: saved.code };
    // 写成功才压栈：失败的改动不该出现在"撤销"里，否则撤销会把用户带回一个从未生效的状态。
    remember(beforeDoc, label);
    // 读回比对：`edit` 成功不等于"文件里是我以为的内容"。
    if (typeof readConfig === 'function') {
      const reread = await readConfig(rowId);
      if (reread && typeof reread === 'object') {
        const actual = docFingerprint(normalizeDoc(reread, platform));
        if (actual !== saved.fingerprint) {
          return { ...result, ok: false, code: STORE_CODE.VERIFY_FAILED, message: '写后读回与预期不一致（可能被其它 patch 覆盖）' };
        }
      }
    }
    // `via` 要透出来：写进 profile 配置 和 写进兜底文件 是两件不同的事，
    // 界面上要能说清这次到底落在哪 —— 否则"保存成功"可能只是落在没人读的地方。
    return { ...result, ok: true, changed: saved.fingerprint !== before, via: saved.via };
  }

  return {
    get doc() {
      return doc;
    },
    log,
    /**
     * 迟到服务：Cordis 的 ctx.inject 是异步的，configEditor 可能在 store 建好之后才可用。
     * 补进来之后 save() 才真正能落盘；返回当前可用性，方便 status 报实情。
     */
    setEditors(next = {}) {
      const usable = (e) => !!e && typeof e.edit === 'function';
      if (usable(next.configEditor)) configEditor = next.configEditor;
      if (usable(next.policyEditor)) policyEditor = next.policyEditor;
      else if (usable(next.configEditor) && !options.policyEditor) policyEditor = next.configEditor;
      return { configEditor: usable(configEditor), policyEditor: usable(policyEditor) };
    },
    load,
    save,
    /**
     * 兜底文件到底能不能写。status 要拿它区分「真的没地方存」和
     * 「本机没有 configEditor，但规则确实落到 .dsh/multi-workspace-rules.json 了」——
     * 后者不是故障，不该出现在 problems 里吓人。
     */
    canFileWrite: () => canFileWrite,
    canFileRead: () => canFileRead,
    rulesFile,
    add: (entry) => mutate((current) => upsertRoot(current, entry, platform), 'add'),
    remove: (target) => mutate((current) => removeRoot(current, target, platform), 'remove'),
    update: (target, patch) => mutate((current) => patchRoot(current, target, patch, platform), 'update'),
    // 注意：mutate 要求 operation 返回 `{ doc, code }`，直接返回文档对象会被当成"没变"。
    replace: (nextDoc) => mutate(() => ({ doc: nextDoc, code: STORE_CODE.OK }), 'replace'),
    /** 还能撤销几步 —— 面板用它决定按钮要不要置灰。 */
    undoDepth: () => undoStack.length,
    /** 撤销最近一次写入；栈空返回 NOTHING_TO_UNDO。 */
    async undo() {
      const entry = undoStack.pop();
      if (!entry) {
        return {
          ok: false,
          code: STORE_CODE.NOTHING_TO_UNDO,
          message: '没有可撤销的改动（撤销栈只保留最近 5 次，DSH 重启后清空）',
        };
      }
      const saved = await save(entry.doc);
      if (!saved.ok) {
        // 写失败就把这一步还回去：不能让用户以为撤销成功了。
        undoStack.push(entry);
        return { ok: false, code: saved.code, message: saved.message };
      }
      log.push({ at: new Date().toISOString(), action: 'undo', label: entry.label, fingerprint: docFingerprint(doc) });
      return { ok: true, code: STORE_CODE.OK, undone: entry.label, doc };
    },
    exportJson: (space = 2) => exportJson(doc, space),
    /** 整份导入：先校验，再写；写失败不压栈。 */
    async importDoc(input) {
      let next;
      try {
        next = typeof input === 'string' ? importJson(input, platform) : normalizeDoc(input, platform);
      } catch (err) {
        return { ok: false, code: STORE_CODE.BAD_DOC, message: String(err?.message ?? err) };
      }
      const beforeDoc = doc;
      const saved = await save(next);
      if (!saved.ok) return { ok: false, code: saved.code, message: saved.message };
      remember(beforeDoc, 'import');
      return { ok: true, code: STORE_CODE.OK, doc };
    },
    plan: (actual) => {
      const desired = planAuthorization(doc, platform);
      return { desired, diff: diffAuthorization(desired.roots, actual ?? [], platform) };
    },
    /**
     * 把授权层改成与规则文档一致。
     * `actual` 必须由调用方给出（store 不读别人的 config，读错了会写坏别人那一行）。
     */
    async sync({ actual = [], dryRun = false } = {}) {
      const desired = planAuthorization(doc, platform);
      const diff = diffAuthorization(desired.roots, actual, platform);
      if (dryRun) {
        return { ok: true, code: STORE_CODE.DRY_RUN, desired, diff };
      }
      if (!policyEditor || typeof policyEditor.edit !== 'function') {
        return { ok: false, code: STORE_CODE.POLICY_ROW_UNAVAILABLE, desired, diff, message: '没有 policyEditor（需要 ctx.configEditor）' };
      }
      try {
        // 注意：patch 是整行替换，所以必须基于 current 展开，不能只写 additionalWritableRoots。
        await policyEditor.edit({ id: policyRowId }, (current) => ({
          ...(current && typeof current === 'object' ? current : {}),
          additionalWritableRoots: desired.roots,
        }));
      } catch (err) {
        const message = String(err?.message ?? err);
        const overridden = /overridden by a home patch or command-line overlay/i.test(message);
        return {
          ok: false,
          code: overridden ? STORE_CODE.EDIT_OVERRIDDEN : STORE_CODE.POLICY_ROW_UNAVAILABLE,
          desired,
          diff,
          message,
        };
      }
      return { ok: true, code: STORE_CODE.OK, desired, diff };
    },
  };
}
