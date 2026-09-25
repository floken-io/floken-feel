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

  it('非法源码不抛异常（返回已识别部分或空）', () => {
    expect(() => highlight('1 @ 2')).not.toThrow();
    expect(() => highlight('"未闭合')).not.toThrow();
    expect(highlight('"未闭合')).toEqual([]);
  });

  it('主入口与 editor 子路径导出同一个实现', () => {
    expect(highlightFromMain).toBe(highlight);
  });
});
