// Analysis engine: completeness, derived scores for the infographics, and
// "McKee checks" — rule-of-thumb diagnostics drawn from the book's
// principles. Pure functions; used by the browser and by the AI tools.

import * as K from './catalog.js';
import { SECTIONS, sectionFields } from './sections.js';
import { getPath, isFilled, isPlainObject, displayName } from './model.js';

const EXPLICIT_KEYS = K.EXPLICIT_TRAITS.map((t) => t.id);
const MAJOR = new Set(['protagonist', 'first']);

// Which stations a role is expected to complete. McKee: second-circle roles
// carry a dimension or a single trait; third-circle roles stay nearly
// dimensionless — no need to build their arcs. (Ch. 6, 17)
const EXPECTED_BY_CIRCLE = {
  protagonist: SECTIONS.map((s) => s.id),
  first: SECTIONS.map((s) => s.id).filter((id) => id !== 'performance'),
  second: ['spark', 'role', 'explicit', 'implicit', 'desire', 'relationships'],
  third: ['spark', 'role', 'explicit'],
};

export function expectedSections(c) {
  return EXPECTED_BY_CIRCLE[c?.cast?.circle] || EXPECTED_BY_CIRCLE.protagonist;
}

function fieldVisible(field, c, story) {
  if (field.group?.showIf && !field.group.showIf(c, story)) return false;
  if (field.showIf && !field.showIf(c, story)) return false;
  return true;
}

function fieldFilled(field, c) {
  const v = getPath(c, field.path);
  switch (field.type) {
    case 'spectra':
    case 'sliders':
      return isPlainObject(v) && field.items.some((it) => Number.isFinite(v[it.id]));
    case 'toggle':
      return v === true;
    case 'custom':
      switch (field.component) {
        case 'turningPoints': return Array.isArray(v) && v.length >= 2;
        case 'antagonism': return isPlainObject(v) && Object.values(v).some((x) => Number.isFinite(x));
        case 'genreInfo': return null; // informational, not scored
        case 'coreCastPicker': return isFilled(c.genre?.coreCastRole);
        default: return isFilled(v);
      }
    default:
      return isFilled(v);
  }
}

export function sectionProgress(c, sectionId, story) {
  const section = SECTIONS.find((s) => s.id === sectionId);
  if (!section) return { filled: 0, total: 0, ratio: 0 };
  const seen = new Set();
  let filled = 0;
  let total = 0;
  for (const f of sectionFields(section)) {
    if (!fieldVisible(f, c, story)) continue;
    const key = f.type === 'spectra' || f.type === 'sliders' ? `${f.path}:${f.items.map((i) => i.id).join(',')}` : f.path;
    if (seen.has(key)) continue;
    seen.add(key);
    const res = fieldFilled(f, c);
    if (res === null) continue;
    total += 1;
    if (res) filled += 1;
  }
  return { filled, total, ratio: total ? filled / total : 0 };
}

export function overallProgress(c, story) {
  const expected = expectedSections(c);
  let filled = 0;
  let total = 0;
  const bySection = {};
  for (const s of SECTIONS) {
    const p = sectionProgress(c, s.id, story);
    bySection[s.id] = { ...p, expected: expected.includes(s.id) };
    if (expected.includes(s.id)) {
      filled += p.filled;
      total += p.total;
    }
  }
  return { filled, total, ratio: total ? filled / total : 0, bySection };
}

// ── Derived scores ──────────────────────────────────────────────────────

export function traitDensity(c) {
  const ex = c.outer?.explicit || {};
  const known = EXPLICIT_KEYS.filter((k) => isFilled(ex[k]));
  const expressed = known.filter((k) => c.outer?.expressed?.[k]);
  return {
    total: EXPLICIT_KEYS.length,
    known: known.length,
    expressed: expressed.length,
    // share of what the author knows that is put on the page; McKee's ideal ≈ 0.3
    expressedRatio: known.length ? expressed.length / known.length : 0,
    knownKeys: known,
    expressedKeys: expressed,
  };
}

