/**
 * floken-feel · 数值内置函数
 *
 * 约定：任何一个参数不可用（null / 类型不符 / 越界）即整体返回 null，
 * 由求值器保持三值语义（NFR-F14）。
 */

import type { NativeFn } from '../core/types.js';
import { compareValues, toNumber } from '../core/values.js';
import { numericList, roundTo, spread } from './helpers.js';

export const NUMERIC_BUILTINS: Record<string, NativeFn> = {
  // ----- 取整 / 舍入 -----
  floor: (a) => {
    const n = toNumber(a[0] ?? null);
    return n === null ? null : Math.floor(n);
  },
  ceiling: (a) => {
    const n = toNumber(a[0] ?? null);
    return n === null ? null : Math.ceil(n);
  },
  round: (a) => {
    const n = toNumber(a[0] ?? null);
    if (n === null) return null;
    const scale = a.length > 1 ? toNumber(a[1] ?? null) : 0;
    return roundTo(n, scale ?? 0, 'halfUp');
  },
  'round half up': (a) => {
    const n = toNumber(a[0] ?? null);
    if (n === null) return null;
    const scale = a.length > 1 ? toNumber(a[1] ?? null) : 0;
    return roundTo(n, scale ?? 0, 'halfUp');
  },
  'round half down': (a) => {
    const n = toNumber(a[0] ?? null);
    if (n === null) return null;
    const scale = a.length > 1 ? toNumber(a[1] ?? null) : 0;
    return roundTo(n, scale ?? 0, 'halfDown');
  },
  decimal: (a) => {
    const n = toNumber(a[0] ?? null);
    const scale = a.length > 1 ? toNumber(a[1] ?? null) : null;
    if (n === null || scale === null) return null;
    return roundTo(n, Math.trunc(scale), 'halfUp');
  },

  // ----- 一元数学 -----
  abs: (a) => {
    const n = toNumber(a[0] ?? null);
    return n === null ? null : Math.abs(n);
  },
  modulo: (a) => {
    const x = toNumber(a[0] ?? null);
    const y = toNumber(a[1] ?? null);
    if (x === null || y === null || y === 0) return null;
    return x % y;
  },
  sqrt: (a) => {
    const n = toNumber(a[0] ?? null);
    return n === null || n < 0 ? null : Math.sqrt(n);
  },
  log: (a) => {
    const n = toNumber(a[0] ?? null);
    return n === null || n <= 0 ? null : Math.log(n);
  },
  exp: (a) => {
    const n = toNumber(a[0] ?? null);
    return n === null ? null : Math.exp(n);
  },
  odd: (a) => {
    const n = toNumber(a[0] ?? null);
    return n === null ? null : Math.abs(n % 2) === 1;
  },
  even: (a) => {
    const n = toNumber(a[0] ?? null);
    return n === null ? null : Math.abs(n % 2) === 0;
  },

  // ----- 列表聚合 -----
  min: (a) => {
    const items = spread(a).filter((v) => v !== null);
    if (items.length === 0) return null;
    return items.reduce((acc, v) => ((compareValues(v, acc) ?? 0) < 0 ? v : acc));
  },
  max: (a) => {
    const items = spread(a).filter((v) => v !== null);
    if (items.length === 0) return null;
    return items.reduce((acc, v) => ((compareValues(v, acc) ?? 0) > 0 ? v : acc));
  },
  sum: (a) => {
    const nums = numericList(spread(a));
    if (nums.length === 0) return null;
    return nums.reduce((x, y) => x + y, 0);
  },
  mean: (a) => {
    const nums = numericList(spread(a));
    if (nums.length === 0) return null;
    return nums.reduce((x, y) => x + y, 0) / nums.length;
  },
  median: (a) => {
    const nums = numericList(spread(a)).sort((x, y) => x - y);
    if (nums.length === 0) return null;
    const mid = Math.floor(nums.length / 2);
    if (nums.length % 2 === 1) return nums[mid] ?? null;
    return ((nums[mid - 1] ?? 0) + (nums[mid] ?? 0)) / 2;
  },
  product: (a) => {
    const nums = numericList(spread(a));
    if (nums.length === 0) return null;
    return nums.reduce((x, y) => x * y, 1);
  },
  /** 样本标准差（除以 n-1，对齐 DMN）；n < 2 → null */
  stddev: (a) => {
    const nums = numericList(spread(a));
    if (nums.length < 2) return null;
    const mean = nums.reduce((x, y) => x + y, 0) / nums.length;
    const variance = nums.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (nums.length - 1);
    return Math.sqrt(variance);
  },
};
