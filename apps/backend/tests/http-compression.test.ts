import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { createDbPool } from '../src/adapters/db/client.js';

describe('Batch 3: HTTP Compression & DB Pool Infrastructure Tests', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await buildHttpServer();
    // Add lightweight test endpoints to verify compression threshold
    server.get('/test/large-payload', async () => {
      return { data: 'x'.repeat(2048) };
    });
    server.get('/test/small-payload', async () => {
      return { ok: true };
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it('compresses payloads exceeding the 1KB threshold when Accept-Encoding is provided', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/test/large-payload',
      headers: {
        'accept-encoding': 'gzip',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBe('gzip');
  });

  it('does not compress payloads below the 1KB threshold', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/test/small-payload',
      headers: {
        'accept-encoding': 'gzip',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBeUndefined();
  });

  it('configures default 15-second statement_timeout on the PostgreSQL pool', () => {
    const pool = createDbPool('postgresql://test_user:test_pass@localhost:5433/mahalla_ovozi_test');
    expect((pool.options as any).statement_timeout).toBe(15000);
    void pool.end();
  });
});
