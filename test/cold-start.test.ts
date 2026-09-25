import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * 冷启动契约（AC-F7 的**双向**验收）
 *
 * 为什么这一组必须走子进程：时间能力的注册是全局且不可逆的，
 * 同进程里只要有一个文件 import 过 `floken-feel/temporal`，"未加载"分支就再也走不到。
 * 参见 `test/fixtures/cold-start.mjs`。
 *
 * 反向面（2026-09-25 补）：**import 即注册** —— 此前本档只提供 `evaluateTemporal()`
 * 这类显式 API，import 本身不改变全局表，于是错误提示里的
 * `await import("floken-feel/temporal")` 照着做也没用（提示不可执行）。
 */

const fixture = path.resolve('test/fixtures/cold-start.mjs');
const distReady = existsSync(path.resolve('dist/index.js'));

const run = (
  mode: 'cold' | 'load' | 'polyfill-only' | 'dep-missing',
) =>
  JSON.parse(execFileSync(process.execPath, [fixture, mode], { encoding: 'utf8' })) as {
    skipped?: boolean;
    core?: { threw: string | null; value: unknown; message?: string };
    atLiteral?: { threw: string | null; value: unknown };
    afterLoad?: { threw: string | null; value: unknown };
    afterAtLiteral?: { threw: string | null; value: unknown };
    entryLoaded?: boolean;
    usesPolyfill?: boolean;
    loadFailure?: string;
    threw?: string | null;
    errorName?: string | null;
    message?: string;
    hint?: string | null;
    pkg?: string | null;
    floken?: boolean | null;
    isBareNodeError?: boolean;
  };

describe.skipIf(!distReady)('floken-feel · 冷启动契约（AC-F7）', () => {
  it('未加载 ./temporal：具名时间函数与 @"…" 字面量都抛未加载，且提示是**可执行的**', () => {
    const r = run('cold');
    expect(r.core?.threw).toBe('FEEL_NOT_LOADED_TEMPORAL');
    expect(r.atLiteral?.threw).toBe('FEEL_NOT_LOADED_TEMPORAL');
    // 提示里的动作必须真的能解决问题（照着做 → 下面那条测试即证明）
    expect(r.core?.message).toContain('await import("floken-feel/temporal")');
  });

  it('import ./temporal 之后：同一个 evaluate 立即可用（import 即注册，无需额外调用）', () => {
    const r = run('load');
    expect(r.afterLoad?.threw).toBeNull();
    expect(r.afterLoad?.value).toMatchObject({ kind: 'date', iso: '2020-01-01' });
    expect(r.afterAtLiteral?.threw).toBeNull();
    expect(r.afterAtLiteral?.value).toMatchObject({ kind: 'date', iso: '2020-01-01' });
  });
});

describe.skipIf(!distReady)('floken-feel · 时间实现源（ADR Q32：只用 temporal-polyfill）', () => {
  it('把 globalThis.Temporal 设成"一读就炸"的陷阱后仍能正常工作 —— 证明实现不读原生', () => {
    const r = run('polyfill-only');
    // 陷阱生效的前提下，入口必须仍能装载成功
    expect(r.entryLoaded).toBe(true);
    expect(r.loadFailure).toBeUndefined();
    expect(r.usesPolyfill).toBe(true);
    // 且时间函数照常工作（若走了原生，这一句会拿到陷阱抛出的错误）
    expect(r.afterLoad?.threw).toBeNull();
    expect(r.afterLoad?.value).toMatchObject({ kind: 'date', iso: '2020-01-01' });
  });

  it('缺 temporal-polyfill 时抛 FEEL_ENV_TEMPORAL_MISSING（不是裸 ERR_MODULE_NOT_FOUND）', () => {
    const r = run('dep-missing');
    expect(r.threw).toBe('FEEL_ENV_TEMPORAL_MISSING');
    expect(r.isBareNodeError).toBe(false);
    expect(r.errorName).toBe('FeelEnvError');
    expect(r.pkg).toBe('feel');
    expect(r.floken).toBe(true);
    // 修复提示必须是**照着做就能解决**的动作（AGENTS.md §5）
    expect(r.hint).toContain('temporal-polyfill');
  });
});
