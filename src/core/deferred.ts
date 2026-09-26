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

/**
 * ★ 一元负号作用于**时间值**的延迟能力键（**DMN 1.5 新增**，Clauses 10.3.2.3.7 / 10.3.2.3.8：
 * `-duration("PT1H")` 合法且等于 `-PT1H`）。
 *
 * 为什么它**不放进** `TEMPORAL_FUNCTIONS`：
 * - `-@` 不是合法 FEEL 标识符，用户**写不出**这个调用，它不是"函数名"；
 * - 那张表会被 `test/errors.test.ts` 当函数名逐个核查、并随主入口公开导出，
 *   把一个运算符委托键塞进去会污染两处的语义。
 * 它只是 `core/evaluator.ts` 的 `unary` 分支 → `./temporal` 实现的**委托键**，故单独定义。
 *
 * core 侧只做"值是时间值 → 委托给这个键"；真正取负的实现住在 `./temporal/index.ts`。
 */
export const TEMPORAL_UNARY_MINUS = '-@';

/**
 * ★ **duration 与标量乘除**的延迟能力键（DMN 1.5 §10.3.2.3.4）。
 *
 * 规范定义的四条（此前本包全部缺失 → 求值得 `null` + `EVAL_TYPE_MISMATCH`）：
 *   `duration * number`、`number * duration`、`duration / number`、`duration / duration → number`。
 * 它不能写在 core 里：duration 的分量缩放必须走 Temporal（`years/months` 与
 * `days/hours/…` 两套量纲要分别处理，且非整数倍要在量纲内平衡，如 `P1D * 2.5 = P2DT12H`）。
 *
 * 与 `-@` 同理：不是用户能写出的函数名，只是 core 的 `binary` 分支 → `./temporal` 的委托键。
 * 调用约定：`builtins['*@']([left, right, op])`，`op` 为 `'*'` 或 `'/'`；
 * 返回 `undefined` 表示"这不是我能管的算式" → core 落回数字分支报类型不匹配。
 */
export const TEMPORAL_SCALE = '*@';

/**
 * ★ **两个同类时间值相减**的延迟能力键（DMN 1.5 §10.3.1.3 Subtraction 表的后三档）。
 *
 * 规范定义（此前本包全部缺失 → 求值得 `null`）：
 *   `date - date`        → days and time duration（按**天**）
 *   `time - time`        → days and time duration（按**小时**）
 *   `dateTime - dateTime`→ days and time duration（按**天**）
 * 与 `date − duration` 那几档的区别：这里两个操作数**都不是** duration，
 * 结果是 duration —— 必须走 Temporal 的 `until()`，core 无法自研。
 *
 * 调用约定：`builtins['--']([left, right])`；返回 `null` 表示"这不是我能管的算式"
 * （异类、含 duration、无绝对位置等）→ core 落回数字分支报类型不匹配。
 */
export const TEMPORAL_SUBTRACT = '--';

/**
 * `./temporal` 独占的**属性名**（路径访问 `x.prop` 的右侧）。
 *
 * 与 `TEMPORAL_FUNCTIONS` 分开的原因是用途不同：这里是 `path` 节点的分派依据，
 * 而 `year` / `weekday` 等**既**能当函数调、**也**能当属性读（FEEL 两写法等价），
 * 故两表有交集。核心（`core/evaluator.ts` 的 `path` 分支）只认本表，
 * 命中后把值交给 `builtins[name]([value])` —— 实现仍住在 `./temporal`，core 零依赖。
 */
export const TEMPORAL_PROPERTIES: ReadonlySet<string> = new Set([
  // 日期 / 时间字段（与同名函数共用实现）
  'year',
  'month',
  'day',
  'hour',
  'minute',
  'second',
  'weekday',
  // 只能路径访问的属性
  'time offset',
  'timezone',
  // 时长分量（跨类访问由 temporal 档抛 `FEEL_EVAL_DURATION_COMPONENT`）
  'years',
  'months',
  'days',
  'hours',
  'minutes',
  'seconds',
]);
