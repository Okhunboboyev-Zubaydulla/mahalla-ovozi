/**
 * Single typed, validated entry point for build-time configuration.
 *
 * `import.meta.env` is read exactly once, at module load. Everything downstream
 * consumes `envConfig` instead of touching `import.meta.env` directly.
 */

/** Raw subset of Vite's `import.meta.env` that this module understands. */
export interface RawEnv {
  readonly VITE_API_BASE_URL?: string | undefined;
  readonly VITE_APP_ENV?: string | undefined;
  readonly MODE?: string | undefined;
}

export interface EnvConfig {
  /**
   * Origin prefix for API calls, without a trailing slash.
   *
   * The empty string is the default and means "same origin": callers pass
   * relative `/api/v1/...` paths and the browser (or the Vite dev proxy) resolves
   * them. This is exactly today's behaviour.
   */
  readonly apiBaseUrl: string;
  /** Deployment label used for diagnostics: `VITE_APP_ENV` or Vite's `MODE`. */
  readonly appEnv: string;
}

/**
 * Trims whitespace and trailing slashes so `${base}/api/v1` can never produce a
 * doubled `//`. The empty (default) case returns the empty string untouched.
 * Throws only when a value is actually present but unusable.
 */
function normalizeApiBaseUrl(rawValue: string | undefined): string {
  // `?? ''` rather than a default parameter: default parameter values are
  // banned by the project code standards. Absent env => same-origin relative URLs.
  const value = rawValue ?? '';
  const trimmed = value.trim();

  if (trimmed === '') {
    return '';
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `[env] VITE_API_BASE_URL must be an absolute http(s) URL when set, received "${trimmed}". ` +
        'Leave it empty to use same-origin relative /api/v1 paths.',
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `[env] VITE_API_BASE_URL must use the http or https protocol, received "${parsed.protocol}".`,
    );
  }

  return trimmed.replace(/\/+$/, '');
}

function normalizeAppEnv(raw: RawEnv): string {
  const value = (raw.VITE_APP_ENV ?? raw.MODE ?? 'development').trim();
  return value === '' ? 'development' : value;
}

/** Pure builder — takes the raw env so tests can drive it without module tricks. */
export function createEnvConfig(raw: RawEnv): EnvConfig {
  return {
    apiBaseUrl: normalizeApiBaseUrl(raw.VITE_API_BASE_URL),
    appEnv: normalizeAppEnv(raw),
  };
}

/** The one and only read of `import.meta.env` in the app. */
export const envConfig: EnvConfig = createEnvConfig(import.meta.env);
