import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HealthStatusBadge } from '../../src/components/health/HealthStatusBadge.js';
import { HealthStatus } from '@mahalla-ovozi/api-contracts';

describe('Story 4.1: HealthStatusBadge Component Tests (AC 4)', () => {
  const TEST_CASES: Array<{ status: HealthStatus; expectedLabel: string }> = [
    { status: 'Healthy', expectedLabel: 'Соғлом' },
    { status: 'Delayed', expectedLabel: 'Кечиккан' },
    { status: 'Degraded', expectedLabel: 'Қисман ишламоқда' },
    { status: 'Unavailable', expectedLabel: 'Ишламаяпти' },
    { status: 'Quiet', expectedLabel: 'Фаолиятсиз' },
    { status: 'Unknown', expectedLabel: 'Номаълум' },
  ];

  TEST_CASES.forEach(({ status, expectedLabel }) => {
    it(`renders ${status} status with correct Uzbek Cyrillic text "${expectedLabel}" and accessible ARIA attributes`, () => {
      render(<HealthStatusBadge status={status} />);

      const badge = screen.getByRole('status');
      expect(badge).toBeTruthy();
      expect(badge.textContent).toContain(expectedLabel);
      expect(badge.getAttribute('aria-label')).toBe(`Ҳолат: ${expectedLabel}`);
    });
  });

  it('handles fallback gracefully for unexpected status', () => {
    render(<HealthStatusBadge status={'NonExistent' as HealthStatus} />);

    const badge = screen.getByRole('status');
    expect(badge).toBeTruthy();
    expect(badge.textContent).toContain('Номаълум');
  });
});
