/**
 * floken-feel · 求值器
 *
 * 三值逻辑：null 参与的比较/布尔运算得到 null（未知），不静默降级为 false。
 *
 * 错误契约（见 AGENTS.md §5）：
 * - **抛**：语法错、选项契约破坏、能力未加载、白名单越界、资源上限 —— 调用方无法继续。
 * - **诊断**：变量/属性/函数找不到、类型不匹配降级 —— 可继续，随 `warnings` 返回。
 */

import { parseExpression, parseUnaryTests } from './parser.js';
import { BUILTINS } from '../builtins/registry.js';
import {
  TEMPORAL_FUNCTIONS,
  TEMPORAL_PROPERTIES,
  TEMPORAL_SCALE,
  TEMPORAL_SUBTRACT,
  TEMPORAL_UNARY_MINUS,
} from './deferred.js';
import {
  argTypeError,
  FEEL_DIAGNOSTIC_CODES,
  FEEL_ERROR_CODES,
  FeelError,
  diagnostic,
  functionNotAllowed,
  limitExceeded,
  namedArgError,
  notCallableError,
  optionError,
  temporalNotLoaded,
  undefinedResultError,
  type Diagnostic,
} from './errors.js';
import { paramNamesOf, slotNames } from './function-params.js';
import {
  compareValues,
  deepEquals,
  feelTypeName,
  rangeContains,
  rangeTestMatches,
  sameTypeFamily,
  toFeelContext,
  toNumber,
  toStr,
  tripleAnd,
  tripleNot,
  tripleOr,
} from './values.js';
import {
  FeelContext,
  isContext,
  isFunction,
  isList,
  isRange,
  isTemporal,
  makeFunction,
  makeRange,
  type EvalResult,
  type EvalRuntime,
  type FeelRange,
  type NativeFn,
  type Node,
  type TypeSpec,
  type Value,
} from './types.js';

export interface EvaluateOptions {
  /** 覆盖/扩展内置函数表 */
  builtins?: Record<string, NativeFn>;
  /**
   * 注入时钟（`05-feel` §6.1）。
   * `now()` / `today()` 一旦直接读系统时间，**所有涉及时态的测试都无法稳定**；
   * 注入后含 `today()` 的表达式可以钉死日历。
   */
  clock?: () => Date;
  /**
   * S-FEEL 子集白名单（`03-engine` §7.2：**越界必须报错，不能静默求值**）。
   * 设置后，调用白名单外的**具名**函数 → 抛 `FeelNotAllowedError`。
   */
  allowedFunctions?: readonly string[];
  /** AST 节点数上限（防构造型攻击） */
  maxNodes?: number;
  /** 表达式嵌套深度上限 */
  maxDepth?: number;
  /** 协作式超时：仅在求值步之间的检查点生效（同步求值无法强杀） */
  timeoutMs?: number;
  /**
   * 模型**类型表**：`itemDefinition` 名 → 类型规格。
   * `instance of t255` / `instance of tNumberList` 这类用例只有拿到模型定义才判得了
   * （TCK 0070），故由宿主持有、求值时传入（引擎侧来自 moddle）。
   * 名字未命中且不是内置类型名 → 判定为「不匹配」（不抛，见 `instanceOfSpec`）。
   */
  types?: Record<string, TypeSpec>;
  /**
   * ★ **求值语义层错误的处置模式**（DMN 1.4 §10.3.2.13.1 的双出口）。
   *
   * - `'null'`（**默认**，规范语义）：实参不符形参域、或函数结果无定义 →
   *   结果是 `null`（unknown）**并附一条诊断**；对齐规范与 Camunda / feelin / Drools（默认）。
   * - `'throw'`：同一情形**抛出** `FeelError`（`FEEL_EVAL_ARG_*` / `FEEL_EVAL_UNDEFINED` /
   *   `FEEL_EVAL_NOT_CALLABLE` …），对齐 **TCK 的 `errorResult="true"` 口径**。
   *
   * ⚠️ 两种模式**都不变**的硬错误（照旧抛）：语法错、能力未加载
   * `FEEL_NOT_LOADED_TEMPORAL`、S-FEEL 白名单越界、资源上限 —— 这些是调用方无法继续的问题。
   *
   * ⚠️ 别把它当成"严格模式"：它**只**切换语义层错误的出口，不做类型收紧。
   *   算符表里没有的组合（`10 + "10"`）两种模式下都是 `null + 诊断` / 抛，不存在"宽容放行"。
   */
  errorMode?: 'null' | 'throw';
}

/**
 * 求值运行时。携带求值记账与宿主策略；
 * 对 `NativeFn` 的第三参（`EvalRuntime`）而言，本类型是它的超集，可直接传入。
 */
export interface FeelEvalRuntime extends EvalRuntime {
  allowed?: ReadonlySet<string>;
  /** 求值语义层错误处置：`'null'`（默认，规范）| `'throw'`（TCK 严格口径） */
  errorMode: 'null' | 'throw';
  deadline: number;
  steps: number;
  /** 模型类型表（`instance of <itemDefinition 名>` 用） */
  types?: Record<string, TypeSpec>;
}

const KNOWN_OPTIONS: ReadonlySet<string> = new Set([
  'builtins',
  'clock',
  'allowedFunctions',
  'maxNodes',
  'maxDepth',
  'timeoutMs',
  'types',
  'errorMode',
]);

function isPositiveInt(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** 选项契约：未知选项**禁止静默忽略**（AGENTS.md §5「四个禁止」之一） */
function assertOptions(options: EvaluateOptions): void {
  for (const key of Object.keys(options)) {
    if (!KNOWN_OPTIONS.has(key)) {
      throw optionError(`Unknown option '${key}'`, FEEL_ERROR_CODES.OPTION_UNKNOWN, {
        option: key,
        known: [...KNOWN_OPTIONS],
      });
    }
  }
  if (options.clock !== undefined && typeof options.clock !== 'function') {
    throw optionError("Option 'clock' must be a function returning Date", FEEL_ERROR_CODES.OPTION_INVALID, {
      option: 'clock',
      found: typeof options.clock,
    });
  }
  for (const [key, value] of [
    ['maxNodes', options.maxNodes],
    ['maxDepth', options.maxDepth],
    ['timeoutMs', options.timeoutMs],
  ] as const) {
    if (value !== undefined && !isPositiveInt(value)) {
      throw optionError(`Option '${key}' must be a positive integer`, FEEL_ERROR_CODES.OPTION_INVALID, {
        option: key,
        found: value,
      });
    }
  }
  if (options.allowedFunctions !== undefined && !Array.isArray(options.allowedFunctions)) {
    throw optionError(
      "Option 'allowedFunctions' must be an array of function names",
      FEEL_ERROR_CODES.OPTION_INVALID,
      { option: 'allowedFunctions' },
    );
  }
  if (options.errorMode !== undefined && options.errorMode !== 'null' && options.errorMode !== 'throw') {
    throw optionError("Option 'errorMode' must be either 'null' or 'throw'", FEEL_ERROR_CODES.OPTION_INVALID, {
      option: 'errorMode',
      found: options.errorMode,
    });
  }
}

// ---------- AST 度量（资源上限） ----------

/** 逐层子节点（`measure` 用；顺序不影响结果） */
function childNodes(n: Node): Node[] {
  switch (n.type) {
    case 'path':
      return [n.base];
    case 'filter':
      return [n.base, n.condition];
    case 'in':
      return [n.value, n.domain];
    case 'between':
      return [n.value, n.low, n.high];
    case 'instance':
      return [n.value];
    case 'function':
      return [n.body];
    case 'list':
      return n.items;
    case 'range':
      return [n.from, n.to];
    case 'context':
      return n.entries.map((e) => e.value);
    case 'call':
      return [n.callee, ...n.args];
    case 'unary':
      return [n.operand];
    case 'binary':
    case 'compare':
    case 'logical':
      return [n.left, n.right];
    case 'if':
      return [n.cond, n.then, n.else];
    case 'for':
      return [...n.vars.map((v) => v.expr), n.body];
    case 'quantified':
      return [...n.vars.map((v) => v.expr), n.satisfier];
    default:
      return [];
  }
}

/** 迭代式度量节点数与最大深度（不用递归，避免深表达式打爆调用栈） */
export function measureAst(root: Node): { nodes: number; depth: number } {
  let nodes = 0;
  let depth = 0;
  const stack: { node: Node; level: number }[] = [{ node: root, level: 1 }];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    nodes += 1;
    if (item.level > depth) depth = item.level;
    for (const child of childNodes(item.node)) {
      stack.push({ node: child, level: item.level + 1 });
    }
  }
  return { nodes, depth };
}

