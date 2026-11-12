'use client';

import { useId, useMemo, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { COMMON_LOCALES, localeLabel, searchCatalogLocales, type LocaleCatalogEntry } from '@localehub/contracts/locale-catalog';
import { cn } from '@/lib/utils';

/**
 * Pick a language instead of typing one.
 *
 * The forms used to take a free-text BCP 47 code, which is a memory test with a silent failure
 * mode: `zh-Hans` and `zh-CN` are one language to a person and two to the database, and a typo
 * either fails validation with a message about language tags or, worse, creates a locale nobody
 * meant to create. The picker offers the common languages, searches by code / native name /
 * English name, and still accepts a code typed in full for anything not in the list — the catalog
 * is a convenience, not a constraint.
 */
type SingleProps = {
  multiple?: false;
  value: string;
  onChange: (code: string) => void;
};

type MultipleProps = {
  multiple: true;
  value: string[];
  onChange: (codes: string[]) => void;
};

export function LocalePicker(
  props: (SingleProps | MultipleProps) & {
    placeholder?: string;
    disabled?: boolean;
    /** Codes that cannot be chosen (e.g. the source locale when picking a target). */
    exclude?: string[];
    id?: string;
  },
) {
  const { onChange, placeholder = '选择语言', disabled, exclude = [], id } = props;
  const multiple = props.multiple === true;
  const selected = multiple ? props.value : props.value ? [props.value] : [];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const listId = useId();

  const excluded = useMemo(() => new Set(exclude), [exclude]);
  const matches = useMemo(
    // In multiple mode an already-chosen language stays visible but reads as chosen, so the list
    // does not shuffle as items are added.
    () => searchCatalogLocales(query).filter((entry) => !excluded.has(entry.code)),
    [query, excluded],
  );
  const typed = query.trim();

  const choose = (code: string) => {
    setQuery('');
    if (multiple) {
      const next = selected.includes(code) ? selected.filter((item) => item !== code) : [...selected, code];
      (onChange as MultipleProps['onChange'])(next);
      return;
    }
    (onChange as SingleProps['onChange'])(code);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          {selected.length === 1 ? (
            <span className="flex items-center gap-2">
              <span className="font-mono text-xs">{selected[0]}</span>
              <span className="text-muted-foreground text-xs">{labelOf(selected[0]!)}</span>
            </span>
          ) : selected.length > 1 ? (
            <span className="flex items-center gap-1.5">
              <span className="text-xs">{selected.length} 种语言</span>
              <span className="text-muted-foreground truncate font-mono text-[11px]">{selected.join(', ')}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(22rem,calc(100vw-2rem))] p-0" align="start">
        <div className="border-b p-2">
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索代码、语言名或英文名"
            aria-label="搜索语言"
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              // Enter takes the first match, so the picker works without reaching for the mouse.
              const first = matches[0];
              if (first) choose(first.code);
            }}
          />
        </div>
        <ScrollArea className="h-72">
          <div id={listId} role="listbox" className="flex flex-col p-1">
            {matches.map((entry) => (
              <LocaleOption
                key={entry.code}
                entry={entry}
                selected={selected.includes(entry.code)}
                onSelect={() => choose(entry.code)}
              />
            ))}
            {!matches.length && typed && isLikelyLocaleTag(typed) ? (
              <button
                type="button"
                className="hover:bg-accent flex items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm"
                onClick={() => choose(typed)}
              >
                <span>
                  使用 <span className="font-mono text-xs">{typed}</span>
                </span>
                <Badge variant="outline" className="text-[10px]">
                  自定义
                </Badge>
              </button>
            ) : null}
            {!matches.length && !(typed && isLikelyLocaleTag(typed)) ? (
              <p className="text-muted-foreground p-3 text-xs">
                没有匹配的语言。列表之外的语言可以直接输入代码（例如 <span className="font-mono">haw-US</span>）。
              </p>
            ) : null}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

function LocaleOption({
  entry,
  selected,
  onSelect,
}: {
  entry: LocaleCatalogEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        'hover:bg-accent focus-visible:bg-accent flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none',
        selected && 'bg-accent/60',
      )}
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{localeLabel(entry)}</span>
        <span className="text-muted-foreground truncate text-xs">{entry.english}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <span className="text-muted-foreground font-mono text-xs">{entry.code}</span>
        {selected ? <Check className="size-4" /> : null}
      </span>
    </button>
  );
}

function labelOf(code: string): string {
  return COMMON_LOCALES.find((entry) => entry.code === code) ? localeLabel(COMMON_LOCALES.find((entry) => entry.code === code)!) : code;
}

/** Cheap shape check, so a stray "abc" does not become a locale but `haw-US` can. */
function isLikelyLocaleTag(value: string): boolean {
  return /^[a-z]{2,3}(-[A-Za-z]{4})?(-([A-Za-z]{2}|\d{3}))?$/.test(value.trim());
}