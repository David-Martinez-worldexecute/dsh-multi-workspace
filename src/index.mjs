/**
 * index.mjs —— DSH 插件入口（薄到极致，所有逻辑都在其它文件里）。
 *
 * ⚠️ 诚实声明：这个文件是**唯一**依赖 DSH 真实 API 形状的部分，
 * 而 DSH 的插件作者文档（`docs/development/plugin-authoring.md`）在 0.2.2-rc.3 里不存在。
 * 所以下面每一处 ctx 调用都做了存在性判断，并在拿不到时**明确降级/失败**，
 * 而不是静默什么都不做 —— 装上去之后如果哪一项没生效，日志/返回值里必须看得见。
 *
 * 它做三件事：
 *   1. 注册 `workspace_roots` 工具（给模型用）；
 *   2. 注册 `ctx.tools.guard()` 守卫（真正拦文件写操作的地方）；
 *   3. 维护 store（规则文档）+ audit（审计）。
 *
 * 一切写入都走 `ctx.configEditor.edit()`，本文件不碰任何 YAML 文本。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import fsDefault from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAudit } from './audit.mjs';
import { createRoutes } from './http.mjs';
import { createStore, docFingerprint, emptyDoc, normalizeDoc } from './store.mjs';
import { createWorkspaceRootsTool } from './tool.mjs';
import { ALL_CAPS, compileDoc, normalizeRoot, resolve } from './rules.mjs';
import { samePathOf } from './paths.mjs';

/**
 * 加载探针：把「模块有没有被求值 / apply 有没有跑 / 抛了什么」写到临时目录里。
 *
 * 为什么需要它：DSH 桌面端看不到插件 console；而"插件没加载"与"加载了但抛异常"
 * 在界面上完全同形（面板渲染出来、数据却拿不到）。没有落盘证据就只能猜。
 * 每次只追加一行 JSON，不含任何用户数据与路径内容。
 */
/** 落在插件目录下的 `.dsh/load-trace.log`：不依赖临时目录，位置稳定、好找。 */
const LOAD_TRACE_FILE = fileURLToPath(new URL('../.dsh/load-trace.log', import.meta.url));
/** 规则文档的文件兜底位置（configEditor 拿不到时写这里，见 store.mjs）。 */
const RULES_FILE = fileURLToPath(new URL('../.dsh/multi-workspace-rules.json', import.meta.url));

function traceLoad(event, extra = {}) {
  try {
    mkdirSync(dirname(LOAD_TRACE_FILE), { recursive: true });
    appendFileSync(
      LOAD_TRACE_FILE,
      `${JSON.stringify({ at: new Date().toISOString(), event, pid: process.pid, ...extra })}\n`,
      'utf8',
    );
  } catch {
    // 探针失败绝不能影响插件本身
  }
}

/** 与包名保持一致：Cordis 的行名与包名不同名时，排查成本会白白翻倍。 */
export const name = 'dsh-multi-workspace';
export const version = '0.5.4';

/**
 * Cordis 的依赖声明。`tools` 是必须的（不给就只有工具没有守卫）；
 * `configEditor` / `sandboxPolicy` 缺失时降级（仍能读规则、能校验，但不能持久化）。
 */
// Cordis 的 `inject` 只接受**服务名数组**（对象形式 {required, optional} 会被当成
// 两个名叫 required / optional 的服务，激活报 "waiting for services: required, optional"）。
// 所以硬依赖写在这里；其它可选服务在 apply 里用 `ctx.inject([...], cb)` 补进来。
export const inject = ['tools'];

const DEFAULT_CONFIG = Object.freeze({
  rowId: 'dsh-multi-workspace',
  policyRowId: 'sandbox-policy',
  allowShell: false,
  enforceRead: false,
  requireApproval: true,
  audit: true,
  auditFile: '.dsh/multi-workspace-audit.jsonl',
});

/**
 * 读一个**可选**服务，读不到就是 undefined。
 *
 * 为什么不能直接写 `ctx.configEditor`：Cordis 要求服务先 inject 再读，
 * 直接 get 一个没声明的服务会抛
 *   cannot get property "configEditor" without inject
 * 而这行异常会把整个插件的激活打断 —— 面板与路由就永远挂不上。
 * 插件的活可以在"没有 configEditor / sandboxPolicy / sessions"的宿主上降级运行，
 * 所以这些读取必须变成不抛错的探测。
 */