function enforceLimits(root: Node, options: EvaluateOptions): void {
  if (options.maxNodes === undefined && options.maxDepth === undefined) return;
  const { nodes, depth } = measureAst(root);
  if (options.maxNodes !== undefined && nodes > options.maxNodes) {
    throw limitExceeded(
      FEEL_ERROR_CODES.LIMIT_MAX_NODES,
      'Expression exceeds maxNodes',
      { nodes, maxNodes: options.maxNodes },
    );
  }
  if (options.maxDepth !== undefined && depth > options.maxDepth) {
    throw limitExceeded(
      FEEL_ERROR_CODES.LIMIT_MAX_DEPTH,
      'Expression exceeds maxDepth',
      { depth, maxDepth: options.maxDepth },
    );
  }
}

function buildRuntime(options: EvaluateOptions): FeelEvalRuntime {
  const rt: FeelEvalRuntime = {
    errorMode: options.errorMode === 'throw' ? 'throw' : 'null',
    deadline: options.timeoutMs === undefined ? 0 : Date.now() + options.timeoutMs,
    steps: 0,
  };
  if (options.clock) rt.clock = options.clock;
  if (options.allowedFunctions) rt.allowed = new Set(options.allowedFunctions);
  if (options.types) rt.types = options.types;
  return rt;
}

/** 协作式超时检查 */
function tick(rt: FeelEvalRuntime | undefined): void {
  if (!rt || rt.deadline === 0) return;
  rt.steps += 1;
  if (rt.steps % 128 === 0 && Date.now() > rt.deadline) {
    throw limitExceeded(FEEL_ERROR_CODES.LIMIT_TIMEOUT, 'Evaluation timed out', {
      steps: rt.steps,
    });
  }
}

function diag(
  warnings: Diagnostic[],
  code: string,
  message: string,
  node: Node,
): void {
  warnings.push(diagnostic({ code, message, start: node.start, end: node.end }));
}

/**
 * ★ **求值语义层错误的统一出口**（不经 `call` 边界的节点用这个）。
 *
 * 两类节点需要它：
 * ① **运算符**（`=` 跨类型、`between` 的 null 端点、`in <区间>` 的 null 被测试值）；
 * ② **上下文字面量的重复键**、**调用非函数值**。
 *
 * 行为与 `call` 边界完全同构，只是按 `errorMode` 分岔：
 * - `'null'`（默认）→ 记诊断 + 返回 `null`；
 * - `'throw'` → 抛出该错误（`make()` 构造）。
 *
 * 传**工厂**而不是错误对象：默认模式下构造一个永不抛出的错误对象没有意义。
 */
function semanticFail(
  runtime: FeelEvalRuntime | undefined,
  make: () => FeelError,
  warnings: Diagnostic[],
  node: Node,
  /**
   * 默认模式下使用的**诊断码**（缺省用抛出码自身）。
   * 只在「诊断码与抛出码不同名」时传 —— 目前只有「调用非函数值」：抛出
   * `FEEL_EVAL_NOT_CALLABLE`，诊断为 `FEEL_EVAL_NO_FUNCTION`（两个命名空间不重叠，见 errors.ts）。
   */
  diagCode?: string,
): null {
  if (runtime?.errorMode === 'throw') throw make();
  const e = make();
  diag(warnings, diagCode ?? e.code, e.message, node);
  return null;
}

/**
 * 调用边界转换为 `null` 的**求值语义层**错误码（对齐 DMN 1.4 §10.3.2.13.1 + Camunda/feelin）。
 *
 * 内置函数在求值期抛出的这些码，一律属于"调用结果 unknown" —— 规范把结果定为 `null`，
 * 不是 error。故在 `call` 节点统一捕获并转成 `null + 诊断`（错误信息与定位不丢）。
 *
 * 覆盖两类：
 * ① **参数/类型类**：arity / 实参类型 / 取值越界 / 命名参数 / 时间字面量非法 / 时长分量跨类；
 * ② **结果无定义** `EVAL_UNDEFINED`：`sqrt(-1)` / `log(0)` / `modulo(x,0)` / `product([])` /
 *    `stddev([1])` / `number()` 转换失败 / `context` 重复键 / `context put` 空路径或死胡同。
 *
 * ② 同样转 null 的依据：DMN 1.4 §10.3.2.13.1 + Camunda 官方语义（"if something goes wrong,
 * return null"，明确含 "A function can't be invoked successfully with the given arguments" 与
 * "An operation is not defined for the given values"）；且这类"换个输入就有救"，按 `AGENTS.md §5`
 * 本就该走诊断通道而非抛出。实证：TCK 这些用例的 `<expected>` 值本身就是 `null`，
 * 只是额外挂了 `errorResult="true"`（那部分已登记 IGNORED，见 `tooling/tck/ignored.json`）。
 *
 * **不在此集合**（照旧抛出）：语法错、能力未加载 `FEEL_NOT_LOADED_TEMPORAL`、S-FEEL 白名单越界、
 * 资源上限 —— 这些是调用方**无法继续**的硬错误（Camunda 同样抛）。
 */
const PARAM_ERROR_CODES = new Set<string>([
  FEEL_ERROR_CODES.EVAL_ARG_COUNT,
  FEEL_ERROR_CODES.EVAL_ARG_TYPE,
  FEEL_ERROR_CODES.EVAL_ARG_RANGE,
  FEEL_ERROR_CODES.EVAL_NAMED_ARG,
  FEEL_ERROR_CODES.EVAL_TEMPORAL_VALUE,
  FEEL_ERROR_CODES.EVAL_DURATION_COMPONENT,
  FEEL_ERROR_CODES.EVAL_UNDEFINED,
]);

