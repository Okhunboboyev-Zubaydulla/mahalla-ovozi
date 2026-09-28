import type { DbOrTx } from '../../adapters/db/client.js';
import type {
  AiOperationFilter,
  AiOperationListItem,
  AiOperationDetailRecord,
  PaginatedResult,
  AiOperationHealthMetrics,
} from './ai-operation-types.js';
import {
  findOperationsByDistrict,
  findOperationsGlobal,
  findOperationDetailsById,
  findOperationDetailsByIdGlobal,
  aggregateHealthMetrics,
} from './ai-operation-repository.js';

export class InvalidDistrictScopeError extends Error {
  readonly code = 'INVALID_DISTRICT_SCOPE' as const;
  readonly statusCode = 400;
  constructor(message = 'Туман идентификатори талаб қилинади ва бўш бўлмаслиги керак.') {
    super(message);
    this.name = 'InvalidDistrictScopeError';
  }
}

export class OperationNotFoundError extends Error {
  readonly code = 'OPERATION_NOT_FOUND' as const;
  readonly statusCode = 404;
  constructor(message = 'AI амалиёти топилмади.') {
    super(message);
    this.name = 'OperationNotFoundError';
  }
}

export class PrivacyBoundaryViolationError extends Error {
  readonly code = 'PRIVACY_BOUNDARY_VIOLATION' as const;
  readonly statusCode = 500;
  constructor(message = 'Махфийлик чегараси бузилди: тақиқланган маълумот майдони аниқланди.') {
    super(message);
    this.name = 'PrivacyBoundaryViolationError';
  }
}

const FORBIDDEN_PRIVACY_KEYS = new Set([
  'residentText',
  'verbatimText',
  'citizenText',
  'candidateText',
  'telegramHandle',
  'botToken',
  'apiKey',
  'rawHeaders',
  'authSecret',
]);

/**
 * Validates that an object or nested structure does not contain forbidden privacy-violating keys.
 * Throws PrivacyBoundaryViolationError if any forbidden keys are present.
 */
export function assertPrivacyBoundary(obj: unknown): boolean {
  function check(item: unknown): boolean {
    if (!item || typeof item !== 'object') {
      return true;
    }

    if (Array.isArray(item)) {
      for (const el of item) {
        if (!check(el)) {
          return false;
        }
      }
      return true;
    }

    for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
      if (FORBIDDEN_PRIVACY_KEYS.has(key)) {
        return false;
      }
      if (typeof value === 'object' && value !== null) {
        if (!check(value)) {
          return false;
        }
      }
    }

    return true;
  }

  const isSafe = check(obj);
  if (!isSafe) {
    throw new PrivacyBoundaryViolationError();
  }
  return true;
}

export class AiOperationQueryService {
  /**
   * List AI operations scoped to a specific district with tenant isolation.
   */
  async listDistrictOperations(
    db: DbOrTx,
    districtId: string,
    filter?: Omit<AiOperationFilter, 'districtId'>,
  ): Promise<PaginatedResult<AiOperationListItem>> {
    if (!districtId || typeof districtId !== 'string' || districtId.trim() === '') {
      throw new InvalidDistrictScopeError();
    }

    const trimmedDistrictId = districtId.trim();
    const result = await findOperationsByDistrict(db, {
      ...filter,
      districtId: trimmedDistrictId,
    });

    assertPrivacyBoundary(result);
    return result;
  }

  /**
   * Get single AI operation detail joined with immutable profile and attempts, scoped to district.
   */
  async getDistrictOperationDetails(
    db: DbOrTx,
    districtId: string,
    operationId: string,
  ): Promise<AiOperationDetailRecord> {
    if (!districtId || typeof districtId !== 'string' || districtId.trim() === '') {
      throw new InvalidDistrictScopeError();
    }
    if (!operationId || typeof operationId !== 'string' || operationId.trim() === '') {
      throw new OperationNotFoundError();
    }

    const trimmedDistrictId = districtId.trim();
    const details = await findOperationDetailsById(db, trimmedDistrictId, operationId.trim());

    if (!details || details.operation.districtId !== trimmedDistrictId) {
      throw new OperationNotFoundError();
    }

    assertPrivacyBoundary(details);
    return details;
  }

  /**
   * Global administrative list of AI operations across districts (Product Owner scope).
   */
  async listGlobalOperations(
    db: DbOrTx,
    filter?: AiOperationFilter,
  ): Promise<PaginatedResult<AiOperationListItem>> {
    const result = await findOperationsGlobal(db, filter ?? {});
    assertPrivacyBoundary(result);
    return result;
  }

  /**
   * Global administrative single AI operation detail (Product Owner scope).
   */
  async getGlobalOperationDetails(
    db: DbOrTx,
    operationId: string,
  ): Promise<AiOperationDetailRecord> {
    if (!operationId || typeof operationId !== 'string' || operationId.trim() === '') {
      throw new OperationNotFoundError();
    }

    const details = await findOperationDetailsByIdGlobal(db, operationId.trim());
    if (!details) {
      throw new OperationNotFoundError();
    }

    assertPrivacyBoundary(details);
    return details;
  }

  /**
   * System Health aggregate AI metrics.
   */
  async getSystemHealthAiMetrics(
    db: DbOrTx,
    options?: { districtId?: string; timeframe?: { from?: Date; to?: Date } },
  ): Promise<AiOperationHealthMetrics> {
    const districtId = options?.districtId?.trim() || undefined;
    const metrics = await aggregateHealthMetrics(db, districtId, options?.timeframe);
    assertPrivacyBoundary(metrics);
    return metrics;
  }
}

export const aiOperationQueryService = new AiOperationQueryService();
