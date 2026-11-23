/**
 * src/doctor.mjs —— 不启动 DSH 也能跑的「为什么它不像在生效」体检。
 *
 * 背景：这个插件最隐蔽的失效方式不是抛异常，而是**根本没被加载**。
 * 例如仓库目录改名后，profile 里 `link:` 与 node_modules 下的 junction
 * 仍指向旧路径：DSH 启动时按 bundle 名解析失败，静默跳过整个插件 ——
 * 守卫不注册、路由不挂载、面板却可能还渲染着。in-plugin 的 doctorReport()
 * 在那种情况下根本不会执行，所以需要一份「只看磁盘」的体检。
 *
 * 设计约束：
 *   - 纯函数 + 注入 fs，便于测试时不碰真实 profile；
 *   - 每个问题都带 code / message / fix 三段，fix 是能照做的下一步；
 *   - 只读，绝不修改任何文件。
 */

import path from 'node:path';

const ROW_ID = 'dsh-multi-workspace';
const PKG_NAME = 'dsh-multi-workspace';

/** 小工具：安全读文本。 */
function readText(fs, file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 从 package.json 里取依赖声明（可能是 link:<路径> 或版本号）。 */
export function depSpec(profilePkg, name = PKG_NAME) {
  const deps = profilePkg?.dependencies ?? {};
  return typeof deps[name] === 'string' ? deps[name] : null;
}

/** 从 `link:C:/x/y` 里取出路径；不是 link: 协议时返回 null。 */
export function linkTarget(spec) {
  if (typeof spec !== 'string') return null;
  const match = /^link:(.+)$/.exec(spec.trim());
  return match ? match[1] : null;
}

/** 解析 profile 的 cordis.patch.yml 里有没有这个插件的配置行。 */
export function hasConfigRow(text, rowId = ROW_ID) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return new RegExp(`^\\s*-?\\s*id:\\s*["']?${rowId}["']?\\s*$`, 'm').test(text);
}

/** 读 load-trace 的最后一条指定事件时间。 */
export function lastTraceAt(text, events = ['registered', 'apply-enter']) {
  if (typeof text !== 'string' || text.length === 0) return null;
  let latest = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!events.includes(row?.event)) continue;
    const at = typeof row.at === 'string' ? row.at : null;
    if (at && (latest === null || Date.parse(at) > Date.parse(latest))) latest = at;
  }
  return latest;
}

/**
 * 执行体检。
 * @param {object} options
 * @param {string} options.profileDir   例如 C:/Users/x/.dsh/profiles/desktop
 * @param {string} options.packageDir   插件包目录（本仓库）
 * @param {object} options.fs           node:fs（测试可注入）
 * @returns {{ok:boolean, problems:Array<{code:string,message:string,fix:string}>, info:object}}
 */
