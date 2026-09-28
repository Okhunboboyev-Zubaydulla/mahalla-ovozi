import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { createDbPool, createDbClient, DbClient, DbTransaction } from '../src/adapters/db/client.js';
import { runMigrations } from '../src/adapters/db/migrate.js';
import {
  districts,
  districtAnalysisSettingsVersions,
  districtAnalysisSettingsDrafts,
} from '../src/adapters/db/schema/index.js';
import { createAnalysisSettingsDataCleaner } from '../src/modules/ai/district-analysis-settings-data-cleaner.js';

describe('createAnalysisSettingsDataCleaner', () => {
  let pool: pg.Pool;
  let db: DbClient;

  beforeAll(async () => {
    await runMigrations();
    pool = createDbPool();
    db = createDbClient(pool);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function seedSettingsForDistrict(tag: string) {
    const districtId = `dist_set_${tag}_${Date.now()}`;
    const now = new Date();

    await db.insert(districts).values({
      id: districtId,
      name: `Settings Clean ${districtId}`,
      region: 'Toshkent',
      status: 'CANCELLED',
    });

    const versionId = `dcfg_${districtId}_v1`;
    await db.insert(districtAnalysisSettingsVersions).values({
      id: versionId,
      districtId,
      version: 1,
      hokimRecognitionTerms: ['Hokim'],
      localVocabularyAdditions: [],
      isActive: true,
      activatedAt: now,
    });

    const draftId = `draft_${districtId}`;
    await db.insert(districtAnalysisSettingsDrafts).values({
      id: draftId,
      districtId,
      baseActiveVersionId: versionId,
      hokimRecognitionTerms: ['Hokim'],
      localVocabularyAdditions: [],
    });

    return { districtId, versionId, draftId };
  }

  it('deletes drafts before versions for the target district', async () => {
    const { districtId } = await seedSettingsForDistrict('a');

    const draftsBefore = await db
      .select()
      .from(districtAnalysisSettingsDrafts)
      .where(eq(districtAnalysisSettingsDrafts.districtId, districtId));
    expect(draftsBefore).toHaveLength(1);

    const versionsBefore = await db
      .select()
      .from(districtAnalysisSettingsVersions)
      .where(eq(districtAnalysisSettingsVersions.districtId, districtId));
    expect(versionsBefore).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createAnalysisSettingsDataCleaner().deleteDistrictData(tx, districtId);
    });

    const draftsAfter = await db
      .select()
      .from(districtAnalysisSettingsDrafts)
      .where(eq(districtAnalysisSettingsDrafts.districtId, districtId));
    expect(draftsAfter).toHaveLength(0);

    const versionsAfter = await db
      .select()
      .from(districtAnalysisSettingsVersions)
      .where(eq(districtAnalysisSettingsVersions.districtId, districtId));
    expect(versionsAfter).toHaveLength(0);
  });

  it('does not delete settings belonging to other districts', async () => {
    const { districtId: districtA } = await seedSettingsForDistrict('b1');
    const { districtId: districtB } = await seedSettingsForDistrict('b2');

    await db.transaction(async (tx: DbTransaction) => {
      await createAnalysisSettingsDataCleaner().deleteDistrictData(tx, districtA);
    });

    const draftsB = await db
      .select()
      .from(districtAnalysisSettingsDrafts)
      .where(eq(districtAnalysisSettingsDrafts.districtId, districtB));
    expect(draftsB).toHaveLength(1);

    const versionsB = await db
      .select()
      .from(districtAnalysisSettingsVersions)
      .where(eq(districtAnalysisSettingsVersions.districtId, districtB));
    expect(versionsB).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createAnalysisSettingsDataCleaner().deleteDistrictData(tx, districtB);
    });
  });

  it('is idempotent when called on an already clean district', async () => {
    const { districtId } = await seedSettingsForDistrict('c');

    await db.transaction(async (tx: DbTransaction) => {
      await createAnalysisSettingsDataCleaner().deleteDistrictData(tx, districtId);
    });

    await expect(
      db.transaction(async (tx: DbTransaction) => {
        await createAnalysisSettingsDataCleaner().deleteDistrictData(tx, districtId);
      })
    ).resolves.not.toThrow();
  });

  it('rolls back on transaction error', async () => {
    const { districtId } = await seedSettingsForDistrict('d');

    await expect(
      db.transaction(async (tx: DbTransaction) => {
        await createAnalysisSettingsDataCleaner().deleteDistrictData(tx, districtId);
        throw new Error('forced rollback');
      })
    ).rejects.toThrow('forced rollback');

    const draftsAfter = await db
      .select()
      .from(districtAnalysisSettingsDrafts)
      .where(eq(districtAnalysisSettingsDrafts.districtId, districtId));
    expect(draftsAfter).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createAnalysisSettingsDataCleaner().deleteDistrictData(tx, districtId);
    });
  });
});
