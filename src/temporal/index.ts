/**
 * floken-feel · temporal 子入口
 *
 * 只有本档允许接触 temporal-polyfill，且为**动态 import**（Q9 / NFR-F12）：
 * - Node 26+ 原生 `globalThis.Temporal` 存在时直接用；
 * - 否则 `typeof globalThis.Temporal === 'undefined'` 时才动态加载 polyfill。
 * 核心档（`.` / `./unary-tests`）绝不静态引用本档与 temporal-polyfill。
 */

import { BUILTINS, registerBuiltin } from '../builtins/registry.js';
import { NUMERIC_BUILTINS } from '../builtins/numeric.js';
import { requireArity } from '../builtins/helpers.js';
import { evaluate, type EvaluateOptions } from '../core/evaluator.js';
import {
  FeelContext,
  isTemporal,
  type EvalResult,
  type EvalRuntime,
  type FeelTemporal,
  type NativeFn,
  type Value,
} from '../core/types.js';
import { feelTypeName, toStr } from '../core/values.js';
import { argTypeError, durationComponentError } from '../core/errors.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Temporal 命名空间（原生或 polyfill），结构随实现而定，故用宽松类型 */
export type TemporalNS = any;

const EMPTY = new FeelContext();

let loaded: TemporalNS | null = null;

/** 确保 Temporal 可用。应在调用时间函数前 await 一次（Node 22 / 浏览器场景）。 */
export async function ensureTemporal(): Promise<TemporalNS | null> {
  const g = globalThis as { Temporal?: TemporalNS };
  if (typeof g.Temporal !== 'undefined') {
    loaded = g.Temporal;
    return loaded;
  }
  if (loaded) return loaded;
  const specifier = 'temporal-polyfill';
  const mod: any = await import(specifier);
  loaded = (mod?.Temporal ?? mod) as TemporalNS;
  return loaded;
}

/** 同步取 Temporal（未加载则返回 null） */
export function getTemporal(): TemporalNS | null {
  const g = globalThis as { Temporal?: TemporalNS };
  if (typeof g.Temporal !== 'undefined') return g.Temporal;
  return loaded;
}

function isoOf(obj: unknown): string {
  if (typeof obj === 'object' && obj !== null) {
    const t = (obj as { toString?: unknown }).toString;
    if (typeof t === 'function') return String((obj as { toString: () => string }).toString());
  }
  return '';
}

function wrap(kind: FeelTemporal['kind'], obj: unknown, src?: string): FeelTemporal {
  const iso = isoOf(obj);
  const eqKey = eqKeyOf(kind, obj, src, iso);
  return src === undefined
    ? { __feelTemporal: true, kind, iso, raw: obj, eqKey }
    : { __feelTemporal: true, kind, iso, raw: obj, src, eqKey };
}

/** 从原始串取「UTC 偏移 / 时区名」标记；`Z` 与 `+00:00` 归一，`+0500` 补冒号；无则空串 */
function zoneToken(src: string | undefined): string {
  if (!src) return '';
  const at = src.indexOf('@');
  if (at > 0) return `zone:${src.slice(at + 1)}`;
  const m = /([+-]\d{2}:?\d{2}|Z)$/.exec(src);
  if (!m) return '';
  if (m[0] === 'Z') return 'offset:+00:00';
  return `offset:${m[0].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')}`;
}

/**
 * 相等判定键（`FeelTemporal.eqKey`，供 `is()` 用 —— TCK 0103）。
 *
 * - **时间**：`kind|本地字段|偏移或时区`。于是 `23:00:50Z` ≡ `23:00:50+00:00`，
 *   而 `23:00:50` ≠ `23:00:50Z`（无偏移 vs 零偏移），时区名也 ≠ 同值偏移。
 * - **时长**：只比**总量**，但两类互不相等 —— `P1D` ≡ `PT24H`（同属 days-and-time），
 *   而 `P0Y` ≠ `P0D`（years-and-months vs days-and-time）。
 */
