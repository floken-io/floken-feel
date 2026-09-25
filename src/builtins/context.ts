/**
 * floken-feel · 上下文（context）内置函数
 */

import { FeelContext, isContext, isList, type NativeFn, type Value } from '../core/types.js';
import { toStr } from '../core/values.js';

export const CONTEXT_BUILTINS: Record<string, NativeFn> = {
  'get value': (a) => {
    const c = a[0] ?? null;
    const key = toStr(a[1] ?? null);
    if (!isContext(c) || key === null) return null;
    return c.get(key) ?? null;
  },
  'get entries': (a) => {
    const c = a[0] ?? null;
    if (!isContext(c)) return null;
    return c
      .keys()
      .map((k) => new FeelContext(new Map([['key', k], ['value', c.get(k) ?? null]])));
  },
  /** `context([{key:…, value:…}, …])` → 由键值项列表构造上下文 */
  context: (a) => {
    const list = a[0] ?? null;
    if (!isList(list)) return null;
    const entries = new Map<string, Value>();
    for (const item of list) {
      if (!isContext(item)) return null;
      const k = toStr(item.get('key') ?? null);
      if (k === null) return null;
      entries.set(k, item.get('value') ?? null);
    }
    return new FeelContext(entries);
  },
  /** `context put(ctx, key, value)` → 覆盖某键后的新上下文（不改原值） */
  'context put': (a) => {
    const c = a[0] ?? null;
    const key = toStr(a[1] ?? null);
    if (!isContext(c) || key === null) return null;
    const entries = new Map(c.entries);
    entries.set(key, a[2] ?? null);
    return new FeelContext(entries);
  },
  /** `context merge([ctx, …])` → 依次合并，后者覆盖前者 */
  'context merge': (a) => {
    const list = a[0] ?? null;
    if (!isList(list)) return null;
    const entries = new Map<string, Value>();
    for (const item of list) {
      if (!isContext(item)) return null;
      for (const k of item.keys()) entries.set(k, item.get(k) ?? null);
    }
    return new FeelContext(entries);
  },
};
