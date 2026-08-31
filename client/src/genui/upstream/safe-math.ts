/**
 * SafeMath: a restricted math expression evaluator for GenUI plot specs.
 *
 * The model supplies an expression string like "sin(x) * 2 + 1". It is parsed
 * and evaluated here WITHOUT eval / new Function: a hand-written recursive
 * descent parser over a white-listed function/constant vocabulary. Unknown
 * identifiers, object property access, and call syntax other than the
 * white-listed functions are parse errors, so an adversarial expression
 * cannot reach globals, prototypes, or side effects.
 *
 * Supported grammar:
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/') unary)*
 *   unary   := ('-' | '+') unary | power
 *   power   := atom ('^' atom)?
 *   atom    := number | variable | constant | func '(' expr ')' | '(' expr ')'
 *   variable: 'x' (and any single-letter variable present in vars)
 *   constant: 'pi' | 'e' | 'tau'
 *   func    : sin cos tan asin acos atan sqrt cbrt exp log ln abs floor ceil round min max pow
 */

export interface SafeMathOptions {
  /** Variable values; only names present here may be referenced as variables. */
  vars?: Record<string, number>
}

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
}

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sqrt: Math.sqrt, cbrt: Math.cbrt,
  exp: Math.exp, log: Math.log10, ln: Math.log,
  abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  min: Math.min, max: Math.max,
  pow: (a, b) => Math.pow(a, b),
}

class ParseError extends Error {
  // CGUI-PATCH: 参数属性拆成显式字段 —— 裸 node strip-only 不支持参数属性
  readonly pos: number
  constructor(message: string, pos: number) { super(`SafeMath parse error at ${pos}: ${message}`); this.pos = pos }
}

class SafeMathParser {
  private i = 0
  // CGUI-PATCH: 参数属性拆成显式字段 —— 裸 node strip-only 不支持参数属性
  private readonly src: string
  private readonly vars: Record<string, number>
  constructor(src: string, vars: Record<string, number>) { this.src = src; this.vars = vars }

  parse(): (x: number) => number {
    const node = this.parseExpr()
    this.skipWs()
    if (this.i < this.src.length) throw new ParseError('unexpected trailing input', this.i)
    return this.evalNode(node)
  }

  private evalNode(node: number | ((x: number) => number)): (x: number) => number {
    if (typeof node === 'number') return () => node
    return node
  }

  private parseExpr(): number | ((x: number) => number) {
    let left = this.parseTerm()
    for (;;) {
      this.skipWs()
      const c = this.peek()
      if (c === '+' || c === '-') {
        this.i++
        const right = this.parseTerm()
        const op = c
        const prev = left
        left = op === '+'
          ? (x) => this.asNum(prev, x) + this.asNum(right, x)
          : (x) => this.asNum(prev, x) - this.asNum(right, x)
      } else return left
    }
  }

  private parseTerm(): number | ((x: number) => number) {
    let left = this.parseUnary()
    for (;;) {
      this.skipWs()
      const c = this.peek()
      // CGUI-PATCH(INTERFACE §2.8):取模不在运算符表里(`+ - * / ^ ( )` 就是全集,
      // 内置技能 SKILL.md 也是这么教模型的)。留着 `%` 等于实现比契约宽 —— 契约是
      // 白名单,宽出来的那一格没人测、也没人知道它在。
      if (c === '*' || c === '/') {
        this.i++
        const right = this.parseUnary()
        const op = c
        const prev = left
        left = op === '*'
          ? (x) => this.asNum(prev, x) * this.asNum(right, x)
          : (x) => this.asNum(prev, x) / this.asNum(right, x)
      } else return left
    }
  }

  private parseUnary(): number | ((x: number) => number) {
    this.skipWs()
    const c = this.char()
    if (c === '-' || c === '+') {
      this.i++
      const operand = this.parseUnary()
      return c === '-' ? (x) => -this.asNum(operand, x) : (x) => this.asNum(operand, x)
    }
    return this.parsePower()
  }

  private parsePower(): number | ((x: number) => number) {
    const base = this.parseAtom()
    this.skipWs()
    if (this.peek() === '^') {
      this.i++
      const exp = this.parsePower()
      const prev = base
      return (x) => Math.pow(this.asNum(prev, x), this.asNum(exp, x))
    }
    return base
  }

  private parseAtom(): number | ((x: number) => number) {
    this.skipWs()
    const c = this.char()
    if (c === '(') {
      this.i++
      const inner = this.parseExpr()
      this.skipWs()
      if (this.peek() !== ')') throw new ParseError('expected )', this.i)
      this.i++
      return inner
    }
    if (c >= '0' && c <= '9' || c === '.') return this.parseNumber()
    if (this.isIdentStart(c)) return this.parseIdent()
    throw new ParseError(`unexpected character '${c}'`, this.i)
  }

  private parseNumber(): number {
    const start = this.i
    while (this.i < this.src.length && /[0-9.]/.test(this.src[this.i]!)) this.i++
    // CGUI-PATCH(§5.4-V6 数字词法):`e/E` 与其后的符号只有在**真跟着数字**时才算指数,
    // 否则不吞。上游一路吞 `[0-9.eE+-]`,于是 `1+2` 整串被当成一个数 ⟹ Number('1+2')
    // = NaN ⟹ 抛 ParseError ⟹ 整条曲线不绘制。凡是含 `a+b` / `a-b` 的表达式(`(1+2)*3`、
    // `abs(0-3)`、`1+2*3-4/2`)全军覆没,而这是最常见的写法。
    if (this.i < this.src.length && /[eE]/.test(this.src[this.i]!)) {
      let j = this.i + 1
      if (j < this.src.length && (this.src[j] === '+' || this.src[j] === '-')) j++
      if (j < this.src.length && /[0-9]/.test(this.src[j]!)) {
        this.i = j
        while (this.i < this.src.length && /[0-9]/.test(this.src[this.i]!)) this.i++
      }
    }
    const text = this.src.slice(start, this.i)
    const value = Number(text)
    if (Number.isNaN(value)) throw new ParseError(`invalid number '${text}'`, start)
    return value
  }

