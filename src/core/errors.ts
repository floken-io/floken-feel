/**
 * floken-feel · 错误与诊断契约（feel 侧实现）
 *
 * 五包通用的错误处理契约见仓库根 `AGENTS.md` §5「错误处理契约」。本档落实 feel 这一侧：
 *
 * 1. **两条通道不许混**：`FeelError` 系（抛出，调用方无法继续） vs `Diagnostic`（随结果返回，可继续）。
 * 2. **结构契约，不共享基类**：五包是独立仓且 moddle/feel 零互相依赖，
 *    因此**禁止跨包 import 错误基类**；改为逐字约定字段形状
 *    （`name` / `code` / `pkg` / `position` / `node` / `hint` / `details`）。
 * 3. **错误码是稳定契约**：一旦发布不得改名（性质同 XML 前缀），只能新增。
 *    命名规则 `<域>_<类别>_<对象>`，全大写蛇形，域 = 包短名（本包 `FEEL`）。
 * 4. **message 面向人、不含易变数据**：计数 / id / 名字一律进 `details`，否则宿主断言会碎。
 */

/** 诊断分级（moddle 校验分级 error/warn/info，见 01-moddle §11） */
export type Severity = 'error' | 'warn' | 'info';

/** 源码定位：**0-based、左闭右开** */
export interface Position {
  from: number;
  to: number;
}

/** 模型定位：moddle / engine / dmn 用（`path` 形如 `a.b[0].c`） */
export interface NodeRef {
  id?: string;
  path?: string;
}

/**
 * 统一诊断形状 = `05-feel` §6 的 `Diagnostic` **+ `severity`**
 * （补齐 `severity` 是为了让 moddle 的校验分级复用同一形状；`start`/`end` 为扁平偏移，不用 `position`）。
 */
export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  start: number;
  end: number;
  /** 此处期望的 token / 值（编辑器用于"可能漏了一个 `)`"） */
  expected?: string[];
  /** 补全候选 */
  suggestions?: string[];
}

/**
 * `Diagnostic` 的别名。
 * 保留它是因为公开结果壳沿用 feelin 的字段名 `warnings`（见 `EvalResult`），
 * 需要一个和该字段对应的类型名。
 */
export type Warning = Diagnostic;

// ---------------- 错误码 ----------------

/** 抛出类错误的码表（`FeelError` 家族） */
export const FEEL_ERROR_CODES = {
  // 词法 / 语法
  SYNTAX_UNEXPECTED_CHARACTER: 'FEEL_SYNTAX_UNEXPECTED_CHARACTER',
  SYNTAX_UNTERMINATED_STRING: 'FEEL_SYNTAX_UNTERMINATED_STRING',
  SYNTAX_UNEXPECTED_TOKEN: 'FEEL_SYNTAX_UNEXPECTED_TOKEN',
  SYNTAX_EXPECTED_TOKEN: 'FEEL_SYNTAX_EXPECTED_TOKEN',
  SYNTAX_EXPECTED_NAME: 'FEEL_SYNTAX_EXPECTED_NAME',
  SYNTAX_UNTERMINATED_INTERVAL: 'FEEL_SYNTAX_UNTERMINATED_INTERVAL',
  SYNTAX_INSTANCE_OF_TYPE: 'FEEL_SYNTAX_INSTANCE_OF_TYPE',
  // 能力未加载
  NOT_LOADED_TEMPORAL: 'FEEL_NOT_LOADED_TEMPORAL',
  // 选项契约
  OPTION_UNKNOWN: 'FEEL_OPTION_UNKNOWN',
  OPTION_INVALID: 'FEEL_OPTION_INVALID',
  // 资源上限
  LIMIT_MAX_NODES: 'FEEL_LIMIT_MAX_NODES',
  LIMIT_MAX_DEPTH: 'FEEL_LIMIT_MAX_DEPTH',
  LIMIT_TIMEOUT: 'FEEL_LIMIT_TIMEOUT',
  // S-FEEL 子集越界（03-engine §7.2：越界必须报错，不能静默求值）
  NOT_ALLOWED_FUNCTION: 'FEEL_NOT_ALLOWED_FUNCTION',
  /*
   * 求值期**类型错误**（不是"降级可继续"的诊断，故与 EVAL_* 诊断码分属两个命名空间）。
   * 判据：换输入也救不回、且结果语义被破坏 → 抛。
   */
  EVAL_DURATION_COMPONENT: 'FEEL_EVAL_DURATION_COMPONENT',
  EVAL_UNSUPPORTED_PROPERTY: 'FEEL_EVAL_UNSUPPORTED_PROPERTY',
  EVAL_NAMED_ARG: 'FEEL_EVAL_NAMED_ARG',
  EVAL_ARG_COUNT: 'FEEL_EVAL_ARG_COUNT',
  EVAL_ARG_TYPE: 'FEEL_EVAL_ARG_TYPE',
  EVAL_ARG_RANGE: 'FEEL_EVAL_ARG_RANGE',
  EVAL_UNDEFINED: 'FEEL_EVAL_UNDEFINED',
} as const;

