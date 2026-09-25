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
import { TEMPORAL_FUNCTIONS } from './deferred.js';
import {
  FEEL_DIAGNOSTIC_CODES,
  FEEL_ERROR_CODES,
  diagnostic,
  functionNotAllowed,
  limitExceeded,
  optionError,
  temporalNotLoaded,
  type Diagnostic,
} from './errors.js';
import {
  compareValues,
  deepEquals,
  rangeContains,
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
  type NativeFn,
  type Node,
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
  /** 严格类型强制：为 true 时不接受字符串→数字的隐式转换 */
  strictCoercion?: boolean;
}

/**
 * 求值运行时。携带求值记账与宿主策略；
 * 对 `NativeFn` 的第三参（`EvalRuntime`）而言，本类型是它的超集，可直接传入。
 */
export interface FeelEvalRuntime extends EvalRuntime {
  allowed?: ReadonlySet<string>;
  strict: boolean;
  deadline: number;
  steps: number;
}

const KNOWN_OPTIONS: ReadonlySet<string> = new Set([
  'builtins',
  'clock',
  'allowedFunctions',
  'maxNodes',
  'maxDepth',
  'timeoutMs',
  'strictCoercion',
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
    strict: options.strictCoercion === true,
    deadline: options.timeoutMs === undefined ? 0 : Date.now() + options.timeoutMs,
    steps: 0,
  };
  if (options.clock) rt.clock = options.clock;
  if (options.allowedFunctions) rt.allowed = new Set(options.allowedFunctions);
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

/** 数字读取（`strictCoercion` 下拒绝字符串→数字） */
function num(v: Value, rt: FeelEvalRuntime | undefined): number | null {
  if (rt?.strict && typeof v === 'string') return null;
  return toNumber(v);
}

/** `instance of` 判定（null 只有 `any` 成立） */
function instanceOf(v: Value, typeName: string): Value {
  if (v === null) return typeName === 'any';
  switch (typeName) {
    case 'any':
      return true;
    case 'number':
      return typeof v === 'number';
    case 'string':
      return typeof v === 'string';
    case 'boolean':
      return typeof v === 'boolean';
    case 'list':
      return isList(v);
    case 'context':
      return isContext(v);
    case 'range':
      return isRange(v);
    case 'function':
      return isFunction(v);
    case 'date':
      return isTemporal(v) && v.kind === 'date';
    case 'time':
      return isTemporal(v) && v.kind === 'time';
    case 'date and time':
    case 'dateTime':
      return isTemporal(v) && v.kind === 'dateTime';
    case 'duration':
    case 'years and months duration':
      return isTemporal(v) && v.kind === 'duration';
    default:
      return null;
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
      diag(warnings, FEEL_DIAGNOSTIC_CODES.EVAL_NO_VARIABLE, `Variable '${node.name}' not found`, node);
      return null;
    }

    case 'path': {
      const base = evaluateNode(node.base, ctx, warnings, builtins, runtime);
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
      const base = evaluateNode(node.base, ctx, warnings, builtins, runtime);
      if (!isList(base)) {
        diag(
          warnings,
          FEEL_DIAGNOSTIC_CODES.EVAL_TYPE_MISMATCH,
          'Filter/index access requires a list',
          node,
        );
        return null;
      }
      // 先在原上下文试算（静默）：能算出数字/列表即为「下标」语义
      const probe = evaluateNode(node.condition, ctx, [], builtins, runtime);
      if (typeof probe === 'number') return listAt(base, probe);
      if (isList(probe)) return probe.map((x) => listAt(base, num(x, runtime)));
      // 否则按过滤：逐元素求值，元素绑定为 `item`，其属性亦可直接访问
      return base.filter(
        (el) => evaluateNode(node.condition, scopeFor(ctx, el), warnings, builtins, runtime) === true,
      );
    }

    // `x in <区间|列表|上下文>`
    case 'in': {
      const v = evaluateNode(node.value, ctx, warnings, builtins, runtime);
      const domain = evaluateNode(node.domain, ctx, warnings, builtins, runtime);
      if (isRange(domain)) return rangeContains(domain, v);
      if (isList(domain)) {
        // 列表成员判定：**元素本身是区间时按包含**（`1 in [[2..4], [1..3]]` → true），
        // 否则按相等。三值逻辑：任一项为真 → true；否则有未定 → null；全假 → false。
        const results = domain.map((x) => (isRange(x) ? rangeContains(x, v) : deepEquals(x, v)));
        if (results.some((r) => r === true)) return true;
        if (results.some((r) => r === null)) return null;
        return false;
      }
      if (isContext(domain)) {
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
      const c1 = compareValues(v, lo);
      const c2 = compareValues(v, hi);
      if (c1 === null || c2 === null) return null; // 任一端不可比较 → 未知
      return c1 >= 0 && c2 <= 0;
    }

    // `x instance of <类型名>`
    case 'instance':
      return instanceOf(
        evaluateNode(node.value, ctx, warnings, builtins, runtime),
        node.typeName,
      );

    // 函数字面量：闭包捕获**定义处**上下文，形参按位置绑定
    case 'function': {
      const { params, body } = node;
      return makeFunction('function', (args) => {
        const bindings: Record<string, Value> = {};
        params.forEach((p, i) => {
          bindings[p] = args[i] ?? null;
        });
        return evaluateNode(body, ctx.with(bindings), warnings, builtins, runtime);
      });
    }

    case 'list':
      return node.items.map((i) => evaluateNode(i, ctx, warnings, builtins, runtime));

    case 'range':
      return makeRange(
        evaluateNode(node.from, ctx, warnings, builtins, runtime),
        evaluateNode(node.to, ctx, warnings, builtins, runtime),
        node.fromInclusive,
        node.toInclusive,
      );

    // 上下文字面量：**后一项可见前一项**（FEEL 语义，故逐项累积作用域）
    case 'context': {
      const entries = new Map<string, Value>();
      let scope = ctx;
      for (const e of node.entries) {
        const v = evaluateNode(e.value, scope, warnings, builtins, runtime);
        entries.set(e.key, v);
        scope = scope.with({ [e.key]: v });
      }
      return new FeelContext(entries);
    }

    case 'call': {
      let fn: NativeFn | null = null;
      let fnName: string | null = null;

      if (node.callee.type === 'name') {
        const name = node.callee.name;
        const builtin = builtins[name];
        if (builtin) {
          fn = builtin;
          fnName = name;
        } else {
          const v = ctx.get(name) ?? null;
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
        if (isFunction(v)) {
          fn = v.call;
          fnName = v.name || node.callee.name;
        }
      } else {
        // 任意表达式作被调者：`(function(a, b) a + b)(1, 2)`、`f().g` 等
        const v = evaluateNode(node.callee, ctx, warnings, builtins, runtime);
        if (isFunction(v)) {
          fn = v.call;
          fnName = v.name || null;
        }
      }

      const args = node.args.map((a) => evaluateNode(a, ctx, warnings, builtins, runtime));

      if (!fn) {
        const label = node.callee.type === 'name' ? node.callee.name : 'expression';
        diag(warnings, FEEL_DIAGNOSTIC_CODES.EVAL_NO_FUNCTION, `Function '${label}' not found`, node);
        return null;
      }

      // S-FEEL 白名单：具名函数越界 → 抛（匿名函数字面量不在此列，由引擎侧语法校验拦）
      if (runtime?.allowed && fnName !== null && !runtime.allowed.has(fnName)) {
        throw functionNotAllowed(fnName, [...runtime.allowed]);
      }

      return fn(args, ctx, runtime);
    }

    case 'unary': {
      const v = evaluateNode(node.operand, ctx, warnings, builtins, runtime);
      const n = num(v, runtime);
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
      const l = num(evaluateNode(node.left, ctx, warnings, builtins, runtime), runtime);
      const r = num(evaluateNode(node.right, ctx, warnings, builtins, runtime), runtime);
      if (l === null || r === null) {
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
      if (node.op === '=') return deepEquals(l, r);
      if (node.op === '!=') return !deepEquals(l, r);
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
      return combos.map((c) => evaluateNode(node.body, ctx.with(c), warnings, builtins, runtime));
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
function buildCombos(
  vars: { name: string; expr: Node }[],
  ctx: FeelContext,
  warnings: Diagnostic[],
  builtins: Record<string, NativeFn>,
  runtime?: FeelEvalRuntime,
): Record<string, Value>[] {
  let combos: Record<string, Value>[] = [{}];
  for (const v of vars) {
    const listValue = evaluateNode(v.expr, ctx, warnings, builtins, runtime);
    const items = isList(listValue) ? listValue : [listValue];
    const next: Record<string, Value>[] = [];
    for (const combo of combos) {
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
  // 区间 → 包含判定
  if (term.type === 'range') {
    const range = evaluateNode(term, ctx, warnings, builtins, runtime);
    if (!isRange(range)) return null;
    return rangeContains(range, ctx.get('?') ?? null);
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
