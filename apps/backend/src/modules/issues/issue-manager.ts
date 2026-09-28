import crypto from 'node:crypto';
import { eq, and, sql } from 'drizzle-orm';
import {
  ComponentHealthObservation,
  ComponentScope,
  ComponentType,
} from '@mahalla-ovozi/api-contracts';
import { DbClient } from '../../adapters/db/client.js';
import {
  operationalIssues,
  auditEvents,
  OperationalIssueEntity,
} from '../../adapters/db/schema/index.js';
import {
  classifyIssueSeverity,
  deriveIssueMetadata,
  generateLogicalKey,
} from './issue-evaluator.js';

export interface SynchronizeOptions {
  districtMap?: Map<string, string>;
  evaluationScope?:
    | { type: 'GLOBAL' }
    | { type: 'DISTRICT'; districtId: string }
    | { type: 'SYSTEM' };
}

export interface SynchronizeResult {
  created: number;
  updated: number;
  resolved: number;
}

/**
 * True only when the issue's own four identity fields regenerate its logicalKey.
 * Health-sync issues satisfy this by construction; issues minted by other
 * subsystems with a bespoke logicalKey do not, and must never be resolved by a
 * health probe that merely shares their (scope, districtId, component) tuple.
 */
function isHealthSyncOwnedIssue(issue: OperationalIssueEntity): boolean {
  const canonicalKey = generateLogicalKey(
    issue.scope as ComponentScope,
    issue.districtId,
    issue.component as ComponentType,
    issue.issueCategory,
  );
  return canonicalKey === issue.logicalKey;
}

/**
 * Transactional manager for synchronizing operational issues with health observations (Story 4.2 AC 1, 6, 8, 9, 10, 11, 13).
 * Ensures atomic state transitions and audit log persistence in a single transaction.
 */
