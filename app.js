'use strict';

/* ============================================================
   Compact Calendar — inspired by David Seah's printable design.
   Continuous week rows, drag to "circle" days, notes on the right.
   ============================================================ */

const $  = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DOW_MON = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const DOW_SUN = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

const STORAGE_KEY = 'compactcal.v1';
const PALETTE = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6',
                 '#ec4899','#14b8a6','#f97316','#64748b','#84cc16'];

/* ---------------- date utils (all local time, ISO yyyy-mm-dd keys) */

const pad2 = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fromISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const daysBetween = (a, b) => Math.round((b - a) / 86400000);

function todayISO() {
  const tz = state.settings.timezone;
  try {
    // en-CA formats as YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  } catch {
    return iso(new Date());
  }
}

function startOfWeek(d, weekStart) {
  const x = new Date(d);
  const shift = (x.getDay() - weekStart + 7) % 7;
  x.setDate(x.getDate() - shift);
  return x;
}

function prettyDate(s, withYear) {
  const d = fromISO(s);
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}${withYear ? ' ' + d.getFullYear() : ''}`;
}

function prettyRange(start, end, displayYear) {
  const sd = fromISO(start), ed = fromISO(end);
  const needYear = sd.getFullYear() !== displayYear || ed.getFullYear() !== displayYear;
  if (start === end) return prettyDate(start, needYear);
  if (sd.getFullYear() === ed.getFullYear() && sd.getMonth() === ed.getMonth()) {
    return `${MONTHS_SHORT[sd.getMonth()]} ${sd.getDate()} – ${ed.getDate()}${needYear ? ' ' + ed.getFullYear() : ''}`;
  }
  return `${prettyDate(start, needYear)} – ${prettyDate(end, needYear)}`;
}

/* ---------------- profiles (Netflix-style, each with its own calendar) */

const PROFILES_KEY = 'compactcal.profiles';
const pid = () => 'p-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const dataKey = id => STORAGE_KEY + ':' + id;

function loadProfiles() {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (Array.isArray(p.list) && p.list.length) {
        if (!p.list.some(x => x.id === p.current)) p.current = p.list[0].id;
        return p;
      }
    }
  } catch { /* fall through to fresh setup */ }
  // first run (or migration): adopt any pre-profile data as the first profile
  const def = { id: pid(), name: 'My Calendar', color: PALETTE[0] };
  const p = { list: [def], current: def.id };
  const legacy = localStorage.getItem(STORAGE_KEY);
  if (legacy != null) {
    localStorage.setItem(dataKey(def.id), legacy);
    localStorage.removeItem(STORAGE_KEY);
  }
  localStorage.setItem(PROFILES_KEY, JSON.stringify(p));
  return p;
}

let profiles = loadProfiles();
const saveProfiles = () => {
  localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
  pushRemote('/profiles', JSON.stringify(profiles));
};
const currentProfile = () =>
  profiles.list.find(p => p.id === profiles.current) || profiles.list[0];

/* ---------------- server sync (optional backend; see k8s manifests)
   localStorage stays the working copy & offline cache; when the /api
   backend responds, the server is the source of truth shared by everyone. */

const API = 'api'; // relative, so it works behind any ingress path
let serverMode = false;
const pendingPuts = new Map();
let pushTimer = 0;
let syncWarned = false;

function pushRemote(pathPart, body) {
  if (!serverMode) return;
  pendingPuts.set(pathPart, body);
  clearTimeout(pushTimer);
  pushTimer = setTimeout(flushPuts, 600);
}

async function flushPuts() {
  for (const [p, body] of [...pendingPuts]) {
    pendingPuts.delete(p);
    try {
      await fetch(`${API}${p}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      syncWarned = false;
    } catch {
      if (!syncWarned) { syncWarned = true; toast('Offline — changes kept on this device, will sync later.'); }
      pendingPuts.set(p, body); // retry on next save / pagehide
    }
  }
}

window.addEventListener('pagehide', () => {
  for (const [p, body] of [...pendingPuts]) {
    pendingPuts.delete(p);
    try {
      navigator.sendBeacon(`${API}${p}`, new Blob([body], { type: 'application/json' }));
    } catch { /* best effort */ }
  }
});

