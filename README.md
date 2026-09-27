# @floken-io/feel

FEEL（Friendly Enough Expression Language）表达式语言的独立实现：
给一串字符串 + 一组变量，返回一个值（外加一组诊断 warnings）。

> 五个包里排**第一**施工（Q22）。需求见 `流程引擎包文档/05-包需求-floken-feel.md`。
> **当前进度：F3 收官（2026-09-26）** —— F0 语言内核 → F1（方括号统一语义 / `in` / `between` /
> 函数字面量 / 语法着色）→ F2（空格名与撇号名 / `instance of` / `clock` 注入 / S-FEEL 白名单 /
> 资源上限 / **错误与诊断契约**）→ F3（自研 parser + 时态 / 三值 / 区间 / 类型强制收敛）。
> **官方 DMN TCK · B 口径：1995/1995（100%）**，79 个 FEEL label 中 77 组满分、0 组失败（详见 §1.3）。

---

## 1. 公开 API

形态**对标 feelin**（`{ value, warnings }`），实现完全自研（Q9：feelin 源码只读不拷）。

```ts
import { evaluate, unaryTest } from '@floken-io/feel';

evaluate('1 + 2');                       // { value: 3, warnings: [] }
evaluate('a * b', { a: 3, b: 4 });       // { value: 12, warnings: [] }
evaluate('user.name', { user: { name: 'Lisa' } }); // { value: 'Lisa', ... }

unaryTest('1', { '?': 1 });              // { value: true,  warnings: [] }
unaryTest('[1..end]', { '?': 1, end: 10 }); // { value: true, warnings: [] }
unaryTest('< 10', { '?': 5 });           // { value: true,  warnings: [] }
```

运行期问题**不抛异常**，而是降级为 `null` 并产出诊断：

```ts
const { value, warnings } = evaluate('x');
// value === null
// warnings: [{
//   severity: 'warn',
//   code: 'FEEL_EVAL_NO_VARIABLE',
//   message: "Variable 'x' not found",
//   start: 0, end: 1,
// }]
```

**语法错误**会抛 `FeelSyntaxError`（快速失败）；要做编辑器实时提示请用 `./editor` 的
`diagnose()`，它返回诊断数组而不抛异常。

---

## 1.1 错误处理契约（仓库根 `AGENTS.md` §5 的落地）

两条通道**不许混用**：**「重试也救不回来」→ 抛；「换个输入还有救」→ 诊断。**

| 通道 | 场景 | 形态 |
|---|---|---|
| **抛** | 语法/词法非法、选项契约破坏（未知选项、非法值）、能力未加载（`./temporal`）、S-FEEL 白名单越界、资源上限 | `FeelError` 子类 |
| **诊断** | 变量/属性/函数找不到、类型不匹配降级 | `Diagnostic[]`（走 `warnings`） |

```ts
import {
  FeelError, FeelSyntaxError, FeelOptionError,
  FeelNotLoadedError, FeelLimitError, FeelNotAllowedError,
  FEEL_ERROR_CODES, FEEL_DIAGNOSTIC_CODES,
} from '@floken-io/feel';

try {
  evaluate('date("2020-01-01")');          // 核心未加载时间档
} catch (e) {
  if (e instanceof FeelError) {
    e.code;    // 'FEEL_NOT_LOADED_TEMPORAL'
    e.pkg;     // 'feel'
    e.hint;    // 修复提示
    e.details; // { function: 'date', module: '@floken-io/feel/temporal' }
    // message: 'temporal functions require: await import("@floken-io/feel/temporal")'
  }
}
```

**错误码是稳定契约**：命名 `<域>_<类别>_<对象>`、全大写蛇形，**发布后不得改名**，只能新增。
抛出码与诊断码分属两个命名空间（诊断码统一带 `EVAL_`）。

**`Diagnostic` 形状**（= `05-feel` §6 + `severity`）：

```ts
interface Diagnostic {
  severity: 'error' | 'warn' | 'info';
  code: string; message: string;
  start: number; end: number;      // 0-based、左闭右开
  expected?: string[];             // 期望的 token
  suggestions?: string[];          // 「此处可能漏了 `)`」
}
```

一致性由 `test/errors.test.ts` 兜底（错误形状、码表命名、去重、双命名空间不重叠、延迟能力不漂移）。

---

## 1.2 求值选项（`EvaluateOptions`）

```ts
evaluate('now()', ctx, {
  clock: () => new Date('2026-03-01T09:30:00'), // ★ 注入时钟，钉死时态测试
  allowedFunctions: ['abs', 'count'],           // S-FEEL 白名单（越界抛错）
  maxNodes: 500, maxDepth: 32, timeoutMs: 200,  // 资源上限（超限抛错）
  builtins: { double: (args) => /* … */ null }, // 覆盖/扩展内置表
});
```

