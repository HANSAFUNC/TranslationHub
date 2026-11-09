import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { ErrorCode, LocaleHubError, type McpScope } from '@localehub/contracts';

/** Password hashing (bcrypt, cost 10 — the API never stores plaintext). */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

export const MCP_TOKEN_PREFIX = 'lh_mcp_';
export const API_TOKEN_PREFIX = 'lh_api_';

export interface GeneratedToken {
  token: string;
  tokenHash: string;
  tokenPrefix: string;
}

/**
 * MCP / API token handling.
 *
 * Tokens are stored only as SHA-256 hashes; the plaintext is shown exactly once at
 * creation time. Tokens must never appear in YAML config, git, logs or stack traces
 * (spec §4.2), so the prefix is kept short and the value is only ever returned once.
 */
export function generateToken(kind: 'mcp' | 'api' = 'mcp'): GeneratedToken {
  const prefix = kind === 'mcp' ? MCP_TOKEN_PREFIX : API_TOKEN_PREFIX;
  const secret = randomBytes(32).toString('base64url');
  const token = `${prefix}${secret}`;
  return { token, tokenHash: hashToken(token), tokenPrefix: token.slice(0, 12) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function tokenPrefixOf(token: string): string {
  return token.slice(0, 12);
}

/** Constant-time comparison for hashed tokens. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function scopeAllows(scopes: string[], required: McpScope): boolean {
  return scopes.includes(required) || scopes.includes('admin');
}

export function assertTokenScopes(scopes: string[], required: McpScope[]): void {
  const missing = required.filter((scope) => !scopeAllows(scopes, scope));
  if (missing.length) {
    throw new LocaleHubError(ErrorCode.SCOPE_INSUFFICIENT, `Token is missing scopes: ${missing.join(', ')}`, 403, { missing });
  }
}

/**
 * Encrypt provider API keys at rest with a key derived from ENCRYPTION_KEY.
 * (AES-256-GCM; the nonce is stored with the ciphertext.)
 */
export function encryptSecret(plaintext: string, encryptionKey: string): string {
  const key = createHash('sha256').update(encryptionKey).digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${nonce.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSecret(payload: string, encryptionKey: string): string {
  const [version, nonceB64, tagB64, dataB64] = payload.split(':');
  if (version !== 'v1' || !nonceB64 || !tagB64 || !dataB64) {
    throw new LocaleHubError(ErrorCode.INTERNAL_ERROR, 'Unsupported encrypted payload format', 500);
  }
  const key = createHash('sha256').update(encryptionKey).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonceB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}
