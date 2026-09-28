import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDbPool, createDbClient, DbClient, DbTransaction } from '../src/adapters/db/client.js';
import { runMigrations } from '../src/adapters/db/migrate.js';
import { districts, accounts, sessions, userDashboardVisits } from '../src/adapters/db/schema/index.js';
import { createAuthDataCleaner } from '../src/modules/auth/auth-data-cleaner.js';
import { hashPassword } from '../src/adapters/crypto/argon2.js';

describe('createAuthDataCleaner', () => {
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

  async function seedAuthForDistrict(tag: string) {
    const districtId = `dist_auth_${tag}_${Date.now()}`;
    const now = new Date();

    await db.insert(districts).values({
      id: districtId,
      name: `Auth Clean ${districtId}`,
      region: 'Toshkent',
      status: 'CANCELLED',
    });

    const accountId = crypto.randomUUID();
    const passwordHash = await hashPassword('SecurePass123!');
    await db.insert(accounts).values({
      id: accountId,
      username: `hokim_${tag}_${crypto.randomUUID().slice(0, 6)}`,
      passwordHash,
      role: 'DISTRICT_HOKIM',
      status: 'ACTIVE',
      districtId,
      mustChangePassword: false,
    });

    const sessionId = crypto.randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      accountId,
      tokenHash: crypto.randomBytes(32).toString('hex'),
      credentialVersion: 1,
      expiresAt: new Date(now.getTime() + 86400000),
    });

    const visitId = `vis_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(userDashboardVisits).values({
      id: visitId,
      userId: accountId,
      districtId,
      visitedAt: now,
    });

    return { districtId, accountId, sessionId, visitId };
  }

  it('deletes sessions, user_dashboard_visits, and accounts for the target district', async () => {
    const { districtId, sessionId, visitId } = await seedAuthForDistrict('a');

    const accountsBefore = await db.select().from(accounts).where(eq(accounts.districtId, districtId));
    expect(accountsBefore).toHaveLength(1);
    const sessionsBefore = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(sessionsBefore).toHaveLength(1);
    const visitsBefore = await db.select().from(userDashboardVisits).where(eq(userDashboardVisits.id, visitId));
    expect(visitsBefore).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createAuthDataCleaner().deleteDistrictData(tx, districtId);
    });

    const accountsAfter = await db.select().from(accounts).where(eq(accounts.districtId, districtId));
    expect(accountsAfter).toHaveLength(0);
    const sessionsAfter = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(sessionsAfter).toHaveLength(0);
    const visitsAfter = await db.select().from(userDashboardVisits).where(eq(userDashboardVisits.id, visitId));
    expect(visitsAfter).toHaveLength(0);
  });

  it('does not delete auth data belonging to other districts', async () => {
    const { districtId: districtA } = await seedAuthForDistrict('b1');
    const { districtId: districtB } = await seedAuthForDistrict('b2');

    await db.transaction(async (tx: DbTransaction) => {
      await createAuthDataCleaner().deleteDistrictData(tx, districtA);
    });

    const accountsB = await db.select().from(accounts).where(eq(accounts.districtId, districtB));
    expect(accountsB).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createAuthDataCleaner().deleteDistrictData(tx, districtB);
    });
  });

  it('is idempotent when called on an already clean district', async () => {
    const { districtId } = await seedAuthForDistrict('c');

    await db.transaction(async (tx: DbTransaction) => {
      await createAuthDataCleaner().deleteDistrictData(tx, districtId);
    });

    await expect(
      db.transaction(async (tx: DbTransaction) => {
        await createAuthDataCleaner().deleteDistrictData(tx, districtId);
      })
    ).resolves.not.toThrow();
  });

  it('rolls back on transaction error', async () => {
    const { districtId } = await seedAuthForDistrict('d');

    await expect(
      db.transaction(async (tx: DbTransaction) => {
        await createAuthDataCleaner().deleteDistrictData(tx, districtId);
        throw new Error('forced rollback');
      })
    ).rejects.toThrow('forced rollback');

    const accountsAfter = await db.select().from(accounts).where(eq(accounts.districtId, districtId));
    expect(accountsAfter).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createAuthDataCleaner().deleteDistrictData(tx, districtId);
    });
  });
});
