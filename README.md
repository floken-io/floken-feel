# @floken-io/feel

[![npm](https://img.shields.io/npm/v/@floken-io/feel)](https://www.npmjs.com/package/@floken-io/feel)
[![license](https://img.shields.io/npm/l/@floken-io/feel)](./LICENSE)

FEEL（Friendly Enough Expression Language）的独立实现：给一串表达式 + 一组变量，返回一个值，外加一组诊断。

自研词法/语法分析器，运行时依赖只有时态档需要的 `temporal-polyfill`（语言内核零依赖）。

## 安装

```bash
npm i @floken-io/feel
```

## 快速开始

```ts
import { evaluate, unaryTest } from '@floken-io/feel';

evaluate('1 + 2');                                // { value: 3, warnings: [] }
evaluate('a * b', { a: 3, b: 4 });                // { value: 12, warnings: [] }
evaluate('user.name', { user: { name: 'Lisa' } }); // { value: 'Lisa', ... }

unaryTest('< 10', { '?': 5 });                    // { value: true, warnings: [] }
unaryTest('[1..end]', { '?': 1, end: 10 });       // { value: true, warnings: [] }
```

运行期问题**不抛异常**，而是降级为 `null` 并产出诊断：

```ts
const { value, warnings } = evaluate('x');
// value === null
// warnings: [{ severity: 'warn', code: 'FEEL_EVAL_NO_VARIABLE',
//              message: "Variable 'x' not found", start: 0, end: 1 }]
```

语法错误抛 `FeelSyntaxError`（快速失败）；编辑器场景请用 `./editor` 的 `diagnose()`，它返回诊断数组而不抛异常。

## 四个子入口

| 入口 | 内容 |
|---|---|
| `.` | parse + 求值 + 三值逻辑 + 内置函数（**无时态**） |
| `./unary-tests` | unary tests（S-FEEL），`?` 为被测输入 |
| `./temporal` | date / time / duration + JS 侧值桥 |
| `./editor` | 解析 + AST + 诊断 + 语法着色（**不含求值器**，可进浏览器） |

```ts
import { unaryTest } from '@floken-io/feel/unary-tests';
import { toFeel, evaluateTemporal } from '@floken-io/feel/temporal';
import { diagnose, highlight } from '@floken-io/feel/editor';
```

## 语言特性

- 字面量：`1` `1.5` `1.2e3` `"str"` `true` `false` `null`；空列表 `[]`
- 名字可含空格与撇号：`Applicant Age`、`Mike's daughter`、上下文键 `{ Mike's age: 3 }`、路径步 `a.b c`
- 算术 `+ - * / **`、一元 `-`、取负 duration
- 比较 `= != < <= > >=`
- 类型判定 `x instance of number` / `list` / `context` / `range` / `function` …
- 逻辑 `and` / `or` / `not(...)`
- 成员判定 `x in [1..10]` / `x in ["a","b"]` / `"k" in { k: 1 }`
- 区间判定 `x between 1 and 10`
- 区间字面量 `[1..5]` `]1..5[` `[1..5)` `(1..5]`，及字符串构造 `range("[18..21)")`
- 列表与**方括号统一语义**：数字 → 下标（1-based，负号倒数）；列表 → 多下标；否则 → 过滤
  - `[1,2,3][-1]` → `3`　`[10,20,30][[1,3]]` → `[10,30]`　`[1,2,3,4][item > 2]` → `[3,4]`
- 上下文 `{ a: 1, b: "x" }`、路径 `a.b.c`，**后一项可见前一项**（`{ a: 1, b: a + 1 }.b` → `2`）
- 控制：`if … then … else …`、`for x in list return …`、`every|some x in list satisfies …`
- 函数字面量 `function(a, b) a + b`，闭包捕获定义处上下文
- 时间字面量 `@"2020-01-01"` `@"PT5H"`
- 注释 `// …` 到行尾

## 内置函数

标准 FEEL 名（含带空格者）**同时**提供 camelCase 别名，两种写法都能调用：

```ts
evaluate('string length("abc")').value;  // 3
evaluate('stringLength("abc")').value;   // 3
```

| 类别 | 函数 |
|---|---|
| 数值 | `decimal` `floor` `ceiling` `abs` `modulo` `sqrt` `log` `exp` `odd` `even` `round` `round half up` `round half down` |
| 聚合 | `min` `max` `sum` `mean` `median` `product` `stddev` |
| 字符串 | `string` `string length` `upper case` `lower case` `contains` `starts with` `ends with` `substring` `substring before` `substring after` `replace` `matches` `split` `string join` |
| 列表 | `list contains` `count` `sublist` `append` `concatenate` `insert before` `remove` `reverse` `index of` `union` `distinct values` `flatten` `sort` `mode` `list replace` |
| 布尔 | `not` `and` `or` `all` `any` |
| 转换 | `string` `number` |
| 上下文 | `get value` `get entries` `context` `context put` `context merge` |
| 区间 | `before` `after` `meets` `met by` `overlaps` `overlaps before` `overlaps after` `finishes` `finished by` `includes` `during` `starts` `started by` `coincides` `is` `range` |
| 函数 | `invoke` |
| 时间 | 见 `./temporal` 档 |

扩展点：

```ts
import { registerBuiltin } from '@floken-io/feel';

registerBuiltin('double', (args) => {
  const n = (args[0] ?? null) as number | null;
  return n === null ? null : n * 2;
});
evaluate('double(21)').value; // 42
```

## 三值逻辑

`null` 表示「未知」。它参与的比较/布尔运算结果是 `null`，**不会**静默变成 `false`：

```ts
evaluate('null < 1').value;       // null（未知）
evaluate('null = 1').value;       // false
evaluate('null = null').value;    // true
evaluate('true and null').value;  // null
evaluate('false and null').value; // false
evaluate('true or null').value;   // true
```

## 错误与诊断

两条通道**互不混用**：**「重试也救不回来」→ 抛；「换个输入还有救」→ 诊断。**

| 通道 | 场景 | 形态 |
|---|---|---|
| 抛 | 语法/词法非法、未知选项、能力未加载（`./temporal`）、S-FEEL 白名单越界、资源超限 | `FeelError` 子类 |
| 诊断 | 变量/属性/函数找不到、类型不匹配降级 | `Diagnostic[]`（走 `warnings`） |

```ts
import { FeelError, FEEL_ERROR_CODES, FEEL_DIAGNOSTIC_CODES } from '@floken-io/feel';

try {
  evaluate('date("2020-01-01")');       // 未加载 ./temporal
} catch (e) {
  if (e instanceof FeelError) {
    e.code;    // 'FEEL_NOT_LOADED_TEMPORAL'
    e.hint;    // 修复提示：await import("@floken-io/feel/temporal")
    e.details; // { function: 'date', module: '@floken-io/feel/temporal' }
  }
}
```

错误码是**稳定契约**：命名 `<域>_<类别>_<对象>`、全大写蛇形，发布后只增不改。抛出码与诊断码分属两个命名空间（诊断码统一带 `EVAL_`）。

```ts
interface Diagnostic {
  severity: 'error' | 'warn' | 'info';
  code: string; message: string;
  start: number; end: number;   // 0-based、左闭右开
  expected?: string[];
  suggestions?: string[];
}
```

### 求值选项

```ts
evaluate('now()', ctx, {
  clock: () => new Date('2026-03-01T09:30:00'), // 注入时钟，钉死时态测试
  allowedFunctions: ['abs', 'count'],           // S-FEEL 白名单（越界抛错）
  maxNodes: 500, maxDepth: 32, timeoutMs: 200,  // 资源上限（超限抛错）
  builtins: { double: (args) => null },         // 覆盖/扩展内置表
});
```

未知选项抛 `FEEL_OPTION_UNKNOWN`，**不静默忽略**。算术操作数**只收真数字**：`10 + "10"` 是类型错误（降级 `null` + 诊断），`+` 唯一的串用法是 `string + string` 拼接。

> `timeoutMs` 是协作式的：同步求值无法强杀，只在求值步之间的检查点生效。要硬隔离请用 `maxNodes` / `maxDepth`，或把求值放进 worker。

## 时间档 `./temporal`

表达式里的 `date("…")` / `now()` 是 FEEL 内置函数；本档另提供**给 JS 代码用**的时态 API——把 `new Date()` 转成能塞进 `context` 的 FEEL 值。不转的话它会被当成普通对象，比较结果是 `null` 且**没有诊断**。

```ts
import { toFeel, evaluateTemporal } from '@floken-io/feel/temporal';

const x = toFeel(new Date('2020-06-01T00:00:00Z')); // → date and time，按 UTC 记
evaluateTemporal('x > date and time("2020-01-01T00:00:00Z")', { x }); // → { value: true, … }
```

**import 即注册**：本档是该包唯一的副作用档，import 时自动加载时态实现并注册时间函数。

```ts
import '@floken-io/feel/temporal';
import { evaluate } from '@floken-io/feel';

evaluate('year(date("2020-01-01"))').value;  // 2020
```

未加载就调用 → 抛 `FEEL_NOT_LOADED_TEMPORAL`，提示里给的修复动作就是上面那句 `import`。也可用不依赖全局注册的 `evaluateTemporal(src, ctx?, options?)`。

| 类别 | API |
|---|---|
| 值桥 | `toFeel(v)`（按 UTC 记，避免随部署机器时区漂移）、`unwrap(v)` |
| 判定 | `isDate` `isTime` `isDateTime` `isDuration` `isZoned` `zoneEquals` |
| 分量 | `year` `month` `day` `hour` `minute` `second` `dayOfWeek`（**1 = 周一**）`timezone` `timeOffset` |
| 构造 | `date` `time` `dateAndTime` `duration` `dateFrom` `timeFrom` `dateOfValue` `timeOfValue` `combine` `now` `today` |
| 运算 | `addDuration` `subtractTemporals` `addDurations` `absDuration` `durationEquals` `toComparable` |

时态值以数据对象表示（`{ __feelTemporal, kind, iso, raw, … }`），分量用**函数**读（`year(v)` 而非 `v.year`）；要读底层对象用 `unwrap(v)`。时长分量跨类访问返回 `null`（规范口径）：`years` / `months` 只属 years and months duration，`days` / `hours` / `minutes` / `seconds` 只属 days and time duration。

## 编辑器档 `./editor`

面向表达式编辑器：解析 + 诊断 + 语法着色，**不含求值器与内置函数库**（因此很轻，可随设计器进浏览器）。

```ts
import { diagnose, tokens, parse, parseWithDiagnostics, highlight } from '@floken-io/feel/editor';

diagnose('1 +');            // [{ severity: 'error', code: 'FEEL_SYNTAX_UNEXPECTED_TOKEN', start: 3, end: 3 }]
diagnose('(1 + 2');         // [{ code: 'FEEL_SYNTAX_EXPECTED_TOKEN', expected: ['rparen'],
                            //    suggestions: ['此处可能漏了 `)`'], start: 6, end: 6 }]
diagnose('1 + 2');          // []
parseWithDiagnostics('1 +'); // { ast: null, diagnostics: [...] }  ← 不抛
```

`highlight(src)` 返回单调不重叠的 span 数组，`value` 为源码原样切片，配色由宿主决定。`kind` 取值：

`keyword` / `boolean` / `null` / `number` / `string` / `temporal` / `function` / `variable` / `operator` / `punctuation` / `comment` / `error`

```ts
highlight('if a > 1 then "x" else null // c');
// [ { kind: 'keyword',  value: 'if',   from: 0,  to: 2  },
//   { kind: 'variable', value: 'a',    from: 3,  to: 4  },
//   { kind: 'operator', value: '>',    from: 5,  to: 6  }, … ]
```

源码非法时**不整段失效**，而是降级为「已识别部分 + 尾部 `error` 区间」——编辑器边打字边着色时，前面的字符仍然该着色：

```ts
highlight('1 + "abc');   // 未闭合字符串
// [ { kind: 'number',   value: '1',    from: 0, to: 1 },
//   { kind: 'operator', value: '+',    from: 2, to: 3 },
//   { kind: 'error',    value: '"abc', from: 4, to: 8 } ]   ← 只有坏掉的那一段是 error
```

### 在浏览器里跑

产物是纯 ESM，dist 里**零 `node:` 内置依赖、零 DOM 依赖**，不需要打包器：

```html
<script type="module">
  import { diagnose, highlight } from '/node_modules/@floken-io/feel/dist/editor.js';

  const diags = diagnose(src);   // 不抛，带 start/end，直接画波浪线
  const spans = highlight(src);  // 着色（非法时降级，不整段消失）
</script>
```

完整可运行示例见 [`examples/browser-lint.html`](./examples/browser-lint.html)（需用 http 打开，例如 `python -m http.server`；`file://` 下浏览器会拦 ES module）。

网页端做错误提示的姿势：**语法错误 → `diagnose()`**（一次列全部、带位置）；**运行期问题 → `evaluate()` 的 `warnings`**。不要用 `errorMode: 'throw'` 当校验——它只报第一个错且丢掉 `value`。

## 标准符合性

本包用 **DMN TCK 的 FEEL 断言子集**自证：官方 79 个 FEEL label，共 2053 条断言。

其中 58 条按能力边界登记为 IGNORED（机器可读清单在 `tooling/tck/ignored.json`，理由逐条写死在 [`known-gaps.md`](./known-gaps.md)）——它们考的不是 FEEL 表达式层：`0076-feel-external-java`（18 条需 JVM）、`0082-feel-coercion`（36 条属 DMN 声明类型强制，归 `@floken-io/dmn`）。IGNORED 不进分子分母，**计分基数是 1995 条**。

| 入口 | `errorMode` | 语义 | 成绩 |
|---|---|---|---|
| `evaluate(src)` | `'null'`（**默认**） | 规范语义：`null` + 诊断 | **1995 / 1995（100%）** |
| `evaluateStrict(src)` | `'throw'` | 严格口径：抛 `FeelError` | **1995 / 1995（100%）** |

79 个 label 中 77 组满分、0 组失败。基线分两套存（`baseline.labels.json` / `baseline.labels.strict.json`），重跑后任一组低于它即判退化。

> 完整 DMN TCK（含 DRG 遍历 / 决策表 / 命中策略）归 [`@floken-io/dmn`](https://www.npmjs.com/package/@floken-io/dmn)，本包没有 DMN 引擎，跑不出来。

跑分工具在 `tooling/tck/`（自研 XML 扫描器 + 提取器 + 跑分器，零依赖），判定规则写死在 `tooling/tck/README.md`。TCK 语料**不随包分发**（CC BY-SA 有传染性），由 `check:tck-isolation` 门禁强制。

## 已知边界

- 未实现 `for … in … return` 的 `partial` 修饰、`function(…) external { … }`
- `instance of` 的类型名不含 `day-time duration`（含 `-`，与减法词法冲突；需要时用 `duration` 判定）
- `date` / `time` / `dateTime` 互不可比较，`duration` 不可比较
- 名字字符集有意偏离 FEEL：只纳入 `'` 与 `^`，`- + * / .` 保留运算/路径语义
- 不支持 B-FEEL 方言与隐式 `date → date and time` 转换

详见 [`known-gaps.md`](./known-gaps.md)。

## 相关包

| 包 | 用途 |
|---|---|
| [`@floken-io/feel`](https://www.npmjs.com/package/@floken-io/feel) | FEEL 表达式语言（本包） |
| [`@floken-io/moddle`](https://www.npmjs.com/package/@floken-io/moddle) | BPMN 2.0 模型与 XML 双向转换 |
| [`@floken-io/dmn`](https://www.npmjs.com/package/@floken-io/dmn) | DMN 1.5 决策引擎 |
| `@floken-io/engine` | 流程内核与审批动作（开发中） |
| `@floken-io/designer` | 流程画布与审批配置面板（开发中） |

## 开发

```bash
npm install
npm run build
npm run verify   # 门禁：types / tests / pack / tck-isolation / deps
npm run tck      # FEEL 断言跑分（2053 断言 / 计分 1995；加 --strict 走严格口径）
```

## 许可证

[Apache-2.0](./LICENSE)
