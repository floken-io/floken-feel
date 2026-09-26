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

import type { NativeFn, Value } from '../core/types.js';
import { compareValues } from '../core/values.js';
import { decimalModulo } from '../core/decimal.js';
import { argTypeError, undefinedResultError } from '../core/errors.js';
import {
  optScale,
  reqNumber,
  requireArity,
  roundScaled,
  spread,
  strictNumericList,
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
    // scale 为负表示"取整到 10 的幂"，故允许；范围同舍入家族。
    // ⚠️ 舍入模式是**银行家舍入**（DMN 1.4 §10.3.3.1 的 decimal = round half even）：
    // `1.5` → 2 而 `2.5` → 2（TCK 1100#003~#004），用 JS 的 Math.round 会得 3。
    // 非整数 scale 按**截断**处理：`decimal(1/3, 2.5)` 期望 0.33，即 scale 取 2。
    return roundScaled(n, Math.trunc(optScale(a, 1, 'decimal')), 'halfEven');
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
    /*
     * ★ 十进制优先：`modulo(10.1, 4.5)` 必须是 **1.1**，double 路径给的是
     *   1.0999999999999996（TCK 0056 #017a~#017d 逐条钉死）。
     *   floor 语义（结果符号跟随 divisor）由 `decimalModulo` 保证，与这里原来的
     *   算式一致；decimal 路径不可用时回退原式，行为不变。
     */
    return decimalModulo(dividend, divisor) ?? dividend - divisor * Math.floor(dividend / divisor);
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
  /**
   * ★ `min` / `max` 的形参是 `list`（**可比**即可，不限数字 —— 规范原文 "minimum **comparable** element"），
   * 故 `min(["b","a"])` = `"a"`、`min([date…])` 有定义；但两条边界必须守：
   *
   * 1. **含 `null` 元素 → 无效**（OMG issue DMN18-63：min/max 与 sum/mean 同口径，
   *    "an array containing at least one null value is resulting in null"）。
   *    ⚠️ 曾写 `.filter(v => v !== null)` 静默跳过 —— 又一处 B-FEEL 语义混入。
   * 2. **两两不可比较 → 结果未定义**（`compareValues` 给 `null`，与 FEEL 三值比较一致，
   *    例如 `1 < "a"` 是 `null`）。曾写 `?? 0` 把"不可比较"当成"相等"，于是 `min([1,"a",3])` 得 1。
   *
   * ⚠️ TCK 无 `min(` / `max(` 的 FEEL 用例（2053 条里 0 命中），故 1995/1995 同样掩盖了这两处。
   */
  min: (a) => {
    const items = spread(a);
    if (items.length === 0) return null;
    let acc: Value = items[0] ?? null;
    if (acc === null) throw argTypeError('min', 'list', 'list of comparable values', 'null');
    for (let i = 1; i < items.length; i++) {
      const v = items[i] ?? null;
      if (v === null) throw argTypeError('min', 'list', 'list of comparable values', 'null');
      const c = compareValues(v, acc);
      if (c === null) throw undefinedResultError('min', { left: acc, right: v });
      if (c < 0) acc = v;
    }
    return acc;
  },
  max: (a) => {
    const items = spread(a);
    if (items.length === 0) return null;
    let acc: Value = items[0] ?? null;
    if (acc === null) throw argTypeError('max', 'list', 'list of comparable values', 'null');
    for (let i = 1; i < items.length; i++) {
      const v = items[i] ?? null;
      if (v === null) throw argTypeError('max', 'list', 'list of comparable values', 'null');
      const c = compareValues(v, acc);
      if (c === null) throw undefinedResultError('max', { left: acc, right: v });
      if (c > 0) acc = v;
    }
    return acc;
  },
  /**
   * ★ `sum` / `mean` 与 `median` / `product` / `stddev` / `mode` **同组**，形参都是 `list<number>`：
   * 含 `null` 或非数值元素 = **类型错误**（与 `median([1,2,"foo",4])` → `null` 的 TCK 0061#005 同口径）。
   *
   * ⚠️ 曾误用会静默跳过非数值的 `numericList`，于是 `sum([1,null,3])` 得 4、`sum([1,"1",3])` 得 5 ——
   * 那是 **B-FEEL 的「忽略非数值」语义**（DMN 1.6 第二方言），不是 FEEL。
   * FEEL 的权威口径（IBM 官方 B-FEEL↔FEEL 对照表 + OMG issue DMN18-63）：
   * `sum([1,null,3]) = null`、`sum([1,"1",3]) = null`、`mean([1,"a",3]) = null`。
   * ⚠️ TCK **没有任何 `sum` / `mean` 用例**（2053 条里 0 命中），故 1995/1995 掩盖了这个偏差；
   * 是与 `feelin` 批量对比时暴露的。旧注释写的「TCK 期望 sum 容忍」属**无依据的推断**，已订正。
   */
  sum: (a) => {
    const nums = strictNumericList(spread(a), 'sum');
    if (nums.length === 0) return null;
    return nums.reduce((x, y) => x + y, 0);
  },
  mean: (a) => {
    const nums = strictNumericList(spread(a), 'mean');
    if (nums.length === 0) return null;
    return nums.reduce((x, y) => x + y, 0) / nums.length;
  },
  median: (a) => {
    requireArity(a, 'median', 1, Infinity);
    const nums = strictNumericList(spread(a), 'median').sort((x, y) => x - y);
    if (nums.length === 0) return null;
    const mid = Math.floor(nums.length / 2);
    if (nums.length % 2 === 1) return nums[mid] ?? null;
    return ((nums[mid - 1] ?? 0) + (nums[mid] ?? 0)) / 2;
  },
  /** 空列表 / 含非数字 → 抛（TCK 0094#002 / #004~005 都是 `errorResult`） */
  product: (a) => {
    requireArity(a, 'product', 1, Infinity);
    const nums = strictNumericList(spread(a), 'product');
    if (nums.length === 0) throw undefinedResultError('product', { list: [] });
    return nums.reduce((x, y) => x * y, 1);
  },
  /** 样本标准差（除以 n-1，对齐 DMN）；元素非数字或个数 < 2 → 抛（TCK 0063#007~008_a） */
  stddev: (a) => {
    requireArity(a, 'stddev', 1, Infinity);
    const nums = strictNumericList(spread(a), 'stddev');
    if (nums.length < 2) throw undefinedResultError('stddev', { list: nums });
    const mean = nums.reduce((x, y) => x + y, 0) / nums.length;
    const variance = nums.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (nums.length - 1);
    return Math.sqrt(variance);
  },
};
