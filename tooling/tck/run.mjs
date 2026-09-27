/**
 * @floken-io/feel · TCK 工具（工-A 下半）· B 口径跑分器
 *
 * 输入：`extract.mjs` 产出的 `tmp/tck/cases.json`（79 组 / 2053 断言）。
 * 输出：总分 + 每 label 分数 + 失败清单（落地 `tmp/tck/results.json` / `failed.json`）。
 *
 * ────────────────────────────────────────────────────────────────
 * ★ 裁判规则（v0，自研 · 必须公开写死 —— 理由见 05-包需求-floken-feel.md §7.3-③）
 *
 * 官方**没有**规范「怎么算相等」（`TestResult.java` 只是结果容器，没有任何 compare 方法），
 * 所以这一层是我们的自由裁量，也必须由我们写清楚：
 *
 * R1. 两侧都当 FEEL 表达式处理：`expected` 由本引擎自行求值成值，再与 actual 比较。
 * R2. 相等判定：
 *     · null = null（FEEL 的 null 是一等值，不是"缺省"）
 *     · number = number：精确相等，或在**相对误差 ≤ 1e-9** 内（容纳 IEEE-754 表示误差）
 *     · string / boolean：严格相等
 *     · 时态：`kind` 相同且规范串（iso）相等 —— date 与 date-time **不相等**
 *     · 列表 / context / 区间：结构递归比较（context 比键集合，不比顺序）
 * R3. `errorResult="true"`（**官方 XSD 字段**，§7.3-③ 点名要用它）：期望求值**抛错**。
 *     抛错 = pass；返回了任何值（含 null）= **fail**。
 *     同时另记一条「宽松口径」——把「返回 null」也算 pass，**仅用于和上游 92.6% 对照**，不作门禁。
 *     上游 `feelin` 用的是私有野规则（"期望 null 时抛错也算 pass"），我们**不继承**它。
 * R4. 非 `FeelError` 的异常（TypeError 之类）单独记为 `unexpected-error`：
 *     它通常意味着引擎内部崩溃，不能与"规范判定为错误"混为一谈。
 * R5. 确定性（NFR-F3）：时钟固定注入，`now()` / `today()` 不得读系统时间。
 * ────────────────────────────────────────────────────────────────
 *
 * 用法：
 *   node tooling/tck/run.mjs [--cases=tmp/tck/cases.json] [--json] [--top=20]
 *                            [--baseline=tooling/tck/baseline.labels.json] [--write-baseline]
 *                            [--label=1130-feel-interval] [--show-fail=5] [--strict]
 *
 * `--strict`：用 `evaluateStrict`（`errorMode:'throw'`）跑，出**官方严格口径**分数
 * （`errorResult="true"` 的用例必须抛错才算过）。基线与默认口径**分开存**
 * （`baseline.labels.strict.json`），两套口径各自防退化、互不干扰。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

// ---------- 载入被测引擎（发布产物形态，与 NFR 的"打包之后才存在"一致） ----------
const DIST = path.resolve(arg('dist', 'dist'));
const feel = await import(pathToFileURL(path.join(DIST, 'index.js')).href);
await import(pathToFileURL(path.join(DIST, 'temporal.js')).href); // B 口径含时态断言，必须挂时间档
const { evaluate, isRange, isContext, isTemporal, registerSpacedName, toFeelFunction } = feel;

const CASES = path.resolve(arg('cases', 'tmp/tck/cases.json'));
const cases = JSON.parse(fs.readFileSync(CASES, 'utf8'));

/**
 * 模型**类型表**（`extract.mjs` 从各模型的 `itemDefinition` 抽出）。
 * `instance of t255` / `instance of tNumberList` 这类断言只有拿到模型定义才判得了
 * （TCK 0070）；用例通过 `model` 字段关联到所属模型。
 */
const TYPES_PATH = path.resolve(arg('types', 'tmp/tck/types.json'));
const TYPES = fs.existsSync(TYPES_PATH) ? JSON.parse(fs.readFileSync(TYPES_PATH, 'utf8')) : {};

