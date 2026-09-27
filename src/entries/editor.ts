/**
 * @floken/feel · editor 子入口（→ dist/editor.js）
 *
 * 编辑器诊断的实现住在 `src/editor/`，本档只做汇总再导出。
 * 只装载 core（parser + lexer），**不含求值器与内置函数库**。
 */

export * from '../editor/index.js';
