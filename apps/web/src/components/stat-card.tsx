import type { ReactNode } from 'react';

import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export function StatCard({
  label,
  value,
  hint,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('gap-0 py-4', className)}>
      <CardContent className="px-4">
        <div className="text-muted-foreground text-xs font-medium uppercase tracking-wide">{label}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
        {hint ? <div className="text-muted-foreground mt-1 text-xs">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}
