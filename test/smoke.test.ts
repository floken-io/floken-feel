import { describe, it, expect } from 'vitest';
import * as feel from '../src/entries/index.js';

describe('@floken/feel · 包导出健全性', () => {
  it('导出 feelin 同款的两个主函数', () => {
    expect(typeof feel.evaluate).toBe('function');
    expect(typeof feel.unaryTest).toBe('function');
  });

  it('导出解析/诊断/内置函数与类型守卫', () => {
    expect(typeof feel.parseExpression).toBe('function');
    expect(typeof feel.parseUnaryTests).toBe('function');
    expect(typeof feel.tokenize).toBe('function');
    expect(typeof feel.registerBuiltin).toBe('function');
    expect(typeof feel.isContext).toBe('function');
    expect(typeof feel.isList).toBe('function');
    expect(typeof feel.isTemporal).toBe('function');
    expect(typeof feel.isRange).toBe('function');
  });

  it('内置函数表非空且含核心函数', () => {
    expect(Object.keys(feel.BUILTINS).length).toBeGreaterThan(20);
    for (const name of ['abs', 'floor', 'count', 'sum', 'not', 'string length']) {
      expect(feel.BUILTINS[name]).toBeTypeOf('function');
    }
  });

  it('registerBuiltin 可扩展自定义函数', () => {
    feel.registerBuiltin('double', (args) => {
      const n = feel.toNumber(args[0] ?? null);
      return n === null ? null : n * 2;
    });
    expect(feel.evaluate('double(21)').value).toBe(42);
  });

  it('所有含空格的内置名都在多词名表里（否则 parser 无法合并 token）', () => {
    const missing = Object.keys(feel.BUILTINS).filter(
      (n) => n.includes(' ') && !feel.SPACED_BUILTINS.has(n),
    );
    expect(missing).toEqual([]);
  });

  it('运行时注册的多词内置函数可被解析与调用（注册表 ↔ 多词名表联动）', () => {
    feel.registerBuiltin('my custom fn', (args) => args[0] ?? null);
    expect(feel.SPACED_BUILTINS.has('my custom fn')).toBe(true);
    expect(feel.evaluate('my custom fn(7)').value).toBe(7);
  });
});
