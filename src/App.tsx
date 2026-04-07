import React, { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import CARD_IMAGE_URLS, { CARD_IMAGE_MIME } from './imageMap';
// CSV data via Vite-managed URLs (no query strings) so builds fingerprint and refresh on deploy
const aspectsCsvUrl = new URL('./assets/data/aspects.csv', import.meta.url).href;
const cardsCsvUrl = new URL('./assets/data/cards.csv', import.meta.url).href;
// Optional remote override for codes. If not set, we prefer a local hashed CSV.
const __CODES_BASE = ((import.meta as any)?.env?.VITE_CODES_URL) as string | undefined;
const codesCsvUrl: string | undefined = __CODES_BASE || undefined;

/** ------------------------
 * Card Data
 * ---------------------- */
type SpellType = "Holy" | "Light" | "Dark" | "Astral" | "Shadow" | "Travel" | "Info" | "Curse";

type Aspect = {
  slug: string;
  name: string;
  isBasic?: boolean;
  isDark?: boolean;
  isSpecial?: boolean;
  order?: number;
};

type Card = {
  id: string;
  name: string;
  type: SpellType;
  rank: number;
  maxCopies: number;
  aspect: Aspect["slug"];
};

const FOCUS_SLUG = 'focus';
const STUDY_SLUG = 'study';

// Pre-Bound Grimoire definition (admin-curated template decks)
type PreboundGrimoire = {
  id: string;
  name: string;
  description?: string;
  aspects: string[]; // required aspects to be unlocked by player
  // list of cards with optional counts. Accepts one of:
  //  - "card_id" (implies count 1)
  //  - "card_id:3" (parsed as id=count)
  //  - { id: "card_id", count: 3 }
  spellCards: Array<string | { id: string; count?: number }>; 
  recommended?: boolean; // highlight + sort to top
  loreTagline?: string; // optional lore/flavor
};

function resolveCardImageUrl(id: string): string | undefined {
  const mapped = CARD_IMAGE_URLS[id];
  const guessExtension = (source: string | undefined) => {
    const match = source?.match(/\.([a-z0-9]+)(?:[?#]|$)/i);
    return match?.[1] || 'png';
  };

  const baseFromEnv = (((import.meta as any)?.env?.BASE_URL) || '/') as string;
  let normalizedBase = baseFromEnv.endsWith('/') ? baseFromEnv : `${baseFromEnv}/`;
  if (!normalizedBase.startsWith('/')) normalizedBase = `/${normalizedBase}`;
  if (/\/assets\/?$/.test(normalizedBase)) {
    normalizedBase = normalizedBase.replace(/assets\/?$/, '');
    if (!normalizedBase.endsWith('/')) normalizedBase += '/';
  }

  // If our image map has an entry, normalize it for GitHub Pages base path.
  if (mapped) {
    if (/^(https?:|blob:|data:)/i.test(mapped)) return mapped;
    if (mapped.startsWith('/assets/')) {
      return `${normalizedBase}${mapped.replace(/^\/+/, '')}`;
    }
    return mapped;
  }

  const extension = guessExtension(mapped);
  const relativePath = `assets/cards/${id}.${extension}`;

  const buildAbsolute = () => {
    const sanitized = relativePath.replace(/^[./]+/, '');
    if (typeof window === 'undefined') {
      return `${normalizedBase}${sanitized}`;
    }
    try {
      return new URL(relativePath, window.location.origin + normalizedBase).toString();
    } catch {
      return `${window.location.origin}${normalizedBase}${sanitized}`;
    }
  };

  return buildAbsolute();
}

function isReferenceCard(card?: Card | null): boolean {
  if (!card) return false;
  const type = card.type;
  if (type === 'Travel' || type === 'Info' || type === 'Curse') return true;
  return card.id.toUpperCase().endsWith('_INFO');
}

// Cache blob URLs for obfuscated images to avoid refetching
const OBF_BLOB_CACHE: Map<string, string> = new Map();

// Priority-aware fetch scheduler for obfuscated assets
type Task = { key: string; id: string; priority: number; resolve: (url: string) => void; reject: (e: any) => void };
const MAX_CONCURRENT_OBF_FETCH = 6;
const obfQueue: Task[] = [];
const obfInflight: Set<string> = new Set();
const obfPromiseByKey: Map<string, Promise<string>> = new Map();

function pumpObfQueue() {
  while (obfInflight.size < MAX_CONCURRENT_OBF_FETCH && obfQueue.length > 0) {
    // take highest-priority task (lowest numeric value)
    obfQueue.sort((a, b) => a.priority - b.priority);
    const task = obfQueue.shift()!;
    if (obfInflight.has(task.key)) continue; // already running
    obfInflight.add(task.key);
    (async () => {
      try {
        const res = await fetch(task.key, { credentials: 'same-origin', cache: 'force-cache' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const blob = await res.blob();
        const desired = (CARD_IMAGE_MIME as any)?.[task.id] || 'image/png';
        const useBlob = (blob && (blob as any).type && (blob as any).type !== 'application/octet-stream') ? blob : new Blob([blob], { type: desired });
        const url = URL.createObjectURL(useBlob);
        OBF_BLOB_CACHE.set(task.key, url);
        task.resolve(url);
      } catch (e) {
        task.reject(e);
      } finally {
        obfInflight.delete(task.key);
        obfPromiseByKey.delete(task.key);
        pumpObfQueue();
      }
    })();
  }
}

function scheduleObfFetch(raw: string, id: string, priority: number): Promise<string> {
  if (OBF_BLOB_CACHE.has(raw)) {
    return Promise.resolve(OBF_BLOB_CACHE.get(raw)!);
  }
  if (obfPromiseByKey.has(raw)) {
    return obfPromiseByKey.get(raw)!;
  }
  const promise = new Promise<string>((resolve, reject) => {
    obfQueue.push({ key: raw, id, priority, resolve, reject });
    pumpObfQueue();
  });
  obfPromiseByKey.set(raw, promise);
  return promise;
}

async function prefetchCardImage(id: string, priority: number = 2): Promise<void> {
  const raw = resolveCardImageUrl(id);
  if (!raw || !raw.endsWith('.bin')) return;
  if (OBF_BLOB_CACHE.has(raw)) return;
  try { await scheduleObfFetch(raw, id, priority); } catch {}
}

function ObfImage({ id, className, alt, onError, priority = 3 }: { id: string; className?: string; alt?: string; onError?: React.ReactEventHandler<HTMLImageElement>; priority?: number }) {
  const raw = resolveCardImageUrl(id);
  const [src, setSrc] = React.useState<string | undefined>(undefined);
  const [tick, setTick] = React.useState(0); // bump to retry on failure
  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!raw) { setSrc(undefined); return; }
      if (!raw.endsWith('.bin')) { setSrc(raw); return; }
      const cached = OBF_BLOB_CACHE.get(raw);
      if (cached) { setSrc(cached); return; }
      try {
        const url = await scheduleObfFetch(raw, id, priority);
        if (!cancelled) setSrc(url);
      } catch {
        if (!cancelled) setSrc(undefined);
      }
    }
    load();
    return () => { cancelled = true; /* do not revoke cached blob URLs */ };
  }, [id, raw, tick, priority]);
  if (!src) return null;
  const handleError: React.ReactEventHandler<HTMLImageElement> = (e) => {
    // If a cached blob URL was revoked or became invalid, purge and retry once
    if (raw && raw.endsWith('.bin')) {
      OBF_BLOB_CACHE.delete(raw);
      setSrc(undefined);
      setTick((t) => t + 1);
    }
    onError?.(e);
  };
  return <img src={src} alt={alt} className={className} onError={handleError} loading="lazy" decoding="async" />;
}

// All card and aspect data is sourced from CSV files in src/assets/data

// Optional rules/effect text was used in tooltips; removed with tooltip feature.

// Image sheets removed: each card uses its own file by id under src/assets/cards/

//

// Unlock codes are now sourced from CSV (see src/assets/data/unlock_codes.csv)

/** ------------------------
 * CSV loading (optional)
 * ---------------------- */
type CsvRow = Record<string, string>;
function parseCSV(raw: string): CsvRow[] {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n").filter(l => l.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = splitCsvLine(lines[0]).map(h => h.trim());
  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = splitCsvLine(lines[i]);
    const row: CsvRow = {};
    headers.forEach((h, idx) => { row[h] = (parts[idx] ?? '').trim(); });
    rows.push(row);
  }
  return rows;
}
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
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

function toBool(v: string | undefined): boolean | undefined {
  if (!v) return undefined;
  const t = v.trim().toLowerCase();
  if (["true","1","yes","y"].includes(t)) return true;
  if (["false","0","no","n"].includes(t)) return false;
  return undefined;
}

function toNum(v: string | undefined): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

async function loadDataFromCsv() {
  const [aspectsRaw, cardsRaw] = await Promise.all([
    fetch(aspectsCsvUrl).then(r => r.ok ? r.text() : ''),
    fetch(cardsCsvUrl).then(r => r.ok ? r.text() : ''),
  ]);

  // Prefer a hashed local CSV if available; otherwise use provided URL
  let codesRaw = '';
  try {
    if (!__CODES_BASE) {
      const hashedLocal = new URL('./assets/data/unlock_codes_hashed.csv', import.meta.url).href;
      const res = await fetch(hashedLocal);
      if (res.ok) {
        codesRaw = await res.text();
      }
    }
  } catch {
    // ignore; fall back to default
  }
  if (!codesRaw && codesCsvUrl) {
    try {
      const res = await fetch(codesCsvUrl);
      if (res.ok) codesRaw = await res.text();
    } catch {
      codesRaw = '';
    }
  }

  const aspects: Aspect[] | undefined = aspectsRaw
    ? parseCSV(aspectsRaw).map(r => ({
        slug: r.slug,
        name: r.name,
        isBasic: toBool(r.isBasic),
        isDark: toBool(r.isDark),
        isSpecial: toBool(r.isSpecial),
        order: toNum(r.order),
      })).filter(a => a.slug && a.name)
    : undefined;

  // Build a robust mapping from various aspect representations -> slug
  const aspectSlugByKey: Record<string, string> = aspects
    ? aspects.reduce((acc, a) => {
        const slug = (a.slug || '').trim().toLowerCase();
        const name = (a.name || '').trim().toLowerCase();
        const nameNoPrefix = name.replace(/^aspect of\s+/i, '').toLowerCase();
        const nameSpacedToSlug = name.replace(/\s+/g, '-').toLowerCase();
        const nameNoPrefixSlug = nameNoPrefix.replace(/\s+/g, '-').toLowerCase();
        acc[slug] = a.slug;
        acc[name] = a.slug;
        acc[nameNoPrefix] = a.slug;
        acc[nameSpacedToSlug] = a.slug;
        acc[nameNoPrefixSlug] = a.slug;
        return acc;
      }, {} as Record<string, string>)
    : {};

  const cards: Card[] | undefined = cardsRaw
    ? parseCSV(cardsRaw).map(r => {
        const rawAspect = (r.aspect || '').trim();
        const normalizedAspect = aspectSlugByKey[rawAspect.toLowerCase()] || (rawAspect as Aspect['slug']);
        return {
          id: r.id,
          name: r.name,
          type: (r.type as SpellType),
          rank: Number((r as any).InkCost || (r as any).inkCost || r.rank || 0),
          maxCopies: Number(r.maxCopies || 0),
          aspect: normalizedAspect,
        } as Card;
      }).filter(c => c.id && c.name && c.aspect)
    : undefined;

  let codes: Record<string, string> | undefined = undefined;
  let codeHashes: Record<string, string> | undefined = undefined;
  if (codesRaw) {
    const rows = parseCSV(codesRaw);
    const hasHash = rows.length > 0 && (Object.prototype.hasOwnProperty.call(rows[0], 'hash') || Object.prototype.hasOwnProperty.call(rows[0], 'sha256'));
    if (hasHash) {
      codeHashes = Object.fromEntries(
        rows
          .map(r => [
            ((r as any).hash || (r as any).sha256 || '').trim().toLowerCase(),
            (r.slug || '').trim().toLowerCase(),
          ])
          .filter(([h, slug]) => h && slug)
      );
    } else {
      codes = Object.fromEntries(
        rows
          .map(r => [
            (r.code || '').trim().toUpperCase(),
            (r.slug || '').trim().toLowerCase(),
          ])
          .filter(([code, slug]) => code && slug)
      );
    }
  }

  return { aspects, cards, codes, codeHashes } as { aspects?: Aspect[]; cards?: Card[]; codes?: Record<string,string>; codeHashes?: Record<string,string> };
}

const TYPE_ORDER: Record<SpellType, number> = {
  Holy: 7,
  Light: 6,
  Astral: 5,
  Shadow: 4,
  Dark: 3,
  Curse: 2,
  Travel: 1,
  Info: 0,
};
const PARALLEL_CARD_IDS = new Set<string>([
  'energy_supernova_converter','energy_will_power','energy_fears_grasp','energy_rage_unleashed',
  'madness_twisted_space','madness_shattered_time','madness_splintered_mind','madness_unhinged_reality','madness_chaotic_power','madness_eclipsed_soul',
]);

type ModeToggleId =
  | 'starlight_addition'
  | 'shadow_addition'
  | 'parallel_dimension'
  | 'fragments_mode';

type ModeMessage = { type: 'info' | 'warning' | 'error'; text: string };

type CollapsibleSectionId = 'basics' | 'dark' | 'special';

const MODE_TOGGLE_META: Record<ModeToggleId, {
  label: string;
  description: string;
  requiresAspects?: string[]; // all of these must be available
  requiresAnyAspects?: string[]; // at least one of these must be available
  requiresToggle?: ModeToggleId[];
  conflicts?: ModeToggleId[];
  modifiesDeckLimit?: boolean;
}> = {
  starlight_addition: {
    label: 'Starlight Addition',
    description: 'Enable Astral spells and extend slots to [Astral] ×7.',
    requiresAspects: ['starlight'],
  },
  shadow_addition: {
    label: 'Shadow Addition',
    description: 'Enable Shadow spells and extend slots to [Shadow] ×3.',
    requiresAspects: ['shadows'],
  },
  parallel_dimension: {
    label: 'Parallel Dimension Addition',
    description: 'Reveal Parallel [Light] spells as replacements for standard versions.',
    requiresAnyAspects: ['madness', 'energy'],
  },
  fragments_mode: {
    label: 'Fragments Mode',
    description: 'Limit spells above Rank 2 to a single copy.',
  },
};

const MODE_DISPLAY_ORDER: ModeToggleId[] = [
  'fragments_mode',
  'starlight_addition',
  'shadow_addition',
  'parallel_dimension',
];

const MODE_REQUIREMENT_BY_ASPECT: Record<string, { toggle: ModeToggleId; label: string }> = {
  starlight: { toggle: 'starlight_addition', label: 'Starlight Addition' },
  shadows: { toggle: 'shadow_addition', label: 'Shadow Addition' },
  madness: { toggle: 'parallel_dimension', label: 'Parallel Dimension Addition' },
  energy: { toggle: 'parallel_dimension', label: 'Parallel Dimension Addition' },
};

const MODE_TOGGLE_IDS: ModeToggleId[] = [
  'starlight_addition',
  'shadow_addition',
  'parallel_dimension',
  'fragments_mode',
];

function createDefaultModeState(): Record<ModeToggleId, boolean> {
  return MODE_TOGGLE_IDS.reduce((acc, id) => {
    acc[id] = false;
    return acc;
  }, {} as Record<ModeToggleId, boolean>);
}

function createDefaultModeAutoLockState(): Record<ModeToggleId, boolean> {
  return MODE_TOGGLE_IDS.reduce((acc, id) => {
    acc[id] = true;
    return acc;
  }, {} as Record<ModeToggleId, boolean>);
}

function aspectDisplayName(aspect: Aspect, unlocked: boolean): string {
  const base = aspect.name || aspect.slug;
  if (unlocked) return base.startsWith('Aspect of') ? base : `Aspect of ${base}`;
  return base.startsWith('Aspect of') ? 'Aspect of ???' : 'Aspect of ???';
}

type AdditionalGroupRenderArgs = {
  aspect: Aspect;
  additionalGroupExpanded: Record<string, boolean>;
  overrideAll: boolean;
  unlocksSet: Set<string>;
  aspectAllowedByModes: (slug: string) => boolean;
  modeRequirementHint: (slug: string) => string | undefined;
  chosenAspects: string[];
  aspects: Aspect[];
  aspectEligible: (slug: string) => boolean;
  maxNonSpecialAllowed: number;
  toggleAdditionalGroup: (key: string) => void;
  toggleAspect: (slug: string) => void;
  DARK_SLUGS: readonly string[];
};

function renderAdditionalLostAspect(args: AdditionalGroupRenderArgs) {
  const {
    aspect,
    additionalGroupExpanded,
    overrideAll,
    unlocksSet,
    aspectAllowedByModes,
    modeRequirementHint,
    chosenAspects,
    aspects,
    aspectEligible,
    maxNonSpecialAllowed,
    toggleAdditionalGroup,
    toggleAspect,
    DARK_SLUGS,
  } = args;
  const unlocked = overrideAll || unlocksSet.has(aspect.slug);
  if (!unlocked) return null;
  const key = aspect.slug;
  const open = additionalGroupExpanded[key] ?? false;
  const isSelected = chosenAspects.includes(aspect.slug);
  const allowed = aspectAllowedByModes(aspect.slug);
  const modeLocked = !allowed && unlocked && !overrideAll;
  const modeHint = modeRequirementHint(aspect.slug);
  const nonSpecialSelected = chosenAspects
    .filter((s) => !aspects.find(x => x.slug === s)?.isSpecial)
    .filter((s) => aspectEligible(s) && aspectAllowedByModes(s));
  const nextSet = new Set([...nonSpecialSelected, aspect.slug]);
  const nextCount = nextSet.size;
  const nextIsExactDarkTrio = (DARK_SLUGS as readonly string[]).every((s) => nextSet.has(s)) && nextSet.size === (DARK_SLUGS as readonly string[]).length;
  const disabled = modeLocked || (!overrideAll && !isSelected && !(nextCount <= maxNonSpecialAllowed || nextIsExactDarkTrio));
  const label = aspectDisplayName(aspect, unlocked);
  const labelWithIndicator = isSelected ? `${label} · 1 selected` : label;

  return (
    <div key={aspect.slug} className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white/60 dark:bg-slate-900/40 shadow-sm">
      <div className="flex items-center gap-2 rounded-xl px-3 py-2 text-base font-semibold text-slate-900 dark:text-slate-100">
        <span className="flex-1 text-center">{labelWithIndicator}</span>
        <button
          type="button"
          onClick={() => toggleAdditionalGroup(key)}
          className="inline-flex items-center justify-center px-3 py-1 text-xs font-semibold border border-slate-300 dark:border-slate-600 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 shadow-sm"
        >
          {open ? 'Collapse' : 'Expand'}
        </button>
      </div>
      {open && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <AspectCard
            key={aspect.slug}
            aspect={aspect}
            unlocked={unlocked}
            selected={isSelected}
            disabled={disabled}
            hint={modeHint}
            onToggle={() => toggleAspect(aspect.slug)}
          />
        </div>
      )}
    </div>
  );
}

type AdditionalGroupListArgs = {
  group: Aspect[];
  idx: number;
  additionalGroupExpanded: Record<string, boolean>;
  overrideAll: boolean;
  unlocksSet: Set<string>;
  aspectAllowedByModes: (slug: string) => boolean;
  modeRequirementHint: (slug: string) => string | undefined;
  chosenAspects: string[];
  aspects: Aspect[];
  aspectEligible: (slug: string) => boolean;
  maxNonSpecialAllowed: number;
  toggleAdditionalGroup: (key: string) => void;
  toggleAspect: (slug: string) => void;
  DARK_SLUGS: readonly string[];
};

