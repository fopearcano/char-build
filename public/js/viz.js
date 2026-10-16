// Infographics. Each function returns an SVG/HTML string for a character.
// Colours come from CSS variables so light/dark themes both work.

import * as K from '/shared/catalog.js';
import { esc } from './ui.js';
import { traitDensity as traitDensityData, antagonismProfile, choiceDepth, definingDimension, overallProgress, suspenseScore } from '/shared/analysis.js';
import { SECTIONS } from '/shared/sections.js';
import { displayName, isFilled } from '/shared/model.js';
import { t, tn } from '/shared/i18n.js';

const ch = (n) => t('Ch. {n}', { n });
const MO_GROUP_LABELS = { Hollywood: () => t('Hollywood MO'), Political: () => t('Political MO'), Object: () => t('Object MO') };

const trunc = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const deg = (a) => (a * Math.PI) / 180;
const polar = (cx, cy, r, aDeg) => [cx + r * Math.cos(deg(aDeg)), cy + r * Math.sin(deg(aDeg))];
const f1 = (n) => Math.round(n * 10) / 10;

function svg(w, h, body, cls = '', label = '') {
  return `<svg class="viz ${cls}" viewBox="0 0 ${w} ${h}" role="img" ${label ? `aria-label="${esc(label)}"` : ''} preserveAspectRatio="xMidYMid meet">${body}</svg>`;
}

function wrapText(text, maxChars, maxLines = 3) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars) {
      if (cur) lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    } else cur = (cur + ' ' + w).trim();
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) lines[maxLines - 1] = trunc(lines[maxLines - 1], maxChars - 1) + '…';
  return lines;
}

function tspanLines(lines, x, y, lh = 13, attrs = '') {
  return `<text x="${x}" y="${y}" ${attrs}>${lines.map((l, i) => `<tspan x="${x}" dy="${i ? lh : 0}">${esc(l)}</tspan>`).join('')}</text>`;
}

export function progressRing(ratio, size = 54, stroke = 6, color = 'var(--accent)', inner = '') {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  return `<svg class="ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-label="${esc(t('{pct}% complete', { pct }))}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--track)" stroke-width="${stroke}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"
      stroke-dasharray="${f1(c * ratio)} ${f1(c)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
    <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" class="ring-txt" font-size="${size * 0.26}">${inner || `${pct}%`}</text>
  </svg>`;
}

function card(title, body, sub = '') {
  return `<div class="viz-card"><div class="viz-head"><h3>${esc(title)}</h3>${sub ? `<span class="viz-sub">${sub}</span>` : ''}</div>${body}</div>`;
}

function empty(msg) {
  return `<p class="viz-empty">${esc(msg)}</p>`;
}

// ── 01 · Spark: the five spheres of inspiration ──────────────────────────
export function sparkSpheres(c) {
  const sel = new Set(c.concept?.inspiration || []);
  const rings = [
    { label: t('Actuality'), on: sel.has('reality') },
    { label: t('Media'), on: sel.has('medium') },
    { label: t('Genre'), on: sel.has('genre') },
    { label: t('Story · events, theme, past'), on: ['events', 'theme', 'biography', 'selfStory'].some((s) => sel.has(s)) },
    { label: t('Author'), on: sel.has('insideOut') || c.concept?.approach === 'insideOut' || c.concept?.approach === 'alternating' },
  ];
  const cx = 160;
  const cy = 150;
  let body = '';
  rings.forEach((rg, i) => {
    const r = 140 - i * 27;
    body += `<circle cx="${cx}" cy="${cy}" r="${r}" class="sphere ${rg.on ? 'on' : ''}" style="--i:${i}"/>`;
  });
  rings.forEach((rg, i) => {
    const r = 140 - i * 27;
    body += `<text x="${cx}" y="${cy - r + 15}" text-anchor="middle" class="sphere-lbl ${rg.on ? 'on' : ''}">${esc(rg.label)}</text>`;
  });
  body += `<circle cx="${cx}" cy="${cy}" r="10" class="sphere-core"/>`;
  const detail = c.concept?.tellingDetail;
  const magic = c.concept?.magicIf;
  return card(t('Five spheres of inspiration'), svg(320, 300, body, '', t('Spheres of inspiration')), ch(4)) +
    card(t('The spark'), `${detail ? `<p class="quote"><span class="qmark">“</span>${esc(trunc(detail, 220))}</p>` : empty(t('Add the telling detail — the facet that implies a whole humanity.'))}
      ${magic ? `<div class="magic-if"><b>${esc(t('Magic If'))}</b> ${esc(trunc(magic, 200))}</div>` : ''}`);
}

