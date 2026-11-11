import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildOpenApiDocument } from './document';

/**
 * Write the OpenAPI document to disk.
 *
 * `pnpm --filter @localehub/api openapi` regenerates `docs/openapi.json`, which is committed so
 * that a reader (and a client generator) can find it without running the API. The committed copy
 * is kept honest by a test that regenerates in memory and compares — a stale document fails CI
 * rather than quietly describing an older API.
 */
const target = resolve(process.argv[2] ?? resolve(__dirname, '../../../../docs/openapi.json'));
const document = buildOpenApiDocument({ serverUrl: process.env.API_BASE_URL ?? '/api/v1' });
writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
const operations = Object.values(document.paths).reduce((total, path) => total + Object.keys(path).length, 0);
console.log(`wrote ${target}: ${Object.keys(document.paths).length} paths, ${operations} operations`);