/**
 * 算术操作数读取 —— **只收真数字，不做字符串→数字隐式转换**。
 *
 * ★ 规范算符表（DMN 1.5 §10.3.2.3）里 `+ - * / **` **不存在**「字符串 → 数字」这一档：
 *   TCK 0100 用 14 条 `error_when_*` 逐算符钉死 —— `10 + "10"`、`10 - "10"`、
 *   `10 * "10"`、`10 / "10"`、`10 ** "10"` 及其反向、以及双方都是串，**全部要求 null**。
 *   只有 `+` 有字符串的那一档，且是 `string + string` → 拼接（见 `binary` 分支）。
 *
 * ⚠️ 曾在此处按 `strictCoercion` 选项宽容转换（`"1" + 1` = 2），与 TCK 直接冲突，已废。
 *   隐式转换是 **DMN 的 typeRef 强制**（`floken-dmn` 的 `coerceTypeRef`）与
 *   **内置函数实参**的事，不是算符的事 —— 两者不可混为一谈。
 */
function num(v: Value): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 是否是 FEEL duration（days and time / years and months 两类都算） */
function isDuration(v: Value): boolean {
  return isTemporal(v) && v.kind === 'duration';
}

/**
 * `+` / `-` 的时间分支（DMN 1.4 §10.3.2.4）：`date ± duration`、`duration + date`。
 *
 * 返回 `undefined` 表示"不归时间管" —— 调用方落回数字分支（于是 `date - date`
 * 这类没有定义的算式仍按类型不匹配处理，不会静默给错值）。
 */
function shiftTemporal(op: string, l: Value, r: Value): Value | undefined {
  if (op !== '+' && op !== '-') return undefined;
  const sign: 1 | -1 = op === '+' ? 1 : -1;
  if (isTemporal(l) && isTemporal(r) && r.kind === 'duration' && l.plus) {
    return l.plus(r, sign);
  }
  // 加法可交换：`duration + date` 与 `date + duration` 同值；减法没有这一支
  if (sign === 1 && isTemporal(l) && isTemporal(r) && l.kind === 'duration' && r.plus) {
    return r.plus(l, 1);
  }
  return undefined;
}

/** 形参缺省占位：命名参数只给了一部分时，缺的位置补 `null`（null 是 FEEL 一等值） */
const NULL_NODE: Node = { type: 'lit', value: null, start: 0, end: 0 };

/**
 * 把**命名参数**按形参名表对位成位置参数（DMN 1.4 §10.3.2）。
 *
 * 三条硬规则（TCK 0050 / 1101 等组把每种错法都测了）：
 * 1. 名字必须与规范**逐字**相符 → 否则抛 `unknown`；
 * 2. 位置与命名不可**混用** → 抛 `mixed`；
 * 3. 未给到的形参补 `null` 占位，**抛不抛由函数自己决定**
 *    （`is(value1: X)` 缺 value2 → false；`round down(scale: 0)` 缺 n → 抛）。
 */
function reorderNamedArgs(
  fnName: string | null,
  names: readonly (string | null)[],
  args: Node[],
): { nodes: Node[]; used: (string | null)[] } {
  if (fnName === null) throw namedArgError('unsupported', 'expression');
  const params = paramNamesOf(fnName);
  if (!params) throw namedArgError('unsupported', fnName);

  const out: (Node | null)[] = new Array<Node | null>(params.length).fill(null);
  /*
   * 逐位记录"这一位实际用的是哪个形参名"。
   * 匿名函数 / 普通位置参数下是 `null`；别名位（`context put` 的 `key`/`keys`）
   * 靠它把"同一个位置上的两套签名"分开 —— 见 `core/types.ts` 的 `NativeFn`。
   */
  const used: (string | null)[] = new Array<string | null>(params.length).fill(null);
  for (let i = 0; i < args.length; i += 1) {
    const name = names[i] ?? null;
    const arg = args[i] as Node;
    if (name === null) throw namedArgError('mixed', fnName);
    const idx = params.findIndex((slot) => slotNames(slot).includes(name));
    if (idx < 0) {
      throw namedArgError('unknown', fnName, { name, allowed: params.flatMap(slotNames) });
    }
    if (out[idx] !== null) throw namedArgError('duplicate', fnName, { name, allowed: params.flatMap(slotNames) });
    out[idx] = arg;
    used[idx] = name;
  }
  return { nodes: out.map((a) => a ?? NULL_NODE), used };
}

/**
 * 区间的**成员判定**，两种写法分流：
 * 显式区间（`[1..10]`）按端点包含；前缀一元测试写法（`(< 5)` / `(!=5)`）按运算符判。
 * 分流点是 `FeelRange.test`（见 `core/types.ts`）。
 */
function rangeMatch(range: FeelRange, value: Value): Value {
  /*
   * 端点**显式写成 `null`**（TCK 0072 `null_001_a~d`）时：
   * - 端点为 null 且**闭** → 无效区间（闭端点是"包含某个值"，而 null 不是可比的值）→ 抛；
   * - 端点为 null 且**开** → `x > null` 无从判定 → `null`（不是 false）。
   *
   * ⚠️ 必须与前缀比较式 `(< 10)` 分开 —— 它的 `from` 同样是 null，
   * 但语义是 `x < 10`（DMN 1.4 §10.3.2.5），是**确定**的比较，不能降级成 null
   * （`10 in (< 10)` = false）。判别位就是 `FeelRange.test`。
   */
  if (range.test === undefined && (range.from === null || range.to === null)) {
    if ((range.from === null && range.fromInclusive) || (range.to === null && range.toInclusive)) {
      throw argTypeError('in', 'range', 'range with non-null endpoints', 'range with a null endpoint');
    }
    return null;
  }
  return range.test === undefined ? rangeContains(range, value) : rangeTestMatches(range, value);
}

/** 区间的四个属性（DMN 1.4 §10.3.4.3）：`.start` / `.end` / `.start included` / `.end included` */
function rangeProperty(range: FeelRange, name: string): Value {
  switch (name) {
    case 'start':
      return range.from;
    case 'end':
      return range.to;
    case 'start included':
      return range.fromInclusive;
    case 'end included':
      return range.toInclusive;
    default:
      return null;
  }
}

/** duration 的规范串是否含「天 / 时间」分量（→ `days and time duration`） */
function isDaysAndTimeDuration(iso: string): boolean {
  return /[DT]/.test(iso.replace(/^[-+]?P/, ''));
}

/**
 * FEEL **内置**类型名 → 判定（名字大小写不敏感：TCK 写 `Any`，规范本文写 `any`）。
 * 注意 `duration` 的两种细分（DMN 1.4 §10.3.4.4）必须分开判 —— TCK 0070 明确要求。
 */
const BUILTIN_TYPES: Record<string, (v: Value) => boolean> = {
  any: () => true,
  number: (v) => typeof v === 'number',
  string: (v) => typeof v === 'string',
  boolean: (v) => typeof v === 'boolean',
  list: (v) => isList(v),
  context: (v) => isContext(v),
  range: (v) => isRange(v),
  function: (v) => isFunction(v),
  date: (v) => isTemporal(v) && v.kind === 'date',
  time: (v) => isTemporal(v) && v.kind === 'time',
  'date and time': (v) => isTemporal(v) && v.kind === 'dateTime',
  datetime: (v) => isTemporal(v) && v.kind === 'dateTime',
  duration: (v) => isTemporal(v) && v.kind === 'duration',
  'years and months duration': (v) =>
    isTemporal(v) && v.kind === 'duration' && !isDaysAndTimeDuration(v.iso),
  'days and time duration': (v) =>
    isTemporal(v) && v.kind === 'duration' && isDaysAndTimeDuration(v.iso),
};

