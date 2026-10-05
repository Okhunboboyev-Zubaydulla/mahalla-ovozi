import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 20000,
    env: {
      DATABASE_URL: 'postgresql://mahalla_user:mahalla_dev_password@localhost:5433/mahalla_ovozi_test',
      AI_PROVIDER: 'OLLAMA',
      ENCRYPTION_KEY: 'test_encryption_key_32_bytes_ok!',
    },
  },
});
