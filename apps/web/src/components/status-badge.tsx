import { Badge } from '@/components/ui/badge';

/**
 * Maps LocaleHub domain states to a badge tone. Keeping the mapping in one place means the
 * translation editor, review queue, sync history and conflict pages always colour a state
 * identically.
 */
const TONE: Record<string, 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' | 'info' | 'muted'> = {
  // review status
  APPROVED: 'success',
  PENDING_REVIEW: 'warning',
  DRAFT: 'info',
  REJECTED: 'destructive',
  STALE: 'warning',
  // sync session / status
  SUCCEEDED: 'success',
  PARTIAL: 'warning',
  FAILED: 'destructive',
  RUNNING: 'info',
  PENDING: 'muted',
  CANCELLED: 'muted',
  // conflicts
  OPEN: 'destructive',
  RESOLVED: 'success',
  DEFERRED: 'warning',
  // repository
  ACTIVE: 'success',
  DISABLED: 'muted',
  // sync actions
  PUSH_NEW: 'info',
  PUSH_LOCAL: 'info',
  PULL_NEW: 'warning',
  PULL_REMOTE: 'warning',
  CONFLICT: 'destructive',
  CONVERGED: 'success',
  SKIP: 'muted',
  ARCHIVE_CANDIDATE: 'warning',
  REMOTE_ARCHIVE_CANDIDATE: 'warning',
  ARCHIVE_CONVERGED: 'muted',
  // qa severity
  ERROR: 'destructive',
  WARNING: 'warning',
  INFO: 'muted',
  // apply item status
  READY: 'success',
  NOT_APPROVED: 'warning',
  STALE_LOCAL_VALUE: 'destructive',
  MISSING_LOCAL_ENTRY: 'warning',
  NO_LOCAL_FILE: 'warning',
  UNCHANGED: 'muted',
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <Badge variant={TONE[status] ?? 'outline'} className={className}>
      {status}
    </Badge>
  );
}
