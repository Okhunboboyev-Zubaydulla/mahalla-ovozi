/**
 * Shared SQL helpers for topic search and filtering across district-topics and hokim-topic services.
 *
 * Centralizes the multi-field text search predicate (summary + evidence verbatim text + author
 * attribution fields) that is used identically in both services.
 */

import { sql, type SQL } from 'drizzle-orm';

/**
 * Escapes SQL LIKE wildcard characters in a user-supplied search string.
 * Must be applied before interpolating user input into an ILIKE pattern.
 */
export function escapeLikePattern(input: string): string {
  return input.replace(/[%_\\]/g, '\\$&');
}

/**
 * Builds the WHERE clause SQL fragment that matches topics by:
 * - Topic projection summary (ILIKE)
 * - Evidence verbatim text (ILIKE)
 * - Evidence author: username, @username, firstName, lastName, or full name (ILIKE)
 *
 * The fragment already includes a leading AND so it can be embedded directly into
 * a query that already has a WHERE clause.  Call only when trimmedPattern is non-empty.
 *
 * @param pattern  Already LIKE-escaped pattern string (e.g. `%term%`)
 * @param districtId  District scope for the evidence subquery
 */
export function buildTopicSearchPredicate(pattern: string, districtId: string): SQL {
  return sql`AND (
    tp.summary ILIKE ${pattern}
    OR EXISTS (
      SELECT 1 FROM accepted_evidence ae 
      WHERE ae.topic_id = t.id 
        AND ae.district_id = ${districtId}
        AND (
          ae.verbatim_text ILIKE ${pattern}
          OR ae.user_metadata->>'username' ILIKE ${pattern}
          OR (ae.user_metadata->>'username' IS NOT NULL AND CONCAT('@', ae.user_metadata->>'username') ILIKE ${pattern})
          OR ae.user_metadata->>'firstName' ILIKE ${pattern}
          OR ae.user_metadata->>'lastName' ILIKE ${pattern}
          OR ((ae.user_metadata->>'firstName' IS NOT NULL OR ae.user_metadata->>'lastName' IS NOT NULL) AND CONCAT_WS(' ', ae.user_metadata->>'firstName', ae.user_metadata->>'lastName') ILIKE ${pattern})
        )
    )
  )`;
}
