/**
 * floken-feel · 词法高亮
 *
 * 面向编辑器（`floken-designer`）的语法着色：把源码切成带类别的 span。
 * **纯词法层实现**，只依赖 lexer 与多词名表 —— 不装载求值器、不装载内置函数库，
 * 因此可安全地用在 `.` 与 `./editor` 两个子路径。
 */

import { tokenize, type Token, type TokenType } from './lexer.js';
import { mergeNames } from './name-merge.js';

/** 着色类别（配色由宿主决定，这里只给语义） */
export type HighlightKind =
  | 'keyword' // and / or / if / then / for / in / every / satisfies …
  | 'boolean' // true / false
  | 'null' // null
  | 'number'
  | 'string'
  /** 日期时间字面量 `@"2020-01-01"`（语义是时态值，与普通字符串区分） */
  | 'temporal'
  /** 后跟 `(` 的名字（含多词内置名，如 `list contains`） */
  | 'function'
  /** 变量、上下文键、路径段、`?` 占位符 */
  | 'variable'
  | 'operator' // + - * / ** = != < <= > >= .. 
  | 'punctuation' // ( ) [ ] { } , . :
  | 'comment'
  /** 词法层已经坏掉的区间（未闭合字符串、裸 `@` …）：编辑器应把它画成"这里有问题" */
  | 'error';

export interface HighlightSpan {
  kind: HighlightKind;
  value: string;
  from: number;
  to: number;
}

const BOOLEAN_WORDS = new Set(['true', 'false']);
const NULL_WORDS = new Set(['null']);

const PUNCTUATION: ReadonlySet<TokenType> = new Set<TokenType>([
  'lparen',
  'rparen',
  'lbracket',
  'rbracket',
  'lbrace',
  'rbrace',
  'comma',
  'dot',
  'colon',
]);

/**
 * 切分并着色一段 FEEL 源码（含注释；**不抛异常**）
 *
 * ★ 词法出错时**降级**而不是整段变空 —— 这是编辑器实时着色的硬要求：
 * 用户敲到 `date("2020-01-0` 这种中间态时，前面的字符仍然该着色，只有坏掉的那一小段标成 `error`。
 * 整段返回 `[]` 会让"每敲一下整行掉色"，闪烁到没法用
 * （实测：5 条含字面量的表达式逐字符输入共 101 个中间态，原实现有 **37 个**整段掉色）。
 */
export function highlight(src: string): HighlightSpan[] {
  try {
    // 名字合并与解析器**共用同一函数**（core/name-merge.ts），保证高亮边界 === 解析边界。
    // 注释 token 会被原样透传，因此无需先摘出来。
    return spansOf(src, mergeNames(tokenize(src)));
  } catch (err) {
    return partialSpans(src, err);
  }
}

/** 词法出错的降级路径：已识别部分照常着色 + 尾部坏区间标 `error` */
function partialSpans(src: string, err: unknown): HighlightSpan[] {
  const cut = recoverCut(src, err);
  let spans: HighlightSpan[] = [];
  if (cut > 0) {
    try {
      spans = spansOf(src, mergeNames(tokenize(src.slice(0, cut))));
    } catch {
      spans = []; // 理论不可达（cut 已验证可分词）；真发生也不许抛出去
    }
  }
  if (cut < src.length) {
    spans.push({ kind: 'error', value: src.slice(cut), from: cut, to: src.length });
  }
  return spans;
}

/**
 * 找一个"到此为止还能正常分词"的切割点：
 * 优先用错误对象自带的位置；位置不可靠时退化为找最大可分词前缀（表达式很短，O(n²) 可接受）。
 */
function recoverCut(src: string, err: unknown): number {
  const at = errPositionStart(err);
  if (at !== undefined && at > 0 && at < src.length && tokenizable(src.slice(0, at))) return at;
  for (let n = src.length - 1; n >= 1; n -= 1) {
    if (tokenizable(src.slice(0, n))) return n;
  }
  return 0;
}

function errPositionStart(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { floken?: boolean; position?: { start?: number } };
  return e.floken === true && typeof e.position?.start === 'number' ? e.position.start : undefined;
}

function tokenizable(src: string): boolean {
  try {
    tokenize(src);
    return true;
  } catch {
    return false;
  }
}

function spansOf(src: string, ordered: Token[]): HighlightSpan[] {
  const spans: HighlightSpan[] = [];
  for (let i = 0; i < ordered.length; i += 1) {
    const t = ordered[i];
    if (!t || t.type === 'eof') continue;
    // value 取**源码原样切片**（字符串 token 的内部值已去引号，不能直接用于回显）
    spans.push({
      kind: kindOf(t, ordered[i + 1]),
      value: src.slice(t.start, t.end),
      from: t.start,
      to: t.end,
    });
  }
  return spans;
}

function kindOf(t: Token, next: Token | undefined): HighlightKind {
  switch (t.type) {
    case 'comment':
      return 'comment';
    case 'num':
      return 'number';
    case 'str':
      return 'string';
    case 'atstr':
      // `@"…"` 是**日期时间字面量**而非普通字符串：语法上属字面量，
      // 但语义是时态值，故单列一类，编辑器可据此给不同配色。
      return 'temporal';
    case 'op':
    case 'range':
      return 'operator';
    case 'kw':
      if (BOOLEAN_WORDS.has(t.value)) return 'boolean';
      if (NULL_WORDS.has(t.value)) return 'null';
      return 'keyword';
    case 'name':
      // 名字后跟 `(` 视为函数调用；多词内置名已在上一步合并
      return next?.type === 'lparen' ? 'function' : 'variable';
    default:
      return PUNCTUATION.has(t.type) ? 'punctuation' : 'variable';
  }
}
