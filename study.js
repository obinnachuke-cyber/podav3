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

  // Full-size viewer for the grid: arrows or swipe-free buttons, Esc to close.
  function bindLightbox(grid, images, captions) {
    if (!grid || !images.length) return;
    let at = 0;
    let box = null;

    function show(i) {
      at = (i + images.length) % images.length;
      box.querySelector("img").src = images[at];
      box.querySelector(".lb__cap").textContent = captions[at] || "";
      box.querySelector(".lb__count").textContent = `${at + 1} / ${images.length}`;
    }
    function close() {
      if (!box) return;
      document.removeEventListener("keydown", onKey);
      box.remove();
      box = null;
      document.body.style.overflow = "";
    }
    function onKey(e) {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") show(at + 1);
      else if (e.key === "ArrowLeft") show(at - 1);
    }
    function open(i) {
      box = document.createElement("div");
      box.className = "lb";
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");
      box.innerHTML = `
        <button type="button" class="lb__close" aria-label="Close">×</button>
        ${images.length > 1 ? `<button type="button" class="lb__nav lb__nav--prev" aria-label="Previous">‹</button>
        <button type="button" class="lb__nav lb__nav--next" aria-label="Next">›</button>` : ""}
        <img alt="" />
        <p class="lb__cap"></p><p class="lb__count"></p>`;
      box.addEventListener("click", e => {
        if (e.target.closest(".lb__close") || e.target === box) close();
        else if (e.target.closest(".lb__nav--prev")) show(at - 1);
        else if (e.target.closest(".lb__nav--next")) show(at + 1);
      });
      document.body.appendChild(box);
      document.body.style.overflow = "hidden";
      document.addEventListener("keydown", onKey);
      show(i);
    }
    grid.addEventListener("click", e => {
      const item = e.target.closest(".sg__item");
      if (item) open(Number(item.dataset.i));
    });
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

    // A compact grid of small crops. Tapping one opens the full image.
    const figures = images.length ? `
      <div class="sg" id="studyGrid">${images.map((url, i) => `
        <figure class="sg__cell">
          <button type="button" class="sg__item" data-i="${i}" aria-label="View image ${i + 1} of ${images.length}">
            <img src="${esc(url)}" alt="" loading="lazy" decoding="async" />
          </button>
          ${captions[i] ? `<figcaption>${esc(captions[i])}</figcaption>` : ""}
        </figure>`).join("")}
      </div>` : "";

    // An Index entry is a brand or reference poda picked. It names where the
    // images come from, links to the Instagram, and says plainly that poda
    // does not sell it or vouch for it.
    const isEntry = !!study.kind;
    const handle = /^[A-Za-z0-9._]{1,30}$/.test(study.instagram || "") ? study.instagram : "";
    // The counted link only works for a published entry, because the redirect
    // reads the public entry. A draft, which only the admin can open, links
    // straight to the Instagram so it can be checked before publishing.
    const goHref = handle
      ? (study.slug && study.status === "published" ? `/go/${encodeURIComponent(study.slug)}` : `https://www.instagram.com/${handle}/`)
      : "";
    const credit = String(study.credit || "").trim() || (handle ? `@${handle}` : "");
    const contact = window.PODA_CONTACT_EMAIL || "";
    const removeHref = contact
      ? `mailto:${contact}?subject=${encodeURIComponent(`Removal request: ${study.title || "Index entry"}`)}`
      : "";
    const entryExtras = isEntry ? `
        <footer class="sae">
          <div class="sae__row">
            ${goHref ? `<a class="sae__ig" href="${esc(goHref)}" target="_blank" rel="noopener">@${esc(handle)} <span>on Instagram ↗</span></a>` : ""}
            ${credit ? `<p class="sae__credit">Images: ${esc(credit)}</p>` : ""}
          </div>
          <div class="sae__join">
            <p class="sae__join-title">Market Notes by email</p>
            <p class="sae__join-sub">Short notes on what is moving in fashion and retail.</p>
            <div data-poda-subscribe="index"></div>
          </div>
          <p class="sae__fine">poda features brands it finds interesting. It does not sell their pieces and is not affiliated with them unless it says so.${removeHref ? ` Own this work? <a href="${esc(removeHref)}">Ask us to remove it</a>.` : ""}</p>
        </footer>` : "";

    const related = [];
    if (study.relatedNoteId) related.push(`<a class="product-link" href="note.html?id=${encodeURIComponent(study.relatedNoteId)}">Read the related note →</a>`);
    if (study.relatedDropId) related.push(`<a class="product-link" href="folder.html?id=${encodeURIComponent(study.relatedDropId)}">Open the folder →</a>`);

    page.innerHTML = `
      <article class="study-article">
        <header class="study-article__header">
          <p class="study-article__eyebrow">
            <a href="lookbook.html">← Index</a>
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
    bindLightbox(page.querySelector("#studyGrid"), images, captions);
    const slot = page.querySelector("[data-poda-subscribe]");
    if (slot && window.PodaSubscribe && typeof window.PodaSubscribe.mount === "function") {
      // Take the attribute off so the page's own auto-mount does not add a second form.
      slot.removeAttribute("data-poda-subscribe");
      window.PodaSubscribe.mount(slot, { source: "index", compact: true });
    }
  }

  load();
})();
