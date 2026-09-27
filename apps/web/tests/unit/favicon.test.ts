// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { devFaviconPlugin } from '../../vite.config';

describe('Favicon Configuration and Assets', () => {
  const publicDir = path.resolve(__dirname, '../../public');
  const indexHtmlPath = path.resolve(__dirname, '../../index.html');

  it('contains valid production SVG favicon with brand blue color', () => {
    const svgPath = path.join(publicDir, 'favicon.svg');
    expect(fs.existsSync(svgPath)).toBe(true);
    const content = fs.readFileSync(svgPath, 'utf-8');
    expect(content).toContain('#0284C7');
    expect(content).toContain('<svg');
  });

  it('contains valid development SVG favicon with amber color', () => {
    const devSvgPath = path.join(publicDir, 'favicon-dev.svg');
    expect(fs.existsSync(devSvgPath)).toBe(true);
    const content = fs.readFileSync(devSvgPath, 'utf-8');
    expect(content).toContain('#D97706');
    expect(content).toContain('<svg');
  });

  it('contains valid favicon.ico binary asset with ICO header', () => {
    const icoPath = path.join(publicDir, 'favicon.ico');
    expect(fs.existsSync(icoPath)).toBe(true);
    const buffer = fs.readFileSync(icoPath);
    expect(buffer.length).toBeGreaterThan(0);
    // ICO header magic: 0x00, 0x00, 0x01, 0x00
    expect(buffer[0]).toBe(0);
    expect(buffer[1]).toBe(0);
    expect(buffer[2]).toBe(1);
    expect(buffer[3]).toBe(0);
  });

  it('contains valid apple-touch-icon.png with PNG header', () => {
    const pngPath = path.join(publicDir, 'apple-touch-icon.png');
    expect(fs.existsSync(pngPath)).toBe(true);
    const buffer = fs.readFileSync(pngPath);
    expect(buffer.length).toBeGreaterThan(0);
    // PNG header magic: 0x89, 'P', 'N', 'G'
    expect(buffer[0]).toBe(0x89);
    expect(buffer[1]).toBe(0x50);
    expect(buffer[2]).toBe(0x4e);
    expect(buffer[3]).toBe(0x47);
  });

  it('declares favicon links in index.html', () => {
    const html = fs.readFileSync(indexHtmlPath, 'utf-8');
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
    expect(html).toContain('<link rel="alternate icon" href="/favicon.ico" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
  });

  it('devFaviconPlugin transforms index.html to serve /favicon-dev.svg in dev mode', () => {
    const plugin = devFaviconPlugin();
    expect(plugin.apply).toBe('serve');
    const inputHtml = '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transformFn = plugin.transformIndexHtml as any;
    const transformed = typeof transformFn === 'function' ? transformFn(inputHtml) : transformFn.handler(inputHtml);
    expect(transformed).toBe('<link rel="icon" type="image/svg+xml" href="/favicon-dev.svg" />');
  });
});
