import type {
  DistrictAnalysisSettingsDto,
  DistrictAnalysisSettingsDraftDto,
  SaveDistrictAnalysisSettingsDraftRequest,
  DistrictLocalVocabularyItem,
} from '@mahalla-ovozi/api-contracts';

export interface VocabularyDiffItem {
  term: string;
  type: 'added' | 'removed' | 'modified' | 'unchanged';
  category: string;
  oldCategory?: string;
  description?: string;
  oldDescription?: string;
}

export interface HokimTermDiffItem {
  term: string;
  type: 'added' | 'removed' | 'unchanged';
}

export interface DistrictSettingsDiff {
  hokimTermsDiffs: HokimTermDiffItem[];
  vocabularyDiffs: VocabularyDiffItem[];
  hasChanges: boolean;
  totalChangesCount: number;
}

export function computeDistrictSettingsDiff(
  active: DistrictAnalysisSettingsDto,
  draft:
    | DistrictAnalysisSettingsDto
    | DistrictAnalysisSettingsDraftDto
    | SaveDistrictAnalysisSettingsDraftRequest
    | null,
): DistrictSettingsDiff {
  if (!draft) {
    return {
      hokimTermsDiffs: [],
      vocabularyDiffs: [],
      hasChanges: false,
      totalChangesCount: 0,
    };
  }

  let totalChanges = 0;

  // 1. Hokim Recognition Terms diffs
  const activeTermsMap = new Map<string, string>();
  for (const term of active?.hokimRecognitionTerms || []) {
    if (typeof term !== 'string') continue;
    const key = term.trim().toLowerCase().normalize('NFC').replace(/\s+/g, ' ');
    if (key) activeTermsMap.set(key, term.trim());
  }

  const draftTermsMap = new Map<string, string>();
  for (const term of draft?.hokimRecognitionTerms || []) {
    if (typeof term !== 'string') continue;
    const key = term.trim().toLowerCase().normalize('NFC').replace(/\s+/g, ' ');
    if (key) draftTermsMap.set(key, term.trim());
  }

  const hokimTermsDiffs: HokimTermDiffItem[] = [];

  for (const [key, draftTerm] of draftTermsMap.entries()) {
    if (!activeTermsMap.has(key)) {
      hokimTermsDiffs.push({
        term: draftTerm,
        type: 'added',
      });
      totalChanges++;
    } else {
      hokimTermsDiffs.push({
        term: draftTerm,
        type: 'unchanged',
      });
    }
  }

  for (const [key, activeTerm] of activeTermsMap.entries()) {
    if (!draftTermsMap.has(key)) {
      hokimTermsDiffs.push({
        term: activeTerm,
        type: 'removed',
      });
      totalChanges++;
    }
  }

  // 2. District Local Vocabulary diffs
  const activeVocabMap = new Map<string, DistrictLocalVocabularyItem>();
  for (const item of active?.localVocabularyAdditions || []) {
    if (!item || typeof item.term !== 'string') continue;
    const key = item.term.trim().toLowerCase().normalize('NFC').replace(/\s+/g, ' ');
    if (key) activeVocabMap.set(key, item);
  }

  const draftVocabMap = new Map<string, DistrictLocalVocabularyItem>();
  for (const item of draft?.localVocabularyAdditions || []) {
    if (!item || typeof item.term !== 'string') continue;
    const key = item.term.trim().toLowerCase().normalize('NFC').replace(/\s+/g, ' ');
    if (key) draftVocabMap.set(key, item);
  }

  const vocabularyDiffs: VocabularyDiffItem[] = [];

  for (const [key, draftItem] of draftVocabMap.entries()) {
    const activeItem = activeVocabMap.get(key);
    const draftCategory = (draftItem.category || '').trim();
    const draftDesc = (draftItem.description || '').trim();

    if (!activeItem) {
      vocabularyDiffs.push({
        term: draftItem.term,
        type: 'added',
        category: draftItem.category,
        description: draftItem.description,
      });
      totalChanges++;
    } else {
      const activeCategory = (activeItem.category || '').trim();
      const activeDesc = (activeItem.description || '').trim();
      const isModified =
        activeCategory !== draftCategory || activeDesc !== draftDesc;

      if (isModified) {
        vocabularyDiffs.push({
          term: draftItem.term,
          type: 'modified',
          category: draftItem.category,
          oldCategory: activeItem.category,
          description: draftItem.description,
          oldDescription: activeItem.description,
        });
        totalChanges++;
      } else {
        vocabularyDiffs.push({
          term: draftItem.term,
          type: 'unchanged',
          category: draftItem.category,
          description: draftItem.description,
        });
      }
    }
  }

  for (const [key, activeItem] of activeVocabMap.entries()) {
    if (!draftVocabMap.has(key)) {
      vocabularyDiffs.push({
        term: activeItem.term,
        type: 'removed',
        category: activeItem.category,
        description: activeItem.description,
      });
      totalChanges++;
    }
  }

  return {
    hokimTermsDiffs,
    vocabularyDiffs,
    hasChanges: totalChanges > 0,
    totalChangesCount: totalChanges,
  };
}
