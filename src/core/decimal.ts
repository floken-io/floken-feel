/**
 * @floken-io/feel · 十进制算术（decimal128）
 *
 * ★ 为什么要有这个模块：DMN 1.5 §10.3.2.1 规定 FEEL 的 `number` 是
 *   **IEEE 754-2008 decimal128**（34 位有效数字），**不是** JS 的 binary64。
 *   double 算出来的二进制误差在金额场景是**真实缺陷**，不是计分细节：
 *
 *   | 表达式 | double（现状） | decimal128（正解） |
 *   |---|---|---|
 *   | `1.2345 + 2.234` | 3.4684999999999997 | **3.4685** |
 *   | `modulo(10.1, 4.5)` | 1.0999999999999996 | **1.1** |
 *
 *   TCK 0100-arithmetic#005/#006、0056-feel-modulo-function#017a~#017d 直接钉死这两条。
 *
 * ★ 设计边界（**刻意**不改表示层）：
 *   - 值类型**仍是 JS number**。只在**运算瞬间**把操作数转成十进制、算完转回 number。
 *     若改成 `{mantissa, scale}` 一路传递，就要动比较、排序、格式化、temporal、
 *     全部 builtin —— 爆炸半径大到不可控，且 B 口径 1995 条的既有语义会全盘漂移。
 *   - 往返**无损**：`number → toString()` 是最短往返表示 → 解析成十进制 → 算完
 *     `Number("…e-…")` 转回。只要中间结果按 34 位有效数字舍入，double 侧就不会
 *     丢掉「原本就有的」信息。
 *   - 只对**有限数**生效；`Infinity` / `NaN` / 非数字操作数一律返回 `null`，
 *     由调用方回退原路径（三值传播、诊断、抛错的既有语义完全不动）。
 *
 * ★ 精度：除法/非整数幂这类**可能无限**的运算，按 34 位有效数字**半进位**舍入，
 *   与 decimal128 对齐。加减乘与整数幂是**精确**的，不舍入（只在输出时规整位数）。
 */

/** decimal128 的有效数字位数（IEEE 754-2008 §3.2） */
const PRECISION = 34;

/**
 * 幂运算的**位数爆炸**护栏：估算结果超过这个十进制位数就不再走 BigInt。
 * 这么大的数在 double 里必然是 `Infinity` 或 `0`，回退过去结果一致且快得多。
 */
const POW_DIGIT_LIMIT = 400;

/** 十进制小数：`m * 10^-s` */
interface Dec {
  m: bigint;
  s: number;
}

const ONE: Dec = { m: 1n, s: 0 };

/** `Number#toString()` 的三种形态：`12.5` / `1e+21` / `5e-7` */
const DECIMAL_LITERAL = /^(-)?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * JS number → 十进制小数。
 *
 * ★ 走 `n.toString()`（**最短往返**表示）而非 `toFixed`：前者给出的正是「这个
 *   double 所代表的那个十进制数」，后者会凭空造出 `0.1000000000000000055…`
 *   这种二进制噪声，等于把误差又带回来了。
 */
function numToDec(n: number): Dec | null {
  if (!Number.isFinite(n)) return null;
  const m = DECIMAL_LITERAL.exec(n.toString());
  if (!m) return null;
  const digits = `${m[2] ?? '0'}${m[3] ?? ''}`;
  let s = (m[3] ?? '').length;
  if (m[4] !== undefined) s -= Number(m[4]);
  const v = BigInt(digits);
  return { m: m[1] ? -v : v, s };
}

/**
 * 十进制小数 → JS number。
 *
 * ★ 用科学计数法字面量 `Number("34685e-4")` —— 既能天然表示极大/极小值
 *   （`Number("1e400")` → `Infinity`，与 double 语义一致），又不必拼几千位的字符串。
 */
function decToNum(d: Dec): number {
  if (d.m === 0n) return 0;
  return Number(`${d.m}e${-d.s}`);
}

/** 绝对值的十进制位数 */
function digits10(m: bigint): number {
  return (m < 0n ? -m : m).toString().length;
}

/**
 * 舍入到 `p` 位有效数字（**半进位**，按绝对值判定，负数不会跑偏）。
 * 加/减/乘/整数幂的结果精确，本函数只在**输出规整**与**除法**时用。
 */
function roundToPrecision(d: Dec, p: number = PRECISION): Dec {
  if (d.m === 0n) return { m: 0n, s: 0 };
  const dig = digits10(d.m);
  if (dig <= p) return d;
  const drop = dig - p;
  const pow = 10n ** BigInt(drop);
  const abs = d.m < 0n ? -d.m : d.m;
  let q = abs / pow;
  if ((abs % pow) * 2n >= pow) q += 1n;
  return { m: d.m < 0n ? -q : q, s: d.s - drop };
}

