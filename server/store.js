// JSON-file persistence for stories, characters, settings and chats.
// Writes are serialized and atomic (write temp file, then rename).

import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { newCharacter, newStory, normalizeCharacter, normalizeStory, getPath } from '../shared/model.js';
import { validateUpdate, applyUpdates } from '../shared/fields.js';

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

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    this.settingsFile = path.join(dir, 'settings.json');
    this.chatDir = path.join(dir, 'chats');
    this.data = { stories: [], characters: [] };
    this.settings = {};
    this.queue = Promise.resolve();
  }

  async init({ seed } = {}) {
    await fs.mkdir(this.chatDir, { recursive: true });
    if (fssync.existsSync(this.file)) {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.data = {
        stories: (raw.stories || []).map(normalizeStory),
        characters: (raw.characters || []).map(normalizeCharacter),
      };
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

  flush() {
    const snapshot = structuredClone(this.data);
    this.queue = this.queue.then(() => writeAtomic(this.file, snapshot)).catch((err) => {
      console.error('[store] write failed:', err.message);
    });
    return this.queue;
  }

  async saveSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    for (const [k, v] of Object.entries(this.settings)) if (v === null || v === '') delete this.settings[k];
    await fs.writeFile(this.settingsFile, JSON.stringify(this.settings, null, 2), { mode: 0o600 });
    return this.settings;
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

  async updateStory(id, body) {
    const cur = this.getStory(id);
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

  async updateCharacter(id, body) {
    const cur = this.getCharacter(id);
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

  async duplicateCharacter(id) {
    const src = this.getCharacter(id);
    const copy = structuredClone(src);
    delete copy.id;
    copy.name = `${src.name || 'Unnamed'} (copy)`;
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
    return { deleted: id };
  }

  // ── Import / export ───────────────────────────────────────────────────
  exportAll() {
    return { app: 'char-build', exportedAt: new Date().toISOString(), ...structuredClone(this.data) };
  }

  async importData(payload, mode = 'merge') {
    if (!payload || typeof payload !== 'object') throw new HttpError(400, 'Invalid import file');
    const stories = (payload.stories || []).filter((s) => validId(s?.id)).map(normalizeStory);
    const characters = (payload.characters || []).filter((c) => validId(c?.id)).map(normalizeCharacter);
    if (payload.character && validId(payload.character.id)) characters.push(normalizeCharacter(payload.character));
    if (mode === 'replace') {
      this.data = { stories, characters };
    } else {
      const upsert = (list, items) => {
        for (const item of items) {
          const i = list.findIndex((x) => x.id === item.id);
          if (i >= 0) list[i] = item;
          else list.push(item);
        }
      };
      upsert(this.data.stories, stories);
      upsert(this.data.characters, characters);
    }
    const storyIds = new Set(this.data.stories.map((s) => s.id));
    for (const c of this.data.characters) if (c.storyId && !storyIds.has(c.storyId)) c.storyId = null;
    await this.flush();
    return { stories: stories.length, characters: characters.length };
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
        out.push({ id: chat.id, mode: chat.mode, characterId: chat.characterId, title: chat.title, updatedAt: chat.updatedAt, turns: chat.display?.length || 0 });
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
