/**
 * lib/client.js —— DSH Web 客户端面板（手写 bundle，不过打包器）。
 *
 * 为什么手写：这个插件的界面只有"一个胶囊 + 一块弹层"，为它引一套构建链
 * （esbuild/vite + 依赖树）代价远大于收益。代价是只能用它依赖的运行时模块：
 *   require('react')                      —— DSH Web 已经提供
 *   require('react-dom/client')           —— 同上
 * 两边都不要，DSH 的加载器会直接报缺依赖。
 *
 * 契约（照 dsh-client-auto-continue / dsh-doc 的 ui-plugin 文档）：
 *   ① package.json: exports["./client"] -> 本文件, dsh.client.platform = 'web'
 *   ② 本文件: window.__ModuleLoader__.load({ id: <包名>, factory })
 *   ③ factory 返回 { inject: ['slots'], apply(ctx) }
 *   ④ apply 里用 ctx.slots.register 把组件挂到 seat 上
 *
 * 三条自我约束（都是踩过的坑）：
 *   - factory 里不放副作用（不要在那里 fetch、不要摸 DOM）
 *   - 不往 document.body 追加第二个 React 根（会和 DSH 抢宿主）
 *   - 不读别人的 DOM 猜位置（用 seat，不按选择器抓节点）
 */

