import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const source = process.env.DB_PATH || fileURLToPath(new URL('./data/academy.sqlite', import.meta.url));
const target = resolve(process.argv[2] || `academy-backup-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`);
const db = new DatabaseSync(source, { readOnly:true });
try { db.prepare('VACUUM INTO ?').run(target); console.log(`Backup created: ${target}`); }
finally { db.close(); }