// ── 02 · Role: orbit + essentials ────────────────────────────────────────
export function castOrbit(c, ctx = {}) {
  const cast = ctx.cast || [c];
  const cx = 160;
  const cy = 160;
  const radii = [0, 62, 104, 142];
  let body = radii.slice(1).map((r, i) => `<circle cx="${cx}" cy="${cy}" r="${r}" class="orbit" />
    <text x="${cx + r - 4}" y="${cy - 4}" text-anchor="end" class="orbit-lbl">${esc([t('1st'), t('2nd'), t('3rd')][i])}</text>`).join('');
  body += `<circle cx="${cx}" cy="${cy}" r="26" class="sun"/>`;
  const byRing = { 1: [], 2: [], 3: [] };
  for (const m of cast) {
    const ring = K.CIRCLES.find((x) => x.id === m.cast?.circle)?.ring;
    if (ring) byRing[ring].push(m);
  }
  for (const [ring, members] of Object.entries(byRing)) {
    members.forEach((m, i) => {
      const a = (360 / Math.max(members.length, 1)) * i - 90 + ring * 25;
      const [x, y] = polar(cx, cy, radii[ring], a);
      const me = m.id === c.id;
      body += `<circle cx="${f1(x)}" cy="${f1(y)}" r="${me ? 11 : 6}" fill="${esc(m.color)}" class="planet ${me ? 'me' : ''}"><title>${esc(displayName(m))}</title></circle>`;
      if (me) body += `<text x="${f1(x)}" y="${f1(y + 24)}" text-anchor="middle" class="planet-lbl">${esc(trunc(displayName(m), 16))}</text>`;
    });
  }
  const prots = cast.filter((m) => m.cast?.circle === 'protagonist');
  body += `<text x="${cx}" y="${cy + 4}" text-anchor="middle" class="sun-lbl">${esc(trunc(prots[0] ? displayName(prots[0]) : t('Protagonist'), 12))}</text>`;
  if (c.cast?.circle === 'protagonist') body += `<circle cx="${cx}" cy="${cy}" r="31" class="me-ring"/>`;

  const ess = new Set(c.cast?.essentials || []);
  const segs = K.PROTAGONIST_ESSENTIALS.map((e, i) => {
    const on = ess.has(e.id);
    return `<div class="ess ${on ? 'on' : ''}" title="${esc(e.desc)}"><span class="ess-n">${i + 1}</span>${esc(e.label)}</div>`;
  }).join('');
  const isProt = c.cast?.circle === 'protagonist' || !c.cast?.circle;
  const cog = c.cast?.centerOfGood;
  return card(t('The cast as a solar system'), svg(320, 320, body, '', t('Cast orbit')), ch(6)) +
    (isProt ? card(t('Protagonist essentials'), `<div class="ess-grid">${segs}</div>${cog ? `<div class="cog"><span class="cog-dot"></span><div><b>${esc(t('Center of Good'))}</b><p>${esc(trunc(cog, 160))}</p></div></div>` : ''}`, `${ess.size}/8`) : '');
}

// ── 03 · Explicit: the 3/10 canvas ───────────────────────────────────────
export function traitDensity(c) {
  const td = traitDensityData(c);
  const cells = K.EXPLICIT_TRAITS.map((tr) => {
    const known = td.knownKeys.includes(tr.id);
    const shown = td.expressedKeys.includes(tr.id);
    return `<div class="cell ${shown ? 'shown' : known ? 'known' : ''}" title="${esc(tr.label)} — ${esc(shown ? t('dramatized') : known ? t('known to author') : t('unknown'))}"><span>${esc(tr.short || tr.label)}</span></div>`;
  }).join('');
  const pct = Math.round(td.expressedRatio * 100);
  const meter = `<div class="density-meter" aria-label="${esc(t('Dramatized {pct}% of known traits', { pct }))}">
      <div class="dm-bar"><div class="dm-fill" style="width:${Math.min(100, pct)}%"></div><div class="dm-target" style="left:30%"><span>3/10</span></div></div>
      <div class="dm-legend"><span><i class="lgd shown"></i>${esc(t('{n} dramatized', { n: td.expressed }))}</span><span><i class="lgd known"></i>${esc(t('{n} known', { n: td.known }))}</span><span><i class="lgd"></i>${esc(t('{n} unknown', { n: td.total - td.known }))}</span></div>
    </div>`;
  const spectra = [...K.PUBLIC_SPECTRA, ...K.PRIVATE_SPECTRA];
  const sp = c.outer?.spectra || {};
  const hasSp = spectra.some((s) => Number.isFinite(sp[s.id]));
  return card(t('Trait canvas'), `<div class="canvas-grid">${cells}</div>${meter}<p class="viz-note">${esc(t('McKee: leave about seven-tenths of a protagonist unknown; the audience fills in the rest.'))}</p>`, esc(t('{pct}% dramatized', { pct }))) +
    (hasSp ? card(t('Public & private spectra'), diverging(spectra.map((s) => ({ left: s.left, right: s.right, value: sp[s.id] })), 5)) : '');
}
export function diverging(rows, max = 5) {
  const w = 360;
  const rowH = 26;
  const mid = w / 2;
  const scale = (w / 2 - 104) / max;
  const body = rows.map((r, i) => {
    const y = i * rowH + 14;
    const v = Number.isFinite(r.value) ? r.value : null;
    const len = v == null ? 0 : Math.abs(v) * scale;
    const x = v == null ? mid : v < 0 ? mid - len : mid;
    return `<text x="4" y="${y + 4}" class="dv-l ${v != null && v < 0 ? 'act' : ''}">${esc(r.left)}</text>
      <text x="${w - 4}" y="${y + 4}" text-anchor="end" class="dv-r ${v != null && v > 0 ? 'act' : ''}">${esc(r.right)}</text>
      <line x1="${mid - max * scale}" x2="${mid + max * scale}" y1="${y}" y2="${y}" class="dv-track"/>
      ${v == null ? `<circle cx="${mid}" cy="${y}" r="2.5" class="dv-null"/>` : `<rect x="${f1(x)}" y="${y - 5}" width="${f1(Math.max(len, 2))}" height="10" rx="3" class="dv-bar ${v < 0 ? 'neg' : 'pos'}"/>`}`;
  }).join('') + `<line x1="${mid}" x2="${mid}" y1="2" y2="${rows.length * rowH + 2}" class="dv-mid"/>`;
  return svg(w, rows.length * rowH + 6, body, 'diverging');
}

