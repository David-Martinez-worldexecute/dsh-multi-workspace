/**
 * tool.mjs —— 给模型用的唯一入口 `workspace_roots`。
 *
 * 为什么只给一个工具、用 action 分派：工具越多，模型越容易挑错那个；
 * 一个工具 + 明确的 action 列表，比十个近义工具好教也好查。
 *
 * 这个文件**不 import DSH 运行时**，只接受注入的依赖（store / audit / checkRoot 的 fs），
 * 所以它可以被单测直接调用，不需要真 profile、不需要真 DSH。
 *
 * 每个返回值都遵守同一形状：
 *   { ok, action, code, message, data?, note? }
 * 模型侧永远能拿到 `code`（机器可判）与 `message`（人话），两条都在。
 */

import { ALL_CAPS, CAP, summarize } from './rules.mjs';
import { STORE_CODE } from './store.mjs';
import { checkRoot } from './validate.mjs';
import { samePathOf } from './paths.mjs';
import { createAudit, summarizeArgs } from './audit.mjs';
import { canonical, keyOf } from './paths.mjs';

export const TOOL_NAME = 'workspace_roots';

/** 需要"真动手"的 action（会改文档或写盘）—— 这些要过审批。 */
export const MUTATING_ACTIONS = Object.freeze([
  'add',
  'remove',
  'update',
  'sync',
  'probe',
  'undo',
  'import',
  'session-add',
  'session-remove',
]);

export const ACTION_LIST = Object.freeze([
  'list',
  'status',
  'add',
  'remove',
  'update',
  'validate',
  'probe',
  'sync',
  'audit',
  'evaluate',
  'doctor',
  'undo',
  'export',
  'import',
  'session-list',
  'session-add',
  'session-remove',
]);

export const PARAMETERS = Object.freeze({
  type: 'object',
  properties: {
    action: { type: 'string', enum: ACTION_LIST, description: '要做什么' },
    path: {
      type: 'string',
      description: '根目录的绝对路径（add/remove/update/validate/probe 用）。Windows 例：D:\\work\\proj-a',
    },
    capabilities: {
      type: 'array',
      items: { type: 'string', enum: ALL_CAPS },
      description: '给哪些能力位（默认全给）。read=读 write=写 delete=删 move=移动/复制',
    },
    mode: { type: 'string', enum: ['rw', 'ro'], description: 'rw=可写 ro=只读根（不进授权层）' },
    include: { type: 'array', items: { type: 'string' }, description: '只允许这些 glob（非读操作）' },
    exclude: { type: 'array', items: { type: 'string' }, description: '排除这些 glob' },
    expiresAt: { type: 'string', description: 'ISO 时间；到点自动失效。传 null 表示清除' },
    note: { type: 'string', description: '备注，只给人看' },
    dryRun: { type: 'boolean', description: '只算不写（sync 用）' },
    actualRoots: {
      type: 'array',
      items: { type: 'string' },
      description: 'sync 时：授权层**现在**有哪些根（由调用方给出，工具不读别人的配置）',
    },
    limit: { type: 'integer', description: 'audit 取最近几条（默认 20）' },
    toolName: { type: 'string', description: 'evaluate：要试算的工具名（如 write）' },
    argsJson: { type: 'string', description: 'evaluate：该工具的参数 JSON 字符串（如 {"file_path":"D:\\x\\a.txt"}）' },
    json: { type: 'string', description: 'import：整份规则文档的 JSON 字符串' },
    sessionId: { type: 'string', description: '会话级临时根要挂到哪个会话；面板会自动带，模型调用需显式给' },
    ttlMinutes: { type: 'integer', description: '会话级临时根的存活分钟数（不填=到会话结束）' },
  },
  required: ['action'],
});

const NO_NOTE = '注意：Windows 上 `pwsh` / `bash` 起的子进程不认额外根，只有 DSH 文件工具（write/edit/patch/delete/move）认。';

function ok(action, code, message, data, note) {
  return { ok: true, action, code, message, data, ...(note ? { note } : {}) };
}

