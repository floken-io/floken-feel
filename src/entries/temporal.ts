/**
 * @floken-io/feel · temporal 子入口（→ dist/temporal.js）
 *
 * 时间类的实现住在 `src/temporal/`，本档只做汇总再导出。
 * 唯一允许接触 `temporal-polyfill` 的子路径（动态 import，Q9 / NFR-F12）。
 *
 * ★ 时间实现源 = `temporal-polyfill`，**统一使用，不读原生 `globalThis.Temporal`**
 *   （ADR Q32：跨 Node 版本行为一致优先于"少一个依赖"）。
 *   因此 `temporal-polyfill` 对本档是**必需依赖**，缺失时本档 import 即抛
 *   `FEEL_ENV_TEMPORAL_MISSING`（而核心 `.` / `./unary-tests` 依旧零 temporal 依赖）。
 *
 * ★ 本档是**唯一的带副作用档**：import 时自动完成两件事 ——
 *   ① `await ensureTemporal()`：动态加载并缓存 `temporal-polyfill`；
 *   ② `registerTemporalBuiltins()`：把时间函数注册进全局内置表。
 *
 * 这样 `evaluate('date("2020-01-01")')` 无需任何额外调用即可工作，
 * 与 `FeelNotLoadedError` 给出的修复提示（`await import("@floken-io/feel/temporal")`）**逐字一致**。
 *
 * ★ 因此 import 本档必须真的完成注册，而不只是提供 `evaluateTemporal()` 这类显式 API：
 *   否则用户照 `FeelNotLoadedError` 的提示 `await import("@floken-io/feel/temporal")` 做完，
 *   仍会拿到同一个 `FEEL_NOT_LOADED_TEMPORAL` —— 提示不可执行，属契约缺陷
 *   （AGENTS.md §5：修复提示必须是照着做就能解决问题的动作）。
 *
 * ⚠️ 因此 `package.json` 必须声明 `"sideEffects": ["./dist/temporal.js"]`，
 * 否则打包器会把 `import '@floken-io/feel/temporal'` 当成无用副作用整条删掉，缺陷复现。
 */

export * from '../temporal/index.js';

import { ensureTemporal, registerTemporalBuiltins } from '../temporal/index.js';

await ensureTemporal();
registerTemporalBuiltins();