// ── 04 · Implicit: Big Five radar + intelligences ────────────────────────
export function bigFive(c) {
  const bf = c.outer?.implicit?.bigFive || {};
  const cx = 190;
  const cy = 150;
  const R = 100;
  const n = K.BIG_FIVE.length;
  const angle = (i) => -90 + (360 / n) * i;
  let grid = '';
  for (const k of [0.25, 0.5, 0.75, 1]) {
    grid += `<polygon class="radar-grid" points="${K.BIG_FIVE.map((_, i) => polar(cx, cy, R * k, angle(i)).map(f1).join(',')).join(' ')}"/>`;
  }
  let axes = '';
  K.BIG_FIVE.forEach((trait, i) => {
    const [x, y] = polar(cx, cy, R, angle(i));
    const [lx, ly] = polar(cx, cy, R + 22, angle(i));
    axes += `<line x1="${cx}" y1="${cy}" x2="${f1(x)}" y2="${f1(y)}" class="radar-axis"/>`;
    const v = bf[trait.id];
    const lbl = Number.isFinite(v) ? (v >= 50 ? trait.right : trait.left) : trait.label;
    axes += `<text x="${f1(lx)}" y="${f1(ly)}" text-anchor="${Math.abs(lx - cx) < 8 ? 'middle' : lx > cx ? 'start' : 'end'}" dominant-baseline="middle" class="radar-lbl">${esc(lbl)}</text>`;
  });
  const set = K.BIG_FIVE.some((trait) => Number.isFinite(bf[trait.id]));
  const poly = set ? `<polygon class="radar-shape" points="${K.BIG_FIVE.map((trait, i) => polar(cx, cy, R * (num(bf[trait.id], 50) / 100), angle(i)).map(f1).join(',')).join(' ')}"/>` +
    K.BIG_FIVE.map((trait, i) => {
      const [x, y] = polar(cx, cy, R * (num(bf[trait.id], 50) / 100), angle(i));
      return `<circle cx="${f1(x)}" cy="${f1(y)}" r="3.5" class="radar-dot"/>`;
    }).join('') : '';
  const intel = c.outer?.implicit?.intelligence || {};
  const bars = K.INTELLIGENCES.map((kind) => {
    const v = intel[kind.id];
    return `<div class="hbar"><span class="hb-l">${esc(kind.label)}</span><span class="hb-track"><span class="hb-fill" style="width:${num(v) * 10}%"></span></span><span class="hb-v">${Number.isFinite(v) ? v : '—'}</span></div>`;
  }).join('');
  return card(t('Five galaxies of personality'), svg(380, 300, grid + axes + poly, '', t('Personality radar')) + (set ? '' : empty(t('Move the sliders to draw her personality.'))), ch(7)) +
    card(t('Intelligences'), `<div class="hbars">${bars}</div>`);
}

// ── 05 · World: rings of setting + expression coverage ───────────────────
export function settingRings(c) {
  const s = c.outer?.setting || {};
  const levels = new Set(s.levels || []);
  const rings = [
    { id: 'physical', text: s.physical },
    { id: 'social', text: s.social },
    { id: 'personal', text: s.personal },
    { id: 'inner', text: '' },
  ].map((r) => ({ ...r, label: K.CONFLICT_LEVELS.find((l) => l.id === r.id)?.label || r.id }));
  const cx = 160;
  const cy = 150;
  let body = '';
  rings.forEach((r, i) => {
    const rad = 138 - i * 32;
    const on = levels.has(r.id) || isFilled(r.text);
    body += `<circle cx="${cx}" cy="${cy}" r="${rad}" class="lvl lvl-${r.id} ${on ? 'on' : ''}"/>`;
    body += `<text x="${cx}" y="${cy - rad + 18}" text-anchor="middle" class="lvl-lbl ${on ? 'on' : ''}">${esc(r.label)}</text>`;
  });
  body += `<circle cx="${cx}" cy="${cy}" r="30" fill="${esc(c.color)}" class="me-dot"/><text x="${cx}" y="${cy + 4}" text-anchor="middle" class="me-ini">${esc(trunc(displayName(c).split(' ')[0], 8))}</text>`;
  const rel = K.SETTING_RELATIONS.find((x) => x.id === s.relation);
  const exp = c.outer?.expression || {};
  const techs = K.EXPRESSION_TECHNIQUES.map((tq) => `<span class="badge ${isFilled(exp[tq.id]) ? 'on' : ''}" title="${esc(exp[tq.id] || tq.desc)}">${esc(tq.label)}</span>`).join('');
  return card(t('Levels of conflict in her world'), svg(320, 300, body, '', t('Setting rings')) + (rel ? `<p class="viz-note"><b>${esc(rel.label)}</b> — ${esc(rel.desc)}</p>` : ''), ch(7)) +
    card(t('Nine ways to express her'), `<div class="badges">${techs}</div>`, `${K.EXPRESSION_TECHNIQUES.filter((tq) => isFilled(exp[tq.id])).length}/9`);
}

// ── 06 · Four selves ─────────────────────────────────────────────────────
export function fourSelves(c, { compact = false } = {}) {
  const sv = c.selves || {};
  const cx = 150;
  const cy = 150;
  const rings = [
    { id: 'social', r: 140 }, { id: 'personal', r: 106 }, { id: 'core', r: 72 }, { id: 'hidden', r: 38 },
  ];
  let body = '';
  rings.forEach((rg) => {
    const on = isFilled(sv[rg.id]);
    body += `<circle cx="${cx}" cy="${cy}" r="${rg.r}" class="self self-${rg.id} ${on ? 'on' : ''}"/>`;
  });
  rings.forEach((rg) => {
    const def = K.SELF_LEVELS.find((x) => x.id === rg.id);
    const y = rg.id === 'hidden' ? cy + 4 : cy - rg.r + 19;
    body += `<text x="${cx}" y="${y}" text-anchor="middle" class="self-lbl ${isFilled(sv[rg.id]) ? 'on' : ''}">${esc(def.short || def.label)}</text>`;
  });
  const notes = K.SELF_LEVELS.map((s) => `<div class="self-note self-${s.id} ${isFilled(sv[s.id]) ? 'on' : ''}"><b>${esc(s.label)}</b><span class="mm">${esc(s.madMen)}</span><p>${esc(trunc(sv[s.id], compact ? 120 : 200)) || '<i>—</i>'}</p></div>`).join('');
  const personae = (sv.personae || []).length;
  return card(t('Four selves in search of a character'), svg(300, 300, body, '', t('Four selves')) + `<div class="self-notes">${notes}</div>`, `${esc(ch(5))}${personae ? ` · ${esc(tn(personae, '{n} persona', '{n} personae'))}` : ''}`);
}

