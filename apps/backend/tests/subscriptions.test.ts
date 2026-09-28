import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import pg from 'pg';
import {
  ListDistrictSubscriptionsResponse,
  GetDistrictSubscriptionResponse,
  UpdateDistrictSubscriptionResponse,
  UpdateDistrictSubscriptionRequest,
} from '@mahalla-ovozi/api-contracts';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { buildHttpServer } from '../src/entrypoints/http.js';
import {
  accounts,
  districts,
  auditEvents,
} from '../src/adapters/db/schema/index.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import { hashPassword } from '../src/adapters/crypto/argon2.js';
import { eq, desc } from 'drizzle-orm';
import crypto from 'node:crypto';

const SAME_ORIGIN_HEADERS = {
  origin: 'http://localhost:5173',
  host: 'localhost:3000',
};

describe('Story 6.1: Review and Maintain District Subscription Records Integration Tests', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let server: FastifyInstance;

  let poCookie = '';
  let poAccountId = '';
  let hokimCookie = '';
  let districtAId = '';
  let districtBId = '';

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);

    server = await buildHttpServer({ db, pool });
    await server.ready();

    // 1. Seed Product Owner
    const poUsername = `po_sub_test_${Date.now()}`;
    const poPassword = 'SecurePOPassword2026!';
    const poAccount = await createOrResetProductOwner(db, {
      username: poUsername,
      password: poPassword,
    });
    poAccountId = poAccount.accountId;

    const poSignIn = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { 'content-type': 'application/json', ...SAME_ORIGIN_HEADERS },
      payload: { username: poUsername, password: poPassword },
    });
    expect(poSignIn.statusCode).toBe(200);
    const poSetCookie = poSignIn.headers['set-cookie'];
    poCookie =
      (Array.isArray(poSetCookie) ? poSetCookie[0] : (poSetCookie as string)) ||
      '';

    // 2. Seed District A and District B
    districtAId = `dist_a_${crypto.randomUUID()}`;
    await db.insert(districts).values({
      id: districtAId,
      name: `DistrictA_${crypto.randomUUID().slice(0, 8)}`,
      region: 'Тошкент шаҳри',
      status: 'ACTIVE',
      activatedAt: new Date('2026-08-01T10:00:00.000Z'),
    });

    districtBId = `dist_b_${crypto.randomUUID()}`;
    await db.insert(districts).values({
      id: districtBId,
      name: `DistrictB_${crypto.randomUUID().slice(0, 8)}`,
      region: 'Самарқанд вилояти',
      status: 'SETUP_INCOMPLETE',
    });

    // 3. Seed Hokim for District A
    const hokimUsername = `hokim_sub_${Date.now()}`;
    const hokimPassword = 'HokimPassword2026!';
    const hokimPasswordHash = await hashPassword(hokimPassword);
    const hokimAccountId = `acc_hokim_${crypto.randomUUID()}`;

    await db.insert(accounts).values({
      id: hokimAccountId,
      username: hokimUsername,
      passwordHash: hokimPasswordHash,
      role: 'DISTRICT_HOKIM',
      status: 'ACTIVE',
      districtId: districtAId,
      mustChangePassword: false,
    });

    const hokimSignIn = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { 'content-type': 'application/json', ...SAME_ORIGIN_HEADERS },
      payload: { username: hokimUsername, password: hokimPassword },
    });
    expect(hokimSignIn.statusCode).toBe(200);
    const hokimSetCookie = hokimSignIn.headers['set-cookie'];
    hokimCookie =
      (Array.isArray(hokimSetCookie)
        ? hokimSetCookie[0]
        : (hokimSetCookie as string)) || '';
  });

  afterAll(async () => {
    if (server) await server.close();
    if (pool) await pool.end();
  });

  describe('1. Product Owner Authorization Enforcement (AC 9)', () => {
    it('rejects unauthenticated requests with HTTP 401', async () => {
      const resList = await server.inject({
        method: 'GET',
        url: '/api/v1/subscriptions',
        headers: { ...SAME_ORIGIN_HEADERS },
      });
      expect(resList.statusCode).toBe(401);

      const resGet = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${districtAId}/subscription`,
        headers: { ...SAME_ORIGIN_HEADERS },
      });
      expect(resGet.statusCode).toBe(401);

      const resPatch = await server.inject({
        method: 'PATCH',
        url: `/api/v1/districts/${districtAId}/subscription`,
        headers: { 'content-type': 'application/json', ...SAME_ORIGIN_HEADERS },
        payload: { externalPaymentReference: 'REF-100' },
      });
      expect(resPatch.statusCode).toBe(401);
    });

    it('rejects Hokim requests with HTTP 403 Forbidden', async () => {
      const resList = await server.inject({
        method: 'GET',
        url: '/api/v1/subscriptions',
        headers: { Cookie: hokimCookie, ...SAME_ORIGIN_HEADERS },
      });
      expect(resList.statusCode).toBe(403);

      const resGet = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${districtAId}/subscription`,
        headers: { Cookie: hokimCookie, ...SAME_ORIGIN_HEADERS },
      });
      expect(resGet.statusCode).toBe(403);

      const resPatch = await server.inject({
        method: 'PATCH',
        url: `/api/v1/districts/${districtAId}/subscription`,
        headers: {
          Cookie: hokimCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
        payload: { externalPaymentReference: 'REF-100' },
      });
      expect(resPatch.statusCode).toBe(403);
    });
  });

  describe('2. Aggregate Subscription Listing & Auto-Initialization (AC 1, AC 4)', () => {
    it('returns all permitted district subscriptions and initializes missing rows with preserved historical timestamps', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/subscriptions',
        headers: { Cookie: poCookie, ...SAME_ORIGIN_HEADERS },
      });

      expect(res.statusCode).toBe(200);
      const data: ListDistrictSubscriptionsResponse = res.json();
      expect(data.subscriptions).toBeDefined();
      expect(Array.isArray(data.subscriptions)).toBe(true);

      const subA = data.subscriptions.find((s) => s.districtId === districtAId);
      expect(subA).toBeDefined();
      expect(subA!.status).toBe('ACTIVE');
      expect(subA!.statusStartedAt).toBe(new Date('2026-08-01T10:00:00.000Z').toISOString());

      const subB = data.subscriptions.find((s) => s.districtId === districtBId);
      expect(subB).toBeDefined();
      expect(subB!.status).toBe('SETUP_INCOMPLETE');
    });
  });

  describe('3. Single District Subscription Retrieval & Explicit Scoping (AC 3, AC 9)', () => {
    it('returns single district subscription with explicit district scope', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${districtAId}/subscription`,
        headers: { Cookie: poCookie, ...SAME_ORIGIN_HEADERS },
      });

      expect(res.statusCode).toBe(200);
      const data: GetDistrictSubscriptionResponse = res.json();
      expect(data.subscription.districtId).toBe(districtAId);
      expect(data.subscription.status).toBe('ACTIVE');
    });

    it('returns 404 with DISTRICT_NOT_FOUND when non-existent districtId is requested', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/districts/dist_nonexistent_12345/subscription',
        headers: { Cookie: poCookie, ...SAME_ORIGIN_HEADERS },
      });

      expect(res.statusCode).toBe(404);
      const data = res.json();
      expect(data.error.code).toBe('DISTRICT_NOT_FOUND');
    });
  });

  describe('4. Metadata Persistence & Strict Lifecycle Immutability (AC 4, AC 8, FR29)', () => {
    it('successfully updates externalPaymentReference and internalNote while preserving lifecycle status and timestamps', async () => {
      // Fetch baseline
      const beforeRes = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${districtAId}/subscription`,
        headers: { Cookie: poCookie, ...SAME_ORIGIN_HEADERS },
      });
      const baseline = beforeRes.json().subscription;

      const payload: UpdateDistrictSubscriptionRequest = {
        externalPaymentReference: 'BANK-CONTRACT-9988',
        internalNote: 'Расмий шартнома асосида хизмат кўрсатилмоқда.',
      };

      const res = await server.inject({
        method: 'PATCH',
        url: `/api/v1/districts/${districtAId}/subscription`,
        headers: {
          Cookie: poCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
        payload,
      });

      expect(res.statusCode).toBe(200);
      const data: UpdateDistrictSubscriptionResponse = res.json();
      expect(data.subscription.externalPaymentReference).toBe('BANK-CONTRACT-9988');
      expect(data.subscription.internalNote).toBe('Расмий шартнома асосида хизмат кўрсатилмоқда.');
      expect(data.subscription.updatedById).toBe(poAccountId);

      // Strict lifecycle immutability verification (AC 4, AC 8)
      expect(data.subscription.status).toBe(baseline.status);
      expect(data.subscription.statusStartedAt).toBe(baseline.statusStartedAt);
      expect(data.subscription.scheduledTransitionAt).toBe(baseline.scheduledTransitionAt);
      expect(data.subscription.scheduledTransitionType).toBe(baseline.scheduledTransitionType);
    });

    it('handles partial updates preserving omitted fields and clearing with null/empty string', async () => {
      // Partial update 1: update only externalPaymentReference
      const res1 = await server.inject({
        method: 'PATCH',
        url: `/api/v1/districts/${districtAId}/subscription`,
        headers: {
          Cookie: poCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          externalPaymentReference: 'NEW-REF-5544',
        },
      });
      expect(res1.statusCode).toBe(200);
      expect(res1.json().subscription.externalPaymentReference).toBe('NEW-REF-5544');
      // internalNote preserved from previous test
      expect(res1.json().subscription.internalNote).toBe('Расмий шартнома асосида хизмат кўрсатилмоқда.');

      // Partial update 2: clear internalNote with empty string
      const res2 = await server.inject({
        method: 'PATCH',
        url: `/api/v1/districts/${districtAId}/subscription`,
        headers: {
          Cookie: poCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          internalNote: '',
        },
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.json().subscription.externalPaymentReference).toBe('NEW-REF-5544');
      expect(res2.json().subscription.internalNote).toBeUndefined();
    });
  });

  describe('5. Known Product Secret Detection & Sanitized Rejection (AC 5)', () => {
    it('rejects update containing a Telegram Bot Token', async () => {
      const res = await server.inject({
        method: 'PATCH',
        url: `/api/v1/districts/${districtAId}/subscription`,
        headers: {
          Cookie: poCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          externalPaymentReference: '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz123456789',
        },
      });

      expect(res.statusCode).toBe(400);
      const data = res.json();
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.message).toContain('Махфий маълумотлар');
    });

    it('rejects update containing an OpenAI API Key', async () => {
      const res = await server.inject({
        method: 'PATCH',
        url: `/api/v1/districts/${districtAId}/subscription`,
        headers: {
          Cookie: poCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          internalNote: 'sk-proj-test12345678901234567890abcdefghijklmnopqrstuvwxyz',
        },
      });

      expect(res.statusCode).toBe(400);
      const data = res.json();
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.message).toContain('Махфий маълумотлар');
    });

    it('rejects update containing Google API Key or Anthropic API Key', async () => {
      const res = await server.inject({
        method: 'PATCH',
        url: `/api/v1/districts/${districtAId}/subscription`,
        headers: {
          Cookie: poCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          internalNote: 'AIzaSyA1234567890abcdefghijklmnopqrstuv',
        },
      });

      expect(res.statusCode).toBe(400);
      const data = res.json();
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.message).toContain('Махфий маълумотлар');
    });
  });

  describe('6. Immutable Audit Event Recording (AC 4, AC 13)', () => {
    it('records DISTRICT_SUBSCRIPTION_METADATA_UPDATED event with privacy-safe metadata', async () => {
      await server.inject({
        method: 'PATCH',
        url: `/api/v1/districts/${districtAId}/subscription`,
        headers: {
          Cookie: poCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          externalPaymentReference: 'AUDIT-REF-001',
          internalNote: 'Audit log verification note',
        },
      });

      const events = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.districtId, districtAId))
        .orderBy(desc(auditEvents.createdAt))
        .limit(5);

      const updateEvent = events.find(
        (e) => e.action === 'DISTRICT_SUBSCRIPTION_METADATA_UPDATED',
      );
      expect(updateEvent).toBeDefined();
      expect(updateEvent!.actorId).toBe(poAccountId);
      expect(updateEvent!.actorRole).toBe('PRODUCT_OWNER');
      expect(updateEvent!.metadata).toMatchObject({
        districtId: districtAId,
        externalPaymentReferenceUpdated: true,
        internalNoteUpdated: true,
      });
    });
  });
});
