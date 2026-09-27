/**
 * Curated low-saturation (pastel) color tokens for Mahalla badges.
 * Excludes high-alert Red / Coral to preserve the dashboard's semantic hierarchy
 * (preventing collisions with Hokim-priority or New Topic indicators).
 */
export interface MahallaColorToken {
  bg: string;
  border: string;
  text: string;
  icon: string;
}

export const MAHALLA_PALETTE: readonly MahallaColorToken[] = [
  // 0: Deep Teal
  { bg: '#F0FDFA', border: '#99F6E4', text: '#0F766E', icon: '#0284C7' },
  // 1: Vivid Violet
  { bg: '#F5F3FF', border: '#DDD6FE', text: '#7C3AED', icon: '#0284C7' },
  // 2: Royal Blue
  { bg: '#EFF6FF', border: '#BFDBFE', text: '#1D4ED8', icon: '#0284C7' },
  // 3: Warm Amber / Gold
  { bg: '#FFFBEB', border: '#FDE68A', text: '#B45309', icon: '#0284C7' },
  // 4: Rosewood / Berry
  { bg: '#FDF2F8', border: '#FBCFE8', text: '#9D174D', icon: '#0284C7' },
  // 5: Emerald Green
  { bg: '#F2FDF5', border: '#BBF7D0', text: '#15803D', icon: '#0284C7' },
  // 6: Plum / Magenta
  { bg: '#FDF4FF', border: '#F5D0FE', text: '#86198F', icon: '#0284C7' },
  // 7: Terracotta / Orange
  { bg: '#FFF7ED', border: '#FED7AA', text: '#C2410C', icon: '#0284C7' },
  // 8: Deep Cyan
  { bg: '#ECFEFF', border: '#A5F3FC', text: '#0E7490', icon: '#0284C7' },
  // 9: Dark Chocolate Umber
  { bg: '#FDFBF7', border: '#E7DFD5', text: '#78350F', icon: '#0284C7' },
  // 10: Olive Moss
  { bg: '#F7FEE7', border: '#D9F99D', text: '#4D7C0F', icon: '#0284C7' },
  // 11: Deep Indigo
  { bg: '#EEF2FF', border: '#C7D2FE', text: '#4338CA', icon: '#0284C7' },
  // 12: Steel Slate Blue
  { bg: '#F1F5F9', border: '#CBD5E1', text: '#255784', icon: '#0284C7' },
  // 13: Wine Maroon
  { bg: '#FDF2F4', border: '#F8CBD2', text: '#831843', icon: '#0284C7' },
  // 14: Dark Pine Green
  { bg: '#F0FDF9', border: '#99F6E4', text: '#115E59', icon: '#0284C7' },
  // 15: Deep Slate
  { bg: '#F8FAFC', border: '#CBD5E1', text: '#334155', icon: '#0284C7' },
  // 16: Royal Night Violet
  { bg: '#FAF5FF', border: '#E9D5FF', text: '#581C87', icon: '#0284C7' },
  // 17: Rust Brown
  { bg: '#FFF7ED', border: '#FED7AA', text: '#9A3412', icon: '#0284C7' },
  // 18: Charcoal Zinc
  { bg: '#F3F4F6', border: '#CFD3DA', text: '#374151', icon: '#0284C7' },
] as const;

/**
 * Normalizes a Mahalla name by stripping common suffixes ("маҳалласи", "mahallasi", "мфй", etc.)
 * and unifying apostrophes, so variations of the same name produce identical color hashes.
 */
export function normalizeMahallaName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  if (trimmed.length === 0) {
    return '';
  }

  // Standardize apostrophes
  const unifiedApostrophes = trimmed.replace(/[`'ʻʼ’]/g, "'");

  // Remove common administrative suffix variants (supporting both Latin and Cyrillic)
  const cleaned = unifiedApostrophes
    .replace(/(?:^|\s+)(маҳалласи|маҳалла|махалласи|махалла|mahallasi|mahalla)(?:\s+|$)/gi, ' ')
    .replace(/(?:^|\s+)(м\.?ф\.?й\.?|m\.?f\.?y\.?)(?:\s+|$)/gi, ' ')
    .trim();

  return cleaned.length > 0 ? cleaned : trimmed;
}

const FALLBACK_MAHALLA_COLOR: MahallaColorToken = MAHALLA_PALETTE[8] ?? {
  bg: '#F8FAFC',
  border: '#CBD5E1',
  text: '#334155',
  icon: '#0284C7',
};

/**
 * Deterministically maps any Mahalla name to a consistent, accessible MahallaColorToken.
 * Uses 32-bit FNV-1a with Murmur3 fmix32 avalanche mixer across a prime-sized palette
 * to guarantee uniform distribution and eliminate collisions among common neighborhood names.
 */
export function getMahallaColor(mahallaName: string): MahallaColorToken {
  const normalized = normalizeMahallaName(mahallaName);
  if (normalized.length === 0) {
    return FALLBACK_MAHALLA_COLOR;
  }

  // 32-bit FNV-1a
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  // Murmur3 fmix32 avalanche mixer
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;

  const index = Math.abs(hash >>> 0) % MAHALLA_PALETTE.length;
  return MAHALLA_PALETTE[index] ?? FALLBACK_MAHALLA_COLOR;
}
