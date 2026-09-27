import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { accounts, sessions, auditEvents, signInRateLimits, districts, districtTelegramBots, districtTelegramGroups, aiProfiles, aiOperations, aiProviderAttempts, topics, acceptedEvidence, telegramIntakeRecords, districtAnalysisSettingsVersions, districtAnalysisSettingsDrafts, districtTelegramUserbotSessions } from '../src/adapters/db/schema/index.js';
import { ensureDefaultAiProfiles, ensureDefaultDistrictAnalysisSettings } from '../src/adapters/db/seeds.js';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import crypto from 'node:crypto';

describe('Database Schema & Migration Verification', () => {
  let pool: pg.Pool;
  let db: DbClient;

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('can query accounts table', async () => {
    const rows = await db.select().from(accounts).limit(1);
    expect(Array.isArray(rows)).toBe(true);
  });

  it('can query sessions table with foreign key relationship', async () => {
    const rows = await db.select().from(sessions).limit(1);
    expect(Array.isArray(rows)).toBe(true);
  });

  it('can query audit_events table', async () => {
    const rows = await db.select().from(auditEvents).limit(1);
    expect(Array.isArray(rows)).toBe(true);
  });

  it('can query sign_in_rate_limits table', async () => {
    const rows = await db.select().from(signInRateLimits).limit(1);
    expect(Array.isArray(rows)).toBe(true);
  });

  it('can query districts table', async () => {
    const rows = await db.select().from(districts).limit(1);
    expect(Array.isArray(rows)).toBe(true);
  });

  it('can query district_telegram_bots table', async () => {
    const rows = await db.select().from(districtTelegramBots).limit(1);
    expect(Array.isArray(rows)).toBe(true);
  });

  it('can query district_telegram_userbot_sessions table', async () => {
    const rows = await db.select().from(districtTelegramUserbotSessions).limit(1);
    expect(Array.isArray(rows)).toBe(true);
  });

  it('enforces case-insensitive uniqueness on district name at DB level (P2-A)', async () => {
    const uniqueSuffix = crypto.randomUUID().slice(0, 8);
    const id1 = `dist_${crypto.randomUUID()}`;
    const id2 = `dist_${crypto.randomUUID()}`;
    const name = `SchemaTest_${uniqueSuffix}`;

    // Insert first district
    await db.insert(districts).values({
      id: id1,
      name: name,
      status: 'SETUP_INCOMPLETE',
    });

    // Attempt insert with different casing — must fail due to LOWER(name) unique index
    await expect(
      db.insert(districts).values({
        id: id2,
        name: name.toLowerCase(),
        status: 'SETUP_INCOMPLETE',
      })
    ).rejects.toThrow();

    // Clean up
    await db.delete(districts).where(eq(districts.id, id1));
  });

  it('enforces CHECK constraint on district status values at DB level (P2-B)', async () => {
    const id = `dist_${crypto.randomUUID()}`;
    await expect(
      db.insert(districts).values({
        id,
        name: `StatusCheck_${crypto.randomUUID().slice(0, 8)}`,
        status: 'INVALID_STATUS_VALUE',
      })
    ).rejects.toThrow();
  });

  it('cascades deletion of district_telegram_bots when district is deleted', async () => {
    const districtId = `dist_${crypto.randomUUID()}`;
    const botRowId = `dtb_${crypto.randomUUID()}`;
    const botId = `bot_${crypto.randomUUID().slice(0, 8)}`;

    await db.insert(districts).values({
      id: districtId,
      name: `CascadeTest_${crypto.randomUUID().slice(0, 8)}`,
      status: 'SETUP_INCOMPLETE',
    });

    await db.insert(districtTelegramBots).values({
      id: botRowId,
      districtId,
      botId,
      botFirstName: 'Test Bot',
      encryptedToken: 'abcdef123456',
      tokenIv: '123456789012345678901234',
      tokenTag: '12345678901234567890123456789012',
      tokenKeyVersion: 'v1',
      tokenMasked: `${botId}:••••••••••••`,
      status: 'VALID',
      lastValidatedAt: new Date(),
    });

    // Verify row exists
    const [botBefore] = await db
      .select()
      .from(districtTelegramBots)
      .where(eq(districtTelegramBots.id, botRowId));
    expect(botBefore).toBeDefined();

    // Delete parent district
    await db.delete(districts).where(eq(districts.id, districtId));

    // Verify child record was cascade-deleted
    const [botAfter] = await db
      .select()
      .from(districtTelegramBots)
      .where(eq(districtTelegramBots.id, botRowId));
    expect(botAfter).toBeUndefined();
  });

  it('enforces unique constraint on districtId (max 1 bot per district)', async () => {
    const districtId = `dist_${crypto.randomUUID()}`;
    const bot1RowId = `dtb_${crypto.randomUUID()}`;
    const bot2RowId = `dtb_${crypto.randomUUID()}`;

    await db.insert(districts).values({
      id: districtId,
      name: `UniqueDistrictBot_${crypto.randomUUID().slice(0, 8)}`,
      status: 'SETUP_INCOMPLETE',
    });

    await db.insert(districtTelegramBots).values({
      id: bot1RowId,
      districtId,
      botId: `bot_1_${crypto.randomUUID().slice(0, 8)}`,
      botFirstName: 'Bot 1',
      encryptedToken: 'encrypted1',
      tokenIv: 'iv1',
      tokenTag: 'tag1',
      tokenKeyVersion: 'v1',
      tokenMasked: '1:••••••••••••',
      status: 'VALID',
      lastValidatedAt: new Date(),
    });

    // Inserting a second bot for the same district must throw unique violation
    await expect(
      db.insert(districtTelegramBots).values({
        id: bot2RowId,
        districtId,
        botId: `bot_2_${crypto.randomUUID().slice(0, 8)}`,
        botFirstName: 'Bot 2',
        encryptedToken: 'encrypted2',
        tokenIv: 'iv2',
        tokenTag: 'tag2',
        tokenKeyVersion: 'v1',
        tokenMasked: '2:••••••••••••',
        status: 'VALID',
        lastValidatedAt: new Date(),
      })
    ).rejects.toThrow();

    // Clean up
    await db.delete(districts).where(eq(districts.id, districtId));
  });

  it('enforces cross-district uniqueness on botId at DB level (AC 5)', async () => {
    const district1Id = `dist_${crypto.randomUUID()}`;
    const district2Id = `dist_${crypto.randomUUID()}`;
    const sharedBotId = `shared_bot_${crypto.randomUUID().slice(0, 8)}`;

    await db.insert(districts).values([
      { id: district1Id, name: `District1_${crypto.randomUUID().slice(0, 8)}`, status: 'SETUP_INCOMPLETE' },
      { id: district2Id, name: `District2_${crypto.randomUUID().slice(0, 8)}`, status: 'SETUP_INCOMPLETE' },
    ]);

    await db.insert(districtTelegramBots).values({
      id: `dtb_${crypto.randomUUID()}`,
      districtId: district1Id,
      botId: sharedBotId,
      botFirstName: 'Shared Bot',
      encryptedToken: 'enc1',
      tokenIv: 'iv1',
      tokenTag: 'tag1',
      tokenKeyVersion: 'v1',
      tokenMasked: 'shared:••••••••••••',
      status: 'VALID',
      lastValidatedAt: new Date(),
    });

    // Attempting to attach the same botId to district 2 must fail with unique constraint violation
    await expect(
      db.insert(districtTelegramBots).values({
        id: `dtb_${crypto.randomUUID()}`,
        districtId: district2Id,
        botId: sharedBotId,
        botFirstName: 'Shared Bot',
        encryptedToken: 'enc2',
        tokenIv: 'iv2',
        tokenTag: 'tag2',
        tokenKeyVersion: 'v1',
        tokenMasked: 'shared:••••••••••••',
        status: 'VALID',
        lastValidatedAt: new Date(),
      })
    ).rejects.toThrow();

    // Clean up
    await db.delete(districts).where(eq(districts.id, district1Id));
    await db.delete(districts).where(eq(districts.id, district2Id));
  });

  it('enforces CHECK constraint on district_telegram_bots status values', async () => {
    const districtId = `dist_${crypto.randomUUID()}`;

    await db.insert(districts).values({
      id: districtId,
      name: `CheckStatusBot_${crypto.randomUUID().slice(0, 8)}`,
      status: 'SETUP_INCOMPLETE',
    });

    await expect(
      db.insert(districtTelegramBots).values({
        id: `dtb_${crypto.randomUUID()}`,
        districtId,
        botId: `bot_${crypto.randomUUID().slice(0, 8)}`,
        botFirstName: 'Invalid Status Bot',
        encryptedToken: 'enc',
        tokenIv: 'iv',
        tokenTag: 'tag',
        tokenKeyVersion: 'v1',
        tokenMasked: 'mask',
        status: 'UNAUTHORIZED_STATUS' as unknown as 'VALID',
        lastValidatedAt: new Date(),
      })
    ).rejects.toThrow();

    // Clean up
    await db.delete(districts).where(eq(districts.id, districtId));
  });

  it('can query district_telegram_groups table', async () => {
    const rows = await db.select().from(districtTelegramGroups).limit(1);
    expect(Array.isArray(rows)).toBe(true);
  });

  it('cascades deletion of district_telegram_groups when district is deleted', async () => {
    const districtId = `dist_${crypto.randomUUID()}`;
    const groupId = `dtg_${crypto.randomUUID()}`;
    const chatId = `-100${crypto.randomUUID().replace(/\D/g, '').slice(0, 10)}`;

    await db.insert(districts).values({
      id: districtId,
      name: `CascadeGroupDist_${crypto.randomUUID().slice(0, 8)}`,
      status: 'SETUP_INCOMPLETE',
    });

    await db.insert(districtTelegramGroups).values({
      id: groupId,
      districtId,
      mahallaName: 'Bogbonlar',
      telegramChatId: chatId,
      telegramChatTitle: 'Bogbonlar Mahalla Guruhi',
      status: 'PENDING',
    });

    const [groupBefore] = await db
      .select()
      .from(districtTelegramGroups)
      .where(eq(districtTelegramGroups.id, groupId));
    expect(groupBefore).toBeDefined();

    // Delete parent district
    await db.delete(districts).where(eq(districts.id, districtId));

    // Verify child group was cascade-deleted
    const [groupAfter] = await db
      .select()
      .from(districtTelegramGroups)
      .where(eq(districtTelegramGroups.id, groupId));
    expect(groupAfter).toBeUndefined();
  });

  it('enforces case-insensitive uniqueness on mahallaName within a district (AC 2)', async () => {
    const districtId = `dist_${crypto.randomUUID()}`;
    const group1Id = `dtg_${crypto.randomUUID()}`;
    const group2Id = `dtg_${crypto.randomUUID()}`;

    await db.insert(districts).values({
      id: districtId,
      name: `MahallaUniqDist_${crypto.randomUUID().slice(0, 8)}`,
      status: 'SETUP_INCOMPLETE',
    });

    await db.insert(districtTelegramGroups).values({
      id: group1Id,
      districtId,
      mahallaName: 'Navbahor',
      telegramChatId: `-100${crypto.randomUUID().replace(/\D/g, '').slice(0, 10)}`,
      telegramChatTitle: 'Navbahor Guruhi 1',
      status: 'PENDING',
    });

    // Attempt insert with different casing (NAVBAHOR / navbahor) for the same district must fail
    await expect(
      db.insert(districtTelegramGroups).values({
        id: group2Id,
        districtId,
        mahallaName: 'NAVBAHOR',
        telegramChatId: `-100${crypto.randomUUID().replace(/\D/g, '').slice(0, 10)}`,
        telegramChatTitle: 'Navbahor Guruhi 2',
        status: 'PENDING',
      })
    ).rejects.toThrow();

    // Clean up
    await db.delete(districts).where(eq(districts.id, districtId));
  });

  it('enforces global uniqueness on telegramChatId across districts (AC 3)', async () => {
    const district1Id = `dist_${crypto.randomUUID()}`;
    const district2Id = `dist_${crypto.randomUUID()}`;
    const sharedChatId = `-100${crypto.randomUUID().replace(/\D/g, '').slice(0, 10)}`;

    await db.insert(districts).values([
      { id: district1Id, name: `DistrictA_${crypto.randomUUID().slice(0, 8)}`, status: 'SETUP_INCOMPLETE' },
      { id: district2Id, name: `DistrictB_${crypto.randomUUID().slice(0, 8)}`, status: 'SETUP_INCOMPLETE' },
    ]);

    await db.insert(districtTelegramGroups).values({
      id: `dtg_${crypto.randomUUID()}`,
      districtId: district1Id,
      mahallaName: 'Mahalla A',
      telegramChatId: sharedChatId,
      telegramChatTitle: 'Shared Group',
      status: 'VALID',
    });

    // Attempting to attach the same telegramChatId to district 2 must fail
    await expect(
      db.insert(districtTelegramGroups).values({
        id: `dtg_${crypto.randomUUID()}`,
        districtId: district2Id,
        mahallaName: 'Mahalla B',
        telegramChatId: sharedChatId,
        telegramChatTitle: 'Shared Group',
        status: 'VALID',
      })
    ).rejects.toThrow();

    // Clean up
    await db.delete(districts).where(eq(districts.id, district1Id));
    await db.delete(districts).where(eq(districts.id, district2Id));
  });

  it('enforces CHECK constraint on district_telegram_groups status values', async () => {
    const districtId = `dist_${crypto.randomUUID()}`;

    await db.insert(districts).values({
      id: districtId,
      name: `CheckStatusGroup_${crypto.randomUUID().slice(0, 8)}`,
      status: 'SETUP_INCOMPLETE',
    });

    await expect(
      db.insert(districtTelegramGroups).values({
        id: `dtg_${crypto.randomUUID()}`,
        districtId,
        mahallaName: 'Chilonzor',
        telegramChatId: `-100${crypto.randomUUID().replace(/\D/g, '').slice(0, 10)}`,
        telegramChatTitle: 'Chilonzor Guruhi',
        status: 'INVALID_GROUP_STATUS',
      })
    ).rejects.toThrow();

    // Clean up
    await db.delete(districts).where(eq(districts.id, districtId));
  });

  describe('Story 1.6: Accounts Schema & Hokim Constraints', () => {
    it('enforces accounts role and status check constraints', async () => {
      const districtId = `dist_${crypto.randomUUID()}`;
      await db.insert(districts).values({
        id: districtId,
        name: `HokimDistrict_${crypto.randomUUID().slice(0, 8)}`,
        status: 'SETUP_INCOMPLETE',
      });

      // Invalid role
      await expect(
        db.insert(accounts).values({
          id: `acc_${crypto.randomUUID()}`,
          username: `user_${crypto.randomUUID().slice(0, 8)}`,
          passwordHash: 'dummyhash',
          role: 'SUPER_ADMIN',
          status: 'ACTIVE',
        })
      ).rejects.toThrow();

      // Invalid status
      await expect(
        db.insert(accounts).values({
          id: `acc_${crypto.randomUUID()}`,
          username: `user_${crypto.randomUUID().slice(0, 8)}`,
          passwordHash: 'dummyhash',
          role: 'PRODUCT_OWNER',
          status: 'PENDING',
        })
      ).rejects.toThrow();

      // Clean up
      await db.delete(districts).where(eq(districts.id, districtId));
    });

    it('enforces accounts role-district relationship check constraint', async () => {
      const districtId = `dist_${crypto.randomUUID()}`;
      await db.insert(districts).values({
        id: districtId,
        name: `HokimRelDistrict_${crypto.randomUUID().slice(0, 8)}`,
        status: 'SETUP_INCOMPLETE',
      });

      // PRODUCT_OWNER with districtId must fail
      await expect(
        db.insert(accounts).values({
          id: `acc_${crypto.randomUUID()}`,
          username: `po_with_district_${crypto.randomUUID().slice(0, 8)}`,
          passwordHash: 'dummyhash',
          role: 'PRODUCT_OWNER',
          status: 'ACTIVE',
          districtId,
        })
      ).rejects.toThrow();

      // DISTRICT_HOKIM without districtId must fail
      await expect(
        db.insert(accounts).values({
          id: `acc_${crypto.randomUUID()}`,
          username: `hokim_no_district_${crypto.randomUUID().slice(0, 8)}`,
          passwordHash: 'dummyhash',
          role: 'DISTRICT_HOKIM',
          status: 'ACTIVE',
          districtId: null,
        })
      ).rejects.toThrow();

      // Clean up
      await db.delete(districts).where(eq(districts.id, districtId));
    });

    it('enforces strict single active Hokim per district partial unique index (AC 12)', async () => {
      const districtId = `dist_${crypto.randomUUID()}`;
      await db.insert(districts).values({
        id: districtId,
        name: `HokimUniqueDistrict_${crypto.randomUUID().slice(0, 8)}`,
        status: 'SETUP_INCOMPLETE',
      });

      const acc1Id = `acc_${crypto.randomUUID()}`;
      const acc2Id = `acc_${crypto.randomUUID()}`;
      const acc3Id = `acc_${crypto.randomUUID()}`;

      // 1. First active Hokim creates successfully
      await db.insert(accounts).values({
        id: acc1Id,
        username: `hokim1_${crypto.randomUUID().slice(0, 8)}`,
        passwordHash: 'dummyhash',
        role: 'DISTRICT_HOKIM',
        status: 'ACTIVE',
        districtId,
      });

      // 2. Second concurrent active Hokim for same district MUST fail unique constraint
      await expect(
        db.insert(accounts).values({
          id: acc2Id,
          username: `hokim2_${crypto.randomUUID().slice(0, 8)}`,
          passwordHash: 'dummyhash',
          role: 'DISTRICT_HOKIM',
          status: 'ACTIVE',
          districtId,
        })
      ).rejects.toThrow();

      // 3. Disabling first Hokim allows creating a new active Hokim
      await db.update(accounts).set({ status: 'DISABLED' }).where(eq(accounts.id, acc1Id));

      await db.insert(accounts).values({
        id: acc3Id,
        username: `hokim3_${crypto.randomUUID().slice(0, 8)}`,
        passwordHash: 'dummyhash',
        role: 'DISTRICT_HOKIM',
        status: 'ACTIVE',
        districtId,
      });

      // Both disabled and active Hokim coexist for the district
      const districtAccounts = await db.select().from(accounts).where(eq(accounts.districtId, districtId));
      expect(districtAccounts).toHaveLength(2);

      // Clean up
      await db.delete(accounts).where(eq(accounts.districtId, districtId));
      await db.delete(districts).where(eq(districts.id, districtId));
    });
  });

  describe('Story 1.7: Activation Metadata & Password Change Flag', () => {
    it('defaults mustChangePassword to false on accounts', async () => {
      const accId = `acc_${crypto.randomUUID()}`;
      await db.insert(accounts).values({
        id: accId,
        username: `po_test_${crypto.randomUUID().slice(0, 8)}`,
        passwordHash: 'dummyhash',
        role: 'PRODUCT_OWNER',
        status: 'ACTIVE',
      });

      const [row] = await db.select().from(accounts).where(eq(accounts.id, accId));
      expect(row).toBeDefined();
      expect(row!.mustChangePassword).toBe(false);

      await db.delete(accounts).where(eq(accounts.id, accId));
    });

    it('persists activatedAt and activatedById on districts and sets activatedById to null on account deletion', async () => {
      const poId = `acc_${crypto.randomUUID()}`;
      const districtId = `dist_${crypto.randomUUID()}`;
      const now = new Date();

      await db.insert(accounts).values({
        id: poId,
        username: `po_activator_${crypto.randomUUID().slice(0, 8)}`,
        passwordHash: 'dummyhash',
        role: 'PRODUCT_OWNER',
        status: 'ACTIVE',
      });

      await db.insert(districts).values({
        id: districtId,
        name: `ActivationTestDist_${crypto.randomUUID().slice(0, 8)}`,
        status: 'ACTIVE',
        activatedAt: now,
        activatedById: poId,
      });

      const [distBefore] = await db.select().from(districts).where(eq(districts.id, districtId));
      expect(distBefore).toBeDefined();
      expect(distBefore!.activatedAt).toBeInstanceOf(Date);
      expect(distBefore!.activatedById).toBe(poId);

      // Deleting the PO account should set activatedById to null (onDelete: 'set null')
      await db.delete(accounts).where(eq(accounts.id, poId));

      const [distAfter] = await db.select().from(districts).where(eq(districts.id, districtId));
      expect(distAfter).toBeDefined();
      expect(distAfter!.activatedById).toBeNull();

      // Clean up
      await db.delete(districts).where(eq(districts.id, districtId));
    });
  });

  describe('Story 2.3: AI Profiles, AI Operations & Provider Attempts Traceability Schemas', () => {
    it('can seed and query default immutable AI profile (prof_rel_2026_08_v1)', async () => {
      await ensureDefaultAiProfiles(db);

      const [profile] = await db
        .select()
        .from(aiProfiles)
        .where(eq(aiProfiles.id, 'prof_rel_2026_08_v1'));

      expect(profile).toBeDefined();
      expect(profile!.version).toBe(1);
      expect(profile!.operationType).toBe('SEMANTIC_RELEVANCE');
      expect(profile!.provider).toBe('OLLAMA');
      expect(profile!.modelId).toBe('gemma4:12b');
      expect(profile!.isActive).toBe(true);
    });

    it('cascades deletion from district to ai_operations and ai_provider_attempts', async () => {
      await ensureDefaultAiProfiles(db);

      const districtId = `dist_ai_${crypto.randomUUID()}`;
      const opId = `aiop_${crypto.randomUUID()}`;
      const attemptId = `att_${crypto.randomUUID()}`;

      await db.insert(districts).values({
        id: districtId,
        name: `AiTestDistrict_${crypto.randomUUID().slice(0, 8)}`,
        status: 'ACTIVE',
      });

      await db.insert(aiOperations).values({
        id: opId,
        districtId,
        mahallaName: 'Guliston',
        calendarDay: '2026-08-22',
        operationType: 'SEMANTIC_RELEVANCE',
        targetId: `intk_${crypto.randomUUID()}`,
        pinnedProfileId: 'prof_rel_2026_08_v1',
        contextRevision: 0,
        snapshotFingerprint: 'sha256_empty_v1',
        finalStatus: 'COMPLETED_RELEVANT',
        resultPayload: { lanes: ['WATER'], exclusionReason: null, reasoning: 'Water outage' },
      });

      await db.insert(aiProviderAttempts).values({
        id: attemptId,
        operationId: opId,
        attemptNumber: 1,
        provider: 'OPENAI',
        modelId: 'gpt-4o-mini-2024-07-18',
        durationMs: 420,
        inputTokens: 150,
        outputTokens: 45,
        status: 'SUCCESS',
      });

      // Verify records exist
      const [opBefore] = await db.select().from(aiOperations).where(eq(aiOperations.id, opId));
      const [attBefore] = await db.select().from(aiProviderAttempts).where(eq(aiProviderAttempts.id, attemptId));
      expect(opBefore).toBeDefined();
      expect(attBefore).toBeDefined();

      // Delete parent district -> should cascade delete ai_operations and ai_provider_attempts
      await db.delete(districts).where(eq(districts.id, districtId));

      const [opAfter] = await db.select().from(aiOperations).where(eq(aiOperations.id, opId));
      const [attAfter] = await db.select().from(aiProviderAttempts).where(eq(aiProviderAttempts.id, attemptId));
      expect(opAfter).toBeUndefined();
      expect(attAfter).toBeUndefined();
    });

    it('enforces composite unique constraint on ai_operations (districtId, operationType, targetId)', async () => {
      await ensureDefaultAiProfiles(db);

      const districtId = `dist_ai_uniq_${crypto.randomUUID()}`;
      const targetId = `intk_uniq_${crypto.randomUUID()}`;

      await db.insert(districts).values({
        id: districtId,
        name: `AiUniqDistrict_${crypto.randomUUID().slice(0, 8)}`,
        status: 'ACTIVE',
      });

      // Insert first operation
      await db.insert(aiOperations).values({
        id: `aiop_${crypto.randomUUID()}`,
        districtId,
        mahallaName: 'Navbahor',
        calendarDay: '2026-08-22',
        operationType: 'SEMANTIC_RELEVANCE',
        targetId,
        pinnedProfileId: 'prof_rel_2026_08_v1',
        contextRevision: 0,
        snapshotFingerprint: 'sha256_empty_v1',
        finalStatus: 'COMPLETED_RELEVANT',
      });

      // Inserting second operation with same district + operationType + targetId must fail
      await expect(
        db.insert(aiOperations).values({
          id: `aiop_${crypto.randomUUID()}`,
          districtId,
          mahallaName: 'Navbahor',
          calendarDay: '2026-08-22',
          operationType: 'SEMANTIC_RELEVANCE',
          targetId,
          pinnedProfileId: 'prof_rel_2026_08_v1',
          contextRevision: 1,
          snapshotFingerprint: 'sha256_different',
          finalStatus: 'COMPLETED_RELEVANT',
        }),
      ).rejects.toThrow();

      // Clean up
      await db.delete(districts).where(eq(districts.id, districtId));
    });

    it('enforces composite unique constraint on ai_provider_attempts (operationId, attemptNumber)', async () => {
      await ensureDefaultAiProfiles(db);

      const districtId = `dist_att_uniq_${crypto.randomUUID()}`;
      const opId = `aiop_att_${crypto.randomUUID()}`;

      await db.insert(districts).values({
        id: districtId,
        name: `AiAttDistrict_${crypto.randomUUID().slice(0, 8)}`,
        status: 'ACTIVE',
      });

      await db.insert(aiOperations).values({
        id: opId,
        districtId,
        mahallaName: 'Navbahor',
        calendarDay: '2026-08-22',
        operationType: 'SEMANTIC_RELEVANCE',
        targetId: `intk_att_${crypto.randomUUID()}`,
        pinnedProfileId: 'prof_rel_2026_08_v1',
        contextRevision: 0,
        snapshotFingerprint: 'sha256_empty_v1',
        finalStatus: 'COMPLETED_RELEVANT',
      });

      // Insert attempt 1
      await db.insert(aiProviderAttempts).values({
        id: `att1_${crypto.randomUUID()}`,
        operationId: opId,
        attemptNumber: 1,
        provider: 'OPENAI',
        modelId: 'gpt-4o-mini-2024-07-18',
        durationMs: 300,
        status: 'SUCCESS',
      });

      // Duplicate attempt 1 for same operationId must fail
      await expect(
        db.insert(aiProviderAttempts).values({
          id: `att2_${crypto.randomUUID()}`,
          operationId: opId,
          attemptNumber: 1,
          provider: 'OPENAI',
          modelId: 'gpt-4o-mini-2024-07-18',
          durationMs: 400,
          status: 'SUCCESS',
        }),
      ).rejects.toThrow();

      // Clean up
      await db.delete(districts).where(eq(districts.id, districtId));
    });

    it('can query topics and accepted_evidence tables and seeds default topic matching profile', async () => {
      await ensureDefaultAiProfiles(db);

      const topicRows = await db.select().from(topics).limit(1);
      expect(Array.isArray(topicRows)).toBe(true);

      const evidenceRows = await db.select().from(acceptedEvidence).limit(1);
      expect(Array.isArray(evidenceRows)).toBe(true);

      const [matchProfile] = await db
        .select()
        .from(aiProfiles)
        .where(eq(aiProfiles.id, 'prof_match_2026_08_v1'))
        .limit(1);

      expect(matchProfile).toBeDefined();
      expect(matchProfile?.operationType).toBe('TOPIC_MATCHING');
      expect(matchProfile?.provider).toBe('OLLAMA');
      expect(matchProfile?.modelId).toBe('gemma4:12b');
    });

    it('enforces foreign key restrict on accepted_evidence.topic_id (preventing topic deletion)', async () => {
      const districtId = `dist_top_${crypto.randomUUID()}`;
      const topicId = `top_${crypto.randomUUID()}`;
      const intakeId = `intk_top_${crypto.randomUUID()}`;
      const evidenceId = `evi_${crypto.randomUUID()}`;
      const now = new Date();
      const retentionExpiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

      await db.insert(districts).values({
        id: districtId,
        name: `TopicDist_${crypto.randomUUID().slice(0, 8)}`,
        status: 'ACTIVE',
      });

      await db.insert(topics).values({
        id: topicId,
        districtId,
        mahallaName: 'Guliston',
        calendarDay: '2026-08-22',
        primaryLane: 'WATER',
        status: 'ACTIVE',
        latestRelevantEvidenceTimestamp: now,
        retentionExpiresAt,
        requiredDerivedGeneration: 1,
        appliedDerivedGeneration: 0,
      });

      await db.insert(telegramIntakeRecords).values({
        id: intakeId,
        districtId,
        mahallaName: 'Guliston',
        telegramBotId: 'bot_123',
        telegramChatId: '-100123456789',
        telegramMessageId: '9901',
        originalTimestamp: now,
        calendarDay: '2026-08-22',
        rawPayload: { text: 'Suv toshib ketdi' },
      });

      await db.insert(acceptedEvidence).values({
        id: evidenceId,
        topicId,
        districtId,
        mahallaName: 'Guliston',
        calendarDay: '2026-08-22',
        intakeRecordId: intakeId,
        telegramChatId: '-100123456789',
        telegramMessageId: '9901',
        originalTimestamp: now,
        verbatimText: 'Suv toshib ketdi',
        contentType: 'TEXT',
        userMetadata: { username: 'citizen1' },
      });

      // Deleting the topic while accepted_evidence references it MUST fail due to onDelete: 'restrict'
      await expect(
        db.delete(topics).where(eq(topics.id, topicId)),
      ).rejects.toThrow();

      // Clean up: delete evidence first, then topic, then intake, then district
      await db.delete(acceptedEvidence).where(eq(acceptedEvidence.id, evidenceId));
      await db.delete(topics).where(eq(topics.id, topicId));
      await db.delete(telegramIntakeRecords).where(eq(telegramIntakeRecords.id, intakeId));
      await db.delete(districts).where(eq(districts.id, districtId));
    });

    it('enforces status check constraint and default PENDING on telegram_intake_records', async () => {
      const districtId = `dist_intk_stat_${crypto.randomUUID()}`;
      const intakeIdValid = `intk_stat_v_${crypto.randomUUID()}`;
      const intakeIdInvalid = `intk_stat_inv_${crypto.randomUUID()}`;
      const now = new Date();

      await db.insert(districts).values({
        id: districtId,
        name: `IntakeStatDist_${crypto.randomUUID().slice(0, 8)}`,
        status: 'ACTIVE',
      });

      // 1. Insert with default status -> defaults to 'PENDING'
      await db.insert(telegramIntakeRecords).values({
        id: intakeIdValid,
        districtId,
        mahallaName: 'Yangiobod',
        telegramBotId: 'bot_status_test',
        telegramChatId: '-100999888',
        telegramMessageId: '1001',
        originalTimestamp: now,
        calendarDay: '2026-08-22',
        rawPayload: { text: 'Test message' },
      });

      const [validRow] = await db
        .select({ status: telegramIntakeRecords.status })
        .from(telegramIntakeRecords)
        .where(eq(telegramIntakeRecords.id, intakeIdValid));

      expect(validRow?.status).toBe('PENDING');

      // 2. Insert with illegal status -> rejected by CHECK constraint
      await expect(
        db.insert(telegramIntakeRecords).values({
          id: intakeIdInvalid,
          districtId,
          mahallaName: 'Yangiobod',
          telegramBotId: 'bot_status_test',
          telegramChatId: '-100999888',
          telegramMessageId: '1002',
          originalTimestamp: now,
          calendarDay: '2026-08-22',
          rawPayload: { text: 'Invalid status test' },
          status: 'ILLEGAL_STATUS',
        }),
      ).rejects.toThrow();

      // Cleanup
      await db.delete(telegramIntakeRecords).where(eq(telegramIntakeRecords.id, intakeIdValid));
      await db.delete(districts).where(eq(districts.id, districtId));
    });

    it('enforces source check constraint and bot-id consistency check on telegram_intake_records (Ticket 10)', async () => {
      const districtId = `dist_intk_src_${crypto.randomUUID()}`;
      const intakeIdBotValid = `intk_bot_v_${crypto.randomUUID()}`;
      const intakeIdBotInvalid = `intk_bot_inv_${crypto.randomUUID()}`;
      const intakeIdUserbotValid = `intk_ub_v_${crypto.randomUUID()}`;
      const intakeIdUserbotInvalid = `intk_ub_inv_${crypto.randomUUID()}`;
      const intakeIdInvalidSource = `intk_src_inv_${crypto.randomUUID()}`;
      const now = new Date();

      await db.insert(districts).values({
        id: districtId,
        name: `IntakeSrcDist_${crypto.randomUUID().slice(0, 8)}`,
        status: 'ACTIVE',
      });

      // 1. Valid BOT_API record with non-null telegramBotId succeeds
      await db.insert(telegramIntakeRecords).values({
        id: intakeIdBotValid,
        districtId,
        mahallaName: 'Yangiobod',
        source: 'BOT_API',
        telegramBotId: 'bot_123456',
        telegramChatId: '-100999777',
        telegramMessageId: '2001',
        originalTimestamp: now,
        calendarDay: '2026-08-22',
        rawPayload: { text: 'Valid BOT_API test' },
      });

      const [botRow] = await db
        .select({
          source: telegramIntakeRecords.source,
          telegramBotId: telegramIntakeRecords.telegramBotId,
        })
        .from(telegramIntakeRecords)
        .where(eq(telegramIntakeRecords.id, intakeIdBotValid));

      expect(botRow?.source).toBe('BOT_API');
      expect(botRow?.telegramBotId).toBe('bot_123456');

      // 2. Invalid BOT_API record with null telegramBotId fails consistency constraint
      let botNullErr: any;
      try {
        await db.insert(telegramIntakeRecords).values({
          id: intakeIdBotInvalid,
          districtId,
          mahallaName: 'Yangiobod',
          source: 'BOT_API',
          telegramBotId: null,
          telegramChatId: '-100999777',
          telegramMessageId: '2002',
          originalTimestamp: now,
          calendarDay: '2026-08-22',
          rawPayload: { text: 'Invalid BOT_API null bot test' },
        });
      } catch (e) {
        botNullErr = e;
      }
      expect(botNullErr).toBeDefined();
      expect(botNullErr?.cause?.constraint).toBe('telegram_intakes_bot_id_source_consistency_check');

      // Also invalid when defaulting source to BOT_API with omitted telegramBotId
      let botOmittedErr: any;
      try {
        await db.insert(telegramIntakeRecords).values({
          id: intakeIdBotInvalid,
          districtId,
          mahallaName: 'Yangiobod',
          telegramChatId: '-100999777',
          telegramMessageId: '2002',
          originalTimestamp: now,
          calendarDay: '2026-08-22',
          rawPayload: { text: 'Default BOT_API omitted bot test' },
        });
      } catch (e) {
        botOmittedErr = e;
      }
      expect(botOmittedErr).toBeDefined();
      expect(botOmittedErr?.cause?.constraint).toBe('telegram_intakes_bot_id_source_consistency_check');

      // 3. Valid USERBOT record with null telegramBotId succeeds
      await db.insert(telegramIntakeRecords).values({
        id: intakeIdUserbotValid,
        districtId,
        mahallaName: 'Yangiobod',
        source: 'USERBOT',
        telegramBotId: null,
        telegramChatId: '-100999777',
        telegramMessageId: '2003',
        originalTimestamp: now,
        calendarDay: '2026-08-22',
        rawPayload: { text: 'Valid USERBOT test' },
      });

      const [userbotRow] = await db
        .select({
          source: telegramIntakeRecords.source,
          telegramBotId: telegramIntakeRecords.telegramBotId,
        })
        .from(telegramIntakeRecords)
        .where(eq(telegramIntakeRecords.id, intakeIdUserbotValid));

      expect(userbotRow?.source).toBe('USERBOT');
      expect(userbotRow?.telegramBotId).toBeNull();

      // 4. Invalid USERBOT record with non-null telegramBotId fails consistency constraint
      let userbotNonEmptyErr: any;
      try {
        await db.insert(telegramIntakeRecords).values({
          id: intakeIdUserbotInvalid,
          districtId,
          mahallaName: 'Yangiobod',
          source: 'USERBOT',
          telegramBotId: 'bot_illegal',
          telegramChatId: '-100999777',
          telegramMessageId: '2004',
          originalTimestamp: now,
          calendarDay: '2026-08-22',
          rawPayload: { text: 'Invalid USERBOT non-null bot test' },
        });
      } catch (e) {
        userbotNonEmptyErr = e;
      }
      expect(userbotNonEmptyErr).toBeDefined();
      expect(userbotNonEmptyErr?.cause?.constraint).toBe('telegram_intakes_bot_id_source_consistency_check');

      // 5. Insert with illegal source -> rejected by source check constraint
      await expect(
        db.insert(telegramIntakeRecords).values({
          id: intakeIdInvalidSource,
          districtId,
          mahallaName: 'Yangiobod',
          source: 'INVALID_SOURCE' as any,
          telegramChatId: '-100999777',
          telegramMessageId: '2005',
          originalTimestamp: now,
          calendarDay: '2026-08-22',
          rawPayload: { text: 'Invalid source test' },
        }),
      ).rejects.toThrow();

      // Cleanup
      await db.delete(telegramIntakeRecords).where(eq(telegramIntakeRecords.id, intakeIdBotValid));
      await db.delete(telegramIntakeRecords).where(eq(telegramIntakeRecords.id, intakeIdUserbotValid));
      await db.delete(districts).where(eq(districts.id, districtId));
    });

    it('enforces status check constraint on topics table (F3.2)', async () => {
      const districtId = `dist_top_stat_${crypto.randomUUID()}`;
      const topicIdValid = `top_stat_v_${crypto.randomUUID()}`;
      const topicIdInvalid = `top_stat_inv_${crypto.randomUUID()}`;
      const now = new Date();

      await db.insert(districts).values({
        id: districtId,
        name: `TopicStatDist_${crypto.randomUUID().slice(0, 8)}`,
        status: 'ACTIVE',
      });

      // 1. Valid status ('ACTIVE') succeeds
      await db.insert(topics).values({
        id: topicIdValid,
        districtId,
        mahallaName: 'Yangiobod',
        calendarDay: '2026-08-22',
        primaryLane: 'WATER',
        status: 'ACTIVE',
        latestRelevantEvidenceTimestamp: now,
        retentionExpiresAt: new Date(now.getTime() + 90 * 86400000),
      });

      // 2. Illegal status rejected by CHECK constraint
      await expect(
        db.insert(topics).values({
          id: topicIdInvalid,
          districtId,
          mahallaName: 'Yangiobod',
          calendarDay: '2026-08-22',
          primaryLane: 'WATER',
          status: 'ILLEGAL_STATUS',
          latestRelevantEvidenceTimestamp: now,
          retentionExpiresAt: new Date(now.getTime() + 90 * 86400000),
        }),
      ).rejects.toThrow();

      // Cleanup
      await db.delete(topics).where(eq(topics.id, topicIdValid));
      await db.delete(districts).where(eq(districts.id, districtId));
    });

    it('enforces composite unique constraint on accepted_evidence (districtId, telegramChatId, telegramMessageId)', async () => {
      const districtId = `dist_evi_uniq_${crypto.randomUUID()}`;
      const topicId = `top_${crypto.randomUUID()}`;
      const intakeId1 = `intk_uniq1_${crypto.randomUUID()}`;
      const intakeId2 = `intk_uniq2_${crypto.randomUUID()}`;
      const now = new Date();

      await db.insert(districts).values({
        id: districtId,
        name: `EviUniqDist_${crypto.randomUUID().slice(0, 8)}`,
        status: 'ACTIVE',
      });

      await db.insert(topics).values({
        id: topicId,
        districtId,
        mahallaName: 'Guliston',
        calendarDay: '2026-08-22',
        primaryLane: 'ELECTRICITY',
        status: 'ACTIVE',
        latestRelevantEvidenceTimestamp: now,
        retentionExpiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
        requiredDerivedGeneration: 1,
        appliedDerivedGeneration: 0,
      });

      await db.insert(telegramIntakeRecords).values([
        {
          id: intakeId1,
          districtId,
          mahallaName: 'Guliston',
          telegramBotId: 'bot_123',
          telegramChatId: '-100987654321',
          telegramMessageId: '8801',
          originalTimestamp: now,
          calendarDay: '2026-08-22',
          rawPayload: { text: 'Svet o‘chdi' },
        },
        {
          id: intakeId2,
          districtId,
          mahallaName: 'Guliston',
          telegramBotId: 'bot_123',
          telegramChatId: '-100987654321',
          telegramMessageId: '8802',
          originalTimestamp: now,
          calendarDay: '2026-08-22',
          rawPayload: { text: 'Svet o‘chdi' },
        },
      ]);

      await db.insert(acceptedEvidence).values({
        id: `evi1_${crypto.randomUUID()}`,
        topicId,
        districtId,
        mahallaName: 'Guliston',
        calendarDay: '2026-08-22',
        intakeRecordId: intakeId1,
        telegramChatId: '-100987654321',
        telegramMessageId: '8801',
        originalTimestamp: now,
        verbatimText: 'Svet o‘chdi',
        contentType: 'TEXT',
      });

      // Duplicate (districtId, telegramChatId, telegramMessageId) must fail
      await expect(
        db.insert(acceptedEvidence).values({
          id: `evi2_${crypto.randomUUID()}`,
          topicId,
          districtId,
          mahallaName: 'Guliston',
          calendarDay: '2026-08-22',
          intakeRecordId: intakeId2,
          telegramChatId: '-100987654321',
          telegramMessageId: '8801',
          originalTimestamp: now,
          verbatimText: 'Svet o‘chdi',
          contentType: 'TEXT',
        }),
      ).rejects.toThrow();

      // Clean up
      await db.delete(acceptedEvidence).where(eq(acceptedEvidence.districtId, districtId));
      await db.delete(topics).where(eq(topics.id, topicId));
      await db.delete(telegramIntakeRecords).where(eq(telegramIntakeRecords.districtId, districtId));
      await db.delete(districts).where(eq(districts.id, districtId));
    });
  });

  describe('Story 5.2: District Analysis Settings Versions & Drafts Schemas', () => {
    it('seeds and retrieves default active district analysis configuration', async () => {
      const districtId = `dist_schema_${crypto.randomUUID()}`;
      await db.insert(districts).values({
        id: districtId,
        name: `DistrictSchemaTest_${crypto.randomUUID().slice(0, 8)}`,
        status: 'ACTIVE',
      });

      await ensureDefaultDistrictAnalysisSettings(db, districtId);

      const [activeVersion] = await db
        .select()
        .from(districtAnalysisSettingsVersions)
        .where(eq(districtAnalysisSettingsVersions.districtId, districtId));

      expect(activeVersion).toBeDefined();
      expect(activeVersion!.id).toBe(`dcfg_${districtId}_v1`);
      expect(activeVersion!.version).toBe(1);
      expect(activeVersion!.isActive).toBe(true);
      expect(Array.isArray(activeVersion!.hokimRecognitionTerms)).toBe(true);
      expect(activeVersion!.hokimRecognitionTerms.length).toBeGreaterThanOrEqual(5);
      expect(Array.isArray(activeVersion!.localVocabularyAdditions)).toBe(true);

      // Clean up
      await db.delete(districts).where(eq(districts.id, districtId));
    });

    it('enforces composite unique constraint on (districtId, version)', async () => {
      const districtId = `dist_ver_uniq_${crypto.randomUUID()}`;
      await db.insert(districts).values({
        id: districtId,
        name: `VerUniqDist_${crypto.randomUUID().slice(0, 8)}`,
        status: 'ACTIVE',
      });

      await db.insert(districtAnalysisSettingsVersions).values({
        id: `dcfg_${districtId}_v1`,
        districtId,
        version: 1,
        hokimRecognitionTerms: ['Ҳоким'],
        localVocabularyAdditions: [],
        isActive: true,
      });

      // Duplicate (districtId, version = 1) must fail
      await expect(
        db.insert(districtAnalysisSettingsVersions).values({
          id: `dcfg_${districtId}_v1_dup`,
          districtId,
          version: 1,
          hokimRecognitionTerms: ['Ҳоким', 'Туман ҳокими'],
          localVocabularyAdditions: [],
          isActive: false,
        }),
      ).rejects.toThrow();

      // Clean up
      await db.delete(districts).where(eq(districts.id, districtId));
    });

    it('can insert, update, and query district settings draft and enforces unique districtId', async () => {
      const districtId = `dist_draft_test_${crypto.randomUUID()}`;
      await db.insert(districts).values({
        id: districtId,
        name: `DraftTestDist_${crypto.randomUUID().slice(0, 8)}`,
        status: 'ACTIVE',
      });

      await db.insert(districtAnalysisSettingsDrafts).values({
        id: `draft_${districtId}`,
        districtId,
        hokimRecognitionTerms: ['Ҳоким', 'Ҳокимият'],
        localVocabularyAdditions: [
          { term: 'Қўшчинор маҳалласи', category: 'Маҳалла номлари', description: 'МФЙ' },
        ],
      });

      const [draft] = await db
        .select()
        .from(districtAnalysisSettingsDrafts)
        .where(eq(districtAnalysisSettingsDrafts.districtId, districtId));

      expect(draft).toBeDefined();
      expect(draft!.hokimRecognitionTerms).toEqual(['Ҳоким', 'Ҳокимият']);
      expect(draft!.localVocabularyAdditions).toHaveLength(1);

      // Inserting a second draft for the same districtId must fail
      await expect(
        db.insert(districtAnalysisSettingsDrafts).values({
          id: `draft_another_${districtId}`,
          districtId,
          hokimRecognitionTerms: ['Ҳоким'],
          localVocabularyAdditions: [],
        }),
      ).rejects.toThrow();

      // Clean up
      await db.delete(districts).where(eq(districts.id, districtId));
    });

    it('cascades deletion of district_analysis_settings_versions and drafts when district is deleted', async () => {
      const districtId = `dist_cascade_${crypto.randomUUID()}`;
      await db.insert(districts).values({
        id: districtId,
        name: `CascadeDist_${crypto.randomUUID().slice(0, 8)}`,
        status: 'ACTIVE',
      });

      await db.insert(districtAnalysisSettingsVersions).values({
        id: `dcfg_${districtId}_v1`,
        districtId,
        version: 1,
        hokimRecognitionTerms: ['Ҳоким'],
        localVocabularyAdditions: [],
        isActive: true,
      });

      await db.insert(districtAnalysisSettingsDrafts).values({
        id: `draft_${districtId}`,
        districtId,
        hokimRecognitionTerms: ['Ҳоким'],
        localVocabularyAdditions: [],
      });

      // Delete parent district
      await db.delete(districts).where(eq(districts.id, districtId));

      // Verify versions and drafts were deleted
      const versions = await db
        .select()
        .from(districtAnalysisSettingsVersions)
        .where(eq(districtAnalysisSettingsVersions.districtId, districtId));
      expect(versions).toHaveLength(0);

      const drafts = await db
        .select()
        .from(districtAnalysisSettingsDrafts)
        .where(eq(districtAnalysisSettingsDrafts.districtId, districtId));
      expect(drafts).toHaveLength(0);
    });
  });
});





