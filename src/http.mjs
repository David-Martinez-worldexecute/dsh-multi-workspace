/**
 * http.mjs —— 面板用的本机 HTTP 路由（给 composer 里那块小控件读写规则）。
 *
 * 为什么是 HTTP 而不是别的：
 *   浏览器里的客户端插件拿不到 node 侧的对象，只能走 `fetch`。DSH 的
 *   `/plugins/<包名>/...` 路由**不经过** session cookie 校验（那层只管 `/api` 与 WebSocket），
 *   所以每个 handler 必须自己做两道检查：
 *     ① 只接受本机回环（127.0.0.1 / ::1 / IPv4-mapped）
 *     ② 带 Origin 时必须与 Host 同源
 *   这两条是照 `dsh-ai-memory/src/routes.js` 的实地结论抄的，不是我想出来的。
 *
 * ⚠️ 一条诚实边界：这里的写操作**不过工具审批**。审批是给「模型发起的工具调用」用的，
 *   而点这个面板的是人本人 —— 人已经是授权来源。所以在 README 里必须写清：
 *   面板 = 人的直接操作；模型想改规则仍然要走 `workspace_roots` 工具 + 审批。
 */

import { samePathOf } from './paths.mjs';
import { checkRoot } from './validate.mjs';
import { ALL_CAPS } from './rules.mjs';
import { docFingerprint } from './store.mjs';

/** 路由前缀。客户端 bundle 里用的是同一个常量，改这里要一起改。 */
export const ROUTE_BASE = '/plugins/dsh-multi-workspace';

/** 请求体上限：面板只发很小的 JSON，超过就是异常请求。 */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * 判断请求是否只可能来自本机。
 * @param {string|undefined} address - `req.socket.remoteAddress`
 * @returns {boolean}
 */
export function isLoopback(address) {
  if (typeof address !== 'string') return false;
  if (address === '::1' || address === '127.0.0.1') return true;
  return address.startsWith('::ffff:') && address.slice(7) === '127.0.0.1';
}

/**
 * Origin 与 Host 是否同源。没有 Origin（curl / 同源 GET）时调用方直接跳过。
 * @param {string} origin
 * @param {unknown} host
 * @returns {boolean}
 */
export function originMatchesHost(origin, host) {
  if (typeof host !== 'string' || host === '') return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * 写 JSON 响应。
 * @param {object} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

/**
 * 读请求体并按 JSON 解析。超过上限直接 reject（不读进内存）。
 * @param {object} req
 * @returns {Promise<object>}
 */
function readJsonBody(req) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(text));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 把 store 的文档形状转成面板要的紧凑形状。
 * @param {object} doc
 * @param {string} platform
 */
function panelRoots(doc, platform) {
  const roots = Array.isArray(doc?.roots) ? doc.roots : [];
  return roots.map((root) => ({
    path: root.path,
    caps: Array.isArray(root.capabilities) ? root.capabilities : [...ALL_CAPS],
    mode: root.mode === 'ro' ? 'ro' : 'rw',
    include: Array.isArray(root.include) ? root.include : [],
    exclude: Array.isArray(root.exclude) ? root.exclude : [],
    expiresAt: root.expiresAt ?? null,
    note: root.note ?? '',
    key: String(root.path ?? '').toLowerCase(),
    platform,
  }));
}

/**
 * 造路由表。
 *
 * @param {object} options
 * @param {object} options.store - createStore 的产物
 * @param {string} [options.platform] - 默认 process.platform
 * @param {string} [options.workspaceRoot] - 用于"这个路径已在工作区里"的判断
 * @param {object} [options.fs] - 注入的文件系统（测试用）
 * @param {object} [options.audit] - 审计器（可选）
 * @param {(path: string) => object} [options.probe] - probe 实现（可选）
 * @returns {object[]} `{ kind, path, handler }`
 */
