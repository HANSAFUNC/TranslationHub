/**
 * Integration test bootstrap: load the same environment files the services use, so the suite
 * talks to the configured database and API instead of hard-coded values.
 */
import { loadEnvFiles } from './packages/config/src';

loadEnvFiles(process.cwd());
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://localehub_app:localehub@127.0.0.1:55432/localehub?schema=public';
}
if (!process.env.LOCALEHUB_API_URL) {
  process.env.LOCALEHUB_API_URL = 'http://localhost:3001/api/v1';
}