export async function synchronizeOperationalIssues(
  db: DbClient,
  observations: ComponentHealthObservation[],
  options: SynchronizeOptions = {},
): Promise<SynchronizeResult> {
  const now = new Date();
  const districtMap = options.districtMap || new Map<string, string>();
  const evaluationScope = options.evaluationScope || { type: 'SYSTEM' };

  return await db.transaction(async (tx) => {
    let created = 0;
    let updated = 0;
    let resolved = 0;

    // 1. Fetch currently active issues matching the evaluationScope with lock
    let existingActiveQuery = tx
      .select()
      .from(operationalIssues)
      .where(eq(operationalIssues.status, 'ACTIVE'))
      .for('update');

    let activeIssuesList: OperationalIssueEntity[];

    if (evaluationScope.type === 'GLOBAL') {
      activeIssuesList = await tx
        .select()
        .from(operationalIssues)
        .where(
          and(
            eq(operationalIssues.status, 'ACTIVE'),
            eq(operationalIssues.scope, 'GLOBAL'),
          ),
        )
        .for('update');
    } else if (evaluationScope.type === 'DISTRICT') {
      activeIssuesList = await tx
        .select()
        .from(operationalIssues)
        .where(
          and(
            eq(operationalIssues.status, 'ACTIVE'),
            eq(operationalIssues.scope, 'DISTRICT'),
            eq(operationalIssues.districtId, evaluationScope.districtId),
          ),
        )
        .for('update');
    } else {
      activeIssuesList = await existingActiveQuery;
    }

    // Map active issues by logicalKey for fast lookup
    const activeByLogicalKey = new Map<string, OperationalIssueEntity>();
    for (const issue of activeIssuesList) {
      activeByLogicalKey.set(issue.logicalKey, issue);
    }

    // Keep track of logicalKeys processed as failed in this check
    const processedFailedKeys = new Set<string>();

    // 2. Step 1: Process incoming observations that evaluate to failure issues
    for (const obs of observations) {
      const severity = classifyIssueSeverity(obs);
      if (!severity) {
        continue;
      }

      const districtName = obs.districtId
        ? districtMap.get(obs.districtId) || null
        : null;
      const meta = deriveIssueMetadata(obs, districtName);
      const logicalKey = generateLogicalKey(
        obs.scope,
        obs.districtId,
        obs.component,
        meta.issueCategory,
      );
      processedFailedKeys.add(logicalKey);

      const safeMetadata: Record<string, unknown> = {
        outcome: obs.outcome,
        errorCode: obs.errorCode,
        latencyMs: obs.latencyMs,
        errorMessage: obs.errorMessage,
      };

      const existingIssue = activeByLogicalKey.get(logicalKey);

      if (existingIssue) {
        // Continuing issue: update latest check metadata without duplicate failure audit event (AC 1, AC 6)
        const mergedMetadata = {
          ...(existingIssue.metadata || {}),
          ...safeMetadata,
        };

        await tx
          .update(operationalIssues)
          .set({
            latestCheckAt: now,
            healthStatus: obs.status,
            severity,
            sanitizedTitle: meta.sanitizedTitle,
            sanitizedDescription: meta.sanitizedDescription,
            recommendedAction: meta.recommendedAction,
            targetRoute: meta.targetRoute,
            metadata: mergedMetadata,
            updatedAt: now,
          })
          .where(eq(operationalIssues.id, existingIssue.id));

        updated++;
      } else {
        // New issue: insert into operational_issues and emit failure-start audit record atomically (AC 10)
        // Uses native onConflictDoUpdate with partial index targetWhere to prevent transaction abort on concurrent races
        const issueId = crypto.randomUUID();

        const [upsertedIssue] = await tx
          .insert(operationalIssues)
          .values({
            id: issueId,
            logicalKey,
            scope: obs.scope,
            districtId: obs.districtId,
            component: obs.component,
            issueCategory: meta.issueCategory,
            severity,
            status: 'ACTIVE',
            healthStatus: obs.status,
            sanitizedTitle: meta.sanitizedTitle,
            sanitizedDescription: meta.sanitizedDescription,
            recommendedAction: meta.recommendedAction,
            targetRoute: meta.targetRoute,
            metadata: safeMetadata,
            startedAt: now,
            latestCheckAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: operationalIssues.logicalKey,
            targetWhere: sql`${operationalIssues.status} = 'ACTIVE'`,
            set: {
              latestCheckAt: now,
              healthStatus: obs.status,
              severity,
              sanitizedTitle: meta.sanitizedTitle,
              sanitizedDescription: meta.sanitizedDescription,
              recommendedAction: meta.recommendedAction,
              targetRoute: meta.targetRoute,
              metadata: sql`COALESCE(${operationalIssues.metadata}, '{}'::jsonb) || ${JSON.stringify(safeMetadata)}::jsonb`,
              updatedAt: now,
            },
          })
          .returning();

        if (upsertedIssue && upsertedIssue.id === issueId) {
          // Newly created issue: insert atomic audit event with canonical system actor (AC 10, AC 13)
          await tx.insert(auditEvents).values({
            id: crypto.randomUUID(),
            districtId: obs.districtId,
            actorId: 'system:health-monitor',
            actorRole: 'SYSTEM',
            action: 'OPERATIONAL_ISSUE_DETECTED',
            metadata: {
              issueId,
              logicalKey,
              scope: obs.scope,
              districtId: obs.districtId,
              component: obs.component,
              issueCategory: meta.issueCategory,
              severity,
              healthStatus: obs.status,
              startedAt: now.toISOString(),
            },
            createdAt: now,
          });

          created++;
        } else {
          updated++;
        }
      }
    }

    // 3. Step 2: Evaluate verified recovery for active issues matching the evaluationScope (AC 8, AC 9, AC 11)
    for (const existingIssue of activeIssuesList) {
      // If already processed as failed in Step 1, it is still failing
      if (processedFailedKeys.has(existingIssue.logicalKey)) {
        continue;
      }

      // Foreign-keyed issues (deletion lifecycle, restore reconciliation) are not
      // owned by the health sync; a probe sharing their tuple must not resolve them.
      if (!isHealthSyncOwnedIssue(existingIssue)) {
        continue;
      }

      // Find matching observation in current check
      const matchingObs = observations.find(
        (o) =>
          o.scope === existingIssue.scope &&
          (o.districtId || null) === (existingIssue.districtId || null) &&
          o.component === existingIssue.component,
      );

      if (!matchingObs) {
        // No matching observation in this run (e.g. out-of-scope check) -> preserve active state
        continue;
      }

      if (matchingObs.status === 'Healthy' || matchingObs.status === 'Quiet') {
        // Verified recovery condition met! Transition issue to RESOLVED (AC 9, AC 11)
        await tx
          .update(operationalIssues)
          .set({
            status: 'RESOLVED',
            resolvedAt: now,
            healthStatus: matchingObs.status,
            updatedAt: now,
          })
          .where(eq(operationalIssues.id, existingIssue.id));

        const durationMs = Math.max(
          0,
          now.getTime() - new Date(existingIssue.startedAt).getTime(),
        );

        // Atomically insert verified-recovery audit log (AC 11, AC 13)
        await tx.insert(auditEvents).values({
          id: crypto.randomUUID(),
          districtId: existingIssue.districtId,
          actorId: 'system:health-monitor',
          actorRole: 'SYSTEM',
          action: 'OPERATIONAL_ISSUE_RESOLVED',
          metadata: {
            issueId: existingIssue.id,
            logicalKey: existingIssue.logicalKey,
            scope: existingIssue.scope,
            districtId: existingIssue.districtId,
            component: existingIssue.component,
            issueCategory: existingIssue.issueCategory,
            resolvedAt: now.toISOString(),
            durationMs,
          },
          createdAt: now,
        });

        resolved++;
      }
      // If matchingObs.status === 'Unknown', preserve active state (AC 7: stale/insufficient evidence creates no false recovery)
    }

    return { created, updated, resolved };
  });
}