| 选项 | 作用 | 违反时 |
|---|---|---|
| `clock` | `now()` / `today()` 的时间来源（`05-feel` §6.1：不注入则时态测试无法稳定） | — |
| `allowedFunctions` | S-FEEL 子集白名单（`03-engine` §7.2：**越界必须报错，不能静默求值**） | 抛 `FEEL_NOT_ALLOWED_FUNCTION` |
| `maxNodes` / `maxDepth` / `timeoutMs` | 防构造型输入与失控求值 | 抛 `FEEL_LIMIT_MAX_NODES` / `_MAX_DEPTH` / `_TIMEOUT` |
| 算术操作数 | **只收真数字**：`10 + "10"` / `10 * "10"` … 是类型错误（规范算符表无"字符串→数字"一档，TCK 0100 的 14 条 `error_when_*` 钉死）。`+` 唯一合法的串用法是 `string + string` → 拼接；隐式转换属 **DMN typeRef 强制**（`@floken-io/dmn` 的 `coerceTypeRef`） | 降级 `null` + 诊断 |
| `builtins` | 覆盖/扩展内置函数表（`./temporal` 正是这样注入的） | — |
| 未知选项 | — | 抛 `FEEL_OPTION_UNKNOWN`（**禁止静默忽略**） |

> `timeoutMs` 是**协作式**的：同步求值无法强杀，只在求值步之间（每 128 步）的检查点生效。
> 要硬隔离请用 `maxNodes` / `maxDepth`，或把求值放到 worker 里由宿主中断。

### 与 feelin 的差异（有意为之）

| 项 | feelin | @floken-io/feel |
|---|---|---|
| 语法错误 | 容错恢复 | 抛 `FeelSyntaxError`（另有 `diagnose()` / `parseWithDiagnostics()` 走不抛路径） |
| 结果壳 | `{ value, warnings }` | **同样**（保留兼容） |
| 诊断元素 | `{ message, type, position }` | `Diagnostic`：`{ severity, code, message, start, end, expected?, suggestions? }`（= `05-feel` §6 + `severity`） |
| 时间函数 | 主入口内置 | 放在 `./temporal`（NFR-F12 隔离，**必需依赖 `temporal-polyfill`**）；**import 即注册** —— 未加载时调用抛「带可执行修复提示」的错误 |
| 带空格内置名 | 上下文相关解析 | 标准名 **+ camelCase 别名** 双注册；名字合并规则与高亮共用 |
| 自定义内置函数 | — | `registerBuiltin(name, fn)` |
| 求值选项 | 无 | `clock` / `allowedFunctions` / `maxNodes` / `maxDepth` / `timeoutMs` / **`errorMode`** |
| **严格口径求值**（错误改为抛） | 无 | **`evaluateStrict(src, ctx?, opts?)`**（= `errorMode:'throw'`） |

---

## 1.3 TCK 口径与当前成绩（2026-09-25 首跑；2026-09-26 第八轮 · **双口径 100%**）

本包用 **DMN TCK 的 B 口径**自证：官方 **79 个 FEEL label**（`TestCases/*/*-feel-*`），共 **2053 条断言**。

其中 **58 条按 NFR-F14 登记 IGNORED**（机器可读在 `tooling/tck/ignored.json`，
可读化与补充见 **[`known-gaps.md`](./known-gaps.md)**，理由逐条写死）——它们不是"我们做错了"，
而是**该断言考的能力不属于 FEEL 表达式层**，或 **TCK 自身矛盾**：`0076-feel-external-java`（18 条，Java 绑定要 JVM）、
`0082-feel-coercion`（36 条，考的是 DMN 声明类型与值之间的强制转换，归属 `@floken-io/dmn`），
外加单条 `0057#009/#010`（`{a:1}.b` / `null.b`：description 写 "results in null" 却标 `errorResult`，从规范）、
`0092#013`（decisionService 调用，与 0082 同族）、`0092#009`（**boxed context 的 result entry**，
跑分器摊平成 FEEL 文本时丢了这一层 → 提取器失真）。
IGNORED 不进任何口径的分子分母，单独记 ⊘，故**计入口径是 1995 条**。

> ⚠️ **全绿 ≠ 口径正确**：TCK 2053 条里 `sum` / `mean` / `min(` / `max(` / `union(` / `round(`
> **命中 0 条**，字符串函数也没有「传非字符串实参」的用例。本包曾把这些实现成 B-FEEL 语义
> （`sum([1,null,3])` 得 4、`string length(22)` 得 2）却依然 1995/1995。
> 现由 `test/feel-dialect.test.ts`（IBM 官方 B-FEEL↔FEEL 对照表 26 条）与
> `test/aggregates.test.ts` 钉死 FEEL 口径 —— 详见 `known-gaps.md` §2。

### ★ 两套口径，两个入口 —— 不用二选一，且都是 100%

