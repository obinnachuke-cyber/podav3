/* ============================================================
   folders.js — the public release-folder experience.

   One folder = one biweekly edition (an `edits` row — see
   MARKETPLACE_SETUP.md). It fills up over two weeks: a Market Note,
   imagery, short updates, and finally the product drop when the folder
   goes 'live'.

   One file, two pages, detected by the element present:
     • #folderGrid  (index.html)  — the desktop of folders
     • #folderPage  (folder.html) — what's inside one folder

   Requires: supabase.min.js, supabase-config.js, db.js, marketplace-db.js
   ============================================================ */
(function () {
  "use strict";

  // The ORIGINAL horizontal folder art — both share one 1024×1024 canvas,
  // so swapping between them never shifts the folder.
  const ART = {
    base:   "assets/folders/poda-folder.svg",
    unread: "assets/folders/poda-folder-unread.svg"
  };
  const SEEN_KEY = "poda:folderSeen:v1";
  const SELLER_LABELS = {
    consignor: "Private closet",
    brand:     "Independent brand",
    boutique:  "Boutique",
    poda:      "poda"
  };

  /* —— Small helpers —— */
  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }

  function market() {
    return window.PodaMarketplace;
  }

  function folderName(folder) {
    return folder.number == null
      ? "Folder"
      : `Folder ${String(folder.number).padStart(3, "0")}`;
  }

  function fmtDate(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function fmtDateTime(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " · " +
      d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }

  // Folder lifecycle in visitor-facing words. 'scheduled' is the open,
  // accumulating phase; 'live' is the drop; 'archived' is a closed edition.
  function stateInfo(folder) {
    if (folder.status === "live") return { mod: "live", label: "Drop is live" };
    if (folder.status === "archived") return { mod: "closed", label: "Closed" };
    const due = folder.publish_at ? Date.parse(folder.publish_at) : NaN;
    if (Number.isFinite(due) && due > Date.now()) {
      return { mod: "open", label: `Open · drop ${fmtDate(folder.publish_at)}` };
    }
    return { mod: "open", label: "Open" };
  }

  /* —— "New material" tracking. A single localStorage map of
     folderId → last-opened time. Storage can be blocked (private mode,
     embedded browsers), in which case we show no dots rather than a dot
     that can never clear. —— */
  function readSeen() {
    try {
      const raw = localStorage.getItem(SEEN_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) {
      return null; // storage unavailable
    }
  }

  function markSeen(folderId) {
    try {
      const seen = readSeen();
      if (!seen) return;
      seen[folderId] = new Date().toISOString();
      localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
    } catch (e) { /* non-fatal */ }
  }

  function isUnread(folder, activity, seen) {
    if (!seen || folder.status === "archived") return false;
    const opened = seen[folder.id] ? Date.parse(seen[folder.id]) : NaN;
    if (!Number.isFinite(opened)) return true; // never opened
    const latest = Math.max(
      Date.parse(folder.published_at) || 0,
      activity[folder.id] || 0
    );
    return latest > opened;
  }

  /* —— The folder art. The SVG canvas is square with generous padding, so a
     fixed-aspect window crops it to the folder (and the dot) — the asset
     files themselves stay untouched. —— */
  function folderArt(unread) {
    return `<span class="folder-art${unread ? " folder-art--unread" : ""}" aria-hidden="true">` +
      `<img src="${unread ? ART.unread : ART.base}" alt="" decoding="async" /></span>`;
  }

  /* ============================================================
     Homepage — the desktop of folders
     ============================================================ */
  function folderTile(folder, unread) {
    const name = folderName(folder);
    const state = stateInfo(folder);
    const aria = `${name}, ${folder.title}${unread ? " — new material" : ""}`;
    return `
      <a class="folder-tile" href="folder.html?id=${encodeURIComponent(folder.id)}" aria-label="${esc(aria)}">
        ${folderArt(unread)}
        <span class="folder-tile__no">${esc(name)}</span>
        <span class="folder-tile__label">${esc(folder.title)}</span>
        <span class="folder-tile__state folder-tile__state--${state.mod}">${esc(state.label)}</span>
      </a>`;
  }

  async function bootGrid(mount) {
    let folders, activity;
    try {
      [folders, activity] = await Promise.all([
        market().getPublicFolders(),
        market().getPublicActivity()
      ]);
    } catch (error) {
      console.error("Could not load folders:", error);
      mount.innerHTML = `<p class="status-message">Could not load the folders — try refreshing.</p>`;
      return;
    }

    if (!folders.length) {
      // Nothing published yet — a quiet, non-clickable placeholder so the
      // desktop never looks broken.
      mount.innerHTML = `
        <div class="folder-tile folder-tile--empty">
          ${folderArt(false)}
          <span class="folder-tile__no">Folder 001</span>
          <span class="folder-tile__label">Opening soon</span>
        </div>`;
      return;
    }

    const seen = readSeen();
    mount.innerHTML = folders
      .map(f => folderTile(f, isUnread(f, activity, seen)))
      .join("");
  }

  /* ============================================================
     Folder page
     ============================================================ */
  function noteRow(note) {
    const thumb = note.coverImage
      ? `<img src="${esc(note.coverImage)}" alt="" loading="lazy" decoding="async" />`
      : `<div class="inbox-thumb__placeholder"></div>`;
    const cat = String(note.category || "").toLowerCase();
    const tag = cat ? `<span class="inbox-row__tag inbox-row__tag--${esc(cat)}">${esc(cat.toUpperCase())}</span>` : "";
    const date = note.publishedAt || note.createdAt;
    return `
      <a class="inbox-row" href="note.html?id=${encodeURIComponent(note.id)}">
        <div class="inbox-thumb">${thumb}</div>
        <div class="inbox-row__body">
          <span class="inbox-row__from">${note.issueNumber ? `No. ${esc(String(note.issueNumber))}` : "poda"} ${tag}</span>
          <span class="inbox-row__title">${esc(note.title || "Untitled")}</span>
          ${note.subtitle ? `<span class="inbox-row__preview">${esc(note.subtitle)}</span>` : ""}
        </div>
        <span class="inbox-row__date">${esc(date ? fmtDate(date) : "")}</span>
      </a>`;
  }

  function studyCard(study) {
    const images = Array.isArray(study.images) ? study.images : [];
    const url = study.coverImage || images[0] || "";
    const img = url
      ? `<img src="${esc(url)}" alt="" loading="lazy" decoding="async" />`
      : `<div class="image-placeholder">poda</div>`;
    return `
      <a class="study-card" href="study.html?id=${encodeURIComponent(study.id)}">
        <div class="study-card__image">${img}</div>
        <div class="study-card__meta">
          <span class="study-card__num">${images.length} image${images.length === 1 ? "" : "s"}</span>
          <h3 class="study-card__title">${esc(study.title || "Untitled")}</h3>
          ${study.framing ? `<p class="study-card__framing">${esc(study.framing)}</p>` : ""}
        </div>
      </a>`;
  }

  function updateItem(update) {
    const image = update.image_path
      ? `<img class="folder-update__image" src="${esc(market().noteMediaUrl(update.image_path))}" alt="" loading="lazy" decoding="async" />`
      : "";
    return `
      <li class="folder-update">
        <span class="folder-update__meta">poda · ${esc(fmtDateTime(update.created_at))}</span>
        <p class="folder-update__body">${esc(update.body)}</p>
        ${image}
      </li>`;
  }

  function formatPrice(product) {
    if (product.price_cents == null) return "";
    return new Intl.NumberFormat("en-US", {
      style: "currency", currency: product.currency || "USD", maximumFractionDigits: 0
    }).format(product.price_cents / 100);
  }

  function sellerLabel(product) {
    return product.supplier_name || SELLER_LABELS[product.supplier_type] || "";
  }

  function inquiryHref(folder, product) {
    const email = window.PODA_CONTACT_EMAIL || "";
    const what = [product.brand, product.title].filter(Boolean).join(" ");
    if (!email) return `https://instagram.com/${window.PODA_INSTAGRAM || "podacapital"}`;
    const subject = `poda — ${folderName(folder)}: ${what}`;
    const body = `Hi poda,\n\nI'm interested in this piece from ${folderName(folder)}:\n• ${what}\n` +
      (formatPrice(product) ? `• ${formatPrice(product)}\n` : "") + `\nIs it still available?\n\nThanks!`;
    return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  function productCard(folder, product) {
    const available = product.is_available === true;
    const path = Array.isArray(product.image_paths) ? product.image_paths[0] : "";
    const img = path
      ? `<img src="${esc(market().productImageUrl(path))}" alt="${esc(product.title || "")}" loading="lazy" decoding="async" />`
      : `<div class="image-placeholder">poda</div>`;
    const details = formatPrice(product);
    const seller = sellerLabel(product);
    return `
      <article class="catalog-card${available ? "" : " catalog-card--sold"}">
        <div class="catalog-card__image${path ? "" : " catalog-card__image--empty"}${available ? "" : " catalog-card__image--sold"}">
          ${img}
          <span class="catalog-card__status catalog-card__status--${available ? "available" : "sold"}">${available ? "Available" : "Unavailable"}</span>
        </div>
        <div class="catalog-card__meta">
          <div class="catalog-card__meta-row">
            <span class="catalog-card__brand">${esc(product.brand || seller)}</span>
            ${product.brand && seller ? `<span class="catalog-card__id">${esc(seller)}</span>` : ""}
          </div>
          <h3 class="catalog-card__name">${esc(product.title || "Untitled")}</h3>
          ${details ? `<p class="catalog-card__details">${esc(details)}</p>` : ""}
          ${available ? `<a class="product-link folder-inquire" href="${esc(inquiryHref(folder, product))}">Inquire →</a>` : ""}
        </div>
      </article>`;
  }

  // The drop is the culmination: until the folder is 'live' the product
  // grid is not just hidden by the UI — the database doesn't return it.
  function dropSection(folder, products) {
    if (folder.status === "live") {
      return products.length
        ? `<div class="items-grid">${products.map(p => productCard(folder, p)).join("")}</div>`
        : `<p class="status-message">The drop is live — pieces are being placed.</p>`;
    }
    if (folder.status === "archived") {
      return `<p class="folder-locked">This folder is closed. Its drop has ended.</p>`;
    }
    const due = folder.publish_at ? Date.parse(folder.publish_at) : NaN;
    const when = Number.isFinite(due) && due > Date.now()
      ? `The drop opens ${fmtDate(folder.publish_at)}.`
      : "The drop opens at the end of this folder's two weeks.";
    return `
      <div class="folder-locked">
        <span class="folder-locked__label">Locked</span>
        <p>${esc(when)} Pieces from invited sellers, brands, boutiques and private closets will appear here.</p>
      </div>`;
  }

  function section(id, number, title, bodyHTML, countText) {
    return `
      <section class="folder-section" id="${id}">
        <div class="section-bar">
          <span class="section-bar__label">${String(number).padStart(2, "0")}</span>
          <span class="section-bar__title">${esc(title)}</span>
          ${countText ? `<span class="folder-section__count">${esc(countText)}</span>` : ""}
        </div>
        ${bodyHTML}
      </section>`;
  }

  function renderFolder(mount, folder, content) {
    const state = stateInfo(folder);
    const notes = content.notes.slice().sort((a, b) =>
      (Date.parse(b.publishedAt || b.createdAt) || 0) - (Date.parse(a.publishedAt || a.createdAt) || 0));
    const { studies, updates, products } = content;

    // Contents list: only sections that have material, plus the drop.
    const parts = [];
    if (notes.length) parts.push({
      id: "notes", title: notes.length === 1 ? "Market Note" : "Market Notes",
      count: String(notes.length),
      html: `<div class="inbox-list">${notes.map(noteRow).join("")}</div>`
    });
    if (studies.length) parts.push({
      id: "imagery", title: "Imagery", count: String(studies.length),
      html: `<div class="study-grid">${studies.map(studyCard).join("")}</div>`
    });
    if (updates.length) parts.push({
      id: "updates", title: "Updates", count: String(updates.length),
      html: `<ul class="folder-updates">${updates.map(updateItem).join("")}</ul>`
    });
    parts.push({
      id: "drop", title: "The Drop", count: state.mod === "live" ? String(products.length) : state.label,
      html: dropSection(folder, products)
    });

    const index = parts.map((p, i) =>
      `<a href="#${p.id}"><span>${String(i + 1).padStart(2, "0")}</span>${esc(p.title)}<em>${esc(p.count)}</em></a>`
    ).join("");

    const justOpened = parts.length === 1 && state.mod === "open"
      ? `<p class="status-message">This folder was just opened. Material arrives over the next two weeks — check back.</p>`
      : "";

    mount.innerHTML = `
      <article class="folder-page">
        <a class="folder-page__back" href="index.html">← All folders</a>
        <header class="folder-head">
          ${folderArt(false)}
          <div class="folder-head__text">
            <p class="folder-head__no">${esc(folderName(folder).toUpperCase())}
              <span class="folder-state folder-state--${state.mod}">${esc(state.label)}</span></p>
            <h1 class="folder-head__title">${esc(folder.title)}</h1>
            ${folder.standfirst ? `<p class="folder-head__standfirst">${esc(folder.standfirst)}</p>` : ""}
          </div>
        </header>
        <nav class="folder-index" aria-label="Contents">${index}</nav>
        ${justOpened}
        ${parts.map((p, i) => section(p.id, i + 1, p.title, p.html, p.count)).join("")}
      </article>`;
  }

  async function bootFolder(mount) {
    const id = new URLSearchParams(window.location.search).get("id");
    const notFound = message => {
      mount.innerHTML = `
        <div class="product-error">
          <p>${esc(message)}</p>
          <a class="product-link" href="index.html">← All folders</a>
        </div>`;
    };
    if (!id) { notFound("This folder isn't available."); return; }

    let folder;
    try {
      folder = await market().getPublicFolder(id);
    } catch (error) {
      console.error("Could not load folder:", error);
      notFound("Could not load this folder — try refreshing.");
      return;
    }
    if (!folder) { notFound("This folder isn't available."); return; }

    document.title = `${folderName(folder)} — ${folder.title} — poda`;
    const content = await market().getPublicFolderContent(folder.id);
    renderFolder(mount, folder, content);
    markSeen(folder.id);
  }

  /* —— Boot —— */
  function start() {
    const grid = document.getElementById("folderGrid");
    const page = document.getElementById("folderPage");
    if (!grid && !page) return;

    if (!window.PodaDB || !window.PodaDB.isConfigured || !market()) {
      const target = grid || page;
      target.innerHTML = `<p class="status-message">Folders are unavailable right now.</p>`;
      return;
    }
    if (grid) bootGrid(grid);
    if (page) bootFolder(page);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
