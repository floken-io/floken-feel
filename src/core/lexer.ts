/**
 * floken-feel · 词法分析器（完全自研，零依赖 —— 不引入 lezer-feel，见 Q9）
 */

export type TokenType =
  | 'num'
  | 'str'
  /** 日期时间字面量 `@"2020-01-01"`（FEEL 10.3.2.3） */
  | 'atstr'
  | 'name'
  | 'op'
  | 'range'
  | 'lparen'
  | 'rparen'
  | 'lbracket'
  | 'rbracket'
  | 'lbrace'
  | 'rbrace'
  | 'comma'
  | 'dot'
  | 'colon'
  | 'kw'
  /** 行注释 `// …`。词法**始终**产出本类 token，便于高亮；
   *  语法分析会先过滤掉（见 `parser.ts`）。 */
  | 'comment'
  | 'eof';

export interface Token {
  type: TokenType;
  value: string;
  start: number;
  end: number;
}

import { FEEL_ERROR_CODES, syntaxError } from './errors.js';

/** FEEL 关键字（小写精确匹配） */
const KEYWORDS = new Set([
  'and',
  'or',
  'not',
  'if',
  'then',
  'else',
  'for',
  'in',
  'between',
  'instance',
  'of',
  'return',
  'every',
  'some',
  'satisfies',
  'function',
  'true',
  'false',
  'null',
]);

/** 多字符运算符优先匹配 */
const MULTI_OPS = ['**', '!=', '<=', '>=', '=', '<', '>', '+', '-', '*', '/'];

const NAME_START = /[A-Za-z_]/;
/**
 * 名字后续字符 = 字母数字下划线 + FEEL `additional name symbols` 里的 `'` 与 `^`。
 * 于是 `Mike's daughter` 这种带撇号的名字可被并入同一名字（空格由 `name-merge` 处理）。
 *
 * ⚠️ 有意偏离：FEEL 的 additional name symbols 还含 `- + * / .`，但那会与算术/路径语义
 * 直接冲突（`a-b` 究竟是一个名字还是减法），floken 保留其运算语义。偏离已登记在 AGENTS.md。
 */
