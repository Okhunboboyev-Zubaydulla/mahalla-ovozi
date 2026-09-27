import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { districts } from './districts.js';

export const userDashboardVisits = pgTable(
  'user_dashboard_visits',
  {
    id: text('id').primaryKey(), // 'vis_<uuid>'
    userId: text('user_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    districtId: text('district_id')
      .notNull()
      .references(() => districts.id, { onDelete: 'cascade' }),
    visitedAt: timestamp('visited_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Composite index for fast lookup of previous visit boundary
    index('user_dashboard_visits_user_district_visited_idx').on(
      table.userId,
      table.districtId,
      table.visitedAt,
    ),
  ],
);

export type UserDashboardVisit = typeof userDashboardVisits.$inferSelect;
export type NewUserDashboardVisit = typeof userDashboardVisits.$inferInsert;