export function createRoutes(options = {}) {
  const store = options.store;
  if (!store || typeof store.load !== 'function') {
    throw new Error('createRoutes 需要 store（createStore 的产物）');
  }
  const platform = options.platform ?? process.platform;
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const fs = options.fs;
  const audit = options.audit;
  const session = options.session;
  const evaluate = options.evaluate;
  // shell 到底放不放行，取决于插件配置的 allowShell（总闸），不是规则文档的 shell.mode。
  // 之前这里只看 doc.shell.mode，于是 allowShell: true 的机器上面板仍写着「当前一律拒绝」——
  // 试算和面板文案一起骗人，Agent 就真的以为 shell 被禁了。
  const allowShell = options.allowShell === true;
  // 运行时自检（哪个能力真的接线成功）。面板要能按它禁用「必然报错」的按钮，
  // 而不是让人点了才看到 SESSION_UNAVAILABLE。
  const statusOf = typeof options.status === 'function' ? options.status : () => null;

  /** 文档指纹：面板用它判断"规则有没有变"，避免每 10 秒重绘一次。 */
  function rev() {
    try {
      return docFingerprint(store.doc ?? {});
    } catch {
      return 'unknown';
    }
  }

  /**
   * 统一的安全壳：本机 + 同源，然后交给业务函数。
   * @param {object} req
   * @param {object} res
   * @param {(url: URL, body: object) => Promise<object>|object} handler
   * @param {{ body?: boolean }} [shape]
   */
  async function guarded(req, res, handler, shape = {}) {
    if (!isLoopback(req.socket?.remoteAddress)) {
      sendJson(res, 403, { ok: false, code: 'NOT_LOOPBACK', message: '只接受本机回环请求' });
      return;
    }
    const origin = req.headers?.origin;
    if (typeof origin === 'string' && origin !== '' && !originMatchesHost(origin, req.headers?.host)) {
      sendJson(res, 403, { ok: false, code: 'CROSS_ORIGIN', message: 'Origin 与 Host 不同源' });
      return;
    }
    let body = {};
    if (shape.body) {
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { ok: false, code: 'BAD_BODY', message: String(err?.message ?? err) });
        return;
      }
    }
    try {
      // 每个请求都从配置里重读一次：否则面板看到的是插件启动那一刻的旧规则。
      await store.load();
      const url = new URL(req.url ?? '/', 'http://localhost');
      sendJson(res, 200, await handler(url, body));
    } catch (err) {
      sendJson(res, 500, { ok: false, code: 'INTERNAL', message: String(err?.message ?? err) });
    }
  }

  /** 记录一次面板写入（审计不记参数值，只记形状与结果）。 */
  function note(op, code, path) {
    if (!audit || typeof audit.record !== 'function') return;
    audit.record({ tool: 'panel', code: `${op}:${code}`, path });
  }

  return [
    {
      kind: 'exact',
      path: `${ROUTE_BASE}/state`,
      handler: (req, res) =>
        guarded(req, res, async (url) => {
          const doc = store.doc ?? {};
          const sessionId = url.searchParams.get('sessionId') ?? undefined;
          return {
            ok: true,
            rev: rev(),
            roots: panelRoots(doc, platform),
            // 会话级临时根：只在内存里，DSH 重启就没了。
            sessionRoots: typeof session?.list === 'function' ? session.list(sessionId) : [],
            undoDepth: typeof store.undoDepth === 'function' ? store.undoDepth() : 0,
            // 面板必须能自己说清"我这一层管到哪" —— 这三条是事实，不是文案。
            limits: {
              fileTools: '受控：write / edit / patch / delete / move 会过守卫',
              shellTools: allowShell
                ? 'Windows 上 pwsh / bash 子进程不认额外根；当前**整体放行**（插件配置 allowShell: true：围栏只剩文件工具这一层）'
                : doc.shell?.mode === 'allowlist'
                  ? 'Windows 上 pwsh / bash 子进程不认额外根；当前只放行白名单里的完整命令（全等匹配）'
                  : 'Windows 上 pwsh / bash 子进程不认额外根；当前一律拒绝（放行需插件配置 allowShell: true，或规则文档 shell.mode=allowlist + 完整命令）',
              readTools: '不管：DSH 本来就不围栏读',
              sessionRoots: '会话级：只对这一场会话生效，不持久、不继承 subagent',
            },
            workspaceRoot,
            // 运行时自检：面板据此禁用必然失败的按钮（例如没有 sandboxPolicy 时的「加临时根」）。
            status: statusOf(),
          };
        }),
    },
    {
      kind: 'exact',
      path: `${ROUTE_BASE}/roots`,
      handler: (req, res) =>
        guarded(
          req,
          res,
          async (_url, body) => {
            const op = String(body?.op ?? '');
            const target = typeof body?.path === 'string' ? body.path.trim() : '';
            const scope = body?.scope === 'session' ? 'session' : 'persistent';

            // ── 会话级：只改内存，不写 profile ──────────────────────────
            if (scope === 'session') {
              if (typeof session?.add !== 'function' || typeof session?.remove !== 'function') {
                return { ok: false, code: 'SESSION_UNAVAILABLE', message: '这个实例没有接会话级根' };
              }
              const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
              if (op === 'add') {
                if (target === '') return { ok: false, code: 'PATH_MISSING_ARG', message: 'add 需要 path' };
                if (sessionId === '') return { ok: false, code: 'SESSION_UNAVAILABLE', message: '会话级添加需要 sessionId' };
                const result = session.add({
                  sessionId,
                  path: target,
                  capabilities: body?.caps ?? body?.capabilities,
                  ttlMinutes: body?.ttlMinutes,
                  note: body?.note,
                });
                note('session-add', result.code, target);
                return { ok: result.ok !== false, code: result.code, message: result.message ?? (result.ok ? '已加临时根' : '加临时根失败'), sessionRoots: session.list(sessionId) };
              }
              if (op === 'remove') {
                if (target === '') return { ok: false, code: 'PATH_MISSING_ARG', message: 'remove 需要 path' };
                if (sessionId === '') return { ok: false, code: 'SESSION_UNAVAILABLE', message: '会话级移除需要 sessionId' };
                const result = session.remove(sessionId, target, 'panel');
                note('session-remove', result.code, target);
                return { ok: result.ok !== false, code: result.code, message: result.message ?? '已移除', sessionRoots: session.list(sessionId) };
              }
              // 能力位是随授权一起登记的：换能力位 = 撤掉再登记，不做原地改。
              return { ok: false, code: 'SESSION_UPDATE_UNSUPPORTED', message: '会话级根不支持原地改能力位：先 remove 再 add' };
            }

            if (op === 'add') {
              if (target === '') return { ok: false, code: 'PATH_MISSING_ARG', message: 'add 需要 path' };
              const checked = checkRoot({
                target,
                // 同路径旧登记先摘掉：add 的语义是"合并能力位"，不是"重复登记报错"。
                existingRoots: (store.doc?.roots ?? [])
                  .filter((root) => !samePathOf(root.path, target, platform))
                  .map((root) => root.path),
                workspaceRoot,
                platform,
                fs,
              });
              if (checked.code === 'PATH_INSIDE_WORKSPACE') {
                return { ok: true, code: checked.code, message: '这个目录已在当前工作区里，不需要额外添加', roots: panelRoots(store.doc, platform) };
              }
              if (!checked.ok) {
                return { ok: false, code: checked.code, message: checked.message, path: checked.path };
              }
              const result = await store.add({
                path: checked.path,
                capabilities: body?.caps ?? body?.capabilities,
                mode: body?.mode,
                note: body?.note,
              });
              note('add', result.code, checked.path);
              return {
                ok: result.ok !== false,
                code: result.code,
                message: result.message ?? (result.ok === false ? '写入规则失败' : '已添加'),
                warnings: checked.warnings ?? [],
                // 写进配置文件和写进兜底文件是两件事，如实透出去，界面才能说清「这次落在哪」。
                via: result.via,
                roots: panelRoots(store.doc, platform),
              };
            }

            if (op === 'remove') {
              if (target === '') return { ok: false, code: 'PATH_MISSING_ARG', message: 'remove 需要 path' };
              const result = await store.remove(target);
              note('remove', result.code, target);
              return { ok: result.ok !== false, code: result.code, message: result.message ?? '已移除', via: result.via, roots: panelRoots(store.doc, platform) };
            }

            if (op === 'update') {
              if (target === '') return { ok: false, code: 'PATH_MISSING_ARG', message: 'update 需要 path' };
              const patch = {};
              const caps = body?.caps ?? body?.capabilities;
              if (caps !== undefined) patch.capabilities = caps;
              if (body?.mode !== undefined) patch.mode = body.mode;
              if (body?.include !== undefined) patch.include = body.include;
              if (body?.exclude !== undefined) patch.exclude = body.exclude;
              if (body?.expiresAt !== undefined) patch.expiresAt = body.expiresAt;
              if (body?.note !== undefined) patch.note = body.note;
              const result = await store.update(target, patch);
              note('update', result.code, target);
              return { ok: result.ok !== false, code: result.code, message: result.message ?? '已更新', via: result.via, roots: panelRoots(store.doc, platform) };
            }

            if (op === 'undo') {
              if (typeof store.undo !== 'function') return { ok: false, code: 'NOTHING_TO_UNDO', message: '这个 store 不支持撤销' };
              const result = await store.undo();
              note('undo', result.code, '');
              return {
                ok: result.ok !== false,
                code: result.code,
                message: result.message ?? (result.ok ? `已撤销（${result.undone ?? ''}）` : '撤销失败'),
                rev: rev(),
                roots: panelRoots(store.doc, platform),
                undoDepth: typeof store.undoDepth === 'function' ? store.undoDepth() : 0,
              };
            }

            return { ok: false, code: 'UNKNOWN_OP', message: `不认识的 op：${op || '(空)'}` };
          },
          { body: true },
        ),
    },
    {
      kind: 'exact',
      path: `${ROUTE_BASE}/evaluate`,
      handler: (req, res) =>
        guarded(
          req,
          res,
          async (_url, body) => {
            if (typeof evaluate !== 'function') {
              return { ok: false, code: 'EVALUATE_UNAVAILABLE', message: '这个实例没有接 evaluate' };
            }
            let args = body?.args;
            if (typeof args === 'string' && args.trim() !== '') {
              try {
                args = JSON.parse(args);
              } catch (err) {
                return { ok: false, code: 'BAD_ARGS', message: `args 不是合法 JSON：${String(err?.message ?? err)}` };
              }
            }
            return { ok: true, result: evaluate({ toolName: body?.toolName, args }) };
          },
          { body: true },
        ),
    },
    {
      kind: 'exact',
      path: `${ROUTE_BASE}/events`,
      handler: (req, res) =>
        guarded(req, res, async (url) => {
          const raw = Number(url.searchParams.get('limit') ?? 20);
          const limit = Number.isFinite(raw) ? Math.max(1, Math.min(200, Math.trunc(raw))) : 20;
          if (!audit || typeof audit.tail !== 'function') return { ok: true, items: [] };
          return { ok: true, items: audit.tail(limit) };
        }),
    },
    {
      kind: 'exact',
      path: `${ROUTE_BASE}/export`,
      handler: (req, res) =>
        guarded(req, res, async () => {
          if (typeof store.exportJson !== 'function') {
            return { ok: false, code: 'EXPORT_UNAVAILABLE', message: '这个 store 不支持导出' };
          }
          return { ok: true, json: store.exportJson(), rev: rev() };
        }),
    },
    {
      kind: 'exact',
      path: `${ROUTE_BASE}/import`,
      handler: (req, res) =>
        guarded(
          req,
          res,
          async (_url, body) => {
            if (typeof store.importDoc !== 'function') {
              return { ok: false, code: 'IMPORT_UNAVAILABLE', message: '这个 store 不支持导入' };
            }
            const payload = body?.json ?? body?.doc;
            if (payload === undefined) return { ok: false, code: 'BAD_ARGS', message: 'import 需要 json' };
            const result = await store.importDoc(payload);
            note('import', result.code, '');
            return {
              ok: result.ok !== false,
              code: result.code,
              message: result.message ?? '已导入',
              rev: rev(),
              roots: panelRoots(store.doc, platform),
            };
          },
          { body: true },
        ),
    },
  ];
}
