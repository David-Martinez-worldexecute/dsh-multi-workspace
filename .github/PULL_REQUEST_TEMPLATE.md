## 这个 PR 做了什么 · What does this PR do

<!-- 一到三句。如果是修 bug，说清「原来会发生什么」与「现在会发生什么」。 -->

## 关联 · Related

<!-- Fixes #123 / Refs #456 -->

## 影响面 · Impact

- [ ] 判定逻辑（`src/rules.mjs` / `src/guard.mjs`）—— **必须**附新增/修改的测试
- [ ] 持久化（`src/store.mjs`）—— 附「写失败时降级」的行为说明
- [ ] 面板（`lib/client.js` / `http.mjs`）—— 附一次真实的 `curl` 或截图
- [ ] 只改文档 / 注释

## 自检 · Checklist

- [ ] `node tests/run-all.mjs` 全绿（贴出 `tests N / pass N / fail 0`）
- [ ] `npm run check` 通过（含 `scripts/load-check.mjs` 24 项）
- [ ] 新增行为有对应断言；**没有**为了变绿去放宽已有断言
- [ ] 没有新增运行时依赖（本项目零依赖）
- [ ] 文档同步（README / CHANGELOG / 边界与自检）—— 数字用当场实测值，不手填

## 备注 · Notes

<!-- 已知限制、未验证的部分、需要维护者拍板的取舍。 -->
