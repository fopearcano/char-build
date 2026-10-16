// Field renderers for the builder. Every input is bound declaratively:
//   data-path="outer.explicit.age"             → value at that path
//   data-list="dimensions" data-index data-field → a field of a list item
// app.js handles the events and persistence.

import * as K from '/shared/catalog.js';
import { getPath, displayName } from '/shared/model.js';
import { esc, attr, icon } from './ui.js';
import { t } from '/shared/i18n.js';

const LEVEL_HEADS = { physical: () => t('Physical conflict'), social: () => t('Social conflict'), personal: () => t('Personal conflict'), inner: () => t('Inner conflict') };
const MO_GROUP_TITLES = { Hollywood: () => t('Hollywood themes'), Political: () => t('Political themes'), Object: () => t('Object themes') };

const fid = (path) => `f-${String(path).replace(/[^\w]+/g, '-')}`;

export function renderFields(fields, c, ctx) {
  return fields
    .filter((f) => !f.showIf || f.showIf(c, ctx.story))
    .map((f) => renderField(f, c, ctx))
    .join('');
}

function help(f) {
  return f.help ? `<p class="help">${esc(f.help)}</p>` : '';
}

export function renderField(f, c, ctx) {
  const v = getPath(c, f.path);
  const id = fid(f.path + (f.items ? f.items.map((i) => i.id).join('') : ''));
  switch (f.type) {
    case 'text':
      return `<label class="field" for="${id}"><span class="lbl">${esc(f.label)}</span>
        <input class="inp" id="${id}" type="text" data-path="${attr(f.path)}" value="${attr(v ?? '')}" placeholder="${attr(f.placeholder || '')}">${help(f)}</label>`;
    case 'textarea':
      return `<label class="field" for="${id}"><span class="lbl">${esc(f.label)}</span>
        <textarea class="inp" id="${id}" rows="${f.rows || 3}" data-path="${attr(f.path)}" placeholder="${attr(f.placeholder || '')}">${esc(v ?? '')}</textarea>${help(f)}</label>`;
    case 'trait':
      return traitField(f, c, id);
    case 'select':
      return `<label class="field" for="${id}"><span class="lbl">${esc(f.label)}</span>
        <select class="inp" id="${id}" data-path="${attr(f.path)}"><option value="">—</option>${f.options.map((o) => `<option value="${attr(o.id)}" ${o.id === v ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>${help(f)}</label>`;
    case 'radio':
      return radioField(f, v);
    case 'chips':
      return `<div class="field"><span class="lbl">${esc(f.label || '')}</span><div class="chips">${f.options.map((o) => {
        const on = Array.isArray(v) && v.includes(o.id);
        return `<button type="button" class="chip ${on ? 'on' : ''}" aria-pressed="${on}" data-path="${attr(f.path)}" data-toggle="${attr(o.id)}" title="${attr(o.desc || '')}">${on ? icon('check') : ''}${esc(o.label)}</button>`;
      }).join('')}</div>${help(f)}</div>`;
    case 'checklist':
      return `<div class="field">${f.label ? `<span class="lbl">${esc(f.label)}</span>` : ''}<div class="checklist ${f.columns === 2 ? 'cols2' : ''}">${f.options.map((o) => {
        const on = Array.isArray(v) && v.includes(o.id);
        return `<label class="check ${on ? 'on' : ''}"><input type="checkbox" data-path="${attr(f.path)}" data-toggle="${attr(o.id)}" ${on ? 'checked' : ''}><span class="box">${icon('check')}</span><span><b>${esc(o.label)}</b>${o.desc ? `<small>${esc(o.desc)}</small>` : ''}</span></label>`;
      }).join('')}</div>${help(f)}</div>`;
    case 'slider':
      return sliderRow({ path: f.path, label: f.label, min: f.min, max: f.max, step: f.step || 1, left: f.left, right: f.right, value: v, help: f.help });
    case 'spectra':
      return `<div class="field">${f.label ? `<span class="lbl">${esc(f.label)}</span>` : ''}<div class="spectra">${f.items.map((it) => sliderRow({
        path: `${f.path}.${it.id}`, label: f.showDesc ? it.label : '', min: f.min, max: f.max, step: f.max > 20 ? 5 : 1, left: it.left, right: it.right, value: v?.[it.id], desc: f.showDesc ? it.desc : '', diverging: true,
      })).join('')}</div></div>`;
    case 'sliders':
      return `<div class="field">${f.label ? `<span class="lbl">${esc(f.label)}</span>` : ''}<div class="sliders">${f.items.map((it) => sliderRow({
        path: `${f.path}.${it.id}`, label: it.label, min: f.min, max: f.max, step: 1, value: v?.[it.id], desc: f.showDesc ? it.desc : '', inline: true,
      })).join('')}</div></div>`;
    case 'toggle':
      return `<label class="toggle"><input type="checkbox" data-path="${attr(f.path)}" data-bool ${v ? 'checked' : ''}><span class="sw"></span><span>${esc(f.label)}</span></label>`;
    case 'custom':
      return (CUSTOM[f.component] || (() => `<p class="help">${esc(t('Unknown component {name}', { name: f.component }))}</p>`))(f, c, ctx);
    default:
      return '';
  }
}

function traitField(f, c, id) {
  const trait = K.EXPLICIT_TRAITS.find((x) => x.id === f.key);
  const shown = !!c.outer?.expressed?.[f.key];
  const v = getPath(c, f.path);
  return `<div class="field trait ${shown ? 'shown' : ''}">
    <div class="trait-head"><label class="lbl" for="${id}">${esc(trait.label)}</label>
      <button type="button" class="eye ${shown ? 'on' : ''}" data-action="toggle-expressed" data-key="${attr(f.key)}" aria-pressed="${shown}" title="${attr(shown ? t('Dramatized on the page') : t('Known only to the author — click to dramatize'))}">${icon(shown ? 'eye' : 'eyeOff')}<span>${esc(shown ? t('on page') : t('author only'))}</span></button></div>
    ${(f.rows || 2) === 1
    ? `<input class="inp" id="${id}" data-path="${attr(f.path)}" value="${attr(v ?? '')}" placeholder="${attr(trait.desc || '')}">`
    : `<textarea class="inp" id="${id}" rows="${f.rows || 2}" data-path="${attr(f.path)}" placeholder="${attr(trait.desc || '')}">${esc(v ?? '')}</textarea>`}
  </div>`;
}

function radioField(f, v) {
  if (f.compact) {
    return `<div class="field"><span class="lbl">${esc(f.label)}</span><div class="seg" role="radiogroup">${f.options.map((o) => `<button type="button" role="radio" class="seg-btn ${o.id === v ? 'on' : ''}" aria-checked="${o.id === v}" data-path="${attr(f.path)}" data-value="${attr(o.id)}" title="${attr(o.desc || '')}">${esc(o.label)}</button>`).join('')}</div>${help(f)}</div>`;
  }
  return `<div class="field"><span class="lbl">${esc(f.label || '')}</span><div class="opt-cards" role="radiogroup">${f.options.map((o) => `<button type="button" role="radio" class="opt-card ${o.id === v ? 'on' : ''}" aria-checked="${o.id === v}" data-path="${attr(f.path)}" data-value="${attr(o.id)}"><b>${esc(o.label)}</b>${o.desc ? `<span>${esc(o.desc)}</span>` : ''}</button>`).join('')}</div>${help(f)}</div>`;
}

export function sliderRow({ path, label, min, max, step = 1, left, right, value, desc, help: h, diverging, inline, list }) {
  const set = Number.isFinite(value);
  const mid = diverging ? (min + max) / 2 : min;
  const val = set ? value : mid;
  const bind = list ? `data-list="${attr(list.path)}" data-index="${list.index}" data-field="${attr(list.field)}"` : `data-path="${attr(path)}"`;
  const pct = ((val - min) / (max - min)) * 100;
  return `<div class="slider ${set ? '' : 'unset'} ${diverging ? 'div' : ''} ${inline ? 'inline' : ''}">
    ${label ? `<div class="sl-head"><span class="sl-lbl">${esc(label)}</span>${desc ? `<span class="sl-desc">${esc(desc)}</span>` : ''}</div>` : ''}
    <div class="sl-row">
      ${left ? `<span class="pole l">${esc(left)}</span>` : ''}
      <input type="range" min="${min}" max="${max}" step="${step}" value="${val}" ${bind} data-num style="--p:${pct}%" aria-label="${attr(label || t('{left} to {right}', { left: left || '', right: right || '' }))}">
      ${right ? `<span class="pole r">${esc(right)}</span>` : ''}
      <output class="sl-val">${set ? value : '—'}</output>
      ${set && !list ? `<button type="button" class="clear" data-action="clear" data-path="${attr(path)}" title="${attr(t('Clear'))}">${icon('x')}</button>` : ''}
    </div>
    ${h ? `<p class="help">${esc(h)}</p>` : ''}
  </div>`;
}

// ── Custom components ────────────────────────────────────────────────────

const listInput = (path, i, field, value, placeholder = '', tag = 'input', rows = 2) => (tag === 'textarea'
  ? `<textarea class="inp" rows="${rows}" data-list="${attr(path)}" data-index="${i}" data-field="${field}" placeholder="${attr(placeholder)}">${esc(value ?? '')}</textarea>`
  : `<input class="inp" data-list="${attr(path)}" data-index="${i}" data-field="${field}" value="${attr(value ?? '')}" placeholder="${attr(placeholder)}">`);

const listSelect = (path, i, field, value, options, empty = '—') => `<select class="inp" data-list="${attr(path)}" data-index="${i}" data-field="${field}"><option value="">${esc(empty)}</option>${options.map((o) => `<option value="${attr(o.id)}" ${o.id === value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;

const itemTools = (path, i, n) => `<div class="item-tools">
  <button type="button" class="icon-btn sm" data-action="move-item" data-list="${attr(path)}" data-index="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="${attr(t('Move up'))}">${icon('up')}</button>
  <button type="button" class="icon-btn sm" data-action="move-item" data-list="${attr(path)}" data-index="${i}" data-dir="1" ${i === n - 1 ? 'disabled' : ''} aria-label="${attr(t('Move down'))}">${icon('down')}</button>
  <button type="button" class="icon-btn sm danger" data-action="remove-item" data-list="${attr(path)}" data-index="${i}" aria-label="${attr(t('Remove'))}">${icon('trash')}</button></div>`;

const CUSTOM = {
  personae(f, c) {
    const list = c.selves?.personae || [];
    return `<div class="list">${list.map((p, i) => `<div class="list-item persona">
        <div class="row2">${listInput('selves.personae', i, 'with', p.with, t('With whom? (boss, mother, ex…)'))}
        ${listSelect('selves.personae', i, 'axis', p.axis, [{ id: 'power', label: t('Power (social)') }, { id: 'intimacy', label: t('Intimacy (personal)') }], t('Axis…'))}</div>
        ${listInput('selves.personae', i, 'persona', p.persona, t('Voice, eyes, posture, energy — the mask she wears'), 'textarea')}
        ${itemTools('selves.personae', i, list.length)}</div>`).join('')}
      <button type="button" class="btn ghost" data-action="add-item" data-list="selves.personae">${icon('plus')} ${esc(t('Add a persona'))}</button></div>`;
  },

  dimensions(f, c) {
    const list = c.dimensions || [];
    const cards = list.map((d, i) => `<div class="list-item dim ${d.defining ? 'defining' : ''}" id="dim-${attr(d.id)}">
      <div class="dim-poles">
        <span class="pole-tag pos">+</span>${listInput('dimensions', i, 'positive', d.positive, t('Positive pole'))}
        <span class="slash">/</span>
        <span class="pole-tag neg">−</span>${listInput('dimensions', i, 'negative', d.negative, t('Negative pole'))}
        <button type="button" class="star ${d.defining ? 'on' : ''}" data-action="set-defining" data-index="${i}" aria-pressed="${!!d.defining}" title="${attr(t('Defining dimension'))}">${icon('star')}<span>${esc(d.defining ? t('Defining') : t('Make defining'))}</span></button>
      </div>
      <div class="row2">
        ${listSelect('dimensions', i, 'type', d.type, K.DIMENSION_TYPES, t('Kind of contradiction…'))}
        ${listSelect('dimensions', i, 'level', d.level, K.SELF_LEVELS, t('Level of self…'))}
      </div>
      <div class="row2">
        ${listInput('dimensions', i, 'positiveExample', d.positiveExample, t('(+) when does she show this pole?'), 'textarea')}
        ${listInput('dimensions', i, 'negativeExample', d.negativeExample, t('(−) and this one?'), 'textarea')}
      </div>
      <div class="dim-tests">${[['consistent', t('Consistent'), t('A pattern, not a one-off kindness or a snit')], ['variable', t('Variable'), t('Unpredictable, progressing — not the same cat and dog every time')], ['unresolvable', t('Unresolvable'), t('It must seem impossible to settle')]].map(([k, l, tip]) => `<label class="mini-check" title="${attr(tip)}"><input type="checkbox" data-list="dimensions" data-index="${i}" data-field="${k}" data-bool ${d[k] ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div>
      ${itemTools('dimensions', i, list.length)}
    </div>`).join('');
    const sugg = K.DIMENSION_SUGGESTIONS.filter(([p, n]) => !list.some((d) => d.positive === p && d.negative === n)).slice(0, 14);
    return `<div class="list">${cards || `<p class="help">${esc(t('No dimensions yet. A dimension is a living contradiction — wise yet foolish, generous to some, selfish to others.'))}</p>`}
      <div class="add-row"><button type="button" class="btn" data-action="add-item" data-list="dimensions">${icon('plus')} ${esc(t('Add a dimension'))}</button>
      <span class="help">${esc(t('or start from a pair:'))}</span></div>
      <div class="chips small">${sugg.map(([p, n]) => `<button type="button" class="chip" data-action="add-dimension" data-pos="${attr(p)}" data-neg="${attr(n)}">${esc(p)} / ${esc(n)}</button>`).join('')}</div></div>`;
  },

  antagonism(f, c) {
    const a = c.complexity?.antagonism || {};
    const notes = c.complexity?.antagonismNotes || {};
    let lastLevel = '';
    const rows = K.ANTAGONISM_FORCES.map((force) => {
      const head = force.level !== lastLevel ? `<h4 class="lvl-head lvl-${force.level}">${esc(LEVEL_HEADS[force.level]?.() || force.level)}</h4>` : '';
      lastLevel = force.level;
      return `${head}<div class="force">${sliderRow({ path: `complexity.antagonism.${force.id}`, label: force.label, desc: force.desc, min: 0, max: 10, value: a[force.id], inline: true })}
        <input class="inp sm" data-path="complexity.antagonismNotes.${force.id}" value="${attr(notes[force.id] || '')}" placeholder="${attr(t('How does it bear down on her?'))}"></div>`;
    }).join('');
    return `<div class="antagonism">${rows}
      <div class="capacity">${sliderRow({ path: 'complexity.capacity', label: t('Her capacities — mental, emotional, physical'), min: 0, max: 10, value: c.complexity?.capacity, left: t('Feeble'), right: t('Formidable'), help: t('Weigh her in one hand and every negative power in the other. (Ch. 6)') })}</div></div>`;
  },

  dimensionPicker(f, c) {
    const dims = c.dimensions || [];
    return `<label class="field"><span class="lbl">${esc(f.label)}</span><select class="inp" data-path="arc.dimensionId"><option value="">—</option>${dims.map((d) => `<option value="${attr(d.id)}" ${c.arc?.dimensionId === d.id ? 'selected' : ''}>${esc(d.positive || '?')} / ${esc(d.negative || '?')}${d.defining ? ' ★' : ''}</option>`).join('')}</select>
      ${dims.length ? '' : `<p class="help">${esc(t('Add dimensions first (station 09).'))}</p>`}</label>`;
  },

  turningPoints(f, c) {
    const list = c.arc?.turningPoints || [];
    return `<div class="list">${list.map((tp, i) => `<div class="list-item tp-row"><span class="tp-num">${i + 1}</span>
        ${listInput('arc.turningPoints', i, 'label', tp.label, t('What happens?'))}
        <div class="tp-charge">${sliderRow({ min: -5, max: 5, value: Number(tp.charge), left: '−', right: '+', diverging: true, list: { path: 'arc.turningPoints', index: i, field: 'charge' } })}</div>
        ${itemTools('arc.turningPoints', i, list.length)}</div>`).join('')}
      <button type="button" class="btn ghost" data-action="add-item" data-list="arc.turningPoints">${icon('plus')} ${esc(t('Add a turning point'))}</button></div>`;
  },

  scenes(f, c) {
    const list = c.action?.scenes || [];
    const P = 'action.scenes';
    return `<div class="list">${list.map((s, i) => `<details class="list-item scene" ${i === list.length - 1 ? 'open' : ''}>
        <summary><b>${i + 1}. ${esc(s.title || t('Untitled scene'))}</b>${Number.isFinite(s.from) && Number.isFinite(s.to) ? `<span class="charge-pill ${s.to > s.from ? 'pos' : s.to < s.from ? 'neg' : ''}">${esc(s.value || t('value'))} ${s.from > 0 ? '+' : ''}${s.from} → ${s.to > 0 ? '+' : ''}${s.to}</span>` : ''}</summary>
        <div class="scene-grid">
          <label class="field"><span class="lbl">${esc(t('Scene'))}</span>${listInput(P, i, 'title', s.title, t('Where / what'))}</label>
          <label class="field"><span class="lbl">${esc(t('Scene-objective — what she wants now'))}</span>${listInput(P, i, 'objective', s.objective, t('A step toward the super-objective'), 'textarea')}</label>
          <label class="field"><span class="lbl">${esc(t('First action (her MO)'))}</span>${listInput(P, i, 'action', s.action, '', 'textarea')}</label>
          <label class="field"><span class="lbl">${esc(t('Expectation — “if I do X, Y will happen”'))}</span>${listInput(P, i, 'expectation', s.expectation, '', 'textarea')}</label>
          <label class="field"><span class="lbl">${esc(t('Counteraction'))}</span>${listInput(P, i, 'counteraction', s.counteraction, t('What blocks her?'), 'textarea')}</label>
          <label class="field"><span class="lbl">${esc(t('Source of counteraction'))}</span>${listSelect(P, i, 'source', s.source, K.COUNTERACTION_SOURCES)}</label>
          <label class="field"><span class="lbl">${esc(t('Surprise'))}</span>${listInput(P, i, 'surprise', s.surprise, t('What does she suddenly discover?'), 'textarea')}</label>
          <label class="field"><span class="lbl">${esc(t('Value at stake'))}</span>${listInput(P, i, 'value', s.value, t('Truth, Safety, Love…'))}</label>
          <div class="field"><span class="lbl">${esc(t('Charge at opening'))}</span>${sliderRow({ min: -5, max: 5, value: s.from, left: '−', right: '+', diverging: true, list: { path: P, index: i, field: 'from' } })}</div>
          <div class="field"><span class="lbl">${esc(t('Charge at close'))}</span>${sliderRow({ min: -5, max: 5, value: s.to, left: '−', right: '+', diverging: true, list: { path: P, index: i, field: 'to' } })}</div>
          <label class="field"><span class="lbl">${esc(t('Reaction'))}</span>${listInput(P, i, 'reaction', s.reaction, t('Her never-seen-before reaction'), 'textarea')}</label>
          <label class="field"><span class="lbl">${esc(t('What she does next'))}</span>${listInput(P, i, 'next', s.next, '', 'textarea')}</label>
        </div>
        ${itemTools(P, i, list.length)}</details>`).join('')}
      <button type="button" class="btn ghost" data-action="add-item" data-list="${P}">${icon('plus')} ${esc(t('Add a scene'))}</button></div>`;
  },

  relationships(f, c, ctx) {
    const others = (ctx.cast || []).filter((m) => m.id !== c.id);
    const list = c.relationships || [];
    const P = 'relationships';
    if (!others.length) return `<p class="help">${esc(t('This character has no castmates yet. Add characters to the story to link them.'))}</p>`;
    const dims = (c.dimensions || []).map((d) => ({ id: d.id, label: `${d.positive || '?'} / ${d.negative || '?'}` }));
    return `<div class="list">${list.map((r, i) => `<div class="list-item rel">
        <div class="row3">${listSelect(P, i, 'targetId', r.targetId, others.map((m) => ({ id: m.id, label: displayName(m) })), t('Character…'))}
        ${listSelect(P, i, 'kind', r.kind, K.RELATIONSHIP_KINDS, t('Kind…'))}
        ${listSelect(P, i, 'effect', r.effect, K.RELATIONSHIP_EFFECTS, t('Helps/hinders…'))}</div>
        <div class="row2">${listInput(P, i, 'draws', r.draws, t('Which trait or truth does this person draw out of her?'))}
        ${listSelect(P, i, 'dimensionId', r.dimensionId, dims, t('Activates dimension…'))}</div>
        ${listInput(P, i, 'bringsOut', r.bringsOut, t('And what does she bring out in them?'))}
        ${itemTools(P, i, list.length)}</div>`).join('')}
      <button type="button" class="btn ghost" data-action="add-item" data-list="${P}">${icon('plus')} ${esc(t('Link a cast member'))}</button></div>`;
  },

  genreInfo(f, c, ctx) {
    const story = ctx.story;
    if (!story) return `<p class="help">${esc(t('This character isn’t part of a story yet.'))}</p>`;
    const genres = (story.genre?.primary || []).map((id) => K.PRIMARY_GENRES.find((g) => g.id === id)).filter(Boolean);
    return `<div class="genre-strip">${genres.length ? genres.map((g) => `<span class="gchip ${g.family}">${esc(g.label)}</span>`).join('') : `<span class="help">${esc(t('No genre chosen yet.'))}</span>`}
      <a class="btn ghost sm" href="#/story/${attr(story.id)}">${esc(t('Edit story genre'))} ${icon('chevron')}</a></div>`;
  },

  coreCastPicker(f, c, ctx) {
    const genres = (ctx.story?.genre?.primary || []).map((id) => K.PRIMARY_GENRES.find((g) => g.id === id)).filter(Boolean);
    const roles = [...new Set(genres.flatMap((g) => g.coreCast))];
    const v = c.genre?.coreCastRole || '';
    return `<div class="field"><span class="lbl">${esc(f.label)}</span>
      ${roles.length ? `<div class="seg">${roles.map((r) => `<button type="button" class="seg-btn ${r === v ? 'on' : ''}" data-path="genre.coreCastRole" data-value="${attr(r)}">${esc(t(r))}</button>`).join('')}</div>` : ''}
      <input class="inp" data-path="genre.coreCastRole" value="${attr(v)}" placeholder="${attr(t('Or type a position'))}"></div>`;
  },

  moPicker(f, c) {
    const v = c.action?.mo?.theme;
    const groups = [...new Set(K.MO_THEMES.map((m) => m.group))];
    return `<div class="field"><span class="lbl">${esc(f.label)}</span>${groups.map((g) => `<div class="mo-group"><h5>${esc(MO_GROUP_TITLES[g]?.() || g)}</h5><div class="opt-cards three">${K.MO_THEMES.filter((m) => m.group === g).map((m) => `<button type="button" class="opt-card ${m.id === v ? 'on' : ''}" data-path="action.mo.theme" data-value="${attr(m.id)}"><b>${esc(m.label)}</b><span>${esc(m.desc)}</span><em>${esc(t('Twist: {twist}', { twist: m.twist }))}</em></button>`).join('')}</div></div>`).join('')}</div>`;
  },

  genrePicker(f, story) {
    const v = story.genre?.primary || [];
    const fam = (family, title) => `<h5>${title}</h5><div class="genre-grid">${K.PRIMARY_GENRES.filter((g) => g.family === family).map((g) => {
      const on = v.includes(g.id);
      return `<button type="button" class="genre-card ${on ? 'on' : ''} ${family}" data-path="genre.primary" data-toggle="${attr(g.id)}" aria-pressed="${on}">
        <b>${esc(g.label)}</b><span class="gv">${esc(g.coreValue)}</span><small>${esc(g.coreEvent)} · ${esc(g.coreEmotion)}</small><small class="cast">${esc(g.coreCast.map((r) => t(r)).join(' · '))}</small></button>`;
    }).join('')}</div>`;
    return `<div class="field"><span class="lbl">${esc(f.label)}</span>${fam('fortune', esc(t('Ten plots of fortune — outer conditions change')))}${fam('character', esc(t('Six plots of character — morality, mentality, humanity change')))}
      <p class="help">${esc(t('Combine a plot of fortune with a plot of character to merge an outer spine with an inner arc. (Ch. 14)'))}</p></div>`;
  },
};

export function renderStoryFields(fields, story) {
  return fields.map((f) => (f.type === 'custom' && f.component === 'genrePicker' ? CUSTOM.genrePicker(f, story) : renderField(f, story, { story }))).join('');
}

