'use client';

import { Check, ChevronsUpDown } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

const PLATFORMS: { value: string; label: string; hint: string }[] = [
  { value: 'web', label: 'Web', hint: '网页端文案' },
  { value: 'ios', label: 'iOS', hint: '.strings / .xcstrings / .stringsdict' },
  { value: 'android', label: 'Android', hint: 'strings.xml' },
  { value: 'universal', label: '通用', hint: '多端共用同一份文案' },
];

/**
 * Platforms are part of a key's identity — `(project, platform, namespace, key)` — so this is a
 * set, chosen rather than typed, and it is what a repository's file mappings have to agree with.
 */
export function PlatformPicker({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (platforms: string[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = PLATFORMS.filter((item) => value.includes(item.value));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" role="combobox" aria-expanded={open} disabled={disabled} className="w-full justify-between font-normal">
          {selected.length ? (
            <span className="flex flex-wrap items-center gap-1">
              {selected.map((item) => (
                <span key={item.value} className="bg-muted rounded px-1.5 py-0.5 text-xs">
                  {item.label}
                </span>
              ))}
            </span>
          ) : (
            <span className="text-muted-foreground">选择平台</span>
          )}
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(20rem,calc(100vw-2rem))] p-1" align="start">
        {PLATFORMS.map((item) => {
          const checked = value.includes(item.value);
          return (
            <button
              key={item.value}
              type="button"
              role="option"
              aria-selected={checked}
              onClick={() =>
                onChange(
                  checked
                    ? // Never empty: a project with no platform has nowhere to put a key.
                      value.length > 1
                      ? value.filter((platform) => platform !== item.value)
                      : value
                    : [...value, item.value],
                )
              }
              className={cn('hover:bg-accent flex w-full items-start justify-between gap-2 rounded-sm px-2 py-1.5 text-left', checked && 'bg-accent/60')}
            >
              <span className="flex flex-col">
                <span className="text-sm">{item.label}</span>
                <span className="text-muted-foreground text-xs">{item.hint}</span>
              </span>
              {checked ? <Check className="mt-0.5 size-4" /> : null}
            </button>
          );
        })}
        <p className="text-muted-foreground px-2 py-1.5 text-xs">至少保留一个。改动 Key 的归属，之后调整需要重新导入。</p>
      </PopoverContent>
    </Popover>
  );
}