export function antagonismProfile(c) {
  const a = c.complexity?.antagonism || {};
  const forces = K.ANTAGONISM_FORCES.map((f) => ({ ...f, value: Number.isFinite(a[f.id]) ? a[f.id] : 0 }));
  const sumSq = forces.reduce((s, f) => s + f.value * f.value, 0);
  // Forces compound: several medium forces can overwhelm like one huge one.
  const power = Math.min(10, Math.sqrt(sumSq));
  const capacity = Number.isFinite(c.complexity?.capacity) ? c.complexity.capacity : null;
  const levels = new Set(forces.filter((f) => f.value > 0).map((f) => f.level));
  return {
    forces,
    power: Math.round(power * 10) / 10,
    capacity,
    levelsEngaged: levels.size,
    underdog: capacity == null ? null : power > capacity,
    margin: capacity == null ? null : Math.round((power - capacity) * 10) / 10,
  };
}

export function choiceDepth(c) {
  const risk = c.inner?.pressure?.risk;
  const freedom = c.inner?.pressure?.freedom;
  if (!Number.isFinite(risk) || !Number.isFinite(freedom)) return null;
  // Principle 2: greater risk → deeper choice. Principle 3: freer → deeper still.
  return Math.round(((risk * (freedom + 5)) / 15) * 10) / 10;
}

export function definingDimension(c) {
  return (c.dimensions || []).find((d) => d.defining) || null;
}

export function suspenseScore(c) {
  const cu = c.performance?.curiosity;
  const co = c.performance?.concern;
  if (!Number.isFinite(cu) || !Number.isFinite(co)) return null;
  return Math.round(Math.sqrt(cu * co) * 10) / 10; // both are required
}

function tokens(s) {
  return new Set(String(s || '').toLowerCase().match(/[a-zÀ-ɏ]{3,}/g) || []);
}

