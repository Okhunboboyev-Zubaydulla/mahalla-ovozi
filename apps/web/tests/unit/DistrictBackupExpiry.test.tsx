import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfigProvider, App as AntdApp } from 'antd';
import type { DistrictDeletionRecord } from '@mahalla-ovozi/api-contracts';
import { mahallaTheme } from '../../src/theme/antd-theme.js';
import { DistrictDeletionRecordCard } from '../../src/components/subscriptions/DistrictDeletionRecordCard.js';

function setupMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

beforeAll(() => {
  setupMatchMedia();
});

describe('Story 6.5: District Protected-Backup Expiry UI Unit Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setupMatchMedia();
  });

  const baseTombstone: DistrictDeletionRecord = {
    id: 'del_rec_test_1',
    districtId: 'dist_del_test_1',
    districtName: 'Яшнобод тумани',
    cancelledAt: '2026-07-01T10:00:00.000Z',
    cancelledById: 'acc_po_123',
    cancellationReason: 'Тест мақсадида бекор қилинган',
    scheduledLiveDeletionAt: '2026-07-31T10:00:00.000Z',
    actualLiveDeletionAt: '2026-07-31T10:05:00.000Z',
    liveDeletionStatus: 'COMPLETED',
    protectedBackupExpiryDeadline: '2026-08-30T10:05:00.000Z',
    backupExpiryStatus: 'PENDING',
    backupExpiryVerifiedAt: undefined,
    restoreReconciliationStatus: undefined,
    restoreReconciliationVerifiedAt: undefined,
    createdAt: '2026-07-31T10:05:00.000Z',
    updatedAt: '2026-07-31T10:05:00.000Z',
  };

  it('renders PENDING backup expiry milestone with 30-day deadline and enabled verify button', () => {
    const onVerify = vi.fn();

    render(
      <ConfigProvider theme={mahallaTheme}>
        <AntdApp>
          <DistrictDeletionRecordCard
            deletionRecord={baseTombstone}
            onVerifyBackupExpiry={onVerify}
            isOffline={false}
          />
        </AntdApp>
      </ConfigProvider>,
    );

    // Verify district title and live deletion completed status
    expect(screen.getByText(/Яшнобод тумани \(Ўчирилган\)/i)).toBeDefined();
    expect(screen.getByText('ЯКУНЛАНГАН (COMPLETED)')).toBeDefined();

    // Verify backup expiry pending banner
    expect(screen.getByText(/2-босқич: Ҳимояланган заҳира нусхалари кутилмоқда/i)).toBeDefined();

    // Verify verification button is present and enabled
    const verifyButton = screen.getByRole('button', {
      name: /Заҳирани текшириш \(Verify Backup Expiry\)/i,
    });
    expect(verifyButton).toBeDefined();
    expect(verifyButton.hasAttribute('disabled')).toBe(false);

    // Click verification button
    fireEvent.click(verifyButton);
    expect(onVerify).toHaveBeenCalledTimes(1);
  });

  it('renders VERIFIED backup expiry milestone with verified timestamp and disabled verify button', () => {
    const verifiedTombstone: DistrictDeletionRecord = {
      ...baseTombstone,
      backupExpiryStatus: 'VERIFIED',
      backupExpiryVerifiedAt: '2026-08-29T12:00:00.000Z',
    };

    const onVerify = vi.fn();

    render(
      <ConfigProvider theme={mahallaTheme}>
        <AntdApp>
          <DistrictDeletionRecordCard
            deletionRecord={verifiedTombstone}
            onVerifyBackupExpiry={onVerify}
            isOffline={false}
          />
        </AntdApp>
      </ConfigProvider>,
    );

    // Verify success banner and verified tag
    expect(
      screen.getByText(/2-босқич: Ҳимояланган заҳира нусхалари муддати \(Backup Expiry\)/i),
    ).toBeDefined();
    expect(screen.getAllByText(/Заҳира муддати муваффақиятли тасдиқланди \(Verified\)/i).length).toBeGreaterThan(0);

    // Verify button is disabled for already verified records
    const verifyButton = screen.getByRole('button', {
      name: /Заҳирани текшириш \(Verify Backup Expiry\)/i,
    });
    expect(verifyButton.hasAttribute('disabled')).toBe(true);
  });

  it('renders FAILED backup expiry milestone with error banner and system health notice', () => {
    const failedTombstone: DistrictDeletionRecord = {
      ...baseTombstone,
      backupExpiryStatus: 'FAILED',
    };

    render(
      <ConfigProvider theme={mahallaTheme}>
        <AntdApp>
          <DistrictDeletionRecordCard
            deletionRecord={failedTombstone}
            isOffline={false}
          />
        </AntdApp>
      </ConfigProvider>,
    );

    // Verify error banner
    expect(
      screen.getByText(/2-босқич: Заҳира нусхалари муддатини тасдиқлашда хатолик \(Backup Expiry Failed\)/i),
    ).toBeDefined();
    expect(
      screen.getByText(/30 кунлик муддат ўтган бўлса-да, заҳира омборида эски нусхалар мавжуд/i),
    ).toBeDefined();
  });

  it('disables verify button when isOffline is true', () => {
    const onVerify = vi.fn();

    render(
      <ConfigProvider theme={mahallaTheme}>
        <AntdApp>
          <DistrictDeletionRecordCard
            deletionRecord={baseTombstone}
            onVerifyBackupExpiry={onVerify}
            isOffline={true}
          />
        </AntdApp>
      </ConfigProvider>,
    );

    const verifyButton = screen.getByRole('button', {
      name: /Заҳирани текшириш \(Verify Backup Expiry\)/i,
    });
    expect(verifyButton.hasAttribute('disabled')).toBe(true);
  });
});
