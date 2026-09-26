/**
 * floken-feel · 字符串内置函数
 *
 * 字符串位置按 FEEL 规范为 **1-based**，负值表示从末尾倒数。
 * 正则相关函数（`replace` / `matches` / `split`）编译失败时返回 null。
 */

import { isList, type NativeFn, type Value } from '../core/types.js';
import { argTypeError } from '../core/errors.js';
import { feelTypeName, toNumber, toStr } from '../core/values.js';
import { requireArity } from './helpers.js';

/** 把 FEEL 的 1-based（可负）起点换算成 0-based 下标 */
function toIndex(start: number, length: number): number {
  return start > 0 ? start - 1 : Math.max(0, length + start);
}

/**
 * FEEL/XPath 的 flags 方言 → JS flags。
 *
 * 认 `i` `m` `s` `x`，其余字母（含大写 `X`、空格）一律**非法** → 返回 `null`
 * （TCK 1111 `fn-matchesErr-1` 的 `"p"`、`K-MatchesFunc-5` 的 `" "`、`-6` 的 `"X"`）。
 *
 * - `x`（**free-spacing**）JS 没有对应物，故不进 flags，改为**改写模式串**；
 * - `u` 由本档**恒加**（见 `compileRegex`）：它把 `i` 升级为 Unicode 全折叠，
 *   从而 `matches("\u212A","k","i")` = true（TCK `caselessmatch07`）。
 */
function translateFlags(flags: string): { js: string; freeSpacing: boolean } | null {
  let js = '';
  let freeSpacing = false;
  for (const f of flags) {
    if (f === 'i' || f === 'm' || f === 's') {
      if (!js.includes(f)) js += f;
      continue;
    }
    if (f === 'x') {
      freeSpacing = true;
      continue;
    }
    return null;
  }
  return { js, freeSpacing };
}

/** 从 `[` 起扫出整个字符类（含嵌套 `[…]`），返回结束下标（不含），失败 -1 */
function scanClass(src: string, start: number): number {
  let i = start + 1;
  if (src[i] === '^') i += 1;
  if (src[i] === ']') i += 1; // `[]]` / `[^]]`
  for (; i < src.length; ) {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === '[') {
      const end = scanClass(src, i);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (src[i] === ']') return i + 1;
    i += 1;
  }
  return -1;
}

/**
 * 字符类**减法** `[A-Z-[OI]]`（XPath 2.0）→ JS `v` 模式的 `[[A-Z]--[OI]]`。
 *
 * JS 的普通模式没有集合运算，`v` 模式（ES2024）有，故只在**真的出现减法**时才切 `v`。
 * 返回 `null` = 有减法但写坏了（如带 `^` 取反的减法，我们不翻译）。
 */
function expandSubtractions(
  pattern: string,
): { src: string; usedV: boolean } | null {
  let out = '';
  let usedV = false;
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '\\') {
      out += pattern.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c !== '[') {
      out += c;
      i += 1;
      continue;
    }
    const end = scanClass(pattern, i);
    if (end < 0) return null;
    const body = pattern.slice(i, end);
    const inner = body.slice(1, -1);
    const neg = inner.startsWith('^');
    const cut = neg ? findSubtraction(inner, 1) : findSubtraction(inner, 0);
    if (cut < 0) {
      out += body;
      i = end;
      continue;
    }
    if (neg) return null;
    const base = inner.slice(0, cut);
    const nestedEnd = scanClass(inner, cut + 1);
    if (nestedEnd < 0 || nestedEnd !== inner.length) return null;
    const sub = inner.slice(cut + 2, nestedEnd - 1);
    out += `[[${base}]--[${sub}]]`;
    usedV = true;
    i = end;
  }
  return { src: out, usedV };
}

