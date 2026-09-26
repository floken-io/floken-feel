/**
 * ★ FEEL 口径总校验：DMN 1.6 引入了第二方言 **B-FEEL**，它与 FEEL **语法相同、语义不同**，
 * 对"出错"的处理正好相反（FEEL 给 `null`，B-FEEL 给 0 / "" / false / 忽略非数值）。
 *
 * 本包实现的是 **FEEL**，不是 B-FEEL。下面这张表逐条钉死两方言的分歧点，
 * 依据 IBM 官方 BAMOE 文档的 B-FEEL↔FEEL 对照表（与 OMG issue DMN18-63 一致）。
 * 参照实现 `feelin` 在其中若干条上取的是 B-FEEL 的值，故**不能**拿它当这些条的基准。
 *
 * ⚠️ 为什么必须靠本文件锁定：DMN TCK 2053 条对 `sum` / `mean` / `min(` / `max(` / `union(`
 * **命中 0 条**，对 `string length(22)` / `lower case(12)` 这类"传错类型实参"也**没有用例** ——
 * 也就是说 TCK 1995/1995 **覆盖不到这张表的大半**，全绿并不代表口径正确。
 * 本包曾实装成 B-FEEL 语义（`sum([1,null,3])` 得 4、`string length(22)` 得 2）却依然"全绿"。
 */

import { describe, it, expect } from 'vitest';
import { evaluate } from '../src/entries/index.js';
// 时间相关那几条需要时间档（import 即注册）
import '../src/entries/temporal.js';

/** [表达式, FEEL 应有值] —— B-FEEL 的值写在注释里，方便对照 */
const TABLE: Array<[string, unknown]> = [
  // —— 布尔：FEEL 三值（null），B-FEEL 二值（false/true）——
  ['"a" = 1', null], // B-FEEL: false
  ['"a" != 1', null], // B-FEEL: true
  ['not("a")', null], // B-FEEL: false
  ['true and "x"', null], // B-FEEL: false
  ['false or "x"', null], // B-FEEL: false
  ['"a" in [1..100]', null], // B-FEEL: false
  ['null between 1 and 100', null], // B-FEEL: false
  ['matches("bad pattern", "[0-9")', null], // B-FEEL: false
  ['all(true, "x", true)', null], // B-FEEL: false
  ['any(null)', null], // B-FEEL: false

  // —— 数值：FEEL null，B-FEEL 0 ——
  ['decimal("a", 0)', null],
  ['round up("5.5", 0)', null],
  ['string length(22)', null], // B-FEEL: 0；我们曾得 2（把 22 隐式转字符串）
  ['day of year("a")', null],

  // —— 列表聚合：FEEL null（含 null/非数值即无效），B-FEEL 忽略 ——
  ['sum([1, null, 3])', null], // B-FEEL: 4；我们曾得 4
  ['mean(["a"])', null], // B-FEEL: 0
  ['count([1, null, 3])', 3], // ★ 两方言都是 3：count 计入 null

  // —— 字符串：FEEL null，B-FEEL "" ——
  ['lower case(12)', null], // 我们曾得 "12"
  ['string(null)', null],
  ['day of week("a")', null],
  ['substring("a", "z")', null],

  // —— 时态：FEEL null，B-FEEL epoch ——
  ['time("a")', null],
  ['date(null)', null],
  ['date and time(true)', null],
  ['duration("a")', null],

  /*
   * —— 条件表达式：条件为 **null → 走 else**，不是三值传播成 null ——
   * ★ 本条曾按「IBM 对照表」写成 `null`，被 **OMG TCK** 直接推翻。按既定判据（OMG > IBM > feelin）改判：
   *   ① OMG TCK 0032-conditionals #003：`bool`=nil → `if bool then num+10 else num-10` 期望 **90**（else）；
   *   ② 同组 #006：`aDate`=nil → `if aDate > date("2017-01-01") then … else …` 期望 **"World"**（else）；
   *   ③ feelin（第三方）：`if null then 1 else 2` → 2。
   *   两条互相独立的 OMG 用例 + 第三方实现一致；IBM 表此条是孤证，故降级。
   *   规范读法：条件语义是「为真取 then，**否则**取 else」，null 属"否则"而非"条件本身出错"。
   */
  ['if null then 1 else 2', 2],
];

describe('FEEL 口径总校验（不是 B-FEEL）', () => {
  it('IBM 官方 B-FEEL↔FEEL 对照表 26 条全部取 FEEL 列', () => {
    for (const [src, expected] of TABLE) {
      const r = evaluate(src);
      expect(r.value, `${src} 应为 FEEL 口径`).toEqual(expected);
    }
  });

  /*
   * ★ 与上面那条**必须成对**读，否则容易把「null 走 else」误扩成「什么都走 else」：
   *   条件是 **null** → 走 else（TCK 0032）；条件是 **非布尔非 null** → 类型错误，结果仍是 null。
   *   （feelin 在这一条上取的是 JS 真值，`if 1 then 1 else 2` 会得 1 —— 那是它的宽松，不是规范。）
   */
  it('条件是 null 走 else，但条件是非布尔仍为 null（两者不得合并）', () => {
    expect(evaluate('if null then 1 else 2').value).toBe(2);
    expect(evaluate('if 1 then 1 else 2').value).toBeNull();
    expect(evaluate('if "x" then 1 else 2').value).toBeNull();
    expect(evaluate('if true then 1 else 2').value).toBe(1);
    expect(evaluate('if false then 1 else 2').value).toBe(2);
  });
});

