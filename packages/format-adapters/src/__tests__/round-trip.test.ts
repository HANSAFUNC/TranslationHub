import { describe, expect, it } from 'vitest';
import { contentHash, type AdapterInput, type FormatAdapter, type NormalizedEntry } from '@localehub/contracts';
import { JsonAdapter } from '../json-adapter';
import { YamlAdapter } from '../adapters/yaml';
import { AppleStringsAdapter } from '../adapters/ios-strings';
import { AndroidXmlAdapter, localeFromAndroidPath } from '../adapters/android-xml';
import { XcstringsAdapter } from '../adapters/xcstrings';
import { StringsdictAdapter } from '../adapters/stringsdict';
import { PoAdapter } from '../adapters/po';
import { XliffAdapter } from '../adapters/xliff';
import { createAdapter, formatForExtension } from '../index';
import { buildIcuPlural, parseIcuPlural } from '../icu';

function input(filePath: string, content: string, overrides: Partial<AdapterInput> = {}): AdapterInput {
  return {
    filePath,
    content: Buffer.from(content, 'utf8'),
    locale: 'ja-JP',
    namespace: 'common',
    platform: 'web',
    ...overrides,
  };
}

function asNormalized(adapterId: string, filePath: string, entries: Awaited<ReturnType<FormatAdapter['parse']>>): NormalizedEntry[] {
  return entries.map((entry) => ({
    projectId: 'prj_1',
    platform: entry.platform,
    namespace: entry.namespace,
    key: entry.key,
    locale: entry.locale,
    value: entry.value,
    isSource: false,
    description: entry.description,
    context: entry.context,
    placeholders: entry.placeholders,
    platformMetadata: entry.platformMetadata,
    fileId: adapterId,
    filePath,
    contentHash: contentHash(entry.value),
  }));
}

