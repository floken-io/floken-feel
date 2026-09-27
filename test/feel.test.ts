import { describe, it, expect } from 'vitest';
import { evaluate, unaryTest, parseExpression, isContext } from '../src/entries/index.js';

describe('@floken-io/feel · evaluate 基础', () => {
  it('算术与优先级', () => {
    expect(evaluate('1 + 2').value).toBe(3);
    expect(evaluate('1 + 2 * 3').value).toBe(7);
    expect(evaluate('(1 + 2) * 3').value).toBe(9);
    expect(evaluate('10 / 4').value).toBe(2.5);
    expect(evaluate('2 ** 3').value).toBe(8);
    expect(evaluate('-5').value).toBe(-5);
  });

  it('字面量与比较', () => {
    expect(evaluate('true').value).toBe(true);
    expect(evaluate('null').value).toBe(null);
    expect(evaluate('"hello"').value).toBe('hello');
    expect(evaluate('1 = 1').value).toBe(true);
    expect(evaluate('1 != 2').value).toBe(true);
    expect(evaluate('2 > 1').value).toBe(true);
    expect(evaluate('2 <= 2').value).toBe(true);
  });

  it('上下文变量与路径访问', () => {
    expect(evaluate('a + b', { a: 1, b: 2 }).value).toBe(3);
    expect(evaluate('user.name', { user: { name: 'Lisa' } }).value).toBe('Lisa');
    expect(evaluate('user.age > 10', { user: { name: 'Lisa', age: 30 } }).value).toBe(true);
  });

  it('列表与下标（1-based）', () => {
    expect(evaluate('[1, 2, 3]').value).toEqual([1, 2, 3]);
    expect(evaluate('[1, 2, 3][1]').value).toBe(1);
    expect(evaluate('[1, 2, 3][3]').value).toBe(3);
    expect(evaluate('[1, 2, 3][-1]').value).toBe(3);
  });

  it('列表投影 list.property', () => {
    const r = evaluate('users.name', { users: [{ name: 'a' }, { name: 'b' }] });
    expect(r.value).toEqual(['a', 'b']);
  });

  it('context 字面量', () => {
    const r = evaluate('{ a: 1, b: "x" }');
    const ctx = r.value;
    expect(isContext(ctx)).toBe(true);
    if (isContext(ctx)) {
      expect(ctx.get('a')).toBe(1);
      expect(ctx.get('b')).toBe('x');
    }
  });
});

describe('@floken-io/feel · 控制结构', () => {
  it('if-then-else', () => {
    expect(evaluate('if 1 > 2 then "a" else "b"').value).toBe('b');
    expect(evaluate('if true then 1 else 2').value).toBe(1);
  });

  it('for ... in ... return', () => {
    expect(evaluate('for a in [1, 2, 3] return a * 2').value).toEqual([2, 4, 6]);
  });

  it('多变量迭代（笛卡尔积）', () => {
    const r = evaluate('for a in [1, 2], b in [10, 20] return a + b');
    expect(r.value).toEqual([11, 21, 12, 22]);
  });

  it('every / some ... satisfies', () => {
    expect(evaluate('every x in [1, 2] satisfies x > 0').value).toBe(true);
    expect(evaluate('every x in [1, 2] satisfies x > 1').value).toBe(false);
    expect(evaluate('some x in [1, 2] satisfies x > 1').value).toBe(true);
  });

  it('feelin 同款：context 里放函数', () => {
    const r = evaluate('every rate in rates() satisfies rate < 10', {
      rates: () => [10, 20],
    });
    expect(r.value).toBe(false);

    const r2 = evaluate('every rate in rates() satisfies rate < 100', {
      rates: () => [10, 20],
    });
    expect(r2.value).toBe(true);
  });
});

describe('@floken-io/feel · 三值逻辑（NFR-F14）', () => {
  it('null 参与比较得到 null（未知），不是 false', () => {
    expect(evaluate('null < 1').value).toBe(null);
    expect(evaluate('null = 1').value).toBe(false);
    expect(evaluate('null = null').value).toBe(true);
  });

  it('and / or 三值', () => {
    expect(evaluate('true and null').value).toBe(null);
    expect(evaluate('false and null').value).toBe(false);
    expect(evaluate('true or null').value).toBe(true);
    expect(evaluate('false or null').value).toBe(null);
  });

  it('未知变量 → null + warning', () => {
    const r = evaluate('x');
    expect(r.value).toBe(null);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]?.code).toBe('FEEL_EVAL_NO_VARIABLE');
    expect(r.warnings[0]?.severity).toBe('warn');
    expect({ from: r.warnings[0]?.start, to: r.warnings[0]?.end }).toEqual({ from: 0, to: 1 });
  });
});

