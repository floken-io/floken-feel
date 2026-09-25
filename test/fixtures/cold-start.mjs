/**
 * 冷启动探针（在**全新进程**里跑）
 *
 * 为什么必须是子进程：`floken-feel/temporal` 的注册是**全局且不可逆**的，
 * 同一个进程里只要有任何一个模块 import 过它，"未加载"的场景就再也复现不出来。
 * 而"未加载时必须抛带修复提示的错误"（AC-F7）恰恰是**进程启动态**的性质 ——
 * 只有在真正干净的进程里测，才算数。
 *
 * 用法：
 *   node test/fixtures/cold-start.mjs cold   → 只探"未加载"
 *   node test/fixtures/cold-start.mjs load   → 探"未加载 → import → 可用"
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

process.stdout.write(JSON.stringify(out));
