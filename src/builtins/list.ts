/**
 * floken-feel · 列表内置函数
 *
 * 位置参数（`sublist` / `insert before` / `remove`）同为 FEEL 1-based。
 */

import { isFunction, isList, type NativeFn, type Value } from '../core/types.js';
import { compareValues, deepEquals, toNumber } from '../core/values.js';
import { asList, EMPTY_CONTEXT, requireArity, spread, strictNumericList } from './helpers.js';

export const LIST_BUILTINS: Record<string, NativeFn> = {
  // ----- 查询 -----
  'list contains': (a) => {
    const list = asList(a[0] ?? null);
    if (list === null) return null;
    return list.some((x) => deepEquals(x, a[1] ?? null));
  },
  count: (a) => {
    const list = asList(a[0] ?? null);
    return list === null ? null : list.length;
  },
  'index of': (a) => {
    const list = asList(a[0] ?? null);
    if (list === null) return null;
    const match = a[1] ?? null;
    const out: Value[] = [];
    list.forEach((x, i) => {
      if (deepEquals(x, match)) out.push(i + 1);
    });
    return out;
  },

  // ----- 截取 -----
  sublist: (a) => {
    const list = asList(a[0] ?? null);
    const start = toNumber(a[1] ?? null);
    if (list === null || start === null || start === 0) return null;
    const len = a.length > 2 ? toNumber(a[2] ?? null) : null;
    const from = start > 0 ? start - 1 : Math.max(0, list.length + start);
    return len === null ? list.slice(from) : list.slice(from, from + Math.max(0, len));
  },

  // ----- 增删改 -----
  append: (a) => {
    const list = asList(a[0] ?? null);
    if (list === null) return null;
    return [...list, ...a.slice(1)];
  },
  'insert before': (a) => {
    const list = asList(a[0] ?? null);
    const pos = toNumber(a[1] ?? null);
    if (list === null || pos === null) return null;
    if (pos < 1 || pos > list.length + 1) return null;
    const out = [...list];
    out.splice(pos - 1, 0, a[2] ?? null);
    return out;
  },
  remove: (a) => {
    const list = asList(a[0] ?? null);
    const pos = toNumber(a[1] ?? null);
    if (list === null || pos === null) return null;
    if (pos < 1 || pos > list.length) return null;
    const out = [...list];
    out.splice(pos - 1, 1);
    return out;
  },
  reverse: (a) => {
    const list = asList(a[0] ?? null);
    return list === null ? null : [...list].reverse();
  },

  // ----- 集合运算 -----
  concatenate: (a) => {
    const out: Value[] = [];
    for (const v of a) {
      const l = asList(v);
      if (l === null) return null;
      out.push(...l);
    }
    return out;
  },
  union: (a) => {
    const out: Value[] = [];
    for (const v of a) {
      const l = asList(v);
      if (l === null) return null;
      out.push(...l);
    }
    return out;
  },
  'distinct values': (a) => {
    const list = asList(a[0] ?? null);
    if (list === null) return null;
    const out: Value[] = [];
    for (const v of list) {
      if (!out.some((x) => deepEquals(x, v))) out.push(v);
    }
    return out;
  },
  /**
   * 众数：出现次数最多的值，可能多个。TCK 0062 的三条口径：
   * 结果**升序**（`mode([3,6,1,9,6,1,3])` = `[1, 3, 6]`）、空列表 → `[]`（不是 null）、
   * 元素非数字 → 抛。变参形态 `mode(6, 3, 9, 6, 6)` 同 `spread`。
   */
  mode: (a) => {
    requireArity(a, 'mode', 1, Infinity);
    const list = strictNumericList(spread(a), 'mode');
    if (list.length === 0) return [];
    const groups: { value: Value; count: number }[] = [];
    for (const v of list) {
      const hit = groups.find((g) => deepEquals(g.value, v));
      if (hit) hit.count += 1;
      else groups.push({ value: v, count: 1 });
    }
    const best = Math.max(...groups.map((g) => g.count));
    const winners = groups.filter((g) => g.count === best).map((g) => g.value);
    return winners.sort((x, y) => compareValues(x, y) ?? 0);
  },
  flatten: (a) => {
    const list = asList(a[0] ?? null);
    if (list === null) return null;
    const flat = (items: Value[]): Value[] => {
      const out: Value[] = [];
      for (const v of items) {
        if (isList(v)) out.push(...flat(v));
        else out.push(v);
      }
      return out;
    };
    return flat(list);
  },
  sort: (a) => {
    const list = asList(a[0] ?? null);
    if (list === null) return null;
    const pred = a.length > 1 ? (a[1] ?? null) : null;
    const arr = [...list];
    if (isFunction(pred)) {
      arr.sort((x, y) => {
        const r = pred.call([x, y], EMPTY_CONTEXT);
        if (r === true) return -1;
        if (r === false) return 1;
        return 0;
      });
    } else {
      arr.sort((x, y) => compareValues(x, y) ?? 0);
    }
    return arr;
  },
};
