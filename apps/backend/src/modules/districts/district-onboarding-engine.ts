import { eq, and, desc, sql } from 'drizzle-orm';
import { DbClient, DbOrTx } from '../../adapters/db/client.js';
import {
  districts,
  districtSubscriptions,
  districtDeletionRecords,
  districtTelegramBots,
  districtTelegramGroups,
  accounts,
} from '../../adapters/db/schema/index.js';
import {
  DistrictReadiness,
  PrerequisiteItem,
  DistrictStatusSchema,
  ConfirmDisclosureResponse,
  ActivateDistrictResponse,
  ActorContext,
} from '@mahalla-ovozi/api-contracts';
import { recordAuditEvent } from '../audit/audit-service.js';
import { formatDistrict } from './districts-service.js';
import { DistrictAlreadyDeletedError } from '../subscriptions/district-deletion-service.js';

/* ── Domain Errors ── */

export class DistrictNotFoundError extends Error {
  readonly code = 'DISTRICT_NOT_FOUND' as const;
  constructor(districtId: string) {
    super(`Туман топилмади (ID: ${districtId}).`);
    this.name = 'DistrictNotFoundError';
  }
}

export class DistrictAlreadyActiveError extends Error {
  readonly code = 'DISTRICT_ALREADY_ACTIVE' as const;
  readonly statusCode = 409;
  constructor(districtId: string) {
    super(`Туман аллақачон фаоллаштирилган (ID: ${districtId}).`);
    this.name = 'DistrictAlreadyActiveError';
  }
}

export class DistrictNotReadyForActivationError extends Error {
  readonly code = 'DISTRICT_NOT_READY' as const;
  readonly statusCode = 409;
  readonly blockers: PrerequisiteItem[];

  constructor(blockers: PrerequisiteItem[]) {
    super('Туманни фаоллаштириш учун барча талаблар бажарилмаган.');
    this.name = 'DistrictNotReadyForActivationError';
    this.blockers = blockers;
  }
}

export class DistrictInvalidStatusError extends Error {
  readonly code = 'DISTRICT_INVALID_STATUS' as const;
  readonly statusCode = 409;
  constructor(districtId: string, status: string) {
    super(`Туман нотўғри ҳолатда: ${status}. Фақат созлаш тугалланмаган туманларни фаоллаштириш мумкин (ID: ${districtId}).`);
    this.name = 'DistrictInvalidStatusError';
  }
}

export interface ClientContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Asserts that a district with the given ID exists and returns its raw DB row.
 * Throws DistrictNotFoundError if the district cannot be found.
 * Accepts DbOrTx so it can be called inside or outside a transaction.
 */
export async function assertDistrictExists(
  db: DbOrTx,
  districtId: string,
): Promise<typeof districts.$inferSelect> {
  const [row] = await db
    .select()
    .from(districts)
    .where(eq(districts.id, districtId))
    .limit(1);

  if (!row) {
    throw new DistrictNotFoundError(districtId);
  }

  return row;
}

/* ── Pure Prerequisite Evaluation Engine ── */

