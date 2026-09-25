/**
 * floken-feel · temporal 子入口
 *
 * ★ 时间实现源（ADR Q32，2026-09-25 用户拍板）：**统一使用 `temporal-polyfill`**。
 * - 落点是 `temporal-polyfill/implementation`（**不是包根**，理由见 `TEMPORAL_SPECIFIER`）；
 * - 不读原生 `globalThis.Temporal`：原生实现只在较新的 Node 上存在，
 *   且边界行为与 polyfill 不保证逐字一致；本包要求**同一表达式在任何
 *   受支持的 Node（≥22.12）上得到同一个结果**，故以 polyfill 为唯一实现源。
 *   （这与 NFR-F10「特性检测」的分工不同：检测的是"依赖是否装好"，不是"运行时有没有原生"。）
 * - 仍是**动态 import**：核心档（`.` / `./unary-tests`）绝不静态引用本档与 polyfill，
 *   由 `check:deps` 沿 import 递归兜底（NFR-F12 保留的那半条）。
 * - 未安装 → 抛 `FEEL_ENV_TEMPORAL_MISSING`（不裸抛 `ERR_MODULE_NOT_FOUND`，AGENTS.md §5）。
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
import {
  FEEL_ERROR_CODES,
  FeelEnvError,
  argTypeError,
  durationComponentError,
} from '../core/errors.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Temporal 命名空间（polyfill 导出），结构随实现而定，故用宽松类型 */
export type TemporalNS = any;

const EMPTY = new FeelContext();

/**
 * 唯一实现源。
 *
 * ⚠️ 必须是 **`./implementation` 子路径，不能用包根**：`temporal-polyfill` 的包根
 * （`index.js`）第一行就是 `const Temporal = NativeTemporal || PolyfillTemporal` ——
 * 在带原生 `Temporal` 的新 Node 上会**静默切到原生实现**，正是我们要消除的
 * 版本相关行为（同一表达式在 Node 22 与 Node 26 上结果可能不同）。
 * `./implementation.js` 无条件 re-export polyfill 实现（并加载 full 日历集），
 * 这才是"统一使用这个库"的准确落点。
 *
 * 该子路径自 `temporal-polyfill@1.0.5` 起提供，故 peer 下限即 1.0.5。
 *
 * ⚠️ 改回包根**不会**让任何测试变红（Node 22 下两者等价），只会在 Node 26 上悄悄换实现 ——
 * 故 `check:deps` 额外断言本档可达图必须含 `temporal-polyfill/implementation` 且不得
 * 出现 `globalThis.Temporal`。
 */
const TEMPORAL_SPECIFIER = 'temporal-polyfill/implementation';

/**
 * 实现源缺失 / 导出面不对（`FEEL_ENV_TEMPORAL_MISSING`）。
 *
 * 为什么这条**文案**（而不是契约）住在这个域里：`core` 只认"某个延迟能力档"这层抽象，
 * 不点名第三方包 —— 指名道姓说"装哪个包、怎么装"属本域知识。附带好处是 core 产物里
 * 不出现包名，`check:deps` 得以用文本守住"core 不触及 temporal"。
 */
export function temporalMissingError(cause?: unknown): FeelEnvError {
  const details: Record<string, unknown> = {
    dependency: 'temporal-polyfill',
    subpath: 'floken-feel/temporal',
  };
  if (cause !== undefined) details.cause = String(cause);
  return new FeelEnvError(
    "Temporal support requires the 'temporal-polyfill' package but it could not be loaded",
    {
      code: FEEL_ERROR_CODES.ENV_TEMPORAL_MISSING,
      hint: 'npm install temporal-polyfill（./temporal 档统一以 polyfill 为时间实现源）',
      details,
    },
  );
}

let loaded: TemporalNS | null = null;

/**
 * 确保时间实现可用。应在调用时间函数前 await 一次
 * （`floken-feel/temporal` 入口已在模块顶层 await 过，走公开入口的宿主无需自己调）。
 *
 * @throws FeelEnvError `FEEL_ENV_TEMPORAL_MISSING` —— 依赖没装。
 */
export async function ensureTemporal(): Promise<TemporalNS> {
  if (loaded) return loaded;
  let mod: { Temporal?: TemporalNS } | null = null;
  try {
    mod = (await import(TEMPORAL_SPECIFIER)) as { Temporal?: TemporalNS };
  } catch (cause) {
    throw temporalMissingError(cause);
  }
  const ns = mod?.Temporal;
  // 装了但导出面不对（版本过旧 / 被打包器改写过）也算环境不满足，不能等到调用点才炸
  if (!ns || typeof ns.PlainDate?.from !== 'function') throw temporalMissingError();
  loaded = ns;
  return loaded;
}

