// Moving stories and characters in and out of the library: the export
// dialog (stories with their cast, single characters, JSON or Markdown), the
// import preview (choose items and what to do with ones you already have),
// undo through backups, the backups list, and drag-and-drop import.

import * as K from '/shared/catalog.js';
import { displayName } from '/shared/model.js';
import { characterMarkdown, storyMarkdown } from '/shared/export.js';
import { exportFileName, exportKind } from '/shared/transfer.js';
import { t, tn, getLocale } from '/shared/i18n.js';
import { esc, attr, icon, toast, modal, confirmDialog, download, timeAgo, tHtml } from './ui.js';

export function createTransfer({ api, getState, load, render, flushSaves }) {
  const castOf = (storyId) => getState().characters.filter((c) => (storyId ? c.storyId === storyId : !c.storyId));
  const storyById = (id) => getState().stories.find((s) => s.id === id);
  const circleLabel = (id) => K.CIRCLES.find((c) => c.id === id)?.label || t('Unplaced');
  // "1 story · 6 characters", leaving out a count of zero stories.
  const counts = (stories, characters) => [stories ? tn(stories, '{n} story', '{n} stories') : null, tn(characters, '{n} character', '{n} characters')].filter(Boolean).join(' · ');

  const reload = async () => {
    await load();
    render();
  };

  async function undo(backupId, doneMessage) {
    await flushSaves();
    await api('POST', `/api/backups/${encodeURIComponent(backupId)}/restore`);
    await reload();
    toast(doneMessage || t('Undone'), 'success');
  }

  // ── Export ──────────────────────────────────────────────────────────────
  const itemRow = ({ kind, id, name, sub, checked, nested, inStory, badge = '' }) => `<label class="xfer-item ${nested ? 'sub' : ''}">
      <input type="checkbox" ${kind === 'story' ? `data-story="${attr(id)}"` : `data-char="${attr(id)}"`} ${inStory ? `data-in="${attr(inStory)}"` : ''} ${checked ? 'checked' : ''}>
      <span class="xfer-name"><b>${esc(name)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>${badge}</label>`;

  function exportBody(pre) {
    const { stories } = getState();
    const loose = castOf(null);
    const storyBlocks = stories.map((s) => {
      const cast = castOf(s.id);
      const on = pre.stories ? pre.stories.includes(s.id) : !pre.characters;
      return `<div class="xfer-story">${itemRow({ kind: 'story', id: s.id, name: s.title, sub: tn(cast.length, '{n} character', '{n} characters'), checked: on })}
        ${cast.length ? `<details class="xfer-cast"><summary>${esc(tn(cast.length, 'Pick from its {n} character', 'Pick from its {n} characters'))}</summary>
          ${cast.map((c) => itemRow({ kind: 'char', id: c.id, name: displayName(c), sub: circleLabel(c.cast?.circle), checked: on || pre.characters?.includes(c.id), nested: true, inStory: s.id })).join('')}</details>` : ''}</div>`;
    }).join('');
    const looseRows = loose.map((c) => itemRow({ kind: 'char', id: c.id, name: displayName(c), sub: circleLabel(c.cast?.circle), checked: pre.characters ? pre.characters.includes(c.id) : !pre.stories })).join('');
    return `<div class="xfer">
      <p class="help">${esc(t('Pick what to export. A story comes with its whole cast — or open it to pick single characters.'))}</p>
      <div class="xfer-tools"><button type="button" class="link" data-xfer="all">${esc(t('Select all'))}</button><span aria-hidden="true">·</span><button type="button" class="link" data-xfer="none">${esc(t('Select none'))}</button></div>
      <div class="xfer-list">
        ${stories.length ? `<h4>${esc(t('Stories'))}</h4>${storyBlocks}` : ''}
        ${loose.length ? `<h4>${esc(t('Characters without a story'))}</h4>${looseRows}` : ''}
      </div>
      <fieldset class="xfer-opts"><legend>${esc(t('Format'))}</legend>
        <label class="xfer-radio"><input type="radio" name="xfer-format" value="json" checked><span><b>JSON</b><small>${esc(t('Everything you built, to back up or to import on another computer.'))}</small></span></label>
        <label class="xfer-radio"><input type="radio" name="xfer-format" value="md"><span><b>Markdown</b><small>${esc(t('Readable story and character bibles, to read, print or share.'))}</small></span></label>
        <label class="xfer-check" data-for="json"><input type="checkbox" id="xfer-chats"><span>${esc(t('Include coach conversations'))}</span></label>
      </fieldset>
      <p class="xfer-count" aria-live="polite"></p>
    </div>`;
  }

  // Stories ticked → whole cast; otherwise the single characters ticked.
  function exportSelection(w) {
    const storyIds = [...w.querySelectorAll('input[data-story]:checked')].map((x) => x.dataset.story);
    const characterIds = [...w.querySelectorAll('input[data-char]:checked')]
      .filter((x) => !x.dataset.in || !storyIds.includes(x.dataset.in))
      .map((x) => x.dataset.char);
    return { storyIds, characterIds };
  }

  // Ticking or unticking a story does the same to its characters. In the
  // export dialog (`locked`) a ticked story always takes its whole cast; in
  // the import dialog its characters can still be left out one by one.
  function wireSelection(w, { countText, locked }) {
    const nested = (storyId) => w.querySelectorAll(`input[data-in="${CSS.escape(storyId)}"]`);
    const sync = () => {
      if (locked) {
        for (const box of w.querySelectorAll('input[data-story]')) {
          for (const c of nested(box.dataset.story)) {
            if (box.checked) c.checked = true;
            c.disabled = box.checked;
          }
        }
      }
      const text = countText();
      w.querySelector('.xfer-count').textContent = text.label;
      const go = w.querySelector('footer [data-btn="1"]');
      if (go) go.disabled = !text.any;
    };
    w.addEventListener('change', (e) => {
      if (e.target.matches('input[data-story]')) for (const c of nested(e.target.dataset.story)) c.checked = e.target.checked;
      sync();
    });
    w.addEventListener('click', (e) => {
      const b = e.target.closest('[data-xfer]');
      if (!b) return;
      const on = b.dataset.xfer === 'all';
      for (const box of w.querySelectorAll('input[data-story], input[data-char]')) box.checked = on;
      sync();
    });
    sync();
  }

  async function openExport(pre = {}) {
    await flushSaves();
    const { stories, characters } = getState();
    if (!stories.length && !characters.length) return toast(t('The library is empty — nothing to export yet.'), 'info');
    const result = await modal({
      title: t('Export'),
      wide: true,
      body: exportBody(pre),
      buttons: [
        { label: t('Cancel'), value: null },
        { label: t('Export'), kind: 'primary', value: (w) => ({ ...exportSelection(w), format: w.querySelector('input[name="xfer-format"]:checked').value, chats: w.querySelector('#xfer-chats').checked }) },
      ],
      onMount: (w) => {
        const count = () => {
          const sel = exportSelection(w);
          const n = sel.storyIds.reduce((sum, id) => sum + castOf(id).length, 0) + sel.characterIds.length;
          return { any: sel.storyIds.length + sel.characterIds.length > 0, label: counts(sel.storyIds.length, n) };
        };
        const formatChanged = () => {
          const json = w.querySelector('input[name="xfer-format"]:checked').value === 'json';
          w.querySelector('.xfer-check[data-for="json"]').hidden = !json;
        };
        w.addEventListener('change', (e) => {
          if (e.target.name === 'xfer-format') formatChanged();
        });
        wireSelection(w, { countText: count, locked: true });
      },
    });
    if (!result) return;
    if (result.format === 'md') return exportMarkdown(result);
    const q = new URLSearchParams();
    if (result.storyIds.length) q.set('stories', result.storyIds.join(','));
    if (result.characterIds.length) q.set('characters', result.characterIds.join(','));
    if (result.chats) q.set('chats', '1');
    const data = await api('GET', `/api/export?${q}`);
    download(exportFileName(data), JSON.stringify(data, null, 2));
    toast(t('Exported {what}', { what: counts(data.stories.length, data.characters.length) }), 'success');
  }

  function exportMarkdown({ storyIds, characterIds }) {
    const docs = [];
    const stories = storyIds.map(storyById).filter(Boolean);
    for (const s of stories) docs.push(storyMarkdown(s, castOf(s.id)));
    const chars = getState().characters.filter((c) => characterIds.includes(c.id));
    for (const c of chars) {
      const story = c.storyId ? storyById(c.storyId) : null;
      docs.push(characterMarkdown(c, story, story ? castOf(story.id) : [c]));
    }
    const kind = exportKind({ stories, characters: [...chars, ...stories.flatMap((s) => castOf(s.id))] });
    download(exportFileName({ kind, stories, characters: chars }, 'md'), docs.join('\n\n---\n\n'), 'text/markdown');
  }

  async function exportCharacter(id) {
    await flushSaves();
    const data = await api('GET', `/api/export?characters=${encodeURIComponent(id)}`);
    download(exportFileName(data), JSON.stringify(data, null, 2));
  }

  // ── Import ──────────────────────────────────────────────────────────────
  const BADGES = {
    new: () => [t('New'), 'new'],
    same: () => [t('Unchanged'), 'same'],
    file: () => [t('In library · file is newer'), 'conflict'],
    library: () => [t('In library · yours is newer'), 'conflict'],
    equal: () => [t('In library · different'), 'conflict'],
  };
  const badge = (item) => {
    const [label, cls] = BADGES[item.status === 'conflict' ? item.newer : item.status]();
    return `<span class="xfer-badge ${cls}">${esc(label)}</span>`;
  };

  function importBody(p, fileName) {
    const { stories } = getState();
    const conflicts = [...p.stories, ...p.characters].filter((x) => x.status === 'conflict');
    const others = p.characters.filter((c) => !c.inFileStory);
    const storyBlocks = p.stories.map((s) => {
      const cast = p.characters.filter((c) => c.inFileStory && c.storyId === s.id);
      return `<div class="xfer-story">${itemRow({ kind: 'story', id: s.id, name: s.title, sub: tn(s.characters, '{n} character', '{n} characters'), checked: true, badge: badge(s) })}
        ${cast.length ? `<div class="xfer-cast open">${cast.map((c) => itemRow({ kind: 'char', id: c.id, name: c.name || t('Unnamed character'), sub: circleLabel(c.circle), checked: true, nested: true, inStory: s.id, badge: badge(c) })).join('')}</div>` : ''}</div>`;
    }).join('');
    const otherRows = others.map((c) => itemRow({
      kind: 'char', id: c.id, name: c.name || t('Unnamed character'), checked: true, badge: badge(c),
      sub: c.libraryStory ? t('from “{title}”', { title: c.libraryStory.title }) : circleLabel(c.circle),
    })).join('');
    const newerFile = conflicts.every((x) => x.newer === 'file');
    const radio = (value, title, help, on) => `<label class="xfer-radio"><input type="radio" name="xfer-conflict" value="${value}" ${on ? 'checked' : ''}><span><b>${esc(title)}</b><small>${esc(help)}</small></span></label>`;
    return `<div class="xfer">
      <p class="xfer-file">${icon('file')} <b>${esc(fileName)}</b><span>${esc(`${counts(p.stories.length, p.characters.length)}${p.chats ? ` · ${tn(p.chats, '{n} conversation', '{n} conversations')}` : ''}`)}</span>${p.exportedAt ? `<small>${esc(t('exported {when}', { when: new Date(p.exportedAt).toLocaleString(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }) }))}</small>` : ''}</p>
      ${p.newerSchema ? `<p class="xfer-warn">${icon('alert')} ${esc(t('This file was made by a newer version of CharBuild: some details may not come through.'))}</p>` : ''}
      <div class="xfer-tools"><button type="button" class="link" data-xfer="all">${esc(t('Select all'))}</button><span aria-hidden="true">·</span><button type="button" class="link" data-xfer="none">${esc(t('Select none'))}</button></div>
      <div class="xfer-list">
        ${p.stories.length ? `<h4>${esc(t('Stories'))}</h4>${storyBlocks}` : ''}
        ${others.length ? `<h4>${esc(p.stories.length ? t('Other characters') : t('Characters'))}</h4>${otherRows}` : ''}
      </div>
      <div class="xfer-merge">
        ${conflicts.length ? `<fieldset class="xfer-opts"><legend>${esc(tn(conflicts.length, '{n} item is already in your library', '{n} items are already in your library'))}</legend>
          ${radio('update', t('Update them'), t('The file’s version replaces yours.'), newerFile)}
          ${radio('copy', t('Keep both'), t('Import the file’s version as a copy next to yours.'), !newerFile)}
          ${radio('skip', t('Keep yours'), t('Skip them; import only what’s new.'), false)}</fieldset>` : ''}
        ${others.length ? `<label class="field"><span class="lbl">${esc(t('Characters without their story in this file go to'))}</span><select class="inp" id="xfer-target">
          <option value="keep">${esc(t('Their original story, if it’s in the library'))}</option><option value="none">${esc(t('No story'))}</option>
          ${stories.map((s) => `<option value="${attr(s.id)}">${esc(s.title)}</option>`).join('')}</select></label>` : ''}
      </div>
      ${p.chats ? `<label class="xfer-check"><input type="checkbox" id="xfer-chats" checked><span>${esc(t('Include coach conversations'))}</span></label>` : ''}
      <details class="xfer-danger"><summary>${esc(t('Replace the whole library instead'))}</summary>
        <label class="xfer-check"><input type="checkbox" id="xfer-replace"><span>${esc(t('Remove everything that isn’t in this file. A backup is made first, so it can be undone.'))}</span></label></details>
      <p class="xfer-count" aria-live="polite"></p>
    </div>`;
  }

  function importChoices(w) {
    const pick = (sel, key) => [...w.querySelectorAll(`${sel}:checked`)].map((x) => x.dataset[key]);
    return {
      select: { stories: pick('input[data-story]', 'story'), characters: pick('input[data-char]', 'char') },
      conflict: w.querySelector('input[name="xfer-conflict"]:checked')?.value || 'update',
      target: w.querySelector('#xfer-target')?.value || 'keep',
      includeChats: w.querySelector('#xfer-chats')?.checked ?? false,
      replace: !!w.querySelector('#xfer-replace')?.checked,
    };
  }

  function importSummary(r) {
    if (r.replaced) return t('Library replaced: {what}', { what: counts(r.stories, r.characters) });
    const items = (x) => x.stories + x.characters;
    const parts = [
      [items(r.added), t('New: {n}')],
      [items(r.updated), t('Updated: {n}')],
      [items(r.copied), t('Copied: {n}')],
      [items(r.unchanged), t('Unchanged: {n}')],
      [items(r.skipped), t('Skipped: {n}')],
    ].filter(([n]) => n).map(([n, s]) => s.replace('{n}', n));
    const chats = r.added.chats + r.updated.chats + r.copied.chats;
    if (chats) parts.push(tn(chats, '{n} conversation', '{n} conversations'));
    return `${t('Imported')} — ${parts.join(' · ') || t('nothing changed')}`;
  }

  async function importFile(file) {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      return toast(t('“{file}” isn’t a valid JSON file.', { file: file.name }), 'error');
    }
    await flushSaves();
    const preview = await api('POST', '/api/import/preview', { data });
    const choice = await modal({
      title: t('Import'),
      wide: true,
      body: importBody(preview, file.name),
      buttons: [{ label: t('Cancel'), value: null }, { label: t('Import'), kind: 'primary', value: importChoices }],
      onMount: (w) => {
        const count = () => {
          const c = importChoices(w);
          return { any: c.select.stories.length + c.select.characters.length > 0, label: counts(c.select.stories.length, c.select.characters.length) };
        };
        const replaceChanged = () => {
          const on = !!w.querySelector('#xfer-replace')?.checked;
          w.querySelector('.xfer-merge').hidden = on;
          const go = w.querySelector('footer [data-btn="1"]');
          go.classList.toggle('danger', on);
          go.classList.toggle('primary', !on);
          go.textContent = on ? t('Replace library') : t('Import');
        };
        w.addEventListener('change', (e) => {
          if (e.target.id === 'xfer-replace') replaceChanged();
        });
        wireSelection(w, { countText: count });
      },
    });
    if (!choice) return;
    if (choice.replace && !(await confirmDialog(t('Replace the whole library?'), t('Everything that isn’t in “{file}” will be removed from the library. You can undo this from the backups.', { file: file.name }), t('Replace library')))) return;
    const res = await api('POST', '/api/import', { data, ...choice });
    await reload();
    toast(importSummary(res), 'success', 12000, { label: t('Undo'), onClick: () => undo(res.backup.id, t('Import undone')).catch((err) => toast(err.message, 'error')) });
  }

  function pickAndImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const file = input.files[0];
      if (file) importFile(file).catch((err) => toast(t('Import failed: {error}', { error: err.message }), 'error'));
    };
    input.click();
  }

  // ── Backups ─────────────────────────────────────────────────────────────
  const KIND_LABELS = {
    auto: () => t('Automatic'),
    manual: () => t('Made by hand'),
    import: () => t('Before an import'),
    replace: () => t('Before replacing the library'),
    restore: () => t('Before a restore'),
  };

  async function openBackups() {
    await flushSaves();
    const list = await api('GET', '/api/backups');
    const when = (iso) => new Date(iso).toLocaleString(getLocale(), { dateStyle: 'medium', timeStyle: 'short' });
    const rows = list.map((b, i) => `<li class="bk-row"><div><b>${esc(when(b.createdAt))}</b> <span class="muted">${esc(timeAgo(b.createdAt))}</span>
        <small>${esc(KIND_LABELS[b.kind]?.() || b.kind)} · ${esc(tn(b.stories, '{n} story', '{n} stories'))} · ${esc(tn(b.characters, '{n} character', '{n} characters'))}</small></div>
        <button type="button" class="btn sm" data-btn="${i + 2}">${icon('refresh')} ${esc(t('Restore'))}</button></li>`).join('');
    const choice = await modal({
      title: t('Backups'),
      wide: true,
      body: `<div class="xfer">
        <p class="help">${esc(t('CharBuild keeps a snapshot of the library before every import or restore, and every half hour while you work. Restoring one snapshots the current library first, so a restore can be undone too.'))}</p>
        <div class="xfer-tools"><button type="button" class="btn sm" data-btn="1">${icon('download')} ${esc(t('Back up now'))}</button></div>
        ${list.length ? `<ul class="bk-list">${rows}</ul>` : `<p class="viz-empty">${esc(t('No backups yet.'))}</p>`}
        <p class="help">${tHtml('Stored on the host in {dir}.', { dir: '<code>data/backups/</code>' })}</p></div>`,
      buttons: [{ label: t('Close'), value: null }, { label: '', value: { create: true } }, ...list.map((b) => ({ label: '', value: { restore: b } }))],
      onMount: (w) => w.querySelectorAll('footer [data-btn]').forEach((b) => { if (b.dataset.btn !== '0') b.remove(); }),
    });
    if (!choice) return;
    if (choice.create) {
      await api('POST', '/api/backups');
      toast(t('Backup saved'), 'success');
      return openBackups();
    }
    const b = choice.restore;
    if (!(await confirmDialog(t('Restore this backup?'), t('The library goes back to how it was on {date}. The current library is backed up first, so you can undo this.', { date: when(b.createdAt) }), t('Restore')))) return;
    const res = await api('POST', `/api/backups/${encodeURIComponent(b.id)}/restore`);
    await reload();
    toast(t('Library restored to {date}', { date: when(b.createdAt) }), 'success', 12000, { label: t('Undo'), onClick: () => undo(res.backup.id).catch((err) => toast(err.message, 'error')) });
  }

  // ── Drag and drop a .json file anywhere to import it ────────────────────
  function enableDrop() {
    let overlay = null;
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    const hide = () => {
      depth = 0;
      overlay?.remove();
      overlay = null;
    };
    document.addEventListener('dragenter', (e) => {
      if (!hasFiles(e) || document.querySelector('.modal-backdrop')) return;
      depth += 1;
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'drop-overlay';
        overlay.innerHTML = `<div>${icon('upload')}<b>${esc(t('Drop a CharBuild file to import it'))}</b></div>`;
        document.body.appendChild(overlay);
      }
    });
    document.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth -= 1;
      if (depth <= 0) hide();
    });
    document.addEventListener('dragover', (e) => {
      if (hasFiles(e) && overlay) e.preventDefault();
    });
    document.addEventListener('drop', (e) => {
      if (!overlay) return;
      e.preventDefault();
      hide();
      const file = [...(e.dataTransfer.files || [])].find((f) => /\.json$/i.test(f.name) || f.type === 'application/json');
      if (!file) return toast(t('Drop a .json file exported from CharBuild.'), 'error');
      importFile(file).catch((err) => toast(t('Import failed: {error}', { error: err.message }), 'error'));
    });
  }

  return { openExport, exportCharacter, pickAndImport, importFile, openBackups, undo, enableDrop };
}