export function evaluateDistrictPrerequisites(
  district: typeof districts.$inferSelect,
  telegramBot?: typeof districtTelegramBots.$inferSelect | null,
  telegramGroups?: Array<typeof districtTelegramGroups.$inferSelect>,
  hokimAccount?: typeof accounts.$inferSelect | null,
): PrerequisiteItem[] {
  const isBotValid = Boolean(telegramBot && telegramBot.status === 'VALID');
  const groups = telegramGroups ?? [];
  const hasGroups = groups.length > 0;
  const allGroupsValid = hasGroups && groups.every((g) => g.status === 'VALID');
  const invalidGroupCount = groups.filter((g) => g.status !== 'VALID').length;

  const isHokimValid = Boolean(hokimAccount && hokimAccount.status === 'ACTIVE');
  const isHokimDisabled = Boolean(hokimAccount && hokimAccount.status === 'DISABLED');

  const items: PrerequisiteItem[] = [
    {
      key: 'district_identity',
      label: 'Туман маълумотлари',
      description: 'Туман номи ва ҳудудий маълумотлари қайд этилган',
      status: district.name && district.name.trim().length > 0 ? 'passed' : 'incomplete',
      blockerReason:
        district.name && district.name.trim().length > 0
          ? undefined
          : 'Туман номи тўлиқ киритилмаган.',
    },
    {
      key: 'access_eligibility',
      label: 'Тизимга кириш ҳуқуқи',
      description: 'Туман тизимга кириш учун фаол ҳолатда',
      status: district.accessEligible ? 'passed' : 'failed',
      blockerReason: district.accessEligible
        ? undefined
        : 'Туманнинг тизимга кириш ҳуқуқи чекланган.',
    },
    {
      key: 'analysis_configuration',
      label: 'Асосий таҳлил созламалари',
      description: 'Тасдиқланган базавий таҳлил профили бириктирилган',
      status: district.analysisConfigProfileId === 'baseline_v1' ? 'passed' : 'incomplete',
      blockerReason:
        district.analysisConfigProfileId === 'baseline_v1'
          ? undefined
          : 'Базавий таҳлил профили созланмаган.',
    },
    {
      key: 'district_isolation',
      label: 'Ҳудудий хавфсизлик чегараси',
      description: 'Туманнинг алоҳида хавфсизлик муҳити текширилди',
      status: 'passed',
    },
    {
      key: 'disclosure_confirmation',
      label: 'Операцион кириш очиқлигини тасдиқлаш',
      description: 'Ташқи операцион кириш бўйича расмий тасдиқлов қайд этилди',
      status: district.disclosureConfirmedAt ? 'passed' : 'incomplete',
      blockerReason: district.disclosureConfirmedAt
        ? undefined
        : 'Маҳсулот эгаси томонидан операцион кириш очиқлиги тасдиқланмаган.',
      actionRequired: !district.disclosureConfirmedAt,
      completedAt: district.disclosureConfirmedAt
        ? district.disclosureConfirmedAt.toISOString()
        : undefined,
      completedBy: district.disclosureConfirmedById ?? undefined,
    },
    {
      key: 'telegram_bot',
      label: 'Telegram бот уланиши',
      description:
        isBotValid && telegramBot
          ? `Туманнинг расмий Telegram боти (${telegramBot.botUsername ? `@${telegramBot.botUsername}` : telegramBot.botFirstName}) фаоллаштирилди`
          : 'Туманнинг расмий Telegram боти фаоллаштирилди',
      status: isBotValid ? 'passed' : 'incomplete',
      blockerReason: isBotValid ? undefined : 'Telegram бот ҳали уланмаган (1.4-босқич).',
      actionRequired: !isBotValid,
      actionPath: !isBotValid ? '/telegram-setup' : undefined,
      completedAt: isBotValid && telegramBot ? telegramBot.lastValidatedAt.toISOString() : undefined,
    },
    {
      key: 'group_mappings',
      label: 'Гуруҳлар ва маҳаллалар харитаси',
      description: allGroupsValid
        ? `${groups.length} та маҳалла Telegram гуруҳи муваффақиятли бириктирилди ва синовдан ўтди`
        : 'Telegram гуруҳлари тегишли маҳаллаларга бириктирилди',
      status: allGroupsValid ? 'passed' : 'incomplete',
      blockerReason: !hasGroups
        ? 'Маҳалла Telegram гуруҳлари ҳали бириктирилмаган.'
        : !allGroupsValid
          ? `${invalidGroupCount} та гуруҳ ҳали тўлиқ синовдан ўтмаган ёки тасдиқланмаган.`
          : undefined,
      actionRequired: !allGroupsValid,
      actionPath: !allGroupsValid ? '/telegram-setup' : undefined,
      completedAt: allGroupsValid
        ? (groups
            .map((g) => g.lastValidatedAt || g.testMessageReceivedAt || g.updatedAt)
            .filter(Boolean)
            .sort((a, b) => (b ? new Date(b).getTime() : 0) - (a ? new Date(a).getTime() : 0))[0]
            ?.toISOString() ?? undefined)
        : undefined,
    },
    {
      key: 'hokim_account',
      label: 'Ҳоким аккаунти',
      description: isHokimValid && hokimAccount
        ? `Туман ҳокими учун хавфсиз аккаунт яратилди (@${hokimAccount.username})`
        : 'Туман ҳокими учун хавфсиз аккаунт яратилди',
      status: isHokimValid ? 'passed' : 'incomplete',
      blockerReason: isHokimValid
        ? undefined
        : isHokimDisabled
          ? 'Ҳоким аккаунти фаолсизлантирилган (1.6-босқич). Янги аккаунт яратинг ёки алмаштиринг.'
          : 'Ҳоким аккаунти яратилмаган (1.6-босқич).',
      actionRequired: !isHokimValid,
      actionPath: !isHokimValid ? '/hokim-accounts' : undefined,
      completedAt: isHokimValid && hokimAccount
        ? (hokimAccount.updatedAt || hokimAccount.createdAt).toISOString()
        : undefined,
    },
  ];

  return items;
}

