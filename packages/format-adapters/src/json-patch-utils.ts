import { joinPath, type JsonScanResult } from './json-scan';
import { trimTrailingWhitespace } from './json-adapter';
import type { TextEdit } from './text-utils';

/**
 * Build a single insertion edit that appends members to an existing JSON object while
 * keeping the file's indentation. Used by adapters that need to add keys (JSON, xcstrings).
 */
export function buildObjectInsertion(
  text: string,
  scan: JsonScanResult,
  parentPath: (string | number)[],
  members: { key: string; valueSource: string }[],
): TextEdit | null {
  if (members.length === 0) return null;
  const parentKey = joinPath(parentPath);
  const inner = scan.objectInnerSpans.get(parentKey);
  if (!inner) return null;
  const depth = parentPath.length + 1;
  const memberIndent = inner.indent.repeat(depth);
  const parentIsEmpty = inner.start === inner.end;
  const body = members
    .map((member, index) => {
      const prefix = parentIsEmpty && index === 0 ? '' : ',';
      return `${prefix}\n${memberIndent}${JSON.stringify(member.key)}: ${member.valueSource}`;
    })
    .join('');
  const at = parentIsEmpty ? inner.end : trimTrailingWhitespace(text, inner.start, inner.end);
  return { start: at, end: at, text: body };
}

/** Build a replacement edit for an existing scalar value. */
export function buildValueReplacement(scan: JsonScanResult, path: (string | number)[], valueSource: string): TextEdit | null {
  const span = scan.spans.get(joinPath(path));
  if (!span) return null;
  return { start: span.start, end: span.end, text: valueSource };
}
