/**
 * @floken/feel · 内置函数注册表
 *
 * 把各域（数值 / 布尔 / 转换 / 字符串 / 列表 / 上下文）的定义汇总成一张表，
 * 并补上 camelCase 别名。时间类内置函数不在此处 —— 见 `../temporal`（NFR-F12）。
 *
 * 扩展新内置函数：在对应域文件里加一条定义即可，注册表自动带上；
 * 名字含空格时同时往 `core/spaced-names` 登记，供 parser 合并多词 token。
 */

import type { NativeFn } from '../core/types.js';
import { registerSpacedName, SPACED_NAMES } from '../core/spaced-names.js';
import { paramNamesOf, registerParams } from '../core/function-params.js';
import { BOOLEAN_BUILTINS } from './boolean.js';
import { CONTEXT_BUILTINS } from './context.js';
import { CONVERSION_BUILTINS } from './conversion.js';
import { FUNCTION_BUILTINS } from './function.js';
import { INTERVAL_BUILTINS } from './interval.js';
import { LIST_BUILTINS } from './list.js';
import { NUMERIC_BUILTINS } from './numeric.js';
import { STRING_BUILTINS } from './string.js';

/**
 * 带空格的内置函数名（供 parser 合并相邻 token）。
 * 与 `core/spaced-names` 是**同一个 Set**：运行时注册的新名字两边都能看到。
 */
export const SPACED_BUILTINS: ReadonlySet<string> = SPACED_NAMES;

/** 各域定义（按域拆档，见同目录 numeric/string/list/boolean/conversion/context） */
const DOMAINS: Record<string, Record<string, NativeFn>> = {
  numeric: NUMERIC_BUILTINS,
  boolean: BOOLEAN_BUILTINS,
  conversion: CONVERSION_BUILTINS,
  string: STRING_BUILTINS,
  list: LIST_BUILTINS,
  context: CONTEXT_BUILTINS,
  interval: INTERVAL_BUILTINS,
  fn: FUNCTION_BUILTINS,
};

/** 不带空格调用时用的 camelCase 别名 → 规范名 */
const ALIASES: Record<string, string> = {
  listContains: 'list contains',
  stringLength: 'string length',
  stringJoin: 'string join',
  upperCase: 'upper case',
  lowerCase: 'lower case',
  substringBefore: 'substring before',
  substringAfter: 'substring after',
  startsWith: 'starts with',
  endsWith: 'ends with',
  insertBefore: 'insert before',
  indexOf: 'index of',
  distinctValues: 'distinct values',
  getValue: 'get value',
  getEntries: 'get entries',
  contextPut: 'context put',
  contextMerge: 'context merge',
  roundHalfUp: 'round half up',
  roundHalfDown: 'round half down',
  listContainsAll: 'list contains',
  stringConcat: 'string join',
};

/** 汇总后的内置函数表（含别名） */
export const BUILTINS: Record<string, NativeFn> = (() => {
  const out: Record<string, NativeFn> = {};
  for (const defs of Object.values(DOMAINS)) Object.assign(out, defs);
  for (const [name] of Object.entries(out)) registerSpacedName(name);
  for (const [alias, canonical] of Object.entries(ALIASES)) {
    const fn = out[canonical];
    if (fn) {
      out[alias] = fn;
      // 别名与规范名**共用同一张形参名表**（`stringLength` ← `string length`）
      const params = paramNamesOf(canonical);
      if (params) registerParams(alias, params);
    }
  }
  return out;
})();

/** 运行时注册自定义内置函数（floken 扩展点） */
export function registerBuiltin(name: string, fn: NativeFn): void {
  BUILTINS[name] = fn;
  registerSpacedName(name);
}
