/**
 * floken-feel · 类型转换内置函数
 *
 * 转换失败返回 null（而非抛错），沿用三值语义。
 */

import type { NativeFn } from '../core/types.js';
import { toNumber, toStr } from '../core/values.js';

export const CONVERSION_BUILTINS: Record<string, NativeFn> = {
  string: (a) => toStr(a[0] ?? null),
  number: (a) => toNumber(a[0] ?? null),
};
