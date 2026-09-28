import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { mahallaTheme } from '../../src/theme/antd-theme.js';
import { TopicCard } from '../../src/components/topics/TopicCard.js';
import { TopicCardItem } from '@mahalla-ovozi/api-contracts';
import { getMahallaColor } from '../../src/utils/mahalla-colors.js';

function createMockTopic(mahallaName: string, id: string): TopicCardItem {
  return {
    id,
    districtId: 'dist_1',
    mahallaName,
    calendarDay: '2026-08-24',
    summary: 'Таъминот муаммоси юзасидан хабар.',
    primaryLane: 'WATER',
    lanes: ['WATER'],
    additionalLanes: [],
    evidenceCount: 1,
    latestMeaningfulActivityTimestamp: '2026-08-24T08:00:00.000Z',
    isNew: false,
    isUpdated: false,
    createdAt: '2026-08-24T08:00:00.000Z',
    updatedAt: '2026-08-24T08:00:00.000Z',
  };
}

function hexToRgb(hex: string): string {
  const cleanHex = hex.replace('#', '');
  const r = parseInt(cleanHex.substring(0, 2), 16);
  const g = parseInt(cleanHex.substring(2, 4), 16);
  const b = parseInt(cleanHex.substring(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

describe('TopicCard Mahalla Color Styling', () => {
  it('renders mahalla name with distinct muted text and icon colors without background wrapper', () => {
    const topicNavbahor = createMockTopic('Навбаҳор', 'top_1');
    const colorNavbahor = getMahallaColor('Навбаҳор');

    const { container, unmount } = render(
      <ConfigProvider theme={mahallaTheme}>
        <TopicCard topic={topicNavbahor} />
      </ConfigProvider>,
    );

    const navbahorEl = screen.getByText('Навбаҳор маҳалласи');
    expect(navbahorEl).toBeDefined();
    const navbahorTypography = navbahorEl.closest('.ant-typography') as HTMLElement;
    expect(navbahorTypography).not.toBeNull();
    expect(navbahorTypography.style.color).toBe(hexToRgb(colorNavbahor.text));

    // Ensure there is NO background wrapper around the mahalla name
    const spaceContainer = navbahorEl.closest('.ant-space');
    expect(spaceContainer).not.toBeNull();
    expect(spaceContainer?.getAttribute('style')).not.toContain('background-color');

    // Icon retains the original brand azure color #0284C7
    const icon = container.querySelector('.anticon-environment');
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('style')).toContain(hexToRgb('#0284C7'));

    unmount();

    // Verify a different mahalla produces a distinct color
    const topicGulbodom = createMockTopic('Гулбодом', 'top_2');
    const colorGulbodom = getMahallaColor('Гулбодом');

    const { container: container2 } = render(
      <ConfigProvider theme={mahallaTheme}>
        <TopicCard topic={topicGulbodom} />
      </ConfigProvider>,
    );

    const gulbodomEl = screen.getByText('Гулбодом маҳалласи');
    const gulbodomTypography = gulbodomEl.closest('.ant-typography') as HTMLElement;
    expect(gulbodomTypography).not.toBeNull();
    expect(gulbodomTypography.style.color).toBe(hexToRgb(colorGulbodom.text));

    const icon2 = container2.querySelector('.anticon-environment');
    expect(icon2?.getAttribute('style')).toContain(hexToRgb('#0284C7'));

    // Assert that the two mahallas have different text colors
    expect(colorNavbahor.text).not.toBe(colorGulbodom.text);
  });
});
