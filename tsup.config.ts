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
  // ★ 不开 sourcemap：`.map` 的 `sourcesContent` 会把**原始 TS 源码整段嵌进去**
  // （实测 feel 曾 22 万字符，占 unpacked 体积 67%），等于"源码跟着包发出去"。
  // 发布策略是「npm 只发产物，源码只在 GitHub」，所以这里彻底不生成 ——
  // dist js 末尾也就不会有 `//# sourceMappingURL=` 那条（浏览器 devtools 不会再报加载失败）。
  // 调试走 src（vitest 直接跑源码），不依赖 dist 断点。
  sourcemap: false,
  splitting: true,
  treeshake: true,
  clean: true,
  // ★★ 绝对不能被 bundle 进产物（NFR-F12）：core/unary-tests 不得含 temporal 静态引用。
  // 同时列子路径：实现源是 `temporal-polyfill/implementation`（见 src/temporal/index.ts），
  // 只写包名的话，将来某次把 specifier 改成字面量就会被 esbuild 静默打进来。
  external: ['temporal-polyfill', 'temporal-polyfill/*'],
});
