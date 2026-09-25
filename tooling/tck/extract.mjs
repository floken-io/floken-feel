/**
 * floken-feel · TCK 工具（工-A）· FEEL-only 用例提取器
 *
 * 用途：把 DMN TCK 语料里 `-feel-` 专项用例（79 组 / B 口径）抽成可跑的 JSON 断言集。
 * 这是 `05-包需求-floken-feel.md` §7.3 的「工-A，本包生命线」。
 *
 * 上游参照 `feelin/tasks/extract-tck-tests.js`（MIT）—— **只读思路、不拷实现**（Q9 红线）：
 *   · 它的做法是把「期望值」反编译成 FEEL 字面量源码，再把两侧都交给引擎求值后比较；
 *     我们沿用这一条**裁判思路**（因为「怎么算相等」官方没有规范，必须自己写死，见 §7.3-③），
 *     但解析、序列化、错误处理全部自研，并额外采用**官方 `errorResult` 字段**（上游用的是私有野规则）。
 *
 * 用法：
 *   TCK_DIR=<dmn-tck/tck 根目录> node tooling/tck/extract.mjs [--out=tmp/tck]
 *
 * 语料**不随包分发**（CC BY-SA 传染性，见 §7.3-⑥）：本脚本只读取外部目录，永不拷贝语料进仓库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseTree, findAll, findOne } from './xml.mjs';

const argv = process.argv.slice(2);
const outArg = argv.find((a) => a.startsWith('--out='));
const OUT_DIR = path.resolve(outArg ? outArg.slice(6) : 'tmp/tck');

/** 语料根目录：优先 `TCK_DIR`；未设时回落到本仓库开发期的沙箱位置（仅本地便利） */
const TCK_DIR = path.resolve(
  process.env.TCK_DIR ||
    path.join(process.cwd(), '..', '..', '.workbuddy', '_bpmn-sandbox', 'tck', 'raw', 'TestCases'),
);

if (!fs.existsSync(TCK_DIR)) {
  console.error(`✗ 找不到 TCK 语料目录：${TCK_DIR}`);
  console.error('  请设置环境变量 TCK_DIR 指向 dmn-tck/tck 仓库根目录（见 05-包需求-floken-feel.md §7.3-⑥）。');
  process.exit(1);
}

// ---------- decision 表达式提取 ----------

/** decision 元素上不属于「表达式」的子节点 */
const NON_EXPRESSION = new Set([
  'description',
  'question',
  'allowedAnswers',
  'variable',
  'informationRequirement',
  'knowledgeRequirement',
  'authorityRequirement',
  'extensionElements',
  'text',
  'formalParameter',
  'binding',
]);

/** 表达式容器（DMN 盒装表达式）→ FEEL 源码；不认识时返回 null */
function expressionOf(node) {
  if (!node) return null;
  switch (node.local) {
    case 'literalExpression':
      return literalText(node);
    case 'context': {
      const entries = node.children.filter((c) => c.local === 'contextEntry');
      const parts = entries.map((e) => {
        const variable = e.children.find((c) => c.local === 'variable');
        const value = e.children.find((c) => !NON_EXPRESSION.has(c.local));
        return `${keyLiteral(variable?.attrs.name ?? '')}: ${expressionOf(value) ?? 'null'}`;
      });
      return `{${parts.join(', ')}}`;
    }
    case 'list': {
      const items = node.children.filter((c) => c.local === 'item');
      if (items.length > 0) {
        return `[${items.map((i) => expressionOf(firstExpressionChild(i)) ?? 'null').join(', ')}]`;
      }
      /*
       * 决策体**本身就是** `<list>` 时，子节点是各盒装表达式（`<literalExpression>`…），
       * 没有 `<item>` 包裹 —— 这是「一个表达式」而不是「一个列表值」。
       * 不补这条规则会抽成 `[]`（TCK 0098 `date_008` 曾因此假失败）。
       */
      const parts = node.children
        .filter((c) => !NON_EXPRESSION.has(c.local))
        .map((c) => expressionOf(c) ?? 'null');
      return `[${parts.join(', ')}]`;
    }
    case 'item':
      return expressionOf(firstExpressionChild(node));
    case 'functionDefinition': {
      const params = node.children
        .filter((c) => c.local === 'formalParameter')
        .map((p) => p.attrs.name ?? '')
        .filter(Boolean);
      const body = node.children.find((c) => !NON_EXPRESSION.has(c.local));
      const inner = expressionOf(body);
      return inner === null ? null : `function(${params.join(', ')}) ${inner}`;
    }
    case 'invocation': {
      const callee = node.children.find((c) => !['binding', ...NON_EXPRESSION].includes(c.local));
      const bindings = node.children.filter((c) => c.local === 'binding');
      const args = bindings.map((b) => {
        const param = b.children.find((c) => c.local === 'formalParameter');
        const value = b.children.find((c) => !['formalParameter', ...NON_EXPRESSION].includes(c.local));
        const src = expressionOf(value) ?? 'null';
        return param ? `${keyLiteral(param.attrs.name ?? '')}: ${src}` : src;
      });
      const head = expressionOf(callee);
      if (head === null) return null;
      return `${head}(${args.join(', ')})`;
    }
    default:
      return null;
  }
}

