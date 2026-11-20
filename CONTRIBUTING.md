# 贡献指南 · Contributing

感谢你愿意花时间。这个项目很小，但边界很硬：**一个绕过守卫的 PR 比一个功能 PR 更值得警惕**。

Thanks for helping. The project is small, but the boundaries are strict: **a PR that bypasses a guard is worse than no PR at all**.

---

## 1. 先跑一遍，再改 · Run before you change

```bash
node --version          # 需要 >= 24.9.0
npm test                # node tests/run-all.mjs，当前 205 条，必须全绿
npm run check           # 测试 + node scripts/load-check.mjs（真调 apply()）
node scripts/route-probe.mjs   # 假 ctx 跑一遍 6 条 HTTP 路由的注册
```

三条命令都在仓库根目录跑。**不要**用 `node --test`：在 DSH 的 workspace-write 沙箱里它会 `spawn EPERM`，报 `tests 1 / fail 1`，看着像实现坏了，其实一条用例都没执行。

> If you are running inside DSH's sandbox, use `node tests/run-all.mjs` — `node --test` spawns a child process per file and fails with `spawn EPERM`.

## 2. 代码地图 · Where things live

| 路径 | 职责 | Responsibility |
| --- | --- | --- |
| `src/rules.mjs` | 判定（7 步顺序、能力位、敏感名单、glob） | the decision function |
| `src/guard.mjs` | 把工具调用翻译成判定输入 | tool-call → decision input |
| `src/index.mjs` | Cordis 插件入口：守卫、工具、路由、会话根 | plugin entry |
| `src/store.mjs` | 规则文档的读写、撤销栈、导入导出 | rule persistence |
| `src/http.mjs` | `/plugins/dsh-multi-workspace/*` 六条路由 | panel API |
| `lib/client.js` | 浏览器端面板（手写，不打包） | the panel |
| `tests/*.test.mjs` | 205 条守卫 | the guards |

改 `src/` 里任何判断逻辑，**必须**同时改 `tests/`；只改实现不改测试会被拒。

## 3. 提交信息 · Commit messages

```
<type>: <一句话，中文或英文都行>

可选正文：为什么这么改，而不是改了什么。
```

`type` 用 `feat` / `fix` / `test` / `docs` / `chore` / `refactor`。示例：

```
fix: 面板加根时补发 caps，避免服务端按四能力位建档
docs: README 首屏改双语 + 加面板截图
```

## 4. 什么会被拒 · What gets rejected

- 绕过 `tests/` 里已有的断言（改断言之前，先说清是**断言过时**还是**实现退化**）；
- 在 `lib/client.js` 里用 `import` / `export`（它必须是 `window.__ModuleLoader__` 的工厂函数，无构建）；
- 往浏览器 `localStorage` 写规则副本（规则只有一个来源：服务端）；
- 新增加运行时依赖（当前是**零依赖**，只用 `node:` 内置模块）；
- 改 `cordis.patch.yml` 的行 `id` 而不同步 `DEFAULT_ROW_ID` —— 会让 `configEditor.edit` 报 `Configuration entry is no longer available`。

## 5. 报 bug · Filing issues

给最小复现：DSH 版本、Node 版本、`roots` 文档（脱敏后的路径即可）、被拒时的完整 `code` 与 `message`、以及 `curl -s http://127.0.0.1:<端口>/plugins/dsh-multi-workspace/state` 的输出。

路径请脱敏：把用户名换成 `<user>`，别贴 `.env` 内容或 token。

## 6. 许可证 · License

提交即表示你同意以 [MIT](LICENSE) 授权你的贡献。
