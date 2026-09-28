import { describe, it, expect } from 'vitest';
import {
  computeSnapshotFingerprint,
  verifySnapshotIntegrity,
  assertSnapshotRevision,
  StaleSnapshotRevisionError,
  MahallaDailySnapshot,
  AcceptedEvidenceItem,
  formatEvidenceItemLine,
  formatSnapshotEvidenceList,
  groupSnapshotByTopic,
  formatSnapshotForSemanticRelevance,
} from '../src/modules/ai/context-snapshot.js';

describe('Context Snapshot Kernel & Cryptographic Integrity Tests (AD-5, AD-6)', () => {
  const sampleEvidence: AcceptedEvidenceItem[] = [
    {
      id: 'ev_1',
      topicId: 'top_1',
      telegramMessageId: '1001',
      originalTimestamp: '2026-08-25T10:00:00.000Z',
      verbatimText: 'Elektr ta`minotida uzilishlar bo`lyapti',
      lane: 'ELECTRICITY',
    },
    {
      id: 'ev_2',
      topicId: 'top_1',
      telegramMessageId: '1002',
      originalTimestamp: '2026-08-25T10:05:00.000Z',
      verbatimText: 'Yo`l ta`mirlash ishlari to`xtab qoldi',
      lane: 'ELECTRICITY',
    },
    {
      id: 'ev_3',
      topicId: 'top_2',
      telegramMessageId: '1003',
      originalTimestamp: '2026-08-25T10:10:00.000Z',
      verbatimText: 'Suv quvuri yorildi',
      lane: 'WATER',
    },
  ];

  it('computes deterministic SHA-256 fingerprint for non-empty evidence array', () => {
    const hash1 = computeSnapshotFingerprint(sampleEvidence);
    const hash2 = computeSnapshotFingerprint(sampleEvidence);
    expect(hash1).toBe(hash2);
    expect(typeof hash1).toBe('string');
    expect(hash1.length).toBe(64); // SHA-256 hex string
  });

  it('returns sentinel empty hash for empty evidence list', () => {
    expect(computeSnapshotFingerprint([])).toBe('sha256_empty_v1');
  });

  it('verifies integrity of valid snapshot successfully', () => {
    const validSnapshot: MahallaDailySnapshot = {
      districtId: 'dist_1',
      mahallaName: 'Navbahor',
      calendarDay: '2026-08-25',
      contextRevision: 3,
      snapshotFingerprint: computeSnapshotFingerprint(sampleEvidence),
      evidence: sampleEvidence,
    };

    expect(verifySnapshotIntegrity(validSnapshot)).toBe(true);
  });

  it('rejects snapshot with tampered fingerprint', () => {
    const tamperedSnapshot: MahallaDailySnapshot = {
      districtId: 'dist_1',
      mahallaName: 'Navbahor',
      calendarDay: '2026-08-25',
      contextRevision: 3,
      snapshotFingerprint: 'tampered_fake_sha256_hash_1234567890abcdef',
      evidence: sampleEvidence,
    };

    expect(verifySnapshotIntegrity(tamperedSnapshot)).toBe(false);
  });

  it('rejects snapshot with mismatched contextRevision count', () => {
    const mismatchedRevisionSnapshot: MahallaDailySnapshot = {
      districtId: 'dist_1',
      mahallaName: 'Navbahor',
      calendarDay: '2026-08-25',
      contextRevision: 999,
      snapshotFingerprint: computeSnapshotFingerprint(sampleEvidence),
      evidence: sampleEvidence,
    };

    expect(verifySnapshotIntegrity(mismatchedRevisionSnapshot)).toBe(false);
  });

  it('assertSnapshotRevision succeeds when revisions match (CAS pass)', () => {
    expect(() => assertSnapshotRevision(5, 5)).not.toThrow();
  });

  it('assertSnapshotRevision throws StaleSnapshotRevisionError on CAS mismatch', () => {
    expect(() => assertSnapshotRevision(6, 5)).toThrow(StaleSnapshotRevisionError);
    try {
      assertSnapshotRevision(6, 5);
    } catch (err) {
      expect(err).toBeInstanceOf(StaleSnapshotRevisionError);
      const staleErr = err as StaleSnapshotRevisionError;
      expect(staleErr.code).toBe('STALE_SNAPSHOT');
      expect(staleErr.status).toBe(409);
    }
  });

  describe('Deterministic Prompt Serialization Helpers (AD-5)', () => {
    it('formats single evidence item line with canonical markers', () => {
      const line = formatEvidenceItemLine(sampleEvidence[0]!, 0, {
        includeLane: true,
      });
      expect(line).toBe(
        '[#1] Timestamp: 2026-08-25T10:00:00.000Z | MsgID: 1001 | Lane: [ELECTRICITY] | Text: "Elektr ta`minotida uzilishlar bo`lyapti"',
      );
    });

    it('formats evidence item line with ID, custom prefix and indent', () => {
      const line = formatEvidenceItemLine(sampleEvidence[0]!, 0, {
        prefix: 'Evidence #1',
        includeId: true,
        indent: '  ',
        timeLabel: 'Time',
      });
      expect(line).toBe(
        '  [Evidence #1] ID: ev_1 | Time: 2026-08-25T10:00:00.000Z | MsgID: 1001 | Text: "Elektr ta`minotida uzilishlar bo`lyapti"',
      );
    });

    it('formats evidence item line with authorLabel when provided', () => {
      const line = formatEvidenceItemLine(sampleEvidence[0]!, 0, {
        prefix: 'Evidence #1',
        includeId: true,
        authorLabel: 'Citizen #1 (@Zubaydulla)',
        timeLabel: 'Time',
      });
      expect(line).toBe(
        '[Evidence #1] ID: ev_1 | Author: [Citizen #1 (@Zubaydulla)] | Time: 2026-08-25T10:00:00.000Z | MsgID: 1001 | Text: "Elektr ta`minotida uzilishlar bo`lyapti"',
      );
    });

    it('formats evidence item line with includeAuthor using item.authorHandle or item.telegramUserId', () => {
      const evidenceWithAuthor: AcceptedEvidenceItem = {
        ...sampleEvidence[0]!,
        authorHandle: '@testuser',
        telegramUserId: '12345678',
      };
      const line = formatEvidenceItemLine(evidenceWithAuthor, 0, {
        includeAuthor: true,
      });
      expect(line).toContain('Author: [@testuser]');
    });

    it('formats flat evidence list correctly with relative time offsets', () => {
      const list = formatSnapshotEvidenceList(sampleEvidence.slice(0, 2), {
        includeLane: true,
      });
      expect(list).toContain('[#1] Timestamp: 2026-08-25T10:00:00.000Z | MsgID: 1001 | Lane: [ELECTRICITY]');
      expect(list).toContain('[#2] Timestamp: 2026-08-25T10:05:00.000Z (+5m from previous) | MsgID: 1002 | Lane: [ELECTRICITY]');
    });

    it('groups evidence deterministically by topicId and preserves topicSummary', () => {
      const snapshot: MahallaDailySnapshot = {
        districtId: 'dist_1',
        mahallaName: 'Navbahor',
        calendarDay: '2026-08-25',
        contextRevision: 3,
        snapshotFingerprint: computeSnapshotFingerprint(sampleEvidence),
        evidence: [
          {
            ...sampleEvidence[0]!,
            topicSummary: 'Электр таъминотида узилиш хабар қилинмоқда',
          },
          sampleEvidence[1]!,
          {
            ...sampleEvidence[2]!,
            topicSummary: 'Сув қувури ёрилиши',
          },
        ],
      };

      const topicMap = groupSnapshotByTopic(snapshot);
      expect(topicMap.size).toBe(2);
      expect(topicMap.get('top_1')?.items.length).toBe(2);
      expect(topicMap.get('top_1')?.summary).toBe('Электр таъминотида узилиш хабар қилинмоқда');
      expect(topicMap.get('top_2')?.items.length).toBe(1);
      expect(topicMap.get('top_2')?.summary).toBe('Сув қувури ёрилиши');
    });

    it('formats semantic relevance context section with relative time offsets', () => {
      const snapshot: MahallaDailySnapshot = {
        districtId: 'dist_1',
        mahallaName: 'Navbahor',
        calendarDay: '2026-08-25',
        contextRevision: 3,
        snapshotFingerprint: computeSnapshotFingerprint(sampleEvidence),
        evidence: sampleEvidence,
      };

      const formatted = formatSnapshotForSemanticRelevance(snapshot);
      expect(formatted).toContain('### SAME-DAY ACCEPTED EVIDENCE CONTEXT (Mahalla: Navbahor, Day: 2026-08-25)');
      expect(formatted).toContain('[#1] Timestamp: 2026-08-25T10:00:00.000Z | MsgID: 1001 | Lane: [ELECTRICITY] | Text: "Elektr ta`minotida uzilishlar bo`lyapti"');
      expect(formatted).toContain('[#2] Timestamp: 2026-08-25T10:05:00.000Z (+5m from previous) | MsgID: 1002 | Lane: [ELECTRICITY] | Text: "Yo`l ta`mirlash ishlari to`xtab qoldi"');
      expect(formatted).toContain('[#3] Timestamp: 2026-08-25T10:10:00.000Z (+5m from previous) | MsgID: 1003 | Lane: [WATER] | Text: "Suv quvuri yorildi"');
    });

    it('formats semantic relevance context for empty snapshot', () => {
      const emptySnapshot: MahallaDailySnapshot = {
        districtId: 'dist_1',
        mahallaName: 'Guliston',
        calendarDay: '2026-08-25',
        contextRevision: 0,
        snapshotFingerprint: 'sha256_empty_v1',
        evidence: [],
      };

      const formatted = formatSnapshotForSemanticRelevance(emptySnapshot);
      expect(formatted).toContain('(No accepted evidence recorded yet today for this Mahalla)');
    });
  });
});