/** 三值 every：任一 false → false；否则有 null → null；全 true → true */
function everyOf(results: readonly Value[]): Value {
  if (results.some((r) => r === false)) return false;
  if (results.some((r) => r === null)) return null;
  return true;
}

/**
 * `instance of` 判定（DMN 1.4 §10.3.5）。
 *
 * 三条口径（都由 TCK 0070 定死）：
 * 1. **顶层左值为 null 时不是任何类型的实例**，连 `any` 都不是（`null instance of Any` → false）；
 * 2. 但**嵌套位置**的 null 视为与任何类型兼容（`{a: null} instance of context<a: string>` → true）——
 *    即 null 表示"此处无值"，不参与结构判定；故用 `depth` 区分顶层与嵌套；
 * 3. `context<…>` 是**结构子类型**判定：值可有多余键（`{a,b,c} instance of t_context_013`
 *    → true），但定义里的每个键都必须存在且类型相符。
 *
 * `types` 是模型类型表；名字未命中且非内置 → 判 `false`（不是抛错：表达式的真值
 * 依然确定，只是"不是该类型的实例"）。
 */
function instanceOfSpec(
  v: Value,
  spec: TypeSpec,
  types?: Record<string, TypeSpec>,
  depth = 0,
): Value {
  if (v === null) return depth > 0; // 顶层 null 不算实例；嵌套 null 视为兼容
  if (depth > 16) return false; // 类型表自引用保护

  switch (spec.kind) {
    case 'named': {
      const builtin = BUILTIN_TYPES[spec.name.toLowerCase()];
      if (builtin) return builtin(v);
      const def = types?.[spec.name];
      return def ? instanceOfSpec(v, def, types, depth + 1) : false;
    }
    case 'list': {
      if (!isList(v)) return false;
      return everyOf(v.map((x) => instanceOfSpec(x, spec.item, types, depth + 1)));
    }
    case 'context': {
      if (!isContext(v)) return false;
      for (const e of spec.entries) {
        if (!v.has(e.key)) return false; // 缺键 → 不是该结构
        const r = instanceOfSpec(v.get(e.key) ?? null, e.type, types, depth + 1);
        if (r !== true) return r;
      }
      return true; // 允许多余键
    }
    /**
     * `range<X>`：**两个端点都**得是 X（TCK 1156 decision001_a~001_i）。
     * 只判"是个区间"会让 `range("[@"P1Y"..@"P2Y"]") instance of range<date>` 也成立。
     * `range<Any>` 不查端点（`Any` 恒真，走 `everyOf` 也无害，但短路更省）。
     */
    case 'range': {
      if (!isRange(v)) return false;
      const item = spec.item;
      if (item.kind === 'named' && item.name.toLowerCase() === 'any') return true;
      return everyOf([
        instanceOfSpec(v.from, item, types, depth + 1),
        instanceOfSpec(v.to, item, types, depth + 1),
      ]);
    }
    case 'function':
      return isFunction(v);
  }
}

