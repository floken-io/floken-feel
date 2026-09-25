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
  type FeelRange,
  type NativeFn,
  type Value,
} from '../core/types.js';
import { compareValues, feelTypeName } from '../core/values.js';
import { argTypeError } from '../core/errors.js';
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

export const INTERVAL_BUILTINS: Record<string, NativeFn> = {
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
