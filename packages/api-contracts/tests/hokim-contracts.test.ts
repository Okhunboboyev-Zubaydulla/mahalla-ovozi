import { describe, it, expect } from 'vitest';
import {
  ActorRoleSchema,
  ActorContextSchema,
  HokimAccountStatusSchema,
  HokimAccountStateEnumSchema,
  DistrictHokimAccountSchema,
  GetDistrictHokimAccountResponseSchema,
  CreateHokimAccountRequestSchema,
  CreateHokimAccountResponseSchema,
  ResetHokimPasswordResponseSchema,
  ReplaceHokimAccountRequestSchema,
  ReplaceHokimAccountResponseSchema,
  UpdateHokimUsernameRequestSchema,
  UpdateHokimUsernameResponseSchema,
  DisableHokimAccountResponseSchema,
} from '../src/index.js';

describe('Hokim Account API Contracts', () => {
  describe('ActorRoleSchema & ActorContextSchema updates', () => {
    it('accepts both PRODUCT_OWNER and DISTRICT_HOKIM roles', () => {
      expect(ActorRoleSchema.safeParse('PRODUCT_OWNER').success).toBe(true);
      expect(ActorRoleSchema.safeParse('DISTRICT_HOKIM').success).toBe(true);
      expect(ActorRoleSchema.safeParse('SUPER_ADMIN').success).toBe(false);
    });

    it('validates ActorContextSchema with optional districtId', () => {
      const poActor = {
        id: 'acc_po_1',
        role: 'PRODUCT_OWNER',
        username: 'po_admin',
        districtId: null,
      };
      expect(ActorContextSchema.safeParse(poActor).success).toBe(true);

      const hokimActor = {
        id: 'acc_hokim_1',
        role: 'DISTRICT_HOKIM',
        username: 'hokim_chilonzor',
        districtId: 'dist_chilonzor_1',
      };
      expect(ActorContextSchema.safeParse(hokimActor).success).toBe(true);
    });
  });

  describe('DistrictHokimAccountSchema & GetDistrictHokimAccountResponseSchema', () => {
    it('validates Hokim account status and state enums', () => {
      expect(HokimAccountStatusSchema.safeParse('ACTIVE').success).toBe(true);
      expect(HokimAccountStatusSchema.safeParse('DISABLED').success).toBe(true);
      expect(HokimAccountStatusSchema.safeParse('PENDING').success).toBe(false);

      expect(HokimAccountStateEnumSchema.safeParse('NO_ACCOUNT').success).toBe(true);
      expect(HokimAccountStateEnumSchema.safeParse('ACTIVE').success).toBe(true);
      expect(HokimAccountStateEnumSchema.safeParse('DISABLED').success).toBe(true);
    });

    it('validates a complete active DistrictHokimAccount payload', () => {
      const account = {
        id: 'acc_hokim_123',
        username: 'hokim_yunusobod',
        role: 'DISTRICT_HOKIM',
        status: 'ACTIVE',
        districtId: 'dist_yunusobod',
        credentialVersion: 1,
        createdAt: '2026-08-19T10:00:00.000Z',
        updatedAt: '2026-08-19T10:00:00.000Z',
      };

      const result = DistrictHokimAccountSchema.safeParse(account);
      expect(result.success).toBe(true);
    });

    it('validates GetDistrictHokimAccountResponseSchema for NO_ACCOUNT and ACTIVE states', () => {
      const noAccountResponse = {
        state: 'NO_ACCOUNT',
        account: null,
      };
      expect(GetDistrictHokimAccountResponseSchema.safeParse(noAccountResponse).success).toBe(true);

      const activeResponse = {
        state: 'ACTIVE',
        account: {
          id: 'acc_hokim_123',
          username: 'hokim_yunusobod',
          role: 'DISTRICT_HOKIM',
          status: 'ACTIVE',
          districtId: 'dist_yunusobod',
          credentialVersion: 1,
          createdAt: '2026-08-19T10:00:00.000Z',
          updatedAt: '2026-08-19T10:00:00.000Z',
        },
      };
      expect(GetDistrictHokimAccountResponseSchema.safeParse(activeResponse).success).toBe(true);
    });
  });

  describe('CreateHokimAccountRequestSchema & ResponseSchema', () => {
    it('validates valid usernames (3–64 chars, letters, numbers, spaces, dashes, underscores)', () => {
      expect(CreateHokimAccountRequestSchema.safeParse({ username: 'hokim_chilonzor' }).success).toBe(true);
      expect(CreateHokimAccountRequestSchema.safeParse({ username: 'hokim123' }).success).toBe(true);
      expect(CreateHokimAccountRequestSchema.safeParse({ username: 'Botir Zoirov' }).success).toBe(true);
      expect(CreateHokimAccountRequestSchema.safeParse({ username: 'Ботир Зоиров' }).success).toBe(true);
      expect(CreateHokimAccountRequestSchema.safeParse({ username: 'hokim-with-dash' }).success).toBe(true);
      expect(CreateHokimAccountRequestSchema.safeParse({ username: 'ab' }).success).toBe(false); // too short
      expect(CreateHokimAccountRequestSchema.safeParse({ username: 'hokim@special!' }).success).toBe(false); // invalid special chars
    });

    it('validates CreateHokimAccountResponseSchema containing temporaryPassword', () => {
      const response = {
        account: {
          id: 'acc_hokim_123',
          username: 'hokim_yunusobod',
          role: 'DISTRICT_HOKIM',
          status: 'ACTIVE',
          districtId: 'dist_yunusobod',
          credentialVersion: 1,
          createdAt: '2026-08-19T10:00:00.000Z',
          updatedAt: '2026-08-19T10:00:00.000Z',
        },
        temporaryPassword: 'Temporary#Password2026!',
      };

      const result = CreateHokimAccountResponseSchema.safeParse(response);
      expect(result.success).toBe(true);
    });
  });

  describe('Reset, Replace, and Disable Schemas', () => {
    it('validates ResetHokimPasswordResponseSchema', () => {
      const response = {
        account: {
          id: 'acc_hokim_123',
          username: 'hokim_yunusobod',
          role: 'DISTRICT_HOKIM',
          status: 'ACTIVE',
          districtId: 'dist_yunusobod',
          credentialVersion: 2,
          createdAt: '2026-08-19T10:00:00.000Z',
          updatedAt: '2026-08-19T10:30:00.000Z',
        },
        temporaryPassword: 'NewRandomPassword2026!',
      };
      expect(ResetHokimPasswordResponseSchema.safeParse(response).success).toBe(true);
    });

    it('validates ReplaceHokimAccountRequestSchema and ResponseSchema', () => {
      const req = { newUsername: 'new_hokim_username' };
      expect(ReplaceHokimAccountRequestSchema.safeParse(req).success).toBe(true);

      const resp = {
        account: {
          id: 'acc_hokim_456',
          username: 'new_hokim_username',
          role: 'DISTRICT_HOKIM',
          status: 'ACTIVE',
          districtId: 'dist_yunusobod',
          credentialVersion: 1,
          createdAt: '2026-08-19T11:00:00.000Z',
          updatedAt: '2026-08-19T11:00:00.000Z',
        },
        temporaryPassword: 'AnotherSecurePassword2026!',
        previousAccountId: 'acc_hokim_123',
      };
      expect(ReplaceHokimAccountResponseSchema.safeParse(resp).success).toBe(true);
    });

    it('validates DisableHokimAccountResponseSchema', () => {
      const resp = {
        account: {
          id: 'acc_hokim_123',
          username: 'hokim_yunusobod',
          role: 'DISTRICT_HOKIM',
          status: 'DISABLED',
          districtId: 'dist_yunusobod',
          credentialVersion: 2,
          createdAt: '2026-08-19T10:00:00.000Z',
          updatedAt: '2026-08-19T11:30:00.000Z',
        },
      };
      expect(DisableHokimAccountResponseSchema.safeParse(resp).success).toBe(true);
    });
  });

  describe('UpdateHokimUsernameRequestSchema & ResponseSchema', () => {
    it('validates valid username updates with letters, spaces, numbers, Cyrillic', () => {
      expect(UpdateHokimUsernameRequestSchema.safeParse({ username: 'Botir Zoirov' }).success).toBe(true);
      expect(UpdateHokimUsernameRequestSchema.safeParse({ username: 'Ботир Зоиров' }).success).toBe(true);
      expect(UpdateHokimUsernameRequestSchema.safeParse({ username: 'botir_zoirov_2' }).success).toBe(true);
      expect(UpdateHokimUsernameRequestSchema.safeParse({ username: 'ab' }).success).toBe(false);
      expect(UpdateHokimUsernameRequestSchema.safeParse({ username: '   ' }).success).toBe(false);
    });

    it('validates UpdateHokimUsernameResponseSchema', () => {
      const resp = {
        account: {
          id: 'acc_hokim_123',
          username: 'Botir Zoirov',
          role: 'DISTRICT_HOKIM',
          status: 'ACTIVE',
          districtId: 'dist_yunusobod',
          credentialVersion: 1,
          createdAt: '2026-08-19T10:00:00.000Z',
          updatedAt: '2026-08-19T12:00:00.000Z',
        },
      };
      expect(UpdateHokimUsernameResponseSchema.safeParse(resp).success).toBe(true);
    });
  });
});
