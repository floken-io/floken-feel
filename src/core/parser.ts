/**
 * floken-feel · 语法分析器（递归下降，零依赖）
 *
 * 支持：字面量 / 算术 / 比较 / 与或非 / 列表 / 区间 / 上下文 / 函数调用 /
 *      路径访问 / if-then-else / for-in-return / every|some-in-satisfies /
 *      `in` / `between` / `instance of` / 函数字面量 /
 *      unary tests（`?` 占位符、区间测试、列表测试、`not(...)`）
 *
 * 带空格的变量名与多词内置名在**词法之后、语法之前**统一合并
 * （`core/name-merge.ts`，与高亮共用同一规则）。
 *
 * 错误一律走 `core/errors.ts` 的工厂：带稳定 `code` + `position`，
 * 期望类错误另带 `details.expected`，供编辑器给出"这里可能漏了一个 `)`"。
 */

import {
  type ArithOp,
  type CompareOp,
  type Node,
  type TypeSpec,
  type Value,
} from './types.js';
import { FEEL_ERROR_CODES, expectedTokenError, syntaxError } from './errors.js';
import { tokenize, type Token } from './lexer.js';
import { mergeNames } from './name-merge.js';
import { SPACED_NAMES } from './spaced-names.js';

const CMP_OPS = new Set(['=', '!=', '<', '<=', '>', '>=']);

/** 泛型缺省参数（`list<>`）当作 `any` */
const ANY_SPEC: TypeSpec = { kind: 'named', name: 'any', start: 0, end: 0 };

/**
 * FEEL **内置**类型名（DMN 1.4 §10.3.5）。
 *
 * ⚠️ 仅供编辑器补全 / 文档参考，**语法分析不再用它做白名单**：
 * `instance of <某模型的 itemDefinition 名>` 是合法的（TCK 0070 的 `t255`、
 * `tNumberList` 即此），名字合法性只有运行期拿到类型表才判得了。
 */
export const INSTANCE_TYPES: ReadonlySet<string> = new Set([
  'any',
  'boolean',
  'number',
  'string',
  'date',
  'time',
  'date and time',
  'dateTime',
  'duration',
  'years and months duration',
  'list',
  'context',
  'range',
  'function',
]);

export interface ParseOptions {
  /** 覆盖「需合并的多词名」表（默认取 `core/spaced-names` 的全局表） */
  spacedNames?: ReadonlySet<string>;
}

