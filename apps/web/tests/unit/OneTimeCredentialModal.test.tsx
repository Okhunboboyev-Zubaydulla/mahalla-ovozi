import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { OneTimeCredentialModal } from '../../src/components/OneTimeCredentialModal.js';
import { mahallaTheme } from '../../src/theme/antd-theme.js';

function setupMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
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

describe('OneTimeCredentialModal Component Tests', () => {
  it('renders modal with username, temporary password, copy button, and security warnings', () => {
    const handleClose = vi.fn();

    render(
      <ConfigProvider theme={mahallaTheme}>
        <OneTimeCredentialModal
          isOpen={true}
          onClose={handleClose}
          username="hokim_chilonzor"
          temporaryPassword="SecureTempPass#2026!"
          title="Ҳоким аккаунти муваффақиятли яратилди"
        />
      </ConfigProvider>
    );

    // Title
    expect(screen.getByText('Ҳоким аккаунти муваффақиятли яратилди')).toBeTruthy();

    // Security Alert
    expect(screen.getByText('Диққат! Бир марталик хавфсизлик маълумоти')).toBeTruthy();
    expect(
      screen.getByText(/Ушбу вақтинчалик парол фақат бир марта кўрсатилади/i)
    ).toBeTruthy();

    // Username & Password
    expect(screen.getByText('hokim_chilonzor')).toBeTruthy();
    expect(screen.getByText('SecureTempPass#2026!')).toBeTruthy();

    // Close button
    const closeBtn = screen.getByRole('button', { name: 'Тушундим, ойнани ёпиш' });
    expect(closeBtn).toBeTruthy();

    fireEvent.click(closeBtn);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when temporaryPassword is null', () => {
    const { container } = render(
      <ConfigProvider theme={mahallaTheme}>
        <OneTimeCredentialModal
          isOpen={true}
          onClose={vi.fn()}
          username="hokim_chilonzor"
          temporaryPassword={null}
        />
      </ConfigProvider>
    );

    expect(container.firstChild).toBeNull();
  });
});