describe('@floken-io/feel · 内置函数', () => {
  it('数值', () => {
    expect(evaluate('abs(-3)').value).toBe(3);
    expect(evaluate('floor(1.7)').value).toBe(1);
    expect(evaluate('ceiling(1.2)').value).toBe(2);
    expect(evaluate('sqrt(9)').value).toBe(3);
    expect(evaluate('modulo(7, 3)').value).toBe(1);
    expect(evaluate('odd(3)').value).toBe(true);
    expect(evaluate('even(3)').value).toBe(false);
  });

  it('聚合：既支持列表也支持变参', () => {
    expect(evaluate('sum([1, 2, 3])').value).toBe(6);
    expect(evaluate('sum(1, 2, 3)').value).toBe(6);
    expect(evaluate('mean([1, 2, 3])').value).toBe(2);
    expect(evaluate('min([3, 1, 2])').value).toBe(1);
    expect(evaluate('max([3, 1, 2])').value).toBe(3);
    expect(evaluate('count([1, 2, 3])').value).toBe(3);
  });

  it('字符串', () => {
    expect(evaluate('string length("abc")').value).toBe(3);
    expect(evaluate('upper case("ab")').value).toBe('AB');
    expect(evaluate('lower case("AB")').value).toBe('ab');
    expect(evaluate('contains("abc", "b")').value).toBe(true);
    expect(evaluate('starts with("abc", "a")').value).toBe(true);
    expect(evaluate('ends with("abc", "c")').value).toBe(true);
    expect(evaluate('substring("abcdef", 2, 3)').value).toBe('bcd');
    expect(evaluate('substring before("abc", "b")').value).toBe('a');
    expect(evaluate('substring after("abc", "b")').value).toBe('c');
    expect(evaluate('string join(["a", "b"], "-")').value).toBe('a-b');
  });

  it('带空格内置名也可用 camelCase 别名调用', () => {
    expect(evaluate('stringLength("abc")').value).toBe(3);
    expect(evaluate('upperCase("ab")').value).toBe('AB');
    expect(evaluate('listContains([1, 2], 2)').value).toBe(true);
    expect(evaluate('list contains([1, 2], 2)').value).toBe(true);
  });

  it('列表操作', () => {
    expect(evaluate('append([1], 2, 3)').value).toEqual([1, 2, 3]);
    expect(evaluate('reverse([1, 2, 3])').value).toEqual([3, 2, 1]);
    expect(evaluate('sublist([1, 2, 3], 2)').value).toEqual([2, 3]);
    expect(evaluate('distinct values([1, 1, 2])').value).toEqual([1, 2]);
    expect(evaluate('flatten([1, [2, 3]])').value).toEqual([1, 2, 3]);
    expect(evaluate('union([1], [2])').value).toEqual([1, 2]);
    expect(evaluate('index of([1, 2, 1], 1)').value).toEqual([1, 3]);
    expect(evaluate('sort([3, 1, 2])').value).toEqual([1, 2, 3]);
  });

  /*
   * ★ 调用目标不是函数 → **null + 诊断**（对齐 DMN 1.4 §10.3.2.13.1 + feelin v8.2.0）。
   * 规范把"调用目标不符参数域"的结果定为 `null`（unknown），不是 error；feelin 对此
   * `addWarning('NO_FUNCTION_FOUND')` 后返回 null。故 `nope(1)` 经 call 边界转换转成 null。
   */
  it('未知函数 → null + 诊断 FEEL_EVAL_NO_FUNCTION（对齐规范/feelin，不是抛）', () => {
    const r = evaluate('nope(1)');
    expect(r.value).toBe(null);
    expect(r.warnings.some((w: { code?: string }) => w.code === 'FEEL_EVAL_NO_FUNCTION')).toBe(true);
  });
});

describe('@floken-io/feel · unaryTest（对标 feelin）', () => {
  it('feelin 官方示例', () => {
    expect(unaryTest('1', { '?': 1 }).value).toBe(true);
    expect(unaryTest('1', { '?': 2 }).value).toBe(false);
    expect(unaryTest('[1..end]', { '?': 1, end: 10 }).value).toBe(true);
    expect(unaryTest('[1..end]', { '?': 20, end: 10 }).value).toBe(false);
  });

  it('比较型测试项', () => {
    expect(unaryTest('< 10', { '?': 5 }).value).toBe(true);
    expect(unaryTest('<= 10', { '?': 10 }).value).toBe(true);
    expect(unaryTest('> 10', { '?': 5 }).value).toBe(false);
    expect(unaryTest('!= 10', { '?': 5 }).value).toBe(true);
  });

  it('多个测试项逗号 = OR', () => {
    expect(unaryTest('1, 2, 3', { '?': 2 }).value).toBe(true);
    expect(unaryTest('1, 2, 3', { '?': 9 }).value).toBe(false);
  });

  it('not(...) 取反', () => {
    expect(unaryTest('not(1, 2)', { '?': 5 }).value).toBe(true);
    expect(unaryTest('not(1, 2)', { '?': 1 }).value).toBe(false);
  });

  it('区间开闭', () => {
    expect(unaryTest('[1..5]', { '?': 1 }).value).toBe(true);
    expect(unaryTest('[1..5]', { '?': 5 }).value).toBe(true);
    expect(unaryTest(']1..5[', { '?': 1 }).value).toBe(false);
    expect(unaryTest(']1..5[', { '?': 3 }).value).toBe(true);
  });

  it('列表测试项', () => {
    expect(unaryTest('[1, 2, 3]', { '?': 2 }).value).toBe(true);
    expect(unaryTest('[1, 2, 3]', { '?': 9 }).value).toBe(false);
  });

  it('返回形态与 feelin 一致：{ value, warnings }', () => {
    const r = unaryTest('1', { '?': 1 });
    expect(Object.keys(r).sort()).toEqual(['value', 'warnings']);
    expect(r.warnings).toEqual([]);
  });
});

describe('@floken-io/feel · 解析', () => {
  it('parseExpression 产出 AST', () => {
    const ast = parseExpression('1 + 2');
    expect(ast.type).toBe('binary');
  });

  it('语法错误抛 FeelSyntaxError', () => {
    expect(() => parseExpression('1 +')).toThrow();
    expect(() => evaluate('1 +')).toThrow();
  });
});