function firstExpressionChild(node) {
  return node.children.find((c) => !NON_EXPRESSION.has(c.local)) ?? null;
}

function literalText(node) {
  const text = node.children.find((c) => c.local === 'text');
  const raw = text?.text ?? '';
  return raw.trim() ? raw.trim() : null;
}

/** 形如 `{a: 1}` 的 key 是否需要加引号 */
function keyLiteral(name) {
  if (!name) return '""';
  return /^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) ? name : JSON.stringify(name);
}

/**
 * 从 dmn 模型取 `decision name → { source, deps }`。
 *
 * `deps` = 该 decision 通过 `informationRequirement/requiredDecision` 引用的**同模型其他 decision**。
 * 例：`1146-decision014` 的表达式是 `context put(context01, "a", 2)`，而 `context01` 是本模型里
 * 另一个 decision（内容 `{a: 1}`）—— 不递归求值它，这条断言只能拿到 `null`、并被误记成引擎失配。
 * 这类用例此前计入 `mismatch`，实为**跑分器**的能力缺口（2026-09-25 修）。
 */
function collectDecisions(dmnSource) {
  const map = new Map();
  const tree = parseTree(dmnSource);
  const byId = new Map();
  for (const d of findAll(tree, 'decision')) {
    if (d.attrs.id) byId.set(d.attrs.id, d);
  }
  for (const decision of findAll(tree, 'decision')) {
    const name = decision.attrs.name ?? '';
    const exprNode = firstExpressionChild(decision);
    const deps = [];
    for (const ir of decision.children.filter((c) => c.local === 'informationRequirement')) {
      for (const rd of ir.children.filter((c) => c.local === 'requiredDecision')) {
        const href = rd.attrs.href ?? '';
        const target = byId.get(href.startsWith('#') ? href.slice(1) : href);
        if (target?.attrs.name) deps.push(target.attrs.name);
      }
    }
    map.set(name, { source: expressionOf(exprNode), deps });
  }
  return map;
}

/**
 * 抽 DMN 模型的**可调用体**（TCK 0092 的 lambda 用例全靠它）：
 * `businessKnowledgeModel`，以及**直接挂 `formalParameter`** 的 decision。
 *
 * ⚠️ 形参只认 `encapsulatedLogic` 的**直接子节点** `<formalParameter>`，这一点是 XSD 定的：
 * `encapsulatedLogic` 本身是 `tFunctionDefinition`（`formalParameter*` + `expression`）。
 * 于是 `bkm_004_1` 的 `<encapsulatedLogic><functionDefinition>…</functionDefinition>` 里，
 * `a` 属于**内层函数**、BKM 自己**零形参** —— `bkm_004_1()` 先取到函数值、再由 `(5)` 调用 → 6。
 * 若误把内层形参当成 BKM 的形参，这条就会变成 `1 + null`。
 */
