import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type PgBoss from 'pg-boss';
import type pg from 'pg';
import {
  UpdateDistrictSubscriptionRequestSchema,
  StartGraceRequestSchema,
  RestoreActiveRequestSchema,
  CancelDistrictRequestSchema,
  StartRecoveryRequestSchema,
  ReconcileDisasterRestoreRequestSchema,
  type ListDistrictSubscriptionsResponse,
  type GetDistrictSubscriptionResponse,
  type UpdateDistrictSubscriptionResponse,
  type StartGraceResponse,
  type RestoreActiveResponse,
  type CancelDistrictResponse,
  type StartRecoveryResponse,
  type ExecuteLiveDeletionResponse,
  type VerifyBackupExpiryResponse,
  type ReconcileDisasterRestoreResponse,
} from '@mahalla-ovozi/api-contracts';
import { DbClient, createDbPool } from '../../adapters/db/client.js';
import { verifyStateChangingOrigin } from '../auth/origin-guard.js';
import { createRequireProductOwner } from '../auth/require-product-owner.js';
import { getClientInfo } from '../auth/client-info.js';
import { DistrictNotFoundError } from '../districts/districts-service.js';
import { DistrictNotReadyForActivationError } from '../districts/district-onboarding-engine.js';
import {
  listDistrictSubscriptions,
  getDistrictSubscription,
  updateDistrictSubscriptionMetadata,
  startDistrictGrace,
  restoreDistrictActive,
  cancelDistrict,
  startDistrictRecovery,
  InvalidSubscriptionTransitionError,
  SubscriptionConcurrencyConflictError,
  DistrictConfirmationMismatchError,
  RecoveryWindowExpiredError,
} from './subscriptions-service.js';
import {
  executeDistrictLiveDeletion,
  getDistrictDeletionRecord,
  verifyDistrictBackupExpiry,
  DistrictAlreadyDeletedError,
  DistrictNotEligibleForDeletionError,
  DeletionRecordNotFoundError,
} from './district-deletion-service.js';
import type { BackupRetentionVerifier } from './ports/backup-retention-verifier.js';
import { SystemBackupRetentionVerifier } from '../../adapters/backup/system-backup-verifier.js';
import type { ExternalTombstoneStore } from './ports/external-tombstone-store.port.js';
import { FileExternalTombstoneStore } from '../../adapters/storage/external-tombstone-store.js';
import { reconcileDisasterRestore } from '../retention/restore-reconciliation.js';

export interface SubscriptionRoutesDeps {
  db: DbClient;
  pool?: pg.Pool;
  boss?: PgBoss;
  backupVerifier?: BackupRetentionVerifier;
  tombstoneStore?: ExternalTombstoneStore;
}

