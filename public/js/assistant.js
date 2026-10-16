// The optional AI drawer: Coach (proposes field updates), Interview (the
// character tells her self-story), Book (local search in McKee's text) and
// Settings (API key, model). Talks to /api/ai/* over fetch + SSE.

import * as K from '/shared/catalog.js';
import { fieldIndex } from '/shared/fields.js';
import { displayName } from '/shared/model.js';
import { esc, attr, icon, mdLite, toast, timeAgo, autoGrow } from './ui.js';

const COACH_PROMPTS = [
  ['What’s weakest?', 'Run the McKee diagnostics and tell me the three most important things to fix about this character, then propose fixes.'],
  ['Find clichés', 'Where is this character clichéd or generic? Suggest more specific, never-seen-before alternatives.'],
  ['Deepen dimensions', 'Propose two or three new dimensions that would make this character more complex, with a behaviour for each pole, and say which should be defining.'],
  ['Counterdesire', 'Help me find a subconscious desire that contradicts her conscious object of desire.'],
  ['Design a foil', 'Suggest a foil character who would illuminate her defining dimension.'],
  ['Tune the inciting incident', 'Is the inciting incident perfectly tuned to her need? Propose alternatives that would push her to the limits of her humanity.'],
];

const INTERVIEW_PROMPTS = [
  'Tell me about yourself. Who are you?',
  'What was the worst day of your life?',
  'What is the thing you’re proudest of?',
  'What’s the hardest choice you’ve ever made?',
  'What do you want more than anything right now — and why?',
  'What would you never do, no matter what?',
  'Who do you love? Who do you hate?',
  'Do you believe in God? In people?',
  'What’s your plan for the next year?',
];

export class Assistant {
  constructor(opts) {
    this.opts = opts;
    this.tab = 'coach';
    this.open = false;
    this.busy = false;
    this.ctx = {};
    this.chats = { coach: null, interview: null }; // current conversation per mode
    this.histories = { coach: [], interview: [] };
    this.loadedFor = null;
    this.bookResults = null;
    this.el = document.createElement('aside');
    this.el.className = 'coach-drawer';
    this.el.id = 'assistant';
    this.el.setAttribute('aria-label', 'AI coach');
    this.el.hidden = true;
    this.el.__assistant = this;
    document.body.appendChild(this.el);
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.el.addEventListener('input', (e) => {
      if (e.target.matches('textarea')) autoGrow(e.target);
    });
    this.el.addEventListener('change', (e) => this.onChange(e));
  }

  // ── public API ──────────────────────────────────────────────────────────
  setContext(ctx) {
    const prev = this.ctx.character?.id;
    this.ctx = ctx;
    if (ctx.character?.id !== prev) {
      this.chats = { coach: null, interview: null };
      this.histories = { coach: [], interview: [] };
      this.loadedFor = null;
      if (this.open) this.loadHistory();
    }
    if (this.open) this.render();
  }

  toggle() {
    if (this.open) this.close();
    else this.show();
  }

  show(tab) {
    if (tab) this.tab = tab;
    this.open = true;
    this.el.hidden = false;
    document.body.classList.add('with-assistant');
    requestAnimationFrame(() => this.el.classList.add('in'));
    this.loadHistory();
    this.render();
  }

  close() {
    this.open = false;
    this.el.classList.remove('in');
    document.body.classList.remove('with-assistant');
    setTimeout(() => {
      if (!this.open) this.el.hidden = true;
    }, 200);
  }

  ask(prompt) {
    this.show('coach');
    if (!this.ctx.character) return;
    this.send('coach', prompt);
  }

  openBook(q) {
    this.show('book');
    const inp = this.el.querySelector('#book-q');
    if (inp) inp.value = q || '';
    if (q) this.searchBook(q);
  }

  // ── data ────────────────────────────────────────────────────────────────
  async loadHistory() {
    const c = this.ctx.character;
    if (!c || this.loadedFor === c.id) return;
    this.loadedFor = c.id;
    try {
      for (const mode of ['coach', 'interview']) {
        const list = await this.opts.api('GET', `/api/ai/conversations?characterId=${encodeURIComponent(c.id)}&mode=${mode}`);
        this.histories[mode] = list;
        if (!this.chats[mode] && list[0]) this.chats[mode] = await this.opts.api('GET', `/api/ai/conversations/${list[0].id}`);
      }
      this.render();
    } catch (err) {
      console.warn('history load failed', err);
    }
  }

