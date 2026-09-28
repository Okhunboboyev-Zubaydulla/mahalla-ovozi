import { describe, it, expect } from 'vitest';
import {
  ComponentHealthObservation,
  IssueSeverity,
} from '@mahalla-ovozi/api-contracts';
import {
  generateLogicalKey,
  classifyIssueSeverity,
  deriveIssueMetadata,
  sortOperationalIssues,
} from '../src/modules/issues/issue-evaluator.js';

describe('Story 4.2: Issue Evaluator Pure Engine Tests', () => {
  const freshTime = new Date('2026-08-25T11:55:00.000Z').toISOString();

  function createObservation(
    component: ComponentHealthObservation['component'],
    status: ComponentHealthObservation['status'],
    options: Partial<ComponentHealthObservation> = {},
  ): ComponentHealthObservation {
    return {
      component,
      scope: options.scope || (component === 'database' || component === 'processing_queue' || component === 'storage' || component === 'web_application' || component === 'retention_jobs' ? 'GLOBAL' : 'DISTRICT'),
      districtId: options.districtId !== undefined ? options.districtId : (options.scope === 'GLOBAL' ? null : 'dist-chilonzor'),
      status,
      lastCheckAt: options.lastCheckAt || freshTime,
      checkedAt: options.checkedAt || freshTime,
      outcome: options.outcome || (status === 'Unavailable' || status === 'Degraded' ? 'failure' : 'success'),
      errorCode: options.errorCode || null,
      errorMessage: options.errorMessage || null,
      latencyMs: options.latencyMs !== undefined ? options.latencyMs : 20,
      isApplicable: options.isApplicable !== undefined ? options.isApplicable : true,
      lifecycleStatus: options.lifecycleStatus || 'ACTIVE',
    };
  }

  describe('1. Stable Logical Key Derivation (AC 1)', () => {
    it('generates deterministic logical key for global component', () => {
      const key = generateLogicalKey('GLOBAL', null, 'database', 'DATABASE_CONNECTION_ERROR');
      expect(key).toBe('GLOBAL:global:database:DATABASE_CONNECTION_ERROR');
    });

    it('generates deterministic logical key for district component', () => {
      const key = generateLogicalKey('DISTRICT', 'dist-yunusobod', 'telegram_bot', 'BOT_DISCONNECTED');
      expect(key).toBe('DISTRICT:dist-yunusobod:telegram_bot:BOT_DISCONNECTED');
    });

    it('produces identical logical keys regardless of timestamp or check sequence', () => {
      const key1 = generateLogicalKey('DISTRICT', 'dist-1', 'telegram_groups', 'TELEGRAM_GROUP_DISCONNECTED');
      const key2 = generateLogicalKey('DISTRICT', 'dist-1', 'telegram_groups', 'TELEGRAM_GROUP_DISCONNECTED');
      expect(key1).toBe(key2);
    });
  });

  describe('2. Deterministic Severity Classification & Guardrails (AC 2)', () => {
    it('classifies Unavailable state as Critical', () => {
      const obs = createObservation('database', 'Unavailable', { scope: 'GLOBAL', districtId: null });
      expect(classifyIssueSeverity(obs)).toBe('Critical');
    });

    it('classifies Delayed state as Warning', () => {
      const obs = createObservation('message_intake', 'Delayed');
      expect(classifyIssueSeverity(obs)).toBe('Warning');
    });

    it('classifies Degraded state as Warning', () => {
      const obs = createObservation('ai_operations', 'Degraded');
      expect(classifyIssueSeverity(obs)).toBe('Warning');
    });

    it('returns null for Healthy state (never creates failure issue)', () => {
      const obs = createObservation('telegram_bot', 'Healthy');
      expect(classifyIssueSeverity(obs)).toBeNull();
    });

    it('returns null for Quiet state (silence creates no failure issue)', () => {
      const obs = createObservation('telegram_bot', 'Quiet');
      expect(classifyIssueSeverity(obs)).toBeNull();
    });

    it('returns null for Unknown state (missing/stale evidence creates no failure issue)', () => {
      const obs = createObservation('storage', 'Unknown', { scope: 'GLOBAL', districtId: null });
      expect(classifyIssueSeverity(obs)).toBeNull();
    });

    it('returns null for non-applicable components even if degraded', () => {
      const obs = createObservation('ai_operations', 'Degraded', { isApplicable: false });
      expect(classifyIssueSeverity(obs)).toBeNull();
    });
  });

  describe('3. Uzbek Cyrillic Metadata & Target Route Mappings (AC 3, AC 5)', () => {
    it('maps Telegram bot token invalid error to BOT_TOKEN_INVALID and /telegram-setup route', () => {
      const obs = createObservation('telegram_bot', 'Unavailable', {
        districtId: 'dist-samarkand',
        errorCode: 'BOT_TOKEN_INVALID',
      });
      const meta = deriveIssueMetadata(obs, 'Самарқанд тумани');

      expect(meta.issueCategory).toBe('BOT_TOKEN_INVALID');
      expect(meta.sanitizedTitle).toBe('Telegram бот токени нотўғри');
      expect(meta.targetRoute).toBe('/telegram-setup?districtId=dist-samarkand');
      expect(meta.recommendedAction).toBe('Бот созламаларини текширинг ва токенни қайта киритинг');
      expect(meta.sanitizedDescription).toContain('Самарқанд тумани');
    });

    it('maps TELEGRAM_BOT_INVALID error code to BOT_TOKEN_INVALID category', () => {
      const obs = createObservation('telegram_bot', 'Unavailable', {
        districtId: 'dist-samarkand',
        errorCode: 'TELEGRAM_BOT_INVALID',
      });
      const meta = deriveIssueMetadata(obs, 'Самарқанд тумани');

      expect(meta.issueCategory).toBe('BOT_TOKEN_INVALID');
      expect(meta.sanitizedTitle).toBe('Telegram бот токени нотўғри');
    });

    it('maps Telegram bot disconnected to BOT_DISCONNECTED and /telegram-setup route', () => {
      const obs = createObservation('telegram_bot', 'Unavailable', {
        districtId: 'dist-bukhara',
      });
      const meta = deriveIssueMetadata(obs, 'Бухоро тумани');

      expect(meta.issueCategory).toBe('BOT_DISCONNECTED');
      expect(meta.sanitizedTitle).toBe('Telegram бот уланмаган ёки фаол эмас');
      expect(meta.targetRoute).toBe('/telegram-setup?districtId=dist-bukhara');
      expect(meta.recommendedAction).toBe('Бот созламаларини текширинг ва боғланишни қайта текширинг');
    });

    it('maps Telegram group failure to TELEGRAM_GROUP_DISCONNECTED and /telegram-setup route', () => {
      const obs = createObservation('telegram_groups', 'Unavailable', {
        districtId: 'dist-chilonzor',
      });
      const meta = deriveIssueMetadata(obs, 'Чилонзор тумани');

      expect(meta.issueCategory).toBe('TELEGRAM_GROUP_DISCONNECTED');
      expect(meta.sanitizedTitle).toBe('Telegram гуруҳларига уланишда хатолик');
      expect(meta.targetRoute).toBe('/telegram-setup?districtId=dist-chilonzor');
      expect(meta.recommendedAction).toBe('Гуруҳ уланишлари ва бот администратор ҳуқуқларини текширинг');
    });

    it('maps global database failure to DATABASE_CONNECTION_ERROR with null route', () => {
      const obs = createObservation('database', 'Unavailable', { scope: 'GLOBAL', districtId: null });
      const meta = deriveIssueMetadata(obs);

      expect(meta.issueCategory).toBe('DATABASE_CONNECTION_ERROR');
      expect(meta.sanitizedTitle).toBe('Маълумотлар базасига уланишда хатолик');
      expect(meta.targetRoute).toBeNull();
      expect(meta.recommendedAction).toBe('PostgreSQL сервери ҳолати ва тармоқни текширинг');
    });

    it('maps processing queue delay to QUEUE_BACKLOG_DELAY with null route', () => {
      const obs = createObservation('processing_queue', 'Delayed', { scope: 'GLOBAL', districtId: null });
      const meta = deriveIssueMetadata(obs);

      expect(meta.issueCategory).toBe('QUEUE_BACKLOG_DELAY');
      expect(meta.sanitizedTitle).toBe('Навбат тизимида кечикиш кузатилмоқда');
      expect(meta.targetRoute).toBeNull();
      expect(meta.recommendedAction).toBe('pg-boss worker жараёни ва навбат ҳажмини текширинг');
    });

    it('maps processing queue unavailable to QUEUE_UNAVAILABLE with null route', () => {
      const obs = createObservation('processing_queue', 'Unavailable', { scope: 'GLOBAL', districtId: null });
      const meta = deriveIssueMetadata(obs);

      expect(meta.issueCategory).toBe('QUEUE_UNAVAILABLE');
      expect(meta.sanitizedTitle).toBe('Навбат тизими ишламаяпти');
      expect(meta.targetRoute).toBeNull();
      expect(meta.recommendedAction).toBe('pg-boss worker жараёнини қайта ишга туширинг');
    });

    it('maps district retention delay to DISTRICT_RETENTION_DELAY with null route', () => {
      const obs = createObservation('district_retention', 'Delayed', { districtId: 'dist-1' });
      const meta = deriveIssueMetadata(obs, 'Олмазор');

      expect(meta.issueCategory).toBe('DISTRICT_RETENTION_DELAY');
      expect(meta.sanitizedTitle).toBe('Туман маълумотларини тозалаш иши кечикмоқда');
      expect(meta.targetRoute).toBeNull();
      expect(meta.recommendedAction).toBe('Туман маълумотларини тозалаш жараёнини текширинг');
    });
  });

  describe('4. Deterministic Ordering of Operational Issues (AC 4)', () => {
    it('orders strictly by Critical > Warning > Information, secondary startedAt DESC, tiebreaker id', () => {
      const t1 = new Date('2026-08-25T10:00:00.000Z').toISOString();
      const t2 = new Date('2026-08-25T11:00:00.000Z').toISOString();
      const t3 = new Date('2026-08-25T11:30:00.000Z').toISOString();

      const issues: Array<{ id: string; severity: IssueSeverity; startedAt: string }> = [
        { id: 'issue-info-1', severity: 'Information', startedAt: t3 },
        { id: 'issue-warn-older', severity: 'Warning', startedAt: t1 },
        { id: 'issue-crit-older', severity: 'Critical', startedAt: t1 },
        { id: 'issue-warn-newer', severity: 'Warning', startedAt: t2 },
        { id: 'issue-crit-newer-b', severity: 'Critical', startedAt: t3 },
        { id: 'issue-crit-newer-a', severity: 'Critical', startedAt: t3 },
      ];

      const sorted = sortOperationalIssues(issues as any);

      expect(sorted.map((i) => i.id)).toEqual([
        'issue-crit-newer-a', // Critical, t3 (tiebreaker 'a' < 'b')
        'issue-crit-newer-b', // Critical, t3
        'issue-crit-older',   // Critical, t1
        'issue-warn-newer',   // Warning, t2
        'issue-warn-older',   // Warning, t1
        'issue-info-1',       // Information, t3
      ]);
    });
  });
});
