// JSON-file persistence for stories, characters, settings and chats.
// Writes are serialized and atomic (write temp file, then rename). Imports,
// restores and — while the library changes — a rolling half-hourly snapshot
// leave backups in data/backups/, so any of them can be rolled back.

import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { newCharacter, newStory, normalizeCharacter, normalizeStory, getPath, uid, SCHEMA_VERSION } from '../shared/model.js';
import { validateUpdate, applyUpdates } from '../shared/fields.js';
import { i18nError, tr, DEFAULT_LOCALE } from '../shared/i18n.js';
import { EXPORT_FORMAT, exportKind } from '../shared/transfer.js';

const AUTO_BACKUP_EVERY_MS = 30 * 60 * 1000;
const KEEP_RECENT_BACKUPS = 20;
const KEEP_DAILY_BACKUPS = 14;

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
export const validId = (id) => typeof id === 'string' && ID_RE.test(id);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normalizeLibrary(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not a library object');
  return {
    stories: (raw.stories || []).map(normalizeStory),
    characters: (raw.characters || []).map(normalizeCharacter),
  };
}

// Key-order–independent JSON, to tell an unchanged item from an edited one.
function stableJSON(v) {
  if (Array.isArray(v)) return `[${v.map(stableJSON).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJSON(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

// How an imported item relates to the library's copy.
function compare(item, local) {
  if (!local) return { status: 'new' };
  const strip = ({ updatedAt, ...rest }) => rest; // eslint-disable-line no-unused-vars
  if (stableJSON(strip(item)) === stableJSON(strip(local))) return { status: 'same' };
  const a = Date.parse(item.updatedAt) || 0;
  const b = Date.parse(local.updatedAt) || 0;
  return { status: 'conflict', newer: a > b ? 'file' : a < b ? 'library' : 'equal' };
}

const backupMeta = ({ id, kind, createdAt, stories, characters, note }) => ({ id, kind, createdAt, stories, characters, ...(note ? { note } : {}) });
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    this.settingsFile = path.join(dir, 'settings.json');
    this.chatDir = path.join(dir, 'chats');
    this.backupDir = path.join(dir, 'backups');
    this.data = { stories: [], characters: [] };
    this.settings = {};
    this.queue = Promise.resolve();
    this.lastAutoBackup = 0;
    this.recovered = null; // set when db.json was unreadable at startup
  }

  async init({ seed } = {}) {
    await fs.mkdir(this.chatDir, { recursive: true });
    await fs.mkdir(this.backupDir, { recursive: true });
    this.lastAutoBackup = Date.parse((await this.listBackups())[0]?.createdAt) || 0;
    if (fssync.existsSync(this.file)) {
      try {
        this.data = normalizeLibrary(JSON.parse(await fs.readFile(this.file, 'utf8')));
      } catch (err) {
        await this.recover(err);
      }
    } else if (seed) {
      this.data = seed();
      await this.flush();
    }
    if (fssync.existsSync(this.settingsFile)) {
      try {
        this.settings = JSON.parse(await fs.readFile(this.settingsFile, 'utf8'));
      } catch {
        this.settings = {};
      }
    }
    return this;
  }

  // db.json can't be read: keep it aside and start from the newest backup
  // that loads (or an empty library), instead of refusing to start.
  async recover(err) {
    const aside = `${this.file}.corrupt-${stamp()}`;
    await fs.rename(this.file, aside);
    for (const b of await this.listBackups()) {
      try {
        this.data = normalizeLibrary((await this.readBackup(b.id)).data);
        this.recovered = { backupId: b.id, createdAt: b.createdAt, file: path.basename(aside) };
        break;
      } catch {
        // try the next one
      }
    }
    if (!this.recovered) {
      this.data = { stories: [], characters: [] };
      this.recovered = { backupId: null, createdAt: null, file: path.basename(aside) };
    }
    console.warn(`[store] ${path.basename(this.file)} could not be read (${err.message}). It was moved to ${this.recovered.file}; ${this.recovered.backupId ? `restored the backup from ${this.recovered.createdAt}` : 'starting with an empty library'}.`);
    await this.flush();
  }

  // Write the library. A failed write is reported to the caller (the data
  // stays in memory and goes out with the next successful write).
  flush() {
    const snapshot = structuredClone(this.data);
    const write = this.queue.then(() => writeAtomic(this.file, snapshot));
    this.queue = write.catch(() => {});
    return write.then(() => this.autoBackup(), (err) => {
      console.error('[store] write failed:', err.message);
      throw Object.assign(i18nError(503, 'Could not save to disk ({error}). Your changes are kept and will be saved with the next successful write.', { error: err.code || err.message }), { expose: true });
    });
  }

  // A rolling snapshot at most every half hour while the library changes.
  autoBackup() {
    if (Date.now() - this.lastAutoBackup < AUTO_BACKUP_EVERY_MS) return;
    this.lastAutoBackup = Date.now();
    this.createBackup('auto').catch((err) => console.error('[store] backup failed:', err.message));
  }

  async saveSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    for (const [k, v] of Object.entries(this.settings)) if (v === null || v === '') delete this.settings[k];
    await fs.writeFile(this.settingsFile, JSON.stringify(this.settings, null, 2), { mode: 0o600 });
    return this.settings;
  }

  // Saving an edited copy that is older than the library's (another device
  // or tab saved in between) is refused, so neither edit is lost silently.
  checkFresh(cur, body, kind) {
    if (body?.updatedAt && cur.updatedAt && body.updatedAt !== cur.updatedAt) {
      const err = kind === 'story'
        ? i18nError(409, 'This story was changed somewhere else since you opened it.')
        : i18nError(409, 'This character was changed somewhere else since you opened it.');
      throw Object.assign(err, { payload: { conflict: true, current: cur } });
    }
  }

  // ── Stories ───────────────────────────────────────────────────────────
  listStories() {
    return this.data.stories;
  }

  getStory(id) {
    const s = this.data.stories.find((x) => x.id === id);
    if (!s) throw new HttpError(404, 'Story not found');
    return s;
  }

  async createStory(fields = {}) {
    const s = normalizeStory(newStory(sanitize(fields, ['id', 'createdAt', 'updatedAt'])));
    this.data.stories.push(s);
    await this.flush();
    return s;
  }

  // `checkFresh`: refuse a save based on an outdated copy (see checkFresh).
  async updateStory(id, body, { checkFresh = false } = {}) {
    const cur = this.getStory(id);
    if (checkFresh) this.checkFresh(cur, body, 'story');
    const next = normalizeStory({ ...sanitize(body), id: cur.id, createdAt: cur.createdAt, updatedAt: new Date().toISOString() });
    Object.assign(cur, next);
    await this.flush();
    return cur;
  }

  async deleteStory(id) {
    this.getStory(id);
    this.data.stories = this.data.stories.filter((s) => s.id !== id);
    const removed = new Set(this.data.characters.filter((c) => c.storyId === id).map((c) => c.id));
    this.data.characters = this.data.characters.filter((c) => !removed.has(c.id));
    await this.flush();
    await this.deleteChatsOf(removed);
    return { deleted: id, characters: [...removed] };
  }

  // ── Characters ────────────────────────────────────────────────────────
  listCharacters(storyId) {
    return storyId ? this.data.characters.filter((c) => c.storyId === storyId) : this.data.characters;
  }

  getCharacter(id) {
    const c = this.data.characters.find((x) => x.id === id);
    if (!c) throw new HttpError(404, 'Character not found');
    return c;
  }

  async createCharacter(fields = {}) {
    const clean = sanitize(fields, ['id', 'createdAt', 'updatedAt']);
    if (clean.storyId) this.getStory(clean.storyId);
    const c = normalizeCharacter(newCharacter(clean));
    this.data.characters.push(c);
    await this.flush();
    return c;
  }

  async updateCharacter(id, body, { checkFresh = false } = {}) {
    const cur = this.getCharacter(id);
    if (checkFresh) this.checkFresh(cur, body, 'character');
    const clean = sanitize(body);
    if (clean.storyId && clean.storyId !== cur.storyId) this.getStory(clean.storyId);
    const next = normalizeCharacter({ ...clean, id: cur.id, createdAt: cur.createdAt, updatedAt: new Date().toISOString() });
    for (const k of Object.keys(cur)) delete cur[k];
    Object.assign(cur, next);
    await this.flush();
    return cur;
  }

  // Apply [{path, value, op}] updates — e.g. when the user accepts AI
  // proposals. Every update is validated against the field index.
  async patchCharacter(id, updates) {
    const cur = this.getCharacter(id);
    if (!Array.isArray(updates) || !updates.length) throw new HttpError(400, 'No updates');
    const ctx = updateContext(cur, this.listCharacters(cur.storyId), updates);
    const valid = [];
    for (const u of updates) {
      const r = validateUpdate(u, ctx);
      if (!r.ok) throw new HttpError(400, r.error);
      valid.push(r.update);
    }
    return this.updateCharacter(id, applyUpdates(cur, valid));
  }

  async duplicateCharacter(id, lang = DEFAULT_LOCALE) {
    const src = this.getCharacter(id);
    const copy = structuredClone(src);
    delete copy.id;
    delete copy.updatedAt;
    copy.name = tr(lang, '{name} (copy)', { name: src.name || tr(lang, 'Unnamed character') });
    copy.relationships = [];
    return this.createCharacter(copy);
  }

  async deleteCharacter(id) {
    this.getCharacter(id);
    this.data.characters = this.data.characters.filter((c) => c.id !== id);
    for (const c of this.data.characters) {
      c.relationships = (c.relationships || []).filter((r) => r.targetId !== id);
    }
    await this.flush();
    await this.deleteChatsOf([id]);
    return { deleted: id };
  }

  // ── Export ────────────────────────────────────────────────────────────
  exportAll() {
    return { app: 'char-build', format: EXPORT_FORMAT, schema: SCHEMA_VERSION, kind: 'library', exportedAt: new Date().toISOString(), ...structuredClone(this.data) };
  }

  // Stories come with their whole cast; characters can also be picked one by
  // one. No ids → the whole library. Coach conversations are optional.
  async exportSelection({ storyIds = [], characterIds = [], includeChats = false } = {}) {
    const all = !storyIds.length && !characterIds.length;
    const stories = all ? this.data.stories : this.data.stories.filter((s) => storyIds.includes(s.id));
    const inStory = new Set(stories.map((s) => s.id));
    const characters = all ? this.data.characters : this.data.characters.filter((c) => inStory.has(c.storyId) || characterIds.includes(c.id));
    if (!all && !stories.length && !characters.length) throw i18nError(404, 'Nothing to export: those stories or characters no longer exist.');
    const out = {
      app: 'char-build',
      format: EXPORT_FORMAT,
      schema: SCHEMA_VERSION,
      kind: exportKind({ all, stories, characters }),
      exportedAt: new Date().toISOString(),
      stories: structuredClone(stories),
      characters: structuredClone(characters),
    };
    if (includeChats) {
      const ids = new Set(characters.map((c) => c.id));
      out.chats = [];
      for (const meta of await this.listChats()) {
        if (!ids.has(meta.characterId)) continue;
        const chat = await this.loadChat(meta.id);
        if (chat) out.chats.push(chat);
      }
    }
    return out;
  }

  // ── Import ────────────────────────────────────────────────────────────
  // Read any CharBuild export (library, story, selection, single character —
  // old or new format) into clean, normalized stories, characters and chats.
  planImport(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw i18nError(400, 'Invalid import file');
    if (payload.app && payload.app !== 'char-build') throw i18nError(400, 'This file isn’t a CharBuild export.');
    const list = (many, one) => [...(Array.isArray(many) ? many : []), ...(one && typeof one === 'object' ? [one] : [])];
    const byId = (items) => [...new Map(items.map((x) => [x.id, x])).values()];
    const stories = byId(list(payload.stories, payload.story).filter((x) => validId(x?.id)).map((x) => normalizeStory(sanitize(x))));
    const characters = byId(list(payload.characters, payload.character).filter((x) => validId(x?.id)).map((x) => normalizeCharacter(sanitize(x))));
    const chats = byId(list(payload.chats)
      .filter((ch) => validId(ch?.id) && validId(ch?.characterId) && Array.isArray(ch.messages) && Array.isArray(ch.display))
      .map((ch) => sanitize(ch)));
    if (!stories.length && !characters.length) throw i18nError(400, 'The file has no stories or characters.');
    const schemas = [payload.schema, ...stories.map((x) => x.schema), ...characters.map((x) => x.schema)].filter(Number.isFinite);
    return {
      stories,
      characters,
      chats,
      kind: typeof payload.kind === 'string' ? payload.kind : null,
      exportedAt: typeof payload.exportedAt === 'string' ? payload.exportedAt : null,
      newerSchema: schemas.some((v) => v > SCHEMA_VERSION),
    };
  }

  // What importing the file would do, item by item, without changing anything.
  previewImport(payload) {
    const plan = this.planImport(payload);
    const fileStories = new Set(plan.stories.map((s) => s.id));
    const localStory = (id) => this.data.stories.find((s) => s.id === id);
    return {
      kind: plan.kind,
      exportedAt: plan.exportedAt,
      newerSchema: plan.newerSchema,
      chats: plan.chats.length,
      stories: plan.stories.map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        characters: plan.characters.filter((c) => c.storyId === s.id).length,
        ...compare(s, localStory(s.id)),
      })),
      characters: plan.characters.map((c) => {
        const home = fileStories.has(c.storyId) ? null : localStory(c.storyId);
        return {
          id: c.id,
          name: c.name,
          color: c.color,
          circle: c.cast?.circle || '',
          storyId: c.storyId,
          inFileStory: fileStories.has(c.storyId),
          libraryStory: home ? { id: home.id, title: home.title } : null,
          updatedAt: c.updatedAt,
          chats: plan.chats.filter((ch) => ch.characterId === c.id).length,
          ...compare(c, this.data.characters.find((x) => x.id === c.id)),
        };
      }),
    };
  }

  // Import a file. For items already in the library, `conflict` decides:
  //   update — the file's version replaces the library's
  //   copy   — keep both: the file's version comes in under new ids
  //   skip   — keep the library's version
  // `select` limits the import to some story/character ids; `target` places
  // characters whose story isn't imported: 'keep' (their story, if it is in
  // the library), 'none', or a story id. `replace` swaps the whole library.
  // A backup is taken first; restoring it undoes the import.
  async applyImport(payload, { conflict = 'update', select = null, target = 'keep', includeChats = true, replace = false, lang = DEFAULT_LOCALE } = {}) {
    const plan = this.planImport(payload);
    if (!['update', 'copy', 'skip'].includes(conflict)) throw i18nError(400, 'Unknown choice for items already in the library.');
    const chosen = (items, ids) => (Array.isArray(ids) ? items.filter((x) => ids.includes(x.id)) : items);
    const stories = chosen(plan.stories, select?.stories);
    const characters = chosen(plan.characters, select?.characters);
    if (!stories.length && !characters.length) throw i18nError(400, 'Nothing selected to import.');
    const libStories = replace ? [] : this.data.stories;
    const libChars = replace ? [] : this.data.characters;
    if (target && !['keep', 'none'].includes(target) && !libStories.some((s) => s.id === target)) {
      throw i18nError(404, 'Story not found');
    }

    // Stories: decide an action and the id each one ends up with.
    const storyIds = new Map();
    const storyOps = stories.map((s) => {
      const cmp = compare(s, libStories.find((x) => x.id === s.id));
      const action = cmp.status === 'new' ? 'add' : cmp.status === 'same' ? 'same' : conflict === 'update' ? 'update' : conflict;
      const id = action === 'copy' ? uid('story') : s.id;
      storyIds.set(s.id, id);
      return { action, item: action === 'copy' ? { ...s, id, title: tr(lang, '{title} (copy)', { title: s.title }) } : s };
    });

    const hasStory = (id) => libStories.some((s) => s.id === id) || storyOps.some((op) => op.item.id === id && op.action !== 'skip');
    const placeOf = (c) => {
      if (storyIds.has(c.storyId)) return storyIds.get(c.storyId);
      if (target === 'none') return null;
      if (target && target !== 'keep') return target;
      return hasStory(c.storyId) ? c.storyId : null;
    };

    // Characters: a character whose story is imported as a copy goes with it.
    const charIds = new Map();
    const charOps = characters.map((c) => {
      const cmp = compare(c, libChars.find((x) => x.id === c.id));
      const storyCopied = storyIds.has(c.storyId) && storyIds.get(c.storyId) !== c.storyId;
      let action;
      if (cmp.status === 'new') action = 'add';
      else if (storyCopied) action = 'copy';
      else if (cmp.status === 'same' && placeOf(c) === c.storyId) action = 'same';
      else action = conflict; // differs, or the same character going to another story
      const id = action === 'copy' ? uid('char') : c.id;
      charIds.set(c.id, id);
      const name = action === 'copy' && !storyCopied ? tr(lang, '{name} (copy)', { name: c.name || tr(lang, 'Unnamed character') }) : c.name;
      return { action, src: c, item: { ...c, id, name, storyId: placeOf(c) } };
    });
    for (const op of charOps) {
      op.item.relationships = (op.item.relationships || []).map((r) => ({ ...r, targetId: charIds.get(r.targetId) || r.targetId }));
    }

    // Chats follow their character (and get a new id when it was copied).
    const chatOps = [];
    if (includeChats) {
      for (const ch of plan.chats) {
        const op = charOps.find((o) => o.src.id === ch.characterId);
        if (!op || op.action === 'skip') continue;
        const local = replace ? null : await this.loadChat(ch.id);
        let action = 'add';
        if (local) {
          if (op.action === 'copy' || conflict === 'copy') action = 'copy';
          else if (stableJSON(local) === stableJSON(ch)) action = 'same';
          else action = conflict === 'skip' ? 'skip' : 'update';
        }
        chatOps.push({ action, item: { ...ch, id: action === 'copy' ? uid('chat') : ch.id, characterId: op.item.id, storyId: op.item.storyId } });
      }
    }

    // Back up everything the import may change, then apply it.
    const writes = (ops) => ops.filter((op) => ['add', 'copy', 'update'].includes(op.action));
    const chatBackup = {};
    for (const op of writes(chatOps)) chatBackup[op.item.id] = op.action === 'update' ? await this.loadChat(op.item.id) : null;
    const backup = await this.createBackup(replace ? 'replace' : 'import', { chats: chatBackup });

    if (replace) this.data = { stories: [], characters: [] };
    const upsert = (list, item) => {
      const i = list.findIndex((x) => x.id === item.id);
      if (i >= 0) list[i] = item;
      else list.push(item);
    };
    for (const op of writes(storyOps)) upsert(this.data.stories, op.item);
    for (const op of writes(charOps)) upsert(this.data.characters, op.item);
    this.tidyRelationships();
    for (const op of writes(chatOps)) await writeAtomic(this.chatPath(op.item.id), op.item);
    await this.flush();

    const tally = (action) => ({
      stories: storyOps.filter((op) => op.action === action).length,
      characters: charOps.filter((op) => op.action === action).length,
      chats: chatOps.filter((op) => op.action === action).length,
    });
    const added = tally('add');
    const updated = tally('update');
    const copied = tally('copy');
    return {
      stories: added.stories + updated.stories + copied.stories,
      characters: added.characters + updated.characters + copied.characters,
      added,
      updated,
      copied,
      unchanged: tally('same'),
      skipped: tally('skip'),
      replaced: replace,
      backup,
    };
  }

  // The previous API: merge (update existing) or replace everything.
  importData(payload, mode = 'merge', lang = DEFAULT_LOCALE) {
    return this.applyImport(payload, { conflict: 'update', replace: mode === 'replace', lang });
  }

  // Relationships point at castmates: drop links to characters that are gone
  // or now live in another story.
  tidyRelationships() {
    const byId = new Map(this.data.characters.map((c) => [c.id, c]));
    const storyIds = new Set(this.data.stories.map((s) => s.id));
    for (const c of this.data.characters) {
      if (c.storyId && !storyIds.has(c.storyId)) c.storyId = null;
    }
    for (const c of this.data.characters) {
      c.relationships = (c.relationships || []).filter((r) => {
        const other = byId.get(r.targetId);
        return other && other.id !== c.id && (other.storyId || null) === (c.storyId || null);
      });
    }
  }

  // ── Backups ───────────────────────────────────────────────────────────
  backupPath(id) {
    if (!validId(id)) throw new HttpError(400, 'Invalid id');
    return path.join(this.backupDir, `${id}.json`);
  }

  // kind: auto | manual | import | replace | restore. `chats` maps chat ids
  // an import or restore touches to their previous content (null = new).
  async createBackup(kind, { chats = null, note = null } = {}) {
    const createdAt = new Date().toISOString();
    const id = `bk_${createdAt.replace(/\D/g, '').slice(0, 17)}_${Math.random().toString(36).slice(2, 7)}`;
    const body = {
      id,
      kind,
      createdAt,
      stories: this.data.stories.length,
      characters: this.data.characters.length,
      ...(note ? { note } : {}),
      data: structuredClone(this.data),
      ...(chats && Object.keys(chats).length ? { chats } : {}),
    };
    await writeAtomic(this.backupPath(id), body);
    await this.pruneBackups();
    return backupMeta(body);
  }

  async listBackups() {
    let files = [];
    try {
      files = (await fs.readdir(this.backupDir)).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const out = [];
    for (const f of files) {
      try {
        const b = JSON.parse(await fs.readFile(path.join(this.backupDir, f), 'utf8'));
        if (validId(b.id) && b.data && typeof b.createdAt === 'string') out.push(backupMeta(b));
      } catch {
        // ignore unreadable backups
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // Keep the 20 newest backups, plus the newest of each of the last 14 days.
  async pruneBackups() {
    const list = await this.listBackups();
    const keep = new Set(list.slice(0, KEEP_RECENT_BACKUPS).map((b) => b.id));
    const days = new Set();
    for (const b of list) {
      const day = b.createdAt.slice(0, 10);
      if (days.has(day) || days.size >= KEEP_DAILY_BACKUPS) continue;
      days.add(day);
      keep.add(b.id);
    }
    for (const b of list) if (!keep.has(b.id)) await fs.rm(this.backupPath(b.id), { force: true });
  }

  async readBackup(id) {
    try {
      return JSON.parse(await fs.readFile(this.backupPath(id), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') throw i18nError(404, 'Backup not found');
      throw err;
    }
  }

  // Put the library (and any chats the backup recorded) back as they were.
  // The current state is backed up first, so a restore can be undone too.
  async restoreBackup(id) {
    const b = await this.readBackup(id);
    const data = normalizeLibrary(b.data);
    const chats = b.chats || {};
    const current = {};
    for (const chatId of Object.keys(chats)) if (validId(chatId)) current[chatId] = await this.loadChat(chatId);
    const undo = await this.createBackup('restore', { chats: current, note: b.createdAt });
    this.data = data;
    for (const [chatId, content] of Object.entries(chats)) {
      if (!validId(chatId)) continue;
      if (content) await writeAtomic(this.chatPath(chatId), content);
      else await fs.rm(this.chatPath(chatId), { force: true });
    }
    await this.flush();
    return { restored: backupMeta(b), backup: undo };
  }

  // ── Chats ─────────────────────────────────────────────────────────────
  chatPath(id) {
    if (!validId(id)) throw new HttpError(400, 'Invalid conversation id');
    return path.join(this.chatDir, `${id}.json`);
  }

  async loadChat(id) {
    try {
      return JSON.parse(await fs.readFile(this.chatPath(id), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async saveChat(chat) {
    await writeAtomic(this.chatPath(chat.id), chat);
  }

  async listChats(filter = {}) {
    const files = (await fs.readdir(this.chatDir)).filter((f) => f.endsWith('.json'));
    const out = [];
    for (const f of files) {
      try {
        const chat = JSON.parse(await fs.readFile(path.join(this.chatDir, f), 'utf8'));
        if (filter.characterId && chat.characterId !== filter.characterId) continue;
        if (filter.mode && chat.mode !== filter.mode) continue;
        out.push({ id: chat.id, mode: chat.mode, provider: chat.provider || 'anthropic', model: chat.model || null, characterId: chat.characterId, title: chat.title, updatedAt: chat.updatedAt, turns: chat.display?.length || 0 });
      } catch {
        // ignore unreadable chat files
      }
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async deleteChat(id) {
    await fs.rm(this.chatPath(id), { force: true });
    return { deleted: id };
  }

  async deleteChatsOf(characterIds) {
    const ids = new Set(characterIds);
    for (const chat of await this.listChats()) if (ids.has(chat.characterId)) await this.deleteChat(chat.id);
  }
}

// Drop server-owned keys and anything that could pollute prototypes.
function sanitize(obj, drop = []) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const json = JSON.parse(JSON.stringify(obj), (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v));
  for (const k of drop) delete json[k];
  return json;
}

export function updateContext(character, cast, updates = []) {
  return {
    character,
    castIds: cast.map((c) => c.id).filter((x) => x !== character.id),
    pendingDimensionIds: updates
      .filter((u) => u?.path === 'dimensions')
      .flatMap((u) => [].concat(u.value || []).map((v) => v?.id))
      .filter(Boolean),
  };
}

export { getPath };
