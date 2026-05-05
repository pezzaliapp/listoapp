/* ListoAPP — user-facing app
 *
 * Tutto in un unico modulo IIFE per evitare build step. Sezioni:
 *   1. Costanti & vendor loader (CDN con SRI)
 *   2. Utility (escape, currency, date, debounce)
 *   3. IndexedDB layer
 *   4. Toast & banner UI
 *   5. Service worker registration + version polling
 *   6. Listino: parsing xlsx/csv, viewer pdf, persistenza IDB
 *   7. Preventivo: stato, render, focus-stable qty, export
 *   8. Promo: polling con ETag, fallback raw, fusione locale + remoto
 *   9. Modal viewer (pdf/img)
 *  10. Bootstrap
 */
(function () {
  'use strict';

  // ────────────────────────────────────────────────
  // 1. VENDORS & SRI
  // ────────────────────────────────────────────────
  // Gli hash SRI vanno verificati con ./verify-vendors.sh prima del deploy.
  // Se l'integrity fallisce il browser blocca lo script e mostriamo un toast.
  // Hash SRI sono PLACEHOLDER finché non si esegue ./verify-vendors.sh che li compila.
  // Se l'integrity contiene "PLACEHOLDER" il loader la salta (script senza integrity).
  // In produzione: eseguire verify-vendors.sh, committare gli hash reali, redeploy.
  const VENDORS = {
    xlsx: {
      url: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
      integrity: 'sha512-r22gChDnGvBylk90+2e/ycr3RVrDi8DIOkIGNhJlKfuyQM4tIRAI062MaV8sfjQKYVGjOBaZBOA87z+IhZE9DA==',
      check: () => typeof window.XLSX !== 'undefined'
    },
    jspdf: {
      url: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
      integrity: 'sha512-qZvrmS2ekKPF2mSznTQsxqPgnpkI4DNTlrdUmTzrDgektczlKNRRhy5X5AAOnx5S09ydFYWWNSfcEqDTTHgtNA==',
      check: () => !!(window.jspdf && window.jspdf.jsPDF)
    }
  };

  const VENDOR_PROMISES = {};
  function loadVendor(name) {
    const v = VENDORS[name];
    if (!v) return Promise.reject(new Error('Vendor sconosciuto: ' + name));
    if (v.check()) return Promise.resolve();
    if (VENDOR_PROMISES[name]) return VENDOR_PROMISES[name];
    VENDOR_PROMISES[name] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = v.url;
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.referrerPolicy = 'no-referrer';
      // integrity disabilitato in dev se hash placeholder; in produzione verify-vendors.sh aggiorna.
      if (v.integrity && !v.integrity.includes('PLACEHOLDER')) s.integrity = v.integrity;
      s.onload = () => v.check() ? resolve() : reject(new Error(name + ' caricato ma simbolo assente'));
      s.onerror = () => { delete VENDOR_PROMISES[name]; reject(new Error('Caricamento ' + name + ' fallito (rete o SRI)')); };
      document.head.appendChild(s);
    });
    return VENDOR_PROMISES[name];
  }

  // ────────────────────────────────────────────────
  // 2. UTILITY
  // ────────────────────────────────────────────────
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  const fmtCurrency = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
  const fmtNumber = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 2 });
  function formatCurrency(n) {
    if (typeof n !== 'number' || !isFinite(n)) return fmtCurrency.format(0);
    return fmtCurrency.format(n);
  }

  function todayISO() {
    // Data LOCALE dell'utente in YYYY-MM-DD. Niente toISOString() qui:
    // restituirebbe la data UTC e in fusi >0 nelle prime ore della notte
    // l'utente vede ancora "ieri", filtrando fuori promo con startsAt=oggi.
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }
  function isWithinRange(today, startsAt, expiresAt) {
    // Normalizza a YYYY-MM-DD puro: tollera ISO completi ("2026-05-05T22:00:00Z"),
    // stringhe vuote, null, undefined. Confronto same-day inclusivo a entrambi
    // gli estremi (la promo è attiva anche il giorno startsAt e il giorno expiresAt).
    const norm = (s) => {
      if (!s) return '';
      const str = String(s).trim();
      return str ? str.slice(0, 10) : '';
    };
    const t = norm(today);
    const s = norm(startsAt);
    const e = norm(expiresAt);
    if (s && t < s) return false;
    if (e && t > e) return false;
    return true;
  }
  function debounce(fn, ms) {
    let t = null;
    return function debounced() {
      const args = arguments;
      const ctx = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(ctx, args), ms);
    };
  }
  function uid(prefix) {
    return (prefix || 'id_') + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  // Estrae tutti i numeri di pagina da una stringa tipo "61, 67" o "10".
  // Ritorna un array di stringhe (es: ["61","67"]). Vuoto se nessun numero.
  function pageTokens(v) {
    return String(v == null ? '' : v).match(/\d+/g) || [];
  }

  // Cerca la colonna "pagina" in una riga grezza dell'Excel con sinonimi flessibili.
  // Match case-insensitive sui nomi delle colonne, restituisce il valore raw.
  const PAGE_COLUMN_NEEDLES = ['pagine', 'pagina', 'pag', 'pdf', 'page'];
  function rawPageValue(row) {
    if (!row || typeof row !== 'object') return '';
    const keys = Object.keys(row);
    for (const needle of PAGE_COLUMN_NEEDLES) {
      const k = keys.find((c) => String(c).toLowerCase().trim() === needle);
      if (k && row[k] != null && row[k] !== '') return row[k];
    }
    // fallback: contains-match (es. "Pagine PDF")
    for (const k of keys) {
      const lc = String(k).toLowerCase();
      if (PAGE_COLUMN_NEEDLES.some((n) => lc.includes(n))) {
        if (row[k] != null && row[k] !== '') return row[k];
      }
    }
    return '';
  }
  function pageTokensOfRow(row) { return pageTokens(rawPageValue(row)); }

  // ────────────────────────────────────────────────
  // 3. INDEXEDDB
  // ────────────────────────────────────────────────
  const DB_NAME = 'listoapp_db';
  const DB_VERSION = 1;
  const STORE = 'files';
  let _dbPromise = null;
  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB non disponibile')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IDB open error'));
    });
    return _dbPromise;
  }
  async function idbGet(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbSet(key, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
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
  async function idbKeys() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  // Storage persistente best-effort
  async function requestPersistence() {
    try {
      if (navigator.storage && typeof navigator.storage.persist === 'function') {
        await navigator.storage.persist();
      }
    } catch (_) { /* Safari iOS standalone fallisce silenziosamente, è ok */ }
  }

  // ────────────────────────────────────────────────
  // 4. TOAST & BANNER
  // ────────────────────────────────────────────────
  function showToast(message, kind, opts) {
    opts = opts || {};
    const wrap = $('#toasts');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    const msg = document.createElement('span');
    msg.className = 'msg';
    msg.textContent = message;
    el.appendChild(msg);
    let dismissTimer = null;
    if (opts.action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = opts.action.label;
      btn.addEventListener('click', () => {
        if (dismissTimer) clearTimeout(dismissTimer);
        try { opts.action.handler(); } catch (e) { console.error(e); }
        if (el.parentNode) el.parentNode.removeChild(el);
      });
      el.appendChild(btn);
    }
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Chiudi');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => { if (el.parentNode) el.parentNode.removeChild(el); });
    el.appendChild(closeBtn);
    wrap.appendChild(el);
    const ttl = opts.sticky ? 0 : (opts.ttl || 4000);
    if (ttl > 0) dismissTimer = setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, ttl);
    return el;
  }

  function showUpdateBanner(message, onReload) {
    const banner = $('#update-banner');
    if (!banner) return;
    banner.textContent = '';
    const span = document.createElement('span');
    span.textContent = message;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary';
    btn.textContent = 'Ricarica';
    btn.addEventListener('click', () => { try { onReload(); } catch (_) { location.reload(); } });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ghost';
    close.setAttribute('aria-label', 'Nascondi');
    close.textContent = '✕';
    close.addEventListener('click', () => banner.classList.add('hidden'));
    banner.appendChild(span);
    banner.appendChild(btn);
    banner.appendChild(close);
    banner.classList.remove('hidden');
  }

  // ────────────────────────────────────────────────
  // 5. SERVICE WORKER & VERSION POLLING
  // ────────────────────────────────────────────────
  let _swControllerWasNull = false;
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol === 'file:') return; // SW non registrabile da file://
    _swControllerWasNull = !navigator.serviceWorker.controller;
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('SW registrazione fallita:', err);
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (_swControllerWasNull) { _swControllerWasNull = false; return; }
      showUpdateBanner('Nuova versione disponibile.', () => location.reload());
    });
  }

  let _versionPollEtag = null;
  let _versionLastValue = null;
  let _versionInFlight = null;
  async function pollVersion() {
    if (location.protocol === 'file:') return;
    if (document.visibilityState !== 'visible') return;
    if (_versionInFlight) return;
    _versionInFlight = (async () => {
      try {
        const headers = {};
        if (_versionPollEtag) headers['If-None-Match'] = _versionPollEtag;
        const res = await fetch('./version.json', { cache: 'no-store', headers });
        if (res.status === 304) return;
        if (!res.ok) return;
        _versionPollEtag = res.headers.get('ETag') || _versionPollEtag;
        const data = await res.json();
        const tag = (data && data.version) ? String(data.version) : null;
        if (!tag) return;
        if (_versionLastValue === null) { _versionLastValue = tag; return; }
        if (tag !== _versionLastValue) {
          _versionLastValue = tag;
          showUpdateBanner('Nuova versione disponibile (' + tag + ').', () => location.reload());
        }
      } catch (_) { /* offline = ignora */ } finally { _versionInFlight = null; }
    })();
    return _versionInFlight;
  }

  // ────────────────────────────────────────────────
  // 6. LISTINO
  // ────────────────────────────────────────────────
  const KEY_LISTINO_META = 'listino_meta';
  const KEY_LISTINO_BLOB = 'listino_blob';
  // PDF abbinato al listino tabellare (separato da KEY_LISTINO_BLOB che tiene il file
  // originale qualunque sia: xlsx/csv o pdf). Schema: {name, type, blob:ArrayBuffer, savedAt}.
  const KEY_LISTINO_PDF = 'listino_pdf';

  // Stato in memoria del listino corrente
  let listino = null; // {kind: 'tabular'|'pdf', fileName, columns:[], rows:[], mapping:{code,name,price}}

  // Filtri/paginazione del listino full
  let listinoFilter = { q: '', page: '' };
  let listinoPage = 1;
  const LISTINO_PAGE_SIZE = 50;

  async function loadListinoFromIDB() {
    const meta = await idbGet(KEY_LISTINO_META);
    if (!meta) { listino = null; return null; }
    listino = meta;
    return meta;
  }

  async function clearListino() {
    await idbDel(KEY_LISTINO_META);
    await idbDel(KEY_LISTINO_BLOB);
    listino = null;
    listinoPage = 1;
    listinoFilter = { q: '', page: '' };
    const search = $('#listino-search'); if (search) search.value = '';
    const pageSel = $('#pageFilter'); if (pageSel) pageSel.value = '';
    renderListino();
    renderPreventivoCatalog();
    showToast('Listino rimosso.', 'success');
  }

  function detectMapping(columns) {
    const lc = columns.map((c) => String(c || '').toLowerCase());
    const find = (needles) => {
      for (const n of needles) {
        const idx = lc.findIndex((c) => c.includes(n));
        if (idx >= 0) return columns[idx];
      }
      return null;
    };
    return {
      code: find(['codice', 'code', 'sku', 'art']) || columns[0] || null,
      name: find(['descrizione', 'description', 'prodotto', 'product', 'name', 'nome']) || columns[1] || null,
      price: find(['prezzo', 'price', 'listino', 'imp']) || columns[2] || null
    };
  }

  async function ingestTabularFile(file) {
    await loadVendor('xlsx');
    const buf = await file.arrayBuffer();
    const wb = window.XLSX.read(buf, { type: 'array' });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) throw new Error('Foglio vuoto');
    const sheet = wb.Sheets[sheetName];
    const json = window.XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });
    if (!json.length) throw new Error('Nessuna riga trovata');
    const columns = Object.keys(json[0]);
    const meta = {
      kind: 'tabular',
      fileName: file.name,
      mime: file.type || '',
      size: file.size,
      uploadedAt: new Date().toISOString(),
      columns: columns,
      mapping: detectMapping(columns),
      rows: json
    };
    await idbSet(KEY_LISTINO_META, meta);
    await idbSet(KEY_LISTINO_BLOB, { name: file.name, type: file.type, blob: buf });
    listino = meta;
    showToast('Listino caricato: ' + file.name + ' (' + json.length + ' righe).', 'success');
    renderListino();
    renderPreventivoCatalog();
  }

  async function ingestPdfFile(file) {
    const buf = await file.arrayBuffer();
    const meta = {
      kind: 'pdf',
      fileName: file.name,
      mime: file.type || 'application/pdf',
      size: file.size,
      uploadedAt: new Date().toISOString(),
      columns: [],
      mapping: null,
      rows: []
    };
    await idbSet(KEY_LISTINO_META, meta);
    await idbSet(KEY_LISTINO_BLOB, { name: file.name, type: file.type || 'application/pdf', blob: buf });
    listino = meta;
    showToast('Listino PDF caricato: ' + file.name + '.', 'success');
    renderListino();
    renderPreventivoCatalog();
  }

  async function handleListinoFile(file) {
    const name = (file.name || '').toLowerCase();
    try {
      if (name.endsWith('.pdf') || file.type === 'application/pdf') {
        await ingestPdfFile(file);
      } else if (name.endsWith('.csv') || name.endsWith('.tsv') || name.endsWith('.xls') || name.endsWith('.xlsx') || /sheet|excel|csv/.test(file.type || '')) {
        await ingestTabularFile(file);
      } else {
        // tenta tabular come default
        await ingestTabularFile(file);
      }
      await requestPersistence();
    } catch (err) {
      console.error(err);
      showToast('Errore caricando il listino: ' + (err.message || err), 'error', { ttl: 6000 });
    }
  }

  function priceOf(row, mapping) {
    if (!mapping || !mapping.price) return 0;
    const raw = row[mapping.price];
    if (typeof raw === 'number') return raw;
    if (raw === null || raw === undefined) return 0;
    const cleaned = String(raw).replace(/[^\d,.\-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
    const n = parseFloat(cleaned);
    return isFinite(n) ? n : 0;
  }
  function codeOf(row, mapping) { return mapping && mapping.code ? String(row[mapping.code] || '') : ''; }
  function nameOf(row, mapping) { return mapping && mapping.name ? String(row[mapping.name] || '') : ''; }

  function renderListino() {
    const empty = $('#listino-empty');
    const filled = $('#listino-filled');
    const meta = listino;
    if (!meta) {
      if (empty) empty.style.display = '';
      if (filled) filled.style.display = 'none';
      return;
    }
    if (empty) empty.style.display = 'none';
    if (filled) filled.style.display = '';
    const info = $('#listino-info');
    if (info) {
      info.textContent = '';
      const dt = new Date(meta.uploadedAt);
      const lines = [
        meta.fileName,
        meta.kind === 'pdf' ? 'PDF (visualizzatore)' : (meta.rows.length + ' righe · ' + meta.columns.length + ' colonne'),
        'Caricato: ' + dt.toLocaleString('it-IT')
      ];
      lines.forEach((t) => {
        const p = document.createElement('p');
        p.textContent = t;
        p.className = 'muted';
        info.appendChild(p);
      });
    }
    const mapWrap = $('#listino-mapping');
    if (mapWrap) {
      mapWrap.innerHTML = '';
      if (meta.kind === 'tabular') {
        const fields = [
          ['code', 'Colonna codice'],
          ['name', 'Colonna descrizione'],
          ['price', 'Colonna prezzo']
        ];
        fields.forEach(([key, label]) => {
          const wrap = document.createElement('div');
          const lbl = document.createElement('label');
          lbl.textContent = label;
          const sel = document.createElement('select');
          sel.dataset.field = key;
          const optEmpty = document.createElement('option');
          optEmpty.value = '';
          optEmpty.textContent = '— nessuna —';
          sel.appendChild(optEmpty);
          meta.columns.forEach((c) => {
            const opt = document.createElement('option');
            opt.value = c;
            opt.textContent = c;
            if (meta.mapping && meta.mapping[key] === c) opt.selected = true;
            sel.appendChild(opt);
          });
          sel.addEventListener('change', async () => {
            meta.mapping = meta.mapping || {};
            meta.mapping[key] = sel.value || null;
            await idbSet(KEY_LISTINO_META, meta);
            renderListinoFull();
            renderPreventivoCatalog();
          });
          wrap.appendChild(lbl);
          wrap.appendChild(sel);
          mapWrap.appendChild(wrap);
        });
      }
    }
    populatePageFilter();
    renderListinoFull();
  }

  // Filtra le righe correnti del listino in base a search + page filter.
  function filteredListinoRows() {
    if (!listino || listino.kind !== 'tabular') return [];
    const q = (listinoFilter.q || '').trim().toLowerCase();
    const pageFilter = listinoFilter.page || '';
    return listino.rows.filter((r) => {
      if (q) {
        const code = codeOf(r, listino.mapping).toLowerCase();
        const name = nameOf(r, listino.mapping).toLowerCase();
        if (!code.includes(q) && !name.includes(q)) return false;
      }
      if (pageFilter && !pageTokensOfRow(r).includes(pageFilter)) return false;
      return true;
    });
  }

  // Popola il <select id="pageFilter"> con l'unione ordinata dei numeri di pagina.
  function populatePageFilter() {
    const sel = $('#pageFilter');
    if (!sel) return;
    const previousValue = sel.value;
    const opts = ['<option value="">Tutte le pagine</option>'];
    if (listino && listino.kind === 'tabular') {
      const set = new Set();
      for (const r of listino.rows) for (const p of pageTokensOfRow(r)) set.add(p);
      const sorted = Array.from(set).sort((a, b) => Number(a) - Number(b));
      for (const p of sorted) opts.push('<option value="' + escapeHTML(p) + '">Pag. ' + escapeHTML(p) + '</option>');
    }
    sel.innerHTML = opts.join('');
    // ripristina la selezione se ancora valida
    if (previousValue && Array.from(sel.options).some((o) => o.value === previousValue)) {
      sel.value = previousValue;
    }
  }

  // Render della tabella full degli articoli con paginazione.
  function renderListinoFull() {
    const tbody = $('#listino-tbody');
    const count = $('#listino-count');
    const pagerInfo = $('#listino-pager-info');
    const wrap = $('#listino-tablewrap');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!listino || listino.kind !== 'tabular') {
      if (wrap) wrap.style.display = 'none';
      if (count) count.textContent = '';
      if (pagerInfo) pagerInfo.textContent = '—';
      return;
    }
    if (wrap) wrap.style.display = '';
    const filtered = filteredListinoRows();
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / LISTINO_PAGE_SIZE));
    if (listinoPage > totalPages) listinoPage = totalPages;
    if (listinoPage < 1) listinoPage = 1;
    const start = (listinoPage - 1) * LISTINO_PAGE_SIZE;
    const slice = filtered.slice(start, start + LISTINO_PAGE_SIZE);

    for (const r of slice) {
      const tr = document.createElement('tr');
      const tdCode = document.createElement('td'); tdCode.textContent = codeOf(r, listino.mapping); tr.appendChild(tdCode);
      const tdName = document.createElement('td'); tdName.textContent = nameOf(r, listino.mapping); tr.appendChild(tdName);
      const tdPrice = document.createElement('td'); tdPrice.className = 'num';
      tdPrice.textContent = formatCurrency(priceOf(r, listino.mapping));
      tr.appendChild(tdPrice);
      const tdPage = document.createElement('td');
      const tokens = pageTokensOfRow(r);
      for (const n of tokens) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pageBtn';
        btn.dataset.page = n;
        btn.textContent = 'Pag. ' + n;
        tdPage.appendChild(btn);
      }
      tr.appendChild(tdPage);
      tbody.appendChild(tr);
    }

    if (count) {
      const totRows = listino.rows.length;
      count.textContent = total === totRows
        ? totRows + ' articoli'
        : total + ' di ' + totRows + ' articoli';
    }
    if (pagerInfo) pagerInfo.textContent = 'Pagina ' + listinoPage + '/' + totalPages;
    const prev = $('#listino-prev'); if (prev) prev.disabled = (listinoPage <= 1);
    const next = $('#listino-next'); if (next) next.disabled = (listinoPage >= totalPages);
  }

  async function viewListinoPDF() {
    const blob = await idbGet(KEY_LISTINO_BLOB);
    if (!blob) { showToast('Nessun PDF in archivio.', 'error'); return; }
    const ab = blob.blob;
    const url = URL.createObjectURL(new Blob([ab], { type: blob.type || 'application/pdf' }));
    openModal(listino.fileName, (body) => {
      const iframe = document.createElement('iframe');
      iframe.src = url;
      iframe.title = 'Listino PDF';
      body.appendChild(iframe);
    }, () => URL.revokeObjectURL(url));
  }

  // ────────────────────────────────────────────────
  // 7. PREVENTIVO
  // ────────────────────────────────────────────────
  const QUOTE_KEY = 'listoapp_quote_v1';
  let quote = { items: [], globalDiscount: 0, customer: '', notes: '' };

  function loadQuote() {
    try {
      const raw = localStorage.getItem(QUOTE_KEY);
      if (raw) quote = Object.assign(quote, JSON.parse(raw));
    } catch (_) { /* ignora */ }
  }
  function saveQuote() {
    try { localStorage.setItem(QUOTE_KEY, JSON.stringify(quote)); } catch (_) {}
  }

  function rowSubtotal(item) {
    const gross = (Number(item.price) || 0) * (Number(item.qty) || 0);
    const disc = (Number(item.discount) || 0) / 100;
    return gross * (1 - disc);
  }
  function quoteTotals() {
    const sub = quote.items.reduce((a, i) => a + (Number(i.price) || 0) * (Number(i.qty) || 0), 0);
    const afterRow = quote.items.reduce((a, i) => a + rowSubtotal(i), 0);
    const rowDisc = sub - afterRow;
    const gd = (Number(quote.globalDiscount) || 0) / 100;
    const grand = afterRow * (1 - gd);
    return { sub: sub, rowDisc: rowDisc, afterRow: afterRow, globalDisc: afterRow - grand, grand: grand };
  }

  function updateTotalsUI() {
    const t = quoteTotals();
    const el = (id, v) => { const n = $('#' + id); if (n) n.textContent = formatCurrency(v); };
    el('total-sub', t.sub);
    el('total-rowdisc', t.rowDisc);
    el('total-globaldisc', t.globalDisc);
    el('total-grand', t.grand);
    const count = $('#total-count');
    if (count) count.textContent = String(quote.items.reduce((a, i) => a + (Number(i.qty) || 0), 0));
  }

  function quoteRowEl(item) {
    const tr = document.createElement('tr');
    tr.dataset.itemId = item.id;
    const tdCode = document.createElement('td'); tdCode.textContent = item.code || '';
    const tdName = document.createElement('td'); tdName.textContent = item.name || '';
    const tdPage = document.createElement('td');
    if (item.code && listino && listino.mapping && listino.mapping.code) {
      const row = listino.rows.find((r) => String(r[listino.mapping.code] || '') === item.code);
      if (row) for (const n of pageTokensOfRow(row)) {
        const pgBtn = document.createElement('button');
        pgBtn.type = 'button'; pgBtn.className = 'pageBtn';
        pgBtn.dataset.page = n; pgBtn.textContent = 'Pag. ' + n;
        tdPage.appendChild(pgBtn);
      }
    }
    const tdPrice = document.createElement('td'); tdPrice.className = 'num';
    const inpPrice = document.createElement('input');
    inpPrice.type = 'number'; inpPrice.step = '0.01'; inpPrice.min = '0';
    inpPrice.dataset.field = 'price';
    inpPrice.value = String(item.price);
    tdPrice.appendChild(inpPrice);
    const tdQty = document.createElement('td'); tdQty.className = 'num';
    const inpQty = document.createElement('input');
    inpQty.type = 'number'; inpQty.min = '0'; inpQty.step = '1'; inpQty.inputMode = 'numeric';
    inpQty.dataset.field = 'qty';
    inpQty.value = String(item.qty);
    tdQty.appendChild(inpQty);
    const tdDisc = document.createElement('td'); tdDisc.className = 'num';
    const inpDisc = document.createElement('input');
    inpDisc.type = 'number'; inpDisc.min = '0'; inpDisc.max = '100'; inpDisc.step = '0.5';
    inpDisc.dataset.field = 'discount';
    inpDisc.value = String(item.discount || 0);
    tdDisc.appendChild(inpDisc);
    const tdSub = document.createElement('td'); tdSub.className = 'num'; tdSub.dataset.cell = 'subtotal';
    tdSub.textContent = formatCurrency(rowSubtotal(item));
    const tdAct = document.createElement('td');
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'ghost'; btn.dataset.action = 'remove';
    btn.setAttribute('aria-label', 'Rimuovi');
    btn.textContent = '✕';
    tdAct.appendChild(btn);
    tr.append(tdCode, tdName, tdPage, tdPrice, tdQty, tdDisc, tdSub, tdAct);
    return tr;
  }

  function addQuoteItem(seed) {
    // Merge per codice: se l'articolo è già nel preventivo, incrementa qty
    // invece di aggiungere una riga duplicata. Aggiorna il <tr> esistente in-place.
    if (seed && seed.code) {
      const existing = quote.items.find((i) => i.code === seed.code);
      if (existing) {
        existing.qty = (Number(existing.qty) || 0) + (Number(seed.qty) || 1);
        const tr = document.querySelector('#quote-tbody tr[data-item-id="' + CSS.escape(existing.id) + '"]');
        if (tr) {
          const inpQty = tr.querySelector('input[data-field="qty"]');
          if (inpQty) inpQty.value = String(existing.qty);
          const cell = tr.querySelector('[data-cell="subtotal"]');
          if (cell) cell.textContent = formatCurrency(rowSubtotal(existing));
        }
        saveQuote();
        updateTotalsUI();
        return existing;
      }
    }
    const item = Object.assign({
      id: uid('it_'),
      code: '', name: '', price: 0, qty: 1, discount: 0
    }, seed || {});
    quote.items.push(item);
    saveQuote();
    const tbody = $('#quote-tbody');
    if (tbody) tbody.appendChild(quoteRowEl(item));
    updateTotalsUI();
    renderQuoteEmpty();
    return item;
  }
  function removeQuoteItem(id) {
    quote.items = quote.items.filter((i) => i.id !== id);
    saveQuote();
    const tr = document.querySelector('#quote-tbody tr[data-item-id="' + CSS.escape(id) + '"]');
    if (tr && tr.parentNode) tr.parentNode.removeChild(tr);
    updateTotalsUI();
    renderQuoteEmpty();
    renderPreventivoCatalog();
  }
  function renderQuoteEmpty() {
    const empty = $('#quote-empty');
    if (empty) empty.style.display = quote.items.length ? 'none' : '';
    const wrap = $('#quote-tablewrap');
    if (wrap) wrap.style.display = quote.items.length ? '' : 'none';
  }

  function renderQuote() {
    const tbody = $('#quote-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    quote.items.forEach((it) => tbody.appendChild(quoteRowEl(it)));
    renderQuoteEmpty();
    updateTotalsUI();
    const cust = $('#quote-customer'); if (cust) cust.value = quote.customer || '';
    const notes = $('#quote-notes'); if (notes) notes.value = quote.notes || '';
    const gd = $('#quote-global-discount'); if (gd) gd.value = String(quote.globalDiscount || 0);
  }

  function bindQuoteEvents() {
    const tbody = $('#quote-tbody');
    if (!tbody) return;
    // input: aggiorna stato + cella subtotale + totali (NON rebuild riga)
    tbody.addEventListener('input', (e) => {
      const tr = e.target.closest('tr[data-item-id]');
      if (!tr) return;
      const id = tr.dataset.itemId;
      const item = quote.items.find((i) => i.id === id);
      if (!item) return;
      const field = e.target.dataset.field;
      if (!field) return;
      const num = Number(e.target.value);
      item[field] = isFinite(num) ? num : 0;
      const cell = tr.querySelector('[data-cell="subtotal"]');
      if (cell) cell.textContent = formatCurrency(rowSubtotal(item));
      updateTotalsUI();
      if (field === 'qty' && item.code) {
        const cBtn = document.querySelector('#catalog-results button[data-code="' + CSS.escape(item.code) + '"]');
        if (cBtn) {
          if (item.qty >= 1) {
            cBtn.classList.add('is-added');
            cBtn.textContent = '✓ Aggiunto ×' + item.qty;
          } else {
            cBtn.classList.remove('is-added');
            cBtn.textContent = 'Aggiungi';
          }
        }
      }
    });
    // change: persisti
    tbody.addEventListener('change', () => saveQuote());
    // click rimuovi + apertura PDF dalla cella PAG.
    tbody.addEventListener('click', (e) => {
      const pgBtn = e.target.closest('[data-page]');
      if (pgBtn) { openPdfAtPage(Number(pgBtn.dataset.page)); return; }
      const btn = e.target.closest('button[data-action="remove"]');
      if (!btn) return;
      const tr = btn.closest('tr[data-item-id]');
      if (!tr) return;
      removeQuoteItem(tr.dataset.itemId);
    });

    const gd = $('#quote-global-discount');
    if (gd) {
      gd.addEventListener('input', () => {
        const n = Number(gd.value);
        quote.globalDiscount = isFinite(n) ? n : 0;
        updateTotalsUI();
      });
      gd.addEventListener('change', () => saveQuote());
    }
    const cust = $('#quote-customer');
    if (cust) cust.addEventListener('change', () => { quote.customer = cust.value; saveQuote(); });
    const notes = $('#quote-notes');
    if (notes) notes.addEventListener('change', () => { quote.notes = notes.value; saveQuote(); });

    const clearBtn = $('#quote-clear');
    if (clearBtn) clearBtn.addEventListener('click', () => {
      if (!quote.items.length && !quote.customer && !quote.notes) return;
      quote = { items: [], globalDiscount: 0, customer: '', notes: '' };
      saveQuote();
      renderQuote();
      showToast('Preventivo svuotato.', 'success');
    });

    const addManual = $('#quote-add-manual');
    if (addManual) addManual.addEventListener('click', () => addQuoteItem({ code: '', name: 'Voce manuale', price: 0, qty: 1 }));

    const expPdf = $('#quote-export-pdf');
    if (expPdf) expPdf.addEventListener('click', exportQuotePDF);
    const expTxt = $('#quote-export-text');
    if (expTxt) expTxt.addEventListener('click', exportQuoteText);
  }

  function renderPreventivoCatalog() {
    const wrap = $('#catalog-results');
    const search = $('#catalog-search');
    if (!wrap || !search) return;
    const q = (search.value || '').trim().toLowerCase();
    wrap.innerHTML = '';
    if (!listino || listino.kind !== 'tabular') {
      const div = document.createElement('div');
      div.className = 'empty';
      div.textContent = listino && listino.kind === 'pdf'
        ? 'Listino PDF: aggiungi voci manualmente al preventivo.'
        : 'Carica un listino tabellare per cercare gli articoli.';
      wrap.appendChild(div);
      return;
    }
    const rows = listino.rows;
    let matched = 0;
    const limit = 30;
    for (let i = 0; i < rows.length && matched < limit; i++) {
      const r = rows[i];
      const code = codeOf(r, listino.mapping);
      const name = nameOf(r, listino.mapping);
      if (q && !(code.toLowerCase().includes(q) || name.toLowerCase().includes(q))) continue;
      const price = priceOf(r, listino.mapping);
      const item = document.createElement('div');
      item.className = 'row-flex';
      item.style.padding = '8px 0';
      item.style.borderBottom = '1px solid var(--border)';
      const left = document.createElement('div');
      left.className = 'grow';
      const codeEl = document.createElement('strong');
      codeEl.textContent = code || '—';
      const nameEl = document.createElement('div');
      nameEl.className = 'muted';
      nameEl.textContent = name || '';
      left.appendChild(codeEl);
      left.appendChild(nameEl);
      const priceEl = document.createElement('div');
      priceEl.style.minWidth = '100px';
      priceEl.style.textAlign = 'right';
      priceEl.textContent = formatCurrency(price);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'primary';
      btn.dataset.code = code;
      const existing = quote.items.find((it) => it.code === code);
      if (existing) { btn.classList.add('is-added'); btn.textContent = '✓ Aggiunto ×' + existing.qty; }
      else { btn.textContent = 'Aggiungi'; }
      btn.addEventListener('click', () => {
        addQuoteItem({ code: code, name: name, price: price, qty: 1 });
        const cur = quote.items.find((it) => it.code === code);
        if (cur) {
          btn.classList.add('is-added');
          btn.textContent = '✓ Aggiunto ×' + cur.qty;
          btn.classList.add('flash');
          setTimeout(() => btn.classList.remove('flash'), 250);
        }
      });
      item.appendChild(left);
      item.appendChild(priceEl);
      item.appendChild(btn);
      wrap.appendChild(item);
      matched++;
    }
    if (!matched) {
      const div = document.createElement('div');
      div.className = 'empty';
      div.textContent = 'Nessun articolo trovato.';
      wrap.appendChild(div);
    }
  }

  async function exportQuotePDF() {
    if (!quote.items.length) { showToast('Preventivo vuoto.', 'warn'); return; }
    try {
      await loadVendor('jspdf');
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      const M = 40; let y = M;
      doc.setFontSize(16); doc.text('Preventivo ListoAPP', M, y); y += 22;
      doc.setFontSize(10);
      const dt = new Date().toLocaleString('it-IT');
      doc.text('Data: ' + dt, M, y); y += 14;
      if (quote.customer) { doc.text('Cliente: ' + quote.customer, M, y); y += 14; }
      y += 10;
      doc.setFontSize(11);
      doc.text('Cod.', M, y);
      doc.text('Descrizione', M + 80, y);
      doc.text('Q.tà', M + 320, y);
      doc.text('Prezzo', M + 380, y);
      doc.text('Subtot.', M + 460, y);
      y += 6; doc.line(M, y, 555, y); y += 14;
      doc.setFontSize(10);
      quote.items.forEach((it) => {
        if (y > 760) { doc.addPage(); y = M; }
        doc.text(String(it.code || '').slice(0, 14), M, y);
        doc.text(String(it.name || '').slice(0, 40), M + 80, y);
        doc.text(String(it.qty || 0), M + 320, y);
        doc.text(formatCurrency(it.price || 0), M + 380, y);
        doc.text(formatCurrency(rowSubtotal(it)), M + 460, y);
        y += 14;
      });
      const t = quoteTotals();
      y += 10; doc.line(M, y, 555, y); y += 16;
      doc.setFontSize(11);
      doc.text('Subtotale: ' + formatCurrency(t.sub), M + 320, y); y += 14;
      doc.text('Sconti riga: -' + formatCurrency(t.rowDisc), M + 320, y); y += 14;
      doc.text('Sconto globale: -' + formatCurrency(t.globalDisc), M + 320, y); y += 14;
      doc.setFontSize(13);
      doc.text('TOTALE: ' + formatCurrency(t.grand), M + 320, y); y += 18;
      if (quote.notes) {
        y += 12; doc.setFontSize(10);
        doc.text('Note:', M, y); y += 12;
        const lines = doc.splitTextToSize(quote.notes, 515);
        doc.text(lines, M, y);
      }
      const fname = 'preventivo_' + todayISO() + '.pdf';
      doc.save(fname);
      showToast('PDF generato: ' + fname, 'success');
    } catch (err) {
      console.error(err);
      showToast('Export PDF fallito: ' + (err.message || err), 'error');
    }
  }

  function exportQuoteText() {
    if (!quote.items.length) { showToast('Preventivo vuoto.', 'warn'); return; }
    const t = quoteTotals();
    const lines = ['*Preventivo ListoAPP*'];
    if (quote.customer) lines.push('Cliente: ' + quote.customer);
    lines.push('');
    quote.items.forEach((it) => {
      lines.push('• ' + (it.code ? '[' + it.code + '] ' : '') + (it.name || '') +
        ' — ' + it.qty + ' × ' + formatCurrency(it.price) +
        (it.discount ? ' (-' + it.discount + '%)' : '') +
        ' = ' + formatCurrency(rowSubtotal(it)));
    });
    lines.push('');
    lines.push('Subtotale: ' + formatCurrency(t.sub));
    if (t.rowDisc > 0) lines.push('Sconti riga: -' + formatCurrency(t.rowDisc));
    if (t.globalDisc > 0) lines.push('Sconto globale: -' + formatCurrency(t.globalDisc));
    lines.push('*TOTALE: ' + formatCurrency(t.grand) + '*');
    if (quote.notes) { lines.push(''); lines.push('Note: ' + quote.notes); }
    const text = lines.join('\n');
    const tryClipboard = async () => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          showToast('Testo copiato negli appunti.', 'success');
          return true;
        }
      } catch (_) { /* fall through */ }
      return false;
    };
    tryClipboard().then((ok) => {
      if (ok) return;
      const wa = 'https://wa.me/?text=' + encodeURIComponent(text);
      const a = document.createElement('a');
      a.href = wa; a.target = '_blank'; a.rel = 'noopener';
      a.click();
      showToast('Apro WhatsApp con il testo del preventivo.', 'success');
    });
  }

  // ────────────────────────────────────────────────
  // 8. PROMO
  // ────────────────────────────────────────────────
  const KEY_PROMO_REMOTE = 'promo_remote_cache';
  const KEY_PROMO_LOCAL = 'promo_local_index';
  const KEY_PROMO_LOCAL_PREFIX = 'promo_local_';
  const KEY_PROMO_SEEN = 'listoapp_promo_seen_v1';

  let promoRemote = [];
  let promoLocal = [];
  let promoEtag = null;
  let promoInFlight = null;

  async function loadPromoCaches() {
    try {
      const cache = await idbGet(KEY_PROMO_REMOTE);
      if (cache && Array.isArray(cache.list)) { promoRemote = cache.list; promoEtag = cache.etag || null; }
    } catch (_) {}
    try {
      const idx = await idbGet(KEY_PROMO_LOCAL);
      if (Array.isArray(idx)) {
        const all = [];
        for (const id of idx) {
          const p = await idbGet(KEY_PROMO_LOCAL_PREFIX + id);
          if (p) all.push(Object.assign({}, p, { _local: true }));
        }
        promoLocal = all;
      }
    } catch (_) {}
  }

  async function savePromoLocal(promo) {
    const id = promo.id || uid('lp_');
    promo.id = id;
    promo._local = true;
    if (!promo.createdAt) promo.createdAt = new Date().toISOString();
    await idbSet(KEY_PROMO_LOCAL_PREFIX + id, promo);
    let idx = (await idbGet(KEY_PROMO_LOCAL)) || [];
    if (!Array.isArray(idx)) idx = [];
    if (!idx.includes(id)) idx.push(id);
    await idbSet(KEY_PROMO_LOCAL, idx);
    promoLocal = promoLocal.filter((p) => p.id !== id).concat([promo]);
  }

  async function deletePromoLocal(id) {
    await idbDel(KEY_PROMO_LOCAL_PREFIX + id);
    let idx = (await idbGet(KEY_PROMO_LOCAL)) || [];
    if (!Array.isArray(idx)) idx = [];
    idx = idx.filter((x) => x !== id);
    await idbSet(KEY_PROMO_LOCAL, idx);
    promoLocal = promoLocal.filter((p) => p.id !== id);
    renderPromo();
    showToast('Promo locale eliminata.', 'success');
  }

  async function fetchPromoOnce() {
    if (promoInFlight) return promoInFlight;
    promoInFlight = (async () => {
      const tryFetch = async (url, useEtag) => {
        const headers = {};
        if (useEtag && promoEtag) headers['If-None-Match'] = promoEtag;
        const res = await fetch(url, { cache: 'no-store', headers });
        return res;
      };
      try {
        let res;
        const isFileProto = (location.protocol === 'file:');
        try {
          if (isFileProto) {
            // fetch() locale da file:// genera rumore in console su Chrome — vai diretto al raw
            res = await tryFetch('https://raw.githubusercontent.com/pezzaliapp/ListoAPP/main/promo/promo.json', false);
          } else {
            res = await tryFetch('./promo/promo.json', true);
          }
        } catch (e) {
          // fallback raw (solo se non l'abbiamo già provato)
          if (!isFileProto) {
            res = await tryFetch('https://raw.githubusercontent.com/pezzaliapp/ListoAPP/main/promo/promo.json', false);
          } else {
            throw e;
          }
        }
        if (res.status === 304) return { unchanged: true };
        if (!res.ok) {
          if (res.status === 404) {
            // promo.json assente: 0 promo remote
            promoRemote = [];
            await idbSet(KEY_PROMO_REMOTE, { etag: null, list: [] });
            return { changed: true };
          }
          throw new Error('HTTP ' + res.status);
        }
        promoEtag = res.headers.get('ETag') || promoEtag;
        const data = await res.json();
        const list = Array.isArray(data) ? data : (data && Array.isArray(data.promo) ? data.promo : []);
        const before = promoRemote.map((p) => p.id).sort().join(',');
        const after = list.map((p) => p.id).sort().join(',');
        promoRemote = list;
        await idbSet(KEY_PROMO_REMOTE, { etag: promoEtag, list: list });
        return { changed: before !== after, list: list };
      } catch (err) {
        // offline: usa cache locale già caricata, niente errore visivo aggressivo
        return { error: err };
      }
    })();
    try { return await promoInFlight; }
    finally { promoInFlight = null; }
  }

  async function refreshPromoVisible(showNewToast) {
    const before = new Set(getMergedPromos().map((p) => p.id));
    const r = await fetchPromoOnce();
    const after = getMergedPromos();
    if (r && r.changed && showNewToast) {
      const seen = readSeen();
      const newOnes = after.filter((p) => !before.has(p.id) && !seen[p.id] && isPromoActive(p));
      if (newOnes.length) {
        showToast('Nuove promo: ' + newOnes.map((p) => p.title).join(', '), 'success', { ttl: 6000 });
      }
    }
    renderPromo();
  }

  function readSeen() {
    try { return JSON.parse(localStorage.getItem(KEY_PROMO_SEEN) || '{}') || {}; }
    catch (_) { return {}; }
  }
  function markSeen(id) {
    const s = readSeen();
    s[id] = Date.now();
    try { localStorage.setItem(KEY_PROMO_SEEN, JSON.stringify(s)); } catch (_) {}
  }

  function isPromoActive(p) {
    if (p.active === false) return false;
    return isWithinRange(todayISO(), p.startsAt, p.expiresAt);
  }

  function getMergedPromos() {
    const map = new Map();
    promoRemote.forEach((p) => map.set(p.id, Object.assign({ _local: false }, p)));
    promoLocal.forEach((p) => map.set(p.id, Object.assign({}, p, { _local: true })));
    return Array.from(map.values());
  }

  function renderPromo() {
    const wrap = $('#promo-list');
    if (!wrap) return;
    wrap.innerHTML = '';
    const all = getMergedPromos();
    const active = all.filter(isPromoActive).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    if (!active.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Nessuna promo attiva al momento.';
      wrap.appendChild(empty);
      return;
    }
    active.forEach((p) => {
      const card = document.createElement('article');
      card.className = 'promo';
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      const header = document.createElement('header');
      const titleWrap = document.createElement('div');
      const h = document.createElement('h3');
      h.textContent = p.title || '(senza titolo)';
      titleWrap.appendChild(h);
      const badges = document.createElement('div');
      if (p._local) {
        const b = document.createElement('span');
        b.className = 'badge local';
        b.textContent = '📱 locale';
        badges.appendChild(b);
      }
      if (p.type) {
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = p.type;
        badges.appendChild(b);
      }
      header.appendChild(titleWrap);
      header.appendChild(badges);
      const desc = document.createElement('div');
      desc.className = 'desc';
      desc.textContent = p.description || '';
      const meta = document.createElement('div');
      meta.className = 'meta';
      const range = (p.startsAt || '—') + ' → ' + (p.expiresAt || '—');
      const r = document.createElement('span'); r.textContent = range; meta.appendChild(r);
      if (p.fileSize) {
        const s = document.createElement('span');
        s.textContent = (Math.round(p.fileSize / 1024)) + ' KB';
        meta.appendChild(s);
      }
      card.appendChild(header);
      if (p.description) card.appendChild(desc);
      card.appendChild(meta);
      if (p._local) {
        const actions = document.createElement('div');
        actions.style.display = 'flex'; actions.style.gap = '6px'; actions.style.marginTop = '8px';
        const del = document.createElement('button');
        del.type = 'button'; del.className = 'danger'; del.textContent = 'Elimina';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          deletePromoLocal(p.id);
        });
        actions.appendChild(del);
        card.appendChild(actions);
      }
      const open = () => { markSeen(p.id); openPromo(p); };
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      wrap.appendChild(card);
    });
  }

  async function openPromo(p) {
    const url = p.url || '';
    if (!url) { showToast('Nessun allegato per questa promo.', 'warn'); return; }
    if (p.type === 'link' || /^https?:/i.test(url) && !/\.(pdf|png|jpe?g|gif|webp)$/i.test(url)) {
      window.open(url, '_blank', 'noopener');
      return;
    }
    const isImage = p.type === 'image' || /\.(png|jpe?g|gif|webp)$/i.test(url) || (p.fileMime || '').startsWith('image/');
    const isPdf = p.type === 'pdf' || /\.pdf$/i.test(url) || (p.fileMime || '') === 'application/pdf';
    let resolvedUrl = url;
    if (url.startsWith('data:')) {
      // ok diretto
    } else if (!/^https?:/i.test(url)) {
      // path relativo (es: 'promo/file.pdf') — risolto contro origin
      resolvedUrl = url;
    }
    openModal(p.title || 'Promo', (body) => {
      if (isImage) {
        const img = document.createElement('img');
        img.src = resolvedUrl;
        img.alt = p.title || '';
        body.appendChild(img);
        body.classList.add('padded');
      } else if (isPdf) {
        // Render via pdf.js su canvas: gli iframe con src=data:application/pdf
        // vengono bloccati da Chrome/Safari per policy di sicurezza, lasciando
        // il modale bianco. Stesso pattern del viewer del listino, ma stato
        // in closure isolato (niente globali, niente listener su document).
        const wrapper = document.createElement('div');
        wrapper.style.display = 'flex';
        wrapper.style.flexDirection = 'column';
        wrapper.style.height = '100%';

        const toolbar = document.createElement('div');
        toolbar.style.display = 'flex';
        toolbar.style.alignItems = 'center';
        toolbar.style.justifyContent = 'center';
        toolbar.style.gap = '8px';
        toolbar.style.padding = '8px';
        toolbar.style.borderBottom = '1px solid var(--border)';
        toolbar.style.background = 'var(--surface)';
        toolbar.style.position = 'sticky';
        toolbar.style.top = '0';
        toolbar.style.zIndex = '1';

        const prevBtn = document.createElement('button');
        prevBtn.type = 'button';
        prevBtn.setAttribute('aria-label', 'Pagina precedente');
        prevBtn.textContent = '‹';
        prevBtn.disabled = true;

        const indicator = document.createElement('span');
        indicator.style.minWidth = '64px';
        indicator.style.textAlign = 'center';
        indicator.style.fontVariantNumeric = 'tabular-nums';
        indicator.textContent = '— / —';

        const nextBtn = document.createElement('button');
        nextBtn.type = 'button';
        nextBtn.setAttribute('aria-label', 'Pagina successiva');
        nextBtn.textContent = '›';
        nextBtn.disabled = true;

        toolbar.append(prevBtn, indicator, nextBtn);

        const status = document.createElement('div');
        status.style.padding = '16px';
        status.style.textAlign = 'center';
        status.style.color = 'var(--text-muted)';
        status.textContent = 'Caricamento…';

        const canvasWrap = document.createElement('div');
        canvasWrap.style.flex = '1';
        canvasWrap.style.overflow = 'auto';
        canvasWrap.style.padding = '12px';
        canvasWrap.style.display = 'flex';
        canvasWrap.style.justifyContent = 'center';
        canvasWrap.style.alignItems = 'flex-start';

        const canvas = document.createElement('canvas');
        canvas.style.maxWidth = '100%';
        canvas.style.height = 'auto';
        canvas.style.display = 'none';
        canvas.style.background = '#fff';
        canvas.style.boxShadow = '0 4px 12px rgba(0,0,0,0.2)';
        canvasWrap.appendChild(canvas);

        wrapper.append(toolbar, status, canvasWrap);
        body.appendChild(wrapper);

        // Stato locale isolato in closure
        let pdfDoc = null;
        let currentPage = 1;
        let totalPages = 0;

        async function renderPromoPage(n) {
          if (!pdfDoc) return;
          currentPage = Math.min(Math.max(1, Number(n) || 1), totalPages);
          try {
            const page = await pdfDoc.getPage(currentPage);
            const wrapW = Math.max(320, canvasWrap.clientWidth - 24);
            const base = page.getViewport({ scale: 1 });
            const scale = wrapW / base.width;
            const viewport = page.getViewport({ scale });
            const ctx = canvas.getContext('2d');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            await page.render({ canvasContext: ctx, viewport }).promise;
            canvas.style.display = 'block';
            indicator.textContent = currentPage + ' / ' + totalPages;
            prevBtn.disabled = currentPage <= 1;
            nextBtn.disabled = currentPage >= totalPages;
          } catch (err) {
            console.error(err);
            status.textContent = 'Errore nel rendering della pagina ' + currentPage + '.';
            status.style.display = '';
          }
        }

        prevBtn.addEventListener('click', () => renderPromoPage(currentPage - 1));
        nextBtn.addEventListener('click', () => renderPromoPage(currentPage + 1));

        (async () => {
          if (!window.pdfjsLib) {
            status.textContent = 'Viewer PDF non disponibile (pdf.js non caricato).';
            return;
          }
          try {
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
            const getDocArg = resolvedUrl.startsWith('data:')
              ? { data: dataUrlToUint8Array(resolvedUrl) }
              : { url: resolvedUrl };
            pdfDoc = await window.pdfjsLib.getDocument(getDocArg).promise;
            totalPages = pdfDoc.numPages || 0;
            if (totalPages === 0) throw new Error('PDF senza pagine');
            status.style.display = 'none';
            if (totalPages === 1) toolbar.style.display = 'none';
            await renderPromoPage(1);
          } catch (err) {
            console.error(err);
            status.textContent = 'Impossibile aprire il PDF.';
          }
        })();
      } else {
        const a = document.createElement('a');
        a.href = resolvedUrl; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = 'Apri allegato in nuova scheda';
        body.classList.add('padded');
        body.appendChild(a);
      }
    });
  }

  async function importLocalPromoFromFile(file) {
    if (!file) return;
    const name = (file.name || '').toLowerCase();
    if (name.endsWith('.json')) {
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const list = Array.isArray(data) ? data : (data && Array.isArray(data.promo) ? data.promo : [data]);
        let added = 0;
        for (const raw of list) {
          if (!raw || typeof raw !== 'object') continue;
          const p = {
            id: raw.id || uid('lp_'),
            title: String(raw.title || 'Promo locale'),
            description: String(raw.description || ''),
            url: String(raw.url || ''),
            type: raw.type || (raw.url && /\.pdf$/i.test(raw.url) ? 'pdf' : (raw.url ? 'link' : 'link')),
            fileName: raw.fileName || '',
            fileMime: raw.fileMime || '',
            fileSize: Number(raw.fileSize) || 0,
            startsAt: raw.startsAt || '',
            expiresAt: raw.expiresAt || '',
            active: raw.active !== false,
            createdAt: raw.createdAt || new Date().toISOString(),
            _local: true
          };
          await savePromoLocal(p);
          added++;
        }
        renderPromo();
        showToast('Importate ' + added + ' promo locali.', 'success');
      } catch (err) {
        showToast('JSON non valido: ' + (err.message || err), 'error');
      }
      return;
    }
    // Allegato singolo: chiedi titolo via prompt? No alert/prompt — usa modal mini
    promptLocalPromo(file);
  }

  function promptLocalPromo(file) {
    const isImage = (file.type || '').startsWith('image/');
    const isPdf = (file.type || '') === 'application/pdf' || /\.pdf$/i.test(file.name);
    openModal('Nuova promo locale', (body) => {
      body.classList.add('padded');
      const form = document.createElement('div');
      form.className = 'admin-form';
      const mk = (label, key, type, value) => {
        const w = document.createElement('div');
        w.className = key === 'description' ? 'full' : '';
        const l = document.createElement('label'); l.textContent = label;
        const i = document.createElement(type === 'textarea' ? 'textarea' : 'input');
        if (type !== 'textarea') i.type = type;
        i.dataset.key = key;
        if (value) i.value = value;
        w.appendChild(l); w.appendChild(i);
        form.appendChild(w);
        return i;
      };
      const inpTitle = mk('Titolo', 'title', 'text', file.name);
      mk('Descrizione', 'description', 'textarea', '');
      mk('Inizio', 'startsAt', 'date', todayISO());
      mk('Scadenza', 'expiresAt', 'date', '');
      body.appendChild(form);
      const footer = document.createElement('div');
      footer.style.marginTop = '12px';
      footer.style.display = 'flex';
      footer.style.gap = '8px';
      footer.style.justifyContent = 'flex-end';
      const cancel = document.createElement('button');
      cancel.type = 'button'; cancel.className = 'ghost'; cancel.textContent = 'Annulla';
      cancel.addEventListener('click', closeModal);
      const save = document.createElement('button');
      save.type = 'button'; save.className = 'primary'; save.textContent = 'Salva';
      save.addEventListener('click', async () => {
        const fields = {};
        $$('input, textarea', form).forEach((el) => fields[el.dataset.key] = el.value);
        try {
          const ab = await file.arrayBuffer();
          const dataUrl = await arrayBufferToDataURL(ab, file.type || (isPdf ? 'application/pdf' : 'application/octet-stream'));
          const promo = {
            id: uid('lp_'),
            title: fields.title || file.name,
            description: fields.description || '',
            url: dataUrl,
            type: isImage ? 'image' : (isPdf ? 'pdf' : 'link'),
            fileName: file.name,
            fileMime: file.type || '',
            fileSize: file.size,
            startsAt: fields.startsAt || '',
            expiresAt: fields.expiresAt || '',
            active: true,
            createdAt: new Date().toISOString(),
            _local: true
          };
          await savePromoLocal(promo);
          renderPromo();
          closeModal();
          showToast('Promo locale aggiunta.', 'success');
        } catch (err) {
          showToast('Salvataggio fallito: ' + (err.message || err), 'error');
        }
      });
      footer.appendChild(cancel);
      footer.appendChild(save);
      body.appendChild(footer);
    });
  }

  function arrayBufferToDataURL(buffer, mime) {
    return new Promise((resolve, reject) => {
      try {
        const blob = new Blob([buffer], { type: mime });
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(blob);
      } catch (e) { reject(e); }
    });
  }

  function dataUrlToUint8Array(dataUrl) {
    const idx = dataUrl.indexOf(',');
    const base64 = idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // ────────────────────────────────────────────────
  // 9. MODAL
  // ────────────────────────────────────────────────
  let _modalCleanup = null;
  function openModal(title, build, cleanup) {
    const back = $('#modal');
    if (!back) return;
    const titleEl = $('#modal-title');
    const body = $('#modal-body');
    if (titleEl) titleEl.textContent = title || '';
    if (body) {
      body.innerHTML = '';
      body.classList.remove('padded');
      try { build(body); } catch (e) { console.error(e); }
    }
    back.classList.add('open');
    _modalCleanup = cleanup || null;
    document.body.style.overflow = 'hidden';
  }
  function closeModal() {
    const back = $('#modal');
    if (!back) return;
    back.classList.remove('open');
    document.body.style.overflow = '';
    if (typeof _modalCleanup === 'function') { try { _modalCleanup(); } catch (_) {} _modalCleanup = null; }
    const body = $('#modal-body');
    if (body) body.innerHTML = '';
  }

  // ────────────────────────────────────────────────
  // 9b. PDF VIEWER (canvas overlay) + collegamento Excel↔PDF
  // ────────────────────────────────────────────────
  const PDFJS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  let pdfDoc = null;
  let currentPdfPage = 1;
  let pdfName = 'Listino PDF';
  let _pdfLoading = null;

  async function ensurePdf() {
    if (pdfDoc) return pdfDoc;
    if (_pdfLoading) return _pdfLoading;
    const saved = await idbGet(KEY_LISTINO_PDF);
    if (!saved) {
      showToast('Carica prima il PDF del listino dalla scheda "Listino".', 'warn');
      return null;
    }
    if (!window.pdfjsLib) {
      showToast('Viewer PDF non disponibile (pdf.js non caricato). Apri l\'app online almeno una volta.', 'error', { ttl: 6000 });
      return null;
    }
    _pdfLoading = (async () => {
      try {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
        const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(saved.blob) }).promise;
        pdfDoc = doc;
        pdfName = saved.name || 'Listino PDF';
        const titleEl = $('#pdfTitle'); if (titleEl) titleEl.textContent = pdfName;
        const totalEl = $('#pdfPageTotal'); if (totalEl) totalEl.textContent = '/ ' + doc.numPages;
        return doc;
      } finally { _pdfLoading = null; }
    })();
    return _pdfLoading;
  }

  async function renderPdfPage(n) {
    const doc = await ensurePdf();
    if (!doc) return;
    currentPdfPage = Math.min(Math.max(1, Number(n) || 1), doc.numPages);
    const page = await doc.getPage(currentPdfPage);
    const wrap = $('#pdfCanvasWrap');
    const canvas = $('#pdfCanvas');
    if (!wrap || !canvas) return;
    const wrapW = Math.max(320, wrap.clientWidth - 24);
    const base = page.getViewport({ scale: 1 });
    const scale = wrapW / base.width;
    const viewport = page.getViewport({ scale });
    const ctx = canvas.getContext('2d');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: ctx, viewport }).promise;
    const inp = $('#pdfPageInput'); if (inp) inp.value = String(currentPdfPage);
    wrap.scrollTop = 0;
  }

  async function openPdfAtPage(n) {
    const overlay = $('#pdfViewer');
    if (!overlay) return;
    overlay.classList.remove('hide');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    await renderPdfPage(n);
  }

  function closePdfViewer() {
    const overlay = $('#pdfViewer');
    if (!overlay) return;
    overlay.classList.add('hide');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  function bindPdfViewerUI() {
    const close = $('#pdfClose'); if (close) close.addEventListener('click', closePdfViewer);
    const prev = $('#pdfPrev'); if (prev) prev.addEventListener('click', () => renderPdfPage(currentPdfPage - 1));
    const next = $('#pdfNext'); if (next) next.addEventListener('click', () => renderPdfPage(currentPdfPage + 1));
    const inp = $('#pdfPageInput'); if (inp) inp.addEventListener('change', (e) => renderPdfPage(e.target.value));
    document.addEventListener('keydown', (e) => {
      const overlay = $('#pdfViewer');
      if (!overlay || overlay.classList.contains('hide')) return;
      if (e.key === 'Escape') { e.preventDefault(); closePdfViewer(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); renderPdfPage(currentPdfPage - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); renderPdfPage(currentPdfPage + 1); }
    });
    const onResize = debounce(() => {
      const overlay = $('#pdfViewer');
      if (overlay && !overlay.classList.contains('hide') && pdfDoc) renderPdfPage(currentPdfPage);
    }, 150);
    window.addEventListener('resize', onResize);
  }

  async function refreshPdfStatus() {
    const el = $('#pdfStatus');
    const clearBtn = $('#pdfClearBtn');
    const saved = await idbGet(KEY_LISTINO_PDF);
    if (saved) {
      pdfName = saved.name || 'Listino PDF';
      if (el) {
        el.textContent = 'PDF caricato: ' + saved.name + ' — tocca "Pag. N" su un articolo per aprirlo.';
        el.classList.add('ok');
      }
      if (clearBtn) clearBtn.hidden = false;
    } else {
      if (el) { el.textContent = 'Nessun PDF caricato.'; el.classList.remove('ok'); }
      if (clearBtn) clearBtn.hidden = true;
    }
  }

  async function handlePdfFile(file) {
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      await idbSet(KEY_LISTINO_PDF, {
        name: file.name,
        type: file.type || 'application/pdf',
        blob: buf,
        savedAt: Date.now()
      });
      pdfDoc = null; // forza il reload alla prossima apertura
      await refreshPdfStatus();
      showToast('PDF caricato: ' + file.name + '.', 'success');
    } catch (err) {
      console.error(err);
      showToast('Caricamento PDF fallito: ' + (err.message || err), 'error');
    }
  }

  async function clearPdf() {
    await idbDel(KEY_LISTINO_PDF);
    pdfDoc = null;
    await refreshPdfStatus();
    showToast('PDF rimosso.', 'success');
  }

  // ────────────────────────────────────────────────
  // 10. BOOTSTRAP
  // ────────────────────────────────────────────────
  function bindTabs() {
    const tabs = $$('.tab-btn');
    const panels = $$('.panel');
    tabs.forEach((t) => {
      t.addEventListener('click', () => {
        const target = t.dataset.tab;
        tabs.forEach((x) => x.setAttribute('aria-selected', x === t ? 'true' : 'false'));
        panels.forEach((p) => p.dataset.active = (p.id === 'panel-' + target) ? 'true' : 'false');
        if (target === 'promo') refreshPromoVisible(true);
      });
    });
  }

  function bindListinoUI() {
    const drop = $('#listino-drop');
    const fileInput = $('#listino-file');
    if (!drop || !fileInput) return;
    // Click → file picker: gestito dal `for="listino-file"` sulla label (HTML nativo).
    // Niente handler JS sul click per evitare doppia attivazione.
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault(); drop.classList.remove('dragover');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleListinoFile(f);
    });
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      if (f) handleListinoFile(f);
      fileInput.value = '';
    });
    // A11y: la label con tabindex è focusable ma non si attiva con Enter/Space
    // di default. Aggiungiamo l'handler keydown qui per ripristinare il comportamento.
    const dropLabel = $('#listino-drop');
    if (dropLabel) {
      dropLabel.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          fileInput.click();
        }
      });
    }
    const removeBtn = $('#listino-remove');
    if (removeBtn) removeBtn.addEventListener('click', clearListino);
    const viewBtn = $('#listino-view');
    if (viewBtn) viewBtn.addEventListener('click', async () => {
      if (!listino) return;
      if (listino.kind === 'pdf') { viewListinoPDF(); return; }
      // listino tabellare: apri il PDF abbinato (KEY_LISTINO_PDF) nel viewer canvas
      const saved = await idbGet(KEY_LISTINO_PDF);
      if (!saved) { showToast('Carica prima il PDF abbinato.', 'warn'); return; }
      openPdfAtPage(1);
    });

    // Upload PDF dedicato (separato dal dropzone)
    const pdfBtn = $('#pdfUploadBtn');
    const pdfInp = $('#pdfFile');
    if (pdfBtn && pdfInp) {
      pdfBtn.addEventListener('click', () => pdfInp.click());
      pdfInp.addEventListener('change', () => {
        const f = pdfInp.files && pdfInp.files[0];
        if (f) handlePdfFile(f);
        pdfInp.value = '';
      });
    }
    const pdfClearBtn = $('#pdfClearBtn');
    if (pdfClearBtn) pdfClearBtn.addEventListener('click', clearPdf);

    // Filtri tabella listino
    const search = $('#listino-search');
    if (search) {
      const handler = debounce(() => {
        listinoFilter.q = search.value || '';
        listinoPage = 1;
        renderListinoFull();
      }, 80);
      search.addEventListener('input', handler);
    }
    const pageSel = $('#pageFilter');
    if (pageSel) pageSel.addEventListener('change', () => {
      listinoFilter.page = pageSel.value || '';
      listinoPage = 1;
      renderListinoFull();
    });

    // Pager
    const prev = $('#listino-prev');
    if (prev) prev.addEventListener('click', () => { listinoPage = Math.max(1, listinoPage - 1); renderListinoFull(); });
    const next = $('#listino-next');
    if (next) next.addEventListener('click', () => { listinoPage = listinoPage + 1; renderListinoFull(); });

    // Click delegation per i bottoni "Pag. N" nelle righe della tabella listino.
    const tbody = $('#listino-tbody');
    if (tbody) tbody.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-page]');
      if (!btn) return;
      openPdfAtPage(Number(btn.dataset.page));
    });
  }

  function bindCatalogUI() {
    const search = $('#catalog-search');
    if (search) {
      const handler = debounce(renderPreventivoCatalog, 80);
      search.addEventListener('input', handler);
    }
  }

  function bindPromoUI() {
    const btnImport = $('#promo-import');
    const inp = $('#promo-import-file');
    if (btnImport && inp) {
      btnImport.addEventListener('click', () => inp.click());
      inp.addEventListener('change', () => {
        const f = inp.files && inp.files[0];
        if (f) importLocalPromoFromFile(f);
        inp.value = '';
      });
    }
    const btnRefresh = $('#promo-refresh');
    if (btnRefresh) btnRefresh.addEventListener('click', () => refreshPromoVisible(true));
  }

  function bindModalUI() {
    const close = $('#modal-close');
    if (close) close.addEventListener('click', closeModal);
    const back = $('#modal');
    if (back) back.addEventListener('click', (e) => { if (e.target === back) closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  }

  function startPolling() {
    // Promo: 60s
    setInterval(() => { if (document.visibilityState === 'visible') refreshPromoVisible(true); }, 60000);
    // Version: 5min
    setInterval(pollVersion, 5 * 60 * 1000);
    // Trigger su focus / visibility
    window.addEventListener('focus', () => { refreshPromoVisible(true); pollVersion(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        refreshPromoVisible(true);
        pollVersion();
      }
    });
  }

  async function init() {
    bindTabs();
    bindListinoUI();
    bindCatalogUI();
    bindPromoUI();
    bindModalUI();
    bindPdfViewerUI();
    bindQuoteEvents();
    loadQuote();
    renderQuote();
    try { await loadListinoFromIDB(); } catch (e) { console.warn('IDB listino load failed:', e); }
    renderListino();
    renderPreventivoCatalog();
    try { await refreshPdfStatus(); } catch (e) { console.warn('PDF status refresh failed:', e); }
    try { await loadPromoCaches(); } catch (e) { console.warn('promo cache load failed:', e); }
    renderPromo();
    registerSW();
    // primo poll: senza toast (evita rumore al boot)
    refreshPromoVisible(false).catch(() => {});
    pollVersion().catch(() => {});
    startPolling();
    requestPersistence();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
