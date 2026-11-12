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

/**
 * Canonical form: lower case language, Title case script, upper case region.
 *
 * The script and region positions also *repair* case, not just preserve it: `pt-br` and `zh-hans`
 * arrive from directory names and hand-written config, and a canonicaliser that leaves them alone
 * hands the validator a tag it will reject. Position is what makes the repair unambiguous — a
 * four-letter alphabetic subtag straight after the language can only be a script, and a two-letter
 * or three-digit one can only be a region.
 */
export function canonicalizeLocaleTag(tag: string): string {
  if (tag === '*') return tag;
  const parts = tag.split('-');
  const out: string[] = [];
  const [language, ...rest] = parts;
  out.push((language ?? '').toLowerCase());
  let index = 0;
  const script = rest[index];
  if (script && /^[A-Za-z]{4}$/.test(script)) {
    out.push(script.charAt(0).toUpperCase() + script.slice(1).toLowerCase());
    index += 1;
  }
  const region = rest[index];
  if (region && /^([A-Za-z]{2}|\d{3})$/.test(region)) {
    out.push(/^\d+$/.test(region) ? region : region.toUpperCase());
    index += 1;
  }
  for (; index < rest.length; index += 1) out.push(rest[index].toLowerCase());
  return out.join('-');
}

/** Base language of a tag: "zh-Hans-CN" -> "zh". */
export function baseLanguage(tag: string): string {
  return (tag.split('-')[0] ?? '').toLowerCase();
}

/**
 * Tags that name the same language through different subtags.
 *
 * This is the one place where a script and a region genuinely substitute for each other: `zh-Hans`
 * and `zh-CN` are both "Chinese, Simplified", and an iOS repository writes the first while a
 * platform project usually stores the second. Everywhere else the platform compares tags literally,
 * which is why this list is explicit and short rather than a guess at CLDR's likely-subtags.
 */
const EQUIVALENT_LOCALE_GROUPS: readonly (readonly string[])[] = [
  ['zh-Hans', 'zh-CN', 'zh-SG', 'zh-MY'],
  ['zh-Hant', 'zh-TW', 'zh-HK', 'zh-MO'],
];

export type LocaleResolutionReason = 'exact' | 'equivalent' | 'new' | 'ambiguous';

export interface LocaleResolution {
  /** The code to store. For `equivalent` this is the code already in the project. */
  code: string;
  reason: LocaleResolutionReason;
  /** For `ambiguous`: every existing code that could have been meant. */
  candidates?: string[];
}

/**
 * Decide which code an incoming tag should become, given what the project already has.
 *
 * `ambiguous` is returned rather than guessed at: a bare `zh` against a project holding both
 * `zh-CN` and `zh-TW` has no right answer, and picking one would file text under the wrong language
 * — the kind of mistake that is silent and expensive. The caller is expected to refuse and say so.
 */
export function resolveLocaleTag(incoming: string, existing: readonly string[]): LocaleResolution {
  const code = canonicalizeLocaleTag(incoming);
  const canonical = existing.map(canonicalizeLocaleTag);

  const exactIndex = canonical.indexOf(code);
  if (exactIndex >= 0) return { code: existing[exactIndex] ?? code, reason: 'exact' };

  const group = EQUIVALENT_LOCALE_GROUPS.find((members) => members.includes(code));
  if (group) {
    const matches = existing.filter((_, index) => group.includes(canonical[index] ?? ''));
    if (matches.length === 1) return { code: matches[0]!, reason: 'equivalent' };
    if (matches.length > 1) return { code, reason: 'ambiguous', candidates: matches };
  }

  // `ja` against a project that has exactly one Japanese locale means that locale. Against two,
  // it means neither in particular.
  if (!code.includes('-')) {
    const matches = existing.filter((_, index) => baseLanguage(canonical[index] ?? '') === code);
    if (matches.length === 1) return { code: matches[0]!, reason: 'equivalent' };
    if (matches.length > 1) return { code, reason: 'ambiguous', candidates: matches };
  }

  return { code, reason: 'new' };
}

const LANGUAGE_NAMES: Record<string, string> = {
  ar: 'العربية', bn: 'বাংলা', cs: 'Čeština', da: 'Dansk', de: 'Deutsch', el: 'Ελληνικά',
  en: 'English', es: 'Español', fa: 'فارسی', fi: 'Suomi', fr: 'Français', he: 'עברית',
  hi: 'हिन्दी', id: 'Bahasa Indonesia', it: 'Italiano', ja: '日本語', ko: '한국어', ms: 'Bahasa Melayu',
  nb: 'Norsk Bokmål', nl: 'Nederlands', pl: 'Polski', pt: 'Português', ru: 'Русский', sv: 'Svenska',
  ta: 'தமிழ்', th: 'ไทย', tr: 'Türkçe', uk: 'Українська', ur: 'اردو', vi: 'Tiếng Việt', zh: '中文',
};

const SCRIPT_NAMES: Record<string, string> = {
  Arab: 'Arabic', Cyrl: 'Cyrillic', Hans: '简体', Hant: '繁體', Jpan: '日本語', Kore: '한국어', Latn: 'Latin',
};

const REGION_NAMES: Record<string, string> = {
  AU: 'Australia', BR: 'Brasil', CA: 'Canada', CN: '中国', DE: 'Deutschland', ES: 'España',
  FR: 'France', GB: 'United Kingdom', HK: '香港', IN: 'India', IT: 'Italia', JP: '日本',
  KR: '대한민국', MX: 'México', MY: 'Malaysia', NL: 'Nederland', RU: 'Россия', SG: '新加坡',
  TW: '台灣', US: 'United States',
};

/**
 * A human label for a locale the platform had to invent.
 *
 * A locale created by an import used to be named after its own code, so the project page showed
 * `zh-Hant` next to a hand-made `中文（繁體）`. Best effort and never authoritative: unrecognised
 * subtags fall back to the tag itself, which is still better than an empty cell.
 */
export function localeDisplayName(tag: string): string {
  const code = canonicalizeLocaleTag(tag);
  const parts = code.split('-');
  const language = parts[0] ?? '';
  const pieces = [LANGUAGE_NAMES[language] ?? code];

  const script = parts.find((part) => SCRIPT_NAMES[part] !== undefined);
  if (script) pieces.push(SCRIPT_NAMES[script]!);
  const region = parts.find((part) => REGION_NAMES[part] !== undefined);
  if (region) pieces.push(REGION_NAMES[region]!);

  if (pieces.length === 1) return pieces[0]!;
  const [base, ...rest] = pieces;
  return `${base}（${rest.join('，')}）`;
}
