# Finanza Personale

App di finanza personale (stile YNAB) in React + Vite: dashboard con report multipli
(patrimonio netto, entrate/uscite, spese per categoria, entrate per fonte, risparmio
ed età del denaro), budget mensile, movimenti, conti e categorie. I dati sono salvati
nel `localStorage` del browser — nessun backend richiesto.

## Struttura del progetto

```
├── index.html              punto di ingresso HTML per Vite
├── vite.config.js          config Vite (contiene il `base` path per GitHub Pages)
├── package.json
├── public/
│   └── favicon.svg
└── src/
    ├── main.jsx             monta <App /> nel DOM
    ├── App.jsx              tutta l'app: stato, logica, calcoli e JSX
    └── index.css            stili globali, font, animazioni
```

Tutta la logica (store dati, calcoli dei report, gestione modali, ecc.) e il markup
vivono in `src/App.jsx` come un unico componente React a classe — è la stessa identica
logica dell'app originale, portata "as-is" da un formato a template custom a JSX
idiomatico. Non ci sono altre dipendenze runtime oltre a `react` e `react-dom`.

## Sviluppo locale

Richiede [Node.js](https://nodejs.org) 18 o superiore.

```bash
npm install
npm run dev
```

Apri l'indirizzo mostrato in console (di norma `http://localhost:5173`).

## Build di produzione

```bash
npm run build
```

Genera i file statici in `dist/`. Per verificarli localmente prima del deploy:

```bash
npm run preview
```

## Deploy su GitHub Pages

Prima di tutto, **verifica il valore di `base` in `vite.config.js`**:

- Se il sito verrà pubblicato come *project page*, cioè all'indirizzo
  `https://<tuo-utente>.github.io/<nome-repo>/`, imposta:
  ```js
  base: '/<nome-repo>/'
  ```
  (è già preimpostato su `/Finanza-Ynab/` — cambialo se il tuo repository si chiama
  diversamente).
- Se il sito verrà pubblicato come *user/organization page*, cioè il repository si
  chiama esattamente `<tuo-utente>.github.io` e il sito vive alla radice del dominio,
  imposta:
  ```js
  base: '/'
  ```

Un `base` sbagliato è la causa più comune di una pagina bianca dopo il deploy: il
browser cerca i file JS/CSS nel posto sbagliato.

### Opzione A — Deploy automatico con GitHub Actions (consigliata)

Il progetto include già `.github/workflows/deploy.yml`: ogni push sul branch `main`
builda l'app e la pubblica automaticamente su GitHub Pages.

1. Crea un nuovo repository su GitHub e caricaci questo progetto (via `git push` o
   trascinando i file dall'interfaccia web).
2. Nel repository, vai su **Settings → Pages**.
3. Alla voce **Source**, seleziona **GitHub Actions** (non "Deploy from a branch").
4. Fai un push sul branch `main` (o lancia manualmente il workflow da **Actions →
   Deploy to GitHub Pages → Run workflow**).
5. Dopo un paio di minuti il sito sarà live all'indirizzo mostrato in **Settings →
   Pages**.

Da questo momento, ogni volta che modifichi il codice e fai push su `main`, il sito
si aggiorna automaticamente.

### Opzione B — Deploy manuale con `gh-pages`

Alternativa se preferisci non usare GitHub Actions:

```bash
npm run deploy
```

Questo comando (pacchetto `gh-pages`, già incluso nelle devDependencies) builda il
progetto e pubblica il contenuto di `dist/` sul branch `gh-pages` del repository.
Dopo il primo deploy, vai su **Settings → Pages** e imposta come sorgente il branch
`gh-pages` (cartella `/root`).

## Note

- I dati (conti, movimenti, categorie, budget) sono salvati in `localStorage` sotto
  la chiave `fp_mvp_store_v5`, quindi restano nel browser dell'utente e non vengono
  sincronizzati altrove. Il pulsante "Ripristina dati d'esempio" nella barra laterale
  cancella tutto e ricarica i dati demo iniziali.
- I font (Hanken Grotesk, JetBrains Mono) sono caricati da Google Fonts in
  `src/index.css`. Se preferisci non dipendere da una CDN esterna, puoi scaricare i
  file `.woff2` e sostituire la riga `@import` con delle regole `@font-face` locali.
