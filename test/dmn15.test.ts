/**
 * @floken/feel · **DMN 1.5 / 1.6 语言层补齐**测试
 *
 * 背景（2026-09-26 用户拍板）：元模型与函数表**按最新规范来**，不保留旧版本兼容层。
 * 本轮（A 档）在 `@floken/feel` 内补齐 DMN 1.5 相对 1.4 的 FEEL **语言层**新增：
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

/** 默认模式的诊断列表（判「给了 null 但**没有**诊断」这类"静默降级"） */
function diags(src: string): unknown[] {
  return evaluate(src).warnings;
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

  /*
   * ★ `match` 的**形参必须恰好两个**（TCK 1155 decision018）：
   *   1 参的 `function(item) …` 要求 null —— 形参少一个，`newItem` 位置会静默补 null，
   *   判定的语义就变了。同理 3 参（decision017）也不行。
   */
  it('match 形态：判定非 true（含 null）保持原值 —— 三值逻辑', () => {
    expect(val('list replace([1, 2, 3], function(item, newItem) null, 9)')).toEqual([1, 2, 3]);
  });

  it('match 形态：形参个数必须恰好 2（TCK 1155 decision017/018）', () => {
    nullWithDiag('list replace([2, 4], function(item) null, 9)');
    nullWithDiag('list replace([2, 4], function(item, newItem, extra) true, 9)');
    // 判定返回非布尔（这里返回 number）也是错误（decision019）
    nullWithDiag('list replace([2, 4], function(item, newItem) item, 9)');
  });

  it('位置形态：非整数位置**向零取整**（TCK 1155 decision011/011_a）', () => {
    expect(val('list replace([1,2,3], 2.5, 4)')).toEqual([1, 4, 3]); // 2.5 → 2
    expect(val('list replace([1,2,3], -1.5, 4)')).toEqual([1, 2, 4]); // -1.5 → -1（末位）
    // 这两条合起来排除了 四舍五入 / half-even / floor，只剩向零取整
  });

  it('list 形参：单值按单元素列表（singleton list 隐式转换）', () => {
    expect(val('list replace(1, 1, 5)')).toEqual([5]);
    // ★ null 不是"装了一个 null 的列表"，仍是类型错误
    nullWithDiag('list replace(null, 1, 4)');
  });

  it('命名参数：`position:` / `match:` 两套签名（TCK 1155 decision012/013）', () => {
    expect(val('list replace(position: 2, newItem: 4, list: [1,2,3])')).toEqual([1, 4, 3]);
    expect(
      val('list replace(match: function(item, newItem) item = 2, newItem: 4, list: [1,2,3])'),
    ).toEqual([1, 4, 3]);
    // 错的形参名 → NAMED_ARG
    expect(code('list replace(position: 2, newItem: 4, list: [1,2,3], foo: 1)')).toBe(
      FEEL_ERROR_CODES.EVAL_NAMED_ARG,
    );
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

  it('错误：位置/实参类型 → ARG_TYPE', () => {
    // 位置形参**不做**字符串→数字隐式转换（`sublist` 同口径，TCK 1155 decision010）
    for (const src of ['list replace([1], "1", 0)', 'list replace([1], null, 0)']) {
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

describe('②b duration 乘除（DMN 1.5 §10.3.2：duration × number / duration ÷ duration）', () => {
  // ★ 这一档此前**已实现但零测试**（`TEMPORAL_SCALE` 委托键），本段把它钉死。

  it('duration × number：交换律成立，两侧都给 duration', () => {
    expect(evaluate('string(duration("PT1H") * 2)').value).toBe('PT2H');
    expect(evaluate('string(2 * duration("PT1H"))').value).toBe('PT2H');
  });

  it('duration ÷ number：按分量等分', () => {
    expect(evaluate('string(duration("PT1H") / 2)').value).toBe('PT30M');
    expect(evaluate('string(duration("P1D") / 2)').value).toBe('PT12H');
  });

  it('years and months duration 缩放在**自己的量纲**内，不退化成秒', () => {
    expect(evaluate('string(duration("P1Y2M") * 3)').value).toBe('P3Y6M');
  });

  it('乘 0 → 零值 duration（不是 null）；乘小数 → 分量进位', () => {
    expect(evaluate('string(duration("PT1H") * 0)').value).toBe('PT0S');
    expect(evaluate('string(duration("PT1H") * 1.5)').value).toBe('PT1H30M');
  });

  it('duration ÷ duration（**同量纲**）→ number', () => {
    expect(evaluate('duration("PT2H") / duration("PT1H")').value).toBe(2);
    // P1Y2M / P1Y = 14 月 / 12 月
    expect(evaluate('duration("P1Y2M") / duration("P1Y")').value as number).toBeCloseTo(14 / 12, 12);
  });

  it('跨量纲相除无定义 → null（years-months vs days-time）', () => {
    nullWithDiag('duration("P1Y") / duration("PT1H")');
  });

  it('duration × duration 无定义 → null（交回 core 报错）', () => {
    nullWithDiag('duration("PT1H") * duration("PT1H")');
  });

  it('除以 0 → null（不是 Infinity）；除以零值 duration 同理', () => {
    // ★ 除零是**语义**不是错误 —— 与 `1 / 0` 同族，故 null 且**不带诊断**
    expect(evaluate('duration("PT1H") / 0').value).toBe(null);
    expect(evaluate('duration("PT1H") / 0').warnings.length).toBe(0);
    expect(evaluate('duration("PT1H") / duration("PT0S")').value).toBe(null);
    expect(evaluate('duration("PT1H") / duration("PT0S")').warnings.length).toBe(0);
  });

  it('非数字另一侧 → null', () => {
    nullWithDiag('duration("PT1H") / null');
    nullWithDiag('duration("PT1H") * "2"');
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

  it('端点开闭：起 `[`/`(`/`]`、止 `]`/`)`/`[`（规范三种各三个，不是各两个）', () => {
    expect(val('range("]18..21]") = ]18..21]')).toBe(true);
    expect(val('range("[18..21[") = [18..21[')).toBe(true);
    expect(val('range("[18..21)") = [18..21)')).toBe(true);
    // `]` 起、`[` 止都是**开**端点
    expect(val('18 in range("]18..21[")')).toBe(false);
    expect(val('21 in range("]18..21[")')).toBe(false);
  });

  it('时间端点：`@"…"` 与字面量时间构造（TCK 1156 decision001/005/007~010）', () => {
    expect(val('range("[@\\"1970-01-01\\"..@\\"1970-01-02\\"]") = [@"1970-01-01"..@"1970-01-02"]')).toBe(true);
    expect(val('range("[@\\"P1D\\"..@\\"P2D\\"]") = [@"P1D"..@"P2D"]')).toBe(true);
    expect(val('range("[date(\\"1970-01-01\\")..date(\\"1970-01-02\\")]") = [date("1970-01-01")..date("1970-01-02")]')).toBe(true);
    // ★ 非字面量端点（`string(...)` 包裹）**不被允许** → null，不是"尽力算"
    expect(val('range("[date(string(\\"1970-01-01\\"))..date(\\"1970-01-02\\")]")')).toBeNull();
  });

  it('`range` 只有一参（`from`）：`instance of range<X>` 要查端点类型', () => {
    expect(val('range(from: "[1..3]") = [1..3]')).toBe(true);
    expect(val('range("[@\\"P1Y\\"..@\\"P2Y\\"]") instance of range<years and months duration>')).toBe(true);
    // 参数化类型必须真查端点：不然 `range<date>` 会被 `P1Y..P2Y` 误判为匹配
    expect(val('range("[@\\"P1Y\\"..@\\"P2Y\\"]") instance of range<date>')).toBe(false);
    expect(code('range(fron: "[1..3]")')).toBe(FEEL_ERROR_CODES.EVAL_NAMED_ARG);
    // ★ 没有 `range(from, to)` 双参形态（那是 Camunda/Drools 扩展，非规范）
    expect(code('range(1, 10)')).toBe(FEEL_ERROR_CODES.EVAL_ARG_COUNT);
  });

  it('无效区间串 → null（不是抛错）：跨类型 / 降序 / 无值端点', () => {
    expect(val('range("[1..\\"b\\"]")')).toBeNull();
    expect(val('range("[3..1]")')).toBeNull();
    expect(val('range("[\\"z\\"..\\"a\\"]")')).toBeNull();
    expect(val('range("[@\\"P2D\\"..@\\"P1D\\"]")')).toBeNull();
    // date 与 date and time 不是同类 → null
    expect(val('range("[@\\"1970-01-01\\"..@\\"1970-01-02T00:00:00\\"]")')).toBeNull();
    expect(val('range("[null..null]")')).toBeNull();
  });

  it('错误：串不是区间字面量 → ARG_TYPE；端点不是字面量 → null（不抛）', () => {
    for (const src of ['range("bad")', 'range("18..21")']) {
      nullWithDiag(src);
      expect(code(src)).toBe(FEEL_ERROR_CODES.EVAL_ARG_TYPE);
    }
    // 端点不是字面量是"值无定义"，不是调用形式错 —— 只给 null，不带诊断
    expect(val('range("[a..c]")')).toBeNull();
    expect(diags('range("[a..c]")')).toHaveLength(0);
  });

  it('错误：单参非字符串 / arity 不符', () => {
    nullWithDiag('range(1)');
    expect(code('range(1)')).toBe(FEEL_ERROR_CODES.EVAL_ARG_TYPE);
    nullWithDiag('range()');
    expect(code('range()')).toBe(FEEL_ERROR_CODES.EVAL_ARG_COUNT);
  });
});
