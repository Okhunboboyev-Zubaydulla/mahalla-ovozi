import { eq } from 'drizzle-orm';
import { DbClient } from '../../adapters/db/client.js';
import { accounts } from '../../adapters/db/schema/index.js';
import { cryptoService } from '../../adapters/crypto/index.js';
import { recordAuditEvent } from '../audit/audit-service.js';
import { revokeAllAccountSessions } from './session-manager.js';

export interface ManageProductOwnerResult {
  isNew: boolean;
  accountId: string;
  username: string;
  credentialVersion: number;
}

export class ProductOwnerProvisioningError extends Error {
  readonly statusCode = 400;
  readonly code = 'PO_PROVISIONING_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ProductOwnerProvisioningError';
  }
}

export async function createOrResetProductOwner(
  db: DbClient,
  input: { username: string; password: string }
): Promise<ManageProductOwnerResult> {
  const username = input.username.trim();
  if (!username || username.length < 3 || username.length > 64) {
    throw new ProductOwnerProvisioningError('Фойдаланувчи номи 3 дан 64 белгигача бўлиши керак.');
  }

  const validation = cryptoService.passwords.validate(input.password);
  if (!validation.isValid) {
    throw new ProductOwnerProvisioningError(validation.message || 'Парол талабга жавоб бермайди.');
  }

  const hashedPassword = await cryptoService.passwords.hash(input.password);

  const [existing] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.username, username))
    .limit(1);

  if (existing) {
    const newVersion = existing.credentialVersion + 1;
    const now = new Date();

    // B7: Wrap all mutations in a transaction — prevents partial state
    // (e.g. password updated but sessions not revoked) if the process crashes mid-execution.
    await db.transaction(async (tx) => {
      await tx
        .update(accounts)
        .set({
          passwordHash: hashedPassword,
          credentialVersion: newVersion,
          updatedAt: now,
        })
        .where(eq(accounts.id, existing.id));

      // Immediately revoke all existing active sessions upon credential reset
      await revokeAllAccountSessions(tx, existing.id);

      // Record privacy-safe audit event
      await recordAuditEvent(tx, {
        actorId: existing.id,
        actorRole: 'PRODUCT_OWNER',
        action: 'ACCOUNT_PO_PASSWORD_RESET',
        metadata: {
          username,
          credential_version: newVersion,
        },
      });
    });

    return {
      isNew: false,
      accountId: existing.id,
      username,
      credentialVersion: newVersion,
    };
  }

  const accountId = `acc_${crypto.randomUUID()}`;
  const now = new Date();

  await db.insert(accounts).values({
    id: accountId,
    username,
    passwordHash: hashedPassword,
    role: 'PRODUCT_OWNER',
    credentialVersion: 1,
    createdAt: now,
    updatedAt: now,
  });

  // Record privacy-safe audit event
  await recordAuditEvent(db, {
    actorId: accountId,
    actorRole: 'PRODUCT_OWNER',
    action: 'ACCOUNT_PO_CREATED',
    metadata: {
      username,
      credential_version: 1,
    },
  });

  return {
    isNew: true,
    accountId,
    username,
    credentialVersion: 1,
  };
}
