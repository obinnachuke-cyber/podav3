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

    // An entry opens at /index/<name> or at study.html?id=<id>.
    const fromPath = window.location.pathname.match(/^\/index\/([^/]+)/);
    const key = fromPath ? decodeURIComponent(fromPath[1]) : new URLSearchParams(window.location.search).get("id");
    if (!key) { status.textContent = "Study not found."; return; }

    let studies = [];
    try { studies = await window.PodaDB.getStudies(); } catch (e) { status.textContent = "Could not load."; return; }
    const study = studies.find(s => s.id === key || (s.slug && s.slug === key));
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

    // An Index entry is a brand or reference poda picked. It names where the
    // images come from, links to the Instagram, and says plainly that poda
    // does not sell it or vouch for it.
    const isEntry = !!study.kind;
    const handle = /^[A-Za-z0-9._]{1,30}$/.test(study.instagram || "") ? study.instagram : "";
    const goHref = handle ? (study.slug ? `/go/${encodeURIComponent(study.slug)}` : `https://www.instagram.com/${handle}/`) : "";
    const credit = String(study.credit || "").trim() || (handle ? `@${handle}` : "");
    const contact = window.PODA_CONTACT_EMAIL || "";
    const removeHref = contact
      ? `mailto:${contact}?subject=${encodeURIComponent(`Removal request: ${study.title || "Index entry"}`)}`
      : "";
    const entryExtras = isEntry ? `
        <div class="study-article__entry">
          ${goHref ? `<a class="product-buy" href="${esc(goHref)}" target="_blank" rel="noopener">@${esc(handle)} on Instagram ↗</a>` : ""}
          ${credit ? `<p class="study-article__credit">Images: ${esc(credit)}</p>` : ""}
          <p class="study-article__fine">poda features brands it finds interesting. It does not sell their pieces, and is not affiliated with them unless it says so.${removeHref ? ` Own this work? <a href="${esc(removeHref)}">Ask us to remove it</a>.` : ""}</p>
          <div class="study-article__subscribe" data-poda-subscribe="index"></div>
        </div>` : "";

    const related = [];
    if (study.relatedNoteId) related.push(`<a class="product-link" href="note.html?id=${encodeURIComponent(study.relatedNoteId)}">Read the related note →</a>`);
    if (study.relatedDropId) related.push(`<a class="product-link" href="folder.html?id=${encodeURIComponent(study.relatedDropId)}">Open the folder →</a>`);

    page.innerHTML = `
      <article class="study-article">
        <header class="study-article__header">
          <p class="study-article__eyebrow">
            <a href="lookbook.html">← Lookbook</a>
            <span>${isEntry ? (study.kind === "reference" ? "Reference" : "Brand") : (study.studyNumber ? `Vol. ${esc(String(study.studyNumber).padStart(2, "0"))}` : "Visual Study")}${date ? ` · ${esc(date)}` : ""}</span>
          </p>
          <h1 class="study-article__title">${esc(study.title || "Untitled study")}</h1>
          ${study.framing ? `<p class="study-article__framing">${esc(study.framing)}</p>` : ""}
        </header>
        <div class="study-article__body">
          ${figures || `<p class="status-message">Imagery for this study is being prepared.</p>`}
        </div>
        ${entryExtras}
        ${related.length ? `<div class="study-article__related">${related.join("")}</div>` : ""}
      </article>`;
    const slot = page.querySelector("[data-poda-subscribe]");
    if (slot && window.PodaSubscribe && typeof window.PodaSubscribe.mount === "function") {
      // Take the attribute off so the page's own auto-mount does not add a second form.
      slot.removeAttribute("data-poda-subscribe");
      window.PodaSubscribe.mount(slot, { source: "index", compact: false });
    }
  }

  load();
})();
