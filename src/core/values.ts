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
  type FeelTemporal,
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

/**
 * FEEL 类型名是否同类（`=` 的类型前沿，见 `sameTypeFamily`）。
 * 比 `typeof` 细：两个 duration 类型是**两个类型**，date 与 time 也不是一类。
 */
function feelFamily(v: Value): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (isTemporal(v)) return v.category ?? v.kind;
  if (isList(v)) return 'list';
  if (isContext(v)) return 'context';
  if (isRange(v)) return 'range';
  if (isFunction(v)) return 'function';
  return 'unknown';
}

/**
 * 两个值是否属于同一个 FEEL 类型（`=` 的前提）。
 *
 * 这条判据决定「**类型错误**」还是「`false`」（TCK 0068 逐条钉死）：
 * `false = 0` / `100 = "100"` / `[] = 0` / `{} = []` / `duration("P1Y") = duration("P365D")`
 * 全是 `errorResult`（跨类型相比无定义），而 `null = 100` 只是 `false`。
 */
export function sameTypeFamily(a: Value, b: Value): boolean {
  return feelFamily(a) === feelFamily(b);
}

/**
 * 时间值的相等键。优先用 `./temporal` 档给的 `eqKey`（它对时区/偏移/时长有更细口径），
 * 没有则退回 `kind|iso`。
 */
function temporalKey(t: FeelTemporal): string {
  return t.eqKey ?? `${t.category ?? t.kind}|${t.iso}`;
}

/** 深相等（列表按元素、上下文按键、时间值按 `eqKey`） */
export function deepEquals(a: Value, b: Value): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;

  if (isTemporal(a) || isTemporal(b)) {
    if (!isTemporal(a) || !isTemporal(b)) return false;
    // 两个 duration 类型之间不相等（也不是"未知"，调用方按类型错误处理）
    if ((a.category ?? a.kind) !== (b.category ?? b.kind)) return false;
    return temporalKey(a) === temporalKey(b);
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
    // date / time / dateTime 互相不可比较；两个 duration 类型之间也不可比
    // （`P1Y` 与 `P365D` 谁长？规范不给答案 → 不可比，TCK 0068 判 Err）
    if ((a.category ?? a.kind) !== (b.category ?? b.kind)) return null;
    if (a.kind === 'duration') {
      // 同类 duration 按「月数 / 秒数」比（TCK 0072/0071）—— 靠 `./temporal` 档给的 order
      if (a.order === undefined || b.order === undefined) return null;
      return a.order < b.order ? -1 : a.order > b.order ? 1 : 0;
    }
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

/**
 * 值的 FEEL 类型名（DMN 1.4 §10.3.1 的类型集合）。
 * 用于**类型错误**的 message / `details.actualType` —— 宿主与编辑器都要能直接展示，
 * 所以这里给的是 FEEL 口径的名字（`null` / `number` / `date and time` …），不是 JS 的 `typeof`。
 */
export function feelTypeName(v: Value): string {
  if (v === null) return 'null';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'boolean';
  // 时间值优先报 `category`：它把 duration 拆成 FEEL 的**两个**类型（见 types.ts）
  if (isTemporal(v)) return v.category ?? (v.kind === 'dateTime' ? 'date and time' : v.kind);
  if (isList(v)) return 'list';
  if (isContext(v)) return 'context';
  if (isRange(v)) return 'range';
  if (isFunction(v)) return 'function';
  return 'unknown';
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
