/**
 * floken-feel · 字符串内置函数
 *
 * 字符串位置按 FEEL 规范为 **1-based**，负值表示从末尾倒数。
 * 正则相关函数（`replace` / `matches` / `split`）编译失败时返回 null。
 */

import { isList, type NativeFn, type Value } from '../core/types.js';
import { argTypeError } from '../core/errors.js';
import { feelTypeName, toNumber, toStr } from '../core/values.js';
import { requireArity } from './helpers.js';

/** 把 FEEL 的 1-based（可负）起点换算成 0-based 下标 */
function toIndex(start: number, length: number): number {
  return start > 0 ? start - 1 : Math.max(0, length + start);
}

export const STRING_BUILTINS: Record<string, NativeFn> = {
  // ----- 判定 -----
  contains: (a) => {
    const s = toStr(a[0] ?? null);
    const m = toStr(a[1] ?? null);
    return s === null || m === null ? null : s.includes(m);
  },
  'starts with': (a) => {
    const s = toStr(a[0] ?? null);
    const m = toStr(a[1] ?? null);
    return s === null || m === null ? null : s.startsWith(m);
  },
  'ends with': (a) => {
    const s = toStr(a[0] ?? null);
    const m = toStr(a[1] ?? null);
    return s === null || m === null ? null : s.endsWith(m);
  },
  'string length': (a) => {
    const s = toStr(a[0] ?? null);
    return s === null ? null : s.length;
  },

  // ----- 大小写 -----
  'upper case': (a) => {
    const s = toStr(a[0] ?? null);
    return s === null ? null : s.toUpperCase();
  },
  'lower case': (a) => {
    const s = toStr(a[0] ?? null);
    return s === null ? null : s.toLowerCase();
  },

  // ----- 截取 -----
  substring: (a) => {
    const s = toStr(a[0] ?? null);
    const start = toNumber(a[1] ?? null);
    if (s === null || start === null || start === 0) return null;
    const len = a.length > 2 ? toNumber(a[2] ?? null) : null;
    const from = toIndex(start, s.length);
    return len === null ? s.slice(from) : s.slice(from, from + Math.max(0, len));
  },
  'substring before': (a) => {
    const s = toStr(a[0] ?? null);
    const m = toStr(a[1] ?? null);
    if (s === null || m === null) return null;
    const i = s.indexOf(m);
    return i < 0 ? '' : s.slice(0, i);
  },
  'substring after': (a) => {
    const s = toStr(a[0] ?? null);
    const m = toStr(a[1] ?? null);
    if (s === null || m === null) return null;
    const i = s.indexOf(m);
    return i < 0 ? '' : s.slice(i + m.length);
  },

  // ----- 正则 -----
  replace: (a) => {
    const s = toStr(a[0] ?? null);
    const pattern = toStr(a[1] ?? null);
    if (s === null || pattern === null) return null;
    const rep = toStr(a[2] ?? null) ?? '';
    const flags = a.length > 3 ? (toStr(a[3] ?? null) ?? '') : '';
    try {
      return s.replace(new RegExp(pattern, flags), rep);
    } catch {
      return null;
    }
  },
  matches: (a) => {
    const s = toStr(a[0] ?? null);
    const pattern = toStr(a[1] ?? null);
    if (s === null || pattern === null) return null;
    const flags = a.length > 2 ? (toStr(a[2] ?? null) ?? '') : '';
    try {
      return new RegExp(pattern, flags).test(s);
    } catch {
      return null;
    }
  },
  split: (a) => {
    const s = toStr(a[0] ?? null);
    const delim = toStr(a[1] ?? null);
    if (s === null || delim === null) return null;
    try {
      return s.split(new RegExp(delim));
    } catch {
      return null;
    }
  },

  // ----- 拼接 -----
  /**
   * `string join(list, delimiter?)`（DMN 1.4 §10.3.4.5）。
   *
   * 三条口径（TCK 1140 逐条钉死）：
   * 1. `list` 是**字符串列表**；列表里的 `null` 元素**跳过**（006），
   *    非字符串元素（`[1,2,3]`）是类型错 → 抛（013）；
   * 2. 单个字符串会**强转**成单元素列表（015/016：`string join("a","X")` = `"a"`），
   *    但数字 / `null` 不行 → 抛（012/014）；
   * 3. `delimiter` 可省（默认空串）或显式 `null`（004），给了就必须是字符串。
   */
  'string join': (a) => {
    requireArity(a, 'string join', 1, 2);
    const raw = a[0] ?? null;
    let items: readonly Value[];
    if (isList(raw)) {
      items = raw;
    } else if (typeof raw === 'string') {
      items = [raw];
    } else {
      throw argTypeError('string join', 'list', 'list of strings', feelTypeName(raw));
    }
    const parts: string[] = [];
    for (const x of items) {
      if (x === null) continue;
      if (typeof x !== 'string') {
        throw argTypeError('string join', 'list', 'list of strings', feelTypeName(x));
      }
      parts.push(x);
    }
    const d = a.length > 1 ? (a[1] ?? null) : null;
    if (d !== null && typeof d !== 'string') {
      throw argTypeError('string join', 'delimiter', 'string', feelTypeName(d));
    }
    return parts.join(d ?? '');
  },
};