async function syncInit() { return; /* static build: localStorage only */
  try {
    const opts = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? { signal: AbortSignal.timeout(2500) } : {};
    const res = await fetch(`${API}/profiles`, opts);
    if (!res.ok) return;
    const server = await res.json();
    serverMode = true;
    if (server && Array.isArray(server.list) && server.list.length) {
      // server owns the profile list; the chosen profile stays per-device
      let current = server.list[0].id;
      try {
        const local = JSON.parse(localStorage.getItem(PROFILES_KEY));
        if (local && server.list.some(x => x.id === local.current)) current = local.current;
      } catch { /* ignore */ }
      localStorage.setItem(PROFILES_KEY, JSON.stringify({ list: server.list, current }));
      try {
        const r = await fetch(`${API}/data/${encodeURIComponent(current)}`);
        if (r.ok) localStorage.setItem(dataKey(current), await r.text());
      } catch { /* keep cached copy */ }
    } else {
      // empty server — seed it with this device's data
      try {
        const local = JSON.parse(localStorage.getItem(PROFILES_KEY));
        if (local && Array.isArray(local.list)) {
          await fetch(`${API}/profiles`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(local),
          });
          for (const pr of local.list) {
            const d = localStorage.getItem(dataKey(pr.id));
            if (d) {
              await fetch(`${API}/data/${encodeURIComponent(pr.id)}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: d,
              });
            }
          }
        }
      } catch { /* server will get seeded by the next save */ }
    }
  } catch { serverMode = false; }
}

async function syncPullProfile(id) {
  if (!serverMode) return;
  try {
    const r = await fetch(`${API}/data/${encodeURIComponent(id)}`);
    if (r.ok) localStorage.setItem(dataKey(id), await r.text());
  } catch { /* offline: use the cached copy */ }
}

/* ---------------- state & persistence */

function defaultState() {
  return {
    // events: {id, title, start, end, notes, ci (theme palette slot), label?{x,y}}
    events: [],
    settings: {
      themeMode: 'auto', accent: 'classic', accentCi: null,
      weekStart: 0, timezone: '', scheme: 'builtin', autoColor: true,
      months: 12, numFont: 11, pastStyle: 'none', hidePastEvents: false,
      slimCards: false, fitCards: false,
      lineWidth: 1.6, lineStyle: 'simple', lineDash: 'solid', lineOpacity: 0.5,
      lineEdge: true, dynamicOrigin: false,
      exportQRMode: 'none', exportMono: false, exportPast: false,
    },
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(dataKey(profiles.current));
    if (!raw) return defaultState();
    const s = JSON.parse(raw);
    const d = defaultState();
    const events = Array.isArray(s.events) ? s.events : [];
    // every event owns a palette slot (older versions used categories)
    const used = new Set(events.map(e => e.ci).filter(n => n != null));
    let next = 0;
    for (const ev of events) {
      if (ev.ci == null) {
        while (used.has(next)) next++;
        ev.ci = next;
        used.add(next);
      }
    }
    const settings = { ...d.settings, ...(s.settings || {}) };
    if (s.settings && s.settings.strikePast && !s.settings.pastStyle) settings.pastStyle = 'strike';
    if (s.settings && s.settings.exportQR && !s.settings.exportQRMode) settings.exportQRMode = 'whole';
    return { events, settings };
  } catch {
    return defaultState();
  }
}

function saveState() {
  const body = JSON.stringify(state);
  localStorage.setItem(dataKey(profiles.current), body);
  pushRemote(`/data/${encodeURIComponent(profiles.current)}`, body);
}

let state = loadState();
let year = new Date().getFullYear();
let gridStart = null; // Date of first cell in grid
let gridEnd = null;   // Date of last cell in grid

const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));

const evColor = ev => colorAt(ev.ci != null ? ev.ci : 0);

function nextEventCi() {
  const used = new Set(state.events.map(e => e.ci).filter(n => n != null));
  let i = 0;
  while (used.has(i)) i++;
  return i;
}

/* ---------------- color schemes (Ghostty themes from color.txt) */

let schemes = []; // {name, bg, fg, sel, palette[16]}

const hexRgb = h => {
  h = h.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};
const rgbCss = (rgb, a) => a == null
  ? `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`
  : `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
const mixRgb = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const lum = rgb => {
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
};
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/* Event colors come from the active theme: the built-in palette, or the
   Ghostty scheme's ANSI colors filtered for contrast against its background. */

function themeEventPalette() {
  const sc = activeScheme();
  if (!sc) return PALETTE;
  const bg = hexRgb(sc.bg);
  const out = [];
  const seen = new Set();
  for (const i of [9, 12, 10, 11, 13, 14, 1, 4, 2, 3, 5, 6]) {
    const hex = sc.palette[i];
    if (seen.has(hex)) continue;
    if (contrast(hexRgb(hex), bg) >= 1.7) { out.push(hex); seen.add(hex); }
  }
  return out.length >= 3 ? out : PALETTE;
}

function colorAt(i) {
  // stick to the theme's reference colors — wrap around instead of inventing new hues
  const pal = themeEventPalette();
  return pal[((i % pal.length) + pal.length) % pal.length];
}

let schemeGroups = []; // {label, light: schemeName, dark: schemeName}

/* Schemes that only differ by a Light/Dark or Day/Night suffix are
   consolidated into one entry; the Theme setting picks the variant. */
function buildSchemeGroups() {
  const SUFFIX = /\s+(light|dark|day|night)$/i;
  const byBase = new Map();
  for (const sc of schemes) {
    const m = sc.name.match(SUFFIX);
    const base = m ? sc.name.slice(0, m.index) : sc.name;
    const key = base.toLowerCase();
    if (!byBase.has(key)) byBase.set(key, { label: base, members: [] });
    byBase.get(key).members.push(sc);
  }
  schemeGroups = [];
  for (const g of byBase.values()) {
    if (g.members.length >= 2) {
      const lights = g.members.filter(s => lum(hexRgb(s.bg)) >= 0.4);
      const darks = g.members.filter(s => lum(hexRgb(s.bg)) < 0.4);
      if (lights.length && darks.length) {
        schemeGroups.push({ label: g.label, light: lights[0].name, dark: darks[0].name });
        continue;
      }
    }
    for (const s of g.members) schemeGroups.push({ label: s.name, light: s.name, dark: s.name });
  }
  schemeGroups.sort((a, b) => a.label.localeCompare(b.label));
}

function activeScheme() {
  const v = state.settings.scheme;
  if (v === 'builtin') return null;
  const g = schemeGroups.find(x => x.label === v);
  let name = v; // legacy: stored value may be a full scheme name
  if (g) {
    const mode = state.settings.themeMode;
    const dark = mode === 'dark' ||
      (mode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    name = dark ? g.dark : g.light;
  }
  return schemes.find(s => s.name === name) || schemes.find(s => s.name === v) || null;
}

async function loadSchemes() {
  try {
    const res = await fetch('color.txt');
    if (!res.ok) return;
    const text = await res.text();
    schemes = text.split(/\r?\n/).map(line => {
      const parts = line.split('|');
      if (parts.length < 5) return null;
      const palette = parts[4].trim().split(/\s+/);
      if (palette.length < 16) return null;
      return { name: parts[0].trim(), bg: parts[1].trim(), fg: parts[2].trim(), sel: parts[3].trim(), palette };
    }).filter(Boolean);

    buildSchemeGroups();
    const sel = $('#set-scheme');
    for (const g of schemeGroups) {
      const opt = document.createElement('option');
      opt.value = g.label;
      opt.textContent = g.label + (g.light !== g.dark ? ' ◐' : '');
      sel.appendChild(opt);
    }
    if (state.settings.scheme !== 'builtin') { applyTheme(); renderAll(); }
  } catch { /* file:// or offline — built-in themes still work */ }
}

const SCHEME_VARS = ['--bg', '--bg-raised', '--fg', '--fg-muted', '--line', '--line-soft',
                     '--month-a', '--month-b', '--weekend', '--outside', '--accent', '--accent-soft'];

function applyScheme() {
  const root = document.documentElement;
  const sc = activeScheme();
  if (!sc) {
    SCHEME_VARS.forEach(v => root.style.removeProperty(v));
    root.style.removeProperty('color-scheme');
    return;
  }
  const bg = hexRgb(sc.bg), fg = hexRgb(sc.fg);
  const dark = lum(bg) < 0.4;

  // pick an accent from the palette with enough contrast against the background
  let accent = null;
  for (const i of [4, 12, 6, 14, 2, 5, 3, 1]) {
    const c = hexRgb(sc.palette[i]);
    if (contrast(c, bg) >= 2.2) { accent = c; break; }
  }
  if (!accent) accent = fg;

  const set = (k, v) => root.style.setProperty(k, v);
  set('--bg', rgbCss(bg));
  set('--bg-raised', rgbCss(mixRgb(bg, fg, 0.05)));
  set('--fg', rgbCss(fg));
  set('--fg-muted', rgbCss(mixRgb(fg, bg, 0.35)));
  set('--line', rgbCss(mixRgb(bg, fg, 0.22)));
  set('--line-soft', rgbCss(mixRgb(bg, fg, 0.12)));
  set('--month-a', rgbCss(mixRgb(bg, fg, 0.05)));
  set('--month-b', rgbCss(bg));
  set('--weekend', rgbCss(fg, 0.05));
  set('--outside', rgbCss(mixRgb(bg, fg, 0.4)));
  set('--accent', rgbCss(accent));
  set('--accent-soft', rgbCss(accent, 0.16));
  root.style.colorScheme = dark ? 'dark' : 'light';
}

/* ---------------- theme */

function applyTheme() {
  const html = document.documentElement;
  html.dataset.theme = state.settings.themeMode;
  html.dataset.accent = state.settings.accent;
  const lw = state.settings.lineWidth;
  html.style.setProperty('--lw', lw + 'px');
  const dashes = {
    solid: 'none',
    dash: `${lw * 4} ${lw * 2.5}`,
    dot: `0.1 ${lw * 2.6}`,
    finedot: `0.1 ${lw * 1.6}`,
  };
  html.style.setProperty('--ldash', dashes[state.settings.lineDash] || 'none');
  html.style.setProperty('--numfs', (state.settings.numFont || 11) + 'px');
  html.style.setProperty('--lop', String(state.settings.lineOpacity != null ? state.settings.lineOpacity : 0.5));
  html.dataset.past = state.settings.pastStyle || 'none';
  applyScheme();
  // user-picked accent (a theme palette color) overrides the automatic one
  if (state.settings.accentCi != null) {
    const a = hexRgb(colorAt(state.settings.accentCi));
    html.style.setProperty('--accent', rgbCss(a));
    html.style.setProperty('--accent-soft', rgbCss(a, 0.16));
  } else if (state.settings.scheme === 'builtin') {
    html.style.removeProperty('--accent');
    html.style.removeProperty('--accent-soft');
  }
  const usingScheme = state.settings.scheme !== 'builtin';
  const icons = { auto: '◐', light: '☀︎', dark: '☾︎' };
  $('#theme-icon').textContent = icons[state.settings.themeMode] || icons.auto;
  $('#btn-theme').title = 'Theme: ' + state.settings.themeMode +
    (usingScheme ? ' · ' + state.settings.scheme : '');
}

/* ---------------- calendar grid */

function buildCalendar() {
  const ws = Number(state.settings.weekStart);
  const cal = $('#calendar');
  cal.innerHTML = '';

  // weekday header
  const dowRow = $('#dow-row');
  dowRow.innerHTML = '';
  const corner = document.createElement('div');
  dowRow.appendChild(corner);
  for (const name of (ws === 1 ? DOW_MON : DOW_SUN)) {
    const el = document.createElement('div');
    el.className = 'dow';
    el.textContent = name;
    dowRow.appendChild(el);
  }

  const monthsLen = Number(state.settings.months) === 18 ? 18 : 12;
  const lastDay = monthsLen === 18 ? new Date(year + 1, 5, 30) : new Date(year, 11, 31);
  const today = todayISO();
  let firstDay = new Date(year, 0, 1);
  if (state.settings.pastStyle === 'hide') {
    // push the calendar up: start at the current month, hide earlier ones
    const now = fromISO(today);
    const curMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    if (curMonth > firstDay && curMonth <= lastDay) firstDay = curMonth;
  }
  gridStart = startOfWeek(firstDay, ws);
  gridEnd = addDays(startOfWeek(lastDay, ws), 6);
  const rangeStart = iso(firstDay);
  const rangeEnd = iso(lastDay);

  for (let w = new Date(gridStart); w <= gridEnd; w = addDays(w, 7)) {
    const week = document.createElement('div');
    week.className = 'week';

    const label = document.createElement('div');
    label.className = 'wlabel';
    week.appendChild(label);

    for (let i = 0; i < 7; i++) {
      const d = addDays(w, i);
      const dIso = iso(d);
      const cell = document.createElement('div');
      cell.className = 'day';
      cell.dataset.date = dIso;
      cell.style.gridColumn = String(i + 2);

      const mIdx = d.getFullYear() * 12 + d.getMonth();
      cell.classList.add(mIdx % 2 === 0 ? 'm-even' : 'm-odd');
      if (d.getDay() === 0 || d.getDay() === 6) cell.classList.add('weekend');
      if (dIso < rangeStart || dIso > rangeEnd) cell.classList.add('outside');
      if (dIso < today) cell.classList.add('past');
      if (dIso === today) cell.classList.add('today');
      if (d.getDate() === 1) {
        cell.classList.add('first-of-month');
        label.textContent = MONTHS_SHORT[d.getMonth()];
      }

      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = d.getDate();
      cell.appendChild(num);
      week.appendChild(cell);
    }
    cal.appendChild(week);
  }
}

/* ---------------- event spans ("circled" ranges) */

function visibleEvents() {
  const gs = iso(gridStart), ge = iso(gridEnd);
  const hideBefore = state.settings.hidePastEvents ? todayISO() : null;
  return state.events.filter(ev =>
    ev.end >= gs && ev.start <= ge && (!hideBefore || ev.end >= hideBefore));
}

function renderSpans() {
  $$('.evspan').forEach(el => el.remove());
  const weeks = $$('#calendar .week');
  const gs = iso(gridStart), ge = iso(gridEnd);
  const occupancy = weeks.map(() => []);

  const visible = visibleEvents()
    .sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : (a.end > b.end ? -1 : 1));

  for (const ev of visible) {
    let d = fromISO(ev.start < gs ? gs : ev.start);
    const last = fromISO(ev.end > ge ? ge : ev.end);

    while (d <= last) {
      const wi = Math.floor(daysBetween(gridStart, d) / 7);
      const weekStartDate = addDays(gridStart, wi * 7);
      const colStart = daysBetween(weekStartDate, d);
      const segLast = daysBetween(weekStartDate, last) > 6 ? addDays(weekStartDate, 6) : last;
      const colEnd = daysBetween(weekStartDate, segLast);

      let lane = 0;
      while (occupancy[wi].some(o => o.lane === lane && !(colEnd < o.c1 || colStart > o.c2))) lane++;
      occupancy[wi].push({ c1: colStart, c2: colEnd, lane });

      const span = document.createElement('div');
      span.className = 'evspan';
      span.dataset.ev = ev.id;
      span.style.gridColumn = `${colStart + 2} / ${colEnd + 3}`;
      span.style.setProperty('--c', evColor(ev));
      span.style.setProperty('--lane', String(Math.min(lane, 3)));
      if (iso(d) === ev.start) span.classList.add('cap-l');
      if (iso(segLast) === ev.end) span.classList.add('cap-r');
      span.title = ev.title;
      weeks[wi].appendChild(span);

      d = addDays(segLast, 1);
    }
  }
}

/* ---------------- right panel */

function renderPanel() {
  const cards = $('#cards');
  cards.innerHTML = '';
  cards.style.height = '';
  cards.classList.toggle('slim', !!state.settings.slimCards);
  cards.classList.toggle('fit', !!state.settings.fitCards);
  const visible = visibleEvents()
    .sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No events yet. Drag across days on the calendar to add one — just like circling dates on paper.';
    cards.appendChild(empty);
    return;
  }

  const slim = !!state.settings.slimCards;
  for (const ev of visible) {
    const card = document.createElement('article');
    card.className = 'card';
    card.id = 'card-' + ev.id;
    card.dataset.ev = ev.id;
    card.style.setProperty('--c', evColor(ev));

    const bar = document.createElement('div');
    bar.className = 'card-bar';

    const main = document.createElement('div');
    main.className = 'card-main';
    const title = document.createElement('div');
    title.className = 'card-title';

    if (slim) {
      title.textContent = `${prettyRange(ev.start, ev.end, year)}: ${ev.title}`;
      main.appendChild(title);
    } else {
      title.textContent = ev.title;
      const dates = document.createElement('div');
      dates.className = 'card-dates';
      const nDays = daysBetween(fromISO(ev.start), fromISO(ev.end)) + 1;
      dates.textContent = `${prettyRange(ev.start, ev.end, year)} · ${nDays}d`;
      main.append(title, dates);
      if (ev.notes) {
        const notes = document.createElement('div');
        notes.className = 'card-notes';
        notes.textContent = ev.notes;
        main.appendChild(notes);
      }
    }

    const actions = document.createElement('div');
    actions.className = 'card-actions';
    actions.innerHTML = `<button data-action="del" class="del" title="Delete">✕</button>`;

    card.append(bar, main, actions);
    cards.appendChild(card);
  }

  positionCards(visible);
}

/* Place each card beside its event's week row (like a margin note),
   pushing down to avoid overlaps. User-dragged cards keep their spot. */
function cardMinX() {
  // let cards be dragged left into the gutter, up to near the calendar edge
  const cardsRect = $('#cards').getBoundingClientRect();
  const calRect = $('#calendar').getBoundingClientRect();
  return Math.min(0, -(cardsRect.left - calRect.right - 12));
}

function positionCards(visible) {
  const cardsEl = $('#cards');
  const cRect = cardsEl.getBoundingClientRect();
  const contW = cardsEl.clientWidth;
  const minX = cardMinX();
  let lastBottom = -8;

  for (const ev of visible) {
    // getElementById, not querySelector: imported ICS UIDs may contain
    // characters (':', '/', …) that are invalid in a CSS selector
    const card = document.getElementById('card-' + ev.id);
    if (!card) continue;
    const maxX = Math.max(0, contW - card.offsetWidth);

    if (ev.label) {
      card.style.left = Math.min(Math.max(ev.label.x, minX), maxX) + 'px';
      card.style.top = Math.max(0, ev.label.y) + 'px';
      continue;
    }

    const spans = $$(`#calendar .evspan[data-ev="${CSS.escape(ev.id)}"]`);
    let target = 0;
    if (spans.length) {
      const seg = spans[spans.length - 1].getBoundingClientRect();
      target = seg.top + seg.height / 2 - cRect.top - card.offsetHeight / 2;
    }
    const y = Math.max(target, lastBottom + 8, 0);
    card.style.left = '0px';
    card.style.top = y + 'px';
    lastBottom = y + card.offsetHeight;
  }

  let maxBottom = 0;
  $$('.card', cardsEl).forEach(c => { maxBottom = Math.max(maxBottom, c.offsetTop + c.offsetHeight); });
  const calBottom = $('#calendar').getBoundingClientRect().bottom - cRect.top;
  cardsEl.style.height = Math.max(maxBottom + 10, calBottom) + 'px';
}

/* ---------------- card dragging */

let cardDragMoved = false;

function initCardDrag() {
  const cardsEl = $('#cards');
  let drag = null;

  cardsEl.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const card = e.target.closest('.card');
    if (!card) return;
    drag = {
      card, id: card.dataset.ev,
      sx: e.clientX, sy: e.clientY,
      ox: card.offsetLeft, oy: card.offsetTop,
      moved: false,
    };
    cardDragMoved = false;
    try { card.setPointerCapture(e.pointerId); } catch { /* noop */ }
  });

  cardsEl.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    drag.card.classList.add('dragging');
    const minX = cardMinX();
    const maxX = Math.max(0, cardsEl.clientWidth - drag.card.offsetWidth);
    const maxY = Math.max(0, cardsEl.clientHeight - drag.card.offsetHeight);
    drag.card.style.left = Math.min(Math.max(drag.ox + dx, minX), maxX) + 'px';
    drag.card.style.top = Math.min(Math.max(drag.oy + dy, 0), maxY) + 'px';
    scheduleConnectors();
  });

  const finish = () => {
    if (!drag) return;
    const { card, id, moved } = drag;
    drag = null;
    card.classList.remove('dragging');
    if (moved) {
      cardDragMoved = true; // suppress the click that follows
      const ev = state.events.find(x => x.id === id);
      if (ev) {
        ev.label = { x: card.offsetLeft, y: card.offsetTop };
        saveState();
      }
      scheduleConnectors();
    }
  };
  cardsEl.addEventListener('pointerup', finish);
  cardsEl.addEventListener('pointercancel', finish);
}

/* ---------------- connector lines (event span -> card) */

let connectorRaf = 0;
function scheduleConnectors() {
  if (connectorRaf) return;
  connectorRaf = requestAnimationFrame(() => { connectorRaf = 0; drawConnectors(); });
}

function drawConnectors() {
  const svg = $('#connectors');
  const layout = $('#layout');
  const base = layout.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${base.width} ${base.height}`);
  svg.innerHTML = '';

  const panelRect = $('.panel').getBoundingClientRect();
  const calRect = $('#calendar').getBoundingClientRect();
  const calRight = calRect.right - base.left;

  // vertical "channels" in the gutter between calendar and panel, so
  // parallel lines never sit on top of each other
  const gutterL = calRight + 6;
  const gutterR = Math.max(gutterL, panelRect.left - base.left - 8);
  const step = 8;
  const channels = Math.max(1, Math.floor((gutterR - gutterL) / step));

  const style = state.settings.lineStyle || 'simple';
  const lw = state.settings.lineWidth || 1.6;
  const edgeRoute = state.settings.lineEdge !== false;
  const dynamic = !!state.settings.dynamicOrigin;
  const edgeUseB = new Map(); // row top -> lines already on its bottom edge
  const edgeUseT = new Map(); // row top -> lines already on its top edge
  const gap = lw + 1.4;       // spacing between parallel lines on one edge

  const cards = $$('#cards .card');
  cards.forEach((card, i) => {
    const id = card.dataset.ev;
    const ev = state.events.find(x => x.id === id);
    const spans = $$(`#calendar .evspan[data-ev="${CSS.escape(id)}"]`);
    if (!ev || !spans.length) return;

    const cardRect = card.getBoundingClientRect();
    const x2 = cardRect.left - base.left - 3;
    const y2 = cardRect.top + cardRect.height / 2 - base.top;

    // origin segment: normally the event's last week-row segment, but for
    // multi-row events a segment touching the calendar's right edge gives a
    // cleaner exit — pick the edge-touching one closest to the card
    let seg = spans[spans.length - 1];
    let edgeSeg = false;
    if (dynamic && spans.length > 1) {
      let best = null, bestDist = Infinity;
      for (const s of spans) {
        const r = s.getBoundingClientRect();
        if (calRect.right - r.right > 8) continue;
        const dist = Math.abs(r.top + r.height / 2 - base.top - y2);
        if (dist < bestDist) { best = s; bestDist = dist; }
      }
      if (best) { seg = best; edgeSeg = true; }
    }
    const segRect = seg.getBoundingClientRect();
    const rowRect = seg.parentElement.getBoundingClientRect();

    const yMid = segRect.top + segRect.height / 2 - base.top;
    const rowTop = rowRect.top - base.top;
    const rowBottom = rowRect.bottom - base.top;
    const rowKey = Math.round(rowRect.top);
    const segCx = (segRect.left + segRect.right) / 2 - base.left;

    // pick where the line leaves the event
    let exit = 'right';
    if (dynamic && !edgeSeg) {
      if (y2 > rowBottom + 6) exit = 'bottom';
      else if (y2 < rowTop - 6) exit = 'top';
    }
    let ox, oy;
    if (exit === 'right') { ox = segRect.right - base.left + 2; oy = yMid; }
    else if (exit === 'bottom') { ox = segCx; oy = segRect.bottom - base.top + 1; }
    else { ox = segCx; oy = segRect.top - base.top - 1; }
    if (x2 <= ox + 6) return;

    const color = evColor(ev);
    let d;

    if (style === 'straight') {
      d = `M ${ox} ${oy} L ${x2} ${y2}`;
    } else if (style === 'curved') {
      const dx = Math.min(Math.max((x2 - ox) / 2, 24), 130);
      if (exit === 'right') {
        d = `M ${ox} ${oy} C ${ox + dx} ${oy}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
      } else {
        const dy = Math.min(Math.max(Math.abs(y2 - oy) / 2, 16), 80) * (exit === 'bottom' ? 1 : -1);
        d = `M ${ox} ${oy} C ${ox} ${oy + dy}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
      }
    } else {
      // simple (elbow). With edge routing the horizontal run hugs a grid
      // line; parallel lines on the same edge are nudged apart.
      let cx = Math.max(gutterL + (i % channels) * step, ox + 6);
      if (x2 - cx < 10) cx = Math.max(ox + 6, x2 - 10);

      let p = `M ${ox} ${oy}`;
      let sy = oy;  // y of the horizontal run
      let hx = ox;  // where the horizontal run starts

      if (exit === 'right') {
        const crossesCells = calRight - ox > 14;
        if (edgeRoute && crossesCells) {
          const nudge = edgeUseB.get(rowKey) || 0;
          edgeUseB.set(rowKey, nudge + 1);
          sy = Math.max(rowBottom - 0.5 - nudge * gap, oy + 2);
          p += ` Q ${ox + 8} ${oy} ${ox + 8} ${sy}`;
          hx = ox + 8;
        }
      } else if (exit === 'bottom') {
        const nudge = edgeUseB.get(rowKey) || 0;
        edgeUseB.set(rowKey, nudge + 1);
        sy = Math.max(rowBottom - 0.5 + nudge * gap, oy + 2); // fan below the row line
        const rb = Math.min(4, sy - oy);
        p += ` V ${sy - rb} Q ${ox} ${sy} ${ox + rb} ${sy}`;
        hx = ox + rb;
      } else { // top
        const nudge = edgeUseT.get(rowKey) || 0;
        edgeUseT.set(rowKey, nudge + 1);
        sy = Math.min(rowTop + 0.5 - nudge * gap, oy - 2); // fan above the row line
        const rb = Math.min(4, oy - sy);
        p += ` V ${sy + rb} Q ${ox} ${sy} ${ox + rb} ${sy}`;
        hx = ox + rb;
      }

      if (Math.abs(y2 - sy) < 3 && hx === ox) {
        d = `M ${ox} ${oy} L ${x2} ${y2}`;
      } else {
        const dir = y2 > sy ? 1 : -1;
        const rr = Math.max(1, Math.min(8, Math.abs(y2 - sy) / 2, (cx - hx) / 2, (x2 - cx) / 2));
        d = p +
          ` H ${cx - rr}` +
          ` Q ${cx} ${sy} ${cx} ${sy + dir * rr}` +
          ` V ${y2 - dir * rr}` +
          ` Q ${cx} ${y2} ${cx + rr} ${y2}` +
          ` H ${x2}`;
      }
    }

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('stroke', color);
    path.dataset.ev = id;
    svg.appendChild(path);

    for (const [dx, dy] of [[ox, oy], [x2, y2]]) {
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', dx); dot.setAttribute('cy', dy);
      dot.setAttribute('r', '2.2'); dot.setAttribute('fill', color);
      dot.dataset.ev = id;
      svg.appendChild(dot);
    }
  });
}