function eqKeyOf(
  kind: FeelTemporal['kind'],
  obj: unknown,
  src: string | undefined,
  base: string,
): string {
  const raw = obj as Record<string, number> | null;
  if (kind === 'duration') {
    const body = (src ?? base).replace(/^[-+]?P/, '');
    if (/[DT]/.test(body)) {
      const seconds =
        (raw?.days ?? 0) * 86400 +
        (raw?.hours ?? 0) * 3600 +
        (raw?.minutes ?? 0) * 60 +
        (raw?.seconds ?? 0) +
        (raw?.milliseconds ?? 0) / 1e3 +
        (raw?.microseconds ?? 0) / 1e6 +
        (raw?.nanoseconds ?? 0) / 1e9;
      return `duration-dt|${seconds}s`;
    }
    return `duration-ym|${(raw?.years ?? 0) * 12 + (raw?.months ?? 0)}mo`;
  }
  return `${kind}|${base}|${zoneToken(src)}`;
}

function temporalArg(v: Value): any | null {
  return isTemporal(v) ? (v.raw as any) : null;
}

function propGetter(key: string): NativeFn {
  return (args) => {
    const raw = temporalArg(args[0] ?? null);
    if (raw === null || raw === undefined) return null;
    const val = raw[key];
    return typeof val === 'number' ? val : null;
  };
}

/**
 * 构造时间值，并**保留原始串**（见 `FeelTemporal.src`）。
 *
 * 为什么要留原文：`Temporal.PlainDateTime.from("…+05:00")` 会**静默丢弃** UTC offset，
 * 而 FEEL 的 `.time offset` 必须能读回来（DMN 1.4 §10.3.4.2）。原文是唯一可靠的来源。
 *
 * 带**时区名** `@Europe/Paris` 的写法走 `ZonedDateTime`（Plain* 构造器不接受 `@`），
 * 对外仍记 `dateTime` —— `FeelTemporal.kind` 只有四档。
 */
function construct(kind: FeelTemporal['kind'], ctor: string): NativeFn {
  return (args) => {
    const T = getTemporal();
    const s = toStr(args[0] ?? null);
    if (!T || s === null) return null;
    const text = s.trim();

    const at = text.indexOf('@');
    if (at > 0 && kind === 'dateTime') {
      try {
        return wrap(kind, T.ZonedDateTime.from(`${text.slice(0, at)}[${text.slice(at + 1)}]`), text);
      } catch {
        return null;
      }
    }

    const Ctor = T[ctor];
    if (!Ctor || typeof Ctor.from !== 'function') return null;
    try {
      return wrap(kind, Ctor.from(text), text);
    } catch {
      return null;
    }
  };
}

/**
 * `@"…"` 日期时间字面量（FEEL 10.3.2.3）—— 按**字面形态**分派类型。
 *
 * 分派顺序有意如此：`^-?P` 是 duration 专有前缀；`HH:MM` 开头的只可能是 time
 * （否则 `11:22:33` 会被误判成含 `:` 的 date-time）；纯 `YYYY-MM-DD` 是 date；
 * 余下含 `T` 的才是 date-time。
 *
 * 带时区名后缀的写法（`@"2020-01-01T10:00:00@Europe/Paris"`）折算成 `ZonedDateTime`
 * （Temporal 用 `[…]` 表示时区），对外仍记作 `dateTime` 值 —— `FeelTemporal.kind` 只有四档。
 */
function atLiteralFn(): NativeFn {
  return (args) => {
    const T = getTemporal();
    const s = toStr(args[0] ?? null);
    if (!T || s === null) return null;
    const text = s.trim();

    if (/^-?P/i.test(text)) return construct('duration', 'Duration')([text], EMPTY);

    const zoneAt = text.indexOf('@');
    if (zoneAt > 0) {
      const stamp = text.slice(0, zoneAt);
      const zone = text.slice(zoneAt + 1);
      try {
        return wrap('dateTime', T.ZonedDateTime.from(`${stamp}[${zone}]`), text);
      } catch {
        return null;
      }
    }

    if (/^\d\d:\d\d/.test(text)) return construct('time', 'PlainTime')([text], EMPTY);
    if (/^[+-]?\d{4,}-\d\d-\d\d$/.test(text)) return construct('date', 'PlainDate')([text], EMPTY);
    return construct('dateTime', 'PlainDateTime')([text], EMPTY);
  };
}

/**
 * duration 属于哪一类（DMN 1.4 §10.3.4.4）。
 * 判据取规范串：出现 `D` 或 `T` 分量即为 `days and time duration`，
 * 否则是 `years and months duration`。
 */
