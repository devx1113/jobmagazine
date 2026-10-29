# ライター名鑑 scraper + database site

## 1. Scrape → CSV

```
.venv/bin/python scrape.py          # writes output/writers.csv, writer_tags.csv, tags.csv
```

## 2. CSV → encrypted site data

```
MEIKAN_PIN=<15-digit PIN> .venv/bin/python build_site.py   # writes site/data.enc.js
```

The PIN is never stored. The database is gzipped and encrypted with AES-256-GCM
(key = PBKDF2-SHA256, 600k iterations); the lock screen decrypts it in the browser.
To change the PIN, re-run this step with a new one.

## 3. View / deploy

`site/` is a static site (index.html, styles.css, app.js, data.enc.js).

- Local: `python3 -m http.server 8000 --directory site` → http://localhost:8000
  (Web Crypto needs https or localhost; opening the file directly also works in Chrome/Firefox.)
- Vercel: deploy the `site/` folder as a static project (`vercel site/`).