/**
 * 同步取时间实现（未加载返回 `null`）。
 *
 * ⚠️ 只认 `ensureTemporal()` 装载的那一份 —— **不读 `globalThis.Temporal`**（ADR Q32）。
 */
export function getTemporal(): TemporalNS | null {
  return loaded;
}

function isoOf(obj: unknown): string {
  if (typeof obj === 'object' && obj !== null) {
    const t = (obj as { toString?: unknown }).toString;
    if (typeof t === 'function') return String((obj as { toString: () => string }).toString());
  }
  return '';
}

/**
 * FEEL 类型名（比 `kind` 细一档，见 `FeelTemporal.category`）。
 * duration 分成**两个** FEEL 类型，判据取**规范文本**：出现 `D`/`T` 分量即为 days-and-time。
 */
function categoryOf(kind: FeelTemporal['kind'], text: string): string {
  if (kind === 'dateTime') return 'date and time';
  if (kind !== 'duration') return kind;
  return /[DT]/.test(text.replace(/^[-+]?P/, '')) ? 'days and time duration' : 'years and months duration';
}

/**
 * 同类可比较 duration 的**数值量**：years-and-months 记月数、days-and-time 记秒数。
 * `orderOf` 与 `categoryOf` 必须同源判定，否则会出现"同类却无数值"的空档。
 */
function orderOf(kind: FeelTemporal['kind'], obj: unknown, text: string): number | undefined {
  if (kind !== 'duration') return undefined;
  const raw = obj as Record<string, number> | null;
  if (categoryOf(kind, text) === 'days and time duration') {
    return (
      (raw?.days ?? 0) * 86400 +
      (raw?.hours ?? 0) * 3600 +
      (raw?.minutes ?? 0) * 60 +
      (raw?.seconds ?? 0) +
      (raw?.milliseconds ?? 0) / 1e3 +
      (raw?.microseconds ?? 0) / 1e6 +
      (raw?.nanoseconds ?? 0) / 1e9
    );
  }
  return (raw?.years ?? 0) * 12 + (raw?.months ?? 0);
}

/** 时区/偏移标注（FEEL 形式）：`@Zone` 或 `±HH:MM[:SS]`，二者互斥 */
interface ZoneInfo {
  offset: string | null;
  zone: string | null;
}

const NO_ZONE: ZoneInfo = { offset: null, zone: null };

/** 从 FEEL 文本尾部取时区/偏移标注 */
function parseZone(text: string | undefined): ZoneInfo {
  if (!text) return NO_ZONE;
  const at = text.indexOf('@');
  if (at > 0) return { offset: null, zone: text.slice(at + 1) };
  const m = /([+-])(\d{2}):?(\d{2})(?::(\d{2}))?$/.exec(text);
  if (m) return { offset: `${m[1]}${m[2]}:${m[3]}${m[4] ? `:${m[4]}` : ''}`, zone: null };
  if (/Z$/i.test(text)) return { offset: '+00:00', zone: null };
  return NO_ZONE;
}

/** FEEL 的时区后缀：零偏移一律写 `Z`（`+00:00` / `-00:00` 都要归一），时区名写 `@Zone` */
function zoneSuffix(z: ZoneInfo): string {
  if (z.zone) return `@${z.zone}`;
  if (!z.offset) return '';
  return /^[+-]00:00(?::00)?$/.test(z.offset) ? 'Z' : z.offset;
}

/** 扩年去零：`+999999999-12-31` → `999999999-12-31`、`-002017-12-31` → `-2017-12-31`（`0000-…` 保持四位） */
function normalizeYearText(text: string): string {
  const m = /^([+-]?)(0*)(\d+)-/.exec(text);
  if (!m) return text;
  const sign = m[1] ?? '';
  const digits = `${m[2] ?? ''}${m[3] ?? ''}`;
  if (sign !== '-' && digits.length <= 4) return text;
  return `${sign}${digits.replace(/^0+(?=\d)/, '')}-${text.slice(m[0].length)}`;
}