function setHighlight(evId, on) {
  const method = on ? 'add' : 'remove';
  $$(`.evspan[data-ev="${CSS.escape(evId)}"], .card[data-ev="${CSS.escape(evId)}"]`)
    .forEach(el => el.classList[method]('hl'));
  $$(`#connectors path[data-ev="${CSS.escape(evId)}"]`)
    .forEach(el => el.classList[method]('hl'));
}

/* ---------------- render everything */

function renderAll() {
  $('#year-label').textContent = Number(state.settings.months) === 18
    ? `${year}–${String(year + 1).slice(2)}`
    : year;
  buildCalendar();
  renderSpans();
  renderPanel();
  scheduleConnectors();
}

/* ---------------- selection (drag on desktop, tap-tap on touch) */

let dragAnchor = null;   // ISO date where mouse/pen drag started
let dragFocus = null;
let tapAnchor = null;    // ISO date of first tap (touch flow)

function paintSelection(a, b) {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  $$('#calendar .day').forEach(cell => {
    const d = cell.dataset.date;
    cell.classList.toggle('sel', d >= lo && d <= hi);
  });
}

function clearSelection() {
  dragAnchor = dragFocus = null;
  $$('#calendar .day.sel').forEach(c => c.classList.remove('sel'));
}

function clearTapAnchor() {
  tapAnchor = null;
  $$('#calendar .day.pending').forEach(c => c.classList.remove('pending'));
}

function cellFromPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  return el && el.closest ? el.closest('.day') : null;
}

function initSelection() {
  const cal = $('#calendar');

  cal.addEventListener('pointerdown', e => {
    if (e.target.closest('.evspan')) return;
    const cell = e.target.closest('.day');
    if (!cell) return;
    if (e.pointerType === 'touch') return; // touch uses tap-tap flow on pointerup
    e.preventDefault();
    dragAnchor = dragFocus = cell.dataset.date;
    paintSelection(dragAnchor, dragFocus);
    try { cal.setPointerCapture(e.pointerId); } catch { /* noop */ }
  });

  cal.addEventListener('pointermove', e => {
    if (!dragAnchor || e.pointerType === 'touch') return;
    const cell = cellFromPoint(e.clientX, e.clientY);
    if (cell && cell.dataset.date !== dragFocus) {
      dragFocus = cell.dataset.date;
      paintSelection(dragAnchor, dragFocus);
    }
  });

  cal.addEventListener('pointerup', e => {
    if (e.pointerType === 'touch') {
      if (e.target.closest('.evspan')) return;
      const cell = e.target.closest('.day');
      if (!cell) return;
      const d = cell.dataset.date;
      if (!tapAnchor) {
        const existing = eventsOnDate(d);
        if (existing.length) { openDayChooser(d, existing); return; }
        tapAnchor = d;
        cell.classList.add('pending');
        toast('Start day picked — tap an end day, or tap it again for a single day.');
      } else {
        const [lo, hi] = tapAnchor <= d ? [tapAnchor, d] : [d, tapAnchor];
        clearTapAnchor();
        openEventModal({ start: lo, end: hi });
      }
      return;
    }
    if (!dragAnchor) return;
    const [lo, hi] = dragAnchor <= dragFocus ? [dragAnchor, dragFocus] : [dragFocus, dragAnchor];
    clearSelection();
    if (lo === hi) {
      const existing = eventsOnDate(lo);
      if (existing.length) { openDayChooser(lo, existing); return; }
    }
    openEventModal({ start: lo, end: hi });
  });

  cal.addEventListener('pointercancel', () => clearSelection());

  // click on a span: this day already has events — offer edit or add-another
  cal.addEventListener('click', e => {
    const span = e.target.closest('.evspan');
    if (!span) return;
    clearTapAnchor();
    const day = document.elementsFromPoint(e.clientX, e.clientY)
      .find(el => el.classList && el.classList.contains('day'));
    const date = day ? day.dataset.date : null;
    if (date) openDayChooser(date, eventsOnDate(date));
    else openEditModal(span.dataset.ev);
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { clearSelection(); clearTapAnchor(); }
  });
}

/* ---------------- event modal */

let editingId = null;
let pendingCi = 0;

function renderSwatches(selectedCi) {
  const wrap = $('#ev-colors');
  wrap.innerHTML = '';
  const count = themeEventPalette().length;
  for (let i = 0; i < count; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch' + (i === ((selectedCi % count) + count) % count ? ' sel' : '');
    b.style.setProperty('--c', colorAt(i));
    b.title = 'Color ' + (i + 1);
    b.addEventListener('click', () => { pendingCi = i; renderSwatches(i); });
    wrap.appendChild(b);
  }
}

function openEventModal({ start, end }) {
  editingId = null;
  $('#event-dialog-title').textContent = 'New event';
  $('#ev-title').value = '';
  $('#ev-start').value = start;
  $('#ev-end').value = end;
  pendingCi = state.settings.autoColor ? nextEventCi() : 0;
  renderSwatches(pendingCi);
  $('#ev-notes').value = '';
  $('#ev-delete').hidden = true;
  $('#ev-ics').hidden = true;
  $('#event-dialog').showModal();
  $('#ev-title').focus();
}

function openEditModal(id) {
  const ev = state.events.find(x => x.id === id);
  if (!ev) return;
  editingId = id;
  $('#event-dialog-title').textContent = 'Edit event';
  $('#ev-title').value = ev.title;
  $('#ev-start').value = ev.start;
  $('#ev-end').value = ev.end;
  pendingCi = ev.ci != null ? ev.ci : 0;
  renderSwatches(pendingCi);
  $('#ev-notes').value = ev.notes || '';
  $('#ev-delete').hidden = false;
  $('#ev-ics').hidden = false;
  $('#event-dialog').showModal();
}

/* ---------------- day chooser (clicked a day that already has events) */

function openDayChooser(date, eventIds) {
  const dialog = $('#choose-dialog');
  $('#choose-title').textContent = prettyDate(date, true);
  const list = $('#choose-list');
  list.innerHTML = '';
  for (const id of eventIds) {
    const ev = state.events.find(x => x.id === id);
    if (!ev) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'choose-item';
    b.style.setProperty('--c', evColor(ev));
    b.innerHTML = '<i></i>';
    const label = document.createElement('span');
    label.textContent = `${ev.title} · ${prettyRange(ev.start, ev.end, year)}`;
    b.appendChild(label);
    b.addEventListener('click', () => { dialog.close(); openEditModal(id); });
    list.appendChild(b);
  }
  $('#choose-new').onclick = () => { dialog.close(); openEventModal({ start: date, end: date }); };
  $('#choose-cancel').onclick = () => dialog.close();
  showDialog(dialog);
}

function eventsOnDate(date) {
  return state.events.filter(ev => ev.start <= date && ev.end >= date).map(ev => ev.id);
}

function initEventDialog() {
  const dialog = $('#event-dialog');

  $('#event-form').addEventListener('submit', () => {
    let start = $('#ev-start').value, end = $('#ev-end').value;
    if (!start || !end) return;
    if (end < start) [start, end] = [end, start];
    const data = {
      title: $('#ev-title').value.trim() || 'Untitled',
      start, end,
      ci: pendingCi,
      notes: $('#ev-notes').value.trim(),
    };
    if (editingId) {
      Object.assign(state.events.find(x => x.id === editingId), data);
    } else {
      state.events.push({ id: uid(), ...data });
    }
    saveState();
    renderAll();
  });

  $('#ev-cancel').addEventListener('click', () => dialog.close());

  $('#ev-delete').addEventListener('click', () => {
    if (!editingId) return;
    deleteEvent(editingId);
    dialog.close();
  });

  $('#ev-ics').addEventListener('click', () => {
    const ev = state.events.find(x => x.id === editingId);
    if (ev) exportICS([ev], safeFilename(ev.title) + '.ics');
  });
}

