/* ListoAPP — admin
 *
 * Sezioni:
 *   1. IDB & toast (compatti, auto-contenuti)
 *   2. Config: load/save con verifica round-trip, PAT mascherato
 *   3. GitHub Contents API: get/put contenuti, encoding base64
 *   4. Promo CRUD
 *   5. Publish flow con backup pre-pubblicazione
 *   6. Bump version.json opzionale
 *   7. Bootstrap UI
 */
(function () {
  'use strict';

  // ────────────────────────────────────────────────
  // 1. IDB & toast
  // ────────────────────────────────────────────────
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function uid(prefix) {
    return (prefix || 'id_') + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function todayISO() { return new Date().toISOString().slice(0, 10); }

  const DB_NAME = 'listoapp_db';
  const STORE = 'files';
  let _db = null;
  function openDB() {
    if (_db) return _db;
    _db = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _db;
  }
  async function idbGet(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function idbSet(key, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbDel(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function showToast(message, kind, opts) {
    opts = opts || {};
    const wrap = $('#toasts');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    const msg = document.createElement('span'); msg.className = 'msg'; msg.textContent = message;
    el.appendChild(msg);
    const close = document.createElement('button');
    close.type = 'button'; close.textContent = '✕'; close.setAttribute('aria-label', 'Chiudi');
    close.addEventListener('click', () => { if (el.parentNode) el.parentNode.removeChild(el); });
    el.appendChild(close);
    wrap.appendChild(el);
    if (!opts.sticky) setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, opts.ttl || 4000);
  }

  function setStatus(id, text, ok) {
    const el = $('#' + id);
    if (!el) return;
    el.textContent = text;
    el.classList.remove('ok', 'ko');
    if (ok === true) el.classList.add('ok');
    else if (ok === false) el.classList.add('ko');
  }

  // ────────────────────────────────────────────────
  // 2. CONFIG
  // ────────────────────────────────────────────────
  const KEY_CONFIG = 'admin_config';
  // PAT salvato separatamente: roundtrip-verified
  const KEY_PAT = 'admin_pat';

  const DEFAULT_CONFIG = {
    owner: 'pezzaliapp',
    repo: 'ListoAPP',
    branch: 'main',
    promoPath: 'promo/promo.json',
    versionPath: 'version.json'
  };

  let config = Object.assign({}, DEFAULT_CONFIG);
  let hasSavedToken = false;

  async function loadConfig() {
    try {
      const c = await idbGet(KEY_CONFIG);
      if (c && typeof c === 'object') config = Object.assign({}, DEFAULT_CONFIG, c);
    } catch (_) {}
    try {
      const t = await idbGet(KEY_PAT);
      hasSavedToken = !!(t && typeof t === 'string' && t.length > 0);
    } catch (_) { hasSavedToken = false; }
  }

  async function saveConfig(formValues, newToken) {
    const merged = Object.assign({}, DEFAULT_CONFIG, formValues);
    await idbSet(KEY_CONFIG, merged);
    // verify round-trip
    const re = await idbGet(KEY_CONFIG);
    if (!re || re.owner !== merged.owner || re.repo !== merged.repo || re.branch !== merged.branch || re.promoPath !== merged.promoPath) {
      throw new Error('Verifica round-trip configurazione fallita');
    }
    config = re;
    if (typeof newToken === 'string' && newToken.length > 0) {
      await idbSet(KEY_PAT, newToken);
      const tre = await idbGet(KEY_PAT);
      if (tre !== newToken) throw new Error('Verifica round-trip PAT fallita');
      hasSavedToken = true;
    }
    return true;
  }

  async function getToken() {
    try {
      const t = await idbGet(KEY_PAT);
      return (typeof t === 'string' && t.length > 0) ? t : null;
    } catch (_) { return null; }
  }

  async function clearToken() {
    await idbDel(KEY_PAT);
    hasSavedToken = false;
  }

  // ────────────────────────────────────────────────
  // 3. GITHUB API
  // ────────────────────────────────────────────────
  const GH_BASE = 'https://api.github.com';

  async function ghHeaders() {
    const token = await getToken();
    const h = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  }

  async function ghGetContents(path) {
    const url = GH_BASE + '/repos/' + encodeURIComponent(config.owner) + '/' + encodeURIComponent(config.repo)
      + '/contents/' + encodeGHPath(path) + '?ref=' + encodeURIComponent(config.branch);
    const res = await fetch(url, { headers: await ghHeaders(), cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('GitHub GET ' + res.status + ' ' + (await res.text()).slice(0, 200));
    return res.json();
  }

  async function ghPutContents(path, contentB64, message, sha) {
    const url = GH_BASE + '/repos/' + encodeURIComponent(config.owner) + '/' + encodeURIComponent(config.repo)
      + '/contents/' + encodeGHPath(path);
    const body = {
      message: message || ('chore: update ' + path),
      content: contentB64,
      branch: config.branch
    };
    if (sha) body.sha = sha;
    const res = await fetch(url, {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, await ghHeaders()),
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('GitHub PUT ' + res.status + ' ' + (await res.text()).slice(0, 300));
    return res.json();
  }

  function encodeGHPath(p) {
    return p.split('/').map(encodeURIComponent).join('/');
  }

  function utf8ToBase64(str) {
    // gestisce caratteri UTF-8
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function base64ToUtf8(b64) {
    const bin = atob(b64.replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }
  function bufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  async function testConnection() {
    setStatus('test-status', 'Verifica…', null);
    try {
      const data = await ghGetContents(config.promoPath);
      if (data === null) {
        setStatus('test-status', 'Repo OK, ' + config.promoPath + ' non ancora presente (verrà creato alla prima publish).', true);
        return;
      }
      setStatus('test-status', 'OK — ' + config.promoPath + ' (sha ' + (data.sha || '').slice(0, 7) + ', ' + (data.size || 0) + ' bytes).', true);
    } catch (err) {
      setStatus('test-status', 'KO: ' + (err.message || err), false);
    }
  }

  // ────────────────────────────────────────────────
  // 4. PROMO CRUD
  // ────────────────────────────────────────────────
  let promoList = [];
  let promoSha = null;

  function emptyPromo() {
    return {
      id: uid('p_'),
      title: '',
      description: '',
      url: '',
      type: 'pdf',
      fileName: '',
      fileMime: '',
      fileSize: 0,
      startsAt: todayISO(),
      expiresAt: '',
      active: true,
      createdAt: new Date().toISOString()
    };
  }

  async function loadPromoFromGitHub() {
    setStatus('load-status', 'Scaricamento…', null);
    try {
      const data = await ghGetContents(config.promoPath);
      if (data === null) {
        promoList = [];
        promoSha = null;
        setStatus('load-status', 'File non presente: lista vuota.', true);
      } else {
        const text = base64ToUtf8(data.content || '');
        const json = text.trim() ? JSON.parse(text) : [];
        promoList = Array.isArray(json) ? json : [];
        promoSha = data.sha || null;
        setStatus('load-status', 'Caricate ' + promoList.length + ' promo (sha ' + (promoSha || '').slice(0, 7) + ').', true);
      }
      renderPromoList();
    } catch (err) {
      setStatus('load-status', 'KO: ' + (err.message || err), false);
    }
  }

  function renderPromoList() {
    const wrap = $('#promo-edit-list');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!promoList.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Nessuna promo. "Aggiungi" per crearne una.';
      wrap.appendChild(empty);
      return;
    }
    promoList.forEach((p, idx) => {
      wrap.appendChild(buildPromoEditor(p, idx));
    });
  }

  function buildPromoEditor(p, idx) {
    const card = document.createElement('div');
    card.className = 'promo-edit';
    card.dataset.idx = String(idx);
    const grid = document.createElement('div');
    grid.className = 'admin-form';

    const mk = (label, key, type, full) => {
      const w = document.createElement('div');
      if (full) w.className = 'full';
      const l = document.createElement('label'); l.textContent = label;
      let inp;
      if (type === 'textarea') {
        inp = document.createElement('textarea');
        inp.rows = 3;
      } else if (type === 'select') {
        inp = document.createElement('select');
        ['pdf', 'image', 'link'].forEach((opt) => {
          const o = document.createElement('option'); o.value = opt; o.textContent = opt; inp.appendChild(o);
        });
      } else if (type === 'checkbox') {
        inp = document.createElement('input'); inp.type = 'checkbox';
      } else {
        inp = document.createElement('input'); inp.type = type;
      }
      inp.dataset.key = key;
      const v = p[key];
      if (type === 'checkbox') inp.checked = v !== false;
      else if (v !== undefined && v !== null) inp.value = String(v);
      inp.addEventListener('change', () => {
        const prev = p[key];
        if (type === 'checkbox') p[key] = inp.checked;
        else if (type === 'number') p[key] = Number(inp.value) || 0;
        else p[key] = inp.value;
        // Validazione cross-field: expiresAt non può precedere startsAt.
        // Confronto lessicografico OK su stringhe YYYY-MM-DD. Vuoti = no check.
        if ((key === 'startsAt' || key === 'expiresAt') && p.startsAt && p.expiresAt && p.expiresAt < p.startsAt) {
          alert('Data di scadenza (' + p.expiresAt + ') precedente alla data di inizio (' + p.startsAt + '). Modifica annullata.');
          p[key] = prev;
          inp.value = prev == null ? '' : String(prev);
        }
      });
      w.appendChild(l); w.appendChild(inp);
      return w;
    };

    grid.appendChild(mk('Titolo', 'title', 'text', true));
    grid.appendChild(mk('Descrizione', 'description', 'textarea', true));
    grid.appendChild(mk('Tipo', 'type', 'select'));
    grid.appendChild(mk('URL/path allegato', 'url', 'text'));
    grid.appendChild(mk('Inizio', 'startsAt', 'date'));
    grid.appendChild(mk('Scadenza', 'expiresAt', 'date'));
    grid.appendChild(mk('Nome file', 'fileName', 'text'));
    grid.appendChild(mk('Mime', 'fileMime', 'text'));
    grid.appendChild(mk('Dimensione (bytes)', 'fileSize', 'number'));
    grid.appendChild(mk('ID', 'id', 'text'));
    const actW = document.createElement('div'); actW.className = 'full';
    const actLbl = document.createElement('label'); actLbl.textContent = 'Stato';
    const actInp = document.createElement('input'); actInp.type = 'checkbox'; actInp.dataset.key = 'active';
    actInp.checked = p.active !== false;
    actInp.addEventListener('change', () => { p.active = actInp.checked; });
    const wlabel = document.createElement('span'); wlabel.style.marginLeft = '8px'; wlabel.textContent = 'Attiva';
    actW.appendChild(actLbl);
    const inline = document.createElement('div');
    inline.style.display = 'flex'; inline.style.alignItems = 'center';
    inline.appendChild(actInp); inline.appendChild(wlabel);
    actW.appendChild(inline);
    grid.appendChild(actW);

    card.appendChild(grid);

    const actions = document.createElement('div');
    actions.className = 'actions';

    // upload allegato
    const upWrap = document.createElement('div');
    upWrap.style.display = 'flex'; upWrap.style.gap = '6px'; upWrap.style.alignItems = 'center';
    const upBtn = document.createElement('button');
    upBtn.type = 'button'; upBtn.textContent = '📎 Carica allegato su GitHub';
    const upInp = document.createElement('input');
    upInp.type = 'file'; upInp.style.display = 'none';
    upBtn.addEventListener('click', () => upInp.click());
    upInp.addEventListener('change', async () => {
      const f = upInp.files && upInp.files[0];
      if (!f) return;
      try {
        const buf = await f.arrayBuffer();
        const b64 = bufferToBase64(buf);
        const remotePath = 'promo/' + sanitizeFilename(f.name);
        upBtn.disabled = true; upBtn.textContent = 'Caricamento…';
        // se esiste, prendi sha per overwrite
        let sha = null;
        try {
          const existing = await ghGetContents(remotePath);
          if (existing && existing.sha) sha = existing.sha;
        } catch (_) {}
        await ghPutContents(remotePath, b64, 'feat(promo): upload ' + remotePath, sha);
        p.url = remotePath;
        p.fileName = f.name;
        p.fileMime = f.type || '';
        p.fileSize = f.size;
        p.type = (f.type || '').startsWith('image/') ? 'image' : (f.type === 'application/pdf' ? 'pdf' : 'link');
        renderPromoList(); // re-render per riflettere i campi aggiornati
        showToast('Allegato caricato: ' + remotePath, 'success');
      } catch (err) {
        showToast('Upload allegato fallito: ' + (err.message || err), 'error', { ttl: 6000 });
      } finally {
        upBtn.disabled = false; upBtn.textContent = '📎 Carica allegato su GitHub';
        upInp.value = '';
      }
    });
    upWrap.appendChild(upBtn);
    upWrap.appendChild(upInp);

    const dup = document.createElement('button');
    dup.type = 'button'; dup.textContent = 'Duplica';
    dup.addEventListener('click', () => {
      const copy = JSON.parse(JSON.stringify(p));
      copy.id = uid('p_');
      copy.createdAt = new Date().toISOString();
      promoList.splice(idx + 1, 0, copy);
      renderPromoList();
    });
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'danger'; del.textContent = 'Elimina';
    del.addEventListener('click', () => {
      promoList.splice(idx, 1);
      renderPromoList();
    });

    actions.appendChild(upWrap);
    actions.appendChild(dup);
    actions.appendChild(del);
    card.appendChild(actions);
    return card;
  }

  function sanitizeFilename(name) {
    return String(name || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
  }

  // ────────────────────────────────────────────────
  // 5. PUBLISH
  // ────────────────────────────────────────────────
  async function publishPromo() {
    if (!await getToken()) {
      showToast('Salva prima un PAT GitHub valido.', 'error');
      return;
    }
    setStatus('publish-status', 'Pubblicazione…', null);
    try {
      // backup
      const backupKey = 'backup_' + new Date().toISOString().replace(/[:.]/g, '-');
      await idbSet(backupKey, { ts: Date.now(), list: promoList, sha: promoSha });
      // serialize
      const text = JSON.stringify(promoList, null, 2) + '\n';
      const b64 = utf8ToBase64(text);
      // se promoSha non è noto, prova a riprenderlo (per evitare 409 conflict)
      if (!promoSha) {
        try {
          const existing = await ghGetContents(config.promoPath);
          if (existing && existing.sha) promoSha = existing.sha;
        } catch (_) {}
      }
      // safety: confirm bloccante se stiamo pubblicando MENO promo di quelle già su GitHub.
      // Best-effort: errori di rete o JSON malformato non bloccano la publish.
      try {
        const remote = await ghGetContents(config.promoPath);
        if (remote && remote.content) {
          const remoteJson = JSON.parse(base64ToUtf8(remote.content));
          if (Array.isArray(remoteJson) && promoList.length < remoteJson.length) {
            const ok = confirm('ATTENZIONE: stai per pubblicare ' + promoList.length + ' promo, ma su GitHub ce ne sono ' + remoteJson.length + '. Continuare e sovrascrivere?');
            if (!ok) {
              setStatus('publish-status', 'Annullato dall\'utente.', null);
              return;
            }
          }
        }
      } catch (_) { /* check best-effort */ }
      const res = await ghPutContents(config.promoPath, b64, 'chore(promo): update ' + config.promoPath + ' (' + promoList.length + ')', promoSha);
      promoSha = (res && res.content && res.content.sha) || null;
      setStatus('publish-status', 'Pubblicato (' + promoList.length + ' promo).', true);
      showToast('Promo pubblicate. Backup: ' + backupKey, 'success');
      // bump version.json se richiesto
      const bump = $('#publish-bump');
      if (bump && bump.checked) {
        await bumpVersionJson();
      }
    } catch (err) {
      setStatus('publish-status', 'KO: ' + (err.message || err), false);
    }
  }

  // ────────────────────────────────────────────────
  // 6. VERSION BUMP
  // ────────────────────────────────────────────────
  async function bumpVersionJson() {
    try {
      let sha = null;
      const existing = await ghGetContents(config.versionPath);
      if (existing && existing.sha) sha = existing.sha;
      const body = {
        version: new Date().toISOString(),
        commit: 'admin-' + Math.random().toString(36).slice(2, 10)
      };
      const text = JSON.stringify(body, null, 2) + '\n';
      const b64 = utf8ToBase64(text);
      await ghPutContents(config.versionPath, b64, 'chore(app): bump version after promo publish', sha);
      showToast('version.json aggiornato (' + body.version + ').', 'success');
    } catch (err) {
      showToast('Bump version fallito: ' + (err.message || err), 'error');
    }
  }

  // ────────────────────────────────────────────────
  // 7. BOOTSTRAP UI
  // ────────────────────────────────────────────────
  function fillForm() {
    const set = (id, v) => { const el = $('#' + id); if (el) el.value = v == null ? '' : String(v); };
    set('cfg-owner', config.owner);
    set('cfg-repo', config.repo);
    set('cfg-branch', config.branch);
    set('cfg-promo-path', config.promoPath);
    set('cfg-version-path', config.versionPath);
    const tokenInput = $('#cfg-token');
    if (tokenInput) {
      tokenInput.value = '';
      tokenInput.placeholder = hasSavedToken ? '(token salvato — lascia vuoto per mantenerlo)' : 'ghp_… (Personal Access Token)';
    }
    setStatus('save-status', hasSavedToken ? 'Configurazione caricata, token presente.' : 'Configurazione caricata, nessun token.', hasSavedToken);
  }

  function bindForm() {
    const saveBtn = $('#cfg-save');
    if (saveBtn) saveBtn.addEventListener('click', async () => {
      try {
        const values = {
          owner: ($('#cfg-owner').value || '').trim(),
          repo: ($('#cfg-repo').value || '').trim(),
          branch: ($('#cfg-branch').value || 'main').trim(),
          promoPath: ($('#cfg-promo-path').value || 'promo/promo.json').trim(),
          versionPath: ($('#cfg-version-path').value || 'version.json').trim()
        };
        const tokenRaw = ($('#cfg-token').value || '').trim();
        await saveConfig(values, tokenRaw);
        fillForm();
        setStatus('save-status', 'Salvato e verificato (round-trip OK).', true);
        showToast('Configurazione salvata.', 'success');
      } catch (err) {
        setStatus('save-status', 'Errore: ' + (err.message || err), false);
        showToast('Salvataggio fallito.', 'error');
      }
    });

    const clearBtn = $('#cfg-clear-token');
    if (clearBtn) clearBtn.addEventListener('click', async () => {
      await clearToken();
      fillForm();
      showToast('Token eliminato dal dispositivo.', 'success');
    });

    const testBtn = $('#cfg-test');
    if (testBtn) testBtn.addEventListener('click', testConnection);

    const loadBtn = $('#promo-load');
    if (loadBtn) loadBtn.addEventListener('click', loadPromoFromGitHub);

    const addBtn = $('#promo-add');
    if (addBtn) addBtn.addEventListener('click', () => {
      promoList.unshift(emptyPromo());
      renderPromoList();
    });

    const pubBtn = $('#promo-publish');
    if (pubBtn) pubBtn.addEventListener('click', publishPromo);

    const bumpBtn = $('#version-bump-now');
    if (bumpBtn) bumpBtn.addEventListener('click', bumpVersionJson);

    const exportBtn = $('#promo-export');
    if (exportBtn) exportBtn.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(promoList, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'promo-export-' + todayISO() + '.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    });

    const importBtn = $('#promo-import');
    const importInp = $('#promo-import-file');
    if (importBtn && importInp) {
      importBtn.addEventListener('click', () => importInp.click());
      importInp.addEventListener('change', async () => {
        const f = importInp.files && importInp.files[0];
        if (!f) return;
        try {
          const text = await f.text();
          const arr = JSON.parse(text);
          if (!Array.isArray(arr)) throw new Error('Non è un array JSON');
          promoList = arr;
          renderPromoList();
          showToast('Importate ' + arr.length + ' promo (in memoria, non ancora pubblicate).', 'success');
        } catch (err) {
          showToast('Import fallito: ' + (err.message || err), 'error');
        }
        importInp.value = '';
      });
    }
  }

  async function init() {
    await loadConfig();
    fillForm();
    bindForm();
    renderPromoList();
    if (hasSavedToken) await loadPromoFromGitHub();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
