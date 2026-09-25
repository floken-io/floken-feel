/**
 * floken-feel · 函数值内置函数
 *
 * 处理「一等函数」：函数字面量（`function(a,b) …`）与宿主注入的 JS 函数。
 */

import { isFunction, isList, type NativeFn, type Value } from '../core/types.js';

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
};
