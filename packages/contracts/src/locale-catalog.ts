/**
 * The languages a project is likely to need, so nobody has to type a code from memory.
 *
 * The platform accepts any valid BCP 47 tag — this list is not a constraint, it is what the picker
 * offers. It lives in the contracts package because three consumers need the same list with the
 * same labels: the web picker, the name given to a locale the platform creates during an import,
 * and anything that has to show a language to a person.
 *
 * `native` is what the language calls itself (what a translator recognizes), `english` is what an
 * English reader searches by. Both are searchable in the picker.
 */
export interface LocaleCatalogEntry {
  code: string;
  native: string;
  english: string;
}

export const COMMON_LOCALES: readonly LocaleCatalogEntry[] = [
  { code: 'af-ZA', native: 'Afrikaans', english: 'Afrikaans (South Africa)' },
  { code: 'am-ET', native: 'አማርኛ', english: 'Amharic (Ethiopia)' },
  { code: 'ar-SA', native: 'العربية', english: 'Arabic (Saudi Arabia)' },
  { code: 'ar-AE', native: 'العربية', english: 'Arabic (United Arab Emirates)' },
  { code: 'ar-EG', native: 'العربية', english: 'Arabic (Egypt)' },
  { code: 'az-AZ', native: 'Azərbaycan', english: 'Azerbaijani (Azerbaijan)' },
  { code: 'be-BY', native: 'Беларуская', english: 'Belarusian (Belarus)' },
  { code: 'bg-BG', native: 'Български', english: 'Bulgarian (Bulgaria)' },
  { code: 'bn-BD', native: 'বাংলা', english: 'Bengali (Bangladesh)' },
  { code: 'bn-IN', native: 'বাংলা', english: 'Bengali (India)' },
  { code: 'ca-ES', native: 'Català', english: 'Catalan (Spain)' },
  { code: 'cs-CZ', native: 'Čeština', english: 'Czech (Czechia)' },
  { code: 'da-DK', native: 'Dansk', english: 'Danish (Denmark)' },
  { code: 'de-DE', native: 'Deutsch', english: 'German (Germany)' },
  { code: 'de-AT', native: 'Deutsch', english: 'German (Austria)' },
  { code: 'de-CH', native: 'Deutsch', english: 'German (Switzerland)' },
  { code: 'el-GR', native: 'Ελληνικά', english: 'Greek (Greece)' },
  { code: 'en-US', native: 'English', english: 'English (United States)' },
  { code: 'en-GB', native: 'English', english: 'English (United Kingdom)' },
  { code: 'en-AU', native: 'English', english: 'English (Australia)' },
  { code: 'en-CA', native: 'English', english: 'English (Canada)' },
  { code: 'en-IN', native: 'English', english: 'English (India)' },
  { code: 'en-SG', native: 'English', english: 'English (Singapore)' },
  { code: 'es-ES', native: 'Español', english: 'Spanish (Spain)' },
  { code: 'es-MX', native: 'Español', english: 'Spanish (Mexico)' },
  { code: 'es-AR', native: 'Español', english: 'Spanish (Argentina)' },
  { code: 'es-CL', native: 'Español', english: 'Spanish (Chile)' },
  { code: 'es-CO', native: 'Español', english: 'Spanish (Colombia)' },
  { code: 'es-US', native: 'Español', english: 'Spanish (United States)' },
  { code: 'et-EE', native: 'Eesti', english: 'Estonian (Estonia)' },
  { code: 'eu-ES', native: 'Euskara', english: 'Basque (Spain)' },
  { code: 'fa-IR', native: 'فارسی', english: 'Persian (Iran)' },
  { code: 'fi-FI', native: 'Suomi', english: 'Finnish (Finland)' },
  { code: 'fil-PH', native: 'Filipino', english: 'Filipino (Philippines)' },
  { code: 'fr-FR', native: 'Français', english: 'French (France)' },
  { code: 'fr-CA', native: 'Français', english: 'French (Canada)' },
  { code: 'fr-BE', native: 'Français', english: 'French (Belgium)' },
  { code: 'fr-CH', native: 'Français', english: 'French (Switzerland)' },
  { code: 'ga-IE', native: 'Gaeilge', english: 'Irish (Ireland)' },
  { code: 'gl-ES', native: 'Galego', english: 'Galician (Spain)' },
  { code: 'gu-IN', native: 'ગુજરાતી', english: 'Gujarati (India)' },
  { code: 'he-IL', native: 'עברית', english: 'Hebrew (Israel)' },
  { code: 'hi-IN', native: 'हिन्दी', english: 'Hindi (India)' },
  { code: 'hr-HR', native: 'Hrvatski', english: 'Croatian (Croatia)' },
  { code: 'hu-HU', native: 'Magyar', english: 'Hungarian (Hungary)' },
  { code: 'hy-AM', native: 'Հայերեն', english: 'Armenian (Armenia)' },
  { code: 'id-ID', native: 'Bahasa Indonesia', english: 'Indonesian (Indonesia)' },
  { code: 'is-IS', native: 'Íslenska', english: 'Icelandic (Iceland)' },
  { code: 'it-IT', native: 'Italiano', english: 'Italian (Italy)' },
  { code: 'it-CH', native: 'Italiano', english: 'Italian (Switzerland)' },
  { code: 'ja-JP', native: '日本語', english: 'Japanese (Japan)' },
  { code: 'jv-ID', native: 'Basa Jawa', english: 'Javanese (Indonesia)' },
  { code: 'ka-GE', native: 'ქართული', english: 'Georgian (Georgia)' },
  { code: 'kk-KZ', native: 'Қазақша', english: 'Kazakh (Kazakhstan)' },
  { code: 'km-KH', native: 'ខ្មែរ', english: 'Khmer (Cambodia)' },
  { code: 'kn-IN', native: 'ಕನ್ನಡ', english: 'Kannada (India)' },
  { code: 'ko-KR', native: '한국어', english: 'Korean (South Korea)' },
  { code: 'lo-LA', native: 'ລາວ', english: 'Lao (Laos)' },
  { code: 'lt-LT', native: 'Lietuvių', english: 'Lithuanian (Lithuania)' },
  { code: 'lv-LV', native: 'Latviešu', english: 'Latvian (Latvia)' },
  { code: 'mk-MK', native: 'Македонски', english: 'Macedonian (North Macedonia)' },
  { code: 'ml-IN', native: 'മലയാളം', english: 'Malayalam (India)' },
  { code: 'mn-MN', native: 'Монгол', english: 'Mongolian (Mongolia)' },
  { code: 'mr-IN', native: 'मराठी', english: 'Marathi (India)' },
  { code: 'ms-MY', native: 'Bahasa Melayu', english: 'Malay (Malaysia)' },
  { code: 'my-MM', native: 'မြန်မာ', english: 'Burmese (Myanmar)' },
  { code: 'nb-NO', native: 'Norsk Bokmål', english: 'Norwegian Bokmål (Norway)' },
  { code: 'ne-NP', native: 'नेपाली', english: 'Nepali (Nepal)' },
  { code: 'nl-NL', native: 'Nederlands', english: 'Dutch (Netherlands)' },
  { code: 'nl-BE', native: 'Nederlands', english: 'Dutch (Belgium)' },
  { code: 'pa-IN', native: 'ਪੰਜਾਬੀ', english: 'Punjabi (India)' },
  { code: 'pl-PL', native: 'Polski', english: 'Polish (Poland)' },
  { code: 'pt-BR', native: 'Português', english: 'Portuguese (Brazil)' },
  { code: 'pt-PT', native: 'Português', english: 'Portuguese (Portugal)' },
  { code: 'ro-RO', native: 'Română', english: 'Romanian (Romania)' },
  { code: 'ru-RU', native: 'Русский', english: 'Russian (Russia)' },
  { code: 'si-LK', native: 'සිංහල', english: 'Sinhala (Sri Lanka)' },
  { code: 'sk-SK', native: 'Slovenčina', english: 'Slovak (Slovakia)' },
  { code: 'sl-SI', native: 'Slovenščina', english: 'Slovenian (Slovenia)' },
  { code: 'sq-AL', native: 'Shqip', english: 'Albanian (Albania)' },
  { code: 'sr-RS', native: 'Српски', english: 'Serbian (Serbia)' },
  { code: 'sv-SE', native: 'Svenska', english: 'Swedish (Sweden)' },
  { code: 'sw-KE', native: 'Kiswahili', english: 'Swahili (Kenya)' },
  { code: 'ta-IN', native: 'தமிழ்', english: 'Tamil (India)' },
  { code: 'te-IN', native: 'తెలుగు', english: 'Telugu (India)' },
  { code: 'th-TH', native: 'ไทย', english: 'Thai (Thailand)' },
  { code: 'tr-TR', native: 'Türkçe', english: 'Turkish (Türkiye)' },
  { code: 'uk-UA', native: 'Українська', english: 'Ukrainian (Ukraine)' },
  { code: 'ur-PK', native: 'اردو', english: 'Urdu (Pakistan)' },
  { code: 'uz-UZ', native: 'Oʻzbek', english: 'Uzbek (Uzbekistan)' },
  { code: 'vi-VN', native: 'Tiếng Việt', english: 'Vietnamese (Vietnam)' },
  { code: 'zh-CN', native: '中文（简体）', english: 'Chinese, Simplified (China)' },
  { code: 'zh-TW', native: '中文（繁體）', english: 'Chinese, Traditional (Taiwan)' },
  { code: 'zh-HK', native: '中文（繁體）', english: 'Chinese, Traditional (Hong Kong)' },
  { code: 'zh-Hans', native: '中文（简体）', english: 'Chinese, Simplified' },
  { code: 'zh-Hant', native: '中文（繁體）', english: 'Chinese, Traditional' },
  // iOS ships a `Base.lproj` for storyboards whose strings are the development language; naming it
  // explicitly stops a repository's `Base.lproj` from becoming a mystery locale.
  { code: 'zu-ZA', native: 'isiZulu', english: 'Zulu (South Africa)' },
];

