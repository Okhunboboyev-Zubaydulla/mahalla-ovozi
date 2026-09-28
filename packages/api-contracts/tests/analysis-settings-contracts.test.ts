import { describe, it, expect } from 'vitest';
import { SaveDistrictAnalysisSettingsDraftSchema } from '../src/analysis-settings.js';

describe('SaveDistrictAnalysisSettingsDraftSchema validation', () => {
  const validPayload = {
    hokimRecognitionTerms: ['Ҳоким', 'Раҳбар'],
    localVocabularyAdditions: [
      {
        term: 'Чилонзор кўчаси',
        category: 'Йўл ва инфратузилма',
        description: 'Чилонзор кўчаси таъмири',
      },
    ],
  };

  it('accepts valid district payload with terms and vocabulary', () => {
    const result = SaveDistrictAnalysisSettingsDraftSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it('rejects vocabulary with more than 100 items (DoS prevention)', () => {
    const oversizedVocabulary = Array.from({ length: 101 }, (_, i) => ({
      term: `term_${i}`,
      category: 'OTHER',
      description: 'Test description',
    }));

    const result = SaveDistrictAnalysisSettingsDraftSchema.safeParse({
      ...validPayload,
      localVocabularyAdditions: oversizedVocabulary,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.path.includes('localVocabularyAdditions'),
      );
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('100');
    }
  });

  it('rejects duplicate hokim recognition terms', () => {
    const result = SaveDistrictAnalysisSettingsDraftSchema.safeParse({
      ...validPayload,
      hokimRecognitionTerms: ['Ҳоким', 'ҳоким'],
    });

    expect(result.success).toBe(false);
  });
});
