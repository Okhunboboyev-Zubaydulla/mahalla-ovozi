import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IssueSeverityBadge } from '../../src/components/issues/IssueSeverityBadge.js';
import { IssueSeverity } from '@mahalla-ovozi/api-contracts';

describe('Story 4.2: IssueSeverityBadge Component Tests (AC 3)', () => {
  const TEST_CASES: Array<{ severity: IssueSeverity; expectedLabel: string }> = [
    { severity: 'Critical', expectedLabel: 'Муҳим' },
    { severity: 'Warning', expectedLabel: 'Огоҳлантириш' },
    { severity: 'Information', expectedLabel: 'Маълумот' },
  ];

  TEST_CASES.forEach(({ severity, expectedLabel }) => {
    it(`renders ${severity} severity badge with correct Uzbek Cyrillic text "${expectedLabel}" and accessible ARIA attributes`, () => {
      render(<IssueSeverityBadge severity={severity} />);

      const badge = screen.getByRole('status');
      expect(badge).toBeTruthy();
      expect(badge.textContent).toContain(expectedLabel);
      expect(badge.getAttribute('aria-label')).toBe(`Муаммо даражаси: ${expectedLabel}`);
    });
  });
});
