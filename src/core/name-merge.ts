/**
 * floken-feel · 名字合并（空格名 / 多词内置名）
 *
 * 词法把 `list contains`、`Mike's daughter` 都切成若干 `name`/`kw` token，
 * 这里把它们合成**一个**名字 token。
 *
 * ⚠️ 语法分析与高亮**必须共用本档**：否则高亮边界会与解析边界漂移，
 * 编辑器就会出现"划错位置"的高亮（test/highlight.test.ts 有一致性断言兜底）。
 *
 * 规则（对齐 DMN 1.4 FEEL 的 `Name = Identifier (additional name symbols Identifier)*`）：
 *
 * 1. **优先匹配「最长多词内置名」**：只有**整体**命中 `spaced` 表才算数。
 *    于是 `date and time` 合并，而 `date and x`（`date` 变量 + 逻辑与）**不会**被误并 —— 这是
 *    只判"前缀"的写法做不到的。
 * 2. 否则做**通用名字合并**：相邻的 `name` token 合成一个名字（FEEL 允许名字含空格与撇号）；
 *    名字**后面紧跟的数字**一并吸收（`decision A 2.1` / `Flight 234` —— 见下方 ★）。
 * 3. 关键字**不参与**通用合并（`and`/`in`/`return`/`then` 必须保持关键字身份）；
 *    只有规则 1 命中时，才允许关键字被吸收（`date and time` 里的 `and`）。
 * 4. 连续空格归一成**一个**空格（规范写法条：`decision  A  1` 与 `decision A 1` 同名）。
 *
 * ★ 为什么要吸收数字（DMN 1.5 §10.3.1.1：名字后续字符含 digits 与 `.`）：
 *   TCK 0034 的决策名就是 `decision A 1` / `decision A 2.1` / `decision C 3`。
 *   只合并 `name name` 会得到 `decision A` + 数字 `2.1` → **语法错误**，整组 10 条全抛。
 *
 * ⚠️ 这样做不会抢走任何**现有合法**表达式的语义：名字后**直接**跟数字在 FEEL 里
 *   原本就是语法错（两个值之间没有运算符），吸收只是把"必然报错"变成"按名字解析"。
 *   有运算符的（`a - 1`、`a + 1`、`a[1]`、`a in [1..2]`）都不满足相邻条件，不受影响。
 */

import type { Token } from './lexer.js';
import { SPACED_NAMES } from './spaced-names.js';

/** 可作为「名字」参与合并的 token：`name` 类型，且不是 unary test 的 `?` 占位符 */
function isPlainName(t: Token | undefined): boolean {
  return !!t && t.type === 'name' && t.value !== '?' && t.value !== '';
}

/** 取 token 文本（**不做类型收窄**，收窄到 `Token` 会把否定分支推成 `never`） */
function val(t: Token | undefined): string {
  return t?.value ?? '';
}

/**
 * 允许出现在名字**中间**的关键字（DMN 1.5 §10.3.1.1：多数关键字可作名字的中间字符）。
 *
 * ★ 为什么不吸收 `and` `or` `in` `instance` `then` `else` `return` `satisfies` `between`：
 *   它们是**连接符**，两边本来就能接表达式 —— `a and b`、`a instance of number`、
 *   `if a then b else c`、`for i in x return y`、`some i in x satisfies p`。
 *   吸收它们会把这些合法表达式整段并成一个名字。
 *   反过来，表里这几个关键字**夹在两个名字之间**时原本就是语法错（`a of b` 没有意义），
 *   吸收只是把"必然报错"变成"按名字解析"（TCK 0020 的 `Years of Service`）。
 */
const NAME_INNER_KEYWORDS: ReadonlySet<string> = new Set([
  'of',
  'not',
  'if',
  'for',
  'every',
  'some',
  'function',
]);

/** 名字尾部可吸收的数字（`decision A 2.1` / `Extra days case 1`，见文件头 ★） */
function isTrailingNum(t: Token | undefined): boolean {
  return t?.type === 'num';
}

/** 两个 token 在源码里**紧邻**（中间没有空白）—— `a-b` 紧邻，`a - b` 不是 */
function adjacent(a: Token | undefined, b: Token | undefined): boolean {
  return !!a && !!b && a.end === b.start;
}

