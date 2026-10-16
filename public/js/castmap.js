// Cast map: McKee's three concentric circles around the protagonist
// (Ch. 6 & 17). Characters can be dragged between orbits; relationship
// lines show who draws what out of whom.

import * as K from '/shared/catalog.js';
import { displayName } from '/shared/model.js';
import { esc, initials } from './ui.js';

const SIZE = 640;
const C = SIZE / 2;
const RINGS = [0, 138, 214, 284]; // centre, 1st, 2nd, 3rd
const BOUNDS = [70, 176, 249]; // drop thresholds between orbits
const CIRCLE_IDS = ['protagonist', 'first', 'second', 'third'];

function positions(cast) {
  const pos = {};
  const byRing = [[], [], [], []];
  const unplaced = [];
  for (const c of cast) {
    const ring = K.CIRCLES.find((x) => x.id === c.cast?.circle)?.ring;
    if (ring == null) unplaced.push(c);
    else byRing[ring].push(c);
  }
  byRing.forEach((members, ring) => {
    if (ring === 0) {
      members.forEach((c, i) => {
        const a = members.length === 1 ? 0 : (2 * Math.PI * i) / members.length;
        const r = members.length === 1 ? 0 : 34;
        pos[c.id] = { x: C + r * Math.cos(a), y: C + r * Math.sin(a), ring };
      });
      return;
    }
    members.forEach((c, i) => {
      const auto = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(members.length, 1) + ring * 0.45;
      const a = Number.isFinite(c.cast?.mapAngle) ? c.cast.mapAngle : auto;
      pos[c.id] = { x: C + RINGS[ring] * Math.cos(a), y: C + RINGS[ring] * Math.sin(a), ring };
    });
  });
  unplaced.forEach((c, i) => {
    pos[c.id] = { x: 34 + i * 46, y: SIZE - 26, ring: null };
  });
  return pos;
}

export function renderCastMap(story, cast) {
  const pos = positions(cast);
  let body = `<defs><radialGradient id="sun-glow"><stop offset="0" stop-color="var(--spark)" stop-opacity=".55"/><stop offset="1" stop-color="var(--spark)" stop-opacity="0"/></radialGradient></defs>`;
  body += `<circle cx="${C}" cy="${C}" r="110" fill="url(#sun-glow)"/>`;
  RINGS.slice(1).forEach((r, i) => {
    body += `<circle cx="${C}" cy="${C}" r="${r}" class="cm-ring r${i + 1}"/>`;
  });
  body += `<circle cx="${C}" cy="${C}" r="${BOUNDS[0]}" class="cm-core"/>`;
  // Ring tags sit on the lower-left diagonal, where auto-placement rarely lands.
  ['1st', '2nd', '3rd'].forEach((t, i) => {
    const a = (3 * Math.PI) / 4;
    const r = RINGS[i + 1];
    body += `<text x="${(C + r * Math.cos(a)).toFixed(1)}" y="${(C + r * Math.sin(a) + 4).toFixed(1)}" text-anchor="middle" class="cm-ring-tag">${t}</text>`;
  });

  // relationship edges
  const ids = new Set(cast.map((c) => c.id));
  const seen = new Set();
  for (const c of cast) {
    for (const r of c.relationships || []) {
      if (!ids.has(r.targetId) || !pos[c.id] || !pos[r.targetId]) continue;
      const key = [c.id, r.targetId].sort().join('|');
      const both = seen.has(key);
      seen.add(key);
      const a = pos[c.id];
      const b = pos[r.targetId];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const bend = both ? -0.18 : 0.18;
      const qx = mx - dy * bend;
      const qy = my + dx * bend;
      const kind = K.RELATIONSHIP_KINDS.find((k) => k.id === r.kind)?.label || 'link';
      body += `<path d="M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${qx.toFixed(1)} ${qy.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}" class="cm-edge eff-${esc(r.effect || '')}" marker-end="url(#cm-arrow)"><title>${esc(displayName(c))} → ${esc(cast.find((x) => x.id === r.targetId) ? displayName(cast.find((x) => x.id === r.targetId)) : '')}: ${esc(kind)}${r.draws ? ` — draws out ${esc(r.draws)}` : ''}</title></path>`;
    }
  }
  body = body.replace('</defs>', '<marker id="cm-arrow" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10z" class="cm-arrow"/></marker></defs>');

  for (const c of cast) {
    const p = pos[c.id];
    const r = p.ring === 0 ? 30 : p.ring === 1 ? 23 : p.ring === 2 ? 18 : 14;
    const dims = (c.dimensions || []).length;
    body += `<g class="cm-node" data-id="${esc(c.id)}" transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})" tabindex="0" role="button" aria-label="${esc(displayName(c))}">
      <circle r="${r + 6}" class="cm-halo"/>
      <circle r="${r}" fill="${esc(c.color)}" class="cm-body"/>
      ${dims ? Array.from({ length: Math.min(dims, 12) }, (_, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / Math.min(dims, 12);
    return `<circle cx="${((r + 4) * Math.cos(a)).toFixed(1)}" cy="${((r + 4) * Math.sin(a)).toFixed(1)}" r="2.2" class="cm-dim"/>`;
  }).join('') : ''}
      <text y="${p.ring === 0 ? 6 : 4}" text-anchor="middle" class="cm-ini" font-size="${Math.max(10, r * 0.62)}">${esc(initials(displayName(c)))}</text>
      <text y="${r + 17}" text-anchor="middle" class="cm-name">${esc(displayName(c))}</text>
      ${c.concept?.roleLabel ? `<text y="${r + 30}" text-anchor="middle" class="cm-role">${esc(c.concept.roleLabel)}</text>` : ''}
    </g>`;
  }
  if (cast.some((c) => pos[c.id].ring == null)) body += `<text x="12" y="${SIZE - 50}" class="cm-ring-lbl" text-anchor="start">Unplaced — drag into an orbit</text>`;
  if (!cast.length) body += `<text x="${C}" y="${C + 4}" text-anchor="middle" class="cm-ring-lbl">Add characters to populate the cast</text>`;
  return `<svg class="castmap" viewBox="0 0 ${SIZE} ${SIZE}" role="img" aria-label="Cast map of ${esc(story.title)}">${body}</svg>
    <p class="cm-legend"><span><b>Centre</b> protagonist</span><span><b>1st</b> major support & service</span><span><b>2nd</b> one dimension or a vivid trait</span><span><b>3rd</b> bit parts & crowds</span></p>
    <p class="cm-legend"><span><i class="lgd helps"></i>helps</span><span><i class="lgd hinders"></i>hinders</span><span><i class="lgd bothk"></i>both</span><span><i class="lgd dimk"></i>dots = dimensions</span></p>`;
}

