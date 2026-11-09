import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
  startedAt: number;
  ip?: string;
  path?: string;
  organizationId?: string;
  projectId?: string;
  syncSessionId?: string;
  mcpClientId?: string;
  actorId?: string;
  tool?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext | undefined {
  return requestContext.getStore();
}

export function contextRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

/** Attach extra identifiers once authentication resolved them. */
export function enrichContext(patch: Partial<RequestContext>): void {
  const store = requestContext.getStore();
  if (store) Object.assign(store, patch);
}