function safeService(ctx, name) {
  // 优先走宿主的服务查找接口 `ctx.get(name)` —— 这是 app.asar 里自带文档的写法
  // （示例：`const editor = ctx.get('configEditor')`）。它不需要先 inject 就能查，
  // 因此可选服务的探测必须走这条路；直接 `ctx[name]` 在没 inject 时会抛
  // "cannot get property ... without inject"，而那正是把插件锁死在降级态的根因。
  try {
    if (typeof ctx?.get === 'function') {
      const found = ctx.get(name);
      if (found !== undefined && found !== null) return found;
    }
  } catch {
    /* ctx.get 在某些宿主上也会抛：继续用属性探测兜底 */
  }
  try {
    return ctx?.[name];
  } catch {
    return undefined;
  }
}

/**
 * 造一个"能跑"的实例（不注册到任何 ctx，测试与本地控制台都用它）。
 */
export function createInstance(ctx = {}, config = {}) {
  const merged = { ...DEFAULT_CONFIG, ...(config ?? {}) };
  const platform = process.platform;
  const audit = createAudit({ file: merged.auditFile, enabled: merged.audit !== false });

  const services = {
    configEditor: safeService(ctx, 'configEditor'),
    sandboxPolicy: safeService(ctx, 'sandboxPolicy'),
    sessions: safeService(ctx, 'sessions'),
    workspaceRoot: safeService(ctx, 'workspaceRoot'),
  };
  const configEditor = services.configEditor;
  const readConfig =
    typeof configEditor?.read === 'function'
      ? (rowId) => configEditor.read({ id: rowId })
      : typeof merged.readConfig === 'function'
        ? merged.readConfig
        : undefined;

  const store = createStore({
    configEditor,
    readConfig,
    config: merged.config ?? emptyDoc(),
    rowId: merged.rowId,
    policyRowId: merged.policyRowId,
    platform,
    // configEditor 拿不到时的落盘兜底（见 store.mjs 里 rulesFile 的注释）。
    rulesFile: merged.rulesFile ?? RULES_FILE,
    fs: merged.fs ?? fsDefault,
  });

  // Cordis 的服务必须经 ctx.inject 才能读（直接读会抛 without inject 并打断整个激活）。
  // configEditor 对插件是"可降级"的：没有它，规则只活在内存里 —— 面板能读、能试算，
  // 但"加根 / 撤销 / 导入"会返回 EDIT_FAILED。所以这里挂一个注入回调，
  // 等服务出现时补进 store，而不是在 apply 开头硬读把激活搞崩。
  try {
    ctx?.inject?.(['configEditor'], (scope) => {
      try {
        store.setEditors?.({ configEditor: scope?.configEditor });
      } catch {
        /* 注入回调里失败只影响持久化，不影响守卫与工具 */
      }
    });
  } catch {
    /* 宿主没有 inject 能力：保持降级，status.persistent=false 会如实反映 */
  }

  // ── 会话级临时根 ────────────────────────────────────────────────────────
  // 只在内存里：sessionId -> Map<pathKey, entry>。
  // 它和"持久规则"是两条独立通路：持久规则写 profile、全 profile 共享；
  // 会话根走 ctx.sandboxPolicy.registerWritableRoot，只对这一场会话生效，
  // 不持久、不继承 subagent、撤销后已在跑的子进程仍保持旧权限。
  const sessionRoots = new Map();
  const SESSION_MAX_TTL_MINUTES = 24 * 60;

  function sessionBucket(sessionId) {
    const id = String(sessionId ?? '');
    if (!sessionRoots.has(id)) sessionRoots.set(id, new Map());
    return sessionRoots.get(id);
  }

  function publicSessionEntry(entry) {
    return {
      path: entry.path,
      capabilities: [...entry.capabilities],
      ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
      ...(entry.note ? { note: entry.note } : {}),
    };
  }

  function listSessionRoots(sessionId) {
    if (sessionId === undefined || sessionId === null || String(sessionId) === '') {
      const all = [];
      for (const [id, bucket] of sessionRoots) {
        for (const entry of bucket.values()) all.push({ sessionId: id, ...publicSessionEntry(entry) });
      }
      return all;
    }
    return [...sessionBucket(sessionId).values()].map(publicSessionEntry);
  }

  function removeSessionRoot(sessionId, target, reason = 'manual') {
    const bucket = sessionRoots.get(String(sessionId ?? ''));
    if (!bucket) return { ok: false, code: 'SESSION_ROOT_NOT_FOUND', message: `会话 ${sessionId} 上没有临时根` };
    let found = null;
    for (const [key, entry] of bucket) {
      if (samePathOf(entry.path, target, platform)) {
        found = [key, entry];
        break;
      }
    }
    if (!found) return { ok: false, code: 'SESSION_ROOT_NOT_FOUND', message: `会话 ${sessionId} 上没有 ${target}` };
    const [key, entry] = found;
    if (entry.timer) clearTimeout(entry.timer);
    // disposer 可能已经被别处撤销过：这里失败不代表"没移除"，所以不把它变成错误。
    try {
      if (typeof entry.disposer === 'function') entry.disposer();
    } catch (err) {
      /* 已失效：忽略 */
    }
    bucket.delete(key);
    audit.record({ tool: 'session', code: `session-remove:${reason}`, path: entry.path });
    return { ok: true, code: 'SESSION_REMOVED', path: entry.path, reason };
  }

  function registerSessionRoot(input = {}) {
    if (input.sessionId === undefined || input.sessionId === null || String(input.sessionId) === '') {
      return { ok: false, code: 'SESSION_UNAVAILABLE', message: '没有 sessionId —— 会话级临时根只能挂在具体会话上' };
    }
    if (typeof services.sandboxPolicy?.registerWritableRoot !== 'function') {
      return { ok: false, code: 'POLICY_UNAVAILABLE', message: 'ctx.sandboxPolicy.registerWritableRoot 不可用（这个 DSH 版本没有会话级授权入口）' };
    }
    const session = typeof services.sessions?.get === 'function' ? services.sessions.get(String(input.sessionId)) : undefined;
    if (!session) {
      return { ok: false, code: 'SESSION_UNAVAILABLE', message: `拿不到会话 ${input.sessionId}（可能已经结束）` };
    }
    let normalized;
    try {
      normalized = normalizeRoot({ path: input.path, capabilities: input.capabilities ?? [...ALL_CAPS] }, platform);
    } catch (err) {
      return { ok: false, code: 'BAD_RULE', message: String(err?.message ?? err) };
    }
    const bucket = sessionBucket(input.sessionId);
    if (bucket.has(normalized.key)) {
      return { ok: false, code: 'SESSION_ROOT_EXISTS', message: `${normalized.path} 已经是这个会话的临时根` };
    }
    let disposer;
    try {
      disposer = services.sandboxPolicy.registerWritableRoot(session, normalized.path);
    } catch (err) {
      return { ok: false, code: 'REGISTER_FAILED', message: `注册会话根失败：${String(err?.message ?? err)}` };
    }
    const ttl = Number(input.ttlMinutes);
    const ttlMinutes = Number.isFinite(ttl) && ttl > 0 ? Math.min(ttl, SESSION_MAX_TTL_MINUTES) : 0;
    const expiresAt = ttlMinutes > 0 ? new Date(Date.now() + ttlMinutes * 60000).toISOString() : undefined;
    const entry = {
      path: normalized.path,
      capabilities: [...normalized.capabilities],
      ...(expiresAt ? { expiresAt } : {}),
      ...(typeof input.note === 'string' && input.note.trim() !== '' ? { note: input.note } : {}),
      disposer,
      timer: null,
    };
    if (ttlMinutes > 0) {
      entry.timer = setTimeout(() => removeSessionRoot(input.sessionId, normalized.path, 'expired'), ttlMinutes * 60000);
      // 不要因为这个定时器把进程钉住（测试 / 控制台里尤其明显）。
      if (typeof entry.timer?.unref === 'function') entry.timer.unref();
    }
    bucket.set(normalized.key, entry);
    audit.record({ tool: 'session', code: 'session-add', path: normalized.path });
    return {
      ok: true,
      code: 'SESSION_ADDED',
      entry: publicSessionEntry(entry),
      note: '只对这一个会话生效；不持久，DSH 重启或会话结束后消失。',
    };
  }

  function disposeAllSessionRoots() {
    for (const bucket of sessionRoots.values()) {
      for (const entry of bucket.values()) {
        if (entry.timer) clearTimeout(entry.timer);
        try {
          if (typeof entry.disposer === 'function') entry.disposer();
        } catch (err) {
          /* 忽略：卸载时不应该因为某一项失败而中断 */
        }
      }
      bucket.clear();
    }
    sessionRoots.clear();
  }

  const tool = createWorkspaceRootsTool({
    store,
    audit,
    fs: merged.fs,
    platform,
    workspaceRoot: merged.workspaceRoot ?? services.workspaceRoot ?? process.cwd(),
    allowShell: merged.allowShell === true,
    approve: merged.approve,
    requireApproval: merged.requireApproval,
    session: { add: registerSessionRoot, remove: removeSessionRoot, list: listSessionRoots },
    evaluate: (input) => evaluateCall(input),
    doctor: () => doctorReport(),
  });

  // 守卫要跟着 store.doc 变，不能只在启动时编译一次 —— 否则改了规则还要重载才生效。
  let cached = { fingerprint: '', doc: null };
  function compiledDoc() {
    const fingerprint = docFingerprint(store.doc);
    if (cached.fingerprint !== fingerprint) {
      cached = { fingerprint, doc: compileDoc(normalizeDoc(store.doc, platform), platform) };
    }
    return cached.doc;
  }

  /** 试算一次调用会怎么判（不执行任何工具，只跑规则）。 */
  function evaluateCall(input = {}) {
    const compiled = compiledDoc();
    const result = resolve({
      name: input.toolName ?? input.name,
      args: input.args ?? (input.path ? { file_path: input.path } : {}),
      doc: compiled,
      platform,
      mode: merged.mode ?? 'workspace-write',
      enforceRead: merged.enforceRead === true,
      // 试算必须用**和守卫完全相同的入参**。这里漏过 allowShell：守卫放行 shell，
      // 试算却回 SHELL_UNCONTROLLED —— 同一个问题两个出口两种答案（真机上被当成"shell 被禁"）。
      allowShell: merged.allowShell === true,
    });
    return {
      ok: true,
      code: result.code ?? 'OK',
      decision: result.denial ? 'deny' : 'allow',
      reason: result.denial ? String(result.denial) : '放行',
      path: result.path,
      cap: result.cap,
      matchedRoot: result.rule?.path,
    };
  }

  /** 自检：把"这个插件到底哪一项没生效"变成一份可读清单，而不是让人猜。 */
  function doctorReport() {
    const checks = [
      { id: 'tools.guard', ok: status.guardRegistered, detail: status.guardRegistered ? '已注册：工具调用会过守卫' : '不可用：规则不会真的拦截' },
      { id: 'tools.register', ok: status.toolRegistered, detail: status.toolRegistered ? '已注册 workspace_roots 工具' : '不可用：模型看不到工具' },
      { id: 'configEditor.edit', ok: status.persistent, detail: status.persistent ? '可用：规则能持久化' : '不可用：规则改不了' },
      {
        id: 'sandboxPolicy.registerWritableRoot',
        ok: typeof services.sandboxPolicy?.registerWritableRoot === 'function',
        detail: typeof services.sandboxPolicy?.registerWritableRoot === 'function' ? '可用：支持会话级临时根' : '不可用：只能走持久根',
      },
      {
        id: 'sessions.get',
        ok: typeof services.sessions?.get === 'function',
        detail: typeof services.sessions?.get === 'function' ? '可用：能按 id 找会话' : '不可用：会话级临时根挂不上',
      },
      { id: 'webServer', ok: status.routesRequested, detail: status.routesRequested ? '已请求 /plugins/dsh-multi-workspace/* 路由' : '不可用：面板读不到真实规则' },
      { id: 'audit', ok: audit.enabled !== false, detail: `审计文件：${audit.file}` },
      { id: 'rules', ok: true, detail: `持久根 ${store.doc.roots.length} 个，会话根 ${listSessionRoots().length} 个` },
    ];
    const failed = checks.filter((check) => !check.ok);
    return { ok: failed.length === 0, checks, problems: [...status.problems] };
  }

  function guard(exec) {
    try {
      const compiled = compiledDoc();
      const result = resolve({
        name: exec?.name,
        args: exec?.arguments,
        doc: compiled,
        platform,
        mode: merged.mode ?? 'workspace-write',
        enforceRead: merged.enforceRead === true,
        allowShell: merged.allowShell === true,
      });
      if (!result.denial) return undefined;
      audit.record({
        tool: exec?.name,
        code: result.code,
        cap: result.cap,
        path: result.path,
        sensitive: result.code === 'SENSITIVE_DENIED',
        args: exec?.arguments,
      });
      return result.denial;
    } catch (err) {
      // 守卫自己炸了必须 fail closed：宁可拒绝，也不能因为内部错误放行。
      audit.record({ tool: exec?.name, code: 'GUARD_INTERNAL_ERROR' });
      return `multi-workspace 守卫内部错误，已拒绝这次调用：${String(err?.message ?? err)}`;
    }
  }

  const status = {
    guardRegistered: false,
    toolRegistered: false,
    routesRequested: false,
    sessionRootsSupported: typeof services.sandboxPolicy?.registerWritableRoot === 'function',
    persistent: typeof configEditor?.edit === 'function',
    problems: [],
  };

  function register(ctx2 = ctx) {
    // 1) 守卫：monotonic denial，注册在 pre-execute 与审批之后，挡得住真正落盘。
    if (typeof ctx2.tools?.guard === 'function') {
      ctx2.tools.guard(guard);
      status.guardRegistered = true;
    } else {
      status.problems.push('ctx.tools.guard 不可用 —— 规则不会真的拦截工具调用');
    }

    // 2) 工具
    if (typeof ctx2.tools?.register === 'function') {
      try {
        const definition = typeof ctx2.tools.defineTool === 'function' ? ctx2.tools.defineTool(tool) : tool;
        ctx2.tools.register(definition);
        status.toolRegistered = true;
      } catch (err) {
        status.problems.push(`注册 workspace_roots 失败：${String(err?.message ?? err)}`);
      }
    } else {
      status.problems.push('ctx.tools.register 不可用 —— 模型看不到 workspace_roots 工具');
    }

    // 3) 面板用的本机 HTTP 路由：composer 那块小控件靠它读/写规则。
    //    拿不到 webServer 不算失败 —— 面板不显示，工具与守卫照旧工作。
    if (typeof ctx2.inject === 'function') {
      try {
        ctx2.inject(['webServer'], (scope) => {
          scope.effect(() => {
            const routes = createRoutes({
              store,
              platform,
              workspaceRoot: merged.workspaceRoot ?? services.workspaceRoot ?? process.cwd(),
              fs: merged.fs,
              audit,
              // 面板文案与试算都必须知道 shell 总闸的真实状态，否则会写出「一律拒绝」这种假话。
              allowShell: merged.allowShell === true,
              // 面板要按真实接线状态禁用按钮，不能让人点了才吃 SESSION_UNAVAILABLE。
              status: () => ({ ...status, problems: [...status.problems] }),
              session: { add: registerSessionRoot, remove: removeSessionRoot, list: listSessionRoots },
              evaluate: (input) => evaluateCall(input),
            });
            const disposers = routes.map((route) => scope.webServer.register(route));
            return () => {
              for (const dispose of disposers) {
                if (typeof dispose === 'function') dispose();
              }
            };
          }, 'multi-workspace: panel routes');
        });
        status.routesRequested = true;
      } catch (err) {
        status.problems.push(`注册面板路由失败：${String(err?.message ?? err)}`);
      }
    } else {
      status.problems.push('ctx.inject 不可用 —— 面板读不到真实规则（工具与守卫不受影响）');
    }

    // 4) 卸载时把会话级临时根的定时器与 disposer 一起收干净。
    if (typeof ctx2.effect === 'function') {
      try {
        ctx2.effect(() => () => disposeAllSessionRoots(), 'multi-workspace: session roots');
      } catch (err) {
        status.problems.push(`注册会话根清理钩子失败：${String(err?.message ?? err)}`);
      }
    }

    // 持久化有两条真实的路：写 profile 配置行（configEditor）或写兜底文件。
    //
    // 真机实测（DSH 0.2.2-rc.3）：configEditor 服务**是存在的**，但必须经 `ctx.get('configEditor')`
    // 才拿得到（见 safeService 的注释）；而 profile 的 cordis.patch.yml 里**没有本插件的行**
    // —— bundle 的行住在插件自己的 cordis.patch.yml 里，configEditor 不认它 —— 于是
    // `configEditor.edit({ id: 'dsh-multi-workspace' })` 会抛
    // "Configuration entry is no longer available"，store 随即降级写兜底文件。
    //
    // 所以这里的 status 必须说**默认落点**，不能因为"服务在"就声称写进了配置行：
    // 使用者点「加根」时真正发生的落点是兜底文件。
    const fileFallback = typeof store.canFileWrite === 'function' ? store.canFileWrite() : false;
    if (fileFallback) {
      status.persistent = true;
      status.persistVia = 'file';
      status.notes = [
        ...(status.notes ?? []),
        `规则默认落在 ${store.rulesFile ?? '.dsh/multi-workspace-rules.json'}：profile 的 cordis.patch.yml 里没有可写行`
          + (typeof configEditor?.edit === 'function' ? '（configEditor 服务在，但它不认 bundle 自带的行）' : '（没拿到 configEditor 服务）'),
      ];
    } else if (!status.persistent) {
      status.problems.push('规则无处可存：既没有 configEditor 可写的行，兜底文件也不可写');
    } else {
      status.persistVia = 'config';
    }
    return status;
  }

  return {
    store,
    audit,
    tool,
    guard,
    status,
    register,
    listSessionRoots,
    registerSessionRoot,
    removeSessionRoot,
    disposeAllSessionRoots,
    evaluateCall,
    doctorReport,
    /** 当前规则摘要（给面板/控制台用） */
    snapshot: () => ({
      doc: store.doc,
      compiled: compiledDoc(),
      status: { ...status, problems: [...status.problems] },
      auditFile: audit.file,
      sessionRoots: listSessionRoots(),
      policy: {
        // 这一行是"人话"：告诉使用者这个能力到底覆盖到哪一层
        fileTools: '受控（write/edit/patch/delete/move 会过守卫）',
        shellTools: merged.allowShell ? '放行（注意：Windows 子进程本来就不认额外根）' : '默认拒绝',
        readTools: merged.enforceRead ? '受控' : '不管（DSH 本来就不围栏读）',
      },
    }),
  };
}

