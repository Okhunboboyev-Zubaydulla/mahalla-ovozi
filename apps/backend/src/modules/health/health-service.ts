import type pg from 'pg';
import type PgBoss from 'pg-boss';
import { eq } from 'drizzle-orm';
import {
  OverallSystemHealthResponse,
  DistrictHealthResponse,
  DistrictHealthSummary,
  ComponentHealthObservation,
  ComponentType,
  ComponentScope,
} from '@mahalla-ovozi/api-contracts';
import { DbClient } from '../../adapters/db/client.js';
import { districts } from '../../adapters/db/schema/index.js';
import { mapConcurrent } from '../../utils/concurrency.js';
import { logger } from '../../utils/logger.js';
import {
  aggregateComponentStatuses,
  aggregateOverallSystemHealth,
} from './health-evaluator.js';
import {
  checkDatabaseHealth,
  checkProcessingQueueHealth,
  checkStorageHealth,
  checkWebApplicationHealth,
  checkRetentionJobHealth,
  checkScheduledDeletionHealth,
  checkDistrictBotHealth,
  checkDistrictGroupsHealth,
  checkDistrictIntakeHealth,
  checkDistrictAiHealth,
  checkDistrictRetentionHealth,
  HealthConfig,
} from './health-checker.js';
import { synchronizeOperationalIssues } from '../issues/issue-manager.js';

export class DistrictNotFoundError extends Error {
  statusCode = 404;
  code = 'NOT_FOUND';
  constructor(message = 'Сўралган туман топилмади.') {
    super(message);
    this.name = 'DistrictNotFoundError';
  }
}

function handleSettledObservation(
  res: PromiseSettledResult<ComponentHealthObservation>,
  fallbackComponent: ComponentType,
  fallbackScope: ComponentScope,
  fallbackDistrictId: string | null,
  evaluatedAt: Date,
): ComponentHealthObservation {
  if (res.status === 'fulfilled') {
    return res.value;
  }
  const scopeLabel = fallbackDistrictId ? `${fallbackScope}:${fallbackDistrictId}` : fallbackScope;
  logger.error({ component: fallbackComponent, scope: scopeLabel, err: res.reason }, 'Component probe error');
  return {
    component: fallbackComponent,
    scope: fallbackScope,
    districtId: fallbackDistrictId,
    status: 'Unavailable',
    lastCheckAt: evaluatedAt.toISOString(),
    checkedAt: evaluatedAt.toISOString(),
    outcome: 'failure',
    errorCode: 'COMPONENT_PROBE_ERROR',
    errorMessage: 'Компонент текширувида кутилмаган хатолик юз берди.',
    latencyMs: null,
    isApplicable: true,
    lifecycleStatus: null,
    diagnostics: null,
  };
}

/**
 * High-level health query service for system and district scopes.
 */