/*
 * IGNORED 名单（NFR-F14 的第三态）。理由逐条写在文件里；未命中 → 空（照旧全量跑分）。
 *
 * 两个粒度：`IGNORED[label]` 整组、`IGNORED_CASES["label#id"]` 单条。
 * 单条粒度给「组内只有这一条越界」的情形（如 0092#013 的 decisionService 调用），
 * 免得为了一条就把整组 18 条都免掉 —— 那是把账做糊涂，不是把题做对。
 */
const IGNORED_PATH = path.resolve(arg('ignored', 'tooling/tck/ignored.json'));
const IGNORED_FILE = fs.existsSync(IGNORED_PATH)
  ? JSON.parse(fs.readFileSync(IGNORED_PATH, 'utf8'))
  : {};
const IGNORED = IGNORED_FILE.labels ?? {};
const IGNORED_CASES = IGNORED_FILE.cases ?? {};

/** R5：固定时钟（2026-05-12 是有意选的"周二"，能同时暴露周历/工作日类边界） */
const CLOCK = () => new Date('2026-05-12T00:00:00.000Z');

/**
 * ★ `--strict`：用 `evaluateStrict`（`errorMode:'throw'`）跑被测表达式。
 *
 * 默认（不开）时，引擎按 DMN 1.4 §10.3.2.13.1 把参数/类型类错误与"结果无定义"
 * 返回成 `null + 诊断` —— 于是 TCK 那批 `errorResult="true"` 的用例只能算「宽松通过」。
 * 开了 `--strict`，同一批错误改为抛出，就能跑出**官方严格口径**的真实分数。
 *
 * ⚠️ 只作用于**被测表达式**：`deps`（模型内其它 decision）与 `<expected>` 期望值
 * 一律走默认模式 —— 期望值只是"用来比对的写法"，它自己抛错不代表用例失败。
 */
const STRICT = argv.includes('--strict');
const OPTIONS = { clock: CLOCK };

/** 按用例所属模型补上类型表（无关用例共用同一份 OPTIONS，不额外分配） */
const optsFor = (c) => {
  const types = TYPES[c.model];
  return types ? { ...OPTIONS, types } : OPTIONS;
};

/** 空 FeelContext（求 `{}` 得来，避免依赖引擎未公开导出的构造器） */
let EMPTY_CTX = null;
function emptyCtx(opts) {
  if (!EMPTY_CTX) EMPTY_CTX = evaluate('{}', undefined, opts).value;
  return EMPTY_CTX;
}

// ---------- R2：相等判定 ----------

/**
 * 由期望值**字面写法的小数位**决定的容差下限（每条形用例比较前重设）。
 *
 * 为什么需要它：官方把 `exp(-1)` 的期望写成 `0.36787944`（8 位小数），
 * 引擎按 IEEE-754 给出 `0.36787944117144233` —— 差 1.2e-9，超过 1e-9 的相对容差。
 * 但那是**期望自己只写了 8 位**，不是引擎算错。故"期望写到几位小数，就按几位小数比"。
 *
 * 只放宽**下限**、不放宽相对误差，故不会掩盖真正的算错
 * （`0.36787944` 与 `0.36787945` 仍判不等）。
 */
let numFloor = 0;

function numEq(a, b) {
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const tolerance = Math.max(1e-9, Math.abs(b) * 1e-9, numFloor);
  return Math.abs(a - b) <= tolerance;
}

/** `0.36787944` → `0.5e-8`；非纯十进制字面量 → 0（不放宽） */
function decimalsFloor(src) {
  const m = /^-?\d+\.(\d+)$/.exec(String(src ?? '').trim());
  return m ? 0.5 * 10 ** -m[1].length : 0;
}

