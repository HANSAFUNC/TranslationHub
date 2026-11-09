/**
 * Canonical representation of pluralised values.
 *
 * Plurals must survive round-trips through the platform (spec §10.1), and the platform
 * needs one canonical string per entry. ICU MessageFormat is that canonical string:
 *
 *   {count, plural, one {# item} other {# items}}
 *
 * `#` is the ICU shorthand for the plural argument value, which is how Android's %d and
 * Apple's %d are expressed without losing the quantity branches.
 */
export interface ParsedPlural {
  argName: string;
  quantities: Record<string, string>;
  exactMatches?: Record<string, string>;
}

const HEADER = /^\s*\{\s*([A-Za-z0-9_]+)\s*,\s*(plural|selectordinal)\s*,\s*/;

export function buildIcuPlural(parsed: ParsedPlural): string {
  const branches = Object.entries(parsed.quantities)
    .map(([quantity, value]) => `${quantity} {${value}}`)
    .join(' ');
  return `{${parsed.argName}, plural, ${branches}}`;
}

export function parseIcuPlural(value: string): ParsedPlural | null {
  const header = HEADER.exec(value);
  if (!header) return null;
  const argName = header[1] ?? 'count';
  let index = header[0].length;
  const quantities: Record<string, string> = {};
  const exactMatches: Record<string, string> = {};
  while (index < value.length) {
    while (index < value.length && /\s/.test(value[index] ?? '')) index += 1;
    if (value[index] === '}') break;
    const selectorMatch = /^([A-Za-z0-9_]+|=?\d+)\s*\{/.exec(value.slice(index));
    if (!selectorMatch) return null;
    const selector = selectorMatch[1] ?? '';
    index += selectorMatch[0].length;
    let depth = 1;
    let body = '';
    while (index < value.length && depth > 0) {
      const ch = value[index];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
      body += ch;
      index += 1;
    }
    if (depth !== 0) return null;
    index += 1; // closing brace of branch
    if (selector.startsWith('=')) exactMatches[selector] = body;
    else quantities[selector] = body;
  }
  if (Object.keys(quantities).length === 0) return null;
  return { argName, quantities, ...(Object.keys(exactMatches).length ? { exactMatches } : {}) };
}

export function isPluralValue(value: string): boolean {
  return parseIcuPlural(value) !== null;
}

export function pluralQuantities(value: string): Record<string, string> | null {
  const parsed = parseIcuPlural(value);
  return parsed ? parsed.quantities : null;
}