describe('位置 / 长度这类 number 形参不做隐式转换', () => {
  /*
   * ⚠️ 曾与字符串函数口径不一致（用宽松 `toNumber`）：`sublist([1,2,3], "2")` 得 `[2,3]`、
   * `sort([3,1], 1)` 退回默认排序得 `[1,3]`。TCK 对 `sublist` / `insert before` / `remove(`
   * **命中 0 条**，同样属于盲区。
   */
  it('位置 / 长度 / 比较器 传错类型 → null（+ARG_TYPE 诊断）', () => {
    for (const src of [
      'sublist([1,2,3], "2")',
      'sublist([1,2,3], 1, "2")',
      'insert before([1,3], "1", 2)',
      'remove([1,2,3], "1")',
      'sort([3,1], 1)', // 第二参不是函数 → 不退回默认排序
      'substring("abc", "1")',
    ]) {
      const r = evaluate(src);
      expect(r.value, src).toBe(null);
      expect(r.warnings.some((w: { code?: string }) => w.code === 'FEEL_EVAL_ARG_TYPE'), src).toBe(
        true,
      );
    }
  });

  it('合法位置参数不受影响', () => {
    expect(evaluate('sublist([1,2,3], 2)').value).toEqual([2, 3]);
    expect(evaluate('sublist([1,2,3], 1, 2)').value).toEqual([1, 2]);
    expect(evaluate('sublist([1,2,3], -2)').value).toEqual([2, 3]);
    expect(evaluate('remove([1,2,3], 2)').value).toEqual([1, 3]);
    expect(evaluate('insert before([1,3], 2, 2)').value).toEqual([1, 2, 3]);
    expect(evaluate('sort([3,1,2])').value).toEqual([1, 2, 3]);
    expect(evaluate('substring("foobar", 3)').value).toBe('obar');
    // TCK 1103#010：length 允许小数（3.8 → 取 3）
    expect(evaluate('substring("foobar", 3, 3.8)').value).toBe('oba');
  });

  /*
   * ★ 命名调用的陷阱：`reorderNamedArgs` 后实参数组长度**恒等于形参个数**，缺省位补 `null`。
   * 故**可选**形参（`substring` / `sublist` 的 `length`）拿到显式 `null` 时要当"未给"，
   * 不能当类型错误 —— 否则 TCK 1103#011 `substring(string:"foobar", start position :3)` 会退化。
   */
  it('★ 命名调用：可选形参缺省补 null 时不得报类型错误', () => {
    expect(evaluate('substring(string:"foobar", start position :3)').value).toBe('obar');
    expect(evaluate('substring("foobar", 3, null)').value).toBe('obar');
    expect(evaluate('sublist([1,2,3], 2, null)').value).toEqual([2, 3]);
  });
});

describe('字符串函数不做隐式转换（形参就是 string）', () => {
  /*
   * ⚠️ 曾与同档的 `contains` / `replace`（它们用严格 `reqString`）口径不一致。
   * 这两条是 TCK 盲区：TCK 有 `string length` / `lower case` 用例，但**没有传非字符串实参**的。
   */
  it('数字 / 布尔 / 列表实参 → null（+ARG_TYPE 诊断）', () => {
    for (const src of [
      'string length(22)',
      'upper case(12)',
      'lower case(12)',
      'starts with(1, "a")',
      'ends with(1, "a")',
      'substring(123, 1)',
      'substring before(1, "a")',
      'substring after(1, "a")',
      'string length(true)',
      'string length([1])',
    ]) {
      const r = evaluate(src);
      expect(r.value, src).toBe(null);
      expect(r.warnings.some((w: { code?: string }) => w.code === 'FEEL_EVAL_ARG_TYPE'), src).toBe(
        true,
      );
    }
  });

  it('正常字符串实参不受影响（含 TCK 0083 的码点口径）', () => {
    expect(evaluate('string length("🐎😀")').value).toBe(2);
    expect(evaluate('upper case("aBc4")').value).toBe('ABC4');
    expect(evaluate('lower case("aBc4")').value).toBe('abc4');
    expect(evaluate('starts with("abc", "a")').value).toBe(true);
    expect(evaluate('ends with("abc", "c")').value).toBe(true);
    expect(evaluate('substring("🐎foo", 2)').value).toBe('foo');
    expect(evaluate('substring before("abc", "b")').value).toBe('a');
    expect(evaluate('substring after("abc", "b")').value).toBe('c');
    expect(evaluate('substring after("abc", "z")').value).toBe('');
  });
});