function collectInvocables(dmnSource) {
  const tree = parseTree(dmnSource);
  const out = [];
  const add = (name, logic) => {
    const params = logic.children
      .filter((c) => c.local === 'formalParameter')
      .map((p) => ({ name: p.attrs.name ?? '', typeRef: p.attrs.typeRef ?? '' }))
      .filter((p) => p.name !== '');
    const source = expressionOf(firstExpressionChild(logic));
    if (name && source != null) out.push({ name, params, source });
  };
  for (const bkm of findAll(tree, 'businessKnowledgeModel')) {
    const logic = bkm.children.find((c) => c.local === 'encapsulatedLogic');
    if (logic) add(bkm.attrs.name ?? '', logic);
  }
  for (const d of findAll(tree, 'decision')) {
    if (!d.children.some((c) => c.local === 'formalParameter')) continue;
    add(d.attrs.name ?? '', d);
  }
  return out;
}

/** 按依赖序展开某 decision 依赖的其他 decision（去重，被依赖者在前） */
function depChain(name, decisions, seen = new Set()) {
  const entry = decisions.get(name);
  if (!entry) return [];
  const out = [];
  for (const d of entry.deps) {
    if (seen.has(d)) continue;
    seen.add(d);
    out.push(...depChain(d, decisions, seen));
    const dep = decisions.get(d);
    if (dep && dep.source != null) out.push({ name: d, source: dep.source });
  }
  return out;
}

// ---------- itemDefinition → 类型表 ----------

/** 类型名引用 → 具名规格（名字大小写原样保留，判定时统一小写） */
function typeRefSpec(name) {
  return { kind: 'named', name: name || 'any' };
}

/**
 * 抽 DMN 模型的 `itemDefinition` 表（`instance of <模型类型名>` 需要它，见 TCK 0070）。
 *
 * ⚠️ **有意忽略 `allowedValues`**：TCK 明确期望 `256 instance of t255` 为 **true**，
 * 而 `t255` 的 allowedValues 恰是 `[0..255]` —— 这证明 `instance of` 只看**类型**，
 * 不看取值域（同 `1.4` 规范 §10.3.5 对 `instance of` 的定义）。
 *
 * 四种形态（DMN 1.4 §7.3.2）：
 * - `typeRef` 单引用 → 具名（`Any` / `number` / 另一个 itemDefinition 名）
 * - `isCollection="true"` → `list<T>`
 * - `itemComponent*` → `context<a: T, …>`
 * - `functionItem` → `function<…> -> T`
 */
function collectItemDefinitions(dmnSource) {
  const table = {};
  const tree = parseTree(dmnSource);
  for (const def of findAll(tree, 'itemDefinition')) {
    const name = def.attrs.name;
    if (!name) continue;

    const components = def.children.filter((c) => c.local === 'itemComponent');
    const fnItem = def.children.find((c) => c.local === 'functionItem');
    const typeRef = def.children.find((c) => c.local === 'typeRef')?.text.trim();

    let spec;
    if (components.length) {
      spec = {
        kind: 'context',
        entries: components.map((c) => ({
          key: c.attrs.name ?? '',
          type: typeRefSpec(c.children.find((x) => x.local === 'typeRef')?.text.trim()),
        })),
      };
    } else if (fnItem) {
      const out = fnItem.attrs.outputTypeRef;
      spec = { kind: 'function', result: out ? typeRefSpec(out) : null };
    } else {
      spec = typeRefSpec(typeRef);
    }

    if (def.attrs.isCollection === 'true') spec = { kind: 'list', item: spec };
    table[name] = spec;
  }
  return table;
}

// ---------- 期望值 / 输入值 → FEEL 源码 ----------