  async selectConversation(mode, id) {
    if (!id) {
      this.chats[mode] = null;
    } else {
      this.chats[mode] = await this.opts.api('GET', `/api/ai/conversations/${id}`);
    }
    this.render();
  }

  // ── rendering ───────────────────────────────────────────────────────────
  render() {
    if (!this.open) return;
    const c = this.ctx.character;
    const ai = this.opts.getAI() || {};
    const tabs = [['coach', 'Coach', 'sparkle'], ['interview', 'Interview', 'mic'], ['book', 'Book', 'book'], ['settings', '', 'gear']];
    const scrollTop = this.el.querySelector('.as-msgs')?.scrollTop;
    const draft = this.el.querySelector('#as-input')?.value;
    this.el.innerHTML = `<header class="as-head">
        <div class="as-title">${icon('sparkle')}<div><b>McKee coach</b><small>${c ? `for ${esc(displayName(c))}` : 'open a character to begin'}</small></div></div>
        <button class="icon-btn" data-as="close" aria-label="Close coach">${icon('x')}</button></header>
      <nav class="as-tabs" role="tablist">${tabs.map(([id, label, ic]) => `<button role="tab" aria-selected="${this.tab === id}" class="as-tab ${this.tab === id ? 'on' : ''}" data-as="tab" data-tab="${id}" ${label ? '' : 'aria-label="Settings"'}>${icon(ic)}${label ? `<span>${label}</span>` : ''}</button>`).join('')}</nav>
      <div class="as-body">${this.tab === 'book' ? this.bookHtml() : this.tab === 'settings' ? this.settingsHtml(ai) : this.chatHtml(this.tab, c, ai)}</div>`;
    const msgs = this.el.querySelector('.as-msgs');
    if (msgs) msgs.scrollTop = scrollTop ?? msgs.scrollHeight;
    const input = this.el.querySelector('#as-input');
    if (input && draft) {
      input.value = draft;
      autoGrow(input);
    }
  }

  chatHtml(mode, c, ai) {
    if (!c) return '<div class="as-empty"><p>Open a character in the builder to get coaching or to interview her.</p></div>';
    const chat = this.chats[mode];
    const history = this.histories[mode];
    const setup = ai.configured ? '' : `<div class="as-setup">${icon('info')}<div><b>AI is optional and not configured.</b><p>Add an Anthropic API key in <button class="link" data-as="tab" data-tab="settings">settings</button> (or set <code>ANTHROPIC_API_KEY</code> before <code>npm start</code>). Everything else in CharBuild works without it.</p></div></div>`;
    const intro = mode === 'coach'
      ? `<div class="as-intro"><p>Ask anything about building <b>${esc(displayName(c))}</b>. The coach reads the live profile, searches McKee’s book, runs the diagnostics and proposes field values you can apply with one click.</p></div>`
      : `<div class="as-intro"><p><b>${esc(displayName(c))}</b> sits across from you. McKee’s self-story exercise: ask about high points, low points, dilemmas and beliefs — then judge truth from self-serving spin (Ch. 4). Write in [brackets] to step out of the scene.</p></div>`;
    const msgs = (chat?.display || []).map((m) => this.msgHtml(m, chat.id)).join('');
    const prompts = mode === 'coach'
      ? COACH_PROMPTS.map(([label, p]) => `<button class="chip small" data-as="prompt" data-prompt="${attr(p)}">${esc(label)}</button>`).join('')
      : INTERVIEW_PROMPTS.map((p) => `<button class="chip small" data-as="prompt" data-prompt="${attr(p)}">${esc(p)}</button>`).join('');
    return `${setup}
      <div class="as-conv"><select data-as="conv" data-mode="${mode}" aria-label="Conversation"><option value="">New conversation</option>${history.map((h) => `<option value="${attr(h.id)}" ${chat?.id === h.id ? 'selected' : ''}>${esc(h.title)} · ${esc(timeAgo(h.updatedAt))}</option>`).join('')}</select>
        <button class="icon-btn sm" data-as="new" data-mode="${mode}" title="New conversation">${icon('plus')}</button>
        ${chat ? `<button class="icon-btn sm" data-as="delete-conv" data-mode="${mode}" title="Delete conversation">${icon('trash')}</button>` : ''}
        ${mode === 'interview' && chat?.display?.length ? `<button class="btn sm" data-as="distill">${icon('sparkle')} Distill into profile</button>` : ''}</div>
      <div class="as-msgs" aria-live="polite">${msgs || intro}<div id="as-live"></div></div>
      <div class="as-prompts">${prompts}</div>
      <form class="as-compose" data-as="form" data-mode="${mode}">
        <textarea id="as-input" rows="2" placeholder="${mode === 'coach' ? 'Ask the coach…' : `Ask ${esc(displayName(c).split(' ')[0])} a question…`}" ${this.busy ? 'disabled' : ''}></textarea>
        ${this.busy ? `<button type="button" class="btn danger sm" data-as="stop">${icon('stop')} Stop</button>` : `<button type="submit" class="btn primary sm">${icon('send')} Send</button>`}
      </form>`;
  }

