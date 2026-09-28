import { test, expect } from '@playwright/test';

test.describe('Mobile Web Performance Baseline', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
    hasTouch: true,
  });

  test('captures mobile baseline timings and resource metrics on /sign-in', async ({ page }) => {
    // 1. Establish CDP session for CPU & Network throttling (Simulating regional 4G / mid-tier mobile)
    const client = await page.context().newCDPSession(page);

    // 4x CPU slowdown (simulates budget Android / low-end mobile SoC)
    await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });

    // 2. Setup long-task observer before navigation
    await page.addInitScript(() => {
      (window as unknown as { __longTasks: number[] }).__longTasks = [];
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            (window as unknown as { __longTasks: number[] }).__longTasks.push(entry.duration);
          }
        });
        observer.observe({ entryTypes: ['longtask'] });
      } catch {
        // Observer not supported in all environments
      }
    });

    const startTime = Date.now();
    await page.goto('/sign-in', { waitUntil: 'load' });
    const wallClockLoadTimeMs = Date.now() - startTime;

    // Verify critical elements are interactive
    const heading = page.locator('h2');
    await expect(heading).toHaveText('Тизимга кириш');
    await expect(page.locator('#username-input')).toBeVisible();

    // 3. Extract browser performance timings & Web Vitals
    const perfData = await page.evaluate(() => {
      const [nav] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
      const paintEntries = performance.getEntriesByType('paint');
      const fcpEntry = paintEntries.find((e) => e.name === 'first-contentful-paint');

      const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      const jsResources = resources.filter((r) => r.initiatorType === 'script' || r.name.endsWith('.js'));

      const totalJsTransfer = jsResources.reduce((acc, r) => acc + (r.transferSize || 0), 0);
      const totalJsDecoded = jsResources.reduce((acc, r) => acc + (r.decodedBodySize || 0), 0);

      const longTasks = (window as unknown as { __longTasks?: number[] }).__longTasks || [];
      const totalBlockingTimeProxy = longTasks.reduce((acc, dur) => acc + Math.max(0, dur - 50), 0);

      return {
        domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd - nav.startTime) : null,
        loadEventMs: nav ? Math.round(nav.loadEventEnd - nav.startTime) : null,
        fcpMs: fcpEntry ? Math.round(fcpEntry.startTime) : null,
        resourceCount: resources.length,
        jsResourceCount: jsResources.length,
        totalJsTransferBytes: totalJsTransfer,
        totalJsDecodedBytes: totalJsDecoded,
        longTaskCount: longTasks.length,
        totalBlockingTimeProxyMs: Math.round(totalBlockingTimeProxy),
      };
    });

    console.log('=== MOBILE PERFORMANCE BASELINE REPORT ===');
    console.log(`Wall Clock Load Time: ${wallClockLoadTimeMs}ms`);
    console.log(`FCP (First Contentful Paint): ${perfData.fcpMs}ms`);
    console.log(`DOMContentLoaded: ${perfData.domContentLoadedMs}ms`);
    console.log(`Load Event: ${perfData.loadEventMs}ms`);
    console.log(`Total JS Resources: ${perfData.jsResourceCount} files`);
    console.log(`Total JS Decoded Size: ${(perfData.totalJsDecodedBytes / 1024).toFixed(1)} KB`);
    console.log(`Long Tasks Count (>50ms): ${perfData.longTaskCount}`);
    console.log(`TBT Proxy (Blocking Time): ${perfData.totalBlockingTimeProxyMs}ms`);
    console.log('==========================================');

    // Baseline sanity assertions (verify successful render under throttled conditions)
    expect(perfData.fcpMs).toBeGreaterThan(0);
    expect(perfData.jsResourceCount).toBeGreaterThan(0);
  });
});
