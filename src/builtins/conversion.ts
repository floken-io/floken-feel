/**
 * @floken/feel · 类型转换内置函数
 *
 * 转换失败返回 null（而非抛错），沿用三值语义 —— 唯一的例外是 `string()` 的**实参个数**：
 * 少给/多给是调用签名错误（没有可返回的值），按 DMN 1.4 §10.3.4 抛（TCK 0079 逐条钉死）。
 */

import { isContext, isList, isTemporal, isRange, type Value } from '../core/types.js';
import { argCountError, argTypeError, undefinedResultError } from '../core/errors.js';
import { feelTypeName, toNumber } from '../core/values.js';
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

/**
 * 取一个**分隔符**实参：`null` 合法（表示"没有这一位"），其余必须是字符串。
 * TCK 0058 把 `number("…", 123, ".")` 标成 `errorResult`，故数字分隔符是类型错误。
 */
function reqSeparator(v: Value, fnName: string, param: string): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') throw argTypeError(fnName, param, 'string', feelTypeName(v));
  return v;
}

/**
 * 按分组符 / 小数符解析一个"人写的"数字串（DMN 1.4 §10.3.3.2 的 `number`）。
 *
 * 口径（TCK 0058 的 21 条逐条钉死）：
 * - **小数符为 `null` 时按 `.` 处理** —— `number("1,000,000.00", ",", null)` = 1000000
 *   （小数位显式写 `.` 仍要能认出来）；
 * - 小数符最多出现一次，多余 → 失败；
 * - 分组符必须**夹在数字之间**（`1,000,000` 合法；`1,000,000.01` 用 `" "` 作分组符则失败，
 *   因为剩下的 `,` 不是合法字符）；
 * - 任一步失败 → **抛错**（0058 里失败例全是 `errorResult`，没有"给 null"的读法）。
 */
function parseFormatted(raw: string, group: string | null, dec: string | null): number | null {
  const sep = dec === null || dec === '' ? '.' : dec;
  let intPart = raw;
  let fracPart: string | null = null;
  const at = raw.indexOf(sep);
  if (at >= 0) {
    if (raw.indexOf(sep, at + sep.length) >= 0) return null; // 多个小数分隔符
    intPart = raw.slice(0, at);
    fracPart = raw.slice(at + sep.length);
  }
  if (group !== null && group !== '') {
    // 逐段校验：分组符两侧都必须有数字，且不能出现在首尾或连续出现
    const parts = intPart.split(group);
    if (parts.some((p) => p === '' || !/^[0-9]+$/.test(p))) return null;
    intPart = parts.join('');
  }
  const normalized = fracPart === null ? intPart : `${intPart}.${fracPart}`;
  if (!/^[+-]?[0-9]+(\.[0-9]+)?$/.test(normalized)) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

export const CONVERSION_BUILTINS: Record<string, NativeFn> = {
  string: (a) => {
    if (a.length !== 1) throw argCountError('string', 1, a.length);
    return feelString(a[0] ?? null);
  },
  /**
   * `number(from[, grouping separator, decimal separator])`。
   *
   * ⚠️ 位置顺序是 **(from, 分组符, 小数符)** —— `number("1.000.000,01", ".", ",")` = 1000000.01。
   * 只给 `from` 或三个都给，**给两个是签名错误**（0058#016）。
   */
  number: (a) => {
    if (a.length !== 1 && a.length !== 3) throw argCountError('number', [1, 3], a.length);
    const from = a[0] ?? null;
    if (typeof from !== 'string') {
      throw argTypeError('number', 'from', 'string', feelTypeName(from));
    }
    if (a.length === 1) return toNumber(from);
    const group = reqSeparator(a[1] ?? null, 'number', 'grouping separator');
    const dec = reqSeparator(a[2] ?? null, 'number', 'decimal separator');
    if (group !== null && dec !== null && group === dec) {
      throw argTypeError(
        'number',
        'decimal separator',
        'string different from grouping separator',
        dec,
      );
    }
    const n = parseFormatted(from, group, dec);
    if (n === null) {
      throw undefinedResultError('number', { from, groupingSeparator: group, decimalSeparator: dec });
    }
    return n;
  },
};
