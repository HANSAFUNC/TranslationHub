/**
 * Stable machine readable error codes.
 * Spec §8.4: error codes must be stable and documented.
 */
export const ErrorCode = {
  // auth / authorization
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  SCOPE_INSUFFICIENT: 'SCOPE_INSUFFICIENT',
  PROJECT_ACCESS_DENIED: 'PROJECT_ACCESS_DENIED',
  ORGANIZATION_ACCESS_DENIED: 'ORGANIZATION_ACCESS_DENIED',
  ROLE_INSUFFICIENT: 'ROLE_INSUFFICIENT',

  // validation
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
  PLACEHOLDER_MISMATCH: 'PLACEHOLDER_MISMATCH',
  DUPLICATE_KEY: 'DUPLICATE_KEY',
  INVALID_LOCALE: 'INVALID_LOCALE',

  // sync
  SYNC_PLAN_EXPIRED: 'SYNC_PLAN_EXPIRED',
  SYNC_PLAN_NOT_FOUND: 'SYNC_PLAN_NOT_FOUND',
  SYNC_PLAN_HASH_MISMATCH: 'SYNC_PLAN_HASH_MISMATCH',
  SYNC_CONFLICT: 'SYNC_CONFLICT',
  REVISION_MISMATCH: 'REVISION_MISMATCH',
  LOCAL_FILE_CHANGED_AFTER_PREVIEW: 'LOCAL_FILE_CHANGED_AFTER_PREVIEW',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  SYNC_SESSION_NOT_FOUND: 'SYNC_SESSION_NOT_FOUND',
  CONFLICT_ALREADY_RESOLVED: 'CONFLICT_ALREADY_RESOLVED',
  BASELINE_NOT_FOUND: 'BASELINE_NOT_FOUND',

  // local workspace (CLI)
  WORKSPACE_NOT_FOUND: 'WORKSPACE_NOT_FOUND',
  PATH_OUTSIDE_WORKSPACE: 'PATH_OUTSIDE_WORKSPACE',
  PATH_TRAVERSAL_REJECTED: 'PATH_TRAVERSAL_REJECTED',
  SYMLINK_ESCAPE_REJECTED: 'SYMLINK_ESCAPE_REJECTED',
  PATH_DENIED: 'PATH_DENIED',
  PATH_NOT_MAPPED: 'PATH_NOT_MAPPED',
  PATH_NOT_WRITABLE: 'PATH_NOT_WRITABLE',
  CONFIG_INVALID: 'CONFIG_INVALID',
  PARSE_ERROR: 'PARSE_ERROR',
  APPLY_REJECTED_STALE_PREVIEW: 'APPLY_REJECTED_STALE_PREVIEW',

  // review / workflow
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  TRANSLATION_NOT_APPROVED: 'TRANSLATION_NOT_APPROVED',
  STALE_TRANSLATION: 'STALE_TRANSLATION',

  // account state
  ACCOUNT_DEACTIVATED: 'ACCOUNT_DEACTIVATED',

  // generic
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  CSRF_VERIFICATION_FAILED: 'CSRF_VERIFICATION_FAILED',
  INSECURE_TRANSPORT: 'INSECURE_TRANSPORT',
  POLICY_VIOLATION: 'POLICY_VIOLATION',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
  requestId?: string;
}

/** Consistent API envelope (see docs/API.md). */
export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ApiFailure {
  success: false;
  error: ApiErrorBody;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export class LocaleHubError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = 'LocaleHubError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  toBody(requestId?: string): ApiErrorBody {
    return { code: this.code, message: this.message, details: this.details, requestId };
  }

  static from(error: unknown): LocaleHubError {
    if (error instanceof LocaleHubError) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new LocaleHubError(ErrorCode.INTERNAL_ERROR, message, 500);
  }
}
