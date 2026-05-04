# ListoAPP

PWA installabile per gestire **listini prezzi**, costruire **preventivi** e ricevere **promo in tempo reale** pubblicate da un admin centrale via GitHub.

- Vanilla JS, nessun build step.
- Si serve direttamente da GitHub Pages (push e basta).
- Funziona offline dopo la prima visita.
- Due pagine: `index.html` (utente) e `admin.html` (admin con PAT).

## Struttura

```
.
├── index.html               app utente
├── admin.html               pannello admin
├── manifest.webmanifest
├── sw.js                    service worker (cache versionata)
├── version.json             { version, commit } per il banner di update
├── icon.svg                 icona principale
├── promo/
│   └── promo.json           lista promo (gestita dall'admin)
├── assets/
│   ├── app.js               logica utente
│   ├── admin.js             logica admin
│   └── styles.css
├── bump-version.sh          aggiorna CACHE_NAME in sw.js + version.json
├── verify-vendors.sh        calcola SRI delle librerie CDN
└── README.md
```

## Installazione locale (sviluppo)

Niente `npm install`. Servire la cartella con un qualsiasi static server:

```bash
# Python
python3 -m http.server 8080
# oppure
npx serve -p 8080 .
```

Poi aprire <http://localhost:8080/>. Per testare il service worker serve **HTTPS** o `localhost` — non `file://` (da `file://` il SW non si registra, ma il resto dell'app funziona).

## Deploy su GitHub Pages

1. Push del contenuto sulla repo `pezzaliapp/ListoAPP`, branch `main`.
2. GitHub Pages: _Settings → Pages → Source: Deploy from a branch → main / root_.
3. L'app vive a `https://pezzaliapp.github.io/ListoAPP/`.

Prima di ogni release significativa:

```bash
./bump-version.sh             # bump CACHE_NAME e version.json con timestamp UTC
./verify-vendors.sh --update  # rigenera gli SRI dei vendor CDN
```

## Icone PNG (opzionali)

Il manifest referenzia `icon-192.png` e `icon-512.png`. Se non sono presenti, `icon.svg` copre comunque tutti gli usi su browser moderni. Per generarli:

```bash
# con rsvg-convert (libRSVG)
rsvg-convert -w 192 -h 192 icon.svg -o icon-192.png
rsvg-convert -w 512 -h 512 icon.svg -o icon-512.png

# oppure con ImageMagick
magick icon.svg -resize 192x192 icon-192.png
magick icon.svg -resize 512x512 icon-512.png
```

## Vendor (CDN)

Le librerie pesanti sono caricate **on-demand** via `<script>` con attributo `integrity` (SRI):

| libreria | versione | quando viene caricata |
| --- | --- | --- |
| SheetJS (`xlsx`) | 0.18.5 | al primo caricamento di un file Excel/CSV |
| jsPDF | 2.5.1 | alla prima esportazione PDF di un preventivo |

Gli hash sono memorizzati in `assets/app.js`. Compilali con:

```bash
./verify-vendors.sh --update
```

## Storage

- **IndexedDB** (`listoapp_db` / store `files`): listino, blob PDF, promo locali, configurazione admin, PAT.
- **localStorage**: preventivo corrente, ETag della versione, IDs delle promo già viste.
- **Cache API** (gestita solo dal SW): shell statica e binari delle promo. `promo/promo.json` e `version.json` non sono mai cachati.

## Real-time

- `promo/promo.json`: polling ogni 60 s + trigger su focus/visibilitychange. Usa `If-None-Match`/ETag, GitHub Pages risponde 304 quando non cambia. Fallback a `https://raw.githubusercontent.com/pezzaliapp/ListoAPP/main/promo/promo.json` se l'origin fallisce, poi all'ultima copia in IDB.
- `version.json`: polling ogni 5 min. Quando il timestamp cambia compare un banner "Nuova versione disponibile".

## Pannello admin

`admin.html` richiede un GitHub **Personal Access Token** con scope `repo` (o `public_repo` se la repo è pubblica). Il token resta nel browser (IndexedDB) con verifica round-trip dopo la scrittura. Non viene mai re-iniettato nel campo input al ricarico (placeholder "(token salvato)").

Flusso tipico:
1. Inserisci token e configurazione, premi **Salva**.
2. **Test connessione** verifica che `promo/promo.json` sia raggiungibile.
3. **Carica da GitHub** popola la lista da pubblicato.
4. Aggiungi/duplica/elimina promo. Per gli allegati, usa **📎 Carica allegato su GitHub** che fa upload in `promo/<file>` e imposta il campo `url`.
5. **Pubblica** scrive `promo/promo.json` (con backup pre-publish in IDB sotto chiave `backup_<timestamp>`).
6. Spunta **bump version.json** se vuoi che gli utenti vedano subito il banner di update.

## Service worker

Strategie in `sw.js`:
- `index.html` / `admin.html` → **network-first** (fallback cache).
- `promo/promo.json`, `version.json` → **mai cachati** (bypass diretto alla rete).
- File binari in `promo/` (PDF, immagini) → **network-first** (fallback cache).
- Asset statici (`assets/*`, `icon.svg`, ecc.) → **stale-while-revalidate**.

`CACHE_NAME` è hardcoded e va bumpato via `./bump-version.sh` ad ogni release.

## Browser support

Target: Chrome / Safari / Firefox / Edge ultime 2 versioni; iOS Safari 16+ in modalità installata.

## Licenza

MIT, salvo le librerie vendor (vedi sezione vendor sopra).
