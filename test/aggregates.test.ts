/**
 * ★ FEEL 与 B-FEEL 的分歧点：列表聚合对 `null` / 非数值元素的处理
 *
 * B-FEEL（DMN 1.6 第二方言）规定 `sum([1,null,3]) = 4`、`mean([1,"a",3]) = 2`
 * （**忽略**非数值）；**FEEL 一律 `null`**。本包实现的是 FEEL。
 *
 * 权威依据：
 * - IBM 官方 B-FEEL↔FEEL 对照表：`sum([1,null,3])` FEEL=`null` / B-FEEL=`4`；
 *   `sum([1,"1",3])` FEEL=`null` / B-FEEL=`4`；`mean([1,"a",3])` FEEL=`null` / B-FEEL=`2`。
 * - OMG issue DMN18-63：min / max 与 sum / mean 同口径 —— 含 null 即 null。
 * - 参照实现 feelin 8.2.0 实测全部为 `null`。
 *
 * ⚠️ 为什么必须靠本文件锁定：**TCK 2053 条里 `sum` / `mean` / `min(` / `max(` / `union(`
 * 命中 0 条**，官方语料完全没有覆盖这些函数，故 TCK 1995/1995 无法发现偏离 ——
 * 曾实装成 B-FEEL 语义（`sum([1,null,3])` 得 4）却仍然"全绿"。
 */

import { describe, it, expect } from 'vitest';
import { evaluate, evaluateStrict } from '../src/entries/index.js';
// 日期比较那条用例需要时间档（import 即注册，与 `test/temporal-bridge.test.ts` 同法）
import '../src/entries/temporal.js';

/** 默认模式：值 null 且带诊断码 */
function nullDiag(src: string, code: string): void {
  const r = evaluate(src);
  expect(r.value, `value of ${src}`).toBe(null);
  expect(r.warnings.some((w: { code?: string }) => w.code === code), `diag of ${src}`).toBe(true);
}

describe('列表聚合 · FEEL 口径：null / 非数值元素 → null（不是 B-FEEL 的"忽略"）', () => {
  it('sum / mean：含 null 或非数值 → null + ARG_TYPE 诊断', () => {
    for (const src of [
      'sum([1, null, 3])',
      'sum([1, "1", 3])',
      'sum([1, true])',
      'sum(1, null, 3)',
      'mean([1, null, 3])',
      'mean([1, "a", 3])',
      'mean([1, true])',
    ]) {
      nullDiag(src, 'FEEL_EVAL_ARG_TYPE');
    }
  });

  it('sum / mean：正常值与空列表不受影响', () => {
    expect(evaluate('sum([1,2,3])').value).toBe(6);
    expect(evaluate('sum(1,2,3)').value).toBe(6);
    expect(evaluate('mean([1,2,3])').value).toBe(2);
    expect(evaluate('sum([])').value).toBe(null);
    expect(evaluate('mean([])').value).toBe(null);
  });

  it('min / max：含 null → null + ARG_TYPE 诊断', () => {
    for (const src of [
      'min([1, null, 3])',
      'max([1, null, 3])',
      'min(["b", null])',
      'min([null])',
      'min(1, null, 3)',
    ]) {
      nullDiag(src, 'FEEL_EVAL_ARG_TYPE');
    }
  });

  it('min / max：两两不可比较 → 结果未定义（EVAL_UNDEFINED）', () => {
    // `1 < "a"` 在 FEEL 里是 null（三值比较），故最小值无法确定
    for (const src of ['min([1, "a", 3])', 'max([1, "a", 3])']) {
      nullDiag(src, 'FEEL_EVAL_UNDEFINED');
    }
  });

  /*
   * min / max 的形参是 `list`（**可比**即可，不限数字 —— 规范 "minimum comparable element"）。
   * 参照实现 feelin 对 `min(["b","a"])` 也返回 null（它只支持数字），那是它的局限，
   * 不是规范；这里锁的是"我们对得更多"，防止上面两处改动误伤。
   */
  it('min / max：非数值但**同类可比**的列表仍有定义', () => {
    expect(evaluate('min(["b","a"])').value).toBe('a');
    expect(evaluate('max(["b","a"])').value).toBe('b');
    expect(evaluate('min([true,false])').value).toBe(false);
    expect(evaluate('min([1,2,3])').value).toBe(1);
    expect(evaluate('max([1,2,3])').value).toBe(3);
    expect(evaluate('min([])').value).toBe(null);
  });

  it('min / max：日期列表可比', () => {
    expect(evaluate('string(min([date("2020-01-02"), date("2020-01-01")]))').value).toBe(
      '2020-01-01',
    );
  });

  it('同组函数 product / median / stddev / mode 含 null 同为 null', () => {
    for (const src of [
      'product([2, null, 3])',
      'median([1, null, 3])',
      'stddev([1, null, 3])',
      'mode([1, null, 1])',
    ]) {
      expect(evaluate(src).value, src).toBe(null);
    }
  });

  it('★ count 不受影响：null 元素照旧计入', () => {
    expect(evaluate('count([1, null, 3])').value).toBe(3);
  });
});

describe('union 去重（规范：excludes duplicates）', () => {
  /*
   * DMN 规范 Table 41 / Drools 官方函数参考：
   * union( list ) "Returns a list of all the elements from multiple lists and **excludes duplicates**"
   *   union([1,2],[2,3]) = [1,2,3]
   * FlexRule：union([1,2],[1,2,3],[1,2,3,4]) = [1,2,3,4]
   * ⚠️ 曾与 `concatenate` 逐字相同（保留重复 → [1,2,2,3]）。
   */
  it('union 去重，concatenate 不去重', () => {
    expect(evaluate('union([1,2],[2,3])').value).toEqual([1, 2, 3]);
    expect(evaluate('union([1,2],[1,2,3],[1,2,3,4])').value).toEqual([1, 2, 3, 4]);
    expect(evaluate('concatenate([1,2],[2,3])').value).toEqual([1, 2, 2, 3]);
  });

  it('union 的去重口径与 distinct values 一致（null 也视为相同）', () => {
    expect(evaluate('union([null, 1],[null, 2])').value).toEqual([null, 1, 2]);
    expect(evaluate('distinct values([1,1,null,null])').value).toEqual([1, null]);
  });
});

describe('严格口径：以上都是"抛"而不是静默 null', () => {
  it('evaluateStrict 对含 null 的聚合抛错', () => {
    for (const src of ['sum([1, null, 3])', 'min([1, null, 3])', 'mean([1, "a", 3])']) {
      expect(() => evaluateStrict(src), src).toThrow();
    }
  });

  it('合法聚合在严格口径下照旧返回', () => {
    expect(evaluateStrict('sum([1,2,3])').value).toBe(6);
    expect(evaluateStrict('union([1,2],[2,3])').value).toEqual([1, 2, 3]);
  });
});