class Parser {
  private pos = 0;
  /** >0 表示正在解析区间内部：此时 `[` 属于区间闭合符，不能被当作列表下标 */
  private rangeDepth = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly src: string,
  ) {}

  // ---------- token 工具 ----------

  private cur(): Token {
    const t = this.tokens[this.pos];
    return t ?? { type: 'eof', value: '', start: this.src.length, end: this.src.length };
  }

  private advance(): Token {
    const t = this.cur();
    this.pos += 1;
    return t;
  }

  private at(type: TokenTypeUnion, value?: string): boolean {
    const t = this.cur();
    return t.type === type && (value === undefined || t.value === value);
  }

  private eat(type: TokenTypeUnion, value?: string): boolean {
    if (this.at(type, value)) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expect(type: TokenTypeUnion, value?: string): Token {
    if (!this.at(type, value)) {
      const t = this.cur();
      throw expectedTokenError(value ?? type, t.value, { from: t.start, to: t.end });
    }
    return this.advance();
  }

  private expectName(): Token {
    const t = this.cur();
    if (t.type === 'name' || (t.type === 'kw' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t.value))) {
      this.pos += 1;
      return t;
    }
    throw syntaxError(
      `Expected a name but found '${t.value || 'EOF'}'`,
      { from: t.start, to: t.end },
      { code: FEEL_ERROR_CODES.SYNTAX_EXPECTED_NAME, details: { found: t.value } },
    );
  }

  /** 此处不允许出现的 token（带 expected 便于诊断） */
  private unexpected(): never {
    const t = this.cur();
    throw syntaxError(`Unexpected token '${t.value || 'EOF'}'`, { from: t.start, to: t.end }, {
      code: FEEL_ERROR_CODES.SYNTAX_UNEXPECTED_TOKEN,
      details: { found: t.value || 'EOF' },
    });
  }

  // ---------- 入口 ----------

  parse(): Node {
    const node = this.parseExpression();
    if (!this.at('eof')) this.unexpected();
    return node;
  }

  /** 解析 unary tests：逗号分隔的若干测试项，项间为 OR 语义 */
  parseTests(): Node[] {
    const tests: Node[] = [];
    do {
      tests.push(this.parseUnaryTest());
    } while (this.eat('comma'));
    if (!this.at('eof')) this.unexpected();
    return tests;
  }

  // ---------- 表达式层级 ----------

  private parseExpression(): Node {
    return this.parseLogical();
  }

  private parseLogical(): Node {
    let left = this.parseComparison();
    while (this.at('kw', 'and') || this.at('kw', 'or')) {
      const op = this.advance().value as 'and' | 'or';
      const right = this.parseComparison();
      left = { type: 'logical', op, left, right, start: left.start, end: right.end };
    }
    return left;
  }

  private parseComparison(): Node {
    let left = this.parseAdditive();
    for (;;) {
      // 比较运算符
      if (this.at('op') && CMP_OPS.has(this.cur().value)) {
        const opTok = this.advance();
        const right = this.parseAdditive();
        left = {
          type: 'compare',
          op: opTok.value as CompareOp,
          left,
          right,
          start: left.start,
          end: right.end,
        };
        continue;
      }
      // `x in <区间|列表|上下文|unary tests>`（成员判定）
      if (this.at('kw', 'in')) {
        this.advance();
        const domain = this.parseInDomain();
        left = { type: 'in', value: left, domain, start: left.start, end: domain.end };
        continue;
      }
      // `x between low and high`
      if (this.at('kw', 'between')) {
        this.advance();
        const low = this.parseAdditive();
        this.expect('kw', 'and');
        const high = this.parseAdditive();
        left = { type: 'between', value: left, low, high, start: left.start, end: high.end };
        continue;
      }
      // `x instance of <类型规格>`
      if (this.at('kw', 'instance')) {
        this.advance();
        this.expect('kw', 'of');
        const spec = this.parseTypeSpec();
        left = { type: 'instance', value: left, typeSpec: spec, start: left.start, end: spec.end };
        continue;
      }
      return left;
    }
  }

  private parseAdditive(): Node {
    let left = this.parseMultiplicative();
    while (this.at('op', '+') || this.at('op', '-')) {
      const opTok = this.advance();
      const right = this.parseMultiplicative();
      left = {
        type: 'binary',
        op: opTok.value as ArithOp,
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
    return left;
  }

  private parseMultiplicative(): Node {
    let left = this.parsePower();
    while (this.at('op', '*') || this.at('op', '/')) {
      const opTok = this.advance();
      const right = this.parsePower();
      left = {
        type: 'binary',
        op: opTok.value as ArithOp,
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
    return left;
  }

  /**
   * 幂 `**`：**比 `*` `/` 紧、比一元 `-` 松、左结合**（TCK 0075 / 0105 逐条钉死）。
   *
   * - `5 + 2**5` = 37 → 幂高于加法；
   * - `1.2*10**3` = 1200 → 幂高于乘法（否则会被读成 `(1.2*10)**3` = 1728）；
   * - `-3 ** 2` = 9 → 一元负号先作用（`(-3)**2`），即幂**低于**一元；
   * - `3 ** 4 ** 5` = `(3**4)**5` = 3486784401 → **左结合**（若右结合是 3^1024）。
   */
  private parsePower(): Node {
    let left = this.parseUnary();
    while (this.at('op', '**')) {
      this.advance();
      const right = this.parseUnary();
      left = { type: 'binary', op: '**', left, right, start: left.start, end: right.end };
    }
    return left;
  }

  private parseUnary(): Node {
    if (this.at('op', '-')) {
      const t = this.advance();
      const operand = this.parseUnary();
      return { type: 'unary', op: '-', operand, start: t.start, end: operand.end };
    }
    return this.parsePostfix();
  }

  /** 后缀：`.name` 路径 与 `(...)` 调用，可交错 */
  private parsePostfix(): Node {
    let base = this.parsePrimary();
    for (;;) {
      if (this.at('dot')) {
        this.advance();
        const nameTok = this.expectName();
        base = { type: 'path', base, name: nameTok.value, start: base.start, end: nameTok.end };
        continue;
      }
      if (this.at('lparen')) {
        this.advance();
        const { args, argNames } = this.parseArgs();
        const close = this.expect('rparen');
        base = argNames.some((n) => n !== null)
          ? { type: 'call', callee: base, args, argNames, start: base.start, end: close.end }
          : { type: 'call', callee: base, args, start: base.start, end: close.end };
        continue;
      }
      // `list[x]`：下标 / 过滤统一（FEEL 方括号语义，运行时定夺）
      // 区间内部的 `[`（如 `]1..5[`）是闭合符，不是下标
      if (this.rangeDepth === 0 && this.at('lbracket')) {
        this.advance();
        const condition = this.parseExpression();
        const close = this.expect('rbracket');
        base = { type: 'filter', base, condition, start: base.start, end: close.end };
        continue;
      }
      return base;
    }
  }

  /**
   * 调用实参：`f(1, 2)`（位置）或 `f(n: -1, scale: 2)`（命名，DMN 1.4 §10.3.2）。
   * 命名参数的**对位与校验**留到求值期（要查形参名表，见 `core/function-params.ts`）；
   * 语法层只负责认出 `name :` 这一形态。
   */
  private parseArgs(): { args: Node[]; argNames: (string | null)[] } {
    const args: Node[] = [];
    const argNames: (string | null)[] = [];
    if (this.at('rparen')) return { args, argNames };
    do {
      const t = this.cur();
      const next = this.tokens[this.pos + 1];
      let name: string | null = null;
      if ((t.type === 'name' || t.type === 'kw') && next?.type === 'colon') {
        name = t.value;
        this.advance();
        this.advance(); // 吃掉 `:`
      }
      argNames.push(name);
      args.push(this.parseExpression());
    } while (this.eat('comma'));
    return { args, argNames };
  }

  /**
   * 上下文条目的**键**（FEEL 1.4 §10.3.1.2 只写了 `name | string literal`）。
   *
   * 但 TCK 0057 把"名字"放得比规范宽（`004` 的 `foo bar`、`005` 的 `foo+bar`），
   * 因此这里对非字符串字面量取「**冒号之前的原始源码**」再去掉首尾空白，
   * 而不是拼 token 值 —— 后者会把 `foo+bar` 的空白处理搞错。
   * 字符串字面量仍按字面量取值（`006` 的 `"foo+bar((!!],foo"` 就是靠这条过关）。
   *
   * 重复键的判定不在这里：`{a:1, a:2}` 语法上成立、语义上无定义，
   * 按"语法归语法、语义归语义"放到求值期（`evaluator.ts` 的 `context` 分支）。
   */
  private parseContextKey(): string {
    const t = this.cur();
    if (t.type === 'str') {
      this.advance();
      return t.value;
    }
    if (t.type !== 'name' && t.type !== 'kw') this.expectName(); // 抛带 position 的错
    const from = t.start;
    while (!this.at('colon')) {
      if (this.at('eof') || this.at('rbrace') || this.at('comma')) this.unexpected();
      this.advance();
    }
    return this.src.slice(from, this.cur().start).trim();
  }

  private parsePrimary(): Node {
    const t = this.cur();

    /*
     * `<= 10` / `< 10` / `> 10` / `>= 10` / `= 10` / `!=10`：**前缀一元测试写法**。
     *
     * 端点按 FEEL 10.3.2.5 的等价关系定（`< a` ≡ `(null..a)`、`>= a` ≡ `[a..null)`、`= a` ≡ `[a..a]`），
     * 这样 `1 in <= 10` 与 `(<10).start` / `(<10).end`（TCK 0074）都能直接求值；
     * 另记 `test` 判别位，好让 `=` 区分「前缀写法」与「端点相同的显式区间」
     * —— TCK 0068 要求 `(< 10) = (null..10)` 为 **false**、`(< 10) = (< 10)` 为 **true**。
     * `!=` 是补集、无区间等价端点，只借 `test` 承载写法（`in` 时按"不等"判）。
     */
    if (t.type === 'op' && CMP_OPS.has(t.value)) {
      this.advance();
      const op = t.value;
      const rhs = this.parseAdditive();
      const nullLit: Node = { type: 'lit', value: null, start: t.start, end: t.start };
      const inclusive = op.endsWith('='); // `<=` `>=` `=` `!=` → true；`<` `>` → false
      const start = t.start;
      const end = rhs.end;
      // `= a` / `!= a`：端点都是 `a`，区别只在 `test`（`!=` 的"补集"语义由 `rangeTestMatches` 兜）
      if (op === '=' || op === '!=') {
        return {
          type: 'range',
          from: rhs,
          to: rhs,
          fromInclusive: true,
          toInclusive: true,
          test: op,
          start,
          end,
        };
      }
      const isLower = op === '>' || op === '>=';
      return {
        type: 'range',
        from: isLower ? rhs : nullLit,
        to: isLower ? nullLit : rhs,
        fromInclusive: isLower ? inclusive : false,
        toInclusive: isLower ? false : inclusive,
        test: op,
        start,
        end,
      };
    }

    if (t.type === 'num') {
      this.advance();
      return { type: 'lit', value: Number(t.value) as Value, start: t.start, end: t.end };
    }

    if (t.type === 'str') {
      this.advance();
      return { type: 'lit', value: t.value as Value, start: t.start, end: t.end };
    }

    // 日期时间字面量 @"…" —— 只收原文，类型分派在 `./temporal` 档
    if (t.type === 'atstr') {
      this.advance();
      return { type: 'at', text: t.value, start: t.start, end: t.end };
    }

    if (t.type === 'kw' && (t.value === 'true' || t.value === 'false' || t.value === 'null')) {
      this.advance();
      const value: Value = t.value === 'true' ? true : t.value === 'false' ? false : null;
      return { type: 'lit', value, start: t.start, end: t.end };
    }

    if (t.type === 'kw' && t.value === 'if') {
      this.advance();
      const cond = this.parseExpression();
      this.expect('kw', 'then');
      const thenNode = this.parseExpression();
      this.expect('kw', 'else');
      const elseNode = this.parseExpression();
      return { type: 'if', cond, then: thenNode, else: elseNode, start: t.start, end: elseNode.end };
    }

    if (t.type === 'kw' && t.value === 'for') {
      this.advance();
      const vars = this.parseIterVars();
      this.expect('kw', 'return');
      const body = this.parseExpression();
      return { type: 'for', vars, body, start: t.start, end: body.end };
    }

    if (t.type === 'kw' && (t.value === 'every' || t.value === 'some')) {
      this.advance();
      const kind = t.value as 'every' | 'some';
      const vars = this.parseIterVars();
      this.expect('kw', 'satisfies');
      const satisfier = this.parseExpression();
      return { type: 'quantified', kind, vars, satisfier, start: t.start, end: satisfier.end };
    }

    // 函数字面量 function(a, b) body（闭包捕获定义处上下文）
    if (t.type === 'kw' && t.value === 'function') {
      this.advance();
      this.expect('lparen');
      const params: string[] = [];
      if (!this.at('rparen')) {
        do {
          params.push(this.expectName().value);
          /*
           * **形参类型标注** `function(a: number) a`（DMN 1.4 §10.3.14，TCK 0092/0082）。
           * 标注在此**只解析不保留**：FEEL 的函数体本身不做静态类型检查，
           * 类型由调用方（DMN 的 BKM 调用）在**调用时**校验，不是本层的事。
           */
          if (this.eat('colon')) this.parseTypeSpec();
        } while (this.eat('comma'));
      }
      this.expect('rparen');
      const body = this.parseExpression();
      return { type: 'function', params, body, start: t.start, end: body.end };
    }

    // 分组 或 开区间 (a..b) / (a..b]
    if (t.type === 'lparen') {
      this.advance();
      this.rangeDepth += 1;
      const inner = this.parseExpression();
      if (this.at('range')) {
        this.advance();
        const to = this.parseExpression();
        const closeTok = this.cur();
        if (closeTok.type === 'rparen' || closeTok.type === 'rbracket') {
          this.advance();
          this.rangeDepth -= 1;
          return {
            type: 'range',
            from: inner,
            to,
            fromInclusive: false, // `(` 开头为开区间
            toInclusive: closeTok.type === 'rbracket',
            start: t.start,
            end: closeTok.end,
          };
        }
        this.rangeDepth -= 1;
        throw syntaxError('Unterminated interval', { from: t.start, to: closeTok.end }, {
          code: FEEL_ERROR_CODES.SYNTAX_UNTERMINATED_INTERVAL,
          hint: '区间需用 `)` `]` 收尾，如 `(1..5]`',
        });
      }
      this.expect('rparen');
      this.rangeDepth -= 1;
      return inner;
    }

    // 列表 [a, b] 或 区间 [a..b] / ]a..b[ / [a..b[
    if (t.type === 'lbracket' || t.type === 'rbracket') {
      const open = this.advance();
      const fromInclusive = open.value === '[';
      this.rangeDepth += 1;
      // 空列表 `[]`（`]` 只可能是开区间起始符，不能是空列表）
      if (open.value === '[' && this.at('rbracket')) {
        const close = this.advance();
        this.rangeDepth -= 1;
        return { type: 'list', items: [], start: open.start, end: close.end };
      }
      const first = this.parseExpression();
      if (this.at('range')) {
        this.advance();
        const to = this.parseExpression();
        const closeTok = this.cur();
        if (
          closeTok.type === 'rbracket' ||
          closeTok.type === 'lbracket' ||
          closeTok.type === 'rparen'
        ) {
          this.advance();
          this.rangeDepth -= 1;
          return {
            type: 'range',
            from: first,
            to,
            fromInclusive,
            toInclusive: closeTok.value === ']',
            start: open.start,
            end: closeTok.end,
          };
        }
        this.rangeDepth -= 1;
        throw syntaxError('Unterminated interval', { from: open.start, to: closeTok.end }, {
          code: FEEL_ERROR_CODES.SYNTAX_UNTERMINATED_INTERVAL,
          hint: '区间需用 `]` `[` 收尾，如 `[1..5[`',
        });
      }
      const items = [first];
      while (this.eat('comma')) items.push(this.parseExpression());
      const close = this.expect('rbracket');
      this.rangeDepth -= 1;
      return { type: 'list', items, start: open.start, end: close.end };
    }

    // 上下文 { a: 1, "b c": 2, Mike's age: 3, foo+bar: 4 }
    if (t.type === 'lbrace') {
      this.advance();
      const entries: { key: string; value: Node }[] = [];
      if (!this.at('rbrace')) {
        do {
          const key = this.parseContextKey();
          this.expect('colon');
          const value = this.parseExpression();
          entries.push({ key, value });
        } while (this.eat('comma'));
      }
      const close = this.expect('rbrace');
      return { type: 'context', entries, start: t.start, end: close.end };
    }

    // 名字（带空格的变量名 / 多词内置名已在 token 流合并，见 core/name-merge.ts）
    if (t.type === 'name' || t.type === 'kw') {
      this.advance();
      return { type: 'name', name: t.value, start: t.start, end: t.end };
    }

    return this.unexpected();
  }

  /**
   * `instance of` 右侧的类型规格（DMN 1.4 §10.3.5）：
   * - 具名：`number` / `Any` / `date and time` / 模型 itemDefinition 名（`t255`）
   * - 泛型：`list<Any>` / `range<number>`
   * - 结构：`context<a: string, b: number>`
   * - 函数：`function<> -> Any` / `function<p: string> -> string`
   *
   * **不做白名单校验**：类型名可能来自 DMN 模型的 itemDefinition，
   * 只有运行期拿到类型表才判得了合法性（未知名字运行期按「不匹配」处理）。
   */
  private parseTypeSpec(): TypeSpec {
    const t = this.cur();
    if (t.type !== 'name' && t.type !== 'kw') {
      throw syntaxError(
        `Expected a FEEL type name after 'instance of' but found '${t.value || 'EOF'}'`,
        { from: t.start, to: t.end },
        { code: FEEL_ERROR_CODES.SYNTAX_INSTANCE_OF_TYPE, details: { found: t.value || 'EOF' } },
      );
    }
    this.advance();
    const name = t.value;
    if (!this.at('op', '<')) return { kind: 'named', name, start: t.start, end: t.end };

    this.advance(); // 吃掉 `<`
    const lower = name.toLowerCase();

    // `context<a: T, b: T>`：键值对形式，与其它泛型的「逗号分隔类型」不同
    if (lower === 'context') {
      const entries: { key: string; type: TypeSpec }[] = [];
      if (!this.at('op', '>')) {
        do {
          const keyTok = this.cur();
          if (keyTok.type !== 'name' && keyTok.type !== 'kw' && keyTok.type !== 'str') {
            throw syntaxError(
              `Expected a context key but found '${keyTok.value || 'EOF'}'`,
              { from: keyTok.start, to: keyTok.end },
              { code: FEEL_ERROR_CODES.SYNTAX_INSTANCE_OF_TYPE, details: { found: keyTok.value } },
            );
          }
          this.advance();
          this.expect('colon');
          entries.push({ key: keyTok.value, type: this.parseTypeSpec() });
        } while (this.eat('comma'));
      }
      const close = this.expect('op', '>');
      return { kind: 'context', entries, start: t.start, end: close.end };
    }

    // 其余泛型：逗号分隔的类型参数（`function` 的形参可写成 `p: T`）
    const args: TypeSpec[] = [];
    if (!this.at('op', '>')) {
      do {
        const next = this.tokens[this.pos + 1];
        if (this.cur().type === 'name' && next?.type === 'colon') {
          this.advance();
          this.advance();
        }
        args.push(this.parseTypeSpec());
      } while (this.eat('comma'));
    }
    const close = this.expect('op', '>');

    if (lower === 'list') {
      return { kind: 'list', item: args[0] ?? ANY_SPEC, start: t.start, end: close.end };
    }
    if (lower === 'range') {
      return { kind: 'range', item: args[0] ?? ANY_SPEC, start: t.start, end: close.end };
    }
    if (lower === 'function') {
      const result = this.eat('op', '->') ? this.parseTypeSpec() : null;
      return { kind: 'function', result, start: t.start, end: result?.end ?? close.end };
    }
    // 未知泛型名 → 退化成具名（运行期按未知类型处理）
    return { kind: 'named', name, start: t.start, end: close.end };
  }

  /**
   * `in` 右侧的 domain —— 按 FEEL 10.3.2.4「unary tests」解析，而非普通表达式：
   * - `[` / `]` 开头 → 区间或列表（沿用 primary 的既有语义）
   * - `(` 开头 → 先试区间 `(a..b)`；失败则按括号内**逗号分隔的 unary tests 列表**
   * - `<` `<=` `>` `>=` `=` `!=` 开头 → 单个 unary test（如 `10 in !=10`）
   * - 其余 → 普通表达式（裸值，运行期按「相等」判定）
   *
   * 不能直接 `parseAdditive`：`(1, 5, 9)` 在表达式层是非法语法
   * （FEEL 无通用括号逗号构造），只有 unary tests 上下文才允许。
   */
  private parseInDomain(): Node {
    const t = this.cur();

    if (t.type === 'lbracket' || t.type === 'rbracket') return this.parsePrimary();

    if (t.type === 'lparen') {
      const savePos = this.pos;
      const saveDepth = this.rangeDepth;
      try {
        const grouped = this.parsePrimary();
        // primary 成功且后面不是逗号 → 真正的区间 `(a..b)` 或分组 `(a)`
        if (!this.at('comma')) return grouped;
      } catch {
        // 落到下面按 unary tests 列表重解析（语法错误会在重解析时自然抛出）
      }
      this.pos = savePos;
      this.rangeDepth = saveDepth;
      return this.parseParenTests();
    }

    if (t.type === 'op' && CMP_OPS.has(t.value)) {
      // `<` `<=` `>` `>=` `=` → 仍走 primary 的**区间等价**（保持既有行为，零回归）
      if (t.value !== '!=') return this.parsePrimary();
      // `!=` 无单一区间等价形式 → 单个 unary test（`10 in !=10`）
      const opTok = this.advance();
      const rhs = this.parseAdditive();
      const q: Node = { type: 'name', name: '?', start: t.start, end: t.start };
      return {
        type: 'tests',
        tests: [
          {
            type: 'compare',
            op: '!=',
            left: q,
            right: rhs,
            start: t.start,
            end: rhs.end,
          },
        ],
        start: t.start,
        end: rhs.end,
      };
    }

    return this.parseAdditive();
  }

  /** `(t1, t2, …)`：括号内逗号分隔的 unary tests 列表（项间 OR） */
  private parseParenTests(): Node {
    const open = this.expect('lparen');
    const tests: Node[] = [];
    do {
      tests.push(this.parseUnaryTest());
    } while (this.eat('comma'));
    const close = this.expect('rparen');
    return { type: 'tests', tests, start: open.start, end: close.end };
  }

  private parseIterVars(): { name: string; expr: Node }[] {
    const vars: { name: string; expr: Node }[] = [];
    do {
      const nameTok = this.expectName();
      this.expect('kw', 'in');
      const from = this.parseExpression();
      /*
       * `for i in 2..4 return i`：**裸** `a..b` 是迭代序列，不是区间字面量
       * （TCK 0084#007）。语法层必须在这里接住 —— 表达式层不认 `..`，
       * 否则 `2..4` 会被当成 `2` 后接一个悬空的 `..`（且 `for` 的 `return` 找不到）。
       * 端点用 `parseAdditive`：`for i in 1+1..1+3`（#012）两端都是算术式。
       */
      if (this.at('range')) {
        this.advance();
        const to = this.parseExpression();
        vars.push({
          name: nameTok.value,
          expr: {
            type: 'range',
            from,
            to,
            fromInclusive: true,
            toInclusive: true,
            seq: true,
            start: from.start,
            end: to.end,
          },
        });
        continue;
      }
      vars.push({ name: nameTok.value, expr: from });
    } while (this.eat('comma'));
    return vars;
  }

  /** 单个 unary test 项 */
  private parseUnaryTest(): Node {
    const t = this.cur();

    // not(...) —— 交给通用表达式解析（会形成 call 节点）
    if (t.type === 'kw' && t.value === 'not') {
      return this.parseExpression();
    }

    // `in <区间|列表>` → ? in domain
    if (t.type === 'kw' && t.value === 'in') {
      this.advance();
      const domain = this.parseExpression();
      const q: Node = { type: 'name', name: '?', start: t.start, end: t.start };
      return { type: 'in', value: q, domain, start: t.start, end: domain.end };
    }

    // 以比较运算符开头：< 2 / >= x / != 5  →  ? op rhs
    if (t.type === 'op' && CMP_OPS.has(t.value)) {
      this.advance();
      const op = t.value as CompareOp;
      const rhs = this.parseExpression();
      const q: Node = { type: 'name', name: '?', start: t.start, end: t.start };
      return { type: 'compare', op, left: q, right: rhs, start: t.start, end: rhs.end };
    }

    // 区间 / 列表：交给 primary（会形成 range 或 list 节点）
    if (t.type === 'lbracket' || t.type === 'rbracket' || t.type === 'lparen') {
      return this.parsePrimary();
    }

    // 其它表达式：若本身已是布尔型结构则原样返回，否则视为 `? = expr`
    const node = this.parseExpression();
    if (
      node.type === 'compare' ||
      node.type === 'logical' ||
      node.type === 'call' ||
      node.type === 'in' ||
      node.type === 'between' ||
      node.type === 'instance'
    ) {
      return node;
    }
    const q: Node = { name: '?', type: 'name', start: node.start, end: node.start };
    return { type: 'compare', op: '=', left: q, right: node, start: node.start, end: node.end };
  }
}

type TokenTypeUnion = Token['type'];

/**
 * 供语法分析使用的 token 流：
 * 1. 剔除注释（词法始终产出 `comment` token 供高亮用，语法不关心）；
 * 2. 合并名字（与高亮共用 `core/name-merge.ts`，保证边界一致）。
 */
function significant(src: string, spaced: ReadonlySet<string>): Token[] {
  const tokens = tokenize(src).filter((t) => t.type !== 'comment');
  return mergeNames(tokens, spaced);
}

/** 解析一个完整 FEEL 表达式 */
export function parseExpression(src: string, opts: ParseOptions = {}): Node {
  return new Parser(significant(src, opts.spacedNames ?? SPACED_NAMES), src).parse();
}

/** 解析 unary tests（决策表输入项），返回测试项数组（逗号 = OR） */
export function parseUnaryTests(src: string, opts: ParseOptions = {}): Node[] {
  return new Parser(significant(src, opts.spacedNames ?? SPACED_NAMES), src).parseTests();
}