describe('JSON adapter', () => {
  const adapter = new JsonAdapter();

  it('parses nested keys into dot paths', async () => {
    const entries = await adapter.parse(
      input('apps/web/src/locales/ja-JP/common.json', JSON.stringify({ checkout: { pay_now: '今すぐ支払う' } }, null, 2)),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe('checkout.pay_now');
    expect(entries[0].value).toBe('今すぐ支払う');
    expect(entries[0].placeholders).toEqual([]);
  });

  it('parses flat keys when keyMode is flat', async () => {
    const entries = await adapter.parse(
      input('flat.json', JSON.stringify({ 'checkout.pay_now': 'Pay now' }), { keyMode: 'flat' }),
    );
    expect(entries[0].key).toBe('checkout.pay_now');
  });

  it('extracts placeholders', async () => {
    const entries = await adapter.parse(input('p.json', JSON.stringify({ greeting: 'Hello {name}, you have %d items' })));
    expect(entries[0].placeholders?.map((p) => p.name).sort()).toEqual(['%d', 'name']);
  });

  it('patches a value in place and keeps formatting byte for byte', async () => {
    const original = ['{', '    "checkout": {', '        "pay_now": "Pay now",', '        "cart": "Cart"', '    },', '    "other": 42', '}', ''].join('\n');
    const patched = await adapter.applyPatch({
      originalContent: Buffer.from(original, 'utf8'),
      changes: [
        {
          key: 'checkout.pay_now',
          namespace: '',
          platform: 'web',
          locale: 'ja-JP',
          previousValue: 'Pay now',
          newValue: '今すぐ支払う',
        },
      ],
      preserveUnknownFields: true,
    });
    const text = patched.toString('utf8');
    expect(text).toContain('"pay_now": "今すぐ支払う"');
    expect(text).toContain('        "cart": "Cart"'); // 8-space indentation preserved
    expect(text).toContain('    "other": 42'); // unrelated numeric untouched
    expect(JSON.parse(text).checkout.pay_now).toBe('今すぐ支払う');
  });

  it('inserts a brand new key using the file indentation', async () => {
    const original = `{\n  "a": "A"\n}\n`;
    const patched = await adapter.applyPatch({
      originalContent: Buffer.from(original, 'utf8'),
      changes: [{ key: 'b.c', namespace: '', platform: 'web', locale: 'en-US', previousValue: null, newValue: 'C' }],
      preserveUnknownFields: true,
    });
    const parsed = JSON.parse(patched.toString('utf8'));
    expect(parsed).toEqual({ a: 'A', b: { c: 'C' } });
    expect(patched.toString('utf8')).toBe(`{\n  "a": "A",\n  "b": {\n    "c": "C"\n  }\n}\n`);
  });

  it('escapes quotes and newlines safely', async () => {
    const original = `{"k": "old"}`;
    const patched = await adapter.applyPatch({
      originalContent: Buffer.from(original, 'utf8'),
      changes: [{ key: 'k', namespace: '', platform: 'web', locale: 'en-US', previousValue: 'old', newValue: 'a "quoted"\nline' }],
      preserveUnknownFields: true,
    });
    expect(JSON.parse(patched.toString('utf8')).k).toBe('a "quoted"\nline');
  });

  it('round-trips: parse -> serialize -> parse', async () => {
    const original = `{\n  "checkout": {\n    "pay_now": "Pay now"\n  }\n}\n`;
    const entries = await adapter.parse(input('en-US/common.json', original));
    const normalized = asNormalized('web-en', 'apps/web/src/locales/en-US/common.json', entries);
    const [file] = await adapter.serialize(normalized);
    const reparsed = await adapter.parse(input('en-US/common.json', file.content));
    expect(reparsed.map((e) => [e.key, e.value])).toEqual(entries.map((e) => [e.key, e.value]));
  });

  it('reports a parse error with file and line information', async () => {
    await expect(adapter.parse(input('broken.json', '{\n  "a": \n}'))).rejects.toThrow(/Failed to parse JSON/);
  });
});

describe('YAML adapter', () => {
  const adapter = new YamlAdapter();

  it('parses and patches while preserving comments', async () => {
    const original = `# top comment\ncheckout:\n  # about pay now\n  pay_now: Pay now\n  cart: Cart\n`;
    const entries = await adapter.parse(input('ja.yaml', original));
    expect(entries.map((e) => e.key)).toEqual(['checkout.pay_now', 'checkout.cart']);
    const patched = await adapter.applyPatch({
      originalContent: Buffer.from(original, 'utf8'),
      changes: [
        { key: 'checkout.pay_now', namespace: '', platform: 'web', locale: 'ja', previousValue: 'Pay now', newValue: '今すぐ支払う' },
      ],
      preserveUnknownFields: true,
    });
    const text = patched.toString('utf8');
    expect(text).toContain('今すぐ支払う');
    expect(text).toContain('# top comment');
    expect(text).toContain('cart: Cart');
  });
});

describe('Apple .strings adapter', () => {
  const adapter = new AppleStringsAdapter();

  it('parses keys, values, comments and escapes', async () => {
    const original = [
      '/* Checkout button */',
      '"checkout.pay_now" = "Pay now";',
      '"greeting" = "Hello \\"world\\"";',
      '"multi" = "line1\\nline2";',
    ].join('\n');
    const entries = await adapter.parse(input('ja.lproj/Localizable.strings', original));
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ key: 'checkout.pay_now', value: 'Pay now', description: 'Checkout button' });
    expect(entries[1].value).toBe('Hello "world"');
    expect(entries[2].value).toBe('line1\nline2');
  });

  it('patches a value in place and preserves other lines and comments', async () => {
    const original = `/* keep me */\n"a" = "A";\n"b" = "B";\n`;
    const patched = await adapter.applyPatch({
      originalContent: Buffer.from(original, 'utf8'),
      changes: [{ key: 'a', namespace: '', platform: 'ios', locale: 'ja', previousValue: 'A', newValue: 'あ' }],
      preserveUnknownFields: true,
    });
    expect(patched.toString('utf8')).toBe(`/* keep me */\n"a" = "あ";\n"b" = "B";\n`);
  });

  it('appends new keys when they are missing', async () => {
    const patched = await adapter.applyPatch({
      originalContent: Buffer.from('"a" = "A";\n', 'utf8'),
      changes: [{ key: 'b', namespace: '', platform: 'ios', locale: 'ja', previousValue: null, newValue: 'B' }],
      preserveUnknownFields: true,
    });
    expect(patched.toString('utf8')).toBe('"a" = "A";\n"b" = "B";\n');
  });

  it('round-trips values containing quotes and newlines', async () => {
    const entries = await adapter.parse(input('ja.lproj/Localizable.strings', '"k" = "say \\"hi\\"\\nnow";\n'));
    const normalized = asNormalized('ios-ja', 'ios/ja.lproj/Localizable.strings', entries);
    const [file] = await adapter.serialize(normalized);
    const reparsed = await adapter.parse(input('ja.lproj/Localizable.strings', file.content));
    expect(reparsed[0].value).toBe(entries[0].value);
  });
});