/**
 * **FEEL 规范文本** —— `FeelTemporal.iso` 的真正口径。
 *
 * Temporal 的 `toString()` 有两处与 FEEL 不同，都要换掉：
 * 1. 年份用扩年（`+275760-…` / `-002017-…`），FEEL 写作 `275760-…` / `-2017-…`；
 * 2. 带时区值的写法是 `…+01:00[Europe/Paris]`，FEEL 写作 `…@Europe/Paris`；
 *    而 Plain* 值会**丢掉**偏移，得从原文/显式标注补回（零偏移归一到 `Z`）。
 *
 * 之所以让 `iso` 扛这个口径：它是宿主机与跑分器唯一看到的"值文本"，
 * TCK 的期望值就是按 FEEL 规范文本写的（1115/1116/1117/0079 共 100+ 条）。
 */
function feelTextOf(kind: FeelTemporal['kind'], obj: unknown, zone: ZoneInfo): string {
  const base = isoOf(obj);
  if (kind === 'duration') return base; // 已由 normalizeDuration 输出 FEEL 形式
  if (kind === 'date') return normalizeYearText(base);
  if (kind === 'time') return normalizeYearText(base) + zoneSuffix(zone);
  const zoned = /\[([^\]]+)\]$/.exec(base);
  if (zoned) return `${normalizeYearText(base.slice(0, base.lastIndexOf('[')))}@${zoned[1]}`;
  return normalizeYearText(base) + zoneSuffix(zone);
}

/**
 * 造时间值。
 *
 * `zone` 可显式传（由分量构造偏移时无从解析原文），否则从 `src` 里解析。
 * `src` 只作**回溯用**留档：语义（相等、比较、文本、`.time offset`）一律以 `iso` 为准。
 */
function wrap(kind: FeelTemporal['kind'], obj: unknown, src?: string, zone?: ZoneInfo): FeelTemporal {
  const z = zone ?? parseZone(src);
  const iso = feelTextOf(kind, obj, z);
  const base: FeelTemporal = {
    __feelTemporal: true,
    kind,
    iso,
    raw: obj,
    eqKey: eqKeyOf(kind, obj, z, iso),
    category: categoryOf(kind, iso),
  };
  // 可选字段按需挂（`exactOptionalPropertyTypes` 下不能显式写 undefined）
  const order = orderOf(kind, obj, iso);
  const withOrder: FeelTemporal = order === undefined ? base : { ...base, order };
  return src === undefined ? withOrder : { ...withOrder, src };
}