/** 诊断码表（不抛，随结果返回） */
export const FEEL_DIAGNOSTIC_CODES = {
  EVAL_NO_VARIABLE: 'FEEL_EVAL_NO_VARIABLE',
  EVAL_NO_PROPERTY: 'FEEL_EVAL_NO_PROPERTY',
  EVAL_NO_FUNCTION: 'FEEL_EVAL_NO_FUNCTION',
  EVAL_TYPE_MISMATCH: 'FEEL_EVAL_TYPE_MISMATCH',
  EVAL_UNKNOWN_TYPE: 'FEEL_EVAL_UNKNOWN_TYPE',
} as const;

export type FeelErrorCode =
  | (typeof FEEL_ERROR_CODES)[keyof typeof FEEL_ERROR_CODES];

export type FeelDiagnosticCode =
  | (typeof FEEL_DIAGNOSTIC_CODES)[keyof typeof FEEL_DIAGNOSTIC_CODES];

// ---------------- 抛出类错误 ----------------

export interface FeelErrorInit {
  code: string;
  /** 源码定位（0-based、左闭右开） */
  position?: Position;
  /** 模型定位（moddle/engine/dmn 场景） */
  node?: NodeRef;
  /** 一句修复提示（人读） */
  hint?: string;
  /** 结构化补充：计数、名字、合法取值等**可断言**的数据都放这里 */
  details?: Record<string, unknown>;
}

/**
 * feel 错误基类。
 * ⚠️ 本类**不出现在任何跨包依赖里**：其他四包各有自己的基类，只保证字段形状一致。
 */
export class FeelError extends Error {
  /** 五包统一印记：宿主可据此判断「这是 floken 的结构化错误」 */
  readonly floken = true;
  readonly pkg = 'feel';
  readonly code: string;
  /*
   * 可选字段一律用 `declare`：**不生成实例字段**，于是未赋值时不会留下
   * `position: undefined` 这种键（`JSON.stringify` / `Object.keys` 保持干净）。
   */
  declare readonly position?: Position;
  declare readonly node?: NodeRef;
  declare readonly hint?: string;
  declare readonly details?: Record<string, unknown>;

  constructor(message: string, init: FeelErrorInit) {
    super(message);
    this.name = new.target.name;
    this.code = init.code;
    if (init.position) this.position = init.position;
    if (init.node) this.node = init.node;
    if (init.hint) this.hint = init.hint;
    if (init.details) this.details = init.details;
  }
}

/** 词法 / 语法非法 */
export class FeelSyntaxError extends FeelError {}

/** 选项非法或未知（**禁止静默忽略**未知选项） */
export class FeelOptionError extends FeelError {}

