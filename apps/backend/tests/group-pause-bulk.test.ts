import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import pg from 'pg';
import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import {
  TELEGRAM_GROUP_BULK_MAX_IDS,
} from '@mahalla-ovozi/api-contracts';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import {
  accounts,
  districts,
  districtTelegramBots,
  districtTelegramGroups,
  auditEvents,
} from '../src/adapters/db/schema/index.js';
import { hashPassword } from '../src/adapters/crypto/argon2.js';
import { encryptToken } from '../src/adapters/crypto/token-cipher.js';

const SAME_ORIGIN_HEADERS = { 'sec-fetch-site': 'same-origin' } as const;

let chatIdCounter = 0;
function nextChatId(): string {
  chatIdCounter += 1;
  return `-100${Date.now()}${chatIdCounter}`;
}

interface InsertGroupParams {
  districtId: string;
  mahallaName: string;
  isPaused: boolean;
  skippedCount: number;
}

describe('Ticket 03: Telegram Group Bulk Pause & Resume API', () => {
  let server: FastifyInstance;
  let pool: pg.Pool;
  let db: DbClient;
  let poCookie: string;
  let hokimCookie: string;
  let testDistrictId: string;
  let otherDistrictId: string;
  const testBotToken = '123456789:ABCdefGHIjklmnOPQRstuvWXYZ_12345678';

  async function insertGroup(params: InsertGroupParams): Promise<string> {
    const groupId = `dtg_${crypto.randomUUID()}`;
    await db.insert(districtTelegramGroups).values({
      id: groupId,
      districtId: params.districtId,
      mahallaName: params.mahallaName,
      telegramChatId: nextChatId(),
      telegramChatTitle: `${params.mahallaName} Guruhi`,
      status: 'VALID',
      isPaused: params.isPaused,
      isPausedSkippedCount: params.skippedCount,
    });
    return groupId;
  }

  async function readGroup(groupId: string) {
    const [row] = await db
      .select()
      .from(districtTelegramGroups)
      .where(eq(districtTelegramGroups.id, groupId));
    return row;
  }

  async function readAudit(action: string, districtId: string) {
    return db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, action), eq(auditEvents.districtId, districtId)));
  }

  function readAuditMetadata(row: { metadata: unknown }): Record<string, unknown> {
    return (row.metadata ?? {}) as Record<string, unknown>;
  }

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    server = await buildHttpServer({ db, pool });
    await server.ready();

    const testUsername = `po_pause_${Date.now()}`;
    const testPassword = 'Secure-PO-Pause-Pass-2026!';

    await createOrResetProductOwner(db, { username: testUsername, password: testPassword });

    const signInRes = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: SAME_ORIGIN_HEADERS,
      payload: { username: testUsername, password: testPassword },
    });
    expect(signInRes.statusCode).toBe(200);
    const setCookie = signInRes.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieHeader).toBeDefined();
    poCookie = cookieHeader ? cookieHeader.split(';')[0]! : '';

    const hokimDistrictId = `dist_hokim_scope_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(districts).values({
      id: hokimDistrictId,
      name: `Hokim Pause District ${crypto.randomUUID()}`,
      status: 'ACTIVE',
      accessEligible: true,
    });
    const hokimUsername = `hokim_pause_${Date.now()}`;
    const hokimPassword = 'Secure-Hokim-Pause-2026!';
    await db.insert(accounts).values({
      id: `acc_hokim_${crypto.randomUUID().slice(0, 8)}`,
      username: hokimUsername,
      passwordHash: await hashPassword(hokimPassword),
      role: 'DISTRICT_HOKIM',
      status: 'ACTIVE',
      districtId: hokimDistrictId,
      mustChangePassword: false,
    });

    const hokimSignInRes = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: SAME_ORIGIN_HEADERS,
      payload: { username: hokimUsername, password: hokimPassword },
    });
    expect(hokimSignInRes.statusCode).toBe(200);
    const hokimSetCookie = hokimSignInRes.headers['set-cookie'];
    const hokimCookieHeader = Array.isArray(hokimSetCookie) ? hokimSetCookie[0] : hokimSetCookie;
    hokimCookie = hokimCookieHeader ? hokimCookieHeader.split(';')[0]! : '';
  });

  afterAll(async () => {
    await server.close();
    await pool.end();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    testDistrictId = `dist_${crypto.randomUUID()}`;
    otherDistrictId = `dist_${crypto.randomUUID()}`;
    await db.insert(districts).values([
      {
        id: testDistrictId,
        name: `Pause District ${crypto.randomUUID().slice(0, 6)}`,
        status: 'ACTIVE',
        accessEligible: true,
      },
      {
        id: otherDistrictId,
        name: `Other District ${crypto.randomUUID().slice(0, 6)}`,
        status: 'ACTIVE',
        accessEligible: true,
      },
    ]);
  });

  // --- Single group ---

  it('pauses a single group and reports its resulting paused state', async () => {
    const groupId = await insertGroup({
      districtId: testDistrictId,
      mahallaName: 'Yakkama-yakka',
      isPaused: false,
      skippedCount: 0,
    });

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${testDistrictId}/groups/pause`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie, 'content-type': 'application/json' },
      payload: { groupIds: [groupId] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].id).toBe(groupId);
    expect(body.groups[0].isPaused).toBe(true);
    expect(body.groups[0].isPausedSkippedCount).toBe(0);
    // Pause is orthogonal to validation status.
    expect(body.groups[0].status).toBe('VALID');

    const row = await readGroup(groupId);
    expect(row!.isPaused).toBe(true);
    expect(row!.status).toBe('VALID');
  });

  it('resumes a single paused group and leaves the cumulative skipped counter untouched', async () => {
    const groupId = await insertGroup({
      districtId: testDistrictId,
      mahallaName: 'Qayta tiklash',
      isPaused: true,
      skippedCount: 7,
    });

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${testDistrictId}/groups/resume`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie, 'content-type': 'application/json' },
      payload: { groupIds: [groupId] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].id).toBe(groupId);
    expect(body.groups[0].isPaused).toBe(false);
    expect(body.groups[0].isPausedSkippedCount).toBe(7);

    const row = await readGroup(groupId);
    expect(row!.isPaused).toBe(false);
    // The skipped counter is a cumulative lifetime figure: resume never resets it.
    expect(row!.isPausedSkippedCount).toBe(7);
  });

  // --- Multi group ---

  it('pauses several groups in one request and reports each resulting state', async () => {
    const groupA = await insertGroup({
      districtId: testDistrictId,
      mahallaName: 'Ko‘plik A',
      isPaused: false,
      skippedCount: 0,
    });
    const groupB = await insertGroup({
      districtId: testDistrictId,
      mahallaName: 'Ko‘plik B',
      isPaused: false,
      skippedCount: 0,
    });

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${testDistrictId}/groups/pause`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie, 'content-type': 'application/json' },
      payload: { groupIds: [groupA, groupB] },
    });

    expect(res.statusCode).toBe(200);
    const returned = res.json().groups as Array<{ id: string; isPaused: boolean }>;
    expect(returned).toHaveLength(2);
    expect(returned.map((g) => g.id).sort()).toEqual([groupA, groupB].sort());
    expect(returned.every((g) => g.isPaused === true)).toBe(true);

    expect((await readGroup(groupA))!.isPaused).toBe(true);
    expect((await readGroup(groupB))!.isPaused).toBe(true);
  });

  it('resumes several groups in one request and reports each resulting state', async () => {
    const groupA = await insertGroup({
      districtId: testDistrictId,
      mahallaName: 'Tiklash A',
      isPaused: true,
      skippedCount: 3,
    });
    const groupB = await insertGroup({
      districtId: testDistrictId,
      mahallaName: 'Tiklash B',
      isPaused: true,
      skippedCount: 11,
    });

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${testDistrictId}/groups/resume`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie, 'content-type': 'application/json' },
      payload: { groupIds: [groupA, groupB] },
    });

    expect(res.statusCode).toBe(200);
    const returned = res.json().groups as Array<{
      id: string;
      isPaused: boolean;
      isPausedSkippedCount: number;
    }>;
    expect(returned).toHaveLength(2);
    expect(returned.every((g) => g.isPaused === false)).toBe(true);
    expect(returned.find((g) => g.id === groupA)!.isPausedSkippedCount).toBe(3);
    expect(returned.find((g) => g.id === groupB)!.isPausedSkippedCount).toBe(11);

    expect((await readGroup(groupA))!.isPaused).toBe(false);
    expect((await readGroup(groupB))!.isPaused).toBe(false);
    expect((await readGroup(groupA))!.isPausedSkippedCount).toBe(3);
  });

  // --- Tenant isolation ---

  it('refuses a cross-Tuman group identifier and applies nothing to the valid identifiers', async () => {
    const inDistrict = await insertGroup({
      districtId: testDistrictId,
      mahallaName: 'Bizning mahalla',
      isPaused: false,
      skippedCount: 0,
    });
    const foreignGroup = await insertGroup({
      districtId: otherDistrictId,
      mahallaName: 'Begona mahalla',
      isPaused: false,
      skippedCount: 0,
    });

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${testDistrictId}/groups/pause`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie, 'content-type': 'application/json' },
      payload: { groupIds: [inDistrict, foreignGroup] },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('TELEGRAM_GROUP_NOT_FOUND');

    // All-or-nothing: the in-District group must not have been paused either.
    expect((await readGroup(inDistrict))!.isPaused).toBe(false);
    expect((await readGroup(foreignGroup))!.isPaused).toBe(false);
  });

  it('rejects an unknown group identifier instead of silently ignoring it', async () => {
    const known = await insertGroup({
      districtId: testDistrictId,
      mahallaName: 'Ma’lum mahalla',
      isPaused: false,
      skippedCount: 0,
    });
    const unknownGroupId = `dtg_${crypto.randomUUID()}`;

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${testDistrictId}/groups/pause`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie, 'content-type': 'application/json' },
      payload: { groupIds: [known, unknownGroupId] },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('TELEGRAM_GROUP_NOT_FOUND');
    expect((await readGroup(known))!.isPaused).toBe(false);
  });

  // --- Malformed requests ---

  it('rejects an empty list as a malformed request rather than a no-op', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${testDistrictId}/groups/pause`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie, 'content-type': 'application/json' },
      payload: { groupIds: [] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a list beyond the permitted size', async () => {
    const oversized = Array.from(
      { length: TELEGRAM_GROUP_BULK_MAX_IDS + 1 },
      (_, index) => `dtg_${index}`,
    );

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${testDistrictId}/groups/pause`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie, 'content-type': 'application/json' },
      payload: { groupIds: oversized },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  // --- Idempotency ---

  it('is idempotent when pausing an already-paused group and preserves its skipped counter', async () => {
    const groupId = await insertGroup({
      districtId: testDistrictId,
      mahallaName: 'Allaqachon to‘xtatilgan',
      isPaused: true,
      skippedCount: 5,
    });

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${testDistrictId}/groups/pause`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie, 'content-type': 'application/json' },
      payload: { groupIds: [groupId] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().groups[0].isPaused).toBe(true);
    expect(res.json().groups[0].isPausedSkippedCount).toBe(5);

    const row = await readGroup(groupId);
    expect(row!.isPaused).toBe(true);
    expect(row!.isPausedSkippedCount).toBe(5);

    // A repeat that changed nothing must not overstate the trail as a transition.
    const pauseAudits = await readAudit('DISTRICT_GROUP_PAUSED', testDistrictId);
    expect(pauseAudits).toHaveLength(0);
  });

  it('is idempotent when resuming an already-active group and changes nothing', async () => {
    const groupId = await insertGroup({
      districtId: testDistrictId,
      mahallaName: 'Allaqachon faol',
      isPaused: false,
      skippedCount: 0,
    });

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${testDistrictId}/groups/resume`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie, 'content-type': 'application/json' },
      payload: { groupIds: [groupId] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().groups[0].isPaused).toBe(false);
    expect(res.json().groups[0].isPausedSkippedCount).toBe(0);

    expect((await readGroup(groupId))!.isPaused).toBe(false);

    // Consistent with the pause direction: no transition means no transition record.
    const resumeAudits = await readAudit('DISTRICT_GROUP_RESUMED', testDistrictId);
    expect(resumeAudits).toHaveLength(0);
  });

  // --- Audit trail ---

  it('writes one audit record per paused group naming the actor, role and group identifiers', async () => {
    const groupA = await insertGroup({
      districtId: testDistrictId,
      mahallaName: 'Audit A',
      isPaused: false,
      skippedCount: 0,
    });
    const groupB = await insertGroup({
      districtId: testDistrictId,
      mahallaName: 'Audit B',
      isPaused: false,
      skippedCount: 0,
    });

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${testDistrictId}/groups/pause`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie, 'content-type': 'application/json' },
      payload: { groupIds: [groupA, groupB] },
    });
    expect(res.statusCode).toBe(200);

    const audits = await readAudit('DISTRICT_GROUP_PAUSED', testDistrictId);
    expect(audits).toHaveLength(2);
    const auditedGroupIds = audits.map((row) => readAuditMetadata(row).groupId);
    expect(auditedGroupIds.sort()).toEqual([groupA, groupB].sort());

    for (const row of audits) {
      expect(row.actorId).toBeTruthy();
      expect(row.actorRole).toBe('PRODUCT_OWNER');
      const meta = readAuditMetadata(row);
      expect(meta.districtId).toBe(testDistrictId);
      expect(meta.previousIsPaused).toBe(false);
      expect(meta.newIsPaused).toBe(true);
    }
  });

  it('preserves the skipped message count of the ended episode in the resume audit record', async () => {
    const groupId = await insertGroup({
      districtId: testDistrictId,
      mahallaName: 'Audit tiklash',
      isPaused: true,
      skippedCount: 12,
    });

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${testDistrictId}/groups/resume`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie, 'content-type': 'application/json' },
      payload: { groupIds: [groupId] },
    });
    expect(res.statusCode).toBe(200);

    const audits = await readAudit('DISTRICT_GROUP_RESUMED', testDistrictId);
    expect(audits).toHaveLength(1);
    const meta = readAuditMetadata(audits[0]!);
    expect(meta.groupId).toBe(groupId);
    expect(meta.previousIsPaused).toBe(true);
    expect(meta.newIsPaused).toBe(false);
    expect(meta.skippedMessageCount).toBe(12);
    expect(audits[0]!.actorRole).toBe('PRODUCT_OWNER');
    expect(audits[0]!.actorId).toBeTruthy();
  });

  it('reports only the skipped count of the episode that just ended across two pause/resume cycles', async () => {
    const groupId = await insertGroup({
      districtId: testDistrictId,
      mahallaName: 'Ikki davr',
      isPaused: false,
      skippedCount: 0,
    });

    async function bumpSkippedCount(by: number) {
      const row = await readGroup(groupId);
      await db
        .update(districtTelegramGroups)
        .set({ isPausedSkippedCount: row!.isPausedSkippedCount + by })
        .where(eq(districtTelegramGroups.id, groupId));
    }

    async function transition(path: 'pause' | 'resume') {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/groups/${path}`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie, 'content-type': 'application/json' },
        payload: { groupIds: [groupId] },
      });
      expect(res.statusCode).toBe(200);
    }

    // --- Cycle 1: pause, drop 4 messages, resume ---
    await transition('pause');
    await bumpSkippedCount(4);
    await transition('resume');

    const cycleOneAudits = await readAudit('DISTRICT_GROUP_RESUMED', testDistrictId);
    expect(cycleOneAudits).toHaveLength(1);
    expect(readAuditMetadata(cycleOneAudits[0]!).skippedMessageCount).toBe(4);

    // The lifetime counter is cumulative and resume never resets it.
    expect((await readGroup(groupId))!.isPausedSkippedCount).toBe(4);

    // --- Cycle 2: pause, drop 3 messages, resume ---
    await transition('pause');
    await bumpSkippedCount(3);
    await transition('resume');

    const cycleTwoAudits = await readAudit('DISTRICT_GROUP_RESUMED', testDistrictId);
    expect(cycleTwoAudits).toHaveLength(2);

    const secondEpisode = cycleTwoAudits.find((row) => readAuditMetadata(row).skippedMessageCount === 3);
    expect(secondEpisode).toBeDefined();
    // The second resume audit reports its own episode (3), not the lifetime total (7).
    expect(cycleTwoAudits.map((row) => readAuditMetadata(row).skippedMessageCount).sort()).toEqual([
      3, 4,
    ]);

    expect((await readGroup(groupId))!.isPausedSkippedCount).toBe(7);
  });

  // --- Authorization & origin guard ---

  it('refuses a District Hokim for both pause and resume without changing any state', async () => {
    const groupId = await insertGroup({
      districtId: testDistrictId,
      mahallaName: 'Hokim rad etiladi',
      isPaused: false,
      skippedCount: 0,
    });

    const pauseRes = await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${testDistrictId}/groups/pause`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie, 'content-type': 'application/json' },
      payload: { groupIds: [groupId] },
    });
    expect(pauseRes.statusCode).toBe(403);
    expect(pauseRes.json().error.code).toBe('FORBIDDEN');

    const resumeRes = await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${testDistrictId}/groups/resume`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie, 'content-type': 'application/json' },
      payload: { groupIds: [groupId] },
    });
    expect(resumeRes.statusCode).toBe(403);
    expect(resumeRes.json().error.code).toBe('FORBIDDEN');

    expect((await readGroup(groupId))!.isPaused).toBe(false);
  });

  it('refuses an unauthenticated caller for both pause and resume', async () => {
    const groupId = await insertGroup({
      districtId: testDistrictId,
      mahallaName: 'Anonim rad etiladi',
      isPaused: false,
      skippedCount: 0,
    });

    const pauseRes = await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${testDistrictId}/groups/pause`,
      headers: { ...SAME_ORIGIN_HEADERS, 'content-type': 'application/json' },
      payload: { groupIds: [groupId] },
    });
    expect(pauseRes.statusCode).toBe(401);

    const resumeRes = await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${testDistrictId}/groups/resume`,
      headers: { ...SAME_ORIGIN_HEADERS, 'content-type': 'application/json' },
      payload: { groupIds: [groupId] },
    });
    expect(resumeRes.statusCode).toBe(401);

    expect((await readGroup(groupId))!.isPaused).toBe(false);
  });

  it('protects both bulk operations with the state-changing origin guard', async () => {
    const groupId = await insertGroup({
      districtId: testDistrictId,
      mahallaName: 'Origin qo‘riqlanadi',
      isPaused: false,
      skippedCount: 0,
    });

    const pauseRes = await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${testDistrictId}/groups/pause`,
      headers: { cookie: poCookie, 'content-type': 'application/json' },
      payload: { groupIds: [groupId] },
    });
    expect(pauseRes.statusCode).toBe(403);
    expect(pauseRes.json().error.code).toBe('FORBIDDEN_ORIGIN');

    const resumeRes = await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${testDistrictId}/groups/resume`,
      headers: { cookie: poCookie, 'content-type': 'application/json' },
      payload: { groupIds: [groupId] },
    });
    expect(resumeRes.statusCode).toBe(403);
    expect(resumeRes.json().error.code).toBe('FORBIDDEN_ORIGIN');

    expect((await readGroup(groupId))!.isPaused).toBe(false);
  });

  // --- Group contract ---

  it('returns paused state and skipped count for every group, including never-paused ones', async () => {
    const activeGroupId = await insertGroup({
      districtId: testDistrictId,
      mahallaName: 'Faol mahalla',
      isPaused: false,
      skippedCount: 0,
    });
    const pausedGroupId = await insertGroup({
      districtId: testDistrictId,
      mahallaName: 'To‘xtatilgan mahalla',
      isPaused: true,
      skippedCount: 4,
    });

    const listRes = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${testDistrictId}/groups`,
      headers: { cookie: poCookie },
    });
    expect(listRes.statusCode).toBe(200);
    const listed = listRes.json().groups as Array<{
      id: string;
      isPaused: boolean;
      isPausedSkippedCount: number;
    }>;
    expect(listed).toHaveLength(2);
    for (const group of listed) {
      expect(typeof group.isPaused).toBe('boolean');
      expect(typeof group.isPausedSkippedCount).toBe('number');
    }
    expect(listed.find((g) => g.id === activeGroupId)!.isPaused).toBe(false);
    expect(listed.find((g) => g.id === activeGroupId)!.isPausedSkippedCount).toBe(0);
    expect(listed.find((g) => g.id === pausedGroupId)!.isPaused).toBe(true);
    expect(listed.find((g) => g.id === pausedGroupId)!.isPausedSkippedCount).toBe(4);

    const detailRes = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${testDistrictId}/groups/${pausedGroupId}`,
      headers: { cookie: poCookie },
    });
    expect(detailRes.statusCode).toBe(200);
    expect(detailRes.json().group.isPaused).toBe(true);
    expect(detailRes.json().group.isPausedSkippedCount).toBe(4);
  });

  it('starts a newly mapped group active and ignores any pause field on the create path', async () => {
    const botId = `bot_${crypto.randomUUID().slice(0, 8)}`;
    const enc = encryptToken(testBotToken);
    await db.insert(districtTelegramBots).values({
      id: `dtb_${crypto.randomUUID()}`,
      districtId: testDistrictId,
      botId,
      botFirstName: 'Pause Contract Bot',
      botUsername: 'pause_contract_bot',
      encryptedToken: enc.encryptedToken,
      tokenIv: enc.tokenIv,
      tokenTag: enc.tokenTag,
      tokenKeyVersion: enc.tokenKeyVersion,
      tokenMasked: `${botId}:••••••••••••`,
      status: 'VALID',
      lastValidatedAt: new Date(),
    });

    const chatId = `-100${crypto.randomUUID().replace(/\D/g, '').slice(0, 10)}`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((...args: Parameters<typeof fetch>) => {
      const urlStr = String(args[0]);
      if (urlStr.includes('/getChatMember')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              result: { status: 'member', user: { id: botId, is_bot: true, first_name: 'Bot' } },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      if (urlStr.includes('/getChat')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              result: { id: Number(chatId) || -100123, title: 'Yangi Guruh', type: 'supergroup' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            result: { id: botId, is_bot: true, can_read_all_group_messages: true },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    });

    try {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/groups`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie, 'content-type': 'application/json' },
        payload: {
          mahallaName: 'Yangi mahalla',
          telegramChatId: chatId,
          isPaused: true,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.group.isPaused).toBe(false);
      expect(body.group.isPausedSkippedCount).toBe(0);

      const row = await readGroup(body.group.id as string);
      expect(row!.isPaused).toBe(false);
      expect(row!.isPausedSkippedCount).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
