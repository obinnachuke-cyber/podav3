/* ============================================================
   home.js — editorial homepage modules
   Defines renderHome(items, drops), which script.js calls after
   inventory loads. Reuses helpers/globals from script.js
   (escapeHTML, pieceCard, latestDrop, dropNo, formatMoney…).
   Also fetches the featured Market Note + Visual Study directly.
   ============================================================ */
(function () {
  "use strict";

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el && value) el.textContent = value;
  }

  function dropStatusLabel(rec) {
    const s = (rec && rec.status) || "In Assembly";
    return `STATUS: ${String(s).toUpperCase()}`;
  }

  // —— A/B: premise + thesis, overridden by the current drop record ——
  function renderPremise(live, drops) {
    const current = typeof latestDrop === "function" ? latestDrop(live) : "";
    const rec = drops.find(d => String(d.number || "").trim() === String(current).trim());

    const dropNumber = rec && rec.number ? `DROP ${rec.number}` : (current ? `DROP ${current}` : "DROP 001");
    setText("premiseDrop", dropNumber);
    setText("headerStatus", `${dropNumber} · ${(rec && rec.status ? rec.status : "In Assembly").toUpperCase()}`);
    setText("premiseStatus", dropStatusLabel(rec));
    if (rec && rec.question) setText("premiseQuestion", rec.question);
    if (rec && rec.thesis)   setText("thesisStatement", rec.thesis);
  }

  // —— E: featured products (up to 6 from the current drop) ——
  function renderFeaturedProducts(live) {
    const grid = document.getElementById("homeEditGrid");
    if (!grid) return;

    if (!live.length) {
      grid.innerHTML = `<p class="status-message">The next drop is in assembly. <a class="product-link" href="source.html">Open a sourcing request →</a></p>`;
      return;
    }
    const current = typeof latestDrop === "function" ? latestDrop(live) : "";
    const ordered = [
      ...live.filter(i => dropNo(i) === current),
      ...live.filter(i => dropNo(i) !== current)
    ].slice(0, 6);

    grid.innerHTML = ordered.map(pieceCard).join("");
    if (typeof bindImageErrorHandlers === "function") bindImageErrorHandlers(grid);
  }

  // —— C: featured Market Note ——
  async function renderFeaturedNote() {
    const section = document.getElementById("featuredNote");
    const inner = document.getElementById("featuredNoteInner");
    if (!section || !inner) return;

    let notes = [];
    try { notes = await window.PodaDB.getNotes(); } catch (e) { return; }
    const published = notes.filter(n => n.status === "published");
    if (!published.length) return;

    // Prefer an explicitly featured note; else the newest.
    const note = published.find(n => n.featured) || published[0];
    const date = note.publishedAt
      ? new Date(note.publishedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
      : "";
    const issue = note.issueNumber ? `No. ${escapeHTML(String(note.issueNumber))}` : "Market Note";
    const cover = note.coverImage
      ? `<a class="feature-note__media" href="note.html?id=${encodeURIComponent(note.id)}"><img src="${escapeHTML(note.coverImage)}" alt="" loading="lazy" /></a>`
      : "";

    inner.innerHTML = `
      ${cover}
      <div class="feature-note__text">
        <p class="feature-note__meta"><span>${issue}</span>${note.category ? `<span>${escapeHTML(String(note.category).toUpperCase())}</span>` : ""}${date ? `<span>${escapeHTML(date)}</span>` : ""}</p>
        <h3 class="feature-note__title"><a href="note.html?id=${encodeURIComponent(note.id)}">${escapeHTML(note.title || "Untitled")}</a></h3>
        ${note.subtitle ? `<p class="feature-note__abstract">${escapeHTML(note.subtitle)}</p>` : ""}
        <a class="product-link" href="note.html?id=${encodeURIComponent(note.id)}">Read the note →</a>
      </div>`;
    section.hidden = false;
  }

  // —— B: thesis body = first 75 words of the current note ——
  async function renderThesisFromNote() {
    const el = document.getElementById("thesisBody");
    if (!el) return;

    let notes = [];
    try { notes = await window.PodaDB.getNotes(); } catch (e) { return; }
    const published = notes.filter(n => n.status === "published");
    if (!published.length) return;

    const note = published.find(n => n.featured) || published[0];
    const body = String(note.body || "").trim();
    if (!body) return;

    const words = body.split(/\s+/);
    const excerpt = words.slice(0, 75).join(" ") + (words.length > 75 ? "…" : "");
    el.textContent = excerpt;
  }

  // —— D: featured Visual Study ——
  async function renderFeaturedStudy() {
    const section = document.getElementById("featuredStudy");
    const inner = document.getElementById("featuredStudyInner");
    if (!section || !inner || !window.PodaDB.getStudies) return;

    let studies = [];
    try { studies = await window.PodaDB.getStudies(); } catch (e) { return; }
    if (!studies.length) return;

    const study = studies.find(s => s.featured) || studies[0];
    const imgs = (study.images || []).slice(0, 3);
    const grid = imgs.length
      ? `<div class="feature-study__grid">${imgs.map(u => `<div class="feature-study__cell"><img src="${escapeHTML(u)}" alt="" loading="lazy" /></div>`).join("")}</div>`
      : (study.coverImage ? `<div class="feature-study__grid"><div class="feature-study__cell"><img src="${escapeHTML(study.coverImage)}" alt="" loading="lazy" /></div></div>` : "");

    inner.innerHTML = `
      <div class="feature-study__text">
        <p class="feature-study__meta">${study.studyNumber ? `Study ${escapeHTML(String(study.studyNumber))}` : "Visual Study"}</p>
        <h3 class="feature-study__title"><a href="study.html?id=${encodeURIComponent(study.id)}">${escapeHTML(study.title || "Untitled study")}</a></h3>
        ${study.framing ? `<p class="feature-study__framing">${escapeHTML(study.framing)}</p>` : ""}
        <a class="product-link" href="study.html?id=${encodeURIComponent(study.id)}">See the full study →</a>
      </div>
      ${grid}`;
    section.hidden = false;
  }

  // Exposed for script.js to call once inventory is loaded.
  window.renderHome = function (items, drops) {
    const live = (items || []).filter(i => i.status === "Live");
    renderPremise(live, drops || []);
    renderFeaturedProducts(live);
    renderThesisFromNote();
    renderFeaturedNote();
    renderFeaturedStudy();
  };
})();
