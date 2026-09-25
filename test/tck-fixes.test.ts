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

describe('floken-feel · TCK 修复回归 · 词法与字面量', () => {
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

describe('floken-feel · TCK 修复回归 · 区间（Range 一等公民）', () => {
  it('开闭括号四种写法，含 `)` 收尾（TCK 0068/0072）', () => {
    const r1 = evaluate('[1..10)').value;
    const r2 = evaluate('[1..10[').value;
    expect(isRange(r1) && isRange(r2)).toBe(true);
    expect(r1).toMatchObject({ fromInclusive: true, toInclusive: false });
    expect(r2).toMatchObject({ fromInclusive: true, toInclusive: false });
    expect(evaluate('[1..10) = [1..10[').value).toBe(true);
  });

  it('无界区间：端点为 null 按「无界」处理，不再返回 null（TCK 0072 大项）', () => {
    expect(evaluate('1 in <= 10').value).toBe(true);
    expect(evaluate('10 in <= 10').value).toBe(true);
    expect(evaluate('11 in <= 10').value).toBe(false);
    expect(evaluate('10 in < 10').value).toBe(false);
    expect(evaluate('11 in >= 10').value).toBe(true);
    expect(evaluate('10 in > 10').value).toBe(false);
    expect(evaluate('10 in (1..null]').value).toBe(true);
    expect(evaluate('5 in [10..null)').value).toBe(false);
  });

  it('比较符写法与区间写法等价（FEEL 10.3.2.5）', () => {
    expect(evaluate('(<= 10) = (null..10]').value).toBe(true);
    expect(evaluate('(< 10) = (null..10)').value).toBe(true);
    expect(evaluate('(>= 10) = [10..null)').value).toBe(true);
    expect(evaluate('(=10) = [10..10]').value).toBe(true);
  });

  it('`in` 右侧裸值按相等判定；列表元素是区间按包含（TCK 0072）', () => {
    expect(evaluate('1 in 1').value).toBe(true);
    expect(evaluate('1 in 5').value).toBe(false);
    expect(evaluate('10 in =10').value).toBe(true);
    expect(evaluate('1 in [[2..4], [1..3]]').value).toBe(true);
    expect(evaluate('9 in [[2..4], [1..3]]').value).toBe(false);
  });

  it('三值逻辑：输入为 null → null；类型不可比 → null', () => {
    expect(evaluate('null in [1..10]').value).toBe(null);
    expect(evaluate('"a" in <= 10').value).toBe(null);
  });
});

describe('floken-feel · TCK 修复回归 · 形参有类型（0050/0056/1101/1102/1141~1144）', () => {
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

  it('`scale` 合法范围为 [-6111, 6176]，越界抛 EVAL_ARG_RANGE', () => {
    expect(evaluate('round up(5.5, 6176)').value).toBe(5.5);
    const err = catchErr('round up(5.5, (-6111 - 1))');
    expect(err?.code).toBe('FEEL_EVAL_ARG_RANGE');
    expect(err?.details).toMatchObject({ param: 'scale', min: -6111, max: 6176 });
  });

  it('`null` / 字符串 / 布尔 都不是 number → 抛 EVAL_ARG_TYPE（不是返回 null）', () => {
    for (const src of ['floor(null, 1)', 'abs("-1")', 'abs(null)', 'sqrt("4")', 'abs(true)']) {
      expect(catchErr(src)?.code, src).toBe('FEEL_EVAL_ARG_TYPE');
    }
  });

  it('少给 / 多给参数抛 EVAL_ARG_COUNT，且 details 给出区间', () => {
    expect(catchErr('abs()')?.code).toBe('FEEL_EVAL_ARG_COUNT');
    expect(catchErr('abs(1, 1)')?.details?.expected).toEqual([1]);
    expect(catchErr('floor()')?.code).toBe('FEEL_EVAL_ARG_COUNT');
    const tooMany = catchErr('floor(1.5, 1, 2)');
    expect(tooMany?.code).toBe('FEEL_EVAL_ARG_COUNT');
    expect(tooMany?.details?.expected).toEqual([1, 2]);
  });

  it('modulo 不等于 JS `%`：商向下取整（TCK 0056）', () => {
    expect(evaluate('modulo(10, 4)').value).toBe(2);
    expect(evaluate('modulo(-12, 5)').value).toBe(3);
    expect(evaluate('modulo(12, -5)').value).toBe(-3);
    expect(evaluate('modulo(-12, -5)').value).toBe(-2);
    expect(evaluate('modulo(-10.1, 4.5)').value).toBeCloseTo(3.4, 10);
  });

  it('内置函数结果无定义 → 抛 EVAL_UNDEFINED；运算符除零才走 null', () => {
    expect(catchErr('modulo(10, 0)')?.code).toBe('FEEL_EVAL_UNDEFINED');
    expect(catchErr('sqrt(-1)')?.code).toBe('FEEL_EVAL_UNDEFINED');
    expect(catchErr('log(0)')?.code).toBe('FEEL_EVAL_UNDEFINED');
    expect(evaluate('(10+20)/0').value).toBe(null);
  });

  it('abs 对 duration 有定义、对 date/time 抛类型错（TCK 0050）', () => {
    expect(evaluate('abs(duration("-P1D"))').value).toMatchObject({ kind: 'duration' });
    expect(evaluate('abs(duration("-P1D")) = duration("P1D")').value).toBe(true);
    expect(evaluate('abs(duration("-P1Y")) = duration("P1Y")').value).toBe(true);
    expect(catchErr('abs(time("00:00:00"))')?.code).toBe('FEEL_EVAL_ARG_TYPE');
    expect(catchErr('abs(date("2018-12-06"))')?.code).toBe('FEEL_EVAL_ARG_TYPE');
  });
});

/**
 * 时间构造器的**重载与写法校验**，以及 `string()` 的规范文本。
 *
 * 这一批对应 `1115-feel-date-function` / `1116-feel-time-function` /
 * `1117-feel-date-and-time-function` / `0079-feel-string-function` 四组的集中失分
 * （合计约 109 条），语义全部由 TCK 逐条反推、再钉在这里防退化。
 */
describe('floken-feel · TCK 修复回归 · 时间构造器重载与写法（1115/1116/1117）', () => {
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
      expect(catchErr(bad)?.code, bad).toBe('FEEL_EVAL_TEMPORAL_VALUE');
    }
  });

  it('写法非法一律抛 EVAL_TEMPORAL_VALUE（不是给 null）', () => {
    const bad = [
      'date("2017-13-10")', // 月越界
      'date("2012/12/25")', // 分隔符
      'date(2017, 13, 31)',
      'date(2017, -8, 2)',
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
      expect(catchErr(src)?.code, src).toBe('FEEL_EVAL_TEMPORAL_VALUE');
    }
  });

  it('超出实现源可表示范围的年份 → null（known-gap，不是错误）', () => {
    // `999999999` 是合法 FEEL 写法，但 Temporal 只到 ±275760
    expect(evaluate('date("999999999-12-31")').value).toBe(null);
    expect(evaluate('date(999999999, 12, 31)').value).toBe(null);
  });
});

describe('floken-feel · TCK 修复回归 · string() 规范文本（0079）', () => {
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

  it('实参个数必须恰好 1（少给/多给抛 EVAL_ARG_COUNT）', () => {
    expect(catchErr('string()')?.code).toBe('FEEL_EVAL_ARG_COUNT');
    expect(catchErr('string("foo", "bar")')?.code).toBe('FEEL_EVAL_ARG_COUNT');
    expect(s('string(from:"foo")')).toBe('foo');
  });
});
