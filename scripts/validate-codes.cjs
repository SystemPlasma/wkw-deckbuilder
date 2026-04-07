#!/usr/bin/env node
/**
 * Validate and optionally normalize src/assets/data/unlock_codes.csv
 * - Ensures header is `code,slug`
 * - Trims whitespace, uppercases codes, lowercases slugs
 * - Verifies slugs exist in aspects.csv or are in ALLOWED_SPECIAL
 * - Reports duplicates and conflicts
 * - With --fix, rewrites the CSV in a normalized, de-duped form
 */

const fs = require('fs');
const path = require('path');

function parseCSV(raw) {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = splitCsvLine(lines[0]).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = splitCsvLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => { row[h] = (parts[idx] ?? '').trim(); });
    rows.push(row);
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
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else cur += ch;
    } else {
      if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"') { inQuotes = true; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function main() {
  const FIX = process.argv.includes('--fix');
  const repo = process.cwd();
  const codesPath = path.join(repo, 'src', 'assets', 'data', 'unlock_codes.csv');
  const aspectsPath = path.join(repo, 'src', 'assets', 'data', 'aspects.csv');

  if (!fs.existsSync(codesPath)) {
    console.error('[codes] Missing file:', codesPath);
    process.exit(1);
  }
  if (!fs.existsSync(aspectsPath)) {
    console.error('[codes] Missing file:', aspectsPath);
    process.exit(1);
  }

  const allowedSpecial = new Set(['*', '#dark_all']);

  const aspectsRaw = fs.readFileSync(aspectsPath, 'utf8');
  const aspectsRows = parseCSV(aspectsRaw);
  const aspectSlugs = new Set(aspectsRows.map(r => (r.slug || '').trim().toLowerCase()).filter(Boolean));

  const codesRaw = fs.readFileSync(codesPath, 'utf8');
  const rows = parseCSV(codesRaw);

  const problems = [];
  const normalized = [];
  const seenCodes = new Map(); // CODE -> slug

  // header check (best-effort)
  const firstLine = codesRaw.replace(/\r\n?/g, '\n').split('\n')[0] || '';
  const header = splitCsvLine(firstLine).map(s => s.trim().toLowerCase()).join(',');
  if (header !== 'code,slug') {
    problems.push(`Header should be "code,slug" but is "${firstLine}"`);
  }

  for (const r of rows) {
    let code = (r.code || '').trim();
    let slug = (r.slug || '').trim();
    if (!code || !slug) continue;

    const origCode = code;
    const origSlug = slug;

    code = code.toUpperCase();
    slug = slug.toLowerCase();

    // Check slug validity
    if (!aspectSlugs.has(slug) && !allowedSpecial.has(slug)) {
      problems.push(`Unknown slug: "${origSlug}" (normalized: "${slug}") for code "${origCode}"`);
    }

    // Special note for hardcoded behavior
    if (code === 'ENDLESS SECRETS') {
      // This code is special-cased in App.tsx; CSV mapping will be ignored at runtime
      problems.push('Note: "ENDLESS SECRETS" has special behavior (Lost as Basic) and CSV mapping is ignored.');
    }

    // Dedup handling
    if (seenCodes.has(code)) {
      const prev = seenCodes.get(code);
      if (prev !== slug) {
        problems.push(`Conflict: code "${code}" maps to both "${prev}" and "${slug}"`);
      }
      // skip duplicate in normalized output
      continue;
    }
    seenCodes.set(code, slug);
    normalized.push({ code, slug });
  }

  if (problems.length) {
    console.log('Codes check found:');
    for (const p of problems) console.log(' -', p);
  } else {
    console.log('Codes check: OK');
  }

  if (FIX) {
    // Sort by code for stability
    normalized.sort((a, b) => a.code.localeCompare(b.code));
    const out = ['code,slug', ...normalized.map(r => `${r.code},${r.slug}`)].join('\n');
    fs.writeFileSync(codesPath, out, 'utf8');
    console.log('Wrote normalized file:', path.relative(repo, codesPath));
  }

  // Exit non-zero on errors (conflicts or unknown slugs), but not on notes
  const hasErrors = problems.some(p => p.startsWith('Unknown slug') || p.startsWith('Conflict'));
  process.exit(hasErrors ? 2 : 0);
}

main();
