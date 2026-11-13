import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';

export async function initializeDatabase(database: Pool): Promise<void> {
  const schema = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8');
  await database.query(schema);
}
