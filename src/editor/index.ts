/**
 * floken-feel · editor 子入口
 *
 * 面向 `floken-designer` 的表达式编辑器：解析 + 诊断 + 高亮，**不含求值器**。
 * 语法错误以 `Diagnostic[]` 返回（**不抛异常**），便于编辑器实时波浪线提示 ——
 * 这正是 `05-feel` §6 要的形态：「第 12 到 15 个字符这里，可能漏了一个 `)`」，
 * 而不是一个光秃秃的 `SyntaxError`。
 *
 * 与 `.` 主入口的关系：这里**只**暴露 core（词法/语法/诊断/高亮/名字合并），
 * 不装载内置函数库与求值器，因此体积可控（NFR-F 体积档）。
 */

import { parseExpression, parseUnaryTests, type ParseOptions } from '../core/parser.js';
import { tokenize } from '../core/lexer.js';
import { mergeNames } from '../core/name-merge.js';
import { SPACED_NAMES } from '../core/spaced-names.js';
import {
  FEEL_ERROR_CODES,
  diagnostic,
  type Diagnostic,
  type FeelError,
} from '../core/errors.js';
import type { Node } from '../core/types.js';

/**
 * 语法着色（词法层实现，见 `core/highlight.ts`）。
 * 本档只做透传，方便编辑器一处导入。
 */
export { highlight } from '../core/highlight.js';
export type { HighlightKind, HighlightSpan } from '../core/highlight.js';
export type { Diagnostic, Severity } from '../core/errors.js';

/** token 类型名 → 源码形态（用于把 `expected: ['rparen']` 变成给人看的 `)`） */
const TOKEN_TEXT: Record<string, string> = {
  lparen: '(',
  rparen: ')',
  lbracket: '[',
  rbracket: ']',
  lbrace: '{',
  rbrace: '}',
  comma: ',',
  colon: ':',
  dot: '.',
  op: '运算符',
  num: '数字',
  str: '字符串',
  name: '名字',
  kw: '关键字',
};

export interface EditorToken {
  type: string;
  value: string;
  from: number;
  to: number;
}

function isFeelError(e: unknown): e is FeelError {
  return typeof e === 'object' && e !== null && (e as { floken?: unknown }).floken === true;
}

/** 把抛出的错误转成编辑器诊断；顺带把 `expected` 翻成可读建议 */
function toDiagnostics(err: unknown): Diagnostic[] {
  if (!isFeelError(err)) {
    return [
      diagnostic({
        severity: 'error',
        code: FEEL_ERROR_CODES.SYNTAX_UNEXPECTED_TOKEN,
        message: err instanceof Error ? err.message : String(err),
        start: 0,
        end: 0,
      }),
    ];
  }
  const start = err.position?.from ?? 0;
  const end = err.position?.to ?? start;
  const expectedRaw = err.details?.expected;
  const out = diagnostic({
    severity: 'error',
    code: err.code,
    message: err.message,
    start,
    end,
  });
  if (typeof expectedRaw === 'string') {
    out.expected = [expectedRaw];
    const text = TOKEN_TEXT[expectedRaw] ?? expectedRaw;
    out.suggestions = [`此处可能漏了 \`${text}\``];
  }
  return [out];
}

/**
 * 诊断一个 FEEL 表达式。无错返回空数组。
 */
export function diagnose(src: string, opts: ParseOptions = {}): Diagnostic[] {
  try {
    parseExpression(src, opts);
    return [];
  } catch (e) {
    return toDiagnostics(e);
  }
}

/**
 * 诊断 unary tests（决策表输入项）。
 */
export function diagnoseUnaryTests(src: string, opts: ParseOptions = {}): Diagnostic[] {
  try {
    parseUnaryTests(src, opts);
    return [];
  } catch (e) {
    return toDiagnostics(e);
  }
}

/**
 * 按 `05-feel` §6 的形态解析：`{ ast, diagnostics }` —— **不抛**
 * （编辑器不需要 try/catch；语法坏掉时 `ast` 为 null）。
 */
export function parseWithDiagnostics(
  src: string,
  opts: ParseOptions = {},
): { ast: Node | null; diagnostics: Diagnostic[] } {
  try {
    return { ast: parseExpression(src, opts), diagnostics: [] };
  } catch (e) {
    return { ast: null, diagnostics: toDiagnostics(e) };
  }
}

/**
 * 分词（供语法高亮）。
 * **已按 `core/name-merge.ts` 合并名字**，所以边界与 `highlight()`、与解析器三者一致。
 */
export function tokens(src: string, opts: ParseOptions = {}): EditorToken[] {
  try {
    return mergeNames(
      tokenize(src).filter((t) => t.type !== 'comment' && t.type !== 'eof'),
      opts.spacedNames ?? SPACED_NAMES,
    ).map((t) => ({ type: t.type, value: t.value, from: t.start, to: t.end }));
  } catch {
    return [];
  }
}

/** 解析为 AST（语法错**会抛** —— 需要不抛版本请用 `parseWithDiagnostics`） */
export function parse(src: string, opts: ParseOptions = {}): Node {
  return parseExpression(src, opts);
}

/** 解析 unary tests 为 AST 数组 */
export function parseTests(src: string, opts: ParseOptions = {}): Node[] {
  return parseUnaryTests(src, opts);
}
