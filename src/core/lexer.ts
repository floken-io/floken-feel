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

/**
 * 多字符运算符优先匹配（**顺序即优先级**，长的在前）。
 * `->` 只出现在类型语法里（`function<> -> Any`），不是 FEEL 的运算符。
 */
const MULTI_OPS = ['**', '->', '!=', '<=', '>=', '=', '<', '>', '+', '-', '*', '/'];

const NAME_START = /[A-Za-z_]|[^\x00-\x7F]/;
/**
 * 名字后续字符 = 字母数字下划线 + FEEL `additional name symbols` 里的 `'` `^` **与 `-`**。
 * 于是 `Mike's daughter` 这种带撇号的名字可被并入同一名字（空格由 `name-merge` 处理）。
 *
 * ★ `-` 为什么算名字字符（DMN 1.5 §10.3.1.1 additional name symbols）：
 *   TCK 0007 的决策名 `Date-Time` / `Date-Time2` 在表达式里就是**一个**名字。
 *   不当名字字符时 `date(Date-Time)` 会解析成 `date(Date - Time)`（上下文减时间）
 *   → null，`Time2` / `cHour` / `cOffset` / `dtDuration2` … 连带 11 条全塌。
 *   合并条件收紧为「`-` 紧邻且后接**名字首字符**」：`a - b`、`a -b`、`a- b` 仍是减法，
 *   `5-3` 与 `x-1`（后接数字）也仍是减法。
 *
 * ⚠️ 有意偏离：`additional name symbols` 里的 `+ * / .` 仍**不**算名字字符 ——
 *   它们与算术/路径语义的冲突没有"紧邻 + 后接字母"这样可靠的判别条件
 *   （`a+b` 在 FEEL 里绝大多数情况是加法），保留运算语义。偏离已登记在 AGENTS.md。
 *
 * **非 ASCII 一律算名字字符**（`[^\x00-\x7F]` 覆盖代理对的每一半）：FEEL 的名字是
 * Unicode 字母，中文变量名与 emoji 键（TCK 0083 的 `{🐎: "bar"}`）都必须能进 token 流。
 */
const NAME_PART = /[A-Za-z0-9_'^]|[^\x00-\x7F]/;
const DIGIT = /[0-9]/;

/**
 * 解一个反斜杠转义，返回 `{ text, width }`（`width` = 整个转义序列的字符数，含反斜杠）。
 *
 * FEEL 规范只写明 `\"` 与 `\\`，其余是实现自由；TCK 0083 要求额外支持 Unicode 转义：
 * - `\uXXXX`：4 位十六进制（大小写均可）
 * - `\UXXXXXX`：**6 位**（XPath 口径；`\U01F40E` = U+1F40E = 🐎）
 * - `\n` `\t` `\r`
 *
 * 代理对（`\uD83D\uDCA9`）由两次调用各产出一个 code unit，在 JS 串里自然合成一个码点 ——
 * 故 `[...s].length` 得 1，与 TCK 的 `string length` 期望一致。
 * 认不出的转义**保留反斜杠**（`\s` → `\s`）—— FEEL/XPath 的正则串把 `\d` `\s` `\p{…}`
 * 原样交给正则引擎，抹掉反斜杠会把 `split("John Doe", "\s")` 变成按 `s` 切分（TCK 0067#001）。
 */
function decodeEscape(src: string, i: number): { text: string; width: number } {
  const nxt = src.charAt(i + 1);
  if (nxt === 'u' || nxt === 'U') {
    const width = nxt === 'u' ? 4 : 6;
    const hex = src.slice(i + 2, i + 2 + width);
    if (hex.length === width && /^[0-9A-Fa-f]+$/.test(hex)) {
      return { text: String.fromCodePoint(Number.parseInt(hex, 16)), width: 2 + width };
    }
  }
  if (nxt === 'n') return { text: '\n', width: 2 };
  if (nxt === 't') return { text: '\t', width: 2 };
  if (nxt === 'r') return { text: '\r', width: 2 };
  if (nxt === '"') return { text: '"', width: 2 };
  if (nxt === '\\') return { text: '\\', width: 2 };
  if (nxt === '') return { text: '\\', width: 1 };
  return { text: `\\${nxt}`, width: 2 };
}

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

    // 注释 // … 到行尾
    if (ch === '/' && peek(1) === '/') {
      const start = i;
      while (i < len && src.charAt(i) !== '\n') i += 1;
      tokens.push({ type: 'comment', value: src.slice(start, i), start, end: i });
      continue;
    }

    // 块注释 /* … */（可跨行，TCK 0073）。与 `//` 一样产出 comment token，
    // 供高亮使用；语法层统一在 parse 前过滤掉（见 parser.ts 头部）。
    if (ch === '/' && peek(1) === '*') {
      const start = i;
      i += 2;
      while (i < len && !(src.charAt(i) === '*' && src.charAt(i + 1) === '/')) i += 1;
      i = i < len ? i + 2 : len;
      tokens.push({ type: 'comment', value: src.slice(start, i), start, end: i });
      continue;
    }

    // 数字：`0.5` / `125.43` / `1.23e4`，以及**省略整数部分的 `.872`**（TCK 0101）。
    // 判据是"点后紧跟数字" —— 故 `a.b`（路径）与 `1..5`（区间）都不会被误吞。
    if (DIGIT.test(ch) || (ch === '.' && DIGIT.test(peek(1)))) {
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
          const esc = decodeEscape(src, i);
          out += esc.text;
          i += esc.width;
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

    /*
     * 名字 / 关键字。
     *
     * ★ **`-` 不在这里并入名字**（曾经并入，是错的）。`a-b` 到底是"一个名字"还是
     *   "相减"，**词法层无从判断**：TCK 0007 的 `Date-Time` 是一个名字，
     *   TCK 0035 的 `(1-Rn-Kn) / (1-Kn)` 是相减，两者写法完全一样。
     *   规范给的判据是「按作用域取最长匹配」，而作用域只有到求值前才存在 ——
     *   故这里只产出 `name` `-` `name`，由 `core/name-merge.ts` 拿着作用域去合并。
     */
    if (NAME_START.test(ch)) {
      const start = i;
      let end = i;
      while (end < len && NAME_PART.test(src.charAt(end))) end += 1;
      i = end;
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
