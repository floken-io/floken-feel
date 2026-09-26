/**
 * floken-feel · 区间关系内置函数（DMN 1.4 的 14 个区间函数）
 *
 * `before` / `after` / `meets` / `met by` / `overlaps` / `overlaps before` / `overlaps after` /
 * `finishes` / `finished by` / `includes` / `during` / `starts` / `started by` / `coincides`
 *
 * 实参可为**点**（`before(1, 10)`）或**区间**（`before([1..10], [15..20])`），实参不是区间时
 * 按单点区间 `[p..p]` 处理 —— 于是 14 个关系只需一套实现。
 *
 * ★ 实现思路（把 Allen 区间代数写短的关键）：把每个端点映到一条数轴上的位置
 * `值 + k·ε`（见 `startPos` / `endPos`），14 个关系就全部化归为**两个位置的比较**。
 * 开闭端点靠 `k` 的 ±1 表达：起点闭 `k=0`（含该点）、起点开 `k=+1`（第一个点已大于该值）、
 * 终点闭 `k=0`、终点开 `k=-1`。这样 `meets([1..5],[5..10])` 为真而
 * `meets([1..5],[5..10))` 为假这类开关端点差别，无需任何特判。
 *
 * 语义由 TCK `1130-feel-interval` 的 14 条断言逐条反推（每条是一个装着十几个关系调用的上下文），
 * 全部口径都可在该组的表达式里指到具体子项。三值语义：端点不可比（类型不同 / 无界）→ `null`。
 *
 * ⚠️ **命名参数暂不支持**（有意）：规范对同名函数有「点版 / 区间版」两套形参名
 * （`point1, point2` 与 `range1, range2`），而本表一个名字只能挂一组形参名，
 * 猜一个上去会让另一套写法静默对错位。故此处不登记 `function-params`，
 * 命名调用会明确报「不支持命名参数」而不是悄悄算错。位置调用（TCK 覆盖的唯一形态）正常。
 */

import {
  isContext,
  isFunction,
  isList,
  isRange,
  makeRange,
  type EvalRuntime,
  type FeelContext,
  type FeelRange,
  type NativeFn,
  type Value,
} from '../core/types.js';
import {
  compareValues,
  feelTypeName,
  sameTypeFamily,
} from '../core/values.js';
import { argTypeError, temporalNotLoaded } from '../core/errors.js';
import { requireArity } from './helpers.js';

/** 端点在数轴上的位置：`值 + k·ε`（`k` 表达开闭，见文件头） */
interface Pos {
  value: Value;
  k: number;
}

function startPos(r: FeelRange): Pos {
  return { value: r.from, k: r.fromInclusive ? 0 : 1 };
}

function endPos(r: FeelRange): Pos {
  return { value: r.to, k: r.toInclusive ? 0 : -1 };
}

/** 位置比较：`-1 / 0 / 1`；端点不可比（类型不同、无界 `null` 端点）→ `null`（未知） */
function cmpPos(a: Pos, b: Pos): number | null {
  const c = compareValues(a.value, b.value);
  if (c === null) return null;
  return c !== 0 ? c : a.k - b.k;
}

const lt = (c: number | null): Value => (c === null ? null : c < 0);
const le = (c: number | null): Value => (c === null ? null : c <= 0);
const ge = (c: number | null): Value => (c === null ? null : c >= 0);
const at = (c: number | null): Value => (c === null ? null : c === 0);

/** 三值合取：任一项未知 → `null`；否则全真为真 */
const all = (...parts: Value[]): Value =>
  parts.some((p) => p === null) ? null : !parts.includes(false);

/** 实参 → 区间：区间原样；点 → `[p..p]`；列表 / 上下文 / 函数 / `null` → 不可用 */
function intervalOf(v: Value): FeelRange | null {
  if (isRange(v)) return v;
  if (v === null || isList(v) || isContext(v) || isFunction(v)) return null;
  return makeRange(v, v, true, true);
}

/**
 * 取两个区间实参。实参不是「点或区间」→ **抛**类型错误
 * （调用签名不合法，不是「值未知」；与 `helpers.ts` 的全局口径一致）。
 */
