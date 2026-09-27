import { describe, it, expect } from 'vitest';
import { evaluate, unaryTest, isFunction } from '../src/entries/index.js';

describe('@floken-io/feel · F1 方括号：下标 / 过滤统一', () => {
  it('数字 → 下标（1-based，负号倒数，越界为 null）', () => {
    expect(evaluate('[1, 2, 3][1]').value).toBe(1);
    expect(evaluate('[1, 2, 3][3]').value).toBe(3);
    expect(evaluate('[1, 2, 3][-1]').value).toBe(3);
    expect(evaluate('[1, 2, 3][0]').value).toBe(null);
    expect(evaluate('[1, 2, 3][9]').value).toBe(null);
  });

  it('变量算出数字 → 仍是下标', () => {
    expect(evaluate('[1, 2, 3][n]', { n: 2 }).value).toBe(2);
  });

  it('布尔 → 过滤（元素绑定为 item）', () => {
    expect(evaluate('[1, 2, 3, 4][item > 2]').value).toEqual([3, 4]);
    expect(evaluate('[1, 2, 3][item > 5]').value).toEqual([]);
  });

  it('对象列表可按属性直接过滤（元素属性可见）', () => {
    const users = [
      { name: 'a', age: 20 },
      { name: 'b', age: 30 },
    ];
    expect(evaluate('users[age > 25].name', { users }).value).toEqual(['b']);
  });

  it('列表 → 多下标取值', () => {
    expect(evaluate('[10, 20, 30][[1, 3]]').value).toEqual([10, 30]);
  });

  it('非列表基底的下标 → 按单元素列表处理（FEEL 10.3.1.8）', () => {
    // `100[1]` = 100、`true[true]` = [true]、`true[false]` = []（TCK 0068）
    expect(evaluate('100[1]').value).toBe(100);
    expect(evaluate('true[true]').value).toEqual([true]);
    expect(evaluate('true[false]').value).toEqual([]);
  });
});

describe('@floken-io/feel · F1 in 运算符', () => {
  it('区间包含', () => {
    expect(evaluate('5 in [1..10]').value).toBe(true);
    expect(evaluate('5 in ]1..10[').value).toBe(true);
    expect(evaluate('1 in ]1..10[').value).toBe(false);
  });

  it('列表成员', () => {
    expect(evaluate('"b" in ["a", "b"]').value).toBe(true);
    expect(evaluate('"z" in ["a", "b"]').value).toBe(false);
  });

  it('上下文键', () => {
    expect(evaluate('"a" in { a: 1 }').value).toBe(true);
    expect(evaluate('"z" in { a: 1 }').value).toBe(false);
  });

  it('右端是裸值 → unary test 的「相等」语义（TCK 0072 用例）', () => {
    // `in` 右侧是 positive unary test：裸值即「等于」。`1 in 1` → true、`1 in 5` → false。
    // （2026-09-25 修：此前把裸值判为类型错误并返回 null，TCK 里 0072-feel-in 因此丢分。）
    expect(evaluate('1 in 1').value).toBe(true);
    expect(evaluate('1 in 5').value).toBe(false);
  });

  it('unary test 里的 in', () => {
    expect(unaryTest('in [1..10]', { '?': 5 }).value).toBe(true);
    expect(unaryTest('in [1..10]', { '?': 50 }).value).toBe(false);
  });
});

describe('@floken-io/feel · F1 between', () => {
  it('闭区间判定', () => {
    expect(evaluate('5 between 1 and 10').value).toBe(true);
    expect(evaluate('1 between 1 and 10').value).toBe(true);
    expect(evaluate('10 between 1 and 10').value).toBe(true);
    expect(evaluate('11 between 1 and 10').value).toBe(false);
  });

  it('字符串亦可', () => {
    expect(evaluate('"b" between "a" and "c"').value).toBe(true);
  });

  /*
   * ★ `null` 参与区间判定 → **null**（unknown，对齐 DMN 1.4 §10.3.2.13.1 + feelin v8.2.0）。
   * 「比较得不出结果 → null」适用于类型对得上但值无法定序、以及 null 参与的情形。
   */
  it('任一端是 null → null（TCK 0071 null_001~003，对齐规范/feelin）', () => {
    for (const src of ['null between 1 and 10', '2 between null and 10', '2 between 1 and null']) {
      expect(evaluate(src).value).toBe(null);
    }
  });

  it('类型对得上但无法定序 → null（未知）', () => {
    expect(evaluate('"a" between 1 and 10').value).toBe(null);
  });

  it('unary test 里的 between', () => {
    expect(unaryTest('? between 1 and 10', { '?': 5 }).value).toBe(true);
  });
});

