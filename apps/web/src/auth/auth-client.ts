import {
  SignInRequest,
  SignInResponse,
  SessionResponse,
  SignOutResponse,
  FirstSignInPasswordChangeRequest,
  FirstSignInPasswordChangeResponse,
  SignInResponseSchema,
  SessionResponseSchema,
  SignOutResponseSchema,
  FirstSignInPasswordChangeResponseSchema,
} from '@mahalla-ovozi/api-contracts';
import { request, ApiError } from '../lib/api-client.js';

export { ApiError };

export const authClient = {
  signIn(credentials: SignInRequest): Promise<SignInResponse> {
    return request<SignInResponse>(
      '/api/v1/auth/sign-in',
      {
        method: 'POST',
        body: JSON.stringify(credentials),
      },
      SignInResponseSchema
    );
  },

  signOut(): Promise<SignOutResponse> {
    return request<SignOutResponse>(
      '/api/v1/auth/sign-out',
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
      SignOutResponseSchema
    );
  },

  fetchSession(): Promise<SessionResponse> {
    return request<SessionResponse>(
      '/api/v1/auth/session',
      {
        method: 'GET',
      },
      SessionResponseSchema
    );
  },

  changeFirstLoginPassword(
    payload: FirstSignInPasswordChangeRequest
  ): Promise<FirstSignInPasswordChangeResponse> {
    return request<FirstSignInPasswordChangeResponse>(
      '/api/v1/auth/change-first-login-password',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      FirstSignInPasswordChangeResponseSchema
    );
  },
};