/** 求值 AST */
export function evaluateNode(
  node: Node,
  ctx: FeelContext,
  warnings: Diagnostic[],
  builtins: Record<string, NativeFn> = BUILTINS,
  runtime?: FeelEvalRuntime,
): Value {
  tick(runtime);

  switch (node.type) {
    case 'lit':
      return node.value;

    case 'at': {
      // `@"…"` 的类型分派住在 `./temporal`（核心不解析日期串 —— NFR-F11）。
      // 未加载则**抛**，与具名时间函数同一条规矩（AC-F7）；实现由 temporal 档以 `'@'` 为键注册。
      const at = builtins['@'];
      if (!at) throw temporalNotLoaded('@');
      return at([node.text], ctx, runtime);
    }

    case 'name': {
      if (ctx.has(node.name)) return ctx.get(node.name) ?? null;
      if (node.name === '?') return null;
      /*
       * **内置函数名本身是一个值**（TCK 0092#014 的 `bkm_014_1(abs, sqrt)`）：
       * DMN 的内置函数就在作用域里，可以当参数传、可以赋给变量，不只是"能调用的语法"。
       * 只在**变量未绑定**时兜 —— 宿主绑定的同名变量优先（可覆盖内置函数）。
       */
      const builtin = builtins[node.name];
      if (builtin) {
        return makeFunction(node.name, (args, callCtx) => builtin(args, callCtx, runtime, undefined, builtins));
      }
      diag(warnings, FEEL_DIAGNOSTIC_CODES.EVAL_NO_VARIABLE, `Variable '${node.name}' not found`, node);
      return null;
    }

    case 'path': {
      const base = evaluateNode(node.base, ctx, warnings, builtins, runtime);

      // 区间属性（DMN 1.4 §10.3.4.3）：`.start` / `.end` / `.start included` / `.end included`
      if (isRange(base)) return rangeProperty(base, node.name);

      // 时间值属性 → 委托 `./temporal`（实现不在 core，NFR-F11/F12）
      if (isTemporal(base)) {
        if (!TEMPORAL_PROPERTIES.has(node.name)) {
          diag(
            warnings,
            FEEL_DIAGNOSTIC_CODES.EVAL_NO_PROPERTY,
            `'${node.name}' is not a property of a ${base.kind} value`,
            node,
          );
          return null;
        }
        const getter = builtins[node.name];
        if (!getter) throw temporalNotLoaded(node.name);
        return getter([base], ctx, runtime);
      }

      if (isContext(base)) {
        if (!base.has(node.name)) {
          diag(
            warnings,
            FEEL_DIAGNOSTIC_CODES.EVAL_NO_PROPERTY,
            `Property '${node.name}' not found on context`,
            node,
          );
          return null;
        }
        return base.get(node.name) ?? null;
      }
      // 列表投影：list.property → 逐元素取值
      if (isList(base)) {
        return base.map((item) => (isContext(item) ? (item.get(node.name) ?? null) : null));
      }
      diag(
        warnings,
        FEEL_DIAGNOSTIC_CODES.EVAL_TYPE_MISMATCH,
        `Cannot read '${node.name}' of a non-context value`,
        node,
      );
      return null;
    }

    // FEEL 方括号：数字 → 下标（1-based，负号倒数）；列表 → 多下标；其余 → 过滤
    case 'filter': {
      const raw = evaluateNode(node.base, ctx, warnings, builtins, runtime);
      /*
       * FEEL 10.3.1.8：**非列表的基底按单元素列表处理** ——
       * `100[1]` → `100`、`"foo"[1]` → `"foo"`、`true[true]` → `[true]`、`true[false]` → `[]`。
       * 此前对非列表直接给 null + 诊断，TCK 0069 的 012~023 与 0068 的 list_006~014 全错。
       */
      const base = isList(raw) ? raw : [raw];
      // 先在原上下文试算（静默）：能算出数字/列表即为「下标」语义
      const probe = evaluateNode(node.condition, ctx, [], builtins, runtime);
      if (typeof probe === 'number') return listAt(base, probe);
      if (isList(probe)) return probe.map((x) => listAt(base, num(x)));
      // 否则按过滤：逐元素求值，元素绑定为 `item`，其属性亦可直接访问
      return base.filter(
        (el) => evaluateNode(node.condition, scopeFor(ctx, el), warnings, builtins, runtime) === true,
      );
    }

    // `x in <区间|列表|上下文|unary tests>`
    case 'in': {
      const v = evaluateNode(node.value, ctx, warnings, builtins, runtime);
      // unary tests 形态：`10 in (1, < 5, >=10)` / `10 in !=10`。
      // 各测试项用 `?` 指代被测试值，项间为 OR（三值）。
      if (node.domain.type === 'tests') {
        const qctx = ctx.with({ '?': v });
        return tripleOr(
          node.domain.tests.map((t) => evalUnaryTerm(t, qctx, warnings, builtins, runtime)),
        );
      }
      const domain = evaluateNode(node.domain, ctx, warnings, builtins, runtime);
      /*
       * 被测试值是 `null` 且域是**区间** → 比较无定义 → **null**（unknown，对齐 feelin
       * `compareIn`：nil 值/测试 → unknown → null）。列表域的 `null in [null]` 仍是普通相等判定。
       */
      if (v === null && isRange(domain)) {
        return semanticFail(
          runtime,
          () => argTypeError('in', 'value', 'a non-null value against a range', 'null'),
          warnings,
          node,
        );
      }
      // 区间：前缀写法（`(< 5)` / `(!=5)`）按运算符判，显式写法按端点包含判
      if (isRange(domain)) return rangeMatch(domain, v);
      if (isList(domain)) {
        // 列表成员判定：**元素本身是区间时按包含**（`1 in [[2..4], [1..3]]` → true），
        // 否则按相等。三值逻辑：任一项为真 → true；否则有未定 → null；全假 → false。
        const results = domain.map((x) => (isRange(x) ? rangeMatch(x, v) : deepEquals(x, v)));
        if (results.some((r) => r === true)) return true;
        if (results.some((r) => r === null)) return null;
        return false;
      }
      if (isContext(domain)) {
        /*
         * 上下文域有两种含义，靠**被测试值的类型**分：
         * - 值是字符串 → **键成员判定**（`"a" in {a: 1}` = true，floken 的扩展，见 test/f1）；
         * - 否则 → 退回归「相等」（`{a:"foo"} in {a:"foo"}` = true，TCK 0072#context_011）。
         *   理由：上下文的键**只可能是字符串**，非字符串值不可能是键，此时上下文就只是一个值。
         */
        if (typeof v !== 'string') return deepEquals(domain, v);
        const key = toStr(v);
        return key === null ? null : domain.has(key);
      }
      // 裸值（`1 in 1`、`10 in =10`）：unary test 的「相等」形态
      return deepEquals(domain, v);
    }

    // `x between low and high`
    case 'between': {
      const v = evaluateNode(node.value, ctx, warnings, builtins, runtime);
      const lo = evaluateNode(node.low, ctx, warnings, builtins, runtime);
      const hi = evaluateNode(node.high, ctx, warnings, builtins, runtime);
      /*
       * 任一端是 `null` → 比较无定义 → **null**（unknown）。
       * 规范/feelin 把"null 参与区间判定"归为 unknown（feelin `between`：`start===null || end===null` → null），
       * 不抛错。
       */
      const c1 = compareValues(v, lo);
      const c2 = compareValues(v, hi);
      if (c1 === null || c2 === null) {
        // 不可比较 / 为 null → 未知（`errorMode: 'throw'` 下抛，TCK 0071 的 3 条）
        return semanticFail(
          runtime,
          () => argTypeError('between', 'value/low/high', 'comparable non-null values', 'null or incomparable'),
          warnings,
          node,
        );
      }
      return c1 >= 0 && c2 <= 0;
    }

    // `x instance of <类型规格>`
    case 'instance':
      return instanceOfSpec(
        evaluateNode(node.value, ctx, warnings, builtins, runtime),
        node.typeSpec,
        runtime?.types,
      );

    // 函数字面量：闭包捕获**定义处**上下文，形参按位置绑定
    case 'function': {
      const { params, body } = node;
      // ★ 形参名要挂到函数值上：`list replace` 的 `match` 需按形参个数校验（见 `FeelFunction.params`）
      return makeFunction(
        'function',
        (args) => {
          const bindings: Record<string, Value> = {};
          params.forEach((p, i) => {
            bindings[p] = args[i] ?? null;
          });
          return evaluateNode(body, ctx.with(bindings), warnings, builtins, runtime);
        },
        params,
      );
    }

    case 'list':
      return node.items.map((i) => evaluateNode(i, ctx, warnings, builtins, runtime));

    case 'range':
      return makeRange(
        evaluateNode(node.from, ctx, warnings, builtins, runtime),
        evaluateNode(node.to, ctx, warnings, builtins, runtime),
        node.fromInclusive,
        node.toInclusive,
        node.test,
      );

    // unary tests 列表独立求值：`?` 由上下文提供（`in` 已在自身分支内绑定 `?`）
    case 'tests': {
      const qctx = ctx.has('?') ? ctx : ctx.with({ '?': null });
      return tripleOr(node.tests.map((t) => evalUnaryTerm(t, qctx, warnings, builtins, runtime)));
    }

    // 上下文字面量：**后一项可见前一项**（FEEL 语义，故逐项累积作用域）
    case 'context': {
      const entries = new Map<string, Value>();
      let scope = ctx;
      for (const e of node.entries) {
        /*
         * 重复键无定义（DMN14-178）：`"返回包含全部条目的新上下文"` 在键重复时
         * 根本做不到，规范与 TCK 0057 `008` 都判为错误，而不是"后者覆盖前者"。
         * 放在求值期而非语法期 —— 语法上 `{a:1, a:2}` 完全合法。
         */
        if (entries.has(e.key)) {
          /*
           * ⚠️ 上下文字面量**不经 `call` 边界**，拿不到那层"抛 → 转 null+诊断"的转换，
           * 故走 `semanticFail`（与 `context([...])` 内置函数走边界后的结果完全一致）：
           * 默认模式 `null` + 诊断 `FEEL_EVAL_UNDEFINED`；`errorMode:'throw'` 下抛同码错误。
           */
          return semanticFail(
            runtime,
            () => undefinedResultError('context', { reason: 'duplicate entry key', key: e.key }),
            warnings,
            node,
          );
        }
        const v = evaluateNode(e.value, scope, warnings, builtins, runtime);
        entries.set(e.key, v);
        scope = scope.with({ [e.key]: v });
      }
      return new FeelContext(entries);
    }

    case 'call': {
      let fn: NativeFn | null = null;
      let fnName: string | null = null;
      /** 被调者的实际类型（用于「不可调用」报错） */
      let calleeType = 'null';

      if (node.callee.type === 'name') {
        const name = node.callee.name;
        const builtin = builtins[name];
        if (builtin) {
          fn = builtin;
          fnName = name;
        } else {
          const v = ctx.get(name) ?? null;
          calleeType = feelTypeName(v);
          if (isFunction(v)) {
            fn = v.call;
            fnName = v.name || name;
          } else if (TEMPORAL_FUNCTIONS.has(name)) {
            // 能力未加载 → **抛**，不静默返回 null（AC-F7）
            throw temporalNotLoaded(name);
          }
        }
      } else if (node.callee.type === 'path') {
        const base = evaluateNode(node.callee.base, ctx, warnings, builtins, runtime);
        const v = isContext(base) ? (base.get(node.callee.name) ?? null) : null;
        calleeType = feelTypeName(v);
        if (isFunction(v)) {
          fn = v.call;
          fnName = v.name || node.callee.name;
        }
      } else {
        // 任意表达式作被调者：`(function(a, b) a + b)(1, 2)`、`f().g` 等
        const v = evaluateNode(node.callee, ctx, warnings, builtins, runtime);
        calleeType = feelTypeName(v);
        if (isFunction(v)) {
          fn = v.call;
          fnName = v.name || null;
        }
      }

      /*
       * ★ 被调者不是函数 → **诊断 + null**（对齐 DMN 1.4 §10.3.2.13.1 与 feelin v8.2.0）：
       * `non_existing_function()`（名字未绑定）、`null()`、`"some_func"()`、`"abs"(-1)`、
       * `@"2023-11-11"()`、`123()`、`true()`、`false()`。
       *
       * 规范把"调用目标不符参数域"的结果定为 `null`（unknown），不是 error；feelin 对此
       * `addWarning('NO_FUNCTION_FOUND')` 后返回 null。故**默认模式**走诊断通道，不抛。
       *
       * `errorMode: 'throw'` 下改为抛 `FEEL_EVAL_NOT_CALLABLE`（TCK 1131 的 8 条全标 errorResult）。
       */
      if (!fn) {
        return semanticFail(
          runtime,
          () =>
            notCallableError(
              node.callee.type === 'name' ? node.callee.name : null,
              calleeType,
            ),
          warnings,
          node,
          FEEL_DIAGNOSTIC_CODES.EVAL_NO_FUNCTION,
        );
      }

      /*
       * 调用边界：把**参数/类型类**错误（arity / 类型 / 取值越界 / 命名参数 / 时间字面量 /
       * 时长分量跨类）统一转成 `null + 诊断`，对齐规范 §10.3.2.13.1 + feelin。
       * 这些码由内置函数在求值期抛出，属于"调用结果 unknown"，不向外传播。
       * 其余错误（能力未加载 `FEEL_NOT_LOADED_TEMPORAL`、S-FEEL 白名单越界、语法/资源上限）
       * 是调用方无法继续的硬错误，照旧抛出。
       */
      let result: Value;
      try {
        // 命名参数 → 先按形参名表对位（DMN 1.4 §10.3.2），再逐项求值
        const reordered = node.argNames
          ? reorderNamedArgs(fnName, node.argNames, node.args)
          : null;
        const argNodes = reordered ? reordered.nodes : node.args;
        const args = argNodes.map((a) => evaluateNode(a, ctx, warnings, builtins, runtime));

        // S-FEEL 白名单：具名函数越界 → 抛（引擎策略，非 FEEL 语义；不在转换集合内）
        if (runtime?.allowed && fnName !== null && !runtime.allowed.has(fnName)) {
          throw functionNotAllowed(fnName, [...runtime.allowed]);
        }

        result = fn(args, ctx, runtime, reordered?.used, builtins);
      } catch (e) {
        if (e instanceof FeelError && PARAM_ERROR_CODES.has(e.code)) {
          // 严格口径：同一批错误码改为向外抛（对齐 TCK `errorResult="true"`）
          if (runtime?.errorMode === 'throw') throw e;
          diag(warnings, e.code, e.message, node);
          return null;
        }
        throw e;
      }
      return result;
    }

    case 'unary': {
      const v = evaluateNode(node.operand, ctx, warnings, builtins, runtime);
      /*
       * ★ **DMN 1.5 起 duration 可取负**（Clauses 10.3.2.3.7 / 10.3.2.3.8）：
       * `-duration("PT1H")` = `-PT1H`（1.4 及更早无此语义，取负是类型错误）。
       *
       * 取负要用 `Temporal.Duration.negated()`，而 core 不得 import `./temporal`
       * （包内分层 / NFR-F12），故走**延迟能力委托键** `TEMPORAL_UNARY_MINUS`：
       * 实现由 `./temporal` 注册进内置表，core 只认这个键。
       * 时间值存在却找不到实现（未加载）→ 抛 `FEEL_NOT_LOADED_TEMPORAL`（不静默 null）。
       */
      if (isTemporal(v)) {
        const impl = builtins[TEMPORAL_UNARY_MINUS];
        if (!impl) throw temporalNotLoaded(TEMPORAL_UNARY_MINUS);
        try {
          return impl([v], ctx, runtime, undefined, builtins);
        } catch (e) {
          /*
           * 与 `call` 节点**同一套**边界规则（AGENTS.md §5 / 规范 §10.3.2.13.1）：
           * 非 duration 取负是 ARG_TYPE（参数/类型类）→ 默认 `null + 诊断`、
           * `errorMode:'throw'` 下抛。若不在这里收口，`-date(...)` 会在默认模式下也抛出，
           * 与"调用结果 unknown"的规范口径不一致。
           */
          if (e instanceof FeelError && PARAM_ERROR_CODES.has(e.code)) {
            if (runtime?.errorMode === 'throw') throw e;
            diag(warnings, e.code, e.message, node);
            return null;
          }
          throw e;
        }
      }
      const n = num(v);
      if (n === null) {
        diag(
          warnings,
          FEEL_DIAGNOSTIC_CODES.EVAL_TYPE_MISMATCH,
          'Unary minus requires a number',
          node,
        );
        return null;
      }
      return -n;
    }

    case 'binary': {
      const lv = evaluateNode(node.left, ctx, warnings, builtins, runtime);
      const rv = evaluateNode(node.right, ctx, warnings, builtins, runtime);
      /*
       * 时间算术（`date ± duration`、`duration ×÷ number`，DMN 1.4 §10.3.2.4 / 1.5 §10.3.2.3.4）：
       * 只要有一侧是时间值，先交给值上的钩子 / 委托键（实现由 `./temporal` 档挂上）。
       * 钩子返回 `undefined` 表示"这不是它能管的算式" → 落回数字分支报类型不匹配。
       */
      if (isTemporal(lv) || isTemporal(rv)) {
        const shifted = shiftTemporal(node.op, lv, rv);
        if (shifted !== undefined) return shifted;
        /*
         * ★ 乘除：duration 与标量的缩放语义（`-@` 的同族委托键 `*@`）。
         *   只有**有 duration 参与**才走这条；其余（`date * 2`）落回数字分支报类型不匹配。
         *
         *   ⚠️ **`number / duration` 不在此列**（除法不可交换）：规范算符表只有
         *   `duration / duration → number` 与 `duration / number → duration` 两档，
         *   TCK 0100 的 `error_when_divide_lhs_number_by_rhs_dtDuration` /
         *   `…_ymDuration` 两条要求 null。故 `/` 要求**左侧**是 duration。
         */
        const scaling =
          node.op === '*'
            ? isDuration(lv) || isDuration(rv)
            : node.op === '/' && isDuration(lv);
        if (scaling) {
          const impl = builtins[TEMPORAL_SCALE];
          if (!impl) throw temporalNotLoaded(TEMPORAL_SCALE);
          return impl([lv, rv, node.op], ctx, runtime, undefined, builtins);
        }
        /*
         * ★ 两个**非 duration** 时间值相减（`date - date`、`time - time`、
         * `dateTime - dateTime`）→ duration，走 `-@`/`*@` 的同族委托键 `--`。
         * 必须在 `shiftTemporal` 之后：`date - duration` 那一档已由它处理掉了。
         */
        if (node.op === '-' && !(isDuration(lv) || isDuration(rv))) {
          const impl = builtins[TEMPORAL_SUBTRACT];
          if (!impl) throw temporalNotLoaded(TEMPORAL_SUBTRACT);
          const d = impl([lv, rv], ctx, runtime, undefined, builtins);
          if (d !== null) return d;
        }
      }
      /*
       * ★ **字符串加法**（DMN 1.5 §10.3.2.3.1 Addition）：`+` 是**唯一**对字符串有意义的算术算符，
       * 且只此一档 —— `string + string` → 拼接。
       *
       * ⚠️ 本分支必须在 `num()` 之前，否则 `"1" + "2"` 会被算成 3 而不是 `"12"`。
       *
       * ⚠️ **没有混合档**：`10 + "10"` 在规范算符表里不存在，TCK 0100 的
       *   `error_when_add_lhs_number_to_rhs_string` / `…_string_to_rhs_number` 两条要求 null。
       *   字符串侧**不**先转数字（那是"吞类型错误返默认值"，AGENTS.md §5.6 四禁之一），
       *   也不是反向把数字转成字符串去拼（`10 + "10"` 会变成 `"1010"`）。
       *   落到下面 `num()` 分支 → 类型不匹配 → null + 诊断（严格口径抛）。
       */
      if (node.op === '+' && typeof lv === 'string' && typeof rv === 'string') {
        return lv + rv;
      }
      const l = num(lv);
      const r = num(rv);
      /*
       * 幂 `**` 的非数字操作数 → 见上面的 `**` 分流（严格模式抛，默认 null + 诊断）。
       * `+ - * /` 与 null → 三值传播，两种模式都返回 null（TCK 期望 null，不是 error）。
       */
      if (l === null || r === null) {
        /*
         * ★ **只有幂 `**`** 在严格模式下抛：TCK 0075#002~#011 的 10 条（`"foo" ** 4`、
         * `true ** 4`、`date(...) ** 4`、`{a:2} ** 4` …）全标 `errorResult`。
         *
         * ⚠️ `+ - * /` **不能**跟着抛：它们遇到 null 是**三值传播**（`1 + null` = null，
         * TCK 期望 `null` 而非 error）。故只给 `**` 分流，其余照旧 diag + null。
         */
        if (node.op === '**') {
          return semanticFail(
            runtime,
            () =>
              argTypeError(
                '**',
                'operand',
                'number',
                l === null ? feelTypeName(lv) : feelTypeName(rv),
              ),
            warnings,
            node,
          );
        }
        diag(
          warnings,
          FEEL_DIAGNOSTIC_CODES.EVAL_TYPE_MISMATCH,
          `Operator '${node.op}' requires numbers`,
          node,
        );
        return null;
      }
      switch (node.op) {
        case '+':
          return l + r;
        case '-':
          return l - r;
        case '*':
          return l * r;
        case '/':
          return r === 0 ? null : l / r;
        case '**':
          return l ** r;
        default:
          return null;
      }
    }

    case 'compare': {
      const l = evaluateNode(node.left, ctx, warnings, builtins, runtime);
      const r = evaluateNode(node.right, ctx, warnings, builtins, runtime);
      if (node.op === '=' || node.op === '!=') {
        /*
         * `=` / `!=` 的类型前沿（TCK 0068 逐条钉死）：
         * - 任一侧为 `null` → 不抛，按「只有 null = null 成立」判（`100 = null` → false）；
         * - 两侧都是非 null 但**不同 FEEL 类型** → 类型错误（`false = 0`、`100 = "100"`、
         *   `[] = 0`、`{} = []`、`duration("P1Y") = duration("P365D")` 官方全是 errorResult）；
         * - 同类型 → 深相等。
         */
        if (l !== null && r !== null && !sameTypeFamily(l, r)) {
          /*
           * 跨类型比较：结果 unknown（`null`），不是 error（对齐 feelin：`equals` 返回 null）。
           * `errorMode: 'throw'` 下抛（TCK 0068 的 12 条全标 `errorResult`）。
           */
          return semanticFail(
            runtime,
            () =>
              argTypeError(
                node.op,
                'operands',
                'values of the same type on both sides',
                `${feelTypeName(l)} and ${feelTypeName(r)}`,
              ),
            warnings,
            node,
          );
        }
        const eq = deepEquals(l, r);
        return node.op === '=' ? eq : !eq;
      }
      const c = compareValues(l, r);
      if (c === null) return null;
      switch (node.op) {
        case '<':
          return c < 0;
        case '<=':
          return c <= 0;
        case '>':
          return c > 0;
        case '>=':
          return c >= 0;
        default:
          return null;
      }
    }

    case 'logical': {
      const l = evaluateNode(node.left, ctx, warnings, builtins, runtime);
      if (node.op === 'and') {
        if (l === false) return false;
        const r = evaluateNode(node.right, ctx, warnings, builtins, runtime);
        return tripleAnd([l, r]);
      }
      if (l === true) return true;
      const r = evaluateNode(node.right, ctx, warnings, builtins, runtime);
      return tripleOr([l, r]);
    }

    case 'if': {
      const c = evaluateNode(node.cond, ctx, warnings, builtins, runtime);
      if (c === true) return evaluateNode(node.then, ctx, warnings, builtins, runtime);
      if (c === false) return evaluateNode(node.else, ctx, warnings, builtins, runtime);
      return null;
    }

    case 'for': {
      const combos = buildCombos(node.vars, ctx, warnings, builtins, runtime);
      /*
       * `partial` = **已算出的前缀**（FEEL 的 partial results，TCK 0084#013 的
       * `for i in 0..4 return if i = 0 then 1 else i * partial[-1]` → 阶乘）。
       * 每轮取快照（`slice`），故循环内看到的永远是"之前的"，不会自我引用。
       */
      const out: Value[] = [];
      for (const combo of combos) {
        const scope = ctx.with({ ...combo, partial: out.slice() });
        out.push(evaluateNode(node.body, scope, warnings, builtins, runtime));
      }
      return out;
    }

    case 'quantified': {
      const combos = buildCombos(node.vars, ctx, warnings, builtins, runtime);
      const results = combos.map((c) =>
        evaluateNode(node.satisfier, ctx.with(c), warnings, builtins, runtime),
      );
      return node.kind === 'every' ? tripleAnd(results) : tripleOr(results);
    }

    default:
      return null;
  }
}

