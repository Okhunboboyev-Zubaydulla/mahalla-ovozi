import {
  ComponentHealthObservation,
  DistrictHealthSummary,
  HealthStatus,
  OverallSystemHealthResponse,
} from '@mahalla-ovozi/api-contracts';

/**
 * Deterministic precedence of known abnormal states (AC 5).
 */
export const HEALTH_STATE_PRECEDENCE: readonly HealthStatus[] = [
  'Unavailable',
  'Degraded',
  'Delayed',
  'Unknown',
  'Healthy',
] as const;

/**
 * Intake source components capable of quiet silence (AC 5, AC 6).
 */
export const INTAKE_COMPONENT_TYPES = [
  'telegram_groups',
  'message_intake',
  'ai_operations',
] as const;

/**
 * Pilot freshness and delay thresholds (AC 7, AC 8).
 * Configurable via deployment environment variables without Console UI exposure.
 */
export const STALE_CHECK_THRESHOLD_MS =
  (parseInt(process.env.HEALTH_STALE_CHECK_SECONDS || '600', 10)) * 1000; // 10 min default
export const INTAKE_DELAY_THRESHOLD_MS =
  (parseInt(process.env.HEALTH_INTAKE_DELAY_SECONDS || '300', 10)) * 1000; // 5 min default
export const TOPIC_DELAY_THRESHOLD_MS =
  (parseInt(process.env.HEALTH_TOPIC_DELAY_SECONDS || '900', 10)) * 1000; // 15 min default

/**
 * Evaluates whether a technical check timestamp is fresh or stale.
 */
export function evaluateFreshness(
  lastCheckAt: Date | string | null,
  staleThresholdMs: number = STALE_CHECK_THRESHOLD_MS,
  now: Date = new Date(),
): boolean {
  if (!lastCheckAt) return false;
  const checkTime = typeof lastCheckAt === 'string' ? new Date(lastCheckAt).getTime() : lastCheckAt.getTime();
  if (Number.isNaN(checkTime)) return false;
  return now.getTime() - checkTime <= staleThresholdMs;
}

/**
 * Evaluates whether a processing timestamp exceeds an SLA delay threshold.
 */
export function evaluateThreshold(
  lastEvidenceAt: Date | string | null,
  thresholdMs: number,
  now: Date = new Date(),
): HealthStatus {
  if (!lastEvidenceAt) return 'Healthy';
  const evidenceTime = typeof lastEvidenceAt === 'string' ? new Date(lastEvidenceAt).getTime() : lastEvidenceAt.getTime();
  if (Number.isNaN(evidenceTime)) return 'Healthy';
  return now.getTime() - evidenceTime > thresholdMs ? 'Delayed' : 'Healthy';
}

/**
 * Aggregates component observations into a single health status and oldest lastCheckAt timestamp.
 */