describe('Android XML adapter', () => {
  const adapter = new AndroidXmlAdapter();

  it('parses string resources with attributes and comments', async () => {
    const original = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- Pay button -->
    <string name="checkout_pay_now">Pay now</string>
    <string name="app_name" translatable="false">Demo</string>
</resources>
`;
    const entries = await adapter.parse(input('android/app/src/main/res/values/strings.xml', original, { platform: 'android' }));
    expect(entries.map((e) => e.key)).toEqual(['checkout_pay_now', 'app_name']);
    expect(entries[0].description).toBe('Pay button');
    expect(entries[1].platformMetadata).toMatchObject({ translatable: false });
  });

  it('parses plurals into a canonical ICU value and patches a single branch', async () => {
    const original = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <plurals name="cart_items">
        <item quantity="one">%d item</item>
        <item quantity="other">%d items</item>
    </plurals>
</resources>
`;
    const [entry] = await adapter.parse(input('android/app/src/main/res/values/plurals.xml', original, { platform: 'android' }));
    const plural = parseIcuPlural(entry.value);
    expect(plural?.quantities).toEqual({ one: '%d item', other: '%d items' });

    const patched = await adapter.applyPatch({
      originalContent: Buffer.from(original, 'utf8'),
      changes: [
        {
          key: 'cart_items',
          namespace: '',
          platform: 'android',
          locale: 'ja',
          previousValue: entry.value,
          newValue: buildIcuPlural({ argName: 'count', quantities: { one: '%d 個', other: '%d 個' } }),
        },
      ],
      preserveUnknownFields: true,
    });
    const text = patched.toString('utf8');
    expect(text).toContain('<item quantity="one">%d 個</item>');
    expect(text).toContain('<item quantity="other">%d 個</item>');
    expect(text).not.toContain('%d items');
  });

  it('derives the locale from a values-* directory', () => {
    expect(localeFromAndroidPath('android/app/src/main/res/values-ja/strings.xml')).toBe('ja');
    expect(localeFromAndroidPath('android/app/src/main/res/values-zh-rCN/strings.xml')).toBe('zh-CN');
    expect(localeFromAndroidPath('android/app/src/main/res/values/strings.xml')).toBeNull();
  });

  it('round-trips strings including XML entities', async () => {
    const original = `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="amp">A &amp; B &lt;tag&gt;</string>\n</resources>\n`;
    const entries = await adapter.parse(input('res/values/strings.xml', original, { platform: 'android' }));
    expect(entries[0].value).toBe('A & B <tag>');
    const normalized = asNormalized('android-values', 'res/values/strings.xml', entries);
    const [file] = await adapter.serialize(normalized);
    const reparsed = await adapter.parse(input('res/values/strings.xml', file.content, { platform: 'android' }));
    expect(reparsed[0].value).toBe('A & B <tag>');
  });
});