const BY_CODE = new Map(COMMON_LOCALES.map((entry) => [entry.code, entry]));

export function findCatalogLocale(code: string): LocaleCatalogEntry | undefined {
  return BY_CODE.get(code);
}

const LANGUAGE_COUNTS = COMMON_LOCALES.reduce<Record<string, number>>((counts, entry) => {
  const language = entry.code.split('-')[0] ?? '';
  counts[language] = (counts[language] ?? 0) + 1;
  return counts;
}, {});

/**
 * The label to show next to a language.
 *
 * The region is added only when it distinguishes: a list holding one English locale does not need
 * "English (United States)", but one holding `en-US` and `en-GB` does, or the two rows read
 * identically and the choice becomes a guess.
 */
export function localeLabel(entry: LocaleCatalogEntry): string {
  const language = entry.code.split('-')[0] ?? '';
  if ((LANGUAGE_COUNTS[language] ?? 0) <= 1) return entry.native;
  const rest = entry.code.split('-').slice(1).join('-');
  return rest ? `${entry.native} · ${rest}` : entry.native;
}

/** Search by code, native name or English name — whatever the person happens to know. */
export function searchCatalogLocales(query: string, limit = 60): LocaleCatalogEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return COMMON_LOCALES.slice(0, limit);
  const matches = COMMON_LOCALES.filter(
    (entry) =>
      entry.code.toLowerCase().includes(needle) ||
      entry.native.toLowerCase().includes(needle) ||
      entry.english.toLowerCase().includes(needle),
  );
  return matches.slice(0, limit);
}
