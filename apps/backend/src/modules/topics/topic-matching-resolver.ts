import type { QualifyingLane } from '@mahalla-ovozi/api-contracts';

export interface CandidateTopicItem {
  id: string;
  primaryLane: QualifyingLane | string;
  status: string;
  latestRelevantEvidenceTimestamp: Date;
  requiredDerivedGeneration: number;
}

export interface ResolveTargetTopicParams {
  matchedTopicId?: string | null;
  matchedTopicIndex?: number | null;
  orderedSnapshotTopicIds?: string[];
  candidateTopics: CandidateTopicItem[];
  effectivePrimaryLane: QualifyingLane;
}

export type TopicResolutionResult =
  | {
      status: 'MATCHED';
      matchedTopic: CandidateTopicItem;
      method: 'INDEX' | 'EXACT' | 'FUZZY' | 'LANE_CONSOLIDATION';
    }
  | {
      status: 'UNRESOLVED';
      fallbackLane: QualifyingLane;
    };

/**
 * Computes the standard Levenshtein distance between two strings
 * using space-efficient, index-safe dynamic programming.
 */
export function computeLevenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const row = new Array<number>(a.length + 1);
  for (let j = 0; j <= a.length; j++) {
    row[j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    let prevDiag = row[0] ?? 0;
    row[0] = i;

    for (let j = 1; j <= a.length; j++) {
      const temp = row[j] ?? 0;
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        row[j] = prevDiag;
      } else {
        const insertCost = row[j - 1] ?? 0;
        const deleteCost = temp;
        row[j] = Math.min(prevDiag + 1, insertCost + 1, deleteCost + 1);
      }
      prevDiag = temp;
    }
  }

  return row[a.length] ?? 0;
}

/**
 * Normalizes a topic ID by stripping leading prefixes (e.g. 'top_')
 * for robust string distance comparison.
 */
function normalizeTopicId(id: string): string {
  return id.startsWith('top_') ? id.slice(4).toLowerCase().trim() : id.toLowerCase().trim();
}

/**
 * Multi-tier entity resolution for candidate topic matching:
 * 1. 1-Based Index Match from ordered snapshot prompt list
 * 2. Exact Topic ID Match in database
 * 3. Fuzzy Levenshtein / Substring Match against candidate topics (distance <= 3)
 * 4. Domain Lane Consolidation Match (single active topic in candidate's lane)
 * 5. Safe Fallback to UNRESOLVED (downgrades to NEW_TOPIC; never crashes queue)
 */
export function resolveTargetTopic(params: ResolveTargetTopicParams): TopicResolutionResult {
  const {
    matchedTopicId,
    matchedTopicIndex,
    orderedSnapshotTopicIds = [],
    candidateTopics,
    effectivePrimaryLane,
  } = params;

  // Tier 1: 1-Based Index Resolution
  if (
    typeof matchedTopicIndex === 'number' &&
    matchedTopicIndex > 0 &&
    matchedTopicIndex <= orderedSnapshotTopicIds.length
  ) {
    const resolvedId = orderedSnapshotTopicIds[matchedTopicIndex - 1];
    const matched = candidateTopics.find((t) => t.id === resolvedId);
    if (matched) {
      return { status: 'MATCHED', matchedTopic: matched, method: 'INDEX' };
    }
  }

  // Tier 2: Exact Topic ID Match
  if (matchedTopicId && typeof matchedTopicId === 'string' && matchedTopicId.trim().length > 0) {
    const trimmedId = matchedTopicId.trim();
    const matched = candidateTopics.find((t) => t.id === trimmedId);
    if (matched) {
      return { status: 'MATCHED', matchedTopic: matched, method: 'EXACT' };
    }

    // Tier 3: Fuzzy Levenshtein / Substring Match
    const normalizedTarget = normalizeTopicId(trimmedId);
    let bestMatch: CandidateTopicItem | null = null;
    let lowestDistance = Number.MAX_SAFE_INTEGER;

    for (const candidate of candidateTopics) {
      const normalizedCandidate = normalizeTopicId(candidate.id);

      // Check exact normalized match or containment
      if (normalizedCandidate === normalizedTarget) {
        return { status: 'MATCHED', matchedTopic: candidate, method: 'FUZZY' };
      }

      // Check substring containment (e.g. missing suffix/prefix)
      if (
        (normalizedCandidate.length > 8 && normalizedTarget.includes(normalizedCandidate)) ||
        (normalizedTarget.length > 8 && normalizedCandidate.includes(normalizedTarget))
      ) {
        return { status: 'MATCHED', matchedTopic: candidate, method: 'FUZZY' };
      }

      const dist = computeLevenshteinDistance(normalizedTarget, normalizedCandidate);
      if (dist < lowestDistance) {
        lowestDistance = dist;
        bestMatch = candidate;
      }
    }

    // Accept fuzzy match if distance is within tolerance (<= 3 edit operations)
    if (bestMatch && lowestDistance <= 3) {
      return { status: 'MATCHED', matchedTopic: bestMatch, method: 'FUZZY' };
    }
  }

  // Tier 4: Domain Lane Consolidation Match
  // Per PRD Domain Rule 4.1: If there is exactly 1 active topic in this lane today in the Mahalla,
  // utility disruptions consolidate into it.
  const laneCandidates = candidateTopics.filter(
    (t) => t.primaryLane === effectivePrimaryLane && t.status === 'ACTIVE',
  );
  if (laneCandidates.length === 1 && laneCandidates[0]) {
    return {
      status: 'MATCHED',
      matchedTopic: laneCandidates[0],
      method: 'LANE_CONSOLIDATION',
    };
  }

  // Tier 5: Unresolved -> Caller should safely fall back to NEW_TOPIC
  return {
    status: 'UNRESOLVED',
    fallbackLane: effectivePrimaryLane,
  };
}
