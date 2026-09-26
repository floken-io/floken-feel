# Changelog

本包遵循 [Semantic Versioning](https://semver.org/)，格式参考 [Keep a Changelog](https://keepachangelog.com/)。
0.x 阶段跨包依赖写 `>=x.y.z <1.0.0`（不用 `^`）。

## 0.0.3 — 2026-09-26

首个发布版本，对应里程碑 **F3**（`05-包需求-floken-feel.md` §里程碑）。
F0–F2 未单独发版，其内容一并包含在本版中。

### 完成

- **DMN TCK 双口径 100%**：B 口径 79 个 FEEL label / 2053 条断言，扣 58 条 IGNORED 后
  计分基数 **1995** —— `evaluate()` **1995/1995**、`evaluateStrict()` **1995/1995**，
  `errorResult` 缺口 0，判据① 79 组零退化（两套基线分别比对）。
- **错误双模式**：`evaluate()`（默认，规范口径：出错给 `null` + 诊断）与
  `evaluateStrict()`（TCK 严格口径：抛 `FeelError`）。一条代码路径供两种口径
  —— 内置函数一律 `throw`，由 `call` 边界按模式处置。
- **四档 subpath exports**：`.` / `./unary-tests` / `./temporal` / `./editor`。
  `./editor` 不含求值器与内置函数库；core / unary-tests 不静态引用 temporal（有门禁）。
- **106 个规范名 / 130 个键**的内置函数表（DMN 1.5 齐平）。
- **JS 侧时态值桥**（`./temporal` 的 `toFeel` 一族）：值桥、4 细类判定、分量与时长分量、
  构造、运算、`unwrap`。`toFeel(Date)` 按 **UTC** 记为 date and time。
- **语法着色** `highlight()`（词法层，11 类 span，语法错时仍可用）。
- DMN 1.5 新增：`list replace`、`-duration("PT1H")`、`range()`、科学计数法、`@"PT5H"`。

### 修正

- **分量构造 `overflow: 'reject'`**：`date(2020,2,30)` 等「月内没有这一天」由静默规整
  （`constrain` → `2020-02-29`）改为 `null` + 诊断，与字符串路径、扩展年路径及 `feelin` 一致。
- **`union` 去重**：规范写死 *excludes duplicates*，曾与 `concatenate` 逐字相同。
  `union([1,2],[2,3])` → `[1,2,3]`。
- **列表聚合改为 FEEL 口径**：`sum` / `mean` / `min` / `max` 遇 `null` 或非数值元素由"忽略"
  改为 `null` + 诊断（`min` / `max` 另加：两两不可比较 → 结果未定义）。此前混入的是
  **B-FEEL**（DMN 1.6 第二方言）语义。
- **字符串函数不做隐式转换**：`string length` / `upper case` / `lower case` /
  `starts with` / `ends with` / `substring` / `substring before` / `substring after`
  的 `string` 形参见非字符串一律 `null` + 诊断（与同档 `contains` / `replace` 统一）。

> 上述四项 TCK **均无对应用例**（详见 `known-gaps.md` §2），是靠与 `feelin` 批量对比 +
> IBM 官方 B-FEEL↔FEEL 对照表发现的，已用 `test/feel-dialect.test.ts` /
> `test/aggregates.test.ts` / `test/tck-fixes.test.ts` 钉死。