/** 必需能力未加载（当前只有 `./temporal`） */
export class FeelNotLoadedError extends FeelError {}

/** 超出宿主设定的资源上限 */
export class FeelLimitError extends FeelError {}

/** 调用了白名单外的函数（S-FEEL 子集越界，见 03-engine §7.2） */
export class FeelNotAllowedError extends FeelError {}

/**
 * 求值期类型错误：值存在、类型也对，但**不支持该操作**。
 * 与 `EVAL_TYPE_MISMATCH` 诊断的区别是判据（AGENTS.md §5）：换输入也救不回 → 抛。
 * 例：years-and-months duration 上取 `.days`（该分量按规范不存在）。
 */
export class FeelTypeError extends FeelError {}

/**
 * 调用签名错误（命名参数用错、位置与命名混用、给不支持命名参数的值传命名参数）。
 * DMN 1.4 §10.3.2 规定命名参数名必须与规范**逐字**相同，写错就是错误而非"按位置硬套"。
 */
export class FeelCallError extends FeelError {}

// ---------------- 工厂 ----------------

/** 语法错误工厂（parser / lexer 统一走这里，保证码与定位口径一致） */
export function syntaxError(
  message: string,
  position: Position,
  extra: Pick<FeelErrorInit, 'hint' | 'details'> & { code?: string } = {},
): FeelSyntaxError {
  const { code, ...rest } = extra;
  return new FeelSyntaxError(message, {
    code: code ?? FEEL_ERROR_CODES.SYNTAX_UNEXPECTED_TOKEN,
    position,
    ...rest,
  });
}

/** 期望某个 token 但没找到（带上 `expected`，编辑器才能给出"漏了 `)`"） */
export function expectedTokenError(
  expected: string,
  found: string,
  position: Position,
): FeelSyntaxError {
  return new FeelSyntaxError(`Expected ${expected} but found '${found || 'EOF'}'`, {
    code: FEEL_ERROR_CODES.SYNTAX_EXPECTED_TOKEN,
    position,
    details: { expected, found },
  });
}

/**
 * 时间函数未加载。
 * message 用 `05-feel` §4 逐字规定的修复串（AC-F7：必须是带修复提示的明确错误，不是 `undefined`）。
 */
export function temporalNotLoaded(fnName: string): FeelNotLoadedError {
  return new FeelNotLoadedError('temporal functions require: await import("floken-feel/temporal")', {
    code: FEEL_ERROR_CODES.NOT_LOADED_TEMPORAL,
    hint: 'await import("floken-feel/temporal") 后重试，或改用 evaluateTemporal()',
    details: { function: fnName, module: 'floken-feel/temporal' },
  });
}

/**
 * 时间/时长值上取**不存在**的分量（必须抛，不能降级为 null）。
 *
 * FEEL 把 duration 分成两类（DMN 1.4 §10.3.4.4）：`years and months duration`
 * 只有 `.years` / `.months`；`days and time duration` 只有 `.days` / `.hours` /
 * `.minutes` / `.seconds`。跨类访问按规范就是**错误**（TCK 0074 的 errorResult 用例即此）。
 */
/**
 * 命名参数调用不合法（DMN 1.4 §10.3.2）。
 * `kind`：
 * - `unknown` —— 形参名与规范不符（`abs(number: -1)`）
 * - `unsupported` —— 该函数没有登记形参名，无法对位
 * - `mixed` —— 位置参数与命名参数混用
 * - `duplicate` —— 同一形参给了两次
 */
export function namedArgError(
  kind: 'unknown' | 'unsupported' | 'mixed' | 'duplicate',
  fnName: string,
  detail: { name?: string; allowed?: readonly string[] } = {},
): FeelCallError {
  const message = {
    unknown: `Unknown parameter '${detail.name}' for function '${fnName}'`,
    unsupported: `Function '${fnName}' does not accept named parameters`,
    mixed: `Cannot mix positional and named parameters in '${fnName}'`,
    duplicate: `Duplicate parameter '${detail.name}' in '${fnName}'`,
  } as const;
  const init: FeelErrorInit = {
    code: FEEL_ERROR_CODES.EVAL_NAMED_ARG,
    details: { function: fnName, ...detail },
  };
  if (detail.allowed?.length) init.hint = `可用形参：${detail.allowed.join(', ')}`;
  return new FeelCallError(message[kind], init);
}

