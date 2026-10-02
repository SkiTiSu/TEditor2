import type { DataRow } from './types';
import * as formulas from '@formulajs/formulajs';
import CryptoJS from 'crypto-js';

// Safe data interpreter for the old ToolGood v2 expression grammar. Excel
// functions come from MIT Formula.js; no formula is executed as JavaScript.
// Compatibility behavior is based on ToolGood 2.2.0.2 (Copyright 2016
// ToolGood.com, Apache-2.0); see src/vendor/toolgood/LICENSE and README.md.
const DAY = 86400000,
  epoch = Date.UTC(1899, 11, 30);
class DateValue {
  constructor(
    public serial: number,
    public calendar = serial > 365,
  ) {}
  get date() {
    return new Date(epoch + Math.round(this.serial * 86400) * 1000);
  }
  toString() {
    const d = this.date,
      pad = (v: number) => String(v).padStart(2, '0');
    const hours = this.calendar ? d.getUTCHours() : Math.floor((this.serial % 1) * 24);
    const time = `${pad(hours)}:${pad(d.getUTCMinutes())}${d.getUTCSeconds() ? ':' + pad(d.getUTCSeconds()) : ''}`;
    return this.calendar
      ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}${hours || d.getUTCMinutes() || d.getUTCSeconds() ? ' ' + time : ''}`
      : `${Math.trunc(this.serial) ? Math.trunc(this.serial) + ' ' : ''}${time}`;
  }
}
type Value = string | number | boolean | null | DateValue | Value[] | { [key: string]: Value };
const fail = (message: string): never => {
  throw new Error(message);
};
function number(value: Value): number {
  if (value instanceof DateValue) return value.serial;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (
    typeof value === 'string' &&
    value.trim() !== '' &&
    Number.isFinite(Number(value.replace(/,/g, '')))
  )
    return Number(value.replace(/,/g, ''));
  return fail('数值类型不正确。');
}
function bool(value: Value): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (value instanceof DateValue) return value.serial !== 0;
  if (typeof value === 'string') {
    if (/^(TRUE|1)$/i.test(value)) return true;
    if (/^(FALSE|0)$/i.test(value)) return false;
  }
  return fail('条件结果必须为逻辑值。');
}
function text(value: Value): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'object' && !(value instanceof DateValue)) return JSON.stringify(value);
  return String(value);
}
function date(value: Value): DateValue {
  if (value instanceof DateValue) return value;
  if (typeof value === 'number') return new DateValue(value);
  if (typeof value !== 'string') return fail('日期格式无效。');
  const match = value
    .trim()
    .match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (match) {
    const [, y, m, d, h = '0', mi = '0', s = '0'] = match;
    return new DateValue((Date.UTC(+y, +m - 1, +d, +h, +mi, +s) - epoch) / DAY, true);
  }
  const time = value.trim().match(/^(?:(\d+)\s+)?(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (time)
    return new DateValue(
      Number(time[1] ?? 0) +
        (Number(time[2]) * 3600 + Number(time[3]) * 60 + Number(time[4] ?? 0)) / 86400,
      false,
    );
  return fail('日期格式无效。');
}
function dateOrNumber(value: Value): Value {
  if (typeof value !== 'string') return value;
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return Number(value);
  try {
    return date(value);
  } catch {
    return value;
  }
}
function compare(op: string, a: Value, b: Value): boolean {
  if (a === null || b === null)
    return ['=', '=='].includes(op) ? a === b : ['!=', '<>'].includes(op) ? a !== b : false;
  if (Array.isArray(a) || Array.isArray(b)) return fail('数组不能直接比较。');
  let order: number;
  if (typeof a === 'string' || typeof b === 'string') {
    let x = text(a),
      y = text(b);
    if (typeof a === 'boolean' || typeof b === 'boolean') {
      x = x.toUpperCase();
      y = y.toUpperCase();
    }
    order = x === y ? 0 : x > y ? 1 : -1;
  } else {
    const diff = number(a) - number(b);
    order = Math.abs(diff) < 0.5e-12 ? 0 : Math.sign(diff);
  }
  return op === '=' || op === '=='
    ? order === 0
    : op === '!=' || op === '<>'
      ? order !== 0
      : op === '>'
        ? order > 0
        : op === '>='
          ? order >= 0
          : op === '<'
            ? order < 0
            : order <= 0;
}
function arithmetic(op: string, a: Value, b: Value): Value {
  if (op === '&') return text(a) + text(b);
  a = dateOrNumber(a);
  b = dateOrNumber(b);
  if (op === '*' && (typeof a === 'boolean' || typeof b === 'boolean'))
    return typeof a === 'boolean' ? (a ? b : 0) : b ? a : 0;
  let x = number(a),
    y = number(b);
  if ((op === '/' || op === '%') && y === 0) return fail('不能除以零。');
  if (op === '-' && !(a instanceof DateValue) && b instanceof DateValue) [x, y] = [y, x];
  const result =
    op === '+'
      ? x + y
      : op === '-'
        ? x - y
        : op === '*'
          ? x * y
          : op === '/'
            ? x / y
            : op === '^'
              ? x ** y
              : x % y;
  if (!Number.isFinite(result)) return fail('计算结果不是有限数值。');
  return (a instanceof DateValue || b instanceof DateValue) && op !== '%'
    ? new DateValue(result)
    : result;
}
/** Lexical conversion deliberately leaves quoted text unchanged. */
function translate(expression: string): { source: string; parameters: Map<string, string> } {
  const parameters = new Map<string, string>(),
    aliases = new Map<string, string>();
  const alias = (name: string) => {
    name = name.trim();
    if (!name) throw new Error('列名不能为空。');
    if (!aliases.has(name)) {
      const key = `tedparameter${aliases.size}`;
      aliases.set(name, key);
      parameters.set(key, name);
    }
    return aliases.get(name)!;
  };
  const punct: Record<string, string> = {
    '（': '(',
    '）': ')',
    '，': ',',
    '［': '[',
    '］': ']',
    '｛': '{',
    '｝': '}',
    '＋': '+',
    '－': '-',
    '×': '*',
    '÷': '/',
    '＝': '=',
    '；': ';',
  };
  let source = '',
    i = 0,
    operandExpected = true;
  while (i < expression.length) {
    let c = expression[i];
    if (/\s/.test(c)) {
      source += c;
      i++;
      continue;
    }
    const quote = c === '“' || c === '”' ? '"' : c === '‘' || c === '’' ? "'" : c;
    if (quote === '"' || quote === "'") {
      let value = '',
        closed = false;
      i++;
      while (i < expression.length) {
        const next = expression[i++];
        if (next === '\\' && i < expression.length) {
          value += next + expression[i++];
          continue;
        }
        if (
          next === quote ||
          (quote === '"' && (next === '“' || next === '”')) ||
          (quote === "'" && (next === '‘' || next === '’'))
        ) {
          if (expression[i] === next) {
            value += '\\' + quote;
            i++;
            continue;
          }
          closed = true;
          break;
        }
        value += next;
      }
      if (!closed) throw new Error('字符串引号未闭合。');
      source += quote + value + quote;
      operandExpected = false;
      continue;
    }
    c = punct[c] ?? c;
    if (c === '[' || c === '〖' || c === '#') {
      const closer = c === '[' ? (expression[i] === '［' ? '］' : ']') : c === '〖' ? '〗' : '#';
      const end = expression.indexOf(closer, i + 1);
      if (end < 0) throw new Error('列引用未闭合。');
      const inner = expression.slice(i + 1, end).trim();
      // Preserve explicit modern arrays and indexing; v2 bracket columns accept
      // arbitrary header names, including spaces and reserved words.
      if (c !== '[' || (!inner.includes(',') && operandExpected)) {
        let key = inner;
        if (
          (key.startsWith('"') && key.endsWith('"')) ||
          (key.startsWith("'") && key.endsWith("'"))
        )
          key = key.slice(1, -1);
        source += alias(key);
        i = end + 1;
        operandExpected = false;
        continue;
      }
      if (!operandExpected && /^[\p{L}_][\p{L}\p{N}_ ]*$/u.test(inner)) {
        source += `[${JSON.stringify(inner)}]`;
        i = end + 1;
        operandExpected = false;
        continue;
      }
    }
    if (c === '@') {
      const match = expression.slice(i + 1).match(/^[\p{L}_][\p{L}\p{N}_]*/u);
      if (!match) throw new Error('@ 后需要列名。');
      source += alias(match[0]);
      i += match[0].length + 1;
      operandExpected = false;
      continue;
    }
    const identifier = expression.slice(i).match(/^[\p{L}_][\p{L}\p{N}_]*/u);
    if (identifier) {
      const word = identifier[0],
        upper = word.toUpperCase(),
        rest = expression.slice(i + word.length).trimStart();
      const functionCall = rest.startsWith('(') || rest.startsWith('（');
      if ((upper === 'AND' || upper === 'OR') && !operandExpected) {
        source += upper === 'AND' ? '&&' : '||';
        operandExpected = true;
      } else if (upper === 'NOT' && !functionCall) {
        source += '!';
        operandExpected = true;
      } else if (
        !functionCall &&
        !['TRUE', 'FALSE', 'NULL', 'PI', 'E'].includes(upper) &&
        !source.trimEnd().endsWith('.')
      ) {
        source += alias(word);
        operandExpected = false;
      } else {
        source += upper === 'REGEXREPALCE' ? 'REGEXREPLACE' : word;
        operandExpected = false;
      }
      i += word.length;
      continue;
    }
    const numeric = expression.slice(i).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if (numeric) {
      source += numeric[0];
      i += numeric[0].length;
      operandExpected = false;
      continue;
    }
    if (c === '{') c = '[';
    else if (c === '}') c = ']';
    source += c;
    i++;
    operandExpected = ![')', ']'].includes(c);
  }
  return { source, parameters };
}

type Node =
  | { kind: 'value'; value: Value }
  | { kind: 'parameter'; name: string }
  | { kind: 'unary'; op: string; value: Node }
  | { kind: 'binary'; op: string; left: Node; right: Node }
  | { kind: 'call'; name: string; args: Node[] }
  | { kind: 'array'; values: Node[] }
  | { kind: 'member'; base: Node; key: Node }
  | { kind: 'if'; test: Node; yes: Node; no: Node };
interface Token {
  kind: 'number' | 'string' | 'id' | 'op' | 'end';
  text: string;
  value?: Value;
}
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) {
      i++;
      continue;
    }
    const start = i,
      c = source[i];
    if (c === '"' || c === "'") {
      i++;
      let value = '';
      while (i < source.length && source[i] !== c) {
        if (source[i] === '\\') {
          i++;
          const escaped = source[i++];
          value +=
            (
              {
                n: '\n',
                r: '\r',
                t: '\t',
                b: '\b',
                f: '\f',
                '\\': '\\',
                '"': '"',
                "'": "'",
              } as Record<string, string>
            )[escaped] ?? '\\' + escaped;
        } else value += source[i++];
      }
      if (source[i] !== c) fail('字符串引号未闭合。');
      i++;
      tokens.push({ kind: 'string', text: source.slice(start, i), value });
      continue;
    }
    const numeric = source.slice(i).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if (numeric) {
      tokens.push({ kind: 'number', text: numeric[0], value: Number(numeric[0]) });
      i += numeric[0].length;
      continue;
    }
    const id = source.slice(i).match(/^[\p{L}_][\p{L}\p{N}_]*/u);
    if (id) {
      tokens.push({ kind: 'id', text: id[0] });
      i += id[0].length;
      continue;
    }
    const op = source.slice(i).match(/^(?:>=|<=|<>|!=|==|&&|\|\||[+\-*/%^&=<>!(){}[\],.?:])/);
    if (!op) fail(`无法识别符号“${c}”。`);
    tokens.push({ kind: 'op', text: op![0] });
    i += op![0].length;
  }
  tokens.push({ kind: 'end', text: '' });
  return tokens;
}
class Parser {
  private i = 0;
  private depth = 0;
  constructor(private tokens: Token[]) {}
  private get current() {
    return this.tokens[this.i];
  }
  private take(value?: string) {
    const token = this.current;
    if (value !== undefined && token.text !== value)
      fail(`应为“${value}”，实际为“${token.text || '表达式结束'}”。`);
    this.i++;
    return token;
  }
  private accept(value: string) {
    if (this.current.text === value) {
      this.i++;
      return true;
    }
    return false;
  }
  private args(): Node[] {
    const args: Node[] = [];
    if (this.accept(')')) return args;
    do {
      args.push(this.expression());
    } while (this.accept(','));
    this.take(')');
    return args;
  }
  private primary(): Node {
    if (++this.depth > 128) fail('表达式嵌套过深。');
    const token = this.take();
    let node: Node;
    if (token.kind === 'number' || token.kind === 'string')
      node = { kind: 'value', value: token.value! };
    else if (['-', '+', '!'].includes(token.text))
      node = { kind: 'unary', op: token.text, value: this.expression(30) };
    else if (token.text === '(') {
      node = this.expression();
      this.take(')');
    } else if (token.text === '[') {
      const values: Node[] = [];
      if (!this.accept(']')) {
        do {
          values.push(this.expression());
        } while (this.accept(','));
        this.take(']');
      }
      node = { kind: 'array', values };
    } else if (token.kind === 'id') {
      if (this.accept('(')) node = { kind: 'call', name: token.text, args: this.args() };
      else if (['TRUE', 'FALSE', 'NULL', 'PI', 'E'].includes(token.text.toUpperCase()))
        node = {
          kind: 'value',
          value: (
            { TRUE: true, FALSE: false, NULL: null, PI: Math.PI, E: Math.E } as Record<
              string,
              Value
            >
          )[token.text.toUpperCase()],
        };
      else node = { kind: 'parameter', name: token.text };
    } else return fail(`这里需要数值、列名或函数，实际为“${token.text || '表达式结束'}”。`);
    for (;;) {
      if (this.accept('.')) {
        const field = this.take();
        if (field.kind !== 'id') fail('点号后需要属性名或函数名。');
        node = this.accept('(')
          ? { kind: 'call', name: field.text, args: [node, ...this.args()] }
          : { kind: 'member', base: node, key: { kind: 'value', value: field.text } };
      } else if (this.accept('[')) {
        const key = this.expression();
        this.take(']');
        node = { kind: 'member', base: node, key };
      } else break;
    }
    this.depth--;
    return node;
  }
  private expression(min = 0): Node {
    let left = this.primary();
    const precedence: Record<string, number> = {
      '||': 3,
      '&&': 3,
      '=': 5,
      '==': 5,
      '!=': 5,
      '<>': 5,
      '>': 5,
      '>=': 5,
      '<': 5,
      '<=': 5,
      '+': 10,
      '-': 10,
      '&': 10,
      '*': 20,
      '/': 20,
      '%': 20,
      '^': 25,
    };
    for (;;) {
      const op = this.current.text,
        level = precedence[op];
      if (level === undefined || level < min) break;
      this.take();
      const right = this.expression(level + (op === '^' ? 0 : 1));
      left = { kind: 'binary', op, left, right };
    }
    if (min === 0 && this.accept('?')) {
      const yes = this.expression();
      this.take(':');
      left = { kind: 'if', test: left, yes, no: this.expression() };
    }
    return left;
  }
  parse(): Node {
    const result = this.expression();
    if (this.current.kind !== 'end') fail(`多余内容“${this.current.text}”。`);
    return result;
  }
}

function property(base: Value, key: Value): Value {
  if (['__proto__', 'constructor', 'prototype'].includes(String(key)))
    return fail('不支持此属性。');
  if (base instanceof DateValue) {
    const d = base.date,
      parts: Record<string, number> = {
        YEAR: d.getUTCFullYear(),
        MONTH: d.getUTCMonth() + 1,
        DAY: d.getUTCDate(),
        HOUR: d.getUTCHours(),
        MINUTE: d.getUTCMinutes(),
        SECOND: d.getUTCSeconds(),
      };
    if (Object.hasOwn(parts, String(key).toUpperCase())) return parts[String(key).toUpperCase()];
  }
  if (Array.isArray(base)) {
    const index = Math.trunc(number(key)) - 1;
    return base[index] ?? null;
  }
  if (base !== null && typeof base === 'object' && Object.hasOwn(base, String(key)))
    return (base as Record<string, Value>)[String(key)];
  return fail(`未找到属性“${String(key)}”。`);
}
function flatten(args: Value[]): Value[] {
  return args.flatMap((v) => (Array.isArray(v) ? flatten(v) : [v]));
}
const encodingMaps = new Map<string, Map<string, number[]>>();
function encodingName(name: string) {
  return (
    (
      {
        utf8: 'utf-8',
        unicode: 'utf-16le',
        'utf-16': 'utf-16le',
        gb2312: 'gbk',
        ascii: 'windows-1252',
      } as Record<string, string>
    )[name.toLowerCase()] ?? name.toLowerCase()
  );
}
function bytes(input: string, encoding = 'utf-8'): Uint8Array {
  encoding = encodingName(encoding);
  if (encoding === 'utf-8') return new TextEncoder().encode(input);
  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    const result = new Uint8Array(input.length * 2),
      little = encoding === 'utf-16le';
    for (let i = 0; i < input.length; i++) {
      const code = input.charCodeAt(i);
      result[i * 2] = little ? code & 255 : code >> 8;
      result[i * 2 + 1] = little ? code >> 8 : code & 255;
    }
    return result;
  }
  let map = encodingMaps.get(encoding);
  if (!map) {
    const decoder = new TextDecoder(encoding, { fatal: false });
    map = new Map();
    for (let a = 0; a < 256; a++) {
      const ch = decoder.decode(new Uint8Array([a]));
      if (ch !== '�') map.set(ch, [a]);
    }
    if (['gbk', 'gb18030', 'big5', 'shift_jis', 'euc-kr'].includes(encoding))
      for (let a = 0x81; a <= 0xfe; a++)
        for (let b = 0x40; b <= 0xfe; b++) {
          const ch = decoder.decode(new Uint8Array([a, b]));
          if ([...ch].length === 1 && ch !== '�' && !map.has(ch)) map.set(ch, [a, b]);
        }
    encodingMaps.set(encoding, map);
  }
  const result: number[] = [];
  for (const ch of input) result.push(...(map.get(ch) ?? [63]));
  return new Uint8Array(result);
}
function wordArray(input: string, encoding?: string) {
  return CryptoJS.lib.WordArray.create(bytes(input, encoding));
}
function decoded(word: CryptoJS.lib.WordArray, encoding = 'utf-8'): string {
  const data = new Uint8Array(word.sigBytes);
  for (let i = 0; i < data.length; i++)
    data[i] = (word.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 255;
  return new TextDecoder(encodingName(encoding), { fatal: true }).decode(data);
}
function json(input: string): Value {
  try {
    return JSON.parse(input) as Value;
  } catch {
    // ToolGood accepts JSON with single-quoted strings. Tokenize and normalize
    // literals; never use JavaScript evaluation to parse permissive JSON.
    const tokens = tokenize(input);
    return JSON.parse(
      tokens
        .map((token, i) =>
          token.kind === 'string'
            ? JSON.stringify(token.value)
            : token.kind === 'id' && tokens[i + 1]?.text === ':'
              ? JSON.stringify(token.text)
              : token.text,
        )
        .join(' '),
    ) as Value;
  }
}
function format(value: Value, pattern: string): string {
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) return text(value);
  if (value instanceof DateValue) {
    const d = value.date,
      pad = (value: number, size = 2) => String(value).padStart(size, '0');
    const parts: Record<string, string> = {
      yyyy: pad(d.getUTCFullYear(), 4),
      yy: pad(d.getUTCFullYear() % 100),
      MM: pad(d.getUTCMonth() + 1),
      M: String(d.getUTCMonth() + 1),
      dd: pad(d.getUTCDate()),
      d: String(d.getUTCDate()),
      HH: pad(d.getUTCHours()),
      H: String(d.getUTCHours()),
      hh: pad(d.getUTCHours() % 12 || 12),
      h: String(d.getUTCHours() % 12 || 12),
      mm: pad(d.getUTCMinutes()),
      m: String(d.getUTCMinutes()),
      ss: pad(d.getUTCSeconds()),
      s: String(d.getUTCSeconds()),
      tt: d.getUTCHours() < 12 ? 'AM' : 'PM',
    };
    return pattern.replace(
      /'([^']*)'|"([^"]*)"|yyyy|yy|MM|dd|HH|hh|mm|ss|tt|[MdHhms]/g,
      (token, a: string, b: string) => a ?? b ?? parts[token],
    );
  }
  const numeric = number(value),
    standard = pattern.match(/^([nNfFpPeEgGxXdD])(\d*)$/);
  if (standard) {
    const code = standard[1].toUpperCase(),
      digits = standard[2] === '' ? 2 : Number(standard[2]);
    if (digits > 100) fail('TEXT 的精度不能超过 100。');
    if (code === 'G') return standard[2] ? numeric.toPrecision(digits) : String(numeric);
    if (code === 'E') return numeric.toExponential(standard[2] ? digits : 6);
    if (code === 'X' || code === 'D')
      return Math.trunc(numeric)
        .toString(code === 'X' ? 16 : 10)
        .padStart(standard[2] ? digits : 1, '0')
        .toUpperCase();
    const result = (code === 'P' ? numeric * 100 : numeric).toLocaleString('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      useGrouping: code === 'N' || code === 'P',
    });
    return code === 'P' ? result + ' %' : result;
  }
  const result = formulas.TEXT(numeric, pattern);
  if (result instanceof Error) fail(result.message);
  return text(result as Value);
}
function regex(pattern: string) {
  if (pattern.length > 2048) fail('正则表达式过长。');
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(pattern)) fail('不支持嵌套重复的正则表达式。');
  return new RegExp(pattern, 'g');
}
function rmb(input: number): string {
  if (!Number.isFinite(input) || Math.abs(input) >= 1e16) fail('金额超出范围。');
  const negative = input < 0,
    amount = Math.round(Math.abs(input) * 100),
    integer = Math.floor(amount / 100),
    fraction = amount % 100;
  const digits = '零壹贰叁肆伍陆柒捌玖',
    units = ['', '拾', '佰', '仟'],
    groups = ['', '万', '亿', '兆'];
  const four = (n: number) => {
    let s = '',
      zero = false;
    for (let i = 3; i >= 0; i--) {
      const d = Math.floor(n / 10 ** i) % 10;
      if (d) {
        if (zero && s) s += '零';
        s += digits[d] + units[i];
        zero = false;
      } else if (s) zero = true;
    }
    return s;
  };
  let whole = '',
    n = integer,
    g = 0,
    zero = false;
  while (n > 0) {
    const part = n % 10000;
    if (part) {
      whole = four(part) + groups[g] + (zero ? '零' : '') + whole;
      zero = part < 1000;
    } else if (whole) zero = true;
    n = Math.floor(n / 10000);
    g++;
  }
  const cents = fraction
    ? `${Math.floor(fraction / 10) ? digits[Math.floor(fraction / 10)] + '角' : ''}${fraction % 10 ? (!Math.floor(fraction / 10) && integer ? '零' : '') + digits[fraction % 10] + '分' : ''}`
    : '整';
  return (negative ? '负' : '') + (whole || '零') + '元' + cents;
}
function call(name: string, args: Value[]): Value {
  const n = name.toUpperCase(),
    s = (i = 0) => text(args[i] ?? null),
    v = (i = 0) => number(args[i] ?? null);
  const counted = (length: number) => {
    if (!Number.isSafeInteger(length) || length < 0 || length > 1_000_000)
      fail('生成内容超过 100 万字符限制。');
    return length;
  };
  switch (n) {
    case 'TRUE':
      return true;
    case 'FALSE':
      return false;
    case 'PI':
      return Math.PI;
    case 'E':
      return Math.E;
    case 'AND':
      return flatten(args).every(bool);
    case 'OR':
      return flatten(args).some(bool);
    case 'NOT':
      return !bool(args[0]);
    case 'ISNUMBER':
      return typeof args[0] === 'number';
    case 'ISTEXT':
      return typeof args[0] === 'string';
    case 'ISNONTEXT':
      return typeof args[0] !== 'string';
    case 'ISLOGICAL':
      return typeof args[0] === 'boolean';
    case 'ISEVEN':
      return typeof args[0] === 'number' && Math.trunc(args[0]) % 2 === 0;
    case 'ISODD':
      return typeof args[0] === 'number' && Math.trunc(args[0]) % 2 === 1;
    case 'ISNULLOREMPTY':
      return args[0] === null || args[0] === '';
    case 'ISNULLORWHITESPACE':
      return args[0] === null || s().trim() === '';
    case 'INT':
      return Math.trunc(v());
    case 'VALUE':
      return v();
    case 'T':
      return typeof args[0] === 'string' ? args[0] : '';
    case 'TEXT':
      return format(args[0], s(1));
    case 'CEILING':
      return (
        Math.ceil(v() / (args[1] === undefined ? 1 : v(1))) * (args[1] === undefined ? 1 : v(1))
      );
    case 'FLOOR':
      return (
        Math.floor(v() / (args[1] === undefined ? 1 : v(1))) * (args[1] === undefined ? 1 : v(1))
      );
    case 'ARRAY':
      return args;
    case 'JSON':
      return json(s());
    case 'VLOOKUP': {
      if (!Array.isArray(args[0])) fail('VLOOKUP 首个参数必须为表格数组。');
      let found: Value = null;
      for (const row of args[0] as Value[]) {
        if (!Array.isArray(row)) continue;
        if (compare('=', row[0], args[1])) return row[v(2) - 1] ?? null;
        if ((args[3] === undefined || bool(args[3])) && compare('<', row[0], args[1]))
          found = row[v(2) - 1] ?? null;
      }
      if (found === null) fail('VLOOKUP 没有找到匹配项。');
      return found;
    }
    case 'LOOKUP': {
      if (!Array.isArray(args[0])) fail('LOOKUP 首个参数必须为对象数组。');
      for (const row of args[0] as Value[]) {
        if (!row || typeof row !== 'object' || Array.isArray(row) || row instanceof DateValue)
          continue;
        try {
          const data = Object.fromEntries(
            Object.entries(row).map(([key, val]) => [key, text(val)]),
          );
          if (evaluateExpression(s(1), data)) return property(row, s(2));
        } catch {
          /* a missing property does not match this JSON object */
        }
      }
      return fail('LOOKUP 没有找到匹配项。');
    }
    case 'LEN':
      return s().length;
    case 'TRIM':
      return s().trim();
    case 'LOWER':
      return s().toLowerCase();
    case 'UPPER':
      return s().toUpperCase();
    case 'ASC':
      return s()
        .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
        .replace(/\u3000/g, ' ');
    case 'JIS':
    case 'WIDECHAR':
      return s()
        .replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))
        .replace(/ /g, '\u3000');
    case 'LEFT':
      return s().slice(0, args.length > 1 ? Math.max(0, v(1)) : 1);
    case 'RIGHT': {
      const length = args.length > 1 ? Math.max(0, v(1)) : 1;
      return length ? s().slice(-length) : '';
    }
    case 'MID':
    case 'SUBSTRING':
      return args.length < 3
        ? s().slice(Math.max(0, v(1) - 1))
        : s().slice(Math.max(0, v(1) - 1), Math.max(0, v(1) - 1) + v(2));
    case 'REPT':
      return s().repeat(
        counted(Math.trunc(v(1))) && counted(s().length * Math.trunc(v(1))) ? Math.trunc(v(1)) : 0,
      );
    case 'REPLACE':
      return args.length === 3
        ? s().split(s(1)).join(s(2))
        : s().slice(0, v(1) - 1) + s(3) + s().slice(v(1) - 1 + v(2));
    case 'SUBSTITUTE': {
      if (!s(1)) return s();
      if (args[3] === undefined) return s().split(s(1)).join(s(2));
      let seen = 0,
        cursor = 0,
        result = '',
        at = 0;
      while ((at = s().indexOf(s(1), cursor)) >= 0) {
        seen++;
        result += s().slice(cursor, at) + (seen === v(3) ? s(2) : s(1));
        cursor = at + s(1).length;
      }
      return result + s().slice(cursor);
    }
    case 'CONCATENATE':
      return flatten(args).map(text).join('');
    case 'EXACT':
      return s() === s(1);
    case 'STARTSWITH':
    case 'ENDSWITH': {
      let a = s(),
        b = s(1);
      if (args[2] && bool(args[2])) {
        a = a.toLowerCase();
        b = b.toLowerCase();
      }
      return n === 'STARTSWITH' ? a.startsWith(b) : a.endsWith(b);
    }
    case 'REMOVESTART':
    case 'REMOVEEND': {
      let a = s(),
        b = s(1),
        x = a,
        y = b;
      if (args[2] && bool(args[2])) {
        x = x.toLowerCase();
        y = y.toLowerCase();
      }
      return n === 'REMOVESTART'
        ? x.startsWith(y)
          ? a.slice(b.length)
          : a
        : x.endsWith(y)
          ? a.slice(0, a.length - b.length)
          : a;
    }
    case 'TRIMSTART':
    case 'LTRIM':
    case 'TRIMEND':
    case 'RTRIM': {
      const input = s(),
        set = args[1] === undefined ? null : s(1),
        start = n === 'TRIMSTART' || n === 'LTRIM';
      if (set === null) return start ? input.trimStart() : input.trimEnd();
      let lo = 0,
        hi = input.length;
      if (start) while (lo < hi && set.includes(input[lo])) lo++;
      else while (hi > lo && set.includes(input[hi - 1])) hi--;
      return input.slice(lo, hi);
    }
    case 'INDEXOF':
      return s().indexOf(s(1), args.length > 2 ? v(2) - 1 : 0) + 1;
    case 'LASTINDEXOF':
      return s().lastIndexOf(s(1), args.length > 2 ? v(2) - 1 : undefined) + 1;
    case 'SPLIT': {
      const values = s().split(s(1));
      return args.length > 2 ? (values[v(2) - 1] ?? '') : values;
    }
    case 'JOIN':
      return Array.isArray(args[0])
        ? flatten(args[0]).map(text).join(s(1))
        : flatten(args.slice(1)).map(text).join(s());
    case 'REGEX': {
      const match = s().match(regex(s(1)));
      if (!match) return fail('正则表达式没有匹配结果。');
      return match[0];
    }
    case 'REGEXREPLACE':
    case 'REGEXREPALCE':
      return s().replace(regex(s(1)), s(2));
    case 'ISREGEX':
    case 'ISMATCH':
      return regex(s(1)).test(s());
    case 'URLENCODE':
      return encodeURIComponent(s())
        .replace(/%20/g, '+')
        .replace(/%[0-9A-F]{2}/g, (x) => x.toLowerCase());
    case 'URLDECODE':
      return decodeURIComponent(s().replace(/\+/g, ' '));
    case 'HTMLENCODE':
      return s().replace(
        /[&<>"']/g,
        (c) =>
          (
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }) as Record<
              string,
              string
            >
          )[c],
      );
    case 'HTMLDECODE':
      return s().replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (c) =>
        c[1] === '#'
          ? String.fromCodePoint(
              c[2].toLowerCase() === 'x'
                ? parseInt(c.slice(3, -1), 16)
                : parseInt(c.slice(2, -1), 10),
            )
          : (
              { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" } as Record<
                string,
                string
              >
            )[c.toLowerCase()],
      );
    case 'TEXTTOBASE64':
    case 'TEXTTOBASE64URL': {
      let out = CryptoJS.enc.Base64.stringify(
        wordArray(s(), args[1] === undefined ? undefined : s(1)),
      );
      return n.endsWith('URL')
        ? out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
        : out;
    }
    case 'BASE64TOTEXT':
    case 'BASE64URLTOTEXT':
      return decoded(
        CryptoJS.enc.Base64.parse(s().replace(/-/g, '+').replace(/_/g, '/')),
        args[1] === undefined ? undefined : s(1),
      );
    case 'MD5':
    case 'SHA1':
    case 'SHA256':
    case 'SHA512':
      return CryptoJS[n as 'MD5'](wordArray(s(), args[1] === undefined ? undefined : s(1)))
        .toString()
        .toUpperCase();
    case 'HMACMD5':
    case 'HMACSHA1':
    case 'HMACSHA256':
    case 'HMACSHA512': {
      const method = (
        {
          HMACMD5: 'HmacMD5',
          HMACSHA1: 'HmacSHA1',
          HMACSHA256: 'HmacSHA256',
          HMACSHA512: 'HmacSHA512',
        } as const
      )[n as 'HMACMD5'];
      const encoding = args[2] === undefined ? undefined : s(2);
      return CryptoJS[method](wordArray(s(), encoding), wordArray(s(1), encoding))
        .toString()
        .toUpperCase();
    }
    case 'CRC32': {
      let crc = 0xffffffff;
      for (const byte of bytes(s(), args[1] === undefined ? undefined : s(1))) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
      return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0').toUpperCase();
    }
    case 'GUID':
      return crypto.randomUUID();
    case 'RMB':
      return rmb(v());
    case 'DATE':
      return new DateValue(
        (Date.UTC(
          v(),
          v(1) - 1,
          v(2),
          args[3] === undefined ? 0 : v(3),
          args[4] === undefined ? 0 : v(4),
          args[5] === undefined ? 0 : v(5),
        ) -
          epoch) /
          DAY,
        true,
      );
    case 'TIME':
      return new DateValue((v() * 3600 + v(1) * 60 + v(2)) / 86400, false);
    case 'NOW': {
      const d = new Date();
      return new DateValue(
        (Date.UTC(
          d.getFullYear(),
          d.getMonth(),
          d.getDate(),
          d.getHours(),
          d.getMinutes(),
          d.getSeconds(),
        ) -
          epoch) /
          DAY,
        true,
      );
    }
    case 'TODAY': {
      const d = new Date();
      return new DateValue(
        (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - epoch) / DAY,
        true,
      );
    }
    case 'DATEVALUE':
    case 'TIMEVALUE':
      return date(args[0]);
    case 'DATEDIF': {
      const a = date(args[0]).date,
        b = date(args[1]).date,
        unit = s(2).toUpperCase();
      const y = b.getUTCFullYear() - a.getUTCFullYear(),
        m = b.getUTCMonth() - a.getUTCMonth(),
        d = b.getUTCDate() - a.getUTCDate();
      if (unit === 'Y') return y - (m < 0 || (m === 0 && d < 0) ? 1 : 0);
      if (unit === 'M') return y * 12 + m - (d < 0 ? 1 : 0);
      if (unit === 'D') return Math.trunc((b.getTime() - a.getTime()) / DAY);
      if (unit === 'YM') return (m - (d < 0 ? 1 : 0) + 12) % 12;
      if (unit === 'MD')
        return d < 0
          ? d + new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + 1, 0)).getUTCDate()
          : d;
      if (unit === 'YD') {
        let days =
          (b.getTime() -
            Date.UTC(b.getUTCFullYear(), 0, 1) -
            a.getTime() +
            Date.UTC(a.getUTCFullYear(), 0, 1)) /
          DAY;
        if (y > 0 && days < 0)
          days +=
            (Date.UTC(a.getUTCFullYear() + 1, 0, 1) - Date.UTC(a.getUTCFullYear(), 0, 1)) / DAY;
        return Math.trunc(days);
      }
      return fail('DATEDIF 的单位必须为 y、m、d、ym、yd 或 md。');
    }
    case 'YEAR':
    case 'MONTH':
    case 'DAY':
    case 'HOUR':
    case 'MINUTE':
    case 'SECOND':
      return property(date(args[0]), n);
    case 'ADDDAYS':
    case 'ADDHOURS':
    case 'ADDMINUTES':
    case 'ADDSECONDS':
      return new DateValue(
        date(args[0]).serial +
          v(1) /
            (
              { ADDDAYS: 1, ADDHOURS: 24, ADDMINUTES: 1440, ADDSECONDS: 86400 } as Record<
                string,
                number
              >
            )[n],
      );
    case 'ADDYEARS':
    case 'ADDMONTHS': {
      const d = date(args[0]).date,
        day = d.getUTCDate();
      d.setUTCDate(1);
      if (n === 'ADDYEARS') d.setUTCFullYear(d.getUTCFullYear() + v(1));
      else d.setUTCMonth(d.getUTCMonth() + v(1));
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, last));
      return new DateValue((d.getTime() - epoch) / DAY, true);
    }
    case 'TIMESTAMP':
      return Math.round(date(args[0]).date.getTime() / (args.length > 1 && v(1) === 0 ? 1 : 1000));
    case 'FIXED':
      return v().toLocaleString('en-US', {
        minimumFractionDigits: args[1] === undefined ? 2 : v(1),
        maximumFractionDigits: args[1] === undefined ? 2 : v(1),
        useGrouping: !(args[2] && bool(args[2])),
      });
    case 'QUARTILE':
      if (v(1) === 0) return Math.min(...flatten([args[0]]).map(number));
      if (v(1) === 4) return Math.max(...flatten([args[0]]).map(number));
      break;
  }
  const alias: Record<string, string> = {
    MODE: 'MODE.SNGL',
    STDEV: 'STDEV.S',
    STDEVP: 'STDEV.P',
    VAR: 'VAR.S',
    VARP: 'VAR.P',
    COVAR: 'COVARIANCE.P',
    PERCENTILE: 'PERCENTILE.INC',
    QUARTILE: 'QUARTILE.INC',
    PERCENTRANK: 'PERCENTRANK.INC',
    NORMDIST: 'NORM.DIST',
    NORMINV: 'NORM.INV',
    NORMSDIST: 'NORM.S.DIST',
    NORMSINV: 'NORM.S.INV',
    BETADIST: 'BETA.DIST',
    BETAINV: 'BETA.INV',
    BINOMDIST: 'BINOM.DIST',
    CRITBINOM: 'BINOM.INV',
    CHIDIST: 'CHISQ.DIST.RT',
    CHIINV: 'CHISQ.INV.RT',
    EXPONDIST: 'EXPON.DIST',
    FDIST: 'F.DIST.RT',
    FINV: 'F.INV.RT',
    GAMMADIST: 'GAMMA.DIST',
    GAMMAINV: 'GAMMA.INV',
    HYPGEOMDIST: 'HYPGEOM.DIST',
    LOGINV: 'LOGNORM.INV',
    LOGNORMDIST: 'LOGNORM.DIST',
    NEGBINOMDIST: 'NEGBINOM.DIST',
    POISSON: 'POISSON.DIST',
    TDIST: 'T.DIST',
    TINV: 'T.INV.2T',
    WEIBULL: 'WEIBULL.DIST',
    RANDBETWEEN: 'RANDBETWEEN',
  };
  let fn: unknown = formulas;
  for (const key of (alias[n] ?? n).split('.'))
    fn =
      (fn && typeof fn === 'object') || typeof fn === 'function'
        ? (fn as Record<string, unknown>)[key]
        : undefined;
  if (typeof fn !== 'function') return fail(`不支持函数“${name}”。`);
  const convert = (value: Value): unknown =>
    value instanceof DateValue ? value.serial : Array.isArray(value) ? value.map(convert) : value;
  const dateArgs: Record<string, number[]> = {
    DATEDIF: [0, 1],
    DAYS360: [0, 1],
    DAYS: [0, 1],
    NETWORKDAYS: [0, 1],
    WORKDAY: [0],
    WEEKNUM: [0],
    WEEKDAY: [0],
    EDATE: [0],
    EOMONTH: [0],
    YEARFRAC: [0, 1],
  };
  const converted = args.map((arg, i) => {
    if (dateArgs[n]?.includes(i)) {
      const d = date(arg).date;
      return new Date(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate(),
        d.getUTCHours(),
        d.getUTCMinutes(),
        d.getUTCSeconds(),
      );
    }
    return convert(arg);
  });
  if (['BETADIST', 'LOGNORMDIST', 'NORMSDIST'].includes(n)) converted.push(true);
  if (['NEGBINOMDIST', 'HYPGEOMDIST'].includes(n)) converted.push(false);
  if (n === 'DATEDIF') converted[2] = s(2).toUpperCase();
  const result = (fn as (...args: unknown[]) => unknown)(...converted);
  if (result instanceof Error) return fail(`${name}：${result.message}`);
  if (result instanceof Date) {
    return new DateValue(
      (Date.UTC(
        result.getFullYear(),
        result.getMonth(),
        result.getDate(),
        result.getHours(),
        result.getMinutes(),
        result.getSeconds(),
      ) -
        epoch) /
        DAY,
      true,
    );
  }
  if (result === undefined) return fail(`${name} 的参数不正确。`);
  if (typeof result === 'number' && !Number.isFinite(result)) return fail(`${name} 计算结果无效。`);
  return /^(?:BIN|OCT|DEC)2HEX$/.test(n) && typeof result === 'string'
    ? result.toUpperCase()
    : (result as Value);
}

interface Compiled {
  tree: Node;
  parameters: Map<string, string>;
}
const cache = new Map<string, Compiled>();
export function evaluateExpression(expression: string, row: DataRow): boolean {
  if (!expression.trim()) return false;
  if (expression.length > 8192) throw new Error('条件表达式过长（最多 8192 个字符）。');
  try {
    let compiled = cache.get(expression);
    if (!compiled) {
      const { source, parameters } = translate(expression);
      compiled = { tree: new Parser(tokenize(source)).parse(), parameters };
      if (cache.size >= 256) cache.delete(cache.keys().next().value!);
      cache.set(expression, compiled);
    }
    let steps = 0;
    const started = Date.now();
    const evaluate = (node: Node): Value => {
      if (++steps > 10000 || Date.now() - started > 200) fail('条件表达式计算超出限制。');
      switch (node.kind) {
        case 'value':
          return node.value;
        case 'parameter': {
          const column = compiled!.parameters.get(node.name) ?? node.name;
          if (!Object.hasOwn(row, column)) return fail(`数据中缺少列“${column}”。`);
          const value = row[column];
          if (value.length > 1_000_000) fail('数据单元格过长。');
          return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()) &&
            Number.isFinite(Number(value))
            ? Number(value)
            : value;
        }
        case 'array':
          return node.values.map(evaluate);
        case 'unary': {
          const value = evaluate(node.value);
          return node.op === '!' ? !bool(value) : node.op === '-' ? -number(value) : number(value);
        }
        case 'binary': {
          const a = evaluate(node.left),
            b = evaluate(node.right);
          return node.op === '&&'
            ? bool(a) && bool(b)
            : node.op === '||'
              ? bool(a) || bool(b)
              : ['=', '==', '!=', '<>', '>', '>=', '<', '<='].includes(node.op)
                ? compare(node.op, a, b)
                : arithmetic(node.op, a, b);
        }
        case 'member':
          return property(evaluate(node.base), evaluate(node.key));
        case 'if':
          return bool(evaluate(node.test)) ? evaluate(node.yes) : evaluate(node.no);
        case 'call': {
          const name = node.name.toUpperCase();
          if (name === 'IF') {
            const test = bool(evaluate(node.args[0]));
            return test
              ? node.args[1]
                ? evaluate(node.args[1])
                : true
              : node.args[2]
                ? evaluate(node.args[2])
                : false;
          }
          if (['IFERROR', 'ISERROR', 'ISNULL', 'ISNULLORERROR'].includes(name)) {
            let result: Value = null,
              error = false;
            try {
              result = evaluate(node.args[0]);
            } catch {
              error = true;
            }
            const matched =
              name === 'ISNULL'
                ? result === null && !error
                : name === 'ISNULLORERROR'
                  ? result === null || error
                  : error;
            if (name === 'IFERROR')
              return matched
                ? node.args[1]
                  ? evaluate(node.args[1])
                  : true
                : node.args[2]
                  ? evaluate(node.args[2])
                  : result;
            if (node.args[1]) return matched ? evaluate(node.args[1]) : result;
            return matched;
          }
          return call(name, node.args.map(evaluate));
        }
      }
    };
    return bool(evaluate(compiled.tree));
  } catch (error) {
    throw new Error(`条件公式错误：${error instanceof Error ? error.message : String(error)}`);
  }
}
