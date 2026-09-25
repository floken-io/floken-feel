/**
 * floken-feel · 布尔 / 三值逻辑内置函数
 *
 * `all` / `any` 是布尔聚合（对标 DMN 的 `all(list)` / `any(list)`），
 * 与 `and` / `or` 一样保持三值语义：含未知且无法短路时返回 null。
 */

import type { NativeFn } from '../core/types.js';
import { tripleAnd, tripleNot, tripleOr } from '../core/values.js';
import { spread } from './helpers.js';

export const BOOLEAN_BUILTINS: Record<string, NativeFn> = {
  not: (a) => tripleNot(a[0] ?? null),
  and: (a) => tripleAnd(spread(a)),
  or: (a) => tripleOr(spread(a)),
  all: (a) => tripleAnd(spread(a)),
  any: (a) => tripleOr(spread(a)),
};
