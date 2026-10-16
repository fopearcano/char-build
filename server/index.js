// CharBuild server: REST API + static SPA on port 4133.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { Store, HttpError, validId } from './store.js';
import { sampleData } from './sample.js';
import { createAI, publicChat } from './ai.js';
import { bookStatus, searchBook } from './book.js';
import { characterMarkdown } from '../shared/export.js';
import { displayName } from '../shared/model.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

// Requests from the machine running the server (not from other LAN devices).
export function isLoopback(req) {
  const a = req.socket?.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// IPv4 addresses other devices on the network can use to reach this host.
export function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

export async function createApp({ dataDir = process.env.DATA_DIR || path.join(ROOT, 'data'), seed = true, makeClient, rootDir = ROOT, allowRemoteSettings = process.env.ALLOW_REMOTE_SETTINGS === '1' } = {}) {
  const store = await new Store(dataDir).init({ seed: seed ? sampleData : null });
  const ai = createAI({ store, rootDir, makeClient });
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '5mb' }));

  // Basic hardening: same-origin JSON API, no framing.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const idParam = (req) => {
    if (!validId(req.params.id)) throw new HttpError(400, 'Invalid id');
    return req.params.id;
  };

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  // The app is reachable from the whole LAN, so only the host machine may
  // change the API key / model (unless ALLOW_REMOTE_SETTINGS=1).
  const canEditSettings = (req) => allowRemoteSettings || isLoopback(req);
  const aiStatus = (req) => ({ ...ai.status(), canEditSettings: canEditSettings(req) });

  app.get('/api/bootstrap', (req, res) => {
    res.json({ stories: store.listStories(), characters: store.listCharacters(), ai: aiStatus(req) });
  });

  // Stories
  app.get('/api/stories', (req, res) => res.json(store.listStories()));
  app.post('/api/stories', wrap(async (req, res) => res.status(201).json(await store.createStory(req.body))));
  app.get('/api/stories/:id', (req, res) => res.json(store.getStory(idParam(req))));
  app.put('/api/stories/:id', wrap(async (req, res) => res.json(await store.updateStory(idParam(req), req.body))));
  app.delete('/api/stories/:id', wrap(async (req, res) => res.json(await store.deleteStory(idParam(req)))));

  // Characters
  app.get('/api/characters', (req, res) => res.json(store.listCharacters(req.query.storyId)));
  app.post('/api/characters', wrap(async (req, res) => res.status(201).json(await store.createCharacter(req.body))));
  app.get('/api/characters/:id', (req, res) => res.json(store.getCharacter(idParam(req))));
  app.put('/api/characters/:id', wrap(async (req, res) => res.json(await store.updateCharacter(idParam(req), req.body))));
  app.patch('/api/characters/:id', wrap(async (req, res) => res.json(await store.patchCharacter(idParam(req), req.body?.updates))));
  app.delete('/api/characters/:id', wrap(async (req, res) => res.json(await store.deleteCharacter(idParam(req)))));
  app.post('/api/characters/:id/duplicate', wrap(async (req, res) => res.status(201).json(await store.duplicateCharacter(idParam(req)))));
  app.get('/api/characters/:id/markdown', (req, res) => {
    const c = store.getCharacter(idParam(req));
    const story = c.storyId ? store.data.stories.find((s) => s.id === c.storyId) : null;
    const md = characterMarkdown(c, story, store.listCharacters(c.storyId));
    const file = `${displayName(c).replace(/[^\w-]+/g, '_') || 'character'}.md`;
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
    res.send(md);
  });

  // Import / export
  app.get('/api/export', (req, res) => {
    if (req.query.download) res.setHeader('Content-Disposition', 'attachment; filename="charbuild-export.json"');
    res.json(store.exportAll());
  });
  app.post('/api/import', wrap(async (req, res) => res.json(await store.importData(req.body?.data, req.body?.mode))));
  app.post('/api/reset-sample', wrap(async (req, res) => {
    const sample = sampleData();
    res.json(await store.importData(sample, 'merge'));
  }));

  // Settings (API key is write-only; only a hint is ever returned)
  app.get('/api/settings', (req, res) => res.json(aiStatus(req)));
  app.put('/api/settings', wrap(async (req, res) => {
    if (!canEditSettings(req)) {
      throw new HttpError(403, 'AI settings can only be changed on the computer running CharBuild (or start it with ALLOW_REMOTE_SETTINGS=1).');
    }
    const { apiKey, model, effort, clearKey } = req.body || {};
    const patch = {};
    if (clearKey) patch.apiKey = null;
    else if (typeof apiKey === 'string' && apiKey.trim()) patch.apiKey = apiKey.trim();
    if (typeof model === 'string') patch.model = model.trim() || null;
    if (typeof effort === 'string') patch.effort = effort || null;
    await store.saveSettings(patch);
    res.json(aiStatus(req));
  }));

  // Book
  app.get('/api/book/status', (req, res) => res.json(bookStatus(rootDir)));
  app.get('/api/book/search', (req, res) => {
    const q = String(req.query.q || '').slice(0, 300);
    const limit = Math.max(1, Math.min(10, Number(req.query.limit) || 6));
    res.json(searchBook(rootDir, q, limit, 900));
  });

  // AI
  app.post('/api/ai/test', wrap(async (req, res) => {
    try {
      res.json(await ai.test());
    } catch (err) {
      res.status(200).json({ ok: false, error: friendlyError(err) });
    }
  }));

  app.get('/api/ai/conversations', wrap(async (req, res) => {
    res.json(await store.listChats({ characterId: req.query.characterId, mode: req.query.mode }));
  }));
  app.get('/api/ai/conversations/:id', wrap(async (req, res) => {
    const chat = await store.loadChat(idParam(req));
    if (!chat) throw new HttpError(404, 'Conversation not found');
    res.json(publicChat(chat));
  }));
  app.delete('/api/ai/conversations/:id', wrap(async (req, res) => res.json(await store.deleteChat(idParam(req)))));
  app.post('/api/ai/conversations/:id/proposals/:pid', wrap(async (req, res) => {
    const status = ['applied', 'dismissed', 'pending'].includes(req.body?.status) ? req.body.status : 'pending';
    if (!validId(req.params.pid)) throw new HttpError(400, 'Invalid id');
    res.json(await ai.setProposalStatus(idParam(req), req.params.pid, status));
  }));

  app.post('/api/ai/chat', async (req, res) => {
    const { conversationId, mode, characterId, message, section } = req.body || {};
    if (conversationId && !validId(conversationId)) return res.status(400).json({ error: 'Invalid conversation id' });
    if (!conversationId && !validId(characterId)) return res.status(400).json({ error: 'characterId required' });
    try {
      if (!conversationId) store.getCharacter(characterId);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    const emit = (type, data) => {
      if (!res.writableEnded) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const ping = setInterval(() => emit('ping', {}), 15000);
    try {
      await ai.chat({ conversationId, mode, characterId, message, section }, emit, controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) emit('error', { message: friendlyError(err) });
    } finally {
      clearInterval(ping);
      res.end();
    }
  });

  // Static app
  app.use('/shared', express.static(path.join(ROOT, 'shared'), { fallthrough: false }));
  app.use(express.static(path.join(ROOT, 'public')));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

  // Errors
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[server]', err);
    res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message });
  });

  return { app, store, ai };
}

