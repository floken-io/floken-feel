# TCK 工具（工-A）· B 口径跑分

本目录是 `05-包需求-floken-feel.md` §7.3 里「工-A」的落地：**FEEL-only 提取器 + 跑分器**。
它是本包的**生命线** —— 没有它，「现在能过多少」这个问题只能靠感觉回答。

```
tooling/tck/
  xml.mjs                 极简 XML 扫描器（自研，零依赖）
  extract.mjs             工-A 上半：TCK 语料 → tmp/tck/cases.json
  run.mjs                 工-A 下半：cases.json → 分数 / 失败清单 / 基线对比
  baseline.labels.json    逐 label 基线（随仓库，用于防退化）
```

---

## 一、语料怎么拿（不随包分发）

DMN TCK 在 `github.com/dmn-tck/tck`，本仓库**不含**任何语料副本：

- **授权**：仓库是 Apache-2.0（`LICENSE-ASL-2.0.txt`），但 **test cases 本身是 CC BY-SA**（署名 + 相同方式共享）。
  CC BY-SA 的 Share-Alike **有传染性** —— 拷进仓库会污染 Apache-2.0 的发布树，所以只允许**外部存放 + 本地/CI 运行**。
- **门禁**：`pnpm verify` 的第七道 `check:tck-isolation` 会扫 `files`/`dist`/tarball，出现 `tck` 相关路径即拦截。
- **署名**：写报告/对外提数时须注明 `DMN TCK — github.com/dmn-tck/tck`。

拉语料（只需 `TestCases/` 下的 `*-feel-*` 目录，79 组 / 158 文件）：

```bash
git clone --depth 1 https://github.com/dmn-tck/tck.git
export TCK_DIR="$PWD/tck/TestCases"     # 或用 -- 默认回落到本机沙箱路径
```

> 国内网络下 `github.com` 可能被代理阻断而 `api.github.com` / `cdn.jsdelivr.net` 可用，
> 逐文件走 jsdelivr 或 GitHub contents API 也能拉到（本目录作者即如此）。

## 二、怎么跑

```bash
pnpm build                       # 跑分器吃 dist/（发布产物形态，与 NFR 的"打包之后才存在"一致）
pnpm tck:extract                 # 提取 → tmp/tck/{cases,labels,extract-gaps}.json
pnpm tck                         # 跑分 → 分数 + tmp/tck/{results,failed}.json
pnpm tck:baseline                # 把当前成绩写成 baseline.labels.json（防退化基线）
node tooling/tck/run.mjs --label=1130-feel-interval --show-fail=10   # 单组钻取
```

`tmp/` 已在 `.gitignore` 里 —— 那是**语料的派生物**，同样不进仓库。

## 三、口径（不许混）

| 口径 | 断言数 | 谁能跑 |
|---|---:|---|
| **A · 完整 DMN TCK**（含 DRG 遍历 / 决策表 / 命中策略） | 3495（CL3 3369） | ❌ 本包跑不了 → 属 `floken-dmn` |
| **B · FEEL-only**（`-feel-` 中缀的 79 组） | **2053** | ✅ **本包唯一可达的官方语料** |

「三千三百多 / 3495」是 **A 口径**，本包没有 DMN 引擎、跑不出来。
本包能自证的是 B 口径的 **2053** 条 —— 提取器实测出的就是这个数（与上游 `feelin` 口径逐条对齐）。

## 四、裁判规则（★ 自研靶心，必须公开写死）

官方**规范了输入输出，却没规范"怎么算相等"**：
`TestResult.java` 只是结果容器（`SUCCESS`/`ERROR`/`IGNORED` 三态），没有 `compare` 方法；
「相等」的自由裁量权被完全交给各家厂商（见 §7.3-③）。所以这一层必须由我们自己写死：

| # | 规则 | 说明 |
|---|---|---|
| **R1** | 两侧都当 FEEL 表达式 | `expected` 由本引擎自行求值成值，再与 actual 比较（不解析 XML 值对象） |
| **R2** | 相等判定 | `null`=其一等值；number 精确或在 **相对误差 ≤ 1e-9** 内；string/boolean 严格；时态按 `kind`+规范串（date ≠ date-time）；列表/context/区间结构递归 |
| **R3** | `errorResult="true"`（**官方 XSD 字段**） | 期望**抛错**。抛错 = pass；返回任何值（含 null）= fail。另记「宽松口径」（把返回 null 也算过）**仅用于与上游 92.6% 对照**，不作门禁 —— 上游用的是私有野规则，我们不继承 |
| **R4** | 非 `FeelError` 异常 | 单记 `unexpected-error`：那是引擎崩溃，不是"规范判定为错误" |
| **R5** | 时钟固定注入 | `clock = 2026-05-12T00:00:00Z`，保证可复现（NFR-F3） |

## 五、当前成绩（2026-09-25 晚，F3 第四轮）

