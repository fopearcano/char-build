// Markdown "character bible" export, organised by the builder's stations.

import * as K from './catalog.js';
import { SECTIONS } from './sections.js';
import { getPath, isFilled, displayName } from './model.js';
import { overallProgress, traitDensity, antagonismProfile, choiceDepth, characterChecks } from './analysis.js';

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
        if (vals.length) groupLines.push(`- **${f.label || 'Ratings'}** — ${vals.join(' · ')}`);
        continue;
      }
      if (f.type === 'custom' || seen.has(f.path)) continue;
      seen.add(f.path);
      if (f.type === 'slider' ? !Number.isFinite(v) : !isFilled(v)) continue;
      let shown = v;
      if (Array.isArray(v)) shown = v.map((id) => label(f.options, id)).join(', ');
      else if (f.options) shown = label(f.options, v);
      else if (typeof v === 'boolean') shown = v ? 'Yes' : 'No';
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
  out.push('', `*${label(K.CIRCLES, c.cast?.circle) || 'Unplaced'}${c.concept?.roleLabel ? ` · ${c.concept.roleLabel}` : ''}${story ? ` · ${story.title}` : ''} · ${Math.round(p.ratio * 100)}% built*`, '');

  const td = traitDensity(c);
  const ap = antagonismProfile(c);
  const cd = choiceDepth(c);
  out.push('## At a glance', '');
  out.push(`- Dimensions: ${(c.dimensions || []).length}${c.dimensions?.find((d) => d.defining) ? ` (defining: ${c.dimensions.find((d) => d.defining).positive} / ${c.dimensions.find((d) => d.defining).negative})` : ''}`);
  out.push(`- Trait density: ${td.expressed} dramatized of ${td.known} known (McKee’s ideal ≈ 3/10)`);
  if (ap.capacity != null) out.push(`- Underdog balance: antagonism ${ap.power} vs. capacity ${ap.capacity}${ap.underdog ? ' — underdog ✓' : ''}`);
  if (cd != null) out.push(`- Choice depth: ${cd}/10`);
  out.push('');

  for (const s of SECTIONS) {
    const body = fieldLines(c, s);
    const extra = [];
    if (s.id === 'selves' && c.selves?.personae?.length) {
      extra.push('**Personae**', ...c.selves.personae.map((x) => `- with ${x.with} (${x.axis || '—'}): ${x.persona}`), '');
    }
    if (s.id === 'dimensions' && c.dimensions?.length) {
      extra.push(...c.dimensions.map((d) => `- **${d.positive} / ${d.negative}**${d.defining ? ' — *defining*' : ''}${d.type ? ` · ${label(K.DIMENSION_TYPES, d.type)}` : ''}${d.level ? ` · ${label(K.SELF_LEVELS, d.level)}` : ''}${d.positiveExample ? `\n  - (+) ${d.positiveExample}` : ''}${d.negativeExample ? `\n  - (−) ${d.negativeExample}` : ''}`), '');
    }
    if (s.id === 'complexity') {
      const forces = ap.forces.filter((f) => f.value > 0);
      if (forces.length) extra.push('**Forces of antagonism**', ...forces.map((f) => `- ${f.label}: ${f.value}/10${c.complexity?.antagonismNotes?.[f.id] ? ` — ${c.complexity.antagonismNotes[f.id]}` : ''}`), '');
    }
    if (s.id === 'arc' && c.arc?.turningPoints?.length) {
      extra.push('**Turning points**', ...c.arc.turningPoints.map((t, i) => `${i + 1}. ${t.label} (${t.charge > 0 ? '+' : ''}${t.charge})`), '');
    }
    if (s.id === 'action' && c.action?.scenes?.length) {
      extra.push('**Scenes**', ...c.action.scenes.map((sc) => `- **${sc.title || 'Scene'}** — wants ${sc.objective || '?'}; does ${sc.action || '?'}; blocked by ${sc.counteraction || '?'}; ${sc.value || 'value'} ${sc.from ?? '?'} → ${sc.to ?? '?'}`), '');
    }
    if (s.id === 'action' && c.action?.mo?.theme) extra.unshift(`- **MO theme** — ${label(K.MO_THEMES, c.action.mo.theme)}`);
    if (s.id === 'genre' && c.genre?.coreCastRole) extra.unshift(`- **Core-cast position** — ${c.genre.coreCastRole}`);
    if (s.id === 'relationships' && c.relationships?.length) {
      extra.push(...c.relationships.map((r) => {
        const t = cast.find((x) => x.id === r.targetId);
        const dim = c.dimensions?.find((d) => d.id === r.dimensionId);
        return `- ${label(K.RELATIONSHIP_KINDS, r.kind) || 'Link'} → **${t ? displayName(t) : r.targetId}**${r.draws ? `: draws out ${r.draws}` : ''}${dim ? ` (${dim.positive}/${dim.negative})` : ''}`;
      }), '');
    }
    if (!body.length && !extra.length) continue;
    out.push(`## ${s.num} · ${s.title}`, `*${s.subtitle} — McKee, Ch. ${s.chapters.join(', ')}*`, '', ...body, ...extra);
  }

  const checks = characterChecks(c, story, cast).filter((x) => x.level !== 'good');
  if (checks.length) {
    out.push('## Open McKee checks', '', ...checks.map((x) => `- **${x.title}** — ${x.detail} (${x.ref})`), '');
  }
  out.push('---', `*Built with CharBuild · framework after Robert McKee, ${K.BOOK.title} (${K.BOOK.year}).*`);
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}