describe('.xcstrings adapter', () => {
  const adapter = new XcstringsAdapter();
  const catalog = {
    sourceLanguage: 'en',
    version: '1.0',
    strings: {
      'checkout.pay_now': {
        comment: 'Pay button',
        localizations: {
          en: { stringUnit: { state: 'translated', value: 'Pay now' } },
          ja: { stringUnit: { state: 'translated', value: '今すぐ支払う' } },
        },
      },
      'cart.items': {
        localizations: {
          ja: {
            variations: {
              plural: {
                one: { stringUnit: { state: 'translated', value: '%d 個' } },
                other: { stringUnit: { state: 'translated', value: '%d 個' } },
              },
            },
          },
        },
      },
    },
  };

  it('reads the requested locale only', async () => {
    const entries = await adapter.parse(input('ios/Resources/Localizable.xcstrings', JSON.stringify(catalog, null, 2), { locale: 'ja', platform: 'ios' }));
    expect(entries.map((e) => e.key)).toEqual(['checkout.pay_now', 'cart.items']);
    expect(entries[0].value).toBe('今すぐ支払う');
    expect(parseIcuPlural(entries[1].value)?.quantities.other).toBe('%d 個');
  });

  it('patches a localization in place and preserves unrelated metadata', async () => {
    const source = JSON.stringify(catalog, null, 2);
    const patched = await adapter.applyPatch({
      originalContent: Buffer.from(source, 'utf8'),
      changes: [{ key: 'checkout.pay_now', namespace: '', platform: 'ios', locale: 'ja', previousValue: '今すぐ支払う', newValue: '今すぐお支払い' }],
      preserveUnknownFields: true,
    });
    const parsed = JSON.parse(patched.toString('utf8'));
    expect(parsed.strings['checkout.pay_now'].localizations.ja.stringUnit.value).toBe('今すぐお支払い');
    expect(parsed.strings['checkout.pay_now'].localizations.en.stringUnit.value).toBe('Pay now');
    expect(parsed.strings['checkout.pay_now'].comment).toBe('Pay button');
    expect(parsed.sourceLanguage).toBe('en');
  });
});

