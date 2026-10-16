import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBookFile, parseEpub, BookIndex, tokenize } from '../server/book.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('tokenizer stems and splits hyphenated words', () => {
  assert.deepEqual(tokenize('Dimensions of the three-tenths'), ['dimension', 'three-tenth', 'three', 'tenth']);
});

test('parses the epub into chaptered passages', (t) => {
  const file = findBookFile(root);
  if (!file) return t.skip('no epub in docs/');
  const { passages } = parseEpub(file);
  assert.ok(passages.length > 300);
  const chapters = new Set(passages.map((p) => p.chapter));
  for (let n = 1; n <= 17; n += 1) {
    assert.ok([...chapters].some((c) => c.startsWith(`Ch. ${n} — `)), `chapter ${n} missing`);
  }
  assert.ok(chapters.has('Glossary'));
  const idx = new BookIndex(passages, 'x');
  assert.equal(idx.search('subconscious object of desire', 1)[0].section, 'The Subconscious Object Of Desire');
  assert.match(idx.search('foil character', 1)[0].chapter, /Ch\. 6/);
});
