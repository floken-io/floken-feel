/**
 * @floken/feel · unary tests 子入口（→ dist/unary-tests.js）
 *
 * 决策表输入项求值。形态对标 feelin：
 * `unaryTest('< 10', { '?': 5 }) → { value: true, warnings: [] }`
 *
 * 本档只做汇总再导出；且**不得静态引入 temporal**（NFR-F12）。
 */

export { unaryTest, evalUnaryTerm, evaluateNode } from '../core/evaluator.js';
export type { EvaluateOptions, FeelEvalRuntime } from '../core/evaluator.js';

export { parseUnaryTests } from '../core/parser.js';
export type { ParseOptions } from '../core/parser.js';

export {
  FeelError,
  FeelSyntaxError,
  FeelOptionError,
  FeelNotLoadedError,
  FeelLimitError,
  FeelNotAllowedError,
  FEEL_ERROR_CODES,
  FEEL_DIAGNOSTIC_CODES,
} from '../core/errors.js';
export type { Diagnostic, Severity, Warning } from '../core/errors.js';

export { FeelContext, toFeelFunction } from '../core/types.js';
export { toFeelContext } from '../core/values.js';

export type { EvalResult, Node, Value } from '../core/types.js';