  msgHtml(m, chatId) {
    if (m.role === 'user') return `<div class="msg user"><div class="bubble">${mdLite(m.text)}</div></div>`;
    return `<div class="msg assistant">
      ${m.thinking ? `<details class="thinking"><summary>Reasoning</summary><div>${mdLite(m.thinking)}</div></details>` : ''}
      ${(m.tools || []).map((t) => `<div class="tool-badge">${icon(t.name === 'search_mckee_book' ? 'search' : 'chart')}<span>${esc(t.label)}</span>${t.results?.length ? `<small>${esc(t.results.map((r) => r.chapter).filter((v, i, a) => a.indexOf(v) === i).join(' · '))}</small>` : ''}</div>`).join('')}
      ${m.text ? `<div class="bubble">${mdLite(m.text)}</div>` : ''}
      ${(m.proposals || []).map((p) => this.proposalHtml(p, chatId)).join('')}
      ${m.error ? `<div class="bubble error">${icon('alert')} ${esc(m.error)}</div>` : ''}
    </div>`;
  }

  proposalHtml(p, chatId) {
    const done = p.status && p.status !== 'pending';
    if (p.kind === 'cast') {
      const m = p.member;
      const circle = K.CIRCLES.find((x) => x.id === m.circle)?.label || m.circle;
      return `<div class="proposal cast ${done ? 'done' : ''}" data-pid="${attr(p.id)}" data-chat="${attr(chatId || '')}">
        <header>${icon('users')}<b>${esc(m.name)}</b><span class="tag">${esc(circle)}</span>${done ? `<span class="status ${p.status}">${p.status}</span>` : ''}</header>
        <p><b>${esc(m.roleLabel)}</b>${m.logline ? ` — ${esc(m.logline)}` : ''}</p>
        ${m.draws ? `<p class="muted">Draws out: ${esc(m.draws)}</p>` : ''}
        <p class="rationale">${esc(m.reason)}</p>
        ${done ? '' : `<footer><button class="btn primary sm" data-as="add-cast">${icon('plus')} Add to cast</button><button class="btn ghost sm" data-as="dismiss">Dismiss</button></footer>`}</div>`;
    }
    const idx = fieldIndex();
    return `<div class="proposal ${done ? 'done' : ''}" data-pid="${attr(p.id)}" data-chat="${attr(chatId || '')}">
      <header>${icon('sparkle')}<b>${esc(p.summary || 'Proposed updates')}</b>${done ? `<span class="status ${p.status}">${p.status}</span>` : ''}</header>
      <ul>${p.updates.map((u, i) => `<li><label><input type="checkbox" data-u="${i}" ${done ? 'disabled' : 'checked'}>
        <span class="pu"><span class="pu-label">${esc(u.label || idx[u.path]?.label || u.path)}</span><span class="pu-val">${esc(this.preview(u))}</span>${u.rationale ? `<small>${esc(u.rationale)}</small>` : ''}</span></label></li>`).join('')}</ul>
      ${done ? '' : `<footer><button class="btn primary sm" data-as="apply">${icon('check')} Apply selected</button><button class="btn ghost sm" data-as="dismiss">Dismiss</button></footer>`}</div>`;
  }

  preview(u) {
    const def = fieldIndex()[u.path];
    const v = u.value;
    const lbl = (id) => {
      for (const list of Object.values(K)) {
        if (Array.isArray(list)) {
          const hit = list.find((o) => o && o.id === id);
          if (hit) return hit.label;
        }
      }
      return id;
    };
    if (def?.kind === 'list') {
      const item = v || {};
      const text = item.positive ? `${item.positive} / ${item.negative}${item.defining ? ' ★ defining' : ''}` : item.label ? `${item.label} (${item.charge > 0 ? '+' : ''}${item.charge})` : item.title || item.with || item.persona || JSON.stringify(item);
      return `${u.op === 'append' ? 'Add: ' : ''}${text}`;
    }
    if (Array.isArray(v)) return `${u.op === 'append' ? '+ ' : ''}${v.map(lbl).join(', ')}`;
    if (def?.kind === 'enum') return lbl(v);
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    const s = String(v ?? '');
    return s.length > 240 ? `${s.slice(0, 239)}…` : s;
  }