function intervals(fnName: string, args: readonly Value[]): [FeelRange, FeelRange] {
  requireArity(args, fnName, 2);
  const first = args[0] ?? null;
  const second = args[1] ?? null;
  const a = intervalOf(first);
  const b = intervalOf(second);
  if (a === null) throw argTypeError(fnName, 'range1', 'point or range', feelTypeName(first));
  if (b === null) throw argTypeError(fnName, 'range2', 'point or range', feelTypeName(second));
  return [a, b];
}

/**
 * 区间字面量串。
 *
 * ★ 起止括号各有 **三个** 合法字符，不是两个：
 *   起 `[`（闭）| `(`（开）| `]`（开）；止 `]`（闭）| `)`（开）| `[`（开）。
 *   规范语法即 `('[' | '(' | ']') … (']' | ')' | '[')`。只认 `[`/`(` 起、`]`/`)` 止，
 *   会把 `]18..21]` 与 `[18..21[`（TCK 1156 decision003_c / decision003_e）误判成"不是区间字面量"。
 */
const RANGE_TEXT = /^([[(\]])\s*(.+?)\s*\.\.\s*(.+?)\s*([\])[])$/;

/** 科学计数法也要认（`2.3e-5` 是 DMN 1.5 起允许的数字字面量） */
const NUMBER_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * 端点里允许出现的**字面量时间构造**（DMN 1.5 §10.3.4 转换函数）。
 *
 * 只此 7 个，且**实参必须是字面量串** —— TCK 1156 decision007_b/c 起共 8 条钉死：
 * `date(string("1970-01-01"))` / `date(input_001)` 这种"非字面量"端点**不被允许**，
 * 整条 `range()` 给 `null`，而不是"尽力算出一个值"。
 */
const TEMPORAL_LITERAL_FNS: ReadonlySet<string> = new Set([
  'date',
  'date and time',
  'dateTime',
  'time',
  'duration',
  'years and months duration',
  'days and time duration',
]);

/** `name("…")` —— 名字可含空格（`date and time`），故空格要能在名字里 */
const CALL_HEAD = /^([A-Za-z][A-Za-z0-9 ]*?)\s*\(([\s\S]*)\)$/;

/**
 * 读一个引号字符串（`"` 或 `'` 定界，`\` 转义）。
 * 返回内容与**结束下标**；调用方据此判断后面是否还有多余字符（`date("a", 1)` 就不该算字面量）。
 */
function readQuoted(text: string, i: number): { value: string; end: number } | null {
  const quote = text[i];
  if (quote !== '"' && quote !== "'") return null;
  let out = '';
  let j = i + 1;
  while (j < text.length) {
    const c = text[j] as string;
    if (c === '\\') {
      out += text[j + 1] ?? '';
      j += 2;
      continue;
    }
    if (c === quote) return { value: out, end: j + 1 };
    out += c;
    j += 1;
  }
  return null;
}

/** 端点解析结果：`ok` = 拿到了值；`null` = 不是字面量（整条 `range()` 随之给 null） */
type Endpoint = { ok: true; value: Value } | { ok: false };

