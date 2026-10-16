import { describe, it, expect } from 'vitest';
import {
  canonicalizeMahallaName,
  normalizeMahallaName,
  areMahallasEquivalent,
  ensureOfficialMahallaSuffix,
} from '../src/mahalla.js';

describe('Mahalla Normalization & Equivalence Contracts', () => {
  describe('canonicalizeMahallaName', () => {
    it('strips Cyrillic administrative MFY suffixes preserving capitalization', () => {
      expect(canonicalizeMahallaName('Раваллик ва Яккақайроғоч МФЙ')).toBe(
        'Раваллик ва Яккақайроғоч'
      );
      expect(canonicalizeMahallaName('Равотликлар МФЙ')).toBe('Равотликлар');
      expect(canonicalizeMahallaName('Равотликлар м.ф.й.')).toBe('Равотликлар');
      expect(canonicalizeMahallaName('Равотликлар М.Ф.Й.')).toBe('Равотликлар');
      expect(canonicalizeMahallaName('Равотликлар МФЙ.')).toBe('Равотликлар');
    });

    it('strips Cyrillic mahalla/mahallasi words', () => {
      expect(canonicalizeMahallaName('Истиқлол маҳалласи')).toBe('Истиқлол');
      expect(canonicalizeMahallaName('Истиқлол маҳалла')).toBe('Истиқлол');
      expect(canonicalizeMahallaName('Истиқлол махалласи')).toBe('Истиқлол');
      expect(canonicalizeMahallaName('Истиқлол махалла')).toBe('Истиқлол');
    });

    it('strips Latin administrative suffixes and abbreviations', () => {
      expect(canonicalizeMahallaName('Navbahor MFY')).toBe('Navbahor');
      expect(canonicalizeMahallaName('Navbahor m.f.y.')).toBe('Navbahor');
      expect(canonicalizeMahallaName('Navbahor M.F.Y.')).toBe('Navbahor');
      expect(canonicalizeMahallaName('Navbahor mahallasi')).toBe('Navbahor');
      expect(canonicalizeMahallaName('Navbahor mahalla')).toBe('Navbahor');
    });

    it('handles prefixes as well as suffixes', () => {
      expect(canonicalizeMahallaName('МФЙ Раваллик')).toBe('Раваллик');
      expect(canonicalizeMahallaName('MFY Navbahor')).toBe('Navbahor');
      expect(canonicalizeMahallaName('маҳалласи Истиқлол')).toBe('Истиқлол');
      expect(canonicalizeMahallaName('МФЙ Раваллик маҳалласи')).toBe('Раваллик');
    });

    it('unifies diverse apostrophes to standard ASCII single quote', () => {
      expect(canonicalizeMahallaName("Bog'iston")).toBe("Bog'iston");
      expect(canonicalizeMahallaName('Bogʻiston')).toBe("Bog'iston");
      expect(canonicalizeMahallaName('Bogʼiston')).toBe("Bog'iston");
      expect(canonicalizeMahallaName('Bog`iston')).toBe("Bog'iston");
      expect(canonicalizeMahallaName('Bog’iston')).toBe("Bog'iston");
      expect(canonicalizeMahallaName("Do'stlik mahallasi")).toBe("Do'stlik");
      expect(canonicalizeMahallaName('Doʻstlik MFY')).toBe("Do'stlik");
    });

    it('collapses multiple spaces and trims', () => {
      expect(canonicalizeMahallaName('  Раваллик   ва   Яккақайроғоч   МФЙ  ')).toBe(
        'Раваллик ва Яккақайроғоч'
      );
    });

    it('returns empty string for empty or whitespace-only inputs', () => {
      expect(canonicalizeMahallaName('')).toBe('');
      expect(canonicalizeMahallaName('   ')).toBe('');
    });

    it('falls back to trimmed input if cleaning leaves an empty string', () => {
      expect(canonicalizeMahallaName('МФЙ')).toBe('МФЙ');
      expect(canonicalizeMahallaName('маҳалласи')).toBe('маҳалласи');
      expect(canonicalizeMahallaName('MFY')).toBe('MFY');
    });
  });

  describe('normalizeMahallaName', () => {
    it('returns lowercased canonical name', () => {
      expect(normalizeMahallaName('Раваллик ва Яккақайроғоч МФЙ')).toBe(
        'раваллик ва яккақайроғоч'
      );
      expect(normalizeMahallaName('Navbahor MFY')).toBe('navbahor');
      expect(normalizeMahallaName("Bogʻiston")).toBe("bog'iston");
    });
  });

  describe('areMahallasEquivalent', () => {
    it('identifies identical and suffix-variant Cyrillic mahallas as equivalent', () => {
      expect(
        areMahallasEquivalent(
          'Раваллик ва Яккақайроғоч МФЙ',
          'Раваллик ва Яккақайроғоч'
        )
      ).toBe(true);
      expect(
        areMahallasEquivalent(
          'РАВАЛЛИК ВА ЯККАҚАЙРОҒОЧ МФЙ',
          'раваллик ва яккақайроғоч'
        )
      ).toBe(true);
      expect(
        areMahallasEquivalent('Равотликлар МФЙ', 'Равотликлар')
      ).toBe(true);
      expect(
        areMahallasEquivalent('Истиқлол маҳалласи', 'Истиқлол МФЙ')
      ).toBe(true);
    });

    it('identifies identical and suffix-variant Latin mahallas as equivalent', () => {
      expect(
        areMahallasEquivalent('Navbahor MFY', 'Navbahor mahallasi')
      ).toBe(true);
      expect(areMahallasEquivalent('Navbahor', 'navbahor')).toBe(true);
    });

    it('identifies apostrophe variants as equivalent', () => {
      expect(areMahallasEquivalent("Bog'iston", 'Bogʻiston')).toBe(true);
      expect(areMahallasEquivalent('Bog`iston', 'Bog’iston')).toBe(true);
      expect(areMahallasEquivalent("Do'stlik mahallasi", 'Doʻstlik MFY')).toBe(
        true
      );
    });

    it('distinguishes distinct mahallas as non-equivalent', () => {
      expect(areMahallasEquivalent('Navbahor', "Do'stlik")).toBe(false);
      expect(areMahallasEquivalent('Равотликлар', 'Раваллик')).toBe(false);
    });
  });

  describe('ensureOfficialMahallaSuffix', () => {
    it('appends official Cyrillic "МФЙ" when suffix is absent', () => {
      expect(ensureOfficialMahallaSuffix('Раваллик ва Яккақайроғоч')).toBe(
        'Раваллик ва Яккақайроғоч МФЙ'
      );
      expect(ensureOfficialMahallaSuffix('Равотликлар')).toBe('Равотликлар МФЙ');
      expect(ensureOfficialMahallaSuffix('Navbahor')).toBe('Navbahor МФЙ');
    });

    it('preserves existing official Cyrillic "МФЙ"', () => {
      expect(ensureOfficialMahallaSuffix('Раваллик ва Яккақайроғоч МФЙ')).toBe(
        'Раваллик ва Яккақайроғоч МФЙ'
      );
      expect(ensureOfficialMahallaSuffix('Равотликлар МФЙ')).toBe('Равотликлар МФЙ');
    });

    it('normalizes lowercase or non-standard MFY variants to "МФЙ"', () => {
      expect(ensureOfficialMahallaSuffix('Равотликлар мфй')).toBe('Равотликлар МФЙ');
      expect(ensureOfficialMahallaSuffix('Равотликлар м.ф.й.')).toBe('Равотликлар МФЙ');
      expect(ensureOfficialMahallaSuffix('Равотликлар М.Ф.Й.')).toBe('Равотликлар МФЙ');
      expect(ensureOfficialMahallaSuffix('Navbahor MFY')).toBe('Navbahor МФЙ');
      expect(ensureOfficialMahallaSuffix('Navbahor m.f.y.')).toBe('Navbahor МФЙ');
    });

    it('replaces administrative words like "маҳалласи" with "МФЙ"', () => {
      expect(ensureOfficialMahallaSuffix('Истиқлол маҳалласи')).toBe('Истиқлол МФЙ');
      expect(ensureOfficialMahallaSuffix('Navbahor mahallasi')).toBe('Navbahor МФЙ');
    });

    it('handles standalone "МФЙ" and empty inputs', () => {
      expect(ensureOfficialMahallaSuffix('МФЙ')).toBe('МФЙ');
      expect(ensureOfficialMahallaSuffix('м.ф.й.')).toBe('МФЙ');
      expect(ensureOfficialMahallaSuffix('')).toBe('');
      expect(ensureOfficialMahallaSuffix('   ')).toBe('');
    });
  });
});

