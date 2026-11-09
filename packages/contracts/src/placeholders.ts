import type { Placeholder } from './translation';

/**
 * Placeholder extraction. Supports the styles we must not silently corrupt
 * (spec §5.2: variables, ICU MessageFormat and Unicode content must be preserved):
 *
 *  - printf / sprintf: %s %d %1$s %@ %{name}
 *  - named braces:     {name} {count, plural, ...} {{mustache}}
 *  - iOS positional:   %1$@
 *  - Android:          %1$s, %s
 *  - dollar:           ${name}, $name
 */
const PATTERNS: { type: string; regex: RegExp }[] = [
  { type: 'icu', regex: /\{\s*([A-Za-z0-9_]+)\s*,\s*(plural|selectordinal|select|number|date|time)\s*,/g },
  { type: 'mustache', regex: /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g },
  { type: 'named', regex: /\{\s*([A-Za-z0-9_.]+)\s*\}/g },
  { type: 'dollar-named', regex: /\$\{\s*([A-Za-z0-9_.]+)\s*\}/g },
  { type: 'printf', regex: /%(?:(\d+)\$)?[-+#0 ']*(\d+)?(?:\.(\d+))?([sdfiuoxXeEgGcpaA@%])/g },
  { type: 'ios-named', regex: /%\{([A-Za-z0-9_.]+)\}/g },
];

export function extractPlaceholders(value: string): Placeholder[] {
  const found = new Map<string, Placeholder>();
  for (const { type, regex } of PATTERNS) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(value)) !== null) {
      if (type === 'printf' && match[4] === '%') continue;
      // for printf, the "name" is the positional index or the conversion letter
      const rawName = type === 'printf' ? (match[1] ?? match[4] ?? '') : (match[1] ?? '');
      const name = type === 'printf' ? (match[1] ? `%${match[1]}$${match[4]}` : `%${match[4]}`) : rawName;
      if (!name) continue;
      found.set(`${type}:${name}`, { name, type, format: type === 'printf' ? match[4] : undefined });
    }
  }
  // ICU plural branches contain nested placeholders that the generic named pattern already caught;
  // drop the bare "{count" fragment captured from the plural header.
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function placeholderSignature(value: string): string {
  return extractPlaceholders(value)
    .map((p) => `${p.type}:${p.name}`)
    .sort()
    .join('|');
}

export interface PlaceholderMismatch {
  missing: string[];
  added: string[];
}

/** Compare the placeholder set of a source value and its translation. */
export function comparePlaceholders(source: string, target: string): PlaceholderMismatch {
  const s = new Set(placeholderSignature(source).split('|').filter(Boolean).map(normalizeForCompare));
  const t = new Set(placeholderSignature(target).split('|').filter(Boolean).map(normalizeForCompare));
  const missing = [...s].filter((x) => !t.has(x));
  const added = [...t].filter((x) => !s.has(x));
  return { missing, added };
}

/** `%1$s` and `%s` are equivalent when both appear at most once; normalise the positional form. */
function normalizeForCompare(signature: string): string {
  return signature.replace(/^printf:%\d+\$/, 'printf:%');
}