export function registerSubscriptionRoutes(
  fastify: FastifyInstance,
  depsOrDb: DbClient | SubscriptionRoutesDeps,
  maybeBoss?: PgBoss,
): void {
  const db = 'db' in depsOrDb ? depsOrDb.db : depsOrDb;
  const boss = 'boss' in depsOrDb ? depsOrDb.boss : maybeBoss;

  fastify.register(async (scope) => {
    scope.addHook('preHandler', verifyStateChangingOrigin);
    scope.addHook('preHandler', createRequireProductOwner(db));

    // 1. List all district subscriptions
    scope.get('/api/v1/subscriptions', async (_req: FastifyRequest, reply: FastifyReply) => {
      const subscriptions = await listDistrictSubscriptions(db);
      const response: ListDistrictSubscriptionsResponse = { subscriptions };
      return reply.status(200).send(response);
    });

    // 2. Get single district subscription
    scope.get(
      '/api/v1/districts/:districtId/subscription',
      async (req: FastifyRequest<{ Params: { districtId: string } }>, reply: FastifyReply) => {
        const { districtId } = req.params;
        try {
          const subscription = await getDistrictSubscription(db, districtId);
          const response: GetDistrictSubscriptionResponse = { subscription };
          return reply.status(200).send(response);
        } catch (err: unknown) {
          if (err instanceof DistrictNotFoundError) {
            return reply.status(404).send({
              error: {
                code: err.code,
                message: err.message,
              },
            });
          }
          throw err;
        }
      },
    );

    // 3. Update district subscription metadata
    scope.patch(
      '/api/v1/districts/:districtId/subscription',
      async (
        req: FastifyRequest<{ Params: { districtId: string }; Body: unknown }>,
        reply: FastifyReply,
      ) => {
        const { districtId } = req.params;
        const parseResult = UpdateDistrictSubscriptionRequestSchema.safeParse(req.body);
        if (!parseResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: parseResult.error.errors[0]?.message || 'Обуна маълумотлари нотўғри.',
              details: parseResult.error.errors,
            },
          });
        }

        try {
          const subscription = await updateDistrictSubscriptionMetadata(
            db,
            districtId,
            parseResult.data,
            req.actor,
            getClientInfo(req),
          );

          const response: UpdateDistrictSubscriptionResponse = {
            subscription,
            message: 'Обуна маълумотлари муваффақиятли сақланди.',
          };
          return reply.status(200).send(response);
        } catch (err: unknown) {
          if (err instanceof DistrictNotFoundError) {
            return reply.status(404).send({
              error: {
                code: err.code,
                message: err.message,
              },
            });
          }
          throw err;
        }
      },
    );

    // 4. Start grace period
    scope.post(
      '/api/v1/districts/:districtId/subscription/start-grace',
      async (
        req: FastifyRequest<{ Params: { districtId: string }; Body: unknown }>,
        reply: FastifyReply,
      ) => {
        const { districtId } = req.params;
        const parseResult = StartGraceRequestSchema.safeParse(req.body || {});
        if (!parseResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: parseResult.error.errors[0]?.message || 'Имтиёзли давр маълумотлари нотўғри.',
              details: parseResult.error.errors,
            },
          });
        }

        try {
          const subscription = await startDistrictGrace(
            db,
            boss,
            districtId,
            parseResult.data,
            req.actor,
            getClientInfo(req),
          );

          const response: StartGraceResponse = {
            subscription,
            message: 'Туман учун 7 кунлик имтиёзли давр (Grace) бошланди.',
          };
          return reply.status(200).send(response);
        } catch (err: unknown) {
          if (err instanceof DistrictNotFoundError) {
            return reply.status(404).send({
              error: {
                code: err.code,
                message: err.message,
              },
            });
          }
          if (
            err instanceof InvalidSubscriptionTransitionError ||
            err instanceof SubscriptionConcurrencyConflictError
          ) {
            return reply.status(409).send({
              error: {
                code: err.code,
                message: err.message,
              },
            });
          }
          throw err;
        }
      },
    );

    // 5. Restore active service
    scope.post(
      '/api/v1/districts/:districtId/subscription/restore-active',
      async (
        req: FastifyRequest<{ Params: { districtId: string }; Body: unknown }>,
        reply: FastifyReply,
      ) => {
        const { districtId } = req.params;
        const parseResult = RestoreActiveRequestSchema.safeParse(req.body || {});
        if (!parseResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: parseResult.error.errors[0]?.message || 'Фаоллаштириш маълумотлари нотўғри.',
              details: parseResult.error.errors,
            },
          });
        }

        try {
          const subscription = await restoreDistrictActive(
            db,
            districtId,
            parseResult.data,
            req.actor,
            getClientInfo(req),
          );

          const response: RestoreActiveResponse = {
            subscription,
            message: 'Туман фаолияти (Active) муваффақиятли тикланди.',
          };
          return reply.status(200).send(response);
        } catch (err: unknown) {
          if (err instanceof DistrictNotFoundError) {
            return reply.status(404).send({
              error: {
                code: err.code,
                message: err.message,
              },
            });
          }
          if (err instanceof DistrictNotReadyForActivationError) {
            return reply.status(409).send({
              error: {
                code: err.code,
                message: err.message,
                blockers: err.blockers,
                details: { blockers: err.blockers },
              },
            });
          }
          if (
            err instanceof InvalidSubscriptionTransitionError ||
            err instanceof SubscriptionConcurrencyConflictError
          ) {
            return reply.status(409).send({
              error: {
                code: err.code,
                message: err.message,
              },
            });
          }
          throw err;
        }
      },
    );

    // 6. Cancel district
    scope.post(
      '/api/v1/districts/:districtId/subscription/cancel',
      async (
        req: FastifyRequest<{ Params: { districtId: string }; Body: unknown }>,
        reply: FastifyReply,
      ) => {
        const { districtId } = req.params;
        const parseResult = CancelDistrictRequestSchema.safeParse(req.body || {});
        if (!parseResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: parseResult.error.errors[0]?.message || 'Бекор қилиш маълумотлари нотўғри.',
              details: parseResult.error.errors,
            },
          });
        }

        try {
          const subscription = await cancelDistrict(
            db,
            boss,
            districtId,
            parseResult.data,
            req.actor,
            getClientInfo(req),
          );

          const response: CancelDistrictResponse = {
            subscription,
            message: 'Туман муваффақиятли бекор қилинди (Cancelled).',
          };
          return reply.status(200).send(response);
        } catch (err: unknown) {
          if (err instanceof DistrictNotFoundError) {
            return reply.status(404).send({
              error: {
                code: err.code,
                message: err.message,
              },
            });
          }
          if (err instanceof DistrictConfirmationMismatchError) {
            return reply.status(400).send({
              error: {
                code: err.code,
                message: err.message,
              },
            });
          }
          if (
            err instanceof InvalidSubscriptionTransitionError ||
            err instanceof SubscriptionConcurrencyConflictError
          ) {
            return reply.status(409).send({
              error: {
                code: err.code,
                message: err.message,
              },
            });
          }
          throw err;
        }
      },
    );

    // 7. Start district recovery
    scope.post(
      '/api/v1/districts/:districtId/subscription/start-recovery',
      async (
        req: FastifyRequest<{ Params: { districtId: string }; Body: unknown }>,
        reply: FastifyReply,
      ) => {
        const { districtId } = req.params;
        const parseResult = StartRecoveryRequestSchema.safeParse(req.body || {});
        if (!parseResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: parseResult.error.errors[0]?.message || 'Тиклаш маълумотлари нотўғри.',
              details: parseResult.error.errors,
            },
          });
        }

        try {
          const subscription = await startDistrictRecovery(
            db,
            districtId,
            parseResult.data,
            req.actor,
            getClientInfo(req),
          );

          const response: StartRecoveryResponse = {
            subscription,
            message: 'Туманни қайта тиклаш жараёни бошланди (Setup Incomplete).',
          };
          return reply.status(200).send(response);
        } catch (err: unknown) {
          if (err instanceof DistrictNotFoundError) {
            return reply.status(404).send({
              error: {
                code: err.code,
                message: err.message,
              },
            });
          }
          if (
            err instanceof RecoveryWindowExpiredError ||
            err instanceof DistrictAlreadyDeletedError ||
            err instanceof InvalidSubscriptionTransitionError ||
            err instanceof SubscriptionConcurrencyConflictError
          ) {
            return reply.status(409).send({
              error: {
                code: err.code,
                message: err.message,
              },
            });
          }
          throw err;
        }
      },
    );

    // 8. Execute live deletion immediately (Product Owner authorized)
    scope.post(
      '/api/v1/districts/:districtId/subscription/execute-live-deletion',
      async (
        req: FastifyRequest<{ Params: { districtId: string }; Body: unknown }>,
        reply: FastifyReply,
      ) => {
        const { districtId } = req.params;
        try {
          const deletionRecord = await executeDistrictLiveDeletion(db, districtId, {
            bypassDeadlineCheck: false,
            boss,
            actor: req.actor ? { id: req.actor.id, role: req.actor.role } : undefined,
            context: getClientInfo(req),
          });

          if (!deletionRecord) {
            return reply.status(409).send({
              error: {
                code: 'DISTRICT_NOT_ELIGIBLE_FOR_DELETION',
                message: 'Туман ўчириш талабларига жавоб бермайди ёки ҳолати ўзгарган.',
              },
            });
          }

          const response: ExecuteLiveDeletionResponse = {
            deletionRecord,
            message: 'Туман маълумотлари жонли тизимдан бутунлай ўчирилди.',
          };
          return reply.status(200).send(response);
        } catch (err: unknown) {
          if (err instanceof DistrictNotFoundError) {
            return reply.status(404).send({
              error: {
                code: err.code,
                message: err.message,
              },
            });
          }
          if (
            err instanceof DistrictNotEligibleForDeletionError ||
            err instanceof DistrictAlreadyDeletedError
          ) {
            return reply.status(409).send({
              error: {
                code: err.code,
                message: err.message,
              },
            });
          }
          throw err;
        }
      },
    );

    // 9. Get surviving deletion record tombstone
    scope.get(
      '/api/v1/districts/:districtId/deletion-record',
      async (
        req: FastifyRequest<{ Params: { districtId: string } }>,
        reply: FastifyReply,
      ) => {
        const { districtId } = req.params;
        const deletionRecord = await getDistrictDeletionRecord(db, districtId);
        if (!deletionRecord) {
          return reply.status(404).send({
            error: {
              code: 'DELETION_RECORD_NOT_FOUND',
              message: 'Туман ўчирилганлик маълумотномаси топилмади.',
            },
          });
        }
        return reply.status(200).send({ deletionRecord });
      },
    );

    // 10. Verify protected-backup expiry (Story 6.5)
    scope.post(
      '/api/v1/districts/:districtId/deletion-record/verify-backup-expiry',
      async (
        req: FastifyRequest<{ Params: { districtId: string } }>,
        reply: FastifyReply,
      ) => {
        const { districtId } = req.params;
        const verifier =
          ('backupVerifier' in depsOrDb && depsOrDb.backupVerifier) ||
          new SystemBackupRetentionVerifier();

        try {
          const result = await verifyDistrictBackupExpiry(db, verifier, districtId, {
            actor: req.actor ? { id: req.actor.id, role: req.actor.role } : undefined,
            context: getClientInfo(req),
          });

          const response: VerifyBackupExpiryResponse = {
            deletionRecord: result.deletionRecord,
            isExpired: result.isExpired,
            message: result.message,
          };
          return reply.status(200).send(response);
        } catch (err: unknown) {
          if (
            err instanceof DistrictNotFoundError ||
            err instanceof DeletionRecordNotFoundError
          ) {
            return reply.status(404).send({
              error: {
                code: err.code,
                message: err.message,
              },
            });
          }
          if (err instanceof DistrictNotEligibleForDeletionError) {
            return reply.status(409).send({
              error: {
                code: err.code,
                message: err.message,
              },
            });
          }
          throw err;
        }
      },
    );

    // 11. Reconcile Disaster Restore (Story 6.6)
    scope.post(
      '/api/v1/system/reconcile-disaster-restore',
      async (
        req: FastifyRequest<{ Body: unknown }>,
        reply: FastifyReply,
      ) => {
        const parseResult = ReconcileDisasterRestoreRequestSchema.safeParse(req.body || {});
        if (!parseResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: parseResult.error.errors[0]?.message || 'Сўров параметрлари нотўғри.',
              details: parseResult.error.errors,
            },
          });
        }

        if (!boss) {
          return reply.status(503).send({
            error: {
              code: 'QUEUE_UNAVAILABLE',
              message: 'Навбат хизмати (pg-boss) фаол эмас.',
            },
          });
        }

        const isCustomPool = !('pool' in depsOrDb && depsOrDb.pool);
        const pool = ('pool' in depsOrDb && depsOrDb.pool) || createDbPool();
        const store =
          ('tombstoneStore' in depsOrDb && depsOrDb.tombstoneStore) ||
          new FileExternalTombstoneStore();

        try {
          const result = await reconcileDisasterRestore(pool, boss, db, {
            dryRun: parseResult.data.dryRun,
            tombstoneStore: store,
            actor: req.actor ? { id: req.actor.id, role: req.actor.role } : undefined,
            context: getClientInfo(req),
          });

          const response: ReconcileDisasterRestoreResponse = {
            result,
            message: 'Фалокатдан сўнг маълумотларни мувофиқлаштириш муваффақиятли якунланди.',
          };
          return reply.status(200).send(response);
        } catch (err: unknown) {
          return reply.status(500).send({
            error: {
              code: 'DISASTER_RESTORE_RECONCILIATION_FAILED',
              message:
                err instanceof Error
                  ? err.message
                  : 'Фалокатдан сўнг маълумотларни мувофиқлаштиришда хатолик юз берди.',
            },
          });
        } finally {
          if (isCustomPool) {
            await pool.end().catch(() => {});
          }
        }
      },
    );
  });
}

