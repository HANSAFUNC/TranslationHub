import {
  ErrorCode,
  LocaleHubError,
  extractPlaceholders,
  type AdapterInput,
  type FormatAdapter,
  type NormalizedEntry,
  type RawEntry,
  type TranslationPatch,
} from '@localehub/contracts';
import { JsonScanner } from '../json-scan';
import { buildObjectInsertion, buildValueReplacement } from '../json-patch-utils';
import { buildIcuPlural, parseIcuPlural } from '../icu';
import { applyTextEdits, type TextEdit } from '../text-utils';

interface XcstringsCandidate {
  key: string;
  comment?: string;
  localizations: Record<string, unknown>;
}

interface XcstringsDocument {
  sourceLanguage?: string;
  version?: string;
  strings: Record<string, XcstringsCandidate>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Extract the translation value for a locale out of a `localizations[locale]` node. */
export function readXcstringsLocalization(node: unknown): { value: string; plural: boolean; raw: unknown } | null {
  if (!isRecord(node)) return null;
  const unit = node.stringUnit;
  if (isRecord(unit) && typeof unit.value === 'string') {
    return { value: unit.value, plural: false, raw: node };
  }
  const variations = node.variations;
  if (isRecord(variations)) {
    const plural = variations.plural;
    if (isRecord(plural)) {
      const quantities: Record<string, string> = {};
      for (const [quantity, branch] of Object.entries(plural)) {
        if (!isRecord(branch)) continue;
        const branchUnit = branch.stringUnit;
        if (isRecord(branchUnit) && typeof branchUnit.value === 'string') quantities[quantity] = branchUnit.value;
        else if (typeof branch === 'string') quantities[quantity] = branch;
      }
      if (Object.keys(quantities).length) {
        return { value: buildIcuPlural({ argName: 'count', quantities }), plural: true, raw: node };
      }
    }
    const device = variations.device;
    if (isRecord(device)) {
      const first = Object.values(device)[0];
      if (isRecord(first)) {
        const unit = first.stringUnit;
        if (isRecord(unit) && typeof unit.value === 'string') return { value: unit.value, plural: false, raw: node };
      }
    }
  }
  return null;
}

export class XcstringsAdapter implements FormatAdapter {
  readonly id = 'xcstrings';
  readonly extensions = ['.xcstrings'];

  async detect(filePath: string, content: Buffer): Promise<boolean> {
    if (!/\.xcstrings$/i.test(filePath)) return false;
    try {
      const doc = JSON.parse(content.toString('utf8'));
      return isRecord(doc) && isRecord(doc.strings);
    } catch {
      return false;
    }
  }

  async parse(input: AdapterInput): Promise<RawEntry[]> {
    const text = input.content.toString('utf8');
    let doc: XcstringsDocument;
    try {
      doc = JSON.parse(text) as XcstringsDocument;
    } catch (error) {
      throw new LocaleHubError(ErrorCode.PARSE_ERROR, `Failed to parse .xcstrings ${input.filePath}: ${(error as Error).message}`, 400);
    }
    if (!isRecord(doc.strings)) {
      throw new LocaleHubError(ErrorCode.PARSE_ERROR, `.xcstrings ${input.filePath} has no "strings" object`, 400);
    }
    const entries: RawEntry[] = [];
    for (const [key, candidate] of Object.entries(doc.strings)) {
      if (!isRecord(candidate)) continue;
      const localizations = isRecord(candidate.localizations) ? candidate.localizations : {};
      const localized = localizations[input.locale];
      const read = readXcstringsLocalization(localized);
      if (!read) continue; // locale not present in this catalog
      entries.push({
        key,
        value: read.value,
        locale: input.locale,
        namespace: input.namespace,
        platform: input.platform,
        description: typeof candidate.comment === 'string' ? candidate.comment : undefined,
        placeholders: extractPlaceholders(read.value),
        platformMetadata: {
          xcstrings: true,
          plural: read.plural,
          sourceLanguage: doc.sourceLanguage,
          version: doc.version,
          // keep the untouched structure so the platform never drops extra fields
          rawLocalization: read.raw,
        },
        filePath: input.filePath,
      });
    }
    return entries;
  }