const NAME_PART = /[A-Za-z0-9_'^]/;
const DIGIT = /[0-9]/;

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = src.length;

  const peek = (offset = 0): string => src.charAt(i + offset);

  while (i < len) {
    const ch = src.charAt(i);

    // 空白
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }

    // 注释 // ... 到行尾
    if (ch === '/' && peek(1) === '/') {
      const start = i;
      while (i < len && src.charAt(i) !== '\n') i += 1;
      tokens.push({ type: 'comment', value: src.slice(start, i), start, end: i });
      continue;
    }

    // 数字（含小数与指数记法）
    if (DIGIT.test(ch)) {
      const start = i;
      while (i < len && DIGIT.test(src.charAt(i))) i += 1;
      if (src.charAt(i) === '.' && DIGIT.test(src.charAt(i + 1))) {
        i += 1;
        while (i < len && DIGIT.test(src.charAt(i))) i += 1;
      }
      // 指数记法 `1.23e4` / `1E-10`：仅当 `e`/`E` 后紧跟（可带符号的）数字才并入，
      // 否则留给名字解析（`1e` 应报错而不是被吞成数字）
      const exp = src.charAt(i);
      if (exp === 'e' || exp === 'E') {
        const sign = src.charAt(i + 1) === '+' || src.charAt(i + 1) === '-' ? 1 : 0;
        if (DIGIT.test(src.charAt(i + 1 + sign))) {
          i += 1 + sign;
          while (i < len && DIGIT.test(src.charAt(i))) i += 1;
        }
      }
      tokens.push({ type: 'num', value: src.slice(start, i), start, end: i });
      continue;
    }

    // 日期时间字面量 @"…"（FEEL 10.3.2.3）
    // 内容可以是 date / time / date-time / duration，也可带 `@时区`（如 `@"…@Australia/Melbourne"`），
    // **类型分派交给 temporal 档**（构造它才需要 Temporal）；核心只负责原样收下。
    if (ch === '@' && peek(1) === '"') {
      const start = i;
      i += 2;
      let out = '';
      let closed = false;
      while (i < len) {
        const c = src.charAt(i);
        if (c === '\\') {
          const nxt = src.charAt(i + 1);
          i += 2;
          if (nxt === '"') out += '"';
          else if (nxt === '\\') out += '\\';
          else if (nxt !== undefined) out += nxt;
          continue;
        }
        if (c === '"') {
          i += 1;
          closed = true;
          break;
        }
        out += c;
        i += 1;
      }
      if (!closed) {
        throw syntaxError(
          `Unterminated date-time literal`,
          { from: start, to: len },
          {
            code: FEEL_ERROR_CODES.SYNTAX_UNTERMINATED_STRING,
            hint: '补上收尾的 `"`，如 `@"2020-01-01"`',
          },
        );
      }
      tokens.push({ type: 'atstr', value: out, start, end: i });
      continue;
    }

    // 字符串
    if (ch === '"') {
      const start = i;
      i += 1;
      let out = '';
      let closed = false;
      while (i < len) {
        const c = src.charAt(i);
        if (c === '\\') {
          const nxt = src.charAt(i + 1);
          i += 2;
          if (nxt === 'n') out += '\n';
          else if (nxt === 't') out += '\t';
          else if (nxt === 'r') out += '\r';
          else if (nxt === '"') out += '"';
          else if (nxt === '\\') out += '\\';
          else if (nxt !== undefined) out += nxt;
          continue;
        }
        if (c === '"') {
          i += 1;
          closed = true;
          break;
        }
        out += c;
        i += 1;
      }
      if (!closed) {
        throw syntaxError(
          `Unterminated string literal`,
          { from: start, to: len },
          { code: FEEL_ERROR_CODES.SYNTAX_UNTERMINATED_STRING, hint: '补上收尾的 `"`' },
        );
      }
      tokens.push({ type: 'str', value: out, start, end: i });
      continue;
    }

    // 名字 / 关键字
    if (NAME_START.test(ch)) {
      const start = i;
      while (i < len && NAME_PART.test(src.charAt(i))) i += 1;
      const word = src.slice(start, i);
      tokens.push(
        KEYWORDS.has(word)
          ? { type: 'kw', value: word, start, end: i }
          : { type: 'name', value: word, start, end: i },
      );
      continue;
    }

    // unary test 输入占位符 ?
    if (ch === '?') {
      tokens.push({ type: 'name', value: '?', start: i, end: i + 1 });
      i += 1;
      continue;
    }

    // 区间 ..（先于单字符 . 匹配）
    if (ch === '.' && peek(1) === '.') {
      tokens.push({ type: 'range', value: '..', start: i, end: i + 2 });
      i += 2;
      continue;
    }

    // 运算符
    const matched = MULTI_OPS.find((op) => op === src.slice(i, i + op.length));
    if (matched) {
      tokens.push({ type: 'op', value: matched, start: i, end: i + matched.length });
      i += matched.length;
      continue;
    }

    // 标点
    const punc: Record<string, TokenType> = {
      '(': 'lparen',
      ')': 'rparen',
      '[': 'lbracket',
      ']': 'rbracket',
      '{': 'lbrace',
      '}': 'rbrace',
      ',': 'comma',
      '.': 'dot',
      ':': 'colon',
    };
    const p = punc[ch];
    if (p) {
      tokens.push({ type: p, value: ch, start: i, end: i + 1 });
      i += 1;
      continue;
    }

    throw syntaxError(
      `Unexpected character '${ch}'`,
      { from: i, to: i + 1 },
      {
        code: FEEL_ERROR_CODES.SYNTAX_UNEXPECTED_CHARACTER,
        details: { character: ch },
      },
    );
  }

  tokens.push({ type: 'eof', value: '', start: len, end: len });
  return tokens;
}