规范（DMN 1.4 §10.3.2.13.1：实参不符参数域 → 结果是 `null`）与 TCK（`errorResult="true"`：
期望抛错）长期冲突。本包**同时满足两者**，把选择权交给调用方：

| 入口 | `errorMode` | 语义 | 分数 |
|---|---|---|---|
| `evaluate(src)` | `'null'`（**默认**） | 规范语义：`null` + 诊断 | **1995/1995（100.0%）** |
| `evaluateStrict(src)` | `'throw'` | TCK 严格口径：抛 `FeelError` | **1995/1995（100.0%）**，`errorResult` 缺口 0 |

```ts
evaluate('abs(null)')        // { value: null, warnings: [{ code: 'FEEL_EVAL_ARG_TYPE', ... }] }
evaluateStrict('abs(null)')  // throw FeelTypeError  code: 'FEEL_EVAL_ARG_TYPE'
```

内置函数**一律抛**（没有"静默 `return null`"），由 `call` 边界按模式统一处置 ——
**一条代码路径供两种口径**，故默认模式的值不变（仍是 `null`，只是多了诊断）。
跑分器加 `--strict` 即走严格口径（`node tooling/tck/run.mjs --strict`）。

⚠️ 两种模式**都抛**（不受开关影响）：`@"…"` 构造器字面量语法错、能力未加载 /
S-FEEL 白名单越界 / 语法错 / 资源上限。

79 组中 **77 组满分**（另 2 组整组 IGNORED），**0 组有失败**；基线**两套分开存**：
`baseline.labels.json`（默认）与 `baseline.labels.strict.json`（严格），重跑后任一组低于它即判退化。

**第八轮清掉的 8 条 mismatch**（此前记为"值算错，与错误模式无关"，现已全部归零）：

| 缺口 | 根因 | 处置 |
|---|---|---|
| `1111#K2-1`（1） | x 模式下把 `\ ` 当成"转义的字面空格"（照搬 Java `Pattern.COMMENTS`），与 TCK 相反 | 照 `description`「Whitespace… is **collapsed**」折叠 → `hello\sworld`（`\s` 空白字符类）→ true |
| `1115`×4 / `1117`×2（6） | 9 位年份超出 `temporal-polyfill` 范围（±275760） | 新增 `extendedYear()`：**不经过 Temporal**（`raw` 为 `null`、`iso` 用原文），`string()` 原样输出；运算退回 `null`；月/日/闰年我们自己校验，非法写法照旧抛 |
| `0092#009`（1） | 判成"TCK 自相矛盾"是**臆断** —— 回原始 `.dmn` 看，它是 **boxed context 的 result entry**，而 `0057#007` 的 `{"": "foo"}` 是 FEEL 字面量的合法空键名 | 属**提取器失真** → 按 `label#id` 登记 IGNORED（若改 FEEL 语义，`0057#007` 会立刻翻车，+1 −1 = 0） |

> ⚠️ **「2053」与「1995」的关系**：2053 = 79 个 FEEL label 的**全部断言**（一条没少）；
> 1995 = 2053 − 58 IGNORED，是**计分基数**。IGNORED 既不进分子也不进分母，故分数是 100%。
> 另：**3495 / 3391 是 A 口径**（完整 DMN TCK，含决策表与 DRG 遍历），归 `@floken-io/dmn`，**不是本包的账**。

> ⚠️ **别拿 `3391 / 3495` 来问本包** —— 那是 **A 口径**（完整 DMN TCK，含 DRG 遍历 / 决策表 / 命中策略），
> 归属于 `@floken-io/dmn`；本包没有 DMN 引擎，跑不出来。本包能自证的官方上限就是上面这 2053。

跑分工具在 `tooling/tck/`（自研 XML 扫描器 + 提取器 + 跑分器，零依赖）；
**裁判规则（怎么算相等）写死在 `tooling/tck/README.md`** —— 官方规范了输入输出却没有规范判定，这一层必须自己公开写死。
语料**不随包分发**（DMN TCK 的 test cases 是 CC BY-SA，Share-Alike 有传染性），由 `check:tck-isolation` 门禁强制。

---

## 1.4 JS 侧时态 API（`./temporal` 的值桥）

> **先分清两层**：表达式里的 `date("…")` / `now()` / `today()` 是 **FEEL 内置函数**（106 个规范名内，早已可用）；
> 本节是**另一层** —— 给你的 **JS 代码**用的：直接构造 / 解析 / 运算 FEEL 时态值（对标 `feelin` 的 `./temporal` 导出面）。

**典型用途**：把 `new Date()` 转成能塞进 `context` 的 FEEL 值。不转的话它会被当成普通对象，
比较结果是 `null` **且没有诊断**（跨类型排序比较的规范行为）—— 这是最容易踩的静默坑。

