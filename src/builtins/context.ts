/**
 * floken-feel · 上下文（context）内置函数
 *
 * 口径来源：DMN 1.4 §10.3.4.6（`get value` / `get entries`）与
 * §10.3.4.7（`context` / `context put` / `context merge`；后者是 DMN 1.5 增补的
 * `keys` 重载，TCK 1146 用 `nested007` / `nested008` 把两套签名钉死）。
 *
 * 一条贯穿本域的口径（与 `builtins/helpers.ts` 顶部一致）：
 * **形参类型不符是"调用非法"（抛），不是"值未知"（null）**。
 * TCK 这几组把每种坏写法都标了 `errorResult`，返回 null 只是宽松口径下的假过。
 *
 * 另一条：所有写操作都返回**新副本**，原上下文一个字节都不动
 * （TCK 1146 `nested011` / `nested012` / `decision015` / `decision016` 四条专门盯这个）。
 */

import {
  FeelContext,
  isContext,
  isList,
  type NativeFn,
  type Value,
} from '../core/types.js';
import { argTypeError, undefinedResultError } from '../core/errors.js';
import { feelTypeName, toStr } from '../core/values.js';
import { requireArity } from './helpers.js';

/** 取第 `i` 个实参必须是**上下文**；否则抛类型错 */
function reqContext(args: readonly Value[], i: number, fnName: string, param: string): FeelContext {
  const v = args[i] ?? null;
  if (!isContext(v)) throw argTypeError(fnName, param, 'context', feelTypeName(v));
  return v;
}

/**
 * 把「一个上下文实参」或「上下文列表」统一成列表。
 *
 * 规范里 `context(entries)` / `context merge(contexts)` / `context put(context, keys, …)`
 * 的形参是**列表**，但 TCK 明确要求单个上下文**强转**成单元素列表
 * （1145 `decision005`、1147 `decision012`、1146 `nested001`）。
 */
function itemsOf(v: Value): readonly Value[] {
  return isList(v) ? v : [v];
}

/**
 * 路径式写入：按 `keys` 逐层下钻，在**最深层**覆盖/新增一个键，返回新副本。
 *
 * 中间层必须是**已存在的上下文**（`nested009` 拿 `["y","a","b","c"]` 打到
 * `{y:{a:0}}` 上，`a` 是数字、下不去 → 报错）；只有最后一层允许新增键
 * （`nested001_a` 的 `b`）。
 */
function putPath(root: FeelContext, keys: readonly string[], value: Value): FeelContext {
  const [head, ...rest] = keys;
  if (head === undefined) {
    // 调用方已拦下空路径（`nested005`），这里只是防御
    throw undefinedResultError('context put', { reason: 'empty keys' });
  }
  if (rest.length === 0) {
    const entries = new Map(root.entries);
    entries.set(head, value);
    return new FeelContext(entries);
  }
  const child = root.get(head) ?? null;
  if (!isContext(child)) {
    throw undefinedResultError('context put', { failedKey: head, actualType: feelTypeName(child) });
  }
  const entries = new Map(root.entries);
  entries.set(head, putPath(child, rest, value));
  return new FeelContext(entries);
}