function eq(actual, expected, depth = 0) {
  if (actual === expected) return true;
  if (actual === null || expected === null || actual === undefined || expected === undefined) return false;
  if (typeof actual === 'number' && typeof expected === 'number') return numEq(actual, expected);
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return actual.length === expected.length && actual.every((v, i) => eq(v, expected[i], depth + 1));
  }
  if (isRange(actual) && isRange(expected)) {
    return (
      eq(actual.from, expected.from, depth + 1) &&
      eq(actual.to, expected.to, depth + 1) &&
      actual.fromInclusive === expected.fromInclusive &&
      actual.toInclusive === expected.toInclusive
    );
  }
  if (isContext(actual) && isContext(expected)) {
    const ka = actual.keys();
    const kb = expected.keys();
    if (ka.length !== kb.length) return false;
    return kb.every((k) => actual.has(k) && eq(actual.get(k), expected.get(k), depth + 1));
  }
  if (isTemporal(actual) && isTemporal(expected)) {
    return actual.kind === expected.kind && actual.iso === expected.iso;
  }
  return false;
}

// ---------- 可读化 ----------

function show(v, depth = 0) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (isTemporal(v)) return `${v.kind}(${JSON.stringify(v.iso)})`;
  if (isRange(v)) return `(${show(v.from, depth + 1)}..${show(v.to, depth + 1)})`;
  if (Array.isArray(v)) {
    if (depth > 2) return '[…]';
    return `[${v.map((x) => show(x, depth + 1)).join(', ')}]`;
  }
  if (isContext(v)) {
    if (depth > 2) return '{…}';
    return `{${v.keys().map((k) => `${k}: ${show(v.get(k), depth + 1)}`).join(', ')}}`;
  }
  if (v && typeof v === 'object' && v.__feelFunction) return 'function';
  return String(v);
}

function describe(err) {
  if (!err) return 'unknown';
  const code = err.code ? `${err.code}` : err.name || 'Error';
  const msg = String(err.message ?? '').split('\n')[0].slice(0, 120);
  return `${code}: ${msg}`;
}

// ---------- 跑分 ----------

const only = arg('label');
const results = [];