/**
 * Cordis 插件入口。
 * 注意 `ctx.sandboxPolicy.registerWritableRoot` 这里**没有**自动调用：
 * 它是"会话级临时授权"，和"持久规则"是两件事，混在一起会让行为难以预期。
 * 需要临时授权时，由面板/工具显式调用（M3 的范围）。
 */
export function apply(ctx, config = {}) {
  traceLoad('apply-enter', {
    version,
    hasTools: Boolean(ctx?.tools),
    hasInject: typeof ctx?.inject === 'function',
    hasConfigEditor: typeof safeService(ctx, 'configEditor')?.edit === 'function',
    hasSandboxPolicy: typeof safeService(ctx, 'sandboxPolicy')?.registerWritableRoot === 'function',
    configKeys: Object.keys(config ?? {}),
  });
  try {
    const instance = createInstance(ctx, config);
    traceLoad('instance-created', { version });
    instance.register(ctx);
    traceLoad('registered', { version, status: instance.status });
    return instance;
  } catch (err) {
    // 插件在加载期抛异常，可能让**整个 profile 起不来** —— 那时候连"改回来"都要手改文件。
    // 所以这里降级成"什么都不做但还活着"，并把原因打到控制台与 status 上。
    // 宁可这个插件不生效，也不能把 DSH 一起带走。
    const message = `multi-workspace 加载失败（已降级为不生效）：${String(err?.message ?? err)}`;
    traceLoad('apply-failed', {
      version,
      message,
      stack: String(err?.stack ?? '').split('\n').slice(0, 6).join(' | '),
    });
    console.error(`[dsh-multi-workspace] ${message}`);
    const status = {
      guardRegistered: false,
      toolRegistered: false,
      persistent: false,
      problems: [message],
    };
    return {
      name,
      version,
      status,
      register: () => status,
      snapshot: () => ({ doc: null, status: { ...status }, policy: {} }),
    };
  }
}

traceLoad('module-evaluated', { version, name });

export default { name, version, inject, apply, createInstance };
