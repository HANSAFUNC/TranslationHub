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
 * Labels are Chinese, because the product is.
 *
 * The catalog used to label every language with its own name — `한국어`, `Français · FR`,
 * `አማርኛ` — which is the right label on a language switcher and the wrong one in a Chinese admin
 * UI: the person choosing a language for their project has to recognise a script they may not read,
 * and `· FR` is a region code, not a word. The language's own name is still shown beside it in the
 * picker, because a translator does recognise it.
 */
export const LANGUAGE_ZH: Record<string, string> = {
  af: '南非荷兰语', am: '阿姆哈拉语', ar: '阿拉伯语', az: '阿塞拜疆语', be: '白俄罗斯语', bg: '保加利亚语',
  bn: '孟加拉语', ca: '加泰罗尼亚语', cs: '捷克语', da: '丹麦语', de: '德语', el: '希腊语', en: '英语',
  es: '西班牙语', et: '爱沙尼亚语', eu: '巴斯克语', fa: '波斯语', fi: '芬兰语', fil: '菲律宾语', fr: '法语',
  ga: '爱尔兰语', gl: '加利西亚语', gu: '古吉拉特语', he: '希伯来语', hi: '印地语', hr: '克罗地亚语',
  hu: '匈牙利语', hy: '亚美尼亚语', id: '印度尼西亚语', is: '冰岛语', it: '意大利语', ja: '日语', jv: '爪哇语',
  ka: '格鲁吉亚语', kk: '哈萨克语', km: '高棉语', kn: '卡纳达语', ko: '韩语', lo: '老挝语', lt: '立陶宛语',
  lv: '拉脱维亚语', mk: '马其顿语', ml: '马拉雅拉姆语', mn: '蒙古语', mr: '马拉地语', ms: '马来语',
  my: '缅甸语', nb: '挪威语', ne: '尼泊尔语', nl: '荷兰语', pa: '旁遮普语', pl: '波兰语', pt: '葡萄牙语',
  ro: '罗马尼亚语', ru: '俄语', si: '僧伽罗语', sk: '斯洛伐克语', sl: '斯洛文尼亚语', sq: '阿尔巴尼亚语',
  sr: '塞尔维亚语', sv: '瑞典语', sw: '斯瓦希里语', ta: '泰米尔语', te: '泰卢固语', th: '泰语', tr: '土耳其语',
  uk: '乌克兰语', ur: '乌尔都语', uz: '乌兹别克语', vi: '越南语', zh: '中文', zu: '祖鲁语',
};

export const SCRIPT_ZH: Record<string, string> = { Hans: '简体', Hant: '繁体' };

export const REGION_ZH: Record<string, string> = {
  AE: '阿联酋', AL: '阿尔巴尼亚', AM: '亚美尼亚', AR: '阿根廷', AT: '奥地利', AU: '澳大利亚', AZ: '阿塞拜疆',
  BD: '孟加拉国', BE: '比利时', BG: '保加利亚', BR: '巴西', BY: '白俄罗斯', CA: '加拿大', CH: '瑞士',
  CL: '智利', CN: '中国', CO: '哥伦比亚', CZ: '捷克', DE: '德国', DK: '丹麦', EE: '爱沙尼亚', EG: '埃及',
  ES: '西班牙', ET: '埃塞俄比亚', FI: '芬兰', FR: '法国', GB: '英国', GE: '格鲁吉亚', GR: '希腊',
  HK: '香港', HR: '克罗地亚', HU: '匈牙利', ID: '印度尼西亚', IE: '爱尔兰', IL: '以色列', IN: '印度',
  IR: '伊朗', IS: '冰岛', IT: '意大利', JP: '日本', KE: '肯尼亚', KH: '柬埔寨', KR: '韩国', KZ: '哈萨克斯坦',
  LA: '老挝', LK: '斯里兰卡', LT: '立陶宛', LV: '拉脱维亚', MK: '北马其顿', MM: '缅甸', MN: '蒙古',
  MX: '墨西哥', MY: '马来西亚', NE: '尼泊尔', NL: '荷兰', NO: '挪威', NP: '尼泊尔', PH: '菲律宾',
  PK: '巴基斯坦', PL: '波兰', PT: '葡萄牙', RO: '罗马尼亚', RS: '塞尔维亚', RU: '俄罗斯', SA: '沙特阿拉伯',
  SE: '瑞典', SG: '新加坡', SI: '斯洛文尼亚', SK: '斯洛伐克', SV: '萨尔瓦多', TH: '泰国', TR: '土耳其',
  TW: '台湾', UA: '乌克兰', US: '美国', UZ: '乌兹别克斯坦', VN: '越南', ZA: '南非',
};

/**
 * `zh-CN` carries no script subtag but is Simplified; without this, `zh-CN` and `zh-TW` would both
 * render as plain 中文 and be indistinguishable.
 */
const ZH_IMPLIED_SCRIPT: Record<string, string> = { CN: 'Hans', SG: 'Hans', MY: 'Hans', TW: 'Hant', HK: 'Hant', MO: 'Hant' };

/**
 * The Chinese label for a language.
 *
 * The region is added only when it distinguishes: a list holding one Korean locale does not need
 * "韩语（韩国）", but one holding `en-US` and `en-GB` does, or the two rows read identically and the
 * choice becomes a guess.
 */
export function localeLabel(entry: LocaleCatalogEntry): string {
  const [language, ...rest] = entry.code.split('-');
  const base = LANGUAGE_ZH[language ?? ''] ?? entry.native;

  if (language === 'zh') {
    const script = rest.find((part) => SCRIPT_ZH[part] !== undefined) ?? ZH_IMPLIED_SCRIPT[rest[0] ?? ''];
    const region = rest.find((part) => REGION_ZH[part] !== undefined);
    const name = script ? `${SCRIPT_ZH[script]}${base}` : base;
    return region ? `${name}（${REGION_ZH[region]}）` : name;
  }

  if ((LANGUAGE_COUNTS[language ?? ''] ?? 0) <= 1) return base;
  const region = rest.find((part) => REGION_ZH[part] !== undefined);
  return region ? `${base}（${REGION_ZH[region]}）` : base;
}

/** The language's own name, for the picker's second line. */
export function localeNativeName(entry: LocaleCatalogEntry): string {
  return entry.native;
}

/** Search by code, native name or English name — whatever the person happens to know. */
export function searchCatalogLocales(query: string, limit = 60): LocaleCatalogEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return COMMON_LOCALES.slice(0, limit);
  const matches = COMMON_LOCALES.filter(
    (entry) =>
      entry.code.toLowerCase().includes(needle) ||
      entry.native.toLowerCase().includes(needle) ||
      entry.english.toLowerCase().includes(needle) ||
      // The label is what the list shows, so it is what people type: 韩语, 英语, 繁体中文.
      localeLabel(entry).toLowerCase().includes(needle),
  );
  return matches.slice(0, limit);
}
