/**
 * BCP-47 style language tag handling (spec §4.2 requires locale codes to be valid BCP 47).
 * We intentionally implement a pragmatic validator instead of pulling a full CLDR database:
 * language[-Script][-REGION][-variant...] plus the special "*" wildcard used in file mappings.
 */

const LANGUAGE = /^[a-z]{2,3}$/;
const SCRIPT = /^[A-Z][a-z]{3}$/;
const REGION = /^([A-Z]{2}|\d{3})$/;
const VARIANT = /^([a-z0-9]{5,8}|\d[a-z0-9]{3})$/;

export function isValidLocaleTag(tag: string): boolean {
  if (tag === '*') return true;
  if (!tag || tag.length > 64) return false;
  const parts = tag.split('-');
  const [language, ...rest] = parts;
  if (!language || !LANGUAGE.test(language.toLowerCase())) return false;
  let index = 0;
  if (rest[index] && SCRIPT.test(rest[index])) index += 1;
  if (rest[index] && REGION.test(rest[index])) index += 1;
  for (; index < rest.length; index += 1) {
    const part = rest[index];
    if (!VARIANT.test(part) && !part.startsWith('x-')) return false;
  }
  return true;
}

/** Canonical form: lower case language, Title case script, upper case region. */
export function canonicalizeLocaleTag(tag: string): string {
  if (tag === '*') return tag;
  const parts = tag.split('-');
  const out: string[] = [];
  const [language, ...rest] = parts;
  out.push((language ?? '').toLowerCase());
  let index = 0;
  if (rest[index] && SCRIPT.test(rest[index])) {
    const s = rest[index];
    out.push(s.charAt(0).toUpperCase() + s.slice(1).toLowerCase());
    index += 1;
  }
  if (rest[index] && REGION.test(rest[index])) {
    const r = rest[index];
    out.push(/^\d+$/.test(r) ? r : r.toUpperCase());
    index += 1;
  }
  for (; index < rest.length; index += 1) out.push(rest[index].toLowerCase());
  return out.join('-');
}

/** Base language of a tag: "zh-Hans-CN" -> "zh". */
export function baseLanguage(tag: string): string {
  return (tag.split('-')[0] ?? '').toLowerCase();
}
