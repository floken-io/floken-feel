import { describe, it, expect, beforeAll } from 'vitest';
import {
  evaluate,
  parseExpression,
  FeelError,
  FeelNotAllowedError,
  FeelNotLoadedError,
  FeelLimitError,
  FeelOptionError,
} from '../src/entries/index.js';
import { ensureTemporal, evaluateTemporal } from '../src/entries/temporal.js';

/** 固定时钟：注入后 today()/now() 可被钉死（05-feel §6.1） */
const FIXED_CLOCK = (): Date => new Date('2026-03-01T09:30:15');

/** 捕获错误以便断言码（不加 try/catch 就看不到码） */
function catchError(fn: () => unknown): FeelError {
  try {
    fn();
  } catch (e) {
    if (e instanceof FeelError) return e;
    throw e;
  }
  throw new Error('expected the call to throw, but it did not');
}

describe('floken-feel · F2 带空格 / 撇号的名字', () => {
  it('撇号名字（Mike\'s daughter）可作变量引用', () => {
    expect(evaluate("Mike's daughter", { "Mike's daughter": 12 }).value).toBe(12);
  });

  it('带空格的上下文键可参与运算', () => {
    expect(evaluate('Applicant Age + 1', { 'Applicant Age': 30 }).value).toBe(31);
  });

  it('路径步也可以是带空格的名字', () => {
    expect(evaluate('a.b c', { a: { 'b c': 7 } }).value).toBe(7);
  });

  it('上下文字面量的键可带空格', () => {
    expect(evaluate("{ Mike's daughter: 3 }.Mike's daughter").value).toBe(3);
  });

  it('★ 只有整体命中多词名表才合并：`date and true` 仍是逻辑与', () => {
    expect(parseExpression('date and true').type).toBe('logical');
  });

  it('多词内置名仍正确合并（`date and time`）', () => {
    const ast = parseExpression('date and time("2020-01-01T00:00:00")');
    expect(ast.type).toBe('call');
    expect(ast.type === 'call' && ast.callee.type === 'name' && ast.callee.name).toBe('date and time');
  });

  it('合并规则不破坏迭代式（every/some/for）', () => {
    expect(evaluate('every x in [1, 2, 3] satisfies x > 0').value).toBe(true);
    expect(evaluate('for x in [1, 2] return x + 1').value).toEqual([2, 3]);
  });
});

describe('floken-feel · F2 instance of', () => {
  it('标量类型', () => {
    expect(evaluate('1 instance of number').value).toBe(true);
    expect(evaluate('"a" instance of number').value).toBe(false);
    expect(evaluate('"a" instance of string').value).toBe(true);
    expect(evaluate('true instance of boolean').value).toBe(true);
  });

  it('结构化类型', () => {
    expect(evaluate('[1, 2] instance of list').value).toBe(true);
    expect(evaluate('{ a: 1 } instance of context').value).toBe(true);
    expect(evaluate('[1..2] instance of range').value).toBe(true);
  });

  it('null 不是任何类型的实例（连 any 也不是）—— TCK 0070 口径', () => {
    expect(evaluate('null instance of number').value).toBe(false);
    expect(evaluate('null instance of any').value).toBe(false);
    expect(evaluate('null instance of Any').value).toBe(false);
  });

  it('可参与布尔组合', () => {
    expect(evaluate('1 instance of number and "x" instance of string').value).toBe(true);
  });

  it('多词类型名 `date and time` 可解析', () => {
    const ast = parseExpression('x instance of date and time');
    expect(ast).toMatchObject({
      type: 'instance',
      typeSpec: { kind: 'named', name: 'date and time' },
    });
  });

  it('泛型类型名可解析：list<Any> / context<a: string> / function<> -> Any', () => {
    expect(parseExpression('x instance of list<Any>')).toMatchObject({
      typeSpec: { kind: 'list', item: { kind: 'named', name: 'Any' } },
    });
    expect(parseExpression('x instance of context<a: string>')).toMatchObject({
      typeSpec: {
        kind: 'context',
        entries: [{ key: 'a', type: { kind: 'named', name: 'string' } }],
      },
    });
    expect(parseExpression('x instance of function<> -> Any')).toMatchObject({
      typeSpec: { kind: 'function', result: { kind: 'named', name: 'Any' } },
    });
  });

  it('泛型判定：list<T> 要求所有元素匹配', () => {
    expect(evaluate('[1, 2, 3] instance of list<Any>').value).toBe(true);
    expect(evaluate('[] instance of list<Any>').value).toBe(true);
    expect(evaluate('1 instance of list<Any>').value).toBe(false);
  });

  it('context 结构是**子类型**判定：允许多余键，缺键即假', () => {
    const types = {
      t: {
        kind: 'context' as const,
        entries: [
          { key: 'a', type: { kind: 'named' as const, name: 'string' } },
          { key: 'b', type: { kind: 'named' as const, name: 'string' } },
        ],
      },
    };
    expect(evaluate('{a: "x", b: "y"} instance of t', null, { types }).value).toBe(true);
    expect(evaluate('{a: "x", b: "y", c: 1} instance of t', null, { types }).value).toBe(true);
    expect(evaluate('{a: "x"} instance of t', null, { types }).value).toBe(false);
    expect(evaluate('{a: "x", b: 2} instance of t', null, { types }).value).toBe(false);
  });

  it('未知类型名 → 运行期判 false（合法性交由类型表定夺，语法层不再拦）', () => {
    expect(evaluate('1 instance of banana').value).toBe(false);
    expect(
      evaluate('256 instance of t255', null, {
        types: { t255: { kind: 'named', name: 'number' } },
      }).value,
    ).toBe(true);
  });
});

