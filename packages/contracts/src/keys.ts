/** Translation key helpers: namespace handling and canonical key paths. */

export function joinKey(...parts: (string | undefined | null)[]): string {
  return parts
    .filter((p): p is string => Boolean(p && p.length))
    .join('.')
    .replace(/\.{2,}/g, '.');
}

/** Split a dotted key into [namespace, key] when the namespace prefix is known. */
export function splitNamespace(key: string, knownNamespaces: string[]): { namespace: string; key: string } {
  for (const ns of knownNamespaces.filter(Boolean).sort((a, b) => b.length - a.length)) {
    if (key === ns) return { namespace: ns, key: '' };
    if (key.startsWith(`${ns}.`)) return { namespace: ns, key: key.slice(ns.length + 1) };
  }
  return { namespace: '', key };
}

export function isIgnoredKey(key: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globMatch(pattern, key));
}

/** Minimal glob matcher supporting `*`, `**` and `?` — used for ignore rules and path filters. */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  const regex = globToRegExp(pattern);
  return regex.test(value);
}

const globCache = new Map<string, RegExp>();

export function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` may match zero directories
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  const regex = new RegExp(`^${out}$`);
  globCache.set(pattern, regex);
  return regex;
}

/** Namespaces inferred from a file path (config `namespaceFromPath: true`). */
export function namespaceFromFilePath(relativePath: string, localePattern: string): string {
  const withoutExt = relativePath.replace(/\.[^./\\]+$/, '');
  const parts = withoutExt.split(/[/\\]/).filter(Boolean);
  const localeIndex = parts.findIndex((p) => p === localePattern || globMatch(localePattern, p));
  const tail = (localeIndex >= 0 ? parts.slice(localeIndex + 1) : parts.slice(-1)).filter((p) => !p.startsWith('values'));
  return tail.join('.');
}
