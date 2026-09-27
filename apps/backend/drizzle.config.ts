import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/adapters/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://mahalla_user:mahalla_dev_password@localhost:5433/mahalla_ovozi',
  },
});
