import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { ApiErrorEnvelopeSchema } from '@mahalla-ovozi/api-contracts';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { serializeApiError, serializeNotFoundError } from '../src/modules/errors/api-error-envelope.js';

/** Domain error carrying an out-of-range statusCode — the defect probe. */
class RedirectShapedError extends Error {
  readonly statusCode = 301;
  readonly code = 'MOVED_PERMANENTLY';
  constructor() {
    super('Ресурс кўчирилган.');
  }
}

/** Domain error with a valid contract shape. */
class ContractShapedError extends Error {
  readonly statusCode = 409;
  readonly code = 'CONFLICT';
  constructor() {
    super('Зиддият аниқланди.');
  }
}

describe('ApiErrorEnvelope producer gate', () => {
  describe('serializeApiError', () => {
    it('produces an envelope that satisfies the shared contract', () => {
      const serialized = serializeApiError(new ContractShapedError());

      expect(serialized.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.safeParse(serialized.body).success).toBe(true);
      expect(serialized.body.error.code).toBe('CONFLICT');
    });

    it('normalises an out-of-range statusCode into the contract-legal range', () => {
      const serialized = serializeApiError(new RedirectShapedError());

      // 301 is not a valid error status; the envelope must stay schema-legal.
      expect(serialized.statusCode).toBeGreaterThanOrEqual(400);
      expect(ApiErrorEnvelopeSchema.safeParse(serialized.body).success).toBe(true);
    });

    it('never leaks a 5xx message to the client', () => {
      const internal = new Error('connection string postgres://secret@host/db failed');
      const serialized = serializeApiError(internal);

      expect(serialized.statusCode).toBe(500);
      expect(serialized.body.error.message).not.toContain('secret');
    });

    it('forwards blockers by container shape without inspecting their items', () => {
      const blocked = Object.assign(new Error('Туман тайёр эмас.'), {
        statusCode: 409,
        code: 'DISTRICT_NOT_READY',
        blockers: [{ key: 'BOT_ASSIGNED', label: 'Бот', description: 'd', status: 'FAILED' }],
      });

      const serialized = serializeApiError(blocked);

      expect(serialized.body.error.code).toBe('DISTRICT_NOT_READY');
      expect(serialized.body.error.blockers).toEqual([
        { key: 'BOT_ASSIGNED', label: 'Бот', description: 'd', status: 'FAILED' },
      ]);
    });

    it('drops non-object blocker entries rather than emitting an unparseable envelope', () => {
      const blocked = Object.assign(new Error('Туман тайёр эмас.'), {
        statusCode: 409,
        code: 'DISTRICT_NOT_READY',
        blockers: ['not-an-object', 42, null],
      });

      const serialized = serializeApiError(blocked);

      expect(ApiErrorEnvelopeSchema.safeParse(serialized.body).success).toBe(true);
      expect(serialized.body.error.blockers).toEqual([]);
    });

    it('serialises the not-found envelope', () => {
      const serialized = serializeNotFoundError();

      expect(serialized.statusCode).toBe(404);
      expect(serialized.body.error.code).toBe('NOT_FOUND');
      expect(ApiErrorEnvelopeSchema.safeParse(serialized.body).success).toBe(true);
    });
  });

  describe('HTTP seam — every error response is contract-valid', () => {
    let server: FastifyInstance;

    beforeAll(async () => {
      server = await buildHttpServer();
      server.get('/test/out-of-range-status', async () => {
        throw new RedirectShapedError();
      });
      server.get('/test/contract-shaped', async () => {
        throw new ContractShapedError();
      });
      await server.ready();
    });

    afterAll(async () => {
      await server.close();
    });

    it('an out-of-range thrown statusCode still yields a schema-valid envelope', async () => {
      const response = await server.inject({ method: 'GET', url: '/test/out-of-range-status' });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      const parsed = ApiErrorEnvelopeSchema.safeParse(response.json());
      expect(parsed.success).toBe(true);
    });

    it('a domain error keeps its code through the shared envelope', async () => {
      const response = await server.inject({ method: 'GET', url: '/test/contract-shaped' });

      expect(response.statusCode).toBe(409);
      const parsed = ApiErrorEnvelopeSchema.safeParse(response.json());
      expect(parsed.success).toBe(true);
      expect(response.json().error.code).toBe('CONFLICT');
    });

    it('the unmatched-route handler emits a schema-valid envelope', async () => {
      const response = await server.inject({ method: 'GET', url: '/test/definitely-not-a-route' });

      expect(response.statusCode).toBe(404);
      const parsed = ApiErrorEnvelopeSchema.safeParse(response.json());
      expect(parsed.success).toBe(true);
    });
  });
});
