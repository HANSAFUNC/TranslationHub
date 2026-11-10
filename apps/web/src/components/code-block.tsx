'use client';

import { useState } from 'react';
import { Check, Copy, Terminal } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';

/**
 * A labelled, scrollable snippet with a copy button.
 *
 * `navigator.clipboard` is unavailable outside a secure context and rejects when the document is
 * not focused, so the failure path says so explicitly instead of looking like nothing happened —
 * the text stays selectable either way. The button sits outside the `<pre>` so it does not scroll
 * away with wide content.
 */
export function CodeBlock({ code, what, language = 'json' }: { code: string; what: string; language?: 'json' | 'bash' }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
      toast.success(`${what}已复制`);
    } catch {
      toast.error('浏览器拒绝了剪贴板访问，请手动选中文本复制');
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground flex items-center gap-1.5 font-mono text-xs">
          <Terminal className="size-3.5" />
          {language === 'json' ? '.mcp.json' : 'shell'}
        </span>
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
          {copied ? '已复制' : '复制'}
        </Button>
      </div>
      <pre className="bg-muted max-w-full overflow-x-auto rounded-md p-3 font-mono text-xs">{code}</pre>
    </div>
  );
}