export const healthService = {
  /**
   * Fetches application-owned overall system health with all district summaries.
   */
  async getOverallSystemHealth(
    db: DbClient,
    pool: pg.Pool,
    boss?: PgBoss,
    config?: HealthConfig,
  ): Promise<OverallSystemHealthResponse> {
    const evaluatedAt = new Date();

    // 1. Run all 6 global platform checks in parallel with error isolation (AC 1, AC 6)
    const globalSettled = await Promise.allSettled([
      checkDatabaseHealth(pool, config),
      checkProcessingQueueHealth(boss, config),
      checkStorageHealth(db, config),
      checkWebApplicationHealth(config),
      checkRetentionJobHealth(db, config),
      checkScheduledDeletionHealth(boss, config),
    ]);

    const globalComponents: ComponentHealthObservation[] = [
      handleSettledObservation(globalSettled[0]!, 'database', 'GLOBAL', null, evaluatedAt),
      handleSettledObservation(globalSettled[1]!, 'processing_queue', 'GLOBAL', null, evaluatedAt),
      handleSettledObservation(globalSettled[2]!, 'storage', 'GLOBAL', null, evaluatedAt),
      handleSettledObservation(globalSettled[3]!, 'web_application', 'GLOBAL', null, evaluatedAt),
      handleSettledObservation(globalSettled[4]!, 'retention_jobs', 'GLOBAL', null, evaluatedAt),
      handleSettledObservation(globalSettled[5]!, 'scheduled_deletion', 'GLOBAL', null, evaluatedAt),
    ];

    // 2. Fetch all registered districts
    const allDistricts = await db
      .select()
      .from(districts)
      .orderBy(districts.createdAt);

    // 3. Run per-district component checks with bounded concurrency (limit: 3) and error isolation (AC 6)
    const districtSummaries: DistrictHealthSummary[] = await mapConcurrent(
      allDistricts,
      3,
      async (district) => {
        const districtSettled = await Promise.allSettled([
          checkDistrictBotHealth(db, district.id, config),
          checkDistrictGroupsHealth(db, district.id, config),
          checkDistrictIntakeHealth(db, district.id, config),
          checkDistrictAiHealth(db, district.id, config),
          checkDistrictRetentionHealth(db, district.id, config),
        ]);

        const districtComponents: ComponentHealthObservation[] = [
          handleSettledObservation(districtSettled[0]!, 'telegram_bot', 'DISTRICT', district.id, evaluatedAt),
          handleSettledObservation(districtSettled[1]!, 'telegram_groups', 'DISTRICT', district.id, evaluatedAt),
          handleSettledObservation(districtSettled[2]!, 'message_intake', 'DISTRICT', district.id, evaluatedAt),
          handleSettledObservation(districtSettled[3]!, 'ai_operations', 'DISTRICT', district.id, evaluatedAt),
          handleSettledObservation(districtSettled[4]!, 'district_retention', 'DISTRICT', district.id, evaluatedAt),
        ];

        // Attach district lifecycleStatus to observations
        const enrichedComponents = districtComponents.map((c) => ({
          ...c,
          lifecycleStatus: district.status,
        }));

        const aggregateResult = aggregateComponentStatuses(enrichedComponents, {
          isQuietAllowed: true,
          evaluatedAt,
        });

        return {
          districtId: district.id,
          districtName: district.name,
          status: aggregateResult.status,
          lastCheckAt: aggregateResult.lastCheckAt,
          components: enrichedComponents,
          lifecycleStatus: district.status,
        };
      },
    );

    // 4. Synchronize operational issues across global and all district scopes
    const allDistrictComponents = districtSummaries.flatMap((d) => d.components);
    const allObservations = [...globalComponents, ...allDistrictComponents];
    const districtMap = new Map(allDistricts.map((d) => [d.id, d.name]));

    await synchronizeOperationalIssues(db, allObservations, {
      districtMap,
      evaluationScope: { type: 'SYSTEM' },
    });

    // 5. Hierarchical aggregation into OverallSystemHealthResponse
    return aggregateOverallSystemHealth(globalComponents, districtSummaries, evaluatedAt);
  },

  /**
   * Fetches district-scoped health for a specific district.
   */
  async getDistrictHealth(
    db: DbClient,
    districtId: string,
    _pool?: pg.Pool,
    _boss?: PgBoss,
    config?: HealthConfig,
  ): Promise<DistrictHealthResponse> {
    const evaluatedAt = new Date();

    const districtList = await db
      .select()
      .from(districts)
      .where(eq(districts.id, districtId))
      .limit(1);

    if (districtList.length === 0 || !districtList[0]) {
      throw new DistrictNotFoundError();
    }

    const district = districtList[0];

    const districtSettled = await Promise.allSettled([
      checkDistrictBotHealth(db, district.id, config),
      checkDistrictGroupsHealth(db, district.id, config),
      checkDistrictIntakeHealth(db, district.id, config),
      checkDistrictAiHealth(db, district.id, config),
      checkDistrictRetentionHealth(db, district.id, config),
    ]);

    const districtComponents: ComponentHealthObservation[] = [
      handleSettledObservation(districtSettled[0]!, 'telegram_bot', 'DISTRICT', district.id, evaluatedAt),
      handleSettledObservation(districtSettled[1]!, 'telegram_groups', 'DISTRICT', district.id, evaluatedAt),
      handleSettledObservation(districtSettled[2]!, 'message_intake', 'DISTRICT', district.id, evaluatedAt),
      handleSettledObservation(districtSettled[3]!, 'ai_operations', 'DISTRICT', district.id, evaluatedAt),
      handleSettledObservation(districtSettled[4]!, 'district_retention', 'DISTRICT', district.id, evaluatedAt),
    ].map((c) => ({
      ...c,
      lifecycleStatus: district.status,
    }));

    // Synchronize operational issues strictly scoped to this district
    const districtMap = new Map<string, string>([[district.id, district.name]]);
    await synchronizeOperationalIssues(db, districtComponents, {
      districtMap,
      evaluationScope: { type: 'DISTRICT', districtId: district.id },
    });

    const aggregateResult = aggregateComponentStatuses(districtComponents, {
      isQuietAllowed: true,
      evaluatedAt,
    });

    return {
      districtId: district.id,
      districtName: district.name,
      status: aggregateResult.status,
      lastCheckAt: aggregateResult.lastCheckAt,
      evaluatedAt: evaluatedAt.toISOString(),
      components: districtComponents,
      lifecycleStatus: district.status,
    };
  },
};
