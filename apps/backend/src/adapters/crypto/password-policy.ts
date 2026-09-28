import { COMMON_PASSWORDS_BLOCKLIST } from './common-passwords.js';

export interface PasswordValidationResult {
  isValid: boolean;
  error?: 'TOO_SHORT' | 'TOO_LONG' | 'COMMON_PASSWORD' | 'EMPTY';
  message?: string;
}

export function validatePassword(password: string): PasswordValidationResult {
  if (!password || typeof password !== 'string') {
    return {
      isValid: false,
      error: 'EMPTY',
      message: 'Парол киритилиши шарт.',
    };
  }

  // Count Unicode code points precisely without truncation or trimming
  const codePointsCount = Array.from(password).length;

  if (codePointsCount < 15) {
    return {
      isValid: false,
      error: 'TOO_SHORT',
      message: 'Парол узунлиги камида 15 белгидан иборат бўлиши керак.',
    };
  }

  if (codePointsCount > 128) {
    return {
      isValid: false,
      error: 'TOO_LONG',
      message: 'Парол узунлиги 128 белгидан ошмаслиги керак.',
    };
  }

  const normalized = password.toLowerCase();
  if (COMMON_PASSWORDS_BLOCKLIST.has(normalized)) {
    return {
      isValid: false,
      error: 'COMMON_PASSWORD',
      message: 'Ушбу парол жуда кенг тарқалган ва хавфсиз эмас. Илтимос, бошқа парол танланг.',
    };
  }

  return { isValid: true };
}
