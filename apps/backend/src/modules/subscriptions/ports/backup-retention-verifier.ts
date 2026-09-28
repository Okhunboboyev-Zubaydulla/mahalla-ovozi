export interface BackupVerificationResult {
  isExpired: boolean;
  oldestActiveBackupTimestamp: Date | null;
  totalBackupsCount?: number;
  verificationMethod: string;
  rawDetails?: Record<string, unknown>;
  error?: string;
}

export interface BackupRetentionVerifier {
  verifyDistrictBackupExpiry(params: {
    districtId: string;
    actualLiveDeletionAt: Date;
    protectedBackupExpiryDeadline: Date;
  }): Promise<BackupVerificationResult>;
}
