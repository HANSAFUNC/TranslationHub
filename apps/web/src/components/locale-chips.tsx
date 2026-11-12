'use client';

import { X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { localeDisplayName } from '@localehub/contracts/locale';

/**
 * The chosen languages, shown as chips.
 *
 * Worth its own line because the picker's trigger only shows a count: which languages a project
 * will end up with, and which one is the source, is the thing being decided here.
 */
export function LocaleChips({
  codes,
  source,
  onRemove,
  empty,
}: {
  codes: string[];
  source?: string;
  onRemove?: (code: string) => void;
  empty?: string;
}) {
  if (!codes.length) {
    return <p className="text-muted-foreground text-xs">{empty ?? '尚未选择语言'}</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {codes.map((code) => (
        <Badge key={code} variant={code === source ? 'default' : 'muted'} className="gap-1 pr-1 text-xs">
          <span className="font-mono">{code}</span>
          <span className="opacity-70">{localeDisplayName(code)}</span>
          {code === source ? <span className="opacity-80">源</span> : null}
          {onRemove && code !== source ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-4"
              aria-label={`移除 ${code}`}
              onClick={() => onRemove(code)}
            >
              <X className="size-3" />
            </Button>
          ) : null}
        </Badge>
      ))}
    </div>
  );
}