/** FEEL 下标：1-based，负号倒数；null / 0 / 越界 → null */
function listAt(list: Value[], n: number | null): Value {
  if (n === null || n === 0) return null;
  const i = n > 0 ? n - 1 : list.length + n;
  return list[i] ?? null;
}

/** 过滤时的元素作用域：绑定 `item`；元素为上下文时其键亦可直接访问 */
function scopeFor(ctx: FeelContext, el: Value): FeelContext {
  let scope = ctx.with({ item: el });
  if (isContext(el)) {
    const extra: Record<string, Value> = {};
    for (const k of el.keys()) extra[k] = el.get(k) ?? null;
    scope = scope.with(extra);
  }
  return scope;
}

/** 多变量迭代：笛卡尔积 */
/**
 * 把**区间**展开成迭代序列（`for i in 2..4`，TCK 0084）。
 *
 * 只有两类能展开：
 * - 数字：步长 ±1。**递减只允许在裸序列**（`Node.seq`）里 —— `[2..1]` 是区间字面量，
 *   `start > end` 属**无效区间**，官方标 `errorResult`（#025）；
 * - 日期：步长 ±1 天（#017 升序、#018 降序）。
 *
 * 其余（字符串 / `date and time` / `time` / duration）**没有自然步长** → 抛（#019~#022）。
 */
