import { describe, it, expect } from 'vitest';
import {
  getMahallaColor,
  normalizeMahallaName,
  MAHALLA_PALETTE,
} from '../../src/utils/mahalla-colors.js';

describe('mahalla-colors utility', () => {
  it('returns valid hex color tokens for all palette entries', () => {
    expect(MAHALLA_PALETTE.length).toBe(19);
    for (const token of MAHALLA_PALETTE) {
      expect(token.bg).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(token.border).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(token.text).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(token.icon).toMatch(/^#[0-9A-Fa-f]{6}$/);
      // Ensure alert red is never used in the mahalla palette
      expect(token.bg).not.toBe('#FEE2E2');
      expect(token.text).not.toBe('#EF4444');
      expect(token.text).not.toBe('#DC2626');
    }
  });

  it('normalizes suffixes and apostrophes consistently', () => {
    expect(normalizeMahallaName('Navbahor')).toBe('navbahor');
    expect(normalizeMahallaName('Navbahor mahallasi')).toBe('navbahor');
    expect(normalizeMahallaName('Navbahor mahalla')).toBe('navbahor');
    expect(normalizeMahallaName('Навбаҳор маҳалласи')).toBe('навбаҳор');
    expect(normalizeMahallaName("Do'stlik mahallasi")).toBe("do'stlik");
    expect(normalizeMahallaName("Doʻstlik MFY")).toBe("do'stlik");
  });

  it('deterministically assigns the same color to identical or suffix-equivalent names', () => {
    const color1 = getMahallaColor('Navbahor');
    const color2 = getMahallaColor('Navbahor mahallasi');
    const color3 = getMahallaColor('  NAVBAHOR  ');

    expect(color1).toEqual(color2);
    expect(color1).toEqual(color3);
  });

  it('returns safe fallback for empty or whitespace-only inputs', () => {
    const emptyColor = getMahallaColor('');
    const whitespaceColor = getMahallaColor('   ');

    expect(emptyColor).toBeDefined();
    expect(emptyColor.bg).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(whitespaceColor).toEqual(emptyColor);
  });

  it('distributes different colors across different mahallas', () => {
    const sampleMahallas = [
      'Navbahor',
      'Gulbodom',
      'Navroʻz',
      'Bogʻbonlar',
      'Doʻstlik',
      'Istiqlol',
      'Chilonzor',
      'Yakkasaroy',
    ];

    const assignedColors = sampleMahallas.map((name) => getMahallaColor(name));
    const uniqueBackgrounds = new Set(assignedColors.map((c) => c.bg));

    // With 8 distinct names, we should have strong hue variety (> 1 unique color)
    expect(uniqueBackgrounds.size).toBeGreaterThan(3);
  });
});
