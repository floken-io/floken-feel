/**
 * floken-feel · 值语义公共工具
 *
 * 三值逻辑（NFR-F14 对齐）：null 参与的比较/布尔运算结果为 null（未知），而非 false。
 */

import {
  FeelContext,
  isContext,
  isList,
  isRange,
  isTemporal,
  isFunction,
  toFeelFunction,
  type Value,
} from './types.js';

/** 区间包含判定（含 null / 类型不可比较 → 返回 null，即「未知」） */
export function rangeContains(range: FeelRangeLike, value: Value): Value {
  if (value === null) return null;

  // 端点 `null` 表示**无界**（FEEL 10.3.2.5：`<= 10` ≡ `(null..10]`、`>= 10` ≡ `[10..null)`）。
  // 2026-09-25 修复：此前把"null 端点"与"不可比较"混为一谈，
  // 凡遇到无界区间一律返回 null —— TCK 里所有 `x in <op> n` 断言因此全错。
  const hasFrom = range.from !== null;
  const hasTo = range.to !== null;
  const low = hasFrom ? compareValues(range.from, value) : null;
  const high = hasTo ? compareValues(range.to, value) : null;

  const geFrom = hasFrom ? (low === null ? null : range.fromInclusive ? low <= 0 : low < 0) : true;
  const leTo = hasTo ? (high === null ? null : range.toInclusive ? high >= 0 : high > 0) : true;

  if (geFrom === true && leTo === true) return true;

  // 只有**能确定**落在界外才返回 false（三值逻辑：不可比 → null）
  const below = hasFrom && low !== null && (range.fromInclusive ? low > 0 : low >= 0);
  const above = hasTo && high !== null && (range.toInclusive ? high < 0 : high <= 0);
  if (below || above) return false;
  return null;
}

type FeelRangeLike = {
  from: Value;
  to: Value;
  fromInclusive: boolean;
  toInclusive: boolean;
};

/** 深相等（列表按元素、上下文按键、时间值按 iso） */
export function deepEquals(a: Value, b: Value): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;

  if (isTemporal(a) || isTemporal(b)) {
    return isTemporal(a) && isTemporal(b) && a.kind === b.kind && a.iso === b.iso;
  }

  if (isRange(a) || isRange(b)) {
    if (!isRange(a) || !isRange(b)) return false;
    return (
      a.fromInclusive === b.fromInclusive &&
      a.toInclusive === b.toInclusive &&
      deepEquals(a.from, b.from) &&
      deepEquals(a.to, b.to)
    );
  }

  if (isList(a) && isList(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEquals(x, b[i] ?? null));
  }

  if (isContext(a) && isContext(b)) {
    const ak = a.keys();
    const bk = b.keys();
    if (ak.length !== bk.length) return false;
    return ak.every((k) => b.has(k) && deepEquals(a.get(k) ?? null, b.get(k) ?? null));
  }

  if (typeof a === 'object' || typeof b === 'object') return false;
  return a === b;
}

/**
 * 比较：返回 -1 / 0 / 1；不可比较（含 null、类型不同、date vs time）返回 null。
 */
export function compareValues(a: Value, b: Value): number | null {
  if (a === null || b === null) return null;

  if (isTemporal(a) || isTemporal(b)) {
    if (!isTemporal(a) || !isTemporal(b)) return null;
    // date / time / dateTime 互相不可比较（对齐 feelin 行为）
    if (a.kind !== b.kind) return null;
    if (a.kind === 'duration') return null;
    return a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0;
  }

  if (typeof a === 'number' && typeof b === 'number') {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return a === b ? 0 : a ? 1 : -1;
  }
  return null;
}

/** 转为数字；不可转为 null */
export function toNumber(v: Value): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

/** 转为字符串；不可转为 null */
export function toStr(v: Value): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return null;
}

/** 只有 `true` 为真；null 与其它类型为「未知」 */
export function isTrue(v: Value): boolean {
  return v === true;
}

export function isFalse(v: Value): boolean {
  return v === false;
}

/** 三值 and：任一 false→false；否则含未知→null；全 true→true */
export function tripleAnd(values: readonly Value[]): Value {
  let unknown = false;
  for (const v of values) {
    if (isFalse(v)) return false;
    if (!isTrue(v)) unknown = true;
  }
  return unknown ? null : true;
}

/** 三值 or：任一 true→true；否则含未知→null；全 false→false */
export function tripleOr(values: readonly Value[]): Value {
  let unknown = false;
  for (const v of values) {
    if (isTrue(v)) return true;
    if (!isFalse(v)) unknown = true;
  }
  return unknown ? null : false;
}

/** 三值 not */
export function tripleNot(v: Value): Value {
  if (isTrue(v)) return false;
  if (isFalse(v)) return true;
  return null;
}

// ---------- context 构造 ----------

function convertValue(v: unknown): Value {
  if (v === null || v === undefined) return null;
  if (typeof v === 'function') {
    const fn = v as (...args: Value[]) => Value;
    return toFeelFunction(fn.name || 'fn', fn);
  }
  if (Array.isArray(v)) return v.map(convertValue);
  if (isContext(v as Value) || isTemporal(v as Value) || isFunction(v as Value)) {
    return v as Value;
  }
  if (typeof v === 'object') return toFeelContext(v);
  return v as Value;
}

/** 把宿主传入的普通对象 / Map 转成 FEEL context（函数会被包装为 FeelFunction） */
export function toFeelContext(input: unknown): FeelContext {
  const asValue = input as Value;
  if (isContext(asValue)) return asValue;

  if (input instanceof Map) {
    const entries = new Map<string, Value>();
    for (const [k, v] of input) entries.set(String(k), convertValue(v));
    return new FeelContext(entries);
  }

  if (typeof input === 'object' && input !== null) {
    const entries = new Map<string, Value>();
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      entries.set(k, convertValue(v));
    }
    return new FeelContext(entries);
  }

  return new FeelContext();
}
