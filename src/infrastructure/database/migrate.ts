import { loadConfig } from '../../config';
import { Database } from './database';

/** Uso: bun run src/infrastructure/database/migrate.ts up|down */
const direction = process.argv[2] ?? 'up';
const db = await Database.connect({ url: loadConfig().databaseUrl, poolMax: 2 });
try {
  const migrator = db.orm.getMigrator();
  const applied = direction === 'down' ? await migrator.down() : await migrator.up();
  console.log(JSON.stringify({ msg: `migrations ${direction}`, migrations: applied.map((m) => m.name) }));
} finally {
  await db.close();
}