```ts
import { toFeel, evaluateTemporal } from '@floken-io/feel/temporal';

const x = toFeel(new Date('2020-06-01T00:00:00Z')); // → date and time，按 UTC 记
evaluateTemporal('x > date and time("2020-01-01T00:00:00Z")', { x }); // → { value: true, … }
```

| 类别 | API |
|---|---|
| **值桥** | `toFeel(v)` —— `Date` → date and time（**按 UTC 记**，避免随部署机器时区漂移）；`Temporal.*` 实例按 `Symbol.toStringTag` 分派；已是 FEEL 值 → 原样返回；其余**原样透传**（桥不制造新失败） |
| **判定** | `isDate` `isTime` `isDateTime` `isDuration` `isZoned` `zoneEquals` |
| **分量** | `year` `month` `day` `hour` `minute` `second` `dayOfWeek`（**1 = 周一**）`timezone` `timeOffset` |
| **时长分量** | `years` `months` 只属 **years and months duration**；`days` `hours` `minutes` `seconds` 只属 **days and time duration**；**跨类访问 → `null`**（规范口径） |
| **构造** | `date` `time` `dateAndTime` `duration`（数字按**秒**解释）`dateFrom` `timeFrom` `dateOfValue` `timeOfValue` `combine` `now` `today`（后两者可注入 `clock`） |
| **运算** | `addDuration` `subtractTemporals` `addDurations` `absDuration` `durationEquals` `toComparable` |
| **逃生口** | `unwrap(v)` → 底层 `Temporal.*` 对象 |

> ⚠️ **与 `feelin` 的形态差异**：本包的时态值是**数据对象**（`{__feelTemporal, kind, iso, raw, …}`）而不是类，
> 所以分量用**函数**读（`year(v)`）而不是 `v.year`。把值改成类会牵动 `eqKey` / `identity` / 比较 / JSON 序列化，
> 风险与收益不成比例；要读底层对象请用 `unwrap(v)`。

> ⚠️ **分量构造不规整**：`dateFrom(y, m, d)` / `timeFrom(h, m, s)` 对「月内没有这一天」返回 `null`，
> **不会**把 `2020-02-30` 规整成 `2020-02-29`（Temporal 对象分量的 overflow 默认是 `constrain`，
> 本包已强制 `reject`）。这与表达式内 `date(2020, 2, 30)`、字符串路径 `date("2020-02-30")` 及 `feelin` 一致。
> 反例：`date("2020-01-31") + duration("P1M")` → `2020-02-29` **照旧规整** —— 加法溢出是另一种语义，
> TCK 有覆盖，不可一并改。

---

## 2. 四档订阅（subpath exports）

| 档 | 给谁 | 内容 |
|---|---|---|
| `.` core | engine / dmn | parse + 求值 + 三值逻辑 + 内置函数（**无时态**） |
| `./unary-tests` | engine 网关 / dmn 输入格 | unary tests（S-FEEL），`?` 为被测输入 |
| `./temporal` | dmn（CL3）/ 按需 | date/time/duration + 动态加载 polyfill + **JS 侧值桥（`toFeel` 一族，见 §1.4）** |
| `./editor` | designer | 解析 + AST + 诊断 + **语法着色**（**不含求值器/内置函数库**） |

```ts
import { unaryTest } from '@floken-io/feel/unary-tests';
import { ensureTemporal, evaluateTemporal } from '@floken-io/feel/temporal';
import { diagnose, tokens } from '@floken-io/feel/editor';
```

---

## 3. 支持的语法

- 字面量：`1` `1.5` `"str"` `true` `false` `null`；空列表 `[]`
- **名字可含空格与撇号**（FEEL `additional name symbols`）：
  `Mike's daughter`、`Applicant Age`、上下文键 `{ Mike's age: 3 }`、路径步 `a.b c`
  - 合并规则：**整体**命中多词内置名表才合并（所以 `date and time` 合并，而 `date and x` 仍是逻辑与）；
    其余情况相邻的 `name` 直接合成一个名字
  - 有意偏离：FEEL 还允许 `- + * / .` 出现在名字里，但那会与算术/路径语义冲突，floken 保留运算语义
- 算术：`+ - * / **`，一元 `-`
- 比较：`= != < <= > >=`
- **类型判定**：`x instance of number` / `date and time` / `list` / `context` / `range` / `function` …
  （`null instance of <T>` → `false`，只有 `any` 为 `true`）
- 逻辑：`and` / `or` / `not(...)`
- **成员判定**：`x in [1..10]`（区间）/ `x in ["a","b"]`（列表）/ `"k" in { k: 1 }`（上下文键）
- **区间判定**：`x between 1 and 10`（等价 `x >= 1 and x <= 10`）
- 列表 `[1,2,3]`、**方括号统一语义** `list[…]`、投影 `list.prop`
  - 括号内是**数字** → 下标（**1-based**，负号倒数）：`[1,2,3][-1]` → `3`
  - 括号内是**列表** → 多下标：`[10,20,30][[1,3]]` → `[10,30]`
  - 否则 → **过滤**：`[1,2,3,4][item > 2]` → `[3,4]`
    （元素绑定为 `item`；元素是上下文时其属性可直接引用，如 `users[age > 25]`）
