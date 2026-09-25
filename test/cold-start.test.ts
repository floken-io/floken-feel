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

/** 子进程不可用的典型错误码（Windows 文件锁 / 受限沙箱下会是 EBUSY） */
const SPAWN_BLOCKED = /EBUSY|EAGAIN|EMFILE|EPERM/;

/**
 * 子进程的 stdio。
 *
 * ⚠️ **必须显式 `ignore` 掉 stdin**：默认的 `'pipe'` 会给 stdin 也接一根管道，
 * 而受限沙箱（以及部分 Windows 环境）会在这根管道上直接 `EBUSY`。
 * 本 fixture 从不读 stdin，关掉它既更稳也更语义正确。
 */
const STDIO: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe'];

/** 同步休眠（spawn 偶发 EBUSY，重试前退避；与 `tooling/verify.mjs` 同一手法） */
function sleep(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* 不支持时退化为立即重试 */
  }
}

/**
 * 本机能否 spawn 子进程。
 *
 * 为什么需要这道闸：嵌套子进程在极端受限环境下会以 `EBUSY` 失败，
 * 那是**环境限制**而不是契约被破坏 —— 此时应 `skip` 并说明，
 * 而不是把一个断言都没跑到当作用例失败（`tooling/verify.mjs` 对同类问题
 * 的处理是"退化为进程内实现"，此处无法退化，只能跳过）。
 */
const canSpawn = (() => {
  for (let i = 0; i < 3; i += 1) {
    try {
      execFileSync(process.execPath, ['-e', '0'], { stdio: STDIO });
      return true;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (!SPAWN_BLOCKED.test(msg)) return true; // 别的错因：交给用例去暴露
      if (i < 2) sleep(300);
    }
  }
  return false;
})();

if (distReady && !canSpawn) {
  console.warn(
    '[cold-start] 本机禁止嵌套子进程（spawn EBUSY），4 条冷启动契约用例已跳过。' +
      '可手动核对：node test/fixtures/cold-start.mjs {cold|load|polyfill-only|dep-missing}',
  );
}

const run = (
  mode: 'cold' | 'load' | 'polyfill-only' | 'dep-missing',
) => {
  const delays = [0, 300, 900, 2000];
  let lastErr: unknown;
  for (let i = 0; i < delays.length; i += 1) {
    try {
      return JSON.parse(
        execFileSync(process.execPath, [fixture, mode], { encoding: 'utf8', stdio: STDIO }),
      ) as {
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
    } catch (e) {
      lastErr = e;
      const msg = String((e as Error)?.message ?? e);
      if (!SPAWN_BLOCKED.test(msg)) throw e;
      if (i < delays.length - 1) sleep(delays[i + 1] ?? 500);
    }
  }
  throw lastErr;
};

describe.skipIf(!distReady || !canSpawn)('floken-feel · 冷启动契约（AC-F7）', () => {
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

describe.skipIf(!distReady || !canSpawn)('floken-feel · 时间实现源（ADR Q32：只用 temporal-polyfill）', () => {
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
