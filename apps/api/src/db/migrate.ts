import { loadConfig } from '../config.js';
import { PgStore } from './pg-store.js';

const cfg = loadConfig();
if (!cfg.databaseUrl) {
  console.error('DATABASE_URL is not set; nothing to migrate');
  process.exit(1);
}
const store = new PgStore(cfg.databaseUrl);
await store.migrate();
await store.close();
console.log('migrations applied');