export function aggregateComponentStatuses(
  components: ComponentHealthObservation[],
  options: {
    isQuietAllowed?: boolean;
    evaluatedAt?: Date;
  } = {},
): { status: HealthStatus; lastCheckAt: string } {
  const evaluatedAt = options.evaluatedAt || new Date();
  const applicable = components.filter((c) => c.isApplicable);

  if (applicable.length === 0) {
    return {
      status: 'Unknown',
      lastCheckAt: evaluatedAt.toISOString(),
    };
  }

  const validTimestamps = applicable
    .map((c) => new Date(c.lastCheckAt).getTime())
    .filter((t) => !Number.isNaN(t));

  const oldestCheckTimestamp =
    validTimestamps.length > 0
      ? Math.min(...validTimestamps)
      : evaluatedAt.getTime();

  const oldestCheckIso = new Date(oldestCheckTimestamp).toISOString();

  // Enforce deterministic precedence: Unavailable > Degraded > Delayed > Unknown (AC 5)
  if (applicable.some((c) => c.status === 'Unavailable')) {
    return { status: 'Unavailable', lastCheckAt: oldestCheckIso };
  }
  if (applicable.some((c) => c.status === 'Degraded')) {
    return { status: 'Degraded', lastCheckAt: oldestCheckIso };
  }
  if (applicable.some((c) => c.status === 'Delayed')) {
    return { status: 'Delayed', lastCheckAt: oldestCheckIso };
  }
  if (applicable.some((c) => c.status === 'Unknown')) {
    return { status: 'Unknown', lastCheckAt: oldestCheckIso };
  }

  // All applicable components are either Healthy or Quiet
  if (options.isQuietAllowed) {
    const intakeComponents = applicable.filter((c) =>
      (INTAKE_COMPONENT_TYPES as readonly string[]).includes(c.component),
    );
    const nonIntakeComponents = applicable.filter(
      (c) => !(INTAKE_COMPONENT_TYPES as readonly string[]).includes(c.component),
    );

    // District is Quiet ONLY when all applicable intake sources are Quiet and other components are Healthy
    const hasIntake = intakeComponents.length > 0;
    const allIntakeQuiet = hasIntake && intakeComponents.every((c) => c.status === 'Quiet');
    const allNonIntakeHealthy = nonIntakeComponents.every((c) => c.status === 'Healthy');

    if (allIntakeQuiet && allNonIntakeHealthy) {
      return { status: 'Quiet', lastCheckAt: oldestCheckIso };
    }
  }

  // Otherwise, Quiet is neutral with Healthy -> Healthy
  return { status: 'Healthy', lastCheckAt: oldestCheckIso };
}

/**
 * Aggregates overall system health from global components and district summaries.
 */
export function aggregateOverallSystemHealth(
  globalComponents: ComponentHealthObservation[],
  districts: DistrictHealthSummary[],
  evaluatedAt: Date = new Date(),
): OverallSystemHealthResponse {
  const globalResult = aggregateComponentStatuses(globalComponents, {
    isQuietAllowed: false,
    evaluatedAt,
  });

  const totalDistricts = districts.length;
  const activeDistricts = districts.filter(
    (d) => d.lifecycleStatus === 'ACTIVE' || d.lifecycleStatus === 'GRACE' || d.lifecycleStatus === null,
  ).length;

  if (totalDistricts === 0) {
    return {
      status: globalResult.status,
      lastCheckAt: globalResult.lastCheckAt,
      evaluatedAt: evaluatedAt.toISOString(),
      globalComponents,
      districts: [],
      totalDistricts: 0,
      activeDistricts: 0,
    };
  }

  // Calculate oldest lastCheckAt among global components and active districts (AC 13)
  const allContributingTimestamps: number[] = [
    ...globalComponents
      .filter((c) => c.isApplicable)
      .map((c) => new Date(c.lastCheckAt).getTime()),
    ...districts.map((d) => new Date(d.lastCheckAt).getTime()),
  ].filter((t) => !Number.isNaN(t));

  const oldestTimestamp =
    allContributingTimestamps.length > 0
      ? Math.min(...allContributingTimestamps)
      : evaluatedAt.getTime();

  const oldestCheckIso = new Date(oldestTimestamp).toISOString();

  // Combine global status with all district statuses
  const allStatuses: HealthStatus[] = [
    globalResult.status,
    ...districts.map((d) => d.status),
  ];

  let overallStatus: HealthStatus = 'Healthy';

  if (allStatuses.includes('Unavailable')) {
    overallStatus = 'Unavailable';
  } else if (allStatuses.includes('Degraded')) {
    overallStatus = 'Degraded';
  } else if (allStatuses.includes('Delayed')) {
    overallStatus = 'Delayed';
  } else if (allStatuses.includes('Unknown')) {
    overallStatus = 'Unknown';
  } else {
    // Check all-Quiet condition (AC 5)
    const allDistrictsQuiet = districts.every((d) => d.status === 'Quiet');
    const globalHealthy = globalResult.status === 'Healthy';

    if (allDistrictsQuiet && globalHealthy) {
      overallStatus = 'Quiet';
    } else {
      overallStatus = 'Healthy';
    }
  }

  return {
    status: overallStatus,
    lastCheckAt: oldestCheckIso,
    evaluatedAt: evaluatedAt.toISOString(),
    globalComponents,
    districts,
    totalDistricts,
    activeDistricts,
  };
}
