/**
 * floken-feel · temporal 子入口（→ dist/temporal.js）
 *
 * 时间类的实现住在 `src/temporal/`，本档只做汇总再导出。
 * 唯一允许接触 `temporal-polyfill` 的子路径（动态 import，Q9 / NFR-F12）。
 *
 * ★ 本档是**唯一的带副作用档**：import 时自动完成两件事 ——
 *   ① `await ensureTemporal()`：取原生 `Temporal`，Node 22 下动态加载 polyfill；
 *   ② `registerTemporalBuiltins()`：把时间函数注册进全局内置表。
 *
 * 这样 `evaluate('date("2020-01-01")')` 无需任何额外调用即可工作，
 * 与 `FeelNotLoadedError` 给出的修复提示（`await import("floken-feel/temporal")`）**逐字一致**。
 *
 * > 2026-09-25 修复（TCK 跑分暴露）：此前提示要求用户 import 本档，
 * > 但本档只提供 `evaluateTemporal()` 这类**显式 API**，import 本身不改变全局表 ——
 * > 用户照提示做完，仍会拿到同一个 `FEEL_NOT_LOADED_TEMPORAL`。**提示不可执行，属契约缺陷**
 * > （AGENTS.md §5：修复提示必须是照着做就能解决问题的动作）。
 *
 * ⚠️ 因此 `package.json` 必须声明 `"sideEffects": ["./dist/temporal.js"]`，
 * 否则打包器会把 `import 'floken-feel/temporal'` 当成无用副作用整条删掉，缺陷复现。
 */

export * from '../temporal/index.js';

import { ensureTemporal, registerTemporalBuiltins } from '../temporal/index.js';

await ensureTemporal();
registerTemporalBuiltins();