- 区间 `[1..5]` `]1..5[` `[1..5)` `(1..5]`（unary test 中作包含判定）
- 上下文 `{ a: 1, b: "x" }`、路径 `a.b.c`；**后一项可见前一项**（`{ a: 1, b: a + 1 }.b` → `2`）
- 控制：`if … then … else …`、`for x in list return …`、
  `every|some x in list satisfies …`（支持多变量笛卡尔积）
- **函数字面量**：`function(a, b) a + b`，闭包捕获定义处上下文；
  可立即调用 `(function(a,b) a+b)(1,2)`，也可用 `invoke(f, [1,2])`
- 注释：`// …` 到行尾
- 函数调用：内置函数、context 里的 JS 函数（`rates()`）、对象方法

---

## 4. 内置函数

**命名策略**：标准 FEEL 名（含带空格者）**同时**提供 camelCase 别名，
两种写法都能调用：

```ts
evaluate('string length("abc")').value;  // 3
evaluate('stringLength("abc")').value;   // 3
evaluate('list contains([1,2], 2)').value; // true
evaluate('listContains([1,2], 2)').value;  // true
```

已实现（节选）：

| 类别 | 函数 |
|---|---|
| 数值 | `decimal` `floor` `ceiling` `abs` `modulo` `sqrt` `log` `exp` `odd` `even` `round` `round half up` `round half down` |
| 聚合 | `min` `max` `sum` `mean` `median` `product` `stddev`（样本标准差，n<2 → null） |
| 字符串 | `string` `string length` `upper case` `lower case` `contains` `starts with` `ends with` `substring` `substring before` `substring after` `replace` `matches` `split` `string join` |
| 列表 | `list contains` `count` `sublist` `append` `concatenate` `insert before` `remove` `reverse` `index of` `union` `distinct values` `flatten` `sort` `mode` **`list replace`**（★ DMN 1.5 新增） |
| 布尔 | `not` `and` `or` `all` `any` |
| 转换 | `string` `number` |
| 上下文 | `get value` `get entries` `context` `context put` `context merge` |
| 区间 | `before` `after` `meets` `met by` `overlaps` `overlaps before` `overlaps after` `finishes` `finished by` `includes` `during` `starts` `started by` `coincides` `is` **`range`**（★ DMN 1.5 增强） |
| 函数 | `invoke` |
| 时间 | 见 `./temporal` 档（`date` `time` `date and time` `duration` `years and months duration` `now` `today` 及分量访问器） |

> **版本口径（2026-09-26 拍板：按最新规范实现语言层；元模型权威版本 = DMN 1.5 + 导入双向兼容 1.3~1.6，见 Q35）**：
> 覆盖 **DMN 1.4 全量** + 已补齐的 **1.5/1.6 语言层**：
> `list replace`（1.5）、**duration 取负** `-duration("PT1H")`（1.5）、`range("[18..21)")` 字符串构造（1.5）、
> 科学计数法数字字面量 `1.2e3`（1.5）、`@"PT5H"` 时间字面量（1.4）。
> **未做**：**B-FEEL**（1.6 新增的第二语义方言，需独立开关）、隐式 `date → date and time` 转换
> （须与 TCK 语料升版同步做，否则会与 1.5 语料相冲）。详见 `05-包需求-floken-feel.md` §7.11。

> 各域实现按域拆档在 `src/builtins/`（`numeric` / `string` / `list` / `boolean` / `conversion` / `context` / `function`），
> 新增内置函数只需加到对应域文件，注册表自动汇总。

**扩展点**：

```ts
import { registerBuiltin } from '@floken-io/feel';
registerBuiltin('double', (args) => {
  const n = (args[0] ?? null) as number | null;
  return n === null ? null : n * 2;
});
evaluate('double(21)').value; // 42
```

---

## 5. 三值逻辑（NFR-F14 对齐）

`null` 表示「未知」。它参与的比较/布尔运算结果是 `null`，**不会**静默变成 `false`：

```ts
evaluate('null < 1').value;      // null（未知）
evaluate('null = 1').value;      // false
evaluate('null = null').value;   // true
evaluate('true and null').value; // null
evaluate('false and null').value;// false
evaluate('true or null').value;  // true
```

---

## 6. 时间档（`./temporal`）

核心档**不静态引用**时间实现源（NFR-F12，由 `check:deps` 沿 import 递归兜底）。
时间值以 `FeelTemporal` 结构化表示，核心只按 `iso` 比较。