function deleteEvent(id) {
  const ev = state.events.find(x => x.id === id);
  if (!ev) return;
  if (!confirm(`Delete "${ev.title}"?`)) return;
  state.events = state.events.filter(x => x.id !== id);
  saveState();
  renderAll();
}

/* ---------------- settings */

function renderAccentSwatches() {
  const wrap = $('#accent-swatches');
  wrap.innerHTML = '';
  const auto = document.createElement('button');
  auto.type = 'button';
  auto.className = 'swatch auto' + (state.settings.accentCi == null ? ' sel' : '');
  auto.textContent = 'A';
  auto.title = 'Automatic (from theme)';
  auto.addEventListener('click', () => {
    state.settings.accentCi = null;
    saveState(); applyTheme(); renderAccentSwatches(); renderSchemePreview();
  });
  wrap.appendChild(auto);
  themeEventPalette().forEach((hex, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch' + (state.settings.accentCi === i ? ' sel' : '');
    b.style.setProperty('--c', hex);
    b.title = hex;
    b.addEventListener('click', () => {
      state.settings.accentCi = i;
      saveState(); applyTheme(); renderAccentSwatches(); renderSchemePreview();
    });
    wrap.appendChild(b);
  });
}

function renderSchemePreview() {
  const box = $('#scheme-preview');
  box.innerHTML = '';
  const sc = activeScheme();
  const chip = document.createElement('span');
  chip.className = 'preview-chip';
  chip.textContent = sc ? sc.name : 'Built-in (' + state.settings.themeMode + ')';
  box.appendChild(chip);
  const strip = document.createElement('div');
  strip.className = 'preview-strip';
  for (const hex of themeEventPalette()) {
    const sq = document.createElement('i');
    sq.style.background = hex;
    strip.appendChild(sq);
  }
  box.appendChild(strip);
}

function renderCheatsheet() {
  const list = $('#cheatsheet-list');
  list.innerHTML = '';

  // each strip is a mini preview rendered on the scheme's own background
  const strip = (bg, fg, colors) => {
    const el = document.createElement('span');
    el.className = 'cs-strip';
    el.style.background = bg;
    el.style.color = fg;
    const aa = document.createElement('span');
    aa.className = 'aa';
    aa.textContent = 'Aa';
    el.appendChild(aa);
    for (const c of colors) {
      const sq = document.createElement('i');
      sq.style.background = c;
      el.appendChild(sq);
    }
    return el;
  };

  const mkRow = (label, strips) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'cs-row' + (state.settings.scheme === label ? ' active' : '');
    const name = document.createElement('span');
    name.className = 'cs-name';
    name.textContent = label;
    row.appendChild(name);
    strips.forEach(s => row.appendChild(s));
    row.addEventListener('click', () => {
      state.settings.scheme = label;
      saveState(); applyTheme(); renderAll();
      renderAccentSwatches(); renderSchemePreview();
      $('#set-scheme').value = label;
      $$('.cs-row', list).forEach(r => r.classList.remove('active'));
      row.classList.add('active');
    });
    list.appendChild(row);
  };

  const PICK = [1, 2, 3, 4, 5, 6, 9, 12];
  mkRow('builtin', [
    strip('#f6f7f9', '#1c2330', PALETTE.slice(0, 8)),
    strip('#11151c', '#e6e9ef', PALETTE.slice(0, 8)),
  ]);
  for (const g of schemeGroups) {
    const light = schemes.find(s => s.name === g.light);
    const dark = schemes.find(s => s.name === g.dark);
    const strips = [];
    if (light) strips.push(strip(light.bg, light.fg, PICK.map(i => light.palette[i])));
    if (dark && g.dark !== g.light) strips.push(strip(dark.bg, dark.fg, PICK.map(i => dark.palette[i])));
    mkRow(g.label, strips);
  }
}

function syncFsButtons() {
  const cur = Number(state.settings.numFont || 11);
  $$('#fs-group .fs-btn').forEach(b => b.classList.toggle('active', Number(b.dataset.fs) === cur));
}

function buildTimezoneSelect() {
  const sel = $('#set-timezone');
  const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const sys = document.createElement('option');
  sys.value = '';
  sys.textContent = `System (${systemTz})`;
  sel.appendChild(sys);
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { /* older browsers */ }
  for (const z of zones) {
    const opt = document.createElement('option');
    opt.value = z;
    opt.textContent = z.replace(/_/g, ' ');
    sel.appendChild(opt);
  }
}

let settingsSnapshot = null;

function initSettings() {
  const dialog = $('#settings-dialog');
  buildTimezoneSelect();

  $('#btn-settings').addEventListener('click', () => {
    settingsSnapshot = JSON.stringify(state.settings);
    $('#set-weekstart').value = String(state.settings.weekStart);
    $('#set-timezone').value = state.settings.timezone;
    $('#set-scheme').value = state.settings.scheme;
    $('#set-theme').value = state.settings.themeMode;
    $('#set-months').value = String(Number(state.settings.months) === 18 ? 18 : 12);
    syncFsButtons();
    $('#set-paststyle').value = state.settings.pastStyle || 'none';
    $('#set-hidepast').checked = !!state.settings.hidePastEvents;
    $('#set-exportpast').checked = !!state.settings.exportPast;
    $('#set-autocolor').checked = !!state.settings.autoColor;
    $('#set-slim').checked = !!state.settings.slimCards;
    $('#set-fit').checked = !!state.settings.fitCards;
    $('#set-linewidth').value = state.settings.lineWidth;
    $('#set-lineopacity').value = state.settings.lineOpacity != null ? state.settings.lineOpacity : 0.5;
    $('#set-linestyle').value = state.settings.lineStyle;
    $('#set-linedash').value = state.settings.lineDash;
    $('#set-lineedge').checked = state.settings.lineEdge !== false;
    $('#set-dynorigin').checked = !!state.settings.dynamicOrigin;
    renderAccentSwatches();
    renderSchemePreview();
    showDialog(dialog);
  });

  $('#set-months').addEventListener('change', e => {
    state.settings.months = Number(e.target.value);
    saveState(); renderAll();
  });

  $('#fs-group').addEventListener('click', e => {
    const btn = e.target.closest('.fs-btn');
    if (!btn) return;
    state.settings.numFont = Number(btn.dataset.fs);
    saveState(); applyTheme();
    syncFsButtons();
  });

  $('#set-paststyle').addEventListener('change', e => {
    state.settings.pastStyle = e.target.value;
    saveState(); applyTheme();
    renderAll(); // "hide" changes the calendar range
  });

  $('#set-hidepast').addEventListener('change', e => {
    state.settings.hidePastEvents = e.target.checked;
    saveState(); renderAll();
  });

  $('#set-exportpast').addEventListener('change', e => {
    state.settings.exportPast = e.target.checked;
    saveState();
  });

  $('#set-slim').addEventListener('change', e => {
    state.settings.slimCards = e.target.checked;
    saveState(); renderAll();
  });

  $('#set-fit').addEventListener('change', e => {
    state.settings.fitCards = e.target.checked;
    saveState(); renderAll();
  });

  $('#btn-cheatsheet').addEventListener('click', () => {
    renderCheatsheet();
    showDialog($('#cheatsheet-dialog'));
  });
  $('#cheatsheet-close').addEventListener('click', () => $('#cheatsheet-dialog').close());

  $('#clear-calendar').addEventListener('click', () => {
    if (!state.events.length) { toast('Calendar is already empty.'); return; }
    if (!confirm(`Delete all ${state.events.length} event(s)? This cannot be undone.`)) return;
    state.events = [];
    saveState(); renderAll();
    toast('Calendar cleared.');
  });

  $('#set-lineedge').addEventListener('change', e => {
    state.settings.lineEdge = e.target.checked;
    saveState(); scheduleConnectors();
  });

  $('#set-dynorigin').addEventListener('change', e => {
    state.settings.dynamicOrigin = e.target.checked;
    saveState(); scheduleConnectors();
  });

  $('#set-autocolor').addEventListener('change', e => {
    state.settings.autoColor = e.target.checked;
    saveState();
  });

  $('#set-linewidth').addEventListener('input', e => {
    state.settings.lineWidth = Number(e.target.value);
    saveState(); applyTheme();
  });

  $('#set-lineopacity').addEventListener('input', e => {
    state.settings.lineOpacity = Number(e.target.value);
    saveState(); applyTheme();
  });

  $('#settings-cancel').addEventListener('click', () => {
    if (settingsSnapshot) {
      state.settings = JSON.parse(settingsSnapshot);
      saveState(); applyTheme(); renderAll();
    }
    dialog.close();
  });

  $('#set-linestyle').addEventListener('change', e => {
    state.settings.lineStyle = e.target.value;
    saveState(); scheduleConnectors();
  });

  $('#set-linedash').addEventListener('change', e => {
    state.settings.lineDash = e.target.value;
    saveState(); applyTheme();
  });

  $('#set-timezone').addEventListener('change', e => {
    state.settings.timezone = e.target.value;
    saveState(); renderAll(); // re-evaluates which cell is "today"
  });

  $('#set-scheme').addEventListener('change', e => {
    state.settings.scheme = e.target.value;
    saveState(); applyTheme();
    renderAll(); // event colors follow the scheme palette
    renderAccentSwatches();
    renderSchemePreview();
  });

  $('#set-weekstart').addEventListener('change', e => {
    state.settings.weekStart = Number(e.target.value);
    saveState(); renderAll();
  });
  $('#set-theme').addEventListener('change', e => {
    state.settings.themeMode = e.target.value;
    saveState(); applyTheme();
    renderAll(); // theme mode can switch a scheme's light/dark variant
    renderAccentSwatches();
    renderSchemePreview();
  });

  // in auto mode, a consolidated scheme follows the system light/dark switch
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.settings.themeMode === 'auto') { applyTheme(); renderAll(); }
  });

  $('#btn-reset-labels').addEventListener('click', () => {
    state.events.forEach(ev => { delete ev.label; });
    saveState(); renderAll();
    toast('Event labels back to automatic positions.');
  });

  $('#btn-theme').addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(state.settings.themeMode) + 1) % order.length];
    state.settings.themeMode = next;
    saveState(); applyTheme();
    renderAll(); // may switch a scheme's light/dark variant
    toast('Theme: ' + next);
  });
}

