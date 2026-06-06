# Digistamp

A minimal, browser-only tool for stamping seal/signature images onto PDFs — in bulk.

Upload up to **4 seals**, position and size each one, choose which to apply, lock the
ones you've dialed in, then drop in **one or many PDFs** and seal them all at once.
Everything runs locally in your browser. No accounts, no servers, no uploads.

> **Upload seals → Upload PDFs → Adjust & select → Seal all → Download**

---

## Features

- **Multiple seals (up to 4)** — each with its own position (X/Y) and size.
- **Select which apply** — enable/disable any seal with a checkbox; disabled seals are
  skipped.
- **Lock a seal** — protect a seal's position & size from accidental changes.
- **Persistent** — seals and all their settings are remembered between visits via
  IndexedDB.
- **Live preview** — see every enabled seal overlaid on page 1 of the chosen PDF; tap a
  seal to adjust it.
- **Batch processing** — upload many PDFs and seal them in one click, with progress and
  individual / "Download all" options.
- **Consistent placement** — seals are positioned by percentage, so they land the same on
  every page regardless of page size, across the whole document.
- **Quality preserved** — existing PDF content is not re-compressed.

---

## Tech Stack

| Concern            | Choice                                            |
| ------------------ | ------------------------------------------------- |
| UI                 | React 18                                          |
| Build / dev server | Vite 5                                            |
| PDF stamping       | [`pdf-lib`](https://pdf-lib.js.org/)              |
| PDF preview render | [`pdfjs-dist`](https://mozilla.github.io/pdf.js/) |
| Local storage      | IndexedDB (raw, no wrapper library)               |
| Styling            | Plain CSS — flat, minimal, Notion-style           |

All processing happens in the browser.


### Data flow

1. **Seals** are stored as an array in IndexedDB under a single key. Each record is:

   ```js
   {
     id,                 // unique id
     blob,               // the image File/Blob
     type,               // mime type (png/jpeg)
     name,               // original filename
     placement: { xPct, yPct, sizePct },  // % of page; xPct/yPct = seal CENTER, yPct from top
     enabled,            // included when stamping?
     locked              // position & size protected?
   }
   ```

   `App.jsx` loads them on mount, and saves them (debounced) whenever they change.

2. **PDFs** are held in memory only (not persisted) as `{ id, file, bytes }`. They're the
   current batch to process.

3. **Preview** (`pdfjs-dist`) renders page 1 of the selected PDF to a canvas, and the
   enabled seals are overlaid as absolutely-positioned images using the same percentage
   maths as the stamper.

4. **Generate** (`pdf.js → stampPdf`) iterates the batch. For each PDF it embeds every
   enabled seal once, then draws each seal on every page, converting the percentage
   placement into pdf-lib's bottom-left coordinate system. Each result is exposed as a
   downloadable object URL.

### Placement model

Positions are stored as **percentages**, not absolute points:

- `xPct` / `yPct` — the seal's **center**, 0–100 across the page width / height
  (`yPct` measured from the **top**, which matches the preview and user intuition).
- `sizePct` — the seal's width as a percentage of each page's width; height scales to keep
  the image's aspect ratio.

Because everything is relative, the same seal appears in the same proportional spot on
pages of any size within a document — and across every document in a batch.

---

## Running locally

```bash
npm install
npm run dev
```

Then open the URL Vite prints (default http://localhost:5173/).

---

## Privacy

Seal images and settings live only in your browser's IndexedDB. PDFs are read and stamped
entirely client-side and never leave your device.
