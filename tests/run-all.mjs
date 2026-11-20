/**
 * tests/run-all.mjs —— 一次跑完全部测试。
 *
 * 为什么不用 `node --test`：在 DSH 的 workspace-write 沙箱里，测试运行器要为每个文件
 * spawn 子进程，直接被拒（`Error: spawn EPERM`），报成 `tests 1 / fail 1`，
 * 看着像实现坏了，其实一条用例都没跑。
 * 所以这里用**同进程 import**：node:test 的用例在同一个进程里注册并执行。
 *
 * 用法：`node tests/run-all.mjs`
 */

const FILES = [
  './validate.test.mjs',
  './guard.test.mjs',
  './rules.test.mjs',
  './store.test.mjs',
  './tool.test.mjs',
  './audit.test.mjs',
  './cli.test.mjs',
  './panel.test.mjs',
  './http.test.mjs',
  './client.test.mjs',
  './docs.test.mjs',
];

for (const file of FILES) {
  await import(file);
}