/* ---------------- ICS import/export */

function icsEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function icsDate(s) { return s.replace(/-/g, ''); }

function foldLine(line) {
  // RFC 5545: lines max 75 octets; simple char-based fold is fine for our content
  const out = [];
  while (line.length > 73) { out.push(line.slice(0, 73)); line = ' ' + line.slice(73); }
  out.push(line);
  return out.join('\r\n');
}

function buildICS(events) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CompactCalendar//Self-hosted//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    foldLine('X-WR-CALNAME:Compact Calendar'),
  ];
  for (const ev of events) {
    lines.push(
      'BEGIN:VEVENT',
      foldLine('UID:' + ev.id + '@compactcalendar'),
      'DTSTAMP:' + stamp,
      'DTSTART;VALUE=DATE:' + icsDate(ev.start),
      'DTEND;VALUE=DATE:' + icsDate(iso(addDays(fromISO(ev.end), 1))), // DTEND is exclusive
      foldLine('SUMMARY:' + icsEscape(ev.title)),
    );
    if (ev.notes) lines.push(foldLine('DESCRIPTION:' + icsEscape(ev.notes)));
    lines.push('TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

function safeFilename(s) {
  return (s || 'event').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'event';
}

function exportICS(events, filename) {
  if (!events.length) { toast('No events to export.'); return; }
  const blob = new Blob([buildICS(events)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('Exported ' + events.length + ' event(s) — open the file to add to your calendar app.');
}

function parseICS(text) {
  // unfold continuation lines, then walk VEVENT blocks
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (cur && cur.DTSTART) events.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).split(';')[0].toUpperCase();
    cur[key] = line.slice(idx + 1);
  }

  const unescape = s => String(s).replace(/\\n/gi, '\n').replace(/\\([\\;,])/g, '$1');
  const toIso = v => {
    const m = String(v).match(/(\d{4})(\d{2})(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  };

  return events.map(e => {
    const start = toIso(e.DTSTART);
    if (!start) return null;
    let end = e.DTEND ? toIso(e.DTEND) : start;
    // all-day DTEND is exclusive; date-times map onto their own day
    if (e.DTEND && !String(e.DTEND).includes('T') && end > start) {
      end = iso(addDays(fromISO(end), -1));
    }
    if (end < start) end = start;
    return {
      uid: e.UID || null,
      title: e.SUMMARY ? unescape(e.SUMMARY) : 'Imported event',
      start, end,
      notes: e.DESCRIPTION ? unescape(e.DESCRIPTION) : '',
      category: e.CATEGORIES ? unescape(e.CATEGORIES).split(',')[0].trim() : null,
    };
  }).filter(Boolean);
}

function importICSText(text) {
  let parsed;
  try { parsed = parseICS(text); } catch { parsed = []; }
  if (!parsed.length) { toast('No events found in that file.'); return; }

  let added = 0, skipped = 0;
  for (const p of parsed) {
    const id = p.uid ? p.uid.replace(/@.*$/, '') : uid();
    if (state.events.some(ev => ev.id === id)) { skipped++; continue; }
    const ci = state.settings.autoColor ? nextEventCi() : 0;
    state.events.push({ id, title: p.title, start: p.start, end: p.end, ci, notes: p.notes });
    added++;
  }
  saveState();
  renderAll();
  toast(`Imported ${added} event(s)${skipped ? `, skipped ${skipped} duplicate(s)` : ''}.`);
}

/* ---------------- save as image / PDF */

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Array.isArray(r) ? r : [r, r, r, r]; // tl tr br bl
  ctx.beginPath();
  ctx.moveTo(x + rr[0], y);
  ctx.lineTo(x + w - rr[1], y);
  ctx.arcTo(x + w, y, x + w, y + rr[1], rr[1]);
  ctx.lineTo(x + w, y + h - rr[2]);
  ctx.arcTo(x + w, y + h, x + w - rr[2], y + h, rr[2]);
  ctx.lineTo(x + rr[3], y + h);
  ctx.arcTo(x, y + h, x, y + h - rr[3], rr[3]);
  ctx.lineTo(x, y + rr[0]);
  ctx.arcTo(x, y, x + rr[0], y, rr[0]);
  ctx.closePath();
}

function exportImage(opts) {
  opts = opts || {};
  const mono = !!opts.mono;
  const qrMode = opts.qrMode || 'none';
  const layout = $('#layout');
  const base = layout.getBoundingClientRect();
  const scale = 2;
  const pad = 64; // header band: centered year + profile name

  // optionally exclude events that already ended
  const today = todayISO();
  const includePast = !!opts.includePast;
  const skipIds = new Set(
    includePast ? [] : state.events.filter(ev => ev.end < today).map(ev => ev.id));
  const exportable = el => !skipIds.has(el.dataset.ev);

  // grayscale helper (keeps relative brightness of event colors)
  const gray = c => {
    let rgb = [0, 0, 0];
    if (c && c.startsWith('#')) rgb = hexRgb(c);
    else if (c) {
      const m = c.match(/(\d+)[, ]+(\d+)[, ]+(\d+)/);
      if (m) rgb = [Number(m[1]), Number(m[2]), Number(m[3])];
    }
    const l = Math.min(150, Math.round(0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]));
    return `rgb(${l},${l},${l})`;
  };
  const col = (normal, monoVal) => mono ? monoVal : normal;

  const qrEvents = state.events
    .filter(ev => !skipIds.has(ev.id))
    .sort((a, b) => a.start < b.start ? -1 : 1);

  // plan QR codes first so the canvas can grow to fit them
  let qrPlan = null;       // one big QR for the whole calendar
  const perQRs = [];       // small QR beside each event label
  let extraW = 0;
  if (qrMode === 'whole' && qrEvents.length) {
    const matrix = QR.encode(buildICS(qrEvents));
    if (!matrix) {
      toast('Too many events to fit in a QR code — saving without it.');
    } else {
      const panelRect = $('.panel').getBoundingClientRect();
      const x0 = panelRect.left - base.left;
      const colW = base.width - x0;
      const n = matrix.length;
      const px = Math.max(2, Math.floor(Math.min(colW - 16, 260) / (n + 8)));
      const sizePx = px * (n + 8); // includes 4-module quiet zone each side
      let yTop = 16;
      const cardEls = $$('#cards .card').filter(exportable);
      if (cardEls.length) {
        yTop = Math.max(...cardEls.map(el => el.getBoundingClientRect().bottom - base.top)) + 20;
      }
      qrPlan = { matrix, n, px, sizePx, x: x0 + Math.max(0, (colW - sizePx) / 2), y: yTop };
    }
  } else if (qrMode === 'per' && qrEvents.length) {
    const px = 2;
    const cardEls = $$('#cards .card').filter(exportable)
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const items = [];
    for (const cardEl of cardEls) {
      const ev = state.events.find(x => x.id === cardEl.dataset.ev);
      if (!ev) continue;
      const matrix = QR.encode(buildICS([ev]));
      if (!matrix) continue;
      const n = matrix.length;
      const sizePx = px * (n + 8);
      const r = cardEl.getBoundingClientRect();
      items.push({
        matrix, n, px, sizePx, boxH: sizePx + 13, // box = QR + caption strip
        cardRight: r.right - base.left,
        cardCy: r.top + r.height / 2 - base.top,
        color: evColor(ev),
        title: ev.title,
      });
    }
    if (items.length) {
      // distribute the QR boxes evenly from the top of the image
      const sumH = items.reduce((s, q) => s + q.boxH, 0);
      const gap = Math.max(14, (base.height - sumH) / (items.length + 1));
      let y = gap;
      items.forEach((q, i) => { q.y = y; q.idx = i; y += q.boxH + gap; perQRs.push(q); });
      // left margin hosts the staggered leader channels
      extraW = 34 + Math.max(...items.map(q => q.sizePx)) + 16;
    }
  }

  const perBottom = perQRs.length ? Math.max(...perQRs.map(q => q.y + q.boxH)) + 16 : 0;
  const contentH = Math.max(base.height, qrPlan ? qrPlan.y + qrPlan.sizePx + 28 : 0, perBottom);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round((base.width + extraW) * scale);
  canvas.height = Math.round((contentH + pad) * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  ctx.fillStyle = col(getComputedStyle(document.body).backgroundColor, '#ffffff');
  ctx.fillRect(0, 0, base.width + extraW, contentH + pad);
  ctx.translate(0, pad); // content below the header band

  const rel = el => {
    const r = el.getBoundingClientRect();
    return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
  };

  const rootStyle = getComputedStyle(document.documentElement);
  const accent = rootStyle.getPropertyValue('--accent').trim() || '#1f6feb';
  const calRel = rel($('#calendar'));

  // header: centered year, then centered profile name on the next line
  const headerCx = (base.width + extraW) / 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = col(rootStyle.getPropertyValue('--fg').trim() || '#222', '#222222');
  ctx.font = `700 20px ${FONT}`;
  ctx.fillText($('#year-label').textContent, headerCx, -38);
  const owner = currentProfile();
  ctx.font = `600 13px ${FONT}`;
  ctx.fillStyle = col(rootStyle.getPropertyValue('--fg-muted').trim() || '#888', '#777777');
  ctx.fillText(`${profileGlyph(owner)} ${owner.name}`, headerCx, -16);

  const firstWeekDays = $$('#calendar .week')[0] ? $$('.day', $$('#calendar .week')[0]) : [];
  const dowNames = $$('.dow').map(el => el.textContent);
  ctx.font = `600 9.5px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillStyle = col(rootStyle.getPropertyValue('--fg-muted').trim() || '#888', '#777777');
  firstWeekDays.forEach((cell, i) => {
    if (dowNames[i] == null) return;
    const r = rel(cell);
    ctx.fillText(dowNames[i].toUpperCase(), r.x + r.w / 2, calRel.y - 5);
  });

  // day cells
  for (const el of $$('#calendar .day')) {
    const r = rel(el), s = getComputedStyle(el);
    ctx.fillStyle = mono
      ? (el.classList.contains('m-odd') ? '#f2f2f2' : '#ffffff')
      : s.backgroundColor;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = col(s.borderBottomColor, '#dddddd');
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(r.x, r.y + r.h); ctx.lineTo(r.x + r.w, r.y + r.h);
    ctx.moveTo(r.x + r.w, r.y); ctx.lineTo(r.x + r.w, r.y + r.h);
    ctx.stroke();

    const num = el.querySelector('.num');
    const ns = getComputedStyle(num);
    const dim = el.classList.contains('outside') ||
      (el.classList.contains('past') && state.settings.pastStyle !== 'none');
    ctx.fillStyle = col(ns.color, dim ? '#b5b5b5' : '#444444');
    ctx.font = `${ns.fontWeight} ${ns.fontSize} ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2 + 0.5;
    ctx.save();
    ctx.globalAlpha = mono ? 1 : Number(ns.opacity || 1);
    ctx.fillText(num.textContent, cx, cy);
    if (ns.textDecorationLine.includes('line-through')) {
      const tw = ctx.measureText(num.textContent).width;
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(cx - tw / 2 - 1, cy); ctx.lineTo(cx + tw / 2 + 1, cy); ctx.stroke();
    }
    ctx.restore();

    if (el.classList.contains('today')) {
      ctx.strokeStyle = col(accent, '#222222');
      ctx.lineWidth = 2;
      roundRectPath(ctx, r.x + 1, r.y + 1, r.w - 2, r.h - 2, 6);
      ctx.stroke();
    }
  }

  // month labels
  for (const el of $$('.wlabel')) {
    if (!el.textContent) continue;
    const r = rel(el), s = getComputedStyle(el);
    ctx.fillStyle = col(s.color, '#444444');
    ctx.font = `700 10px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(el.textContent.toUpperCase(), r.x + r.w - 8, r.y + r.h / 2);
  }

  // event spans ("circled" days)
  for (const el of $$('.evspan')) {
    if (!exportable(el)) continue;
    const r = rel(el);
    const c = col(el.style.getPropertyValue('--c').trim(), gray(el.style.getPropertyValue('--c').trim()));
    const capL = el.classList.contains('cap-l') ? r.h / 2 : 3;
    const capR = el.classList.contains('cap-r') ? r.h / 2 : 3;
    roundRectPath(ctx, r.x, r.y, r.w, r.h, [capL, capR, capR, capL]);
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = c;
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = c;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // connector lines (reuse the live SVG geometry)
  const firstPath = $('#connectors').querySelector('path');
  const dash = firstPath ? getComputedStyle(firstPath).strokeDasharray : 'none';
  const lineAlpha = Math.min(1, (state.settings.lineOpacity != null ? state.settings.lineOpacity : 0.5) + 0.1);
  for (const p of $$('#connectors path')) {
    if (skipIds.has(p.dataset.ev)) continue;
    ctx.save();
    ctx.globalAlpha = lineAlpha;
    ctx.strokeStyle = col(p.getAttribute('stroke'), gray(p.getAttribute('stroke')));
    ctx.lineWidth = state.settings.lineWidth || 1.6;
    ctx.lineCap = 'round';
    if (dash && dash !== 'none') ctx.setLineDash(dash.split(',').map(v => parseFloat(v)));
    ctx.stroke(new Path2D(p.getAttribute('d')));
    ctx.restore();
  }
  for (const c of $$('#connectors circle')) {
    if (skipIds.has(c.dataset.ev)) continue;
    ctx.fillStyle = col(c.getAttribute('fill'), gray(c.getAttribute('fill')));
    ctx.beginPath();
    ctx.arc(Number(c.getAttribute('cx')), Number(c.getAttribute('cy')), Number(c.getAttribute('r')), 0, Math.PI * 2);
    ctx.fill();
  }

  // event cards
  const raised = rootStyle.getPropertyValue('--bg-raised').trim();
  const lineCol = rootStyle.getPropertyValue('--line').trim();
  for (const el of $$('#cards .card')) {
    if (!exportable(el)) continue;
    const r = rel(el);
    roundRectPath(ctx, r.x, r.y, r.w, r.h, 8);
    ctx.fillStyle = col(raised || '#fff', '#ffffff');
    ctx.fill();
    ctx.strokeStyle = col(lineCol || '#ccc', '#cccccc');
    ctx.lineWidth = 1;
    ctx.stroke();
    const bar = el.querySelector('.card-bar');
    if (bar) {
      const br = rel(bar);
      roundRectPath(ctx, br.x, br.y, Math.max(br.w, 3), br.h, 2);
      ctx.fillStyle = col(el.style.getPropertyValue('--c').trim(), gray(el.style.getPropertyValue('--c').trim()));
      ctx.fill();
    }
    ctx.save();
    roundRectPath(ctx, r.x + 1, r.y + 1, r.w - 2, r.h - 2, 7);
    ctx.clip();
    for (const sel of ['.card-title', '.card-dates', '.card-notes']) {
      const t = el.querySelector(sel);
      if (!t) continue;
      const tr = rel(t), ts = getComputedStyle(t);
      ctx.fillStyle = col(ts.color, sel === '.card-title' ? '#222222' : '#777777');
      ctx.font = `${ts.fontWeight} ${ts.fontSize} ${FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const lines = sel === '.card-notes' ? t.textContent.split('\n') : [t.textContent];
      const lh = parseFloat(ts.lineHeight) || parseFloat(ts.fontSize) * 1.35;
      lines.forEach((ln, i) => ctx.fillText(ln, tr.x, tr.y + 1 + i * lh));
    }
    ctx.restore();
  }

  // QR code (always black on white, for scannability)
  if (qrPlan) {
    const { matrix, n, px, sizePx, x, y } = qrPlan;
    roundRectPath(ctx, x, y, sizePx, sizePx, 8);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = col(lineCol || '#ccc', '#cccccc');
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#000000';
    const off = 4 * px; // quiet zone
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (matrix[r][c]) ctx.fillRect(x + off + c * px, y + off + r * px, px, px);
      }
    }
    ctx.fillStyle = col(rootStyle.getPropertyValue('--fg-muted').trim() || '#888', '#777777');
    ctx.font = `500 10px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('Scan to import calendar (.ics)', x + sizePx / 2, y + sizePx + 6);
  }

  // individual QR beside each event label; leader uses the same
  // style / stroke / thickness as the calendar connectors
  const lwSet = state.settings.lineWidth || 1.6;
  const dashMap = {
    dash: [lwSet * 4, lwSet * 2.5],
    dot: [0.1, lwSet * 2.6],
    finedot: [0.1, lwSet * 1.6],
  };
  const leadDash = dashMap[state.settings.lineDash] || [];
  const leadStyle = state.settings.lineStyle || 'simple';
  const qrX = base.width + 34;
  for (const q of perQRs) {
    const sx = q.cardRight + 3, sy = q.cardCy;
    const ex = qrX - 3, ey = q.y + q.sizePx / 2;
    // each leader gets its own vertical channel so long runs never overlap
    const mx = Math.max(sx + 6, base.width + 5 + (q.idx % 8) * 3.2);
    let lp = `M ${sx} ${sy} `;
    if (leadStyle === 'curved') {
      const dx = Math.max(12, (ex - sx) / 2);
      lp += `C ${sx + dx} ${sy}, ${ex - dx} ${ey}, ${ex} ${ey}`;
    } else if (leadStyle === 'simple' && Math.abs(ey - sy) > 3 && ex - sx > 16) {
      const dir = ey > sy ? 1 : -1;
      const rr = Math.max(1, Math.min(6, Math.abs(ey - sy) / 2, (mx - sx) / 2, (ex - mx) / 2));
      lp += `H ${mx - rr} Q ${mx} ${sy} ${mx} ${sy + dir * rr}` +
            ` V ${ey - dir * rr} Q ${mx} ${ey} ${mx + rr} ${ey} H ${ex}`;
    } else {
      lp += `L ${ex} ${ey}`;
    }
    ctx.save();
    ctx.strokeStyle = col(q.color, gray(q.color));
    ctx.globalAlpha = lineAlpha;
    ctx.lineWidth = lwSet;
    ctx.lineCap = 'round';
    ctx.setLineDash(leadDash);
    ctx.stroke(new Path2D(lp));
    ctx.restore();

    // bordered box: QR on top, tiny event title at the bottom
    roundRectPath(ctx, qrX, q.y, q.sizePx, q.boxH, 6);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = col(q.color, gray(q.color));
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = '#000000';
    const off = 4 * q.px;
    for (let r = 0; r < q.n; r++) {
      for (let c = 0; c < q.n; c++) {
        if (q.matrix[r][c]) ctx.fillRect(qrX + off + c * q.px, q.y + off + r * q.px, q.px, q.px);
      }
    }
    ctx.fillStyle = '#444444';
    ctx.font = `500 7.5px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    let cap = q.title;
    if (ctx.measureText(cap).width > q.sizePx - 8) {
      while (cap.length > 1 && ctx.measureText(cap + '…').width > q.sizePx - 8) cap = cap.slice(0, -1);
      cap += '…';
    }
    ctx.fillText(cap, qrX + q.sizePx / 2, q.y + q.sizePx);
  }

  canvas.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `compact-calendar-${year}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, 'image/png');
}

function initExportDialog() {
  const dialog = $('#export-dialog');
  $('#btn-export-image').addEventListener('click', () => {
    $('#export-qrmode').value = state.settings.exportQRMode || 'none';
    $('#export-mono').checked = !!state.settings.exportMono;
    showDialog(dialog);
  });
  $('#export-cancel').addEventListener('click', () => dialog.close());
  $('#export-png').addEventListener('click', () => {
    state.settings.exportQRMode = $('#export-qrmode').value;
    state.settings.exportMono = $('#export-mono').checked;
    saveState();
    dialog.close();
    exportImage({
      qrMode: state.settings.exportQRMode,
      mono: state.settings.exportMono,
      includePast: state.settings.exportPast,
    });
  });
}

function initImportExport() {
  $('#btn-export').addEventListener('click', () => {
    const today = todayISO();
    const evs = state.events
      .filter(ev => state.settings.exportPast || ev.end >= today)
      .sort((a, b) => a.start < b.start ? -1 : 1);
    if (!evs.length && state.events.length) {
      toast('All events are in the past — enable "Include past events in exports" in settings.');
      return;
    }
    exportICS(evs, `compact-calendar-${year}.ics`);
  });

  $('#btn-import').addEventListener('click', () => $('#ics-file').click());

  $('#ics-file').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    importICSText(await file.text());
    e.target.value = '';
  });

  // per-card actions + card click to edit + hover highlight
  $('#cards').addEventListener('click', e => {
    if (cardDragMoved) { cardDragMoved = false; return; } // it was a drag, not a click
    const card = e.target.closest('.card');
    if (!card) return;
    const evId = card.dataset.ev;
    const btn = e.target.closest('button[data-action]');
    if (btn) {
      if (btn.dataset.action === 'del') deleteEvent(evId);
      return;
    }
    openEditModal(evId);
  });
}

/* ---------------- hover highlighting (cards <-> spans <-> lines) */

function initHighlighting() {
  const over = e => {
    const el = e.target.closest('[data-ev]');
    if (el) setHighlight(el.dataset.ev, true);
  };
  const out = e => {
    const el = e.target.closest('[data-ev]');
    if (el) setHighlight(el.dataset.ev, false);
  };
  for (const root of [$('#cards'), $('#calendar')]) {
    root.addEventListener('mouseover', over);
    root.addEventListener('mouseout', out);
  }
}

/* ---------------- profile UI (picker overlay + edit dialog) */

let pickerManage = false;
let editingProfileId = null;
let pendingProfileColor = PALETTE[0];

function firstGrapheme(s) {
  s = (s || '').trim();
  if (!s) return '?';
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return [...seg.segment(s)][0].segment;
  } catch {
    return Array.from(s)[0]; // code-point fallback (still emoji-safe)
  }
}

const profileGlyph = p =>
  p.avatar ? firstGrapheme(p.avatar) : firstGrapheme(p.name).toUpperCase();

function updateProfileChip() {
  const p = currentProfile();
  const chip = $('#profile-chip');
  chip.textContent = profileGlyph(p);
  chip.style.background = p.color || PALETTE[0];
  $('#btn-profile').title = 'Profile: ' + p.name + ' — click to switch';

  const owner = $('#cal-owner');
  owner.innerHTML = '';
  const badge = document.createElement('span');
  badge.className = 'owner-badge';
  badge.style.background = p.color || PALETTE[0];
  badge.textContent = profileGlyph(p);
  const nm = document.createElement('span');
  nm.textContent = p.name;
  owner.append(badge, nm);
}

function renderProfilePicker() {
  const grid = $('#profile-grid');
  grid.innerHTML = '';
  grid.classList.toggle('managing', pickerManage);
  for (const p of profiles.list) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'profile-tile' + (p.id === profiles.current ? ' current' : '');
    const av = document.createElement('div');
    av.className = 'profile-avatar';
    av.style.background = p.color || PALETTE[0];
    av.textContent = profileGlyph(p);
    const nm = document.createElement('span');
    nm.className = 'pname';
    nm.textContent = p.name;
    tile.append(av, nm);
    tile.addEventListener('click', () => pickerManage ? openProfileDialog(p.id) : enterProfile(p.id));
    grid.appendChild(tile);
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'profile-tile add';
  add.innerHTML = '<div class="profile-avatar">+</div><span class="pname">Add profile</span>';
  add.addEventListener('click', () => openProfileDialog(null));
  grid.appendChild(add);
}

function showPicker() {
  pickerManage = false;
  $('#profile-manage').textContent = 'Manage profiles';
  renderProfilePicker();
  $('#profile-picker').hidden = false;
}

async function enterProfile(id) {
  if (profiles.current !== id) {
    profiles.current = id;
    saveProfiles();
    await syncPullProfile(id);
    state = loadState();
    year = new Date().getFullYear();
    applyTheme();
    renderAll();
  }
  updateProfileChip();
  $('#profile-picker').hidden = true;
}

function renderProfileColors(sel) {
  const wrap = $('#profile-colors');
  wrap.innerHTML = '';
  for (const c of PALETTE) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch' + (c === sel ? ' sel' : '');
    b.style.setProperty('--c', c);
    b.addEventListener('click', () => { pendingProfileColor = c; renderProfileColors(c); });
    wrap.appendChild(b);
  }
}

const AVATAR_EMOJI = ['🦊','🐼','🐸','🦉','🐙','🦄','🐝','🐢','🦋','🌵','🍀','🌙',
  '⭐','🔥','🌈','🍉','🍋','🥑','🍩','🎈','🎨','🎸','🚀','⚡'];

function openProfileDialog(id) {
  editingProfileId = id;
  const p = id ? profiles.list.find(x => x.id === id) : null;
  $('#profile-dialog-title').textContent = p ? 'Edit profile' : 'New profile';
  $('#profile-name').value = p ? p.name : '';
  $('#profile-avatar-input').value = p
    ? (p.avatar || '')
    : AVATAR_EMOJI[Math.floor(Math.random() * AVATAR_EMOJI.length)];
  pendingProfileColor = p ? (p.color || PALETTE[0]) : PALETTE[profiles.list.length % PALETTE.length];
  renderProfileColors(pendingProfileColor);
  $('#profile-delete').hidden = !p || profiles.list.length <= 1;
  showDialog($('#profile-dialog'));
  if (!p) $('#profile-name').focus();
}

function initProfiles() {
  $('#btn-profile').addEventListener('click', showPicker);
  $('#picker-close').addEventListener('click', () => { $('#profile-picker').hidden = true; });
  $('#profile-manage').addEventListener('click', () => {
    pickerManage = !pickerManage;
    $('#profile-manage').textContent = pickerManage ? 'Done managing' : 'Manage profiles';
    renderProfilePicker();
  });

  $('#profile-cancel').addEventListener('click', () => $('#profile-dialog').close());

  $('#profile-save').addEventListener('click', () => {
    const name = $('#profile-name').value.trim() || 'Profile';
    const avRaw = $('#profile-avatar-input').value.trim();
    const avatar = avRaw ? firstGrapheme(avRaw) : null;
    if (editingProfileId) {
      const p = profiles.list.find(x => x.id === editingProfileId);
      if (p) { p.name = name; p.color = pendingProfileColor; p.avatar = avatar; }
      saveProfiles();
      $('#profile-dialog').close();
      updateProfileChip();
      renderProfilePicker();
    } else {
      const p = { id: pid(), name, color: pendingProfileColor, avatar };
      profiles.list.push(p);
      saveProfiles();
      $('#profile-dialog').close();
      enterProfile(p.id); // fresh profile starts with its own empty calendar
    }
  });

  $('#profile-delete').addEventListener('click', () => {
    const p = profiles.list.find(x => x.id === editingProfileId);
    if (!p) return;
    if (!confirm(`Delete profile "${p.name}" and its whole calendar?`)) return;
    localStorage.removeItem(dataKey(p.id));
    if (serverMode) fetch(`${API}/data/${encodeURIComponent(p.id)}`, { method: 'DELETE' }).catch(() => {});
    profiles.list = profiles.list.filter(x => x.id !== p.id);
    const wasCurrent = profiles.current === p.id;
    if (wasCurrent) profiles.current = profiles.list[0].id;
    saveProfiles();
    $('#profile-dialog').close();
    if (wasCurrent) {
      state = loadState();
      applyTheme();
      renderAll();
    }
    updateProfileChip();
    renderProfilePicker();
  });

  updateProfileChip();
  // Netflix-style: always ask who's planning on launch
  showPicker();
}

/* ---------------- misc UI */

/* showModal focuses the first control; on iOS that pops the select picker
   immediately. Blur it so dialogs open quietly. */
function showDialog(dialog) {
  dialog.showModal();
  const ae = document.activeElement;
  if (ae && ae !== dialog && dialog.contains(ae) && typeof ae.blur === 'function') ae.blur();
}

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

function measureTopbar() {
  const h = $('.topbar').getBoundingClientRect().height;
  document.documentElement.style.setProperty('--topbar-h', h + 'px');
}

/* ---------------- init */

function init() {
  applyTheme();
  loadSchemes();
  // attach all listeners before the first render, so a data-dependent
  // render error can never leave the UI without working controls
  initSelection();
  initEventDialog();
  initSettings();
  initImportExport();
  initExportDialog();
  initHighlighting();
  initCardDrag();
  initProfiles();
  measureTopbar();
  try {
    renderAll();
  } catch (err) {
    console.error(err);
    toast('Some events could not be rendered: ' + err.message);
  }

  $('#prev-year').addEventListener('click', () => { year--; renderAll(); });
  $('#next-year').addEventListener('click', () => { year++; renderAll(); });

  window.addEventListener('resize', () => {
    measureTopbar();
    renderPanel(); // card auto-positions depend on layout geometry
    scheduleConnectors();
  });
  // capture-phase scroll catches both page scroll and the panel's inner scroll
  window.addEventListener('scroll', scheduleConnectors, { capture: true, passive: true });
}

(async function boot() {
  await syncInit();
  if (serverMode) {
    profiles = loadProfiles();
    state = loadState();
  }
  init();

  // returning to the tab: pick up changes other people/devices made
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !serverMode) return;
    await flushPuts(); // our edits first, so they aren't lost
    const before = JSON.stringify(state) + JSON.stringify(profiles.list);
    await syncInit();
    profiles = loadProfiles();
    state = loadState();
    if (JSON.stringify(state) + JSON.stringify(profiles.list) !== before) {
      applyTheme();
      renderAll();
      updateProfileChip();
    }
  });
})();
