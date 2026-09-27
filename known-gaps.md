# Known gaps

> 本文件是 **NFR-F14 的强制交付物**：每标一条 `IGNORED` 都要登记理由，
> 且 TCK 语料（CC BY-SA）**不随包分发**。机器可读的登记在 `tooling/tck/ignored.json`，
> 本文件是它的可读化 + 补充其它已知缺口。

**口径**：DMN TCK **B 口径**（79 个 FEEL label / 2053 条断言），
扣掉 58 条 IGNORED 后计分基数是 **1995**，两套错误口径都是 **1995/1995（100%）**。

---

## 1. IGNORED 断言：58 条（不进分子分母，单独记 ⊘）

判据（Q31）：**换输入也救不回，且救回它需要本包之外的能力（JVM / DMN 类型声明层 / 宿主绑定）**。
能实现的不许往这里塞。

### 1.1 整组 IGNORED（2 组，54 条）

| label | 条数 | 理由 |
|---|---|---|
| `0076-feel-external-java` | 18 | 全部是 `external {java: {class, method signature}}` 的 **Java 绑定**，需要 JVM 与宿主类路径。本包是纯 FEEL 引擎（零宿主依赖），没有这一层；Java 绑定属宿主适配器职责 |
| `0082-feel-coercion` | 36 | 考的**不是 FEEL 语义，而是 DMN 类型声明层的强制转换** —— decision / BKM 的 `typeRef`（含函数型 `lambda_number_returns_number`）与「结果值 / 实参值」之间的校验与强转（`[10]`→`10`、`["foo"]`→`"foo"`、`1+1`→string 失败）以及 decisionService 调用。FEEL 表达式引擎没有「decision 的声明类型」这一层（feel 零 floken 依赖、只读表达式），该职责在 `@floken-io/dmn` |

### 1.2 单条 IGNORED（4 条）

| 断言 | 理由 |
|---|---|
| `0057-feel-context#009` | **TCK 自身矛盾 → 从规范**（DMN §10.3.2.9 / §10.3.4.6）：`{a:1}.b` 是路径表达式取不存在的键，规范口径 `null`（unknown），同批 `#007` 正是这么判的，这里却挂 `errorResult="true"`。取不存在的键返回 null 是 FEEL 核心语义（上下文是稀疏映射），不能为凑 errorResult 改成抛错 |
| `0057-feel-context#010` | 同上：`null.b` 对 null 取属性在三值语义里就是 null（null 传播），规范没有「对 null 取属性是错误」的规定。与 `#009` 同族 |
| `0092-feel-lambda#009` | `{a: 10, "": bkm_009_1(100)(2)}` 期望 **200**（result entry 的值），而同批 `0057#007` 的 `{"": "foo"}` 期望的却是**上下文本身**。两者不矛盾 —— 前者在 `.dmn` 里是 **boxed context**，跑分器抽不到该结构差异 |
| `0092-feel-lambda#013` | `bkm_013_1(decisionService_013_1, decisionService_013_1)` 期望 5000 —— 实参是 **decisionService**，真实 DMN 宿主会把它绑定成可调用体，而跑分器的 `collectInvocables` 只收集 BKM，绑定不到 |

> 这 4 条已钉进 `test/tck-fixes.test.ts`，防止将来"为了凑数"把它们改成抛错。

---

## 2. ⚠️ TCK 的盲区：全绿 ≠ 口径正确

**TCK B 口径 2053 条里，以下函数命中 0 条** —— 官方语料完全没有覆盖：

`sum` · `mean` · `min(` · `max(` · `union(` · `round(`

此外 `string length` / `lower case` / `upper case` / `contains` / `split` / `replace` 虽有用例，
但**没有「传非字符串实参」**的用例。

**后果是真实的**：本包曾把这些实现成 **B-FEEL**（DMN 1.6 第二方言）语义 ——
`sum([1,null,3])` 得 `4`、`string length(22)` 得 `2`、`lower case(12)` 得 `"12"`、
`union([1,2],[2,3])` 得 `[1,2,2,3]` —— 却依然保持 TCK 1995/1995 全绿。
它们是靠与 `feelin` 的批量行为对比 + IBM 官方 B-FEEL↔FEEL 对照表才暴露的，
现已全部修正并用 `test/feel-dialect.test.ts` / `test/aggregates.test.ts` 钉死。

**结论**：本包的正确性来自「TCK + 官方对照表 + 参照实现三方交叉」，不能只看 TCK 分数。

---

## 3. 与参照实现 `feelin@8.2.0` 的差集

### 3.1 我们更多（不是缺口）