describe('floken-feel · F2 clock 注入（05-feel §6.1）', () => {
  beforeAll(async () => {
    await ensureTemporal();
  });

  it('today() 被钉死到注入的日期', () => {
    expect(evaluateTemporal('today()', {}, { clock: FIXED_CLOCK }).value).toMatchObject({
      kind: 'date',
      iso: '2026-03-01',
    });
  });

  it('now() 被钉死到注入的日期时间', () => {
    const r = evaluateTemporal('now()', {}, { clock: FIXED_CLOCK });
    expect(String((r.value as { iso: string }).iso)).toContain('2026-03-01T09:30');
  });

  it('未注入时仍走系统时钟（不崩）', () => {
    expect(evaluateTemporal('today()').value).toBeTruthy();
  });
});

describe('floken-feel · F2 S-FEEL 白名单（03-engine §7.2）', () => {
  it('白名单内 → 正常求值', () => {
    expect(evaluate('abs(-1)', {}, { allowedFunctions: ['abs'] }).value).toBe(1);
  });

  it('★ 越界 → 抛错，绝不静默求值', () => {
    const err = catchError(() => evaluate('abs(-1)', {}, { allowedFunctions: ['sum'] }));
    expect(err).toBeInstanceOf(FeelNotAllowedError);
    expect(err.code).toBe('FEEL_NOT_ALLOWED_FUNCTION');
    expect(err.details).toMatchObject({ function: 'abs', allowed: ['sum'] });
  });
});

describe('floken-feel · F2 资源上限与选项契约', () => {
  it('maxNodes 超限 → 抛 FEEL_LIMIT_MAX_NODES', () => {
    const err = catchError(() => evaluate('1 + 2 + 3 + 4 + 5', {}, { maxNodes: 3 }));
    expect(err).toBeInstanceOf(FeelLimitError);
    expect(err.code).toBe('FEEL_LIMIT_MAX_NODES');
    expect(err.details?.maxNodes).toBe(3);
  });

  it('maxDepth 超限 → 抛 FEEL_LIMIT_MAX_DEPTH', () => {
    // 括号分组不产生 AST 节点，所以用真的嵌套结构（列表套列表）
    const err = catchError(() => evaluate('[[[1]]]', {}, { maxDepth: 2 }));
    expect(err.code).toBe('FEEL_LIMIT_MAX_DEPTH');
    expect(err.details?.maxDepth).toBe(2);
  });

  it('timeoutMs 协作式超时 → 抛 FEEL_LIMIT_TIMEOUT', () => {
    const big = Array.from({ length: 200_000 }, (_, i) => i);
    const err = catchError(() => evaluate('for x in big return x', { big }, { timeoutMs: 1 }));
    expect(err.code).toBe('FEEL_LIMIT_TIMEOUT');
  });

  it('★ 未知选项 → 抛错（禁止静默忽略）', () => {
    const err = catchError(() =>
      evaluate('1', {}, { unknownOption: true } as unknown as Record<string, never>),
    );
    expect(err).toBeInstanceOf(FeelOptionError);
    expect(err.code).toBe('FEEL_OPTION_UNKNOWN');
    expect(err.details?.option).toBe('unknownOption');
  });

  it('选项值非法 → 抛 FEEL_OPTION_INVALID', () => {
    expect(catchError(() => evaluate('1', {}, { maxNodes: -1 })).code).toBe('FEEL_OPTION_INVALID');
    expect(catchError(() => evaluate('1', {}, { clock: 1 } as never)).code).toBe(
      'FEEL_OPTION_INVALID',
    );
  });

  /*
   * ★ 算符表里**没有**「字符串 → 数字」这一档，故算术操作数只收真数字（TCK 0100）。
   *   曾有一个 `strictCoercion` 选项管"要不要宽容转换"，与 TCK 直接冲突，已废 ——
   *   隐式转换是 DMN typeRef 强制（floken-dmn 的 coerceTypeRef）与内置函数实参的事，不是算符的事。
   */
  it('算术操作数不做字符串→数字隐式转换（TCK 0100 error_when_*）', () => {
    for (const src of ['10 + "10"', '"10" + 10', '10 - "10"', '10 * "10"', '10 / "10"']) {
      const r = evaluate(src);
      expect(r.value, src).toBe(null);
      expect(r.warnings[0]?.code, src).toBe('FEEL_EVAL_TYPE_MISMATCH');
    }
    // 唯一合法的"字符串参与算术"`string + string` 是拼接，不是相加
    expect(evaluate('"1" + "1"').value).toBe('11');
  });
});

describe('floken-feel · F2 时间能力', () => {
  // 「未加载 → 抛带可执行提示的错误」属于**进程启动态**的性质，
  // 只能在干净进程里验证 —— 见 test/cold-start.test.ts。
  // （本文件顶部已 import ./temporal，而注册是全局且不可逆的，同进程复现不出未加载态。）
  it('加载 ./temporal 后同一表达式正常求值', async () => {
    await ensureTemporal();
    expect(evaluateTemporal('today()').value).toBeTruthy();
  });
});
