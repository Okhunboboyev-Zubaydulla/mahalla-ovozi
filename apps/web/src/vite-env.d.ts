/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional origin prefix for API calls; empty/absent means same origin. */
  readonly VITE_API_BASE_URL?: string;
  /** Deployment label for diagnostics; falls back to Vite's `MODE`. */
  readonly VITE_APP_ENV?: string;
}
