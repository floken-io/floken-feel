/**
 * @floken-io/feel · 核心类型
 *
 * 设计要点：
 * 1. 公开 API 形态对标 feelin（{ value, warnings }），但实现完全自研（Q9：feelin 源码只读不拷）。
 * 2. 核心（`.` / `./unary-tests`）**不静态引用时间实现源**（NFR-F12；
 *    具体是哪个包属 `src/temporal/` 的域知识，core 不点名，`check:deps` 用文本守这条线）。
 *    时间值以结构化 FeelTemporal 存在，核心只按 `iso` 比较，不感知其底层实现。
 */

/** FEEL 运行时值。null 是 FEEL 的一等值，参与三值逻辑。 */
export type Value =
  | null
  | boolean
  | number
  | string
  | Value[]
  | FeelContext
  | FeelTemporal
  | FeelFunction
  | FeelRange;

/** 区间（range）值，如 `[1..5]` / `]1..5[` */
export interface FeelRange {
  readonly __feelRange: true;
  readonly from: Value;
  readonly to: Value;
  readonly fromInclusive: boolean;
  readonly toInclusive: boolean;
  /**
   * **前缀写法判别位**（可选）：`(< 10)` / `(<= 10)` / `(> 10)` / `(>= 10)` / `(=10)` / `(!=10)`
   * 记下当时的运算符；显式区间写法（`(null..10)`、`[10..10]`）留空。
   *
   * 为什么需要它：这两种写法**端点完全相同**，但 DMN TCK 0068 明确要求它们**不相等** ——
   * `(< 10) = (null..10)` → `false`，而 `(< 10) = (< 10)` → `true`。
   * 同时 0074 又要求 `(<10).start` = `null`、`(<10).end` = `10`、
   * `(=10).start included` = `true` —— 即**属性层面二者一致**。
   * 故保留同一表示、只加一个判别位：属性与 `in` 判定照旧，`=` 时要求判别位也相同。
   * `!=` 是补集、无区间等价端点，仅借用本字段承载写法（`in` 时按"不等"判，见 `rangeTestMatches`）。
   */
  readonly test?: string;
}

/**
 * 函数值：宿主（或调用方）传入的 JS 函数被包装成它，
 * 以便与 feelin 一样支持在 context 里放函数（如 `rates()`）。
 */
export interface FeelFunction {
  readonly __feelFunction: true;
  readonly name: string;
  readonly call: (args: Value[], ctx: FeelContext) => Value;
  /**
   * 函数字面量声明的**形参名**（`function(item, newItem) …` → `['item','newItem']`）。
   *
   * 只由**字面量**带；内置函数值（`abs` 当值传）与宿主注入的函数没有 —— 故它是
   * 「已知才校验，未知放行」的可选信息，不是契约强制。
   * 用途：`list replace(list, match, newItem)` 必须拒掉形参个数不是 2 的 `match`
   * （TCK 1155 decision017/018：3 参 / 1 参都要求 null）。
   */
  readonly params?: readonly string[];
}

/**
 * 造一个 FEEL **函数值**。
 *
 * ★ 参数化的函数值（`function(a, b) …`）必须把形参名一并挂上 —— 见 `FeelFunction.params`。
 */
export function makeFunction(
  name: string,
  call: (args: Value[], ctx: FeelContext) => Value,
  params?: readonly string[],
): FeelFunction {
  const base: FeelFunction = { __feelFunction: true, name, call };
  return params === undefined ? base : { ...base, params };
}

/**
 * 时间值。核心按 `iso` 做比较/排序，`raw` 对核心不透明（由 ./temporal 子路径填充）。
 */
