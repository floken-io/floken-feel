import { defineConfig } from 'tsup';

export default defineConfig({
  // 4 个公开子路径入口都在 src/entries/ 下（只做 re-export），
  // entry 的 key 决定 dist 产物名，故 exports 映射保持不变。
  entry: {
    index: 'src/entries/index.ts',
    'unary-tests': 'src/entries/unary-tests.ts',
    temporal: 'src/entries/temporal.ts',
    editor: 'src/entries/editor.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'neutral',
  dts: true,
  sourcemap: true,
  splitting: true,
  treeshake: true,
  clean: true,
  // ★★ 绝对不能被 bundle 进产物（NFR-F12）：core/unary-tests 不得含 temporal 静态引用。
  // 同时列子路径：实现源是 `temporal-polyfill/implementation`（见 src/temporal/index.ts），
  // 只写包名的话，将来某次把 specifier 改成字面量就会被 esbuild 静默打进来。
  external: ['temporal-polyfill', 'temporal-polyfill/*'],
});
