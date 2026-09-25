import { describe, it, expect } from 'vitest';
import { evaluate, highlight, isRange, isTemporal } from '../src/entries/index.js';
// 注册时间能力（import 即注册）—— `@"…"` 与 date/time 断言需要它
import '../src/entries/temporal.js';

/**
 * TCK 驱动修复的回归集（2026-09-25）
 *
 * 每一条都对应一次真实失分：跑 B 口径（79 组 / 2053 断言）时暴露、修好后钉在这里，
 * 防止后续改 parser/求值器时悄悄退化。来源用例写在注释里，便于回溯。
 */

describe('floken-feel · TCK 修复回归 · 词法与字面量', () => {
  it('指数记法 `1.23e4`（TCK 0077/0078 数值边界）', () => {
    expect(evaluate('1.23e4').value).toBe(12300);
    expect(evaluate('1.0E-3').value).toBeCloseTo(0.001, 12);
    expect(evaluate('-1.5e+2').value).toBe(-150);
    // `e` 后面不是数字时不得被吞（仍按名字处理，最终是语法错误或名字）
    expect(evaluate('12300 = 1.23e4').value).toBe(true);
  });

  it('日期时间字面量 `@"…"` 四种形态（TCK 0093-feel-at-literals）', () => {
    expect(evaluate('@"2020-01-01"').value).toMatchObject({ kind: 'date', iso: '2020-01-01' });
    expect(evaluate('@"11:22:33"').value).toMatchObject({ kind: 'time' });
    expect(evaluate('@"2020-01-01T10:20:30"').value).toMatchObject({ kind: 'dateTime' });
    expect(evaluate('@"P1Y2M"').value).toMatchObject({ kind: 'duration' });
    expect(isTemporal(evaluate('@"2020-01-01"').value)).toBe(true);
  });

  it('`@` 字面量可参与比较（TCK 0068-feel-equality）', () => {
    expect(evaluate('@"2020-01-01" = date("2020-01-01")').value).toBe(true);
    expect(evaluate('@"2020-01-01" = @"2020-01-02"').value).toBe(false);
  });

  it('高亮把 `@"…"` 单列 temporal 类', () => {
    const spans = highlight('@"2020-01-01"');
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ kind: 'temporal', value: '@"2020-01-01"' });
  });
});

describe('floken-feel · TCK 修复回归 · 区间（Range 一等公民）', () => {
  it('开闭括号四种写法，含 `)` 收尾（TCK 0068/0072）', () => {
    const r1 = evaluate('[1..10)').value;
    const r2 = evaluate('[1..10[').value;
    expect(isRange(r1) && isRange(r2)).toBe(true);
    expect(r1).toMatchObject({ fromInclusive: true, toInclusive: false });
    expect(r2).toMatchObject({ fromInclusive: true, toInclusive: false });
    expect(evaluate('[1..10) = [1..10[').value).toBe(true);
  });

  it('无界区间：端点为 null 按「无界」处理，不再返回 null（TCK 0072 大项）', () => {
    expect(evaluate('1 in <= 10').value).toBe(true);
    expect(evaluate('10 in <= 10').value).toBe(true);
    expect(evaluate('11 in <= 10').value).toBe(false);
    expect(evaluate('10 in < 10').value).toBe(false);
    expect(evaluate('11 in >= 10').value).toBe(true);
    expect(evaluate('10 in > 10').value).toBe(false);
    expect(evaluate('10 in (1..null]').value).toBe(true);
    expect(evaluate('5 in [10..null)').value).toBe(false);
  });

  it('比较符写法与区间写法等价（FEEL 10.3.2.5）', () => {
    expect(evaluate('(<= 10) = (null..10]').value).toBe(true);
    expect(evaluate('(< 10) = (null..10)').value).toBe(true);
    expect(evaluate('(>= 10) = [10..null)').value).toBe(true);
    expect(evaluate('(=10) = [10..10]').value).toBe(true);
  });

  it('`in` 右侧裸值按相等判定；列表元素是区间按包含（TCK 0072）', () => {
    expect(evaluate('1 in 1').value).toBe(true);
    expect(evaluate('1 in 5').value).toBe(false);
    expect(evaluate('10 in =10').value).toBe(true);
    expect(evaluate('1 in [[2..4], [1..3]]').value).toBe(true);
    expect(evaluate('9 in [[2..4], [1..3]]').value).toBe(false);
  });

  it('三值逻辑：输入为 null → null；类型不可比 → null', () => {
    expect(evaluate('null in [1..10]').value).toBe(null);
    expect(evaluate('"a" in <= 10').value).toBe(null);
  });
});
