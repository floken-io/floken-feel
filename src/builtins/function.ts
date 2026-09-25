/**
 * floken-feel · 函数值内置函数
 *
 * 处理「一等函数」（`function(a,b) …` / 宿主注入的 JS 函数）与 `is()`。
 */

import {
  isContext,
  isFunction,
  isList,
  isRange,
  isTemporal,
  type FeelTemporal,
  type NativeFn,
  type Value,
} from '../core/types.js';
import { deepEquals } from '../core/values.js';
import { argCountError } from '../core/errors.js';

/** 两个值是否属于**同一个运行时类型档**（时间值还要 kind 相同） */
function sameTypeFamily(a: Value, b: Value): boolean {
  if (isTemporal(a) || isTemporal(b)) return isTemporal(a) && isTemporal(b) && a.kind === b.kind;
  if (isList(a) || isList(b)) return isList(a) && isList(b);
  if (isContext(a) || isContext(b)) return isContext(a) && isContext(b);
  if (isRange(a) || isRange(b)) return isRange(a) && isRange(b);
  if (isFunction(a) || isFunction(b)) return isFunction(a) && isFunction(b);
  return typeof a === typeof b;
}

/** 时间值按 `eqKey` 比较（见 `FeelTemporal.eqKey`）；两侧都缺则退回 `iso` */
function temporalEquals(a: FeelTemporal, b: FeelTemporal): boolean {
  return a.eqKey !== undefined && b.eqKey !== undefined ? a.eqKey === b.eqKey : a.iso === b.iso;
}

/**
 * `is(value1, value2)`：值**与类型**都相等（DMN 1.4 §10.3.4.6）。
 *
 * 与 `=` 的差别主要落在时间上：`is(@"23:00:50Z", @"23:00:50+00:00")` 为真
 * （同一零偏移的两种写法），而 `is(@"23:00:50", @"23:00:50Z")` 为假（一个没有偏移）。
 * 这些口径由 `../temporal` 写进 `eqKey`，核心只做键比较。
 */
function isStrictEqual(a: Value, b: Value): boolean {
  if (a === null || b === null) return false;
  if (!sameTypeFamily(a, b)) return false;
  if (isTemporal(a) && isTemporal(b)) return temporalEquals(a, b);
  return deepEquals(a, b);
}

export const FUNCTION_BUILTINS: Record<string, NativeFn> = {
  /**
   * `invoke(f, args)`：以参数列表调用函数值。
   * 第二个参数可为列表（`invoke(f, [1,2])`）或直接摊开（`invoke(f, 1, 2)`）。
   */
  invoke: (a, ctx) => {
    const fn = a[0] ?? null;
    if (!isFunction(fn)) return null;
    const rest = a.slice(1);
    const first = rest[0] ?? null;
    const args: Value[] = rest.length === 1 && isList(first) ? first : rest;
    return fn.call(args, ctx);
  },

  /**
   * `is(value1, value2)`。
   * 缺参数**不抛**：命名参数只给一半时缺位补 `null`，于是 `is(value1: X)` → `is(X, null)` → `false`
   * （TCK 0103 的期望）；而多给参数是签名错误 → 抛。
   */
  is: (args) => {
    if (args.length !== 2) throw argCountError('is', 2, args.length);
    return isStrictEqual(args[0] ?? null, args[1] ?? null);
  },
};
