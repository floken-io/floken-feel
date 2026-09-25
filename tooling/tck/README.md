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

## 五、当前成绩（2026-09-25 首次跑通）

```
断言 2053   ✓ 1220 (59.4%)   ✗ 833
├ 严格口径（官方 errorResult）: 889/2053 (43.3%)
└ 宽松口径（上游私有规则，仅对照）: 1220/2053 (59.4%)
79 组中 12 组 100%
```

失败归因（条数）：`mismatch` 473 / `threw` 251 / `expected-error-got-value` 109。

**已修（本轮由 TCK 暴露）**：temporal 档 import 即注册（+176）、指数记法 `1.23e4`（+139）、
区间 `)` 收尾、比较符的区间等价（`<= 10` ≡ `(null..10]`）、`@"…"` 字面量（+117）、
无界区间端点 `null`、`in` 的裸值/区间元素语义。

**已知最大缺口（下一轮按此顺序）**：见 `05-包需求-floken-feel.md` §7.4 的清单。

## 六、基线怎么用

`baseline.labels.json` 记录**每个 label 的 pass 数**。
它的用途是**防退化**：任何一次改动后重跑，`run.mjs` 会自动逐 label 比对，
出现 `X → 更小` 就报「判据① 标签退化」。

> 为什么不叫「上游基线」：本项目**从一开始就是自研 parser**（零 `lezer-feel` 依赖，用户已拍板），
> 因此不存在"换 parser 前后对比"的参照物 —— 判据① 的原始意图（证明分数不是 fork 来的）
> 在前提上自动成立。这份基线改为承担**回归护栏**的角色。
