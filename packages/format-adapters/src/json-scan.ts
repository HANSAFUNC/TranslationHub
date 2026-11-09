/**
 * JSON scanner that records the byte span of every value while parsing.
 *
 * This is what makes the JSON adapter able to patch a translation file *in place*:
 * we splice only the value tokens that actually change, so indentation, key order,
 * blank lines and any unknown neighbouring fields survive byte-for-byte.
 */

export interface JsonSpan {
  /** [start, end) offsets of the value token in the source text, quotes included for strings */
  start: number;
  end: number;
  type: 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';
}

export interface JsonScanResult {
  root: unknown;
  /** key path (segments joined with \u0001) -> value span */
  spans: Map<string, JsonSpan>;
  /** key path -> span of the whole member including the key token, for deletion */
  memberSpans: Map<string, { start: number; end: number }>;
  /** key path of an object -> span between its braces, for insertion */
  objectInnerSpans: Map<string, { start: number; end: number; indent: string }>;
}

export const PATH_SEP = '\u0001';

export function joinPath(segments: (string | number)[]): string {
  return segments.join(PATH_SEP);
}

export function splitPath(path: string): string[] {
  return path.split(PATH_SEP);
}

export class JsonScanError extends Error {
  constructor(message: string, readonly offset: number, readonly line: number, readonly column: number) {
    super(message);
    this.name = 'JsonScanError';
  }
}

export class JsonScanner {
  private pos = 0;
  private readonly spans = new Map<string, JsonSpan>();
  private readonly memberSpans = new Map<string, { start: number; end: number }>();
  private readonly objectInnerSpans = new Map<string, { start: number; end: number; indent: string }>();

  constructor(private readonly text: string) {}

  scan(): JsonScanResult {
    this.skipWhitespace();
    const root = this.parseValue([], null);
    this.skipWhitespace();
    if (this.pos !== this.text.length) {
      throw this.error('Unexpected trailing content');
    }
    return { root, spans: this.spans, memberSpans: this.memberSpans, objectInnerSpans: this.objectInnerSpans };
  }

  private parseValue(path: (string | number)[], memberStart: number | null): unknown {
    const ch = this.text[this.pos];
    if (ch === '{') return this.parseObject(path, memberStart);
    if (ch === '[') return this.parseArray(path, memberStart);
    if (ch === '"') return this.parseStringValue(path, memberStart);
    return this.parseLiteral(path, memberStart);
  }

  private parseObject(path: (string | number)[], memberStart: number | null): Record<string, unknown> {
    const start = this.pos;
    this.pos += 1; // {
    const out: Record<string, unknown> = {};
    const pathKey = joinPath(path);
    const innerStart = this.pos;
    let indent = '';
    this.skipWhitespace();
    if (this.text[this.pos] === '}') {
      this.pos += 1;
      this.spans.set(pathKey, { start, end: this.pos, type: 'object' });
      if (memberStart !== null) this.memberSpans.set(pathKey, { start: memberStart, end: this.pos });
      this.objectInnerSpans.set(pathKey, { start: innerStart, end: this.pos - 1, indent: '  ' });
      return out;
    }
    indent = this.detectIndent();
    for (;;) {
      this.skipWhitespace();
      const keyStart = this.pos;
      if (this.text[this.pos] !== '"') throw this.error('Expected object key');
      const key = this.parseStringToken();
      this.skipWhitespace();
      if (this.text[this.pos] !== ':') throw this.error("Expected ':'");
      this.pos += 1;
      this.skipWhitespace();
      const childPath = [...path, key];
      out[key] = this.parseValue(childPath, keyStart);
      this.skipWhitespace();
      const ch = this.text[this.pos];
      if (ch === ',') {
        this.pos += 1;
        continue;
      }
      if (ch === '}') {
        const end = this.pos + 1;
        this.pos = end;
        this.spans.set(pathKey, { start, end, type: 'object' });
        if (memberStart !== null) this.memberSpans.set(pathKey, { start: memberStart, end });
        this.objectInnerSpans.set(pathKey, { start: innerStart, end: end - 1, indent });
        return out;
      }
      throw this.error("Expected ',' or '}'");
    }
  }