export interface FeelTemporal {
  readonly __feelTemporal: true;
  readonly kind: 'date' | 'time' | 'dateTime' | 'duration';
  /** 可直比较的规范串 */
  readonly iso: string;
  /** 底层 Temporal.* 对象（核心永不解构它） */
  readonly raw: unknown;
  /**
   * 构造时的**原始输入串**（可选）。只有 `./temporal` 档会读它：
   * `Temporal.PlainTime` / `PlainDateTime` 会**丢弃** UTC offset 与时区，
   * 而 FEEL 的 `.time offset` / `.timezone` 属性必须能读回来。
   * 核心只透传、不解析（NFR-F11），故对比较与相等判定无影响。
   */
  readonly src?: string;
  /**
   * **相等判定键**（可选，由 `./temporal` 档生成）—— 口径是 `=`（TCK 0068）。
   *
   * 为什么不直接比较 `iso`：FEEL 的 `=` 对时间有两处更细的口径 ——
   * ① 只到**秒**：`time("10:30:00.0001") = time("10:30:00.0002")` 为 true；
   * ② 日期时间带偏移/时区时按**瞬时**比：`…+02:00` ≡ `…@Europe/Paris`（10 月）、
   *    `@Australia/Melbourne` ≡ `@Australia/Sydney`（同一偏移）。
   * 这些都无法用"可直接排序的 `iso`"表达，故另开一键。
   * 两侧都有 `eqKey` 时以它为准，否则退回 `kind + iso`。
   */
  readonly eqKey?: string;
  /**
   * **写法同一键**（可选，由 `./temporal` 档生成）—— 口径是 `is()`（TCK 0103）。
   *
   * 与 `eqKey` 的差别是本包最反直觉的一处，TCK 用**同一对值**钉死：
   * `@"2002-04-02T12:00:00-01:00"` 与 `@"2002-04-02T17:00:00+04:00"` 是同一瞬时 →
   * `=` 为 **true**（0068 datetime_012）而 `is` 为 **false**（0103 datetime_004）。
   * 即 `=` 比"时刻"，`is()` 比"写法"（本地字段 + 偏移/时区都得一致，零偏移的 `Z`/`+00:00` 归一）。
   */
  readonly identity?: string;
  /**
   * **FEEL 类型名**（可选，由 `./temporal` 档生成），比 `kind` 更细。
   *
   * `kind` 只有四档，装不下 FEEL 的两个 duration 类型（DMN 1.4 §10.3.1）：
   * `years and months duration` 与 `days and time duration` 是**两个不同类型**，
   * 它们互相比较/相等都是类型错误（TCK 0068：`duration("P1Y") = duration("P365D")` → Err）。
   * 非 duration 时等于 `kind`（`date` / `time` / `date and time`）。
   */
  readonly category?: string;
  /**
   * 同 `category` 内可比较时的**数值量**（可选，由 `./temporal` 档生成）。
   *
   * 只有 duration 需要：`years and months duration` 记**月数**、`days and time duration` 记**秒数**。
   * 没有它，`duration("P1Y") in <= duration("P2Y")` 这类断言无从排序（TCK 0072/0071 共 70+ 条）。
   * `kind` 为 date/time/dateTime 时留空 —— 那些按 `iso` 排序即可。
   */
  readonly order?: number;
  /**
   * **时间算术钩子**（可选，由 `./temporal` 档生成）—— `date ± duration` 一类
   * （DMN 1.4 §10.3.2.4）。核心不认识 Temporal，只在二元运算里发现有一侧是时间值
   * 时调它，`sign` 为 `1`（加）或 `-1`（减）；无从计算时返回 `null`。
   */
  readonly plus?: (duration: FeelTemporal, sign: 1 | -1) => Value;
  /**
   * **按天步进钩子**（可选，由 `./temporal` 档生成）—— 迭代序列 `for i in @d1..@d2` 用
   * （TCK 0084#017/#018）。只有 `date` 有：日期有自然的"下一天"，
   * 而 `date and time` / `time` / `duration` **没有**自然步长，故 TCK 判它们为错误。
   */
  readonly plusDays?: (days: number) => Value;
}

/** FEEL context：键值集合，键可含空格（如 "Mike's daughter"）。 */
export class FeelContext {
  readonly __feelContext = true as const;

  constructor(public readonly entries: ReadonlyMap<string, Value> = new Map()) {}

