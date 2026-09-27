/**
 * @floken/feel · 内置函数**形参名表**（DMN 1.4 §10.3.4 / §10.3.5）
 *
 * 用途：**命名参数调用**（`abs(n: -1)` / `substring(string: "abc", start position: 2)`）
 * 需要知道"每个位置上的形参叫什么"才能对位。名字必须与规范**逐字**相同 ——
 * TCK 明确要求错名（`abs(number: -1)`、`floor(n: 1.5, scal: 1)`）**抛错**，
 * 而不是"按位置硬套"。0050 / 1101 / 0103 等 16 组共 155 条断言依赖本表。
 *
 * 与 `spaced-names.ts` 同一模式：**表放 core**（纯数据、零依赖），
 * 实现分别住在 `builtins/` 与 `temporal/`，两边由测试锁一致性
 * （`test/params.test.ts`：本表每个名字都必须在实现里存在）。
 *
 * 变参函数（`concatenate` / `union` / `min` …）统一登记为单个 `list` 形参：
 * 规范把它们写成 `list…`，命名参数对它们没有实际意义。
 */

/**
 * 一个**形参位**：要么一个名字，要么**一组别名**（同名重载）。
 *
 * 别名位是为 `context put` 而设 —— 规范对同一位置给了两套签名
 * （`key` 取字符串 / `keys` 取字符串列表），两套的形参位相同、语义不同，
 * 只能靠"你写的是哪个名"来分流（见 `core/types.ts` 的 `NativeFn` 第四参）。
 */
export type ParamSlot = string | readonly string[];

/** 展平一个形参位的全部可接受名字（错误提示 / 校验用） */
export function slotNames(slot: ParamSlot): readonly string[] {
  return typeof slot === 'string' ? [slot] : slot;
}

/** 规范名 → 形参名（按位置顺序，必需参数在前；可选参数也登记，缺省由实现兜） */
const PARAMS: Record<string, readonly ParamSlot[]> = {
  // ---- 数值 ----
  abs: ['n'],
  ceiling: ['n', 'scale'],
  floor: ['n', 'scale'],
  decimal: ['n', 'scale'],
  round: ['n', 'scale'],
  'round up': ['n', 'scale'],
  'round down': ['n', 'scale'],
  'round half up': ['n', 'scale'],
  'round half down': ['n', 'scale'],
  even: ['number'],
  odd: ['number'],
  sqrt: ['number'],
  log: ['number'],
  exp: ['number'],
  modulo: ['dividend', 'divisor'],
  /*
   * ⚠️ 位置顺序是 `(from, grouping separator, decimal separator)` ——
   * **分组符在前、小数符在后**（DMN 1.4 §10.3.3.2），TCK 0058 逐条钉死：
   * `number("1.000.000,01", ".", ",")` = 1000000.01（`.` 分组、`,` 小数）。
   * 曾按「decimal 在前」登记，位置调用能把结果凑对、命名调用却必然错位。
   */
  number: ['from', 'grouping separator', 'decimal separator'],
  // ---- 布尔 ----
  not: ['negand'],
  all: ['list'],
  any: ['list'],
  // ---- 字符串 ----
  substring: ['string', 'start position', 'length'],
  'string length': ['string'],
  'upper case': ['string'],
  'lower case': ['string'],
  'substring before': ['string', 'match'],
  'substring after': ['string', 'match'],
  replace: ['input', 'pattern', 'replacement', 'flags'],
  contains: ['string', 'match'],
  'starts with': ['string', 'match'],
  'ends with': ['string', 'match'],
  split: ['string', 'delimiter'],
  'string join': ['list', 'delimiter'],
  matches: ['input', 'pattern', 'flags'],
  // ---- 列表 ----
  'list contains': ['list', 'element'],
  count: ['list'],
  min: ['list'],
  max: ['list'],
  sum: ['list'],
  mean: ['list'],
  median: ['list'],
  mode: ['list'],
  stddev: ['list'],
  product: ['list'],
  sublist: ['list', 'start position', 'length'],
  append: ['list', 'item'],
  concatenate: ['list'],
  'insert before': ['list', 'position', 'newItem'],
  remove: ['list', 'position'],
  reverse: ['list'],
  'index of': ['list', 'match'],
  union: ['list'],
  'distinct values': ['list'],
  flatten: ['list'],
  sort: ['list', 'precedes'],
  // ---- 上下文 ----
  'get value': ['m', 'key'],
  'get entries': ['m'],
  context: ['entries'],
  /*
   * `context put(context, key, value)` 与 `context put(context, keys, value)`
   * 是**同名重载**：位置相同、名字不同（`key` 取单个字符串、`keys` 取字符串列表）。
   * 合并在一个位置上，靠 `NativeFn` 第四参（实际用的形参名）分流。
   */
  'context put': ['context', ['key', 'keys'], 'value'],
  'context merge': ['contexts'],
  // ---- 其他 ----
  is: ['value1', 'value2'],
  invoke: ['function', 'params'],
  /*
   * `range` 只此一参，名字逐字为 `from`（DMN 1.5 §10.3.4）。
   * 登记它的理由不是"支持命名调用"，而是让**错名**能被认出来：
   * TCK 1156 decision012 的 `range(fron: "[1..3]")` 必须给 `null`（不是按位置硬套）。
   * 上面 14 个区间关系函数仍未登记（点版 / 区间版两套形参名，见 `interval.ts` 文件头）。
   */
  range: ['from'],
  /*
   * `list replace(list, position, newItem)` 与 `list replace(list, match, newItem)`
   * 是**同名重载**：第 2 位既可能是位置（number）也可能是判定函数。
   * 与 `context put` 同法：合并到一个别名位上，实现按**实参类型**分流（形参名不必读）。
   */
  'list replace': ['list', ['position', 'match'], 'newItem'],
  // ---- 时间（实现见 ./temporal）----
  date: ['from', 'year', 'month', 'day'],
  time: ['from', 'hour', 'minute', 'second', 'offset'],
  'date and time': ['from', 'date', 'time'],
  dateTime: ['from', 'date', 'time'],
  duration: ['from'],
  'years and months duration': ['from', 'to'],
  string: ['from'],
  // 时间值的字段属性（路径访问用；登记后命名调用报错信息更准确）
  year: ['date'],
  month: ['date'],
  day: ['date'],
  hour: ['time'],
  minute: ['time'],
  second: ['time'],
  weekday: ['date'],
  'day of year': ['date'],
  'week of year': ['date'],
  'day of week': ['date'],
  'month of year': ['date'],
};

/** 查某个函数的形参名表；未登记 → `null`（调用方据此判断"不支持命名参数"） */
export function paramNamesOf(fnName: string): readonly ParamSlot[] | null {
  return PARAMS[fnName] ?? null;
}

/** 追加/覆盖一条形参名（别名注册用，见 `builtins/registry.ts`） */
export function registerParams(name: string, params: readonly ParamSlot[]): void {
  PARAMS[name] = params;
}

/** 当前已登记的全部函数名（测试用） */
export function registeredParamNames(): string[] {
  return Object.keys(PARAMS);
}