function durationKindOf(t: FeelTemporal): 'years and months duration' | 'days and time duration' {
  return /[DT]/.test(t.iso.replace(/^[-+]?P/, ''))
    ? 'days and time duration'
    : 'years and months duration';
}

/**
 * 时长分量属性（`.years` `.months` `.days` `.hours` `.minutes` `.seconds`）。
 * **跨类访问按规范抛错**（TCK 0074 的 errorResult 用例），不降级为 null：
 * `duration("P1Y").days` 是错误，而 `duration("P1D").hours` 只是 0。
 */
function durationComponent(name: string): NativeFn {
  const dtOnly = name === 'days' || name === 'hours' || name === 'minutes' || name === 'seconds';
  return (args) => {
    const t = args[0] ?? null;
    if (!isTemporal(t) || t.kind !== 'duration') return null;
    const kind = durationKindOf(t);
    if (dtOnly !== (kind === 'days and time duration')) throw durationComponentError(name, kind);
    const v = (t.raw as Record<string, unknown>)[name];
    return typeof v === 'number' ? v : 0;
  };
}

/** `.time offset` → duration 值；无 offset → null（原文是唯一来源，Plain* 会丢 offset） */
function timeOffsetOf(v: Value): Value {
  if (!isTemporal(v)) return null;
  const src = (v.src ?? '').split('@')[0] ?? '';
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(src);
  if (!m) return src.endsWith('Z') ? construct('duration', 'Duration')(['PT0S'], EMPTY) : null;
  let text = 'PT';
  if (Number(m[2])) text += `${Number(m[2])}H`;
  if (Number(m[3])) text += `${Number(m[3])}M`;
  if (text === 'PT') text = 'PT0S';
  return construct('duration', 'Duration')([`${m[1] === '-' ? '-' : ''}${text}`], EMPTY);
}

/** `.timezone` → 时区名；无时区 → null */
function timezoneOf(v: Value): Value {
  if (!isTemporal(v)) return null;
  const src = v.src ?? '';
  const at = src.indexOf('@');
  return at > 0 ? src.slice(at + 1) : null;
}

/** 接受字符串或 date 时间值，统一转成底层 PlainDate */
function toDateLike(v: Value): any | null {
  const T = getTemporal();
  if (!T) return null;
  if (isTemporal(v)) {
    return v.kind === 'date' ? (v.raw as any) : null;
  }
  const s = toStr(v);
  if (s === null) return null;
  try {
    return T.PlainDate.from(s);
  } catch {
    return null;
  }
}

function yearsAndMonthsDuration(args: Value[]): Value {
  const T = getTemporal();
  if (!T) return null;
  const a = toDateLike(args[0] ?? null);
  const b = toDateLike(args[1] ?? null);
  if (!a || !b) return null;
  try {
    return wrap('duration', a.until(b, { largestUnit: 'months' }));
  } catch {
    return null;
  }
}

/**
 * 「现在」的取值：**优先用宿主注入的 clock**（`05-feel` §6.1）。
 * 注入后 `now()` / `today()` 可被测试钉死，否则读系统时间。
 */
function nowDate(rt?: EvalRuntime): Date {
  return rt?.clock ? rt.clock() : new Date();
}

/** 由 Date 的**本地**字段构造 Temporal 值（与 `Temporal.Now.*` 的本地时区语义一致） */
function localPlain(T: TemporalNS, d: Date, kind: FeelTemporal['kind']): FeelTemporal | null {
  const fields = {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
    second: d.getSeconds(),
  };
  try {
    if (kind === 'date') return wrap('date', T.PlainDate.from(fields));
    if (kind === 'time') return wrap('time', T.PlainTime.from(fields));
    return wrap('dateTime', T.PlainDateTime.from(fields));
  } catch {
    return null;
  }
}