  get(key: string): Value | undefined {
    return this.entries.get(key);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  keys(): string[] {
    return Array.from(this.entries.keys());
  }

  /** 以某组临时绑定派生一个新 context（用于 for / every / some 的作用域） */
  with(bindings: Readonly<Record<string, Value>>): FeelContext {
    const next = new Map(this.entries);
    for (const [k, v] of Object.entries(bindings)) next.set(k, v);
    return new FeelContext(next);
  }

  toObject(): Record<string, Value> {
    const out: Record<string, Value> = {};
    for (const [k, v] of this.entries) out[k] = v;
    return out;
  }
}

import type { Diagnostic } from './errors.js';

/**
 * evaluate / unaryTest 的返回形态，对标 feelin 的外壳（`{ value, warnings }`）。
 * 元素形状以 `Diagnostic` 为准（= `05-feel` §6 + `severity`），比 feelin 更丰富。
 */
export interface EvalResult {
  value: Value;
  warnings: Diagnostic[];
}

/**
 * 求值运行时（随 `NativeFn` 第三参传入）。
 * 时间函数靠它拿到宿主注入的 `clock`（`05-feel` §6.1：不注入时钟则涉及时态的测试无法稳定）。
 */
export interface EvalRuntime {
  clock?: () => Date;
}

/**
 * 内置函数实现签名。
 *
 * - 第三参为可选运行时，保持既有实现可只写 `(args, ctx)`。
 * - 第四参 `argNames`：**命名参数调用**时逐位给出实参来自哪个形参名（位置调用 → `undefined`）。
 *   只有"同名重载"才需要它 —— 目前唯一用户是 `context put`：规范给了两套签名
 *   `context put(context, key, value)`（`key` 是字符串）与
 *   `context put(context, keys, value)`（`keys` 是字符串列表），
 *   对位后两者形状一模一样，只有靠形参名才分得清（TCK 1146 nested007/nested008）。
 * - 第五参 `builtins`：**当次求值所用的内置函数表**（求值器逐层透传）。
 *   只有"一个内置函数要调另一个内置函数"才需要它 —— 目前唯一用户是 `range`：
 *   区间字面量的**时间端点**（`@"1970-01-01"` / `date("…")`）只有 `./temporal` 造得出来，
 *   而 `builtins/` 不得 import 域（包内分层 / NFR-F12），只能由求值器把表递进去。
 *   缺省不传时该能力不可用（实现须**抛**而非静默 null，见 AGENTS.md §5 四禁）。
 */
export type NativeFn = (
  args: Value[],
  ctx: FeelContext,
  runtime?: EvalRuntime,
  argNames?: readonly (string | null)[],
  builtins?: Record<string, NativeFn>,
) => Value;

// ---------- 类型守卫 ----------

export function isList(v: Value): v is Value[] {
  return Array.isArray(v);
}

export function isContext(v: Value): v is FeelContext {
  return v instanceof FeelContext;
}

export function isTemporal(v: Value): v is FeelTemporal {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    (v as { __feelTemporal?: unknown }).__feelTemporal === true
  );
}

export function isFunction(v: Value): v is FeelFunction {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    (v as { __feelFunction?: unknown }).__feelFunction === true
  );
}

export function isRange(v: Value): v is FeelRange {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    (v as { __feelRange?: unknown }).__feelRange === true
  );
}

export function makeRange(
  from: Value,
  to: Value,
  fromInclusive: boolean,
  toInclusive: boolean,
  test?: string,
): FeelRange {
  const base: FeelRange = { __feelRange: true, from, to, fromInclusive, toInclusive };
  return test === undefined ? base : { ...base, test };
}

/** 判定是否为「标量」（可直接参与数值/字符串运算） */
export function isScalar(v: Value): v is boolean | number | string {
  return typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string';
}

/**
 * 把宿主传入的 JS 函数包装成 FeelFunction 值。
 *
 * ★ `params` 是**形参名表**，命名调用（`f(a: 1)`）靠它对位。宿主函数本来没有形参名，
 *   但决策服务 / BKM 有 —— `decisionService_012(decision_012_3: "C", …)` 这类调用
 *   不知形参名就只能判「不支持命名参数」而返回 null（TCK 0085#009/#012）。
 */
export function toFeelFunction(
  name: string,
  fn: (...args: Value[]) => Value,
  params?: readonly string[],
): FeelFunction {
  const base: FeelFunction = { __feelFunction: true, name, call: (args) => fn(...args) };
  return params === undefined ? base : { ...base, params };
}

/** 直接以 (args, ctx) 形态构造 FEEL 函数值（供函数字面量/闭包使用） */

// ---------- AST ----------

export type CompareOp = '=' | '!=' | '<' | '<=' | '>' | '>=';
export type ArithOp = '+' | '-' | '*' | '/' | '**';

/**
 * `instance of` 右侧的**类型规格**（DMN 1.4 §10.3.5）。
 *
 * 与「一个字符串」的区别在于泛型：`list<Any>` / `context<a: string>` 必须能被
 * **结构化**判定，否则 `[1,"2"] instance of list<number>` 就无从下手。
 * 类型名大小写不敏感（TCK 写 `Any`，规范本文写 `any`）。
 */
export type TypeSpec =
  | { kind: 'named'; name: string; start: number; end: number }
  | { kind: 'list'; item: TypeSpec; start: number; end: number }
  | { kind: 'context'; entries: { key: string; type: TypeSpec }[]; start: number; end: number }
  | { kind: 'range'; item: TypeSpec; start: number; end: number }
  | { kind: 'function'; result: TypeSpec | null; start: number; end: number };

