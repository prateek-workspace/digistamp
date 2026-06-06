import React, { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { loadSeals, saveSeals, clearSeals } from './db.js';
import { stampPdf } from './pdf.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const SEAL_TYPES = ['image/png', 'image/jpeg', 'image/jpg'];
const MAX_SEALS = 4;

// Staggered defaults so freshly added seals don't all land in the same spot.
const DEFAULT_PLACEMENTS = [
  { xPct: 80, yPct: 85, sizePct: 18 },
  { xPct: 20, yPct: 85, sizePct: 18 },
  { xPct: 80, yPct: 15, sizePct: 18 },
  { xPct: 20, yPct: 15, sizePct: 18 },
];

function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) || `s_${Date.now()}_${Math.random()}`;
}

export default function App() {
  const [seals, setSeals] = useState([]); // [{ id, blob, type, name, placement, enabled, locked }]
  const [selectedId, setSelectedId] = useState(null);
  const [loadingSeals, setLoadingSeals] = useState(true);

  const [pdfs, setPdfs] = useState([]); // [{ id, file, bytes }]
  const [previewId, setPreviewId] = useState(null);

  const [status, setStatus] = useState('idle'); // idle | generating | done | error
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState('');
  const [results, setResults] = useState([]); // [{ id, name, url }]

  const sealInputRef = useRef(null);
  const pdfInputRef = useRef(null);

  // --- Restore saved seals on first load --------------------------------
  useEffect(() => {
    (async () => {
      try {
        const saved = await loadSeals();
        setSeals(saved);
        if (saved.length) setSelectedId(saved[0].id);
      } catch {
        /* start empty */
      } finally {
        setLoadingSeals(false);
      }
    })();
  }, []);

  // Persist seals whenever they change (debounced so slider drags don't thrash).
  useEffect(() => {
    if (loadingSeals) return;
    const t = setTimeout(() => {
      if (seals.length) saveSeals(seals).catch(() => {});
      else clearSeals().catch(() => {});
    }, 350);
    return () => clearTimeout(t);
  }, [seals, loadingSeals]);

  // Object URLs for seal thumbnails / preview overlays.
  const [sealUrls, setSealUrls] = useState({}); // id -> objectURL
  useEffect(() => {
    const urls = {};
    seals.forEach((s) => {
      urls[s.id] = URL.createObjectURL(s.blob);
    });
    setSealUrls(urls);
    return () => Object.values(urls).forEach((u) => URL.revokeObjectURL(u));
  }, [seals.map((s) => s.id).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // Revoke result URLs when they change / unmount.
  useEffect(() => {
    return () => results.forEach((r) => r.url && URL.revokeObjectURL(r.url));
  }, [results]);

  // --- Seal management --------------------------------------------------
  async function onSealsSelected(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;

    const room = MAX_SEALS - seals.length;
    if (room <= 0) {
      setError(`You can keep up to ${MAX_SEALS} seals.`);
      return;
    }
    const valid = files.filter((f) => SEAL_TYPES.includes(f.type));
    if (!valid.length) {
      setError('Please choose PNG or JPG images for seals.');
      return;
    }
    setError('');

    const additions = valid.slice(0, room).map((file, i) => ({
      id: newId(),
      blob: file,
      type: file.type,
      name: file.name,
      placement: { ...DEFAULT_PLACEMENTS[(seals.length + i) % DEFAULT_PLACEMENTS.length] },
      enabled: true,
      locked: false,
    }));

    setSeals((prev) => [...prev, ...additions]);
    setSelectedId(additions[0].id);
    if (valid.length > room) {
      setError(`Added ${room}. Maximum of ${MAX_SEALS} seals reached.`);
    }
  }

  function updateSeal(id, patch) {
    setSeals((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  function updatePlacement(id, key, value) {
    setSeals((prev) =>
      prev.map((s) =>
        s.id === id ? { ...s, placement: { ...s.placement, [key]: value } } : s
      )
    );
  }

  function removeSeal(id) {
    setSeals((prev) => prev.filter((s) => s.id !== id));
    setSelectedId((cur) => {
      if (cur !== id) return cur;
      const rest = seals.filter((s) => s.id !== id);
      return rest.length ? rest[0].id : null;
    });
  }

  async function removeAllSeals() {
    await clearSeals().catch(() => {});
    setSeals([]);
    setSelectedId(null);
  }

  // --- PDF batch --------------------------------------------------------
  async function onPdfsSelected(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;

    const pdfFiles = files.filter((f) => f.type === 'application/pdf');
    if (!pdfFiles.length) {
      setError('Please choose PDF files.');
      return;
    }
    setError('');
    clearResults();
    setStatus('idle');

    try {
      const added = [];
      for (const file of pdfFiles) {
        const bytes = await file.arrayBuffer();
        added.push({ id: newId(), file, bytes });
      }
      setPdfs((prev) => {
        const next = [...prev, ...added];
        return next;
      });
      setPreviewId((cur) => cur || added[0].id);
    } catch {
      setError('Could not read one of those PDFs.');
    }
  }

  function removePdf(id) {
    setPdfs((prev) => prev.filter((p) => p.id !== id));
    setPreviewId((cur) => {
      if (cur !== id) return cur;
      const rest = pdfs.filter((p) => p.id !== id);
      return rest.length ? rest[0].id : null;
    });
    clearResults();
  }

  function resetPdfs() {
    setPdfs([]);
    setPreviewId(null);
    clearResults();
    setStatus('idle');
  }

  function clearResults() {
    setResults((rs) => {
      rs.forEach((r) => r.url && URL.revokeObjectURL(r.url));
      return [];
    });
  }

  // --- Generate (batch) -------------------------------------------------
  async function onGenerate() {
    const activeSeals = seals.filter((s) => s.enabled);
    if (!activeSeals.length || !pdfs.length) return;

    setStatus('generating');
    setError('');
    clearResults();
    setProgress({ done: 0, total: pdfs.length });

    const out = [];
    try {
      for (let i = 0; i < pdfs.length; i++) {
        const p = pdfs[i];
        // pdf-lib consumes the buffer, so hand it a fresh copy.
        const bytes = await stampPdf(p.bytes.slice(0), activeSeals);
        const blob = new Blob([bytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const base = (p.file.name || 'document.pdf').replace(/\.pdf$/i, '');
        out.push({ id: p.id, name: `${base}-sealed.pdf`, url });
        setProgress({ done: i + 1, total: pdfs.length });
      }
      setResults(out);
      setStatus('done');
    } catch (err) {
      console.error(err);
      out.forEach((r) => URL.revokeObjectURL(r.url));
      setError('Something went wrong while stamping. Please try again.');
      setStatus('error');
    }
  }

  function downloadAll() {
    results.forEach((r, i) => {
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = r.url;
        a.download = r.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, i * 200);
    });
  }

  // --- Render -----------------------------------------------------------
  const enabledSeals = seals.filter((s) => s.enabled);
  const selected = seals.find((s) => s.id === selectedId) || null;
  const previewPdf = pdfs.find((p) => p.id === previewId) || null;

  return (
    <div className="page">
      <header className="header">
        <h1>Digistamp</h1>
        <p className="tagline">Stamp your seals across every page — in bulk.</p>
      </header>

      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}

      {loadingSeals ? (
        <div className="card muted">Loading…</div>
      ) : (
        <div className="workflow">
          {/* ---------- Seals ---------- */}
          <section className="card seals-card">
            <div className="card-head">
              <div>
                <div className="section-title">Your seals</div>
                <div className="muted">
                  Up to {MAX_SEALS}. Toggle which ones to apply; lock to protect a
                  seal&apos;s position &amp; size.
                </div>
              </div>
              {seals.length > 0 && (
                <button className="btn btn-ghost btn-sm" onClick={removeAllSeals}>
                  Remove all
                </button>
              )}
            </div>

            <div className="seals-layout">
              <div className="seals-main">
                <div className="seal-grid">
                  {seals.map((s) => (
                    <SealCard
                      key={s.id}
                      seal={s}
                      url={sealUrls[s.id]}
                      selected={s.id === selectedId}
                      onSelect={() => setSelectedId(s.id)}
                      onToggleEnabled={() => updateSeal(s.id, { enabled: !s.enabled })}
                      onToggleLocked={() => updateSeal(s.id, { locked: !s.locked })}
                      onRemove={() => removeSeal(s.id)}
                    />
                  ))}

                  {seals.length < MAX_SEALS && (
                    <button
                      className="seal-card seal-add"
                      onClick={() => sealInputRef.current?.click()}
                    >
                      <span className="seal-add-plus">＋</span>
                      <span>Add seal</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Adjustment sliders — pinned to the top-right */}
              <aside className="controls-panel">
                <div className="controls-panel-head">
                  <span className="controls-panel-title">Adjust</span>
                  {selected?.locked && <span className="lock-pill">🔒</span>}
                </div>
                {selected ? (
                  <>
                    <div className="controls-target" title={selected.name}>
                      {selected.name}
                    </div>
                    <Controls
                      placement={selected.placement}
                      disabled={selected.locked}
                      onChange={(key, value) => updatePlacement(selected.id, key, value)}
                    />
                  </>
                ) : (
                  <p className="muted controls-empty">
                    Select a seal to adjust its position &amp; size.
                  </p>
                )}
              </aside>
            </div>

            <input
              ref={sealInputRef}
              type="file"
              accept="image/png,image/jpeg"
              multiple
              hidden
              onChange={onSealsSelected}
            />
          </section>

          {/* ---------- PDFs (batch) ---------- */}
          {seals.length > 0 && (
            <section className="card">
              <div className="card-head">
                <div>
                  <div className="section-title">Documents</div>
                  <div className="muted">
                    Add one or many PDFs — they&apos;ll all be sealed at once.
                  </div>
                </div>
                {pdfs.length > 0 && (
                  <button className="btn btn-ghost" onClick={resetPdfs}>
                    Clear
                  </button>
                )}
              </div>

              {pdfs.length === 0 ? (
                <div className="dropzone" onClick={() => pdfInputRef.current?.click()}>
                  <div className="dropzone-icon">📄</div>
                  <div className="dropzone-title">Upload PDFs</div>
                  <div className="muted">Select one or more files.</div>
                </div>
              ) : (
                <>
                  <ul className="pdf-list">
                    {pdfs.map((p) => (
                      <li
                        key={p.id}
                        className={`pdf-item ${p.id === previewId ? 'is-preview' : ''}`}
                      >
                        <button
                          className="pdf-name"
                          onClick={() => setPreviewId(p.id)}
                          title="Preview this PDF"
                        >
                          📄 {p.file.name}
                        </button>
                        <button
                          className="icon-btn"
                          onClick={() => removePdf(p.id)}
                          aria-label="Remove"
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                  <button
                    className="btn btn-ghost add-more"
                    onClick={() => pdfInputRef.current?.click()}
                  >
                    ＋ Add more PDFs
                  </button>
                </>
              )}

              <input
                ref={pdfInputRef}
                type="file"
                accept="application/pdf"
                multiple
                hidden
                onChange={onPdfsSelected}
              />

              {previewPdf && (
                <Preview
                  pdfBytes={previewPdf.bytes}
                  seals={enabledSeals}
                  sealUrls={sealUrls}
                  selectedId={selectedId}
                  onPickSeal={setSelectedId}
                />
              )}

              {pdfs.length > 0 && (
                <div className="actions">
                  {status !== 'done' ? (
                    <button
                      className="btn btn-primary"
                      onClick={onGenerate}
                      disabled={status === 'generating' || enabledSeals.length === 0}
                    >
                      {status === 'generating'
                        ? `Sealing ${progress.done} of ${progress.total}…`
                        : `Seal ${pdfs.length} PDF${pdfs.length > 1 ? 's' : ''}`}
                    </button>
                  ) : (
                    <>
                      <button className="btn btn-primary" onClick={downloadAll}>
                        Download all
                      </button>
                      <button className="btn btn-ghost" onClick={() => setStatus('idle')}>
                        Adjust &amp; redo
                      </button>
                    </>
                  )}
                </div>
              )}

              {enabledSeals.length === 0 && pdfs.length > 0 && (
                <div className="muted hint">Enable at least one seal to continue.</div>
              )}

              {status === 'done' && (
                <div className="results">
                  <div className="banner banner-success">
                    Done — {results.length} PDF{results.length > 1 ? 's' : ''} sealed on every
                    page.
                  </div>
                  <ul className="result-list">
                    {results.map((r) => (
                      <li key={r.id} className="result-item">
                        <span className="result-name" title={r.name}>
                          {r.name}
                        </span>
                        <a className="btn btn-ghost btn-sm" href={r.url} download={r.name}>
                          Download
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}
        </div>
      )}

      <footer className="footer">
        Everything stays on your device. Your seals are remembered between visits.
      </footer>
    </div>
  );
}

function SealCard({ seal, url, selected, onSelect, onToggleEnabled, onToggleLocked, onRemove }) {
  return (
    <div
      className={`seal-card ${selected ? 'is-selected' : ''} ${
        seal.enabled ? '' : 'is-disabled'
      }`}
      onClick={onSelect}
    >
      <div className="seal-card-top">
        <label className="checkbox" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={seal.enabled} onChange={onToggleEnabled} />
        </label>
        <div className="seal-card-actions">
          <button
            className={`icon-btn ${seal.locked ? 'is-on' : ''}`}
            title={seal.locked ? 'Unlock position & size' : 'Lock position & size'}
            onClick={(e) => {
              e.stopPropagation();
              onToggleLocked();
            }}
          >
            {seal.locked ? '🔒' : '🔓'}
          </button>
          <button
            className="icon-btn"
            title="Remove seal"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          >
            ✕
          </button>
        </div>
      </div>
      <div className="seal-card-thumb">{url && <img src={url} alt={seal.name} />}</div>
      <div className="seal-card-name" title={seal.name}>
        {seal.name}
      </div>
    </div>
  );
}

function Controls({ placement, disabled, onChange }) {
  const set = (key) => (e) => onChange(key, Number(e.target.value));
  return (
    <div className={`controls ${disabled ? 'is-disabled' : ''}`}>
      <label className="control">
        <span>Horizontal</span>
        <input
          type="range"
          min="0"
          max="100"
          value={placement.xPct}
          disabled={disabled}
          onChange={set('xPct')}
        />
      </label>
      <label className="control">
        <span>Vertical</span>
        <input
          type="range"
          min="0"
          max="100"
          value={placement.yPct}
          disabled={disabled}
          onChange={set('yPct')}
        />
      </label>
      <label className="control">
        <span>Size</span>
        <input
          type="range"
          min="4"
          max="60"
          value={placement.sizePct}
          disabled={disabled}
          onChange={set('sizePct')}
        />
      </label>
    </div>
  );
}

// Renders page 1 of the chosen PDF and overlays every enabled seal so the user
// can see placement before generating. Clicking a seal selects it for editing.
function Preview({ pdfBytes, seals, sealUrls, selectedId, onPickSeal }) {
  const canvasRef = useRef(null);
  const [dims, setDims] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask = null;
    (async () => {
      try {
        const doc = await pdfjsLib.getDocument({ data: pdfBytes.slice(0) }).promise;
        const pdfPage = await doc.getPage(1);
        if (cancelled) return;
        const viewport = pdfPage.getViewport({ scale: 1 });
        const maxW = 480;
        const scale = Math.min(maxW / viewport.width, 1.4);
        const scaled = pdfPage.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = scaled.width;
        canvas.height = scaled.height;
        renderTask = pdfPage.render({
          canvasContext: canvas.getContext('2d'),
          viewport: scaled,
        });
        await renderTask.promise;
        if (!cancelled) setDims({ w: scaled.width, h: scaled.height });
      } catch {
        /* preview is best-effort */
      }
    })();
    return () => {
      cancelled = true;
      if (renderTask) renderTask.cancel();
    };
  }, [pdfBytes]);

  return (
    <div className="preview">
      <div className="preview-stage" style={dims ? { width: dims.w } : undefined}>
        <canvas ref={canvasRef} className="preview-canvas" />
        {dims &&
          seals.map((s) => (
            <img
              key={s.id}
              className={`preview-seal ${s.id === selectedId ? 'is-selected' : ''}`}
              src={sealUrls[s.id]}
              alt=""
              onClick={() => onPickSeal(s.id)}
              style={{
                left: `${s.placement.xPct}%`,
                top: `${s.placement.yPct}%`,
                width: `${s.placement.sizePct}%`,
                transform: 'translate(-50%, -50%)',
              }}
            />
          ))}
      </div>
      <p className="muted preview-hint">
        Preview of page 1 — seals land the same on every page. Tap a seal to adjust it.
      </p>
    </div>
  );
}