function iterItems(range: FeelRange, seq: boolean): Value[] {
  const from = range.from;
  const to = range.to;
  const bad = (expected: string, got: string): never => {
    throw argTypeError('for', 'domain', expected, got);
  };

  if (typeof from === 'number' && typeof to === 'number') {
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      bad('range of integers', `${from}..${to}`);
    }
    if (from > to && !seq) bad('range with start <= end', `${from}..${to}`);
    const step = from <= to ? 1 : -1;
    const out: Value[] = [];
    for (let n = from; step > 0 ? n <= to : n >= to; n += step) out.push(n);
    return out;
  }

  if (
    isTemporal(from) &&
    isTemporal(to) &&
    from.kind === 'date' &&
    to.kind === 'date' &&
    from.plusDays
  ) {
    const cmp = compareValues(from, to);
    if (cmp === null) throw argTypeError('for', 'domain', 'range of comparable dates', 'date..date');
    if (cmp > 0 && !seq) bad('range with start <= end', `${from.iso}..${to.iso}`);
    const step = cmp <= 0 ? 1 : -1;
    const out: Value[] = [from];
    let cur: Value = from;
    // 上界只是防御：端点固定且每次至少走一天，正常不会触发
    for (let guard = 0; guard < 1_000_000; guard += 1) {
      const next: Value = isTemporal(cur) ? (cur.plusDays?.(step) ?? null) : null;
      if (next === null) break;
      const c = compareValues(next, to);
      if (c === null || (step > 0 ? c > 0 : c < 0)) break;
      out.push(next);
      cur = next;
      if (c === 0) break;
    }
    return out;
  }

  return bad('list or range<number | date>', feelTypeName(range));
}

