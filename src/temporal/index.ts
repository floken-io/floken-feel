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
  temporalValueError,
} from '../core/errors.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Temporal 命名空间（polyfill 导出），结构随实现而定，故用宽松类型 */
export type TemporalNS = any;

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

/**
 * 扩年去零去号：`+099999-12-31` → `99999-12-31`、`-002017-12-31` → `-2017-12-31`。
 *
 * Temporal 的 `toString()` 对 5 位以上年份一律写**带符号的 6 位扩年**（`+099999` / `-002017`），
 * 而 FEEL 照 ISO 8601 写：正年**不带号**、只去前导零（`99999` / `-2017`）。
 * 4 位年份（含 `0000`）两种写法一致，原样返回。
 */
function normalizeYearText(text: string): string {
  const m = /^([+-]?)(0*)(\d+)-/.exec(text);
  if (!m) return text;
  const sign = m[1] ?? '';
  const digits = `${m[2] ?? ''}${m[3] ?? ''}`;
  const year = digits.replace(/^0+(?=\d)/, '');
  // 4 位及以内且非负 → 两边写法一致，原样返回
  if (sign !== '-' && year.length <= 4) return text;
  const rest = text.slice(m[0].length);
  return `${sign === '-' ? '-' : ''}${year}-${rest}`;
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
  if (zoned) {
    // ZonedDateTime 的写法 `…+01:00[Europe/Paris]` 里那段偏移是 Temporal 的中间产物：
    // FEEL 只写 `…@Europe/Paris`，故先把 `[` 前的偏移/Z 剥掉（TCK 1117#023~#026 / 0079）。
    const head = localTimeOf(base.slice(0, base.lastIndexOf('[')));
    return `${normalizeYearText(head)}@${zoned[1]}`;
  }
  return normalizeYearText(base) + zoneSuffix(zone);
}

/**
 * 造时间值。
 *
 * `zone` 可显式传（由分量构造偏移时无从解析原文），否则从 `src` 里解析。
 * `src` 只作**回溯用**留档：语义（相等、比较、文本、`.time offset`）一律以 `iso` 为准。
 * `isoText` 用于覆盖由 `obj` 反推的文本 —— 目前只有时长需要：
 * `years and months duration` 的零值 Temporal 一律 `toString()` 成 `PT0S`，
 * 而 FEEL 写作 `P0M`（两者是**不同的 FEEL 类型**，TCK 0079#ym_003 / 0103 都要区分）。
 */
function wrap(
  kind: FeelTemporal['kind'],
  obj: unknown,
  src?: string,
  zone?: ZoneInfo,
  isoText?: string,
): FeelTemporal {
  const z = zone ?? parseZone(src);
  const iso = isoText ?? feelTextOf(kind, obj, z);
  const base: FeelTemporal = {
    __feelTemporal: true,
    kind,
    iso,
    raw: obj,
    eqKey: eqKeyOf(kind, obj, z, iso),
    identity: identityOf(kind, obj, z, iso),
    category: categoryOf(kind, iso),
  };
  // 可选字段按需挂（`exactOptionalPropertyTypes` 下不能显式写 undefined）
  const order = orderOf(kind, obj, iso);
  const withOrder: FeelTemporal = order === undefined ? base : { ...base, order };
  const withPlus: FeelTemporal = { ...withOrder, plus: (d, sign) => shiftByDuration(withOrder, d, sign) };
  // 只有 `date` 有"下一天"这个自然步长（`date and time` / `time` / duration 没有，
  // 故 `for i in @d1..@d2` 对它们应当报错，TCK 0084#020/#021/#022）
  const withStep =
    kind === 'date'
      ? { ...withPlus, plusDays: (days: number) => shiftDays(withPlus, days) }
      : withPlus;
  return src === undefined ? withStep : { ...withStep, src };
}

/**
 * 按天平移一个 `date`（迭代序列用，TCK 0084#017/#018）。
 * 走 Temporal 的 `add({ days })`，不自研日历算法（NFR-F11）。
 */
function shiftDays(date: FeelTemporal, days: number): Value {
  const T = getTemporal();
  const raw = date.raw as { add?: (d: { days: number }) => unknown } | null;
  if (!T || !raw?.add) return null;
  try {
    return wrap('date', raw.add({ days }));
  } catch {
    return null;
  }
}

/**
 * 时间算术：`date ± duration` / `time ± duration` / `date and time ± duration`
 * （DMN 1.4 §10.3.2.4，TCK 0096/0097 的 `date_input_001+@"P1D"` 即此）。
 *
 * 底层直接交给 Temporal 的 `add` / `subtract`，**偏移/时区原样保留**
 * （故沿用基准值的 zone，而不是从新串里重解析）。
 * 组合不可表示（如 `PlainDate + PT1H`）时 Temporal 抛 `RangeError` → 转成 `null`。
 */
function shiftByDuration(base: FeelTemporal, dur: FeelTemporal, sign: 1 | -1): Value {
  if (!isTemporal(dur) || dur.kind !== 'duration') return null;
  const raw = base.raw as { add?: (d: unknown) => unknown; subtract?: (d: unknown) => unknown };
  const apply = sign === 1 ? raw?.add : raw?.subtract;
  if (typeof apply !== 'function') return null;
  let next: unknown;
  try {
    next = apply.call(raw, dur.raw);
  } catch {
    return null;
  }
  if (next === null || next === undefined) return null;
  return wrap(base.kind, next, undefined, parseZone(base.src));
}

