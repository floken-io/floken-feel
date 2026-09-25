/**
 * floken-feel · 多词（带空格）名字表
 *
 * 词法阶段把 `list contains` 切成两个 `name` token，语法阶段需要一张
 * 「哪些多词名应被合并成一个标识符」的表才能正确解析。
 *
 * 为什么放在 `core/` 而不是 `builtins/`：parser 必须能独立拿到这张表
 * （`./editor` 子路径只装载 core，不装载内置函数库），因此 core 不能反向
 * 依赖 builtins。内置函数注册时（见 `builtins/registry.ts`）会往这里追加，
 * 所以三者依赖方向始终是 `core ← builtins`。
 */

/**
 * 初始多词名表。
 * 时间类名字（`date and time` / `years and months duration`）的**实现**在
 * `./temporal`，这里只登记名字，不引入任何 temporal 依赖（NFR-F12）。
 */
export const SPACED_NAMES: Set<string> = new Set([
  // 列表
  'list contains',
  'distinct values',
  'index of',
  'insert before',
  // 字符串
  'string length',
  'string join',
  'upper case',
  'lower case',
  'substring before',
  'substring after',
  'starts with',
  'ends with',
  // 数值
  'round half up',
  'round half down',
  // 上下文
  'get value',
  'get entries',
  'context put',
  'context merge',
  // 时间（实现见 ./temporal）
  'date and time',
  'years and months duration',
]);

/** 追加一个多词名（名字不含空格时为 no-op） */
export function registerSpacedName(name: string): void {
  if (name.includes(' ')) SPACED_NAMES.add(name);
}
