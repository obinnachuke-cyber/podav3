/* ============================================================
   lookbook.js — Visual Studies index
   Reads the studies table and renders a study-card grid.
   ============================================================ */
(function () {
  "use strict";

  function esc(v) {
    return String(v ?? "")
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }

  function studyDate(s) {
    if (!s.date) return "";
    return new Date(s.date).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }

  function cover(s) {
    const url = s.coverImage || (Array.isArray(s.images) && s.images[0]) || "";
    return url
      ? `<img src="${esc(url)}" alt="" loading="lazy" decoding="async" />`
      : `<div class="image-placeholder">No image</div>`;
  }

  function studyCard(s) {
    const href = `study.html?id=${encodeURIComponent(s.id)}`;
    return `
      <a class="study-card" href="${href}">
        <div class="study-card__image">${cover(s)}</div>
        <div class="study-card__meta">
          <span class="study-card__num">${s.studyNumber ? `Study ${esc(String(s.studyNumber))}` : "Visual Study"}${studyDate(s) ? ` · ${esc(studyDate(s))}` : ""}</span>
          <h2 class="study-card__title">${esc(s.title || "Untitled study")}</h2>
          ${s.framing ? `<p class="study-card__framing">${esc(s.framing)}</p>` : ""}
        </div>
      </a>`;
  }

  async function load() {
    const grid = document.getElementById("lookbookGrid");
    const status = document.getElementById("lookbookStatus");
    if (!grid) return;

    let studies = [];
    try {
      studies = await window.PodaDB.getStudies();
    } catch (e) {
      if (status) status.textContent = "Could not load studies — try refreshing.";
      return;
    }

    if (!studies.length) {
      grid.innerHTML = `<div class="empty-x-box">X</div>`;
      return;
    }
    grid.innerHTML = studies.map(studyCard).join("");
  }

  load();
})();
