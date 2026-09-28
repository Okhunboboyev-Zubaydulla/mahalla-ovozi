import { describe, it, expect } from 'vitest';
import {
  DistrictSchema,
  ActivateDistrictResponseSchema,
  ApiErrorEnvelopeSchema,
  ActorContextSchema,
  FirstSignInPasswordChangeRequestSchema,
  FirstSignInPasswordChangeResponseSchema,
} from '../src/index.js';

describe('Activation & First Sign-In API Contracts', () => {
  describe('ApiErrorEnvelopeSchema with Blockers', () => {
    it('parses standard error envelope without blockers', () => {
      const payload = {
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Авторизациядан ўтилмаган.',
        },
      };
      const result = ApiErrorEnvelopeSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.error.code).toBe('UNAUTHENTICATED');
        expect(result.data.error.blockers).toBeUndefined();
      }
    });

    it('parses structured error envelope with prerequisite blockers', () => {
      const payload = {
        error: {
          code: 'DISTRICT_NOT_READY',
          message: 'Туманни фаоллаштириш учун барча талаблар бажарилмаган.',
          blockers: [
            {
              key: 'telegram_bot',
              label: 'Telegram бот уланиши',
              description: 'Туманнинг расмий Telegram боти фаоллаштирилди',
              status: 'incomplete',
              blockerReason: 'Telegram бот ҳали уланмаган (1.4-босқич).',
              actionRequired: true,
              actionPath: '/telegram-setup',
            },
            {
              key: 'hokim_account',
              label: 'Ҳоким аккаунти',
              description: 'Туман ҳокими учун хавфсиз аккаунт яратилди',
              status: 'incomplete',
              blockerReason: 'Ҳоким аккаунти яратилмаган (1.6-босқич).',
              actionRequired: true,
              actionPath: '/hokim-accounts',
            },
          ],
        },
      };

      const result = ApiErrorEnvelopeSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.error.code).toBe('DISTRICT_NOT_READY');
        expect(result.data.error.blockers).toHaveLength(2);
        expect(result.data.error.blockers?.[0].key).toBe('telegram_bot');
      }
    });
  });

  describe('DistrictSchema with Activation Metadata', () => {
    it('accepts district with activatedAt and activatedById metadata', () => {
      const payload = {
        id: 'dist_123',
        name: 'Чилонзор',
        region: 'Тошкент шаҳри',
        status: 'ACTIVE',
        createdAt: '2026-08-20T10:00:00.000Z',
        activatedAt: '2026-08-20T12:00:00.000Z',
        activatedById: 'acc_po_1',
      };

      const result = DistrictSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe('ACTIVE');
        expect(result.data.activatedAt).toBe('2026-08-20T12:00:00.000Z');
        expect(result.data.activatedById).toBe('acc_po_1');
      }
    });

    it('accepts null/undefined for activation fields on unactivated district', () => {
      const payload = {
        id: 'dist_456',
        name: 'Учтепа',
        status: 'SETUP_INCOMPLETE',
        createdAt: '2026-08-20T10:00:00.000Z',
        activatedAt: null,
        activatedById: null,
      };

      const result = DistrictSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });
  });

  describe('ActivateDistrictResponseSchema', () => {
    it('validates ActivateDistrictResponse payload', () => {
      const payload = {
        district: {
          id: 'dist_123',
          name: 'Чилонзор',
          region: 'Тошкент шаҳри',
          status: 'ACTIVE',
          createdAt: '2026-08-20T10:00:00.000Z',
          activatedAt: '2026-08-20T12:00:00.000Z',
          activatedById: 'acc_po_1',
        },
        activatedAt: '2026-08-20T12:00:00.000Z',
        activatedById: 'acc_po_1',
      };

      const result = ActivateDistrictResponseSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.district.status).toBe('ACTIVE');
        expect(result.data.activatedById).toBe('acc_po_1');
      }
    });
  });

  describe('ActorContextSchema with mustChangePassword', () => {
    it('accepts mustChangePassword boolean flag', () => {
      const payload = {
        id: 'acc_hokim_1',
        role: 'DISTRICT_HOKIM',
        username: 'hokim_chilonzor',
        districtId: 'dist_123',
        mustChangePassword: true,
      };

      const result = ActorContextSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.mustChangePassword).toBe(true);
      }
    });
  });

  describe('FirstSignInPasswordChangeRequestSchema', () => {
    it('accepts valid current and new password (>=15 chars)', () => {
      const payload = {
        currentPassword: 'temp-password-12345',
        newPassword: 'MyNewSuperSecurePassword2026!',
      };

      const result = FirstSignInPasswordChangeRequestSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it('rejects new password shorter than 15 characters', () => {
      const payload = {
        currentPassword: 'temp-password-12345',
        newPassword: 'short-pass',
      };

      const result = FirstSignInPasswordChangeRequestSchema.safeParse(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0]?.message).toMatch(/15/);
      }
    });

    it('rejects new password longer than 128 Unicode code points', () => {
      const payload = {
        currentPassword: 'temp-password-12345',
        newPassword: 'a'.repeat(129),
      };

      const result = FirstSignInPasswordChangeRequestSchema.safeParse(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0]?.message).toMatch(/128/);
      }
    });

    it('correctly handles Unicode code points in password length check', () => {
      // 15 emoji code points (30 UTF-16 code units)
      const payload = {
        currentPassword: 'temp-password-12345',
        newPassword: '🔒'.repeat(15),
      };

      const result = FirstSignInPasswordChangeRequestSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });
  });

  describe('FirstSignInPasswordChangeResponseSchema', () => {
    it('validates successful password change response', () => {
      const payload = {
        success: true,
        actor: {
          id: 'acc_hokim_1',
          role: 'DISTRICT_HOKIM',
          username: 'hokim_chilonzor',
          districtId: 'dist_123',
          mustChangePassword: false,
        },
      };

      const result = FirstSignInPasswordChangeResponseSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.success).toBe(true);
        expect(result.data.actor.mustChangePassword).toBe(false);
      }
    });
  });
});