/** 相等键里的时区标记：`Z` 与 `+00:00` 归一，`+0500` 补冒号；无则空串 */
function zoneToken(z: ZoneInfo): string {
  if (z.zone) return `zone:${z.zone}`;
  if (!z.offset) return '';
  return /^[+-]00:00(?::00)?$/.test(z.offset) ? 'offset:+00:00' : `offset:${z.offset}`;
}

/**
 * 抹掉秒以下的小数。**FEEL 的相等判定分辨率是秒**：
 * TCK 0068 `time_005` 要求 `time("10:30:00.0001") = time("10:30:00.0002")` 为 **true**，
 * 而同组的 `time_002_b` 要求 `10:30:01 ≠ 10:30:00` —— 故精度就停在秒。
 * （`iso` 本身仍保留小数，`string()` 必须照原样输出。）
 */
function toSecond(text: string): string {
  return text.replace(/(\d{2}:\d{2}:\d{2})\.\d+/, '$1');
}

/**
 * 该日期时间值对应的**瞬时**（秒）；无绝对位置（既无偏移也无时区）→ `null`。
 *
 * 有绝对位置才能跨写法相等：TCK 0068 要求
 * `…+02:00` ≡ `…@Europe/Paris`（datetime_008）、`+00:00` ≡ `@Etc/UTC`（009）、
 * `@Australia/Melbourne` ≡ `@Australia/Sydney`（008_b）、
 * `-01:00` 与 `+04:00` 同刻（012/013）—— 全是**按瞬时**判。
 * 纯本地时间（`2018-12-08T00:00:00`）没有绝对位置，故退回按本地字段比。
 */
function instantSecondsOf(obj: unknown, zone: ZoneInfo, iso: string): number | null {
  const raw = obj as { epochNanoseconds?: bigint } | null;
  // 带时区名 → 底层是 ZonedDateTime，直接有瞬时
  if (raw && typeof raw.epochNanoseconds === 'bigint') {
    return Number(raw.epochNanoseconds / 1000000000n);
  }
  if (!zone.offset) return null;
  const T = getTemporal();
  if (!T) return null;
  const suffixLen = zoneSuffix(zone).length;
  const local = toSecond(iso.slice(0, iso.length - suffixLen));
  try {
    return Number(T.Instant.from(`${local}${zone.offset}`).epochNanoseconds / 1000000000n);
  } catch {
    return null;
  }
}

/**
 * **写法同一键**（`FeelTemporal.identity`，供 `is()` 用 —— TCK 0103）。
 *
 * 与 `eqKey` 的区别是本包最反直觉的一处，但 TCK 用**同一对值**把我们钉死了：
 * `@"2002-04-02T12:00:00-01:00"` 与 `@"2002-04-02T17:00:00+04:00"` 是**同一瞬时**，
 * 于是 0068 `datetime_012` 要求 `=` 为 **true**，而 0103 `datetime_004` 要求 `is` 为 **false**。
 * 结论：`=` 按瞬时，`is()` 按**写法**（本地字段 + 偏移/时区都得一致）。
 *
 * - 时间 / 日期时间：`kind|本地字段|偏移或时区`。零偏移的两种写法（`Z` 与 `+00:00`）归一
 *   （0103 `time_004`）；但 `无偏移` ≠ `零偏移`（`time_005`），`@Zone` ≠ 同值偏移（`time_006`）。
 * - 时长：只比**总量** —— `P1D` ≡ `PT24H`（0103 `dt_duration_002`）、`P1Y` ≡ `P12M`（`ym_duration_002`），
 *   而两类互不相等（`P0Y` ≠ `P0D`，`zero_duration_001`）。
 */