// ── 07 · Motivation ladder & desire chain ────────────────────────────────
export function motivationLadder(c) {
  const mot = c.inner?.motivations || {};
  const top = [...K.MOTIVATIONS].filter((m) => Number(mot[m.id]) > 0).sort((a, b) => mot[b.id] - mot[a.id]).slice(0, 3).map((m) => m.id);
  const rungs = [...K.MOTIVATIONS].reverse().map((m) => {
    const v = num(mot[m.id]);
    const i = K.MOTIVATIONS.indexOf(m);
    return `<div class="rung ${top.includes(m.id) ? 'top' : ''}" title="${esc(m.desc)}"><span class="rung-n">${i + 1}</span><span class="rung-l">${esc(m.label)}</span><span class="rung-track"><span class="rung-fill" style="width:${v * 10}%"></span></span><span class="rung-v">${v || ''}</span></div>`;
  }).join('');
  return card(t('Ladder of motivation'), `<div class="ladder"><span class="ladder-cap">${esc(t('↑ elevated'))}</span><div class="rungs">${rungs}</div><span class="ladder-cap">${esc(t('primal ↓'))}</span></div>`, ch(8)) +
    card(t('From push to pull'), desireChain(c));
}

export function desireChain(c) {
  const mot = c.inner?.motivations || {};
  const top = [...K.MOTIVATIONS].filter((m) => Number(mot[m.id]) > 0).sort((a, b) => mot[b.id] - mot[a.id]).slice(0, 2).map((m) => m.label);
  const charge = c.inner?.incitingCharge;
  const steps = [
    { k: t('Motivation'), v: top.join(' + '), cls: 'm' },
    { k: `${t('Inciting incident')} ${charge === 'positive' ? '(+)' : charge === 'negative' ? '(−)' : ''}`, v: c.inner?.incitingIncident, cls: 'i' },
    { k: t('Super-objective'), v: c.inner?.superObjective, cls: 's' },
    { k: t('Object of desire'), v: c.inner?.objectOfDesire, cls: 'o' },
    { k: t('Counterdesire'), v: c.complexity?.subconsciousDesire, cls: 'x' },
  ];
  return `<ol class="chain">${steps.map((s) => `<li class="chain-${s.cls} ${isFilled(s.v) ? 'on' : ''}"><b>${esc(s.k)}</b><span>${esc(trunc(s.v, 130)) || '—'}</span></li>`).join('')}</ol>`;
}

// ── 08 · Choice depth + dilemma + emotions ───────────────────────────────
export function choiceDepthViz(c) {
  const d = choiceDepth(c);
  const cx = 150;
  const cy = 130;
  const R = 100;
  const v = d == null ? 0 : d / 10;
  const arc = (from, to, cls) => {
    const [x1, y1] = polar(cx, cy, R, 180 + from * 180);
    const [x2, y2] = polar(cx, cy, R, 180 + to * 180);
    return `<path d="M ${f1(x1)} ${f1(y1)} A ${R} ${R} 0 0 1 ${f1(x2)} ${f1(y2)}" class="${cls}"/>`;
  };
  const [nx, ny] = polar(cx, cy, R - 18, 180 + v * 180);
  let body = arc(0, 1, 'gauge-track') + (d == null ? '' : arc(0, Math.max(v, 0.01), 'gauge-fill'));
  body += `<line x1="${cx}" y1="${cy}" x2="${f1(nx)}" y2="${f1(ny)}" class="gauge-needle"/><circle cx="${cx}" cy="${cy}" r="6" class="gauge-hub"/>`;
  body += `<text x="${cx}" y="${cy + 30}" text-anchor="middle" class="gauge-num">${d == null ? '—' : d}</text>`;
  body += `<text x="${cx - R}" y="${cy + 16}" text-anchor="middle" class="gauge-end">${esc(t('trivial'))}</text><text x="${cx + R}" y="${cy + 16}" text-anchor="middle" class="gauge-end">${esc(t('profound'))}</text>`;
  const dl = c.inner?.dilemma || {};
  const kind = K.DILEMMA_KINDS.find((x) => x.id === dl.kind);
  const dilemma = (dl.optionA || dl.optionB) ? `<div class="dilemma">
      <div class="beam"><div class="pan a"><b>A</b><p>${esc(trunc(dl.optionA, 110)) || '—'}</p></div><div class="fulcrum">${kind ? (kind.id === 'positive' ? '+ / +' : '− / −') : '?'}</div><div class="pan b"><b>B</b><p>${esc(trunc(dl.optionB, 110)) || '—'}</p></div></div>
      ${dl.choice ? `<p class="choice"><b>${esc(t('She chooses'))}</b> ${esc(trunc(dl.choice, 160))}</p>` : ''}</div>` : empty(t('Set two near-equal options to test her.'));
  const em = c.inner?.emotions || {};
  const hasEm = K.EMOTION_PAIRS.some((p) => Number.isFinite(em[p.id]));
  return card(t('Depth of choice'), svg(300, 175, body, '', t('Choice depth gauge')) + `<p class="viz-note">${esc(t('Risk {risk}/10 × freedom {freedom}/10. Greater risk, deeper choice; freer choice, deeper still.', { risk: num(c.inner?.pressure?.risk, '—'), freedom: num(c.inner?.pressure?.freedom, '—') }))}</p>`, ch(8)) +
    card(kind ? kind.label : t('The dilemma'), dilemma) +
    (hasEm ? card(t('Emotional palette'), diverging(K.EMOTION_PAIRS.map((p) => ({ left: p.left, right: p.right, value: em[p.id] })), 5)) : '');
}

