import { eq, and, desc, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../adapters/db/client.js';
import {
  districtAnalysisSettingsVersions,
  districtAnalysisSettingsDrafts,
  type DistrictAnalysisSettingsVersion,
  type NewDistrictAnalysisSettingsVersion,
  type NewDistrictAnalysisSettingsDraft,
  type DistrictAnalysisSettingsDraft,
} from '../../adapters/db/schema/index.js';

export interface DistrictAnalysisSettingsRepositoryPort {
  getActiveConfiguration(
    db: DbOrTx,
    districtId: string,
  ): Promise<DistrictAnalysisSettingsVersion | null>;
  getActiveConfigurationForUpdate(
    tx: DbOrTx,
    districtId: string,
  ): Promise<DistrictAnalysisSettingsVersion | null>;
  getHistory(
    db: DbOrTx,
    districtId: string,
  ): Promise<DistrictAnalysisSettingsVersion[]>;
  getVersionById(
    db: DbOrTx,
    districtId: string,
    id: string,
  ): Promise<DistrictAnalysisSettingsVersion | null>;
  getDraft(
    db: DbOrTx,
    districtId: string,
  ): Promise<DistrictAnalysisSettingsDraft | null>;
  saveDraft(
    db: DbOrTx,
    draft: NewDistrictAnalysisSettingsDraft,
  ): Promise<DistrictAnalysisSettingsDraft>;
  deactivateVersion(
    tx: DbOrTx,
    districtId: string,
    id: string,
  ): Promise<void>;
  getNextVersionNumber(tx: DbOrTx, districtId: string): Promise<number>;
  insertVersion(
    tx: DbOrTx,
    version: NewDistrictAnalysisSettingsVersion,
  ): Promise<DistrictAnalysisSettingsVersion>;
  deleteDraft(tx: DbOrTx, districtId: string): Promise<void>;
}

export class DrizzleDistrictAnalysisSettingsRepository
  implements DistrictAnalysisSettingsRepositoryPort
{
  async getActiveConfiguration(
    db: DbOrTx,
    districtId: string,
  ): Promise<DistrictAnalysisSettingsVersion | null> {
    const [row] = await db
      .select()
      .from(districtAnalysisSettingsVersions)
      .where(
        and(
          eq(districtAnalysisSettingsVersions.districtId, districtId),
          eq(districtAnalysisSettingsVersions.isActive, true),
        ),
      )
      .orderBy(desc(districtAnalysisSettingsVersions.version))
      .limit(1);

    return row || null;
  }

  async getActiveConfigurationForUpdate(
    tx: DbOrTx,
    districtId: string,
  ): Promise<DistrictAnalysisSettingsVersion | null> {
    const [row] = await tx
      .select()
      .from(districtAnalysisSettingsVersions)
      .where(
        and(
          eq(districtAnalysisSettingsVersions.districtId, districtId),
          eq(districtAnalysisSettingsVersions.isActive, true),
        ),
      )
      .orderBy(desc(districtAnalysisSettingsVersions.version))
      .limit(1)
      .for('update');

    return row || null;
  }

  async getHistory(
    db: DbOrTx,
    districtId: string,
  ): Promise<DistrictAnalysisSettingsVersion[]> {
    return await db
      .select()
      .from(districtAnalysisSettingsVersions)
      .where(eq(districtAnalysisSettingsVersions.districtId, districtId))
      .orderBy(desc(districtAnalysisSettingsVersions.version));
  }

  async getVersionById(
    db: DbOrTx,
    districtId: string,
    id: string,
  ): Promise<DistrictAnalysisSettingsVersion | null> {
    const [row] = await db
      .select()
      .from(districtAnalysisSettingsVersions)
      .where(
        and(
          eq(districtAnalysisSettingsVersions.districtId, districtId),
          eq(districtAnalysisSettingsVersions.id, id),
        ),
      )
      .limit(1);

    return row || null;
  }

  async getDraft(
    db: DbOrTx,
    districtId: string,
  ): Promise<DistrictAnalysisSettingsDraft | null> {
    const [row] = await db
      .select()
      .from(districtAnalysisSettingsDrafts)
      .where(eq(districtAnalysisSettingsDrafts.districtId, districtId))
      .limit(1);

    return row || null;
  }

  async saveDraft(
    db: DbOrTx,
    draft: NewDistrictAnalysisSettingsDraft,
  ): Promise<DistrictAnalysisSettingsDraft> {
    const [saved] = await db
      .insert(districtAnalysisSettingsDrafts)
      .values(draft)
      .onConflictDoUpdate({
        target: districtAnalysisSettingsDrafts.districtId,
        set: {
          baseActiveVersionId: draft.baseActiveVersionId,
          hokimRecognitionTerms: draft.hokimRecognitionTerms,
          localVocabularyAdditions: draft.localVocabularyAdditions,
          updatedBy: draft.updatedBy,
          updatedAt: draft.updatedAt ?? new Date(),
        },
      })
      .returning();

    if (!saved) {
      throw new Error('Туман созламалари қораламасини сақлашда хатолик юз берди.');
    }

    return saved;
  }

  async deactivateVersion(
    tx: DbOrTx,
    districtId: string,
    id: string,
  ): Promise<void> {
    await tx
      .update(districtAnalysisSettingsVersions)
      .set({ isActive: false })
      .where(
        and(
          eq(districtAnalysisSettingsVersions.districtId, districtId),
          eq(districtAnalysisSettingsVersions.id, id),
        ),
      );
  }

  async getNextVersionNumber(
    tx: DbOrTx,
    districtId: string,
  ): Promise<number> {
    const [maxRow] = await tx
      .select({
        maxVersion: sql<number>`COALESCE(MAX(${districtAnalysisSettingsVersions.version}), 0)`,
      })
      .from(districtAnalysisSettingsVersions)
      .where(eq(districtAnalysisSettingsVersions.districtId, districtId));

    return (Number(maxRow?.maxVersion) || 0) + 1;
  }

  async insertVersion(
    tx: DbOrTx,
    version: NewDistrictAnalysisSettingsVersion,
  ): Promise<DistrictAnalysisSettingsVersion> {
    const [saved] = await tx
      .insert(districtAnalysisSettingsVersions)
      .values(version)
      .returning();

    if (!saved) {
      throw new Error(
        'Туман созламалари янги версиясини сақлашда хатолик юз берди.',
      );
    }

    return saved;
  }

  async deleteDraft(tx: DbOrTx, districtId: string): Promise<void> {
    await tx
      .delete(districtAnalysisSettingsDrafts)
      .where(eq(districtAnalysisSettingsDrafts.districtId, districtId));
  }
}

export const districtAnalysisSettingsRepository =
  new DrizzleDistrictAnalysisSettingsRepository();

