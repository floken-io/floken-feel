/**
 * floken-feel · 字符串内置函数
 *
 * 字符串位置按 FEEL 规范为 **1-based**，负值表示从末尾倒数。
 * 正则相关函数（`replace` / `matches` / `split`）编译失败时返回 null。
 */

import { isList, type NativeFn, type Value } from '../core/types.js';
import { toNumber, toStr } from '../core/values.js';

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
  'string join': (a) => {
    const list: Value = a[0] ?? null;
    if (list === null) return null;
    if (!isList(list)) return toStr(list);
    const delim = a.length > 1 ? (toStr(a[1] ?? null) ?? '') : '';
    const parts = list.map((x) => toStr(x)).filter((x): x is string => x !== null);
    return parts.join(delim);
  },
};
