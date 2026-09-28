import {
  AiOperationErrorCodeSchema,
  type AiOperationErrorCode,
  type KeysetPage,
} from '@mahalla-ovozi/api-contracts';
import type { AiOperation, AiProfile, AiProviderAttempt } from '../../adapters/db/schema/ai.js';
import type { AiGatewayErrorCode } from './types.js';

export const AiOperationErrorCodeEnum = AiOperationErrorCodeSchema;
export type { AiOperationErrorCode };

export interface AiOperationFilter {
  districtId?: string;
  mahallaName?: string;
  calendarDay?: string;
  operationType?: 'SEMANTIC_RELEVANCE' | 'TOPIC_MATCHING' | 'TOPIC_DERIVED_PROJECTION' | string;
  finalStatus?: string;
  targetId?: string;
  startDate?: Date;
  endDate?: Date;
  cursor?: string;
  limit?: number;
  direction?: 'forward' | 'backward';
}

export interface AiOperationListItem {
  id: string;
  districtId: string;
  mahallaName: string;
  calendarDay: string;
  operationType: string;
  targetId: string;
  pinnedProfileId: string;
  contextRevision: number;
  snapshotFingerprint: string;
  finalStatus: string;
  attemptCount: number;
  totalCostUsd: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AiOperationDetailRecord {
  operation: AiOperation;
  profile: AiProfile;
  attempts: AiProviderAttempt[];
}

export type PaginatedResult<T> = KeysetPage<T>;

export interface AiOperationHealthMetrics {
  totalOperations: number;
  operationsByType: {
    SEMANTIC_RELEVANCE: number;
    TOPIC_MATCHING: number;
    TOPIC_DERIVED_PROJECTION: number;
    [key: string]: number;
  };
  operationsByStatus: {
    COMPLETED_RELEVANT: number;
    COMPLETED_IRRELEVANT: number;
    COMPLETED_MATCHED: number;
    COMPLETED_NEW_TOPIC: number;
    COMPLETED: number;
    FAILED_EXPLICIT: number;
    STALE: number;
    [key: string]: number;
  };
  totalAttempts: number;
  attemptsByStatus: {
    SUCCESS: number;
    ERROR: number;
    TIMEOUT: number;
    REFUSAL: number;
    [key: string]: number;
  };
  attemptsByErrorCode: Record<AiGatewayErrorCode, number>;
  staleSnapshotCount: number;
  contextOverflowCount: number;
  refusalCount: number;
  timeoutCount: number;
  validationFailureCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalEstimatedCostUsd: number;
  avgDurationMs: number;
  p95DurationMs: number;
}