describe('@floken-io/feel · F1 函数字面量', () => {
  it('定义后立即调用', () => {
    expect(evaluate('(function(a, b) a + b)(1, 2)').value).toBe(3);
  });

  it('零参函数', () => {
    expect(evaluate('(function() 42)()').value).toBe(42);
  });

  it('闭包捕获定义处上下文', () => {
    expect(evaluate('{ k: 10, f: function(a) a + k, r: f(5) }.r').value).toBe(15);
  });

  it('函数值可被 isFunction 识别（可作参数传递）', () => {
    const r = evaluate('function(a) a + 1');
    expect(isFunction(r.value)).toBe(true);
  });

  it('invoke 以参数列表调用', () => {
    expect(evaluate('invoke(function(a, b) a - b, [10, 3])').value).toBe(7);
    expect(evaluate('invoke(function(a, b) a - b, 10, 3)').value).toBe(7);
  });

  it('可作为 sort 的比较器', () => {
    expect(evaluate('sort([3, 1, 2], function(x, y) x > y)').value).toEqual([3, 2, 1]);
  });
});

describe('@floken-io/feel · F1 上下文语义', () => {
  it('上下文字面量后一项可见前一项', () => {
    expect(evaluate('{ a: 1, b: a + 1, c: b * 10 }.c').value).toBe(20);
  });
});

describe('@floken-io/feel · F1 新增内置函数', () => {
  it('product / stddev', () => {
    expect(evaluate('product([2, 3, 4])').value).toBe(24);
    expect(evaluate('stddev([1, 2, 3, 4])').value).toBeCloseTo(1.2909944487358056, 10);
    /*
     * 空列表 / 样本数不足 → **null + 诊断**（不是抛）。
     * 对齐 DMN 1.4 §10.3.2.13.1 + Camunda 语义（"if something goes wrong, return null"，
     * 明确含 "An operation is not defined for the given values"）：`product([])`（0094#002）、
     * `stddev([1])`（0063#007）这类"结果无定义"与"参数类型不符"同属 unknown 一档，都落 null。
     * 实证：TCK 这些用例的 `<expected>` 值本身就是 `null`，只是额外挂了 `errorResult="true"`
     * （那部分已按 `label#id` 登记 IGNORED —— 见 `tooling/tck/ignored.json`）。
     * `median([])`（0061#007）官方期望同样是 `null` —— 三条路径现统一为 null。
     */
    for (const src of ['product([])', 'stddev([1])']) {
      const r = evaluate(src);
      expect(r.value, `value of ${src}`).toBe(null);
      expect(
        r.warnings.some((w: { code?: string }) => w.code === 'FEEL_EVAL_UNDEFINED'),
        `diag of ${src}`,
      ).toBe(true);
    }
    expect(evaluate('median([])').value).toBe(null);
  });

  it('mode（众数，可能多个）', () => {
    expect(evaluate('mode([1, 1, 2, 2, 3])').value).toEqual([1, 2]);
    expect(evaluate('mode([7])').value).toEqual([7]);
    // 空列表的众数是**空列表**，不是 null（TCK 0062#007 明确期望 `[]`）
    expect(evaluate('mode([])').value).toEqual([]);
  });

  it('context / context put / context merge', () => {
    expect(evaluate('get value(context([{ key: "a", value: 1 }]), "a")').value).toBe(1);
    expect(evaluate('get value(context put({ a: 1 }, "b", 2), "b")').value).toBe(2);
    expect(evaluate('get value(context merge([{ a: 1 }, { b: 2 }]), "b")').value).toBe(2);
  });

  it('camelCase 别名同样可用', () => {
    expect(evaluate('get value(contextPut({ a: 1 }, "b", 2), "b")').value).toBe(2);
    expect(evaluate('get value(contextMerge([{ a: 1 }, { b: 2 }]), "a")').value).toBe(1);
  });
});

describe('@floken-io/feel · F1 注释', () => {
  it('注释被语法忽略', () => {
    expect(evaluate('1 + 2 // 注释').value).toBe(3);
    expect(evaluate('// 只有注释\n5').value).toBe(5);
  });
});