### 6.1 实现源：统一 `temporal-polyfill`（ADR Q32）

**本档自带 `temporal-polyfill`（`>=1.0.5 <2.0.0`），无需手动安装，与 Node 版本无关。**

> 依赖形态（⚠️ **ADR Q33，2026-09-25 修订**）：`temporal-polyfill` 是本包的**普通 `dependencies`（自带）**，
> 不再是 `peerDependencies` + `optional: true` —— **装上 `@floken-io/feel` 就有时间函数**，
> 不用再单独 `npm install temporal-polyfill`。
>
> 为什么改：Q32 已把它定为 `./temporal` 档的**必需**依赖，而 `optional: true` 意味着"不装也能用"，
> 二者自相矛盾 —— 宿主漏装时只在**运行期**才炸（且报错点离病灶很远）。
>
> 代价（诚实）：`@floken-io/engine` 这类默认依赖本包的包，`node_modules` 里会多出这一份 polyfill（~1114 KB）；
> 但只要不 `import '@floken-io/feel/temporal'` 就**永远不会加载**它，**运行开销为零**。

| 口径 | 说明 |
|---|---|
| 实现源 | **`temporal-polyfill/implementation`**（无条件导出 polyfill 实现） |
| **不用** 原生 | **不读 `globalThis.Temporal`** —— 原生只在较新 Node 上存在，且边界行为与 polyfill 不保证逐字一致 |
| 理由 | **同一表达式在任何受支持的 Node（≥22.12）上必须得到同一结果**；对一个以 TCK 逐条断言为闸门的包，可复现性优先于"少一个依赖" |
| 缺失时 | 抛 `FEEL_ENV_TEMPORAL_MISSING`（`FeelEnvError`，带 `hint` = 上面的安装命令）—— 不是裸的 `ERR_MODULE_NOT_FOUND` |

> ⚠️ **为什么不能写 `import 'temporal-polyfill'`（包根）**：包根第一行就是
> `const Temporal = NativeTemporal || PolyfillTemporal`（`chunks/root.js` = `globalThis.Temporal`）——
> **连 polyfill 自己都在优先原生**，"装 polyfill"并不等于"用 polyfill"。
> 改回包根**不会让任何测试变红**（Node 22 下两者等价），只会在 Node 26 上悄悄换实现，
> 故由 `check:deps` 断言产物里出现的必须是 `temporal-polyfill/implementation`、且不得出现 `globalThis.Temporal`。

### 6.2 用法

```ts
// ★ import 即注册：本档是该包**唯一的副作用档**，import 时自动完成
//   「动态加载 temporal-polyfill/implementation + 注册时间函数」。
import '@floken-io/feel/temporal';
import { evaluate } from '@floken-io/feel';

evaluate('date("2020-01-01")').value;                  // { kind: 'date', iso: '2020-01-01', … }
evaluate('year(date("2020-01-01"))').value;            // 2020
evaluate('@"2020-01-01" = date("2020-01-01")').value;  // true（@ 字面量同样由本档分派类型）
```

- **未加载就调用** → 抛 `FEEL_NOT_LOADED_TEMPORAL`，提示里给的修复动作就是上面那句 `import` ——
  照着做**即可解决**。这条契约由 `test/cold-start.test.ts` 在**独立进程**里验证
  （注册是全局且不可逆的，同进程里复现不出"未加载"）。
- 也可用不依赖全局注册的显式 API：`evaluateTemporal(src, ctx?, options?)`。
- `ensureTemporal()`：加载并缓存 polyfill 实现（返回 `Promise<TemporalNS>`；依赖缺失时抛错）。
- `getTemporal()`：同步取**已加载**的实现（未加载返回 `null`；**不会**去读 `globalThis.Temporal`）。

提供：`now` `today` `date` `time` `date and time` `duration`
`years and months duration` `year` `month` `day` `hour` `minute` `second` `weekday`。

---

## 7. 编辑器档（`./editor`）

面向 `@floken-io/designer` 的表达式编辑器：解析 + 诊断 + 语法着色，**不含求值器与内置函数库**
（因此这一档很轻，可随设计器一起进浏览器）。

```ts
import { diagnose, diagnoseUnaryTests, tokens, parse, parseWithDiagnostics, highlight } from '@floken-io/feel/editor';

diagnose('1 +');
// [{ severity: 'error', code: 'FEEL_SYNTAX_UNEXPECTED_TOKEN',
//    message: "…", start: 3, end: 3 }]
diagnose('(1 + 2');
// [{ code: 'FEEL_SYNTAX_EXPECTED_TOKEN', expected: ['rparen'],
//    suggestions: ['此处可能漏了 `)`'], start: 6, end: 6 }]
diagnose('1 + 2');               // []
parseWithDiagnostics('1 +');     // { ast: null, diagnostics: [...] }  ← 不抛，按 05-feel §6 形态
tokens('a + 1');                 // token 流（已按名字合并规则切分，与 highlight 边界一致）
parse('1 + 2');                  // AST（语法错会抛；要不抛请用 parseWithDiagnostics）
```