export type Node =
  | { type: 'lit'; value: Value; start: number; end: number }
  /**
   * 日期时间字面量 `@"2020-01-01"`（FEEL 10.3.2.3）。
   * `text` 是引号内**原文**，类型（date / time / date-time / duration）由 `./temporal` 档分派 ——
   * 核心不解析日期串（NFR-F11：不自研日期库）。
   */
  | { type: 'at'; text: string; start: number; end: number }
  | { type: 'name'; name: string; start: number; end: number }
  | { type: 'path'; base: Node; name: string; start: number; end: number }
  /**
   * `base[condition]`：FEEL 把「下标」与「过滤」统一在一个方括号里 ——
   * condition 求值成数字即下标（1-based），成布尔即过滤，成列表即按多下标取。
   * 运行时才能定夺，故共用本节点。
   */
  | { type: 'filter'; base: Node; condition: Node; start: number; end: number }
  /** `value in domain`：domain 为区间 → 包含判定；为列表 → 成员判定；为 `tests` → unary tests（OR） */
  | { type: 'in'; value: Node; domain: Node; start: number; end: number }
  /**
   * unary tests 列表（FEEL 10.3.2.4）：`(` 内逗号分隔的若干测试项，**项间为 OR**。
   * 出现在 `in` 右侧（`10 in (1, < 5, >=10)`）；每项用 `?` 指代被测试值，
   * 由 `in` 求值时把 `?` 绑定到左侧的值上（见 evaluator 的 `evalUnaryTerm`）。
   */
  | { type: 'tests'; tests: Node[]; start: number; end: number }
  /** `value instance of <类型规格>`：规格可含泛型（`list<Any>` / `context<a: string>`） */
  | { type: 'instance'; value: Node; typeSpec: TypeSpec; start: number; end: number }
  /** `value between low and high`（等价 `value >= low and value <= high`） */
  | { type: 'between'; value: Node; low: Node; high: Node; start: number; end: number }
  /** 函数字面量 `function(a, b) body`，闭包捕获定义处上下文 */
  | {
      type: 'function';
      params: string[];
      /**
       * ★ 形参**类型标注**（`function(arg: number) arg`，DMN 1.5 §10.3.14）。
       * 未标注的形参是 `null`。**必须保留**：标注在**调用时**用来校验实参 ——
       * TCK 0082 `fd_002` 就是这样一条（见 `evaluator` 的 `function` 分支）。
       */
      paramTypes?: (TypeSpec | null)[];
      body: Node;
      start: number;
      end: number;
    }
  | { type: 'list'; items: Node[]; start: number; end: number }
  | {
      type: 'range';
      from: Node;
      to: Node;
      fromInclusive: boolean;
      toInclusive: boolean;
      /** 前缀写法（`(< 10)` 等）时的运算符；显式区间写法缺省。见 `FeelRange.test` */
      test?: string;
      /**
       * 迭代子句里的**裸序列** `for i in 2..4`（`seq: true`）—— 它与区间字面量
       * `[2..4]` 的区别只有一处：序列允许**递减**（`4..2` → `[4,3,2]`），
       * 而区间要求 `start <= end`，否则是**无效区间**（TCK 0084#025 的 `[2..1]` → 错误）。
       */
      seq?: boolean;
      start: number;
      end: number;
    }
  | { type: 'context'; entries: { key: string; value: Node }[]; start: number; end: number }
  /**
   * 函数调用。`argNames` 与 `args` 等长，元素为 `null` 表示该实参是**位置**参数；
   * 只要有一个非 null，整次调用就按**命名参数**处理（DMN 1.4 §10.3.2 不允许混用）。
   * 无命名参数时该字段整体缺省，保持既有 AST 形状不变。
   */
  | {
      type: 'call';
      callee: Node;
      args: Node[];
      argNames?: readonly (string | null)[];
      start: number;
      end: number;
    }
  | { type: 'unary'; op: '-'; operand: Node; start: number; end: number }
  | { type: 'binary'; op: ArithOp; left: Node; right: Node; start: number; end: number }
  | { type: 'compare'; op: CompareOp; left: Node; right: Node; start: number; end: number }
  | { type: 'logical'; op: 'and' | 'or'; left: Node; right: Node; start: number; end: number }
  | {
      type: 'if';
      cond: Node;
      then: Node;
      else: Node;
      start: number;
      end: number;
    }
  | {
      type: 'for';
      vars: { name: string; expr: Node }[];
      body: Node;
      start: number;
      end: number;
    }
  | {
      type: 'quantified';
      kind: 'every' | 'some';
      vars: { name: string; expr: Node }[];
      satisfier: Node;
      start: number;
      end: number;
    };