export function similarity(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

// ── McKee checks ────────────────────────────────────────────────────────

const check = (level, section, title, detail, ref) => ({ level, section, title, detail, ref, id: `${section}:${title}` });

export function characterChecks(c, story, cast = []) {
  const out = [];
  const circle = c.cast?.circle;
  const major = MAJOR.has(circle) || !circle;
  const isProt = circle === 'protagonist';
  const dims = c.dimensions || [];

  if (!isFilled(c.name)) out.push(check('tip', 'spark', 'Name your character', 'Names carry more meaning in fiction than in life — even plainness is a choice.', 'Ch. 7'));
  if (!circle) out.push(check('tip', 'role', 'Place her in the cast', 'Choose an orbit: protagonist, first, second or third circle. Expectations for depth follow from it.', 'Ch. 6'));
  if (isFilled(c.concept?.inspiration) && !isFilled(c.concept?.tellingDetail)) {
    out.push(check('tip', 'spark', 'Find the telling detail', 'One unique facet that implies an entire humanity is what turns an inspiration into belief.', 'Ch. 4'));
  }

  if (isProt) {
    if (!isFilled(c.cast?.centerOfGood)) out.push(check('warn', 'role', 'Locate the Center of Good', 'The audience searches the story for a positive charge to attach its empathy to — usually in the protagonist.', 'Ch. 6'));
    const ess = (c.cast?.essentials || []).length;
    if (ess >= 7) out.push(check('good', 'role', 'Protagonist essentials covered', `${ess} of 8 essentials checked.`, 'Ch. 6'));
    else if (ess < 5) out.push(check('tip', 'role', 'Protagonist essentials', `${ess}/8 checked. Willpower, capability, underdog status, empathy, intrigue, depth, capacity for change and insight make a lead worth the audience’s time.`, 'Ch. 6'));
  }

  // Explicit traits & the 3/10 rule
  const td = traitDensity(c);
  if (major && td.known < 4) out.push(check('tip', 'explicit', 'Thin characterization', `Only ${td.known} explicit traits known. Credibility begins with characterization — follow her around 24/7.`, 'Ch. 7'));
  if (td.known >= 5 && td.expressedRatio > 0.6) {
    out.push(check('tip', 'explicit', 'Leave seven-tenths unknown', `You plan to dramatize ${Math.round(td.expressedRatio * 100)}% of what you know. McKee suggests expressing about three-tenths and letting the audience fill in the rest.`, 'Ch. 7'));
  }
  if (isProt && td.expressed === 1) out.push(check('warn', 'explicit', 'One lone trait', 'A single expressed trait (a foreign accent, say) shrinks a character to a bit part.', 'Ch. 7'));
  if (td.known >= 5 && td.expressedRatio >= 0.2 && td.expressedRatio <= 0.45) {
    out.push(check('good', 'explicit', 'Trait density near 3/10', `${td.expressed} of ${td.known} known traits dramatized.`, 'Ch. 7'));
  }

  // Four selves
  if (major) {
    const filledSelves = K.SELF_LEVELS.filter((s) => isFilled(c.selves?.[s.id])).length;
    if (filledSelves > 0 && filledSelves < 4) out.push(check('tip', 'selves', 'Complete the four selves', `${filledSelves}/4 levels defined. Major characters should be known socially, personally, privately and in the hidden self.`, 'Ch. 5'));
    if (filledSelves === 4) out.push(check('good', 'selves', 'Known at all four levels', 'Social, personal, core and hidden selves are defined.', 'Ch. 5'));
  }

  // Motivation → desire chain
  const mot = c.inner?.motivations || {};
  const rated = K.MOTIVATIONS.filter((m) => Number(mot[m.id]) > 0);
  if (major && rated.length === 0) out.push(check('tip', 'desire', 'What pushes her?', 'Rate the inner motivations — unsated appetites that push from the past.', 'Ch. 8'));
  if (rated.filter((m) => Number(mot[m.id]) >= 8).length > 6) out.push(check('tip', 'desire', 'Everything at full volume', 'More than six drives at 8+ blurs her. Which hungers dominate?', 'Ch. 8'));
  if (isFilled(c.inner?.incitingIncident) && !isFilled(c.inner?.objectOfDesire)) {
    out.push(check('warn', 'desire', 'Inciting incident without a desire', 'Once life is thrown out of balance she must conceive an object of desire that would restore it.', 'Ch. 8'));
  }
  if (isProt && isFilled(c.inner?.objectOfDesire) && !isFilled(c.inner?.incitingIncident)) {
    out.push(check('tip', 'desire', 'What sets the desire in motion?', 'A motivation is a latency until an inciting incident focuses it on a desire.', 'Ch. 8'));
  }

  // Dilemma & pressure
  const dl = c.inner?.dilemma || {};
  if (isProt && !(isFilled(dl.optionA) && isFilled(dl.optionB))) {
    out.push(check('warn', 'choice', 'No true dilemma yet', 'Clear choices between positive and negative are trivial. Only a choice between near-equal goods or evils reveals true character.', 'Ch. 8'));
  }
  if (isFilled(dl.optionA) && isFilled(dl.optionB) && similarity(dl.optionA, dl.optionB) > 0.7) {
    out.push(check('tip', 'choice', 'Options look alike', 'The two horns of the dilemma read almost the same. Sharpen what each costs.', 'Ch. 8'));
  }
  const depth = choiceDepth(c);
  if (isProt && depth != null && depth < 5) out.push(check('tip', 'choice', 'Raise the stakes of the crisis', `Choice depth ${depth}/10. The greater the risk — and the freer the choice — the deeper and truer it is.`, 'Ch. 8'));

  // Dimensions
  if (isProt && dims.length < 3) out.push(check('warn', 'dimensions', 'Protagonist needs dimensions', `${dims.length} dimension(s). The protagonist should carry the majority of the cast’s contradictions — often more than three.`, 'Ch. 9, 17'));
  if (circle === 'first' && dims.length === 0) out.push(check('tip', 'dimensions', 'Give her a dimension', 'First-circle roles generally feature one or two dimensions.', 'Ch. 9'));
  if (['second', 'third'].includes(circle) && dims.length > 1) out.push(check('tip', 'dimensions', 'Too dimensional for the orbit', 'Dimensions consume storytelling time. Limit second-circle roles to their distinctive traits, or promote her.', 'Ch. 6, 17'));
  const definers = dims.filter((d) => d.defining);
  if (dims.length >= 2 && definers.length === 0) out.push(check('warn', 'dimensions', 'Choose a defining dimension', 'One contradiction should stand forward — the one without which she would vanish.', 'Ch. 9'));
  if (definers.length > 1) out.push(check('warn', 'dimensions', 'More than one defining dimension', 'Only one dimension defines her essential spirit; the others complete the portrait.', 'Ch. 9'));
  if (definers.length === 1 && dims.length >= 3) out.push(check('good', 'dimensions', 'Defining dimension set', `${definers[0].positive || '?'} / ${definers[0].negative || '?'} anchors ${dims.length} dimensions.`, 'Ch. 9'));
  for (const d of dims) {
    if (!isFilled(d.positive) || !isFilled(d.negative)) {
      out.push(check('warn', 'dimensions', 'Half a dimension', 'A dimension needs both poles of the contradiction.', 'Ch. 9'));
      break;
    }
  }
  if (dims.some((d) => isFilled(d.positive) && isFilled(d.negative) && !(isFilled(d.positiveExample) && isFilled(d.negativeExample)))) {
    out.push(check('tip', 'dimensions', 'Show both sides in action', 'A dimension must be consistent (a pattern, not a one-off kindness or a snit) and variable. Note a behaviour for each pole.', 'Ch. 9'));
  }

  // Antagonism
  const ap = antagonismProfile(c);
  if (isProt && ap.underdog === false) {
    out.push(check('warn', 'complexity', 'Not an underdog', `Capacity ${ap.capacity} vs. antagonism ${ap.power}. The forces of antagonism should virtually overwhelm her — she should have only a chance.`, 'Ch. 6'));
  }
  if (isProt && ap.underdog === true) out.push(check('good', 'complexity', 'Underdog confirmed', `Antagonism ${ap.power} outweighs capacity ${ap.capacity}.`, 'Ch. 6'));
  if (major && ap.power > 0 && ap.levelsEngaged < 2) {
    out.push(check('tip', 'complexity', 'Conflict on one level only', 'The more various the antagonisms, the more diverse her choices — and the more complex her nature.', 'Ch. 10'));
  }
  const conscious = c.inner?.objectOfDesire;
  const sub = c.complexity?.subconsciousDesire;
  if (isProt && isFilled(conscious) && !isFilled(sub)) out.push(check('tip', 'complexity', 'Any counterdesire?', 'A complex protagonist’s subconscious often pursues an object that contradicts the conscious one.', 'Ch. 10'));
  if (isFilled(conscious) && isFilled(sub) && similarity(conscious, sub) > 0.5) {
    out.push(check('warn', 'complexity', 'Desires don’t contradict', 'If the subconscious wants what the conscious mind wants, who would notice? Make them collide.', 'Ch. 10'));
  }
  const dt = (c.complexity?.depthTraits || []).length;
  if (dt >= 6) out.push(check('good', 'complexity', 'Depth of character', `${dt}/10 depth traits — antihero territory.`, 'Ch. 10'));

  // Arc
  const arc = c.arc || {};
  if (isProt && !isFilled(arc.need)) out.push(check('warn', 'arc', 'Name her need', 'At the inciting incident major characters are incomplete. What void in her humanity will the story fill (or fail to)?', 'Ch. 11'));
  if (['positive', 'negative', 'double'].includes(arc.type)) {
    if (!arc.dimensionId) out.push(check('warn', 'arc', 'Arc without a dimension', 'Change, when it occurs, arcs along the character’s defining dimension.', 'Ch. 11'));
    else {
      const d = dims.find((x) => x.id === arc.dimensionId);
      if (d && !d.defining) out.push(check('tip', 'arc', 'Arc on a secondary dimension', 'McKee places change on the defining dimension. Is this the one that defines her?', 'Ch. 11'));
    }
  }
  const tps = arc.turningPoints || [];
  const charged = tps.filter((t) => Number(t.charge));
  if (charged.length >= 3) {
    const signs = new Set(charged.map((t) => Math.sign(Number(t.charge))));
    if (signs.size === 1) out.push(check('warn', 'arc', 'Repetition is the mortal enemy', 'Every turning point has the same charge. Arcs move in dynamic zigzags of positive and negative.', 'Ch. 11'));
    const last = Number(tps[tps.length - 1].charge) || 0;
    if (arc.type === 'positive' && last < 0) out.push(check('tip', 'arc', 'Positive arc ends negative', 'A positive arc ends on a positive charge.', 'Ch. 11'));
    if (arc.type === 'negative' && last > 0) out.push(check('tip', 'arc', 'Negative arc ends positive', 'A negative arc deepens toward tragedy.', 'Ch. 11'));
  }
  const storyGenres = (story?.genre?.primary || []).map((id) => K.PRIMARY_GENRES.find((g) => g.id === id)).filter(Boolean);
  const characterPlot = storyGenres.find((g) => g.family === 'character');
  if (isProt && characterPlot && arc.type === 'revealed') {
    out.push(check('tip', 'arc', 'Genre expects change', `${characterPlot.label} arcs the protagonist’s ${characterPlot.quality?.toLowerCase()}. A revealed-only arc fights the genre.`, 'Ch. 14'));
  }
  if (isProt && characterPlot?.arc && ['positive', 'negative'].includes(arc.type) && characterPlot.arc !== arc.type) {
    out.push(check('tip', 'arc', 'Arc direction vs. genre', `${characterPlot.label} implies a ${characterPlot.arc} arc.`, 'Ch. 14'));
  }

  // Symbolic
  const sym = c.symbolic || {};
  if ((sym.level === 'archetype' || (sym.archetypes || []).length) && !isFilled(sym.veil)) {
    out.push(check('warn', 'symbolic', 'Veil the archetype', 'If the audience thinks “she’s a symbol for…”, the role flattens. Invent a never-seen-before characterization.', 'Ch. 12'));
  }
  if (['type', 'stock'].includes(sym.level) && !sym.stereotypeChecked) {
    out.push(check('tip', 'symbolic', 'Stereotype check', 'Types and stocks risk cliché; stereotypes are worse — they distort the truth. Test against “All Xs are Y.”', 'Ch. 12'));
  }
  if (sym.mode === 'radicalism') out.push(check('tip', 'symbolic', 'Radical territory', 'Most readers and audiences want Realism or Nonrealism — rarely Radicalism. Choose it knowingly.', 'Ch. 13'));

  // Genre
  if (storyGenres.length && !isFilled(c.genre?.coreCastRole) && major) {
    out.push(check('tip', 'genre', 'Core-cast position', `The story is ${storyGenres.map((g) => g.label).join(' + ')}. Which core-cast role does she play?`, 'Ch. 14'));
  }

  // Action
  const scenes = c.action?.scenes || [];
  if (scenes.some((s) => Number.isFinite(s.from) && Number.isFinite(s.to) && s.from === s.to)) {
    out.push(check('warn', 'action', 'A scene doesn’t turn', 'If the value at stake ends where it began, nothing changed: activity, not action.', 'Ch. 15'));
  }
  if (scenes.some((s) => isFilled(s.action) && !isFilled(s.counteraction))) {
    out.push(check('tip', 'action', 'Missing counteraction', 'Her expectation should collide with a surprising counteraction from the world.', 'Ch. 15'));
  }
  if (isProt && !isFilled(c.action?.selfStory?.future)) out.push(check('tip', 'action', 'Her future self-story', 'The story she tells about her future governs her MO — and your plot.', 'Ch. 15'));

  // Performance
  const cu = c.performance?.curiosity;
  const co = c.performance?.concern;
  if (Number.isFinite(cu) && Number.isFinite(co) && Math.min(cu, co) <= 3 && Math.max(cu, co) >= 6) {
    out.push(check('tip', 'performance', 'Suspense is lopsided', cu < co ? 'Concern without curiosity becomes mindless longing.' : 'Curiosity without concern turns her into a case study.', 'Ch. 16'));
  }

  // Relationships
  const rels = c.relationships || [];
  if (major && cast.length > 1 && rels.length === 0) out.push(check('tip', 'relationships', 'Link her to the cast', 'Every cast member draws traits and truths out of every other.', 'Ch. 17'));
  if (isProt && dims.length && cast.length > 1) {
    const activated = new Set();
    for (const other of cast) {
      for (const r of other.relationships || []) if (r.targetId === c.id && r.dimensionId) activated.add(r.dimensionId);
    }
    for (const r of rels) if (r.dimensionId) activated.add(r.dimensionId);
    const dormant = dims.filter((d) => !activated.has(d.id));
    if (dormant.length) {
      out.push(check('tip', 'relationships', 'Dormant dimensions', `${dormant.length} dimension(s) aren’t drawn out by any relationship — e.g. ${dormant[0].positive || '?'}/${dormant[0].negative || '?'}. Map a cast member to each, as Austen does with the Bennet sisters.`, 'Ch. 17'));
    }
  }
  return out;
}

export function castChecks(story, cast) {
  const out = [];
  if (!cast.length) return out;
  const prots = cast.filter((c) => c.cast?.circle === 'protagonist');
  if (!prots.length) out.push(check('warn', 'cast', 'No protagonist', 'Design the cast from the star role outward.', 'Ch. 6'));
  const maxDims = Math.max(0, ...cast.map((c) => (c.dimensions || []).length));
  for (const p of prots) {
    const pd = (p.dimensions || []).length;
    if (pd < maxDims) {
      const rival = cast.find((c) => (c.dimensions || []).length === maxDims);
      out.push(check('warn', 'cast', 'Protagonist out-dimensioned', `${displayName(rival)} has more dimensions (${maxDims}) than ${displayName(p)} (${pd}). Overly interesting supporting roles may mutiny and take over the telling.`, 'Ch. 6, 17'));
    }
  }
  if (!cast.some((c) => c.cast?.circle === 'first')) out.push(check('tip', 'cast', 'Empty first circle', 'Major supporting and servicing players orbit closest to the protagonist.', 'Ch. 6, 17'));
  if (prots.length && !cast.some((c) => (c.cast?.specialRoles || []).includes('foil'))) {
    out.push(check('tip', 'cast', 'Consider a foil', 'A foil’s contrasting qualities illuminate — and ground — the protagonist.', 'Ch. 6'));
  }
  const seen = new Map();
  for (const c of cast) {
    const key = `${c.cast?.circle}|${(c.concept?.roleLabel || '').trim().toLowerCase()}`;
    if (!c.concept?.roleLabel) continue;
    if (seen.has(key)) out.push(check('tip', 'cast', 'Two roles in one position', `${displayName(seen.get(key))} and ${displayName(c)} share role and orbit. No two should take the same position nor perform the same tasks the same way.`, 'Ch. 6'));
    else seen.set(key, c);
  }
  if (story && !(story.genre?.primary || []).length) out.push(check('tip', 'cast', 'Choose the story’s genre', 'Genre conventions shape the core cast and what the audience expects.', 'Ch. 14'));
  return out;
}

// ── Text summaries (for exports and the AI coach) ───────────────────────

function labelFor(options, id) {
  const o = options?.find((x) => x.id === id);
  return o ? o.label : id;
}

// Flatten all filled fields to "path: value" lines, translating option ids.
export function flattenFilled(c) {
  const lines = [];
  const seen = new Set();
  const push = (path, value) => {
    if (seen.has(path)) return;
    seen.add(path);
    lines.push([path, value]);
  };
  for (const section of SECTIONS) {
    for (const f of sectionFields(section)) {
      const v = getPath(c, f.path);
      if (f.type === 'custom') continue;
      if (!isFilled(v) && !(f.type === 'slider' && Number.isFinite(v))) continue;
      if (f.type === 'spectra' || f.type === 'sliders') {
        for (const it of f.items) if (Number.isFinite(v?.[it.id])) push(`${f.path}.${it.id}`, v[it.id]);
      } else if (Array.isArray(v)) {
        push(f.path, v.map((id) => labelFor(f.options, id)).join(', '));
      } else if (f.options) {
        push(f.path, labelFor(f.options, v));
      } else {
        push(f.path, v);
      }
    }
  }
  if (Object.keys(c.outer?.expressed || {}).length) {
    push('outer.expressed', Object.keys(c.outer.expressed).filter((k) => c.outer.expressed[k]).join(', '));
  }
  (c.dimensions || []).forEach((d, i) => {
    push(`dimensions.${i}`, `${d.positive || '?'} / ${d.negative || '?'}${d.defining ? ' [DEFINING]' : ''} (id ${d.id}; type ${d.type || '?'}; level ${d.level || '?'})${d.positiveExample ? ` + ${d.positiveExample}` : ''}${d.negativeExample ? ` − ${d.negativeExample}` : ''}`);
  });
  (c.selves?.personae || []).forEach((p, i) => push(`selves.personae.${i}`, `${p.with}: ${p.persona} (${p.axis || ''})`));
  for (const f of K.ANTAGONISM_FORCES) {
    const v = c.complexity?.antagonism?.[f.id];
    if (Number.isFinite(v)) push(`complexity.antagonism.${f.id}`, v);
  }
  if (Number.isFinite(c.complexity?.capacity)) push('complexity.capacity', c.complexity.capacity);
  (c.arc?.turningPoints || []).forEach((t, i) => push(`arc.turningPoints.${i}`, `${t.label} (${t.charge > 0 ? '+' : ''}${t.charge})`));
  if (c.arc?.dimensionId) push('arc.dimensionId', c.arc.dimensionId);
  if (c.genre?.coreCastRole) push('genre.coreCastRole', c.genre.coreCastRole);
  if (c.action?.mo?.theme) push('action.mo.theme', labelFor(K.MO_THEMES, c.action.mo.theme));
  (c.action?.scenes || []).forEach((s, i) => push(`action.scenes.${i}`, `${s.title || 'Scene'} — wants: ${s.objective || '?'}; does: ${s.action || '?'}; blocked by: ${s.counteraction || '?'}; ${s.value || 'value'} ${s.from ?? '?'}→${s.to ?? '?'}`));
  (c.relationships || []).forEach((r, i) => push(`relationships.${i}`, `${r.kind || 'link'} → ${r.targetName || r.targetId} (draws out: ${r.draws || '?'})`));
  return lines;
}

export function characterDigest(c, story, cast = []) {
  const lines = flattenFilled(c).map(([p, v]) => `${p}: ${typeof v === 'string' ? v.replace(/\s+/g, ' ').slice(0, 600) : v}`);
  const header = [`Character "${displayName(c)}" (id ${c.id})`];
  if (story) {
    const g = (story.genre?.primary || []).map((id) => K.PRIMARY_GENRES.find((x) => x.id === id)?.label).filter(Boolean);
    header.push(`Story: "${story.title}"${story.logline ? ` — ${story.logline}` : ''}${g.length ? ` | genres: ${g.join(', ')}` : ''}${story.theme ? ` | theme: ${story.theme}` : ''}`);
  }
  const others = cast.filter((x) => x.id !== c.id);
  if (others.length) header.push(`Other cast: ${others.map((x) => `${displayName(x)} (${x.cast?.circle || 'unplaced'}${x.concept?.roleLabel ? `, ${x.concept.roleLabel}` : ''})`).join('; ')}`);
  return `${header.join('\n')}\n${lines.length ? lines.join('\n') : '(no fields filled yet)'}`;
}