`highlight()` / `diagnose()` / `parseWithDiagnostics()` / `registerBuiltin` / `allowedFunctions` /
`maxNodes·maxDepth·timeoutMs` / `clock` / `errorMode`（`evaluate` vs `evaluateStrict`）/
S-FEEL 子路径 / `range()` / `list replace` / duration 取负。

`min` / `max` 对**非数值但同类可比**的列表有定义（`min(["b","a"])` = `"a"`、日期列表可比），
`feelin` 对这类输入返回 `null`（它只支持数字）—— 规范原文是 "minimum **comparable** element"，我们对。

`feelin` 的 `round` / `round up` / `round down` 全部返回 `null`（未实现），我们按规范实现。

### 3.2 刻意不做（2 项）

| 项 | 说明 |
|---|---|
| **错误恢复 / 部分树** | `feelin` 基于 lezer（LR 容错解析），任何输入都产出一棵带 `error` 节点的树。我们是递归下降、**fail-fast**。这是**编辑器体验能力**，不是 FEEL 规范能力，TCK 一条不考。已决策挂到 **M6（designer 接入）**再按实际需要补；届时硬约束是 `evaluateStrict` **必须仍旧抛**（保护 TCK 严格口径），只有宽松模式允许部分求值 |
| **`dialect` 第三参** | 我们用 `EvaluateOptions` 对象承载选项（`errorMode` / `clock` / `allowedFunctions` / 资源上限 / `builtins`），不提供 `evaluate(expr, ctx, dialect)` 的位置参数形态 |

### 3.3 值形态差异（唯一一处）

本包的时态值是**数据对象** `{__feelTemporal, kind, iso, raw, eqKey, identity}`，
`feelin` 用的是类（`FeelDate` 等）。故分量用**函数**读（`year(v)`）而非 `v.year`；
要底层对象请用 `unwrap(v)`。改成类会牵动 `eqKey` / `identity` / 比较 / JSON 序列化，风险与收益不成比例。

---

## 4. 其它已知缺口

| 缺口 | 说明 |
|---|---|
| **六参 `date and time(y, m, d, h, m, s)`** | 返回 `null`（未实现该签名）。`feelin` 同样不支持（报 `FUNCTION_INVOCATION_FAILURE`），TCK `1117` 也未测。需要时再补 |
| **`now()` 的输出不带时区** | 我们给本地墙上时间（如 `2026-09-26T16:17:26.182`），`feelin` 给带时区名（`…@Asia/Shanghai`）。TCK 只测 `now() instance of date and time`，未覆盖字符串形态。FEEL 的 date and time 本就允许不带时区，故非缺陷；若要改成带时区需先确认下游（dmn）依赖 |
| **DMN 1.6 的 B-FEEL 方言** | 未实现（它要求第二套语义开关：二值逻辑、数值错→0、字符串错→""、日期错→epoch）。见 §2：本包实现的是 **FEEL** |
| **`is defined(value)`** | 返回 `null`（未实现）。它**不在 OMG 规范的内置函数表**里（是 Camunda / Drools 的扩展），`feelin` 同样没有。故属刻意不做，不计入 106 个规范名 |
| **★ 运行期诊断的定位粒度 = 整个出错节点** | 例：`substring(age, 2)`（age 是 number）→ `FEEL_EVAL_ARG_TYPE @0..17`，**覆盖整个 `call`**，不指向出错的那个实参。原因：`helpers.reqString/reqNumber` 抛错时只带形参名，位置是上层 catch 用调用节点补的。要看具体原因得读 `message`（含形参与实际类型）。<br>影响：编辑器做"精确波浪线"时，运行期问题只能整节点标红（语法诊断精确到 token，不受影响）。<br>后续改法：`helpers` 的 `reqXxx` 增加可选实参节点入参，抛错时用它定位 —— 需同时改 evaluator 的内置调用点，成本中等，**未做** |
| **A 口径 3495（全量 DMN TCK）** | 归 `@floken-io/dmn`（需要 DRG 元素图 + 决策表命中策略），本包没有 DMN 引擎，跑不出来 |

---

## 5. 环境相关

- 时间实现源统一 `temporal-polyfill/implementation`，**不读** `globalThis.Temporal`（Q32）。缺包则抛 `FEEL_NOT_LOADED_TEMPORAL`。
- `temporal-polyfill` 只能表示 ±275760 年；**9 位年份**（TCK `1115#015/#016` 等）走 `extendedYear()` 兜底：
  `string()` 原样输出，但**运算与分量访问退回 null**（`date("999999999-12-31") + duration("P1D")` → `null`）。
