#!/usr/bin/env node
// Add SPA-friendly artifacts to dist for GitHub Pages
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const dist = path.join(root, 'dist');
if (!fs.existsSync(dist)) {
  console.error('[prepare-pages] dist/ not found. Run build first.');
  process.exit(1);
}

// Ensure Jekyll doesn’t mangle assets
fs.writeFileSync(path.join(dist, '.nojekyll'), '');

// SPA fallback: copy index.html to 404.html so deep links render
const indexPath = path.join(dist, 'index.html');
const fallbackPath = path.join(dist, '404.html');
try {
  const html = fs.readFileSync(indexPath);
  fs.writeFileSync(fallbackPath, html);
  console.log('[prepare-pages] Wrote .nojekyll and 404.html');
} catch (e) {
  console.warn('[prepare-pages] Could not create 404.html:', e?.message);
}