/**
 * 实参个数不匹配。
 *
 * 注意这与「参数不可用就返回 `null`」的既有约定不冲突：DMN 内置函数**少给或多给参数**
 * 是调用签名错误（没有可返回的值），而"给了 null / 类型不符"才是三值语义的事。
 * TCK 用 `errorResult="true"` 把这两类分开测（`abs()` → Err、`abs(null)` → Err）。
 *
 * `expected` 可给区间（如 floor 的 `[1, 2]`：`n` 必需、`scale` 选填），
 * 消息随之写成 `1 to 2 argument(s)`。
 */
export function argCountError(
  fnName: string,
  expected: number | readonly [number, number],
  actual: number,
): FeelCallError {
  const wants = typeof expected === 'number' ? `${expected}` : `${expected[0]} to ${expected[1]}`;
  return new FeelCallError(`Function '${fnName}' expects ${wants} argument(s) but got ${actual}`, {
    code: FEEL_ERROR_CODES.EVAL_ARG_COUNT,
    details: { function: fnName, expected: [...(typeof expected === 'number' ? [expected] : expected)], actual },
  });
}

/**
 * 实参**类型不符**（含传了 `null`）。
 *
 * ⚠️ 这是对"参数不可用就返回 null"那条顺口溜的**修正**：DMN 1.4 §10.3.4 的内置函数
 * 形参都是有类型的（`floor(n: number, scale: number)`），`null` / 字符串 / 布尔 /
 * 时间值都不匹配 `number` —— 按规范即**类型错误**，没有可返回的值。
 * TCK 用 `errorResult="true"` 逐条钉死了这个口径（`floor(null, 1)`、`abs("-1")`、
 * `modulo(true, true)` 全是 Err）。三值语义管的是「值存在但未知」，不是「参数非法」。
 *
 * `actualType` 用 FEEL 的类型名（`number` / `string` / `null` / `date` …），便于宿主直接展示。
 */
export function argTypeError(
  fnName: string,
  param: string,
  expectedType: string,
  actualType: string,
): FeelTypeError {
  return new FeelTypeError(
    `Function '${fnName}' expects a ${expectedType} for parameter '${param}' but got ${actualType}`,
    {
      code: FEEL_ERROR_CODES.EVAL_ARG_TYPE,
      hint: `按 DMN 1.4 §10.3.4，形参 ${param} 的类型必须匹配；传 null 或其它类型是类型错误，不是"未知值"`,
      details: { function: fnName, param, expectedType, actualType },
    },
  );
}

/**
 * **二元运算两侧类型不符**（`false = 0`、`100 = "100"`、`[] = 0`、`{} = []`）。
 *
 * TCK 0068 把这批全判为 `errorResult`：跨类型的相等/大小比较在 FEEL 里没有定义，
 * 不是「未知」（`null`）。注意与 `null` 的区别 —— `100 = null` 只是 `false`。
 */
export function operandTypeError(op: string, leftType: string, rightType: string): FeelTypeError {
  return new FeelTypeError(
    `Operator '${op}' requires both operands to be of the same type but got ${leftType} and ${rightType}`,
    {
      code: FEEL_ERROR_CODES.EVAL_ARG_TYPE,
      details: { operator: op, leftType, rightType },
    },
  );
}

/**
 * 实参**取值越界**（类型对、但超出规范允许的范围）。
 * 目前只有舍入家族的 `scale`：DMN 1.4 §10.3.4.7 限定为 `[-6111, 6176]`
 * （TCK 1141~1144 用 `(-6111 - 1)` 与 `(6176 + 1)` 把两端都测了）。
 */