/** 把两个操作数对齐到同一 scale（只放大，不缩小 —— 不会截断） */
function align(a: Dec, b: Dec): { x: bigint; y: bigint; s: number } {
  const s = Math.max(a.s, b.s);
  return {
    x: s > a.s ? a.m * 10n ** BigInt(s - a.s) : a.m,
    y: s > b.s ? b.m * 10n ** BigInt(s - b.s) : b.m,
    s,
  };
}

function decAdd(a: Dec, b: Dec): Dec {
  const { x, y, s } = align(a, b);
  return { m: x + y, s };
}

function decSub(a: Dec, b: Dec): Dec {
  const { x, y, s } = align(a, b);
  return { m: x - y, s };
}

function decMul(a: Dec, b: Dec): Dec {
  return { m: a.m * b.m, s: a.s + b.s };
}

/**
 * 除法 —— 唯一「可能无限」的运算，按 34 位有效数字舍入。
 *
 * `a / b = (a.m / b.m) * 10^(b.s - a.s)`；先把被除数放大 `k` 位，让商的有效位数
 * 达到 `PRECISION + 1`（多留一位，舍入时才判得准）。
 */
function decDiv(a: Dec, b: Dec): Dec | null {
  if (b.m === 0n) return null;
  const k = Math.max(0, PRECISION + 1 - digits10(a.m) + digits10(b.m));
  const q = (a.m * 10n ** BigInt(k)) / b.m;
  return roundToPrecision({ m: q, s: a.s - b.s + k }, PRECISION);
}

/** 整数幂（精确）。`n` 为负时先算正幂再取倒数。 */
function decPowInt(a: Dec, n: number): Dec | null {
  if (n === 0) return ONE;
  if (a.m === 0n) return n > 0 ? { m: 0n, s: 0 } : null; // 0 的负幂 → 未定义，回退
  let e = n < 0 ? BigInt(-n) : BigInt(n);

  // 位数护栏：估出结果位数，超限就交给 double（必然 Infinity / 0）
  const est = (digits10(a.m) - a.s) * n;
  if (est > POW_DIGIT_LIMIT || est < -POW_DIGIT_LIMIT) return null;

  let base = a;
  let acc = ONE;
  while (e > 0n) {
    if (e & 1n) acc = decMul(acc, base);
    e >>= 1n;
    if (e > 0n) base = decMul(base, base);
  }
  return n < 0 ? decDiv(ONE, acc) : acc;
}

/**
 * 十进制四则/幂的统一入口。
 *
 * @returns 结果；**不适合十进制路径**时返回 `null`，由调用方回退 double
 *          （非有限数、非整数指数、除零、位数爆炸等 —— 全部是「原语义更好」的情形）。
 */
export function decimalArith(op: '+' | '-' | '*' | '/' | '**', l: number, r: number): number | null {
  if (!Number.isFinite(l) || !Number.isFinite(r)) return null;
  const a = numToDec(l);
  const b = numToDec(r);
  if (!a || !b) return null;

  let out: Dec | null;
  switch (op) {
    case '+':
      out = decAdd(a, b);
      break;
    case '-':
      out = decSub(a, b);
      break;
    case '*':
      out = decMul(a, b);
      break;
    case '/':
      out = r === 0 ? null : decDiv(a, b);
      break;
    case '**':
      /*
       * ★ 只有**整数指数**才走十进制。非整数指数（如 `5 ** 2.55`）数学上要经
       *   `exp(r · ln l)`，需要高精度超越函数 —— 那不是「十进制算术」能解决的，
       *   退回 double（结果同为近似，但至少不会更差）。
       */
      out = Number.isInteger(r) ? decPowInt(a, r) : null;
      break;
    default:
      return null;
  }
  if (!out) return null;
  return decToNum(roundToPrecision(out));
}

/**
 * 十进制取模 —— `dividend - divisor · floor(dividend / divisor)`（DMN 1.5 §10.3.4.8）。
 *
 * ★ 与 JS `%` 的分歧在于 **floor 而非截断**，结果的符号跟随 **divisor**：
 *   `modulo(-10.1, 4.5)` = 3.4、`modulo(10.1, -4.5)` = -3.4。
 *   这条语义本来就是对的，错的只是 double 的二进制误差
 *   （现状给 3.4000000000000004 而非 3.4）。
 */
export function decimalModulo(dividend: number, divisor: number): number | null {
  if (!Number.isFinite(dividend) || !Number.isFinite(divisor) || divisor === 0) return null;
  const a = numToDec(dividend);
  const b = numToDec(divisor);
  if (!a || !b) return null;

  const { x, y, s } = align(a, b);
  let q = x / y; // BigInt 除法是**向零截断**，要修正成 floor
  if (x % y !== 0n && x < 0n !== y < 0n) q -= 1n;
  return decToNum({ m: x - y * q, s });
}