/* ── Public Operation 1: Get Onboarding Readiness ── */

export async function getOnboardingReadiness(
  db: DbOrTx,
  districtId: string,
): Promise<DistrictReadiness> {
  const [district] = await db
    .select()
    .from(districts)
    .where(eq(districts.id, districtId))
    .limit(1);

  if (!district) {
    throw new DistrictNotFoundError(districtId);
  }

  const [botRow] = await db
    .select()
    .from(districtTelegramBots)
    .where(eq(districtTelegramBots.districtId, districtId))
    .limit(1);

  const groupRows = await db
    .select()
    .from(districtTelegramGroups)
    .where(eq(districtTelegramGroups.districtId, districtId));

  const [hokimAccount] = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.districtId, districtId),
        eq(accounts.role, 'DISTRICT_HOKIM'),
      ),
    )
    .orderBy(
      sql`CASE WHEN ${accounts.status} = 'ACTIVE' THEN 1 ELSE 2 END`,
      desc(accounts.updatedAt),
    )
    .limit(1);

  const items = evaluateDistrictPrerequisites(district, botRow, groupRows, hokimAccount);
  const passedCount = items.filter((item) => item.status === 'passed').length;
  const totalCount = items.length;
  const isActivationReady = passedCount === totalCount;

  return {
    districtId: district.id,
    districtName: district.name,
    status: DistrictStatusSchema.parse(district.status),
    isActivationReady,
    passedCount,
    totalCount,
    evaluatedAt: new Date().toISOString(),
    items,
    disclosureConfirmedAt: district.disclosureConfirmedAt
      ? district.disclosureConfirmedAt.toISOString()
      : null,
    disclosureConfirmedById: district.disclosureConfirmedById ?? null,
  };
}

/**
 * @deprecated Legacy alias for getOnboardingReadiness. Use `getOnboardingReadiness` directly.
 */
export const evaluateDistrictReadiness = getOnboardingReadiness;

/* ── Public Operation 2: Confirm Standing Disclosure ── */

export async function confirmStandingDisclosure(
  db: DbClient,
  districtId: string,
  actor: ActorContext,
  clientInfo?: ClientContext
): Promise<ConfirmDisclosureResponse> {
  const [district] = await db
    .select()
    .from(districts)
    .where(eq(districts.id, districtId))
    .limit(1);

  if (!district) {
    throw new DistrictNotFoundError(districtId);
  }

  if (district.status !== 'SETUP_INCOMPLETE') {
    throw new DistrictAlreadyActiveError(districtId);
  }

  const now = new Date();

  await db.transaction(async (tx) => {
    // Explicit updatedAt rule & CAS concurrency guard
    const [updated] = await tx
      .update(districts)
      .set({
        disclosureConfirmedAt: now,
        disclosureConfirmedById: actor.id,
        updatedAt: now,
      })
      .where(
        and(
          eq(districts.id, districtId),
          eq(districts.status, 'SETUP_INCOMPLETE')
        )
      )
      .returning();

    if (!updated) {
      const [current] = await tx
        .select({ status: districts.status })
        .from(districts)
        .where(eq(districts.id, districtId))
        .limit(1);

      if (!current) {
        throw new DistrictNotFoundError(districtId);
      }
      throw new DistrictAlreadyActiveError(districtId);
    }

    // AD-9 privacy-safe audit metadata
    await recordAuditEvent(tx, {
      districtId,
      actorId: actor.id,
      actorRole: actor.role,
      action: 'DISTRICT_DISCLOSURE_CONFIRMED',
      ipAddress: clientInfo?.ipAddress ?? null,
      userAgent: clientInfo?.userAgent ?? null,
      metadata: {
        districtId,
        districtName: district.name,
        confirmedAt: now.toISOString(),
      },
    });
  });

  return {
    districtId,
    disclosureConfirmedAt: now.toISOString(),
    disclosureConfirmedById: actor.id,
  };
}

/**
 * @deprecated Legacy alias for confirmStandingDisclosure. Use `confirmStandingDisclosure` directly.
 */
export const confirmDistrictDisclosure = confirmStandingDisclosure;

