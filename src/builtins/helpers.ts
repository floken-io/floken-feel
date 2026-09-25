/**
 * floken-feel · 内置函数公共工具
 *
 * 只放「多个内置函数域都会用到」的小工具，避免各域互相 import。
 */

import { FeelContext, isList, type Value } from '../core/types.js';
import { toNumber } from '../core/values.js';

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

/** 按指定模式四舍五入到 scale 位小数 */
export function roundTo(
  n: number,
  scale: number,
  mode: 'halfUp' | 'halfDown' | 'down' | 'up',
): number {
  const f = 10 ** scale;
  const x = n * f;
  let r: number;
  if (mode === 'up') r = Math.ceil(x);
  else if (mode === 'down') r = Math.floor(x);
  else {
    const frac = Math.abs(x) % 1;
    if (frac === 0.5) {
      r = mode === 'halfUp' ? Math.ceil(x) : Math.floor(x);
    } else {
      r = Math.round(x);
    }
  }
  return r / f;
}

/** 过滤出可转成数字的元素 */
export function numericList(values: readonly Value[]): number[] {
  const out: number[] = [];
  for (const v of values) {
    const n = toNumber(v);
    if (n !== null) out.push(n);
  }
  return out;
}
