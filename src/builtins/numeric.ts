/**
 * floken-feel · 数值内置函数
 *
 * 两条口径（TCK 逐条钉死，见 `./helpers.ts` 顶部注释）：
 * 1. **形参有类型**：少给/多给参数、错形参名、传 `null` 或非 number → **抛错**，
 *    不返回 `null`。返回 `null` 只用于「值存在但未知」（如 `sqrt(-1)`）。
 * 2. `scale` 是**小数位数**，合法范围 `[-6111, 6176]`（DMN 1.4 §10.3.4.7）。
 *
 * 三个函数（`sum` / `min` / `abs` 等）另有非数值分支（如 duration），
 * 由 `../temporal` 覆盖同名条目补齐（`withTemporal()` 的合并顺序）。
 */

import type { NativeFn } from '../core/types.js';
import { compareValues, toNumber } from '../core/values.js';
import { undefinedResultError } from '../core/errors.js';
import {
  numericList,
  optScale,
  reqNumber,
  requireArity,
  roundScaled,
  spread,
} from './helpers.js';

/** 舍入家族的共用骨架：`n` 必需、`scale` 选填（未给按 0） */
function rounding(name: string, mode: 'floor' | 'ceiling' | 'up' | 'down' | 'halfUp' | 'halfDown'): NativeFn {
  return (a) => {
    requireArity(a, name, 1, 2);
    const n = reqNumber(a, 0, name, 'n');
    return roundScaled(n, optScale(a, 1, name), mode);
  };
}

export const NUMERIC_BUILTINS: Record<string, NativeFn> = {
  // ----- 取整 / 舍入 -----
  floor: rounding('floor', 'floor'),
  ceiling: rounding('ceiling', 'ceiling'),
  round: rounding('round', 'halfUp'),
  'round half up': rounding('round half up', 'halfUp'),
  'round half down': rounding('round half down', 'halfDown'),
  'round up': rounding('round up', 'up'),
  'round down': rounding('round down', 'down'),
  decimal: (a) => {
    requireArity(a, 'decimal', 1, 2);
    const n = reqNumber(a, 0, 'decimal', 'n');
    // scale 为负表示"取整到 10 的幂"，故允许；范围同舍入家族
    return roundScaled(n, optScale(a, 1, 'decimal'), 'halfUp');
  },

  // ----- 一元数学 -----
  abs: (a) => {
    requireArity(a, 'abs', 1);
    const n = reqNumber(a, 0, 'abs', 'n');
    return Math.abs(n);
  },
  /**
   * `modulo(dividend, divisor)` = `dividend - divisor * floor(dividend / divisor)`（DMN 1.4 §10.3.4.7）。
   * 注意**不是** JS 的 `%`（后者符号跟随被除数）：`modulo(-12, 5)` = 3、`modulo(12, -5)` = -3。
   */
  modulo: (a) => {
    requireArity(a, 'modulo', 2);
    const dividend = reqNumber(a, 0, 'modulo', 'dividend');
    const divisor = reqNumber(a, 1, 'modulo', 'divisor');
    if (divisor === 0) throw undefinedResultError('modulo', { dividend, divisor });
    return dividend - divisor * Math.floor(dividend / divisor);
  },
  sqrt: (a) => {
    requireArity(a, 'sqrt', 1);
    const n = reqNumber(a, 0, 'sqrt', 'number');
    if (n < 0) throw undefinedResultError('sqrt', { number: n });
    return Math.sqrt(n);
  },
  log: (a) => {
    requireArity(a, 'log', 1);
    const n = reqNumber(a, 0, 'log', 'number');
    if (n <= 0) throw undefinedResultError('log', { number: n });
    return Math.log(n);
  },
  exp: (a) => {
    requireArity(a, 'exp', 1);
    return Math.exp(reqNumber(a, 0, 'exp', 'number'));
  },
  odd: (a) => {
    requireArity(a, 'odd', 1);
    const n = reqNumber(a, 0, 'odd', 'number');
    return Number.isInteger(n) ? Math.abs(n % 2) === 1 : false;
  },
  even: (a) => {
    requireArity(a, 'even', 1);
    const n = reqNumber(a, 0, 'even', 'number');
    return Number.isInteger(n) ? n % 2 === 0 : false;
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
