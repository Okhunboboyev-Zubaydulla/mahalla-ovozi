import { describe, it, expect } from 'vitest';
import {
  computeDistrictSettingsDiff,
} from '../../src/components/ai/diff-utils.js';
import type {
  DistrictAnalysisSettingsDto,
  DistrictAnalysisSettingsDraftDto,
} from '@mahalla-ovozi/api-contracts';

const mockActiveDistrict: DistrictAnalysisSettingsDto = {
  id: 'dcfg_v1',
  districtId: 'dist_chilonzor',
  version: 1,
  hokimRecognitionTerms: ['Ҳоким', 'Туман ҳокими', 'Сектор раҳбари'],
  localVocabularyAdditions: [
    {
      term: 'Чилонзор-1 мавзеси',
      category: 'Мўлжал ва жойлар',
      description: '1-мавзе маркази',
    },
    {
      term: 'Дўмбиробод маҳалласи',
      category: 'Маҳалла номлари',
    },
  ],
  isActive: true,
  activatedAt: '2026-08-01T00:00:00.000Z',
  createdAt: '2026-08-01T00:00:00.000Z',
};

describe('diff-utils: computeDistrictSettingsDiff (Story 5.3 & 5.4)', () => {
  it('returns empty diff and hasChanges: false when draft is null', () => {
    const diff = computeDistrictSettingsDiff(mockActiveDistrict, null);

    expect(diff.hasChanges).toBe(false);
    expect(diff.totalChangesCount).toBe(0);
    expect(diff.hokimTermsDiffs).toHaveLength(0);
    expect(diff.vocabularyDiffs).toHaveLength(0);
  });

  it('detects zero changes when draft has identical terms and vocabulary', () => {
    const identicalDraft: DistrictAnalysisSettingsDraftDto = {
      id: 'draft_1',
      districtId: 'dist_chilonzor',
      hokimRecognitionTerms: ['Ҳоким', 'Туман ҳокими', 'Сектор раҳбари'],
      localVocabularyAdditions: [
        {
          term: 'Чилонзор-1 мавзеси',
          category: 'Мўлжал ва жойлар',
          description: '1-мавзе маркази',
        },
        {
          term: 'Дўмбиробод маҳалласи',
          category: 'Маҳалла номлари',
        },
      ],
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
    };

    const diff = computeDistrictSettingsDiff(mockActiveDistrict, identicalDraft);

    expect(diff.hasChanges).toBe(false);
    expect(diff.totalChangesCount).toBe(0);
    expect(diff.hokimTermsDiffs.every((t) => t.type === 'unchanged')).toBe(true);
    expect(diff.vocabularyDiffs.every((v) => v.type === 'unchanged')).toBe(true);
  });

  it('accurately identifies added, removed, and unchanged Hokim recognition terms', () => {
    const modifiedDraft: DistrictAnalysisSettingsDraftDto = {
      id: 'draft_1',
      districtId: 'dist_chilonzor',
      hokimRecognitionTerms: ['Ҳоким', 'Ҳоким ёрдамчиси', '1-сектор раҳбари'],
      localVocabularyAdditions: mockActiveDistrict.localVocabularyAdditions,
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
    };

    const diff = computeDistrictSettingsDiff(mockActiveDistrict, modifiedDraft);

    expect(diff.hasChanges).toBe(true);

    const added = diff.hokimTermsDiffs.filter((t) => t.type === 'added');
    const removed = diff.hokimTermsDiffs.filter((t) => t.type === 'removed');
    const unchanged = diff.hokimTermsDiffs.filter((t) => t.type === 'unchanged');

    expect(added.map((t) => t.term)).toEqual(
      expect.arrayContaining(['Ҳоким ёрдамчиси', '1-сектор раҳбари']),
    );
    expect(removed.map((t) => t.term)).toEqual(
      expect.arrayContaining(['Туман ҳокими', 'Сектор раҳбари']),
    );
    expect(unchanged.map((t) => t.term)).toEqual(['Ҳоким']);
  });

  it('accurately identifies added, removed, and modified local vocabulary items', () => {
    const modifiedDraft: DistrictAnalysisSettingsDraftDto = {
      id: 'draft_1',
      districtId: 'dist_chilonzor',
      hokimRecognitionTerms: mockActiveDistrict.hokimRecognitionTerms,
      localVocabularyAdditions: [
        // Modified category and description
        {
          term: 'Чилонзор-1 мавзеси',
          category: 'Маҳаллий атамалар',
          description: 'Янгиланган 1-мавзе тавсифи',
        },
        // Added item
        {
          term: 'Бўрижар канали',
          category: 'Сув ҳавзалари ва каналлар',
          description: 'Чилонзордан оқиб ўтувчи канал',
        },
        // "Дўмбиробод маҳалласи" omitted -> removed
      ],
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
    };

    const diff = computeDistrictSettingsDiff(mockActiveDistrict, modifiedDraft);

    expect(diff.hasChanges).toBe(true);

    const added = diff.vocabularyDiffs.filter((v) => v.type === 'added');
    const removed = diff.vocabularyDiffs.filter((v) => v.type === 'removed');
    const modified = diff.vocabularyDiffs.filter((v) => v.type === 'modified');

    expect(added).toHaveLength(1);
    expect(added[0]?.term).toBe('Бўрижар канали');

    expect(removed).toHaveLength(1);
    expect(removed[0]?.term).toBe('Дўмбиробод маҳалласи');

    expect(modified).toHaveLength(1);
    expect(modified[0]?.term).toBe('Чилонзор-1 мавзеси');
    expect(modified[0]?.oldCategory).toBe('Мўлжал ва жойлар');
    expect(modified[0]?.category).toBe('Маҳаллий атамалар');
  });

  it('treats terms differing only by whitespace or unicode NFC normalization as unchanged', () => {
    const normalizedDraft: DistrictAnalysisSettingsDraftDto = {
      id: 'draft_1',
      districtId: 'dist_chilonzor',
      hokimRecognitionTerms: ['  Ҳоким  ', 'туман ҳокими', 'СЕКТОР РАҲБАРИ'],
      localVocabularyAdditions: [
        {
          term: '  чилонзор-1 мавзеси  ',
          category: 'Мўлжал ва жойлар',
          description: '1-мавзе маркази',
        },
        {
          term: 'Дўмбиробод маҳалласи',
          category: 'Маҳалла номлари',
        },
      ],
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
    };

    const diff = computeDistrictSettingsDiff(mockActiveDistrict, normalizedDraft);

    expect(diff.hasChanges).toBe(false);
    expect(diff.totalChangesCount).toBe(0);
  });
});
