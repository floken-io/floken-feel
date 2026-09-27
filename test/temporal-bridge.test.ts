/**
 * `@floken/feel/temporal` · JS 侧值桥与算子（`toFeel` 一族）
 *
 * 这些不是 FEEL 内置函数（表达式里的 `date("…")` 早已可用），而是给**宿主 JS 代码**用的：
 * 把 `new Date()` 之类宿主值转成能塞进 `context` 的 FEEL 值，并在 JS 侧直接读分量、做运算。
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  ensureTemporal,
  evaluateTemporal,
  getTemporal,
  toFeel,
  isDate,
  isTime,
  isDateTime,
  isDuration,
  isZoned,
  zoneEquals,
  unwrap,
  year,
  month,
  day,
  hour,
  minute,
  second,
  dayOfWeek,
  timezone,
  timeOffset,
  years,
  months,
  days,
  hours,
  minutes,
  seconds,
  date,
  time,
  dateAndTime,
  duration,
  dateFrom,
  timeFrom,
  dateOfValue,
  timeOfValue,
  combine,
  now,
  today,
  addDuration,
  subtractTemporals,
  addDurations,
  absDuration,
  durationEquals,
  toComparable,
} from '../src/entries/temporal.js';
import { isTemporal } from '../src/entries/index.js';

describe('temporal · JS 侧值桥 toFeel()', () => {
  beforeAll(async () => {
    await ensureTemporal();
  });

  it('JS Date → date and time（按 UTC 记，避免随部署机器时区漂移）', () => {
    const v = toFeel(new Date('2020-06-01T10:30:00Z'));
    expect(isDateTime(v)).toBe(true);
    expect((v as { iso: string }).iso).toBe('2020-06-01T10:30:00Z');
  });

  it('已是 FEEL 值 → 原样返回（同一引用）', () => {
    const d = date('2020-01-01');
    expect(toFeel(d)).toBe(d);
  });

  it('不认识的值原样透传（桥不制造新失败）', () => {
    expect(toFeel('2020-01-01')).toBe('2020-01-01');
    expect(toFeel(42)).toBe(42);
    expect(toFeel(null)).toBe(null);
  });

  it('非法 Date（Invalid Date）→ null', () => {
    expect(toFeel(new Date('nope'))).toBe(null);
  });

  it('原生/polyfill 的 Temporal 实例按其 tag 分派', () => {
    const T = getTemporal();
    expect(isDate(toFeel(T.PlainDate.from('2020-06-01')))).toBe(true);
    expect(isTime(toFeel(T.PlainTime.from('10:30:00')))).toBe(true);
    expect(isDateTime(toFeel(T.PlainDateTime.from('2020-06-01T10:30:00')))).toBe(true);
    expect(isDateTime(toFeel(T.Instant.from('2020-06-01T10:30:00Z')))).toBe(true);
    // ZonedDateTime 剥掉方括号，按偏移记（同一瞬时）
    const zdt = toFeel(T.ZonedDateTime.from('2020-06-01T10:30:00+09:00[Asia/Tokyo]'));
    expect(isDateTime(zdt)).toBe(true);
    expect(isZoned(zdt)).toBe(true);
  });

  it('年月类时长的类别要保住（P0M ≠ PT0S）', () => {
    const T = getTemporal();
    expect((toFeel(T.Duration.from('P1Y2M')) as { iso: string }).iso).toBe('P1Y2M');
    expect((toFeel(T.Duration.from({ years: 0, months: 0 })) as { iso: string }).iso).toBe('P0M');
  });

  it('★ 桥接后的值能直接进 context 参与比较（补这个桥的目的用例）', () => {
    const x = toFeel(new Date('2020-06-01T00:00:00Z'));
    const r = evaluateTemporal('x > date and time("2020-01-01T00:00:00Z")', { x });
    expect(r.value).toBe(true);
  });
});

describe('temporal · 判定与分量读取', () => {
  it('四个细类判定 + isZoned', () => {
    expect(isDate(date('2020-01-01'))).toBe(true);
    expect(isTime(time('10:30:00'))).toBe(true);
    expect(isDateTime(dateAndTime('2020-01-01T10:30:00Z'))).toBe(true);
    expect(isDuration(duration('P1D'))).toBe(true);
    expect(isDate(null)).toBe(false);
    expect(isZoned(dateAndTime('2020-01-01T10:30:00Z'))).toBe(true);
    expect(isZoned(date('2020-01-01'))).toBe(false);
  });

  it('日期/时间分量', () => {
    const d = date('2020-06-01');
    expect(year(d)).toBe(2020);
    expect(month(d)).toBe(6);
    expect(day(d)).toBe(1);
    expect(dayOfWeek(d)).toBe(1); // 2020-06-01 是周一（Temporal 口径 1=周一）
    const t = time('10:30:45');
    expect(hour(t)).toBe(10);
    expect(minute(t)).toBe(30);
    expect(second(t)).toBe(45);
    expect(year(t)).toBe(null); // 分量不属于该 kind → null
  });

  it('时区与偏移', () => {
    expect(timezone(dateAndTime('2020-06-01T10:30:00@Asia/Tokyo'))).toBe('Asia/Tokyo');
    expect(timezone(date('2020-06-01'))).toBe(null);
    expect((timeOffset(dateAndTime('2020-06-01T10:30:00+05:00')) as { iso: string }).iso).toBe(
      'PT5H',
    );
    expect(timeOffset(date('2020-06-01'))).toBe(null);
  });

  it('时长分量：跨类访问 = null（规范口径）', () => {
    const ym = duration('P1Y2M');
    const dt = duration('P1DT2H');
    expect(years(ym)).toBe(1);
    expect(months(ym)).toBe(2);
    expect(days(ym)).toBe(null);
    expect(hours(dt)).toBe(2);
    expect(minutes(dt)).toBe(0);
    expect(seconds(dt)).toBe(0);
    expect(years(dt)).toBe(null);
  });

  it('unwrap 拿到底层实现源；非时间值 → null', () => {
    expect(unwrap(date('2020-01-01'))).toBeTruthy();
    expect(unwrap('x')).toBe(null);
  });
});

describe('temporal · JS 侧构造', () => {
  it('文本构造与非法输入', () => {
    expect((date('2020-02-30') as unknown)).toBe(null);
    expect((date('2020-01-01') as { iso: string }).iso).toBe('2020-01-01');
    expect((time('10:30:00') as { iso: string }).iso).toBe('10:30:00');
    expect((dateAndTime('2020-01-01T10:30:00Z') as { iso: string }).iso).toBe(
      '2020-01-01T10:30:00Z',
    );
  });

  it('分量构造（非法给 null，不抛）', () => {
    expect((dateFrom(2020, 2, 29) as { iso: string }).iso).toBe('2020-02-29'); // 闰年
    /*
     * 「月内没有这一天」一律 null —— 与表达式内 `date(2020, 2, 30)` 同行为。
     * 曾因 Temporal 对象分量的 overflow 默认 `constrain` 被静默规整成 `2020-02-29`，
     * 与字符串路径 `date("2020-02-30")` → null、扩展年路径 `date(999999999, 2, 30)` → null
     * 自相矛盾（feelin 同样返回 null）→ 已强制 `overflow: 'reject'`。
     */
    expect(dateFrom(2020, 2, 30)).toBe(null);
    expect(dateFrom(2021, 2, 29)).toBe(null); // 平年没有 2 月 29 日
    expect(dateFrom(2020, 4, 31)).toBe(null); // 4 月只有 30 天
    expect((dateFrom(2020, 4, 30) as { iso: string }).iso).toBe('2020-04-30');
    expect(dateFrom(2020, 13, 1)).toBe(null); // 月超出 1–12：由我们自己守并返回 null
    expect((timeFrom(10, 30, 0) as { iso: string }).iso).toBe('10:30:00');
    expect((timeFrom(10, 30, 0, duration('PT5H')) as { iso: string }).iso).toBe('10:30:00+05:00');
  });

  it('duration(数字) 按秒解释', () => {
    expect((duration(30) as { iso: string }).iso).toBe('PT30S');
    expect((duration('P1D') as { iso: string }).iso).toBe('P1D');
  });

  it('取部分与组合', () => {
    expect((dateOfValue(dateAndTime('2020-06-01T10:30:00')) as { iso: string }).iso).toBe(
      '2020-06-01',
    );
    expect((timeOfValue(date('2020-06-01')) as { iso: string }).iso).toBe('00:00:00Z');
    expect(
      (combine(date('2020-01-01'), time('10:30:00')) as { iso: string }).iso,
    ).toBe('2020-01-01T10:30:00');
    expect(combine(date('2020-01-01'), duration('P1D'))).toBe(null); // 第二个实参不是 time
  });

  it('now() / today() 可注入 clock', () => {
    const clock = () => new Date('2020-06-01T10:30:00Z');
    expect(isDateTime(now(clock))).toBe(true);
    expect(isDate(today(clock))).toBe(true);
  });
});

