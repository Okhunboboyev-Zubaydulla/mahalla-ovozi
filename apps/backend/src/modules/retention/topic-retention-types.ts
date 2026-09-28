/**
 * Topic Retention Domain Types & Contract Definitions
 * Governed by FR-12, AD-3, AD-4, AD-9, AD-11.
 */

export interface RetentionPurgeResult {
  topicId: string;
  districtId: string;
  evidenceCount: number;
  projectionsCount: number;
  purged: boolean;
  reason?: 'SUCCESS' | 'EXTENDED_BY_NEWER_EVIDENCE' | 'TOPIC_NOT_FOUND' | 'LOCKED_OR_ERROR';
}

export interface RetentionScanOptions {
  limit?: number;
}

export interface RetentionBatchResult {
  districtId: string;
  topicsEvaluated: number;
  topicsPurged: number;
  evidencePurged: number;
  projectionsPurged: number;
  failedPurges?: number;
  durationMs: number;
}

export interface DisasterRestoreReconciliationResult {
  districtsReconciled: number;
  districtsEvaluated?: number;
  districtsSucceeded?: number;
  districtsFailed?: number;
  totalTopicsPurged: number;
  totalEvidencePurged: number;
  totalProjectionsPurged: number;
  errors?: Array<{ districtId: string; error: string }>;
  durationMs: number;
}