### 语法着色 `highlight(src)`

返回**单调不重叠**的 span 数组，`value` 为源码原样切片（可直接回显），
类别由宿主决定配色：

```ts
highlight('if a > 1 then "x" else null // c');
// [
//   { kind: 'keyword',     value: 'if',   from: 0,  to: 2  },
//   { kind: 'variable',    value: 'a',    from: 3,  to: 4  },
//   { kind: 'operator',    value: '>',    from: 5,  to: 6  },
//   { kind: 'number',      value: '1',    from: 7,  to: 8  },
//   { kind: 'keyword',     value: 'then', from: 9,  to: 13 },
//   { kind: 'string',      value: '"x"',  from: 14, to: 17 },
//   { kind: 'keyword',     value: 'else', from: 18, to: 22 },
//   { kind: 'null',        value: 'null', from: 23, to: 27 },
//   { kind: 'comment',     value: '// c', from: 28, to: 32 },
// ]
```

`kind` 取值：`keyword` / `boolean` / `null` / `number` / `string` / `temporal` / `function` /
`variable` / `operator` / `punctuation` / `comment` / **`error`**。

判定规则（与解析边界保持一致）：
- 多词内置名（`list contains`、`date and time`）**整体**成一个 span；
- 名字后跟 `(` → `function`，否则 `variable`（纯词法判定，故 `now` 作值用时是 `variable`）；
- **源码非法时不抛异常，降级为「已识别部分 + 尾部 `error` 区间」**：

```ts
highlight('1 + "abc');   // 未闭合字符串
// [ { kind: 'number',  value: '1',     from: 0, to: 1 },
//   { kind: 'operator',value: '+',     from: 2, to: 3 },
//   { kind: 'error',   value: '"abc',  from: 4, to: 8 } ]   ← 只有坏掉的那一段是 error
```

> ★ 为什么不整段返回 `[]`（2026-09-27 修）：编辑器是**边打字边着色**的，
> 用户敲到 `date("2020-01-0` 这种中间态时前面 13 个字符仍然该着色。
> 整段变空会让"每敲一下整行掉色"、闪烁到没法用 ——
> 实测 5 条含字面量的表达式逐字符输入共 **101 个中间态，原实现有 37 个整段掉色**（现已为 0）。
> 该行为原先被 `test/highlight.test.ts` 固化成 `toEqual([])`，与"返回已识别部分"的文档承诺自相矛盾，已一并订正。

> `highlight` 实现在 `src/core/highlight.ts`（纯词法层），因此 `.` 与 `./editor` 都能取到。

### 在浏览器里跑

**能，且不需要任何打包器/转译**：产物是纯 ESM，dist 里**零 `node:` 内置依赖、零 DOM 依赖**，
`./editor` 子入口甚至不装载时态库（体积最小）。

```html
<script type="module">
  // 真实项目里由打包器或 importmap 把 '@floken-io/feel/editor' 解析到 dist/editor.js
  import { diagnose, highlight } from '/node_modules/@floken-io/feel/dist/editor.js';

  // 边打字边出波浪线：diagnose 给 start/end/expected/suggestions，highlight 给配色
  const diags = diagnose(src);                 // 不抛，返回 Diagnostic[]
  const spans = highlight(src);                // 着色（非法时降级，不整段消失）
</script>
```

完整可运行示例见 **`examples/browser-lint.html`**（起个静态服务器打开即可，例如
`python -m http.server`；`file://` 下浏览器会拦 ES module，必须用 http）。
该示例除着色/波浪线外，还用 `parseWithDiagnostics()` 渲染一棵 **AST 树**：
诊断只挂在**最小的包含节点**上（不是整条路径染红），点节点会在编辑器里选中对应源码区间；
语法没走完时 `ast` 为 `null`，此时退化为「按括号分组的词法树」（仍是树，但只有括号层级）。

网页端做错误提示的正确姿势（与 `04-dmn` §14.1 同源）：
- **静态/语法错误** → `diagnose()`：`Diagnostic[]`，带 `start`/`end`，直接画波浪线；
- **运行期问题**（未知变量、类型不符）→ 主入口 `evaluate()` 的 `warnings`，同样是带定位的 `Diagnostic[]`；
- **不要用 `errorMode: 'throw'` 做校验**：它只能报第一个错且丢掉 `value`，
  而诊断列表能一次列全部且带位置 —— 这正是 bpmn-io 另做 `@bpmn-io/feel-lint` 而不是给求值器加严格开关的理由。

---

## 8. 已知边界（后续里程碑补齐）

