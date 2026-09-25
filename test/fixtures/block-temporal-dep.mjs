/**
 * ESM 解析钩子：把 `temporal-polyfill*` 一律判为**解析失败**。
 *
 * 用途：在不真的卸载依赖的前提下，复现"宿主忘了装 peer 依赖"的现场 ——
 * 抛出的 `ERR_MODULE_NOT_FOUND` 与真实现场逐字一致，
 * 于是 `ensureTemporal()` 的兜底分支（AGENTS.md §5：禁裸抛）可以在 CI 里被稳定验证。
 *
 * 为什么不用"复制 dist 到无 node_modules 的目录"那套：
 * ① 需要递归删除临时目录，而本机沙箱会拦批量删除（进程被静默终止，exit 127，无输出）；
 * ② 一旦将来上游某处多出一个 `node_modules`，解析就会成功，探针**静默失效**。
 * 钩子方案零文件系统、零清理、且失败即报错，不存在静默失效。
 *
 * 注意 `register()` 不可逆，故必须在**全新进程**里用（见 cold-start.mjs 的 dep-missing 模式）。
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'temporal-polyfill' || specifier.startsWith('temporal-polyfill/')) {
    const err = new Error(`Cannot find package '${specifier}' imported from ${context.parentURL ?? '<unknown>'}`);
    err.code = 'ERR_MODULE_NOT_FOUND';
    throw err;
  }
  return nextResolve(specifier, context);
}
