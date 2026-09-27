import { describe, it, expect, beforeAll } from 'vitest';
import {
  ensureTemporal,
  evaluateTemporal,
  getTemporal,
  withTemporal,
  dateValue,
  dateTimeValue,
  TEMPORAL_BUILTINS,
} from '../src/entries/temporal.js';
import { evaluate, isTemporal, FeelNotLoadedError } from '../src/entries/index.js';

describe('@floken-io/feel/temporal · 时间类型与函数', () => {
  beforeAll(async () => {
    await ensureTemporal();
  });

  it('ensureTemporal 后可拿到 Temporal', () => {
    expect(getTemporal()).toBeTruthy();
  });

  it('date("2020-01-01") 得到 date 值', () => {
    const r = evaluateTemporal('date("2020-01-01")');
    expect(isTemporal(r.value)).toBe(true);
    expect(r.value).toMatchObject({ kind: 'date', iso: '2020-01-01' });
  });

  it('time / date and time / duration', () => {
    expect(evaluateTemporal('time("10:20:30")').value).toMatchObject({ kind: 'time' });
    expect(evaluateTemporal('date and time("2020-01-01T10:20:30")').value).toMatchObject({
      kind: 'dateTime',
    });
    expect(evaluateTemporal('duration("P1D")').value).toMatchObject({ kind: 'duration' });
  });

  it('now() / today()', () => {
    expect(evaluateTemporal('now()').value).toMatchObject({ kind: 'dateTime' });
    expect(evaluateTemporal('today()').value).toMatchObject({ kind: 'date' });
  });

  it('时间取值函数', () => {
    expect(evaluateTemporal('year(date("2020-01-01"))').value).toBe(2020);
    expect(evaluateTemporal('month(date("2020-03-01"))').value).toBe(3);
    expect(evaluateTemporal('day(date("2020-01-05"))').value).toBe(5);
  });

  it('years and months duration', () => {
    const r = evaluateTemporal('years and months duration(date("2019-01-01"), date("2020-03-01"))');
    expect(isTemporal(r.value)).toBe(true);
  });

  it('★ AC-F7 正向面：import 本档后核心的 evaluate 直接可用（import 即注册）', () => {
    // 2026-09-25 起本档在 import 时自动 `ensureTemporal()` + `registerTemporalBuiltins()`，
    // 因此不需要再手动调任何 API；顺带覆盖 `@"…"` 字面量。
    // 反向面（未加载 → 抛**可执行**修复提示）在干净进程里验证：test/cold-start.test.ts。
    expect(isTemporal(evaluate('date("2020-01-01")').value)).toBe(true);
    expect(isTemporal(evaluate('@"2020-01-01"').value)).toBe(true);
    expect(isTemporal(evaluate('duration("P1D")').value)).toBe(true);
  });

  it('withTemporal 合并表同时含核心与时间函数', () => {
    const merged = withTemporal();
    expect(typeof merged['abs']).toBe('function');
    expect(typeof merged['date']).toBe('function');
    expect(Object.keys(TEMPORAL_BUILTINS).length).toBeGreaterThan(5);
  });

  it('便捷构造', () => {
    expect(dateValue('2020-01-01')).toMatchObject({ kind: 'date' });
    expect(dateTimeValue('2020-01-01T00:00:00')).toMatchObject({ kind: 'dateTime' });
  });
});
