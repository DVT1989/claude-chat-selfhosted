import { Pool, PoolClient, QueryResult } from 'pg';
import { config } from './config';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function query<T extends Row = Row>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const client = await pool.connect();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await client.query<T>(text, params as any[]);
  } finally {
    client.release();
  }
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
