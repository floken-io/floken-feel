/**
 * @floken-io/feel · **错误双模式**（`errorMode`）测试
 *
 * 背景：DMN 1.4 §10.3.2.13.1 与 TCK 的 `errorResult="true"` 是**两套口径**：
 * - 规范（Camunda / feelin / Drools 默认）：实参不符形参域、结果无定义 → `null`（unknown）；
 * - TCK：同一批用例标 `errorResult="true"`，期望**抛错**。
 *
 * 本包用**一个开关**同时满足两者，而不是二选一：
 * - `evaluate()`        → `errorMode: 'null'`（默认，规范语义）→ `null` + 诊断；
 * - `evaluateStrict()`  → `errorMode: 'throw'`（TCK 严格口径）→ 抛 `FeelError`。
 *
 * 本测试逐个钉死「同一表达式在两种模式下的对应关系」，
 * 并钉死两种模式**都不变**的硬错误（语法错 / 能力未加载 / 白名单 / 资源上限）。
 */

import { describe, it, expect } from 'vitest';
import {
  FEEL_DIAGNOSTIC_CODES,
  FEEL_ERROR_CODES,
  evaluate,
  evaluateStrict,
} from '../src/entries/index.js';
// 挂上时间档：`duration()` / `years and months duration()` 是具名时间函数，
// 未加载时按 AC-F7 抛 NOT_LOADED_TEMPORAL（两种模式都抛，与 errorMode 无关）。
import '../src/entries/temporal.js';

/** 严格模式下期待抛出的码；`null` 模式同式必须返回 null */
function code(src: string): string | null {
  try {
    evaluateStrict(src);
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? 'NON_FEEL_ERROR';
  }
}

/** 默认模式：值为 null 且**至少带一条诊断**（说明"出事了但没中断"） */
function nullWithDiag(src: string): void {
  const r = evaluate(src);
  expect(r.value, `default value of ${src}`).toBe(null);
  expect(r.warnings.length, `default diagnostics of ${src}`).toBeGreaterThan(0);
}