describe('temporal · JS 侧运算', () => {
  const isoOf = (v: unknown) => (v as { iso: string } | null)?.iso ?? null;

  it('时间值 ± 时长', () => {
    expect(isoOf(addDuration(date('2020-01-01'), duration('P1D')))).toBe('2020-01-02');
    expect(isoOf(addDuration(date('2020-01-01'), duration('P1D'), -1))).toBe('2019-12-31');
    expect(addDuration(date('2020-01-01'), date('2020-01-02'))).toBe(null); // 第二参不是时长
  });

  it('同类时间值相减 → 时长', () => {
    expect(isoOf(subtractTemporals(date('2020-01-02'), date('2020-01-01')))).toBe('P1D');
    expect(isoOf(subtractTemporals(time('10:00:00'), time('09:00:00')))).toBe('PT1H');
    expect(subtractTemporals(date('2020-01-02'), time('09:00:00'))).toBe(null); // 跨 kind
  });

  it('时长相加：混类 → null', () => {
    expect(isoOf(addDurations(duration('P1D'), duration('PT12H')))).toBe('P1DT12H');
    expect(isoOf(addDurations(duration('P1D'), duration('PT12H'), -1))).toBe('PT12H');
    expect(addDurations(duration('P1Y'), duration('P1D'))).toBe(null);
  });

  it('绝对值 / 相等 / 可比数 / 时区相等', () => {
    expect(isoOf(absDuration(duration('-P1D')))).toBe('P1D');
    expect(durationEquals(duration('P1D'), duration('PT24H'))).toBe(true);
    expect(durationEquals(duration('P0M'), duration('PT0S'))).toBe(false);
    expect(toComparable(date('1970-01-02'))).toBe(1);
    expect(toComparable(duration('P1D'))).toBe(86400);
    expect(toComparable('x')).toBe(null);
    expect(zoneEquals('Z', '+00:00')).toBe(true);
    expect(zoneEquals('Z', 'Asia/Tokyo')).toBe(false);
  });

  it('桥接值与表达式内构造的值语义一致', () => {
    const bridged = toFeel(new Date('2020-06-01T10:30:00Z'));
    const built = dateAndTime('2020-06-01T10:30:00Z');
    expect(isTemporal(bridged)).toBe(true);
    expect((bridged as { eqKey?: string }).eqKey).toBe((built as { eqKey?: string }).eqKey);
  });
});