  async validate(entries: NormalizedEntry[]) {
    const issues = [];
    for (const entry of entries) {
      if (entry.value.length === 0) {
        issues.push({
          code: 'EMPTY_VALUE',
          severity: 'WARNING' as const,
          message: 'Catalog value is empty for this locale',
          key: entry.key,
          locale: entry.locale,
          filePath: entry.filePath,
        });
      }
    }
    return issues;
  }

  async applyPatch(input: { originalContent: Buffer; changes: TranslationPatch[]; preserveUnknownFields: boolean }): Promise<Buffer> {
    const text = input.originalContent.toString('utf8');
    const scan = new JsonScanner(text).scan();
    const edits: TextEdit[] = [];
    const newKeys: { key: string; valueSource: string }[] = [];

    for (const change of input.changes) {
      const keyPath = ['strings', change.key];
      const localizationPath = [...keyPath, 'localizations', change.locale];
      const unitPath = [...localizationPath, 'stringUnit', 'value'];
      const plural = parseIcuPlural(change.newValue);
      const unitValuePath = plural ? [...localizationPath, 'variations', 'plural', 'other', 'stringUnit', 'value'] : unitPath;

      const replacement = buildValueReplacement(scan, unitValuePath, JSON.stringify(plural ? plural.quantities.other ?? change.newValue : change.newValue));
      if (replacement) {
        edits.push(replacement);
        if (plural) {
          for (const [quantity, value] of Object.entries(plural.quantities)) {
            if (quantity === 'other') continue;
            const branchPath = [...localizationPath, 'variations', 'plural', quantity, 'stringUnit', 'value'];
            const branchEdit = buildValueReplacement(scan, branchPath, JSON.stringify(value));
            if (branchEdit) edits.push(branchEdit);
          }
        }
        continue;
      }

      // key exists but this locale has no value yet -> add a stringUnit under localizations[locale]
      if (scan.spans.has(`strings\u0001${change.key}`)) {
        const localizationInsert = buildObjectInsertion(text, scan, localizationPath, [
          { key: 'stringUnit', valueSource: JSON.stringify({ state: 'translated', value: change.newValue }) },
        ]);
        if (localizationInsert) {
          // localizations[locale] may not exist yet
          if (scan.spans.has(`strings\u0001${change.key}\u0001localizations\u0001${change.locale}`)) {
            edits.push(localizationInsert);
          } else {
            const locInsert = buildObjectInsertion(text, scan, [...keyPath, 'localizations'], [
              { key: change.locale, valueSource: JSON.stringify({ stringUnit: { state: 'translated', value: change.newValue } }) },
            ]);
            if (locInsert) edits.push(locInsert);
          }
          continue;
        }
      }

      newKeys.push({
        key: change.key,
        valueSource: JSON.stringify({
          localizations: { [change.locale]: { stringUnit: { state: 'translated', value: change.newValue } } },
        }),
      });
    }

    const insertion = buildObjectInsertion(text, scan, ['strings'], newKeys);
    if (insertion) edits.push(insertion);
    return Buffer.from(applyTextEdits(text, edits), 'utf8');
  }

  async serialize(entries: NormalizedEntry[]) {
    const grouped = new Map<string, NormalizedEntry[]>();
    for (const entry of entries) {
      const list = grouped.get(entry.filePath) ?? [];
      list.push(entry);
      grouped.set(entry.filePath, list);
    }
    return [...grouped.entries()].map(([filePath, list]) => {
      const sourceLanguage = (list[0]?.platformMetadata?.sourceLanguage as string | undefined) ?? 'en';
      const strings: Record<string, unknown> = {};
      for (const entry of list) {
        const plural = parseIcuPlural(entry.value);
        strings[entry.key] = {
          ...(entry.description ? { comment: entry.description } : {}),
          localizations: {
            [entry.locale]: plural
              ? {
                  variations: {
                    plural: Object.fromEntries(
                      Object.entries(plural.quantities).map(([quantity, value]) => [
                        quantity,
                        { stringUnit: { state: 'translated', value } },
                      ]),
                    ),
                  },
                }
              : { stringUnit: { state: 'translated', value: entry.value } },
          },
        };
      }
      return {
        filePath,
        format: this.id,
        locale: list[0]?.locale ?? '',
        content: `${JSON.stringify({ sourceLanguage, version: '1.0', strings }, null, 2)}\n`,
      };
    });
  }
}
