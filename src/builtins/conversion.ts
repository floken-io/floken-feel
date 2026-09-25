/**
 * floken-feel · 类型转换内置函数
 *
 * 转换失败返回 null（而非抛错），沿用三值语义 —— 唯一的例外是 `string()` 的**实参个数**：
 * 少给/多给是调用签名错误（没有可返回的值），按 DMN 1.4 §10.3.4 抛（TCK 0079 逐条钉死）。
 */

import { isContext, isList, isTemporal, isRange, type Value } from '../core/types.js';
import { argCountError } from '../core/errors.js';
import { toNumber } from '../core/values.js';
import type { NativeFn } from '../core/types.js';

/**
 * `string()` 的口径（TCK 0079 共 37 条断言）：
 *
 * - **标量**：数字/布尔直接写字面（`123.45` / `true`）；**字符串返回自身**（不加引号）；
 * - **时间值**：用 `FeelTemporal.iso` —— 那已经是 FEEL 规范文本（`date` / `time` /
 *   `date and time` / 两个 duration 类型），故 `string(date(...))` 直接可用；
 * - **list / context**：**字面形态**（`[a, b]` / `{k: v}`），元素**递归**渲染，
 *   其中字符串要**带引号并转义**（`[1, "a"]`）—— 这正是与"字符串返回自身"的分别。
 * - **null**：`null`（`string(null)` 是 `null`，不是字符串 `"null"`）。
 *
 * 键是裸标识符时不加引号，否则整体加引号（`{"{": "foo"}`）。
 */
const IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_]*$/u;

function keyText(key: string): string {
  return IDENTIFIER.test(key) ? key : JSON.stringify(key);
}

/** 作为**容器元素**时的字面形态：字符串带引号，其余同 `feelString` */
function literalText(v: Value): string | null {
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === null) return 'null';
  return feelString(v);
}

/** `string(x)` 的正文；不可表示 → null */
export function feelString(v: Value): string | null {
  if (v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (isTemporal(v)) return v.iso;
  if (isList(v)) {
    const parts = v.map(literalText);
    return parts.some((p) => p === null) ? null : `[${parts.join(', ')}]`;
  }
  if (isContext(v)) {
    const parts = v.keys().map((k) => {
      const inner = literalText(v.get(k) ?? null);
      return inner === null ? null : `${keyText(k)}: ${inner}`;
    });
    return parts.some((p) => p === null) ? null : `{${parts.join(', ')}}`;
  }
  // range / function：FEEL 未规定其文本形态（TCK 不测），给 null
  if (isRange(v)) return null;
  return null;
}

export const CONVERSION_BUILTINS: Record<string, NativeFn> = {
  string: (a) => {
    if (a.length !== 1) throw argCountError('string', 1, a.length);
    return feelString(a[0] ?? null);
  },
  number: (a) => toNumber(a[0] ?? null),
};
