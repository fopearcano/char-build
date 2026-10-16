import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldIndex, validateUpdate, applyUpdates, describeFieldIndex } from '../shared/fields.js';
import { newCharacter } from '../shared/model.js';

test('field index covers every station', () => {
  const idx = fieldIndex();
  for (const p of ['name', 'cast.circle', 'outer.implicit.bigFive.openness', 'inner.motivations.power', 'dimensions', 'arc.turningPoints', 'complexity.antagonism.inner', 'outer.expressed.voice', 'action.mo.theme']) {
    assert.ok(idx[p], `missing ${p}`);
  }
  assert.ok(describeFieldIndex().split('\n').length > 150);
});

test('validateUpdate coerces and rejects', () => {
  assert.deepEqual(validateUpdate({ path: 'outer.implicit.bigFive.openness', value: 140 }).update.value, 100);
  assert.equal(validateUpdate({ path: 'cast.circle', value: 'first' }).ok, true);
  assert.equal(validateUpdate({ path: 'cast.circle', value: 'fifth' }).ok, false);
  assert.equal(validateUpdate({ path: 'concept.inspiration', value: ['reality', 'nope'] }).ok, false);
  assert.equal(validateUpdate({ path: 'no.such.path', value: 1 }).ok, false);
  assert.equal(validateUpdate({ path: '__proto__.x', value: 1 }).ok, false);
  assert.equal(validateUpdate({ path: 'dimensions', op: 'append', value: { positive: 'Kind' } }).ok, false);
  assert.equal(validateUpdate({ path: 'relationships', op: 'append', value: { targetId: 'char_x' } }, { castIds: [] }).ok, false);
  assert.equal(validateUpdate({ path: 'arc.dimensionId', value: 'dim_new' }, { character: newCharacter(), pendingDimensionIds: ['dim_new'] }).ok, true);
});

test('applyUpdates appends list items and keeps a single defining dimension', () => {
  let c = newCharacter({ dimensions: [{ id: 'd1', positive: 'A', negative: 'B', defining: true }] });
  const u = validateUpdate({ path: 'dimensions', op: 'append', value: { id: 'd2', positive: 'C', negative: 'D', defining: true } }).update;
  c = applyUpdates(c, [u, validateUpdate({ path: 'concept.inspiration', op: 'append', value: ['reality'] }).update]);
  assert.equal(c.dimensions.length, 2);
  assert.deepEqual(c.dimensions.map((d) => d.defining), [false, true]);
  assert.deepEqual(c.concept.inspiration, ['reality']);
});
