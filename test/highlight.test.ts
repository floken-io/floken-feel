import { describe, it, expect } from 'vitest';
import { highlight } from '../src/entries/editor.js';
import { highlight as highlightFromMain } from '../src/entries/index.js';

function kindMap(src: string): Record<string, string> {
  return Object.fromEntries(highlight(src).map((s) => [s.value, s.kind]));
}

describe('floken-feel · 语法着色（供设计器使用）', () => {
  it('关键字 / 布尔 / null / 数字 / 字符串 / 运算符 / 变量', () => {
    const k = kindMap('if a > 1 then "x" else null');
    expect(k['if']).toBe('keyword');
    expect(k['then']).toBe('keyword');
    expect(k['else']).toBe('keyword');
    expect(k['null']).toBe('null');
    expect(k['1']).toBe('number');
    expect(k['"x"']).toBe('string');
    expect(k['>']).toBe('operator');
    expect(k['a']).toBe('variable');
  });

  it('true / false 归入 boolean', () => {
    const k = kindMap('true and false');
    expect(k['true']).toBe('boolean');
    expect(k['false']).toBe('boolean');
    expect(k['and']).toBe('keyword');
  });

  it('后跟括号的名字识别为函数', () => {
    const k = kindMap('abs(-3) + a');
    expect(k['abs']).toBe('function');
    expect(k['a']).toBe('variable');
  });

  it('多词内置名整体识别为函数（与解析边界一致）', () => {
    const spans = highlight('list contains([1], 1)');
    expect(spans[0]).toMatchObject({ kind: 'function', value: 'list contains' });
  });

  it('标点与区间运算符', () => {
    const k = kindMap('{ a: [1..3] }');
    expect(k['{']).toBe('punctuation');
    expect(k[':']).toBe('punctuation');
    expect(k['..']).toBe('operator');
  });

  it('注释单独成段且保留原文', () => {
    const spans = highlight('1 + 2 // note');
    const c = spans.find((s) => s.kind === 'comment');
    expect(c?.value).toBe('// note');
  });

  it('span 单调不重叠，且 value 等于源码切片', () => {
    const src = 'if a > 1 then "x" else null // c';
    const spans = highlight(src);
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i]!.from).toBeGreaterThanOrEqual(spans[i - 1]!.to);
    }
    expect(spans.map((s) => src.slice(s.from, s.to))).toEqual(spans.map((s) => s.value));
  });

  it('非法源码不抛异常，且**降级为「已识别部分 + error 区间」**（不整段掉色）', () => {
    expect(() => highlight('1 @ 2')).not.toThrow();
    expect(() => highlight('"未闭合')).not.toThrow();

    // 未闭合字符串：坏掉的那一段标 error，它之前的照常着色
    const s = '1 + "abc';
    const spans = highlight(s);
    expect(spans[0]).toMatchObject({ kind: 'number', value: '1' });
    expect(spans.at(-1)).toMatchObject({ kind: 'error', value: '"abc', from: 4, to: s.length });
    // value 恒等于源码切片（供编辑器按 span 拼回原串）
    expect(spans.map((x) => s.slice(x.from, x.to))).toEqual(spans.map((x) => x.value));

    // 裸 @（还没敲到 `"`）同理
    const t = highlight('if a then @');
    expect(t.at(-1)).toMatchObject({ kind: 'error', value: '@' });
    expect(t.filter((x) => x.kind === 'keyword').map((x) => x.value)).toEqual(['if', 'then']);
  });

  it('★ 打字中间态不允许整段掉色（回归：原实现 101 个中间态里 37 个返回 []）', () => {
    const exprs = [
      'date("2020-01-01")',
      'a + @"PT1H"',
      'duration("P1D") * 2',
      'if a then @"2020-01-01" else null',
      'string length("abc")',
    ];
    let checked = 0;
    for (const e of exprs) {
      for (let i = 1; i <= e.length; i += 1) {
        expect(highlight(e.slice(0, i)).length).toBeGreaterThan(0);
        checked += 1;
      }
    }
    expect(checked).toBe(101);
  });

  it('主入口与 editor 子路径导出同一个实现', () => {
    expect(highlightFromMain).toBe(highlight);
  });
});
