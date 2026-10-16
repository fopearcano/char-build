import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleData } from '../server/sample.js';
import { newCharacter } from '../shared/model.js';
import { overallProgress, characterChecks, castChecks, traitDensity, antagonismProfile, choiceDepth, similarity, sectionProgress, characterDigest } from '../shared/analysis.js';
import { characterMarkdown } from '../shared/export.js';
import { SECTIONS } from '../shared/sections.js';

const { stories, characters } = sampleData();
const story = stories[0];
const mara = characters.find((c) => c.id === 'char_mara');

test('sample protagonist is well built and passes the key McKee checks', () => {
  const p = overallProgress(mara, story);
  assert.ok(p.ratio > 0.85, `progress ${p.ratio}`);
  const checks = characterChecks(mara, story, characters);
  assert.equal(checks.filter((c) => c.level === 'warn').length, 0, JSON.stringify(checks.filter((c) => c.level === 'warn')));
  assert.ok(checks.some((c) => c.title === 'Underdog confirmed'));
  assert.ok(checks.some((c) => c.title === 'Defining dimension set'));
});

test('an empty protagonist gets the core warnings', () => {
  const c = newCharacter({ cast: { circle: 'protagonist' } });
  const titles = characterChecks(c, null, [c]).map((x) => x.title);
  for (const t of ['Name your character', 'Locate the Center of Good', 'No true dilemma yet', 'Protagonist needs dimensions', 'Name her need']) {
    assert.ok(titles.includes(t), `missing check "${t}"`);
  }
});

test('trait density follows the 3/10 rule', () => {
  const td = traitDensity(mara);
  assert.equal(td.total, 18);
  assert.equal(td.known, 17);
  assert.equal(td.expressed, 5);
  const c = newCharacter({ outer: { explicit: { age: '30', voice: 'x', face: 'y', home: 'z', profession: 'w' }, expressed: { age: true, voice: true, face: true, home: true } } });
  assert.ok(characterChecks(c, null, [c]).some((x) => x.title === 'Leave seven-tenths unknown'));
});

test('underdog scale compounds forces of antagonism', () => {
  const ap = antagonismProfile(mara);
  assert.equal(ap.power, 10);
  assert.equal(ap.capacity, 6);
  assert.equal(ap.underdog, true);
  assert.equal(ap.levelsEngaged, 4);
  const weak = newCharacter({ cast: { circle: 'protagonist' }, complexity: { antagonism: { social: 3 }, capacity: 8 } });
  assert.equal(antagonismProfile(weak).underdog, false);
  assert.ok(characterChecks(weak, null, [weak]).some((x) => x.title === 'Not an underdog'));
});

test('choice depth rewards risk and freedom', () => {
  assert.equal(choiceDepth(mara), 7.8);
  assert.equal(choiceDepth(newCharacter()), null);
  assert.equal(choiceDepth(newCharacter({ inner: { pressure: { risk: 10, freedom: 10 } } })), 10);
});

test('desires that agree are flagged', () => {
  const c = newCharacter({ inner: { objectOfDesire: 'To win back her husband' }, complexity: { subconsciousDesire: 'To win back her husband, secretly' } });
  assert.ok(similarity(c.inner.objectOfDesire, c.complexity.subconsciousDesire) > 0.5);
  assert.ok(characterChecks(c, null, [c]).some((x) => x.title === 'Desires don’t contradict'));
});

test('flat turning points trigger the repetition warning', () => {
  const c = newCharacter({ arc: { turningPoints: [{ label: 'a', charge: 2 }, { label: 'b', charge: 3 }, { label: 'c', charge: 4 }] } });
  assert.ok(characterChecks(c, null, [c]).some((x) => x.title === 'Repetition is the mortal enemy'));
  const z = newCharacter({ arc: { turningPoints: [{ label: 'a', charge: 0 }, { label: 'b', charge: 3 }, { label: 'c', charge: 0 }] } });
  assert.ok(!characterChecks(z, null, [z]).some((x) => x.title === 'Repetition is the mortal enemy'));
});

test('cast checks find an out-dimensioned protagonist', () => {
  const prot = newCharacter({ name: 'P', cast: { circle: 'protagonist' }, dimensions: [{ id: 'd1', positive: 'a', negative: 'b' }] });
  const rival = newCharacter({ name: 'R', cast: { circle: 'first' }, dimensions: [{ id: 'd2', positive: 'a', negative: 'b' }, { id: 'd3', positive: 'c', negative: 'd' }] });
  assert.ok(castChecks(null, [prot, rival]).some((x) => x.title === 'Protagonist out-dimensioned'));
  assert.equal(castChecks(story, characters).filter((x) => x.level === 'warn').length, 0);
});

test('every section reports progress', () => {
  for (const s of SECTIONS) {
    const p = sectionProgress(mara, s.id, story);
    assert.ok(p.total > 0, s.id);
    assert.ok(p.filled <= p.total, s.id);
  }
});

test('digest and markdown include the essentials', () => {
  const digest = characterDigest(mara, story, characters);
  assert.match(digest, /Truthful \/ Self-deceived \[DEFINING\]/);
  assert.match(digest, /complexity\.antagonism\.inner: 9/);
  const md = characterMarkdown(mara, story, characters);
  assert.match(md, /^# Mara Voss/);
  assert.match(md, /## 09 · Dimensions/);
  assert.match(md, /Underdog balance: antagonism 10 vs\. capacity 6/);
});