function renderAdditionalGroup(args: AdditionalGroupListArgs) {
  const {
    group,
    idx,
    additionalGroupExpanded,
    overrideAll,
    unlocksSet,
    aspectAllowedByModes,
    modeRequirementHint,
    chosenAspects,
    aspects,
    aspectEligible,
    maxNonSpecialAllowed,
    toggleAdditionalGroup,
    toggleAspect,
    DARK_SLUGS,
  } = args;

  const groupKey = group.map((a) => a.slug).join('__');
  const open = additionalGroupExpanded[groupKey] ?? false;
  const unlockedAspects = group.filter((a) => overrideAll || unlocksSet.has(a.slug));
  if (unlockedAspects.length === 0) return null;
  const plainName = (name: string) => name.replace(/^Aspect of\s+/i, '').trim();
  let label: string;
  if (group.length === 1) {
    const aspect = group[0];
    const unlocked = overrideAll || unlocksSet.has(aspect.slug);
    label = unlocked ? `Aspect of ${plainName(aspect.name || aspect.slug)}` : 'Aspect of ???';
  } else {
    const names = group.map((a) => {
      const unlocked = overrideAll || unlocksSet.has(a.slug);
      return unlocked ? plainName(a.name || a.slug) : '???';
    });
    label = `Aspects of ${names.join(' and ')}`;
  }
  const selectedCount = group.filter((a) => chosenAspects.includes(a.slug)).length;
  const labelWithIndicator = selectedCount > 0 ? `${label} · ${selectedCount} selected` : label;

  return (
    <div
      key={groupKey || `group-${idx}`}
      className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white/60 dark:bg-slate-900/40 shadow-sm"
    >
      <div className="flex items-center gap-2 rounded-xl px-3 py-2 text-base font-semibold text-slate-900 dark:text-slate-100">
        <span className="flex-1 text-center">{labelWithIndicator}</span>
        <button
          type="button"
          onClick={() => toggleAdditionalGroup(groupKey)}
          className="inline-flex items-center justify-center px-3 py-1 text-xs font-semibold border border-slate-300 dark:border-slate-600 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 shadow-sm"
        >
          {open ? 'Collapse' : 'Expand'}
        </button>
      </div>
      {open && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          {unlockedAspects.map((a) => {
            const isSelected = chosenAspects.includes(a.slug);
            const unlockedForCodes = overrideAll || unlocksSet.has(a.slug);
            const allowed = aspectAllowedByModes(a.slug);
            const modeLocked = !allowed && unlockedForCodes && !overrideAll;
            const modeHint = modeRequirementHint(a.slug);
            const nonSpecialSelected = chosenAspects
              .filter((s) => !aspects.find(x => x.slug === s)?.isSpecial)
              .filter((s) => aspectEligible(s) && aspectAllowedByModes(s));
            const nextSet = new Set([...nonSpecialSelected, a.slug]);
            const nextCount = nextSet.size;
            const nextIsExactDarkTrio = (DARK_SLUGS as readonly string[]).every((s) => nextSet.has(s)) && nextSet.size === (DARK_SLUGS as readonly string[]).length;
            const disabled = modeLocked || (!overrideAll && !isSelected && !(nextCount <= maxNonSpecialAllowed || nextIsExactDarkTrio));
            return (
              <AspectCard
                key={a.slug}
                aspect={a}
                unlocked={unlockedForCodes}
                selected={isSelected}
                disabled={disabled}
                hint={modeHint}
                onToggle={() => toggleAspect(a.slug)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

/** ------------------------
 * Small UI helpers
 * ---------------------- */
function Pill({ children }: { children: React.ReactNode }) {
  return <span className="px-2 py-1 rounded-full text-xs bg-slate-200 dark:bg-slate-700 dark:text-slate-100">{children}</span>;
}

function ModeToggleRow({
  label,
  description,
  active,
  disabled,
  disabledReason,
  conflictAdvice,
  onToggle,
}: {
  label: string;
  description: string;
  active: boolean;
  disabled: boolean;
  disabledReason?: string;
  conflictAdvice?: string;
  onToggle: () => void;
}) {
  const trackClasses = active ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-700';
  const knobClasses = active ? 'translate-x-5 bg-white' : 'translate-x-1 bg-white';
  return (
    <div className={[
      'rounded-xl border p-3 text-left transition-colors',
      active ? 'border-emerald-500 bg-emerald-50/60 dark:bg-emerald-500/10' : 'border-slate-300 dark:border-slate-600 bg-white/70 dark:bg-slate-800/60',
      disabled ? 'opacity-60' : '',
    ].join(' ')}>
      <div className="flex items-start gap-3">
        <div className="flex-1 space-y-1">
          <div className="font-semibold text-slate-900 dark:text-slate-50">{label}</div>
          <div className="text-sm text-slate-600 dark:text-slate-300">{description}</div>
          {disabledReason ? (
            <div className="text-xs text-amber-600 dark:text-amber-300">{disabledReason}</div>
          ) : null}
          {conflictAdvice ? (
            <div className="text-xs text-amber-600 dark:text-amber-300">{conflictAdvice}</div>
          ) : null}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={active}
          disabled={disabled}
          onClick={onToggle}
          className="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:cursor-not-allowed"
          aria-disabled={disabled}
        >
          <span className="sr-only">Toggle {label}</span>
          <span className={`absolute inset-0 rounded-full transition ${trackClasses}`}></span>
          <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full shadow transition ${knobClasses}`}></span>
        </button>
      </div>
    </div>
  );
}

// Tooltip removed in favor of click-to-open preview modal

function AspectCard({
  aspect,
  unlocked,
  selected,
  disabled = false,
  onToggle,
  hint,
}: {
  aspect: Aspect;
  unlocked: boolean;
  selected: boolean;
  disabled?: boolean;
  onToggle: () => void;
  hint?: string;
}) {
  return (
    <button
      onClick={() => {
        console.log('[AspectCard.click]', { slug: aspect.slug, selected, disabled, unlocked });
        onToggle();
      }}
      disabled={!unlocked || disabled}
      className={[
        "rounded-2xl p-4 w-full text-center border transition shadow-sm focus:outline-none relative",
        selected
          ? [
              // Light mode selected style
              "border-indigo-600 bg-indigo-50 ring-2 ring-indigo-500 ring-offset-2 ring-offset-white shadow-md z-10",
              // Dark mode selected style — darker panel, indigo accents, correct offset
              "dark:bg-slate-800 dark:border-indigo-400 dark:ring-indigo-400 dark:ring-offset-slate-900",
            ].join(' ')
          : "border-slate-400 bg-slate-200 hover:bg-slate-300 hover:shadow-md dark:bg-slate-800 dark:border-slate-600",
        (!unlocked || disabled) ? "opacity-40 cursor-not-allowed pointer-events-none" : "hover:border-slate-500",
      ].join(" ")}
    >
      <div className="flex flex-col items-center gap-1">
        {unlocked ? (
          <>
            <div className="text-sm text-slate-500 dark:text-slate-400">
              {aspect.isBasic ? "Basics" : aspect.isSpecial ? "Special" : aspect.isDark ? "Dark Art" : "Aspect"}
            </div>
            <div className="text-base font-semibold">{aspect.name}</div>
          </>
        ) : (
          <div className="text-base font-semibold">Locked</div>
        )}
        <div className="flex items-center gap-2 mt-1">          
          {selected && <Pill>(Selected)</Pill>}
        </div>
        {hint && (!unlocked || disabled) && (
          <div className="mt-2 text-xs text-amber-600 dark:text-amber-300 text-center leading-snug">
            {hint}
          </div>
        )}
      </div>
    </button>
  );
}

function UnlockModal({
  onRedeem,
  onClose,
}: {
  onRedeem: (code: string) => { ok: boolean; unlockedName?: string; status?: 'ok' | 'invalid' | 'used' } | Promise<{ ok: boolean; unlockedName?: string; status?: 'ok' | 'invalid' | 'used' }>;
  onClose: () => void;
}) {
  const [code, setCode] = useState("");
  const [lastUnlocked, setLastUnlocked] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4"
      style={{ position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.9)' }}
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      tabIndex={-1}
    >
      <div
        className="bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 rounded-2xl shadow-2xl w-full max-w-md p-6 flex flex-col gap-3 min-h-[180px] border border-slate-200 dark:border-slate-700"
        style={{ borderRadius: '1rem', padding: '1.5rem', maxWidth: 480, width: '100%' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-xl font-bold text-center text-black dark:text-slate-100">Unlock an Aspect</h2>
        {lastUnlocked && (
          <div className="text-sm text-center font-medium text-slate-900 dark:text-slate-100">
            {lastUnlocked === 'Invalid Code' || lastUnlocked === 'Code Already Used' ? (
              lastUnlocked
            ) : (
              lastUnlocked.split('\n').map((line, i) => (
                <div key={i}>Unlocked: {line}</div>
              ))
            )}
          </div>
        )}
        <p className="text-xl text-center text-black dark:text-slate-100">
          Enter your code to reveal an Aspect’s spells.
        </p>
        <input
          ref={inputRef}
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="Enter code"
          className="w-full h-[60px] border rounded-xl p-6 text-2xl uppercase bg-white text-black placeholder:text-slate-500 border-slate-300 dark:bg-slate-800 dark:text-white dark:placeholder:text-slate-400 dark:border-slate-700"
          onKeyDown={async (e) => {
            if (e.key === 'Enter') {
              const res = await onRedeem(code);
              if (res?.ok) {
                setLastUnlocked(res.unlockedName || null);
              } else {
                setLastUnlocked(res?.status === 'used' ? 'Code Already Used' : 'Invalid Code');
              }
              setCode("");
              setTimeout(() => inputRef.current?.focus(), 0);
            } else if (e.key === 'Escape') {
              onClose();
            }
          }}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
        />
        <div className="flex gap-2 pt-2">
          <button
            onClick={async () => {
              console.log("[UI] Redeem clicked");
              const res = await onRedeem(code);
              if (res?.ok) {
                setLastUnlocked(res.unlockedName || null);
              } else {
                setLastUnlocked(res?.status === 'used' ? 'Code Already Used' : 'Invalid Code');
              }
              setCode("");
              setTimeout(() => inputRef.current?.focus(), 0);
            }}
            className="flex-1 rounded-xl bg-indigo-600 text-white py-2 font-medium hover:bg-indigo-700"
          >
            Unlock
          </button>
          <button
            onClick={onClose}
            className="flex-1 rounded-xl bg-slate-100 py-2 font-medium hover:bg-slate-200 text-slate-900 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function PasswordGate({ onVerify, error }: { onVerify: (input: string) => Promise<boolean> | boolean; error: string | null }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const formId = 'admin-auth-form';
  const pwdId = 'admin-password-input';
  return (
    <form
      id={formId}
      className="rounded-lg border border-slate-300 dark:border-slate-700 p-4 bg-white/60 dark:bg-slate-900/40"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        try {
          await onVerify(value);
        } finally {
          setBusy(false);
        }
      }}
      autoComplete="on"
    >
      {/* Visually-hidden username so password managers see an associated account */}
      <input
        id="admin-username-input"
        type="text"
        name="username"
        form={formId}
        autoComplete="username"
        value="admin"
        readOnly
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
      />

      <label htmlFor={pwdId} className="text-sm mb-2 inline-block">Password</label>
      <div className="flex gap-2 items-center">
        <input
          id={pwdId}
          name="password"
          type="password"
          autoComplete="current-password"
          form={formId}
          value={value}
          onChange={(e)=>setValue(e.target.value)}
          className="flex-1 rounded border px-3 py-2 bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100 border-slate-300 dark:border-slate-700"
          placeholder="Enter password"
        />
        <button type="submit" className="rounded px-3 py-2 bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60" disabled={busy}>Enter</button>
      </div>
      {error && <div className="text-xs text-rose-600 dark:text-rose-300 mt-2">{error}</div>}
    </form>
  );
}

function CardRow({
  card,
  qty,
  onChange,
  locked,
  readOnly = false,
  onPreview,
  remainingSlots,
  remainingTypeSlots,
  onCapAttempt,
}: {
  card: Card;
  qty: number;
  onChange: (n: number) => void;
  locked: boolean;
  readOnly?: boolean;
  onPreview?: (card: Card) => void;
  remainingSlots: number;
  remainingTypeSlots: number;
  onCapAttempt?: (t: SpellType) => void;
}) {
  const countsTowardPages = !readOnly && card.type !== 'Astral' && card.type !== 'Shadow';
  const noRoomTotal = countsTowardPages && remainingSlots <= 0;
  const noRoomType = countsTowardPages && remainingTypeSlots <= 0;
  const controlsDisabled = locked || readOnly;
  const capType = card.type === 'Curse' ? 'Dark' : card.type;
  const addDisabled = controlsDisabled || (!locked && (noRoomTotal || qty >= card.maxCopies));
  return (
    <div className="flex flex-col md:grid md:grid-cols-[minmax(0,36%)_1fr_auto] md:items-center gap-2 md:gap-3 py-2 px-0">
      {/* Mobile: name left, controls right */}
      <div className="flex items-center justify-between gap-2 md:hidden w-full">
        <div className="font-medium text-left min-w-0 px-1">
          {locked ? (
            <span className="text-slate-500">{"<Locked>"}</span>
          ) : (
            <button
              type="button"
              className="inline-flex items-center justify-center text-center rounded px-3 min-w-14 py-1 bg-indigo-50 text-indigo-700 hover:bg-indigo-50 shadow-sm dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600"
              onMouseEnter={() => prefetchCardImage(card.id, 1)}
              onFocus={() => prefetchCardImage(card.id, 1)}
              onClick={() => { console.log('[CardRow.preview]', { id: card.id, name: card.name }); onPreview?.(card); }}
            >
              {card.name}
            </button>
          )}
        </div>
        <div className="grid grid-cols-3 grid-rows-2 items-center gap-x-2 gap-y-1">
          <button
            onClick={() => { if (controlsDisabled || qty <= 0) return; const n = Math.max(0, qty - 1); onChange(n); }}
            disabled={controlsDisabled || qty <= 0}
            className={["px-1.5 py-1 rounded shadow-sm text-base font-bold text-slate-900 dark:text-slate-900 leading-none", qty <= 0 ? "bg-slate-100 opacity-50 cursor-not-allowed" : "bg-slate-100"].join(' ')}
          >
            -
          </button>
          <div className="w-7 text-center">{qty}</div>
          <button
            onClick={() => {
            if (controlsDisabled) return;
            if (noRoomType) { onCapAttempt?.(capType); return; }
            if (addDisabled) return;
            const n = Math.min(card.maxCopies, qty + 1);
            onChange(n);
          }}
            disabled={controlsDisabled || noRoomTotal || qty >= card.maxCopies}
            className={["px-1.5 py-1 rounded shadow-sm text-base font-bold text-slate-900 dark:text-slate-900 leading-none", locked || addDisabled || qty >= card.maxCopies ? "bg-slate-100 opacity-50 cursor-not-allowed" : "bg-slate-100"].join(' ')}
          >
            +
          </button>
          <button
            onClick={() => {
              if (controlsDisabled) return;
              if (!countsTowardPages) { onChange(card.maxCopies); return; }
              const roomTotal = Math.max(0, remainingSlots);
              const roomType = Math.max(0, remainingTypeSlots);
              const room = Math.min(roomTotal, roomType);
              if (room <= 0) { if (roomType <= 0) onCapAttempt?.(capType); return; }
              const target = Math.min(card.maxCopies, qty + room);
              onChange(target);
            }}
            disabled={controlsDisabled || noRoomTotal}
            className={[
              "col-start-3 row-start-2 justify-self-end px-1.5 py-1 text-xs rounded shadow-sm",
              (locked || noRoomTotal)
                ? "bg-slate-100 text-slate-400 cursor-not-allowed"
                : "bg-indigo-100 text-indigo-800 hover:bg-indigo-200"
            ].join(' ')}
            title={`Set to Max (${card.maxCopies})`}
          >
            MAX
          </button>
        </div>
      </div>

      {/* Left: name button (desktop) */}
      <div className="hidden md:block font-medium text-left md:col-start-1 min-w-0 md:px-1">
        {locked ? (
          <span className="text-slate-500">{"<Locked>"}</span>
        ) : (
          <button
            type="button"
            className="inline-flex items-center justify-center text-center rounded px-3 min-w-14 py-1 bg-indigo-50 text-indigo-700 hover:bg-indigo-50 shadow-sm dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600"
            onMouseEnter={() => prefetchCardImage(card.id, 1)}
            onFocus={() => prefetchCardImage(card.id, 1)}
            onClick={() => { console.log('[CardRow.preview]', { id: card.id, name: card.name }); onPreview?.(card); }}
          >
            {card.name}
          </button>
        )}
      </div>
      {/* Center: type/rank/max — stacked on mobile, grouped with spacing on md+ */}
      <div className="w-full md:col-start-2 leading-tight text-center md:text-left md:pl-0 md:pr-0 min-w-0">
        {/* Mobile: stacked */}
        <div className="md:hidden text-left pl-2">
          <div className="text-base text-slate-600 dark:text-slate-300">
            {(() => {
              const mark = !locked && PARALLEL_CARD_IDS.has(card.id) ? ' (Parallel)' : '';
              const costLabel = (card.type as any) === 'Travel' ? 'MP' : 'INK';
              return locked ? '?' : `${card.type}${mark} · ${costLabel}: ${card.rank}`;
            })()}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-300 mt-1">
            {readOnly ? 'View only' : `Max ${card.maxCopies}`}
          </div>
        </div>
        {/* Desktop: single line with spacing between left (type/rank) and right (Max) */}
        <div className="hidden md:flex items-baseline justify-start gap-4">
          <span className="text-base text-slate-600 dark:text-slate-300 whitespace-nowrap">
            {(() => {
              const mark = !locked && PARALLEL_CARD_IDS.has(card.id) ? ' (Parallel)' : '';
              const costLabel = (card.type as any) === 'Travel' ? 'MP' : 'INK';
              return locked ? '?' : `${card.type}${mark} · ${costLabel}: ${card.rank}`;
            })()}
          </span>
          <span className="text-sm text-slate-500 dark:text-slate-300 whitespace-nowrap">
            {readOnly ? 'View only' : `Max ${card.maxCopies}`}
          </span>
        </div>
      </div>

      {/* Right controls pinned to the far right (desktop) */}
      <div className="hidden md:flex items-center gap-2 shrink-0 md:col-start-3 md:justify-self-end">
        <button
          onClick={() => { if (controlsDisabled || qty <= 0) return; const n = Math.max(0, qty - 1); console.log('[CardRow.qty-]', { id: card.id, from: qty, to: n }); onChange(n); }}
          disabled={controlsDisabled || qty <= 0}
          className={["px-1.5 py-1 md:px-2 rounded shadow-sm text-base md:text-lg font-bold text-slate-900 dark:text-slate-900 leading-none", qty <= 0 ? "bg-slate-100 opacity-50 cursor-not-allowed" : "bg-slate-100"].join(' ')}
        >
          -
        </button>
        <div className="w-7 md:w-8 text-center">{qty}</div>
        <button
          onClick={() => {
            if (controlsDisabled) return;
            if (noRoomType) { onCapAttempt?.(capType); return; }
            if (addDisabled) return;
            const n = Math.min(card.maxCopies, qty + 1);
            console.log('[CardRow.qty+]', { id: card.id, from: qty, to: n });
            onChange(n);
          }}
          disabled={controlsDisabled || noRoomTotal || qty >= card.maxCopies}
          className={["px-1.5 py-1 md:px-2 rounded shadow-sm text-base md:text-lg font-bold text-slate-900 dark:text-slate-900 leading-none", locked || addDisabled || qty >= card.maxCopies ? "bg-slate-100 opacity-50 cursor-not-allowed" : "bg-slate-100"].join(' ')}
        >
          +
        </button>
        <button
          onClick={() => {
            if (controlsDisabled) return;
            if (!countsTowardPages) {
              console.log('[CardRow.max]', { id: card.id, to: card.maxCopies });
              onChange(card.maxCopies);
              return;
            }
            const roomTotal = Math.max(0, remainingSlots);
            const roomType = Math.max(0, remainingTypeSlots);
            const room = Math.min(roomTotal, roomType);
            if (room <= 0) { if (roomType <= 0) onCapAttempt?.(capType); return; }
            const target = Math.min(card.maxCopies, qty + room);
            console.log('[CardRow.max]', { id: card.id, from: qty, room, to: target });
            onChange(target);
          }}
          disabled={controlsDisabled || noRoomTotal}
          className={["px-1.5 py-1 md:px-2 text-xs md:text-sm rounded shadow-sm", (locked || noRoomTotal) ? "bg-slate-100 text-slate-400 cursor-not-allowed" : "bg-indigo-100 text-indigo-800 hover:bg-indigo-200"].join(' ')}
          title={`Set to Max (${card.maxCopies})`}
        >
          MAX
        </button>
      </div>
    </div>
  );
}

function CardPreviewModal({ card, aspectLabel, onClose }: { card: Card; aspectLabel: string; onClose: () => void }) {
  // Resolve URL from statically imported map; fallback to message on error
  const url = useMemo(() => resolveCardImageUrl(card.id), [card.id]);

  if (import.meta.url && (import.meta as any).env?.DEV) {
    console.debug('[CardPreview]', card.id, '→', url);
  }

  const target = (typeof document !== 'undefined' && document.getElementById('root')) || document.body;
  const overlayRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // Focus the overlay so onKeyDown captures ESC; also attach a document fallback
    overlayRef.current?.focus();
    const onDocKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onDocKey);
    return () => document.removeEventListener('keydown', onDocKey);
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[9999] bg-black/90 backdrop-blur-sm flex items-center justify-center p-4"
      style={{ position: 'fixed', inset: 0 as any, zIndex: 2147483647, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.9)' }}
      data-test="card-preview-modal"
      ref={overlayRef}
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      tabIndex={-1}
    >
      <div
        className="bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 rounded-2xl shadow-2xl w-full max-w-2xl p-4 flex flex-col gap-3 pointer-events-auto border border-slate-200 dark:border-slate-700"
        style={{ borderRadius: '1rem', maxWidth: '42rem', width: '100%', padding: '1rem' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold">{card.name}</h3>
            <div className="text-sm text-slate-800 dark:text-slate-200">
              {(() => {
                const costLabel = (card.type as any) === 'Travel' ? 'MP' : 'INK';
                return `[${card.type}] · ${costLabel}: ${card.rank} · ${aspectLabel}`;
              })()}
            </div>
          </div>
          <button
            type="button"
            aria-label="Close preview"
            className="rounded-lg px-3 py-1 bg-slate-100 hover:bg-slate-200 text-slate-900 border border-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 dark:border-slate-700"
            onClick={() => { console.log('[CardPreview.close]', { id: card.id }); onClose(); }}
          >
            Close
          </button>
        </div>

        <div className="flex items-center justify-center p-2 text-center">
          {url ? (
            <ObfImage
              id={card.id}
              alt={`${card.name} card`}
              className="max-w-full max-h-[70vh] rounded-md shadow-md object-contain"
              priority={0}
            />
          ) : (
            <div className="text-sm text-slate-900 dark:text-slate-100 text-center">
              No image available for this card.
              <br />
              <span className="text-xs text-slate-600 dark:text-slate-300">id: {card.id}</span>
              {/* URL intentionally hidden in production */}
            </div>
          )}
        </div>
      </div>
    </div>,
    target
  );
}

function DeckExport({ entries, aspects, cards, hasAstral, hasShadow }: { entries: { cardId: string; qty: number }[]; aspects: Aspect[]; cards: Card[]; hasAstral: boolean; hasShadow: boolean }) {
  const groups = useMemo(() => {
    const nameByAspect: Record<string, string> = Object.fromEntries(
      aspects.map((a) => [a.slug, a.name] as const)
    );

    const expanded = entries
      .filter((e) => e.qty > 0)
      .map((e) => {
        const c = cards.find((x) => x.id === e.cardId)!;
        return { qty: e.qty, card: c, aspectName: nameByAspect[c.aspect] || c.aspect };
      });

    // Build groups by type in order Holy > Light > Dark > Curse > Astral > Shadow
    const typeOrder: SpellType[] = ["Holy", "Light", "Dark", "Curse", "Astral", "Shadow"];
    const result: { type: SpellType; lines: string[] }[] = [];

    for (const t of typeOrder) {
      const items = expanded
        .filter((x) => x.card.type === t)
        .sort((A, B) => {
          const aspectCmp = A.aspectName.localeCompare(B.aspectName);
          if (aspectCmp !== 0) return aspectCmp; // A→Z
          if (A.card.rank !== B.card.rank) return A.card.rank - B.card.rank; // 1→3
          return A.card.name.localeCompare(B.card.name); // A→Z
        });
      // Always include each type, even if empty, to stabilize layout
      result.push({
        type: t,
        lines: items.map(({ qty, card, aspectName }) => {
          const name = (aspectName || '').replace(/^Aspect of\s+/i, '');
          const tag = PARALLEL_CARD_IDS.has(card.id) ? ' (Parallel)' : '';
          const costLabel = (card.type as any) === 'Travel' ? 'MP' : 'INK';
          return `(${costLabel}: ${card.rank}) {${name}} ${card.name}${tag} —\u00A0x${qty}`;
        }),
      });
    }

    return result;
  }, [entries]);

  return (
    <div className="rounded-xl p-3 text-sm font-mono text-left bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100">
      {(() => {
        // Helper to fetch lines for a given type
        const byType: Record<SpellType, string[]> = {
          Holy: [], Light: [], Dark: [], Curse: [], Astral: [], Shadow: [], Travel: [], Info: [],
        };
        for (const g of groups) byType[g.type] = g.lines;

        const renderCol = (label: SpellType, preBreaks: number = 0) => (
          <div>
            {preBreaks > 0 && (
              <>
                {Array.from({ length: preBreaks }).map((_, i) => (
                  <br key={`pre-${label}-${i}`} />
                ))}
              </>
            )}
            <div className="font-bold underline mb-2 text-center" style={{ fontSize: 'calc(1em + 2pt)' }}>
              [{label}]
            </div>
            <div className="space-y-1 text-center">
              {byType[label].length === 0 ? (
                <div className="text-slate-400">&nbsp;</div>
              ) : (
                byType[label].map((line, i) => <div key={`${label}-${i}`}>{line}</div>)
              )}
            </div>
          </div>
        );

        return (
          <div className="grid grid-cols-13 gap-6">
            {/* Row 1: spacer · HOLY(3) · spacer · LIGHT(3) · spacer · DARK(3) · spacer */}
            <div />
            <div className="col-span-3">{renderCol('Holy')}</div>
            <div />
            <div className="col-span-3">{renderCol('Light')}</div>
            <div />
            <div className="col-span-3">{renderCol('Dark')}</div>
            <div />

            {/* Row 2 aligned: spacer · (Astral under Holy, if unlocked) · spacer · placeholder under Light · spacer · (Shadow under Dark, if unlocked) · spacer */}
            <div />
            <div className="col-span-3">{hasAstral ? renderCol('Astral', 2) : null}</div>
            <div />
            <div className="col-span-3" />
            <div />
            <div className="col-span-3">{hasShadow ? renderCol('Shadow', 2) : null}</div>
            <div />
          </div>
        );
      })()}
    </div>
  );
}

/** ------------------------
 * Main App
 * ---------------------- */
export default function App() {
  const env = (import.meta as any)?.env ?? {};
  const isDev = env.MODE ? env.MODE !== 'production' : Boolean(env?.DEV);
  // Data from CSVs
  const [aspects, setAspects] = useState<Aspect[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [prebounds, setPrebounds] = useState<PreboundGrimoire[]>([]);
  const [codes, setCodes] = useState<Record<string,string>>({});
  const [codeHashes, setCodeHashes] = useState<Record<string,string>>({});
  const [showDecks, setShowDecks] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareFeedback, setShareFeedback] = useState<ShareFeedback | null>(null);
  const [shareCodeInput, setShareCodeInput] = useState('');
  const [shareCodeError, setShareCodeError] = useState<string | null>(null);
  const shareCodeInputRef = useRef<HTMLInputElement | null>(null);
  const [loadBusy, setLoadBusy] = useState(false);
  const [deckName, setDeckName] = useState<string>("");
  const [decksTick, setDecksTick] = useState(0); // bump to refresh decks list
  const [decks, setDecks] = useState<SavedDeck[]>([]);
  // Hidden admin panel
  const [showAdmin, setShowAdmin] = useState(false);
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [adminSelected, setAdminSelected] = useState<Record<string, boolean>>({});
  const [adminDuration, setAdminDuration] = useState<number>(60);
  const [adminUnit, setAdminUnit] = useState<'minutes'|'hours'|'days'>('minutes');
  const [adminCode, setAdminCode] = useState<string>('');
  const [adminPwError, setAdminPwError] = useState<string | null>(null);
  // Admin: Pre-Bound Grimoire editor state
  const [preboundForm, setPreboundForm] = useState<PreboundGrimoire>({ id: '', name: '', description: '', aspects: [], spellCards: [], recommended: false, loreTagline: '' });
  const [preboundEditId, setPreboundEditId] = useState<string | null>(null);
  const [preboundsBaseIds, setPreboundsBaseIds] = useState<string[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [sectionExpanded, setSectionExpanded] = useState<Record<CollapsibleSectionId, boolean>>({
    basics: true,
    dark: true,
    special: true,
  });
  const [modePanelOpen, setModePanelOpen] = useState(true);
  // Suppress auto-open when user explicitly collapses while a message is visible
  const modePanelSuppressAutoOpen = React.useRef(false);
  const [additionalGroupExpanded, setAdditionalGroupExpanded] = useState<Record<string, boolean>>({});
  const [modeAutoLock, setModeAutoLock] = useState<Record<ModeToggleId, boolean>>(() => createDefaultModeAutoLockState());
  // Cloud helper UI state
  const [cloudToast, setCloudToast] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [cloudList, setCloudList] = useState<PreboundGrimoire[] | null>(null);

  // Load CSVs once on mount
  React.useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const data = await loadDataFromCsv();
        if (!mounted) return;
        setAspects(data.aspects ?? []);
        setCards(data.cards ?? []);
        setCodes(data.codes ?? {});
        setCodeHashes(data.codeHashes ?? {});
      } catch (e) {
        console.error('[CSV] Failed to load CSV data', e);
      }
    })();
    return () => { mounted = false; };
  }, []);

  // Auto-dismiss cloud toasts
  useEffect(() => {
    if (!cloudToast) return;
    const t = window.setTimeout(() => setCloudToast(null), 6000);
    return () => window.clearTimeout(t);
  }, [cloudToast]);

  // Load Pre-Bound Grimoires (JSON) and merge with local admin overrides if any
  React.useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        async function loadFromAws(): Promise<PreboundGrimoire[] | null> {
          const list = await listCloudGrimoires();
          if (list && list.length >= 0) return list;
          // Legacy fallback: code-indexed
          const codeFromEnv = (((import.meta as any)?.env?.VITE_PREBOUNDS_CODE) || '').toString().trim();
          const codeFromLocal = (typeof localStorage !== 'undefined') ? (localStorage.getItem('wkw.prebounds.code') || '').trim() : '';
          const code = codeFromEnv || codeFromLocal;
          if (!code) return null;
          const payload = await fetchDeckFromShareApi(code);
          const legacy = (payload && payload.m && (payload as any).m.__pbg) || null;
          return Array.isArray(legacy) ? (legacy as PreboundGrimoire[]) : null;
        }

        const url = new URL('./assets/data/prebound.json', import.meta.url).href;
        const res = await fetch(url);
        const baseList: any = res.ok ? await res.json() : [];
        const arr = Array.isArray(baseList) ? baseList : [];

        const aws = await loadFromAws();

        const localRaw = (typeof localStorage !== 'undefined') ? localStorage.getItem('wkw.prebounds.local') : null;
        let localArr: PreboundGrimoire[] = [];
        try { localArr = localRaw ? JSON.parse(localRaw) : []; } catch { localArr = []; }

        if (mounted) {
          if (aws && Array.isArray(aws)) {
            // When Cloud list is present, treat it as authoritative
            setPrebounds(aws);
            setPreboundsBaseIds([]);
          } else {
            // Otherwise merge local overrides over base file
            const byId: Record<string, PreboundGrimoire> = {};
            for (const g of arr as PreboundGrimoire[]) { if (g && g.id) byId[g.id] = g; }
            for (const g of localArr) { if (g && g.id) byId[g.id] = g; }
            setPrebounds(Object.values(byId));
            setPreboundsBaseIds((arr as PreboundGrimoire[]).map(x=>x.id));
          }
        }
      } catch (e) {
        console.error('[Prebounds] Failed to load', e);
        if (mounted) setPrebounds([]);
      }
    })();
    return () => { mounted = false; };
  }, []);

  // Deck persistence and sharing
  type SavedDeck = {
    version: 1;
    name: string;
    rankCap: number;
    basicsSelected: string[];
    chosenAspects: string[];
    entries: Record<string, number>;
    modes?: Partial<Record<ModeToggleId, boolean>>;
    lostBasic?: boolean;
  };
  const LS_KEY = 'wkw.decks.v1';

  function currentDeckPayload(name: string): SavedDeck {
    const activeModes = MODE_TOGGLE_IDS.reduce((acc, id) => {
      if (modeToggles[id]) acc[id] = true;
      return acc;
    }, {} as Partial<Record<ModeToggleId, boolean>>);
    const modes = Object.keys(activeModes).length > 0 ? activeModes : undefined;
    return { version: 1, name, rankCap, basicsSelected, chosenAspects, entries, modes };
  }
  function listDecks(): SavedDeck[] { try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; } }
  function refreshDecks() { setDecks(listDecks()); }
  function saveDeck(name: string) {
    const list = listDecks();
    const idx = list.findIndex(d => d.name === name);
    const payload = currentDeckPayload(name);
    if (idx >= 0) list[idx] = payload; else list.push(payload);
    localStorage.setItem(LS_KEY, JSON.stringify(list));
    setDeckName(name);
    setDecksTick((t) => t + 1);
    refreshDecks();
  }
  function loadDeck(name: string) {
    const d = listDecks().find(x => x.name === name);
    if (!d) return false;
    loadSavedDeck(d);
    setDecksTick((t) => t + 1);
    refreshDecks();
    return true;
  }
  function renameDeck(oldName: string, newName: string) {
    const list = listDecks();
    const idx = list.findIndex(d => d.name === oldName);
    if (idx < 0) return;
    list[idx].name = newName;
    localStorage.setItem(LS_KEY, JSON.stringify(list));
    if (deckName === oldName) setDeckName(newName);
    setDecksTick((t) => t + 1);
    refreshDecks();
  }
  function deleteDeck(name: string) {
    const list = listDecks().filter(d => d.name !== name);
    localStorage.setItem(LS_KEY, JSON.stringify(list));
    if (deckName === name) setDeckName('');
    setDecksTick((t) => t + 1);
    refreshDecks();
  }

  useEffect(() => {
    if (showDecks) refreshDecks();
  }, [showDecks, decksTick]);

  function toBase64Url(s: string) { const b = window.btoa(unescape(encodeURIComponent(s))); return b.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,''); }
  function fromBase64Url(b64: string) { const b=b64.replace(/-/g,'+').replace(/_/g,'/'); const p=b+'==='.slice((b.length+3)%4); const s=window.atob(p); return decodeURIComponent(escape(s)); }

  type CompactDeckPayload = {
    v: 1;
    n: string;
    r: number;
    b: string[];
    c: string[];
    e: Record<string, number>;
    m?: Partial<Record<ModeToggleId, boolean>>;
    lb?: boolean;
  };

  const SHARE_API_BASE = ((import.meta as any)?.env?.VITE_SHARE_API_BASE || '').toString().trim().replace(/\/+$/, '');
  const SHARE_API_ENABLED = SHARE_API_BASE.length > 0;
  const ENV_GRIMOIRE_ADMIN_BEARER = (((import.meta as any)?.env?.VITE_GRIMOIRE_ADMIN_BEARER)||'').toString().trim();
  const ENV_GRIMOIRE_ADMIN_API_KEY = (((import.meta as any)?.env?.VITE_GRIMOIRE_ADMIN_API_KEY)||'').toString().trim();
  // Runtime (paste-in) admin creds kept in state/sessionStorage
  const [rtAdminBearer, setRtAdminBearer] = useState<string>(() => {
    try { return sessionStorage.getItem('wkw.pbg.bearer') || ''; } catch { return ''; }
  });
  const [rtAdminApiKey, setRtAdminApiKey] = useState<string>(() => {
    try { return sessionStorage.getItem('wkw.pbg.xkey') || ''; } catch { return ''; }
  });
  const SHARE_CODE_PATTERN = /^[A-Z2-9]{3}-[A-Z2-9]{3}-[A-Z2-9]{3}$/;
  const SHARE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  type ShareFeedback = { code: string; mode: 'api' | 'legacy'; copied: boolean };

  function randomCodeChar(): string {
    const idx = Math.floor(Math.random() * SHARE_CODE_ALPHABET.length);
    return SHARE_CODE_ALPHABET[idx];
  }

  function randomCodeSegment(length: number): string {
    let out = '';
    for (let i = 0; i < length; i++) out += randomCodeChar();
    return out;
  }

  function generateShareCode(): string {
    return `${randomCodeSegment(3)}-${randomCodeSegment(3)}-${randomCodeSegment(3)}`;
  }

  function makeCompactPayload(name: string): CompactDeckPayload {
    const saved = currentDeckPayload(name);
    return {
      v: 1,
      n: saved.name,
      r: saved.rankCap,
      b: saved.basicsSelected,
      c: saved.chosenAspects,
      e: saved.entries,
      m: saved.modes,
      lb: saved.lostBasic,
    };
  }

  function makeLegacyShareCode(compact: CompactDeckPayload): string {
    return toBase64Url(JSON.stringify(compact));
  }

  function shareApiUrl(path: string): string {
    if (!SHARE_API_ENABLED) return '';
    if (path.startsWith('/')) path = path.slice(1);
    return `${SHARE_API_BASE}/${path}`;
  }

  // Grimoire (slug) API helpers
  async function listCloudGrimoires(): Promise<PreboundGrimoire[] | null> {
    if (!SHARE_API_ENABLED) return null;
    try {
      const r = await fetch(shareApiUrl('grimoires'));
      if (!r.ok) return null;
      const j = await r.json();
      const items = Array.isArray(j?.items) ? (j.items as any[]) : [];
      return items as PreboundGrimoire[];
    } catch { return null; }
  }
  function grimoireAuthHeaders(): Record<string,string> {
    const h: Record<string,string> = { 'Content-Type':'application/json' };
    const bearer = (rtAdminBearer || ENV_GRIMOIRE_ADMIN_BEARER).trim();
    const xkey = (rtAdminApiKey || ENV_GRIMOIRE_ADMIN_API_KEY).trim();
    if (bearer) h['Authorization'] = `Bearer ${bearer}`;
    if (xkey) h['x-api-key'] = xkey;
    return h;
  }
  async function putCloudGrimoire(g: PreboundGrimoire): Promise<boolean> {
    if (!SHARE_API_ENABLED) return false;
    try {
      const r = await fetch(shareApiUrl(`grimoires/${encodeURIComponent(g.id)}`), {
        method: 'PUT',
        headers: grimoireAuthHeaders(),
        body: JSON.stringify({ payload: g }),
      });
      return r.ok;
    } catch { return false; }
  }
  async function deleteCloudGrimoire(id: string): Promise<boolean> {
    if (!SHARE_API_ENABLED) return false;
    try {
      const r = await fetch(shareApiUrl(`grimoires/${encodeURIComponent(id)}`), {
        method: 'DELETE',
        headers: grimoireAuthHeaders(),
      });
      return r.ok;
    } catch { return false; }
  }

  async function saveDeckToShareApi(compact: CompactDeckPayload): Promise<string | null> {
    if (!SHARE_API_ENABLED) return null;

    try {
      const response = await fetch(shareApiUrl('decks'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: compact, code: generateShareCode() }),
      });
      if (!response.ok) {
        console.warn('[ShareCode][API] Save failed', response.status, await response.text());
        return null;
      }
      const json = await response.json();
      const code = (json?.code || '').toString().trim();
      return code || null;
    } catch (error) {
      console.warn('[ShareCode][API] Save error', error);
      return null;
    }
  }

  // Store an Admin unlock token in the same AWS share API by
  // embedding it in a valid deck-shaped object (passes backend validation),
  // then returning the server-generated code (AAA-BBB-CCC).
  async function saveAdminCodeToShareApi(token: string): Promise<string | null> {
    if (!SHARE_API_ENABLED) return null;
    try {
      const wrapper = {
        v: 1,
        n: 'admin',
        r: 1,
        b: [] as string[],
        c: [] as string[],
        e: {},
        m: { __ua: token },
      } as any;
      const response = await fetch(shareApiUrl('decks'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: wrapper, code: generateShareCode() }),
      });
      if (!response.ok) return null;
      const json = await response.json();
      const code = (json?.code || '').toString().trim();
      return code || null;
    } catch {
      return null;
    }
  }

  async function fetchDeckFromShareApi(code: string): Promise<CompactDeckPayload | null> {
    if (!SHARE_API_ENABLED) return null;
    try {
      const response = await fetch(shareApiUrl(`decks/${encodeURIComponent(code)}`));
      if (!response.ok) {
        return null;
      }
      const json = await response.json();
      const payload = json?.payload ?? json;
      if (!payload || payload.v !== 1) return null;
      return payload as CompactDeckPayload;
    } catch (error) {
      console.warn('[ShareCode][API] Fetch error', error);
      return null;
    }
  }

  function savedDeckFromCompact(compact: CompactDeckPayload): SavedDeck {
    return {
      version: 1,
      name: compact.n || 'Shared Grimoire',
      rankCap: compact.r || 1,
      basicsSelected: compact.b || [],
      chosenAspects: compact.c || [],
      entries: compact.e || {},
      modes: compact.m,
      lostBasic: compact.lb,
    };
  }

  function loadSavedDeck(d: SavedDeck) {
    const basics = d.basicsSelected || [];
    const chosen = d.chosenAspects || [];
    const { modes: inferredModes } = deriveModesFromDeck(d);
    const needed = new Set<string>([...basics, ...chosen]);

    setRankCap(d.rankCap);
    setBasicsSelected(basics);
    setChosenAspects(chosen);
    setEntries(d.entries || {});
    setDeckName(d.name || '');
    setUnlocks(prev => Array.from(new Set([...prev, ...needed])));
    setModeToggles(inferredModes);
    setModeAutoLock(createDefaultModeAutoLockState());
    setModeMessage(null);
  }

  async function createShareCode(name: string): Promise<{ code: string; mode: 'api' | 'legacy' }> {
    const compact = makeCompactPayload(name || deckName || 'My Grimoire');
    if (SHARE_API_ENABLED) {
      const cloudCode = await saveDeckToShareApi(compact);
      if (cloudCode) {
        return { code: cloudCode, mode: 'api' };
      }
    }
    return { code: makeLegacyShareCode(compact), mode: 'legacy' };
  }

  // Create an Admin code using the same AWS code-generation flow as share codes.
  // We wrap the signed admin token in a minimal V1 payload under `m.__ua` so
  // it passes backend validation. If the API is unavailable, fall back to
  // the local A-<payload>.<sig> format.
  async function createAdminCode(slugs: string[], exp: number): Promise<{ code: string; mode: 'api' | 'legacy' }> {
    const payload = JSON.stringify({ a: slugs, exp });
    const b64 = toBase64Url(payload);
    const salt = (function(){ const a='e9572d5cca2216667bf710327e0812ec438ba0f0828eda1d7e'; const b='b1d536515496af'; return a+b; })();
    const sig = (await sha256Hex(b64 + ':' + salt)).slice(0,12).toUpperCase();
    const token = `${b64}.${sig}`;

    if (SHARE_API_ENABLED) {
      const adminCompact: any = { v:1, n:'admin', r:1, b:[], c:[], e:{}, m:{ __ua: token } };
      const cloudCode = await saveDeckToShareApi(adminCompact);
      if (cloudCode) return { code: cloudCode, mode: 'api' };
    }
    return { code: `A-${token}`, mode: 'legacy' };
  }

  async function applyShareCode(code: string): Promise<boolean> {
    const trimmed = code.trim();
    if (!trimmed) return false;

    if (SHARE_API_ENABLED && SHARE_CODE_PATTERN.test(trimmed)) {
      const compact = await fetchDeckFromShareApi(trimmed);
      if (!compact) return false;
      loadSavedDeck(savedDeckFromCompact(compact));
      return true;
    }

    try {
      const raw = JSON.parse(fromBase64Url(trimmed));
      if (!raw || raw.v !== 1) return false;
      loadSavedDeck(savedDeckFromCompact(raw as CompactDeckPayload));
      return true;
    } catch {
      return false;
    }
  }

  const copyCodeToClipboard = useCallback(async (code: string): Promise<boolean> => {
    if (typeof navigator === 'undefined') return false;
    const api = navigator.clipboard;
    if (!api || typeof api.writeText !== 'function') {
      return false;
    }
    try {
      await api.writeText(code);
      return true;
    } catch (error) {
      console.warn('[ShareCode] Clipboard copy failed', error);
      return false;
    }
  }, []);

  const handleCopyShareCode = async () => {
    if (shareBusy) return;
    const preferredName = deckName?.trim() ? deckName.trim() : 'My Grimoire';
    setShareBusy(true);
    try {
      const { code, mode } = await createShareCode(preferredName);
      const copied = await copyCodeToClipboard(code);
      setShareFeedback({ code, mode, copied });
    } catch (error) {
      console.error('[ShareCode] Failed to copy', error);
      alert('Unable to create a share code at this time.');
    } finally {
      setShareBusy(false);
    }
  };

  const retryShareCopy = useCallback(async () => {
    if (!shareFeedback) return;
    const ok = await copyCodeToClipboard(shareFeedback.code);
    if (ok) {
      setShareFeedback(prev => (prev ? { ...prev, copied: true } : prev));
    }
  }, [copyCodeToClipboard, shareFeedback]);

  useEffect(() => {
    if (!shareFeedback || !shareFeedback.copied) return;
    const timeout = window.setTimeout(() => setShareFeedback(null), 12000);
    return () => window.clearTimeout(timeout);
  }, [shareFeedback]);

  const submitShareCode = useCallback(async () => {
    if (loadBusy) return;
    const code = shareCodeInput.trim();
    if (!code) {
      setShareCodeError('Enter a share code to load.');
      shareCodeInputRef.current?.focus();
      return;
    }
    setLoadBusy(true);
    setShareCodeError(null);
    try {
      const ok = await applyShareCode(code);
      if (!ok) {
        setShareCodeError('Invalid or unavailable share code.');
        shareCodeInputRef.current?.focus();
        return;
      }
      setShareCodeInput('');
    } finally {
      setLoadBusy(false);
    }
  }, [applyShareCode, loadBusy, shareCodeInput]);

  const handleLoadShareCode = useCallback(() => {
    submitShareCode();
  }, [submitShareCode]);

  async function toDataUrlFromUrl(url: string, mimeFallback: string): Promise<string> {
    const res = await fetch(url, { credentials: 'same-origin', cache: 'force-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const mime = (blob && blob.type && blob.type !== 'application/octet-stream') ? blob.type : mimeFallback;
    const fixed = (blob && blob.type && blob.type !== 'application/octet-stream') ? blob : new Blob([blob], { type: mime });
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error('readAsDataURL failed'));
      reader.onload = () => resolve(String(reader.result || ''));
      reader.readAsDataURL(fixed);
    });
  }

  async function dataUrlForCard(id: string): Promise<string> {
    const raw = CARD_IMAGE_URLS[id];
    if (!raw) return '';
    const mime = (CARD_IMAGE_MIME as any)?.[id] || 'image/png';
    try { return await toDataUrlFromUrl(raw, mime); } catch { return ''; }
  }
  async function exportPdf(name?: string) {
    const deckTitle = name || deckName || 'My Grimoire';
    const nameByAspect: Record<string, string> = Object.fromEntries(aspects.map(a => [a.slug, a.name] as const));
    const expanded = Object.entries(entries)
      .filter(([_, q]) => (q || 0) > 0)
      .map(([id, qty]) => {
        const c = cards.find(x => x.id === id);
        if (!c || isReferenceCard(c)) return null as any;
        return { qty: qty || 0, card: c, aspectName: nameByAspect[c.aspect] || c.aspect };
      })
      .filter(Boolean) as { qty: number; card: Card; aspectName: string }[];
    const types: SpellType[] = ['Holy','Light','Dark','Curse','Astral','Shadow'];
    const enabled = (t: SpellType) => (t==='Astral'? hasAstral : t==='Shadow'? hasShadow : true);
    const win = window.open('', '_blank'); if (!win) return;
    const css = `
      body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111;padding:20px}
      h1{font-size:22px;margin:0 0 10px}
      .grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
      .section{border:1px solid #ddd;border-radius:10px;padding:10px;break-inside:avoid}
      .section h2{margin:0 0 8px;font-size:16px;text-align:center}
      .cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
      .card{border:1px solid #e5e7eb;border-radius:8px;padding:6px;text-align:center}
      .img{width:100%;height:100px;object-fit:contain;border-radius:4px}
      .qty{font-size:12px;margin-top:4px}
      @media print{.grid{grid-template-columns:repeat(3,minmax(0,1fr))} .cards{grid-template-columns:repeat(3,minmax(0,1fr))}}
    `;
    const sections = await Promise.all(types.filter(enabled).map(async (t) => {
      const items = expanded.filter(x => x.card.type === t).sort((A,B)=>{
        if (A.card.rank !== B.card.rank) return A.card.rank - B.card.rank;
        return A.card.name.localeCompare(B.card.name);
      });
      if (items.length === 0) return '';
      const cells = await Promise.all(items.map(async ({qty, card}) => {
        const src = await dataUrlForCard(card.id);
        return `<div class="card"><img class="img" src="${src}" alt="${card.name}"><div class="qty">x${qty}</div></div>`;
      }));
      return `<div class="section"><h2>[${t}]</h2><div class="cards">${cells.join('')}</div></div>`;
    }));
    const sectionsHtml = sections.join('');
    win.document.write(`<html><head><title>${deckTitle} — Grimoire</title><style>${css}</style></head><body><h1>${deckTitle}</h1><div class="grid">${sectionsHtml}</div></body></html>`);
    win.document.close(); win.focus(); win.print();
  }
  // Unlocks (basics visible by default)
  const [unlocks, setUnlocks] = useState<string[]>([FOCUS_SLUG, STUDY_SLUG]);
  const [showUnlock, setShowUnlock] = useState(false);
  const [modeToggles, setModeToggles] = useState<Record<ModeToggleId, boolean>>(() => createDefaultModeState());
  const [modeMessage, setModeMessage] = useState<ModeMessage | null>(null);
  const isModeActive = React.useCallback((id: ModeToggleId) => Boolean(modeToggles[id]), [modeToggles]);

  // Selection
  const [basicsSelected, setBasicsSelected] = useState<string[]>([FOCUS_SLUG, STUDY_SLUG]); // Grimoire starts with Focus + Study
  const [chosenAspects, setChosenAspects] = useState<string[]>([]); // Non-basics

  // Entries: cardId → qty
  const [entries, setEntries] = useState<Record<string, number>>({});
  // Preload images for newly chosen aspects
  const prevChosenRef = useRef<string[]>([]);
  useEffect(() => {
    const prev = new Set(prevChosenRef.current);
    const next = new Set(chosenAspects);
    const added: string[] = [];
    for (const s of next) if (!prev.has(s)) added.push(s);
    if (added.length > 0) {
      const byAspect = new Map<string, string[]>(); // aspect -> card ids
      for (const c of cards) {
        if (added.includes(c.aspect)) {
          const arr = byAspect.get(c.aspect) || [];
          arr.push(c.id);
          byAspect.set(c.aspect, arr);
        }
      }
      for (const ids of byAspect.values()) {
        for (const id of ids) prefetchCardImage(id, 3);
      }
    }
    prevChosenRef.current = chosenAspects.slice();
  }, [chosenAspects, cards]);
  const [previewCard, setPreviewCard] = useState<Card | null>(null);
  const [capAttempt, setCapAttempt] = useState<SpellType | null>(null);
  const capTimer = React.useRef<number | null>(null);
  const showCapAttempt = (t: SpellType) => {
    if (capTimer.current) window.clearTimeout(capTimer.current!);
    setCapAttempt(t);
    capTimer.current = window.setTimeout(() => setCapAttempt(null), 1500);
  };
  const [overrideAll, setOverrideAll] = useState(false);
  // Rank filter: show only cards with rank <= cap
  const [rankCap, setRankCap] = useState<number>(99);

  // No persistence — removed cookies/localStorage

  // Reset all persisted state and in-memory selections
  function resetAll() {
    if (typeof window !== 'undefined' && !window.confirm('Reset unlocks, selections, and grimoire?')) return;
    setUnlocks([FOCUS_SLUG, STUDY_SLUG]);
    setBasicsSelected([STUDY_SLUG]);
    setChosenAspects([]);
    setEntries({});
    setModeToggles(createDefaultModeState());
    setModeAutoLock(createDefaultModeAutoLockState());
    setModeMessage(null);
  }
  React.useEffect(() => {
    if (previewCard) {
      const url = resolveCardImageUrl(previewCard.id);
      console.log('[App.preview-open]', { id: previewCard.id, url });
    } else {
      console.log('[App.preview-close]');
    }
  }, [previewCard]);

  const isBasicAspect = React.useCallback((slug: string) => {
    const a = aspects.find(x => x.slug === slug);
    return Boolean(a?.isBasic);
  }, [aspects]);

  // Derived
  const nameByAspect = useMemo(
    () => Object.fromEntries(aspects.map((a) => [a.slug, a.name] as const)),
    [aspects]
  );
  const aspectsBySlug = useMemo(
    () => Object.fromEntries(aspects.map((a) => [a.slug, a] as const)),
    [aspects]
  );
  const unlocksSet = useMemo(() => {
    if (overrideAll) {
      return new Set(aspects.map((a) => a.slug));
    }
    const basics = aspects.filter((a) => isBasicAspect(a.slug)).map((a) => a.slug);
    return new Set(unlocks.concat(basics));
  }, [aspects, isBasicAspect, overrideAll, unlocks]);

  const fragmentsModeActive = isModeActive('fragments_mode');
  const starlightModeActive = overrideAll || (isModeActive('starlight_addition') && unlocksSet.has('starlight'));
  const shadowModeActive = overrideAll || (isModeActive('shadow_addition') && unlocksSet.has('shadows'));
  const parallelModeActive = overrideAll || isModeActive('parallel_dimension');

  const aspectAllowedByModes = React.useCallback((slug: string) => {
    if (overrideAll) return true;
    if (slug === 'starlight') return starlightModeActive;
    if (slug === 'shadows') return shadowModeActive;
    if (slug === 'madness' || slug === 'energy') return parallelModeActive;
    return true;
  }, [overrideAll, parallelModeActive, shadowModeActive, starlightModeActive]);

  const selectedAspectSlugs = useMemo(() => {
    if (overrideAll) {
      return aspects.map((a) => a.slug);
    }
    return [...basicsSelected, ...chosenAspects]
      .filter((slug) => aspectAllowedByModes(slug));
  }, [aspectAllowedByModes, aspects, basicsSelected, chosenAspects, overrideAll]);

  // Keep Study always present in the Grimoire
  useEffect(() => {
    if (!basicsSelected.includes(STUDY_SLUG)) {
      setBasicsSelected((prev) => Array.from(new Set([...prev, STUDY_SLUG])));
    }
  }, [basicsSelected]);

  // Keep Focus always present in the Grimoire
  useEffect(() => {
    if (!basicsSelected.includes(FOCUS_SLUG)) {
      setBasicsSelected((prev) => Array.from(new Set([...prev, FOCUS_SLUG])));
    }
  }, [basicsSelected]);

  const modeRequirementHint = React.useCallback((slug: string) => {
    if (overrideAll) return undefined;
    if (!unlocksSet.has(slug)) return undefined;
    if (aspectAllowedByModes(slug)) return undefined;
    const requirement = MODE_REQUIREMENT_BY_ASPECT[slug];
    if (!requirement) return undefined;
    const meta = MODE_TOGGLE_META[requirement.toggle];
    const toggleLabel = meta?.label || requirement.label;
    return `Enable ${toggleLabel} in Game Mode Toggles before selecting this Aspect.`;
  }, [aspectAllowedByModes, overrideAll, unlocksSet]);

  // Min rank per aspect and eligibility (rank cap no longer used)
  const MIN_RANK_BY_ASPECT = useMemo(() => {
    const map: Record<string, number> = {};
    for (const c of cards) {
      const cur = map[c.aspect];
      map[c.aspect] = cur == null ? c.rank : Math.min(cur, c.rank);
    }
    return map;
  }, [cards]);
  const aspectEligible = React.useCallback((slug: string) => {
    const min = MIN_RANK_BY_ASPECT[slug];
    return Number.isFinite(min);
  }, [MIN_RANK_BY_ASPECT]);

  // Derived from data
  const ASPECT_INDEX = useMemo(() => {
    const ordered = aspects.map((a, i) => ({ a, i })).sort((A, B) => {
      const ao = A.a.order; const bo = B.a.order;
      if (ao != null && bo != null) return ao - bo;
      if (ao != null) return -1; if (bo != null) return 1;
      return A.i - B.i;
    });
    return Object.fromEntries(ordered.map((x, i) => [x.a.slug, i] as const));
  }, [aspects]);

  const additionalAspectGrouping = useMemo(() => {
    const sorted = aspects
      .filter((a) => !isBasicAspect(a.slug) && !a.isSpecial && !a.isDark && aspectEligible(a.slug))
      .sort((a, b) => (ASPECT_INDEX[a.slug] ?? 999) - (ASPECT_INDEX[b.slug] ?? 999));

    let lost: Aspect | undefined;
    const remainder: Aspect[] = [];
    for (const aspect of sorted) {
      if (aspect.slug === 'lost') lost = aspect;
      else remainder.push(aspect);
    }

    const groups: Aspect[][] = [];
    for (let i = 0; i < remainder.length; i += 2) {
      groups.push(remainder.slice(i, i + 2));
    }

    return { lost, groups };
  }, [ASPECT_INDEX, aspectEligible, aspects, isBasicAspect]);

  const additionalLostAspect = additionalAspectGrouping.lost;
  const additionalAspectGroups = additionalAspectGrouping.groups;

  const DARK_SLUGS = useMemo(
    () => aspects.filter(a => a.isDark).map(a => a.slug) as ReadonlyArray<string>,
    [aspects]
  );

  const allDarkTrioSelected = overrideAll ? false : (() => {
    const nonSpecial = chosenAspects
      .filter((s) => !aspects.find(a => a.slug === s)?.isSpecial)
      .filter((s) => aspectEligible(s) && aspectAllowedByModes(s));
    if (nonSpecial.length < 3) return false;
    const set = new Set(nonSpecial);
    return (DARK_SLUGS as readonly string[]).every((s) => set.has(s));
  })();
  const darkArtsActive = allDarkTrioSelected;
  const maxNonSpecialAllowed = darkArtsActive ? 3 : 2;

  // Enforce Dark Arts restriction by clearing any [Holy] spells when all three Dark aspects are selected
  useEffect(() => {
    if (!allDarkTrioSelected || overrideAll) return;
    setEntries((prev) => {
      const next = { ...prev } as Record<string, number>;
      let changed = false;
      for (const c of cards) {
        if (c.type === 'Holy' && (next[c.id] || 0) > 0) {
          next[c.id] = 0; changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [allDarkTrioSelected, overrideAll, cards]);

  async function sha256Hex(input: string): Promise<string> {
    const enc = new TextEncoder();
    const data = enc.encode(input);
    const hash = await crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(hash);
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }

  async function redeem(code: string): Promise<{ ok: boolean; unlockedName?: string; status?: 'ok' | 'invalid' | 'used' }> {
    const input = code.trim();
    const key = input.toUpperCase();
    const keyUnderscored = key.replace(/\s+/g, '_');
    // Override toggle only when the entire input matches the override code
    const OVERRIDE_CODE = (import.meta as any).env?.VITE_OVERRIDE_CODE as string | undefined;
    const OVERRIDE_ENABLED = Boolean((import.meta as any).env?.DEV && OVERRIDE_CODE);
    if (OVERRIDE_ENABLED && (key === OVERRIDE_CODE!.toUpperCase() || keyUnderscored === OVERRIDE_CODE!.toUpperCase())) {
      const next = !overrideAll;
      setOverrideAll(next);
      console.log('[Redeem][Override]', { enabled: next });
      return { ok: true, unlockedName: 'Override Mode', status: 'ok' };
    }

    // Support chained codes separated by AND, commas, or semicolons
    const parts = key.split(/\s*(?:,|;|\bAND\b)\s*/i).map(s => s.trim()).filter(Boolean);
    const nextUnlocks = new Set(unlocks);
    const namesUnlocked: string[] = [];
    let anyNew = false, anyUsed = false, anyInvalid = false;

    // Small helpers for Admin codes (signed, expirable)
    function adminSalt(): string {
      const a = 'e9572d5cca2216667bf710327e0812ec438ba0f0828eda1d7e';
      const b = 'b1d536515496af';
      return a + b;
    }
    const signAdminPayload = async (payloadB64: string): Promise<string> => {
      const sig = await sha256Hex(payloadB64 + ':' + adminSalt());
      return sig.slice(0, 12).toUpperCase();
    };

    // Support AWS-issued Admin codes (AAA-BBB-CCC) that carry a token
    // stored server-side under payload.m.__ua.
    if (SHARE_API_ENABLED && SHARE_CODE_PATTERN.test(key)) {
      try {
        const fetched = await fetchDeckFromShareApi(key);
        const token = (fetched as any)?.m?.__ua as string | undefined;
        if (token && typeof token === 'string') {
          const [payloadB64, sig] = token.split('.') as [string, string];
          const salt = (function(){ const a='e9572d5cca2216667bf710327e0812ec438ba0f0828eda1d7e'; const b='b1d536515496af'; return a+b; })();
          const expected = (await sha256Hex(payloadB64 + ':' + salt)).slice(0,12).toUpperCase();
          if (expected === (sig || '').toUpperCase()) {
            const raw = fromBase64Url(payloadB64);
            const obj = JSON.parse(raw || '{}') as { a?: string[]; exp?: number };
            if (obj && Array.isArray(obj.a) && typeof obj.exp === 'number' && Date.now() <= obj.exp) {
              const valid = obj.a.filter(s => aspects.some(a => a.slug === s));
              const unlockedNames = valid.map(slug => aspects.find(a=>a.slug===slug)?.name || slug);
              // Merge into unlocks using functional update to avoid stale closures
              setUnlocks(prev => Array.from(new Set([...prev, ...valid])));
              return { ok: true, unlockedName: unlockedNames.join('\n'), status: 'ok' };
            }
          }
        }
      } catch { /* fall through to normal handling */ }
    }

    for (const p of (parts.length ? parts : [key])) {
      const pUnderscored = p.replace(/\s+/g, '_');
      // Admin expiring multi-aspect code: A-<base64url payload>.<sig>
      const m = p.match(/^A-([A-Za-z0-9_-]+)\.([A-Fa-f0-9]{6,})$/);
      if (m) {
        try {
          const payloadB64 = m[1];
          const sig = m[2];
          const expected = await signAdminPayload(payloadB64);
          if (expected.toUpperCase() !== sig.toUpperCase()) { anyInvalid = true; continue; }
          const raw = fromBase64Url(payloadB64);
          const obj = JSON.parse(raw || '{}') as { a?: string[]; exp?: number };
          if (!obj || !Array.isArray(obj.a) || typeof obj.exp !== 'number') { anyInvalid = true; continue; }
          if (Date.now() > obj.exp) { anyInvalid = true; continue; }
          const valid = obj.a.filter(s => aspects.some(a => a.slug === s));
          const unlockedNames = valid.map(slug => aspects.find(a=>a.slug===slug)?.name || slug);
          const before = nextUnlocks.size;
          for (const s of valid) nextUnlocks.add(s);
          if (nextUnlocks.size > before) { namesUnlocked.push(...unlockedNames); anyNew = true; } else anyUsed = true;
          continue;
        } catch {
          anyInvalid = true; continue;
        }
      }
      let slug = codes[p];
      if (!slug && codeHashes && Object.keys(codeHashes).length > 0) {
        try {
          const digest = await sha256Hex(p);
          slug = codeHashes[digest];
        } catch (err) {
          console.warn('[Codes] Failed to hash code for lookup', err);
        }
      }
      if (!slug) { anyInvalid = true; continue; }
      const slugStr = String(slug).trim();
      const slugParts = slugStr.split(/[|,+]/).map(s => s.trim()).filter(Boolean);
      const toApply = slugParts.length > 1 ? slugParts : [slugStr];
      for (const s of toApply) {
        if (s === '*') {
          const before = nextUnlocks.size;
          for (const a of aspects) nextUnlocks.add(a.slug);
          if (nextUnlocks.size > before) { namesUnlocked.push('All Aspects'); anyNew = true; } else anyUsed = true;
          continue;
        }
        if (String(s).toLowerCase() === '#dark_all') {
          const darks = aspects.filter(a => a.isDark).map(a => a.slug);
          const before = nextUnlocks.size;
          for (const d of darks) nextUnlocks.add(d);
          if (nextUnlocks.size > before) { namesUnlocked.push('Dark Arts'); anyNew = true; } else anyUsed = true;
          continue;
        }
        if (!nextUnlocks.has(s)) {
          nextUnlocks.add(s);
          const name = aspects.find(a => a.slug === s)?.name || s;
          namesUnlocked.push(name);
          anyNew = true;
        } else {
          anyUsed = true;
        }
      }
    }

    setUnlocks(Array.from(nextUnlocks));
    if (anyNew) {
      const label = namesUnlocked.join('\n');
      return { ok: true, unlockedName: label, status: 'ok' };
    }
    if (anyUsed && !anyInvalid) return { ok: false, status: 'used' };
    return { ok: false, status: 'invalid' };
  }

  // When an aspect is deselected, remove all cards from that aspect
  function clearAspectEntries(slug: string) {
    setEntries((prev) => {
      const next = { ...prev } as Record<string, number>;
      for (const c of cards) {
        if (c.aspect === slug) next[c.id] = 0;
      }
      return next;
    });
  }

  function toggleBasic(slug: string) {
    if (slug === FOCUS_SLUG) return; // Focus is fixed in the Grimoire
    if (slug === STUDY_SLUG) return; // Study is always present in the Grimoire
    if (basicsSelected.includes(slug)) {
      setBasicsSelected((prev) => prev.filter((s) => s !== slug));
      clearAspectEntries(slug);
    } else {
      setBasicsSelected((prev) => [...prev, slug]);
    }
  }

  function toggleAspect(slug: string) {
    if (overrideAll) { return; }
    const aspect = aspects.find((a) => a.slug === slug);
    if (!aspect) return;
    if (!aspectAllowedByModes(slug)) {
      return;
    }

    // Basics: toggle freely, don't count toward limit
    if (isBasicAspect(slug)) {
      toggleBasic(slug);
      return;
    }

    const exists = chosenAspects.includes(slug);

    if (exists) {
      setChosenAspects(chosenAspects.filter((s) => s !== slug));
      clearAspectEntries(slug);
      return;
    }

    // Specials do not count toward limits
    if (aspect.isSpecial) {
      setChosenAspects([...chosenAspects, slug]);
      return;
    }

    const nonSpecialSelected = chosenAspects
      .filter((s) => !aspects.find(a => a.slug === s)?.isSpecial)
      .filter((s) => aspectEligible(s) && aspectAllowedByModes(s));
    const nextSet = new Set([...nonSpecialSelected, slug]);
    const nextCount = nextSet.size;
    const darkTrioSlugs = DARK_SLUGS as readonly string[];
    const nextIsExactDarkTrio = darkTrioSlugs.every((s) => nextSet.has(s)) && nextSet.size === darkTrioSlugs.length;
    if (nextCount > maxNonSpecialAllowed && !nextIsExactDarkTrio) return;
    setChosenAspects(Array.from(new Set([...chosenAspects, slug])));

    // total >= 3 → already at max; do nothing
  }

  const toggleSection = useCallback((id: CollapsibleSectionId) => {
    setSectionExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const toggleAdditionalGroup = useCallback((key: string) => {
    setAdditionalGroupExpanded((prev) => ({ ...prev, [key]: !(prev[key] ?? false) }));
  }, []);

  const effectiveMaxCopies = useMemo(() => {
    const map: Record<string, number> = {};
    for (const c of cards) {
      let max = c.maxCopies;
      if (fragmentsModeActive && c.rank > 2) {
        max = Math.min(max, 1);
      }
      map[c.id] = max;
    }
    return map;
  }, [cards, fragmentsModeActive]);

  const availableCards = useMemo(() => {
    return cards
      .filter((c) => selectedAspectSlugs.includes(c.aspect))
      .filter((c) => parallelModeActive || !PARALLEL_CARD_IDS.has(c.id))
      .map((c) => ({ ...c, maxCopies: effectiveMaxCopies[c.id] ?? c.maxCopies }))
      .sort((a, b) => {
        // Aspect order fixed at top of list
        const ai = ASPECT_INDEX[a.aspect] ?? 999;
        const bi = ASPECT_INDEX[b.aspect] ?? 999;
        if (ai !== bi) return ai - bi; // Focus → Study → Legend → ...

      // Within aspect: Type desc (Holy > Light > Dark)
      const ta = TYPE_ORDER[a.type] ?? 0;
      const tb = TYPE_ORDER[b.type] ?? 0;
      if (tb !== ta) return tb - ta;

      // Rank desc
      if (b.rank !== a.rank) return b.rank - a.rank;

      // Name desc
      return b.name.localeCompare(a.name);
    });
  }, [ASPECT_INDEX, cards, effectiveMaxCopies, parallelModeActive, selectedAspectSlugs]);

  const groupedByAspect = useMemo(() => {
    const map: Record<string, Card[]> = {};
    for (const c of availableCards) (map[c.aspect] ||= []).push(c);

    const aspectOrder = [...new Set(availableCards.map((c) => c.aspect))].sort(
      (a, b) => (ASPECT_INDEX[a] ?? 999) - (ASPECT_INDEX[b] ?? 999)
    );

    return aspectOrder.map((slug) => ({
      slug,
      name: nameByAspect[slug] || slug,
      cards: map[slug] || [],
    }));
  }, [availableCards, nameByAspect]);

  useEffect(() => {
    setCollapsedGroups((prev) => {
      const valid = new Set(groupedByAspect.map((g) => g.slug));
      const next: Record<string, boolean> = {};
      for (const slug of valid) {
        if (prev[slug]) next[slug] = true;
      }
      return next;
    });
    setModeAutoLock(createDefaultModeAutoLockState());
  }, [groupedByAspect]);

  const totalQty = useMemo(() => {
    // Count only non-special types toward the page limit
    let pages = 0;
    for (const [id, qty] of Object.entries(entries)) {
      const card = cards.find(c => c.id === id);
      if (!card || qty <= 0) continue;
      if (card.type === "Astral" || card.type === "Shadow" || isReferenceCard(card)) continue;
      pages += qty;
    }
    return pages;
  }, [entries, cards]);

  const counts = useMemo(() => {
    let holy = 0, light = 0, dark = 0, astral = 0, shadow = 0;
    for (const [id, qty] of Object.entries(entries)) {
      const card = cards.find(c => c.id === id);
      if (!card || qty <= 0) continue;
      if (isReferenceCard(card)) continue;
      const t = card.type as SpellType;
      if (t === "Holy") holy += qty;
      else if (t === "Light") light += qty;
      else if (t === "Dark" || t === "Curse") dark += qty;
      else if (t === "Astral") astral += qty;
      else if (t === "Shadow") shadow += qty;
    }
    return { Holy: holy, Light: light, Dark: dark, Astral: astral, Shadow: shadow };
  }, [entries, cards]);

  const totalCopies = useMemo(() => Object.values(entries).reduce((sum, n) => sum + (n || 0), 0), [entries]);

  const cardsById = useMemo(() => {
    const map: Record<string, Card> = {};
    for (const card of cards) map[card.id] = card;
    return map;
  }, [cards]);

  useEffect(() => {
    setEntries((prev) => {
      let changed = false;
      const next: Record<string, number> = { ...prev };
      for (const [id, qty] of Object.entries(prev)) {
        if (qty <= 0) continue;
        const card = cardsById[id];
        if (card && isReferenceCard(card)) {
          next[id] = 0;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [cardsById]);

  // Default load: all Focus spells (fills the Grimoire to its base 60 pages)
  useEffect(() => {
    const hasAny = Object.values(entries).some((q) => (q || 0) > 0);
    if (hasAny) return;
    const focusList = cards.filter((c) => c.aspect === FOCUS_SLUG && !isReferenceCard(c));
    if (focusList.length === 0) return;
    const next: Record<string, number> = {};
    for (const c of focusList) {
      const max = Number(c.maxCopies || 0);
      next[c.id] = max > 0 ? max : 1;
    }
    setEntries(next);
  }, [cards, entries]);

  function setQty(cardId: string, n: number) {
    const card = cardsById[cardId];
    if (card && isReferenceCard(card)) {
      setEntries((prev) => ({ ...prev, [cardId]: 0 }));
      return;
    }
    if (darkArtsActive && card?.type === 'Holy') {
      alert('Dark Arts is active. Holy spells cannot be added to the Grimoire.');
      setEntries((prev) => ({ ...prev, [cardId]: 0 }));
      return;
    }
    setEntries((prev) => ({ ...prev, [cardId]: Math.max(0, n) }));
  }

  const defaultPages = 60;
  const pageLimit = Number.POSITIVE_INFINITY; // no hard cap
  const inkTarget = 75;

  const inkTotal = useMemo(() => {
    let total = 0;
    for (const [id, qtyRaw] of Object.entries(entries || {})) {
      const qty = qtyRaw || 0;
      if (qty <= 0) continue;
      const card = cardsById[id];
      if (!card) continue;
      if (isReferenceCard(card)) continue; // Travel/Info do not use INK
      const cost = Number(card.rank || 0);
      if (!Number.isFinite(cost)) continue;
      total += cost * qty;
    }
    return total;
  }, [cardsById, entries]);

  const TYPE_LIMITS = useMemo(() => {
    return { Holy: 5, Light: 52, Dark: 3 } as Partial<Record<SpellType, number>>;
  }, []);

  const remainingByType = useMemo(() => ({
    Holy: Math.max(0, (TYPE_LIMITS.Holy ?? Infinity) - counts.Holy),
    Light: Math.max(0, (TYPE_LIMITS.Light ?? Infinity) - counts.Light),
    Dark: Math.max(0, (TYPE_LIMITS.Dark ?? Infinity) - counts.Dark),
    Astral: Number.POSITIVE_INFINITY,
    Shadow: Number.POSITIVE_INFINITY,
    Travel: Number.POSITIVE_INFINITY,
    Info: Number.POSITIVE_INFINITY,
    Curse: Math.max(0, (TYPE_LIMITS.Dark ?? Infinity) - counts.Dark),
  } as Record<SpellType, number>), [counts, TYPE_LIMITS]);

  const computeDeckUsageStats = useCallback((entriesMap: Record<string, number>) => {
    let pages = 0; // counts only Holy/Light/Dark
    let total = 0; // counts all spells including Astral/Shadow
    let hasAstral = false;
    let hasShadow = false;
    let hasParallel = false;
    for (const [id, qtyRaw] of Object.entries(entriesMap || {})) {
      const qty = qtyRaw || 0;
      if (qty <= 0) continue;
      const card = cardsById[id];
      const type = card?.type as SpellType | undefined;
      if (card && isReferenceCard(card)) continue;
      total += qty;
      if (!card || (type !== 'Astral' && type !== 'Shadow')) {
        pages += qty;
      }
      if (type === 'Astral') hasAstral = true;
      if (type === 'Shadow') hasShadow = true;
      if (PARALLEL_CARD_IDS.has(id) && qty > 0) hasParallel = true;
    }
    return { pages, total, hasAstral, hasShadow, hasParallel };
  }, [cardsById]);

  const currentDeckStats = useMemo(() => computeDeckUsageStats(entries), [computeDeckUsageStats, entries]);

  // ----- Pre-Bound Grimoire Library -----
  const canUseGrimoire = useCallback((g: PreboundGrimoire) => {
    const required = (g?.aspects || []).filter((slug) => {
      // Treat basics as auto-unlocked; omit them from requirement
      return !isBasicAspect(slug);
    });
    return required.every((a) => unlocksSet.has(a));
  }, [isBasicAspect, unlocksSet]);

  const bindGrimoire = useCallback((g: PreboundGrimoire) => {
    if (!g) return;
    if (!canUseGrimoire(g)) {
      alert('You have not unlocked all required Aspects for this Pre-Bound Grimoire.');
      return;
    }
    // Helper: robust ID resolver to tolerate underscores, spacing, or case
    const idIndex: Record<string, string> = (() => {
      const idx: Record<string, string> = {};
      const norm = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      const flat = (s: string) => norm(s).replace(/_/g, '');
      for (const c of cards) {
        const id = c.id;
        const n = norm(id);
        const f = flat(id);
        const dePref = id.replace(/^[a-z]+_/, ''); // drop category prefix like c_, s_, legend_
        const nd = norm(dePref);
        const fd = flat(dePref);
        // direct keys
        idx[id] = id;
        idx[id.toLowerCase()] = id;
        // normalized variants
        idx[n] = id;
        idx[f] = id;
        // de-prefixed variants
        idx[dePref] = id;
        idx[dePref.toLowerCase()] = id;
        idx[nd] = id;
        idx[fd] = id;
      }
      return idx;
    })();
    const resolveId = (raw: string | undefined): string | undefined => {
      if (!raw) return undefined;
      const key = raw.trim();
      const lower = key.toLowerCase();
      const norm = lower.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      const flat = norm.replace(/_/g, '');
      const dePref = lower.replace(/^[a-z]+_/, '');
      const nd = dePref.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      const fd = nd.replace(/_/g, '');
      return (
        idIndex[key] || idIndex[lower] || idIndex[norm] || idIndex[flat] ||
        idIndex[dePref] || idIndex[nd] || idIndex[fd] || undefined
      );
    };

    // First pass: collect requested counts and template-level stats
    const requested: Record<string, number> = {};
    let templatePages = 0; // known non-special pages
    let templateRawPages = 0; // pages counted from raw entries even if id unknown
    let templateTotalSpells = 0; // counts all entries regardless of type/known
    let templateHasAstral = false;
    let templateHasShadow = false;
    let unknownIds = 0;
    let unknownPageUnits = 0;
    const unknowns: { input: string | undefined; count: number; reason: 'unresolved' | 'not_found' }[] = [];
    for (const raw of g.spellCards || []) {
      let id: string | undefined;
      let count = 1;
      if (typeof raw === 'string') {
        const m = raw.split(':');
        id = (m[0] || '').trim();
        if (m.length > 1) {
          const n = parseInt((m[1] || '1').trim(), 10);
          if (Number.isFinite(n) && n > 0) count = n;
        }
      } else if (raw && typeof raw === 'object') {
        id = (raw as any).id;
        const n = parseInt(String((raw as any).count ?? '1'), 10);
        if (Number.isFinite(n) && n > 0) count = n;
      }
      const cid = resolveId(id);
      if (!cid) { templateRawPages += count; unknownIds += 1; unknownPageUnits += count; unknowns.push({ input: id, count, reason: 'unresolved' }); continue; }
      requested[cid] = (requested[cid] || 0) + count;
      const c = cardsById[cid];
      // Always count raw pages for Mastery detection, even if id is unknown
      // Unknown ids are assumed to be non-special pages for this purpose
      if (!c) { templateRawPages += count; templateTotalSpells += count; unknowns.push({ input: cid, count, reason: 'not_found' }); continue; }
      if (c.type !== 'Astral' && c.type !== 'Shadow') {
        templatePages += count;
        templateRawPages += count;
      } else {
        // known Astral/Shadow do not count toward page total
        if (c.type === 'Astral') templateHasAstral = true;
        if (c.type === 'Shadow') templateHasShadow = true;
      }
      templateTotalSpells += count;
    }
    // Ensure aspects selected reflect required aspects
    const required = new Set(g.aspects || []);
    const basicReq: string[] = [];
    const nonBasicReq: string[] = [];
    for (const slug of required) {
      if (isBasicAspect(slug)) basicReq.push(slug); else nonBasicReq.push(slug);
    }
    // keep at least Focus in basics if none provided
    const baseBasics = basicReq.length > 0 ? basicReq : ['focus'];
    setBasicsSelected(Array.from(new Set(baseBasics)));
    setChosenAspects(Array.from(new Set(nonBasicReq)));
    // Two-phase apply: 1) enable required modifiers, 2) fill under caps
    try {
      const targetMastery = false;

      // Compute per-card target max copies under intended modes
      const targetMaxById: Record<string, number> = {};
      for (const c of cards) {
        let max = c.maxCopies;
        if (fragmentsModeActive && c.rank > 2) max = Math.min(max, 1);
        targetMaxById[c.id] = max;
      }

      // Build desired by clamping requested counts to target max
      const desired: Record<string, number> = {};
      for (const [cid, want] of Object.entries(requested)) {
        const c = cardsById[cid];
        if (!c) continue;
        const max = targetMaxById[cid] ?? c.maxCopies;
        desired[cid] = Math.max(0, Math.min(want || 0, max));
      }

      // Now compute quick stats from desired for mode toggles
      let totalCards = 0; // counts all spells
      let totalPages = 0; // counts only Holy/Light/Dark (post-clamp)
      let seesAstral = false;
      let seesShadow = false;
      for (const [cid, qty] of Object.entries(desired)) {
        const q = qty || 0; if (q <= 0) continue;
        totalCards += q;
        const c = cardsById[cid];
        if (c && isReferenceCard(c)) continue;
        if (c?.type === 'Astral') seesAstral = true;
        if (c?.type === 'Shadow') seesShadow = true;
        if (!c || (c.type !== 'Astral' && c.type !== 'Shadow')) totalPages += q;
      }

      // Enable toggles first
      setModeToggles((prev) => ({
        ...prev,
        starlight_addition: (prev.starlight_addition || seesAstral || templateHasAstral),
        shadow_addition: (prev.shadow_addition || seesShadow || templateHasShadow),
      }));

      // Compute caps using intended modes
      const pageCap = pageLimit;
      const typeCaps: Record<'Holy'|'Light'|'Dark', number> = {
        Holy: TYPE_LIMITS.Holy ?? Number.POSITIVE_INFINITY,
        Light: TYPE_LIMITS.Light ?? Number.POSITIVE_INFINITY,
        Dark: TYPE_LIMITS.Dark ?? Number.POSITIVE_INFINITY,
      };
      const astralCap = seesAstral ? 7 : 0;
      const shadowCap = seesShadow ? 3 : 0;

      let pagesLeft = pageCap;
      let holyLeft = typeCaps.Holy;
      let lightLeft = typeCaps.Light;
      let darkLeft = typeCaps.Dark;
      let astralLeft = astralCap;
      let shadowLeft = shadowCap;

      const finalEntries: Record<string, number> = {};

      // First, allocate Astral and Shadow up to their slots
      for (const [cid, want] of Object.entries(desired)) {
        const c = cardsById[cid]; if (!c) continue;
        const q = want || 0; if (q<=0) continue;
        if (isReferenceCard(c)) continue;
        if (c.type === 'Astral') {
          const max = targetMaxById[cid] ?? c.maxCopies;
          const n = Math.min(q, astralLeft, max);
          if (n>0) { finalEntries[cid] = n; astralLeft -= n; }
        }
        if (c.type === 'Shadow') {
          const max = targetMaxById[cid] ?? c.maxCopies;
          const n = Math.min(q, shadowLeft, max);
          if (n>0) { finalEntries[cid] = n; shadowLeft -= n; }
        }
      }
      // Then allocate Holy/Light/Dark pages under per-type caps
      const addPage = (cid: string, maxAdd: number) => {
        const c = cardsById[cid]!;
        if (isReferenceCard(c)) return 0;
        const leftByType = c.type === 'Holy' ? holyLeft : c.type === 'Light' ? lightLeft : darkLeft;
        const max = targetMaxById[cid] ?? c.maxCopies;
        const n = Math.max(0, Math.min(maxAdd, leftByType, pagesLeft, max));
        if (n<=0) return 0;
        finalEntries[cid] = (finalEntries[cid]||0) + n;
        pagesLeft -= n;
        if (c.type === 'Holy') holyLeft -= n; else if (c.type==='Light') lightLeft -= n; else darkLeft -= n;
        return n;
      };
      // preserve template order for deterministic fills
      for (const raw of (g.spellCards || [])) {
        let id: string | undefined; let want=1;
        if (typeof raw==='string') { const m=raw.split(':'); id=(m[0]||'').trim(); if (m.length>1){ const n=parseInt((m[1]||'1').trim(),10); if(Number.isFinite(n)&&n>0) want=n; } }
        else if (raw && typeof raw==='object') { id=(raw as any).id; const n=parseInt(String((raw as any).count ?? '1'),10); if(Number.isFinite(n)&&n>0) want=n; }
        const cid = resolveId(id);
        if (!cid) continue; const c = cardsById[cid]; if (!c) continue;
        if (isReferenceCard(c)) continue;
        if (c.type==='Astral' || c.type==='Shadow') continue; // already allocated above
        const already = finalEntries[cid]||0;
        const remaining = Math.max(0, (desired[cid]||0) - already);
        if (remaining<=0) continue;
        addPage(cid, remaining);
      }

      setEntries(finalEntries);

      // Optional feedback
      const loadedPages = computeDeckUsageStats(finalEntries).total;
      const loadedAstral = astralCap - astralLeft;
      const loadedShadow = shadowCap - shadowLeft;
      const parts: string[] = [`${loadedPages} spells`];
      if (seesAstral) parts.push(`Astral ${loadedAstral}/${astralCap}`);
      if (seesShadow) parts.push(`Shadow ${loadedShadow}/${shadowCap}`);
      setModeMessage({ type: 'info', text: `Grimoire loaded: ${parts.join(' · ')}.` });
      if (unknowns.length > 0) {
        try {
          for (const u of unknowns) {
            console.warn('[Pre-Bound] Skipped entry', { grimoire: g?.id, name: g?.name, id: u.input, count: u.count, reason: u.reason });
          }
        } catch {}
      }
    } catch {}
    setShowLibrary(false);
  }, [TYPE_LIMITS, cards, canUseGrimoire, isBasicAspect, pageLimit]);

  // Admin helpers for Pre-Bound Grimoires
  const slugify = useCallback((s: string) => (s||'')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, ''), []);

  const refreshPrebounds = useCallback(() => {
    // Re-run the loader logic for prebounds from localStorage and base ids
    (async () => {
      try {
        const url = new URL('./assets/data/prebound.json', import.meta.url).href;
        const res = await fetch(url);
        const baseList: any = res.ok ? await res.json() : [];
        const arr = Array.isArray(baseList) ? baseList : [];
        const localRaw = (typeof localStorage !== 'undefined') ? localStorage.getItem('wkw.prebounds.local') : null;
        let localArr: PreboundGrimoire[] = [];
        try { localArr = localRaw ? JSON.parse(localRaw) : []; } catch { localArr = []; }
        const byId: Record<string, PreboundGrimoire> = {};
        for (const g of arr as PreboundGrimoire[]) { if (g && g.id) byId[g.id] = g; }
        for (const g of localArr) { if (g && g.id) byId[g.id] = g; }
        setPrebounds(Object.values(byId));
        setPreboundsBaseIds((arr as PreboundGrimoire[]).map(x=>x.id));
      } catch {
        // ignore
      }
    })();
  }, []);

  const upsertLocalPrebound = useCallback((g: PreboundGrimoire) => {
    // Prefer slug-based Cloud save; fall back to local
    (async () => {
      if (SHARE_API_ENABLED && ((rtAdminBearer||rtAdminApiKey) || (ENV_GRIMOIRE_ADMIN_BEARER||ENV_GRIMOIRE_ADMIN_API_KEY))) {
        const ok = await putCloudGrimoire(g);
        if (ok) {
          setCloudToast({ type: 'success', text: `Saved “${g.name || g.id}” to Cloud.` });
          await refreshPrebounds();
          return;
        } else {
          setCloudToast({ type: 'error', text: `Cloud save failed for “${g.id}”. Using local fallback.` });
        }
      }
      const key = 'wkw.prebounds.local';
      let arr: PreboundGrimoire[] = [];
      try { arr = JSON.parse(localStorage.getItem(key) || '[]'); } catch { arr = []; }
      const idx = arr.findIndex(x => x.id === g.id);
      if (idx >= 0) arr[idx] = g; else arr.push(g);
      localStorage.setItem(key, JSON.stringify(arr));
      setCloudToast({ type: 'info', text: `Saved “${g.name || g.id}” locally (Cloud disabled or unauthorized).` });
      await refreshPrebounds();
    })();
  }, [refreshPrebounds]);

  const removeLocalPrebound = useCallback((id: string) => {
    (async () => {
      if (SHARE_API_ENABLED && ((rtAdminBearer||rtAdminApiKey) || (ENV_GRIMOIRE_ADMIN_BEARER||ENV_GRIMOIRE_ADMIN_API_KEY))) {
        const ok = await deleteCloudGrimoire(id);
        if (ok) { setCloudToast({ type: 'success', text: `Deleted “${id}” from Cloud.` }); await refreshPrebounds(); return; }
        else { setCloudToast({ type: 'error', text: `Cloud delete failed for “${id}”.` }); }
      }
      const nextList = prebounds.filter(x => x.id !== id);
      const key = 'wkw.prebounds.local';
      try { localStorage.setItem(key, JSON.stringify(nextList)); } catch {}
      setCloudToast({ type: 'info', text: `Deleted “${id}” locally.` });
      await refreshPrebounds();
    })();
  }, [refreshPrebounds, prebounds]);

  const downloadAllPrebounds = useCallback(() => {
    const data = JSON.stringify(prebounds, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'prebound.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [prebounds]);

  const deriveModesFromDeck = useCallback((deck: SavedDeck) => {
    const baseModes = deck.modes || {};
    const inferred = createDefaultModeState();
    for (const id of MODE_TOGGLE_IDS) {
      inferred[id] = Boolean(baseModes[id]);
    }

    const stats = computeDeckUsageStats(deck.entries || {});
    const aspectsSet = new Set([...(deck.basicsSelected || []), ...(deck.chosenAspects || [])]);

    if (stats.hasAstral || aspectsSet.has('starlight')) {
      inferred.starlight_addition = true;
    }
    if (stats.hasShadow || aspectsSet.has('shadows')) {
      inferred.shadow_addition = true;
    }
    if (stats.hasParallel) {
      inferred.parallel_dimension = true;
    }
    return { modes: inferred };
  }, [computeDeckUsageStats]);

  useEffect(() => {
    if (overrideAll || cards.length === 0) return;

    const stats = computeDeckUsageStats(entries);
    const aspectsSet = new Set([...(basicsSelected || []), ...(chosenAspects || [])]);
    const expected: Partial<Record<ModeToggleId, boolean>> = {
      starlight_addition: stats.hasAstral || aspectsSet.has('starlight'),
      shadow_addition: stats.hasShadow || aspectsSet.has('shadows'),
      parallel_dimension: stats.hasParallel,
    };

    const messages: string[] = [];
    let shouldUpdate = false;
    const nextToggles: Record<ModeToggleId, boolean> = { ...modeToggles };

    for (const [id, value] of Object.entries(expected) as [ModeToggleId, boolean][]) {
      if (!modeAutoLock[id]) continue;
      if (value && !modeToggles[id]) {
        nextToggles[id] = true;
        shouldUpdate = true;
        messages.push(`${MODE_TOGGLE_META[id].label} enabled automatically based on imported grimoire.`);
      }
    }

    if (!shouldUpdate) return;

    setModeToggles(nextToggles);
    if (messages.length > 0 && (!modeMessage || modeMessage.type === 'info')) {
      setModeMessage({ type: 'info', text: messages.join(' ') });
    }
  }, [
    basicsSelected,
    cards.length,
    chosenAspects,
    computeDeckUsageStats,
    entries,
    modeAutoLock,
    modeMessage,
    modeToggles,
    overrideAll,
    setModeMessage,
    setModeToggles,
  ]);

  const modeDescriptors = useMemo(() => {
    return MODE_DISPLAY_ORDER.map((id) => {
      const meta = MODE_TOGGLE_META[id];
      const requiresAll = meta.requiresAspects || [];
      const requiresAny = meta.requiresAnyAspects || [];
      const missingAspects = requiresAll.filter((slug) => !overrideAll && !unlocksSet.has(slug));
      const missingAspectLabels = missingAspects.map((slug) => nameByAspect[slug] || (slug.replace(/_/g, ' ') || slug));
      const requiresToggle = meta.requiresToggle || [];
      const missingToggleLabels = requiresToggle
        .filter((dep) => !modeToggles[dep])
        .map((dep) => MODE_TOGGLE_META[dep].label);
      let requiresAnyMessage: string | undefined;
      if (!overrideAll && requiresAny.length > 0) {
        const hasAny = requiresAny.some((slug) => unlocksSet.has(slug));
        if (!hasAny) {
          const labels = requiresAny.map((slug) => nameByAspect[slug] || (slug.replace(/_/g, ' ') || slug));
          requiresAnyMessage = `Unlock one of: ${labels.join(' / ')}`;
        }
      }
      const conflictsActive = (meta.conflicts || []).filter((conf) => modeToggles[conf]);
      const available = missingAspects.length === 0 && missingToggleLabels.length === 0 && !requiresAnyMessage;
      let disabledReason: string | undefined;
      if (!available) {
        if (missingAspectLabels.length > 0) {
          disabledReason = `Unlock ${missingAspectLabels.join(', ')}.`;
        } else if (missingToggleLabels.length > 0) {
          disabledReason = `Enable ${missingToggleLabels.join(', ')} first.`;
        } else if (requiresAnyMessage) {
          disabledReason = requiresAnyMessage;
        }
      }
      const conflictAdvice = conflictsActive.length > 0
        ? `Disable ${conflictsActive.map((conf) => MODE_TOGGLE_META[conf].label).join(', ')} to enable.`
        : undefined;
      return {
        id,
        meta,
        available,
        missingAspectLabels,
        missingToggleLabels,
        conflictsActive,
        active: Boolean(modeToggles[id]),
        disabledReason,
        conflictAdvice,
      };
    });
  }, [modeToggles, nameByAspect, overrideAll, unlocksSet]);

  const visibleModeDescriptors = useMemo(
    () => modeDescriptors.filter((descriptor) => descriptor.active || descriptor.available),
    [modeDescriptors]
  );
  const hasVisibleModeDescriptors = visibleModeDescriptors.length > 0;
  const togglesDefaultOpen = hasVisibleModeDescriptors && (Boolean(modeMessage) || visibleModeDescriptors.some((d) => d.active));
  const modePanelInitialized = React.useRef(false);
  useEffect(() => {
    if (!modePanelInitialized.current) {
      setModePanelOpen(togglesDefaultOpen);
      modePanelInitialized.current = true;
      modePanelSuppressAutoOpen.current = false;
      return;
    }
    if (!modePanelOpen && modeMessage && !modePanelSuppressAutoOpen.current) {
      setModePanelOpen(true);
    }
    // Once the message clears, allow auto-open again
    if (!modeMessage) modePanelSuppressAutoOpen.current = false;
  }, [modeMessage, modePanelOpen, togglesDefaultOpen]);

  // Auto-dismiss non-error mode messages after 5s
  useEffect(() => {
    if (!modeMessage) return;
    if (modeMessage.type === 'error') return; // keep errors until user changes context
    const t = window.setTimeout(() => setModeMessage(null), 5000);
    return () => window.clearTimeout(t);
  }, [modeMessage]);
  const validateModeChange = React.useCallback((next: Record<ModeToggleId, boolean>): string | null => {
    const fragmentsNext = Boolean(next.fragments_mode);
    const allowAspectInNext = (slug: string) => {
      if (overrideAll) return true;
      if (slug === 'starlight') return Boolean(next.starlight_addition) && unlocksSet.has('starlight');
      if (slug === 'shadows') return Boolean(next.shadow_addition) && unlocksSet.has('shadows');
      return true;
    };

    const nonSpecialNext = chosenAspects
      .filter((slug) => {
        const meta = aspects.find((a) => a.slug === slug);
        if (!meta || meta.isSpecial) return false;
        return aspectEligible(slug) && allowAspectInNext(slug);
      });
    const maxNonSpecialNext = 2;
    const setNon = new Set(nonSpecialNext);
    const includesDarkTrioNext = (DARK_SLUGS as readonly string[]).every((s) => setNon.has(s));
    const allowedNonSpecial = includesDarkTrioNext
      ? Math.max(maxNonSpecialNext, (DARK_SLUGS as readonly string[]).length)
      : maxNonSpecialNext;
    if (setNon.size > allowedNonSpecial) {
      return `Adjust aspect selections to ${maxNonSpecialNext} before changing modes.`;
    }

    // No page cap enforcement in current ruleset

    const baseTypeLimitsNext: Partial<Record<SpellType, number>> = { Holy: 4, Light: 24, Dark: 2 };
    const darkModifierNext = includesDarkTrioNext;
    const typeLimitsNext = (!overrideAll && includesDarkTrioNext)
      ? {
          Holy: 0,
          Light: (baseTypeLimitsNext.Light || 0) + (darkModifierNext ? 6 : 3),
          Dark: (baseTypeLimitsNext.Dark || 0) + (darkModifierNext ? 2 : 1),
        }
      : baseTypeLimitsNext;
    if (!overrideAll) {
      if ((typeLimitsNext.Holy ?? Infinity) < counts.Holy) {
        return `Remove ${counts.Holy - (typeLimitsNext.Holy ?? 0)} Holy spell(s) before disabling this mode.`;
      }
      if ((typeLimitsNext.Light ?? Infinity) < counts.Light) {
        return `Remove ${counts.Light - (typeLimitsNext.Light ?? 0)} Light spell(s) before disabling this mode.`;
      }
      if ((typeLimitsNext.Dark ?? Infinity) < counts.Dark) {
        return `Remove ${counts.Dark - (typeLimitsNext.Dark ?? 0)} Dark spell(s) before disabling this mode.`;
      }
    }

    const nextMaxById: Record<string, number> = {};
    for (const c of cards) {
      let max = c.maxCopies;
      if (fragmentsNext && c.rank > 2) {
        max = Math.min(max, 1);
      }
      nextMaxById[c.id] = max;
    }
    for (const [id, qty] of Object.entries(entries)) {
      const max = nextMaxById[id];
      if (max != null && qty > max) {
        const card = cards.find((c) => c.id === id);
        const name = card ? card.name : id;
        return `Reduce copies of ${name} to ${max} before disabling this mode.`;
      }
    }

    return null;
  }, [DARK_SLUGS, allDarkTrioSelected, aspectEligible, aspects, cards, counts, entries, overrideAll, totalQty, unlocks, unlocksSet]);

  const handleModeToggle = React.useCallback((id: ModeToggleId) => {
    const meta = MODE_TOGGLE_META[id];
    if (!meta) return;
    const descriptor = modeDescriptors.find((d) => d.id === id);
    const active = Boolean(modeToggles[id]);

    if (!active) {
      if (descriptor && !descriptor.available) {
        if (descriptor.missingAspectLabels.length > 0) {
          const list = descriptor.missingAspectLabels.join(', ');
          setModeMessage({ type: 'error', text: `${meta.label} requires unlocking: ${list}.` });
          return;
        }
        if (descriptor.missingToggleLabels.length > 0) {
          const list = descriptor.missingToggleLabels.join(', ');
          setModeMessage({ type: 'error', text: `${meta.label} requires enabling: ${list}.` });
          return;
        }
      }
      const conflicts = (meta.conflicts || []).filter((conf) => modeToggles[conf]);
      if (conflicts.length > 0) {
        const names = conflicts.map((conf) => MODE_TOGGLE_META[conf].label).join(', ');
        setModeMessage({ type: 'error', text: `${meta.label} cannot be enabled while ${names} ${conflicts.length === 1 ? 'is' : 'are'} active.` });
        return;
      }
      const nextState: Record<ModeToggleId, boolean> = { ...modeToggles, [id]: true };
      setModeAutoLock((prev) => ({ ...prev, [id]: false }));
      setModeToggles(nextState);
      setModeMessage(null);
      return;
    }

    const nextState: Record<ModeToggleId, boolean> = { ...modeToggles, [id]: false };
    for (const [otherId, otherMeta] of Object.entries(MODE_TOGGLE_META) as [ModeToggleId, typeof MODE_TOGGLE_META[ModeToggleId]][]) {
      if (otherMeta.requiresToggle && otherMeta.requiresToggle.includes(id) && nextState[otherId]) {
        nextState[otherId] = false;
      }
    }
    const violation = validateModeChange(nextState);
    if (violation) {
      setModeMessage({ type: 'error', text: violation });
      return;
    }
    setModeAutoLock((prev) => ({ ...prev, [id]: false }));
    setModeToggles(nextState);
    setModeMessage(null);
  }, [modeDescriptors, modeToggles, validateModeChange]);

  useEffect(() => {
    setEntries((prev) => {
      let changed = false;
      const next = { ...prev } as Record<string, number>;
      for (const [id, qty] of Object.entries(prev)) {
        const max = effectiveMaxCopies[id];
        if (max != null && qty > max) {
          next[id] = max;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [effectiveMaxCopies]);

  useEffect(() => {
    if (starlightModeActive) return;
    setChosenAspects((prev) => prev.filter((s) => s !== 'starlight'));
    setEntries((prev) => {
      let changed = false;
      const next = { ...prev } as Record<string, number>;
      for (const c of cards) {
        if (c.aspect === 'starlight' && (next[c.id] || 0) > 0) {
          next[c.id] = 0;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [cards, starlightModeActive]);

  useEffect(() => {
    if (shadowModeActive) return;
    setChosenAspects((prev) => prev.filter((s) => s !== 'shadows'));
    setEntries((prev) => {
      let changed = false;
      const next = { ...prev } as Record<string, number>;
      for (const c of cards) {
        if (c.aspect === 'shadows' && (next[c.id] || 0) > 0) {
          next[c.id] = 0;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [cards, shadowModeActive]);

  useEffect(() => {
    if (parallelModeActive) return;
    setChosenAspects((prev) => prev.filter((s) => s !== 'madness' && s !== 'energy'));
    setEntries((prev) => {
      let changed = false;
      const next = { ...prev } as Record<string, number>;
      for (const [id, qty] of Object.entries(prev)) {
        if (PARALLEL_CARD_IDS.has(id) && (qty || 0) > 0) {
          next[id] = 0;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [parallelModeActive]);

  // Special unlock flags and helper text
  const hasAstral = Boolean(starlightModeActive);
  const hasShadow = Boolean(shadowModeActive);
  const extraParts: string[] = [];
  if (hasAstral) extraParts.push(`[Astral]: ${counts.Astral}/7`);
  if (hasShadow) extraParts.push(`[Shadow]: ${counts.Shadow}/3`);
  const extraSummaryLine = extraParts.join('    ');
  const specialSlotsText = hasAstral && hasShadow
    ? 'Unlocks add extra slots: +7 Astral and +3 Shadow.'
    : hasAstral
    ? 'Unlocks add extra slots: +7 Astral.'
    : hasShadow
    ? 'Unlocks add extra slots: +3 Shadow.'
    : '';
  const showDarkCategory = overrideAll || aspects.some((a) => a.isDark && unlocksSet.has(a.slug));

  const basicsSelectedCount = basicsSelected.length;
  const SPECIAL_SLUGS = useMemo(() => aspects.filter(a => a.isSpecial).map(a => a.slug) as ReadonlyArray<string>, [aspects]);
  const darkSelectedCount = chosenAspects.filter((slug) => DARK_SLUGS.includes(slug)).length;
  const specialSelectedCount = chosenAspects.filter((slug) => SPECIAL_SLUGS.includes(slug)).length;
  const additionalSelectedCount = chosenAspects.filter((slug) => {
    const meta = aspectsBySlug[slug];
    if (!meta) return false;
    if (isBasicAspect(slug)) return false;
    if (meta.isSpecial || meta.isDark) return false;
    return true;
  }).length;
  const hasAdditionalUnlocked = Boolean(
    (additionalLostAspect && (overrideAll || unlocksSet.has(additionalLostAspect.slug))) ||
    additionalAspectGroups.some(group => group.some(a => overrideAll || unlocksSet.has(a.slug)))
  );

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100 flex justify-center px-6 md:px-10 lg:px-20 xl:px-28 py-6">
      <div className="max-w-7xl w-full mx-auto space-y-6 sm:space-y-8 text-center">
        <header className="grid grid-cols-1 sm:grid-cols-[auto_1fr_auto] items-center justify-items-center gap-2 w-full px-4 md:px-6">
          {/* Left (desktop): Rules · Library · Grimoires */}
          <div className="hidden sm:flex items-center gap-2 md:gap-3 justify-self-start pl-2 sm:pl-4 mt-1 md:mt-3 w-auto">
            <a
              href="https://docs.google.com/document/d/1_Vso3yHHDZo5LrzWOoWWuSx_P4fiZrx-oQWdGBXncEs/edit?usp=sharing"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-xl border-2 px-4 py-2 text-base md:text-xl bg-slate-100 text-slate-900 hover:bg-slate-200 shadow-md font-semibold border-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 dark:border-slate-600"
            >
              Rules
            </a>
            <button
              type="button"
              aria-label="Library"
              onClick={() => setShowLibrary(true)}
              className="rounded-xl border-2 px-4 py-2 text-base md:text-xl bg-slate-100 text-slate-900 hover:bg-slate-200 shadow-md font-semibold border-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 dark:border-slate-600"
            >
              Library
            </button>
            <button
              type="button"
              aria-label="Grimoires"
              onClick={() => setShowDecks(true)}
              className="rounded-xl border-2 px-4 py-2 text-base md:text-xl bg-slate-100 text-slate-900 hover:bg-slate-200 shadow-md font-semibold border-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 dark:border-slate-600"
            >
              Grimoires
            </button>
          </div>

          {/* Center: Title */}
          <div className="flex flex-col items-center gap-2 justify-self-center">
            <h1 className="text-2xl md:text-4xl font-bold text-center text-slate-900 dark:text-slate-100">WKW Grimoire Binder</h1>
          </div>

          {/* Right (desktop): Unlock Aspects */}
          {!overrideAll && (
            <div className="hidden sm:flex justify-self-end pr-2 sm:pr-4 mt-1 md:mt-3">
              <button
                type="button"
                aria-label="Unlock Aspects"
                onClick={() => { console.log('[UI] Unlock Codes clicked'); setShowUnlock(true); }}
                className="rounded-xl border-2 px-4 py-2 text-base md:text-xl bg-indigo-600 text-white hover:bg-indigo-700 shadow-md font-semibold min-w-[160px] md:min-w-[220px]"
              >
                Unlock Aspects
              </button>
            </div>
          )}

          {/* Mobile buttons (under title): Rules, Library, Grimoires */}
          <div className="sm:hidden col-span-1 w-full flex flex-col items-center gap-2 mt-1">
            <div className="flex flex-wrap items-center justify-center gap-2 w-full">
              <a
                href="https://docs.google.com/document/d/1_Vso3yHHDZo5LrzWOoWWuSx_P4fiZrx-oQWdGBXncEs/edit?usp=sharing"
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-xl border-2 px-4 py-2 text-base bg-slate-100 text-slate-900 hover:bg-slate-200 shadow-md font-semibold border-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 dark:border-slate-600"
              >
                Rules
              </a>
              <button
                type="button"
                aria-label="Library"
                onClick={() => setShowLibrary(true)}
                className="rounded-xl border-2 px-4 py-2 text-base bg-slate-100 text-slate-900 hover:bg-slate-200 shadow-md font-semibold border-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 dark:border-slate-600"
              >
                Library
              </button>
              <button
                type="button"
                aria-label="Grimoires"
                onClick={() => setShowDecks(true)}
                className="rounded-xl border-2 px-4 py-2 text-base bg-slate-100 text-slate-900 hover:bg-slate-200 shadow-md font-semibold border-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 dark:border-slate-600"
              >
                Grimoires
              </button>
            </div>
            {!overrideAll && (
              <button
                type="button"
                aria-label="Unlock Aspects"
                onClick={() => { console.log('[UI] Unlock Codes clicked'); setShowUnlock(true); }}
                className="rounded-xl border-2 px-4 py-2 text-base bg-indigo-600 text-white hover:bg-indigo-700 shadow-md font-semibold min-w-[160px]"
              >
                Unlock Aspects
              </button>
            )}
          </div>
        </header>

        {overrideAll && (
          <div className="rounded-xl border border-amber-300 bg-amber-100 text-amber-900 px-4 py-2 text-sm text-center shadow-sm">
            Override Mode Enabled — All aspects unlocked and limits disabled.
          </div>
        )}

        {/* Basics & Aspects */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-3">
              <div className="rounded-2xl border border-slate-300 dark:border-slate-700 bg-white/70 dark:bg-slate-900/40 shadow-sm">
                <div className="flex items-center gap-2 rounded-xl px-3 py-2 text-base md:text-lg font-semibold text-slate-900 dark:text-slate-100">
                  <span className="flex-1 text-center">
                    Basics (always unlocked)
                    {basicsSelectedCount > 0 ? ` · ${basicsSelectedCount} selected` : ''}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggleSection('basics')}
                  className="inline-flex items-center justify-center px-3 py-1 text-xs font-semibold border border-slate-300 dark:border-slate-600 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 shadow-sm"
                >
                  {sectionExpanded.basics ? 'Collapse' : 'Expand'}
                </button>
              </div>
              {sectionExpanded.basics && (
                <div className="mt-3 grid grid-cols-2 gap-3">
                  {aspects
                    .filter((a) => isBasicAspect(a.slug) && aspectEligible(a.slug))
                    .sort((a, b) => (ASPECT_INDEX[a.slug] ?? 999) - (ASPECT_INDEX[b.slug] ?? 999))
                    .map((a) => (
                      <div key={a.slug}>
                        {a.slug === STUDY_SLUG ? (
                          <div className="rounded-2xl p-4 w-full text-center border border-emerald-500 bg-emerald-50 dark:bg-emerald-900/40 dark:border-emerald-500 shadow-sm">
                            <div className="text-sm text-emerald-700 dark:text-emerald-200">Core</div>
                            <div className="text-base font-semibold">{a.name}</div>
                            <div className="mt-1 text-xs text-emerald-700 dark:text-emerald-200">(Always included)</div>
                          </div>
                        ) : (
                          <AspectCard
                            aspect={a}
                            unlocked={true}
                            selected={basicsSelected.includes(a.slug)}
                            onToggle={() => toggleBasic(a.slug)}
                          />
                        )}
                      </div>
                    ))}
                </div>
              )}
            </div>

            {showDarkCategory && (
              <div className="rounded-2xl border border-slate-300 dark:border-slate-700 bg-white/70 dark:bg-slate-900/40 shadow-sm">
                <div className="flex items-center gap-2 rounded-xl px-3 py-2 text-base md:text-lg font-semibold text-slate-900 dark:text-slate-100">
                  <span className="flex-1 text-center">
                    Dark Arts
                    {darkSelectedCount > 0 ? ` · ${darkSelectedCount} selected` : ''}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggleSection('dark')}
                    className="inline-flex items-center justify-center px-3 py-1 text-xs font-semibold border border-slate-300 dark:border-slate-600 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 shadow-sm"
                  >
                    {sectionExpanded.dark ? 'Collapse' : 'Expand'}
                  </button>
                </div>
                {sectionExpanded.dark && (
                  <div className="mt-3 space-y-3">
                    {!overrideAll && allDarkTrioSelected && (
                      <div className="text-sm font-semibold text-center text-red-700 dark:text-red-300">
                        Dark Arts active: All 3 Dark Arts are allowed, but [Holy] spells are blocked.
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      {aspects
                        .filter((a) => a.isDark && (overrideAll || unlocksSet.has(a.slug)) && aspectEligible(a.slug))
                      .sort((a, b) => (ASPECT_INDEX[a.slug] ?? 999) - (ASPECT_INDEX[b.slug] ?? 999))
                      .map((a) => {
                        const isSelected = chosenAspects.includes(a.slug);
                        const allowedByMode = aspectAllowedByModes(a.slug);
                        const modeLocked = !allowedByMode && !overrideAll;
                        const modeHint = modeRequirementHint(a.slug);
                        const nonSpecialSelected = chosenAspects
                          .filter((s) => !aspects.find(x => x.slug === s)?.isSpecial)
                          .filter((s) => aspectEligible(s) && aspectAllowedByModes(s));
                        const nextSet = new Set([...nonSpecialSelected, a.slug]);
                        const nextCount = nextSet.size;
                        const darkTrioSlugs = DARK_SLUGS as readonly string[];
                        const formsDarkTrioNext = darkTrioSlugs.every((s) => nextSet.has(s));
                        const exactlyDarkTrioNext = formsDarkTrioNext && nextSet.size === darkTrioSlugs.length;
                        let disabled = false;
                        if (modeLocked) {
                          disabled = true;
                        } else if (!overrideAll && !isSelected) {
                          const permitted = nextCount <= maxNonSpecialAllowed || exactlyDarkTrioNext;
                          disabled = !permitted;
                        }
                        return (
                          <AspectCard
                            key={a.slug}
                            aspect={a}
                            unlocked={true}
                            selected={isSelected}
                            disabled={disabled}
                            hint={modeHint}
                            onToggle={() => toggleAspect(a.slug)}
                          />
                          );
                        })}
                    </div>
                  </div>
                )}
              </div>
            )}

          {hasVisibleModeDescriptors && (
            <div className="space-y-3">
              <div className="rounded-2xl border border-slate-300 dark:border-slate-700 bg-white/70 dark:bg-slate-900/40 shadow-sm">
                <div className="flex items-center gap-2 rounded-xl px-3 py-2 text-base md:text-lg font-semibold text-slate-900 dark:text-slate-100">
                  <span className="flex-1 text-center">Game Mode Toggles</span>
                  <button
                    type="button"
                    onClick={() => {
                      if (modeMessage) {
                        modePanelSuppressAutoOpen.current = true;
                        setModeMessage(null);
                      }
                      setModePanelOpen((prev) => !prev);
                    }}
                    className="inline-flex items-center justify-center px-3 py-1 text-xs font-semibold border border-slate-300 dark:border-slate-600 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 shadow-sm"
                  >
                    {modePanelOpen ? 'Collapse' : 'Expand'}
                  </button>
                </div>
                {modePanelOpen && (
                  <div className="mt-3 space-y-3 px-1 pb-2">
                    {modeMessage && (
                      <div
                        className={[
                          'rounded-lg px-3 py-2 text-sm border shadow-sm',
                          modeMessage.type === 'error'
                            ? 'bg-rose-50 text-rose-800 border-rose-200 dark:bg-rose-500/10 dark:text-rose-200 dark:border-rose-400/40'
                            : modeMessage.type === 'warning'
                            ? 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:border-amber-400/40'
                            : 'bg-sky-50 text-sky-800 border-sky-200 dark:bg-sky-500/10 dark:text-sky-200 dark:border-sky-400/40',
                        ].join(' ')}
                      >
                        {modeMessage.text}
                      </div>
                    )}
                    <div className="space-y-2">
                      {visibleModeDescriptors.map((descriptor) => {
                        const disabled = !descriptor.active && !descriptor.available;
                        return (
                          <ModeToggleRow
                            key={descriptor.id}
                            label={descriptor.meta.label}
                            description={descriptor.meta.description}
                            active={descriptor.active}
                            disabled={disabled}
                            disabledReason={disabled ? descriptor.disabledReason : undefined}
                            conflictAdvice={!descriptor.active ? descriptor.conflictAdvice : undefined}
                            onToggle={() => handleModeToggle(descriptor.id)}
                          />
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

            {/* Special Aspects under Dark Arts */}
            {(overrideAll || aspects.some((a) => a.isSpecial && unlocksSet.has(a.slug) && aspectEligible(a.slug))) && (
              <div className="rounded-2xl border border-slate-300 dark:border-slate-700 bg-white/70 dark:bg-slate-900/40 shadow-sm">
                <div className="flex items-center gap-2 rounded-xl px-3 py-2 text-base md:text-lg font-semibold text-slate-900 dark:text-slate-100">
                  <span className="flex-1 text-center">
                    Special Aspects
                    {specialSelectedCount > 0 ? ` · ${specialSelectedCount} selected` : ''}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggleSection('special')}
                    className="inline-flex items-center justify-center px-3 py-1 text-xs font-semibold border border-slate-300 dark:border-slate-600 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 shadow-sm"
                  >
                    {sectionExpanded.special ? 'Collapse' : 'Expand'}
                  </button>
                </div>
                {sectionExpanded.special && (
                  <div className="mt-3 space-y-3">
                    {specialSlotsText && (
                      <div className="text-sm text-slate-700 dark:text-slate-200 text-center">
                        {specialSlotsText}
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      {aspects
                        .filter((a) => a.isSpecial && (overrideAll || unlocksSet.has(a.slug)) && aspectEligible(a.slug))
                        .sort((a, b) => (ASPECT_INDEX[a.slug] ?? 999) - (ASPECT_INDEX[b.slug] ?? 999))
                        .map((a) => {
                          const isSelected = chosenAspects.includes(a.slug);
                          const unlockedForCodes = overrideAll || unlocksSet.has(a.slug);
                          const allowed = aspectAllowedByModes(a.slug);
                          const modeLocked = !allowed && unlockedForCodes && !overrideAll;
                          const modeHint = modeRequirementHint(a.slug);
                          return (
                            <AspectCard
                              key={a.slug}
                              aspect={a}
                              unlocked={unlockedForCodes}
                              selected={isSelected}
                              disabled={modeLocked}
                              hint={modeHint}
                              onToggle={() => toggleAspect(a.slug)}
                            />
                          );
                        })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {hasAdditionalUnlocked && (
          <div className="space-y-3">
            <div className="text-center space-y-1">
              <h2 className="font-semibold text-center">
                Additional Aspects
                {additionalSelectedCount > 0 ? ` · ${additionalSelectedCount} selected` : ''}
              </h2>
              <div className="text-sm text-slate-600 dark:text-slate-300">
                {showDarkCategory
                  ? `(choose up to ${maxNonSpecialAllowed} — all 3 Dark Arts still allowed)`
                  : `(choose up to ${maxNonSpecialAllowed})`}
              </div>
            </div>

            {additionalLostAspect ? renderAdditionalLostAspect({
              aspect: additionalLostAspect,
              additionalGroupExpanded,
              overrideAll,
              unlocksSet,
              aspectAllowedByModes,
              modeRequirementHint,
              chosenAspects,
              aspects,
              aspectEligible,
              maxNonSpecialAllowed,
              toggleAdditionalGroup,
              toggleAspect,
              DARK_SLUGS,
            }) : null}

            {additionalAspectGroups.map((group, idx) => renderAdditionalGroup({
              group,
              idx,
              additionalGroupExpanded,
              overrideAll,
              unlocksSet,
              aspectAllowedByModes,
              modeRequirementHint,
              chosenAspects,
              aspects,
              aspectEligible,
              maxNonSpecialAllowed,
              toggleAdditionalGroup,
              toggleAspect,
              DARK_SLUGS,
            }))}
          </div>
          )}

          {/* Dark and Special moved under Basics in the left column */}
        </section>

        {/* Cards grouped by Aspect */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-slate-100 dark:bg-slate-800 rounded-2xl p-4 shadow-sm">
            <h3 className="font-semibold mb-2 text-center" style={{ fontSize: '26px' }}>Spell Pages</h3>
            {/* Sort by role removed per request; keeping only role filter below */}
            <div className="space-y-4">
              {groupedByAspect.map((group) => {
                const collapsed = collapsedGroups[group.slug] ?? false;
                return (
                  <div key={group.slug} className="rounded-2xl bg-slate-50/60 dark:bg-slate-900/40 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-bold text-slate-900 dark:text-slate-100 text-center flex-1" style={{ fontSize: '24px' }}>
                        {group.name && group.name.startsWith('Aspect of ')
                          ? group.name
                          : `Aspect of ${group.name}`}
                      </div>
                      <button
                        type="button"
                        onClick={() => setCollapsedGroups((prev) => ({ ...prev, [group.slug]: !collapsed }))}
                        className="text-sm px-3 py-1 rounded-md border border-slate-300 dark:border-slate-600 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
                      >
                        {collapsed ? 'Expand' : 'Collapse'}
                      </button>
                    </div>

                    {!collapsed && (
                      <>
                        <div className="mb-2 max-w-xl mx-auto px-6 md:px-8 lg:px-10 flex items-center justify-center gap-3">
                          {(() => {
                            const pageCapReached = totalQty >= pageLimit;
                            const groupHasSelectable = group.cards.some(c => !isReferenceCard(c));
                            const groupHasCountable = group.cards.some(c => !isReferenceCard(c) && c.type !== 'Astral' && c.type !== 'Shadow');
                            const allAstral = group.cards.every(c => c.type === 'Astral');
                            const allShadow = group.cards.every(c => c.type === 'Shadow');
                            const astralCap = starlightModeActive ? 7 : 0;
                            const shadowCap = shadowModeActive ? 3 : 0;
                            let pickDisabled = !groupHasSelectable || (pageCapReached && groupHasCountable);
                            if (allAstral) {
                              const allAtMax = group.cards.every(c => (entries[c.id] || 0) >= c.maxCopies);
                              const typeCapReached = astralCap <= 0 || counts.Astral >= astralCap;
                              pickDisabled = allAtMax || typeCapReached;
                            } else if (allShadow) {
                              const allAtMax = group.cards.every(c => (entries[c.id] || 0) >= c.maxCopies);
                              const typeCapReached = shadowCap <= 0 || counts.Shadow >= shadowCap;
                              pickDisabled = allAtMax || typeCapReached;
                            }
                            const allZero = group.cards.every(c => (entries[c.id] || 0) <= 0);
                            return (
                              <>
                                <button
                                  type="button"
                                  className={[
                                    "inline-flex items-center gap-1 rounded-md px-3 py-1 text-sm shadow-sm",
                                    pickDisabled ? "bg-slate-100 text-slate-400 cursor-not-allowed" : "bg-emerald-100 text-emerald-800 hover:bg-emerald-200",
                                  ].join(' ')}
                                  disabled={pickDisabled}
                                  onClick={() => {
                                    if (pickDisabled) return;
                                    console.log('[Aspect.pickAll]', { aspect: group.slug });
                                    setEntries((prev) => {
                                      const next = { ...prev } as Record<string, number>;
                                      let pages = totalQty;
                                      const typeRoom: Record<SpellType, number> = { ...(remainingByType as any) };
                                      let astralRoom = Math.max(0, astralCap - counts.Astral);
                                      let shadowRoom = Math.max(0, shadowCap - counts.Shadow);
                                      let holyBlockedAlerted = false;
                                      for (const card of group.cards) {
                                        if (isReferenceCard(card)) continue;
                                        const locked = !unlocksSet.has(card.aspect) && !isBasicAspect(card.aspect);
                                        if (locked) continue;
                                        if (darkArtsActive && card.type === 'Holy') {
                                          if (!holyBlockedAlerted) {
                                            alert('Dark Arts is active. Holy spells cannot be added to the Grimoire.');
                                            holyBlockedAlerted = true;
                                          }
                                          next[card.id] = 0;
                                          continue;
                                        }
                                        const current = next[card.id] || 0;
                                        const effectiveMax = effectiveMaxCopies[card.id] ?? card.maxCopies;
                                        const add = Math.max(0, effectiveMax - current);
                                        if (add <= 0) { continue; }
                                        if (card.type === 'Astral') {
                                          if (astralRoom <= 0) continue;
                                          const n = Math.min(add, astralRoom);
                                          next[card.id] = current + n; astralRoom -= n; continue;
                                        }
                                        if (card.type === 'Shadow') {
                                          if (shadowRoom <= 0) continue;
                                          const n = Math.min(add, shadowRoom);
                                          next[card.id] = current + n; shadowRoom -= n; continue;
                                        }
                                        const roomTotal = Math.max(0, pageLimit - pages);
                                        const roomType = Math.max(0, (typeRoom[card.type] ?? 0));
                                        const room = Math.min(roomTotal, roomType);
                                        if (room <= 0) continue;
                                        const n = Math.min(add, room);
                                        pages += n;
                                        typeRoom[card.type] = Math.max(0, (typeRoom[card.type] ?? 0) - n);
                                        next[card.id] = current + n;
                                      }
                                      return next;
                                    });
                                  }}
                                >
                                  PICK ALL
                                </button>
                                <button
                                  type="button"
                                  className={[
                                    "inline-flex items-center gap-1 rounded-md px-3 py-1 text-sm shadow-sm",
                                    allZero ? "bg-slate-100 text-slate-400 cursor-not-allowed" : "bg-rose-100 text-rose-800 hover:bg-rose-200",
                                  ].join(' ')}
                                  disabled={allZero}
                                  onClick={() => {
                                    if (allZero) return;
                                    console.log('[Aspect.removeAll]', { aspect: group.slug });
                                    setEntries((prev) => {
                                      const next = { ...prev } as Record<string, number>;
                                      for (const card of group.cards) {
                                        next[card.id] = 0;
                                      }
                                      return next;
                                    });
                                  }}
                                >
                                  REMOVE ALL
                                </button>
                              </>
                            );
                          })()}
                        </div>
                        <div className="divide-y px-3 md:px-5 lg:px-7 max-w-xl mx-auto rounded-2xl">
                          {group.cards.map((card) => {
                            const qty = entries[card.id] || 0;
                            const locked = !unlocksSet.has(card.aspect) && !isBasicAspect(card.aspect);
                            return (
                              <CardRow
                                key={card.id}
                                card={card}
                                qty={qty}
                                locked={locked}
                                readOnly={isReferenceCard(card)}
                                onChange={(n) => setQty(card.id, n)}
                                onPreview={async (c) => { console.log('[App.setPreviewCard]', c.id); prefetchCardImage(c.id, 0); setPreviewCard(c); }}
                                remainingSlots={Math.max(0, pageLimit - totalQty)}
                                remainingTypeSlots={remainingByType[card.type] ?? Number.POSITIVE_INFINITY}
                                onCapAttempt={showCapAttempt}
                              />
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Summary + Grimoire (sticky on desktop) */}
          <div className="space-y-4 lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100vh-2rem)] lg:overflow-auto lg:pr-1">
            <div className="bg-slate-100 dark:bg-slate-800 rounded-2xl p-4 shadow-sm">
              <h3 className="font-semibold mb-2 text-center">Grimoire Summary:</h3>
              <div className="text-center font-mono whitespace-pre-wrap">
                <div className="text-lg">{totalCopies} Spells in Grimoire</div>
                <div className="flex items-center justify-center gap-6 text-sm font-medium mt-1">
                  <span>Pages: {totalQty}</span>
                </div>
                <div className="flex items-center justify-center gap-6 mt-2">
                  <span className={capAttempt === 'Holy' ? 'text-red-600 font-bold' : undefined}>
                    [Holy]: {counts.Holy}{darkArtsActive ? ' (blocked)' : ''}{'\u00A0\u00A0\u00A0'}
                  </span>
                  <span className={capAttempt === 'Light' ? 'text-red-600 font-bold' : undefined}>
                    [Light]: {counts.Light}{'\u00A0\u00A0\u00A0'}
                  </span>
                  <span className={capAttempt === 'Dark' ? 'text-red-600 font-bold' : undefined}>
                    [Dark]: {counts.Dark}
                  </span>
                </div>
                <div className="mt-1 text-sm font-medium">
                  <span className={inkTotal === inkTarget ? undefined : 'text-red-600 font-semibold'}>
                    INK: {inkTotal}/{inkTarget}
                  </span>
                </div>
                {(hasAstral || hasShadow) && (
                  <div className="mt-1 text-sm">{extraSummaryLine}</div>
                )}
                <div className="mt-1 text-xs text-slate-600 dark:text-slate-300">Copy limits apply. Deck is valid at INK 75.</div>
                <div className="mt-1 text-xs text-slate-600 dark:text-slate-300">Type caps: Holy {TYPE_LIMITS.Holy} · Light {TYPE_LIMITS.Light} · Dark {TYPE_LIMITS.Dark}</div>
                <div className="mt-2 text-xs text-slate-600 dark:text-slate-300">
                  <span className="block">Focus spells start loaded; remove any to make room for other spells.</span>
                  <span className="block">Default load: {defaultPages} Focus spells. Remove cards to tailor your Grimoire.</span>
                </div>
                {darkArtsActive && (
                  <div className="mt-1 text-sm text-red-600 font-semibold">
                    Dark Arts active: All 3 Dark Arts are allowed, but [Holy] spells are blocked.
                  </div>
                )}
              </div>

            </div>

            <div className="bg-slate-100 dark:bg-slate-800 rounded-2xl p-4 shadow-sm">
              <h3 className="font-semibold mb-3 text-center">Grimoire Contents</h3>
              <div className="text-xs text-center text-slate-600 dark:text-slate-300 mb-2">
              </div>
              {(() => {
                const expanded = Object.entries(entries)
                  .filter(([_, q]) => (q || 0) > 0)
                  .map(([id, qty]) => ({ qty: qty || 0, card: cards.find(c => c.id === id)! }))
                  .filter(x => x.card && !isReferenceCard(x.card));
                const types: SpellType[] = ['Holy','Light','Dark','Curse','Astral','Shadow'];
                const shouldShow = (t: SpellType) => {
                  if (t === 'Astral' && !hasAstral) return false;
                  if (t === 'Shadow' && !hasShadow) return false;
                  return true;
                };
                return (
                  <div className="space-y-3">
                    {types.filter(shouldShow).map((t) => {
                      const items = expanded.filter(x => x.card.type === t)
                        .sort((A,B)=>{
                          if (A.card.rank !== B.card.rank) return A.card.rank - B.card.rank;
                          return A.card.name.localeCompare(B.card.name);
                        });
                      if (items.length === 0) return null;
                      const total = items.reduce((a, r) => a + r.qty, 0);
                      return (
                        <details key={t} className="rounded-lg border border-slate-300 dark:border-slate-700">
                          <summary className="cursor-pointer list-none px-3 py-2 flex items-center justify-between bg-white dark:bg-slate-900 rounded-lg">
                            <span className="font-semibold">[{t}]</span>
                            <span className="text-sm text-slate-600 dark:text-slate-300">{total} copies</span>
                          </summary>
                          <div className="p-3">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              {items.map(({ qty, card }) => (
                                <button
                                  key={card.id}
                                  type="button"
                                  className="flex w-full items-center justify-between gap-3 rounded px-3 py-2 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 text-left cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-100 dark:focus-visible:ring-offset-slate-900"
                                  onClick={() => { prefetchCardImage(card.id, 0); setPreviewCard(card); }}
                                  onMouseEnter={() => prefetchCardImage(card.id, 1)}
                                  onFocus={() => prefetchCardImage(card.id, 1)}
                                >
                                  <span className="font-semibold text-indigo-700 dark:text-indigo-200 underline decoration-2 decoration-indigo-400 dark:decoration-indigo-300 underline-offset-2">
                                    {card.name}
                                  </span>
                                  <span className="text-xs text-slate-500 dark:text-slate-300 whitespace-nowrap">
                                    {((card.type as any) === 'Travel' ? 'MP' : 'INK')}: {card.rank} · x{qty}
                                  </span>
                                </button>
                              ))}
                            </div>
                          </div>
                        </details>
                      );
                    })}
                    {types.filter(shouldShow).every(t => expanded.filter(x=>x.card.type===t).length===0) && (
                      <div className="text-sm text-center text-slate-500">No spells chosen yet.</div>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        </section>
        <br />
        <br />
        <br />
        <footer className="text-xs text-slate-500 pt-2 text-center">
         
        </footer>
      </div>

      {showUnlock && <UnlockModal onRedeem={redeem} onClose={() => setShowUnlock(false)} />}
      {showLibrary && createPortal(
        <div className="fixed inset-0 z-[10000] bg-black/70 flex items-center justify-center p-4" onClick={()=>setShowLibrary(false)}>
          <div className="bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 rounded-2xl shadow-2xl w-full max-w-5xl p-6 border border-slate-200 dark:border-slate-700 max-h-[80vh] overflow-y-auto" onClick={(e)=>e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold">Pre-Bound Grimoire Library</h3>
              <button className="rounded-lg px-3 py-1 bg-slate-100 hover:bg-slate-200 text-slate-900 border border-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 dark:border-slate-700" onClick={()=>setShowLibrary(false)}>Close</button>
            </div>
            <div className="text-sm text-slate-600 dark:text-slate-300 mb-4">
              A Pre-Bound Grimoire can only be chosen once you’ve unlocked its Aspects.
            </div>
            {(() => {
              const nameByAspect: Record<string, string> = Object.fromEntries(aspects.map(a => [a.slug, a.name] as const));
              const chipClassForAspect = (slug: string): string => {
                const a = aspects.find(x => x.slug === slug);
                const s = (slug || '').toLowerCase();
                // Basics — Green
                if (a?.isBasic || s === 'focus' || s === 'study') return 'bg-emerald-200 text-emerald-900 dark:bg-emerald-400/35 dark:text-emerald-100';
                // Dark Arts — Dark Red
                if (a?.isDark || s === 'blood' || s === 'pain' || s === 'terror' || s === 'shadows') return 'bg-rose-300 text-rose-900 dark:bg-rose-700/20 dark:text-rose-200';
                // Starlight — Purple
                if (s === 'starlight') return 'bg-violet-200 text-violet-900 dark:bg-violet-700/20 dark:text-violet-200';
                // Shadows — Gray
                if (s === 'shadows') return 'bg-slate-300 text-slate-900 dark:bg-slate-600/40 dark:text-slate-100';
                // Madness and Energy — Orange
                if (s === 'madness' || s === 'energy') return 'bg-amber-200 text-amber-900 dark:bg-amber-600/20 dark:text-amber-200';
                // All others — Aqua
                return 'bg-cyan-200 text-cyan-900 dark:bg-cyan-600/20 dark:text-cyan-200';
              };

              // helpers to expand spell list and compute stats
              function expandGrimoire(g: PreboundGrimoire) {
                try {
                  const norm = (s:string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
                  const flat = (s:string) => norm(s).replace(/_/g,'');
                  const idIndex: Record<string,string> = (()=>{
                    const idx: Record<string,string> = {};
                    for (const c of cards) {
                      const id = c.id; idx[id]=id; idx[id.toLowerCase()]=id; idx[norm(id)]=id; idx[flat(id)]=id;
                    }
                    return idx;
                  })();
                  const resolveId = (raw:string|undefined) => {
                    if (!raw) return undefined; const key=raw.trim(); const n=norm(key); const f=flat(key);
                    return idIndex[key] || idIndex[key.toLowerCase()] || idIndex[n] || idIndex[f];
                  };
                  const items = (g.spellCards || []).map((raw:any) => {
                    let id: string | undefined; let count = 1;
                    if (typeof raw === 'string') {
                      const m = raw.split(':'); id = (m[0]||'').trim();
                      if (m.length>1) { const n=parseInt((m[1]||'1').trim(),10); if(Number.isFinite(n)&&n>0) count=n; }
                    } else if (raw && typeof raw === 'object') {
                      id = (raw as any).id; const n=parseInt(String((raw as any).count ?? '1'),10); if(Number.isFinite(n)&&n>0) count=n;
                    }
                    const cid = resolveId(id);
                    const card = cid ? cards.find(c=>c.id===cid) : undefined;
                    return card ? { card, count } : null;
                  }).filter(Boolean) as { card: Card; count: number }[];
                  let pages = 0; let maxRank = 0; let fragmentsOk = true;
                  for (const {card, count} of items) {
                    if (card.type !== 'Astral' && card.type !== 'Shadow') pages += count;
                    if (card.rank > maxRank) maxRank = card.rank;
                    if (card.rank > 2 && count > 1) fragmentsOk = false;
                  }
                  return { items, pages, maxRank, fragmentsOk };
                } catch (e) {
                  console.warn('[Library.expandGrimoire] failed to parse prebound', g?.id, e);
                  return { items: [], pages: 0, maxRank: 1, fragmentsOk: true };
                }
              }

              const eligible = prebounds
                .slice()
                .sort((a,b)=>{
                  const ra = a.recommended?1:0, rb=b.recommended?1:0; if (ra!==rb) return rb-ra; // recommended first
                  return (a.name||'').localeCompare(b.name||'');
                })
                .filter(g => canUseGrimoire(g))
                .map(g => ({ g, meta: expandGrimoire(g) }))
                .filter(({meta}) => !fragmentsModeActive || meta.fragmentsOk);
              if (eligible.length===0) {
                return <div className="text-sm text-center text-slate-500">No Pre-Bound Grimoires are available with your current unlocks.</div>;
              }
              return (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {eligible.map(({g, meta}) => {
                    const cardsIn = meta.items.map(i=>i.card);
                    const rks = cardsIn.map(c=>c.rank);
                    const minR = rks.length? Math.min(...rks) : 1;
                    const maxR = meta.maxRank || 1;
                    const cover = cardsIn.slice(0,6);
                    // Determine which aspects to display: ALWAYS derive from cards actually present
                    const aspectList = Array.from(new Set(cardsIn.map(c=>c.aspect)));
                    const aspectLabel = aspectList.map(s=>nameByAspect[s] || (s.replace(/_/g,' ')||s)).join(' + ');
                    const badges: React.ReactNode[] = [];
                    if (g.recommended) badges.push(<span key="rec" className="text-xs px-2 py-0.5 rounded-full bg-indigo-600 text-white">Recommended</span>);
                    if (fragmentsModeActive && meta.fragmentsOk) badges.push(<span key="frag" className="text-xs px-2 py-0.5 rounded-full bg-emerald-600 text-white">Fragments Compatible</span>);
                    return (
                      <div key={g.id} className={["rounded-xl border p-3 bg-white/80 dark:bg-slate-900/50", g.recommended? 'border-indigo-500 ring-1 ring-indigo-300 dark:ring-indigo-700':'border-slate-300 dark:border-slate-700'].join(' ')}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="font-semibold text-lg">{g.name}</div>
                          <div className="flex items-center gap-1 flex-wrap">{badges}</div>
                        </div>
                        {g.description && (
                          <div className="text-sm text-slate-700 dark:text-slate-200 mt-1">{g.description}</div>
                        )}
                        <div className="text-xs text-slate-600 dark:text-slate-300 mt-1">Ranks {minR}–{maxR}</div>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {aspectList.map(s => (
                            <span key={s} className={`text-[10px] px-2 py-0.5 rounded-full ${chipClassForAspect(s)}`}>{nameByAspect[s]|| (s.replace(/_/g,' ')||s)}</span>
                          ))}
                        </div>
                        {g.loreTagline && (
                          <div className="text-xs italic text-slate-500 dark:text-slate-400 mt-1">{g.loreTagline}</div>
                        )}
                        {/* Pages dropdown: list card names and counts (no images) */}
                        <div className="mt-2">
                          <details className="rounded-lg border border-slate-300 dark:border-slate-700">
                            <summary className="list-none cursor-pointer flex items-center justify-between px-3 py-2 rounded-lg bg-white/70 dark:bg-slate-800/60">
                              <span className="font-semibold text-sm">Pages</span>
                              <span aria-hidden>▾</span>
                            </summary>
                            <div className="p-3 text-sm space-y-1">
                              {meta.items.map(({card, count}) => (
                                <div key={card.id} className="flex items-center justify-between gap-2">
                                  <div className="truncate">{card.name}</div>
                                  <div className="text-slate-600 dark:text-slate-300">x{count}</div>
                                </div>
                              ))}
                              {meta.items.length===0 && (
                                <div className="text-slate-500">(no cards)</div>
                              )}
                            </div>
                          </details>
                        </div>
                        <div className="mt-3 flex items-center justify-between">
                          <button
                            className="rounded px-3 py-1.5 bg-indigo-600 text-white hover:bg-indigo-700"
                            onClick={()=>bindGrimoire(g)}
                          >
                            Bind This Grimoire
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        </div>,
        document.body
      )}
      {showDecks && (
        createPortal(
          <div className="fixed inset-0 z-[10000] bg-black/70 flex items-center justify-center p-4" onClick={() => setShowDecks(false)}>
            <div className="bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 rounded-2xl shadow-2xl w-full max-w-4xl p-6 border border-slate-200 dark:border-slate-700 max-h-[70vh] overflow-y-auto" onClick={(e)=>e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xl font-bold">My Grimoires</h3>
                <button className="rounded-lg px-3 py-1 bg-slate-100 hover:bg-slate-200 text-slate-900 border border-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 dark:border-slate-700" onClick={()=>setShowDecks(false)}>Close</button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <div className="font-semibold">Save / Update</div>
                  <div className="flex gap-2">
                    <input value={deckName} onChange={e=>setDeckName(e.target.value)} placeholder="Grimoire name" className="flex-1 rounded border px-3 py-2 bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100 border-slate-300 dark:border-slate-700" />
                    <button className="rounded px-3 py-2 bg-indigo-600 text-white hover:bg-indigo-700" onClick={()=>{ if(deckName.trim()) saveDeck(deckName.trim()); }}>Save</button>
                  </div>
                  <div className="font-semibold mt-4">Share</div>
                  <div className="flex gap-2">
                    <button
                      className={`rounded px-3 py-2 border border-slate-300 dark:border-slate-700 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 ${shareBusy ? 'opacity-60 cursor-wait' : ''}`}
                      disabled={shareBusy}
                      onClick={handleCopyShareCode}
                    >
                      {shareBusy ? 'Saving...' : 'Copy to Clipboard'}
                    </button>
                    <button
                      className={`rounded px-3 py-2 border border-slate-300 dark:border-slate-700 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 ${loadBusy ? 'opacity-60 cursor-wait' : ''}`}
                      disabled={loadBusy}
                      onClick={handleLoadShareCode}
                    >
                      {loadBusy ? 'Loading...' : 'Enter Code'}
                    </button>
                  </div>
                  <div
                    className="mt-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-600 dark:bg-emerald-900 dark:text-emerald-200"
                    aria-live="assertive"
                  >
                    <label htmlFor="share-code-input" className="font-semibold">
                      Share Code
                    </label>
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                      <input
                        id="share-code-input"
                        ref={shareCodeInputRef}
                        value={shareCodeInput}
                        onChange={(event) => {
                          setShareCodeInput(event.target.value);
                          setShareCodeError(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            submitShareCode();
                          }
                        }}
                        autoComplete="off"
                        spellCheck={false}
                        inputMode="text"
                        placeholder="AAA-BBB-CCC"
                        className="flex-1 rounded border border-emerald-300 px-3 py-2 text-base text-slate-900 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-400 disabled:opacity-60 dark:border-emerald-700 dark:bg-slate-900/60 dark:text-slate-100"
                        disabled={loadBusy}
                      />
                      <button
                        type="button"
                        className="inline-flex items-center justify-center rounded px-3 py-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60"
                        onClick={submitShareCode}
                        disabled={loadBusy}
                      >
                        {loadBusy ? 'Loading…' : 'Enter'}
                      </button>
                    </div>
                    {shareCodeError ? (
                      <div className="mt-2 text-xs font-semibold text-rose-600 dark:text-rose-300">
                        {shareCodeError}
                      </div>
                    ) : (
                      <div className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">
                        Paste your code and press Enter or click Enter.
                        <div className="mt-1">(Codes expire after 60 days)</div>
                      </div>
                    )}
                  </div>
                  {shareFeedback && (
                    <div
                      className="mt-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-600 dark:bg-emerald-900 dark:text-emerald-200"
                      aria-live="polite"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">
                          {shareFeedback.copied
                            ? 'Code copied to clipboard.'
                            : 'Copy this code to your clipboard.'}
                        </span>
                        <span>
                          {shareFeedback.mode === 'api'
                            ? 'Cloud backup saved for this grimoire.'
                            : 'Offline share code generated.'}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <code className="rounded bg-white px-2 py-1 font-mono text-base text-slate-900 shadow-sm dark:bg-slate-900/60 dark:text-slate-100">
                          {shareFeedback.code}
                        </code>
                        {shareFeedback.copied ? (
                          <span className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                            Copied
                          </span>
                        ) : (
                          <button
                            className="rounded px-2 py-1 text-sm font-medium text-white transition-colors bg-emerald-600 hover:bg-emerald-700"
                            onClick={retryShareCopy}
                          >
                            Copy code
                          </button>
                        )}
                      </div>
                      <div className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">
                        (Codes expire after 60 days)
                      </div>
                    </div>
                  )}
                  <div className="font-semibold mt-4">Export</div>
                  <button className="rounded px-3 py-2 bg-slate-100 hover:bg-slate-200 border border-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 dark:border-slate-700" onClick={()=>exportPdf(deckName)}>Export as PDF</button>
                </div>
                <div>
                  <div className="font-semibold mb-2">Saved <span
                    className="align-baseline inline-block px-1 cursor-pointer select-none"
                    title="Grimoires"
                    onClick={(e)=>{ e.preventDefault(); e.stopPropagation(); setShowDecks(false); setShowAdmin(true);} }
                  >Grimoires</span></div>
                  <div className="space-y-2 max-h-[22rem] md:max-h-[24rem] overflow-auto">
                    {decks.map(d => (
                      <div key={d.name} className="flex items-center gap-2 border rounded px-3 py-2 border-slate-300 dark:border-slate-700">
                        <div className="flex-1 whitespace-normal break-words">{d.name}</div>
                        <button className="rounded px-2 py-1 bg-indigo-600 text-white hover:bg-indigo-700" onClick={()=>loadDeck(d.name)}>Load</button>
                        <button className="rounded px-2 py-1 bg-slate-100 hover:bg-slate-200 border border-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 dark:border-slate-700" onClick={()=>{ const nn=prompt('Rename grimoire', d.name); if(nn&&nn.trim()) renameDeck(d.name, nn.trim()); }}>Rename</button>
                        <button className="rounded px-2 py-1 bg-rose-600 text-white hover:bg-rose-700" onClick={()=>{ if(confirm('Delete grimoire?')) deleteDeck(d.name); }}>Delete</button>
                      </div>
                    ))}
                    {decks.length===0 && (<div className="text-sm text-slate-500">No saved grimoires yet.</div>)}
                  </div>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )
      )}

      {showAdmin && createPortal(
        <div className="fixed inset-0 z-[10001] bg-black/70 flex items-center justify-center p-4" onClick={()=>{ setShowAdmin(false); setAdminUnlocked(false); setAdminCode(''); }}>
          <div className="bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 rounded-2xl shadow-2xl w-full max-w-3xl p-6 border border-slate-200 dark:border-slate-700 max-h-[70vh] overflow-y-auto" onClick={(e)=>e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold">Admin Panel</h3>
              <button className="rounded-lg px-3 py-1 bg-slate-100 hover:bg-slate-200 text-slate-900 border border-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 dark:border-slate-700" onClick={()=>{ setShowAdmin(false); setAdminUnlocked(false); setAdminCode(''); }}>Close</button>
            </div>
            {!adminUnlocked ? (
              <div>
                <div className="text-sm mb-2">Enter admin password</div>
                <PasswordGate onVerify={async (input)=>{
                  try {
                    const digest = await sha256Hex(input.trim().toUpperCase());
                    const target = (function(){ const a='e9572d5cca2216667bf710327e0812ec438ba0f0828eda1d7e'; const b='b1d536515496af'; return a+b; })();
                    const ok = digest === target;
                    if (!ok) setAdminPwError('Incorrect password'); else setAdminPwError(null);
                    if (ok) setAdminUnlocked(true);
                    return ok;
                  } catch { setAdminPwError('Error verifying password'); return false; }
                }} error={adminPwError} />
              </div>
            ) : (
              <div className="space-y-6">
                {/* Manage Cloud */}
                <div className="rounded-xl border border-slate-300 dark:border-slate-700 p-4">
                  <div className="font-semibold mb-1">Manage Cloud</div>
                  <div className="text-sm text-slate-600 dark:text-slate-300">
                    API Base: <code className="px-1 rounded bg-slate-100 dark:bg-slate-800">{SHARE_API_ENABLED ? shareApiUrl('') : '(disabled)'}</code>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      className="rounded px-3 py-2 bg-slate-100 hover:bg-slate-200 border border-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 dark:border-slate-700"
                      onClick={async()=>{
                        try {
                          const list = await (async()=>{
                            try { return await (SHARE_API_ENABLED? (await fetch(shareApiUrl('grimoires'))).json(): null); } catch { return null; }
                          })();
                          const items = (list && Array.isArray(list.items)) ? list.items : [];
                          alert(SHARE_API_ENABLED ? `Cloud reachable. Grimoires: ${items.length}` : 'Cloud disabled. Set VITE_SHARE_API_BASE to enable.');
                        } catch (e) {
                          alert('Cloud test failed. See console for details.');
                          console.error('[Admin][CloudTest]', e);
                        }
                      }}
                    >
                      Test Cloud (/grimoires)
                    </button>
                    <div className="text-xs text-slate-600 dark:text-slate-300">Reads only; writes require admin headers.</div>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      className="rounded px-3 py-2 bg-slate-100 hover:bg-slate-200 border border-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 dark:border-slate-700"
                      onClick={async()=>{
                        try {
                          const list = await listCloudGrimoires();
                          if (!list) { alert('Cloud list failed or disabled.'); return; }
                          setCloudList(list);
                          setCloudToast({ type: 'info', text: `Cloud Grimoires: ${list.length}` });
                        } catch (e) {
                          console.error('[Admin][CloudList]', e);
                          alert('Failed to list cloud grimoires.');
                        }
                      }}
                    >
                      List Cloud Grimoires
                    </button>
                    <div className="text-xs text-slate-600 dark:text-slate-300">Shows ids and names for quick debug.</div>
                  </div>
                  {cloudList && (
                    <div className="mt-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white/60 dark:bg-slate-900/40 p-2 max-h-40 overflow-auto text-xs">
                      {cloudList.length === 0 ? (
                        <div className="text-slate-500">(empty)</div>
                      ) : (
                        cloudList.map((g)=> (
                          <div key={g.id} className="flex items-center justify-between gap-2">
                            <div className="truncate"><span className="font-mono">{g.id}</span> — {g.name || '(no name)'} </div>
                            <div className="text-slate-500">{Array.isArray(g.spellCards)? g.spellCards.length: 0} cards</div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                  {/* Admin paste credentials removed per request */}
                </div>
                <div className="flex items-center justify-between">
                  <div className="font-semibold">Aspects</div>
                  <div className="flex gap-2">
                    <button className="rounded px-2 py-1 bg-slate-100 hover:bg-slate-200 border border-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 dark:border-slate-700" onClick={()=>{
                      const next: Record<string, boolean> = {};
                      for (const a of aspects) next[a.slug] = true;
                      setAdminSelected(next);
                    }}>Select All</button>
                    <button className="rounded px-2 py-1 bg-slate-100 hover:bg-slate-200 border border-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 dark:border-slate-700" onClick={()=>setAdminSelected({})}>Clear All</button>
                  </div>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                  {aspects.map(a => (
                    <label key={a.slug} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" className="rounded" checked={!!adminSelected[a.slug]} onChange={(e)=>{
                        const checked = e.target.checked; setAdminSelected(prev=> ({...prev, [a.slug]: checked}));
                      }} />
                      <span>{a.name}</span>
                    </label>
                  ))}
                </div>
                <div className="flex items-end gap-2">
                  <div>
                    <label className="text-sm">Expires In</label>
                    <div className="flex gap-2">
                      <input type="number" min={1} step={1} value={adminDuration} onChange={(e)=>setAdminDuration(Math.max(1, parseInt(e.target.value||'1',10)))} className="w-24 rounded border px-3 py-2 bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100 border-slate-300 dark:border-slate-700" />
                      <select value={adminUnit} onChange={(e)=>setAdminUnit(e.target.value as any)} className="rounded border px-3 py-2 bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100 border-slate-300 dark:border-slate-700">
                        <option value="minutes">minutes</option>
                        <option value="hours">hours</option>
                        <option value="days">days</option>
                      </select>
                    </div>
                  </div>
                  <div className="flex-1" />
                  <button className="rounded px-3 py-2 bg-indigo-600 text-white hover:bg-indigo-700" onClick={async ()=>{
                    try {
                      const slugs = Object.entries(adminSelected).filter(([,v])=>v).map(([k])=>k);
                      if (slugs.length===0) { alert('Select at least one aspect.'); return; }
                      const now = Date.now();
                      let delta = adminDuration;
                      if (adminUnit==='minutes') delta *= 60*1000; else if (adminUnit==='hours') delta *= 60*60*1000; else delta*=24*60*60*1000;
                      const exp = now + delta;
                      const { code } = await createAdminCode(slugs, exp);
                      setAdminCode(code);
                    } catch (err) {
                      console.error('[Admin] Generate code error', err);
                      alert('Failed to generate code. See console for details.');
                    }
                  }}>Generate Code</button>
                </div>
                {adminCode && (
                  <div className="rounded-lg border border-slate-300 dark:border-slate-700 p-3 bg-white/60 dark:bg-slate-900/40">
                    <div className="text-sm mb-2">Admin Code</div>
                    <div className="flex items-center gap-2">
                      <code className="rounded bg-white px-2 py-1 font-mono text-base text-slate-900 shadow-sm dark:bg-slate-900/60 dark:text-slate-100">{adminCode}</code>
                      <button className="rounded px-2 py-1 bg-slate-100 hover:bg-slate-200 border border-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 dark:border-slate-700" onClick={async()=>{ try{ await navigator.clipboard.writeText(adminCode);}catch{} }}>Copy</button>
                    </div>
                    <div className="text-xs text-slate-600 dark:text-slate-300 mt-1">This code unlocks selected Aspects until the expiry time.</div>
                  </div>
                )}

                {/* Pre-Bound Grimoire Editor */}
                <div className="rounded-xl border border-slate-300 dark:border-slate-700 p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-semibold">Create Pre-Bound Grimoire</div>
                    <div className="flex items-center gap-2">
                      <button className="rounded px-2 py-1 bg-slate-100 hover:bg-slate-200 border border-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 dark:border-slate-700" onClick={()=>{ setPreboundForm({ id:'', name:'', description:'', aspects:[], spellCards:[], recommended:false, loreTagline:'' }); setPreboundEditId(null); }}>Clear</button>
                      <button className="rounded px-2 py-1 bg-emerald-600 text-white hover:bg-emerald-700" onClick={()=>downloadAllPrebounds()}>Download JSON (All)</button>
                    </div>
                  </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <label className="block text-sm">Name</label>
                    <input className="w-full rounded border px-3 py-2 bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100 border-slate-300 dark:border-slate-700" value={preboundForm.name} onChange={(e)=>{ const name=e.target.value; setPreboundForm(prev=>({...prev, name, id: prev.id || slugify(name)})); }} />
                  </div>
                  <div className="space-y-2">
                    <label className="block text-sm">ID (slug)</label>
                    <input className="w-full rounded border px-3 py-2 bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100 border-slate-300 dark:border-slate-700" value={preboundForm.id} onChange={(e)=>setPreboundForm(prev=>({...prev, id: slugify(e.target.value)}))} />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <label className="block text-sm">Description</label>
                    <textarea rows={2} className="w-full rounded border px-3 py-2 bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100 border-slate-300 dark:border-slate-700" value={preboundForm.description||''} onChange={(e)=>setPreboundForm(prev=>({...prev, description: e.target.value}))} />
                  </div>
                  {/* Source: copy from current grimoire */}
                  <div className="space-y-2 md:col-span-2">
                    <label className="block text-sm">Source</label>
                    <div className="rounded-lg border border-slate-300 dark:border-slate-700 p-3 bg-white/60 dark:bg-slate-900/40">
                      <div className="text-sm flex flex-wrap items-center gap-3">
                        <span>Current Grimoire:</span>
                        <span className="font-mono">{currentDeckStats.total} spells</span>
                        <span className="font-mono">[H {counts.Holy}] [L {counts.Light}] [D {counts.Dark}]</span>
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          className="rounded px-3 py-2 bg-slate-100 hover:bg-slate-200 border border-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 dark:border-slate-700"
                          disabled={false}
                          onClick={()=>{
                            // Build from current deck state
                          // Copy ALL aspects from current build (basics + non-basics)
                          const aspectsList = Array.from(new Set([...(basicsSelected||[]), ...(chosenAspects||[])]));
                            const cardsList: string[] = [];
                            for (const [id, qty] of Object.entries(entries)) {
                              const q = qty || 0; if (q<=0) continue;
                              cardsList.push(`${id}:${q}`);
                            }
                            setPreboundForm(prev=> ({
                              ...prev,
                              aspects: aspectsList,
                              spellCards: cardsList,
                            }));
                          }}
                        >
                          Copy from current grimoire
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="block text-sm">Lore / Flavor (optional)</label>
                    <input className="w-full rounded border px-3 py-2 bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100 border-slate-300 dark:border-slate-700" value={preboundForm.loreTagline||''} onChange={(e)=>setPreboundForm(prev=>({...prev, loreTagline: e.target.value}))} />
                  </div>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" className="rounded" checked={!!preboundForm.recommended} onChange={(e)=>setPreboundForm(prev=>({...prev, recommended: e.target.checked}))} />
                    <span className="text-sm">Recommended</span>
                  </label>
                </div>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      className="rounded px-3 py-2 bg-indigo-600 text-white hover:bg-indigo-700"
                      onClick={()=>{
                        const g: PreboundGrimoire = {
                          id: preboundForm.id || slugify(preboundForm.name || 'grimoire'),
                          name: preboundForm.name || 'Untitled',
                          description: preboundForm.description || '',
                          aspects: Array.from(new Set(preboundForm.aspects||[])),
                          spellCards: (preboundForm.spellCards||[]).filter(Boolean),
                          recommended: !!preboundForm.recommended,
                          loreTagline: preboundForm.loreTagline || ''
                        };
                        if (!g.id || !g.name) { alert('Name and ID are required.'); return; }
                        upsertLocalPrebound(g);
                        setPreboundEditId(g.id);
                        if (SHARE_API_ENABLED) {
                          alert('Saved to Cloud (AWS). A new code may be issued; latest is used automatically.');
                        } else {
                          alert('Saved locally. Use "Download JSON (All)" to export.');
                        }
                      }}
                    >
                      {SHARE_API_ENABLED ? (preboundEditId ? 'Update Cloud' : 'Save to Cloud') : (preboundEditId ? 'Update Locally' : 'Save Locally')}
                    </button>
                    {SHARE_API_ENABLED && (
                      <div className="text-xs text-slate-600 dark:text-slate-300">
                        Cloud Code: {(typeof localStorage!=='undefined' ? (localStorage.getItem('wkw.prebounds.code')||'') : '') || (import.meta as any)?.env?.VITE_PREBOUNDS_CODE || '(none)'}
                      </div>
                    )}
                  </div>
                </div>

                {/* Existing Pre-Bound List */}
                <div className="rounded-xl border border-slate-300 dark:border-slate-700 p-4">
                  <div className="font-semibold mb-2">Existing Pre-Bound Grimoires</div>
                  <div className="space-y-2 max-h-64 overflow-auto">
                    {prebounds.map(g => {
                      const isBase = preboundsBaseIds.includes(g.id);
                      return (
                        <div key={g.id} className="flex items-center gap-2 border rounded px-3 py-2 border-slate-300 dark:border-slate-700">
                          <div className="flex-1 min-w-0">
                            <div className="font-medium truncate">{g.name}</div>
                            <div className="text-xs text-slate-600 dark:text-slate-300 truncate">{g.id} {(g.recommended? '· Recommended' : '')}</div>
                          </div>
                          <button className="rounded px-2 py-1 bg-indigo-600 text-white hover:bg-indigo-700" onClick={()=>{ setPreboundForm({ ...g }); setPreboundEditId(g.id); }}>Edit</button>
                          {!isBase && (
                            <button className="rounded px-2 py-1 bg-rose-600 text-white hover:bg-rose-700" onClick={()=>{ if(confirm('Delete this local grimoire?')) removeLocalPrebound(g.id); }}>Delete</button>
                          )}
                        </div>
                      );
                    })}
                    {prebounds.length===0 && (
                      <div className="text-sm text-slate-500">No grimoires yet.</div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
      {previewCard && (
        <CardPreviewModal
          card={previewCard}
          aspectLabel={nameByAspect[previewCard.aspect] || previewCard.aspect}
          onClose={() => setPreviewCard(null)}
        />
      )}
    </div>
  );
}
