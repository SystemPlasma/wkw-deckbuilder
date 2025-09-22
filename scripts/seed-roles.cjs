#!/usr/bin/env node
/**
 * Seed roles column in src/assets/data/cards.csv using heuristics.
 * - Adds a `roles` column if missing; otherwise overwrites empty values
 * - Roles supported: combat, draw, disrupt, move
 */
const fs = require('fs');
const path = require('path');

function parseCSV(raw) {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = split(lines[0]).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l || !l.trim()) continue;
    const parts = split(l);
    const r = {};
    headers.forEach((h, idx) => { r[h] = (parts[idx] ?? '').trim(); });
    rows.push(r);
  }
  return { headers, rows };
}
function split(line) {
  const out = []; let cur = ''; let q = false;
  for (let i=0;i<line.length;i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i+1] === '"') { cur += '"'; i++; }
        else q = false;
      } else cur += ch;
    } else {
      if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"') q = true;
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}
function toCSV(headers, rows) {
  const esc = (s) => {
    if (s == null) s = '';
    s = String(s);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = headers.map(esc).join(',');
  const body = rows.map(r => headers.map(h => esc(r[h] ?? '')).join(',')).join('\n');
  return head + '\n' + body + '\n';
}

const KW = {
  power_increase: ['boost','empower','enhance','valor','wrath','strike','charge','rally','boon','grace','surge','smite','glory'],
  power_reduction: ['weaken','reduce','drain','siphon','diminish','frail','exhaust','lower','miasma'],
  disruption: ['shield','aegis','barrier','protect','ward','mantle','sanctuary','oath','defend'],
  search_draw: ['search','draw','reveal','scry','glimpse','vision','insight','oracle','recall','repeat','written','threads','stargaze'],
  counter: ['counter','negate','silence','null','deny','disrupt','banish','cancel','blockade','mute','seal'],
  movement_increase: ['speed','haste','blink','teleport','dash','phase','wings','slipstream','shift','guiding star'],
  movement_reduction: ['root','bind','snare','ensnare','immobilize','slow','miasma','trap'],
  special: ['wish','intervention','destiny','song','prerogative','authority','grace','favor','mantle'],
  inflict_status: ['poison','fear','dread','horror','curse','stun','bind','root','snare','miasma','silence','oath','seal','paralys','weaken','torment']
};
function detectRoles(name) {
  const n = (name || '').toLowerCase();
  const out = new Set();
  for (const k of Object.keys(KW)) {
    if (KW[k].some(w => n.includes(w))) out.add(k);
  }
  return Array.from(out);
}

function main() {
  const csvPath = path.join(process.cwd(), 'src', 'assets', 'data', 'cards.csv');
  if (!fs.existsSync(csvPath)) {
    console.error('cards.csv not found at', csvPath);
    process.exit(1);
  }
  const raw = fs.readFileSync(csvPath, 'utf8');
  const { headers, rows } = parseCSV(raw);
  const hasRoles = headers.some(h => h.toLowerCase() === 'roles' || h.toLowerCase() === 'role');
  const rolesHeader = headers.find(h => h.toLowerCase() === 'roles') || headers.find(h => h.toLowerCase() === 'role') || 'roles';
  const nextHeaders = hasRoles ? headers : [...headers, 'roles'];
  for (const r of rows) {
    const current = (r[rolesHeader] || r['roles'] || r['role'] || '').trim();
    if (current) continue;
    const name = r.name || '';
    const roles = detectRoles(name);
    r['roles'] = roles.join(';');
  }
  const out = toCSV(nextHeaders, rows);
  fs.writeFileSync(csvPath, out, 'utf8');
  console.log('[seed-roles] Updated roles for', rows.length, 'rows');
}

main();