export function bindCastMap(root, { onMove, onOpen }) {
  const svgEl = root.querySelector('svg.castmap');
  if (!svgEl) return;
  let drag = null;
  const toSvg = (e) => {
    const rect = svgEl.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) / rect.width) * SIZE, y: ((e.clientY - rect.top) / rect.height) * SIZE };
  };
  svgEl.addEventListener('pointerdown', (e) => {
    const node = e.target.closest('.cm-node');
    if (!node) return;
    e.preventDefault();
    node.setPointerCapture(e.pointerId);
    drag = { node, id: node.dataset.id, start: toSvg(e), moved: false };
    node.classList.add('dragging');
  });
  svgEl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = toSvg(e);
    if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 4) drag.moved = true;
    if (!drag.moved) return;
    drag.node.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
    const d = Math.hypot(p.x - C, p.y - C);
    const ring = d < BOUNDS[0] ? 0 : d < BOUNDS[1] ? 1 : d < BOUNDS[2] ? 2 : 3;
    svgEl.querySelectorAll('.cm-ring, .cm-core').forEach((el) => el.classList.remove('target'));
    (ring === 0 ? svgEl.querySelector('.cm-core') : svgEl.querySelector(`.cm-ring.r${ring}`))?.classList.add('target');
    drag.last = { p, ring, d };
  });
  const end = (e) => {
    if (!drag) return;
    const { moved, id, last } = drag;
    drag.node.classList.remove('dragging');
    drag = null;
    if (!moved) return onOpen(id);
    if (!last) return;
    const angle = Math.atan2(last.p.y - C, last.p.x - C);
    onMove(id, CIRCLE_IDS[last.ring], Math.round(angle * 1000) / 1000);
  };
  svgEl.addEventListener('pointerup', end);
  svgEl.addEventListener('pointercancel', () => {
    if (drag) drag.node.classList.remove('dragging');
    drag = null;
  });
  svgEl.addEventListener('keydown', (e) => {
    const node = e.target.closest('.cm-node');
    if (node && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onOpen(node.dataset.id);
    }
  });
}
