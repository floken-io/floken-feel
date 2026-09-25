/**
 * floken-feel · temporal 子入口
 *
 * 只有本档允许接触 temporal-polyfill，且为**动态 import**（Q9 / NFR-F12）：
 * - Node 26+ 原生 `globalThis.Temporal` 存在时直接用；
 * - 否则 `typeof globalThis.Temporal === 'undefined'` 时才动态加载 polyfill。
 * 核心档（`.` / `./unary-tests`）绝不静态引用本档与 temporal-polyfill。
 */

import { BUILTINS, registerBuiltin } from '../builtins/registry.js';
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
import { toStr } from '../core/values.js';

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

function wrap(kind: FeelTemporal['kind'], obj: unknown): FeelTemporal {
  return { __feelTemporal: true, kind, iso: isoOf(obj), raw: obj };
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

function construct(kind: FeelTemporal['kind'], ctor: string): NativeFn {
  return (args) => {
    const T = getTemporal();
    const s = toStr(args[0] ?? null);
    if (!T || s === null) return null;
    const Ctor = T[ctor];
    if (!Ctor || typeof Ctor.from !== 'function') return null;
    try {
      return wrap(kind, Ctor.from(s));
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
        return wrap('dateTime', T.ZonedDateTime.from(`${stamp}[${zone}]`));
      } catch {
        return null;
      }
    }

    if (/^\d\d:\d\d/.test(text)) return construct('time', 'PlainTime')([text], EMPTY);
    if (/^[+-]?\d{4,}-\d\d-\d\d$/.test(text)) return construct('date', 'PlainDate')([text], EMPTY);
    return construct('dateTime', 'PlainDateTime')([text], EMPTY);
  };
}

const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

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
  weekday: (args) => {
    const raw = temporalArg(args[0] ?? null);
    if (!raw) return null;
    const dow = raw.dayOfWeek;
    return typeof dow === 'number' ? (WEEKDAYS[dow - 1] ?? null) : null;
  },
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
