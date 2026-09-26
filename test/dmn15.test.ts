/**
 * floken-feel · **DMN 1.5 / 1.6 语言层补齐**测试
 *
 * 背景（2026-09-26 用户拍板）：元模型与函数表**按最新规范来**，不保留旧版本兼容层。
 * 本轮（A 档）在 `floken-feel` 内补齐 DMN 1.5 相对 1.4 的 FEEL **语言层**新增：
 *   ① `list replace`（新函数，两种形态）
 *   ② duration 取负 `-duration("PT1H")`（Clauses 10.3.2.3.7 / 10.3.2.3.8）
 *   ③ `range()` 区间构造（含 1.5 增强的字符串形态 `range("[18..21)")`）
 *
 * 错误口径沿用本包既定的**双出口**（`test/strict.test.ts`）：
 * 默认 `evaluate()` 给 `null + 诊断`，`evaluateStrict()` 抛 `FeelError`。
 */

import { describe, it, expect } from 'vitest';
import {
  FEEL_ERROR_CODES,
  evaluate,
  evaluateStrict,
  isRange,
  type Value,
} from '../src/entries/index.js';
// 时间档：②③ 都依赖 `duration()` / 时间值取负的延迟实现
import '../src/entries/temporal.js';

function code(src: string): string | null {
  try {
    evaluateStrict(src);
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? 'NON_FEEL_ERROR';
  }
}

/** 默认模式：出事 → `null`，且必须留下诊断（不静默） */
function nullWithDiag(src: string): void {
  const r = evaluate(src);
  expect(r.value, `default value of ${src}`).toBe(null);
  expect(r.warnings.length, `default diagnostics of ${src}`).toBeGreaterThan(0);
}

function val(src: string): Value {
  return evaluate(src).value;
}

describe('① list replace（DMN 1.5 新增）', () => {
  it('位置形态：1-based 替换单个元素（规范示例）', () => {
    expect(val('list replace([2, 4, 7, 8], 3, 6)')).toEqual([2, 4, 6, 8]);
  });

  it('位置形态：负位置自末尾计数', () => {
    expect(val('list replace([2, 4, 7, 8], -1, 0)')).toEqual([2, 4, 7, 0]);
  });

  it('match 形态：判定为 true 的项替换为 newItem（规范示例）', () => {
    expect(val('list replace([2, 4, 7, 8], function(item, newItem) item < newItem, 5)')).toEqual([
      5, 5, 7, 8,
    ]);
  });

  it('match 形态：判定非 true（含 null）保持原值 —— 三值逻辑', () => {
    expect(val('list replace([1, 2, 3], function(item) null, 9)')).toEqual([1, 2, 3]);
  });

  it('不改动原列表（FEEL 列表不可变语义）', () => {
    expect(val('list replace([1, 2, 3], 1, 9)')).toEqual([9, 2, 3]);
    expect(val('list replace([1, 2, 3], 1, 0)')).toEqual([0, 2, 3]);
  });

  it('错误：位置越界 → ARG_RANGE（null+诊断 / throw）', () => {
    for (const src of ['list replace([1, 2], 9, 0)', 'list replace([], 1, 0)']) {
      nullWithDiag(src);
      expect(code(src)).toBe(FEEL_ERROR_CODES.EVAL_ARG_RANGE);
    }
  });

  it('错误：列表实参非列表 → ARG_TYPE', () => {
    for (const src of ['list replace("x", 1, 0)', 'list replace([1], "1", 0)']) {
      nullWithDiag(src);
      expect(code(src)).toBe(FEEL_ERROR_CODES.EVAL_ARG_TYPE);
    }
  });

  it('错误：arity 不符 → ARG_COUNT', () => {
    for (const src of ['list replace([1])', 'list replace([1], 1, 0, 0)']) {
      nullWithDiag(src);
      expect(code(src)).toBe(FEEL_ERROR_CODES.EVAL_ARG_COUNT);
    }
  });
});

describe('② duration 取负（DMN 1.5 Clauses 10.3.2.3.7/8）', () => {
  it('days and time duration 取负 → -PT1H', () => {
    const v = val('-duration("PT1H")');
    expect(evaluate('string(-duration("PT1H"))').value).toBe('-PT1H');
    expect(v).not.toBe(null);
  });

  it('years and months duration 取负 → -P1Y2M', () => {
    expect(evaluate('string(-duration("P1Y2M"))').value).toBe('-P1Y2M');
  });

  it('取负后参与运算：`date + -duration` 等于往回退', () => {
    expect(evaluate('string(date("2020-01-01") + -duration("P1D"))').value).toBe('2019-12-31');
    expect(evaluate('string(date("2020-01-01") - -duration("P1D"))').value).toBe('2020-01-02');
  });

  it('双重取负回到原值', () => {
    expect(evaluate('string(- -duration("PT1H"))').value).toBe('PT1H');
  });

  it('非 duration 取负无定义 → ARG_TYPE（null+诊断 / throw）', () => {
    for (const src of [
      '-date("2020-01-01")',
      '-time("10:00:00")',
      '-date and time("2020-01-01T10:00:00")',
    ]) {
      nullWithDiag(src);
      expect(code(src)).toBe(FEEL_ERROR_CODES.EVAL_ARG_TYPE);
    }
  });

  it('数字取负保持既有行为；`-null` 仍是 null（三值）', () => {
    expect(val('-5')).toBe(-5);
    nullWithDiag('-null');
  });
});

describe('③ range() 区间构造', () => {
  it('字符串形态（DMN 1.5 增强）：开闭按括号', () => {
    const r = val('range("[18..21)")');
    expect(isRange(r)).toBe(true);
    expect(val('18 in range("[18..21)")')).toBe(true);
    expect(val('21 in range("[18..21)")')).toBe(false);
    expect(val('20 in range("[18..21)")')).toBe(true);
    expect(val('18 in range("(18..21]")')).toBe(false);
  });

  it('字符串形态：科学计数法端点（1.5 数字字面量）', () => {
    expect(val('1200 in range("[1.2e3..2e3]")')).toBe(true);
  });

  // FEEL 源码里的嵌套双引号要转义，故 JS 侧写 `\\"`
  it('字符串形态：引号字符串端点', () => {
    expect(val('"b" in range("[\\"a\\"..\\"c\\"]")')).toBe(true);
    expect(val('"d" in range("[\\"a\\"..\\"c\\"]")')).toBe(false);
  });

  it('双参形态：闭区间 [from..to]', () => {
    const r = val('range(1, 10)');
    expect(isRange(r)).toBe(true);
    expect(val('1 in range(1, 10)')).toBe(true);
    expect(val('10 in range(1, 10)')).toBe(true);
    expect(val('11 in range(1, 10)')).toBe(false);
  });

  it('错误：串不是区间字面量 / 端点不是字面量 → ARG_TYPE', () => {
    const cases = ['range("bad")', 'range("[a..c]")', 'range("18..21")'];
    for (const src of cases) {
      nullWithDiag(src);
      expect(code(src)).toBe(FEEL_ERROR_CODES.EVAL_ARG_TYPE);
    }
  });

  it('错误：单参非字符串 / arity 不符', () => {
    nullWithDiag('range(1)');
    expect(code('range(1)')).toBe(FEEL_ERROR_CODES.EVAL_ARG_TYPE);
    nullWithDiag('range()');
    expect(code('range()')).toBe(FEEL_ERROR_CODES.EVAL_ARG_COUNT);
  });
});