/** `xsd:string` 之外的标量要 trim；字符串保留原样（尾空格是数据） */
function scalarSource(node) {
  if (node.attrs['xsi:nil'] === 'true') return 'null';
  const type = (node.attrs['xsi:type'] ?? '').split(':').pop();
  const raw = type === 'string' ? node.text : node.text.trim();
  switch (type) {
    case 'string':
      return JSON.stringify(raw);
    case 'boolean':
      return raw === 'true' ? 'true' : 'false';
    case 'decimal':
    case 'double':
    case 'float':
    case 'integer':
    case 'long':
      return raw ? raw : 'null';
    case 'date':
      return `date(${JSON.stringify(raw)})`;
    case 'time':
      return `time(${JSON.stringify(raw)})`;
    case 'dateTime':
      return `date and time(${JSON.stringify(raw)})`;
    case 'duration':
      return `duration(${JSON.stringify(raw)})`;
    default:
      return raw ? JSON.stringify(raw) : 'null';
  }
}

/**
 * 「子节点」→ FEEL 源码。
 *
 * ★ 关键规则（**位置无关，一条管到底**）：凡是**子节点全是 `component`** 的节点，
 * 就表示**一个 context** —— 每个 `component` 的 `name` 是键、其内容才是值。
 * `expected` / `inputNode` / 列表的 `item` / 嵌套的 `component` 全都走这一条。
 *
 * ⚠️ 早期版本只在 `expected` 这一层按 context 处理、其余层直接取「第一个内层 value」，
 * 于是 `<item><component name="a"><value>2</value></component></item>` 被读成 `2`（应为 `{a: 2}`）、
 * `<component name="b"><component name="c">…` 被截成 `"bar"`（应为嵌套 context）。
 * 这直接**伪造了一批 TCK 失败**（0069 的列表元素、0057/1146/1147 的嵌套 context），
 * 2026-09-25 修复 —— 教训：**先验证度量工具，再改被测代码**。
 */
function srcOfChildren(node) {
  const kids = node.children.filter((c) => c.local !== 'description');
  if (!kids.length) return 'null';
  const comps = kids.filter((c) => c.local === 'component');
  if (comps.length === kids.length) {
    return `{${comps.map((c) => `${keyLiteral(c.attrs.name ?? '')}: ${srcOfChildren(c)}`).join(', ')}}`;
  }
  if (kids.length === 1) return srcOf(kids[0]);
  // 少见形态：多个裸 value → 视为列表
  return `[${kids.map(srcOf).join(', ')}]`;
}

/** `value | list | item | component | expected | inputNode` → FEEL 源码 */
function srcOf(node) {
  switch (node.local) {
    case 'value':
      return scalarSource(node);
    case 'list':
      return `[${node.children
        .filter((c) => c.local === 'item')
        .map(srcOf)
        .join(', ')}]`;
    case 'item':
    case 'component':
    case 'expected':
    case 'inputNode':
      return srcOfChildren(node);
    default:
      return 'null';
  }
}

const containerSource = srcOfChildren;
const valueSource = srcOf;

// ---------- testCase → 断言 ----------

function collectCases(testSource, decisions, label, invocables = []) {
  const cases = [];
  const gaps = [];
  const tree = parseTree(testSource);
  const modelName = findOne(tree, 'modelName')?.text.trim() ?? '';

  for (const testCase of findAll(tree, 'testCase')) {
    const id = testCase.attrs.id ?? '';
    const inputs = testCase.children.filter((c) => c.local === 'inputNode');
    const context = inputs.length
      ? `{${inputs
          .map((n) => `${keyLiteral(n.attrs.name ?? '')}: ${containerSource(n)}`)
          .join(', ')}}`
      : null;

    for (const resultNode of testCase.children.filter((c) => c.local === 'resultNode')) {
      const decision = resultNode.attrs.name ?? '';
      const entry = decisions.get(decision);
      const expression = entry ? entry.source : null;
      const expected = containerSource(findOne([resultNode], 'expected'));

      const base = {
        label,
        model: modelName,
        id,
        decision,
        context,
        deps: depChain(decision, decisions),
        invocables,
        expected,
        errorResult: resultNode.attrs.errorResult === 'true',
      };

      if (expression === null || expression === undefined) {
        gaps.push({ ...base, reason: 'expression-unavailable' });
        cases.push({ ...base, expression: null });
      } else {
        cases.push({ ...base, expression });
      }
    }
  }
  return { cases, gaps, modelName };
}

