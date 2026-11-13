import { Pool } from 'pg';
import { config } from '../config/env.ts';

export const pool = new Pool({ connectionString: config.databaseUrl });

pool.on('error', (error: Error) => {
  console.error('Unexpected PostgreSQL pool error:', error);
});