function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Claude rejected the credentials. Add a valid API key in AI settings (or set ANTHROPIC_API_KEY) and try again.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'This API key is not allowed to use the selected model.';
  if (err instanceof Anthropic.NotFoundError) return 'Model not found. Check the model name in AI settings.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited by the Claude API. Wait a moment and try again.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Claude API. Check your network connection.';
  if (err instanceof Anthropic.APIError) return `Claude API error${err.status ? ` ${err.status}` : ''}: ${err.message}`;
  if (/api key|apiKey|authentication|credentials/i.test(err?.message || '')) return 'No Claude credentials found. Add an API key in AI settings or set ANTHROPIC_API_KEY.';
  return err?.message || 'Something went wrong.';
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);
  const port = Number(process.env.PORT) || 4133;
  // Listen on all interfaces so phones, tablets and other computers on the
  // LAN can open the app. Set HOST=127.0.0.1 to keep it private to this machine.
  const host = process.env.HOST || '0.0.0.0';
  const { app, ai } = await createApp();
  const server = app.listen(port, host, () => {
    const st = ai.status();
    const everywhere = host === '0.0.0.0' || host === '::';
    console.log(`\n  CharBuild — character builder after McKee's CHARACTER\n`);
    console.log(`  Local:    http://localhost:${port}`);
    if (everywhere) {
      const lan = lanAddresses();
      for (const ip of lan) console.log(`  Network:  http://${ip}:${port}`);
      if (!lan.length) console.log('  Network:  no LAN interface found');
    } else {
      console.log(`  Bound to ${host} only${host === '127.0.0.1' || host === 'localhost' ? ' — not reachable from other devices' : ''}`);
    }
    console.log(`\n  AI coach: ${st.configured ? `on (${st.model}, key from ${st.source})` : 'off — add a key in the app’s AI settings or set ANTHROPIC_API_KEY'}`);
    console.log(`  Book search: ${st.book.available ? `${st.book.passages} passages from docs/${st.book.file}` : st.book.reason}\n`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`\n  Port ${port} is already in use. Stop the other process or set PORT=… and try again.\n`);
    else if (err.code === 'EACCES') console.error(`\n  Not allowed to listen on ${host}:${port}.\n`);
    else console.error(err);
    process.exit(1);
  });
}