// ---------- 主流程 ----------

const levels = fs.readdirSync(TCK_DIR).filter((n) => fs.statSync(path.join(TCK_DIR, n)).isDirectory());
const groups = [];
for (const level of levels) {
  for (const group of fs.readdirSync(path.join(TCK_DIR, level))) {
    if (!/-feel-/.test(group)) continue;
    groups.push({ level, label: group, dir: path.join(TCK_DIR, level, group) });
  }
}
groups.sort((a, b) => a.label.localeCompare(b.label));

const allCases = [];
const allGaps = [];
const labels = [];
/** `模型文件名 → 类型表`（只有带 itemDefinition 的模型才登记） */
const typesByModel = {};

for (const g of groups) {
  const files = fs.readdirSync(g.dir);
  const dmnName = files.find((f) => f.endsWith('.dmn'));
  const testName = files.find((f) => f.endsWith('.xml'));
  if (!dmnName || !testName) {
    console.warn(`· 跳过 ${g.label}（缺 .dmn 或 .xml）`);
    continue;
  }
  const dmnSource = fs.readFileSync(path.join(g.dir, dmnName), 'utf8');
  const decisions = collectDecisions(dmnSource);
  const itemDefs = collectItemDefinitions(dmnSource);
  if (Object.keys(itemDefs).length) typesByModel[dmnName] = itemDefs;
  const { cases, gaps } = collectCases(
    fs.readFileSync(path.join(g.dir, testName), 'utf8'),
    decisions,
    g.label,
    collectInvocables(dmnSource),
  );
  allCases.push(...cases);
  allGaps.push(...gaps);
  labels.push({
    label: g.label,
    level: g.level,
    assertions: cases.length,
    runnable: cases.filter((c) => c.expression !== null).length,
  });
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const write = (name, data) => fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(data, null, 2), 'utf8');
write('cases.json', allCases);
write('labels.json', labels);
write('extract-gaps.json', allGaps);
write('types.json', typesByModel);

const runnable = allCases.filter((c) => c.expression !== null);
const byLevel = {};
for (const c of allCases) byLevel[c.label.startsWith('0') ? 'x' : 'y'] = 0;
const levelCount = {};
for (const l of labels) levelCount[l.level] = (levelCount[l.level] ?? 0) + l.assertions;

console.log('DMN TCK · FEEL-only 提取完成（B 口径）');
console.log(`  语料目录: ${TCK_DIR}`);
console.log(`  组数(label): ${labels.length}  ${JSON.stringify(levelCount)}`);
console.log(`  断言总数: ${allCases.length}   可跑: ${runnable.length}   表达式缺失: ${allGaps.length}`);
console.log(`  inputNode 带入上下文的用例: ${allCases.filter((c) => c.context).length}`);
console.log(`  errorResult=true 的用例: ${allCases.filter((c) => c.errorResult).length}`);
const typeCount = Object.values(typesByModel).reduce((n, t) => n + Object.keys(t).length, 0);
console.log(`  类型表: ${Object.keys(typesByModel).length} 个模型 / ${typeCount} 条 itemDefinition`);
console.log(`  产物: ${path.relative(process.cwd(), OUT_DIR)}/{cases,labels,extract-gaps,types}.json`);
if (allGaps.length) {
  const groupsWithGaps = [...new Set(allGaps.map((g) => g.label))];
  console.log(`  ⚠ 表达式缺失涉及 ${groupsWithGaps.length} 组: ${groupsWithGaps.slice(0, 8).join(', ')}${groupsWithGaps.length > 8 ? ' …' : ''}`);
}
