/* ============================================================
   study.js — Visual Study detail
   Renders a controlled editorial rhythm: full-bleed images,
   optional captions, and links back to the related Market Note
   and drop (The Edit).
   ============================================================ */
(function () {
  "use strict";

  function esc(v) {
    return String(v ?? "")
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }

  async function load() {
    const page = document.getElementById("studyPage");
    const status = document.getElementById("studyStatus");
    const topbar = document.getElementById("studyTopbar");

    const id = new URLSearchParams(window.location.search).get("id");
    if (!id) { status.textContent = "Study not found."; return; }

    let studies = [];
    try { studies = await window.PodaDB.getStudies(); } catch (e) { status.textContent = "Could not load."; return; }
    const study = studies.find(s => s.id === id);
    if (!study) { status.textContent = "Study not found."; return; }

    document.title = `${study.title || "Visual Study"} — poda`;
    if (topbar) topbar.textContent = study.title || "Visual Study";

    const date = study.date
      ? new Date(study.date).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
      : "";

    const images = Array.isArray(study.images) ? study.images : [];
    const captions = Array.isArray(study.captions) ? study.captions : [];

    // Alternate rhythm: full-bleed, then a pair, then full-bleed… (brief §10)
    let figures = "";
    for (let i = 0; i < images.length; i++) {
      const cap = captions[i] ? `<figcaption>${esc(captions[i])}</figcaption>` : "";
      // Every 3rd image becomes part of a pair with the next one.
      if (i % 3 === 1 && images[i + 1]) {
        const cap2 = captions[i + 1] ? `<figcaption>${esc(captions[i + 1])}</figcaption>` : "";
        figures += `
          <div class="study-pair">
            <figure class="study-figure"><img src="${esc(images[i])}" alt="" loading="lazy" />${cap}</figure>
            <figure class="study-figure"><img src="${esc(images[i + 1])}" alt="" loading="lazy" />${cap2}</figure>
          </div>`;
        i++; // consumed the next one
      } else {
        figures += `<figure class="study-figure study-figure--full"><img src="${esc(images[i])}" alt="" loading="lazy" />${cap}</figure>`;
      }
    }

    const related = [];
    if (study.relatedNoteId) related.push(`<a class="product-link" href="note.html?id=${encodeURIComponent(study.relatedNoteId)}">Read the related note →</a>`);
    if (study.relatedDropId) related.push(`<a class="product-link" href="drop.html">See the related drop →</a>`);

    page.innerHTML = `
      <article class="study-article">
        <header class="study-article__header">
          <p class="study-article__eyebrow">
            <a href="lookbook.html">← Lookbook</a>
            <span>${study.studyNumber ? `Study ${esc(String(study.studyNumber))}` : "Visual Study"}${date ? ` · ${esc(date)}` : ""}</span>
          </p>
          <h1 class="study-article__title">${esc(study.title || "Untitled study")}</h1>
          ${study.framing ? `<p class="study-article__framing">${esc(study.framing)}</p>` : ""}
        </header>
        <div class="study-article__body">
          ${figures || `<p class="status-message">Imagery for this study is being prepared.</p>`}
        </div>
        ${related.length ? `<div class="study-article__related">${related.join("")}</div>` : ""}
      </article>`;
  }

  load();
})();
