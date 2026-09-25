/**
 * floken-feel · 布尔 / 三值逻辑内置函数
 *
 * `all` / `any` 是布尔聚合（对标 DMN 的 `all(list)` / `any(list)`），
 * 与 `and` / `or` 一样保持三值语义：含未知且无法短路时返回 null。
 */

import { isList, type NativeFn, type Value } from '../core/types.js';
import { feelTypeName, tripleAnd, tripleNot, tripleOr } from '../core/values.js';
import { argCountError, argTypeError } from '../core/errors.js';
import { spread } from './helpers.js';

/**
 * `all` / `any` 的实参整形（TCK 0059 / 0060 逐条钉死）。
 *
 * - 单个**列表**实参 → 展开成元素（`all([true, false])`）；
 * - 单个**布尔**实参 → 当作单元素列表（`all(true)`）；
 * - **多个**实参 → 逐个取（`all(true, false, true)`）；
 * - 单个 `null` / 数字 / 字符串 → **类型错误**（`all(null)`、`any(123)` 都是 `errorResult`）；
 * - 0 个实参 → 实参个数错误（`all()`）。
 *
 * 展开后元素可以含 `null`（三值：`all([true, null, true])` = null），
 * 但不能含数字/字符串（`all([true, 123, true])` 是 `errorResult`）。
 * 注意"单个 `null`"与"列表里的 `null`"待遇不同 —— 前者连列表都不是，后者是合法的未知值。
 */
function logicalArgs(args: readonly Value[], fnName: string): Value[] {
  if (args.length === 0) throw argCountError(fnName, 1, 0);
  if (args.length === 1) {
    const one: Value = args[0] as Value;
    if (!isList(one) && typeof one !== 'boolean') {
      throw argTypeError(fnName, 'list', 'list<boolean>', feelTypeName(one));
    }
    const items: Value[] = isList(one) ? [...(one as Value[])] : [one];
    return checkBooleans(items, fnName);
  }
  return checkBooleans([...args], fnName);
}

/** 元素允许 `null`（三值语义），但不允许数字/字符串 */
function checkBooleans(items: Value[], fnName: string): Value[] {
  for (const v of items) {
    if (v !== null && typeof v !== 'boolean') {
      throw argTypeError(fnName, 'list', 'list<boolean>', feelTypeName(v));
    }
  }
  return items;
}

export const BOOLEAN_BUILTINS: Record<string, NativeFn> = {
  not: (a) => tripleNot(a[0] ?? null),
  and: (a) => tripleAnd(spread(a)),
  or: (a) => tripleOr(spread(a)),
  all: (a) => tripleAnd(logicalArgs(a, 'all')),
  any: (a) => tripleOr(logicalArgs(a, 'any')),
};