for (const c of cases) {
  if (only && c.label !== only) continue;
  const rec = { ...c, status: 'fail', reason: 'unrun', loose: false };

  /*
   * NFR-F14：`TestResult.Result` 只有 SUCCESS / ERROR / IGNORED 三态。
   * 被登记为 IGNORED 的断言不进 ✓/✗ —— 它们不是"我们做错了"，
   * 而是**该断言考的能力不属于 FEEL 表达式层**（属宿主 / DMN 类型声明层职责）。
   * 名单在 `tooling/tck/ignored.json`，**理由逐条写在文件里**；
   * 粒度为整组 `label` 或单条 `label#id`。
   */
  const ignoredReason = IGNORED[c.label] ?? IGNORED_CASES[`${c.label}#${c.id}`] ?? null;
  if (ignoredReason) {
    rec.status = 'ignored';
    rec.reason = 'ignored';
    rec.detail = ignoredReason;
    results.push(rec);
    continue;
  }

  try {
    const opts = optsFor(c);
    let ctx = c.context ? evaluate(c.context, undefined, opts).value : undefined;
    /*
     * DMN 的**可调用体**（`businessKnowledgeModel`，以及带形参的 decision）：
     * 它们是模型里的函数，必须绑进作用域，否则 `bkm_003_1()(4)` 只能拿到 `null`（TCK 0092）。
     *
     * ⚠️ 必须排在 deps **之前**：deps 的表达式常常用到 BKM
     * （`decision_010_2` = `bkm_010_1(2)(3)(4)`，而断言要的是 `decision_010_2(5)` = 120）。
     *
     * 逐个绑定而非一次性绑定：闭包捕获的是**外层的 `ctx` 变量**，故后绑定的也能被先定义的引用。
     */
    for (const inv of c.invocables ?? []) {
      const base = isContext(ctx) ? ctx : emptyCtx(opts);
      ctx = base.with({
        [inv.name]: toFeelFunction(inv.name, (...args) => {
          const scope = isContext(ctx) ? ctx : base;
          let s = scope;
          inv.params.forEach((p, i) => {
            s = s.with({ [p.name]: args[i] ?? null });
          });
          /*
           * ★ BKM 体是**被测逻辑本身**（不是"输入数据"），故 `--strict` 下必须继承严格模式
           * —— 否则 `bkm_016_1(sqrt)`（`fn1(10,2)`，sqrt 收 2 个实参）会在体内被转成
           * `null + 诊断`，外层的真实错误就被吞掉了（0092#016）。
           */
          return evaluate(inv.source, s, STRICT ? { ...opts, errorMode: 'throw' } : opts).value;
        }),
      });
      if (/\s/.test(inv.name)) registerSpacedName(inv.name);
    }
    /*
     * DMN 语义：一个 decision 的输入包括它 `informationRequirement` 引用的其他 decision。
     * 例 `1146-decision014` = `context put(context01, "a", 2)`，`context01` 是同模型的另一个
     * decision（`{a: 1}`）。extract 已把它展成**依赖序**的 `deps` 列表，这里逐个求值并绑进作用域。
     * 不这么做的话，这类断言只会拿到 `null`，被误记成引擎失配（2026-09-25 修）。
     */
    for (const dep of c.deps ?? []) {
      const base = isContext(ctx) ? ctx : emptyCtx(opts);
      // 已被可调用体绑定的名字不再覆盖（带形参的 decision 是函数，不是它的表达式值）
      if (base.has(dep.name)) continue;
      const value = evaluate(dep.source, base, opts).value;
      ctx = base.with({ [dep.name]: value });
      /*
       * 模型里的名字可能**含关键字**（`days in weekend`，TCK 0084#014）。
       * FEEL 的 `in` 是运算符，词法上 `days in weekend` 会被切成 `days` / `in` / `weekend`；
       * 谁该赢只能由**宿主词汇表**决定 —— 这正是 `registerSpacedName` 的用途
       * （真实 DMN 宿主会把模型里的元素名登记进来）。
       */
      if (/\s/.test(dep.name)) registerSpacedName(dep.name);
    }
    let actual;
    let threw = false;
    let error = null;
    try {
      // ★ 只有被测表达式走严格模式；deps 与 <expected> 走默认（见 STRICT 处注释）
      actual = evaluate(c.expression, ctx, STRICT ? { ...opts, errorMode: 'throw' } : opts).value;
    } catch (e) {
      threw = true;
      error = e;
    }

    const isFeelError = threw && error && error.floken === true;

    if (c.errorResult) {
      if (isFeelError) {
        rec.status = 'pass';
        rec.reason = 'error-as-expected';
      } else if (!threw && actual === null) {
        rec.status = 'pass';
        rec.reason = 'null-instead-of-error';
        rec.loose = true; // 宽松口径才过；严格口径算 fail
      } else if (threw) {
        rec.status = 'fail';
        rec.reason = 'non-feel-error';
        rec.detail = describe(error);
      } else {
        rec.status = 'fail';
        rec.reason = 'expected-error-got-value';
        rec.actual = show(actual);
      }
    } else if (threw) {
      rec.status = 'fail';
      rec.reason = isFeelError ? 'threw' : 'unexpected-error';
      rec.detail = describe(error);
    } else {
      let expected;
      try {
        expected = evaluate(c.expected, undefined, opts).value;
      } catch (e) {
        rec.status = 'fail';
        rec.reason = 'expected-unparseable';
        rec.detail = describe(e);
        results.push(rec);
        continue;
      }
      rec.expectedValue = show(expected);
      numFloor = decimalsFloor(c.expected);
      if (eq(actual, expected)) {
        rec.status = 'pass';
        rec.reason = 'equal';
      } else {
        rec.status = 'fail';
        rec.reason = 'mismatch';
        rec.actual = show(actual);
      }
    }
  } catch (e) {
    rec.status = 'fail';
    rec.reason = 'harness-error';
    rec.detail = describe(e);
  }

  results.push(rec);
}

// 宽松口径：errorResult 用例里「返回 null」也算过（上游私有规则，仅对照）
// IGNORED（NFR-F14）不参与任何口径的分子分母，单独计数。
const counted = results.filter((r) => r.status !== 'ignored');
const ignoredCount = results.length - counted.length;
const strictPass = counted.filter((r) => r.status === 'pass' && !r.loose).length;
const loosePass = counted.filter((r) => r.status === 'pass').length;

