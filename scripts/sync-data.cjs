#!/usr/bin/env node
/**
 * Ensure CSV data files are available under public/assets/data for runtime fetches.
 * Copies every .csv from src/assets/data into public/assets/data, plus a legacy path used by prior builds.
 */
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const srcDir = path.join(root, 'src', 'assets', 'data');
const outDir = path.join(root, 'public', 'assets', 'data');
const legacyDir = path.join(root, 'public', 'assets', 'assets', 'data');

if (!fs.existsSync(srcDir)) {
  console.warn('[sync-data] Source directory missing:', path.relative(root, srcDir));
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(legacyDir, { recursive: true });
const files = fs.readdirSync(srcDir).filter((f) => f.toLowerCase().endsWith('.csv'));
let copied = 0;
for (const file of files) {
  const src = path.join(srcDir, file);
  fs.copyFileSync(src, path.join(outDir, file));
  fs.copyFileSync(src, path.join(legacyDir, file));
  copied++;
}
console.log(`[sync-data] Copied ${copied} CSV files to`, path.relative(root, outDir), 'and legacy assets/ path');

