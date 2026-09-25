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
      return `[${items.map((i) => expressionOf(firstExpressionChild(i)) ?? 'null').join(', ')}]`;
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

/** 从 dmn 模型取 `decision name → FEEL 源码` */
function collectDecisions(dmnSource) {
  const map = new Map();
  const tree = parseTree(dmnSource);
  for (const decision of findAll(tree, 'decision')) {
    const name = decision.attrs.name ?? '';
    const exprNode = firstExpressionChild(decision);
    const source = expressionOf(exprNode);
    map.set(name, source);
  }
  return map;
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

/** 容器（expected / inputNode）的子结构 → FEEL 源码 */
function containerSource(node) {
  const kids = node.children.filter((c) => c.local !== 'description');
  const components = kids.filter((c) => c.local === 'component');
  if (components.length && components.length === kids.length) {
    const parts = components.map((c) => {
      const inner = firstValueChild(c);
      return `${keyLiteral(c.attrs.name ?? '')}: ${valueSource(inner)}`;
    });
    return `{${parts.join(', ')}}`;
  }
  if (kids.length === 1) return valueSource(kids[0]);
  if (!kids.length) return 'null';
  // 少见形态：多个裸 value → 视为列表
  return `[${kids.map(valueSource).join(', ')}]`;
}

function firstValueChild(node) {
  return node.children.find((c) => ['value', 'list', 'component', 'item'].includes(c.local)) ?? null;
}

/** `value | list | item | component` → FEEL 源码 */
function valueSource(node) {
  if (!node) return 'null';
  switch (node.local) {
    case 'value':
      return scalarSource(node);
    case 'list': {
      const items = node.children.filter((c) => c.local === 'item');
      return `[${items.map(valueSource).join(', ')}]`;
    }
    case 'item':
      return valueSource(firstValueChild(node));
    case 'component': {
      const inner = firstValueChild(node);
      if (!inner) return 'null';
      // 列表里的 component（如 `[{a: 1}, {a: 2}]`）是 context 元素
      if (inner.local === 'component') {
        const parts = [node, ...node.children.filter((c) => c.local === 'component')];
        return `{${parts.map((c) => `${keyLiteral(c.attrs.name ?? '')}: ${valueSource(firstValueChild(c))}`).join(', ')}}`;
      }
      return valueSource(inner);
    }
    case 'expected':
    case 'inputNode':
      return containerSource(node);
    default:
      return 'null';
  }
}

// ---------- testCase → 断言 ----------

function collectCases(testSource, decisions, label) {
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
      const expression = decisions.get(decision);
      const expected = containerSource(findOne([resultNode], 'expected'));

      const base = {
        label,
        model: modelName,
        id,
        decision,
        context,
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

for (const g of groups) {
  const files = fs.readdirSync(g.dir);
  const dmnName = files.find((f) => f.endsWith('.dmn'));
  const testName = files.find((f) => f.endsWith('.xml'));
  if (!dmnName || !testName) {
    console.warn(`· 跳过 ${g.label}（缺 .dmn 或 .xml）`);
    continue;
  }
  const decisions = collectDecisions(fs.readFileSync(path.join(g.dir, dmnName), 'utf8'));
  const { cases, gaps } = collectCases(fs.readFileSync(path.join(g.dir, testName), 'utf8'), decisions, g.label);
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
console.log(`  产物: ${path.relative(process.cwd(), OUT_DIR)}/{cases,labels,extract-gaps}.json`);
if (allGaps.length) {
  const groupsWithGaps = [...new Set(allGaps.map((g) => g.label))];
  console.log(`  ⚠ 表达式缺失涉及 ${groupsWithGaps.length} 组: ${groupsWithGaps.slice(0, 8).join(', ')}${groupsWithGaps.length > 8 ? ' …' : ''}`);
}
