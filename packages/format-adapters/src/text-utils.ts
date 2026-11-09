export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/** Apply non-overlapping edits to a text buffer, right to left so offsets stay valid. */
export function applyTextEdits(text: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const edit of sorted) {
    if (edit.end > lastStart) {
      throw new Error('Overlapping text edits are not allowed');
    }
    lastStart = edit.start;
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

export function lineOfOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '\\' + "'");
}

export function unescapeHtml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

/** iOS / Android string escaping (spec §10.1 "编码、注释、转义"). */
export function unescapeIosString(value: string): string {
  return value.replace(/\\(.)/g, (_, ch: string) => {
    switch (ch) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case '"':
        return '"';
      case '\\':
        return '\\';
      case "'":
        return "'";
      default:
        return ch;
    }
  });
}

export function escapeIosString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

export function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
