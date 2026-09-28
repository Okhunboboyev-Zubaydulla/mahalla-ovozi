import { eq, inArray } from 'drizzle-orm';
import { accounts, sessions, userDashboardVisits } from '../../adapters/db/schema/index.js';
import type { DistrictDataCleaner } from '../subscriptions/ports/district-data-cleaner.js';

/**
 * Returns a DistrictDataCleaner that purges auth-domain data for a district (ADR-001).
 *
 * Deletion order is strict FK topological order:
 *   1. sessions (FK -> accounts.id; purged via typed subquery)
 *   2. user_dashboard_visits (FK -> accounts.id, FK -> districts.id)
 *   3. accounts (parent rows)
 *
 * Must be called within the orchestrator transaction; does not open its own.
 */
export function createAuthDataCleaner(): DistrictDataCleaner {
  return {
    moduleName: 'auth',

    async deleteDistrictData(tx, districtId) {
      // 1. sessions must be deleted before accounts (FK constraint)
      await tx
        .delete(sessions)
        .where(
          inArray(
            sessions.accountId,
            tx
              .select({ id: accounts.id })
              .from(accounts)
              .where(eq(accounts.districtId, districtId)),
          ),
        );

      // 2. user_dashboard_visits must be deleted before accounts (FK constraint)
      await tx
        .delete(userDashboardVisits)
        .where(eq(userDashboardVisits.districtId, districtId));

      // 3. accounts parent rows
      await tx.delete(accounts).where(eq(accounts.districtId, districtId));
    },
  };
}