  private parseArray(path: (string | number)[], memberStart: number | null): unknown[] {
    const start = this.pos;
    this.pos += 1; // [
    const out: unknown[] = [];
    const pathKey = joinPath(path);
    this.skipWhitespace();
    if (this.text[this.pos] === ']') {
      this.pos += 1;
      this.spans.set(pathKey, { start, end: this.pos, type: 'array' });
      if (memberStart !== null) this.memberSpans.set(pathKey, { start: memberStart, end: this.pos });
      return out;
    }
    let index = 0;
    for (;;) {
      this.skipWhitespace();
      out.push(this.parseValue([...path, index], null));
      index += 1;
      this.skipWhitespace();
      const ch = this.text[this.pos];
      if (ch === ',') {
        this.pos += 1;
        continue;
      }
      if (ch === ']') {
        const end = this.pos + 1;
        this.pos = end;
        this.spans.set(pathKey, { start, end, type: 'array' });
        if (memberStart !== null) this.memberSpans.set(pathKey, { start: memberStart, end });
        return out;
      }
      throw this.error("Expected ',' or ']'");
    }
  }

  private parseStringValue(path: (string | number)[], memberStart: number | null): string {
    const start = this.pos;
    const value = this.parseStringToken();
    const end = this.pos;
    const pathKey = joinPath(path);
    this.spans.set(pathKey, { start, end, type: 'string' });
    if (memberStart !== null) this.memberSpans.set(pathKey, { start: memberStart, end });
    return value;
  }

  private parseLiteral(path: (string | number)[], memberStart: number | null): unknown {
    const start = this.pos;
    const rest = this.text.slice(this.pos);
    const match = /^(true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(rest);
    if (!match) throw this.error('Unexpected token');
    this.pos += match[0].length;
    const raw = match[0];
    const type: JsonSpan['type'] = raw === 'true' || raw === 'false' ? 'boolean' : raw === 'null' ? 'null' : 'number';
    const pathKey = joinPath(path);
    this.spans.set(pathKey, { start, end: this.pos, type });
    if (memberStart !== null) this.memberSpans.set(pathKey, { start: memberStart, end: this.pos });
    if (type === 'boolean') return raw === 'true';
    if (type === 'null') return null;
    return Number(raw);
  }

  private parseStringToken(): string {
    const start = this.pos;
    this.pos += 1; // opening quote
    let out = '';
    for (;;) {
      if (this.pos >= this.text.length) throw this.error('Unterminated string');
      const ch = this.text[this.pos];
      if (ch === '"') {
        this.pos += 1;
        return out;
      }
      if (ch === '\\') {
        const next = this.text[this.pos + 1];
        switch (next) {
          case '"':
            out += '"';
            this.pos += 2;
            break;
          case '\\':
            out += '\\';
            this.pos += 2;
            break;
          case '/':
            out += '/';
            this.pos += 2;
            break;
          case 'b':
            out += '\b';
            this.pos += 2;
            break;
          case 'f':
            out += '\f';
            this.pos += 2;
            break;
          case 'n':
            out += '\n';
            this.pos += 2;
            break;
          case 'r':
            out += '\r';
            this.pos += 2;
            break;
          case 't':
            out += '\t';
            this.pos += 2;
            break;
          case 'u': {
            const hex = this.text.slice(this.pos + 2, this.pos + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw this.error('Invalid unicode escape');
            out += String.fromCharCode(parseInt(hex, 16));
            this.pos += 6;
            break;
          }
          default:
            throw this.error('Invalid escape sequence');
        }
        continue;
      }
      if (ch === '\n' || ch === '\r') throw this.error('Unterminated string');
      out += ch;
      this.pos += 1;
    }
    // keep the reference so linters do not complain about unused variable
    void start;
  }

  private detectIndent(): string {
    const rest = this.text.slice(this.pos);
    const match = /\n([ \t]+)\S/.exec(rest);
    return match?.[1] ?? '  ';
  }

  private skipWhitespace(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos += 1;
  }

  private error(message: string): JsonScanError {
    let line = 1;
    let column = 1;
    for (let i = 0; i < this.pos && i < this.text.length; i += 1) {
      if (this.text[i] === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
    }
    return new JsonScanError(`${message} at line ${line}, column ${column}`, this.pos, line, column);
  }
}

export function scanJson(text: string): JsonScanResult {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return new JsonScanner(withoutBom).scan();
}
