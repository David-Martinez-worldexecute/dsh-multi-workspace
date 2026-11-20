/**
 * paths.mjs —— 路径判定的**唯一来源**。
 *
 * 为什么单独一个文件：guard.mjs 与 rules.mjs 都要判"这个路径在不在那个根里"，
 * 两份实现一旦漂移，就会出现「guard 放行、规则引擎拒绝」这种最难查的矛盾。
 * 所以这里的四个函数（canonical / keyOf / samePathOf / withinOf）是唯一实现，
 * guard.mjs 只做转导出（re-export），rules.mjs 直接 import。
 *
 * 平台分流是硬需求：validate.mjs 的 stripTrailingSeparators 无条件把 `/` 换成 `\`
 * （Windows 语义），拿它判 POSIX 路径会把 `/home/lin/proj` 变成 `\home\lin\proj`，
 * 于是所有包含判断都错。这里按 platform 分流，两个平台各自用各自的规则。
 */

import nodePath from 'node:path';

export const WIN = 'win32';

/** 去掉尾部冗余分隔符；盘根（`D:\`）与 POSIX 根（`/`）必须保留。 */
export function stripSeps(input, platform = process.platform) {
  if (typeof input !== 'string') return '';
  const src = platform === WIN ? input.replace(/\//g, '\\') : input;
  if (src.length === 0) return '';
  if (platform === WIN) {
    // `D:\` → 长度 3，尾字符是分隔符，但它是盘根，保留
    if (/^[A-Za-z]:\\$/.test(src)) return src;
    if (/^\\\\[^\\]+\\[^\\]+\\$/.test(src)) return src; // UNC 共享根
    return src.replace(/\\+$/, '');
  }
  if (src === '/') return '/';
  return src.replace(/\/+$/, '');
}

/** 规范化成"可比较的绝对路径拼写"：分隔符统一、去尾分隔符。不解析 symlink、不碰磁盘。 */
export function canonical(input, platform = process.platform) {
  const s = stripSeps(input, platform);
  if (s.length === 0) return '';
  if (platform === WIN) {
    // 统一用 \，但保留 `\\?\` 前缀原样（去尾分隔符时不能把长路径前缀吃掉）
    return s;
  }
  return s;
}

/** 比较用的 key：Windows 大小写不敏感（转小写），POSIX 保持原样。 */
export function keyOf(input, platform = process.platform) {
  const c = canonical(input, platform);
  return platform === WIN ? c.toLowerCase() : c;
}

/** 两个路径是否指同一个位置（不做磁盘解析）。 */
export function samePathOf(a, b, platform = process.platform) {
  return keyOf(a, platform) === keyOf(b, platform);
}

/**
 * child 是否在 parent 之下（**严格**包含；child === parent 返回 false）。
 * 用 path.relative 的段边界判断，所以 `D:\ab` 不会被 `D:\a` 误判为子目录。
 */
export function withinOf(child, parent, platform = process.platform) {
  const c = canonical(child, platform);
  const p = canonical(parent, platform);
  if (!c || !p) return false;
  const rel = platform === WIN ? nodePath.win32.relative(p, c) : nodePath.posix.relative(p, c);
  if (rel === '') return false;
  if (platform === WIN) {
    if (nodePath.win32.isAbsolute(rel)) return false;
  } else if (nodePath.posix.isAbsolute(rel)) {
    return false;
  }
  const up = rel.split(platform === WIN ? '\\' : '/')[0];
  return up !== '..';
}

/**
 * 从工具参数里抽路径。`dotted` 是参数名路径，`files[].path` 这种数组写法也支持。
 * 返回去重后的字符串数组（保持出现顺序）。
 */
export function extractPaths(args, dotted = [], platform = process.platform) {
  // 兼容两种调用形态：`'file_path'`（单个字符串）与 `['files[].path']`（数组）。
  // V1 的测试就是用字符串调的，只收数组会静默返回空数组 —— 空数组在 guard 里等于"放行"。
  const specs = typeof dotted === 'string' ? [dotted] : Array.isArray(dotted) ? dotted : [];
  const out = [];
  const seen = new Set();
  const push = (v) => {
    if (typeof v !== 'string' || v.length === 0) return;
    const k = keyOf(v, platform);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(v);
  };
  for (const spec of specs) {
    const arrayLike = /\[]\.?/.test(spec);
    const [head, tail] = spec.split('[]');
    let cur = args && typeof args === 'object' ? args[head] : undefined;
    if (arrayLike) {
      if (Array.isArray(cur)) {
        const key = tail ? tail.replace(/^\./, '') : null;
        for (const item of cur) {
          if (key && item && typeof item === 'object') push(item[key]);
          else push(item);
        }
      }
      continue;
    }
    push(cur);
  }
  return out;
}

/** 把 `**` / `*` / `?` 的 glob 编译成正则（路径统一成 `/` + 小写，方便跨平台）。 */
export function globToRegExp(glob, { caseInsensitive = true } = {}) {
  const g = String(glob).replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < g.length; i += 1) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i + 1] === '*') {
        // `**` 吞任意层；`**/` 还能吞零层（`**/*.pem` 也要匹配 `a.pem`）
        if (g[i + 2] === '/') {
          re += '(?:[^/]*/)*';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      re += '[^/]';
      continue;
    }
    re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, caseInsensitive ? 'i' : '');
}

/** 用一组 glob 去匹配若干候选字符串（候选之间是"或"关系）。 */
export function matchesAnyGlob(patterns, candidates) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  const list = Array.isArray(candidates) ? candidates : [candidates];
  for (const pattern of patterns) {
    const re = globToRegExp(pattern);
    for (const cand of list) {
      if (typeof cand !== 'string' || cand.length === 0) continue;
      if (re.test(String(cand).replace(/\\/g, '/'))) return true;
    }
  }
  return false;
}

/** 相对某个根的 a→b 形式（用于 exclude/include 匹配，统一 `/`）。 */
export function relativeTo(target, root, platform = process.platform) {
  const t = canonical(target, platform);
  const r = canonical(root, platform);
  const rel = platform === WIN ? nodePath.win32.relative(r, t) : nodePath.posix.relative(r, t);
  return rel.split(platform === WIN ? '\\' : '/').join('/');
}