/**
 * 从 `i` 起贪心地把名字加长，返回合并后的「末下标 + 文本」。
 *
 * 每段可以是：一个 `name`、一个可夹在名字中间的关键字、一个尾随数字，
 * 或一个**紧邻**的 `-` + 名字（`Date-Time`，仅 `allowHyphen` 时）。
 *
 * ★ 为什么空格段**无条件**合并：`start position`、`end included`、`b c`、
 *   `Mike's daughter` 都**没有第二种读法** —— 两个值之间没有运算符本就是语法错。
 *   只有 `-` 是真的两义（`Date-Time` 是名字，`Rn-Kn` 是相减），故单独开关。
 */
function growOnce(tokens: Token[], i: number, allowHyphen: boolean): { end: number; text: string } {
  let j = i;
  let text = val(tokens[i]);
  for (;;) {
    const next = tokens[j + 1];
    const after = tokens[j + 2];
    if (isPlainName(next)) {
      j += 1;
      text += ` ${val(next)}`;
      continue;
    }
    if (isTrailingNum(next)) {
      j += 1;
      text += ` ${val(next)}`;
      continue;
    }
    if (next?.type === 'kw' && NAME_INNER_KEYWORDS.has(val(next)) && (isPlainName(after) || isTrailingNum(after))) {
      j += 2;
      text += ` ${val(next)} ${val(after)}`;
      continue;
    }
    if (allowHyphen && next?.type === 'op' && val(next) === '-' && adjacent(tokens[j], next) && isPlainName(after)) {
      j += 2;
      text += `-${val(after)}`;
      continue;
    }
    break;
  }
  return { end: j, text };
}

function textOf(tokens: Token[], from: number, to: number): string {
  let text = '';
  for (let k = from; k <= to; k += 1) {
    const t = tokens[k];
    if (!t) continue;
    text = k === from ? t.value : `${text} ${t.value}`;
  }
  return text;
}

/** 从 `i` 起最长的、**整体**命中 `spaced` 的 token 区间末下标；无命中（或只命中起点）返回 -1 */
function matchSpaced(tokens: Token[], i: number, spaced: ReadonlySet<string>): number {
  let text = '';
  let best = -1;
  for (let j = i; j < tokens.length; j += 1) {
    const t = tokens[j];
    if (!t) break;
    if (t.type !== 'name' && t.type !== 'kw') break;
    if (t.value === '?' || t.value === '') break;
    text = j === i ? t.value : `${text} ${t.value}`;
    if (j > i && spaced.has(text)) best = j;
  }
  return best;
}

/**
 * 合并 token 流中的名字。返回新数组，**不改原数组**；非名字 token 原样透传。
 */
export function mergeNames(
  tokens: Token[],
  spaced: ReadonlySet<string> = SPACED_NAMES,
  knownNames?: ReadonlySet<string>,
): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (!t) break;

    // 规则 1：最长多词内置名
    const spacedEnd = matchSpaced(tokens, i, spaced);
    if (spacedEnd > i) {
      const last = tokens[spacedEnd];
      out.push({
        type: 'name',
        value: textOf(tokens, i, spacedEnd),
        start: t.start,
        end: last ? last.end : t.end,
      });
      i = spacedEnd + 1;
      continue;
    }

    // 规则 2：通用名字合并（相邻 name / 夹在中间的关键字 / 尾随数字）
    if (isPlainName(t)) {
      const safe = growOnce(tokens, i, false);
      /*
       * ★ 只有**跨连字符**的那一段才需要查作用域（DMN 1.5 §10.3.1.1 的
       *   "the longest name matched in scope"）：
       *   - `Date-Time` 在作用域里 → 是一个名字（TCK 0007）；
       *   - `Rn-Kn` 不在 → 是相减（TCK 0035 的 `(1-Rn-Kn) / (1-Kn)`）。
       *
       * ⚠️ 反过来**不能**用作用域去裁决空格段：作用域里已有的**短名**会把
       *   `end included` 截成 `end` + `included`（TCK 0074 的上下文里确实先绑了
       *   `end`），于是区间属性整组塌掉。空格段没有第二种读法，照旧合并。
       */
      let chosen = safe;
      const full = growOnce(tokens, i, true);
      if (full.end > safe.end && (!knownNames || knownNames.has(full.text))) chosen = full;
      if (chosen.end > i) {
        const last = tokens[chosen.end];
        out.push({
          type: 'name',
          value: chosen.text,
          start: t.start,
          end: last ? last.end : t.end,
        });
        i = chosen.end + 1;
        continue;
      }
    }

    out.push(t);
    i += 1;
  }
  return out;
}