describe('.stringsdict adapter', () => {
  const adapter = new StringsdictAdapter();
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>cart.items</key>
    <dict>
      <key>NSStringLocalizedFormatKey</key>
      <string>%#@count@</string>
      <key>count</key>
      <dict>
        <key>NSStringFormatSpecTypeKey</key>
        <string>NSStringPluralRuleType</string>
        <key>NSStringFormatValueTypeKey</key>
        <string>d</string>
        <key>one</key>
        <string>%d item</string>
        <key>other</key>
        <string>%d items</string>
      </dict>
    </dict>
  </dict>
</plist>
`;

  it('parses plural rules into canonical ICU', async () => {
    const [entry] = await adapter.parse(input('ios/ja.lproj/Localizable.stringsdict', plist, { platform: 'ios' }));
    expect(entry.key).toBe('cart.items');
    const plural = parseIcuPlural(entry.value);
    expect(plural).toMatchObject({ argName: 'count', quantities: { one: '%d item', other: '%d items' } });
  });

  it('patches the quantity branches in place', async () => {
    const patched = await adapter.applyPatch({
      originalContent: Buffer.from(plist, 'utf8'),
      changes: [
        {
          key: 'cart.items',
          namespace: '',
          platform: 'ios',
          locale: 'ja',
          previousValue: '',
          newValue: buildIcuPlural({ argName: 'count', quantities: { one: '%d 個', other: '%d 個' } }),
        },
      ],
      preserveUnknownFields: true,
    });
    const text = patched.toString('utf8');
    expect(text).toContain('<string>%d 個</string>');
    expect(text).not.toContain('%d items');
    expect(text).toContain('NSStringPluralRuleType');
  });

  it('round-trips the quantity set', async () => {
    const entries = await adapter.parse(input('ios/ja.lproj/Localizable.stringsdict', plist, { platform: 'ios' }));
    const normalized = asNormalized('ios-plural', 'ios/ja.lproj/Localizable.stringsdict', entries);
    const [file] = await adapter.serialize(normalized);
    const reparsed = await adapter.parse(input('ios/ja.lproj/Localizable.stringsdict', file.content, { platform: 'ios' }));
    expect(reparsed[0].value).toBe(entries[0].value);
  });
});

describe('PO adapter', () => {
  const adapter = new PoAdapter();
  const po = `# Translator comment
#. Checkout button label
#: src/checkout.tsx:42
msgid "checkout.pay_now"
msgstr "今すぐ支払う"

msgid "cart.items"
msgid_plural "cart.itemss"
msgstr[0] "%d item"
msgstr[1] "%d items"
`;

  it('parses msgid, comments and plural forms', async () => {
    const entries = await adapter.parse(input('locale/ja.po', po));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ key: 'checkout.pay_now', value: '今すぐ支払う', description: 'Checkout button label' });
    expect(parseIcuPlural(entries[1].value)?.quantities).toEqual({ zero: '%d item', one: '%d items' });
  });

  it('patches a msgstr in place, preserving comments', async () => {
    const patched = await adapter.applyPatch({
      originalContent: Buffer.from(po, 'utf8'),
      changes: [{ key: 'checkout.pay_now', namespace: '', platform: 'web', locale: 'ja', previousValue: '今すぐ支払う', newValue: '今すぐお支払い' }],
      preserveUnknownFields: true,
    });
    const text = patched.toString('utf8');
    expect(text).toContain('msgstr "今すぐお支払い"');
    expect(text).toContain('#: src/checkout.tsx:42');
  });

  it('round-trips a msgctxt key', async () => {
    const source = `msgctxt "menu"\nmsgid "Open"\nmsgstr "開く"\n`;
    const entries = await adapter.parse(input('locale/ja.po', source));
    expect(entries[0].key).toBe('menu\u0004Open');
    const normalized = asNormalized('po-ja', 'locale/ja.po', entries);
    const [file] = await adapter.serialize(normalized);
    const reparsed = await adapter.parse(input('locale/ja.po', file.content));
    expect(reparsed[0].key).toBe('menu\u0004Open');
    expect(reparsed[0].value).toBe('開く');
  });
});

describe('XLIFF adapter', () => {
  const adapter = new XliffAdapter();
  const xliff = `<?xml version="1.0" encoding="UTF-8"?>
<xliff version="1.2">
  <file source-language="en" target-language="ja" datatype="plaintext" original="app">
    <body>
      <trans-unit id="checkout.pay_now">
        <source>Pay now</source>
        <target>今すぐ支払う</target>
        <note>Checkout button</note>
      </trans-unit>
      <trans-unit id="untouched">
        <source>Other</source>
        <target>その他</target>
      </trans-unit>
    </body>
  </file>
</xliff>
`;

  it('parses units with notes', async () => {
    const entries = await adapter.parse(input('app.xliff', xliff));
    expect(entries.map((e) => e.key)).toEqual(['checkout.pay_now', 'untouched']);
    expect(entries[0].description).toBe('Checkout button');
  });

  it('patches only the requested unit', async () => {
    const patched = await adapter.applyPatch({
      originalContent: Buffer.from(xliff, 'utf8'),
      changes: [{ key: 'checkout.pay_now', namespace: '', platform: 'universal', locale: 'ja', previousValue: '今すぐ支払う', newValue: '今すぐお支払い' }],
      preserveUnknownFields: true,
    });
    const text = patched.toString('utf8');
    expect(text).toContain('<target>今すぐお支払い</target>');
    expect(text).toContain('<target>その他</target>');
    expect(text).toContain('<note>Checkout button</note>');
  });
});

describe('adapter registry', () => {
  it('maps file extensions to formats', () => {
    expect(formatForExtension('a/b.json')).toBe('json');
    expect(formatForExtension('a/b.xcstrings')).toBe('xcstrings');
    expect(formatForExtension('a/b.stringsdict')).toBe('ios-stringsdict');
    expect(formatForExtension('a/b.strings')).toBe('ios-strings');
    expect(formatForExtension('a/b.xliff')).toBe('xliff');
    expect(formatForExtension('a/b.po')).toBe('po');
    expect(formatForExtension('a/b.yaml')).toBe('yaml');
    expect(formatForExtension('a/b.xml')).toBe('android-xml');
    expect(formatForExtension('a/b.unknown')).toBeNull();
  });

  it('throws a typed error for an unknown format', () => {
    expect(() => createAdapter('csv' as never)).toThrow(/No adapter registered/);
  });
});