/** 时间类内置函数 */
export const TEMPORAL_BUILTINS: Record<string, NativeFn> = {
  /** `@"…"` 字面量的类型分派（key 不是合法 FEEL 函数名，故用户无法手写调用） */
  '@': atLiteralFn(),
  now: (_args, _ctx, rt) => {
    const T = getTemporal();
    if (!T) return null;
    if (rt?.clock) return localPlain(T, nowDate(rt), 'dateTime');
    if (!T?.Now?.plainDateTimeISO) return null;
    return wrap('dateTime', T.Now.plainDateTimeISO());
  },
  today: (_args, _ctx, rt) => {
    const T = getTemporal();
    if (!T) return null;
    if (rt?.clock) return localPlain(T, nowDate(rt), 'date');
    if (!T?.Now?.plainDateISO) return null;
    return wrap('date', T.Now.plainDateISO());
  },
  /**
   * `abs` 的**时间分支**（数字分支在 `../builtins/numeric`，此处覆盖同名条目）。
   *
   * FEEL 的 `abs` 对 `days and time duration` / `years and months duration` 有定义，
   * 对 date / time / dateTime 没有 —— 后者按类型错误抛（TCK 0050 的 errorResult 用例）。
   * 时长取绝对值会改变规范串（`-P1D` → `P1D`），故重建 `src` 而不是沿用原文。
   */
  abs: (a, ctx, rt) => {
    requireArity(a, 'abs', 1);
    const v = a[0] ?? null;
    if (isTemporal(v)) {
      if (v.kind !== 'duration') {
        throw argTypeError('abs', 'n', 'number or duration', feelTypeName(v));
      }
      const raw = v.raw as { abs?: () => unknown } | null;
      if (typeof raw?.abs !== 'function') return null;
      const d = raw.abs();
      return wrap('duration', d, isoOf(d));
    }
    return NUMERIC_BUILTINS.abs!(a, ctx, rt);
  },
  date: construct('date', 'PlainDate'),
  time: construct('time', 'PlainTime'),
  'date and time': construct('dateTime', 'PlainDateTime'),
  dateTime: construct('dateTime', 'PlainDateTime'),
  duration: construct('duration', 'Duration'),
  'years and months duration': yearsAndMonthsDuration,
  yearsAndMonthsDuration,
  year: propGetter('year'),
  month: propGetter('month'),
  day: propGetter('day'),
  hour: propGetter('hour'),
  minute: propGetter('minute'),
  second: propGetter('second'),
  /**
   * ⚠️ DMN 1.4 §10.3.4.2 规定 `.weekday` 是**数字 1–7（Monday = 1）**，
   * 不是星期名（Temporal 的 `dayOfWeek` 恰好同口径，直接透传）。
   * 这里曾返回 `"Monday"` 字符串 —— 与规范不符，已按 TCK 0074 修正。
   */
  weekday: (args) => {
    const raw = temporalArg(args[0] ?? null);
    if (!raw) return null;
    const dow = raw.dayOfWeek;
    return typeof dow === 'number' ? dow : null;
  },
  // 时长分量（见 durationComponent 的跨类校验）
  years: durationComponent('years'),
  months: durationComponent('months'),
  days: durationComponent('days'),
  hours: durationComponent('hours'),
  minutes: durationComponent('minutes'),
  seconds: durationComponent('seconds'),
  // UTC offset / 时区名 —— 只能从原始串读（Plain* 会丢弃 offset）
  'time offset': (args) => timeOffsetOf(args[0] ?? null),
  timezone: (args) => timezoneOf(args[0] ?? null),
};

/** 核心内置 + 时间内置 的合并表 */
export function withTemporal(): Record<string, NativeFn> {
  return { ...BUILTINS, ...TEMPORAL_BUILTINS };
}

/** 带时间函数求值（未 ensureTemporal 时时间函数返回 null） */
export function evaluateTemporal(
  src: string,
  context?: unknown,
  options: EvaluateOptions = {},
): EvalResult {
  return evaluate(src, context, { ...options, builtins: withTemporal() });
}

/** 把时间内置函数注册进全局内置表（宿主可选） */
export function registerTemporalBuiltins(): void {
  for (const [k, v] of Object.entries(TEMPORAL_BUILTINS)) registerBuiltin(k, v);
}

// ---------- 便捷构造 ----------

export function dateValue(s: string): FeelTemporal | null {
  const v = construct('date', 'PlainDate')([s], EMPTY);
  return isTemporal(v) ? v : null;
}

export function timeValue(s: string): FeelTemporal | null {
  const v = construct('time', 'PlainTime')([s], EMPTY);
  return isTemporal(v) ? v : null;
}

export function dateTimeValue(s: string): FeelTemporal | null {
  const v = construct('dateTime', 'PlainDateTime')([s], EMPTY);
  return isTemporal(v) ? v : null;
}

export function durationValue(s: string): FeelTemporal | null {
  const v = construct('duration', 'Duration')([s], EMPTY);
  return isTemporal(v) ? v : null;
}