// ── 09 · Dimension wheel ─────────────────────────────────────────────────
export function dimensionWheel(c, { interactive = true } = {}) {
  const dims = (c.dimensions || []).filter((d) => d.positive || d.negative);
  const def = definingDimension(c);
  const cx = 170;
  const cy = 170;
  const R = 112;
  let body = `<circle cx="${cx}" cy="${cy}" r="${R + 34}" class="wheel-rim"/>`;
  const others = dims.filter((d) => d !== def);
  others.forEach((d, i) => {
    const a = (360 / Math.max(others.length, 1)) * i - 90;
    const [x1, y1] = polar(cx, cy, 46, a);
    const [xm, ym] = polar(cx, cy, 46 + (R - 46) / 2, a);
    const [x2, y2] = polar(cx, cy, R, a);
    const [lx, ly] = polar(cx, cy, R + 12, a);
    const anchor = Math.abs(lx - cx) < 10 ? 'middle' : lx > cx ? 'start' : 'end';
    body += `<g class="spoke" ${interactive ? `data-action="focus-dim" data-id="${esc(d.id)}" tabindex="0" role="button"` : ''}>
      <line x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(xm)}" y2="${f1(ym)}" class="sp-pos"/>
      <line x1="${f1(xm)}" y1="${f1(ym)}" x2="${f1(x2)}" y2="${f1(y2)}" class="sp-neg"/>
      <circle cx="${f1(x2)}" cy="${f1(y2)}" r="5" class="sp-end lvl-${esc(d.level || 'none')}"/>
      <text x="${f1(lx)}" y="${f1(ly - 5)}" text-anchor="${anchor}" class="sp-lbl pos">${esc(trunc(d.positive, 16))}</text>
      <text x="${f1(lx)}" y="${f1(ly + 8)}" text-anchor="${anchor}" class="sp-lbl neg">${esc(trunc(d.negative, 16))}</text>
    </g>`;
  });
  body += `<circle cx="${cx}" cy="${cy}" r="46" class="hub ${def ? 'on' : ''}" ${def && interactive ? `data-action="focus-dim" data-id="${esc(def.id)}"` : ''}/>`;
  if (def) {
    body += `<text x="${cx}" y="${cy - 7}" text-anchor="middle" class="hub-pos">${esc(trunc(def.positive, 13))}</text><text x="${cx}" y="${cy + 3}" text-anchor="middle" class="hub-slash">/</text><text x="${cx}" y="${cy + 15}" text-anchor="middle" class="hub-neg">${esc(trunc(def.negative, 13))}</text>`;
  } else {
    body += `<text x="${cx}" y="${cy + 4}" text-anchor="middle" class="hub-empty">${esc(dims.length ? t('choose a defining') : t('no dimensions'))}</text>`;
  }
  const legend = `<div class="legend"><span><i class="lgd pos"></i>${esc(t('positive pole'))}</span><span><i class="lgd neg"></i>${esc(t('negative pole'))}</span><span><i class="lgd hubk"></i>${esc(t('defining dimension (the axle)'))}</span></div>`;
  return card(t('Dimension wheel'), svg(340, 340, body, 'wheel', t('Dimension wheel')) + legend, `${esc(tn(dims.length, '{n} dimension', '{n} dimensions'))} · ${esc(ch(9))}`);
}

// ── 10 · Underdog scale + antagonism stack + depth ────────────────────────
export function underdogScale(c) {
  const ap = antagonismProfile(c);
  const cap = ap.capacity;
  const diff = cap == null ? 0 : ap.power - cap;
  const tilt = Math.max(-16, Math.min(16, diff * 3)); // right pan (antagonism) heavier → tilts right-down
  const cx = 160;
  const cy = 70;
  const L = 110;
  const [lx, ly] = [cx - L * Math.cos(deg(tilt)), cy - L * Math.sin(deg(tilt))];
  const [rx, ry] = [cx + L * Math.cos(deg(tilt)), cy + L * Math.sin(deg(tilt))];
  const pan = (x, y, label, value, cls) => `<line x1="${f1(x)}" y1="${f1(y)}" x2="${f1(x - 30)}" y2="${f1(y + 46)}" class="string"/><line x1="${f1(x)}" y1="${f1(y)}" x2="${f1(x + 30)}" y2="${f1(y + 46)}" class="string"/>
    <path d="M ${f1(x - 38)} ${f1(y + 46)} Q ${f1(x)} ${f1(y + 70)} ${f1(x + 38)} ${f1(y + 46)} Z" class="pan ${cls}"/>
    <text x="${f1(x)}" y="${f1(y + 58)}" text-anchor="middle" class="pan-v">${value == null ? '—' : value}</text>
    <text x="${f1(x)}" y="${f1(y + 90)}" text-anchor="middle" class="pan-l">${esc(label)}</text>`;
  let body = `<polygon points="${cx - 14},${cy + 150} ${cx + 14},${cy + 150} ${cx},${cy}" class="post"/>`;
  body += `<line x1="${f1(lx)}" y1="${f1(ly)}" x2="${f1(rx)}" y2="${f1(ry)}" class="beam-line"/>`;
  body += pan(lx, ly, t('Her capacities'), cap, 'cap') + pan(rx, ry, t('Antagonism'), ap.power || 0, 'ant');
  body += `<circle cx="${cx}" cy="${cy}" r="5" class="pivot"/>`;
  const verdict = cap == null ? t('Rate her capacity to weigh her against the world.') : ap.underdog ? t('Underdog: the forces of antagonism outweigh her — she has a chance, just a chance.') : t('Not yet an underdog: the world should virtually overwhelm her.');
  const groups = K.CONFLICT_LEVELS.map((lv) => {
    const fs = ap.forces.filter((f) => f.level === lv.id);
    return `<div class="stack-row"><span class="st-l">${esc(lv.label)}</span><span class="st-bars">${fs.map((f) => `<span class="st-seg lvl-${lv.id}" style="flex:${Math.max(f.value, 0.001)}" title="${esc(f.label)}: ${f.value}"></span>`).join('')}<span class="st-rest" style="flex:${Math.max(0.001, fs.length * 10 - fs.reduce((s, f) => s + f.value, 0))}"></span></span><span class="st-v">${fs.reduce((s, f) => s + f.value, 0)}</span></div>`;
  }).join('');
  const depth = new Set(c.complexity?.depthTraits || []);
  const dots = K.DEPTH_TRAITS.map((dt) => `<span class="dot ${depth.has(dt.id) ? 'on' : ''}" title="${esc(dt.label)}"></span>`).join('');
  return card(t('The underdog scale'), svg(320, 250, body, '', t('Underdog balance')) + `<p class="viz-note ${ap.underdog ? 'good' : ''}">${esc(verdict)}</p>`, ch('6, 10')) +
    card(t('Forces of antagonism by level'), `<div class="stack">${groups}</div>`, esc(t('{n}/4 levels', { n: ap.levelsEngaged }))) +
    card(t('Depth of character'), `<div class="dots">${dots}</div><p class="viz-note">${esc(t('{n}/10 depth traits', { n: depth.size }))}</p>`);
}