/** 在字符类体内找顶层 `-[`（减法运算符），找不到返回 -1 */
function findSubtraction(body: string, from: number): number {
  let i = from;
  for (; i < body.length; ) {
    if (body[i] === '\\') {
      i += 2;
      continue;
    }
    if (body[i] === '[') {
      const end = scanClass(body, i);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (body[i] === '-' && body[i + 1] === '[') return i;
    i += 1;
  }
  return -1;
}

/**
 * 实现 XPath 的 `x` 模式：字符类**之外**的空白全部忽略，`#` 起注释到行尾。
 * 转义序列与字符类内部（`[a b]`）原样保留。
 *
 * ⚠️ 转义空白要落成 `\x20` 而不是 ` `：最终正则恒带 `u`，而 `u` 模式下
 * `\ `（转义一个非语法字符）是**语法错误** —— TCK `K2-MatchesFunc-1` 的 `hello\ sworld`。
 */
function freeSpacing(pattern: string): string {
  let out = '';
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i] ?? '';
    if (c === '\\') {
      const nxt = pattern[i + 1];
      if (nxt !== undefined && /\s/.test(nxt)) {
        out += `\\x${nxt.codePointAt(0)?.toString(16).padStart(2, '0') ?? '20'}`;
      } else {
        out += c + (nxt ?? '');
      }
      i += 1;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    if (!inClass && /\s/.test(c)) continue;
    if (!inClass && c === '#') {
      while (i < pattern.length && pattern[i] !== '\n') i += 1;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * XPath 的**块属性** `\p{IsBasicLatin}` → JS 等价写法。
 *
 * JS 的 `\p{…}` 只认「二进制属性 / General_Category / Script」，没有块名；
 * 而 BasicLatin 块（U+0000–U+007F）**恰好等于**二进制属性 `ASCII`，故映射到 `\p{ASCII}`。
 * 其余块名 floken 不支持 → 抛（认不出来却当普通字符序列去匹配是错的）。
 *
 * 注意本函数必须在 `freeSpacing` **之后**跑：x 模式下 `\p{ IsBasicLatin}` 要先去掉空格；
 * 不带 `x` 时空格留着，于是匹配不上任何块名 → 抛 —— 这正是
 * TCK `K2-MatchesFunc-7` 期望的错误。
 */
const BLOCK_TO_JS: Record<string, string> = { BasicLatin: 'ASCII' };

function translateBlocks(fnName: string, src: string): string {
  return src.replace(/\\([pP])\{Is([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, p, name) => {
    const js = BLOCK_TO_JS[name];
    if (js === undefined) {
      throw argTypeError(fnName, 'pattern', `string<regex>（不支持的 Unicode 块 Is${name}）`, name);
    }
    return `\\${p}{${js}}`;
  });
}

/**
 * 编译一个 FEEL 正则。不合法（flags 字母、模式串、块名）一律**抛**：
 * 写错正则是"换输入还有救"里最典型的一类，静默返回 null 会把错误吞掉。
 *
 * `global` 为真时恒加 `g` —— **FEEL 的 `replace` 替换全部匹配**
 * （TCK 1109#008：`replace("abracadabra","bra","*")` = `"a*cada*"`），
 * 而 JS 的字符串模式只换第一处，这是最容易踩的一处方言差。
 */
/**
 * 拒绝**字符类内**的反向引用与不存在的 `\0`（XPath 正则没有 `\0` 这个转义）。
 *
 * JS 会把 `\0` 当 NUL 字符照常编译，从而把 `(asd)[asd\0]` 判为"能编译、只是不匹配"（false）；
 * 而 XPath 认为这是错的 —— TCK `K2-MatchesFunc-13/-14` 标 `errorResult`。
 */
function rejectBadEscapes(fnName: string, src: string): void {
  let inClass = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i] ?? '';
    if (c === '\\') {
      const nxt = src[i + 1] ?? '';
      if (nxt === '0' || (inClass && nxt >= '1' && nxt <= '9')) {
        throw argTypeError(fnName, 'pattern', 'string<regex>', src);
      }
      i += 1;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
  }
}

function compileRegex(fnName: string, pattern: string, flags: string, global: boolean): RegExp {
  const t = translateFlags(flags);
  if (t === null) {
    throw argTypeError(fnName, 'flags', 'string<XPath flags: i|m|s|x>', JSON.stringify(flags));
  }
  const sub = expandSubtractions(pattern);
  if (sub === null) throw argTypeError(fnName, 'pattern', 'string<regex>', pattern);
  let src = sub.src;
  if (t.freeSpacing) src = freeSpacing(src);
  src = translateBlocks(fnName, src);
  rejectBadEscapes(fnName, src);
  // `v` 用于集合运算（字符类减法），`u` 用于其余场合；两者互斥
  const mode = sub.usedV ? 'v' : 'u';
  try {
    return new RegExp(src, global ? `g${mode}${t.js}` : `${mode}${t.js}`);
  } catch {
    throw argTypeError(fnName, 'pattern', 'string<regex>', pattern);
  }
}

/**
 * 取字符串实参：实参为 `null` 或**非字符串**（如列表/数字）一律返回 `null`
 * （unknown，对齐 DMN 1.4 §10.3.2.13.1 + feelin）。
 *
 * 调用方据此返回 null，由 `call` 节点边界转换为「诊断 + null」，与 feelin 一致；
 * 不在此抛错（参考 r6 的"抛错"立场已被用户拍板「必须对齐规范」回退）。
 *
 * 可选 `flags` 形参的「null / 省略 → 无标志、非字符串 → 类型错返回 null」由
 * `matches` / `replace` 在调用点就地处理（不能简单 `?? ''`，否则列表型 flags
 * 会被误当"无标志"，见 TCK 1111 `K-MatchesFunc-3`）。
 */
function reqString(
  args: readonly Value[],
  i: number,
  fnName: string,
  param: string,
): string | null {
  const v = args[i] ?? null;
  if (v === null) return null;
  if (typeof v !== 'string') return null;
  return v;
}

/**
 * 替换串里的组引用方言：XPath 用 **`$0`** 指"整个匹配"，JS 里那是 `$&`
 * （JS 中 `$0` 无特殊含义，会原样输出 `$0`）。TCK 1109#018 的 `"[$0]"` 即此。
 */
function translateReplacement(rep: string): string {
  return rep.replace(/\$(\d+)/g, (_m, d: string) => (d === '0' ? '$&' : `$${d}`));
}

export const STRING_BUILTINS: Record<string, NativeFn> = {
  // ----- 判定 -----
  /*
   * `contains(string, match)`：两个实参都必须是字符串；`null` / 非字符串一律**返回 null**
   * （unknown，对齐 §10.3.2.13.1）。TCK 1110#001~#003 把 `contains(null,...)` 列成 errorResult
   * （期望抛错）—— 规范/feelin 口径是 null。
   *
   * ⚠️ `starts with` / `ends with` 仍按 toStr+null 处理：TCK 对它们没有这类 errorResult 用例。
   */
  contains: (a) => {
    requireArity(a, 'contains', 2);
    const s = reqString(a, 0, 'contains', 'string');
    const m = reqString(a, 1, 'contains', 'match');
    if (s === null || m === null) return null;
    return s.includes(m);
  },
  'starts with': (a) => {
    const s = toStr(a[0] ?? null);
    const m = toStr(a[1] ?? null);
    return s === null || m === null ? null : s.startsWith(m);
  },
  'ends with': (a) => {
    const s = toStr(a[0] ?? null);
    const m = toStr(a[1] ?? null);
    return s === null || m === null ? null : s.endsWith(m);
  },
  /**
   * 长度按**码点**数（不是 UTF-16 单元）：TCK 0083 要求
   * `string length("🐎😀")` = 2、`string length("\uD83D\uDCA9")` = 1。
   */
  'string length': (a) => {
    const s = toStr(a[0] ?? null);
    return s === null ? null : [...s].length;
  },

  // ----- 大小写 -----
  'upper case': (a) => {
    const s = toStr(a[0] ?? null);
    return s === null ? null : s.toUpperCase();
  },
  'lower case': (a) => {
    const s = toStr(a[0] ?? null);
    return s === null ? null : s.toLowerCase();
  },

  // ----- 截取 -----
  /**
   * 位置同样按**码点**计（TCK 0083#substring_004：`substring("🐎foo", 2)` = `"foo"`）。
   * 直接用 `s.slice` 会把代理对切一半，故先摊成 `[...s]` 再切片。
   */
  substring: (a) => {
    const s = toStr(a[0] ?? null);
    const start = toNumber(a[1] ?? null);
    if (s === null || start === null || start === 0) return null;
    const len = a.length > 2 ? toNumber(a[2] ?? null) : null;
    const chars = [...s];
    const from = toIndex(start, chars.length);
    const picked = len === null ? chars.slice(from) : chars.slice(from, from + Math.max(0, len));
    return picked.join('');
  },
  'substring before': (a) => {
    const s = toStr(a[0] ?? null);
    const m = toStr(a[1] ?? null);
    if (s === null || m === null) return null;
    const i = s.indexOf(m);
    return i < 0 ? '' : s.slice(0, i);
  },
  'substring after': (a) => {
    const s = toStr(a[0] ?? null);
    const m = toStr(a[1] ?? null);
    if (s === null || m === null) return null;
    const i = s.indexOf(m);
    return i < 0 ? '' : s.slice(i + m.length);
  },

  // ----- 正则 -----
  replace: (a) => {
    requireArity(a, 'replace', 3, 4);
    const s = reqString(a, 0, 'replace', 'input');
    const pattern = reqString(a, 1, 'replace', 'pattern');
    const rep = reqString(a, 2, 'replace', 'replacement');
    if (s === null || pattern === null || rep === null) return null;
    // flags 是可选形参：省略 / 显式 null 都按"无标志"；非字符串实参（如列表）→ 类型错 → null
    const flagsArg = a.length > 3 ? a[3] : undefined;
    let flags = '';
    if (flagsArg !== undefined && flagsArg !== null) {
      if (typeof flagsArg !== 'string') return null;
      flags = flagsArg;
    }
    return s.replace(compileRegex('replace', pattern, flags, true), translateReplacement(rep));
  },
  matches: (a) => {
    requireArity(a, 'matches', 2, 3);
    const s = reqString(a, 0, 'matches', 'input');
    const pattern = reqString(a, 1, 'matches', 'pattern');
    if (s === null || pattern === null) return null;
    // flags 是可选形参：省略 / 显式 null 都按"无标志"；非字符串实参（如列表）→ 类型错 → null
    const flagsArg = a.length > 2 ? a[2] : undefined;
    let flags = '';
    if (flagsArg !== undefined && flagsArg !== null) {
      if (typeof flagsArg !== 'string') return null;
      flags = flagsArg;
    }
    return compileRegex('matches', pattern, flags, false).test(s);
  },
  split: (a) => {
    requireArity(a, 'split', 2);
    const s = reqString(a, 0, 'split', 'string');
    const delim = reqString(a, 1, 'split', 'separator');
    if (s === null || delim === null) return null;
    return s.split(compileRegex('split', delim, '', false));
  },

  // ----- 拼接 -----
  /**
   * `string join(list, delimiter?)`（DMN 1.4 §10.3.4.5）。
   *
   * 三条口径（TCK 1140 逐条钉死）：
   * 1. `list` 是**字符串列表**；列表里的 `null` 元素**跳过**（006），
   *    非字符串元素（`[1,2,3]`）是类型错 → 抛（013）；
   * 2. 单个字符串会**强转**成单元素列表（015/016：`string join("a","X")` = `"a"`），
   *    但数字 / `null` 不行 → 抛（012/014）；
   * 3. `delimiter` 可省（默认空串）或显式 `null`（004），给了就必须是字符串。
   */
  'string join': (a) => {
    requireArity(a, 'string join', 1, 2);
    const raw = a[0] ?? null;
    let items: readonly Value[];
    if (isList(raw)) {
      items = raw;
    } else if (typeof raw === 'string') {
      items = [raw];
    } else {
      throw argTypeError('string join', 'list', 'list of strings', feelTypeName(raw));
    }
    const parts: string[] = [];
    for (const x of items) {
      if (x === null) continue;
      if (typeof x !== 'string') {
        throw argTypeError('string join', 'list', 'list of strings', feelTypeName(x));
      }
      parts.push(x);
    }
    const d = a.length > 1 ? (a[1] ?? null) : null;
    if (d !== null && typeof d !== 'string') {
      throw argTypeError('string join', 'delimiter', 'string', feelTypeName(d));
    }
    return parts.join(d ?? '');
  },
};
