/**
 * floken-feel · 内置函数**形参名表**（DMN 1.4 §10.3.4 / §10.3.5）
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

/** 规范名 → 形参名（按位置顺序，必需参数在前；可选参数也登记，缺省由实现兜） */
const PARAMS: Record<string, readonly string[]> = {
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
  number: ['from', 'decimal separator', 'grouping separator'],
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
  'context put': ['context', 'key', 'value'],
  'context merge': ['contexts'],
  // ---- 其他 ----
  is: ['value1', 'value2'],
  invoke: ['function', 'params'],
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
};

/** 查某个函数的形参名表；未登记 → `null`（调用方据此判断"不支持命名参数"） */
export function paramNamesOf(fnName: string): readonly string[] | null {
  return PARAMS[fnName] ?? null;
}

/** 追加/覆盖一条形参名（别名注册用，见 `builtins/registry.ts`） */
export function registerParams(name: string, params: readonly string[]): void {
  PARAMS[name] = params;
}

/** 当前已登记的全部函数名（测试用） */
export function registeredParamNames(): string[] {
  return Object.keys(PARAMS);
}
