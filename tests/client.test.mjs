/**
 * tests/client.test.mjs —— 浏览器端 bundle 的离线守卫。
 *
 * 为什么要有这一层：这个文件只在浏览器里跑，而本机没有可用的浏览器自动化
 * （无头 Edge 不出图、也点不了按钮）。所以退一步，用 Node 的 vm 造一个最小
 * `window.__ModuleLoader__` + 假 React，把它**真跑一遍**：
 *   - 语法错会在这里炸，而不是等用户打开界面才白屏；
 *   - `inject` / `apply` / slot 注册这些"接线"能被断言，不靠肉眼；
 *   - loader 的 id 必须等于包名，否则浏览器侧永远匹配不上（这条最容易错，且静默）。
 *
 * 它验不到的是"长得好看不好看"和真实布局 —— 那部分只能人眼确认。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { ROUTE_BASE } from '../src/http.mjs';

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const PACKAGE_NAME = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).name;

/** 造一个假 React：只实现这个 bundle 真正用到的那几个钩子。 */
function makeReact() {
  return {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: (initial) => ({ current: initial }),
    useEffect: () => {},
    useCallback: (fn) => fn,
  };
}

/** 在沙箱里执行 lib/client.js，返回 loader 收到的东西。 */
function loadBundle() {
  const React = makeReact();
  const seen = { loads: [] };
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (entry) => {
          seen.loads.push(entry);
        },
      },
    },
    console,
  };
  vm.runInNewContext(SOURCE, sandbox, { filename: 'lib/client.js' });

  assert.equal(seen.loads.length, 1, '应该只有一次 __ModuleLoader__.load 调用');
  const entry = seen.loads[0];
  const require = (id) => {
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime') {
      return { jsx: React.createElement, jsxs: React.createElement, Fragment: React.Fragment };
    }
    throw new Error(`unexpected require: ${id}`);
  };
  return { entry, exports: entry.factory(require) };
}

test('client：loader 的 id 必须等于包名（不等就永远匹配不上，且不报错）', () => {
  const { entry } = loadBundle();
  assert.equal(entry.id, PACKAGE_NAME);
});

test('client：导出 inject 含 slots，apply 是函数', () => {
  const { exports } = loadBundle();
  assert.ok(Array.isArray(exports.inject), 'inject 必须是数组');
  assert.ok(exports.inject.includes('slots'));
  assert.equal(typeof exports.apply, 'function');
});

test('client：apply 把控件挂到 conversation.input.left（自动继续开关那一条）', () => {
  const { exports } = loadBundle();
  const calls = [];
  const ctx = {
    slots: {
      inject: (name, run) => {
        calls.push({ kind: 'inject', name });
        run();
      },
      register: (spec, component) => {
        calls.push({ kind: 'register', spec, component });
        return () => {};
      },
    },
  };
  exports.apply(ctx);

  assert.equal(calls[0].kind, 'inject');
  assert.equal(calls[0].name, 'conversation.input.left');
  assert.equal(calls[1].kind, 'register');
  assert.equal(calls[1].spec.name, 'conversation.input.left');
  assert.equal(calls[1].spec.id, 'multi-workspace');
  assert.equal(typeof calls[1].component, 'function');
});

test('client：拿不到 slots 时静默退出，不抛（客户端异常会白屏，代价太大）', () => {
  const { exports } = loadBundle();
  assert.doesNotThrow(() => exports.apply({}));
  assert.doesNotThrow(() => exports.apply(undefined));
});

test('client：是 classic script，不能出现 ESM 的 import/export', () => {
  assert.doesNotMatch(SOURCE, /^\s*import\s/m, '浏览器按脚本执行，出现 import 会整段失败');
  assert.doesNotMatch(SOURCE, /^\s*export\s/m, '浏览器按脚本执行，出现 export 会整段失败');
});

test('client：请求前缀与服务端路由常量一致（两处各写一遍时最容易漂）', () => {
  assert.equal(ROUTE_BASE, '/plugins/dsh-multi-workspace');
  assert.ok(SOURCE.includes(ROUTE_BASE), `client.js 里应出现 ${ROUTE_BASE}`);
});

test('client：不往 document.body 上贴第二个应用，也不碰别人的 DOM', () => {
  assert.doesNotMatch(SOURCE, /document\.body\s*\.\s*append/, '不允许往 body 追加宿主');
  assert.doesNotMatch(SOURCE, /querySelector/, '不读别的插件的 DOM 来猜位置');
});


test('client：v0.5 的五个新入口都在（否则面板会显示成"只有根"）', () => {
  const src = SOURCE;
  assert.match(src, /\/evaluate/, '缺少试算入口');
  assert.match(src, /\/events/, '缺少被拒记录入口');
  assert.match(src, /\/export/, '缺少导出入口');
  assert.match(src, /\/import/, '缺少导入入口');
  assert.match(src, /scope: 'session'|scope === 'session'/, '缺少临时根作用域');
});

test('client：10 秒轮询 + rev 短路（不然每次轮询都整块重绘，输入框会被打断）', () => {
  const src = SOURCE;
  assert.match(src, /setInterval\([^,]+,\s*10000\)/, '轮询间隔不是 10s');
  assert.match(src, /prev\.rev === next\.rev/, '没有 rev 短路');
});

test('client：三个预设各给一组能力位，且"含删除"是单独的、不默认选中', () => {
  const mod = loadBundle().exports;
  assert.equal(mod.PRESETS.length, 3);
  // 注意：这些数组来自 vm 的另一个 realm，deepEqual 会因为原型不同而失败，所以用 join 比对值。
  const byId = new Map(mod.PRESETS.map((preset) => [preset.id, preset]));
  assert.equal(byId.get('browse').caps.join(','), 'read');
  assert.equal(byId.get('browse').mode, 'ro');
  assert.equal(byId.get('work').caps.join(','), 'read,write,move');
  assert.equal(byId.get('full').caps.join(','), 'read,write,delete,move');
});

test('client：面板上能读的东西不写回配置（撤销按钮只发 op:undo，不重放本地状态）', () => {
  const src = SOURCE;
  assert.match(src, /op: 'undo'/);
  assert.doesNotMatch(src, /localStorage/, '面板不该把规则副本塞进浏览器存储');
});

test('client：第一次打开有引导卡，「?」能把关掉的它重新打开', () => {
  const src = SOURCE;
  assert.match(src, /第一次用？三步就够/, '缺少引导卡标题');
  assert.match(src, /知道了/, '引导卡没有关闭按钮');
  // 三步各自要有具体动作，不能只有标题（新手不知道点哪儿就会一直空转）
  assert.match(src, /加一个根/);
  assert.match(src, /选能力位/);
  assert.match(src, /让 Agent 用它/);
  // 关掉之后必须能找回来，否则等于一次性的免责声明
  assert.match(src, /setShowGuide\(true\)/, '缺少重新打开引导的入口');
  // 引导卡只看过与否是内存状态，不进浏览器存储
  assert.doesNotMatch(src, /localStorage/);
});