export const CONTEXT_BUILTINS: Record<string, NativeFn> = {
  /*
   * `get value(m, key)`：`m` 必须是**上下文**、`key` 必须是**字符串**；
   * 传 `null` / 非上下文 / 非字符串一律**返回 null**（unknown，对齐 DMN 1.4 §10.3.2.13.1
   * + feelin）。TCK 0080 把种种坏输入列成 `errorResult`（期望抛错），但规范口径是 null。
   *
   * 「键不存在 → null」仍然成立（`c.get(key) ?? null`）：那是"值存在但没这个键"，
   * 与"实参类型不对"同属 unknown，统一落 null。
   */
  'get value': (a) => {
    requireArity(a, 'get value', 2);
    const c = a[0] ?? null;
    if (!isContext(c)) return null;
    const key = a[1] ?? null;
    if (typeof key !== 'string') return null;
    return c.get(key) ?? null;
  },

  /** `get entries(m)`：键值对列表，**保持插入顺序** */
  'get entries': (a) => {
    requireArity(a, 'get entries', 1);
    const c = reqContext(a, 0, 'get entries', 'm');
    return c
      .keys()
      .map((k) => new FeelContext(new Map([['key', k], ['value', c.get(k) ?? null]])));
  },

  /**
   * `context(entries)` → 由 `[{key:…, value:…}, …]` 构造上下文。
   *
   * 校验点（TCK 1145 逐条）：列表元素必须是上下文（006/016）、
   * 必须**同时**有 `key` 与 `value` 两个成员（006/008）、
   * `key` 必须是字符串（007；空串合法，010）、
   * 键不得重复（003 —— 重复时"新上下文包含全部条目"根本做不到，故报错）。
   */
  context: (a) => {
    requireArity(a, 'context', 1);
    const raw = a[0] ?? null;
    const entries = new Map<string, Value>();
    for (const item of itemsOf(raw)) {
      if (!isContext(item)) {
        throw argTypeError('context', 'entries', 'list of contexts', feelTypeName(item));
      }
      if (!item.has('key') || !item.has('value')) {
        throw argTypeError('context', 'entries', 'entry with both key and value', 'context');
      }
      const k = item.get('key') ?? null;
      if (typeof k !== 'string') {
        throw argTypeError('context', 'entries', 'string key', feelTypeName(k));
      }
      if (entries.has(k)) {
        throw undefinedResultError('context', { reason: 'duplicate entry key', key: k });
      }
      entries.set(k, item.get('value') ?? null);
    }
    return new FeelContext(entries);
  },

  /**
   * `context put(context, key, value)` / `context put(context, keys, value)`
   * → 覆盖某键（或路径末端某键）后的**新**上下文。
   *
   * 两套签名的分流靠第四参 `argNames`：位置调用时两套都允许
   * （`nested001` 位置传列表即路径式）；命名调用时 `key:` 只收字符串、
   * `keys:` 只收字符串列表（`nested008` 的 `key: ["y","a"]` 必须报错）。
   */
  'context put': (a, _ctx, _runtime, argNames) => {
    requireArity(a, 'context put', 3);
    const c = reqContext(a, 0, 'context put', 'context');
    const keyArg = a[1] ?? null;
    const value = a[2] ?? null;
    const viaKeys = argNames?.[1] === 'keys';

    if (isList(keyArg)) {
      // `keys:` 只收列表；`key:` 只收字符串 —— 列表落在 `key` 上是签名错
      if (argNames?.[1] === 'key') {
        throw argTypeError('context put', 'key', 'string', 'list');
      }
      const keys = keyArg.map((k) => {
        if (typeof k !== 'string') {
          throw argTypeError('context put', 'keys', 'list of strings', feelTypeName(k));
        }
        return k;
      });
      if (keys.length === 0) {
        throw undefinedResultError('context put', { reason: 'empty keys' });
      }
      return putPath(c, keys, value);
    }

    if (typeof keyArg !== 'string') {
      throw argTypeError('context put', viaKeys ? 'keys' : 'key', viaKeys ? 'list of strings' : 'string', feelTypeName(keyArg));
    }
    const entries = new Map(c.entries);
    entries.set(keyArg, value);
    return new FeelContext(entries);
  },

  /** `context merge(contexts)` → 依次合并，后者覆盖前者（**不做深合并**，1147 `decision004`） */
  'context merge': (a) => {
    requireArity(a, 'context merge', 1);
    const raw = a[0] ?? null;
    const entries = new Map<string, Value>();
    for (const item of itemsOf(raw)) {
      if (!isContext(item)) {
        throw argTypeError('context merge', 'contexts', 'context', feelTypeName(item));
      }
      for (const k of item.keys()) entries.set(k, item.get(k) ?? null);
    }
    return new FeelContext(entries);
  },
};