  bookHtml() {
    const r = this.bookResults;
    const status = this.opts.getAI()?.book;
    return `<form class="book-search" data-as="book-form"><input id="book-q" class="inp" placeholder="Search McKee’s CHARACTER — e.g. “defining dimension”" value="${attr(r?.q || '')}"><button class="btn sm" type="submit">${icon('search')}</button></form>
      ${status && !status.available ? `<p class="as-empty">${esc(status.reason)}</p>` : ''}
      <div class="book-results">${r ? (r.results.length ? r.results.map((x) => `<article class="passage"><header><b>${esc(x.chapter)}</b>${x.section ? `<span>${esc(x.section)}</span>` : ''}</header><p>${esc(x.text)}</p>
        <button class="link" data-as="ask-passage" data-q="${attr(`${x.chapter}${x.section ? ` — ${x.section}` : ''}`)}">Ask the coach how this applies →</button></article>`).join('') : '<p class="as-empty">No passages found.</p>') : `<p class="as-empty">Searches your own copy of the book in <code>docs/</code> — no AI key needed.</p>`}</div>`;
  }

  settingsHtml(ai) {
    return `<div class="as-settings">
      <div class="status-row ${ai.configured ? 'ok' : ''}">${icon(ai.configured ? 'check' : 'info')}<div><b>${ai.configured ? 'AI configured' : 'AI not configured'}</b><small>${ai.configured ? `Key from ${esc(ai.source)}${ai.keyHint ? ` (${esc(ai.keyHint)})` : ''}` : 'CharBuild works fully without AI.'}</small></div></div>
      <label class="field"><span class="lbl">Anthropic API key</span><input class="inp" type="password" id="as-key" placeholder="${ai.source === 'settings' ? 'Saved — enter a new key to replace' : 'sk-ant-…'}" autocomplete="off"></label>
      <p class="help">Stored on this machine in <code>data/settings.json</code>; never sent back to the browser. Alternatively set <code>ANTHROPIC_API_KEY</code>.</p>
      <label class="field"><span class="lbl">Model</span><input class="inp" id="as-model" value="${attr(ai.model || '')}" placeholder="claude-opus-5-5"></label>
      <label class="field"><span class="lbl">Effort</span><select class="inp" id="as-effort">${['low', 'medium', 'high', 'xhigh'].map((e) => `<option ${ai.effort === e ? 'selected' : ''}>${e}</option>`).join('')}</select></label>
      <div class="row-btns"><button class="btn primary sm" data-as="save-settings">Save</button><button class="btn sm" data-as="test">Test connection</button>${ai.source === 'settings' ? '<button class="btn ghost sm" data-as="clear-key">Remove saved key</button>' : ''}</div>
      <p id="as-test" class="help"></p>
      <p class="help">Book search: ${ai.book?.available ? `${ai.book.passages} passages indexed from <code>${esc(ai.book.file)}</code>.` : esc(ai.book?.reason || 'unavailable')}</p>
    </div>`;
  }

  // ── events ──────────────────────────────────────────────────────────────
  onKey(e) {
    if (e.target.id === 'as-input' && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.target.closest('form')?.requestSubmit();
    }
  }

  onChange(e) {
    const el = e.target;
    if (el.dataset.as === 'conv') this.selectConversation(el.dataset.mode, el.value);
  }