/** 多空格归一（`date  and   time` → `date and time`） */
function squeeze(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/**
 * 调**时间档**的字面量构造。时间档未加载 → **抛** `FEEL_NOT_LOADED_TEMPORAL`
 * （与 `@"…"` 在求值器里的规矩一致，AC-F7；不静默 null —— AGENTS.md §5 四禁之一）。
 */
function temporalLiteral(
  name: string,
  arg: string,
  ctx: FeelContext,
  runtime: EvalRuntime | undefined,
  builtins: Record<string, NativeFn> | undefined,
): Endpoint {
  const impl = builtins?.[name];
  if (!impl) throw temporalNotLoaded(name);
  const v = impl([arg], ctx, runtime);
  // 串不是合法时间文本 → 端点无值 → 整条 range() 给 null（不是类型错误）
  return v === null || v === undefined ? { ok: false } : { ok: true, value: v };
}

/**
 * 区间字面量串的**端点** → 值。
 *
 * 接受的形态（就这四类，其余一律"不是字面量"）：
 *   数字（含科学计数法）· 引号字符串 · `@"…"` 时间字面量 · `date("…")` 等字面量时间构造
 *
 * ⚠️ **故意不认** `null` / `true` / 变量名 / 嵌套调用：
 * `range("[null..null]")`（TCK 1156 decision027）与
 * `range("[date(string("…"))..@"…"]")`（decision007_b）都必须给 `null`。
 */
function endpointValue(
  text: string,
  ctx: FeelContext,
  runtime: EvalRuntime | undefined,
  builtins: Record<string, NativeFn> | undefined,
): Endpoint {
  const t = text.trim();
  if (t === '') return { ok: false };
  if (NUMBER_TEXT.test(t)) return { ok: true, value: Number(t) };

  // `@"…"` —— 时间字面量（语法在 core，构造在 ./temporal）
  if (t[0] === '@') {
    const q = readQuoted(t, 1);
    if (!q || q.end !== t.length) return { ok: false };
    return temporalLiteral('@', q.value, ctx, runtime, builtins);
  }

  // 引号字符串
  if (t[0] === '"' || t[0] === "'") {
    const q = readQuoted(t, 0);
    if (!q || q.end !== t.length) return { ok: false };
    return { ok: true, value: q.value };
  }

  // `name("…")` —— 只放行字面量时间构造，且实参必须恰好一个字面量串
  const m = CALL_HEAD.exec(t);
  if (m) {
    const name = squeeze(m[1] ?? '');
    if (!TEMPORAL_LITERAL_FNS.has(name)) return { ok: false };
    const inner = (m[2] ?? '').trim();
    const q = readQuoted(inner, 0);
    if (!q || q.end !== inner.length) return { ok: false };
    return temporalLiteral(name, q.value, ctx, runtime, builtins);
  }

  return { ok: false };
}


export const INTERVAL_BUILTINS: Record<string, NativeFn> = {
  /**
   * ★ `range` —— 区间**构造**（与上面 14 个关系函数不同：那组是判定，这个是造值）。
   *
   * **只有一参**：`range(from: string)`（DMN 1.5 §10.3.4 转换函数，形参名逐字为 `from`）。
   * 实参不是串、或串不是区间字面量 → **抛** `FEEL_EVAL_ARG_TYPE`；
   * 串是区间字面量但**端点不是字面量 / 两端不同类 / 降序** → 给 `null`（不是错误）。
   *
   * 三类 `null` 各有出处（TCK 1156 逐条钉死）：
   * - 端点非字面量：`range("[date(string("…"))..@"…"]")` → null（decision007_b）
   * - 两端不同类：`range("[1..\"b\"]")`（decision018）、`date` 对 `date and time`（decision019_a）
   * - 降序：`[3..1]`（decision020）、`["z".."a"]`（decision023）、`[@"P2D"..@"P1D"]`（decision024）
   *
   * ⚠️ **没有 `range(from, to)` 双参形态**：TCK decision013_a 明确 `range("[1..3]", "foo")`
   * 是"实参过多 → null"。双参是 Camunda/Drools 的扩展，不是规范。
   */
  range: (args, ctx, runtime, _argNames, builtins) => {
    requireArity(args, 'range', 1);
    const text = args[0] ?? null;
    if (typeof text !== 'string') {
      throw argTypeError('range', 'from', 'string', feelTypeName(text));
    }
    const m = RANGE_TEXT.exec(text.trim());
    if (!m) throw argTypeError('range', 'from', 'range literal, e.g. "[18..21]"', text);
    const [, open = '[', fromText = '', toText = '', close = ']'] = m;
    const from = endpointValue(fromText, ctx, runtime, builtins);
    const to = endpointValue(toText, ctx, runtime, builtins);
    if (!from.ok || !to.ok) return null;
    // 两端必须同类；跨类型无定义 → null（不是"尽力比一下"）
    if (!sameTypeFamily(from.value, to.value)) return null;
    // 降序区间无定义 → null（`c === null` 是不可比，同样无定义）
    const c = compareValues(from.value, to.value);
    if (c === null || c > 0) return null;
    return makeRange(from.value, to.value, open === '[', close === ']');
  },

  /** `a` 整体在 `b` 之前 */
  before: (args) => {
    const [a, b] = intervals('before', args);
    return lt(cmpPos(endPos(a), startPos(b)));
  },
  /** `a` 整体在 `b` 之后 */
  after: (args) => {
    const [a, b] = intervals('after', args);
    return lt(cmpPos(endPos(b), startPos(a)));
  },
  /** `a` 终点**恰好**是 `b` 起点（两端都含该点），即相接而不重叠 */
  meets: (args) => {
    const [a, b] = intervals('meets', args);
    return at(cmpPos(endPos(a), startPos(b)));
  },
  'met by': (args) => {
    const [a, b] = intervals('met by', args);
    return at(cmpPos(endPos(b), startPos(a)));
  },
  /** 起点与终点都相同（含开闭），即同一区间 */
  coincides: (args) => {
    const [a, b] = intervals('coincides', args);
    return all(at(cmpPos(startPos(a), startPos(b))), at(cmpPos(endPos(a), endPos(b))));
  },
  /** 起点相同（含开闭）且不晚于 `b` 结束 */
  starts: (args) => {
    const [a, b] = intervals('starts', args);
    return all(at(cmpPos(startPos(a), startPos(b))), le(cmpPos(endPos(a), endPos(b))));
  },
  'started by': (args) => {
    const [a, b] = intervals('started by', args);
    return all(at(cmpPos(startPos(b), startPos(a))), le(cmpPos(endPos(b), endPos(a))));
  },
  /** 终点相同（含开闭）且不早于 `b` 开始 */
  finishes: (args) => {
    const [a, b] = intervals('finishes', args);
    return all(at(cmpPos(endPos(a), endPos(b))), ge(cmpPos(startPos(a), startPos(b))));
  },
  'finished by': (args) => {
    const [a, b] = intervals('finished by', args);
    return all(at(cmpPos(endPos(b), endPos(a))), ge(cmpPos(startPos(b), startPos(a))));
  },
  /** `a` 完全落在 `b` 内（含边界相等） */
  during: (args) => {
    const [a, b] = intervals('during', args);
    return all(ge(cmpPos(startPos(a), startPos(b))), le(cmpPos(endPos(a), endPos(b))));
  },
  /** `a` 完全包含 `b` */
  includes: (args) => {
    const [a, b] = intervals('includes', args);
    return all(ge(cmpPos(startPos(b), startPos(a))), le(cmpPos(endPos(b), endPos(a))));
  },
  /**
   * **相交**（对称）——注意本函数不是 Allen 的 `overlaps`：
   * TCK 要求 `overlaps([1..5], [3..8])` 与 `overlaps([3..8], [1..5])` **同为真**，
   * 即「有公共点」即可；`[1..5]` 与 `[5..8]` 也共享端点 5，故为真，
   * 而 `[1..5]` 与 `(5..8]`（5 不在后者内）为假。
   */
  overlaps: (args) => {
    const [a, b] = intervals('overlaps', args);
    return all(le(cmpPos(startPos(a), endPos(b))), le(cmpPos(startPos(b), endPos(a))));
  },
  /** `a` 起点更早、且 `a` 的终点落在 `b` 内 → 「向前的重叠」 */
  'overlaps before': (args) => {
    const [a, b] = intervals('overlaps before', args);
    return all(
      lt(cmpPos(startPos(a), startPos(b))),
      le(cmpPos(endPos(a), endPos(b))),
      ge(cmpPos(endPos(a), startPos(b))),
    );
  },
  /** `overlaps before` 的反向 */
  'overlaps after': (args) => {
    const [a, b] = intervals('overlaps after', args);
    return all(
      lt(cmpPos(startPos(b), startPos(a))),
      le(cmpPos(endPos(b), endPos(a))),
      ge(cmpPos(endPos(b), startPos(a))),
    );
  },
};
