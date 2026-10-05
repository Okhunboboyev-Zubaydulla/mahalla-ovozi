import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import {
  serializeError,
  safeJsonStringify,
  MAX_CAUSE_DEPTH,
  logger,
  type SerializedError,
} from '../src/utils/logger.js';

describe('Log Redaction Allowlist (Decision 5.3)', () => {
  describe('serializeError - Core error preservation', () => {
    it('preserves name, message, and stack from standard Error', () => {
      const err = new Error('Database connection failed');
      const serialized = serializeError(err);

      expect(serialized.name).toBe('Error');
      expect(serialized.message).toBe('Database connection failed');
      expect(typeof serialized.stack).toBe('string');
      expect(serialized.stack).toContain('Database connection failed');
    });

    it('preserves custom Error subclass name', () => {
      class TelegramConnectionError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'TelegramConnectionError';
        }
      }

      const err = new TelegramConnectionError('MTProto socket timeout');
      const serialized = serializeError(err);

      expect(serialized.name).toBe('TelegramConnectionError');
      expect(serialized.message).toBe('MTProto socket timeout');
    });
  });

  describe('serializeError - Credential and unlisted property stripping', () => {
    it('strips all sensitive credentials and unlisted enumerable properties', () => {
      const err = new Error('Telegram authentication failed') as Error & Record<string, unknown>;
      err.sessionString = '1BVtsOKEBux...SENSITIVE_SESSION_KEY...';
      err.sessionEncrypted = 'v1:8f9a2b...';
      err.apiHash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
      err.password = 'super_secret_2fa_password';
      err.phoneCode = '12345';
      err.token = 'bot_token_xyz987';
      err.headers = { Authorization: 'Bearer sensitive-token-here' };
      err.request = { body: { password: 'secret' } };
      err.params = { apiId: 12345, apiHash: 'secret_hash' };
      err.config = { privateKey: '-----BEGIN PRIVATE KEY-----' };
      err.arbitrarySecret = 'leaked-data';

      const serialized = serializeError(err);

      // Core properties retained
      expect(serialized.name).toBe('Error');
      expect(serialized.message).toBe('Telegram authentication failed');

      // Unlisted properties completely absent
      const record = serialized as Record<string, unknown>;
      expect(record.sessionString).toBeUndefined();
      expect(record.sessionEncrypted).toBeUndefined();
      expect(record.apiHash).toBeUndefined();
      expect(record.password).toBeUndefined();
      expect(record.phoneCode).toBeUndefined();
      expect(record.token).toBeUndefined();
      expect(record.headers).toBeUndefined();
      expect(record.request).toBeUndefined();
      expect(record.params).toBeUndefined();
      expect(record.config).toBeUndefined();
      expect(record.arbitrarySecret).toBeUndefined();
    });

    it('strips unlisted properties on custom Error subclasses', () => {
      class TelegramApiError extends Error {
        sessionString = 'secret_session_string';
        apiHash = 'secret_api_hash';
        phoneNumber = '+998901234567';
        constructor(msg: string) {
          super(msg);
          this.name = 'TelegramApiError';
        }
      }

      const err = new TelegramApiError('SESSION_REVOKED');
      const serialized = serializeError(err);

      expect(serialized.name).toBe('TelegramApiError');
      expect(serialized.message).toBe('SESSION_REVOKED');

      const record = serialized as Record<string, unknown>;
      expect(record.sessionString).toBeUndefined();
      expect(record.apiHash).toBeUndefined();
      expect(record.phoneNumber).toBeUndefined();
    });
  });

  describe('serializeError - Diagnostic allowlist preservation', () => {
    it('preserves code, statusCode, status, and category when valid', () => {
      const err = new Error('Resource conflict') as Error & Record<string, unknown>;
      err.code = 'USERBOT_SESSION_CONFLICT';
      err.statusCode = 409;
      err.status = '409 Conflict';
      err.category = 'ACCOUNT_BANNED';

      const serialized = serializeError(err);

      expect(serialized.code).toBe('USERBOT_SESSION_CONFLICT');
      expect(serialized.statusCode).toBe(409);
      expect(serialized.status).toBe('409 Conflict');
      expect(serialized.category).toBe('ACCOUNT_BANNED');
    });

    it('preserves numeric error codes (e.g. Postgres sql codes or errno)', () => {
      const err = new Error('Connection refused') as Error & Record<string, unknown>;
      err.code = 111;
      err.statusCode = '503';
      err.status = 503;

      const serialized = serializeError(err);

      expect(serialized.code).toBe(111);
      expect(serialized.statusCode).toBe('503');
      expect(serialized.status).toBe(503);
    });

    it('ignores disallowed non-primitive types for diagnostic fields', () => {
      const err = new Error('Malformed properties') as Error & Record<string, unknown>;
      // If code or category is passed as an object containing secrets, it must be ignored
      err.code = { leak: 'sensitive_payload' };
      err.statusCode = { code: 500 };
      err.status = [400, 500];
      err.category = { category: 'UNKNOWN', internalSecret: 'exposed' };

      const serialized = serializeError(err);

      expect(serialized.code).toBeUndefined();
      expect(serialized.statusCode).toBeUndefined();
      expect(serialized.status).toBeUndefined();
      expect(serialized.category).toBeUndefined();
    });

    it('ignores NaN numeric codes', () => {
      const err = new Error('NaN status') as Error & Record<string, unknown>;
      err.code = NaN;
      err.statusCode = NaN;
      err.status = NaN;

      const serialized = serializeError(err);

      expect(serialized.code).toBeUndefined();
      expect(serialized.statusCode).toBeUndefined();
      expect(serialized.status).toBeUndefined();
    });
  });

  describe('serializeError - Recursive cause handling', () => {
    it('recursively serializes and redacts Error causes', () => {
      const rootCause = new Error('Network TCP socket closed') as Error & Record<string, unknown>;
      rootCause.sessionString = 'sensitive-cause-session';
      rootCause.code = 'ECONNRESET';

      const topError = new Error('Telegram RPC invocation failed', {
        cause: rootCause,
      }) as Error & Record<string, unknown>;
      topError.apiHash = 'sensitive-top-api-hash';
      topError.code = 'RPC_CALL_FAILED';

      const serialized = serializeError(topError);

      expect(serialized.name).toBe('Error');
      expect(serialized.message).toBe('Telegram RPC invocation failed');
      expect(serialized.code).toBe('RPC_CALL_FAILED');
      expect((serialized as Record<string, unknown>).apiHash).toBeUndefined();

      expect(typeof serialized.cause).toBe('object');
      const cause = serialized.cause as SerializedError;
      expect(cause.name).toBe('Error');
      expect(cause.message).toBe('Network TCP socket closed');
      expect(cause.code).toBe('ECONNRESET');
      expect((cause as Record<string, unknown>).sessionString).toBeUndefined();
    });

    it('recursively serializes multi-tier cause chains', () => {
      const dbError = new Error('Lock timeout') as Error & Record<string, unknown>;
      dbError.code = '55P03';
      dbError.dbPassword = 'exposed_pw';

      const serviceError = new Error('Failed to update district session', { cause: dbError });
      const apiError = new Error('Internal Server Error', { cause: serviceError });

      const serialized = serializeError(apiError);

      expect(serialized.message).toBe('Internal Server Error');
      const cause1 = serialized.cause as SerializedError;
      expect(cause1.message).toBe('Failed to update district session');
      const cause2 = cause1.cause as SerializedError;
      expect(cause2.message).toBe('Lock timeout');
      expect(cause2.code).toBe('55P03');
      expect((cause2 as Record<string, unknown>).dbPassword).toBeUndefined();
    });

    it('preserves string, number, and object causes cleanly', () => {
      const stringCauseErr = new Error('Outer error', { cause: 'socket dropped by peer' });
      const serializedStr = serializeError(stringCauseErr);
      expect(serializedStr.cause).toBe('socket dropped by peer');

      const numberCauseErr = new Error('Outer error', { cause: 504 });
      const serializedNum = serializeError(numberCauseErr);
      expect(serializedNum.cause).toBe('504');

      const objCauseErr = new Error('Outer error', {
        cause: { reason: 'handshake timeout', retryCount: 3 },
      });
      const serializedObj = serializeError(objCauseErr);
      expect(serializedObj.cause).toBe('{"reason":"handshake timeout","retryCount":3}');
    });
  });

  describe('serializeError - Non-Error thrown values', () => {
    it('serializes thrown string values', () => {
      const serialized = serializeError('Database connection pool exhausted');
      expect(serialized).toEqual({ value: 'Database connection pool exhausted' });
    });

    it('serializes thrown numbers and primitives', () => {
      expect(serializeError(404)).toEqual({ value: '404' });
      expect(serializeError(500.5)).toEqual({ value: '500.5' });
      expect(serializeError(true)).toEqual({ value: 'true' });
      expect(serializeError(false)).toEqual({ value: 'false' });
      expect(serializeError(null)).toEqual({ value: 'null' });
      expect(serializeError(undefined)).toEqual({ value: 'undefined' });
    });

    it('serializes thrown plain objects as readable JSON rather than [object Object]', () => {
      const plainObj = {
        code: 'TELEGRAM_FLOOD_WAIT',
        waitDurationSeconds: 42,
        reason: 'Too many requests',
      };

      const serialized = serializeError(plainObj);
      expect(serialized).toEqual({
        value: '{"code":"TELEGRAM_FLOOD_WAIT","waitDurationSeconds":42,"reason":"Too many requests"}',
      });
    });

    it('serializes thrown arrays as readable JSON', () => {
      const arr = ['error1', 'error2', 123];
      const serialized = serializeError(arr);
      expect(serialized).toEqual({ value: '["error1","error2",123]' });
    });
  });

  describe('serializeError - Cyclic graph protection', () => {
    it('handles self-referential error cycles (err.cause = err) without crashing or hanging', () => {
      const err = new Error('Self cyclic error');
      (err as unknown as { cause: unknown }).cause = err;

      const serialized = serializeError(err);

      expect(serialized.name).toBe('Error');
      expect(serialized.message).toBe('Self cyclic error');
      expect(serialized.cause).toBe('[Circular]');
    });

    it('handles mutual cycle between two errors (err1.cause = err2; err2.cause = err1)', () => {
      const err1 = new Error('First error');
      const err2 = new Error('Second error');
      (err1 as unknown as { cause: unknown }).cause = err2;
      (err2 as unknown as { cause: unknown }).cause = err1;

      const serialized = serializeError(err1);

      expect(serialized.name).toBe('Error');
      expect(serialized.message).toBe('First error');
      expect(typeof serialized.cause).toBe('object');

      const cause = serialized.cause as SerializedError;
      expect(cause.name).toBe('Error');
      expect(cause.message).toBe('Second error');
      expect(cause.cause).toBe('[Circular]');
    });

    it('handles 3-node cyclic chain (err1 -> err2 -> err3 -> err1)', () => {
      const err1 = new Error('Error 1');
      const err2 = new Error('Error 2');
      const err3 = new Error('Error 3');
      (err1 as unknown as { cause: unknown }).cause = err2;
      (err2 as unknown as { cause: unknown }).cause = err3;
      (err3 as unknown as { cause: unknown }).cause = err1;

      const serialized = serializeError(err1);

      const cause1 = serialized.cause as SerializedError;
      const cause2 = cause1.cause as SerializedError;
      expect(cause2.cause).toBe('[Circular]');
    });

    it('handles cyclic plain objects without throwing', () => {
      const cyclicObj: Record<string, unknown> = { key: 'value' };
      cyclicObj.self = cyclicObj;

      const serialized = serializeError(cyclicObj);
      expect(serialized.value).toContain('[Circular]');
    });
  });

  describe('serializeError - Max depth bounding', () => {
    it('allows cause chains up to MAX_CAUSE_DEPTH (8 levels)', () => {
      // Build a chain of 8 causes: top -> c1 -> c2 -> c3 -> c4 -> c5 -> c6 -> c7 -> c8
      let current = new Error('Root cause level 8');
      for (let i = 7; i >= 1; i--) {
        current = new Error(`Cause level ${i}`, { cause: current });
      }
      const top = new Error('Top level', { cause: current });

      const serialized = serializeError(top);

      let node: SerializedError | string | undefined = serialized;
      let depth = 0;
      while (typeof node === 'object' && node !== null && node.cause) {
        depth++;
        node = node.cause;
      }

      // Exactly 8 causes traversed, ending at root cause level 8
      expect(depth).toBe(8);
      expect(typeof node).toBe('object');
      expect((node as SerializedError).message).toBe('Root cause level 8');
    });

    it('truncates cause chains exceeding MAX_CAUSE_DEPTH to [MaxDepthExceeded]', () => {
      // Build a chain of 10 causes: top -> c1 -> ... -> c8 -> c9 -> c10
      let current = new Error('Root cause level 10');
      for (let i = 9; i >= 1; i--) {
        current = new Error(`Cause level ${i}`, { cause: current });
      }
      const top = new Error('Top level', { cause: current });

      const serialized = serializeError(top);

      let node: SerializedError | string | undefined = serialized;
      let depth = 0;
      while (typeof node === 'object' && node !== null && node.cause) {
        depth++;
        node = node.cause;
      }

      // At depth 9 (level 9 in cause chain), the cause was truncated
      expect(depth).toBe(9);
      expect(node).toBe('[MaxDepthExceeded]');
    });
  });

  describe('safeJsonStringify helper', () => {
    it('correctly stringifies primitives, objects, and arrays', () => {
      expect(safeJsonStringify({ a: 1, b: 'two' })).toBe('{"a":1,"b":"two"}');
      expect(safeJsonStringify([1, 2, 'three'])).toBe('[1,2,"three"]');
      expect(safeJsonStringify('simple string')).toBe('simple string');
      expect(safeJsonStringify(12345)).toBe('12345');
    });

    it('safely handles BigInt without throwing TypeError', () => {
      expect(safeJsonStringify({ big: BigInt(9007199254740991) })).toBe('{"big":"9007199254740991"}');
    });

    it('safely breaks cyclic references in objects', () => {
      const obj: Record<string, unknown> = { name: 'test' };
      obj.nested = { parent: obj };

      const result = safeJsonStringify(obj);
      expect(result).toBe('{"name":"test","nested":{"parent":"[Circular]"}}');
    });
  });

  describe('StructuredLogger stream integration', () => {
    let originalTestLogs: string | undefined;
    let stderrOutput: string[] = [];
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      originalTestLogs = process.env.TEST_LOGS;
      process.env.TEST_LOGS = 'true';
      stderrOutput = [];
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stderrOutput.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      });
    });

    afterEach(() => {
      process.env.TEST_LOGS = originalTestLogs;
      stderrSpy.mockRestore();
    });

    it('redacts unlisted credentials when calling logger.error({ err })', () => {
      const err = new Error('Connection failed') as Error & Record<string, unknown>;
      err.sessionString = 'LEAKED_SESSION_STRING';
      err.apiHash = 'LEAKED_API_HASH';
      err.code = 'ERR_CONN_TIMEOUT';
      err.category = 'CONNECT_FAILED';

      logger.error({ err }, 'Telegram transport connection failed');

      expect(stderrOutput.length).toBe(1);
      const parsed = JSON.parse(stderrOutput[0]);

      expect(parsed.level).toBe('error');
      expect(parsed.msg).toBe('Telegram transport connection failed');
      expect(parsed.err).toBeDefined();
      expect(parsed.err.name).toBe('Error');
      expect(parsed.err.message).toBe('Connection failed');
      expect(parsed.err.code).toBe('ERR_CONN_TIMEOUT');
      expect(parsed.err.category).toBe('CONNECT_FAILED');

      // Credentials strictly absent from log payload
      expect(parsed.err.sessionString).toBeUndefined();
      expect(parsed.err.apiHash).toBeUndefined();
      expect(stderrOutput[0]).not.toContain('LEAKED_SESSION_STRING');
      expect(stderrOutput[0]).not.toContain('LEAKED_API_HASH');
    });

    it('serializes non-Error thrown objects passed as err', () => {
      logger.error({ err: { reason: 'peer_flood', wait: 60 } }, 'Peer flood detected');

      expect(stderrOutput.length).toBe(1);
      const parsed = JSON.parse(stderrOutput[0]);

      expect(parsed.err).toEqual({
        value: '{"reason":"peer_flood","wait":60}',
      });
    });

    it('serializes string values passed as err', () => {
      logger.error({ err: 'Unexpected socket drop' }, 'Worker error');

      expect(stderrOutput.length).toBe(1);
      const parsed = JSON.parse(stderrOutput[0]);

      expect(parsed.err).toEqual({
        value: 'Unexpected socket drop',
      });
    });

    it('handles cyclic graphs logged via logger.error without throwing', () => {
      const cyclicErr = new Error('Cyclic logged error');
      (cyclicErr as unknown as { cause: unknown }).cause = cyclicErr;

      expect(() => {
        logger.error({ err: cyclicErr }, 'Logging cyclic error');
      }).not.toThrow();

      expect(stderrOutput.length).toBe(1);
      const parsed = JSON.parse(stderrOutput[0]);
      expect(parsed.err.cause).toBe('[Circular]');
    });
  });

  describe('Fastify logger serializer integration', () => {
    it('serializes err property through serializeError in Fastify logger', async () => {
      const logLines: string[] = [];
      const stream = {
        write: (msg: string) => {
          logLines.push(msg);
          return true;
        },
      };

      const server = Fastify({
        logger: {
          level: 'error',
          stream,
          serializers: {
            err: serializeError,
          },
        },
      });

      const err = new Error('Unhandled route error') as Error & Record<string, unknown>;
      err.sessionString = 'EXPOSED_FASTIFY_SESSION';
      err.apiHash = 'EXPOSED_API_HASH';
      err.code = 'ROUTE_FAILURE';

      server.log.error({ err }, 'Error during route processing');
      await server.close();

      expect(logLines.length).toBe(1);
      const parsed = JSON.parse(logLines[0]);
      expect(parsed.err).toBeDefined();
      expect(parsed.err.message).toBe('Unhandled route error');
      expect(parsed.err.code).toBe('ROUTE_FAILURE');
      expect(parsed.err.sessionString).toBeUndefined();
      expect(parsed.err.apiHash).toBeUndefined();
      expect(logLines[0]).not.toContain('EXPOSED_FASTIFY_SESSION');
    });
  });
});
