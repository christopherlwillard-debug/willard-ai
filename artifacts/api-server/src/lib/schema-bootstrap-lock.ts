export interface SchemaClient {
  query(sql: string): Promise<unknown>;
  release(): void;
}

export type Queryable = Pick<SchemaClient, "query">;

export interface SchemaPool {
  connect(): Promise<SchemaClient>;
}

const LOCK_SQL = "SELECT pg_advisory_lock(hashtext('willard-schema-bootstrap'))";
const UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtext('willard-schema-bootstrap'))";

export async function withSchemaBootstrapLock<T>(
  schemaPool: SchemaPool,
  work: (client: SchemaClient) => Promise<T>,
): Promise<T> {
  const client = await schemaPool.connect();
  try {
    await client.query(LOCK_SQL);
    return await work(client);
  } finally {
    try {
      await client.query(UNLOCK_SQL);
    } finally {
      client.release();
    }
  }
}