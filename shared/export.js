// Markdown "character bible" export, organised by the builder's stations.

import * as K from './catalog.js';
import { SECTIONS } from './sections.js';
import { getPath, isFilled, displayName } from './model.js';
import { overallProgress, traitDensity, antagonismProfile, choiceDepth, characterChecks } from './analysis.js';
import { t } from './i18n.js';

const label = (options, id) => options?.find((o) => o.id === id)?.label || id;

function fieldLines(c, section) {
  const lines = [];
  const seen = new Set();
  for (const g of section.groups) {
    if (g.showIf && !g.showIf(c)) continue;
    const groupLines = [];
    for (const f of g.fields) {
      if (f.showIf && !f.showIf(c)) continue;
      const v = getPath(c, f.path);
      const name = f.label || K.EXPLICIT_TRAITS.find((t) => t.id === f.key)?.label || f.path;
      if (f.type === 'spectra' || f.type === 'sliders') {
        const vals = f.items.filter((it) => Number.isFinite(v?.[it.id])).map((it) => `${it.label}: ${v[it.id]}`);
        if (vals.length) groupLines.push(`- **${f.label || t('Ratings')}** — ${vals.join(' · ')}`);
        continue;
      }
      if (f.type === 'custom' || seen.has(f.path)) continue;
      seen.add(f.path);
      if (f.type === 'slider' ? !Number.isFinite(v) : !isFilled(v)) continue;
      let shown = v;
      if (Array.isArray(v)) shown = v.map((id) => label(f.options, id)).join(', ');
      else if (f.options) shown = label(f.options, v);
      else if (typeof v === 'boolean') shown = v ? t('Yes') : t('No');
      const mark = f.type === 'trait' && c.outer?.expressed?.[f.key] ? ' 👁' : '';
      groupLines.push(`- **${name}**${mark} — ${String(shown).replace(/\n+/g, ' ')}`);
    }
    if (groupLines.length) lines.push(`**${g.title}**`, ...groupLines, '');
  }
  return lines;
}

export function characterMarkdown(c, story, cast = []) {
  const out = [];
  const p = overallProgress(c, story);
  out.push(`# ${displayName(c)}`);
  if (c.concept?.logline) out.push('', `> ${c.concept.logline}`);
  out.push('', `*${label(K.CIRCLES, c.cast?.circle) || t('Unplaced')}${c.concept?.roleLabel ? ` · ${c.concept.roleLabel}` : ''}${story ? ` · ${story.title}` : ''} · ${t('{pct}% built', { pct: Math.round(p.ratio * 100) })}*`, '');

  const td = traitDensity(c);
  const ap = antagonismProfile(c);
  const cd = choiceDepth(c);
  out.push(`## ${t('At a glance')}`, '');
  const def = c.dimensions?.find((d) => d.defining);
  out.push(`- ${t('Dimensions')}: ${(c.dimensions || []).length}${def ? ` (${t('defining: {pos} / {neg}', { pos: def.positive, neg: def.negative })})` : ''}`);
  out.push(`- ${t('Trait density: {shown} dramatized of {known} known (McKee’s ideal ≈ 3/10)', { shown: td.expressed, known: td.known })}`);
  if (ap.capacity != null) out.push(`- ${t('Underdog balance: antagonism {power} vs. capacity {capacity}', { power: ap.power, capacity: ap.capacity })}${ap.underdog ? ` — ${t('underdog ✓')}` : ''}`);
  if (cd != null) out.push(`- ${t('Choice depth: {n}/10', { n: cd })}`);
  out.push('');

  for (const s of SECTIONS) {
    const body = fieldLines(c, s);
    const extra = [];
    if (s.id === 'selves' && c.selves?.personae?.length) {
      extra.push(`**${t('Personae')}**`, ...c.selves.personae.map((x) => `- ${t('with {who}', { who: x.with })} (${x.axis ? (x.axis === 'power' ? t('Power (social)') : t('Intimacy (personal)')) : '—'}): ${x.persona}`), '');
    }
    if (s.id === 'dimensions' && c.dimensions?.length) {
      extra.push(...c.dimensions.map((d) => `- **${d.positive} / ${d.negative}**${d.defining ? ` — *${t('defining')}*` : ''}${d.type ? ` · ${label(K.DIMENSION_TYPES, d.type)}` : ''}${d.level ? ` · ${label(K.SELF_LEVELS, d.level)}` : ''}${d.positiveExample ? `\n  - (+) ${d.positiveExample}` : ''}${d.negativeExample ? `\n  - (−) ${d.negativeExample}` : ''}`), '');
    }
    if (s.id === 'complexity') {
      const forces = ap.forces.filter((f) => f.value > 0);
      if (forces.length) extra.push(`**${t('Forces of antagonism')}**`, ...forces.map((f) => `- ${f.label}: ${f.value}/10${c.complexity?.antagonismNotes?.[f.id] ? ` — ${c.complexity.antagonismNotes[f.id]}` : ''}`), '');
    }
    if (s.id === 'arc' && c.arc?.turningPoints?.length) {
      extra.push(`**${t('Turning points')}**`, ...c.arc.turningPoints.map((t, i) => `${i + 1}. ${t.label} (${t.charge > 0 ? '+' : ''}${t.charge})`), '');
    }
    if (s.id === 'action' && c.action?.scenes?.length) {
      extra.push(`**${t('Scenes')}**`, ...c.action.scenes.map((sc) => `- **${sc.title || t('Scene')}** — ${t('wants {objective}; does {action}; blocked by {counteraction}', { objective: sc.objective || '?', action: sc.action || '?', counteraction: sc.counteraction || '?' })}; ${sc.value || t('value')} ${sc.from ?? '?'} → ${sc.to ?? '?'}`), '');
    }
    if (s.id === 'action' && c.action?.mo?.theme) extra.unshift(`- **${t('MO theme')}** — ${label(K.MO_THEMES, c.action.mo.theme)}`);
    if (s.id === 'genre' && c.genre?.coreCastRole) extra.unshift(`- **${t('Core-cast position')}** — ${t(c.genre.coreCastRole)}`);
    if (s.id === 'relationships' && c.relationships?.length) {
      extra.push(...c.relationships.map((r) => {
        const other = cast.find((x) => x.id === r.targetId);
        const dim = c.dimensions?.find((d) => d.id === r.dimensionId);
        return `- ${label(K.RELATIONSHIP_KINDS, r.kind) || t('Link')} → **${other ? displayName(other) : r.targetId}**${r.draws ? `: ${t('draws out {what}', { what: r.draws })}` : ''}${dim ? ` (${dim.positive}/${dim.negative})` : ''}`;
      }), '');
    }
    if (!body.length && !extra.length) continue;
    out.push(`## ${s.num} · ${s.title}`, `*${s.subtitle} — McKee, ${t('Ch. {n}', { n: s.chapters.join(', ') })}*`, '', ...body, ...extra);
  }

  const checks = characterChecks(c, story, cast).filter((x) => x.level !== 'good');
  if (checks.length) {
    out.push(`## ${t('Open McKee checks')}`, '', ...checks.map((x) => `- **${x.title}** — ${x.detail} (${x.ref})`), '');
  }
  out.push('---', `*${t('Built with CharBuild · framework after Robert McKee, {title} ({year}).', { title: K.BOOK.title, year: K.BOOK.year })}*`);
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}
