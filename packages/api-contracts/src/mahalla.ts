const APOSTROPHE_REGEX = /[`'ʻʼ’‘]/gu;

// Administrative words: маҳалласи, маҳалла, махалласи, махалла, mahallasi, mahalla
const ADMINISTRATIVE_WORDS_REGEX =
  /(?:^|\s+)(?:маҳалласи|маҳалла|махалласи|махалла|mahallasi|mahalla)(?:\s+|$)/giu;

// Administrative abbreviations: м.ф.й., мфй, m.f.y., mfy
const MFY_ABBREVIATION_REGEX =
  /(?:^|\s+)(?:м\.?\s*ф\.?\s*й\.?|m\.?\s*f\.?\s*y\.?)(?:\s+|$)/giu;

/**
 * Normalizes a Mahalla name by unifying apostrophes, removing common administrative
 * suffixes/prefixes ("МФЙ", "маҳалласи", "mahallasi", etc.), collapsing consecutive
 * spaces, and preserving capitalization.
 *
 * If cleaning strips all characters (e.g. input was only "МФЙ"), falls back to the trimmed input.
 */
export function canonicalizeMahallaName(name: string): string {
  if (typeof name !== 'string') {
    return '';
  }

  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return '';
  }

  // Unify apostrophe variations to standard single quote
  const unified = trimmed.replace(APOSTROPHE_REGEX, "'");

  // Clean administrative words and abbreviations
  let cleaned = unified;
  let prev = '';
  while (cleaned !== prev) {
    prev = cleaned;
    cleaned = cleaned
      .replace(ADMINISTRATIVE_WORDS_REGEX, ' ')
      .replace(MFY_ABBREVIATION_REGEX, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return cleaned.length > 0 ? cleaned : unified;
}

/**
 * Normalizes a Mahalla name to a lowercase canonical key for grouping, indexing, and hashing.
 */
export function normalizeMahallaName(name: string): string {
  return canonicalizeMahallaName(name).toLowerCase();
}

/**
 * Checks whether two Mahalla names represent the same physical neighborhood,
 * ignoring administrative suffixes ("МФЙ", "маҳалласи"), apostrophe variations,
 * extra whitespace, and letter casing.
 */
export function areMahallasEquivalent(a: string, b: string): boolean {
  return normalizeMahallaName(a) === normalizeMahallaName(b);
}

/**
 * Ensures a Mahalla name has the official Cyrillic "МФЙ" suffix.
 * - If the trimmed input already ends with "МФЙ" (case-insensitive, Cyrillic or Latin MFY),
 *   standardizes the suffix to " МФЙ".
 * - If the trimmed input ends with administrative words like "маҳалласи", replaces with " МФЙ".
 * - If the input is empty or whitespace-only, returns empty string.
 * - Otherwise, appends " МФЙ" ensuring proper spacing.
 */
export function ensureOfficialMahallaSuffix(name: string): string {
  if (typeof name !== 'string') {
    return '';
  }

  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return '';
  }

  // If the string is already just "МФЙ" or equivalent abbreviation
  if (/^(?:м\.?\s*ф\.?\s*й\.?|m\.?\s*f\.?\s*y\.?)$/iu.test(trimmed)) {
    return 'МФЙ';
  }

  // If it ends with administrative words (маҳалласи, mahallasi, etc.)
  if (/(?:\s+)(?:маҳалласи|маҳалла|махалласи|махалла|mahallasi|mahalla)$/iu.test(trimmed)) {
    const withoutAdminWord = trimmed
      .replace(/(?:\s+)(?:маҳалласи|маҳалла|махалласи|махалла|mahallasi|mahalla)$/iu, '')
      .trim();
    if (withoutAdminWord.length > 0) {
      return `${withoutAdminWord} МФЙ`;
    }
  }

  // If it ends with any MFY abbreviation variant with preceding whitespace
  const withoutTrailingMfy = trimmed
    .replace(/(?:\s+)(?:м\.?\s*ф\.?\s*й\.?|m\.?\s*f\.?\s*y\.?)$/iu, '')
    .trim();

  if (withoutTrailingMfy !== trimmed && withoutTrailingMfy.length > 0) {
    return `${withoutTrailingMfy} МФЙ`;
  }

  // Check if it already ends with " МФЙ" (exact Cyrillic)
  if (trimmed.endsWith(' МФЙ')) {
    return trimmed;
  }

  // Check if it ends with "МФЙ" attached without space or lowercase
  if (/[\s_-]?мфй$/iu.test(trimmed)) {
    const base = trimmed.replace(/[\s_-]?мфй$/iu, '').trim();
    return base.length > 0 ? `${base} МФЙ` : 'МФЙ';
  }

  return `${trimmed} МФЙ`;
}

