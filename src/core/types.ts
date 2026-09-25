/**
 * floken-feel · 核心类型
 *
 * 设计要点：
 * 1. 公开 API 形态对标 feelin（{ value, warnings }），但实现完全自研（Q9：feelin 源码只读不拷）。
 * 2. 核心（`.` / `./unary-tests`）**不静态 import temporal-polyfill**（NFR-F12）。
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
}

/**
 * 函数值：宿主（或调用方）传入的 JS 函数被包装成它，
 * 以便与 feelin 一样支持在 context 里放函数（如 `rates()`）。
 */
export interface FeelFunction {
  readonly __feelFunction: true;
  readonly name: string;
  readonly call: (args: Value[], ctx: FeelContext) => Value;
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
   * **相等判定键**（可选，由 `./temporal` 档生成）。
   *
   * 为什么不直接比较 `iso`：DMN 的 `is()` 对时间有更细的口径（TCK 0103）——
   * `23:00:50Z` 与 `23:00:50+00:00` 相等（同一零偏移的两种写法），
   * 但 `23:00:50` 与 `23:00:50Z` **不等**（一个无偏移）；`P1D` 与 `PT24H` 相等……
   * 这些都无法用"可直接排序的 `iso`"表达，故另开一键。
   * 两侧都有 `eqKey` 时以它为准，否则退回 `kind + iso`。
   */
  readonly eqKey?: string;
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

/** 内置函数实现签名。第三参为可选运行时，保持既有实现可只写 `(args, ctx)`。 */
export type NativeFn = (args: Value[], ctx: FeelContext, runtime?: EvalRuntime) => Value;

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
): FeelRange {
  return { __feelRange: true, from, to, fromInclusive, toInclusive };
}

/** 判定是否为「标量」（可直接参与数值/字符串运算） */
export function isScalar(v: Value): v is boolean | number | string {
  return typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string';
}

/** 把宿主传入的 JS 函数包装成 FeelFunction 值 */
export function toFeelFunction(
  name: string,
  fn: (...args: Value[]) => Value,
): FeelFunction {
  return { __feelFunction: true, name, call: (args) => fn(...args) };
}

/** 直接以 (args, ctx) 形态构造 FEEL 函数值（供函数字面量/闭包使用） */
export function makeFunction(
  name: string,
  call: (args: Value[], ctx: FeelContext) => Value,
): FeelFunction {
  return { __feelFunction: true, name, call };
}

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
  | { type: 'function'; params: string[]; body: Node; start: number; end: number }
  | { type: 'list'; items: Node[]; start: number; end: number }
  | {
      type: 'range';
      from: Node;
      to: Node;
      fromInclusive: boolean;
      toInclusive: boolean;
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