window.__ModuleLoader__.load({
  id: 'dsh-multi-workspace',
  factory: (require) => {
    var module = { exports: {} };
    var React = require('react');
    var h = React.createElement;

    /** 服务端路由前缀：必须与 src/http.mjs 的 ROUTE_BASE 完全一致。 */
    var ROUTE_BASE = '/plugins/dsh-multi-workspace';

    var CAP_ORDER = ['read', 'write', 'delete', 'move'];
    var CAP_LABELS = { read: '读', write: '写', delete: '删', move: '移' };

    /** 三个预设：名字是给人看的，caps 是给 store 的。 */
    var PRESETS = [
      { id: 'browse', label: '只读浏览', caps: ['read'], mode: 'ro', hint: '能看不能改' },
      { id: 'work', label: '项目协作', caps: ['read', 'write', 'move'], mode: 'rw', hint: '日常改代码，不给删' },
      { id: 'full', label: '含删除', caps: ['read', 'write', 'delete', 'move'], mode: 'rw', hint: '危险：删掉就没了' },
    ];

    /** 面板样式。用内联对象而不是外部 CSS —— 少一个注入点，也少一次样式冲突。 */
    var S = {
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        height: '26px',
        padding: '0 9px',
        borderRadius: '13px',
        border: '1px solid var(--dsh-border, rgba(127,127,127,.35))',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      chipOn: { background: 'rgba(80,140,255,.14)', borderColor: 'rgba(80,140,255,.55)' },
      dot: { width: '6px', height: '6px', borderRadius: '3px', background: '#4c8dff', flex: '0 0 auto' },
      panel: {
        position: 'fixed',
        zIndex: 60,
        width: '460px',
        maxWidth: 'calc(100vw - 24px)',
        maxHeight: '68vh',
        overflowY: 'auto',
        padding: '12px',
        borderRadius: '10px',
        border: '1px solid var(--dsh-border, rgba(127,127,127,.35))',
        background: 'var(--dsh-bg-elevated, #1b1c1f)',
        color: 'var(--dsh-fg, #e8e8e8)',
        boxShadow: '0 10px 30px rgba(0,0,0,.45)',
        fontSize: '12px',
        lineHeight: '1.5',
      },
      row: { display: 'flex', alignItems: 'center', gap: '8px' },
      head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' },
      title: { fontSize: '12px', fontWeight: 600, letterSpacing: '.04em', opacity: 0.75 },
      path: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px', wordBreak: 'break-all' },
      card: {
        border: '1px solid var(--dsh-border, rgba(127,127,127,.25))',
        borderRadius: '8px',
        padding: '8px',
        marginBottom: '8px',
      },
      cap: {
        height: '22px',
        minWidth: '26px',
        padding: '0 6px',
        borderRadius: '11px',
        border: '1px solid var(--dsh-border, rgba(127,127,127,.35))',
        background: 'transparent',
        color: 'inherit',
        fontSize: '11px',
        cursor: 'pointer',
      },
      capOn: { background: 'rgba(76,141,255,.2)', borderColor: 'rgba(76,141,255,.7)' },
      btn: {
        height: '24px',
        padding: '0 9px',
        borderRadius: '6px',
        border: '1px solid var(--dsh-border, rgba(127,127,127,.35))',
        background: 'transparent',
        color: 'inherit',
        fontSize: '11px',
        cursor: 'pointer',
        // 悬停/按下靠弹层上的统一事件改 filter，所以这里只需要一条过渡
        transition: 'filter .12s ease, transform .06s ease',
      },
      btnOn: { background: 'rgba(76,141,255,.16)', borderColor: 'rgba(76,141,255,.6)' },
      danger: { color: '#ff8a8a', borderColor: 'rgba(255,120,120,.5)' },
      input: {
        flex: '1 1 auto',
        minWidth: '0',
        height: '26px',
        padding: '0 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsh-border, rgba(127,127,127,.35))',
        background: 'rgba(127,127,127,.08)',
        color: 'inherit',
        font: 'inherit',
        fontSize: '11px',
      },
      area: {
        width: '100%',
        minHeight: '54px',
        padding: '6px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsh-border, rgba(127,127,127,.35))',
        background: 'rgba(127,127,127,.08)',
        color: 'inherit',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '11px',
        resize: 'vertical',
      },
      muted: { opacity: 0.6, fontSize: '11px' },
      // 引导卡片：编号圆点 + 两行说明
      step: { display: 'flex', gap: '8px', marginBottom: '6px' },
      stepNo: {
        flex: '0 0 auto',
        width: '16px',
        height: '16px',
        borderRadius: '8px',
        background: 'rgba(76,141,255,.25)',
        textAlign: 'center',
        fontSize: '10px',
        lineHeight: '16px',
      },
      ok: { color: '#79d297' },
      bad: { color: '#ff8a8a' },
      sep: { height: '1px', background: 'var(--dsh-border, rgba(127,127,127,.25))', margin: '10px 0' },
      tag: {
        padding: '0 5px',
        borderRadius: '4px',
        border: '1px solid rgba(127,127,127,.4)',
        fontSize: '10px',
        opacity: 0.8,
      },
    };

    /** 统一的后端调用：任何失败都变成可读的 { ok:false, code, message }。 */
    function callApi(path, body) {
      var init = { credentials: 'same-origin', headers: {} };
      if (body === undefined) {
        init.method = 'GET';
      } else {
        init.method = 'POST';
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      return fetch(ROUTE_BASE + path, init).then(
        function (res) {
          return res.text().then(function (text) {
            var data = null;
            try {
              data = text ? JSON.parse(text) : null;
            } catch (e) {
              data = null;
            }
            if (!res.ok) {
              var code = (data && data.code) || 'HTTP_' + res.status;
              return {
                ok: false,
                code: code,
                message: (data && data.message) || hintFor(code) || '请求失败（HTTP ' + res.status + '）',
                hint: hintFor(code),
              };
            }
            return data || { ok: true };
          });
        },
        function (err) {
          return { ok: false, code: 'NETWORK', message: String((err && err.message) || err) };
        },
      );
    }

    /**
     * 把错误码翻译成"下一步做什么"。
     *
     * 这里最要紧的一条是 404：它**不代表插件坏了**，而是节点侧没加载
     * （客户端 bundle 与节点侧是两条独立的加载链）。不写清楚，用户只会看到
     * 一句 HTTP 404 然后以为面板废了。
     */
    function hintFor(code) {
      var c = String(code || '');
      if (c === 'HTTP_404' || c === 'HTTP_405') {
        return '服务端路由没挂上：插件的节点侧没有加载（改完必须重启 DSH）。验证命令：curl http://127.0.0.1:<端口>/plugins/dsh-multi-workspace/state';
      }
      if (c === 'NETWORK') return '连不上本机服务：DSH 可能正在重启，稍后点「刷新」。';
      if (c === 'SESSION_UNAVAILABLE') return '拿不到当前会话 id，所以临时根用不了；持久根不受影响。';
      if (c === 'POLICY_UNAVAILABLE') return '这个 DSH 版本没有开放 registerWritableRoot，临时根用不了。';
      if (c === 'APPROVAL_UNAVAILABLE') return '没有可用的审批器：写配置被 fail-closed 拒绝（这是安全设计）。';
      return '';
    }

    function shorten(text, max) {
      var value = String(text || '');
      return value.length > max ? '…' + value.slice(value.length - max + 1) : value;
    }

    function capsOf(root) {
      var caps = (root && (root.caps || root.capabilities)) || [];
      return Array.isArray(caps) ? caps.slice() : [];
    }

    /**
     * 输入框左下角的小胶囊 + 点开的弹层。
     *
     * props.sessionId 由 DSH 的 slot 注入（这就是"临时根只对这一场生效"的抓手）。
     */
    function RootsControl(props) {
      var sessionId = (props && (props.sessionId || props.session)) || '';
      var anchorRef = React.useRef(null);
      var timerRef = React.useRef(null);

      var stateHook = React.useState(null);
      var state = stateHook[0];
      var setState = stateHook[1];

      var openHook = React.useState(false);
      var open = openHook[0];
      var setOpen = openHook[1];

      var posHook = React.useState({ left: 12, bottom: 48 });
      var pos = posHook[0];
      var setPos = posHook[1];

      var tabHook = React.useState('roots');
      var tab = tabHook[0];
      var setTab = tabHook[1];

      var scopeHook = React.useState('persistent');
      var scope = scopeHook[0];
      var setScope = scopeHook[1];

      var draftHook = React.useState('');
      var draft = draftHook[0];
      var setDraft = draftHook[1];

      // 新根的能力位：默认只给「读 + 写」。
      // 之前 addRoot 根本不发 caps，服务端就按「四个能力全给」建档 ——
      // 于是界面上明明只选了读/写，实际却拿到了删除和移动。这里必须显式带上。
      var newCapsHook = React.useState(['read', 'write']);
      var newCaps = newCapsHook[0];
      var setNewCaps = newCapsHook[1];

      var msgHook = React.useState(null);
      var msg = msgHook[0];
      var setMsg = msgHook[1];

      var eventsHook = React.useState([]);
      var events = eventsHook[0];
      var setEvents = eventsHook[1];

      var evalHook = React.useState('{"toolName":"write","args":{"file_path":"D:\\\\work\\\\demo.txt"}}');
      var evalText = evalHook[0];
      var setEvalText = evalHook[1];

      var evalResultHook = React.useState(null);
      var evalResult = evalResultHook[0];
      var setEvalResult = evalResultHook[1];

      var importHook = React.useState('');
      var importText = importHook[0];
      var setImportText = importHook[1];

      // 第一次打开时显示引导卡。只用内存里的状态记住"看过了"，
      // 不写浏览器本地存储 —— 面板不把规则副本塞进浏览器（tests/client.test.mjs 锁着这条）。
      // 顶部那个「?」随时能再打开。
      var guideHook = React.useState(true);
      var showGuide = guideHook[0];
      var setShowGuide = guideHook[1];

      var busyHook = React.useState(false);
      var busy = busyHook[0];
      var setBusy = busyHook[1];

      /** 拉一次状态。rev 没变就复用旧对象，避免每 10 秒把整块面板重绘一次。 */
      var refresh = React.useCallback(
        function (force) {
          var qs = sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : '';
          return callApi('/state' + qs).then(function (next) {
            if (!next || next.ok === false) {
              if (force) setMsg({ kind: 'bad', text: (next && next.message) || '读不到规则' });
              return next;
            }
            setState(function (prev) {
              if (
                !force &&
                prev &&
                prev.rev === next.rev &&
                (prev.sessionRoots || []).length === (next.sessionRoots || []).length
              ) {
                return prev;
              }
              return next;
            });
            return next;
          });
        },
        [sessionId],
      );

      React.useEffect(function () {
        refresh(true);
        timerRef.current = setInterval(function () {
          refresh(false);
        }, 10000);
        return function () {
          if (timerRef.current) clearInterval(timerRef.current);
          timerRef.current = null;
        };
      }, [refresh]);

      /** 弹层位置：相对胶囊算，不要写死坐标。 */
      var place = React.useCallback(function () {
        var node = anchorRef.current;
        if (!node || typeof node.getBoundingClientRect !== 'function') return;
        var box = node.getBoundingClientRect();
        var width = 460;
        var left = Math.max(12, Math.min(box.left, (window.innerWidth || width) - width - 12));
        setPos({ left: left, bottom: Math.max(12, (window.innerHeight || 800) - box.top + 10) });
      }, []);

      var roots = (state && state.roots) || [];
      var sessionRoots = (state && state.sessionRoots) || [];
      var total = roots.length + sessionRoots.length;
      var limits = (state && state.limits) || {};

      function withBusy(promise) {
        setBusy(true);
        setMsg(null);
        return promise.then(function (result) {
          setBusy(false);
          if (result && result.ok === false) {
            setMsg({ kind: 'bad', text: '[' + result.code + '] ' + result.message });
          } else if (result) {
            // 「保存成功」有两种落点：写进 profile 配置（重启后还算数），
            // 或写进兜底文件（configEditor 不在时的退路）。必须让用户看见是哪一种。
            var where = result.via === 'file' ? '（已写入兜底文件 .dsh/multi-workspace-rules.json）' : '';
            setMsg({ kind: 'ok', text: (result.message || result.code || '完成') + where });
          }
          return refresh(true);
        });
      }

      function sendRoots(payload) {
        return withBusy(callApi('/roots', payload));
      }

      function addRoot() {
        var value = draft.trim();
        if (value === '') return;
        var payload = { op: 'add', path: value, scope: scope, caps: newCaps.slice() };
        if (scope === 'session') payload.sessionId = sessionId;
        setDraft('');
        sendRoots(payload);
      }

      function removeRoot(root) {
        var payload = { op: 'remove', path: root.path, scope: root.scope === 'session' ? 'session' : 'persistent' };
        if (payload.scope === 'session') payload.sessionId = sessionId;
        sendRoots(payload);
      }

      function toggleCap(root, cap) {
        var caps = capsOf(root);
        var at = caps.indexOf(cap);
        if (at >= 0) caps.splice(at, 1);
        else caps.push(cap);
        if (caps.length === 0) caps = ['read'];
        var payload = { op: 'update', path: root.path, caps: caps };
        if (root.scope === 'session') {
          setMsg({ kind: 'bad', text: '临时根的能力位不能原地改：先移除，再加一次' });
          return;
        }
        sendRoots(payload);
      }

      function toggleMode(root) {
        sendRoots({ op: 'update', path: root.path, mode: root.mode === 'ro' ? 'rw' : 'ro' });
      }

      function applyPreset(root, preset) {
        sendRoots({ op: 'update', path: root.path, caps: preset.caps, mode: preset.mode });
      }

      function undo() {
        sendRoots({ op: 'undo' });
      }

      function loadEvents() {
        withBusy(
          callApi('/events?limit=8').then(function (data) {
            setEvents((data && data.items) || []);
            return { ok: true, message: '已刷新最近记录' };
          }),
        );
      }

      function exportDoc() {
        setBusy(true);
        callApi('/export').then(function (data) {
          setBusy(false);
          if (!data || data.ok === false) {
            setMsg({ kind: 'bad', text: (data && data.message) || '导出失败' });
            return;
          }
          setImportText(data.json || '');
          setMsg({ kind: 'ok', text: '已导出到下面的文本框，可复制保存' });
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(data.json || '').catch(function () {});
          }
        });
      }

      function importDoc() {
        var text = importText.trim();
        if (text === '') return;
        withBusy(callApi('/import', { json: text }));
      }

      function runEvaluate() {
        setBusy(true);
        setEvalResult(null);
        callApi('/evaluate', { args: evalText }).then(function (data) {
          setBusy(false);
          if (!data || data.ok === false) {
            setEvalResult({ ok: false, code: (data && data.code) || 'FAILED', message: (data && data.message) || '试算失败' });
            return;
          }
          setEvalResult(data.result || null);
        });
      }

      function renderCapRow(root) {
        var caps = capsOf(root);
        return h(
          'div',
          { style: S.row },
          CAP_ORDER.map(function (cap) {
            var on = caps.indexOf(cap) >= 0;
            return h(
              'button',
              {
                key: cap,
                type: 'button',
                title: cap + (on ? '：已允许' : '：不允许'),
                style: Object.assign({}, S.cap, on ? S.capOn : {}),
                onClick: function () {
                  toggleCap(root, cap);
                },
              },
              CAP_LABELS[cap],
            );
          }),
          h('span', { style: { flex: '1 1 auto' } }),
          root.mode === 'ro'
            ? h('span', { style: S.tag }, '只读根')
            : null,
          root.scope === 'session' ? h('span', { style: S.tag }, '临时') : null,
        );
      }

      function renderRoot(root, index) {
        return h(
          'div',
          { key: (root.key || root.path) + ':' + index, style: S.card },
          h(
            'div',
            { style: Object.assign({}, S.row, { marginBottom: '6px' }) },
            h('span', { style: S.path, title: root.path }, shorten(root.path, 46)),
            h('span', { style: { flex: '1 1 auto' } }),
            h(
              'button',
              {
                type: 'button',
                style: S.btn,
                title: '改这一条根的可写/只读',
                onClick: function () {
                  toggleMode(root);
                },
              },
              root.mode === 'ro' ? '改为可写' : '改为只读',
            ),
            h(
              'button',
              {
                type: 'button',
                style: Object.assign({}, S.btn, S.danger),
                title: '从规则里移除',
                onClick: function () {
                  removeRoot(root);
                },
              },
              '移除',
            ),
          ),
          renderCapRow(root),
          root.scope === 'session'
            ? null
            : h(
                'div',
                { style: Object.assign({}, S.row, { marginTop: '6px', flexWrap: 'wrap' }) },
                h('span', { style: S.muted }, '套用预设'),
                PRESETS.map(function (preset) {
                  return h(
                    'button',
                    {
                      key: preset.id,
                      type: 'button',
                      style: S.btn,
                      title: preset.hint,
                      onClick: function () {
                        applyPreset(root, preset);
                      },
                    },
                    preset.label,
                  );
                }),
              ),
        );
      }

      /**
       * 第一次使用的引导卡。
       * 设计取舍：不写浏览器本地存储（面板不保存规则副本），所以每次刷新页面会再出现一次；
       * 用「知道了」关掉，顶部「?」可以随时重开。
       */
      function renderGuide() {
        function line(no, title, body) {
          return h(
            'div',
            { style: S.step },
            h('span', { style: S.stepNo }, no),
            h(
              'div',
              null,
              h('div', { style: { fontWeight: 600 } }, title),
              h('div', { style: S.muted }, body),
            ),
          );
        }
        return h(
          'div',
          { style: Object.assign({}, S.card, { background: 'rgba(76,141,255,.07)' }) },
          h(
            'div',
            { style: S.head },
            h('span', { style: { fontWeight: 600 } }, '第一次用？三步就够'),
            h(
              'button',
              { type: 'button', style: S.btn, onClick: function () { setShowGuide(false); } },
              '知道了',
            ),
          ),
          line('1', '加一个根', '点「加持久根」，填目录绝对路径，回车或点「添加」。它写进 profile 配置，重启后还在。'),
          line('2', '选能力位', '输入框下面那排「读 / 写 / 删 / 移」就是权限。默认只给读+写；真要删文件才勾「删」。'),
          line('3', '让 Agent 用它', '直接对 Agent 说「往这个目录写文件」。被拒时去「工具」页签做一次试算，看是哪一步拦下的。'),
          h('div', { style: S.sep }),
          h(
            'div',
            { style: S.muted },
            '两个容易踩的点：① 会话里的 pwsh / bash 不认额外根，只有文件工具认；② 「撤销」最多回 5 步。',
          ),
        );
      }

      function renderRootsTab() {
        return h(
          'div',
          null,
          h('div', { style: Object.assign({}, S.row, { marginBottom: '8px' }) },
            h('span', { style: S.title }, '持久根'),
            h('span', { style: S.muted }, roots.length + ' 条'),
          ),
          roots.length === 0
            ? h('div', { style: S.muted }, '还没有登记任何持久根。在下面输入一个绝对路径添加。')
            : roots.map(renderRoot),
          h('div', { style: S.sep }),
          h('div', { style: Object.assign({}, S.row, { marginBottom: '8px' }) },
            h('span', { style: S.title }, '本次会话的临时根'),
            h('span', { style: S.muted }, sessionRoots.length + ' 条'),
          ),
          sessionRoots.length === 0
            ? h('div', { style: S.muted }, '没有临时根。临时根不写配置、不重启就没了，也不传给子 agent。')
            : sessionRoots.map(renderRoot),
          h('div', { style: S.sep }),
          h(
            'div',
            { style: S.row },
            h(
              'button',
              {
                type: 'button',
                style: Object.assign({}, S.btn, scope === 'persistent' ? S.btnOn : {}),
                onClick: function () {
                  setScope('persistent');
                },
              },
              '加持久根',
            ),
            h(
              'button',
              {
                type: 'button',
                style: Object.assign({}, S.btn, scope === 'session' ? S.btnOn : {}),
                title: '只对这一场会话生效',
                onClick: function () {
                  setScope('session');
                },
              },
              '加临时根',
            ),
            h('span', { style: { flex: '1 1 auto' } }),
            h('button', { type: 'button', style: S.btn, onClick: undo }, '撤销'),
          ),
          h(
            'div',
            { style: Object.assign({}, S.row, { marginTop: '8px' }) },
            h('input', {
              style: S.input,
              placeholder: '绝对路径，例如 D:\\work\\proj-a',
              value: draft,
              onChange: function (e) {
                setDraft(e.target.value);
              },
              onKeyDown: function (e) {
                if (e.key === 'Enter') addRoot();
              },
            }),
            h('button', { type: 'button', style: S.btn, onClick: addRoot }, '添加'),
          ),
          h(
            'div',
            { style: Object.assign({}, S.row, { marginTop: '6px' }) },
            h('span', { style: S.muted }, '新根能力位：'),
            CAP_ORDER.map(function (cap) {
              var on = newCaps.indexOf(cap) >= 0;
              return h(
                'button',
                {
                  type: 'button',
                  key: 'new-' + cap,
                  title: '点一下切换「' + CAP_LABELS[cap] + '」',
                  style: Object.assign({}, S.cap, on ? S.capOn : {}),
                  onClick: function () {
                    setNewCaps(function (prev) {
                      var next = prev.slice();
                      var at = next.indexOf(cap);
                      if (at >= 0) next.splice(at, 1);
                      else next.push(cap);
                      // 一个能力位都不给等于"加了个看不见的根"，退回只读。
                      return next.length === 0 ? ['read'] : next;
                    });
                  },
                },
                CAP_LABELS[cap],
              );
            }),
            h('button', { type: 'button', style: S.btn, title: '清空', onClick: function () { setNewCaps(['read']); } }, '只读'),
          ),
          h('div', { style: S.muted }, scope === 'session' ? '（当前：临时根，回车添加）' : '（当前：持久根，写进 profile 配置）'),
        );
      }

      function renderToolsTab() {
        return h(
          'div',
          null,
          h('div', { style: S.title }, '试算：这条调用会被放行吗'),
          h(
            'div',
            { style: { marginTop: '6px' } },
            h('textarea', {
              style: S.area,
              value: evalText,
              onChange: function (e) {
                setEvalText(e.target.value);
              },
            }),
            h(
              'div',
              { style: Object.assign({}, S.row, { marginTop: '6px' }) },
              h('button', { type: 'button', style: S.btn, onClick: runEvaluate }, '试算'),
              h('span', { style: S.muted }, '不真的执行，只按当前规则判一次'),
            ),
            evalResult
              ? h(
                  'div',
                  { style: { marginTop: '6px', color: evalResult.decision === 'allow' ? '#79d297' : '#ff8a8a' } },
                  (evalResult.decision === 'allow' ? '放行' : '拒绝') + ' · ' + (evalResult.code || '') + ' · ' + (evalResult.reason || ''),
                )
              : null,
          ),
          h('div', { style: S.sep }),
          h('div', { style: S.title }, '最近 8 条面板操作 / 被拒记录'),
          h(
            'div',
            { style: Object.assign({}, S.row, { marginTop: '6px' }) },
            h('button', { type: 'button', style: S.btn, onClick: loadEvents }, '刷新记录'),
            h('span', { style: S.muted }, events.length + ' 条'),
          ),
          events.map(function (item, i) {
            return h(
              'div',
              { key: 'ev' + i, style: Object.assign({}, S.muted, { marginTop: '4px' }) },
              String(item.code || '') + ' · ' + String(item.path || '') + ' · ' + String(item.at || ''),
            );
          }),
          h('div', { style: S.sep }),
          h('div', { style: S.title }, '导出 / 导入规则'),
          h(
            'div',
            { style: Object.assign({}, S.row, { marginTop: '6px' }) },
            h('button', { type: 'button', style: S.btn, onClick: exportDoc }, '导出到下面'),
            h('button', { type: 'button', style: S.btn, onClick: importDoc }, '导入这段'),
          ),
          h('textarea', {
            style: Object.assign({}, S.area, { marginTop: '6px', minHeight: '72px' }),
            placeholder: '{"version":2,"roots":[...]}',
            value: importText,
            onChange: function (e) {
              setImportText(e.target.value);
            },
          }),
        );
      }

      var chipStyle = Object.assign({}, S.chip, open || total > 0 ? S.chipOn : {});
      var badge = total > 0 ? String(total) : '0';
      var chipLabel = '根 ' + badge;

      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center' } },
        h(
          'button',
          {
            type: 'button',
            style: chipStyle,
            title: '活动文件范围（点开管理）',
            ref: anchorRef,
            onClick: function () {
              place();
              setOpen(!open);
            },
          },
          h('span', { style: S.dot }),
          chipLabel,
        ),
        open
          ? h(
              'div',
              {
                style: Object.assign({}, S.panel, {
                  left: pos.left + 'px',
                  bottom: pos.bottom + 'px',
                  pointerEvents: busy ? 'none' : 'auto',
                  opacity: busy ? 0.7 : 1,
                }),
                role: 'dialog',
                // 统一交互反馈：鼠标进入按钮变亮、按下轻微下沉。
                // 放在容器上而不是每个按钮上 —— 少写 10 处，也不会漏掉新按钮。
                onMouseOver: function (e) {
                  var el = e.target;
                  if (el && el.tagName === 'BUTTON' && !el.disabled) el.style.filter = 'brightness(1.4)';
                },
                onMouseOut: function (e) {
                  var el = e.target;
                  if (el && el.tagName === 'BUTTON') el.style.filter = '';
                },
                onMouseDown: function (e) {
                  var el = e.target;
                  if (el && el.tagName === 'BUTTON' && !el.disabled) el.style.transform = 'translateY(1px)';
                },
                onMouseUp: function (e) {
                  var el = e.target;
                  if (el && el.tagName === 'BUTTON') el.style.transform = '';
                },
              },
              h(
                'div',
                { style: S.head },
                h(
                  'div',
                  { style: S.row },
                  h('span', { style: S.title }, '活动文件范围'),
                  h(
                    'button',
                    { type: 'button', style: Object.assign({}, S.btn, tab === 'roots' ? S.btnOn : {}), onClick: function () { setTab('roots'); } },
                    '根',
                  ),
                  h(
                    'button',
                    { type: 'button', style: Object.assign({}, S.btn, tab === 'tools' ? S.btnOn : {}), onClick: function () { setTab('tools'); } },
                    '工具',
                  ),
                ),
                h(
                  'div',
                  { style: S.row },
                  h(
                    'button',
                    { type: 'button', style: S.btn, title: '重新读取', onClick: function () { refresh(true); } },
                    '刷新',
                  ),
                  // 随时能重看一遍三步引导
                  h('button', { type: 'button', style: S.btn, title: '看一遍使用说明', onClick: function () { setShowGuide(true); } }, '?'),
                  h('button', { type: 'button', style: S.btn, onClick: function () { setOpen(false); } }, '关'),
                ),
              ),
              msg
                ? h(
                    'div',
                    { style: { marginBottom: '8px' } },
                    h('div', { style: { color: msg.kind === 'ok' ? '#79d297' : '#ff8a8a' } }, msg.text),
                    msg.hint
                      ? h('div', { style: Object.assign({}, S.muted, { marginTop: '2px', lineHeight: '1.5' }) }, msg.hint)
                      : null,
                  )
                : null,
              showGuide ? renderGuide() : null,
              busy ? h('div', { style: S.muted }, '处理中…') : null,
              tab === 'roots' ? renderRootsTab() : renderToolsTab(),
              h('div', { style: S.sep }),
              h('div', { style: S.muted }, limits.sessionRoots || ''),
              h('div', { style: S.muted }, limits.shellTools || ''),
              h('div', { style: S.muted }, limits.readTools || ''),
            )
          : null,
      );
    }

    var inject = ['slots'];

    function apply(ctx) {
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return;
      ctx.slots.inject('conversation.input.left', function () {
        return ctx.slots.register({ name: 'conversation.input.left', id: 'multi-workspace' }, RootsControl);
      });
    }

    module.exports.inject = inject;
    module.exports.apply = apply;
    module.exports.RootsControl = RootsControl;
    module.exports.PRESETS = PRESETS;
    module.exports.ROUTE_BASE = ROUTE_BASE;
    return module.exports;
  },
});
