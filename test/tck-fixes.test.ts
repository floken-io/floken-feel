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

/**
 * 回退后（对齐 DMN 1.4 §10.3.2.13.1 + feelin v8.2.0）：内置函数**形参/类型类**错误
 * （arity / 实参类型 / 取值越界 / 命名参数 / 时间字面量非法 / 时长分量跨类）不再抛出，
 * 而是返回 `null` + 诊断。本助手断言「值为 null」且「携带指定诊断码」，既验证不抛错、
 * 也锁死诊断归类（与规范/feelin 的 null 口径一致）。
 */
const nullDiag = (src: string, code: string): void => {
  const r = evaluate(src);
  expect(r.value, `value of ${src}`).toBe(null);
  expect(r.warnings.some((w: { code?: string }) => w.code === code), `diag of ${src}`).toBe(true);
};

/**
 * 部分内置函数对 null / 非字符串实参走**静默** `return null`（如 `reqString` /
 * `reqBoolean` / `get value` 的 early-return 分支），不抛错、也不挂诊断。
 * 这类只断言「值为 null」（回退的核心行为），不校验诊断码。
 */
const nullVal = (src: string): void => {
  expect(evaluate(src).value, `value of ${src}`).toBe(null);
};

describe('@floken/feel · TCK 修复回归 · 词法与字面量', () => {
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

describe('@floken/feel · TCK 修复回归 · 区间（Range 一等公民）', () => {
  /** 抛出的错误码；没抛返回 `null`（错误码在 `e.code` 上，不在 message 里） */
  const code = (src: string): string | null => {
    try {
      evaluate(src);
      return null;
    } catch (e) {
      return (e as { code?: string }).code ?? null;
    }
  };

  it('开闭括号四种写法，含 `)` 收尾（TCK 0068/0072）', () => {
    const r1 = evaluate('[1..10)').value;
    const r2 = evaluate('[1..10[').value;
    expect(isRange(r1) && isRange(r2)).toBe(true);
    expect(r1).toMatchObject({ fromInclusive: true, toInclusive: false });
    expect(r2).toMatchObject({ fromInclusive: true, toInclusive: false });
    expect(evaluate('[1..10) = [1..10[').value).toBe(true);
  });

  it('无界区间：前缀比较式是确定比较（TCK 0072 大项）', () => {
    expect(evaluate('1 in <= 10').value).toBe(true);
    expect(evaluate('10 in <= 10').value).toBe(true);
    expect(evaluate('11 in <= 10').value).toBe(false);
    expect(evaluate('10 in < 10').value).toBe(false);
    expect(evaluate('11 in >= 10').value).toBe(true);
    expect(evaluate('10 in > 10').value).toBe(false);
  });

  /*
   * ⚠️ 端点**显式**写成 `null` 与前缀比较式是**两回事** —— 两者的 `from/to` 都是 null，
   * 靠 `FeelRange.test` 判别位分开（TCK 0072 `null_001_a~d`）：
   * · 前缀式 `(< 10)` 语义就是 `x < 10`，**确定**；
   * · 显式 `(null..10]` 是"与 null 比大小"，无从判定 → `null`；
   * · 显式 `[1..null]`（闭端点是 null）→ 无效区间 → **抛**。
   */
  it('显式 null 端点：开→null、闭→抛（TCK 0072 null_001_a~d）', () => {
    expect(evaluate('5 in (null..10]').value).toBe(null);
    expect(evaluate('5 in [1..null)').value).toBe(null);
    for (const src of ['5 in [1..null]', '5 in [null..10]']) {
      expect(code(src), src).toBe('FEEL_EVAL_ARG_TYPE');
    }
    expect(evaluate('10 in (< 10)').value).toBe(false); // 前缀式不受影响
  });

  it('一元测试写法 ≠ 同端点的显式区间（TCK 0068 用同一对端点钉死）', () => {
    // 端点完全相同，但「写法」不同 → 不相等；同写法才相等。
    expect(evaluate('(< 10) = (null..10)').value).toBe(false);
    expect(evaluate('(<= 10) = (null..10]').value).toBe(false);
    expect(evaluate('(> 10) = (10..null)').value).toBe(false);
    expect(evaluate('(>= 10) = [10..null)').value).toBe(false);
    expect(evaluate('(< 10) = (< 10)').value).toBe(true);
    // 判别位不影响属性（TCK 0074）：端点为 null、开闭符号照常读出
    expect(evaluate('(< 10).start').value).toBe(null);
    expect(evaluate('(< 10).end').value).toBe(10);
    expect(evaluate('(< 10).end included').value).toBe(false);
    expect(evaluate('(<= 10).end included').value).toBe(true);
  });

  it('`in` 右侧裸值按相等判定；列表元素是区间按包含（TCK 0072）', () => {
    expect(evaluate('1 in 1').value).toBe(true);
    expect(evaluate('1 in 5').value).toBe(false);
    expect(evaluate('10 in =10').value).toBe(true);
    expect(evaluate('1 in [[2..4], [1..3]]').value).toBe(true);
    expect(evaluate('9 in [[2..4], [1..3]]').value).toBe(false);
  });

  /*
   * ★ `null in <区间>` → **null**（unknown，对齐 DMN 1.4 §10.3.2.13.1 + feelin v8.2.0）。
   * 注意区分"区间**端点**是 null"（`null_001_a~d`：开→null、闭→抛，见上一条）与
   * "**被测试值**是 null"（本条）：前者端点语义明确，后者在 FEEL 里归为 unknown → null。
   */
  it('被测试值是 null 且域是区间 → null（TCK 0072 null_001，对齐规范/feelin）', () => {
    expect(evaluate('null in [1..10]').value).toBe(null);
  });

  it('类型不可比 → null（未知）', () => {
    expect(evaluate('"a" in <= 10').value).toBe(null);
  });
});

describe('@floken/feel · TCK 修复回归 · 形参有类型（0050/0056/1101/1102/1141~1144）', () => {
  const catchErr = (src: string) => {
    try {
      evaluate(src);
      return null;
    } catch (e) {
      return e as { code: string; details?: Record<string, unknown> };
    }
  };

  it('`scale` 是**小数位数**而非步长（TCK 1101/1102）', () => {
    expect(evaluate('floor(1.56, 1)').value).toBe(1.5);
    expect(evaluate('floor(-1.56, 1)').value).toBe(-1.6);
    expect(evaluate('ceiling(1.56, 1)').value).toBe(1.6);
    expect(evaluate('ceiling(-1.56, 1)').value).toBe(-1.5);
  });

  it('round up/down 按**绝对值**方向（TCK 1141/1142）', () => {
    expect(evaluate('round up(-5.5, 0)').value).toBe(-6);
    expect(evaluate('round down(-5.5, 0)').value).toBe(-5);
    expect(evaluate('round up(-1.126, 2)').value).toBe(-1.13);
    expect(evaluate('round down(-1.126, 2)').value).toBe(-1.12);
  });

  it('round half up/down 只在中点分道（TCK 1143/1144）', () => {
    expect(evaluate('round half up(5.5, 0)').value).toBe(6);
    expect(evaluate('round half up(-5.5, 0)').value).toBe(-6);
    expect(evaluate('round half down(5.5, 0)').value).toBe(5);
    expect(evaluate('round half down(-5.5, 0)').value).toBe(-5);
    // 非中点：两者同结果
    expect(evaluate('round half down(-1.126, 2)').value).toBe(-1.13);
  });

  it('`scale` 合法范围为 [-6111, 6176]，越界 → null（+诊断 EVAL_ARG_RANGE，对齐规范）', () => {
    expect(evaluate('round up(5.5, 6176)').value).toBe(5.5);
    nullDiag('round up(5.5, (-6111 - 1))', 'FEEL_EVAL_ARG_RANGE');
  });

  it('`null` / 字符串 / 布尔 都不是 number → null（+诊断 EVAL_ARG_TYPE，对齐规范）', () => {
    for (const src of ['floor(null, 1)', 'abs("-1")', 'abs(null)', 'sqrt("4")', 'abs(true)']) {
      nullDiag(src, 'FEEL_EVAL_ARG_TYPE');
    }
  });

  it('少给 / 多给参数 → null（+诊断 EVAL_ARG_COUNT，对齐规范）', () => {
    nullDiag('abs()', 'FEEL_EVAL_ARG_COUNT');
    nullDiag('abs(1, 1)', 'FEEL_EVAL_ARG_COUNT');
    nullDiag('floor()', 'FEEL_EVAL_ARG_COUNT');
    nullDiag('floor(1.5, 1, 2)', 'FEEL_EVAL_ARG_COUNT');
  });

  it('modulo 不等于 JS `%`：商向下取整（TCK 0056）', () => {
    expect(evaluate('modulo(10, 4)').value).toBe(2);
    expect(evaluate('modulo(-12, 5)').value).toBe(3);
    expect(evaluate('modulo(12, -5)').value).toBe(-3);
    expect(evaluate('modulo(-12, -5)').value).toBe(-2);
    expect(evaluate('modulo(-10.1, 4.5)').value).toBeCloseTo(3.4, 10);
  });

  it('内置函数结果无定义 → null + 诊断 EVAL_UNDEFINED；运算符除零同样是 null', () => {
    /*
     * 对齐 Camunda/feelin：`sqrt(-1)` / `log(0)` / `modulo(x, 0)` 属"操作对给定值未定义"，
     * 与"参数类型不符"同属 unknown 一档 → `null` + 诊断，**不抛**。
     * 实证：TCK 这些用例的 `<expected>` 值本身就是 `null`，只是额外挂了 `errorResult="true"`
     * （那部分已按 `label#id` 登记 IGNORED，见 `tooling/tck/ignored.json`）。
     */
    nullDiag('modulo(10, 0)', 'FEEL_EVAL_UNDEFINED');
    nullDiag('sqrt(-1)', 'FEEL_EVAL_UNDEFINED');
    nullDiag('log(0)', 'FEEL_EVAL_UNDEFINED');
    expect(evaluate('(10+20)/0').value).toBe(null);
  });

  it('abs 对 duration 有定义、对 date/time → null（+诊断 EVAL_ARG_TYPE，对齐规范）', () => {
    expect(evaluate('abs(duration("-P1D"))').value).toMatchObject({ kind: 'duration' });
    expect(evaluate('abs(duration("-P1D")) = duration("P1D")').value).toBe(true);
    expect(evaluate('abs(duration("-P1Y")) = duration("P1Y")').value).toBe(true);
    nullDiag('abs(time("00:00:00"))', 'FEEL_EVAL_ARG_TYPE');
    nullDiag('abs(date("2018-12-06"))', 'FEEL_EVAL_ARG_TYPE');
  });
});

/**
 * 时间构造器的**重载与写法校验**，以及 `string()` 的规范文本。
 *
 * 这一批对应 `1115-feel-date-function` / `1116-feel-time-function` /
 * `1117-feel-date-and-time-function` / `0079-feel-string-function` 四组的集中失分
 * （合计约 109 条），语义全部由 TCK 逐条反推、再钉在这里防退化。
 */
describe('@floken/feel · TCK 修复回归 · 时间构造器重载与写法（1115/1116/1117）', () => {
  const catchErr = (src: string) => {
    try {
      evaluate(src);
      return null;
    } catch (e) {
      return e as { code: string; details?: Record<string, unknown> };
    }
  };
  const iso = (src: string) => {
    const v = evaluate(src).value;
    return isTemporal(v) ? v.iso : null;
  };

  it('`from` 三种入参：字符串 / 同类值 / 从 date-time 提取（1115#017~#024、1116#030~#037）', () => {
    expect(iso('date("2017-12-31")')).toBe('2017-12-31');
    expect(iso('date(date("2017-10-11"))')).toBe('2017-10-11');
    expect(iso('date(date and time("2017-08-14T14:25:00"))')).toBe('2017-08-14');
    expect(iso('date(date and time("2017-09-03T09:45:30@Europe/Paris"))')).toBe('2017-09-03');
    expect(iso('time(date and time("2017-08-10T10:20:00"))')).toBe('10:20:00');
    // 提取时间时**保留原值的偏移/时区**
    expect(iso('time(date and time("2017-08-10T10:20:00+01:00"))')).toBe('10:20:00+01:00');
    expect(iso('time(date and time("2017-09-04T11:20:00@Asia/Dhaka"))')).toBe('11:20:00@Asia/Dhaka');
    // date → 时刻按零偏移记（1116#053）
    expect(iso('time(date("2017-08-10"))')).toBe('00:00:00Z');
  });

  it('`date and time(date, time)` 组合：日期取前者、偏移/时区取后者（1117#029~#054）', () => {
    expect(iso('date and time(date("2017-01-01"), time("23:59:01"))')).toBe('2017-01-01T23:59:01');
    expect(iso('date and time(date("2017-01-01"), time("23:59:01Z"))')).toBe('2017-01-01T23:59:01Z');
    expect(iso('date and time(date("2017-01-01"), time("23:59:01@Europe/Paris"))')).toBe(
      '2017-01-01T23:59:01@Europe/Paris',
    );
    // 第一个实参自带的偏移被丢弃（#041）
    expect(
      iso('date and time(date and time("2017-08-10T10:20:00+02:00"), time("23:59:01"))'),
    ).toBe('2017-08-10T23:59:01');
  });

  it('分量式与命名参数（1115#025/#052、1116#038~#048/#082、1117#087）', () => {
    expect(iso('date(2017, 12, 31)')).toBe('2017-12-31');
    expect(iso('date(year:2017, month:8, day:30)')).toBe('2017-08-30');
    expect(iso('date(from:"2012-12-25")')).toBe('2012-12-25');
    expect(iso('time(11, 59, 45, null)')).toBe('11:59:45');
    expect(iso('time(11, 59, 45, duration("PT2H"))')).toBe('11:59:45+02:00');
    expect(iso('time(11, 59, 45, duration("PT2H45M55S"))')).toBe('11:59:45+02:45:55');
    // 零偏移一律归一成 `Z`（`PT0H` 与 `-PT0H` 都算零）
    expect(iso('time(11, 59, 45, duration("PT0H"))')).toBe('11:59:45Z');
    expect(iso('time(11, 59, 45, duration("-PT0H"))')).toBe('11:59:45Z');
    expect(iso('time(hour:11, minute:59, second:0, offset: duration("PT2H1M0S"))')).toBe(
      '11:59:00+02:01',
    );
    // `-00:00` / `+00:00` 文本写法也归一成 `Z`（1116#026/#027）
    expect(iso('time("11:22:33-00:00")')).toBe('11:22:33Z');
    expect(iso('time("11:22:33+00:00")')).toBe('11:22:33Z');
  });

  it('年份写法：4~9 位、不许前导零/正号，负年补扩年（1115#013、1117#010~#012）', () => {
    expect(iso('date("-2017-12-31")')).toBe('-2017-12-31');
    expect(iso('date and time("99999-12-31T11:22:33")')).toBe('99999-12-31T11:22:33');
    expect(iso('date and time("-99999-12-31T11:22:33")')).toBe('-99999-12-31T11:22:33');
    for (const bad of ['date("998-12-31")', 'date("01211-12-31")', 'date("9999999999-12-25")', 'date("+2012-12-02")']) {
      nullDiag(bad, 'FEEL_EVAL_TEMPORAL_VALUE');
    }
  });

  it('写法非法一律 → null（+诊断 EVAL_TEMPORAL_VALUE，对齐规范/feelin）', () => {
    const bad = [
      'date("2017-13-10")', // 月越界
      'date("2012/12/25")', // 分隔符
      'date(2017, 13, 31)',
      'date(2017, -8, 2)',
      // 月内天数溢出：Temporal 对象分量的 overflow 默认 `constrain` 会静默规整成 2-29 / 2-28，
      // 与字符串路径 `date("2020-02-30")`、扩展年路径 `date(999999999, 2, 30)` 的 null 自相矛盾，
      // 也与 feelin 的 `INVALID_ARGUMENTS` 不一致 → 已强制 `overflow: 'reject'`。
      'date(2020, 2, 30)',
      'date(2021, 2, 29)', // 平年没有 2 月 29 日
      'date(2020, 4, 31)', // 4 月只有 30 天
      'date(null, 2, 1)',
      'date(1)',
      'date([])',
      'date()',
      'time(23, 60, 45, null)', // 分越界
      'time(24, 59, 45, null)', // 时越界
      'time("23:59:60")', // 闰秒（Temporal 会静默规整，必须拦）
      'time("7:00:00")', // 未补零
      'time(2017)', // 数字不是时间（Temporal 会读成 20:17）
      'time("13:20:00+19:00")', // 偏移超 ±18:00
      'time("13:20:00@xyz/abc")', // 时区名不存在
      'time("13:20:00+02:00@Europe/Paris")', // 偏移与时区名互斥
      'date and time("2017-12-31T24:00:01")',
      'date and time("11:00:00")', // 没有日期部分
      'date and time(null)',
      'date and time(date("2017-08-10"), null)',
    ];
    for (const src of bad) {
      nullDiag(src, 'FEEL_EVAL_TEMPORAL_VALUE');
    }
  });

  it('扩展年（|year| > 275760）可构造、string() 原样输出（1115#015/#016/#029/#030）', () => {
    /*
     * 曾经是 known-gap（给 null）。现按 TCK 要求实现：Temporal 只到 ±275760，
     * 但 ISO 8601 扩年与 FEEL 都无此上限，故走 `extendedYear()` 兜底 —— 不经过
     * Temporal（`raw` 为 null），`iso` 直接用规范化原文。
     */
    expect(evaluate('string(date("999999999-12-31"))').value).toBe('999999999-12-31');
    expect(evaluate('string(date("-999999999-12-31"))').value).toBe('-999999999-12-31');
    expect(evaluate('string(date(999999999, 12, 31))').value).toBe('999999999-12-31');
    expect(evaluate('string(date(-999999999, 12, 31))').value).toBe('-999999999-12-31');
    // 1117#027/#028：日期时间的扩展年同样原样输出
    expect(
      evaluate('string(date and time("999999999-12-31T23:59:59.999999999@Europe/Paris"))').value,
    ).toBe('999999999-12-31T23:59:59.999999999@Europe/Paris');
    expect(
      evaluate('string(date and time("-999999999-12-31T23:59:59.999999999+02:00"))').value,
    ).toBe('-999999999-12-31T23:59:59.999999999+02:00');

    /* 兜底**不是**放宽校验：月/日/时刻照旧自己校验，非法写法仍抛（日期没有 2 月 30 日，
     * 年份 10 位是非法写法）。这一点由 `extendedYear()` 自己守，Temporal 帮不上忙。 */
    nullDiag('date("999999999-02-30")', 'FEEL_EVAL_TEMPORAL_VALUE');
    nullDiag('date("999999999-13-01")', 'FEEL_EVAL_TEMPORAL_VALUE');
    nullDiag('date("9999999999-12-31")', 'FEEL_EVAL_TEMPORAL_VALUE');
    nullDiag('date(999999999, 2, 30)', 'FEEL_EVAL_TEMPORAL_VALUE');

    // 运算退回 null，不得崩（底层对象为 null 时 `shiftByDuration` / 属性访问都退 null）
    expect(evaluate('date("999999999-12-31") + duration("P1D")').value).toBe(null);
    expect(evaluate('date("999999999-12-31").year').value).toBe(null);
  });
});

describe('@floken/feel · TCK 修复回归 · string() 规范文本（0079）', () => {
  const catchErr = (src: string) => {
    try {
      evaluate(src);
      return null;
    } catch (e) {
      return e as { code: string; details?: Record<string, unknown> };
    }
  };
  const s = (src: string) => evaluate(src).value;

  it('标量：字符串返回自身，数字/布尔写字面', () => {
    expect(s('string("foo")')).toBe('foo');
    expect(s('string(123.45)')).toBe('123.45');
    expect(s('string(true)')).toBe('true');
    expect(s('string(null)')).toBe(null);
  });

  it('时间值用 `iso`（FEEL 规范文本）', () => {
    expect(s('string(date("2018-12-10"))')).toBe('2018-12-10');
    expect(s('string(date and time("2018-12-10"))')).toBe('2018-12-10T00:00:00');
    expect(s('string(date and time("2018-12-10T10:30:00@Etc/UTC"))')).toBe(
      '2018-12-10T10:30:00@Etc/UTC',
    );
    expect(s('string(time("10:30:00.0001+05:00:01"))')).toBe('10:30:00.0001+05:00:01');
  });

  it('时长按规范化后的规范形（含两类零值）', () => {
    expect(s('string(duration("PT49H"))')).toBe('P2DT1H');
    expect(s('string(duration("P25M"))')).toBe('P2Y1M');
    expect(s('string(duration("P0D"))')).toBe('PT0S');
    expect(s('string(duration("P0Y"))')).toBe('P0M');
    // 两个 FEEL duration 类型的零值**不相等**（P0M vs PT0S）
    expect(s('is(@"P0Y", @"P0D")')).toBe(false);
  });

  it('list / context 用字面形态，元素递归、字符串带引号', () => {
    expect(s('string([1, 2, 3, "foo"])')).toBe('[1, 2, 3, "foo"]');
    expect(s('string([1,2,3,[4,5,"foo"]])')).toBe('[1, 2, 3, [4, 5, "foo"]]');
    expect(s('string({a: "foo"})')).toBe('{a: "foo"}');
    expect(s('string({a: "foo", b: {bar: "baz"}})')).toBe('{a: "foo", b: {bar: "baz"}}');
    expect(s('string({"{" : "foo"})')).toBe('{"{": "foo"}');
  });

  it('实参个数必须恰好 1（少给/多给 → null + EVAL_ARG_COUNT，对齐规范）', () => {
    nullDiag('string()', 'FEEL_EVAL_ARG_COUNT');
    nullDiag('string("foo", "bar")', 'FEEL_EVAL_ARG_COUNT');
    expect(s('string(from:"foo")')).toBe('foo');
  });
});

describe('@floken/feel · TCK 修复回归 · 上下文函数族（0057/1140/1145/1146/1147）', () => {
  const err = (src: string) => {
    try {
      evaluate(src);
      return null;
    } catch (e) {
      return e as { code: string; details?: Record<string, unknown> };
    }
  };
  const v = (src: string) => evaluate(src).value;
  /** 把 FeelContext 递归摊成普通对象，便于直接跟期望的对象字面量比 */
  const obj = (src: string): unknown => {
    const deep = (x: unknown): unknown => {
      if (x && typeof x === 'object' && '__feelContext' in x) {
        const out: Record<string, unknown> = {};
        for (const [k, val] of (x as { entries: Map<string, unknown> }).entries) out[k] = deep(val);
        return out;
      }
      if (Array.isArray(x)) return x.map(deep);
      return x;
    };
    return deep(v(src));
  };

  it('语境键支持空格与额外字符（用源码切片，TCK 0057 004/005/006/007）', () => {
    expect(obj('{foo bar: "foo"}')).toEqual({ 'foo bar': 'foo' });
    expect(obj('{foo+bar: "foo"}')).toEqual({ 'foo+bar': 'foo' });
    expect(obj('{"foo+bar((!!],foo": "foo"}')).toEqual({ 'foo+bar((!!],foo': 'foo' });
    expect(obj('{"": "foo"}')).toEqual({ '': 'foo' });
  });

  it('上下文里重复键无定义 → null + 诊断（TCK 0057 008，DMN14-178）', () => {
    /*
     * 两条路径都落 `null` + 诊断码 `FEEL_EVAL_UNDEFINED`：
     * ① `{...}` 字面量**不经** `call` 边界 → 求值器就地落诊断（`evaluator.ts` 的 `case 'context'`）；
     * ② `context([...])` 内置函数抛 → 被 `call` 边界捕获转成 `null` + 诊断。
     * 二者口径必须一致，否则同一语义会因写法不同而一边抛一边静默。
     */
    nullDiag('{foo: "bar", foo: "baz"}', 'FEEL_EVAL_UNDEFINED');
    nullDiag('context([{key:"a", value:1},{key:"a", value:2}])', 'FEEL_EVAL_UNDEFINED');
  });

  it('`context(entries)`：收列表也收单个条目，键/值缺一不可（TCK 1145）', () => {
    expect(obj('context([{key:"a", value:1}, {key:"b", value:2}])')).toEqual({ a: 1, b: 2 });
    expect(obj('context({key:"a", value:1})')).toEqual({ a: 1 });
    expect(obj('context(entries: {key:"a", value:1})')).toEqual({ a: 1 });
    expect(obj('context({key: "a", value: null})')).toEqual({ a: null });
    expect(obj('context({key: "", value: 1})')).toEqual({ '': 1 });
    expect(obj('context([{key:"a", value:1, ignored:"foo"}])')).toEqual({ a: 1 });
    // 缺 key / 缺 value / 类型不对 / 个数不对 → 全部 null（+诊断，对齐规范/feelin）
    for (const src of [
      'context({value:1})',
      'context({key: "a"})',
      'context({key: null, value:1})',
      'context("foo")',
      'context(null)',
      'context()',
      'context([], "foo")',
    ]) {
      expect(evaluate(src).value, src).toBe(null);
    }
  });

  it('`context put`：位置调用两种键形态都收（TCK 1146）', () => {
    expect(obj('context put({}, "a", 1)')).toEqual({ a: 1 });
    expect(obj('context put({"a": 1}, "a", 2)')).toEqual({ a: 2 });
    expect(obj('context put({}, "a", null)')).toEqual({ a: null });
    expect(obj('context put({}, "", 1)')).toEqual({ '': 1 });
    // 覆盖已有键时**保持原插入顺序**
    expect(Object.keys(obj('context put({a:1, b:2, c:3}, "b", 3)') as object)).toEqual(['a', 'b', 'c']);
  });

  it('`context put`：字符串列表即**路径**，逐层重建新副本（TCK 1146 nested*）', () => {
    expect(obj('context put({x:1, y: {a: 0} }, ["y", "a"], 2)')).toEqual({ x: 1, y: { a: 2 } });
    expect(obj('context put({x:1, y: {a: 0} }, ["y", "b"], 2)')).toEqual({ x: 1, y: { a: 0, b: 2 } });
    expect(obj('context put({x:1, y: {a: {b: {c: 1}} }}, ["y","a","b","c"], 2)')).toEqual({
      x: 1,
      y: { a: { b: { c: 2 } } },
    });
    // 不改原值：同一表达式里原件与副本各留一份
    expect(obj('{original: {a: {b: 1}}, copied: context put(original, ["a","b"], 2)}')).toEqual({
      original: { a: { b: 1 } },
      copied: { a: { b: 2 } },
    });
    // 中间层不是上下文（`a` 是数字）/ 路径里有 null / 键非字符串 / 个数错 → null（+诊断，对齐规范）
    for (const src of [
      'context put({x:1, y:{a:0}}, ["y", null], 2)',
      'context put({x:1, y:{a:0}}, [null, "a"], 2)',
      'context put({}, null, 1)',
      'context put({}, 1, 1)',
      'context put([], "a", 1)',
      'context put({}, "a")',
      'context put({}, "a", 1, 1)',
    ]) {
      expect(evaluate(src).value, src).toBe(null);
    }
    // 空路径 / 路径走到死胡同（y.a 是数字、再深入 b）→ 同样是 null + 诊断 EVAL_UNDEFINED
    // （"结果无定义"与"参数/类型不符"现已统一为 unknown → null，对齐 Camunda/feelin）
    nullDiag('context put({x:1, y:{a:0}}, [], 2)', 'FEEL_EVAL_UNDEFINED');
    nullDiag('context put({x:1, y:{a:0}}, ["y","a","b","c"], 2)', 'FEEL_EVAL_UNDEFINED');
  });

  it('`context put` 同名重载：`keys:` 收列表、`key:` 只收字符串（TCK 1146 nested007/008）', () => {
    expect(obj('context put(context: {x:1, y:{a:0}}, keys: ["y","a"], value: 2)')).toEqual({
      x: 1,
      y: { a: 2 },
    });
    expect(obj('context put(context: {}, key: "a", value: 1)')).toEqual({ a: 1 });
    // 列表落在 `key:` 上是签名错（`key` 是 string，不是 list）→ null + 诊断
    nullDiag('context put(context: {x:1, y:{a:0}}, key: ["y","a"], value: 2)', 'FEEL_EVAL_ARG_TYPE');
    nullDiag('context put(context: {}, ky: "a", value: 1)', 'FEEL_EVAL_NAMED_ARG');
  });

  it('`context merge`：收列表也收单个上下文，非上下文元素 → 抛（TCK 1147）', () => {
    expect(obj('context merge([{"a": 1}])')).toEqual({ a: 1 });
    expect(obj('context merge([{"a": 1}, {"b": 2}])')).toEqual({ a: 1, b: 2 });
    expect(obj('context merge([{"a": 1}, {"a": 2}])')).toEqual({ a: 2 });
    // 不做深合并：整个 `a` 被后者替换
    expect(obj('context merge([{"a": {"aa": 1}}, {"a": {"bb": 2}}])')).toEqual({ a: { bb: 2 } });
    expect(obj('context merge({"a": 1})')).toEqual({ a: 1 });
    expect(obj('context merge(contexts: {"a": 1})')).toEqual({ a: 1 });
    for (const src of [
      'context merge(null)',
      'context merge()',
      'context merge([],"foo")',
      'context merge([1,2,3])',
      'context merge([{"a": 1},2,{"b": 2}])',
      'context merge(context: [{"a": 1}])',
    ]) {
      expect(evaluate(src).value, src).toBe(null);
    }
  });

  it('`get entries` 个数必须为 1、`m` 必须是上下文（TCK 0081）', () => {
    expect(v('count(get entries({a: "foo", b: "bar"}))')).toBe(2);
    expect(obj('get entries({})')).toEqual([]);
    for (const src of ['get entries()', 'get entries({a:"foo"}, {b:"bar"})', 'get entries(null)', 'get entries(123)', 'get entries([1,2,3])']) {
      expect(evaluate(src).value, src).toBe(null);
    }
  });

  it('`string join`：只收字符串列表、单个字符串强转、个数 1~2（TCK 1140）', () => {
    expect(v('string join(["a","b","c"])')).toBe('abc');
    expect(v('string join(["a","b","c"], " and ")')).toBe('a and b and c');
    expect(v('string join(["a","b","c"], null)')).toBe('abc');
    expect(v('string join(["a",null,"c"], "X")')).toBe('aXc');
    expect(v('string join([])')).toBe('');
    expect(v('string join("a", "X")')).toBe('a');
    for (const src of [
      'string join()',
      'string join(["a","c"], "X", "foo")',
      'string join([1,2,3], "X")',
      'string join(123, "X")',
      'string join(null)',
    ]) {
      expect(evaluate(src).value, src).toBe(null);
    }
  });
});

// ────────────────────────────────────────────────────────────────

describe('@floken/feel · TCK 修复回归 · 迭代序列与函数值（0084 / 0092）', () => {
  const err = (src: string) => {
    try {
      evaluate(src);
      return null;
    } catch (e) {
      return e as { code: string };
    }
  };
  const v = (src: string) => evaluate(src).value;

  /*
   * `for i in 2..4` 里**裸**的 `a..b` 是**迭代序列**，不是区间字面量：
   * 序列允许递减，而 `[2..1]`（区间、start > end）是无效区间 → 抛。
   * 判别位是 `Node.seq`；两端都走 `parseExpression`，故 `1+1..1+3` 也成立。
   */
  it('裸序列可升可降；区间字面量 start > end 是错误（TCK 0084#007~#025）', () => {
    expect(v('for i in 2..4 return i')).toEqual([2, 3, 4]);
    expect(v('for i in 4..2 return i')).toEqual([4, 3, 2]);
    expect(v('for i in 1..1 return i')).toEqual([1]);
    expect(v('for i in 1+1..1+3 return i')).toEqual([2, 3, 4]);
    expect(v('for i in 1..-1 return i')).toEqual([1, 0, -1]);
    expect(err('for i in [2..1] return i')).not.toBeNull();
  });

  it('日期序列按天步进；string / date-time / time / duration 没有自然步长 → 抛', () => {
    expect(evaluate('for i in @"1980-01-01"..@"1980-01-03" return string(i)').value).toEqual([
      '1980-01-01',
      '1980-01-02',
      '1980-01-03',
    ]);
    expect(evaluate('for i in @"1980-01-03"..@"1980-01-01" return string(i)').value).toEqual([
      '1980-01-03',
      '1980-01-02',
      '1980-01-01',
    ]);
    for (const src of [
      'for i in "a".."z" return i',
      'for i in ["a".."z"] return i',
      'for i in @"1980-01-03T00:00:00"..@"1980-01-01T00:00:00" return i',
      'for i in @"00:00:00"..@"00:00:00" return i',
      'for i in @"P1D"..@"P2D" return i',
    ]) {
      expect(err(src), src).not.toBeNull();
    }
  });

  /** `partial` = 已算出的前缀；`partial[-1]` 是上一个结果（阶乘，TCK 0084#013） */
  it('`partial` 绑定已算出的前缀（TCK 0084#013）', () => {
    expect(v('for i in 0..4 return if i = 0 then 1 else i * partial[-1]')).toEqual([1, 1, 2, 6, 24]);
  });

  /** 后一个迭代变量必须能看到前一个（`y in x`，TCK 0084#015） */
  it('后一个迭代变量可见前一个（TCK 0084#015）', () => {
    expect(v('for x in [[1,2],[3,4]], y in x return y')).toEqual([1, 2, 3, 4]);
    expect(v('for x in [[1,2],[3,4]] return for y in x return y')).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  /** 带类型标注的函数字面量（DMN 1.4 §10.3.14，TCK 0092 / 0082） */
  it('函数字面量的形参可带类型标注（只解析、不做静态检查）', () => {
    expect(v('(function (a: number) 1 + a)(2)')).toBe(3);
    // 两个形参都带标注；`+` 不是字符串拼接，故用 `=` 验参
    expect(v('(function (a: string, b: string) a = b)("x", "x")')).toBe(true);
    expect(v('(function (a: string, b: string) a = b)("x", "y")')).toBe(false);
  });

  /** 内置函数名本身是一个值，可当实参传（TCK 0092#014 的 `bkm_014_1(abs, sqrt)`） */
  it('内置函数名可作为值传递', () => {
    expect(v('(function(f, x) f(x))(abs, -3)')).toBe(3);
    expect(v('abs(-3)')).toBe(3);
  });
});

// ────────────────────────────────────────────────────────────────

describe('@floken/feel · TCK 修复回归 · 正则方言（1111 / 1109）', () => {
  const err = (src: string) => {
    try {
      evaluate(src);
      return null;
    } catch (e) {
      return e as { code: string };
    }
  };
  const v = (src: string) => evaluate(src).value;

  /** `i` 必须按 Unicode 全折叠 —— 光有 JS 的 `i` 认不出 KELVIN SIGN */
  it('`i` 走 Unicode 全折叠（TCK caselessmatch07）', () => {
    expect(v('matches("K", "k", "i")')).toBe(true);
    expect(v('matches("abc", "ABC", "i")')).toBe(true);
    expect(v('matches("q", "[^Q]", "i")')).toBe(false);
  });

  /** 字符类减法 `[A-Z-[OI]]` → JS `v` 模式（只有真的出现减法时才切 `v`） */
  it('字符类减法（TCK caselessmatch08~11）', () => {
    expect(v('matches("x", "[A-Z-[OI]]", "i")')).toBe(true);
    expect(v('matches("X", "[A-Z-[OI]]", "i")')).toBe(true);
    expect(v('matches("O", "[A-Z-[OI]]", "i")')).toBe(false);
    expect(v('matches("i", "[A-Z-[OI]]", "i")')).toBe(false);
  });

  it('`x` 自由空格模式：类外空白忽略、转义空白是字面空白', () => {
    expect(v('matches("hello world", " hello[ ]world", "x")')).toBe(true);
    expect(v('matches("hello world", "he ll o[ ]worl d", "x")')).toBe(true);
    expect(v('matches("hello world", "hello\\x20world", "x")')).toBe(true);
  });

  /** `\p{IsBasicLatin}` 是块属性；JS 没有块名，映射到等价的二进制属性 ASCII */
  it('块属性 `\\p{IsBasicLatin}`（TCK K2-MatchesFunc-5/6/7）', () => {
    expect(v('matches("hello world", "\\p{ IsBasicLatin}+", "x")')).toBe(true);
    expect(v('matches("hello world", "\\p{ I s B a s i c L a t i n }+", "x")')).toBe(true);
    // 不带 `x` 时块名里的空格留着 → 认不出块 → null（+诊断 ARG_TYPE，对齐规范/feelin）
    nullDiag('matches("hello world", "\\p{ IsBasicLatin}+")', 'FEEL_EVAL_ARG_TYPE');
  });

  it('flags 不认识 / 实参非字符串 / 字符类内反向引用 → null 或 false（对齐规范，不再抛）', () => {
    // flags 非法 → null + 诊断 ARG_TYPE（由 compileRegex 的 argTypeError 经边界转换转成 null）
    nullDiag('matches("a", "b", "p")', 'FEEL_EVAL_ARG_TYPE');
    nullDiag('matches("a", "b", " ")', 'FEEL_EVAL_ARG_TYPE');
    nullDiag('matches("a", "b", "X")', 'FEEL_EVAL_ARG_TYPE');
    // pattern / flags 非字符串 → null（reqString 直接返回 null，无诊断）
    expect(evaluate('matches("a", [])').value).toBe(null);
    expect(evaluate('matches("a", "b", [])').value).toBe(null);
    // 单参：pattern 缺失 → null（reqString 返回 null，无诊断）
    expect(evaluate('matches("a")').value).toBe(null);
    // 4 参：实参个数越界 → null + 诊断 ARG_COUNT
    nullDiag('matches("a", "b", "c", "d")', 'FEEL_EVAL_ARG_COUNT');
    // 正则方言：字符类内 `\0` / 反向引用 → 非法正则 → 抛 argTypeError → null + 诊断（对齐规范，不再 false）
    nullDiag('matches("abcd", "(asd)[asd\\0]")', 'FEEL_EVAL_ARG_TYPE');
    nullDiag('matches("h", "(.)\\3")', 'FEEL_EVAL_ARG_TYPE');
    expect(v('matches("abracadabra", "bra", null)')).toBe(true);
  });

  /** `replace` 替换**全部**匹配（JS 的字符串模式只换第一处，TCK 1109#008） */
  it('`replace` 默认全局替换；`$0` 是整个匹配', () => {
    expect(v('replace("abracadabra","bra","*")')).toBe('a*cada*');
    // `.` 是正则元字符（匹配任意字符），要字面点得写 `\.`
    expect(v('replace("a.c", "\\.", "[$0]")')).toBe('a[.]c');
    expect(v('replace("aaa", "a", "b")')).toBe('bbb');
  });
});

/**
 * 第六轮（2026-09-26 续）：**严格参数校验** —— 该抛错而不是返回 null。
 *
 * 这一整块来自同一条发现：B 口径的「严格口径」（官方 `errorResult="true"`）比宽松口径
 * 少 64 条，全部是「引擎给了 null，官方期望抛错」。它们集中在**内置函数与运算符的
 * 形参类型**上：FEEL 里 `null` 实参不是"未知值"，是**类型错误** —— 三值语义管的是
 * "值存在但未知"，不是"实参类型不对"。
 */
/**
 * 第六轮（2026-09-26 续）「严格参数校验」的**回退**：用户拍板「必须对齐规范」。
 *
 * 原 r6 把内置函数**形参/类型类**错误（`EVAL_ARG_TYPE` / `EVAL_ARG_COUNT` /
 * `EVAL_ARG_RANGE` / `EVAL_NAMED_ARG` / `EVAL_TEMPORAL_VALUE` / `EVAL_DURATION_COMPONENT`）
 * 从「返回 null」改成「抛错」。但 DMN 1.4 §10.3.2.13.1 与 feelin v8.2.0 都明确：
 * 实参不符参数域的结果是 `null`（unknown），不是 error。故此处全部回退为
 * 「返回 null + 诊断」，与规范/feelin 一致。
 *
 * 注意 `EVAL_UNDEFINED`（函数**结果**无定义，如 `sqrt(-1)`/`log(0)`/`modulo(x,0)`/
 * `product([])`/`stddev([1])`/`{重复键上下文}`）**不属于**参数/类型不符，按 `AGENTS.md §5`
 * 与 TCK `errorResult` 仍须 **THROW** —— 见各文件中保留的 `EVAL_UNDEFINED` 断言。
 */
describe('@floken/feel · TCK 修复回归 · 形参/类型类错误回退为 null（对齐规范 §10.3.2.13.1）', () => {
  const v = (src: string) => evaluate(src).value;
  /** 仍会抛的错误码（如 `@"…"` 走时间构造器，不经过 call 边界转换）；没抛返回 `null` */
  const code = (src: string): string | null => {
    try {
      evaluate(src);
      return null;
    } catch (e) {
      return (e as { code?: string }).code ?? null;
    }
  };

  it('duration 构造器：null / 错类型 / 非法字面量 → null（+诊断，TCK 1120）', () => {
    // 类型不符（null / number / list）→ 静默 null（无诊断）
    for (const src of ['duration(null)', 'duration(2017)', 'duration([])']) {
      nullVal(src);
    }
    /*
     * 类型是字符串但**不是合法 ISO 8601 时长字面量** → FEEL_EVAL_TEMPORAL_VALUE
     * （走的是时间构造器的 shapeFail，与 `date("…")` 的坏写法同一个出口）。
     */
    for (const src of [
      'duration("")',
      'duration("P")',
      'duration("P0")',
      'duration("1Y")',
      'duration("1D")',
      'duration("P1H")',
      'duration("P1S")',
      'duration("2012T-12-2511:00:00Z")',
    ]) {
      nullDiag(src, 'FEEL_EVAL_TEMPORAL_VALUE');
    }
    // arity 0 → 静默 null（无诊断）
    nullVal('duration()');
    // 合法用法不受影响
    expect(v('string(duration("P1Y"))')).toBe('P1Y');
    expect(v('string(duration("P1DT2H"))')).toBe('P1DT2H');
  });

  it('years and months duration：null / 错类型 / 个数错 → null（TCK 1121，静默返回 null 无诊断）', () => {
    for (const src of [
      'years and months duration(null, null)',
      'years and months duration(date("2017-08-11"), null)',
      'years and months duration(date and time("2017-12-31T13:00:00"), null)',
      'years and months duration(null, date("2017-08-11"))',
      'years and months duration([], [])',
      'years and months duration(null)',
      'years and months duration(2017)',
      'years and months duration("2012T-12-2511:00:00Z")',
      'years and months duration()',
    ]) {
      nullVal(src);
    }
    // 合法用法不受影响（整月数，向零截断：25 个月 + 20/31 → 25 → P2Y1M）
    expect(
      v('string(years and months duration(date("2017-08-11"), date("2019-10-01")))'),
    ).toBe('P2Y1M');
  });

  it('`**` 只对 number 有定义（TCK 0075#002~#011，非 number → null + 诊断）', () => {
    for (const src of [
      '"foo" ** 4',
      'true ** 4',
      'date("2018-12-10") ** 4',
      'time("10:30:00") ** 4',
      'date and time("2018-12-10") ** 4',
      'duration("P2Y") ** 4',
      'duration("P2D") ** 4',
      '{a: 2} ** 4',
      '[2] ** 4',
      '(function() "foo") ** 4',
    ]) {
      nullDiag(src, 'FEEL_EVAL_ARG_TYPE');
    }
    // 合法用法不受影响：幂高于乘法、低于一元、左结合
    expect(v('5 + 2**5')).toBe(37);
    expect(v('1.2*10**3')).toBe(1200);
    expect(v('3 ** 4 ** 5')).toBe(3486784401);
  });

  it('调用非函数值 → null（+诊断 FEEL_EVAL_NO_FUNCTION，TCK 1131）', () => {
    for (const src of [
      'non_existing_function()',
      'null()',
      '"some_func"()',
      '"abs"(-1)',
      '@"2023-11-11"()',
      '123()',
      'true()',
      'false()',
    ]) {
      nullDiag(src, 'FEEL_EVAL_NO_FUNCTION');
    }
    // 正常的调用不受影响
    expect(v('abs(-1)')).toBe(1);
    // 裸变量**取值**仍是降级（诊断 + null）
    expect(v('nope')).toBe(null);
  });

  it('`get value` 的两个形参都有类型（TCK 0080，类型不符 → null）', () => {
    for (const src of [
      'get value("foo", "foo")',
      'get value({a: "foo"}, 123)',
      'get value(null, "a")',
      'get value({a: "foo"}, null)',
      'get value(null, null)',
    ]) {
      // `get value` 对 null / 非上下文 / 非字符串实参走静默 `return null`（无诊断）
      nullVal(src);
    }
    // 键不存在是"值存在但没这个键" → null，不是错误
    expect(v('get value({a: "foo"}, "b")')).toBe(null);
    expect(v('get value({a: "foo"}, "a")')).toBe('foo');
  });

  it('`not` 只收 boolean 与 null（TCK 0066，非布尔 → null）', () => {
    for (const src of ['not(0)', 'not(1)', 'not("true")']) {
      // `not` 对非布尔实参走静默 `return null`（无诊断）
      nullVal(src);
    }
    // `not(null)` 是真正的未知 → null（三值）
    expect(v('not(null)')).toBe(null);
    expect(v('not(true)')).toBe(false);
  });

  it('`split` / `matches` / `contains` 的 null 实参 → null（0067 / 1111 / 1110）', () => {
    for (const src of [
      'split(null, null)',
      'split("foo", null)',
      'split(null, ",")',
      'matches(null, "pattern")',
      'matches("input", null)',
      'contains(null, null)',
      'contains(null, "bar")',
      'contains("bar", null)',
    ]) {
      // 这些函数对 null 实参走静默 `return null`（无诊断）
      nullVal(src);
    }
    // 可选形参 flags 显式传 null 仍按"无标志"处理（不是错误）
    expect(v('matches("abracadabra", "bra", null)')).toBe(true);
    // 合法用法不受影响
    expect(v('contains("foobar", "oob")')).toBe(true);
    expect(v('split("a,b,c", ",")')).toEqual(['a', 'b', 'c']);
  });

  it('`@"…"` 字面量写错 → 仍抛（TCK 0093#test_001，走时间构造器不经过边界转换）', () => {
    // `@"…"` 走的是时间构造器，故是 `FEEL_EVAL_TEMPORAL_VALUE` 而非被转成 null
    expect(code('@"foo"')).toBe('FEEL_EVAL_TEMPORAL_VALUE');
    // 合法字面量不受影响
    expect(v('string(@"2020-01-01")')).toBe('2020-01-01');
    expect(v('string(@"P1Y")')).toBe('P1Y');
  });

  /*
   * 0057#009 `{a: 1}.b`、#010 `null.b`：TCK 标了 `errorResult="true"`，
   * 但**用例描述自己写着 "results in null"**，DMN 1.4 §10.3.1 也说键不存在是 null。
   * 与 1111#K2-1 同属「TCK 内部矛盾」→ **从规范**，保持 null，并钉死在这里防止误改。
   */
  it('上下文取不存在的键 → null（TCK 0057#009/#010 与规范冲突，从规范）', () => {
    expect(v('{a: 1}.b')).toBe(null);
    expect(v('null.b')).toBe(null);
  });
});
