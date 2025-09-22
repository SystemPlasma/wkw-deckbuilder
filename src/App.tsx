import React, { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import CARD_IMAGE_URLS from './imageMap';
// CSV data via Vite-managed URLs (no query strings) so builds fingerprint and refresh on deploy
const aspectsCsvUrl = new URL('./assets/data/aspects.csv', import.meta.url).href;
const cardsCsvUrl = new URL('./assets/data/cards.csv', import.meta.url).href;
// Optional remote override for codes; otherwise use local Vite asset
const __CODES_BASE = ((import.meta as any)?.env?.VITE_CODES_URL) as string | undefined;
const codesCsvUrl = __CODES_BASE || new URL('./assets/data/unlock_codes.csv', import.meta.url).href;

/** ------------------------
 * Card Data
 * ---------------------- */
type SpellType = "Holy" | "Light" | "Dark" | "Astral" | "Shadow";
// New role taxonomy (internal keys)
type Role =
  | 'power_increase'
  | 'power_reduction'
  | 'disruption'
  | 'search_draw'
  | 'counter'
  | 'movement_increase'
  | 'movement_reduction'
  | 'special'
  | 'inflict_status';

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
  roles?: Role[]; // Optional, from CSV column `roles` (comma- or semicolon-separated)
};

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
  const [aspectsRaw, cardsRaw, codesRaw] = await Promise.all([
    fetch(aspectsCsvUrl).then(r => r.ok ? r.text() : ''),
    fetch(cardsCsvUrl).then(r => r.ok ? r.text() : ''),
    fetch(codesCsvUrl).then(r => r.ok ? r.text() : ''),
  ]);

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
        const rolesField = (r.roles || r.role || '').trim();
        const toRole = (tok: string): Role | undefined => {
          const t = tok.trim().toLowerCase();
          // accept new labels
          if (['power increase','power_increase','powerincrease'].includes(t)) return 'power_increase';
          if (['power reduction','power_reduction','powerreduction','reduce power','reduction'].includes(t)) return 'power_reduction';
          if (['disruption','disrupt','disruptive'].includes(t)) return 'disruption';
          if (['search/draw','search','draw','search_draw'].includes(t)) return 'search_draw';
          if (['counter','disrupt','disruption'].includes(t)) return 'counter';
          if (['movement increase','movement_increase','speed','move','movement'].includes(t)) return 'movement_increase';
          if (['movement reduction','movement_reduction','slow','root','snare','bind'].includes(t)) return 'movement_reduction';
          if (['special'].includes(t)) return 'special';
          if (['inflict status','inflict_status','status','status effect'].includes(t)) return 'inflict_status';
          // backward compatibility
          if (t === 'combat') return 'power_increase';
          if (t === 'reveal') return 'search_draw';
          if (t === 'move') return 'movement_increase';
          return undefined;
        };
        const roles: Role[] | undefined = rolesField
          ? Array.from(new Set(
              rolesField.split(/[,;]+/).map(s => toRole(s)).filter(Boolean) as Role[]
            ))
          : undefined;
        return {
          id: r.id,
          name: r.name,
          type: (r.type as SpellType),
          rank: Number(r.rank || 0),
          maxCopies: Number(r.maxCopies || 0),
          aspect: normalizedAspect,
          roles,
        } as Card;
      }).filter(c => c.id && c.name && c.aspect)
    : undefined;

  const codes: Record<string, string> | undefined = codesRaw
    ? Object.fromEntries(
        parseCSV(codesRaw)
          .map(r => [
            (r.code || '').trim().toUpperCase(),
            (r.slug || '').trim().toLowerCase(),
          ])
          .filter(([code, slug]) => code && slug)
      )
    : undefined;

  return { aspects, cards, codes } as { aspects?: Aspect[]; cards?: Card[]; codes?: Record<string,string> };
}

const TYPE_ORDER: Record<SpellType, number> = { Holy: 5, Light: 4, Astral: 3, Shadow: 2, Dark: 1 };
const ALL_ROLES: Role[] = [
  'power_increase','power_reduction','disruption','search_draw','counter','movement_increase','movement_reduction','special','inflict_status'
];

function tokenizeName(name: string): string[] {
  const stop = new Set(['of','the','and','to','a','an','in','on','by','for','from','with','without','into','out']);
  return (name || '')
    .toLowerCase()
    .split(/[^a-z]+/g)
    .filter(t => t && t.length >= 3 && !stop.has(t));
}

/** ------------------------
 * Small UI helpers
 * ---------------------- */
function Pill({ children }: { children: React.ReactNode }) {
  return <span className="px-2 py-1 rounded-full text-xs bg-slate-200 dark:bg-slate-700 dark:text-slate-100">{children}</span>;
}

// Tooltip removed in favor of click-to-open preview modal

function AspectCard({
  aspect,
  unlocked,
  selected,
  disabled = false,
  onToggle,
}: {
  aspect: Aspect;
  unlocked: boolean;
  selected: boolean;
  disabled?: boolean;
  onToggle: () => void;
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
      </div>
    </button>
  );
}

