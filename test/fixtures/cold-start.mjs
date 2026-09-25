/**
 * 冷启动探针（在**全新进程**里跑）
 *
 * 为什么必须是子进程：`floken-feel/temporal` 的注册是**全局且不可逆**的，
 * 同一个进程里只要有任何一个模块 import 过它，"未加载"的场景就再也复现不出来。
 * 而"未加载时必须抛带修复提示的错误"（AC-F7）恰恰是**进程启动态**的性质 ——
 * 只有在真正干净的进程里测，才算数。
 *
 * 用法：
 *   node test/fixtures/cold-start.mjs cold          → 只探"未加载"
 *   node test/fixtures/cold-start.mjs load          → 探"未加载 → import → 可用"
 *   node test/fixtures/cold-start.mjs polyfill-only → 埋雷证明**不读** globalThis.Temporal（ADR Q32）
 *   node test/fixtures/cold-start.mjs dep-missing   → 用解析钩子让 `temporal-polyfill` 判为"没装"，
 *                                                     证明缺依赖时抛结构化错误而非裸抛（AGENTS.md §5）
 *
 * 依赖 `dist/`（发布产物形态）；未构建时输出 `{ skipped: true }`。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 用 fileURLToPath 而非手写 pathname：仓库路径含非 ASCII（"流程引擎开发"），
// URL 里是 percent-encoded，手工去前缀会拼出不存在的路径。
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '..', '..', 'dist');

if (!existsSync(path.join(dist, 'index.js'))) {
  process.stdout.write(JSON.stringify({ skipped: true, reason: 'dist/ 尚未构建' }));
  process.exit(0);
}

const mode = process.argv[2] ?? 'cold';
const feel = await import(pathToFileURL(path.join(dist, 'index.js')).href);

const probe = (src) => {
  try {
    const r = feel.evaluate(src);
    return { threw: null, value: r.value === null ? null : JSON.parse(JSON.stringify(r.value)) };
  } catch (e) {
    return { threw: e?.code ?? e?.name ?? 'Error', message: String(e?.message ?? '') };
  }
};

const out = {
  mode,
  core: probe('date("2020-01-01")'),
  atLiteral: probe('@"2020-01-01"'),
};

if (mode === 'load') {
  await import(pathToFileURL(path.join(dist, 'temporal.js')).href);
  out.afterLoad = probe('date("2020-01-01")');
  out.afterAtLiteral = probe('@"2020-01-01"');
}

if (mode === 'polyfill-only') {
  // 埋雷：此后**任何**对 globalThis.Temporal 的读取都会抛（`typeof` 也会触发 getter）。
  // 若实现仍按"原生优先"取源，本进程必然炸；能正常跑完即证明实现只认 polyfill。
  Object.defineProperty(globalThis, 'Temporal', {
    configurable: true,
    get() {
      throw new Error('floken-feel read globalThis.Temporal');
    },
  });
  try {
    const entry = await import(pathToFileURL(path.join(dist, 'temporal.js')).href);
    out.entryLoaded = true;
    out.usesPolyfill = typeof entry.getTemporal()?.PlainDate?.from === 'function';
  } catch (e) {
    out.entryLoaded = false;
    out.loadFailure = String(e?.message ?? e);
  }
  out.afterLoad = probe('date("2020-01-01")');
}

if (mode === 'dep-missing') {
  // 复现"宿主忘了装 peer 依赖"：注册解析钩子把 `temporal-polyfill*` 判为解析失败。
  // 抛出的 ERR_MODULE_NOT_FOUND 与真实现场一致，且**零文件系统操作**
  // （复制 dist 到无 node_modules 目录那套会被本机沙箱的批量删除拦截）。
  const { register } = await import('node:module');
  register('./block-temporal-dep.mjs', import.meta.url);
  try {
    await import(pathToFileURL(path.join(dist, 'temporal.js')).href);
    out.threw = null;
  } catch (e) {
    out.threw = e?.code ?? e?.name ?? 'Error';
    out.errorName = e?.name ?? null;
    out.message = String(e?.message ?? '');
    out.hint = e?.hint ?? null;
    out.pkg = e?.pkg ?? null;
    out.floken = e?.floken ?? null;
    out.isBareNodeError = e?.code === 'ERR_MODULE_NOT_FOUND';
  }
}

process.stdout.write(JSON.stringify(out));