function identityOf(
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

/**
 * 相等判定键（`FeelTemporal.eqKey`，供 `=` 用 —— TCK 0068）。
 *
 * - **时间**：`kind|本地字段|偏移或时区`，**只到秒**。`23:00:50Z` ≡ `23:00:50+00:00`，
 *   而 `23:00:50` ≠ `23:00:50Z`（无偏移 vs 零偏移），时区名也 ≠ 同值偏移。
 *   `time("10:30:00.0001") = time("10:30:00.0002")` 为 true（`time_005`）—— 相等只到秒。
 * - **日期时间**：有偏移/时区 → 比**瞬时**；无 → 比本地字段（同样只到秒）。
 *   两种口径**不可混**：一个本地时间没有绝对位置，不会等于任何瞬时写法。
 * - **时长**：同 `identityOf`（只比总量、两类互不相等）。
 */
function eqKeyOf(
  kind: FeelTemporal['kind'],
  obj: unknown,
  zone: ZoneInfo,
  base: string,
): string {
  if (kind === 'dateTime') {
    const epoch = instantSecondsOf(obj, zone, base);
    return epoch === null ? `dateTime-local|${toSecond(base)}` : `dateTime-instant|${epoch}`;
  }
  if (kind === 'duration') return identityOf(kind, obj, zone, base);
  return `${kind}|${toSecond(base)}|${zoneToken(zone)}`;
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

/** 英文星期名（DMN 1.4 §10.3.4.3：`day of week` 返回**名字**，索引 = `dayOfWeek` − 1） */
const DAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

/** 英文月份名（同 §10.3.4.3：`month of year` 返回**名字**，索引 = `month` − 1） */
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/**
 * 日期分量函数的共用骨架（DMN 1.4 §10.3.4.3）：
 * `day of year` / `week of year` / `day of week` / `month of year`。
 *
 * 唯一形参 `date` **必须是 date 或 date and time** —— `null` / 字符串 / 数字 /
 * `time` / duration 一律是**类型错误（抛）**。这与同名的路径属性（`date.day`）
 * 那族「读不到就给 null」是两回事：TCK 0095~0098 的 `null_00x` 全是
 * `errorResult="true"`，返回 null 在本口径下就是失败。
 *
 * `day of week` / `month of year` 返回**英文名**而非数字，`week of year` 是
 * **ISO 周**（`2003-12-29` → 1、`2005-01-01` → 53），`temporal-polyfill` 的
 * `dayOfWeek` / `weekOfYear` / `dayOfYear` 恰好同口径，直接透传。
 */
function datePartFn(name: string, pick: (raw: any) => Value): NativeFn {
  return (args) => {
    requireArity(args, name, 1);
    const v = args[0] ?? null;
    const t = asDateLike(v);
    if (!t) throw argTypeError(name, 'date', 'date or date and time', feelTypeName(v));
    return pick(t.raw);
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

/** Temporal 可表示的年份上限（ISO 8601 扩展年 `±275760`） */
const YEAR_LIMIT = 275760;

/** FEEL 允许的 UTC 偏移上限（`±18:00`；Temporal 自身放宽到 ±23:59，TCK 1116#067 / 1117#078 要求更严） */
const OFFSET_LIMIT_HOURS = 18;

/**
 * FEEL 年份写法 → Temporal 认的**扩年**（6 位带符号）。
 *
 * FEEL 照 ISO 8601 写年份：4 位（`2017`）、5–9 位（`99999`，**不许前导零、不许 `+` 号**）、可负（`-2017`）。
 * Temporal 只认 4 位或 6 位带符号扩年，故 5–9 位要补足 6 位并补 `+`。
 *
 * 返回 `'invalid'` = 写法非法（具名构造器抛 `EVAL_TEMPORAL_VALUE`）；
 * 返回 `'overflow'` = 写法合法但超出实现源可表示范围（给 `null`，登记 `known-gaps`）。
 *
 * 四条判据都由 TCK 钉死：`998-12-31`（3 位）/ `01211-12-31`（前导零）/ `9999999999-12-25`（10 位）/
 * `+2012-12-02`（正号）全 `errorResult`；而 `99999-12-31T11:22:33` 必须解析得出来（1117#011）。
 *
 * ⚠️ 注意本函数的正则**只接受可选负号** —— `+2012-…` 因此直接判非法（不进入后面的补位逻辑）。
 */
function convertYear(text: string): string | 'invalid' | 'overflow' {
  const m = /^(-?)(\d+)-(\d{2})-(\d{2})([\s\S]*)$/.exec(text);
  if (!m) return 'invalid';
  const neg = m[1] === '-';
  const digits = m[2] ?? '';
  if (digits.length < 4 || digits.length > 9) return 'invalid';
  if (digits.length > 4 && digits.startsWith('0')) return 'invalid';
  if (Number(digits) > YEAR_LIMIT) return 'overflow';
  const tail = `-${m[3]}-${m[4]}${m[5] ?? ''}`;
  // 负年即使是 4 位也要写扩年：Temporal 的**文本解析**只认 4 位**正**年，
  // `-2016-01-30` 会直接拒收（`{year:-2016}` 的对象形态才接受）—— 故负年一律补足 6 位。
  if (digits.length === 4 && !neg) return `${digits}${tail}`;
  return `${neg ? '-' : '+'}${digits.padStart(6, '0')}${tail}`;
}

/**
 * 构造失败时的统一出口。
 *
 * `fnName` 非 null（具名构造器 `date()` / `time()` / `date and time()`）→ **抛**：
 * DMN 1.4 把这些形参定义为有类型，写法不合规就是**类型错误**，
 * TCK 1115/1116/1117 把每一种坏写法都列成了 `errorResult`。
 * `fnName` 为 null（`@"…"` 字面量路径）→ 给 `null`：那只是"这段文本不是该类型的字面量"。
 */
function shapeFail(fnName: string | null, src: string, expected: string): Value {
  if (fnName === null) return null;
  throw temporalValueError(fnName, { value: src, expected });
}

/** 时区名是否真实存在（`Etc/UTC` 通过、`xyz/abc` 抛 —— TCK 1116#066） */
function zoneExists(zone: string): boolean {
  const T = getTemporal();
  if (!T) return false;
  try {
    T.ZonedDateTime.from(`2000-01-01T00:00:00[${zone}]`);
    return true;
  } catch {
    return false;
  }
}

/** 偏移写法与范围（`±HH:MM[:SS]`，`|HH| ≤ 18`） */
function offsetOk(offset: string): boolean {
  const m = /^([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(offset);
  return m !== null && Number(m[2]) <= OFFSET_LIMIT_HOURS;
}

/** 取必需的分量（必须是范围内的整数），否则抛 `EVAL_TEMPORAL_VALUE` */
function intComponent(v: Value, fnName: string, name: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw temporalValueError(fnName, {
      component: `${name} = ${v === null ? 'null' : String(v)}`,
      expected: 'number',
    });
  }
  return v;
}

/**
 * 校验时间文本里的**时分秒范围**（`date and time` 分支用；`time` 分支走 `validTimeText`）。
 *
 * 为什么必须自己做：Temporal 把 `23:59:60` 当闰秒**静默规整**成 `23:59:59`，
 * 而 DMN/TCK 明确要求报错（1116#057）。其余越界（`24:00:01` / `00:60:00`）Temporal 本身会抛，
 * 但这里统一拦一道，口径才一致 —— 也算"写法层面的规矩由我们守"。
 */
function clockOutOfRange(text: string): boolean {
  const m = /(?:^|T)(\d{2}):(\d{2})(?::(\d{2}))?(?:[.,]\d+)?$/.exec(text);
  if (!m) return false;
  const s = m[3] === undefined ? 0 : Number(m[3]);
  return Number(m[1]) > 23 || Number(m[2]) > 59 || s > 59;
}

/**
 * 纯时间文本必须是 FEEL 的**扩展格式** `HH:MM[:SS[.fff]]`。
 *
 * Temporal 的解析器还认 ISO 基本格式 —— `time(2017)` 会被它读成 `20:17:00`，
 * 但 `2017` 在 FEEL 里是个数字、不是时间，TCK 1116#054 判它是 `errorResult`。
 * 顺带把时分秒越界（`24:00:01` / `23:59:60`）一并判掉。
 */
function validTimeText(text: string): boolean {
  const m = /^(\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?$/.exec(text);
  if (!m) return false;
  const s = m[3] === undefined ? 0 : Number(m[3]);
  return Number(m[1]) <= 23 && Number(m[2]) <= 59 && s <= 59;
}

/**
 * FEEL 时间文本 → 时间值（所有构造器的**唯一文本入口**）。
 *
 * 与 Temporal 的分工：**写法层面的规矩由我们守**（年份位数与符号、偏移上限 `±18:00`、
 * 偏移与时区名不可并存、时区名必须真实存在、时分秒不得越界），**其余交给 Temporal**
 * （月/日范围、闰年、格式细节）。如此才分得清"写法非法"（抛）与
 * "写法合法但实现源不可表示"（给 `null`，登记 `known-gaps`）。
 *
 * `fnName` 非 null = 具名构造器调用（失败抛错）；`null` = `@"…"` 字面量（失败给 `null`）。
 */
function parseText(kind: FeelTemporal['kind'], raw: string, fnName: string | null): Value {
  const T = getTemporal();
  if (!T) return null;
  const src = raw.trim();
  const expected = kind === 'dateTime' ? 'date and time' : kind;

  const at = src.indexOf('@');
  let head = at > 0 ? src.slice(0, at) : src;
  const z = parseZone(src);

  // 偏移与时区名互斥（TCK 1116#071 / 1117#060）：`@` 之前不得再挂偏移
  if (z.zone !== null && /(?:Z|[+-]\d\d:?\d\d(?::\d\d)?)$/i.test(head)) {
    return shapeFail(fnName, src, expected);
  }
  if (z.offset !== null && !offsetOk(z.offset)) return shapeFail(fnName, src, expected);
  if (z.zone !== null && !zoneExists(z.zone)) return shapeFail(fnName, src, expected);

  if (kind === 'duration') {
    // ISO 8601 不允许 `PT0.S` 这种"小数点后直接跟单位"，但 TCK 1120#011 要求按 0 秒解析
    const patched = head.replace(/(\d)\.(?=[A-Z]|$)/g, '$1.0');
    try {
      const norm = normalizeDuration(T, T.Duration.from(patched), patched);
      return wrap('duration', norm.obj, undefined, undefined, norm.text);
    } catch {
      return shapeFail(fnName, src, expected);
    }
  }

  // 年份只对"看起来像日期"的串动手（`11:22:33` 这类不能被误判成年份）
  if (kind !== 'time' && /^-?\d+-\d{2}-\d{2}/.test(head)) {
    const conv = convertYear(head);
    if (conv === 'overflow') return null; // 写法合法、但超出实现源可表示范围
    if (conv === 'invalid') return shapeFail(fnName, src, expected);
    head = conv;
  }

  if (kind === 'time') {
    // PlainTime 不收偏移 / `Z`（`23:59:00Z` 会抛），剥离后由 `src` 还原偏移
    const local = localTimeOf(head);
    if (!validTimeText(local)) return shapeFail(fnName, src, expected);
    try {
      return wrap('time', T.PlainTime.from(local), src);
    } catch {
      return shapeFail(fnName, src, expected);
    }
  }

  if (kind === 'date') {
    try {
      return wrap('date', T.PlainDate.from(head), src);
    } catch {
      return shapeFail(fnName, src, expected);
    }
  }

  // date and time：Plain* 家族同样不收偏移 / `Z`，剥离后再交给 Temporal
  const local = localTimeOf(head);
  if (clockOutOfRange(local)) return shapeFail(fnName, src, expected);
  try {
    if (z.zone !== null) return wrap('dateTime', T.ZonedDateTime.from(`${local}[${z.zone}]`), src);
    return wrap('dateTime', T.PlainDateTime.from(local), src);
  } catch {
    return shapeFail(fnName, src, expected);
  }
}

/** 纯时间串（可带 `Z` / `±HH:MM[:SS]` 偏移）→ 本地字段串；Plain* 家族都不收偏移 */
function localTimeOf(text: string): string {
  return text.replace(/(?:Z|[+-]\d\d:?\d\d(?::\d\d)?)$/i, '');
}

/* ---------------- 构造器（含重载分派） ---------------- */

/** 零偏移（`P0D` / `PT0H` 都归一到这里，`zoneSuffix` 会写成 `Z`） */
const ZERO_OFFSET: ZoneInfo = { offset: '+00:00', zone: null };

/** 时长文本 → 时长值（失败给 `null`） */
function durationFromText(text: string): Value {
  return parseText('duration', text, null);
}

/** 日期 / 时间 / 日期时间文本 → 时间值（失败给 `null`；具名构造器另行传 fnName 抛错） */
function temporalFromText(kind: 'date' | 'time' | 'dateTime', text: string): Value {
  return parseText(kind, text, null);
}

/** 取「有年月日」的时间值（date / date and time）；不是则 null */
function asDateLike(v: Value): FeelTemporal | null {
  return isTemporal(v) && (v.kind === 'date' || v.kind === 'dateTime') ? v : null;
}

/** 取「时间」值；不是则 null */
function asTimeLike(v: Value): FeelTemporal | null {
  return isTemporal(v) && v.kind === 'time' ? v : null;
}

/**
 * 从一个已有时间值里**取日期部分**（`date(<date/date-time>)`，TCK 1115#017~#024、#051）。
 * date → 原样；date and time → 年月日（偏移/时区/时分秒一律丢弃）。
 */
function dateOf(v: FeelTemporal): Value {
  const T = getTemporal();
  if (!T) return null;
  if (v.kind === 'date') return v;
  if (v.kind !== 'dateTime') return null;
  const raw = v.raw as { year: number; month: number; day: number };
  try {
    return wrap('date', T.PlainDate.from({ year: raw.year, month: raw.month, day: raw.day }));
  } catch {
    return null;
  }
}

/**
 * 从一个已有时间值里**取时间部分**（`time(<time/date-time/date>)`，TCK 1116#030~#037、#049~#053）。
 *
 * - `time` → 原样；
 * - `date and time` → 时分秒 + **它自己的偏移/时区**（从 `iso` 回溯，Plain* 会丢偏移）；
 * - `date` → `00:00:00Z`（TCK 1116#053 的期望如此：日期没有偏移，转成时刻按零偏移记）。
 */
function timeOf(v: FeelTemporal): Value {
  const T = getTemporal();
  if (!T) return null;
  if (v.kind === 'time') return v;
  if (v.kind === 'date') {
    try {
      return wrap('time', T.PlainTime.from({ hour: 0, minute: 0, second: 0 }), undefined, ZERO_OFFSET);
    } catch {
      return null;
    }
  }
  if (v.kind !== 'dateTime') return null;
  const raw = v.raw as {
    hour: number;
    minute: number;
    second: number;
    millisecond: number;
    microsecond: number;
    nanosecond: number;
  };
  try {
    const pt = T.PlainTime.from({
      hour: raw.hour,
      minute: raw.minute,
      second: raw.second,
      millisecond: raw.millisecond,
      microsecond: raw.microsecond,
      nanosecond: raw.nanosecond,
    });
    return wrap('time', pt, undefined, parseZone(v.iso));
  } catch {
    return null;
  }
}

/**
 * 时长值 → UTC 偏移标注（`time(…, duration)` 的第四参，TCK 1116#039~#048、#082/#083）。
 * 只取时/分/秒拼 `±HH:MM[:SS]`，并守 `±18:00` 上限（`P1D` 这类日分量同样落进总秒数一起判）。
 */
function offsetZone(v: Value, fnName: string): ZoneInfo {
  if (!isTemporal(v) || v.kind !== 'duration') {
    throw temporalValueError(fnName, { component: `offset = ${feelTypeName(v)}`, expected: 'duration' });
  }
  const raw = v.raw as Record<string, number>;
  const total =
    (raw.days ?? 0) * 86400 +
    (raw.hours ?? 0) * 3600 +
    (raw.minutes ?? 0) * 60 +
    (raw.seconds ?? 0);
  const sign = total < 0 ? '-' : '+';
  const a = Math.abs(total);
  const hh = Math.floor(a / 3600);
  const mm = Math.floor((a % 3600) / 60);
  const ss = a % 60;
  if (hh > OFFSET_LIMIT_HOURS) {
    throw temporalValueError(fnName, { component: `offset = ${v.iso}`, expected: 'within ±18:00' });
  }
  const pad = (x: number) => String(x).padStart(2, '0');
  return { offset: `${sign}${pad(hh)}:${pad(mm)}${ss ? `:${pad(ss)}` : ''}`, zone: null };
}

/** `date(from)`：字符串 / date / date-time 三种入参（TCK 1115#011~#024、#050/#051） */
function dateFromArg(v: Value, fnName: string): Value {
  if (isTemporal(v)) {
    const d = dateOf(v);
    if (d === null) throw temporalValueError(fnName, { value: feelTypeName(v), expected: 'date' });
    return d;
  }
  const s = toStr(v);
  if (s === null) {
    throw temporalValueError(fnName, { component: `from = ${feelTypeName(v)}`, expected: 'date' });
  }
  return parseText('date', s, fnName);
}

/** `time(from)`：字符串 / time / date-time / date（TCK 1116#017~#037、#053、#080/#081） */
function timeFromArg(v: Value, fnName: string): Value {
  if (isTemporal(v)) {
    const t = timeOf(v);
    if (t === null) throw temporalValueError(fnName, { value: feelTypeName(v), expected: 'time' });
    return t;
  }
  const s = toStr(v);
  if (s === null) {
    throw temporalValueError(fnName, { component: `from = ${feelTypeName(v)}`, expected: 'time' });
  }
  return parseText('time', s, fnName);
}

/** `date and time(from)`：字符串 / date / date-time（TCK 1117#007~#028、#086） */
function dateTimeFromArg(v: Value, fnName: string): Value {
  const T = getTemporal();
  if (!T) return null;
  if (isTemporal(v)) {
    if (v.kind === 'dateTime') return v;
    if (v.kind === 'date') {
      const raw = v.raw as { year: number; month: number; day: number };
      try {
        return wrap(
          'dateTime',
          T.PlainDateTime.from({ year: raw.year, month: raw.month, day: raw.day }),
          undefined,
          NO_ZONE,
        );
      } catch {
        return null;
      }
    }
    throw temporalValueError(fnName, { value: feelTypeName(v), expected: 'date and time' });
  }
  const s = toStr(v);
  if (s === null) {
    throw temporalValueError(fnName, {
      component: `from = ${feelTypeName(v)}`,
      expected: 'date and time',
    });
  }
  return parseText('dateTime', s, fnName);
}

/**
 * `date(<y>, <m>, <d>)` 分量式（TCK 1115#025~#030、#042~#047、#052）。
 *
 * 分量的**类型与范围**是我们守的（必须是整数、月 1–12、日 1–31）；闰年/月末交 Temporal。
 * `|year| > 275760` 超出实现源可表示范围（TCK 用 9 位年测到）→ 给 `null` 并登记 `known-gaps`；
 * 而 10 位年（`-1000999999`）本身就是非法写法 → 抛（由 `intComponent` 的范围实现）。
 */
function dateOfComponents(yv: Value, mv: Value, dv: Value, fnName: string): Value {
  const T = getTemporal();
  if (!T) return null;
  const year = intComponent(yv, fnName, 'year', -999999999, 999999999);
  const month = intComponent(mv, fnName, 'month', 1, 12);
  const day = intComponent(dv, fnName, 'day', 1, 31);
  try {
    return wrap('date', T.PlainDate.from({ year, month, day }));
  } catch {
    if (Math.abs(year) > YEAR_LIMIT) return null; // 写法合法、实现源表示不了
    throw temporalValueError(fnName, {
      component: `date(${year}, ${month}, ${day})`,
      expected: 'date',
    });
  }
}

/** `time(<h>, <m>, <s>[, offset])` 分量式（TCK 1116#015、#038~#048、#076~#079、#082/#083） */
function timeOfComponents(hv: Value, mv: Value, sv: Value, ov: Value, fnName: string): Value {
  const T = getTemporal();
  if (!T) return null;
  const hour = intComponent(hv, fnName, 'hour', 0, 23);
  const minute = intComponent(mv, fnName, 'minute', 0, 59);
  const second = intComponent(sv, fnName, 'second', 0, 59);
  const zone = ov === null || ov === undefined ? NO_ZONE : offsetZone(ov, fnName);
  try {
    return wrap('time', T.PlainTime.from({ hour, minute, second }), undefined, zone);
  } catch {
    throw temporalValueError(fnName, {
      component: `time(${hour}, ${minute}, ${second})`,
      expected: 'time',
    });
  }
}

/**
 * `date and time(<date>, <time>)` 组合式（TCK 1117#029~#054、#087/#088）。
 *
 * 规则（由 #041~#053 这一批反推）：**日期部分**取第一个实参的年月日，
 * **时间部分与偏移/时区**取第二个实参 —— 第一个实参自带的偏移/时区一律**丢弃**。
 */
function combineDateTime(dv: Value, tv: Value, fnName: string): Value {
  const T = getTemporal();
  if (!T) return null;
  const d = asDateLike(dv);
  const t = asTimeLike(tv);
  if (!d) {
    throw temporalValueError(fnName, { component: `date = ${feelTypeName(dv)}`, expected: 'date' });
  }
  if (!t) {
    throw temporalValueError(fnName, { component: `time = ${feelTypeName(tv)}`, expected: 'time' });
  }
  const dr = d.raw as { year: number; month: number; day: number };
  const tr = t.raw as {
    hour: number;
    minute: number;
    second: number;
    millisecond: number;
    microsecond: number;
    nanosecond: number;
  };
  try {
    const raw = T.PlainDateTime.from({
      year: dr.year,
      month: dr.month,
      day: dr.day,
      hour: tr.hour,
      minute: tr.minute,
      second: tr.second,
      millisecond: tr.millisecond,
      microsecond: tr.microsecond,
      nanosecond: tr.nanosecond,
    });
    return wrap('dateTime', raw, undefined, parseZone(t.iso));
  } catch {
    throw temporalValueError(fnName, {
      component: `date and time(${t.iso})`,
      expected: 'date and time',
    });
  }
}

/** 实参个数不合法（既不是 `from` 也不是完整分量）→ 抛 */
function badShape(fnName: string, argc: number, expected: string): never {
  throw temporalValueError(fnName, { component: `argc = ${argc}`, expected });
}

/**
 * 构造器工厂。**按实参个数 + 形参名表分派重载**：
 *
 * - `date`：1 → `from`；3 → `(y,m,d)`；4 → 命名式（`from:` 或 `year:/month:/day:`）
 * - `time`：1 → `from`；3/4 → `(h,m,s[,offset])`；5 → 命名式（`from:` 或 `hour:/…`）
 * - `date and time`：1 → `from`；2 → `(date,time)`；3 → 命名式（`from:` 或 `date:/time:`）
 *
 * 为什么看个数就够：命名调用经 `reorderNamedArgs` 后长度**恒等于形参个数**（缺省位补 `null`），
 * 位置调用则就是实参个数 —— 两者在"位置 0 是否有值"上可分（见 evaluator 的 `call`）。
 */
function construct(kind: 'date' | 'time' | 'dateTime'): NativeFn {
  const fnName = kind === 'dateTime' ? 'date and time' : kind;
  return (args) => {
    if (!getTemporal()) return null;
    const n = args.length;
    const a = (i: number): Value => args[i] ?? null;

    const fromShape = kind === 'date' ? 4 : kind === 'time' ? 5 : 3;
    if (n === 1 || (n === fromShape && a(0) !== null)) {
      if (kind === 'date') return dateFromArg(a(0), fnName);
      if (kind === 'time') return timeFromArg(a(0), fnName);
      return dateTimeFromArg(a(0), fnName);
    }

    if (kind === 'date') {
      if (n === 3) return dateOfComponents(a(0), a(1), a(2), fnName);
      if (n === 4) return dateOfComponents(a(1), a(2), a(3), fnName);
      return badShape(fnName, n, 'date');
    }
    if (kind === 'time') {
      if (n === 3) return timeOfComponents(a(0), a(1), a(2), null, fnName);
      if (n === 4) return timeOfComponents(a(0), a(1), a(2), a(3), fnName);
      if (n === 5) return timeOfComponents(a(1), a(2), a(3), a(4), fnName);
      return badShape(fnName, n, 'time');
    }
    if (n === 2) return combineDateTime(a(0), a(1), fnName);
    if (n === 3) return combineDateTime(a(1), a(2), fnName);
    return badShape(fnName, n, 'date and time');
  };
}

/**
 * `duration(from)`：文本 → 时长值。
 *
 * ★ 失败一律**抛**（不是给 null）—— TCK 1120 把每一种坏输入都列成了 `errorResult`：
 * `#001 duration(null)`、`#002 duration()`（arity）、`#042 duration(2017)`、`#044 duration([])`
 * （类型不符）、`#041 ""`、`#045 "P"`、`#046 "P0"`、`#047 "1Y"`、`#048 "1D"`、`#049 "P1H"`、
 * `#050 "P1S"`、`#043 "2012T-12-2511:00:00Z"`（不是合法 ISO 8601 时长字面量）。
 *
 * ⚠️ 只在**具名构造器**这条路上抛：`@"P1Y"` 字面量与隐式转换仍走 `durationFromText`
 * （`parseText(…, null)` → null），那是"这段文本不是该类型的字面量"，不是类型错误。
 */
function durationFn(): NativeFn {
  const fnName = 'duration';
  return (args) => {
    requireArity(args, fnName, 1);
    if (!getTemporal()) return null;
    const v = args[0] ?? null;
    if (v === null) throw argTypeError(fnName, 'from', 'string', 'null');
    if (typeof v !== 'string') throw argTypeError(fnName, 'from', 'string', feelTypeName(v));
    return parseText('duration', v, fnName);
  };
}

/**
 * `@"…"` 日期时间字面量（FEEL 10.3.2.3）—— 按**字面形态**分派类型。
 *
 * 分派顺序有意如此：`^-?P` 是 duration 专有前缀；`HH:MM` 开头的只可能是 time
 * （否则 `11:22:33` 会被误判成含 `:` 的 date-time）；纯 `YYYY-MM-DD` 是 date；
 * 余下含 `T` 的才是 date-time。
 *
 * ★ 失败一律**抛**（`fnName = '@'`），不是给 null：TCK 0093#test_001 的 `@"foo"`
 * 是 `errorResult`。`@"…"` 是**字面量语法**，写了一个不合规的字面量就是表达式错，
 * 与"运行时值未知"无关 —— 三值语义不覆盖这种情况。
 */
function atLiteralFn(): NativeFn {
  const fnName = '@';
  return (args) => {
    const T = getTemporal();
    const s = toStr(args[0] ?? null);
    if (!T || s === null) return null;
    const text = s.trim();
    if (/^-?P/i.test(text)) return parseText('duration', text, fnName);
    if (/^\d\d:\d\d/.test(text)) return parseText('time', text, fnName);
    if (/^-?\d{4,}-\d\d-\d\d$/.test(text)) return parseText('date', text, fnName);
    return parseText('dateTime', text, fnName);
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
  if (!m) return src.endsWith('Z') ? durationFromText('PT0S') : null;
  let text = 'PT';
  if (Number(m[2])) text += `${Number(m[2])}H`;
  if (Number(m[3])) text += `${Number(m[3])}M`;
  if (text === 'PT') text = 'PT0S';
  return durationFromText(`${m[1] === '-' ? '-' : ''}${text}`);
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
  const fnName = 'years and months duration';
  /*
   * ★ 参数校验**抛**而不是返回 null（TCK 1121#001~#007 / #028~#030 全是 errorResult）：
   * `#001 (null)` `#002 (null,null)` `#003 (date,null)` `#004 (dateTime,null)` `#005 (null,date)`
   * `#006 (null,dateTime)` `#007 ()`（arity）`#028 (2017)` `#029 ("2012T-…")` `#030 ([],[])`。
   * 单参 `#001` 由 arity 拦下 —— 该函数按 DMN 1.4 只接受 `from, to` 两参。
   */
  requireArity(args, fnName, 2);
  const T = getTemporal();
  if (!T) return null;
  const from = args[0] ?? null;
  const to = args[1] ?? null;
  const a = toDateLike(from);
  if (!a) throw argTypeError(fnName, 'from', 'date or date and time', feelTypeName(from));
  const b = toDateLike(to);
  if (!b) throw argTypeError(fnName, 'to', 'date or date and time', feelTypeName(to));
  try {
    const base = (b.year - a.year) * 12 + (b.month - a.month);
    const daysInMonth = a.daysInMonth ?? 30;
    const months = Math.trunc(base + (b.day - a.day) / daysInMonth);
    const d = T.Duration.from({ years: Math.trunc(months / 12), months: months % 12 });
    // 零值按 FEEL 写作 `P0M`（Temporal 的 toString 会退化成 `PT0S`，那是**另一个** FEEL 类型）
    return wrap('duration', d, undefined, undefined, months === 0 ? 'P0M' : isoOf(d));
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
  now: (args, _ctx, rt) => {
    requireArity(args, 'now', 0);
    const T = getTemporal();
    if (!T) return null;
    if (rt?.clock) return localPlain(T, nowDate(rt), 'dateTime');
    if (!T?.Now?.plainDateTimeISO) return null;
    return wrap('dateTime', T.Now.plainDateTimeISO());
  },
  today: (args, _ctx, rt) => {
    requireArity(args, 'today', 0);
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
  date: construct('date'),
  time: construct('time'),
  'date and time': construct('dateTime'),
  dateTime: construct('dateTime'),
  duration: durationFn(),
  'years and months duration': yearsAndMonthsDuration,
  yearsAndMonthsDuration,
  year: propGetter('year'),
  month: propGetter('month'),
  day: propGetter('day'),
  // 日期分量函数（DMN 1.4 §10.3.4.3）—— 多词名已登记进 core/spaced-names
  'day of year': datePartFn('day of year', (raw) =>
    typeof raw?.dayOfYear === 'number' ? raw.dayOfYear : null,
  ),
  'week of year': datePartFn('week of year', (raw) =>
    typeof raw?.weekOfYear === 'number' ? raw.weekOfYear : null,
  ),
  'day of week': datePartFn('day of week', (raw) => {
    const d = raw?.dayOfWeek;
    return typeof d === 'number' && d >= 1 && d <= 7 ? (DAY_NAMES[d - 1] ?? null) : null;
  }),
  'month of year': datePartFn('month of year', (raw) => {
    const m = raw?.month;
    return typeof m === 'number' && m >= 1 && m <= 12 ? (MONTH_NAMES[m - 1] ?? null) : null;
  }),
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
  const v = temporalFromText('date', s);
  return isTemporal(v) ? v : null;
}

export function timeValue(s: string): FeelTemporal | null {
  const v = temporalFromText('time', s);
  return isTemporal(v) ? v : null;
}

export function dateTimeValue(s: string): FeelTemporal | null {
  const v = temporalFromText('dateTime', s);
  return isTemporal(v) ? v : null;
}

export function durationValue(s: string): FeelTemporal | null {
  const v = durationFromText(s);
  return isTemporal(v) ? v : null;
}