export function diagnose({ profileDir, packageDir, fs }) {
  const problems = [];
  const info = {};
  const add = (code, message, fix) => problems.push({ code, message, fix });

  /* 1. profile 与依赖声明 */
  const profilePkgPath = path.join(profileDir, 'package.json');
  const profilePkgText = readText(fs, profilePkgPath);
  if (profilePkgText === null) {
    add('PROFILE_MISSING', `找不到 profile 的 package.json：${profilePkgPath}`,
      '确认 --profile 名字（目录在 ~/.dsh/profiles/<名>/），或用 dsh plugin --profile <名> add 重新装一次。');
  } else {
    let profilePkg = null;
    try {
      profilePkg = JSON.parse(profilePkgText);
    } catch {
      add('PROFILE_UNREADABLE', `profile 的 package.json 不是合法 JSON：${profilePkgPath}`,
        '手工改过 JSON 的话先修好语法；不确定就用备份覆盖回去。');
    }
    const spec = depSpec(profilePkg);
    info.dep = spec;
    if (!spec) {
      add('DEP_MISSING', `profile 的 dependencies 里没有 ${PKG_NAME}`,
        `dsh plugin --profile <名> add ${PKG_NAME}（或在 package.json 里加一行 link:<本仓库绝对路径>）。`);
    }

    /* 2. bundles 里有没有登记 */
    const bundles = profilePkg?.dsh?.profile?.bundles;
    info.bundlesListed = Array.isArray(bundles) ? bundles.includes(PKG_NAME) : false;
    if (Array.isArray(bundles) && !info.bundlesListed) {
      add('BUNDLE_NOT_LISTED', `dependencies 里有它，但 dsh.profile.bundles 没登记 ${PKG_NAME}`,
        `把 "${PKG_NAME}" 加进 profile package.json 的 dsh.profile.bundles，然后重启 DSH。`);
    }

    /* 3. node_modules 下的链接是否解析得开 —— 这就是「莫名其妙失效」最常见的原因 */
    const installed = path.join(profileDir, 'node_modules', PKG_NAME);
    let lstat = null;
    try {
      lstat = fs.lstatSync(installed);
    } catch {
      lstat = null;
    }
    info.installedIsLink = lstat ? Boolean(lstat.isSymbolicLink?.()) : false;
    let real = null;
    try {
      real = fs.realpathSync(installed);
    } catch {
      real = null;
    }
    info.resolvedTo = real;
    if (!lstat) {
      add('INSTALLED_MISSING', `profile 的 node_modules 里没有 ${PKG_NAME}`,
        `装一次即可：dsh plugin --profile <名> add ${PKG_NAME}；本地开发则用 mklink /J 指向本仓库。`);
    } else if (!real) {
      const target = linkTarget(spec) ?? '未知目标';
      add('LINK_BROKEN', `node_modules/${PKG_NAME} 指向的目录不存在：${target}`,
        `这是「插件明明装了却没动静」的头号原因。把链接重指到现有路径：`
        + `cmd /c rmdir node_modules\\${PKG_NAME} 然后 cmd /c mklink /J node_modules\\${PKG_NAME} "<仓库绝对路径>"，同时改 package.json 里那行 link:。`);
    }
  }

  /* 4. profile 的补丁行：没有它规则只能落文件（persistVia=file） */
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  const patchText = readText(fs, patchPath);
  info.hasConfigRow = hasConfigRow(patchText);
  if (patchText !== null && !info.hasConfigRow) {
    add('NO_CONFIG_ROW', `profile 的 cordis.patch.yml 里没有 "- id: ${ROW_ID}" 这一行`,
      '规则会退回到插件目录下的 .dsh/multi-workspace-rules.json（persistVia=file）。'
      + '这不算坏，但换 profile 或重装插件后规则就“看起来丢了”；想要跟 profile 走，就加上这一行。');
  }

  /* 5. 规则与审计文件 */
  const rulesPath = path.join(packageDir, '.dsh', 'multi-workspace-rules.json');
  const rulesText = readText(fs, rulesPath);
  let roots = null;
  if (rulesText === null) {
    add('RULES_MISSING', `还没生成规则文件：${rulesPath}`,
      '插件至少成功启动过一次才会写它。若同时有 LINK_BROKEN，先修链接再重启。');
  } else {
    try {
      const doc = JSON.parse(rulesText);
      roots = Array.isArray(doc.roots) ? doc.roots.length : 0;
      info.roots = roots;
      info.sensitiveRules = Array.isArray(doc?.sensitive?.deny) ? doc.sensitive.deny.length : 0;
    } catch {
      add('RULES_UNREADABLE', `规则文件不是合法 JSON：${rulesPath}`,
        '用 workspace_roots export 的备份恢复，或直接删掉让它重新生成（会丢现有 roots）。');
    }
  }
  if (roots === 0) {
    add('ROOTS_EMPTY', '当前有 0 条附加根 —— 写入其它目录会被拒，看起来就像“插件没生效”',
      '用 workspace_roots add 或者在面板里加一个根；DSH 重启后要从 additionalWritableRoots 里恢复，也依赖这份规则。');
  }

  const auditPath = path.join(packageDir, '.dsh', 'multi-workspace-audit.jsonl');
  const auditText = readText(fs, auditPath);
  info.auditBytes = auditText === null ? 0 : Buffer.byteLength(auditText, 'utf8');
  if (auditText === null) {
    add('AUDIT_MISSING', `还没有审计日志：${auditPath}`,
      '审计只在插件真的跑起来后才会写；先解决加载问题。');
  }

  /* 6. 加载轨迹：比源码还旧 = 改了没重启 / 没被加载 */
  const tracePath = path.join(packageDir, '.dsh', 'load-trace.log');
  const traceText = readText(fs, tracePath);
  const lastAt = lastTraceAt(traceText);
  info.lastActivationAt = lastAt;
  const entry = path.join(packageDir, 'src', 'index.mjs');
  const entryMtime = (() => {
    try {
      return fs.statSync(entry).mtimeMs;
    } catch {
      return null;
    }
  })();
  info.entryMtime = entryMtime === null ? null : new Date(entryMtime).toISOString();
  if (lastAt === null) {
    add('NEVER_ACTIVATED', '加载轨迹里没有一次 registered / apply-enter —— 它从来没真正启动过',
      '先按上面的 LINK_BROKEN / DEP_MISSING 修好，再完整重启 DSH（不是刷新页面）。');
  } else if (entryMtime !== null && entryMtime > Date.parse(lastAt)) {
    add('TRACE_STALE', `源码改过（${info.entryMtime}）但之后没有新的加载记录（最后一次 ${lastAt}）`,
      'DSH 在启动时解析插件，改完要重启桌面版；只刷新页面不会重新加载。');
  }

  return { ok: problems.length === 0, problems, info };
}

/** 把报告渲染成人话（CLI 和测试都用它）。 */
export function render(report) {
  const lines = [];
  const { ok, problems, info } = report;
  lines.push(ok ? '体检通过：磁盘上看不出会让它失效的问题。' : `体检发现 ${problems.length} 个问题：`);
  for (const [index, item] of problems.entries()) {
    lines.push('');
    lines.push(`${index + 1}. [${item.code}] ${item.message}`);
    lines.push(`   → ${item.fix}`);
  }
  lines.push('');
  lines.push('— 事实 —');
  lines.push(`  依赖声明 : ${info.dep ?? '（无）'}`);
  lines.push(`  bundles  : ${info.bundlesListed ? '已登记' : '未登记'}`);
  lines.push(`  解析到   : ${info.resolvedTo ?? '（解析失败）'}`);
  lines.push(`  配置行   : ${info.hasConfigRow ? '有' : '没有（persistVia=file）'}`);
  lines.push(`  附加根   : ${info.roots ?? '未知'}`);
  lines.push(`  审计     : ${info.auditBytes} 字节`);
  lines.push(`  最后加载 : ${info.lastActivationAt ?? '（从未）'}`);
  return lines.join('\n');
}
