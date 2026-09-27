import { describe, it, expect } from 'vitest';
import { diagnose, diagnoseUnaryTests, tokens, parse } from '../src/entries/editor.js';

describe('@floken-io/feel/editor · 诊断', () => {
  it('正确表达式 → 无诊断', () => {
    expect(diagnose('1 + 2')).toEqual([]);
    expect(diagnose('if a > 1 then "x" else "y"')).toEqual([]);
  });

  it('语法错误 → 返回诊断（不抛异常）', () => {
    const d = diagnose('1 +');
    expect(d).toHaveLength(1);
    // 诊断码走 AGENTS.md §5 的命名规则：FEEL_<类别>_<对象>
    expect(d[0]?.code).toMatch(/^FEEL_SYNTAX_/);
    expect(d[0]?.severity).toBe('error');
    expect(d[0]?.message).toBeTruthy();
  });

  it('诊断带位置信息（供编辑器波浪线）', () => {
    const d = diagnose('1 @ 2');
    expect(d).toHaveLength(1);
    expect(d[0]?.start).toBe(2);
    expect(d[0]?.end).toBeGreaterThan(2);
  });

  it('★ 期望类错误给出 expected + 可读建议（"可能漏了一个 )"）', () => {
    const d = diagnose('(1 + 2');
    expect(d).toHaveLength(1);
    expect(d[0]?.code).toBe('FEEL_SYNTAX_EXPECTED_TOKEN');
    expect(d[0]?.expected).toEqual(['rparen']);
    expect(d[0]?.suggestions?.[0]).toContain(')');
  });

  it('unary tests 诊断', () => {
    expect(diagnoseUnaryTests('[1..10]')).toEqual([]);
    expect(diagnoseUnaryTests('< 10, >= 20')).toEqual([]);
    expect(diagnoseUnaryTests('[1..')).toHaveLength(1);
  });

  it('分词供高亮', () => {
    const t = tokens('a + 1');
    expect(t.length).toBeGreaterThan(0);
    expect(t.map((x) => x.value).join(' ')).toBe('a + 1');
  });

  it('parse 返回 AST', () => {
    expect(parse('1').type).toBe('lit');
  });
});
