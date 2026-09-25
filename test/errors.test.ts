/**
 * floken-feel · 错误契约一致性测试
 *
 * 对应 AGENTS.md §5「错误处理契约」：本测试就是那张契约的可执行版本。
 * 五包各自持有一份等价测试（不共享运行时基类，只共享**形状**）。
 */

import { describe, it, expect } from 'vitest';
import {
  FEEL_DIAGNOSTIC_CODES,
  FEEL_ERROR_CODES,
  FeelError,
  FeelLimitError,
  FeelNotAllowedError,
  FeelNotLoadedError,
  FeelOptionError,
  FeelSyntaxError,
  TEMPORAL_FUNCTIONS,
  diagnostic,
  evaluate,
  parseExpression,
  unaryTest,
} from '../src/entries/index.js';
import { TEMPORAL_BUILTINS } from '../src/entries/temporal.js';

const ERROR_CLASSES = [
  FeelError,
  FeelSyntaxError,
  FeelOptionError,
  FeelNotLoadedError,
  FeelLimitError,
  FeelNotAllowedError,
] as const;

const ALL_CODES: string[] = [
  ...Object.values(FEEL_ERROR_CODES),
  ...Object.values(FEEL_DIAGNOSTIC_CODES),
];

function catchError(fn: () => unknown): FeelError {
  try {
    fn();
  } catch (e) {
    if (e instanceof FeelError) return e;
    throw e;
  }
  throw new Error('expected the call to throw, but it did not');
}

describe('floken-feel · 错误对象结构契约（AGENTS.md §5.2）', () => {
  it('每个错误子类都带齐 name / code / pkg / position / node / hint / details', () => {
    for (const Ctor of ERROR_CLASSES) {
      const err = new Ctor('message', {
        code: 'FEEL_TEST_CONTRACT',
        position: { from: 0, to: 1 },
        node: { id: 'n1', path: 'a.b' },
        hint: 'hint',
        details: { k: 1 },
      });
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(FeelError);
      expect(err.name).toBe(Ctor.name);
      expect(err.floken).toBe(true);
      expect(err.pkg).toBe('feel');
      expect(err.code).toBe('FEEL_TEST_CONTRACT');
      expect(err.position).toEqual({ from: 0, to: 1 });
      expect(err.node).toEqual({ id: 'n1', path: 'a.b' });
      expect(err.hint).toBe('hint');
      expect(err.details).toEqual({ k: 1 });
      expect(typeof err.message).toBe('string');
      expect(typeof err.stack).toBe('string');
    }
  });

  it('可选字段缺省时不出现 undefined 键（保持 JSON 干净）', () => {
    const err = new FeelSyntaxError('m', { code: 'FEEL_TEST_MIN' });
    expect(Object.keys(err)).not.toContain('position');
    expect(Object.keys(err)).not.toContain('hint');
    expect(Object.keys(err)).not.toContain('details');
  });
});

describe('floken-feel · 错误码命名规则（AGENTS.md §5.3）', () => {
  it('全部符合 <域>_<类别>_<对象>，全大写蛇形，域为 FEEL', () => {
    expect(ALL_CODES.length).toBeGreaterThan(10);
    for (const code of ALL_CODES) {
      expect(code).toMatch(/^FEEL_[A-Z0-9]+(_[A-Z0-9]+)+$/);
    }
  });

  it('码表内无重复值', () => {
    expect(new Set(ALL_CODES).size).toBe(ALL_CODES.length);
  });

  it('抛出码与诊断码两个命名空间不重叠', () => {
    const thrown = new Set<string>(Object.values(FEEL_ERROR_CODES));
    for (const code of Object.values(FEEL_DIAGNOSTIC_CODES)) {
      expect(thrown.has(code)).toBe(false);
    }
  });

  it('诊断码统一带 EVAL_ 中缀（表示"求值降级"而非"契约破坏"）', () => {
    for (const code of Object.values(FEEL_DIAGNOSTIC_CODES)) {
      expect(code).toMatch(/^FEEL_EVAL_/);
    }
  });
});