- 未实现 `for … in … return` 的 `partial` 修饰、`function(…) external { … }`、
  `?` 在普通表达式（非 unary test）里的完整语义。
- `instance of` 的类型名里**不含** `day-time duration`（它含 `-`，会与减法词法冲突；
  需要时用 `duration` 判定）。
- ~~未覆盖 DMN TCK 全量~~ → **已达成（F3）**：79 个 FEEL label 零退化 + B 口径 1995/1995（100%）。
  ⚠️ 剩的是**另一本账**：A 口径（完整 DMN TCK，含 DRG 遍历 / 决策表 / 命中策略）归 `@floken-io/dmn`，本包无 DMN 引擎、跑不出来。
- 时态比较：`date` / `time` / `dateTime` 互不可比较，`duration` 不可比较（对齐 feelin 行为）。
- 名字字符集有意偏离 FEEL：只纳入 `'` 与 `^`，`- + * / .` 保留运算/路径语义（见 §3）。

---

## 9. 源码结构

按「入口 / 内核 / 域」分层，新增功能时按域落档，不要往根目录堆文件：

```
src/
├─ entries/            # 4 个公开子路径入口，只做 re-export，不放逻辑
│  ├─ index.ts         # → dist/index.js
│  ├─ unary-tests.ts   # → dist/unary-tests.js
│  ├─ temporal.ts      # → dist/temporal.js
│  └─ editor.ts        # → dist/editor.js
├─ core/               # FEEL 语言内核（零运行时依赖）
│  ├─ types.ts         # 值类型 / AST（最底层）
│  ├─ errors.ts        # ★ 错误与诊断契约：FeelError 家族 + 码表 + Diagnostic 工厂
│  ├─ values.ts        # 值语义：深相等、比较、三值逻辑、context 转换
│  ├─ lexer.ts         # 词法
│  ├─ name-merge.ts    # ★ 名字合并（parser 与 highlight 共用，保证边界一致）
│  ├─ spaced-names.ts  # 多词名表（名字合并与内置函数注册共用）
│  ├─ parser.ts        # 语法（递归下降）
│  ├─ deferred.ts      # ★ 延迟能力登记：`./temporal` 独占的函数名
│  ├─ evaluator.ts     # 求值器 + 选项契约 + 资源上限
│  └─ highlight.ts     # 词法着色（给设计器；不装载求值器）
├─ builtins/           # 内置函数库（按域拆档，扩展点）
│  ├─ helpers.ts       # 各域共用小工具
│  ├─ numeric.ts       # 数值 / 聚合
│  ├─ string.ts        # 字符串
│  ├─ list.ts          # 列表
│  ├─ boolean.ts       # 布尔 / 三值聚合
│  ├─ conversion.ts    # 类型转换
│  ├─ context.ts       # 上下文
│  ├─ function.ts      # 一等函数（invoke）
│  ├─ registry.ts      # 汇总表 + camelCase 别名 + registerBuiltin
│  └─ index.ts         # barrel
├─ temporal/           # 时间子域（唯一接触 temporal-polyfill 处）
└─ editor/             # 编辑器诊断子域
```

**依赖方向**（单向，无环）：

```
core  ←  builtins  ←  temporal
  ↑        ↑
  └── entries（四个入口）
```

- `core` 不得 import `builtins` / `temporal`（这也是多词名表与延迟能力登记表放在 core 的原因）。
- 新增内置函数：加到对应域文件即可，`registry` 自动汇总；名字含空格会自动登记进多词名表。
- 新增子路径导出：在 `entries/` 加入口文件 + `tsup.config.ts` 加 entry + `package.json` 的 `exports` 加映射，三处同步。

---

## 10. 开发

```bash
pnpm install
pnpm build
pnpm verify   # 门禁：types / tests / pack / tck-isolation / deps（NFR-F12 递归 + Q32 实现源）
pnpm tck      # B 口径跑分（2053 断言 / 计分 1995；加 --strict 走严格口径）
```

## 硬约束

- **纯自研**：不引入 lezer-feel，词法/语法分析器全部自研；feelin 源码只读不拷（Q9）。
  （唯一的**运行时依赖**是 `temporal-polyfill` —— Q33 定为普通 `dependencies` 且只由 `./temporal` 档加载，见 §6.1；
  **语言内核 core 仍是零依赖**。）
- **禁止自研日期库**（NFR-F11）：时态只来自 `temporal-polyfill/implementation`（ADR Q32，**不读原生 `Temporal`**）。
- core/unary-tests **不得**静态引用时间实现源（NFR-F12，`check:deps` 递归兜底）；
  且 `check:deps` 会断言 temporal 产物里出现的是 `temporal-polyfill/implementation`、没有 `globalThis.Temporal`。
- TCK 语料可本地/CI 跑，但**不得**随包分发（NFR-F14，`check:tck-isolation` 兜底）。