```
断言 2053   ✓ 1873 (91.2%)   ✗ 180
├ 严格口径（官方 errorResult）: 1751/2053 (85.3%)
└ 宽松口径（上游私有规则，仅对照）: 1873/2053 (91.2%)
79 组中 50 组 100%
```

失败归因（条数）：`mismatch` 80 / `threw` 61 / `expected-error-got-value` 37 / `harness-error` 2。

**已修（按轮次；轮次口径与 `项目实施记录/2026-09-25.md` 一致）**：
- 首轮：temporal 档 import 即注册（+176）、指数记法 `1.23e4`（+139）、
  区间 `)` 收尾、比较符的区间等价（`<= 10` ≡ `(null..10]`）、`@"…"` 字面量（+117）、
  无界区间端点 `null`、`in` 的裸值/区间元素语义。
- 第二轮（基建，非分数）：Q32 时间实现源统一 `temporal-polyfill/implementation`、Q33 依赖形态调整。
- 第三轮（时间构造器重载 + `string()` 规范文本，+82）：
  `1116` 37→83/83、`0079` 30→37/37、`1117` 32→86/88、`1115` 16→48/52；
  语义 = `date`/`time`/`date and time` 的**重载分派**（`from` 三种入参 / 分量式 / 命名参数）、
  FEEL 年份写法（4~9 位、不许前导零与 `+`、负年补扩年）、偏移上限 `±18:00`、
  偏移与时区名互斥、时区名须真实存在、时分秒越界（含 Temporal 会静默规整的 `23:59:60`）、
  零偏移归一 `Z`、`@Zone` 文本不带偏移、两个 duration 类型零值区分（`P0M` ≠ `PT0S`）。
- **第四轮 4a（度量工具修正 + 区间一等值，+65）**：先修尺子再量东西 ——
  `extract.mjs` 原先只在 `expected` 层正确处理 context，**嵌套 context 与列表内 context 元素被读错**，
  造出一批假失败（`0057#002`、`0069#024~032`、`1146#nested*`、`1147#004`）；
  规则收敛为位置无关的 `srcOfChildren`/`srcOf`；`run.mjs` 补递归求值被 `informationRequirement`
  引用的 decision（`1146-decision014`）。
  其后三块语义：①**`=` 比"时刻"、`is()` 比"写法"**（`0068 datetime_012` 与 `0103 datetime_004`
  用**同一对值**一 true 一 false 钉死）→ `FeelTemporal` 拆 `eqKey` / `identity`；
  ②**前缀一元测试写法保留判别位**（`(< 10)` ≠ `(null..10)` 但属性一致，`0068` vs `0074`）→
  `FeelRange.test`；③**非列表基底的下标/过滤**按 FEEL 10.3.1.8 当单元素列表
  （`100[1]` = 100、`true[true]` = `[true]`）；另加 `src/builtins/interval.ts` 的 14 个区间关系
  （位置化：端点映到 `值 + k·ε` 数轴，全部化归为两个位置比较）。
  本轮 `1130` 14/14、`0068` 114/114、`0069` 35/35、`0103` 50/50 全绿。
- **第四轮 4b（上下文函数族，+25）**：`0057` 9→11/11、`1140` 19→22/22、`1145` 13→18/18、
  `1146` 20→30/30、`1147` 11→14/14 —— **五组全绿**。
  要点：`context put` 的**同名重载**（`key` 取字符串 / `keys` 取字符串列表）靠
  `function-params` 的「形参位别名」+ `NativeFn` 第四参 `argNames` 分流；
  路径式 `context put`（中间层必须是已存在的上下文）、`context`/`context merge` 收单上下文并强转、
  重复键报错（`{a:1,a:2}` 与 `context([{key:"a",…},{key:"a",…}])`）、
  语境键允许额外字符（`foo+bar`，取冒号前原始源码）、`string join` 只收字符串列表。

**已知 gap（6 条，不打算修）**：`1115#015/#016/#029/#030`、`1117#027/#028` 用 9 位年份
（`999999999`）—— 写法合法但超出 `temporal-polyfill` 可表示范围（±275760），记 `known-gaps`：
给 `null`，不抛错。

**已知最大缺口（下一轮按此顺序）**：见 `05-包需求-floken-feel.md` §7.4 的清单。

## 六、基线怎么用

`baseline.labels.json` 记录**每个 label 的 pass 数**。
它的用途是**防退化**：任何一次改动后重跑，`run.mjs` 会自动逐 label 比对，
出现 `X → 更小` 就报「判据① 标签退化」。

> 为什么不叫「上游基线」：本项目**从一开始就是自研 parser**（零 `lezer-feel` 依赖，用户已拍板），
> 因此不存在"换 parser 前后对比"的参照物 —— 判据① 的原始意图（证明分数不是 fork 来的）
> 在前提上自动成立。这份基线改为承担**回归护栏**的角色。