describe('floken-feel · 两条通道不许混（AGENTS.md §5.1）', () => {
  it('语法错 → 抛，且带 code + position', () => {
    const err = catchError(() => parseExpression('1 +'));
    expect(err).toBeInstanceOf(FeelSyntaxError);
    expect(err.code).toMatch(/^FEEL_SYNTAX_/);
    expect(err.position).toBeDefined();
  });

  it('求值降级（变量/函数/类型）→ 不抛，走 warnings', () => {
    for (const src of ['nope', 'nope(1)', '1[1]']) {
      const r = evaluate(src);
      expect(r.value).toBe(null);
      expect(r.warnings.length).toBeGreaterThan(0);
      expect(r.warnings[0]?.code).toMatch(/^FEEL_EVAL_/);
      expect(r.warnings[0]?.severity).toBe('warn');
      expect(typeof r.warnings[0]?.start).toBe('number');
      expect(typeof r.warnings[0]?.end).toBe('number');
    }
    // 注意：`1 in 5` **不在此列** —— `in` 右侧的裸值是合法的 unary test（「等于」），
    // 求值结果为 false 而非降级（TCK 0072 用例，2026-09-25 修）。
    expect(evaluate('1 in 5').value).toBe(false);
    expect(evaluate('1 in 5').warnings).toHaveLength(0);
  });

  it('unaryTest 同样只降级不抛', () => {
    const r = unaryTest('nope', { '?': 1 });
    expect(r.warnings[0]?.code).toBe('FEEL_EVAL_NO_VARIABLE');
  });

  it('message 不含易变数据：时间函数错误的函数名进 details', () => {
    // 本文件已 import ./temporal（注册全局且不可逆），故用空 builtins 覆盖表来走"未加载"路径：
    // 这同时证明该错误是**按名字查不到实现**时抛出的，与注册与否无关。
    const err = catchError(() => evaluate('date("2020-01-01")', undefined, { builtins: {} }));
    expect(err.code).toBe('FEEL_NOT_LOADED_TEMPORAL');
    expect(err.message).not.toContain('date');
    expect(err.details?.function).toBe('date');
  });
});

describe('floken-feel · 诊断形状（Diagnostic）', () => {
  it('diagnostic() 缺省 severity = warn，且不含多余键', () => {
    const d = diagnostic({ code: 'FEEL_EVAL_TEST', message: 'm', start: 1, end: 2 });
    expect(d).toEqual({
      severity: 'warn',
      code: 'FEEL_EVAL_TEST',
      message: 'm',
      start: 1,
      end: 2,
    });
  });

  it('expected / suggestions 为可选，给了才出现', () => {
    const d = diagnostic({
      code: 'FEEL_SYNTAX_EXPECTED_TOKEN',
      message: 'm',
      start: 0,
      end: 1,
      severity: 'error',
      expected: ['rparen'],
      suggestions: ['此处可能漏了 `)`'],
    });
    expect(d.severity).toBe('error');
    expect(d.expected).toEqual(['rparen']);
    expect(d.suggestions).toHaveLength(1);
  });
});

describe('floken-feel · 延迟能力登记表不漂移', () => {
  it('TEMPORAL_FUNCTIONS ⊂ ./temporal 实现（每项都有实现）', () => {
    expect(TEMPORAL_FUNCTIONS.size).toBeGreaterThan(5);
    for (const name of TEMPORAL_FUNCTIONS) {
      expect(typeof TEMPORAL_BUILTINS[name], `缺少实现：${name}`).toBe('function');
    }
  });

  // 「核心不加载 ./temporal 时这些名字一律抛未加载」的验证已移出本文件 ——
  // 本文件顶部 import 了 ./temporal（注册全局且不可逆），同进程复现不出未加载态。
  // 新落点：test/cold-start.test.ts（独立进程，含 AC-F7 双向）。
});