// ── 11 · Arc chart (draggable turning points) ────────────────────────────
export function arcChart(c, { interactive = true } = {}) {
  const tps = c.arc?.turningPoints || [];
  const w = 340;
  const h = 230;
  const pad = { l: 26, r: 14, t: 18, b: 34 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;
  const y = (v) => pad.t + ih / 2 - (v / 5) * (ih / 2);
  const x = (i) => pad.l + (tps.length <= 1 ? iw / 2 : (iw * i) / (tps.length - 1));
  let body = `<rect x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih / 2}" class="arc-pos-zone"/><rect x="${pad.l}" y="${pad.t + ih / 2}" width="${iw}" height="${ih / 2}" class="arc-neg-zone"/>`;
  body += `<line x1="${pad.l}" x2="${pad.l + iw}" y1="${y(0)}" y2="${y(0)}" class="arc-zero"/>`;
  body += `<text x="${pad.l - 6}" y="${y(5) + 4}" text-anchor="end" class="arc-ax">+</text><text x="${pad.l - 6}" y="${y(-5) + 4}" text-anchor="end" class="arc-ax">−</text>`;
  if (tps.length) {
    const pts = tps.map((t, i) => [x(i), y(num(Number(t.charge)))]);
    body += `<path d="M ${pts.map((p) => p.map(f1).join(' ')).join(' L ')}" class="arc-line"/>`;
    tps.forEach((t, i) => {
      const [px, py] = pts[i];
      const v = num(Number(t.charge));
      body += `<g class="tp ${interactive ? 'draggable' : ''}" ${interactive ? `data-drag="tp" data-index="${i}"` : ''}>
        <circle cx="${f1(px)}" cy="${f1(py)}" r="${interactive ? 9 : 6}" class="tp-dot ${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}"><title>${esc(t.label)} (${v > 0 ? '+' : ''}${v})</title></circle>
        <text x="${f1(px)}" y="${f1(py + (v >= 0 ? -14 : 22))}" text-anchor="middle" class="tp-n">${i + 1}</text>
      </g>`;
    });
  } else {
    body += `<text x="${w / 2}" y="${h / 2 + 4}" text-anchor="middle" class="viz-empty-t">${esc(t('Add turning points to draw the arc'))}</text>`;
  }
  body += `<text x="${pad.l}" y="${h - 10}" class="arc-end">${esc(t('inciting incident'))}</text><text x="${pad.l + iw}" y="${h - 10}" text-anchor="end" class="arc-end">${esc(t('climax'))}</text>`;
  const type = K.ARC_TYPES.find((a) => a.id === c.arc?.type);
  const dim = (c.dimensions || []).find((d) => d.id === c.arc?.dimensionId);
  const head = type ? `<div class="arc-type"><b>${esc(type.label)}</b>${c.arc?.from || c.arc?.to ? ` <span>${esc(c.arc.from || '?')} → ${esc(c.arc.to || '?')}</span>` : ''}${dim ? `<em>${esc(t('along {pos} / {neg}', { pos: dim.positive, neg: dim.negative }))}</em>` : ''}</div>` : '';
  const legend = tps.length ? `<ol class="tp-list">${tps.map((tp) => `<li><span class="${Number(tp.charge) > 0 ? 'pos' : Number(tp.charge) < 0 ? 'neg' : ''}">${Number(tp.charge) > 0 ? '+' : ''}${num(Number(tp.charge))}</span> ${esc(trunc(tp.label, 60))}</li>`).join('')}</ol>` : '';
  const steps = [
    [t('Preparation'), c.arc?.need],
    [t('Revelation'), c.arc?.isAtClimax || c.arc?.seemsAtStart],
    [t('Change'), c.arc?.type && c.arc.type !== 'revealed' ? `${c.arc.from || ''} → ${c.arc.to || ''}` : c.arc?.type === 'revealed' ? K.ARC_TYPES.find((a) => a.id === 'revealed').label : ''],
    [t('Completion'), c.arc?.completion || c.arc?.climax],
  ];
  const four = `<div class="four-steps">${steps.map(([k, v], i) => `<div class="fs ${isFilled(v) ? 'on' : ''}"><span>${i + 1}</span><b>${esc(k)}</b><p>${esc(trunc(v, 90)) || '—'}</p></div>`).join('')}</div>`;
  return card(t('Arc of turning points'), head + svg(w, h, body, 'arc', t('Arc chart')) + (interactive && tps.length ? `<p class="viz-note">${esc(t('Drag a point up or down to change its charge.'))}</p>` : '') + legend, ch(11)) +
    card(t('Four steps of character design'), four);
}

// ── 12 · Symbolic spectrum + reality quadrant ────────────────────────────
export function symbolicSpectrum(c) {
  const sym = c.symbolic || {};
  const levels = ['archetype', 'allegory', 'type', 'stock'];
  const idx = levels.indexOf(sym.level);
  const bands = levels.map((l, i) => {
    const o = K.SYMBOLIC_LEVELS.find((x) => x.id === l);
    return `<div class="band b${i} ${idx === i ? 'on' : ''}" title="${esc(o.desc)}"><b>${esc(o.label)}</b><span>${esc(o.desc.split('.')[0])}</span></div>`;
  }).join('');
  const sp = sym.spectrum;
  const realism = `<div class="real-bar"><span>${esc(t('Realism'))}</span><div class="rb-track"><div class="rb-marker" style="left:${Number.isFinite(sp) ? sp * 10 : 50}%;${Number.isFinite(sp) ? '' : 'opacity:.3'}"></div></div><span>${esc(t('Symbolism'))}</span></div>`;
  const quad = K.REALITY_MODES.map((m) => `<div class="q q-${m.id} ${sym.mode === m.id ? 'on' : ''}"><b>${esc(m.label)}</b><span>${esc(m.char === 'conventional' ? t('conventional character') : t('unconventional character'))} · ${esc(m.world === 'conventional' ? t('conventional world') : t('unconventional world'))}</span></div>`).join('');
  const arche = (sym.archetypes || []).map((id) => K.ARCHETYPES.find((a) => a.id === id)?.label).filter(Boolean);
  return card(t('From brightest to dimmest'), `<div class="bands">${bands}</div>${sym.level === 'none' ? `<p class="viz-note">${esc(t('Realistic: personification outweighs symbol.'))}</p>` : ''}${realism}${arche.length ? `<p class="viz-note">${esc(t('Archetypal chords:'))} <b>${esc(arche.join(', '))}</b></p>` : ''}${sym.veil ? `<p class="quote small">${esc(trunc(sym.veil, 160))}</p>` : ''}`, ch(12)) +
    card(t('Character × world'), `<div class="quad"><span class="qa qa-y">${esc(t('world: conventional → unconventional'))}</span>${quad}</div>`, ch(13));
}

// ── 13 · Genre card ──────────────────────────────────────────────────────
export function genreCard(c, ctx = {}) {
  const story = ctx.story;
  const ids = story?.genre?.primary || [];
  const genres = ids.map((id) => K.PRIMARY_GENRES.find((g) => g.id === id)).filter(Boolean);
  if (!genres.length) return card(t('Story genre'), empty(t('Choose the story’s primary genre(s) in story settings.')), ch(14));
  return genres.map((g) => {
    const [pos, neg] = g.coreValue.split(' vs. ');
    return card(g.label, `<div class="genre-sheet">
      <div class="gv"><span class="gv-pos">${esc(pos)}</span><span class="gv-vs">${esc(t('vs.'))}</span><span class="gv-neg">${esc(neg)}</span></div>
      <dl><dt>${esc(t('Core event'))}</dt><dd>${esc(g.coreEvent)}</dd><dt>${esc(t('Core emotion'))}</dt><dd>${esc(g.coreEmotion)}</dd><dt>${esc(t('Core cast'))}</dt><dd>${g.coreCast.map((r) => `<span class="cc ${c.genre?.coreCastRole === r ? 'on' : ''}">${esc(t(r))}</span>`).join('')}</dd></dl>
    </div>`, esc(g.family === 'fortune' ? t('Plot of Fortune') : t('Plot of Character · {quality}', { quality: g.quality })));
  }).join('');
}

// ── 14 · Scene beats ─────────────────────────────────────────────────────
export function sceneBeats(c) {
  const scenes = c.action?.scenes || [];
  const mo = K.MO_THEMES.find((m) => m.id === c.action?.mo?.theme);
  const w = 300;
  const rowH = 40;
  const sx = (v) => 40 + ((num(v) + 5) / 10) * (w - 80);
  let body = `<line x1="${sx(0)}" x2="${sx(0)}" y1="4" y2="${Math.max(1, scenes.length) * rowH}" class="sb-zero"/>`;
  scenes.forEach((s, i) => {
    const y = i * rowH + 26;
    const hasVals = Number.isFinite(s.from) && Number.isFinite(s.to);
    body += `<text x="4" y="${y - 12}" class="sb-title">${esc(trunc(`${i + 1}. ${s.title || t('Scene')}${s.value ? ` — ${s.value}` : ''}`, 44))}</text>`;
    body += `<line x1="${sx(-5)}" x2="${sx(5)}" y1="${y}" y2="${y}" class="sb-track"/>`;
    if (hasVals) {
      const dir = s.to > s.from ? 'pos' : s.to < s.from ? 'neg' : 'flat';
      body += `<line x1="${f1(sx(s.from))}" x2="${f1(sx(s.to))}" y1="${y}" y2="${y}" class="sb-move ${dir}" marker-end="url(#arrow-${dir})"/>`;
      body += `<circle cx="${f1(sx(s.from))}" cy="${y}" r="4" class="sb-from"/>`;
    }
  });
  const defs = `<defs>${['pos', 'neg', 'flat'].map((d) => `<marker id="arrow-${d}" viewBox="0 0 10 10" refX="7" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="mk-${d}"/></marker>`).join('')}</defs>`;
  const self = c.action?.selfStory || {};
  const ss = [['past', t('past')], ['present', t('present')], ['future', t('future')]].map(([k, label]) => `<div class="ss ${isFilled(self[k]) ? 'on' : ''}"><b>${esc(label)}</b><p>${esc(trunc(self[k], 100)) || '—'}</p></div>`).join('');
  return card(t('Self-story'), `<div class="selfstory">${ss}</div>`, ch(15)) +
    (mo ? card(mo.label, `<p class="viz-note">${esc(mo.desc)}</p><p class="quote small"><b>${esc(t('Twist:'))}</b> ${esc(c.action?.mo?.twist || mo.twist)}</p>`, esc(MO_GROUP_LABELS[mo.group]?.() || mo.group)) : '') +
    card(t('Value change per scene'), scenes.length ? svg(w, scenes.length * rowH + 8, defs + body, 'beats', t('Scene value changes')) + `<div class="legend"><span>${esc(t('− negative'))}</span><span>${esc(t('positive +'))}</span></div>` : empty(t('Add a scene to see its value turn.')));
}

// ── 15 · Performance star ────────────────────────────────────────────────
export function performanceStar(c) {
  const on = new Set(c.performance?.functions || []);
  const cx = 150;
  const cy = 140;
  const n = K.PERFORMANCE_FUNCTIONS.length;
  let body = `<circle cx="${cx}" cy="${cy}" r="102" class="star-rim"/>`;
  const pts = [];
  K.PERFORMANCE_FUNCTIONS.forEach((f, i) => {
    const a = -90 + (360 / n) * i;
    const r = on.has(f.id) ? 100 : 40;
    pts.push(polar(cx, cy, r, a));
    pts.push(polar(cx, cy, 26, a + 180 / n));
    const [lx, ly] = polar(cx, cy, 116, a);
    body += `<text x="${f1(lx)}" y="${f1(ly)}" text-anchor="${Math.abs(lx - cx) < 10 ? 'middle' : lx > cx ? 'start' : 'end'}" dominant-baseline="middle" class="star-lbl ${on.has(f.id) ? 'on' : ''}">${esc(f.short || f.label)}</text>`;
  });
  body += `<polygon points="${pts.map((p) => p.map(f1).join(',')).join(' ')}" class="star-shape"/>`;
  const sc = suspenseScore(c);
  return card(t('Seven functions in performance'), svg(300, 280, body, '', t('Performance functions')), `${on.size}/7 · ${esc(ch(16))}`) +
    card(t('Suspense'), `<div class="hbars">
      <div class="hbar"><span class="hb-l">${esc(t('Curiosity'))}</span><span class="hb-track"><span class="hb-fill" style="width:${num(c.performance?.curiosity) * 10}%"></span></span><span class="hb-v">${num(c.performance?.curiosity, '—')}</span></div>
      <div class="hbar"><span class="hb-l">${esc(t('Concern'))}</span><span class="hb-track"><span class="hb-fill alt" style="width:${num(c.performance?.concern) * 10}%"></span></span><span class="hb-v">${num(c.performance?.concern, '—')}</span></div>
    </div><p class="viz-note">${esc(t('Suspense = curiosity × concern'))}${sc != null ? ` → <b>${sc}/10</b>` : ''}</p>`);
}

// ── 16 · Relationship web ────────────────────────────────────────────────
export function relationshipWeb(c, ctx = {}) {
  const cast = ctx.cast || [];
  const byId = Object.fromEntries(cast.map((m) => [m.id, m]));
  const links = new Map();
  for (const r of c.relationships || []) if (byId[r.targetId]) links.set(r.targetId, { out: r });
  for (const m of cast) for (const r of m.relationships || []) if (r.targetId === c.id) links.set(m.id, { ...(links.get(m.id) || {}), in: r });
  const ids = [...links.keys()];
  const cx = 160;
  const cy = 150;
  let edges = '';
  let nodes = '';
  ids.forEach((id, i) => {
    const m = byId[id];
    const a = (360 / Math.max(ids.length, 1)) * i - 90;
    const [x, y] = polar(cx, cy, 112, a);
    const l = links.get(id);
    const eff = l.out?.effect || l.in?.effect || '';
    edges += `<line x1="${cx}" y1="${cy}" x2="${f1(x)}" y2="${f1(y)}" class="edge eff-${esc(eff)} ${l.out && l.in ? 'both-ways' : ''}"/>`;
    const [mx, my] = polar(cx, cy, 58, a);
    const kind = K.RELATIONSHIP_KINDS.find((k) => k.id === (l.out?.kind || l.in?.kind))?.label || '';
    if (kind) edges += `<text x="${f1(mx)}" y="${f1(my)}" text-anchor="middle" class="edge-lbl">${esc(kind)}</text>`;
    // Name sits outside the node, away from the centre, so edges never cross it.
    const [tx, ty] = polar(cx, cy, 112 + 26, a);
    const anchor = Math.abs(tx - cx) < 12 ? 'middle' : tx > cx ? 'start' : 'end';
    const nx = anchor === 'middle' ? tx : tx + (tx > cx ? -8 : 8);
    nodes += `<g class="node" data-action="open-char" data-id="${esc(id)}" role="button" tabindex="0"><circle cx="${f1(x)}" cy="${f1(y)}" r="17" fill="${esc(m.color)}"/><text x="${f1(x)}" y="${f1(y + 4)}" text-anchor="middle" class="node-ini">${esc(initialsOf(m))}</text><text x="${f1(nx)}" y="${f1(ty + (anchor === 'middle' ? (ty < cy ? -2 : 8) : 4))}" text-anchor="${anchor}" class="node-lbl">${esc(trunc(displayName(m), 18))}</text></g>`;
  });
  nodes += `<circle cx="${cx}" cy="${cy}" r="26" fill="${esc(c.color)}" class="me-node"/><text x="${cx}" y="${cy + 4}" text-anchor="middle" class="node-ini big">${esc(initialsOf(c))}</text>`;
  const dims = c.dimensions || [];
  const act = dims.map((d) => {
    const who = [];
    for (const r of c.relationships || []) if (r.dimensionId === d.id && byId[r.targetId]) who.push(displayName(byId[r.targetId]));
    for (const m of cast) for (const r of m.relationships || []) if (r.targetId === c.id && r.dimensionId === d.id) who.push(displayName(m));
    return `<li class="${who.length ? 'on' : ''}"><b>${esc(d.positive || '?')} / ${esc(d.negative || '?')}</b> ${who.length ? `← ${esc([...new Set(who)].join(', '))}` : `<i>${esc(t('dormant'))}</i>`}</li>`;
  }).join('');
  return card(t('Relationship web'), ids.length ? svg(320, 310, edges + nodes, '', t('Relationship web')) + `<div class="legend"><span><i class="lgd helps"></i>${esc(t('helps'))}</span><span><i class="lgd hinders"></i>${esc(t('hinders'))}</span><span><i class="lgd bothk"></i>${esc(t('both'))}</span></div>` : empty(t('Link her to other cast members.')), ch(17)) +
    (dims.length ? card(t('Who draws out each dimension?'), `<ul class="activation">${act}</ul>`) : '');
}

function initialsOf(m) {
  const parts = displayName(m).split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

// ── Registry & profile helpers ───────────────────────────────────────────
export const VISUALS = {
  sparkSpheres,
  castOrbit,
  traitDensity,
  bigFive,
  settingRings,
  fourSelves,
  motivationLadder,
  choiceDepth: choiceDepthViz,
  dimensionWheel,
  underdogScale,
  arcChart,
  symbolicSpectrum,
  genreCard,
  sceneBeats,
  performanceStar,
  relationshipWeb,
};

export function stationBars(c, story) {
  const p = overallProgress(c, story);
  return `<div class="station-bars">${SECTIONS.map((s) => {
    const b = p.bySection[s.id];
    return `<a class="sbar ${b.expected ? '' : 'opt'} acc-${s.accent}" href="#/char/${esc(c.id)}/${s.id}" title="${esc(s.title)} — ${b.filled}/${b.total}"><span class="sb-num">${s.num}</span><span class="sb-col"><span class="sb-fill" style="height:${Math.round(b.ratio * 100)}%"></span></span></a>`;
  }).join('')}</div>`;
}
