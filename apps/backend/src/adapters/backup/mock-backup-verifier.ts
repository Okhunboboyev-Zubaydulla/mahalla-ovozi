import type {
  BackupRetentionVerifier,
  BackupVerificationResult,
} from '../../modules/subscriptions/ports/backup-retention-verifier.js';

export interface MockBackupConfig {
  isExpired?: boolean;
  oldestActiveBackupTimestamp?: Date | null;
  totalBackupsCount?: number;
  verificationMethod?: string;
  rawDetails?: Record<string, unknown>;
  error?: string;
  shouldThrow?: boolean;
  throwError?: Error;
}

export class MockBackupRetentionVerifier implements BackupRetentionVerifier {
  private globalConfig: MockBackupConfig;
  private districtConfigs: Map<string, MockBackupConfig> = new Map();
  private callLog: Array<{
    districtId: string;
    actualLiveDeletionAt: Date;
    protectedBackupExpiryDeadline: Date;
    calledAt: Date;
  }> = [];

  constructor(defaultConfig?: MockBackupConfig) {
    this.globalConfig = defaultConfig ?? {
      isExpired: true,
      oldestActiveBackupTimestamp: null,
      totalBackupsCount: 0,
      verificationMethod: 'MOCK_BACKUP_VERIFIER',
    };
  }

  setGlobalConfig(config: MockBackupConfig): void {
    this.globalConfig = config;
  }

  setDistrictConfig(districtId: string, config: MockBackupConfig): void {
    this.districtConfigs.set(districtId, config);
  }

  clearDistrictConfig(districtId: string): void {
    this.districtConfigs.delete(districtId);
  }

  getCallLog() {
    return [...this.callLog];
  }

  clearCallLog(): void {
    this.callLog = [];
  }

  async verifyDistrictBackupExpiry(params: {
    districtId: string;
    actualLiveDeletionAt: Date;
    protectedBackupExpiryDeadline: Date;
  }): Promise<BackupVerificationResult> {
    this.callLog.push({
      districtId: params.districtId,
      actualLiveDeletionAt: params.actualLiveDeletionAt,
      protectedBackupExpiryDeadline: params.protectedBackupExpiryDeadline,
      calledAt: new Date(),
    });

    const config = this.districtConfigs.get(params.districtId) || this.globalConfig;

    if (config.shouldThrow) {
      throw config.throwError || new Error(config.error || 'Mock backup storage unreachable');
    }

    if (config.error) {
      return {
        isExpired: false,
        oldestActiveBackupTimestamp: config.oldestActiveBackupTimestamp ?? null,
        verificationMethod: config.verificationMethod || 'MOCK_ERROR',
        error: config.error,
        rawDetails: config.rawDetails,
      };
    }

    // Default behavior if not explicitly overridden:
    // If oldestActiveBackupTimestamp is set, compare with actualLiveDeletionAt
    let isExpired = config.isExpired ?? true;
    if (config.oldestActiveBackupTimestamp !== undefined) {
      if (config.oldestActiveBackupTimestamp === null) {
        isExpired = true;
      } else {
        isExpired =
          config.oldestActiveBackupTimestamp.getTime() >
          params.actualLiveDeletionAt.getTime();
      }
    }

    return {
      isExpired: config.isExpired ?? isExpired,
      oldestActiveBackupTimestamp: config.oldestActiveBackupTimestamp ?? null,
      totalBackupsCount: config.totalBackupsCount ?? (isExpired ? 0 : 1),
      verificationMethod: config.verificationMethod || 'MOCK_BACKUP_VERIFIER',
      rawDetails: config.rawDetails,
    };
  }
}
