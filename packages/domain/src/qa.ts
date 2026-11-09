import { comparePlaceholders, contentHash, type QaSeverity } from '@localehub/contracts';

export interface QaRuleDefinition {
  code: string;
  name: string;
  severity: QaSeverity;
  description: string;
  enabledByDefault: boolean;
}

/** Built-in rule set (spec §11.1 质量中心 / E5). Rules are data, not code paths. */
export const BUILTIN_QA_RULES: QaRuleDefinition[] = [
  { code: 'EMPTY_TRANSLATION', name: 'Empty translation', severity: 'ERROR', description: 'The target value is empty', enabledByDefault: true },
  { code: 'PLACEHOLDER_MISMATCH', name: 'Placeholder mismatch', severity: 'ERROR', description: 'Variables of the source are missing (or extra) in the translation', enabledByDefault: true },
  { code: 'MISSING_TRANSLATION', name: 'Missing translation', severity: 'WARNING', description: 'A key has no entry for this locale', enabledByDefault: true },
  { code: 'STALE_TRANSLATION', name: 'Stale translation', severity: 'WARNING', description: 'The source changed after this translation was written', enabledByDefault: true },
  { code: 'HTML_TAG_MISMATCH', name: 'Markup mismatch', severity: 'WARNING', description: 'Inline markup such as <b> differs from the source', enabledByDefault: true },
  { code: 'PUNCTUATION_MISMATCH', name: 'Punctuation mismatch', severity: 'INFO', description: 'Trailing punctuation differs from the source', enabledByDefault: true },
  { code: 'LEADING_TRAILING_WHITESPACE', name: 'Leading/trailing whitespace', severity: 'INFO', description: 'The value starts or ends with whitespace', enabledByDefault: true },
  { code: 'DOUBLE_SPACE', name: 'Double space', severity: 'INFO', description: 'The value contains consecutive spaces', enabledByDefault: false },
  { code: 'GLOSSARY_TERM_MISSING', name: 'Glossary term missing', severity: 'WARNING', description: 'A glossary term from the source is not used in the translation', enabledByDefault: true },
  { code: 'SOURCE_UNCHANGED_TARGET_SAME_AS_SOURCE', name: 'Untranslated copy', severity: 'WARNING', description: 'The target equals the source for a non-source locale', enabledByDefault: false },
];

export interface QaCandidateEntry {
  entryId: string;
  key: string;
  locale: string;
  platform: string;
  namespace: string;
  value: string;
  status: string;
  sourceValue: string;
  sourceLocale: string;
  glossaryTerms?: { term: string; translations: Record<string, string>; caseSensitive?: boolean }[];
}

export interface QaIssueFinding {
  entryId: string | null;
  key: string;
  locale: string;
  ruleCode: string;
  severity: QaSeverity;
  message: string;
  details: Record<string, unknown>;
}

export interface QaRunOptions {
  enabledRules?: string[];
  disabledRules?: string[];
}

/**
 * Pure rule engine: given entries it returns findings. Used by the API (on demand) and by the
 * BullMQ worker (scheduled runs), so results are identical in both paths.
 */
