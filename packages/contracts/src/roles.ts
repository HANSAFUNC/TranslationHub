/** Spec §2.1 roles. */
export const Role = {
  PLATFORM_ADMIN: 'PLATFORM_ADMIN',
  ORG_OWNER: 'ORG_OWNER',
  ORG_ADMIN: 'ORG_ADMIN',
  PROJECT_MANAGER: 'PROJECT_MANAGER',
  DEVELOPER: 'DEVELOPER',
  PRODUCT_MANAGER: 'PRODUCT_MANAGER',
  TRANSLATOR: 'TRANSLATOR',
  REVIEWER: 'REVIEWER',
  READONLY: 'READONLY',
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const ORG_ROLES: Role[] = [Role.ORG_OWNER, Role.ORG_ADMIN, Role.PROJECT_MANAGER, Role.DEVELOPER, Role.PRODUCT_MANAGER, Role.TRANSLATOR, Role.REVIEWER, Role.READONLY];
export const PROJECT_ROLES: Role[] = [Role.PROJECT_MANAGER, Role.DEVELOPER, Role.PRODUCT_MANAGER, Role.TRANSLATOR, Role.REVIEWER, Role.READONLY];

/** Spec §2.2 — MCP token scopes. Kept deliberately fine grained. */
export const McpScope = {
  PROJECT_READ: 'project.read',
  REPOSITORY_SCAN: 'repository.scan',
  SYNC_PREVIEW: 'sync.preview',
  SYNC_PUSH: 'sync.push',
  TRANSLATION_READ: 'translation.read',
  TRANSLATION_WRITE: 'translation.write',
  TRANSLATION_PULL: 'translation.pull',
  TRANSLATION_APPLY: 'translation.apply',
  TRANSLATION_REVIEW: 'translation.review',
  QA_EXECUTE: 'qa.execute',
  GLOSSARY_READ: 'glossary.read',
  RELEASE_PUBLISH: 'release.publish',
  ADMIN: 'admin',
} as const;
export type McpScope = (typeof McpScope)[keyof typeof McpScope];

export const ALL_MCP_SCOPES: McpScope[] = Object.values(McpScope);

/**
 * Default scope set for a freshly issued developer token: read + scan + preview + push,
 * but *not* translation.apply and never release.publish (spec §2.2 requires explicit
 * separation between pushing local changes and writing platform changes into a repo).
 */
export const DEFAULT_MCP_SCOPES: McpScope[] = [
  McpScope.PROJECT_READ,
  McpScope.REPOSITORY_SCAN,
  McpScope.SYNC_PREVIEW,
  McpScope.SYNC_PUSH,
  McpScope.TRANSLATION_READ,
  McpScope.TRANSLATION_PULL,
  McpScope.GLOSSARY_READ,
  McpScope.QA_EXECUTE,
];

export function isMcpScope(value: string): value is McpScope {
  return (ALL_MCP_SCOPES as string[]).includes(value);
}