/*
 * 严格口径缺口 = `errorResult="true"`（官方期望抛错）而我们**返回了 null**。
 * 这些在宽松口径下算 pass，在严格口径下算 fail —— 严格口径才是 F3 闸门判据②的目标，
 * 所以这份清单不是"参考信息"，而是**通往 100% 的待办列表**（按组聚合，便于整组攻克）。
 */
const looseRecs = counted.filter((r) => r.loose);
const looseByLabel = new Map();
for (const r of looseRecs) {
  looseByLabel.set(r.label, (looseByLabel.get(r.label) ?? 0) + 1);
}
const looseTop = [...looseByLabel.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

// ---------- 按 label 汇总 ----------

const byLabel = new Map();
for (const r of counted) {
  if (!byLabel.has(r.label)) byLabel.set(r.label, { label: r.label, total: 0, pass: 0, loose: 0 });
  const s = byLabel.get(r.label);
  s.total += 1;
  if (r.status === 'pass') {
    s.pass += 1;
    if (r.loose) s.loose += 1;
  }
}
const labels = [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label));

// ---------- 失败归因 ----------

const byReason = new Map();
for (const r of counted) {
  if (r.status === 'pass') continue;
  const key = r.reason;
  if (!byReason.has(key)) byReason.set(key, { reason: key, count: 0, labels: new Map() });
  const s = byReason.get(key);
  s.count += 1;
  s.labels.set(r.label, (s.labels.get(r.label) ?? 0) + 1);
}
const reasons = [...byReason.values()].sort((a, b) => b.count - a.count);

// ---------- 输出 ----------

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + '%' : '—');
const total = counted.length;
const pass = counted.filter((r) => r.status === 'pass').length;
const fail = total - pass;

console.log('DMN TCK · FEEL-only（B 口径）· 官方 79 个 FEEL label');
console.log(`  cases: ${path.relative(process.cwd(), CASES)}   引擎: dist/（含 temporal 档）`);
console.log('');
console.log(
  `  断言 ${total}   ✓ ${pass} (${pct(pass, total)})   ✗ ${fail}` +
    (ignoredCount ? `   ⊘ IGNORED ${ignoredCount}` : ''),
);
console.log(`  ├ 严格口径（官方 errorResult，必须抛错）: ${strictPass}/${total} (${pct(strictPass, total)})`);
console.log(`  └ 宽松口径（上游私有规则，仅与 92.6% 对照）: ${loosePass}/${total} (${pct(loosePass, total)})`);

const perfect = labels.filter((l) => l.pass === l.total).length;
console.log('');
console.log(`  label: 79 组中 ${perfect} 组 100%，${labels.length - perfect} 组有失败`);
console.log('');
console.log('  失败归因（条数 / 涉及组数）:');
for (const r of reasons) {
  console.log(`    ${r.reason.padEnd(26)} ${String(r.count).padStart(5)}  (${r.labels.size} 组)`);
}

const topN = Number(arg('top', '20'));
const worst = labels
  .map((l) => ({ ...l, miss: l.total - l.pass }))
  .filter((l) => l.miss > 0)
  .sort((a, b) => b.miss - a.miss)
  .slice(0, topN);
console.log('');
console.log(`  失败最多的 ${worst.length} 组:`);
for (const l of worst) {
  console.log(`    ${l.label.padEnd(38)} ${String(l.pass).padStart(4)}/${String(l.total).padEnd(4)}  缺 ${l.miss}`);
}

/*
 * 严格口径缺口的按组分布。**这是通往 100% 的待办列表**（不是参考信息）：
 * 每一条都要么是"我们该抛错却给了 null"，要么是"该条本就该登记 IGNORED"。
 */
if (looseTop.length) {
  console.log('');
  console.log(
    `  严格口径缺口（errorResult=true 但我们返回 null）${looseRecs.length} 条 / ${looseTop.length} 组:`,
  );
  for (const [l, n] of looseTop.slice(0, Number(arg('top', '20')))) {
    console.log(`    ${l.padEnd(38)} ${String(n).padStart(4)}`);
  }
}