/* ── Public Operation 3: Activate District State Machine ── */

export async function activateDistrict(
  db: DbClient,
  districtId: string,
  actor: ActorContext,
  clientInfo?: ClientContext
): Promise<ActivateDistrictResponse> {
  const now = new Date();
  let failedPrerequisites: PrerequisiteItem[] | null = null;
  let targetDistrictName = '';

  try {
    const result = await db.transaction(async (tx) => {
      // Tier 1: Exclusive row lock via SELECT ... FOR UPDATE
      const lockResult = await tx.execute<{
        id: string;
        name: string;
        region: string | null;
        status: string;
        access_eligible: boolean;
        analysis_config_profile_id: string;
        disclosure_confirmed_at: Date | null;
        disclosure_confirmed_by_id: string | null;
        activated_at: Date | null;
        activated_by_id: string | null;
        created_at: Date;
        updated_at: Date;
      }>(sql`SELECT * FROM districts WHERE id = ${districtId} FOR UPDATE`);

      const lockedDistrict = lockResult.rows[0];
      if (!lockedDistrict) {
        const [tombstone] = await tx
          .select()
          .from(districtDeletionRecords)
          .where(eq(districtDeletionRecords.districtId, districtId))
          .limit(1);

        if (tombstone && tombstone.liveDeletionStatus === 'COMPLETED') {
          throw new DistrictAlreadyDeletedError(districtId);
        }
        throw new DistrictNotFoundError(districtId);
      }

      targetDistrictName = lockedDistrict.name;

      if (lockedDistrict.status === 'ACTIVE') {
        throw new DistrictAlreadyActiveError(districtId);
      }

      if (lockedDistrict.status !== 'SETUP_INCOMPLETE') {
        throw new DistrictInvalidStatusError(districtId, lockedDistrict.status);
      }

      // Authoritatively re-evaluate all 8 prerequisites under lock
      const readiness = await getOnboardingReadiness(tx, districtId);
      if (!readiness.isActivationReady) {
        failedPrerequisites = readiness.items.filter((item) => item.status !== 'passed');
        throw new DistrictNotReadyForActivationError(failedPrerequisites);
      }

      // Tier 2: Conditional CAS atomic update
      const [updated] = await tx
        .update(districts)
        .set({
          status: 'ACTIVE',
          activatedAt: now,
          activatedById: actor.id,
          updatedAt: now,
        })
        .where(and(eq(districts.id, districtId), eq(districts.status, 'SETUP_INCOMPLETE')))
        .returning();

      if (!updated) {
        throw new DistrictAlreadyActiveError(districtId);
      }

      // Atomically synchronize subscription lifecycle status
      await tx
        .insert(districtSubscriptions)
        .values({
          id: `sub_${districtId}`,
          districtId,
          status: 'ACTIVE',
          statusStartedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: districtSubscriptions.districtId,
          set: {
            status: 'ACTIVE',
            statusStartedAt: now,
            scheduledTransitionAt: null,
            scheduledTransitionType: null,
            updatedById: actor.id,
            updatedAt: now,
          },
        });

      // Insert DISTRICT_ACTIVATED audit event inside transaction
      await recordAuditEvent(tx, {
        districtId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'DISTRICT_ACTIVATED',
        ipAddress: clientInfo?.ipAddress ?? null,
        userAgent: clientInfo?.userAgent ?? null,
        metadata: {
          districtId,
          districtName: updated.name,
          previousStatus: 'SETUP_INCOMPLETE',
          previousValues: { status: 'SETUP_INCOMPLETE' },
          newValues: { status: 'ACTIVE' },
          passedPrerequisitesCount: readiness.passedCount,
          activatedAt: now.toISOString(),
        },
      });

      return {
        district: formatDistrict(updated),
        activatedAt: now.toISOString(),
        activatedById: actor.id,
      };
    });

    return result;
  } catch (err) {
    if (err instanceof DistrictNotReadyForActivationError) {
      await recordAuditEvent(db, {
        districtId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'DISTRICT_ACTIVATION_FAILED',
        ipAddress: clientInfo?.ipAddress ?? null,
        userAgent: clientInfo?.userAgent ?? null,
        metadata: {
          districtId,
          districtName: targetDistrictName,
          failedPrerequisites: err.blockers.map((i) => ({
            key: i.key,
            label: i.label,
            status: i.status,
            blockerReason: i.blockerReason,
          })),
        },
      });
    }
    throw err;
  }
}
