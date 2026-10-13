// Copies non-TypeScript runtime assets into dist/ after compilation.
import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist/db', { recursive: true });
mkdirSync('dist/web/public', { recursive: true });

cpSync('src/db/schema.sql', 'dist/db/schema.sql');
cpSync('src/web/public', 'dist/web/public', { recursive: true });

console.log('assets copied to dist/');