export function runQaRules(entries: QaCandidateEntry[], options: QaRunOptions = {}): QaIssueFinding[] {
  const enabled = new Set(
    BUILTIN_QA_RULES.filter((rule) => rule.enabledByDefault).map((rule) => rule.code),
  );
  for (const code of options.enabledRules ?? []) enabled.add(code);
  for (const code of options.disabledRules ?? []) enabled.delete(code);

  const findings: QaIssueFinding[] = [];
  for (const entry of entries) {
    if (entry.locale === entry.sourceLocale) continue;
    const source = entry.sourceValue ?? '';
    const target = entry.value ?? '';

    if (enabled.has('EMPTY_TRANSLATION') && target.trim() === '') {
      findings.push(finding(entry, 'EMPTY_TRANSLATION', 'ERROR', 'Translation is empty', {}));
      continue;
    }
    if (enabled.has('PLACEHOLDER_MISMATCH') && source) {
      const mismatch = comparePlaceholders(source, target);
      if (mismatch.missing.length || mismatch.added.length) {
        findings.push(
          finding(entry, 'PLACEHOLDER_MISMATCH', 'ERROR', 'Placeholders differ from the source', {
            missing: mismatch.missing,
            added: mismatch.added,
          }),
        );
      }
    }
    if (enabled.has('STALE_TRANSLATION') && entry.status === 'STALE') {
      findings.push(finding(entry, 'STALE_TRANSLATION', 'WARNING', 'Source changed after this translation was written', {}));
    }
    if (enabled.has('HTML_TAG_MISMATCH')) {
      const sourceTags = tagsOf(source);
      const targetTags = tagsOf(target);
      if (sourceTags.join(',') !== targetTags.join(',')) {
        findings.push(
          finding(entry, 'HTML_TAG_MISMATCH', 'WARNING', 'Inline markup differs from the source', {
            source: sourceTags,
            target: targetTags,
          }),
        );
      }
    }
    if (enabled.has('PUNCTUATION_MISMATCH') && source && target) {
      const sourceTail = trailingPunctuation(source);
      const targetTail = trailingPunctuation(target);
      if (sourceTail !== targetTail && (sourceTail === '' || targetTail === '')) {
        findings.push(
          finding(entry, 'PUNCTUATION_MISMATCH', 'INFO', 'Trailing punctuation differs from the source', {
            source: sourceTail,
            target: targetTail,
          }),
        );
      }
    }
    if (enabled.has('LEADING_TRAILING_WHITESPACE') && target !== target.trim()) {
      findings.push(finding(entry, 'LEADING_TRAILING_WHITESPACE', 'INFO', 'Value has leading or trailing whitespace', {}));
    }
    if (enabled.has('DOUBLE_SPACE') && / {2,}/.test(target)) {
      findings.push(finding(entry, 'DOUBLE_SPACE', 'INFO', 'Value contains consecutive spaces', {}));
    }
    if (enabled.has('SOURCE_UNCHANGED_TARGET_SAME_AS_SOURCE') && source && source === target) {
      findings.push(finding(entry, 'SOURCE_UNCHANGED_TARGET_SAME_AS_SOURCE', 'WARNING', 'Translation is identical to the source', {}));
    }
    if (enabled.has('GLOSSARY_TERM_MISSING') && entry.glossaryTerms?.length) {
      for (const term of entry.glossaryTerms) {
        const expected = term.translations?.[entry.locale];
        if (!expected) continue;
        const sourceHasTerm = term.caseSensitive
          ? source.includes(term.term)
          : source.toLowerCase().includes(term.term.toLowerCase());
        if (!sourceHasTerm) continue;
        const targetHasTerm = term.caseSensitive
          ? target.includes(expected)
          : target.toLowerCase().includes(expected.toLowerCase());
        if (!targetHasTerm) {
          findings.push(
            finding(entry, 'GLOSSARY_TERM_MISSING', 'WARNING', `Glossary term "${term.term}" should be "${expected}"`, {
              term: term.term,
              expected,
            }),
          );
        }
      }
    }
  }
  return findings;
}

function finding(
  entry: QaCandidateEntry,
  ruleCode: string,
  severity: QaSeverity,
  message: string,
  details: Record<string, unknown>,
): QaIssueFinding {
  return {
    entryId: entry.entryId,
    key: entry.key,
    locale: entry.locale,
    ruleCode,
    severity,
    message,
    details: { ...details, contentHash: contentHash(entry.value) },
  };
}

function tagsOf(value: string): string[] {
  return [...value.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g)].map((match) => match[0].replace(/\s+/g, '')).sort();
}

function trailingPunctuation(value: string): string {
  const match = /([.!?:;…。！？：；]+)\s*$/.exec(value.trimEnd());
  return match?.[1] ?? '';
}

export function severityRank(severity: QaSeverity): number {
  return severity === 'ERROR' ? 3 : severity === 'WARNING' ? 2 : 1;
}
