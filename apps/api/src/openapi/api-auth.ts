import { SetMetadata } from '@nestjs/common';

/**
 * Documentation-only authorization note.
 *
 * Some routes are guarded in the service rather than by `@RequireRole`: member management calls
 * `assertCanManageMembers`, project creation calls `assertRole` by hand. The guard metadata is
 * therefore empty for them, and an empty `role` in the document reads as "any member" — the
 * opposite of the truth. This decorator records what the service enforces.
 *
 * It is deliberately *not* the enforcement mechanism, and it lives in its own module rather than
 * in `common/auth.ts` so the two cannot be confused: `@RequireRole` makes the guard act,
 * `@ApiAuth` only describes. A route carrying `@ApiAuth` without the service check behind it
 * would document a rule nothing applies.
 *
 * Separate file, not a separate concern: `document.ts` imports every controller, so a decorator
 * defined there would be imported *by* the controllers that import it — a cycle that leaves the
 * decorator undefined at class-definition time.
 */
export const API_AUTH = 'apiAuth';

export interface ApiAuthNote {
  role?: string;
  scopes?: string[];
  note?: string;
}

export const ApiAuth = (note: ApiAuthNote): MethodDecorator => SetMetadata(API_AUTH, note);
