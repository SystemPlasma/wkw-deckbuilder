#!/usr/bin/env node
/**
 * Copy card artwork from the repo-level `assets/` folder into `public/assets/cards/`
 * using IDs from `src/assets/data/cards.csv`.
 *
 * This ensures images are published by Vite (public/ is copied to dist/) and
 * resolves 404s in production without bundling every image.
 */
const fs = require('fs');
const path = require('path');

function parseCSV(raw) {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim().length > 0);
  if (!lines.length) return [];
  const headers = splitCsvLine(lines[0]).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = splitCsvLine(lines[i]);
    const r = {};
    headers.forEach((h, idx) => { r[h] = (parts[idx] ?? '').trim(); });
    rows.push(r);
  }
  return rows;
}
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; } }
      else cur += ch;
    } else {
      if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"') { inQuotes = true; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function idVariants(id) {
  return Array.from(new Set([id, id.replace(/_(\d+)/g, '$1')]));
}

function main() {
  const root = process.cwd();
  const dataCsv = path.join(root, 'src', 'assets', 'data', 'cards.csv');
  const repoAssets = path.join(root, 'assets');
  const repoAssetsCards = path.join(repoAssets, 'cards');
  const outDir = path.join(root, 'public', 'assets', 'cards');
  const exts = ['png', 'jpg', 'jpeg', 'svg'];

  if (!fs.existsSync(dataCsv)) {
    console.warn('[sync-card-images] cards.csv not found, skipping');
    return;
  }
  const ids = parseCSV(fs.readFileSync(dataCsv, 'utf8')).map(r => r.id).filter(Boolean);
  fs.mkdirSync(outDir, { recursive: true });

  let copied = 0, missing = 0;
  for (const id of ids) {
    let srcPath = null, extUsed = null;
    for (const cand of idVariants(id)) {
      for (const ext of exts) {
        const direct = path.join(repoAssets, `${cand}.${ext}`);
        const directCards = path.join(repoAssetsCards, `${cand}.${ext}`);
        const hashed = findFirst(repoAssets, (name) => name.startsWith(`${cand}-`) && name.endsWith(`.${ext}`));
        const hashedCards = findFirst(repoAssetsCards, (name) => name.startsWith(`${cand}-`) && name.endsWith(`.${ext}`));
        if (fs.existsSync(direct)) { srcPath = direct; extUsed = ext; break; }
        if (fs.existsSync(directCards)) { srcPath = directCards; extUsed = ext; break; }
        if (hashed) { srcPath = path.join(repoAssets, hashed); extUsed = ext; break; }
        if (hashedCards) { srcPath = path.join(repoAssetsCards, hashedCards); extUsed = ext; break; }
      }
      if (srcPath) break;
    }
    if (!srcPath) { missing++; continue; }
    const dest = path.join(outDir, `${id}.${extUsed}`);
    try { fs.copyFileSync(srcPath, dest); copied++; } catch {}
  }
  console.log(`[sync-card-images] Copied ${copied} images to`, path.relative(root, outDir), missing?`(${missing} missing)`:'');
}

function findFirst(dir, pred) {
  try {
    const list = fs.readdirSync(dir);
    return list.find(pred) || null;
  } catch { return null; }
}

main();
