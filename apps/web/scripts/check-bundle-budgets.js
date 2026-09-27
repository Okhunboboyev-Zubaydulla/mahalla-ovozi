import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distAssetsDir = path.resolve(__dirname, '../dist/assets');

if (!fs.existsSync(distAssetsDir)) {
  console.error('❌ dist/assets directory not found. Run `pnpm build` first.');
  process.exit(1);
}

const BUDGETS = [
  {
    name: 'Max Individual Chunk Budget',
    match: () => true,
    maxBytes: 700 * 1024, // 700 KB (Original was 1,174 KB)
  },
  {
    name: 'Vendor React Runtime Budget',
    match: (file) => file.startsWith('vendor-react-'),
    maxBytes: 250 * 1024, // 250 KB
  },
  {
    name: 'Vendor Query Budget',
    match: (file) => file.startsWith('vendor-query-'),
    maxBytes: 50 * 1024, // 50 KB
  },
  {
    name: 'Table Component Budget',
    match: (file) => file.startsWith('Table-'),
    maxBytes: 200 * 1024, // 200 KB
  },
];

const files = fs.readdirSync(distAssetsDir).filter((f) => f.endsWith('.js'));
let hasFailures = false;

console.log('🔍 Checking bundle size budgets against apps/web/dist/assets:');

for (const file of files) {
  const filePath = path.join(distAssetsDir, file);
  const stat = fs.statSync(filePath);
  const sizeBytes = stat.size;
  const sizeKb = (sizeBytes / 1024).toFixed(2);

  for (const budget of BUDGETS) {
    if (budget.match(file)) {
      if (sizeBytes > budget.maxBytes) {
        console.error(
          `❌ VIOLATION [${budget.name}]: ${file} is ${sizeKb} KB (Budget: ${(budget.maxBytes / 1024).toFixed(0)} KB)`
        );
        hasFailures = true;
      }
    }
  }
}

if (hasFailures) {
  console.error('\n❌ Bundle budget check failed. Prune bloat or review bundle before merging.');
  process.exit(1);
}

console.log('✅ All bundle size budgets passed deterministically.');
process.exit(0);
