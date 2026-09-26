/**
 * floken-feel · 内置函数库 barrel
 *
 * 一般只从 `registry.js` 取汇总表；各域单独导出是为便于单测与按域扩展。
 */

export { BUILTINS, SPACED_BUILTINS, registerBuiltin } from './registry.js';

export { NUMERIC_BUILTINS } from './numeric.js';
export { BOOLEAN_BUILTINS } from './boolean.js';
export { CONVERSION_BUILTINS } from './conversion.js';
export { STRING_BUILTINS } from './string.js';
export { LIST_BUILTINS } from './list.js';
export { CONTEXT_BUILTINS } from './context.js';
export { FUNCTION_BUILTINS } from './function.js';
export { INTERVAL_BUILTINS } from './interval.js';

export {
  asList,
  ceilingScaled,
  EMPTY_CONTEXT,
  floorScaled,
  optNumber,
  optScale,
  reqNumber,
  requireArity,
  roundScaled,
  SCALE_MAX,
  SCALE_MIN,
  spread,
  type RoundMode,
} from './helpers.js';