  private parseIdent(): number | ((x: number) => number) {
    const start = this.i
    while (this.i < this.src.length && this.isIdentChar(this.src[this.i]!)) this.i++
    const name = this.src.slice(start, this.i)
    this.skipWs()
    if (this.peek() === '(') {
      // Function call.
      // CGUI-PATCH(§2.8 / 文件头「不可摸 prototype」):判据必须是**自有属性**,不是
      // `=== undefined`。`FUNCTIONS` 是普通对象字面量,`FUNCTIONS['valueOf']` 命中的是
      // 继承来的 `Object.prototype.valueOf`(非 undefined),于是 `valueOf(x)`、
      // `constructor(x)`、`hasOwnProperty(x)`、`toString(x)`… 全部**编译通过**;守卫
      // repairPlotSeries 靠 `compileMathExpr(expr) === null` 判非法,编译过了就不丢这条
      // 曲线,留到渲染层 sampleExpr 求值时才抛 TypeError ⟹ ErrorBoundary 把**整块**降级
      // 成错误卡,同块的兄弟组件一起没。与同文件 CONSTANTS(:193)、vars(:198) 的
      // `Object.hasOwn` 写法对齐 —— 唯独这一处漏了。
      if (!Object.hasOwn(FUNCTIONS, name)) throw new ParseError(`unknown function '${name}'`, start)
      const fn = FUNCTIONS[name]!
      this.i++
      const args: Array<number | ((x: number) => number)> = []
      this.skipWs()
      if (this.peek() === ')') {
        this.i++
      } else {
        for (;;) {
          args.push(this.parseExpr())
          this.skipWs()
          const sep = this.peek()
          if (sep === ',') { this.i++; continue }
          if (sep === ')') { this.i++; break }
          throw new ParseError('expected , or ) in call', this.i)
        }
      }
      return (x) => fn(...args.map(a => this.asNum(a, x)))
    }
    // Own-property checks only: `in` would match inherited members like
    // `constructor`/`toString` on the vars object.
    if (Object.hasOwn(CONSTANTS, name)) return CONSTANTS[name]!
    if (name === 'x') {
      // The sampling variable resolves against the evaluation argument.
      return (value: number) => value
    }
    if (Object.hasOwn(this.vars, name)) {
      // A declared parameter (a/b/c…) resolves against its captured value,
      // which the caller changes by recompiling with new vars.
      const captured = this.vars[name]!
      return () => captured
    }
    // Implicit parameters: an undeclared single-lowercase-letter identifier
    // (a/b/k/m/n…) is a parameter that defaults to 1, so a model expression
    // like "a*sin(b*x)" without a params declaration still renders instead
    // of failing as "unknown identifier". This is safe: only [a-z] matches,
    // so injection names (constructor, window, process…) still parse-error.
    if (/^[a-z]$/.test(name)) return () => 1
    throw new ParseError(`unknown identifier '${name}'`, start)
  }

  private asNum(node: number | ((x: number) => number), x: number): number {
    return typeof node === 'number' ? node : node(x)
  }

  private skipWs(): void {
    while (this.i < this.src.length && /\s/.test(this.src[this.i]!)) this.i++
  }

  private peek(): string | undefined {
    return this.src[this.i]
  }

  private char(): string {
    const c = this.peek()
    if (c === undefined) throw new ParseError('unexpected end of input', this.i)
    return c
  }

  private isIdentStart(c: string | undefined): boolean {
    return c !== undefined && /[a-zA-Z_]/.test(c)
  }

  private isIdentChar(c: string): boolean {
    return /[a-zA-Z0-9_]/.test(c)
  }
}

/**
 * Compile an expression into an evaluable function.
 * @param expr - the math expression. `x` is the sampling variable; any other
 *   name in `vars` is a parameter whose captured value the evaluator returns
 *   (recompile with new vars to change a parameter — expressions are short).
 * @param options - parameter values; `x` is reserved and ignored here.
 * @returns evaluator, or null when the expression is invalid.
 */
export function compileMathExpr(expr: string, options: SafeMathOptions = {}): ((x: number) => number) | null {
  try {
    // `x` is the sampling variable and must never be shadowed by a param.
    const vars: Record<string, number> = { ...options.vars }
    delete vars.x
    return new SafeMathParser(expr, vars).parse()
  } catch {
    return null
  }
}

/**
 * Sample an expression over a range.
 * @param expr - math expression in x, with optional parameters.
 * @param xMin - inclusive start.
 * @param xMax - inclusive end.
 * @param samples - number of samples (>= 2).
 * @param params - parameter values (e.g. { a: 2, b: 3 }); recompile per change.
 * @returns [x, y] pairs; non-finite samples are dropped.
 */
export function sampleExpr(
  expr: string,
  xMin: number,
  xMax: number,
  samples = 200,
  params: Record<string, number> = {},
): Array<[number, number]> {
  const fn = compileMathExpr(expr, { vars: params })
  if (fn === null) return []
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || xMax <= xMin || samples < 2) return []
  const points: Array<[number, number]> = []
  const step = (xMax - xMin) / (samples - 1)
  for (let i = 0; i < samples; i++) {
    const x = xMin + step * i
    const y = fn(x)
    if (Number.isFinite(y)) points.push([x, y])
  }
  return points
}
