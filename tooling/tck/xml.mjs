/**
 * @floken-io/feel · TCK 工具（工-A）· 极小 XML 扫描器
 *
 * 为什么自研：本包**零运行时依赖**，工具链也不引入 `saxen`/`fast-xml-parser`
 * （上游 `feelin/tasks/extract-tck-tests.js` 用了 `saxen`，我们只读其思路、不拷实现 —— Q9）。
 *
 * 够用即止的边界：
 * - 支持：XML 声明、注释、CDATA、属性（单/双引号）、自闭合、实体解码
 * - 不做：DTD/实体定义、命名空间**映射**（只去前缀，调用方按 localName 匹配）
 *
 * 语料里的前缀**不稳定**（`<testCases>` 与 `<tc:testCases>` 都存在），
 * 所以一律按 `localName` 匹配，`name` 保留原样仅供调试。
 */

const NAMED_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** 解码 XML 实体（含数字实体） */
export function decodeEntities(input) {
  if (input.indexOf('&') === -1) return input;
  return input.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/** 元素描述：`{ name, local, attrs, selfClosing }`；`attrs` 已解码 */
function makeElement(rawName, rawAttrs, selfClosing) {
  const name = rawName;
  const colon = name.indexOf(':');
  const local = colon === -1 ? name : name.slice(colon + 1);
  const attrs = Object.create(null);
  for (const m of rawAttrs.matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? '');
  }
  return { name, local, attrs, selfClosing };
}

/**
 * 流式扫描 XML。`handlers = { openTag(el), closeTag(el), text(value) }`
 * - `text` 收到的已是解码后的文本（CDATA 原样）
 * - 属性名保留前缀（`xsi:type`），需按原样取
 */
export function parseXml(source, handlers) {
  const { openTag, closeTag, text } = handlers;
  const len = source.length;
  let i = 0;

  while (i < len) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      emitText(source.slice(i));
      break;
    }
    if (lt > i) emitText(source.slice(i, lt));

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      const body = source.slice(lt + 9, end === -1 ? len : end);
      if (body && text) text(body, /* raw */ true);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (source.startsWith('<?', lt) || source.startsWith('<!', lt)) {
      const end = source.indexOf('>', lt);
      i = end === -1 ? len : end + 1;
      continue;
    }

    const gt = findTagEnd(source, lt);
    if (gt === -1) break;
    const inner = source.slice(lt + 1, gt);
    i = gt + 1;

    if (inner[0] === '/') {
      const el = makeElement(inner.slice(1).trim(), '', true);
      closeTag?.(el);
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameEnd = body.search(/[\s/]/);
    const rawName = nameEnd === -1 ? body : body.slice(0, nameEnd);
    const rawAttrs = nameEnd === -1 ? '' : body.slice(nameEnd);
    const el = makeElement(rawName, rawAttrs, selfClosing);
    openTag?.(el);
    if (selfClosing) closeTag?.(el);
  }

  function emitText(raw) {
    if (!raw || !text) return;
    text(decodeEntities(raw), false);
  }
}

/** 找标签的结束 `>`，跳过属性值里的 `>` */
function findTagEnd(source, start) {
  let quote = '';
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return i;
  }
  return -1;
}

/**
 * 便捷入口：把整段 XML 收成嵌套节点树（TCK 语料体量很小，够用）。
 * 返回 `{ name, local, attrs, children, text }[]`（根级元素数组）。
 */
export function parseTree(source) {
  const roots = [];
  const stack = [];
  parseXml(source, {
    openTag(el) {
      const node = { name: el.name, local: el.local, attrs: el.attrs, children: [], text: '' };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else roots.push(node);
      if (!el.selfClosing) stack.push(node);
    },
    closeTag(el) {
      const top = stack[stack.length - 1];
      if (top && top.name === el.name) stack.pop();
      else if (top) {
        // 容错：XML 不规整时按名字回退匹配
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].name === el.name) {
            stack.length = i;
            break;
          }
        }
      }
    },
    text(value) {
      const top = stack[stack.length - 1];
      if (top) top.text += value;
    },
  });
  return roots;
}

/** 深度优先找所有 localName 命中的节点 */
export function findAll(nodes, local) {
  const out = [];
  const walk = (list) => {
    for (const n of list) {
      if (n.local === local) out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** 找第一个 localName 命中的后代 */
export function findOne(nodes, local) {
  for (const n of nodes) {
    if (n.local === local) return n;
    const hit = findOne(n.children, local);
    if (hit) return hit;
  }
  return null;
}