  async onClick(e) {
    const el = e.target.closest('[data-as]');
    if (!el) return;
    const a = el.dataset.as;
    if (a === 'form' || a === 'book-form') return;
    e.preventDefault();
    try {
      if (a === 'close') this.close();
      else if (a === 'tab') {
        this.tab = el.dataset.tab;
        this.render();
      } else if (a === 'prompt') {
        const input = this.el.querySelector('#as-input');
        if (this.busy) return;
        this.send(this.tab, el.dataset.prompt);
        if (input) input.value = '';
      } else if (a === 'new') this.selectConversation(el.dataset.mode, '');
      else if (a === 'delete-conv') {
        const chat = this.chats[el.dataset.mode];
        if (!chat) return;
        await this.opts.api('DELETE', `/api/ai/conversations/${chat.id}`);
        this.histories[el.dataset.mode] = this.histories[el.dataset.mode].filter((h) => h.id !== chat.id);
        this.chats[el.dataset.mode] = null;
        this.render();
      } else if (a === 'stop') this.abort?.abort();
      else if (a === 'apply') await this.applyProposal(el.closest('.proposal'));
      else if (a === 'dismiss') await this.setStatus(el.closest('.proposal'), 'dismissed');
      else if (a === 'add-cast') await this.addCast(el.closest('.proposal'));
      else if (a === 'distill') this.distill();
      else if (a === 'save-settings') await this.saveSettings();
      else if (a === 'clear-key') await this.saveSettings({ clearKey: true });
      else if (a === 'test') await this.testConnection();
      else if (a === 'ask-passage') {
        this.tab = 'coach';
        this.ask(`McKee writes about “${el.dataset.q}”. How does that apply to this character? Be specific and propose changes.`);
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ── chat ────────────────────────────────────────────────────────────────
  async send(mode, text) {
    const c = this.ctx.character;
    if (!c || this.busy || !text?.trim()) return;
    await this.opts.flushSaves();
    this.busy = true;
    this.tab = mode;
    let chat = this.chats[mode];
    if (!chat) {
      chat = { id: null, mode, display: [] };
      this.chats[mode] = chat;
    }
    const userMsg = { role: 'user', text };
    const live = { role: 'assistant', text: '', thinking: '', tools: [], proposals: [] };
    chat.display.push(userMsg, live);
    this.render();
    const liveEl = () => [...this.el.querySelectorAll('.as-msgs .msg.assistant')].pop();
    let raf = 0;
    let finished = false;
    const paint = () => {
      if (raf || finished) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (finished) return;
        const node = liveEl();
        if (node) node.outerHTML = this.msgHtml({ ...live, text: live.text || (live.tools.length || live.thinking ? '' : '…') }, chat.id);
        const msgs = this.el.querySelector('.as-msgs');
        if (msgs) msgs.scrollTop = msgs.scrollHeight;
      });
    };
    paint();
    this.abort = new AbortController();
    let failed = null;
    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: chat.id, mode, characterId: c.id, message: text, section: this.ctx.section }),
        signal: this.abort.signal,
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const type = raw.match(/^event: (.*)$/m)?.[1];
          const dataLine = raw.match(/^data: (.*)$/m)?.[1];
          if (!type || dataLine == null) continue;
          const data = JSON.parse(dataLine);
          if (type === 'conversation') {
            if (!chat.id) {
              chat.id = data.id;
              chat.title = data.title;
              this.histories[mode] = [{ id: data.id, title: data.title, updatedAt: new Date().toISOString() }, ...this.histories[mode]];
            }
          } else if (type === 'text') live.text += data.delta;
          else if (type === 'thinking') live.thinking += data.delta;
          else if (type === 'tool') live.tools.push(data);
          else if (type === 'proposal') live.proposals.push(data);
          else if (type === 'error') failed = data.message;
          paint();
        }
      }
    } catch (err) {
      failed = err.name === 'AbortError' ? 'Stopped.' : err.message;
    } finally {
      this.busy = false;
      this.abort = null;
      finished = true;
      if (raf) cancelAnimationFrame(raf);
    }
    if (failed) {
      // The server keeps nothing from a failed turn, so drop it here too
      // and give the text back to the composer for a retry.
      chat.display.splice(chat.display.indexOf(userMsg), 2);
      if (!chat.display.length && !chat.id) this.chats[mode] = null;
      this.render();
      const msgs = this.el.querySelector('.as-msgs');
      msgs?.insertAdjacentHTML('beforeend', this.msgHtml({ role: 'assistant', error: failed, text: '' }));
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
      const input = this.el.querySelector('#as-input');
      if (input) input.value = text;
      return;
    }
    this.render();
  }

  distill() {
    const chat = this.chats.interview;
    if (!chat?.display?.length) return;
    const transcript = chat.display.map((m) => `${m.role === 'user' ? 'WRITER' : 'CHARACTER'}: ${m.text}`).join('\n\n').slice(-16000);
    this.tab = 'coach';
    this.ask(`Here is my interview with the character (McKee's self-story exercise). Separate what she believes from what is true, note her self-deceptions, and propose updates to the profile (self-story, selves, desires, dimensions, subtext) based on it.\n\n<interview>\n${transcript}\n</interview>`);
  }

  findProposal(card) {
    const id = card.dataset.pid;
    for (const mode of ['coach', 'interview']) {
      for (const m of this.chats[mode]?.display || []) {
        const p = (m.proposals || []).find((x) => x.id === id);
        if (p) return { p, chatId: this.chats[mode].id };
      }
    }
    return {};
  }

  async setStatus(card, status) {
    const { p, chatId } = this.findProposal(card);
    if (!p) return;
    p.status = status;
    if (chatId) await this.opts.api('POST', `/api/ai/conversations/${chatId}/proposals/${p.id}`, { status }).catch(() => {});
    this.render();
  }

  async applyProposal(card) {
    const { p } = this.findProposal(card);
    if (!p) return;
    const chosen = [...card.querySelectorAll('input[data-u]')].filter((x) => x.checked).map((x) => p.updates[Number(x.dataset.u)]);
    if (!chosen.length) return toast('Select at least one update', 'info');
    await this.opts.flushSaves();
    const updated = await this.opts.api('PATCH', `/api/characters/${p.characterId}`, { updates: chosen.map(({ path, op, value }) => ({ path, op, value })) });
    this.opts.onCharacterUpdated(updated);
    await this.setStatus(card, 'applied');
    toast(`Applied ${chosen.length} update${chosen.length === 1 ? '' : 's'}`, 'success');
  }

  async addCast(card) {
    const { p } = this.findProposal(card);
    if (!p) return;
    const m = p.member;
    const created = await this.opts.api('POST', '/api/characters', {
      name: m.name,
      storyId: p.storyId || null,
      concept: { roleLabel: m.roleLabel, logline: m.logline || '' },
      cast: { circle: m.circle, specialRoles: m.specialRoles || [] },
    });
    this.opts.onCharacterCreated(created);
    if (p.storyId && m.draws) {
      await this.opts.flushSaves();
      const updated = await this.opts.api('PATCH', `/api/characters/${p.characterId}`, { updates: [{ path: 'relationships', op: 'append', value: { targetId: created.id, draws: m.draws, kind: (m.specialRoles || []).includes('foil') ? 'foil' : undefined } }] });
      this.opts.onCharacterUpdated(updated);
    }
    await this.setStatus(card, 'applied');
    toast(`${m.name} added to the cast`, 'success');
  }

  // ── book & settings ─────────────────────────────────────────────────────
  async searchBook(q) {
    if (!q?.trim()) return;
    const res = await this.opts.api('GET', `/api/book/search?q=${encodeURIComponent(q)}&limit=6`);
    this.bookResults = { q, results: res.results || [] };
    if (!res.available) toast(res.reason || 'Book unavailable', 'error');
    this.render();
  }

  async saveSettings(extra = {}) {
    const body = { ...extra };
    const key = this.el.querySelector('#as-key')?.value.trim();
    if (key && !extra.clearKey) body.apiKey = key;
    const model = this.el.querySelector('#as-model')?.value.trim();
    if (model !== undefined) body.model = model;
    const effort = this.el.querySelector('#as-effort')?.value;
    if (effort) body.effort = effort;
    const ai = await this.opts.api('PUT', '/api/settings', body);
    this.opts.setAI(ai);
    toast(extra.clearKey ? 'Saved key removed' : 'Settings saved', 'success');
    this.render();
  }

  async testConnection() {
    const out = this.el.querySelector('#as-test');
    if (out) out.textContent = 'Testing…';
    const r = await this.opts.api('POST', '/api/ai/test');
    if (out) out.innerHTML = r.ok ? `${icon('check')} Connected — ${esc(r.name || r.model)}` : `${icon('alert')} ${esc(r.error)}`;
  }
}

// Book search form submit (delegated at document level so re-renders keep working)
document.addEventListener('submit', (e) => {
  const form = e.target;
  const host = form.closest('#assistant');
  if (!host) return;
  e.preventDefault();
  const inst = host.__assistant;
  if (!inst) return;
  if (form.dataset.as === 'book-form') inst.searchBook(form.querySelector('#book-q').value);
  if (form.dataset.as === 'form') {
    const input = form.querySelector('#as-input');
    const text = input.value;
    input.value = '';
    inst.send(form.dataset.mode, text);
  }
});