const showFail = Number(arg('show-fail', '0'));
if (showFail > 0) {
  console.log('');
  console.log(`  失败样例（前 ${showFail} 条）:`);
  for (const r of results.filter((x) => x.status !== 'pass').slice(0, showFail)) {
    console.log(`    [${r.label}#${r.id}] ${r.expression}`);
    console.log(`      ${r.reason}  期望=${r.expected}${r.errorResult ? ' (errorResult)' : ''}  实际=${r.actual ?? '—'}${r.detail ? '  ' + r.detail : ''}`);
  }
}

// ---------- 基线对比 / 写出 ----------

const baselinePath = arg(
  'baseline',
  STRICT ? 'tooling/tck/baseline.labels.strict.json' : 'tooling/tck/baseline.labels.json',
);
if (argv.includes('--write-baseline')) {
  fs.mkdirSync(path.dirname(path.resolve(baselinePath)), { recursive: true });
  fs.writeFileSync(
    path.resolve(baselinePath),
    JSON.stringify(
      {
        note: 'B 口径**防退化基线**：每个 FEEL label 的 pass 数快照。重跑后任一 label 低于此处即判「标签退化」。本包从一开始就是自研 parser（零 lezer-feel 依赖），故不存在"换 parser 前后对比"的上游参照物 —— 判据① 的原始意图（分数不是 fork 来的）在前提上自动成立，本文件改任**回归护栏**。',
        source: 'DMN TCK — github.com/dmn-tck/tck（CC BY-SA，语料不随包分发）',
        clock: '2026-05-12T00:00:00.000Z',
        assertions: total,
        pass,
        labels: Object.fromEntries(labels.map((l) => [l.label, { pass: l.pass, total: l.total }])),
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`\n  基线已写出: ${baselinePath}`);
}

if (fs.existsSync(path.resolve(baselinePath)) && !argv.includes('--write-baseline')) {
  const baseline = JSON.parse(fs.readFileSync(path.resolve(baselinePath), 'utf8'));
  const regressed = [];
  for (const l of labels) {
    const base = baseline.labels?.[l.label];
    if (!base) continue;
    if (l.pass < base.pass) regressed.push(`${l.label}: ${base.pass} → ${l.pass}`);
  }
  console.log('');
  if (regressed.length) {
    console.log(`  ✗ 判据① 标签退化 ${regressed.length} 项:`);
    regressed.slice(0, 20).forEach((r) => console.log('    ' + r));
  } else {
    console.log(`  ✓ 判据① 无标签退化（对比 ${path.basename(baselinePath)}）`);
  }
}

const json = {
  generatedAt: new Date().toISOString(),
  clock: '2026-05-12T00:00:00.000Z',
  total,
  pass,
  fail,
  strictPass,
  loosePass,
  labels,
  reasons: reasons.map((r) => ({ reason: r.reason, count: r.count, labels: r.labels.size })),
  looseTotal: looseRecs.length,
  loose: looseRecs.map((r) => ({
    label: r.label,
    id: r.id,
    decision: r.decision,
    expression: r.expression,
    context: r.context,
    expected: r.expected,
  })),
  failed: results
    .filter((r) => r.status !== 'pass')
    .map((r) => ({
      label: r.label,
      id: r.id,
      decision: r.decision,
      expression: r.expression,
      context: r.context,
      expected: r.expected,
      errorResult: r.errorResult,
      actual: r.actual ?? null,
      reason: r.reason,
      detail: r.detail ?? null,
      loose: r.loose,
    })),
};

if (argv.includes('--json')) {
  const outDir = path.resolve('tmp/tck');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(json, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, 'failed.json'), JSON.stringify(json.failed, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, 'loose.json'), JSON.stringify(json.loose, null, 2), 'utf8');
  console.log(`\n  产物: tmp/tck/results.json, tmp/tck/failed.json, tmp/tck/loose.json`);
}
