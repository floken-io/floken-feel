/**
 * floken-feel · 延迟能力登记表
 *
 * 有些内置函数的**实现**住在子路径里（当前只有 `./temporal`）。
 * 核心必须能在**不 import 那个子路径**的前提下认出这些名字，
 * 才能在「未加载就调用」时抛出带修复提示的明确错误
 * （`05-feel` §4 第 2 条 / AC-F7），而不是静默返回 `null`。
 *
 * 一致性由测试兜底（test/errors.test.ts）：加载 `./temporal` 之后，
 * 本表里的每个名字都必须真的有实现，防止两边漂移。
 */

/** `./temporal` 独占的函数名 */
export const TEMPORAL_FUNCTIONS: ReadonlySet<string> = new Set([
  'now',
  'today',
  'date',
  'time',
  'date and time',
  'dateTime',
  'duration',
  'years and months duration',
  'yearsAndMonthsDuration',
  'year',
  'month',
  'day',
  'hour',
  'minute',
  'second',
  'weekday',
  /**
   * 不是函数名，而是**日期时间字面量** `@"2020-01-01"` 的延迟能力键
   * （`05-feel` 的「@ 字面量」：语法在 core、构造在 temporal）。
   * 放在同一张表里的理由：未加载时它必须抛**同一个**修复提示，
   * 而不是静默产出 `null` —— 语义与那 16 个名字完全一致。
   */
  '@',
]);
