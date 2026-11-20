/**
 * audit.mjs —— 审计日志（JSONL，5MB 轮转）。
 *
 * 为什么它必须存在：规则引擎拒绝一个调用时，模型只会看到一句 denial。
 * 事后想回答「谁、什么时候、想动哪个路径、被哪条规则拒了」——只有审计能回答。
 *
 * 为什么它记的东西这么少：审计**会落盘**，落盘的东西就可能被人看到。
 * 所以这里只记「判定结果」，参数只记**键名与长度**，不记值。
 * 把 `{"token":"sk-..."}` 原样写进日志，是比"没日志"更糟的事故。
 *
 * 轮转策略：超过 maxBytes 就把当前文件改名成 `.1`，旧的往后顺延，超过 keep 份删掉。
 * 阈值与轮转目标都是同一个量级（都是这些日志行），不会出现"文档写了轮转、代码从不触发"。
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** 默认 5 MiB：一行约 150–250 B，等于约 2–3 万条判定，够一整天的排查。 */
export const AUDIT_DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
/** 保留 2 份历史：`.1` 与 `.2`。 */
export const AUDIT_DEFAULT_KEEP = 2;
/** 相对工作区；写不进去就只返回错误，绝不升级权限去写别处。 */
export const AUDIT_DEFAULT_FILE = '.dsh/multi-workspace-audit.jsonl';

const REAL_FS = { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync };

/**
 * 只取参数形状，不取参数值。
 * `{"path":"D:/x","n":3,"token":"sk-..."}` → `{"path":"string:5","n":"number","token":"string:4"}`
 */
export function summarizeArgs(args) {
  if (args === null || typeof args !== 'object') return typeof args;
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === null) out[key] = 'null';
    else if (Array.isArray(value)) out[key] = `array:${value.length}`;
    else if (typeof value === 'object') out[key] = 'object';
    else if (typeof value === 'string') out[key] = `string:${value.length}`;
    else out[key] = typeof value;
  }
  return out;
}

/**
 * 造一个审计器。
 *
 * @param {object} [options]
 * @param {string} [options.file] JSONL 路径（相对工作区）
 * @param {boolean} [options.enabled]
 * @param {number} [options.maxBytes]
 * @param {number} [options.keep]
 * @param {object} [options.fs] 注入假 fs 用（测试不需要真磁盘）
 * @param {() => Date} [options.now]
 */
export function createAudit(options = {}) {
  const file = options.file ?? AUDIT_DEFAULT_FILE;
  const enabled = options.enabled !== false;
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : AUDIT_DEFAULT_MAX_BYTES;
  const keep = Number.isFinite(options.keep) && options.keep >= 0 ? options.keep : AUDIT_DEFAULT_KEEP;
  const fs = options.fs ?? REAL_FS;
  const now = typeof options.now === 'function' ? options.now : () => new Date();

  const stats = { written: 0, rotated: 0, failed: 0 };

  function sizeOf(path) {
    try {
      if (typeof fs.statSync !== 'function') return 0;
      return fs.statSync(path).size ?? 0;
    } catch {
      return 0; // 文件还不存在是最常见的情况，不是错误
    }
  }

  function ensureDir() {
    const dir = dirname(file);
    if (dir && dir !== '.' && typeof fs.mkdirSync === 'function') {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /** 轮转：file.(keep) 之后丢弃，其余依次后移一位，再把 file 改成 .1。 */
  function rotate() {
    if (keep <= 0) {
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      stats.rotated += 1;
      return;
    }
    // keep=2 的意思是"只留 .1 与 .2 两份历史"。所以顺序是：
    //   ① 丢掉最老的 .2 → ② .1 改名成 .2 → ③ 当前文件改名成 .1。
    // 早先写成 `.2 → .3`，那不是"保留两份"，而是每轮多留一份、文件名无限增长。
    const drop = `${file}.${keep}`;
    if (fs.existsSync(drop)) fs.rmSync(drop, { force: true });
    for (let i = keep - 1; i >= 1; i -= 1) {
      const from = `${file}.${i}`;
      const to = `${file}.${i + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    fs.renameSync(file, `${file}.1`);
    stats.rotated += 1;
  }

  /**
   * 写一条判定记录。
   * @param {object} entry 至少要有 `tool` 与 `code`；`args` 会被压成形状。
   */
  function record(entry = {}) {
    if (!enabled) return { written: false, reason: 'DISABLED' };
    try {
      ensureDir();
      if (sizeOf(file) >= maxBytes) rotate();
      const line = `${JSON.stringify({
        ts: now().toISOString(),
        tool: entry.tool ?? '',
        code: entry.code ?? 'OK',
        cap: entry.cap,
        path: entry.path,
        sensitive: entry.sensitive === true ? true : undefined,
        rule: entry.rule?.path,
        args: entry.args === undefined ? undefined : summarizeArgs(entry.args),
      })}\n`;
      fs.appendFileSync(file, line, 'utf8');
      stats.written += 1;
      return { written: true };
    } catch (err) {
      stats.failed += 1;
      // 审计写不进去**不能**让被审计的动作失败：拒绝的理由是规则，不是日志。
      return { written: false, reason: 'AUDIT_WRITE_FAILED', error: String(err?.message ?? err) };
    }
  }

  /** 读回最近 n 行（测试与 `workspace_roots audit` 用）。 */
  function tail(n = 20) {
    try {
      if (!fs.existsSync(file)) return [];
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split('\n').filter((line) => line.trim() !== '');
      return lines.slice(Math.max(0, lines.length - n));
    } catch (err) {
      return [{ error: String(err?.message ?? err) }];
    }
  }

  return { file, enabled, maxBytes, keep, stats, record, tail, rotate };
}
