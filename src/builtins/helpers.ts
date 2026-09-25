/**
 * floken-feel · 内置函数公共工具
 *
 * 只放「多个内置函数域都会用到」的小工具，避免各域互相 import。
 *
 * 这里承载一条**全局口径**（TCK 0050/0056/1101/1102/1141~1144 逐条钉死）：
 * DMN 1.4 §10.3.4 的形参都是**有类型**的，`null` / 字符串 / 布尔 / 时间值
 * 都不匹配 `number` —— 那是**类型错误**（抛），不是「未知值」（返回 null）。
 * 三值语义管的是「值存在但未知」，不是「调用非法」。
 */

import { FeelContext, isList, type Value } from '../core/types.js';
import { argCountError, argRangeError, argTypeError } from '../core/errors.js';
import { feelTypeName, toNumber } from '../core/values.js';

/** 空上下文（供不接受上下文的函数占位使用） */
export const EMPTY_CONTEXT = new FeelContext();

/** 既支持 `f([1,2])` 也支持 `f(1,2)` */
export function spread(args: readonly Value[]): Value[] {
  if (args.length === 1 && isList(args[0] ?? null)) return [...(args[0] as Value[])];
  return [...args];
}

/** 严格取列表；非列表返回 null */
export function asList(v: Value): Value[] | null {
  return isList(v) ? v : null;
}

// ---------------- 形参校验 ----------------

/**
 * 校验实参个数。`max` 缺省等于 `min`（定参）；`Infinity` 表示变参。
 * 少给/多给都是**调用签名错误** —— 没有可返回的值，故抛。
 */
export function requireArity(
  args: readonly Value[],
  fnName: string,
  min: number,
  max: number = min,
): void {
  if (args.length < min || args.length > max) {
    throw argCountError(fnName, min === max ? min : [min, max], args.length);
  }
}

/** 取**必须是 number** 的实参；缺失 / `null` / 其它类型 → 抛 `FEEL_EVAL_ARG_TYPE` */
export function reqNumber(
  args: readonly Value[],
  index: number,
  fnName: string,
  param: string,
): number {
  const v = args[index] ?? null;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw argTypeError(fnName, param, 'number', feelTypeName(v));
  }
  return v;
}

/** 取可选 number：未给 → `fallback`；给了就必须合法 */
export function optNumber(
  args: readonly Value[],
  index: number,
  fnName: string,
  param: string,
  fallback: number,
): number {
  if (index >= args.length) return fallback;
  return reqNumber(args, index, fnName, param);
}

/** 舍入家族 `scale` 的合法范围（DMN 1.4 §10.3.4.7） */
export const SCALE_MIN = -6111;
export const SCALE_MAX = 6176;

/** 取可选 `scale`：未给 → `fallback`（默认 0）；给了必须是 number 且落在规范范围内 */
export function optScale(
  args: readonly Value[],
  index: number,
  fnName: string,
  fallback = 0,
): number {
  if (index >= args.length) return fallback;
  const scale = reqNumber(args, index, fnName, 'scale');
  if (scale < SCALE_MIN || scale > SCALE_MAX) {
    throw argRangeError(fnName, 'scale', scale, SCALE_MIN, SCALE_MAX);
  }
  return scale;
}

// ---------------- 舍入 ----------------

export type RoundMode = 'floor' | 'ceiling' | 'up' | 'down' | 'halfUp' | 'halfDown';

/** 对已缩放整数 `x` 施加舍入模式（`up`/`down` 按**绝对值**方向，见 DMN 的 round up/down） */
function applyMode(x: number, mode: RoundMode): number {
  switch (mode) {
    case 'floor':
      return Math.floor(x);
    case 'ceiling':
      return Math.ceil(x);
    case 'up': // 远离 0
      return x < 0 ? -Math.ceil(-x) : Math.ceil(x);
    case 'down': // 靠近 0
      return x < 0 ? -Math.floor(-x) : Math.floor(x);
    case 'halfUp':
    case 'halfDown': {
      const lower = Math.floor(x);
      const frac = x - lower;
      if (Math.abs(frac - 0.5) < 1e-9) {
        // 正好落在中点：halfUp 远离 0、halfDown 靠近 0
        if (mode === 'halfUp') return x < 0 ? lower : lower + 1;
        return x < 0 ? lower + 1 : lower;
      }
      return Math.round(x);
    }
  }
}

/**
 * 按 `scale`（**小数位数**，不是步长）舍入到 `mode`。
 *
 * `scale` 是小数位：`floor(1.56, 1)` = 1.5、`floor(-1.56, 1)` = -1.6（TCK 1101/1102）。
 * 用「乘 `10**scale` → 取整 → 除回去」实现：除法比乘 `10**-scale` 精度好
 * （`113 / 100` = 1.13，而 `113 * 0.01` 会得到 1.1300000000000001）。
 *
 * 规范允许 `scale` 到 ±6176，远超双精度能表示的粒度；此时结果在双精度下
 * 与 `n` 无差别（正 scale）或只能是 0（负 scale），直接短路，不产生 `Infinity/NaN`。
 */
export function roundScaled(n: number, scale: number, mode: RoundMode): number {
  if (n === 0 || !Number.isFinite(n)) return n;
  const factor = 10 ** scale;
  if (!Number.isFinite(factor) || factor === 0) return scale > 0 ? n : 0;
  const x = n * factor;
  if (!Number.isFinite(x)) return scale > 0 ? n : 0;
  return applyMode(x, mode) / factor;
}

/** `floor` / `ceiling`：按小数位数向内/向外取整 */
export function floorScaled(n: number, scale: number): number {
  return roundScaled(n, scale, 'floor');
}

export function ceilingScaled(n: number, scale: number): number {
  return roundScaled(n, scale, 'ceiling');
}

/** 过滤出可转成数字的元素（列表聚合用；这些函数的「变参」形态允许跳过非数字） */
export function numericList(values: readonly Value[]): number[] {
  const out: number[] = [];
  for (const v of values) {
    const n = toNumber(v);
    if (n !== null) out.push(n);
  }
  return out;
}
