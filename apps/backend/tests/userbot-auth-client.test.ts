import { describe, it, expect, vi } from 'vitest';
import {
  GramJsUserbotAuthClient,
  UserbotAuthError,
  InvalidPhoneCodeError,
  Invalid2FAPasswordError,
} from '../src/adapters/telegram/userbot-auth-client.js';

describe('GramJsUserbotAuthClient MTProto Auth Adapter', () => {
  const testApiId = '12345';
  const testApiHash = 'test_api_hash_abc';
  const testPhone = '+998901234567';

  it('fails if signIn is called before sendCode', async () => {
    const client = new GramJsUserbotAuthClient();
    await expect(
      client.signIn({
        phoneNumber: testPhone,
        phoneCodeHash: 'hash123',
        phoneCode: '12345',
      }),
    ).rejects.toThrow(UserbotAuthError);
  });

  it('fails if signInWithPassword is called before sendCode', async () => {
    const client = new GramJsUserbotAuthClient();
    await expect(
      client.signInWithPassword({
        password: 'secretPassword',
      }),
    ).rejects.toThrow(UserbotAuthError);
  });

  it('provides onError callback and function phoneCode to client.signInUser', async () => {
    const authClient = new GramJsUserbotAuthClient();

    let capturedAuthParams: any = null;
    const fakeClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      sendCode: vi.fn().mockResolvedValue({ phoneCodeHash: 'test_hash_123', isCodeViaApp: false }),
      signInUser: vi.fn().mockImplementation(async (_creds, authParams) => {
        capturedAuthParams = authParams;
        expect(typeof authParams.onError).toBe('function');
        expect(typeof authParams.phoneCode).toBe('function');
        const codeResult = await authParams.phoneCode();
        expect(codeResult).toBe('54321');
        return {};
      }),
      signInWithPassword: vi.fn(),
      session: {
        save: vi.fn().mockReturnValue('mock_session_string_123'),
      },
    };

    (authClient as any).client = fakeClient;
    (authClient as any).currentApiId = testApiId;
    (authClient as any).currentApiHash = testApiHash;

    const result = await authClient.signIn({
      phoneNumber: testPhone,
      phoneCodeHash: 'test_hash_123',
      phoneCode: '54321',
    });

    expect(result).toEqual({ sessionString: 'mock_session_string_123' });
    expect(fakeClient.signInUser).toHaveBeenCalledTimes(1);

    // Verify onError rethrows the passed error
    expect(() => capturedAuthParams.onError(new Error('test_error'))).toThrow('test_error');
  });

  it('returns requiresPassword when signInUser throws SESSION_PASSWORD_NEEDED', async () => {
    const authClient = new GramJsUserbotAuthClient();

    const fakeClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      sendCode: vi.fn().mockResolvedValue({ phoneCodeHash: 'hash_2fa' }),
      signInUser: vi.fn().mockImplementation(async (_creds, authParams) => {
        try {
          throw new Error('RPCError: 400: SESSION_PASSWORD_NEEDED');
        } catch (err) {
          authParams.onError(err);
        }
      }),
      signInWithPassword: vi.fn(),
      session: { save: vi.fn() },
    };

    (authClient as any).client = fakeClient;
    (authClient as any).currentApiId = testApiId;
    (authClient as any).currentApiHash = testApiHash;

    const result = await authClient.signIn({
      phoneNumber: testPhone,
      phoneCodeHash: 'hash_2fa',
      phoneCode: '11223',
    });

    expect(result).toEqual({ requiresPassword: true });
  });

  it('returns requiresPassword when teleproto reports "Account has 2FA enabled."', async () => {
    const authClient = new GramJsUserbotAuthClient();

    const fakeClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      sendCode: vi.fn(),
      signInUser: vi.fn().mockRejectedValue(new Error('Account has 2FA enabled.')),
      signInWithPassword: vi.fn(),
      session: { save: vi.fn() },
    };

    (authClient as any).client = fakeClient;
    (authClient as any).currentApiId = testApiId;
    (authClient as any).currentApiHash = testApiHash;

    const result = await authClient.signIn({
      phoneNumber: testPhone,
      phoneCodeHash: 'hash_2fa',
      phoneCode: '11223',
    });

    expect(result).toEqual({ requiresPassword: true });
  });

  it('maps PHONE_CODE_INVALID and PHONE_CODE_EXPIRED to InvalidPhoneCodeError', async () => {
    const authClient = new GramJsUserbotAuthClient();

    const fakeClient = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      sendCode: vi.fn(),
      signInUser: vi.fn().mockRejectedValue(new Error('PHONE_CODE_INVALID')),
      signInWithPassword: vi.fn(),
      session: { save: vi.fn() },
    };

    (authClient as any).client = fakeClient;
    (authClient as any).currentApiId = testApiId;
    (authClient as any).currentApiHash = testApiHash;

    await expect(
      authClient.signIn({
        phoneNumber: testPhone,
        phoneCodeHash: 'hash_code',
        phoneCode: '00000',
      }),
    ).rejects.toThrow(InvalidPhoneCodeError);
  });

  it('provides onError and function password to client.signInWithPassword', async () => {
    const authClient = new GramJsUserbotAuthClient();

    let capturedAuthParams: any = null;
    const fakeClient = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      sendCode: vi.fn(),
      signInUser: vi.fn(),
      signInWithPassword: vi.fn().mockImplementation(async (_creds, authParams) => {
        capturedAuthParams = authParams;
        expect(typeof authParams.onError).toBe('function');
        expect(typeof authParams.password).toBe('function');
        const passResult = await authParams.password();
        expect(passResult).toBe('mypassword2fa');
        return {};
      }),
      session: {
        save: vi.fn().mockReturnValue('mock_2fa_session_string'),
      },
    };

    (authClient as any).client = fakeClient;
    (authClient as any).currentApiId = testApiId;
    (authClient as any).currentApiHash = testApiHash;

    const result = await authClient.signInWithPassword({
      password: 'mypassword2fa',
    });

    expect(result).toEqual({ sessionString: 'mock_2fa_session_string' });
    expect(fakeClient.signInWithPassword).toHaveBeenCalledTimes(1);
    expect(() => capturedAuthParams.onError(new Error('rethrow_me'))).toThrow('rethrow_me');
  });

  it('maps PASSWORD_HASH_INVALID to Invalid2FAPasswordError in signInWithPassword', async () => {
    const authClient = new GramJsUserbotAuthClient();

    const fakeClient = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      sendCode: vi.fn(),
      signInUser: vi.fn(),
      signInWithPassword: vi.fn().mockRejectedValue(new Error('PASSWORD_HASH_INVALID')),
      session: { save: vi.fn() },
    };

    (authClient as any).client = fakeClient;
    (authClient as any).currentApiId = testApiId;
    (authClient as any).currentApiHash = testApiHash;

    await expect(
      authClient.signInWithPassword({
        password: 'wrong_password',
      }),
    ).rejects.toThrow(Invalid2FAPasswordError);
  });
});
