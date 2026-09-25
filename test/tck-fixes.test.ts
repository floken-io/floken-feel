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

describe('floken-feel · TCK 修复回归 · 上下文函数族（0057/1140/1145/1146/1147）', () => {
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

  it('上下文里重复键无定义 → 抛（TCK 0057 008，DMN14-178）', () => {
    expect(err('{foo: "bar", foo: "baz"}')?.code).toBe('FEEL_EVAL_UNDEFINED');
    expect(err('context([{key:"a", value:1},{key:"a", value:2}])')?.code).toBe('FEEL_EVAL_UNDEFINED');
  });

  it('`context(entries)`：收列表也收单个条目，键/值缺一不可（TCK 1145）', () => {
    expect(obj('context([{key:"a", value:1}, {key:"b", value:2}])')).toEqual({ a: 1, b: 2 });
    expect(obj('context({key:"a", value:1})')).toEqual({ a: 1 });
    expect(obj('context(entries: {key:"a", value:1})')).toEqual({ a: 1 });
    expect(obj('context({key: "a", value: null})')).toEqual({ a: null });
    expect(obj('context({key: "", value: 1})')).toEqual({ '': 1 });
    expect(obj('context([{key:"a", value:1, ignored:"foo"}])')).toEqual({ a: 1 });
    // 缺 key / 缺 value / 类型不对 / 个数不对 → 全部抛
    for (const src of [
      'context({value:1})',
      'context({key: "a"})',
      'context({key: null, value:1})',
      'context("foo")',
      'context(null)',
      'context()',
      'context([], "foo")',
    ]) {
      expect(err(src), src).not.toBeNull();
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
    // 中间层不是上下文（`a` 是数字）/ 空路径 / 路径里有 null → 抛
    for (const src of [
      'context put({x:1, y:{a:0}}, ["y","a","b","c"], 2)',
      'context put({x:1, y:{a:0}}, [], 2)',
      'context put({x:1, y:{a:0}}, ["y", null], 2)',
      'context put({x:1, y:{a:0}}, [null, "a"], 2)',
      'context put({}, null, 1)',
      'context put({}, 1, 1)',
      'context put([], "a", 1)',
      'context put({}, "a")',
      'context put({}, "a", 1, 1)',
    ]) {
      expect(err(src), src).not.toBeNull();
    }
  });

  it('`context put` 同名重载：`keys:` 收列表、`key:` 只收字符串（TCK 1146 nested007/008）', () => {
    expect(obj('context put(context: {x:1, y:{a:0}}, keys: ["y","a"], value: 2)')).toEqual({
      x: 1,
      y: { a: 2 },
    });
    expect(obj('context put(context: {}, key: "a", value: 1)')).toEqual({ a: 1 });
    // 列表落在 `key:` 上是签名错（`key` 是 string，不是 list）
    expect(err('context put(context: {x:1, y:{a:0}}, key: ["y","a"], value: 2)')?.code).toBe(
      'FEEL_EVAL_ARG_TYPE',
    );
    expect(err('context put(context: {}, ky: "a", value: 1)')?.code).toBe('FEEL_EVAL_NAMED_ARG');
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
      expect(err(src), src).not.toBeNull();
    }
  });

  it('`get entries` 个数必须为 1、`m` 必须是上下文（TCK 0081）', () => {
    expect(v('count(get entries({a: "foo", b: "bar"}))')).toBe(2);
    expect(obj('get entries({})')).toEqual([]);
    for (const src of ['get entries()', 'get entries({a:"foo"}, {b:"bar"})', 'get entries(null)', 'get entries(123)', 'get entries([1,2,3])']) {
      expect(err(src), src).not.toBeNull();
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
      expect(err(src), src).not.toBeNull();
    }
  });
});