/** 相等键里的时区标记：`Z` 与 `+00:00` 归一，`+0500` 补冒号；无则空串 */
function zoneToken(z: ZoneInfo): string {
  if (z.zone) return `zone:${z.zone}`;
  if (!z.offset) return '';
  return /^[+-]00:00(?::00)?$/.test(z.offset) ? 'offset:+00:00' : `offset:${z.offset}`;
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
  zone: ZoneInfo,
  base: string,
): string {
  const raw = obj as Record<string, number> | null;
  if (kind === 'duration') {
    const body = base.replace(/^[-+]?P/, '');
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
  return `${kind}|${base}|${zoneToken(zone)}`;
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
const DURATION_FIELDS = [
  'years',
  'months',
  'days',
  'hours',
  'minutes',
  'seconds',
  'milliseconds',
  'microseconds',
  'nanoseconds',
] as const;

/**
 * **时长规范化**（TCK 1120/1121）：同类分量进位到最大单位。
 *
 * - `years and months duration`：月数进位 → `P26M` ⇒ `P2Y2M`
 * - `days and time duration`：秒数进位到分/时/日 → `PT1000M` ⇒ `PT16H40M`、`PT24H` ⇒ `P1D`
 *
 * 为什么要做：FEEL 的时长**值**由总量决定，但 TCK 把期望写成规范形
 * （`duration("PT1000M")` 期望等于 `duration("PT16H40M")`），
 * 且 `string()` 也必须给出规范形。规范化后 `iso` / `src` / `eqKey` 三者一致。
 *
 * 用 BigInt 逐级取余，避免 `PT999999999M` 这类大值在浮点下丢纳秒。
 */
function normalizeDuration(
  T: TemporalNS,
  obj: unknown,
  src: string | undefined,
): { obj: unknown; text: string } {
  const raw = (obj ?? {}) as Record<string, number>;
  const negative = DURATION_FIELDS.some((k) => (raw[k] ?? 0) < 0);
  const sign = negative ? -1 : 1;
  const abs = (k: (typeof DURATION_FIELDS)[number]) => BigInt(Math.abs(raw[k] ?? 0));
  const body = (src ?? isoOf(obj)).replace(/^[-+]?P/, '');
  const isYm = !/[DT]/.test(body);

  let fields: Record<string, number>;
  let zeroText: string | null = null;
  if (isYm) {
    const totalMonths = abs('years') * 12n + abs('months');
    // `Temporal.Duration.from({years:0,months:0}).toString()` 退化成 `PT0S`（变成另一个 FEEL 类型了），
    // 而 `years and months duration` 的零值按 FEEL 写作 `P0M`（TCK 1121#013）—— 故手工写死。
    if (totalMonths === 0n) zeroText = 'P0M';
    fields = { years: Number((totalMonths / 12n) * BigInt(sign)), months: Number((totalMonths % 12n) * BigInt(sign)) };
  } else {
    const NS = 1_000_000_000n;
    const DAY = 86_400n * NS;
    const HOUR = 3_600n * NS;
    const MINUTE = 60n * NS;
    let ns =
      abs('days') * DAY +
      abs('hours') * HOUR +
      abs('minutes') * MINUTE +
      abs('seconds') * NS +
      abs('milliseconds') * 1_000_000n +
      abs('microseconds') * 1_000n +
      abs('nanoseconds');
    const days = ns / DAY;
    ns %= DAY;
    const hours = ns / HOUR;
    ns %= HOUR;
    const minutes = ns / MINUTE;
    ns %= MINUTE;
    const seconds = ns / NS;
    ns %= NS;
    const s = BigInt(sign);
    fields = {
      days: Number(days * s),
      hours: Number(hours * s),
      minutes: Number(minutes * s),
      seconds: Number(seconds * s),
      milliseconds: Number((ns / 1_000_000n) * s),
      microseconds: Number(((ns / 1_000n) % 1_000n) * s),
      nanoseconds: Number((ns % 1_000n) * s),
    };
  }
  const d = T.Duration.from(fields);
  return { obj: d, text: zeroText ?? isoOf(d) };
}

/**
 * 把 FEEL 的负年/超长年写法补成 Temporal 认的**扩年**形式（6 位带符号）。
 *
 * FEEL 照 ISO 8601 写作 `-2018-12-06`，但 Temporal 只接受 `-002018-12-06`；
 * 直接喂 `-2018-…` 会抛 "Cannot parse"。原串仍保留在 `src` 里，
 * 供 `string()` 还原 FEEL 写法（TCK 1117 期望 `"-99999-12-31T11:22:33"`，不补零）。
 */
function expandYear(text: string): string {
  const m = /^([+-])(\d{1,5})-/.exec(text);
  if (!m) return text;
  return `${m[1]}${(m[2] ?? '').padStart(6, '0')}-${text.slice(m[0].length)}`;
}

/**
 * 由「清洗后的待解析串 + 原始串」造时间值。
 *
 * 分开传两个串：解析要用 Temporal 认的形式（扩年、补 `.0`），
 * 而 `src` 要留 FEEL 原文（`string()` 与 `.timezone` 要还原人写的样子）。
 */
function parseTemporal(kind: FeelTemporal['kind'], ctor: string, text: string, src: string): Value {
  const T = getTemporal();
  if (!T) return null;

  const at = text.indexOf('@');
  if (at > 0 && kind === 'dateTime') {
    try {
      return wrap(kind, T.ZonedDateTime.from(`${text.slice(0, at)}[${text.slice(at + 1)}]`), src);
    } catch {
      return null;
    }
  }

  const Ctor = T[ctor];
  if (!Ctor || typeof Ctor.from !== 'function') return null;
  try {
    const parsed = Ctor.from(text);
    if (kind === 'duration') {
      // 时长的 `src` 用**规范形**（规范化改变了值本身的写法，原文已无意义）
      const norm = normalizeDuration(T, parsed, text);
      return wrap(kind, norm.obj, norm.text);
    }
    return wrap(kind, parsed, src);
  } catch {
    return null;
  }
}

/** 纯时间串（可带 `Z` / `±HH:MM` 偏移）→ 本地字段串；Temporal 的 PlainTime 不收偏移 */
function localTimeOf(text: string): string {
  return text.replace(/(?:Z|[+-]\d\d:?\d\d)$/i, '');
}

function construct(kind: FeelTemporal['kind'], ctor: string): NativeFn {
  return (args) => {
    const s = toStr(args[0] ?? null);
    if (s === null) return null;
    const original = s.trim();
    // ISO 8601 不允许 `PT0.S` 这种"小数点后直接跟单位"，但 TCK 1120#011 要求按 0 秒解析
    const text =
      kind === 'duration' ? original.replace(/(\d)\.(?=[A-Z]|$)/g, '$1.0') : expandYear(original);
    return parseTemporal(kind, ctor, text, original);
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

    if (/^-?P/i.test(text)) return parseTemporal('duration', 'Duration', text, text);

    const zoneAt = text.indexOf('@');
    if (zoneAt > 0) {
      const stamp = expandYear(text.slice(0, zoneAt));
      const zone = text.slice(zoneAt + 1);
      /*
       * 纯时间 + 时区名（`@"23:00:50@Australia/Melbourne"`）：Temporal 没有 OffsetTime，
       * 也没有"无日期的带时区时刻"，故按本地字段构造 PlainTime，
       * 时区名只留在 `src` 里供 `eqKey` 与 `.timezone` 属性用（TCK 0093/0103）。
       */
      if (/^\d\d:\d\d/.test(stamp)) {
        return parseTemporal('time', 'PlainTime', localTimeOf(stamp), text);
      }
      try {
        return wrap('dateTime', T.ZonedDateTime.from(`${stamp}[${zone}]`), text);
      } catch {
        return null;
      }
    }

    // 带偏移的纯时间（`@"23:00:50Z"` / `@"10:30:11+11:00"`）也要收：
    // Temporal 的 PlainTime 会拒收 `Z`，故先剥掉偏移，偏移只留在 `src` 供 `eqKey` 用。
    if (/^\d\d:\d\d/.test(text)) {
      return parseTemporal('time', 'PlainTime', localTimeOf(text), text);
    }
    if (/^[+-]?\d{4,}-\d\d-\d\d$/.test(text)) {
      return parseTemporal('date', 'PlainDate', expandYear(text), text);
    }
    return parseTemporal('dateTime', 'PlainDateTime', expandYear(text), text);
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

/** `.timezone` → 时区名；无时区 → null。读 `iso`（规范文本）而不是 `src` —— 分量构造的值没有原文 */
function timezoneOf(v: Value): Value {
  if (!isTemporal(v)) return null;
  return parseZone(v.iso).zone;
}

/**
 * 取「有年月日字段」的时间值（date / date and time，含带时区的），
 * 字符串则按 PlainDate 解析。
 *
 * date and time 也放行是因为 `years and months duration(from, to)` 的 TCK 用例
 * 大量传 date-time（1121#013~#026）—— 月差只看年月日，时分秒与时区一律忽略。
 */
function toDateLike(v: Value): any | null {
  const T = getTemporal();
  if (!T) return null;
  if (isTemporal(v)) {
    return v.kind === 'date' || v.kind === 'dateTime' ? (v.raw as any) : null;
  }
  const s = toStr(v);
  if (s === null) return null;
  try {
    return T.PlainDate.from(s);
  } catch {
    return null;
  }
}

/**
 * `years and months duration(from, to)` = 两点之间的**整月数**（DMN 1.4 §10.3.4.4）。
 *
 * 规则从 TCK 1121 的 36 条用例反推并逐条验算：
 * `months = trunc( (to.y-from.y)*12 + (to.m-from.m) + (to.day-from.day)/daysInMonth(from) )`，
 * **向零截断**。几个关键点：
 * - 时分秒与时区**完全不参与**（#019 两端偏移不同、#024 两端时分不同，结果都只看年月日）；
 * - 用 `from` 所在月的天数做分母（#025 / #032 只有这个分母能对上）；
 * - 向零截断使「同月但倒序」得 0 而非 -1（#013 期望 `P0M`）。
 *
 * 为什么不用 `Temporal.until({largestUnit:'months'})`：它返回带 `days` 的完整跨度
 * （`P20M2D`），而 FEEL 这个函数按定义**只给年月**（`P1Y8M`）。
 */
function yearsAndMonthsDuration(args: Value[]): Value {
  const T = getTemporal();
  if (!T) return null;
  const a = toDateLike(args[0] ?? null);
  const b = toDateLike(args[1] ?? null);
  if (!a || !b) return null;
  try {
    const base = (b.year - a.year) * 12 + (b.month - a.month);
    const daysInMonth = a.daysInMonth ?? 30;
    const months = Math.trunc(base + (b.day - a.day) / daysInMonth);
    const d = T.Duration.from({ years: Math.trunc(months / 12), months: months % 12 });
    return wrap('duration', d, isoOf(d));
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

/** 带时间函数求值。走公开入口时 Temporal 必已加载（入口顶层 await 过） */
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