function fail(action, code, message, data) {
  return { ok: false, action, code, message, ...(data === undefined ? {} : { data }) };
}

/**
 * 造工具实现。
 *
 * @param {object} options
 * @param {object} options.store createStore() 的产物
 * @param {object} [options.audit] createAudit() 的产物
 * @param {object} [options.fs] node:fs（checkRoot 与 probe 用）
 * @param {string} [options.platform]
 * @param {string} [options.workspaceRoot] 当前会话工作区（用于"无需添加"的提示）
 * @param {(req: {action: string, message: string, path?: string}) => Promise<boolean>|boolean} [options.approve]
 * @param {boolean} [options.requireApproval] 默认 true
 * @param {string[]} [options.rootDenyList] 额外拒绝的目录（盘根、系统目录等，由 validate 里的 deny-list 负责主判定）
 */
export function createWorkspaceRootsTool(options = {}) {
  const store = options.store;
  const audit = options.audit ?? createAudit({ enabled: false });
  const fs = options.fs;
  const platform = options.platform ?? process.platform;
  const workspaceRoot = options.workspaceRoot;
  const requireApproval = options.requireApproval !== false;

  if (!store || typeof store.add !== 'function') {
    throw new Error('createWorkspaceRootsTool: 需要 createStore() 的产物');
  }

  async function gate(action, message, path) {
    if (!MUTATING_ACTIONS.includes(action)) return { allowed: true };
    if (!requireApproval) return { allowed: true };
    if (typeof options.approve !== 'function') {
      return {
        allowed: false,
        code: 'APPROVAL_UNAVAILABLE',
        message: '这个动作会改配置，但没有可用的审批入口（需要注入 approve）',
      };
    }
    let granted = false;
    try {
      granted = await options.approve({ action, message, path });
    } catch (err) {
      return { allowed: false, code: 'APPROVAL_DENIED', message: `审批通道报错：${String(err?.message ?? err)}` };
    }
    return granted ? { allowed: true } : { allowed: false, code: 'APPROVAL_DENIED', message: '用户没有批准这次改动' };
  }

  function docRoots() {
    return store.doc.roots.map((root) => ({
      path: root.path,
      capabilities: [...root.capabilities],
      mode: root.mode,
      ...(root.expiresAt ? { expiresAt: root.expiresAt } : {}),
      ...(root.include.length > 0 ? { include: [...root.include] } : {}),
      ...(root.exclude.length > 0 ? { exclude: [...root.exclude] } : {}),
      ...(root.note ? { note: root.note } : {}),
    }));
  }

  async function doList() {
    const summary = summarize(store.doc);
    return ok('list', STORE_CODE.OK, `登记了 ${summary.roots} 个根`, {
      roots: docRoots(),
      shell: store.doc.shell,
      sensitiveCount: store.doc.sensitive.deny.length,
      ...summary,
    }, NO_NOTE);
  }

  async function doStatus(actual) {
    const { desired, diff } = store.plan(actual);
    return ok(
      'status',
      diff.missing.length === 0 && diff.extra.length === 0 ? 'IN_SYNC' : 'DRIFT',
      diff.missing.length === 0 && diff.extra.length === 0
        ? `授权层已一致（${desired.roots.length} 个根）`
        : `授权层不一致：缺 ${diff.missing.length} 个、多 ${diff.extra.length} 个`,
      { desired, diff, skipped: desired.skipped },
      NO_NOTE,
    );
  }

  async function doAdd(args) {
    const rootPath = args.path;
    if (typeof rootPath !== 'string' || rootPath.trim() === '') {
      return fail('add', 'PATH_MISSING_ARG', 'add 需要 path（根目录的绝对路径）');
    }
    const checked = checkRoot({
      target: rootPath,
      // 同一路径的旧登记先摘掉：`add` 的语义是"合并/加能力位"（幂等，返回 UPDATED），
      // 而 checkRoot 判 DUPLICATE 是给 `validate` 用的"已登记过"。两者混在一起会让
      // "给已有根补一个 delete 能力"变成一条错误。
      existingRoots: store.doc.roots
        .filter((root) => !samePathOf(root.path, rootPath, platform))
        .map((root) => root.path),
      workspaceRoot,
      platform,
      fs,
    });
    // checkRoot 对"在工作区里"返回的是 ok:true + code=PATH_INSIDE_WORKSPACE：
    // 它不是错误，但也不是"加进去了"。所以必须先按 code 分流，再走 ok 分支。
    if (checked.code === 'PATH_INSIDE_WORKSPACE') {
      return ok('add', checked.code, checked.message ?? '这个路径已经在当前工作区里，不需要额外添加', { path: checked.path }, NO_NOTE);
    }
    if (!checked.ok) {
      return fail('add', checked.code, checked.message, { path: checked.path });
    }
    const approval = await gate('add', `把 ${checked.path} 加进活动范围（能力位：${(args.capabilities ?? ALL_CAPS).join('/')}）`, checked.path);
    if (!approval.allowed) return fail('add', approval.code, approval.message);
    const result = await store.add({
      path: checked.path,
      capabilities: args.capabilities,
      mode: args.mode,
      include: args.include,
      exclude: args.exclude,
      expiresAt: args.expiresAt,
      note: args.note,
    });
    if (!result.ok) return fail('add', result.code, result.message ?? '写入规则文档失败');
    audit.record({ tool: TOOL_NAME, code: result.code, path: checked.path, args: summarizeArgs(args) });
    return ok(
      'add',
      result.code,
      result.code === STORE_CODE.ADDED ? `已添加 ${checked.path}` : `已更新 ${checked.path}（合并能力位）`,
      { roots: docRoots(), warnings: checked.warnings ?? [] },
      `${NO_NOTE} 改的是规则文档；要让 DSH 真正允许写，还要 sync 到授权层并重载。`,
    );
  }

  async function doRemove(args) {
    if (typeof args.path !== 'string' || args.path.trim() === '') {
      return fail('remove', 'PATH_MISSING_ARG', 'remove 需要 path');
    }
    const approval = await gate('remove', `把 ${args.path} 从活动范围里移除`, args.path);
    if (!approval.allowed) return fail('remove', approval.code, approval.message);
    const result = await store.remove(args.path);
    if (!result.ok) return fail('remove', result.code, result.message ?? '移除失败');
    audit.record({ tool: TOOL_NAME, code: result.code, path: args.path });
    return ok('remove', result.code, `已移除 ${args.path}`, { roots: docRoots() }, NO_NOTE);
  }

  async function doUpdate(args) {
    if (typeof args.path !== 'string' || args.path.trim() === '') {
      return fail('update', 'PATH_MISSING_ARG', 'update 需要 path');
    }
    const approval = await gate('update', `改 ${args.path} 的能力位/子规则`, args.path);
    if (!approval.allowed) return fail('update', approval.code, approval.message);
    const result = await store.update(args.path, {
      capabilities: args.capabilities,
      mode: args.mode,
      include: args.include,
      exclude: args.exclude,
      expiresAt: args.expiresAt,
      note: args.note,
    });
    if (!result.ok) return fail('update', result.code, result.message ?? '更新失败');
    audit.record({ tool: TOOL_NAME, code: result.code, path: args.path });
    return ok('update', result.code, `已更新 ${args.path}`, { roots: docRoots() }, NO_NOTE);
  }

  async function doValidate(args) {
    const checked = checkRoot({
      target: args.path,
      existingRoots: store.doc.roots.map((root) => root.path),
      workspaceRoot,
      platform,
      fs,
    });
    return {
      ok: checked.ok,
      action: 'validate',
      code: checked.code,
      message: checked.message ?? (checked.ok ? '这个路径可以加' : '这个路径不能加'),
      data: { path: checked.path, key: checked.key, warnings: checked.warnings ?? [] },
    };
  }

  /**
   * 探针：在目标目录里真写一个临时文件再删掉。
   * 这是**唯一**会碰目标目录的动作 —— 但它不改用户任何已有内容。
   */
  async function doProbe(args) {
    if (typeof args.path !== 'string' || args.path.trim() === '') {
      return fail('probe', 'PATH_MISSING_ARG', 'probe 需要 path');
    }
    const approval = await gate('probe', `在 ${args.path} 里写一个临时文件来验证是否真的可写`, args.path);
    if (!approval.allowed) return fail('probe', approval.code, approval.message);
    if (!fs || typeof fs.writeFileSync !== 'function') {
      return fail('probe', 'PROBE_UNAVAILABLE', '没有可用的 fs，无法做真写探针');
    }
    const target = canonical(args.path, platform);
    const probeFile = `${target}${target.endsWith('\\') || target.endsWith('/') ? '' : platform === 'win32' ? '\\' : '/'}.dsh-probe-${process.pid}-${Date.now()}.tmp`;
    try {
      fs.writeFileSync(probeFile, 'dsh-multi-workspace probe\n', { flag: 'wx' });
    } catch (err) {
      audit.record({ tool: TOOL_NAME, code: 'PROBE_DENIED', path: target, args: summarizeArgs(args) });
      return fail('probe', 'PROBE_DENIED', `写不进这个目录（沙箱拒绝或权限不足）：${String(err?.message ?? err)}`, { path: target });
    }
    let removed = true;
    try {
      fs.unlinkSync(probeFile);
    } catch {
      removed = false;
    }
    audit.record({ tool: TOOL_NAME, code: removed ? 'PROBE_OK' : 'PROBE_OK_LEFTOVER', path: target });
    return ok(
      'probe',
      removed ? 'PROBE_OK' : 'PROBE_OK_LEFTOVER',
      removed ? '真写成功，这个目录当前确实可写' : '真写成功，但临时文件没删掉（请手动清理）',
      { path: target, probeFile },
    );
  }

  async function doSync(args) {
    const actual = Array.isArray(args.actualRoots) ? args.actualRoots : [];
    const approval = args.dryRun ? { allowed: true } : await gate('sync', '把规则文档同步到 DSH 的 additionalWritableRoots', undefined);
    if (!approval.allowed) return fail('sync', approval.code, approval.message);
    const result = await store.sync({ actual, dryRun: args.dryRun === true });
    if (!result.ok) {
      return fail('sync', result.code, result.message ?? '同步失败', { desired: result.desired, diff: result.diff });
    }
    if (result.code === STORE_CODE.DRY_RUN) {
      return ok('sync', result.code, '只是演算，没有写任何东西', { desired: result.desired, diff: result.diff }, NO_NOTE);
    }
    audit.record({ tool: TOOL_NAME, code: 'SYNC_OK' });
    return ok('sync', result.code, '授权层已更新（需要重载 DSH 才会对后续调用生效）', { desired: result.desired, diff: result.diff }, NO_NOTE);
  }

  async function doAudit(args) {
    const limit = Number.isFinite(args.limit) ? Math.min(Math.max(args.limit, 1), 200) : 20;
    return ok('audit', STORE_CODE.OK, `最近 ${limit} 条判定记录`, { file: audit.file, lines: audit.tail(limit) });
  }

  async function doEvaluate(args) {
    if (typeof options.evaluate !== 'function') {
      return fail('evaluate', 'EVALUATE_UNAVAILABLE', '这个实例没有接 evaluate（需要 index.mjs 注入）');
    }
    let parsed;
    if (typeof args.argsJson === 'string' && args.argsJson.trim() !== '') {
      try {
        parsed = JSON.parse(args.argsJson);
      } catch (err) {
        return fail('evaluate', 'BAD_ARGS', `argsJson 不是合法 JSON：${String(err?.message ?? err)}`);
      }
    }
    if (!parsed && typeof args.path === 'string' && args.path.trim() !== '') {
      parsed = { file_path: args.path };
    }
    const result = options.evaluate({ toolName: args.toolName, args: parsed });
    return ok(
      'evaluate',
      result.code,
      result.decision === 'deny' ? `会拒绝（${result.code}）：${result.reason}` : '会放行',
      result,
      NO_NOTE,
    );
  }

  async function doDoctor() {
    if (typeof options.doctor !== 'function') {
      return fail('doctor', 'DOCTOR_UNAVAILABLE', '这个实例没有接 doctor（需要 index.mjs 注入）');
    }
    const report = options.doctor();
    const failed = report.checks.filter((check) => !check.ok);
    return ok(
      'doctor',
      report.ok ? 'OK' : 'DEGRADED',
      report.ok ? '所有检查项通过' : `有 ${failed.length} 项没通过：${failed.map((c) => c.id).join(', ')}`,
      report,
      NO_NOTE,
    );
  }

  async function doUndo() {
    const approval = await gate('undo', '撤销上一次规则改动');
    if (!approval.allowed) return fail('undo', approval.code, approval.message);
    if (typeof store.undo !== 'function') return fail('undo', 'NOTHING_TO_UNDO', '这个 store 不支持撤销');
    const result = await store.undo();
    if (!result.ok) return fail('undo', result.code, result.message);
    audit.record({ tool: TOOL_NAME, code: 'undo' });
    return ok('undo', 'UNDONE', `已撤销上一次改动（${result.undone}）`, { roots: docRoots() }, NO_NOTE);
  }

  async function doExport() {
    if (typeof store.exportJson !== 'function') return fail('export', 'EXPORT_UNAVAILABLE', '这个 store 不支持导出');
    return ok('export', STORE_CODE.OK, '当前规则已导出（可直接粘贴回 import）', { json: store.exportJson() }, NO_NOTE);
  }

  async function doImport(args) {
    const approval = await gate('import', '用外部 JSON 覆盖当前规则');
    if (!approval.allowed) return fail('import', approval.code, approval.message);
    if (typeof args.json !== 'string' || args.json.trim() === '') {
      return fail('import', 'BAD_ARGS', 'import 需要 json（整份规则文档的 JSON 字符串）');
    }
    if (typeof store.importDoc !== 'function') return fail('import', 'IMPORT_UNAVAILABLE', '这个 store 不支持导入');
    const result = await store.importDoc(args.json);
    if (!result.ok) return fail('import', result.code, result.message);
    audit.record({ tool: TOOL_NAME, code: 'import' });
    // 用 IMPORTED 而不是笼统的 OK：模型看到的 code 是用来分支的，OK 分不出"导入成功"和"什么都没做"。
    return ok('import', 'IMPORTED', '已导入规则', { roots: docRoots() }, NO_NOTE);
  }

  async function doSessionList(args) {
    if (typeof options.session?.list !== 'function') return fail('session-list', 'SESSION_UNAVAILABLE', '这个实例没有接会话级根');
    const roots = options.session.list(args.sessionId);
    return ok('session-list', STORE_CODE.OK, `这个会话上有 ${roots.length} 个临时根`, { sessionId: args.sessionId, roots }, NO_NOTE);
  }

  async function doSessionAdd(args) {
    if (typeof options.session?.add !== 'function') return fail('session-add', 'SESSION_UNAVAILABLE', '这个实例没有接会话级根');
    if (typeof args.path !== 'string' || args.path.trim() === '') return fail('session-add', 'PATH_MISSING_ARG', 'session-add 需要 path');
    const approval = await gate('session-add', `给会话 ${args.sessionId ?? '(未指定)'} 临时加 ${args.path}（不写配置）`, args.path);
    if (!approval.allowed) return fail('session-add', approval.code, approval.message);
    const result = options.session.add({
      sessionId: args.sessionId,
      path: args.path,
      capabilities: args.capabilities,
      ttlMinutes: args.ttlMinutes,
      note: args.note,
    });
    if (!result.ok) return fail('session-add', result.code, result.message);
    audit.record({ tool: TOOL_NAME, code: 'session-add', path: args.path });
    return ok('session-add', result.code, `已给这个会话加临时根 ${args.path}`, result, result.note);
  }

  async function doSessionRemove(args) {
    if (typeof options.session?.remove !== 'function') return fail('session-remove', 'SESSION_UNAVAILABLE', '这个实例没有接会话级根');
    if (typeof args.path !== 'string' || args.path.trim() === '') return fail('session-remove', 'PATH_MISSING_ARG', 'session-remove 需要 path');
    const approval = await gate('session-remove', `撤掉会话 ${args.sessionId ?? '(未指定)'} 的临时根 ${args.path}`, args.path);
    if (!approval.allowed) return fail('session-remove', approval.code, approval.message);
    const result = options.session.remove(args.sessionId, args.path, 'manual');
    if (!result.ok) return fail('session-remove', result.code, result.message);
    audit.record({ tool: TOOL_NAME, code: 'session-remove', path: args.path });
    return ok('session-remove', result.code, `已撤掉临时根 ${args.path}`, result, NO_NOTE);
  }

  async function execute(args = {}) {
    const action = args.action;
    // 先读一次当前配置：不加这一步，所有变更都会基于"空文档"算 ——
    // 结果是 remove 说找不到、add 每次都当新根、status 永远显示授权层多出根。
    if (typeof store.load === 'function') {
      try {
        await store.load();
      } catch (err) {
        return fail(String(action), 'LOAD_FAILED', `读不到当前规则文档：${String(err?.message ?? err)}`);
      }
    }
    if (!ACTION_LIST.includes(action)) {
      return fail(String(action), 'UNKNOWN_ACTION', `不认识的 action：${action}（可用：${ACTION_LIST.join(', ')}）`);
    }
    switch (action) {
      case 'list':
        return doList();
      case 'status':
        return doStatus(Array.isArray(args.actualRoots) ? args.actualRoots : []);
      case 'add':
        return doAdd(args);
      case 'remove':
        return doRemove(args);
      case 'update':
        return doUpdate(args);
      case 'validate':
        return doValidate(args);
      case 'probe':
        return doProbe(args);
      case 'sync':
        return doSync(args);
      case 'audit':
        return doAudit(args);
      case 'evaluate':
        return doEvaluate(args);
      case 'doctor':
        return doDoctor();
      case 'undo':
        return doUndo();
      case 'export':
        return doExport();
      case 'import':
        return doImport(args);
      case 'session-list':
        return doSessionList(args);
      case 'session-add':
        return doSessionAdd(args);
      case 'session-remove':
        return doSessionRemove(args);
      default:
        return fail(String(action), 'UNKNOWN_ACTION', `不认识的 action：${action}`);
    }
  }

  return {
    name: TOOL_NAME,
    description:
      '管理 DSH Agent 的活动文件范围（多工作区）。'
      + 'action=list 看当前规则；status 看与 DSH 授权层是否一致；add/remove/update 改规则；'
      + 'validate 只校验不加；probe 真写一个临时文件验证是否真的可写；sync 把规则同步到 DSH 的 additionalWritableRoots；audit 看最近判定记录；'
      + 'evaluate 只试算某次调用会不会被拒（不执行）；doctor 自检插件各项能力是否生效；undo 撤销上一次规则改动；export/import 整体导出导入规则；'
      + 'session-list/session-add/session-remove 管理"只对当前会话生效、不写配置"的临时根（需要显式给 sessionId）。'
      + '能力位：read/write/delete/move，可按根分配，可加 include/exclude 子规则与 expiresAt 过期时间。'
      + '限制：Windows 上 pwsh/bash 子进程不认额外根（只对 DSH 文件工具生效）；读默认可读全盘，只有写被围栏。',
    parameters: PARAMETERS,
    // DSH 的工具契约要求声明 output；缺了它 defineTool 会抛
    // `tool "workspace_roots" must declare output { schema, render, presentationMeta? }`，
    // 整个工具注册失败（守卫还在，但模型看不到这个工具）。
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [
        { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
      ],
    },
    execute,
    /** 给 index.mjs 用的内部件 */
    internals: { gate, docRoots },
  };
}
