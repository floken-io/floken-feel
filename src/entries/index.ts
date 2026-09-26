/**
 * floken-feel · 主入口（package 的 `.` 导出 → dist/index.js）
 *
 * 本档只做「汇总再导出」，不放任何逻辑：逻辑分别住在
 * `core/`（语言内核）与 `builtins/`（内置函数库）。
 *
 * 公开 API 形态对标 feelin（`{ value, warnings }`），实现完全自研（Q9：feelin 源码只读不拷）。
 * 时间函数不在本入口 —— 见 `floken-feel/temporal`（NFR-F12：核心不静态依赖 temporal）。
 */

export {
  evaluate,
  evaluateStrict,
  unaryTest,
  evaluateNode,
  evalUnaryTerm,
  measureAst,
} from '../core/evaluator.js';
export type { EvaluateOptions, FeelEvalRuntime } from '../core/evaluator.js';

export { parseExpression, parseUnaryTests, INSTANCE_TYPES } from '../core/parser.js';
export type { ParseOptions } from '../core/parser.js';

export { tokenize } from '../core/lexer.js';
export type { Token, TokenType } from '../core/lexer.js';

export { mergeNames } from '../core/name-merge.js';

export { highlight } from '../core/highlight.js';
export type { HighlightKind, HighlightSpan } from '../core/highlight.js';

// 错误与诊断契约（AGENTS.md §5）：错误类、码表、Diagnostic 形状
export {
  FeelError,
  FeelSyntaxError,
  FeelOptionError,
  FeelNotLoadedError,
  FeelLimitError,
  FeelNotAllowedError,
  FEEL_ERROR_CODES,
  FEEL_DIAGNOSTIC_CODES,
  diagnostic,
} from '../core/errors.js';
export type {
  Diagnostic,
  Severity,
  Position,
  NodeRef,
  FeelErrorCode,
  FeelDiagnosticCode,
  Warning,
} from '../core/errors.js';

export { TEMPORAL_FUNCTIONS } from '../core/deferred.js';

export { BUILTINS, SPACED_BUILTINS, registerBuiltin } from '../builtins/registry.js';
export { SPACED_NAMES, registerSpacedName } from '../core/spaced-names.js';

export {
  FeelContext,
  isContext,
  isFunction,
  isList,
  isRange,
  isScalar,
  isTemporal,
  makeRange,
  toFeelFunction,
} from '../core/types.js';

export {
  compareValues,
  deepEquals,
  rangeContains,
  toFeelContext,
  toNumber,
  toStr,
  tripleAnd,
  tripleNot,
  tripleOr,
} from '../core/values.js';

export type {
  EvalResult,
  EvalRuntime,
  FeelFunction,
  FeelRange,
  FeelTemporal,
  NativeFn,
  Node,
  Value,
} from '../core/types.js';