function UnlockModal({
  onRedeem,
  onClose,
}: {
  onRedeem: (code: string) => { ok: boolean; unlockedName?: string; status?: 'ok' | 'invalid' | 'used' };
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
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const res = onRedeem(code);
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
            onClick={() => {
              console.log("[UI] Redeem clicked");
              const res = onRedeem(code);
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

function CardRow({
  card,
  qty,
  onChange,
  locked,
  onPreview,
  remainingSlots,
  remainingTypeSlots,
  onCapAttempt,
  showRoles = false,
  rolesForCard,
}: {
  card: Card;
  qty: number;
  onChange: (n: number) => void;
  locked: boolean;
  onPreview?: (card: Card) => void;
  remainingSlots: number;
  remainingTypeSlots: number;
  onCapAttempt?: (t: SpellType) => void;
  showRoles?: boolean;
  rolesForCard?: Role[];
}) {
  const countsTowardPages = card.type !== 'Astral' && card.type !== 'Shadow';
  const noRoomTotal = countsTowardPages && remainingSlots <= 0;
  const noRoomType = countsTowardPages && remainingTypeSlots <= 0;
  const addDisabled = !locked && (noRoomTotal || qty >= card.maxCopies);
  return (
    <div className="flex items-center gap-3 py-2 px-4 md:px-6 lg:px-8">
      {/* Left: name button */}
      <div className="shrink-0 font-medium text-left max-w-[38%]">
        {locked ? (
          <span className="text-slate-500">{"<Locked>"}</span>
        ) : (
          <button
            type="button"
            className="inline-flex items-center rounded px-2 py-1 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 shadow-sm dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600"
            onClick={() => { console.log('[CardRow.preview]', { id: card.id, name: card.name }); onPreview?.(card); }}
          >
            {card.name}
          </button>
        )}
        {showRoles && (
          <div className="mt-1 flex flex-wrap gap-1">
            {(() => {
              const styles: Record<Role, string> = {
                power_increase: 'bg-rose-100 text-rose-800',
                power_reduction: 'bg-rose-200 text-rose-900',
                disruption: 'bg-blue-100 text-blue-800',
                search_draw: 'bg-emerald-100 text-emerald-800',
                counter: 'bg-indigo-100 text-indigo-800',
                movement_increase: 'bg-amber-100 text-amber-800',
                movement_reduction: 'bg-amber-200 text-amber-900',
                special: 'bg-fuchsia-100 text-fuchsia-800',
                inflict_status: 'bg-cyan-100 text-cyan-800',
              };
              const labels: Record<Role,string> = {
                power_increase:'POWER Increase',
                power_reduction:'POWER Reduction',
                disruption:'Disruption',
                search_draw:'Search/Draw',
                counter:'Counter',
                movement_increase:'Movement Increase',
                movement_reduction:'Movement Reduction',
                special:'Special',
                inflict_status:'Inflict Status'
              };
              const roles = (rolesForCard && rolesForCard.length>0)
                ? rolesForCard
                : (card.roles && card.roles.length>0 ? card.roles : []);
              return roles.map((r: Role) => (
                <span key={r} className={`text-[10px] px-1.5 py-0.5 rounded ${styles[r]}`}>{labels[r]}</span>
              ));
            })()}
          </div>
        )}
      </div>
      {/* Center: type/rank/max — stacked on mobile, grouped with spacing on md+ */}
      <div className="flex-1 leading-tight text-center md:text-left md:pl-2">
        {/* Mobile: stacked */}
        <div className="md:hidden text-left pl-2">
          <div className="text-base text-slate-600 dark:text-slate-300">
            {(() => {
              const PARALLEL_IDS = new Set<string>([
                'energy_supernova_converter','energy_will_power','energy_fears_grasp','energy_rage_unleashed',
                'madness_twisted_space','madness_shattered_time','madness_splintered_mind','madness_unhinged_reality','madness_chaotic_power','madness_eclipsed_soul',
              ]);
              const mark = !locked && PARALLEL_IDS.has(card.id) ? ' (Parallel)' : '';
              return locked ? '?' : `${card.type}${mark} · R${card.rank}`;
            })()}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-300 mt-1">Max {card.maxCopies}</div>
        </div>
        {/* Desktop: single line with spacing between left (type/rank) and right (Max) */}
        <div className="hidden md:flex items-baseline justify-start gap-6">
          <span className="text-base text-slate-600 dark:text-slate-300">
            {(() => {
              const PARALLEL_IDS = new Set<string>([
                'energy_supernova_converter','energy_will_power','energy_fears_grasp','energy_rage_unleashed',
                'madness_twisted_space','madness_shattered_time','madness_splintered_mind','madness_unhinged_reality','madness_chaotic_power','madness_eclipsed_soul',
              ]);
              const mark = !locked && PARALLEL_IDS.has(card.id) ? ' (Parallel)' : '';
              return locked ? '?' : `${card.type}${mark} · R${card.rank}`;
            })()}
          </span>
          <span className="text-sm text-slate-500 dark:text-slate-300">Max {card.maxCopies}</span>
        </div>
      </div>

      {/* Right controls pinned to the far right */}
      <div className="flex items-center gap-2 shrink-0 ml-auto">
        <button
          onClick={() => { if (qty <= 0) return; const n = Math.max(0, qty - 1); console.log('[CardRow.qty-]', { id: card.id, from: qty, to: n }); onChange(n); }}
          disabled={qty <= 0}
          className={["px-2 py-1 rounded shadow-sm text-base md:text-lg font-bold text-slate-900 dark:text-slate-900 leading-none", qty <= 0 ? "bg-slate-100 opacity-50 cursor-not-allowed" : "bg-slate-100"].join(' ')}
        >
          -
        </button>
        <div className="w-8 text-center">{qty}</div>
        <button
          onClick={() => {
            if (locked) return;
            if (noRoomType) { onCapAttempt?.(card.type); return; }
            if (addDisabled) return;
            const n = Math.min(card.maxCopies, qty + 1);
            console.log('[CardRow.qty+]', { id: card.id, from: qty, to: n });
            onChange(n);
          }}
          disabled={locked || noRoomTotal || qty >= card.maxCopies}
          className={["px-2 py-1 rounded shadow-sm text-base md:text-lg font-bold text-slate-900 dark:text-slate-900 leading-none", locked || addDisabled || qty >= card.maxCopies ? "bg-slate-100 opacity-50 cursor-not-allowed" : "bg-slate-100"].join(' ')}
        >
          +
        </button>
        <button
          onClick={() => {
            if (locked) return;
            if (!countsTowardPages) {
              console.log('[CardRow.max]', { id: card.id, to: card.maxCopies });
              onChange(card.maxCopies);
              return;
            }
            const roomTotal = Math.max(0, remainingSlots);
            const roomType = Math.max(0, remainingTypeSlots);
            const room = Math.min(roomTotal, roomType);
            if (room <= 0) { if (roomType <= 0) onCapAttempt?.(card.type); return; }
            const target = Math.min(card.maxCopies, qty + room);
            console.log('[CardRow.max]', { id: card.id, from: qty, room, to: target });
            onChange(target);
          }}
          disabled={locked || noRoomTotal}
          className={["px-2 py-1 rounded shadow-sm", (locked || noRoomTotal) ? "bg-slate-100 text-slate-400 cursor-not-allowed" : "bg-indigo-100 text-indigo-800 hover:bg-indigo-200"].join(' ')}
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
  const [errored, setErrored] = useState(false);
  const url = CARD_IMAGE_URLS[card.id];

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
            <div className="text-sm text-slate-800 dark:text-slate-200">[{card.type}] · R{card.rank} · {aspectLabel}</div>
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
          {!errored && url ? (
            <img
              src={url}
              alt={`${card.name} card`}
              className="max-w-full max-h-[70vh] rounded-md shadow-md object-contain"
              onError={() => setErrored(true)}
            />
          ) : (
            <div className="text-sm text-slate-900 dark:text-slate-100 text-center">
              No image available for this card.
              <br />
              <span className="text-xs text-slate-600 dark:text-slate-300">id: {card.id}</span>
              {url ? (
                <>
                  <br />
                  <span className="text-xs text-slate-600 dark:text-slate-300">url: {url}</span>
                </>
              ) : (
                <>
                  <br />
                  <span className="text-xs text-slate-600 dark:text-slate-300">expected: src/assets/cards/{card.id}.png</span>
                </>
              )}
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

    // Build groups by type in order Holy > Light > Dark > Astral > Shadow
    const typeOrder: SpellType[] = ["Holy", "Light", "Dark", "Astral", "Shadow"];
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
          const PARALLEL_IDS = new Set<string>([
            'energy_supernova_converter','energy_will_power','energy_fears_grasp','energy_rage_unleashed',
            'madness_twisted_space','madness_shattered_time','madness_splintered_mind','madness_unhinged_reality','madness_chaotic_power','madness_eclipsed_soul',
          ]);
          const name = (aspectName || '').replace(/^Aspect of\s+/i, '');
          const tag = PARALLEL_IDS.has(card.id) ? ' (Parallel)' : '';
          return `(R${card.rank}) {${name}} ${card.name}${tag} —\u00A0x${qty}`;
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
          Holy: [], Light: [], Dark: [], Astral: [], Shadow: []
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
  // Data from CSVs
  const [aspects, setAspects] = useState<Aspect[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [codes, setCodes] = useState<Record<string,string>>({});
  const [showDecks, setShowDecks] = useState(false);
  const [deckName, setDeckName] = useState<string>("");
  const [decksTick, setDecksTick] = useState(0); // bump to refresh decks list
  const [decks, setDecks] = useState<SavedDeck[]>([]);
  const [rankPending, setRankPending] = useState<{
    next: number;
    removals: { id: string; name: string; aspect: string; rank: number; qty: number; type: SpellType }[];
  } | null>(null);
  const [showTips, setShowTips] = useState(false);
  const [showSubtypes, setShowSubtypes] = useState(false);
  const [roleFilter, setRoleFilter] = useState<Role[]>([]);
  const [useInference, setUseInference] = useState(false);

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
      } catch (e) {
        console.error('[CSV] Failed to load CSV data', e);
      }
    })();
    return () => { mounted = false; };
  }, []);

  // Build heuristics dynamically from cards that already have CSV roles.
  const roleHeuristics = useMemo(() => {
    const tokensByRole: Record<Role, Record<string, number>> = Object.fromEntries(ALL_ROLES.map(r => [r, {}])) as any;
    let anySeed = false;
    for (const c of cards) {
      if (c.roles && c.roles.length > 0) {
        anySeed = true;
        const toks = tokenizeName(c.name);
        for (const r of c.roles) {
          for (const t of toks) tokensByRole[r][t] = (tokensByRole[r][t] || 0) + 1;
        }
      }
    }
    // Select top tokens per role for light heuristic matching
    const map: Record<Role, string[]> = Object.fromEntries(ALL_ROLES.map(r => [r, []])) as any;
    for (const r of ALL_ROLES) {
      const entries = Object.entries(tokensByRole[r]);
      entries.sort((a,b)=>b[1]-a[1]);
      map[r] = entries.slice(0, 20).map(([t]) => t);
    }
    return { map, anySeed };
  }, [cards]);

  const getRoles = useCallback((c: Card): Role[] => {
    if (c.roles && c.roles.length > 0) return c.roles;
    // Infer using heuristics derived from CSV roles
    const toks = tokenizeName(c.name);
    const out: Role[] = [];
    for (const r of ALL_ROLES) {
      const list = roleHeuristics.map[r];
      if (list && list.some(t => toks.includes(t))) out.push(r);
    }
    return out;
  }, [roleHeuristics]);

  // Deck persistence and sharing
  type SavedDeck = {
    version: 1;
    name: string;
    rankCap: number;
    basicsSelected: string[];
    chosenAspects: string[];
    entries: Record<string, number>;
  };
  const LS_KEY = 'wkw.decks.v1';

  function currentDeckPayload(name: string): SavedDeck {
    return { version: 1, name, rankCap, basicsSelected, chosenAspects, entries };
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
    setRankCap(d.rankCap);
    setBasicsSelected(d.basicsSelected || []);
    setChosenAspects(d.chosenAspects || []);
    setEntries(d.entries || {});
    setDeckName(d.name || '');
    const needed = Array.from(new Set([...(d.basicsSelected||[]), ...(d.chosenAspects||[])]));
    setUnlocks(prev => Array.from(new Set([...prev, ...needed])));
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
  function makeShareCode(name: string): string { const p=currentDeckPayload(name||deckName||'My Deck'); const compact={v:1,n:p.name,r:p.rankCap,b:p.basicsSelected,c:p.chosenAspects,e:p.entries}; return toBase64Url(JSON.stringify(compact)); }
  function applyShareCode(code: string): boolean { try { const raw=JSON.parse(fromBase64Url(code)); if(!raw||raw.v!==1) return false; const d: SavedDeck={version:1,name:raw.n||'Shared Deck',rankCap:raw.r||1,basicsSelected:raw.b||[],chosenAspects:raw.c||[],entries:raw.e||{}}; setRankCap(d.rankCap); setBasicsSelected(d.basicsSelected); setChosenAspects(d.chosenAspects); setEntries(d.entries); setDeckName(d.name); const needed=Array.from(new Set([...(d.basicsSelected||[]),...(d.chosenAspects||[])])); setUnlocks(prev=>Array.from(new Set([...prev,...needed]))); return true; } catch { return false; } }
  function exportPdf(name?: string) {
    const deckTitle = name || deckName || 'My Deck';
    const nameByAspect: Record<string, string> = Object.fromEntries(aspects.map(a => [a.slug, a.name] as const));
    const expanded = Object.entries(entries)
      .filter(([_, q]) => (q || 0) > 0)
      .map(([id, qty]) => {
        const c = cards.find(x => x.id === id);
        if (!c) return null as any;
        return { qty: qty || 0, card: c, aspectName: nameByAspect[c.aspect] || c.aspect };
      })
      .filter(Boolean) as { qty: number; card: Card; aspectName: string }[];
    const types: SpellType[] = ['Holy','Light','Dark','Astral','Shadow'];
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
    const sections = types.filter(enabled).map(t => {
      const items = expanded.filter(x => x.card.type === t).sort((A,B)=>{
        if (A.card.rank !== B.card.rank) return A.card.rank - B.card.rank;
        return A.card.name.localeCompare(B.card.name);
      });
      if (items.length === 0) return '';
      const cells = items.map(({qty, card}) => {
        const url = CARD_IMAGE_URLS[card.id] || '';
        return `<div class="card"><img class="img" src="${url}" alt="${card.name}"><div class="qty">x${qty}</div></div>`;
      }).join('');
      return `<div class="section"><h2>[${t}]</h2><div class="cards">${cells}</div></div>`;
    }).join('');
    win.document.write(`<html><head><title>${deckTitle} — Deck</title><style>${css}</style></head><body><h1>${deckTitle}</h1><div class="grid">${sections}</div></body></html>`);
    win.document.close(); win.focus(); win.print();
  }
  // Unlocks (basics visible by default)
  const [unlocks, setUnlocks] = useState<string[]>(["focus", "study"]);
  const [showUnlock, setShowUnlock] = useState(false);
  // Special: if enabled via code, treat Lost as a Basic
  const [lostAsBasic, setLostAsBasic] = useState(false);

  // Selection
  const [basicsSelected, setBasicsSelected] = useState<string[]>(["focus"]); // Basics are free
  const [chosenAspects, setChosenAspects] = useState<string[]>([]); // Non-basics

  // Entries: cardId → qty
  const [entries, setEntries] = useState<Record<string, number>>({});
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
  const [rankCap, setRankCap] = useState<number>(1);

  // No persistence — removed cookies/localStorage

  // Reset all persisted state and in-memory selections
  function resetAll() {
    if (typeof window !== 'undefined' && !window.confirm('Reset unlocks, selections, and deck?')) return;
    setUnlocks(["focus", "study"]);
    setBasicsSelected(["focus"]);
    setChosenAspects([]);
    setEntries({});
    setLostAsBasic(false);
  }
  React.useEffect(() => {
    if (previewCard) {
      const url = CARD_IMAGE_URLS[previewCard.id];
      console.log('[App.preview-open]', { id: previewCard.id, url });
    } else {
      console.log('[App.preview-close]');
    }
  }, [previewCard]);

  // Derived
  const nameByAspect = useMemo(
    () => Object.fromEntries(aspects.map((a) => [a.slug, a.name] as const)),
    [aspects]
  );
  const selectedAspectSlugs = overrideAll
    ? aspects.map(a => a.slug)
    : [...basicsSelected, ...chosenAspects];

  // Min rank per aspect and eligibility against current cap
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
    return Number.isFinite(min) && (min as number) <= rankCap;
  }, [MIN_RANK_BY_ASPECT, rankCap]);

  const isBasicAspect = React.useCallback((slug: string) => {
    const a = aspects.find(x => x.slug === slug);
    return Boolean(a?.isBasic) || (lostAsBasic && slug === 'lost');
  }, [aspects, lostAsBasic]);

  // Derived from data
  const DARK_SLUGS = useMemo(() => aspects.filter(a => a.isDark).map(a => a.slug) as ReadonlyArray<string>, [aspects]);
  const ASPECT_INDEX = useMemo(() => {
    const ordered = aspects.map((a, i) => ({ a, i })).sort((A, B) => {
      const ao = A.a.order; const bo = B.a.order;
      if (ao != null && bo != null) return ao - bo;
      if (ao != null) return -1; if (bo != null) return 1;
      return A.i - B.i;
    });
    return Object.fromEntries(ordered.map((x, i) => [x.a.slug, i] as const));
  }, [aspects]);

  const allDarkTrioSelected = overrideAll ? false : (() => {
    const nonSpecial = chosenAspects.filter((s) => !aspects.find(a => a.slug === s)?.isSpecial && aspectEligible(s));
    if (nonSpecial.length !== 3) return false;
    const set = new Set(nonSpecial);
    return (DARK_SLUGS as readonly string[]).every((s) => set.has(s));
  })();

  // Enforce Dark Arts penalty by clearing any [Holy] spells when all three Dark aspects are selected
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

  function redeem(code: string): { ok: boolean; unlockedName?: string; status?: 'ok' | 'invalid' | 'used' } {
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

    const applyLostBasic = () => {
      if (lostAsBasic) { anyUsed = true; return; }
      setLostAsBasic(true);
      setChosenAspects(prev => prev.filter(s => s !== 'lost'));
      setBasicsSelected(prev => Array.from(new Set([...prev, 'lost'])));
      namesUnlocked.push('Aspect of the Lost (Basic)');
      anyNew = true;
    };

    for (const p of (parts.length ? parts : [key])) {
      const pUnderscored = p.replace(/\s+/g, '_');
      if (p === 'ENDLESS SECRETS' || pUnderscored === 'ENDLESS_SECRETS') {
        applyLostBasic();
        continue;
      }
      const slug = codes[p];
      if (!slug) { anyInvalid = true; continue; }
      if (slug === '*') {
        const before = nextUnlocks.size;
        for (const a of aspects) nextUnlocks.add(a.slug);
        if (nextUnlocks.size > before) { namesUnlocked.push('All Aspects'); anyNew = true; } else anyUsed = true;
        continue;
      }
      if (String(slug).toLowerCase() === '#dark_all') {
        const darks = aspects.filter(a => a.isDark).map(a => a.slug);
        const before = nextUnlocks.size;
        for (const s of darks) nextUnlocks.add(s);
        if (nextUnlocks.size > before) { namesUnlocked.push('Dark Arts'); anyNew = true; } else anyUsed = true;
        continue;
      }
      if (!nextUnlocks.has(slug)) {
        nextUnlocks.add(slug);
        const name = aspects.find(a => a.slug === slug)?.name || slug;
        namesUnlocked.push(name);
        anyNew = true;
      } else {
        anyUsed = true;
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

    // New clarified rules:
    // - Basics have no limits (handled elsewhere)
    // - Non-basic Aspects: choose up to 2 total (excluding specials)
    // - Exception: exactly all 3 Dark Arts may be chosen (then penalty shows)
    const nonSpecialSelected = chosenAspects.filter((s) => !aspects.find(a => a.slug === s)?.isSpecial && aspectEligible(s));
    const total = nonSpecialSelected.length;
    if (total < 2) {
      setChosenAspects([...chosenAspects, slug]);
      return;
    }

    if (total === 2) {
      // Allow only if adding this makes exactly the Dark trio
      const set = new Set([...nonSpecialSelected, slug]);
      const isDarkTrio = set.size === 3 && (DARK_SLUGS as readonly string[]).every((s) => set.has(s));
      if (isDarkTrio) setChosenAspects(Array.from(new Set([...chosenAspects, slug])));
      return;
    }

    // total >= 3 → already at max; do nothing
  }

  function setQty(cardId: string, n: number) {
    setEntries((prev) => ({ ...prev, [cardId]: Math.max(0, n) }));
  }

  const availableCards = useMemo(() => {
    return cards
      .filter((c) => selectedAspectSlugs.includes(c.aspect))
      .filter((c) => c.rank <= rankCap)
      .filter((c) => {
        // Role filter (if any selected)
        if (!roleFilter || roleFilter.length === 0) return true;
        const roles = getRoles(c);
        return roleFilter.some(r => roles.includes(r));
      })
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
  }, [selectedAspectSlugs, rankCap, cards]);

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

  // Unlocked status (Basics always unlocked)
  const unlocksSet = overrideAll
    ? new Set(aspects.map(a => a.slug))
    : new Set(unlocks.concat(aspects.filter(a => isBasicAspect(a.slug)).map(a => a.slug)));

  const totalQty = useMemo(() => {
    // Count only non-special types toward 30 pages
    let pages = 0;
    for (const [id, qty] of Object.entries(entries)) {
      const card = cards.find(c => c.id === id);
      if (!card || qty <= 0) continue;
      if (card.type === "Astral" || card.type === "Shadow") continue;
      pages += qty;
    }
    return pages;
  }, [entries]);
  const counts = useMemo(() => {
    let holy = 0, light = 0, dark = 0, astral = 0, shadow = 0;
    for (const [id, qty] of Object.entries(entries)) {
      const card = cards.find(c => c.id === id);
      if (!card || qty <= 0) continue;
      const t = card.type as SpellType;
      if (t === "Holy") holy += qty;
      else if (t === "Light") light += qty;
      else if (t === "Dark") dark += qty;
      else if (t === "Astral") astral += qty;
      else if (t === "Shadow") shadow += qty;
    }
    return { Holy: holy, Light: light, Dark: dark, Astral: astral, Shadow: shadow };
  }, [entries]);

  // Per-type page limits for non-special spells (dynamic with Dark Arts penalty)
  const TYPE_LIMITS = useMemo(() => {
    // Base limits
    const base: Partial<Record<SpellType, number>> = { Holy: 4, Light: 24, Dark: 2 };
    if (!overrideAll && allDarkTrioSelected) {
      // Penalty: -4 Holy (effectively 0), +3 Light, +1 Dark
      return { Holy: 0, Light: (base.Light || 0) + 3, Dark: (base.Dark || 0) + 1 } as Partial<Record<SpellType, number>>;
    }
    return base;
  }, [allDarkTrioSelected, overrideAll]);

  const remainingByType = useMemo(() => ({
    Holy: Math.max(0, (TYPE_LIMITS.Holy ?? Infinity) - counts.Holy),
    Light: Math.max(0, (TYPE_LIMITS.Light ?? Infinity) - counts.Light),
    Dark: Math.max(0, (TYPE_LIMITS.Dark ?? Infinity) - counts.Dark),
    Astral: Number.POSITIVE_INFINITY,
    Shadow: Number.POSITIVE_INFINITY,
  } as Record<SpellType, number>), [counts, TYPE_LIMITS]);

  // Special unlock flags and helper text
  const hasAstral = unlocksSet.has('starlight');
  const hasShadow = unlocksSet.has('shadows');
  const extraParts: string[] = [];
  if (hasAstral) extraParts.push(`[Astral]: ${counts.Astral}/7`);
  if (hasShadow) extraParts.push(`[Shadow]: ${counts.Shadow}/3`);
  const extraSummaryLine = extraParts.join('    ');
  const specialSlotsText = hasAstral && hasShadow
    ? 'Unlocks add extra slots: +7 Astral and +3 Shadow (beyond 30 Pages).'


    : hasAstral
    ? 'Unlocks add extra slots: +7 Astral (beyond 30 Pages).'
    : hasShadow
    ? 'Unlocks add extra slots: +3 Shadow (beyond 30 Pages).'
    : '';
  const showDarkCategory = overrideAll || aspects.some((a) => a.isDark && unlocksSet.has(a.slug));

  // Rank change handler: warn when lowering rank and trim higher-rank spells from the grimoire
  function handleRankSelect(e: React.MouseEvent<HTMLButtonElement>, nextRank: number) {
    e.preventDefault();
    if (nextRank === rankCap) {
      const el = (e.currentTarget.closest('details')) as HTMLDetailsElement | null;
      if (el) el.open = false;
      return;
    }
    const lowering = nextRank < rankCap;
    if (lowering) {
      // Build list of higher-rank entries that would be removed
      const nameByAspect: Record<string, string> = Object.fromEntries(aspects.map(a => [a.slug, a.name] as const));
      const removals = Object.entries(entries)
        .filter(([_, qty]) => (qty || 0) > 0)
        .map(([id, qty]) => {
          const c = cards.find(x => x.id === id);
          if (!c) return null as any;
          return { id, qty: qty || 0, name: c.name, aspect: nameByAspect[c.aspect] || c.aspect, rank: c.rank, type: c.type };
        })
        .filter((x: any) => x && x.rank > nextRank) as { id: string; name: string; aspect: string; rank: number; qty: number; type: SpellType }[];
      if (removals.length > 0) {
        setRankPending({ next: nextRank, removals });
        const el = (e.currentTarget.closest('details')) as HTMLDetailsElement | null;
        if (el) el.open = false;
        return;
      }
    }
    setRankCap(nextRank);
    // Close the details dropdown
    const el = (e.currentTarget.closest('details')) as HTMLDetailsElement | null;
    if (el) el.open = false;
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100 flex justify-center px-6 md:px-10 lg:px-20 xl:px-28 py-6">
      <div className="max-w-7xl w-full mx-auto space-y-6 sm:space-y-8 text-center">
        <header className="grid grid-cols-1 sm:grid-cols-3 items-center justify-items-center gap-2 w-full px-4 md:px-6">
          {/* Left (desktop): Decks + Rules */}
          <div className="hidden sm:flex items-center gap-2 justify-self-center sm:justify-self-start mx-2 sm:mx-8 mt-1 md:mt-3 w-full sm:w-auto">
            <button
              type="button"
              aria-label="Decks"
              onClick={() => setShowDecks(true)}
              className="rounded-xl border-2 px-4 py-2 text-base md:text-xl bg-slate-100 text-slate-900 hover:bg-slate-200 shadow-md font-semibold min-w-[120px] border-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 dark:border-slate-600"
            >
              Decks
            </button>
            <a
              href="https://docs.google.com/document/d/1_Vso3yHHDZo5LrzWOoWWuSx_P4fiZrx-oQWdGBXncEs/edit?usp=sharing"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-xl border-2 px-4 py-2 text-base md:text-xl bg-slate-100 text-slate-900 hover:bg-slate-200 shadow-md font-semibold min-w-[120px] border-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 dark:border-slate-600"
            >
              Rules
            </a>
          </div>

          {/* Center: Title */}
          <h1 className="text-2xl md:text-4xl font-bold justify-self-center text-center text-slate-900 dark:text-slate-100">WKW Deck Builder</h1>

          {/* Right (desktop): Rank + Unlock */}
          <div className="hidden sm:flex justify-self-center sm:justify-self-end mx-2 sm:mx-8 mt-1 md:mt-3 w-full sm:w-auto flex-col items-stretch gap-2">
            <div className="flex justify-end">
              <details className="relative">
                <summary className="list-none cursor-pointer inline-flex items-center gap-3 rounded-xl border-2 px-4 py-2 text-base md:text-xl bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100 border-slate-300 dark:border-slate-600 shadow-md font-semibold min-w-[140px] md:min-w-[180px]">
                  <span>Rank: {rankCap}</span>
                  <span aria-hidden>▾</span>
                </summary>
                <div className="absolute right-0 z-20 mt-2 w-56 rounded-lg border bg-white dark:bg-slate-800 dark:border-slate-600 dark:text-slate-100 shadow-xl">
                  {[1,2,3,4,5].map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={["block w-full text-left px-5 py-2.5 text-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-900 dark:text-slate-100", n===rankCap?"font-semibold":""].join(' ')}
                      onClick={(e) => handleRankSelect(e, n)}
                    >
                      Rank {n}
                    </button>
                  ))}
                </div>
              </details>
            </div>
            <div className="text-xs text-slate-600 dark:text-slate-300 text-right">
              Some aspects only appear at higher Ranks.
            </div>
            {!overrideAll && (
              <button
                type="button"
                aria-label="Unlock Aspects"
                onClick={() => { console.log('[UI] Unlock Codes clicked'); setShowUnlock(true); }}
                className="rounded-xl border-2 px-4 py-2 text-base md:text-xl bg-indigo-600 text-white hover:bg-indigo-700 shadow-md font-semibold min-w-[140px] md:min-w-[200px] self-end"
              >
                Unlock Aspects
              </button>
            )}
          </div>

          {/* Mobile buttons (under title): Rules, Decks, Unlock Aspects, Rank */}
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
                aria-label="Decks"
                onClick={() => setShowDecks(true)}
                className="rounded-xl border-2 px-4 py-2 text-base bg-slate-100 text-slate-900 hover:bg-slate-200 shadow-md font-semibold border-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 dark:border-slate-600"
              >
                Decks
              </button>
              {!overrideAll && (
                <button
                  type="button"
                  aria-label="Unlock Aspects"
                  onClick={() => { console.log('[UI] Unlock Codes clicked'); setShowUnlock(true); }}
                  className="rounded-xl border-2 px-4 py-2 text-base bg-indigo-600 text-white hover:bg-indigo-700 shadow-md font-semibold border-indigo-600"
                >
                  Unlock Aspects
                </button>
              )}
              <details className="relative">
                <summary className="list-none cursor-pointer inline-flex items-center gap-2 rounded-xl border-2 px-4 py-2 text-base bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100 border-slate-300 dark:border-slate-600 shadow-md font-semibold">
                  <span>Rank: {rankCap}</span>
                  <span aria-hidden>▾</span>
                </summary>
                <div className="absolute left-1/2 -translate-x-1/2 z-20 mt-2 w-56 rounded-lg border bg-white dark:bg-slate-800 dark:border-slate-600 dark:text-slate-100 shadow-xl">
                  {[1,2,3,4,5].map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={["block w-full text-left px-5 py-2.5 text-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-900 dark:text-slate-100", n===rankCap?"font-semibold":""].join(' ')}
                      onClick={(e) => handleRankSelect(e, n)}
                    >
                      Rank {n}
                    </button>
                  ))}
                </div>
              </details>
            </div>
            <div className="text-xs text-slate-600 dark:text-slate-300 text-center">Some aspects only appear at higher Ranks.</div>
          </div>
        </header>

        {rankPending && (
          <div className="mx-4 md:mx-8 lg:mx-12 xl:mx-16 rounded-xl border border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-100/10 dark:text-amber-200 dark:border-amber-400 p-4 text-left">
            <div className="flex flex-col gap-2">
              {(() => {
                const total = rankPending.removals.reduce((a, r) => a + (r.qty || 0), 0);
                const byType: Record<SpellType, number> = { Holy: 0, Light: 0, Dark: 0, Astral: 0, Shadow: 0 };
                for (const r of rankPending.removals) byType[r.type] += (r.qty || 0);
                const parts = (['Holy','Light','Dark','Astral','Shadow'] as SpellType[])
                  .filter(t => byType[t] > 0)
                  .map(t => `${t} ${byType[t]}`);
                return (
                  <div className="font-semibold">
                    Lowering Rank to {rankPending.next} will remove {total} page{total===1?'':'s'} ({parts.join(' · ')}).
                  </div>
                );
              })()}
              <details className="text-sm">
                <summary className="cursor-pointer underline">Show details ({rankPending.removals.length} spell{rankPending.removals.length===1?'':'s'})</summary>
                <div className="mt-2 max-h-48 overflow-auto pr-1">
                  {rankPending.removals.map((r, i) => (
                    <div key={`${r.id}-${i}`}>• (R{r.rank}) {'{'}{(r.aspect||'').replace(/^Aspect of\s+/i,'')}{'}'} {r.name} — x{r.qty}</div>
                  ))}
                </div>
              </details>
              <div className="flex gap-2 pt-1">
                <button
                  className="rounded-lg px-4 py-2 bg-amber-600 text-white hover:bg-amber-700"
                  onClick={() => {
                    // zero out higher-rank entries, then apply new rank
                    setEntries((prev) => {
                      const next: Record<string, number> = { ...prev };
                      for (const r of rankPending.removals) next[r.id] = 0;
                      return next;
                    });
                    setRankCap(rankPending.next);
                    setRankPending(null);
                  }}
                >
                  Apply Rank {rankPending.next} and Remove
                </button>
                <button
                  className="rounded-lg px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-900 border border-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 dark:border-slate-700"
                  onClick={() => setRankPending(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {overrideAll && (
          <div className="rounded-xl border border-amber-300 bg-amber-100 text-amber-900 px-4 py-2 text-sm text-center shadow-sm">
            Override Mode Enabled — All aspects unlocked and limits disabled.
          </div>
        )}

        {/* Basics & Aspects */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-3">
            <h2 className="font-semibold text-center">Basics (always unlocked)</h2>
            <div className="grid grid-cols-2 gap-3">
              {aspects
                .filter((a) => isBasicAspect(a.slug) && aspectEligible(a.slug))
                .sort((a, b) => (ASPECT_INDEX[a.slug] ?? 999) - (ASPECT_INDEX[b.slug] ?? 999))
                .map((a) => (
                <AspectCard
                  key={a.slug}
                  aspect={a}
                  unlocked={true}
                  selected={basicsSelected.includes(a.slug)}
                  onToggle={() => toggleBasic(a.slug)}
                />
              ))}
            </div>
            {/* Dark Arts directly under Basics */}
            {showDarkCategory && (
              <div className="space-y-3">
                <h2 className="font-semibold text-center">Dark Arts</h2>
                {!overrideAll && allDarkTrioSelected && (
                  <>
                    <div className="text-sm font-semibold text-center mb-3">
                      <span className="text-red-700 font-bold" style={{ color: '#dc2626', fontWeight: 700 }}>Dark Arts Penalty:</span>
                      {' '}Lose -4 [Holy] spell slots, gain +3 [Light] spell slots, gain +1 [Dark] spell slot.
                    </div>
                    <br />
                  </>
                )}
                <div className="grid grid-cols-2 gap-3">
                  {aspects
                    .filter((a) => a.isDark && (overrideAll || unlocksSet.has(a.slug)) && aspectEligible(a.slug))
                    .sort((a, b) => (ASPECT_INDEX[a.slug] ?? 999) - (ASPECT_INDEX[b.slug] ?? 999))
                    .map((a) => {
                      const isSelected = chosenAspects.includes(a.slug);
                      // Selection behavior follows normal non-special rules
                      const total = chosenAspects.filter((s) => !aspects.find(x => x.slug === s)?.isSpecial && aspectEligible(s)).length;
                      let disabled = false;
                      if (!overrideAll && !isSelected) {
                        if (total < 2) {
                          disabled = false;
                        } else if (total === 2) {
                          const set = new Set([...chosenAspects.filter((s) => !aspects.find(x => x.slug === s)?.isSpecial), a.slug]);
                          const isDarkTrio = set.size === 3 && (DARK_SLUGS as readonly string[]).every((s) => set.has(s));
                          disabled = !isDarkTrio;
                        } else {
                          disabled = true;
                        }
                      }
                      return (
                        <AspectCard
                          key={a.slug}
                          aspect={a}
                          unlocked={true}
                          selected={isSelected}
                          disabled={disabled}
                          onToggle={() => toggleAspect(a.slug)}
                        />
                      );
                    })}
                </div>
              </div>
            )}

            {/* Special Aspects under Dark Arts */}
            {(overrideAll || aspects.some((a) => a.isSpecial && unlocksSet.has(a.slug) && aspectEligible(a.slug))) && (
              <div className="space-y-3">
                <h2 className="font-semibold text-center">Special Aspects</h2>
                {specialSlotsText && (
                  <div className="text-sm text-slate-700 dark:text-slate-200 text-center">
                    {specialSlotsText}
                    {hasAstral && hasShadow ? (<><br />
                    <br /></>) : null}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  {aspects
                    .filter((a) => a.isSpecial && (overrideAll || unlocksSet.has(a.slug)) && aspectEligible(a.slug))
                    .sort((a, b) => (ASPECT_INDEX[a.slug] ?? 999) - (ASPECT_INDEX[b.slug] ?? 999))
                    .map((a) => {
                    const isSelected = chosenAspects.includes(a.slug);
                    return (
                      <AspectCard
                        key={a.slug}
                        aspect={a}
                        unlocked={true}
                        selected={isSelected}
                        onToggle={() => toggleAspect(a.slug)}
                      />
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="space-y-3">
            <h2 className="font-semibold text-center">
              Additional Aspects{' '}
              <span className="text-slate-600 dark:text-slate-200">
                {showDarkCategory ? '(choose up to 2 — or all 3 Dark Arts)' : '(choose up to 2)'}
              </span>
            </h2>
            <div className="grid grid-cols-2 gap-3">
              {aspects
                .filter((a) => !isBasicAspect(a.slug) && !a.isSpecial && !a.isDark && aspectEligible(a.slug))
                .sort((a, b) => (ASPECT_INDEX[a.slug] ?? 999) - (ASPECT_INDEX[b.slug] ?? 999))
                .map((a) => {
                const isSelected = chosenAspects.includes(a.slug);
                const total = chosenAspects.filter((s) => !aspects.find(x => x.slug === s)?.isSpecial && aspectEligible(s)).length;
                let disabled = false;
                if (!overrideAll && !isSelected) {
                  if (total < 2) {
                    disabled = false;
                  } else if (total === 2) {
                    const set = new Set([...chosenAspects.filter((s) => !aspects.find(x => x.slug === s)?.isSpecial), a.slug]);
                    const isDarkTrio = set.size === 3 && (DARK_SLUGS as readonly string[]).every((s) => set.has(s));
                    disabled = !isDarkTrio;
                  } else {
                    disabled = true;
                  }
                }
                return (
                  <AspectCard
                    key={a.slug}
                    aspect={a}
                    unlocked={overrideAll || unlocksSet.has(a.slug)}
                    selected={isSelected}
                    disabled={disabled}
                    onToggle={() => toggleAspect(a.slug)}
                  />
                );
              })}
            </div>
          </div>

          {/* Dark and Special moved under Basics in the left column */}
        </section>

        {/* Cards grouped by Aspect */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-slate-100 dark:bg-slate-800 rounded-2xl p-4 shadow-sm">
            <h3 className="font-semibold mb-2 text-center">Cards (from selected Aspects)</h3>
            {/* Sort by role removed per request; keeping only role filter below */}
            {/* Role filter (visible only when Tips + Subtypes are on) */}
            {showTips && showSubtypes && (
            <div className="mb-3 flex items-center justify-center gap-2 flex-wrap">
              {(['power_increase','power_reduction','disruption','search_draw','counter','movement_increase','movement_reduction','special','inflict_status'] as Role[]).map(r => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRoleFilter(prev => prev.includes(r) ? prev.filter(x=>x!==r) : [...prev, r])}
                  className={[
                    'px-3 py-1 rounded-full text-sm border',
                    roleFilter.includes(r)
                      ? (r==='power_increase'?'bg-rose-600 border-rose-600 text-white'
                        : r==='power_reduction'?'bg-rose-700 border-rose-700 text-white'
                    : r==='disruption'?'bg-blue-600 border-blue-600 text-white'
                        : r==='search_draw'?'bg-emerald-600 border-emerald-600 text-white'
                        : r==='counter'?'bg-indigo-600 border-indigo-600 text-white'
                        : r==='movement_increase'?'bg-amber-600 border-amber-600 text-white'
                        : r==='movement_reduction'?'bg-amber-700 border-amber-700 text-white'
                        : r==='inflict_status'?'bg-cyan-600 border-cyan-600 text-white'
                        : 'bg-fuchsia-600 border-fuchsia-600 text-white')
                      : 'bg-slate-100 dark:bg-slate-700 text-slate-900 dark:text-slate-100 border-slate-300 dark:border-slate-600'
                  ].join(' ')}
                  title={roleFilter.includes(r)? 'Remove filter': 'Filter by role'}
                >
                  {{
                    power_increase:'POWER Increase',
                    power_reduction:'POWER Reduction',
                    disruption:'Disrupt',
                    search_draw:'Search/Draw',
                    counter:'Counter',
                    movement_increase:'Movement Increase',
                    movement_reduction:'Movement Reduction',
                    special:'Special',
                    inflict_status:'Inflict Status'
                  }[r]}
                </button>
              ))}
              {roleFilter.length>0 && (
                <button type="button" onClick={()=>setRoleFilter([])} className="px-3 py-1 rounded-full text-sm border bg-slate-100 dark:bg-slate-700 text-slate-900 dark:text-slate-100 border-slate-300 dark:border-slate-600">Clear</button>
              )}
            </div>
            )}
            <div className="space-y-4">
              {groupedByAspect.map((group) => (
                <div key={group.slug}>
                  <div className="font-bold text-slate-900 dark:text-slate-100 mb-1 text-center" style={{ fontSize: '24px' }}>
                    {group.name && group.name.startsWith('Aspect of ')
                      ? group.name
                      : `Aspect of ${group.name}`}
                  </div>
                  <div className="mb-2 flex items-center justify-center gap-3 transform -translate-x-2 md:-translate-x-4">
                    {(() => {
                      const pageCapReached = totalQty >= 30;
                      const groupHasCountable = group.cards.some(c => c.type !== 'Astral' && c.type !== 'Shadow');
                      const allAstral = group.cards.every(c => c.type === 'Astral');
                      const allShadow = group.cards.every(c => c.type === 'Shadow');
                      let pickDisabled = pageCapReached && groupHasCountable;
                      if (allAstral || allShadow) {
                        const allAtMax = group.cards.every(c => (entries[c.id] || 0) >= c.maxCopies);
                        const typeCapReached = allAstral
                          ? counts.Astral >= 7
                          : allShadow
                          ? counts.Shadow >= 3
                          : false;
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
                                let astralRoom = Math.max(0, 7 - counts.Astral);
                                let shadowRoom = Math.max(0, 3 - counts.Shadow);
                                for (const card of group.cards) {
                                  const locked = !unlocksSet.has(card.aspect) && !isBasicAspect(card.aspect);
                                  if (locked) continue;
                                  const current = next[card.id] || 0;
                                  const add = Math.max(0, card.maxCopies - current);
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
                                  const roomTotal = Math.max(0, 30 - pages);
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
                  <div className="divide-y px-6 md:px-8 lg:px-10 max-w-xl mx-auto rounded-2xl">
                    {group.cards.map((card) => {
                      const qty = entries[card.id] || 0;
                      const locked = !unlocksSet.has(card.aspect) && !isBasicAspect(card.aspect);
                      return (
                        <CardRow
                          key={card.id}
                          card={card}
                          qty={qty}
                          locked={locked}
                          onChange={(n) => setQty(card.id, n)}
                          onPreview={(c) => { console.log('[App.setPreviewCard]', c.id); setPreviewCard(c); }}
                          remainingSlots={Math.max(0, 30 - totalQty)}
                          remainingTypeSlots={remainingByType[card.type] ?? Number.POSITIVE_INFINITY}
                          onCapAttempt={showCapAttempt}
                          showRoles={showTips && showSubtypes}
                          rolesForCard={getRoles(card)}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Summary + Grimoire (sticky on desktop) */}
          <div className="space-y-4 lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100vh-2rem)] lg:overflow-auto lg:pr-1">
            <div className="bg-slate-100 dark:bg-slate-800 rounded-2xl p-4 shadow-sm">
              <h3 className="font-semibold mb-2 text-center">Deck Summary:</h3>
              <div className="text-center font-mono whitespace-pre-wrap">
                <div className="text-lg">{totalQty}/30 Pages</div>
                <div className="flex items-center justify-center gap-6">
                  <span className={capAttempt === 'Holy' ? 'text-red-600 font-bold' : undefined}>
                    [Holy]: {counts.Holy}/{TYPE_LIMITS.Holy ?? '∞'}{'\u00A0\u00A0\u00A0'}
                  </span>
                  <span className={capAttempt === 'Light' ? 'text-red-600 font-bold' : undefined}>
                    [Light]: {counts.Light}/{TYPE_LIMITS.Light ?? '∞'}{'\u00A0\u00A0\u00A0'}
                  </span>
                  <span className={capAttempt === 'Dark' ? 'text-red-600 font-bold' : undefined}>
                    [Dark]: {counts.Dark}/{TYPE_LIMITS.Dark ?? '∞'}
                  </span>
                </div>
                {capAttempt && (
                  <div className="mt-1 text-sm text-red-600 font-semibold">[{capAttempt}] Cap Reached</div>
                )}
                {(hasAstral || hasShadow) && (
                  <div className="mt-1 text-sm">{extraSummaryLine}</div>
                )}
              </div>

              {/* Tips / Suggestions Toggle */}
              <div className="mt-3 flex items-center justify-center gap-2 flex-wrap">
                <label className="text-sm text-slate-700 dark:text-slate-200">Tips & Suggestions</label>
                <button
                  type="button"
                  onClick={() => setShowTips(v => { const nv=!v; if(!nv) setShowSubtypes(false); return nv; })}
                  className={[
                    'px-3 py-1 rounded-full text-sm border',
                    showTips ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-slate-100 dark:bg-slate-700 text-slate-900 dark:text-slate-100 border-slate-300 dark:border-slate-600'
                  ].join(' ')}
                >
                  {showTips ? 'On' : 'Off'}
                </button>
                {showTips && (
                  <>
                    <span className="mx-1 text-slate-400">|</span>
                    <label className="text-sm text-slate-700 dark:text-slate-200">Show Subtypes</label>
                    <button
                      type="button"
                      onClick={() => setShowSubtypes(v => !v)}
                      className={[
                        'px-3 py-1 rounded-full text-sm border',
                        showSubtypes ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-slate-100 dark:bg-slate-700 text-slate-900 dark:text-slate-100 border-slate-300 dark:border-slate-600'
                      ].join(' ')}
                    >
                      {showSubtypes ? 'On' : 'Off'}
                    </button>
                    <span className="mx-1 text-slate-400">|</span>
                    <label className="text-sm text-slate-700 dark:text-slate-200">Infer Missing Roles</label>
                    <button
                      type="button"
                      onClick={() => setUseInference(v => !v)}
                      className={[
                        'px-3 py-1 rounded-full text-sm border',
                        useInference ? 'bg-teal-600 text-white border-teal-600' : 'bg-slate-100 dark:bg-slate-700 text-slate-900 dark:text-slate-100 border-slate-300 dark:border-slate-600'
                      ].join(' ')}
                      title="When Off, only roles from CSV are used"
                    >
                      {useInference ? 'On' : 'Off'}
                    </button>
                  </>
                )}
              </div>

              {showTips && (() => {
                const countsByRole = {
                  power_increase: 0,
                  power_reduction: 0,
                  disruption: 0,
                  search_draw: 0,
                  counter: 0,
                  movement_increase: 0,
                  movement_reduction: 0,
                  special: 0,
                  inflict_status: 0,
                } as Record<Role, number>;
                for (const [id, q] of Object.entries(entries)) {
                  const qty = q || 0; if (qty <= 0) continue; const c = cards.find(x=>x.id===id); if (!c) continue; const n=(c.name||'').toLowerCase();
                  const roles = getRoles(c);
                  for (const r of roles) countsByRole[r] += qty;
                }

                // Suggestions when exactly one non-special aspect is chosen
                const aspectBySlug: Record<string, Aspect> = Object.fromEntries(aspects.map(a=>[a.slug,a] as const));
                const chosenNonSpecial = chosenAspects.filter(s => !aspectBySlug[s]?.isSpecial);
                const nameByAspect: Record<string, string> = Object.fromEntries(aspects.map(a=>[a.slug,a.name] as const));
                const missingKeys = (['power_increase','power_reduction','disruption','search_draw','counter','movement_increase','movement_reduction','special','inflict_status'] as Role[]).filter(k => (countsByRole as any)[k] === 0);
                const explainForAspect = (slug: string) => {
                  const cover: Partial<Record<Role, number>> = {};
                  for (const c of cards) {
                    if (c.aspect !== slug) continue;
                    const roles = getRoles(c);
                    for (const r of roles) cover[r] = (cover[r]||0)+1;
                  }
                  const parts = (['power_increase','power_reduction','disruption','search_draw','counter','movement_increase','movement_reduction','special','inflict_status'] as Role[])
                    .filter(r => (cover as any)[r] && (missingKeys.length===0 || missingKeys.includes(r)))
                    .map(r => `${r}: ${(cover as any)[r]}`);
                  return parts.length ? `Covers → ${parts.join(' · ')}` : 'Limited coverage for current needs';
                };
                let suggestions: { name: string; explain: string }[] = [];
                if (chosenNonSpecial.length === 1) {
                  const candidateSlugs = aspects
                    .filter(a => !isBasicAspect(a.slug) && !a.isSpecial && aspectEligible(a.slug) && unlocksSet.has(a.slug) && !chosenAspects.includes(a.slug))
                    .map(a=>a.slug);
                  const score = (slug: string) => {
                    let k = 0; for (const c of cards) { if (c.aspect !== slug) continue; const roles = getRoles(c); for (const r of roles) if (missingKeys.includes(r)) k++; }
                    return k;
                  };
                  suggestions = candidateSlugs
                    .map(s => ({ s, k: score(s) }))
                    .filter(x => x.k > 0 || missingKeys.length===0)
                    .sort((a,b)=>b.k-a.k || (nameByAspect[a.s]||a.s).localeCompare(nameByAspect[b.s]||b.s))
                    .slice(0,3)
                    .map(x => ({ name: nameByAspect[x.s] || x.s, explain: explainForAspect(x.s) }));
                }

                return (
                  <div className="mt-3 text-left">
                    <div className="rounded-lg border border-slate-300 dark:border-slate-700 p-3 bg-white/60 dark:bg-slate-900/40">
                      <div className="font-semibold mb-2">Role Coverage</div>
                      <ul className="grid grid-cols-2 gap-2 text-sm">
                        <li className={countsByRole.power_increase>0? 'text-emerald-700 dark:text-emerald-300':'text-slate-500'}>• POWER Increase — {countsByRole.power_increase}</li>
                        <li className={countsByRole.power_reduction>0? 'text-emerald-700 dark:text-emerald-300':'text-slate-500'}>• POWER Reduction — {countsByRole.power_reduction}</li>
                        <li className={countsByRole.disruption>0? 'text-emerald-700 dark:text-emerald-300':'text-slate-500'}>• Disruption — {countsByRole.disruption}</li>
                        <li className={countsByRole.search_draw>0? 'text-emerald-700 dark:text-emerald-300':'text-slate-500'}>• Search/Draw — {countsByRole.search_draw}</li>
                        <li className={countsByRole.counter>0? 'text-emerald-700 dark:text-emerald-300':'text-slate-500'}>• Counter — {countsByRole.counter}</li>
                        <li className={countsByRole.movement_increase>0? 'text-emerald-700 dark:text-emerald-300':'text-slate-500'}>• Movement Increase — {countsByRole.movement_increase}</li>
                        <li className={countsByRole.movement_reduction>0? 'text-emerald-700 dark:text-emerald-300':'text-slate-500'}>• Movement Reduction — {countsByRole.movement_reduction}</li>
                        <li className={countsByRole.inflict_status>0? 'text-emerald-700 dark:text-emerald-300':'text-slate-500'}>• Inflict Status — {countsByRole.inflict_status}</li>
                        <li className={countsByRole.special>0? 'text-emerald-700 dark:text-emerald-300':'text-slate-500'}>• Special — {countsByRole.special}</li>
                      </ul>
                      {chosenNonSpecial.length === 1 && (
                        <div className="mt-3">
                          <div className="font-semibold mb-1">Suggested Aspects</div>
                          {suggestions.length > 0 ? (
                            <div className="flex flex-col gap-1 text-sm">
                              {suggestions.map((s, i) => (
                                <div key={i} className="flex items-center gap-2">
                                  <span>{s.name}</span>
                                  <button
                                    className="text-xs px-2 py-0.5 rounded border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800"
                                    title={s.explain}
                                    onClick={() => alert(s.explain)}
                                  >
                                    Explain
                                  </button>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="text-sm text-slate-500">No suggestions — current deck covers most roles.</div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>

            <div className="bg-slate-100 dark:bg-slate-800 rounded-2xl p-4 shadow-sm">
              <h3 className="font-semibold mb-3 text-center">Grimoire</h3>
              {(() => {
                const expanded = Object.entries(entries)
                  .filter(([_, q]) => (q || 0) > 0)
                  .map(([id, qty]) => ({ qty: qty || 0, card: cards.find(c => c.id === id)! }))
                  .filter(x => x.card);
                const types: SpellType[] = ['Holy','Light','Dark','Astral','Shadow'];
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
                            <span className="text-sm text-slate-600 dark:text-slate-300">{total} pages</span>
                          </summary>
                          <div className="p-3">
                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                              {items.map(({ qty, card }) => (
                                <button key={card.id} className="flex flex-col items-center gap-1 rounded-lg bg-slate-50 dark:bg-slate-800 p-2 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700"
                                  onClick={() => setPreviewCard(card)}
                                >
                                  {CARD_IMAGE_URLS[card.id] ? (
                                    <img src={CARD_IMAGE_URLS[card.id]} alt={card.name} className="w-full h-28 object-contain rounded" />
                                  ) : (
                                    <div className="w-full h-28 flex items-center justify-center text-xs text-slate-500">No image</div>
                                  )}
                                  <div className="text-xs text-slate-700 dark:text-slate-200">x{qty}</div>
                                </button>
                              ))}
                            </div>
                          </div>
                        </details>
                      );
                    })}
                    {types.filter(shouldShow).every(t => expanded.filter(x=>x.card.type===t).length===0) && (
                      <div className="text-sm text-center text-slate-500">No cards in Grimoire yet.</div>
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
      {showDecks && (
        createPortal(
          <div className="fixed inset-0 z-[10000] bg-black/70 flex items-center justify-center p-4" onClick={() => setShowDecks(false)}>
            <div className="bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 rounded-2xl shadow-2xl w-full max-w-4xl p-6 border border-slate-200 dark:border-slate-700" onClick={(e)=>e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xl font-bold">My Decks</h3>
                <button className="rounded-lg px-3 py-1 bg-slate-100 hover:bg-slate-200 text-slate-900 border border-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 dark:border-slate-700" onClick={()=>setShowDecks(false)}>Close</button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <div className="font-semibold">Save / Update</div>
                  <div className="flex gap-2">
                    <input value={deckName} onChange={e=>setDeckName(e.target.value)} placeholder="Deck name" className="flex-1 rounded border px-3 py-2 bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100 border-slate-300 dark:border-slate-700" />
                    <button className="rounded px-3 py-2 bg-indigo-600 text-white hover:bg-indigo-700" onClick={()=>{ if(deckName.trim()) saveDeck(deckName.trim()); }}>Save</button>
                  </div>
                  <div className="font-semibold mt-4">Share</div>
                  <div className="flex gap-2">
                    <button className="rounded px-3 py-2 bg-slate-100 hover:bg-slate-200 border border-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 dark:border-slate-700" onClick={()=>{ const code=makeShareCode(deckName||'My Deck'); navigator.clipboard?.writeText(code).catch(()=>{}); alert(`Share code copied to clipboard:\n\n${code}`); }}>Copy Share Code</button>
                    <button className="rounded px-3 py-2 bg-slate-100 hover:bg-slate-200 border border-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 dark:border-slate-700" onClick={()=>{ const code=prompt('Paste a share code to load'); if(!code) return; const ok=applyShareCode(code.trim()); if(!ok) alert('Invalid code'); }}>Load From Code</button>
                  </div>
                  <div className="font-semibold mt-4">Export</div>
                  <button className="rounded px-3 py-2 bg-slate-100 hover:bg-slate-200 border border-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 dark:border-slate-700" onClick={()=>exportPdf(deckName)}>Export as PDF</button>
                </div>
                <div>
                  <div className="font-semibold mb-2">Saved Decks</div>
                  <div className="space-y-2 max-h-64 overflow-auto">
                    {decks.map(d => (
                      <div key={d.name} className="flex items-center gap-2 border rounded px-3 py-2 border-slate-300 dark:border-slate-700">
                        <div className="flex-1 whitespace-normal break-words">{d.name}</div>
                        <button className="rounded px-2 py-1 bg-indigo-600 text-white hover:bg-indigo-700" onClick={()=>loadDeck(d.name)}>Load</button>
                        <button className="rounded px-2 py-1 bg-slate-100 hover:bg-slate-200 border border-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 dark:border-slate-700" onClick={()=>{ const nn=prompt('Rename deck', d.name); if(nn&&nn.trim()) renameDeck(d.name, nn.trim()); }}>Rename</button>
                        <button className="rounded px-2 py-1 bg-rose-600 text-white hover:bg-rose-700" onClick={()=>{ if(confirm('Delete deck?')) deleteDeck(d.name); }}>Delete</button>
                      </div>
                    ))}
                    {decks.length===0 && (<div className="text-sm text-slate-500">No saved decks yet.</div>)}
                  </div>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )
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