function buildCombos(
  vars: { name: string; expr: Node }[],
  ctx: FeelContext,
  warnings: Diagnostic[],
  builtins: Record<string, NativeFn>,
  runtime?: FeelEvalRuntime,
): Record<string, Value>[] {
  let combos: Record<string, Value>[] = [{}];
  for (const v of vars) {
    const next: Record<string, Value>[] = [];
    /*
     * 后一个迭代变量的**定义式必须能看到前一个变量**（FEEL 的 `for` 是嵌套笛卡尔积）：
     * `for x in [[1,2],[3,4]], y in x return y` → `[1,2,3,4]`（TCK 0084#015）。
     * 故在**每个已累积的绑定**下求值，而不是在原始 `ctx` 下。
     */
    for (const combo of combos) {
      const scope = ctx.with(combo);
      const listValue = evaluateNode(v.expr, scope, warnings, builtins, runtime);
      let items: readonly Value[];
      if (isList(listValue)) items = listValue;
      else if (isRange(listValue)) {
        items = iterItems(listValue, v.expr.type === 'range' && v.expr.seq === true);
      } else items = [listValue];
      for (const item of items) {
        next.push({ ...combo, [v.name]: item });
      }
    }
    combos = next;
  }
  return combos;
}

/**
 * 求值单个 unary test 项。
 * `?` 由 context 提供；区间→包含判定；`not(...)`→取反；其余→与输入相等性/布尔判定。
 */
export function evalUnaryTerm(
  term: Node,
  ctx: FeelContext,
  warnings: Diagnostic[],
  builtins: Record<string, NativeFn> = BUILTINS,
  runtime?: FeelEvalRuntime,
): Value {
  // 区间 → 包含判定（前缀写法按运算符判，见 `rangeMatch`）
  if (term.type === 'range') {
    const range = evaluateNode(term, ctx, warnings, builtins, runtime);
    if (!isRange(range)) return null;
    return rangeMatch(range, ctx.get('?') ?? null);
  }

  // not(...) → 对各项取反
  if (term.type === 'call' && term.callee.type === 'name' && term.callee.name === 'not') {
    const results = term.args.map((a) => evalUnaryTerm(a, ctx, warnings, builtins, runtime));
    return tripleNot(tripleOr(results));
  }

  // 列表 → 输入是否等于其中某项
  if (term.type === 'list') {
    const list = evaluateNode(term, ctx, warnings, builtins, runtime);
    if (!isList(list)) return null;
    const input = ctx.get('?') ?? null;
    return list.some((x) => deepEquals(x, input));
  }

  const v = evaluateNode(term, ctx, warnings, builtins, runtime);
  if (v === true) return true;
  if (v === false) return false;
  // 非布尔结果 → 视为与输入的相等性测试
  return deepEquals(ctx.get('?') ?? null, v);
}

/**
 * 求值 FEEL 表达式。返回形态对标 feelin：`{ value, warnings }`。
 * 语法错误会抛出 `FeelSyntaxError`（快速失败）；运行期问题只产生诊断。
 */
export function evaluate(
  src: string,
  context?: unknown,
  options: EvaluateOptions = {},
): EvalResult {
  assertOptions(options);
  const warnings: Diagnostic[] = [];
  const node = parseExpression(src);
  enforceLimits(node, options);
  const runtime = buildRuntime(options);
  const ctx = toFeelContext(context);
  const value = evaluateNode(node, ctx, warnings, options.builtins ?? BUILTINS, runtime);
  return { value, warnings };
}

/**
 * ★ **严格口径求值**（`errorMode: 'throw'`）。
 *
 * 与 `evaluate` **同一套语义**，只差求值语义层错误的出口：
 * 实参不符形参域、函数结果无定义、调用非函数值 → **抛** `FeelError`，而不是返回 `null` + 诊断。
 *
 * 用途：
 * - 对齐 **DMN TCK 的 `errorResult="true"` 口径**（跑分器用它跑"严格口径"）；
 * - 宿主想在决策表里**把类型错误当故障**而不是"未知"（默认 `evaluate` 是静默 `null`）。
 *
 * ⚠️ 两种模式下**都一样抛**的硬错误：语法错、能力未加载、S-FEEL 白名单越界、资源上限。
 *
 * @example
 * evaluate('abs(null)')        // → { value: null, warnings: [FEEL_EVAL_ARG_TYPE] }
 * evaluateStrict('abs(null)')  // → throw FeelTypeError  code: FEEL_EVAL_ARG_TYPE
 */
export function evaluateStrict(
  src: string,
  context?: unknown,
  options: EvaluateOptions = {},
): EvalResult {
  return evaluate(src, context, { ...options, errorMode: 'throw' });
}

/**
 * 求值 unary tests（决策表输入项）。
 * context 中以 `?` 表示被测输入值；多个测试项用逗号分隔，语义为 OR。
 */
export function unaryTest(
  src: string,
  context?: unknown,
  options: EvaluateOptions = {},
): EvalResult {
  assertOptions(options);
  const warnings: Diagnostic[] = [];
  const terms = parseUnaryTests(src);
  for (const term of terms) enforceLimits(term, options);
  const runtime = buildRuntime(options);
  const ctx = toFeelContext(context);
  const results = terms.map((t) =>
    evalUnaryTerm(t, ctx, warnings, options.builtins ?? BUILTINS, runtime),
  );
  return { value: tripleOr(results), warnings };
}