describe('errorMode 双模式：同一表达式的两种出口', () => {
  it('arity 不符 → null+诊断 / throw ARG_COUNT', () => {
    for (const src of ['abs()', 'abs(1,1)', 'duration()']) {
      nullWithDiag(src);
      expect(code(src)).toBe(FEEL_ERROR_CODES.EVAL_ARG_COUNT);
    }
  });

  it('实参类型不符 → null+诊断 / throw ARG_TYPE', () => {
    const cases = [
      'abs(null)',
      'abs("-1")',
      'abs(true)',
      'floor(null, 1)',
      'matches(null, "pattern")',
      'contains(null, "bar")',
      'split("foo", null)',
      'not(0)',
      'get value(null, "a")',
      'years and months duration(null, null)',
      'duration(2017)',
    ];
    for (const src of cases) {
      nullWithDiag(src);
      expect(code(src), `strict code of ${src}`).toBe(FEEL_ERROR_CODES.EVAL_ARG_TYPE);
    }
  });

  it('函数结果无定义 → null+诊断 / throw EVAL_UNDEFINED', () => {
    const cases = ['sqrt(-1)', 'log(0)', 'modulo(10, 0)', 'product([])', 'stddev([1])'];
    for (const src of cases) {
      nullWithDiag(src);
      expect(code(src), `strict code of ${src}`).toBe(FEEL_ERROR_CODES.EVAL_UNDEFINED);
    }
  });

  it('上下文字面量重复键 → null+诊断 / throw EVAL_UNDEFINED（不经 call 边界，走 semanticFail）', () => {
    nullWithDiag('{foo: "bar", foo: "baz"}');
    expect(code('{foo: "bar", foo: "baz"}')).toBe(FEEL_ERROR_CODES.EVAL_UNDEFINED);
  });

  it('调用非函数值 → 诊断 NO_FUNCTION / throw NOT_CALLABLE（两个命名空间）', () => {
    const r = evaluate('nope(1)');
    expect(r.value).toBe(null);
    expect(r.warnings.some((w) => w.code === FEEL_DIAGNOSTIC_CODES.EVAL_NO_FUNCTION)).toBe(true);
    expect(code('nope(1)')).toBe(FEEL_ERROR_CODES.EVAL_NOT_CALLABLE);
    expect(code('null()')).toBe(FEEL_ERROR_CODES.EVAL_NOT_CALLABLE);
  });

  it('运算符：`=` 跨类型 / between 的 null 端 / in 的 null 值 → 两模式分流', () => {
    for (const src of ['false = 0', '100 = "100"', 'null between 1 and 10', '2 between 1 and null']) {
      nullWithDiag(src);
      expect(code(src), `strict code of ${src}`).toBe(FEEL_ERROR_CODES.EVAL_ARG_TYPE);
    }
    nullWithDiag('null in [1..10]');
    expect(code('null in [1..10]')).toBe(FEEL_ERROR_CODES.EVAL_ARG_TYPE);
  });

  it('幂 `**` 非数字 → 抛；但 `+` 遇 null 仍是三值传播（两种模式都 null）', () => {
    // `**`：TCK 0075 的 10 条标 errorResult
    nullWithDiag('"foo" ** 4');
    expect(code('"foo" ** 4')).toBe(FEEL_ERROR_CODES.EVAL_ARG_TYPE);
    // `+`：三值传播，严格模式**也不抛**（TCK 期望 null，不是 error）
    expect(evaluate('1 + null').value).toBe(null);
    expect(code('1 + null')).toBe(null);
  });

  it('两种模式结果**一致**的表达式不受开关影响', () => {
    for (const src of ['1 + 1', 'abs(-3)', '"a" + "b"', '[1,2,3][item > 1]']) {
      expect(evaluateStrict(src).value, `strict value of ${src}`).toEqual(evaluate(src).value);
    }
  });
});

describe('硬错误：两种模式都抛（不受 errorMode 影响）', () => {
  it('语法错', () => {
    for (const src of ['1 +', '"unterminated', '(1']) {
      expect(() => evaluate(src)).toThrow();
      expect(() => evaluateStrict(src)).toThrow();
    }
  });

  it('未知选项 / 非法取值（选项契约，AGENTS.md §5 四禁之一）', () => {
    // @ts-expect-error 故意传未知选项
    expect(() => evaluate('1', undefined, { nope: 1 })).toThrow();
    // @ts-expect-error 故意传非法 errorMode
    expect(() => evaluate('1', undefined, { errorMode: 'BOOM' })).toThrow();
    expect(() => evaluateStrict('1', undefined, { errorMode: 'null' })).not.toThrow();
  });

  it('资源上限', () => {
    expect(() => evaluate('1+1', undefined, { maxNodes: 1 })).toThrow();
    expect(() => evaluateStrict('1+1', undefined, { maxNodes: 1 })).toThrow();
  });

  it('S-FEEL 白名单越界', () => {
    const opts = { allowedFunctions: ['abs'] };
    expect(() => evaluate('sqrt(4)', undefined, opts)).toThrow();
    expect(() => evaluateStrict('sqrt(4)', undefined, opts)).toThrow();
  });
});

describe('evaluateStrict 的形态契约', () => {
  it('成功时与 evaluate 同样返回 { value, warnings }，且不带诊断', () => {
    const r = evaluateStrict('1 + 1');
    expect(r.value).toBe(2);
    expect(r.warnings).toEqual([]);
  });

  it('显式传 errorMode:"throw" 与 evaluateStrict 等价', () => {
    expect(() => evaluate('abs(null)', undefined, { errorMode: 'throw' })).toThrow();
  });

  it('evaluateStrict 内部用 throw 覆盖调用方传入的 errorMode', () => {
    expect(() => evaluateStrict('abs(null)', undefined, { errorMode: 'null' })).toThrow();
  });
});
