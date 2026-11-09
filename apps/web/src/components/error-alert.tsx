'use client';

import { AlertCircle, X } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/** Renders a LocaleHubError (code + message + details) without leaking stack traces. */
export function ErrorAlert({ error, onDismiss }: { error: unknown; onDismiss?: () => void }) {
  if (!error) return null;
  const err = error as { message?: string; code?: string; details?: unknown };
  const message = err.message ?? String(error);
  return (
    <Alert variant="destructive" className="mb-4">
      <AlertCircle />
      <AlertTitle className="flex items-center justify-between gap-2">
        <span>
          {err.code ? <span className="font-mono text-xs opacity-80">{err.code}: </span> : null}
          {message}
        </span>
        {onDismiss ? (
          <Button variant="ghost" size="icon" className="size-6 shrink-0" onClick={onDismiss} aria-label="关闭">
            <X />
          </Button>
        ) : null}
      </AlertTitle>
      {err.details ? (
        <AlertDescription>
          <pre className="bg-background/60 mt-2 max-h-40 overflow-auto rounded p-2 font-mono text-xs">
            {JSON.stringify(err.details, null, 2)}
          </pre>
        </AlertDescription>
      ) : null}
    </Alert>
  );
}