export function argRangeError(
  fnName: string,
  param: string,
  value: number,
  min: number,
  max: number,
): FeelTypeError {
  return new FeelTypeError(
    `Function '${fnName}' requires parameter '${param}' to be within [${min}, ${max}] but got ${value}`,
    {
      code: FEEL_ERROR_CODES.EVAL_ARG_RANGE,
      details: { function: fnName, param, value, min, max },
    },
  );
}

/**
 * 运算**结果无定义**（参数类型对、但该取值下函数没有值）。
 *
 * 这条口径由 TCK 划开，容易被当成"三值语义"而写错：
 * - **内置函数**无定义 → 抛（`sqrt(-1)` / `log(0)` / `modulo(x, 0)` 官方全标 `errorResult`）；
 * - **运算符**除零 → `null`（`(10+20)/0` 官方期望就是 `null`，不是错误）。
 * 即：运算符走三值传播，函数走签名/取值校验。
 */
export function undefinedResultError(fnName: string, detail: Record<string, unknown>): FeelTypeError {
  return new FeelTypeError(`Function '${fnName}' is undefined for these arguments`, {
    code: FEEL_ERROR_CODES.EVAL_UNDEFINED,
    details: { function: fnName, ...detail },
  });
}

export function durationComponentError(component: string, kind: string): FeelTypeError {
  return new FeelTypeError(`Duration '${kind}' has no component '${component}'`, {
    code: FEEL_ERROR_CODES.EVAL_DURATION_COMPONENT,
    hint:
      kind === 'years and months duration'
        ? 'years and months duration 只有 .years / .months'
        : 'days and time duration 只有 .days / .hours / .minutes / .seconds',
    details: { component, kind },
  });
}

/** 白名单外函数（S-FEEL）：错误信息必须列出被拒的函数名与当前白名单 */
export function functionNotAllowed(fnName: string, allowed: readonly string[]): FeelNotAllowedError {
  return new FeelNotAllowedError(`Function '${fnName}' is not allowed in this profile`, {
    code: FEEL_ERROR_CODES.NOT_ALLOWED_FUNCTION,
    hint: '把该函数加入 EvaluateOptions.allowedFunctions，或改用子集内的表达式',
    details: { function: fnName, allowed: [...allowed] },
  });
}

/** 资源上限错误 */
export function limitExceeded(
  code:
    | typeof FEEL_ERROR_CODES.LIMIT_MAX_NODES
    | typeof FEEL_ERROR_CODES.LIMIT_MAX_DEPTH
    | typeof FEEL_ERROR_CODES.LIMIT_TIMEOUT,
  message: string,
  details: Record<string, unknown>,
): FeelLimitError {
  return new FeelLimitError(message, { code, details });
}

/** 选项契约错误 */
export function optionError(
  message: string,
  code:
    | typeof FEEL_ERROR_CODES.OPTION_UNKNOWN
    | typeof FEEL_ERROR_CODES.OPTION_INVALID,
  details: Record<string, unknown> = {},
): FeelOptionError {
  return new FeelOptionError(message, { code, details });
}

// ---------------- 诊断工厂 ----------------

export interface DiagnosticInit {
  code: string;
  message: string;
  start: number;
  end: number;
  severity?: Severity;
  expected?: string[];
  suggestions?: string[];
}

/** 构造一条诊断（缺省 `severity: 'warn'` —— 求值降级走 warn，编辑器语法检查显式传 'error'） */
export function diagnostic(init: DiagnosticInit): Diagnostic {
  const out: Diagnostic = {
    severity: init.severity ?? 'warn',
    code: init.code,
    message: init.message,
    start: init.start,
    end: init.end,
  };
  if (init.expected) out.expected = init.expected;
  if (init.suggestions) out.suggestions = init.suggestions;
  return out;
}
