/* ============================================================
   folders.js — the public release-folder experience.

   One release = one biweekly folder (an `edits` row). It fills up over two
   weeks (Market Note, imagery, updates) and its products appear in Shop at
   the scheduled drop time.

   Whether a drop is open is decided by the DATABASE clock: the
   public_releases / public_products views only return a release's products
   once its drop time has passed (or it was manually launched). Nothing in
   this file is a gate — the JavaScript below only displays what the database
   returned, and re-asks at the moment a drop is due.

   One file, several pages, detected by the element present:
     • #homeFolders (retired)       — the old folder-desktop homepage; no page uses it now
     • #shopPage    (index.html)   — the release currently in Shop; the Shop is the homepage
     • #folderPage  (folder.html)  — one release: the drop with its Feed, or the countdown and Feed
     • #archiveGrid (archive.html) — past releases
   The admin reuses renderFolder() for its private preview.

   Requires: supabase.min.js, supabase-config.js, db.js, marketplace-db.js
   (tz.js optional: drop times then show in the release's own timezone)
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
  const MAX_TIMEOUT = 2147483000; // setTimeout's ceiling (~24.8 days)

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

  // "Nov 6, 9:00 AM EST" — in the release's own timezone when we know it.
  function fmtDrop(folder) {
    if (!folder.publish_at) return "";
    if (window.PodaTZ) return window.PodaTZ.formatInZone(folder.publish_at, folder.drop_timezone, true);
    return fmtDateTime(folder.publish_at);
  }

  // When this release's drop happened / will happen (ms), or NaN.
  function dropMoment(folder) {
    return Date.parse(folder.launched_at || folder.publish_at || "");
  }

  // The server clock minus this browser's clock, from a fresh response.
  function clockSkew(rows) {
    const server = rows && rows[0] ? Date.parse(rows[0].server_now) : NaN;
    return Number.isFinite(server) ? server - Date.now() : 0;
  }

  // Release lifecycle in visitor-facing words.
  function stateInfo(folder) {
    if (folder.status === "archived") return { mod: "closed", label: "Closed" };
    if (folder.drop_open) {
      return folder.is_shop
        ? { mod: "live", label: "In Shop now" }
        : { mod: "closed", label: "Dropped" };
    }
    const due = folder.publish_at ? Date.parse(folder.publish_at) : NaN;
    if (Number.isFinite(due)) return { mod: "open", label: `Open · drop ${fmtDate(folder.publish_at)}` };
    return { mod: "open", label: "Open" };
  }

  // Past = archived, or dropped and since replaced in Shop by a newer drop.
  function isPast(folder) {
    return folder.status === "archived" || (folder.drop_open && !folder.is_shop);
  }

  /* —— "New material" tracking. A single localStorage map of
     key → last-opened time (key is a folder id, "inbox" or "shop"). Storage
     can be blocked (private mode, embedded browsers); then we show no dots
     rather than a dot that can never clear. —— */
  function readSeen() {
    try {
      const raw = localStorage.getItem(SEEN_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) {
      return null; // storage unavailable
    }
  }

  function markSeen(key) {
    try {
      const seen = readSeen();
      if (!seen) return;
      seen[key] = new Date().toISOString();
      localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
    } catch (e) { /* non-fatal */ }
  }

  // Shop shows a dot when a drop has happened since the visitor last looked.
  function isShopUnread(shop, seen) {
    if (!seen || !shop) return false;
    const opened = seen.shop ? Date.parse(seen.shop) : NaN;
    if (!Number.isFinite(opened)) return true;
    return (dropMoment(shop) || 0) > opened;
  }

  /* —— The folder art. The SVG canvas is square with generous padding, so a
     fixed-aspect window crops it to the folder (and the dot) — the asset
     files themselves stay untouched. —— */
  function folderArt(unread) {
    return `<span class="folder-art${unread ? " folder-art--unread" : ""}" aria-hidden="true">` +
      `<img src="${unread ? ART.unread : ART.base}" alt="" decoding="async" /></span>`;
  }

  // Release date for the Archive: the drop day, with the year.
  function fmtReleaseDate(folder) {
    const t = dropMoment(folder);
    if (!Number.isFinite(t)) return "";
    return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  function folderTile(folder) {
    const name = folderName(folder);
    const released = fmtReleaseDate(folder);
    return `
      <a class="folder-tile" href="folder.html?id=${encodeURIComponent(folder.id)}" aria-label="${esc(`${name}, ${folder.title}`)}">
        ${folderArt(false)}
        <span class="folder-tile__no">${esc(name)}</span>
        <span class="folder-tile__label">${esc(folder.title)}</span>
        ${released ? `<span class="folder-tile__date">${esc(released)}</span>` : ""}
      </a>`;
  }

  // Swap a static tile between the plain and red-dot folder art.
  function setUnread(tile, unread) {
    if (!tile) return;
    const art = tile.querySelector(".folder-art");
    const img = art && art.querySelector("img");
    if (img) img.src = unread ? ART.unread : ART.base;
    if (art) art.classList.toggle("folder-art--unread", unread);
    const name = tile.dataset.name || "";
    tile.setAttribute("aria-label", unread ? `${name} — new material` : name);
    // The 3D folder homepage: raise the red stack on this folder and mark its
    // index entry.
    tile.classList.toggle("is-unread", !!unread);
    const scene = document.querySelector(`[data-scene="${tile.dataset.folder}"]`);
    if (scene) scene.classList.toggle("is-unread", !!unread);
  }

  // Hovering or focusing a folder in the 3D scene lights its index entry, and
  // the other way round, so the two always read as one control.
  function bindFolderScene(root) {
    if (!root) return;
    const targets = root.querySelectorAll("[data-scene], [data-folder]");
    const keyOf = el => el.dataset.scene || el.dataset.folder;
    const set = (key, on) => {
      root.querySelectorAll("[data-scene], [data-folder]").forEach(el => {
        if (keyOf(el) === key) el.classList.toggle("is-active", on);
      });
    };
    targets.forEach(el => {
      const key = keyOf(el);
      el.addEventListener("mouseenter", () => set(key, true));
      el.addEventListener("mouseleave", () => set(key, false));
      el.addEventListener("focus", () => set(key, true));
      el.addEventListener("blur", () => set(key, false));
    });
  }

  // Touch: slide a finger across the row and each folder lifts and fans open
  // as the finger passes over it, with a light buzz where the phone supports
  // it and a slight tilt of the whole row toward the finger. Lifting the
  // finger leaves the last folder raised and its index entry lit; a plain
  // tap still opens a folder straight away. Vertical drags are left to the
  // browser (touch-action: pan-y in style.css), so the page still scrolls.
  function bindFolderDrag(root) {
    const scene = root && root.querySelector(".fscene");
    const row = scene && scene.querySelector(".frow");
    if (!scene || !row) return;

    const DRAG_THRESHOLD = 8;   // px of sideways travel before a touch counts as a drag
    const MAX_TILT = 7;         // degrees the row turns from one edge to the other
    let down = null;            // the touch in progress: { id, x }
    let dragging = false;
    let lastKey = null;
    let swallowClick = false;   // a finished drag must not also open a folder

    const setActive = key => {
      root.querySelectorAll("[data-scene], [data-folder]").forEach(el => {
        const k = el.dataset.scene || el.dataset.folder;
        el.classList.toggle("is-active", !!key && k === key);
      });
    };
    const stackAt = (x, y) => {
      const el = document.elementFromPoint(x, y);
      return el && el.closest ? el.closest(".fstack") : null;
    };
    const tiltTo = x => {
      const box = scene.getBoundingClientRect();
      const ratio = box.width ? (x - box.left) / box.width - 0.5 : 0;
      row.style.setProperty("--tilt", `${Math.max(-0.5, Math.min(0.5, ratio)) * 2 * MAX_TILT}deg`);
    };

    scene.addEventListener("pointerdown", e => {
      if (e.pointerType === "mouse") return;   // mouse keeps the hover behaviour
      down = { id: e.pointerId, x: e.clientX };
      dragging = false;
    });

    scene.addEventListener("pointermove", e => {
      if (!down || e.pointerId !== down.id) return;
      if (!dragging && Math.abs(e.clientX - down.x) < DRAG_THRESHOLD) return;
      dragging = true;
      tiltTo(e.clientX);
      const stack = stackAt(e.clientX, e.clientY);
      const key = stack ? stack.dataset.scene : null;
      if (key && key !== lastKey) {
        lastKey = key;
        setActive(key);
        if (navigator.vibrate) navigator.vibrate(8);
      }
    });

    const end = e => {
      if (!down || e.pointerId !== down.id) return;
      if (dragging) {
        swallowClick = true;
        setTimeout(() => { swallowClick = false; }, 350);
        row.style.setProperty("--tilt", "0deg");
      }
      down = null;
      dragging = false;
    };
    scene.addEventListener("pointerup", end);
    scene.addEventListener("pointercancel", end);

    // Capture phase, so it runs before the folder link's own navigation.
    scene.addEventListener("click", e => {
      if (swallowClick) { e.preventDefault(); e.stopPropagation(); }
    }, true);
  }

  function setSub(tile, text) {
    const el = tile && tile.querySelector(".folder-tile__state");
    if (el && text) el.textContent = text;
  }

  // The next drop still to come: open, scheduled for a future moment.
  function pickUpcoming(folders, nowMs) {
    return folders
      .filter(f => !f.drop_open && f.status !== "archived" && f.publish_at && Date.parse(f.publish_at) > nowMs)
      .sort((a, b) => Date.parse(a.publish_at) - Date.parse(b.publish_at))[0] || null;
  }

  /* ============================================================
     Homepage — five fixed folders (markup lives in index.html so the links
     work with no JS). This only adds live state: what is in Shop, the
     past-release count, and the red dot on Shop and Inbox.
     ============================================================ */
  async function bootHome(root) {
    const tile = key => root.querySelector(`[data-folder="${key}"]`);
    let folders, activity;
    try {
      [folders, activity] = await Promise.all([
        market().getPublicFolders(),
        market().getPublicActivity()
      ]);
    } catch (error) {
      console.error("Could not load folders:", error);
      return; // the static folders still work
    }

    const seen = readSeen();
    const shop = folders.find(f => f.is_shop) || null;
    const upcoming = pickUpcoming(folders, Date.now() + clockSkew(folders));

    setSub(tile("shop"), shop
      ? `${folderName(shop)} · In Shop now`
      : upcoming ? `Next drop ${fmtDate(upcoming.publish_at)}` : "Opening soon");
    setUnread(tile("shop"), isShopUnread(shop, seen));

    const past = folders.filter(isPast).length;
    setSub(tile("archive"), past ? `${past} past release${past === 1 ? "" : "s"}` : "Past releases");

    const inboxOpened = seen && seen.inbox ? Date.parse(seen.inbox) : NaN;
    setUnread(tile("inbox"), !!seen && activity.inbox > 0 && !(inboxOpened >= activity.inbox));
  }

  /* ============================================================
     Archive — past releases
     ============================================================ */
  async function bootArchive(mount) {
    let folders;
    try {
      folders = (await market().getPublicFolders()).filter(isPast);
    } catch (error) {
      console.error("Could not load folders:", error);
      mount.innerHTML = `<p class="status-message">Could not load the archive — try refreshing.</p>`;
      return;
    }
    mount.innerHTML = folders.length
      ? folders.map(folderTile).join("")
      : `<p class="status-message">Nothing archived yet. Finished releases are kept here, complete with their writing, imagery and drop.</p>`;
  }

  /* ============================================================
     Release rendering (shared by the folder page, Shop and admin preview)
     ============================================================ */
  function draftChip(isDraft, text) {
    return isDraft ? `<span class="folder-chip">${esc(text || "Draft")}</span>` : "";
  }

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
          <span class="inbox-row__from">${note.issueNumber ? `No. ${esc(String(note.issueNumber))}` : "poda"} ${tag} ${draftChip(note.status !== "published")}</span>
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
          <span class="study-card__num">${images.length} image${images.length === 1 ? "" : "s"} ${draftChip(study.status !== "published")}</span>
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
        <span class="folder-update__meta">poda · ${esc(fmtDateTime(update.created_at))} ${draftChip(update.published === false)}</span>
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

  // One product card, used identically in Shop, on a release page and in the
  // admin preview, so available / sold / unavailable look the same everywhere.
  function productCard(folder, product, opts) {
    const availability = product.availability || (product.is_available ? "available" : "unavailable");
    const available = availability === "available";
    const labels = { available: "Available", sold: "Sold", unavailable: "Unavailable" };
    const path = Array.isArray(product.image_paths) ? product.image_paths[0] : "";
    const img = path
      ? `<img src="${esc(market().productImageUrl(path))}" alt="${esc(product.title || "")}" loading="lazy" decoding="async" />`
      : `<div class="image-placeholder">poda</div>`;
    const details = formatPrice(product);
    const seller = sellerLabel(product);
    const preview = opts && opts.preview;
    return `
      <article class="catalog-card${available ? "" : " catalog-card--sold"}" data-availability="${esc(availability)}">
        <div class="catalog-card__image${path ? "" : " catalog-card__image--empty"}${available ? "" : " catalog-card__image--sold"}">
          ${img}
          <span class="catalog-card__status catalog-card__status--${available ? "available" : "sold"}">${labels[availability]}</span>
        </div>
        <div class="catalog-card__meta">
          <div class="catalog-card__meta-row">
            <span class="catalog-card__brand">${esc(product.brand || seller)}</span>
            ${product.brand && seller ? `<span class="catalog-card__id">${esc(seller)}</span>` : ""}
          </div>
          <h3 class="catalog-card__name">${esc(product.title || "Untitled")}</h3>
          ${details ? `<p class="catalog-card__details">${esc(details)}</p>` : ""}
          ${available && !preview ? `<a class="product-link folder-inquire" href="${esc(inquiryHref(folder, product))}">Inquire →</a>` : ""}
        </div>
      </article>`;
  }

  // The drop is the culmination: until the database says it is open the
  // products are not returned at all, so this only renders what it was given.
  function dropSection(folder, products, opts) {
    const preview = opts && opts.preview;
    if (preview) {
      const when = folder.publish_at ? `at ${fmtDrop(folder)}` : "when a drop is scheduled";
      return `
        <p class="folder-banner">Preview — these products are private and appear in Shop ${esc(when)}.</p>
        ${products.length
          ? `<div class="items-grid">${products.map(p => productCard(folder, p, opts)).join("")}</div>`
          : `<p class="status-message">No products selected yet.</p>`}`;
    }
    if (folder.drop_open) {
      return products.length
        ? `<div class="items-grid">${products.map(p => productCard(folder, p)).join("")}</div>`
        : `<p class="status-message">The drop is live — pieces are being placed.</p>`;
    }
    if (folder.status === "archived") {
      return `<p class="folder-locked">This release is closed. Its drop never opened.</p>`;
    }
    const when = folder.publish_at
      ? `The drop opens ${fmtDrop(folder)}.`
      : "The drop date hasn't been set yet.";
    return `
      <div class="folder-locked">
        <span class="folder-locked__label">Locked</span>
        <p>${esc(when)} Pieces from invited sellers, brands, boutiques and private closets will appear in Shop.</p>
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

  // opts.preview: render the release as the admin sees it — drafts included
  // and flagged, products shown before the drop. Public pages never pass it.
  function renderFolder(mount, folder, content, opts) {
    const preview = !!(opts && opts.preview);
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
      id: "imagery", title: "Lookbook", count: String(studies.length),
      html: `<div class="study-grid">${studies.map(studyCard).join("")}</div>`
    });
    if (updates.length) parts.push({
      id: "updates", title: "Updates", count: String(updates.length),
      html: `<ul class="folder-updates">${updates.map(updateItem).join("")}</ul>`
    });
    parts.push({
      id: "drop", title: "The Drop",
      count: (folder.drop_open || preview) ? String(products.length) : state.label,
      html: dropSection(folder, products, opts)
    });

    const index = parts.map((p, i) =>
      `<a href="#${p.id}"><span>${String(i + 1).padStart(2, "0")}</span>${esc(p.title)}<em>${esc(p.count)}</em></a>`
    ).join("");

    const justOpened = parts.length === 1 && state.mod === "open" && !preview
      ? `<p class="status-message">This release was just opened. Material arrives over the next two weeks — check back.</p>`
      : "";

    mount.innerHTML = `
      <article class="folder-page">
        ${preview || (opts && opts.landing) ? "" : `<a class="folder-page__back" href="index.html">← Home</a>`}
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

  /* ============================================================
     Folder page — folder.html?id=…
     ============================================================ */
  async function bootFolder(mount) {
    const notFound = message => {
      mount.innerHTML = `
        <div class="product-error">
          <p>${esc(message)}</p>
          <a class="product-link" href="index.html">← Home</a>
        </div>`;
    };

    let folder = null;
    try {
      const id = new URLSearchParams(window.location.search).get("id");
      folder = id ? await market().getPublicFolder(id) : null;
    } catch (error) {
      console.error("Could not load folder:", error);
      notFound("Could not load this release — try refreshing.");
      return;
    }
    if (!folder) { notFound("This release isn't available."); return; }

    document.title = `${folderName(folder)} — ${folder.title} — poda`;
    let content = { notes: [], studies: [], updates: [], products: [] };
    try { content = await market().getPublicFolderContent(folder.id); }
    catch (error) { console.error("Could not load the folder content:", error); }

    // The same layouts as the homepage: a folder with an open drop shows the
    // drop and a Feed (live if it is in Shop, past if not); a folder whose drop
    // has not opened shows the countdown and the feed.
    const isPastFolder = folder.status === "archived" || (folder.drop_open && !folder.is_shop);
    const back = isPastFolder
      ? `<a class="folder-page__back" href="archive.html">← Archive</a>`
      : `<a class="folder-page__back" href="index.html">← Home</a>`;
    bindFeedUI(mount);
    if (folder.drop_open) {
      mount.innerHTML = liveFolderHTML(folder, content, { kind: folder.is_shop ? "live" : "past", back });
      markSeen(folder.id);
    } else {
      mountBuilding(mount, folder, content, clockSkew([folder]), { back });
    }
    applyFeedHash(mount);
  }

  /* ============================================================
     Feed — the one stream that carries a folder's updates, notes and image
     sets, newest first. Every post reads as a file: .txt for an update,
     .doc for a note, .jpg for an image set. On the live page it opens from a
     Feed bar (a sheet on a phone, a side panel on desktop); on the building
     page it is the page. Everything shown here is already public data.
     ============================================================ */
  function pad(n, width) { return String(n).padStart(width, "0"); }

  function ts(value) {
    const t = Date.parse(value || "");
    return Number.isFinite(t) ? t : 0;
  }

  // "new-work-uniform": a safe, short piece of a filename.
  function fileSlug(text, max) {
    return String(text || "").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
      .slice(0, max || 28).replace(/-+$/, "");
  }

  // Notes and sets store date-only strings; showing those through a timezone
  // would slip them back a day, so they are formatted from their parts.
  function fmtStamp(iso) {
    if (!iso) return "";
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
    if (m) {
      return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
        .toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }
    return fmtDateTime(iso);
  }

  // When the drop opened (a manual launch wins over the scheduled time).
  function fmtOpened(folder) {
    const iso = folder.launched_at || folder.publish_at;
    if (!iso) return "";
    if (window.PodaTZ) return window.PodaTZ.formatInZone(iso, folder.drop_timezone, true);
    return fmtDateTime(iso);
  }

  // Plain-text pieces of a note's published HTML, for the in-feed preview.
  // The HTML is only parsed into an inert document and read as text.
  function notePreview(note) {
    let thesis = "";
    let paras = [];
    if (note.websiteHtml) {
      try {
        const doc = new DOMParser().parseFromString(note.websiteHtml, "text/html");
        const th = doc.querySelector("[data-poda-thesis] .note-article__thesis-body");
        thesis = th ? th.textContent.trim() : "";
        doc.querySelectorAll("[data-poda-thesis]").forEach(el => el.remove());
        paras = Array.from(doc.querySelectorAll("p")).map(p => p.textContent.trim()).filter(Boolean);
      } catch (e) { /* fall back to the plain body below */ }
    }
    if (!paras.length && note.body) {
      paras = String(note.body).split(/\n+/).map(s => s.trim()).filter(Boolean);
    }
    const words = (thesis + " " + paras.join(" ")).trim().split(/\s+/).filter(Boolean).length;
    let excerpt = paras.join(" ");
    if (excerpt.length > 340) excerpt = excerpt.slice(0, 340).replace(/\s+\S*$/, "") + "…";
    return { thesis, excerpt, minutes: words ? Math.max(1, Math.round(words / 220)) : 0 };
  }

  /* —— Lookbook grid with gaps. The images fill a grid in order, but now and
     then a cell is skipped so white space opens up. The pattern comes from a
     seed (the set's id), so a set always looks the same, on every visit and
     every device. At most cols - 1 cells are skipped at a time, so a whole row
     is never left blank. —— */
  const LOOKBOOK_MAX = 9;

  function seededRandom(seed) {
    let h = 2166136261;
    const str = String(seed);
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return function () {
      h += 0x6D2B79F5;
      let t = h;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Where each of `count` images sits: { col, row }, both starting at 1.
  function lookbookCells(count, cols, seed) {
    const rand = seededRandom(seed);
    const cells = [];
    let pos = 0;
    for (let i = 0; i < count; i++) {
      // After the first image, sometimes leave one cell (less often two) empty.
      if (i > 0 && rand() < 0.3) pos += Math.min(cols - 1, rand() < 0.2 ? 2 : 1);
      cells.push({ col: (pos % cols) + 1, row: Math.floor(pos / cols) + 1 });
      pos++;
    }
    return cells;
  }

  // One list from three kinds of post. seenMs is null when this browser cannot
  // store anything, in which case nothing is marked new.
  function buildFeed(content, seenMs) {
    const entries = [];
    (content.updates || [])
      .slice().sort((a, b) => ts(a.created_at) - ts(b.created_at))
      .forEach((u, i) => entries.push({
        type: "updates", ext: "txt", iso: u.created_at, date: ts(u.created_at),
        name: `update_${pad(i + 1, 2)}.txt`, update: u
      }));
    (content.notes || []).forEach(n => {
      const iso = n.publishedAt || n.createdAt;
      entries.push({
        type: "notes", ext: "doc", iso, date: ts(iso), note: n,
        name: `note_${n.issueNumber ? pad(n.issueNumber, 3) + "_" : ""}${fileSlug(n.slug || n.title, 34) || "untitled"}.doc`
      });
    });
    (content.studies || []).forEach(s => {
      const iso = s.date || s.createdAt;
      entries.push({
        type: "lookbook", ext: "jpg", iso, date: ts(iso), study: s,
        name: `lookbook${s.studyNumber ? "_" + pad(s.studyNumber, 2) : ""}_${fileSlug(s.title, 30) || "untitled"}.jpg`
      });
    });
    entries.sort((a, b) => b.date - a.date);
    entries.forEach(e => { e.isNew = seenMs != null && e.date > seenMs; });
    return entries;
  }

  function feedSeenMs(folder) {
    const seen = readSeen();
    if (!seen) return null;
    const t = seen["feed:" + folder.id] ? Date.parse(seen["feed:" + folder.id]) : 0;
    return Number.isFinite(t) ? t : 0;
  }

  function feedEntryHTML(e) {
    const head = `
      <div class="ff-eh">
        <span class="ff-x ff-x--${e.ext}">${e.ext.toUpperCase()}</span>
        <span class="ff-fn">${esc(e.name)}</span>
        <time>${esc(fmtStamp(e.iso))}</time>
        ${e.isNew ? `<em class="ff-new">NEW</em>` : ""}
      </div>`;
    const cls = `ff-entry${e.isNew ? " is-new" : ""}`;

    if (e.update) {
      const u = e.update;
      const img = u.image_path
        ? `<img class="ff-upimg" src="${esc(market().noteMediaUrl(u.image_path))}" alt="" loading="lazy" decoding="async" />`
        : "";
      return `<article class="${cls}" data-type="updates">${head}<p class="ff-tx">${esc(u.body)}</p>${img}</article>`;
    }

    if (e.note) {
      const n = e.note;
      const p = notePreview(n);
      const cat = String(n.category || "").toUpperCase();
      const href = `note.html?id=${encodeURIComponent(n.id)}`;
      let lead = n.subtitle || p.excerpt || "";
      if (lead.length > 160) lead = lead.slice(0, 160).replace(/\s+\S*$/, "") + "…";
      const hasPreview = !!(p.thesis || p.excerpt);
      return `
        <article class="${cls}" data-type="notes">${head}
          <div class="ff-nb">
            ${cat ? `<span class="ff-tag">${esc(cat)}</span>` : ""}
            <h3 class="ff-nt">${esc(n.title || "Untitled")}</h3>
            ${lead ? `<p class="ff-nl">${esc(lead)}</p>` : ""}
            ${hasPreview ? `
            <div class="ff-prev" hidden>
              ${p.thesis ? `<div class="ff-thesis"><b>THESIS</b><p>${esc(p.thesis)}</p></div>` : ""}
              ${p.excerpt ? `<p class="ff-ex">${esc(p.excerpt)}</p>` : ""}
              <a class="ff-cta" href="${href}"><span>Open full note</span><span aria-hidden="true">→</span></a>
            </div>` : ""}
          </div>
          <div class="ff-ef">
            <span>${p.minutes ? `${p.minutes} min` : ""}</span>
            ${hasPreview
              ? `<button type="button" class="ff-toggle" aria-expanded="false">Preview ▾</button>`
              : `<a href="${href}">Open note →</a>`}
          </div>
        </article>`;
    }

    // A lookbook post: its images laid out on a grid, with some cells left
    // empty on purpose. One image (or none) is shown as a single wide picture.
    const s = e.study;
    const images = (Array.isArray(s.images) ? s.images : []).filter(Boolean);
    const shown = images.slice(0, LOOKBOOK_MAX);
    const href = `study.html?id=${encodeURIComponent(s.id)}`;
    let visual;
    if (shown.length <= 1) {
      const url = shown[0] || s.coverImage || "";
      visual = `<a class="ff-im" href="${href}">${url
        ? `<img src="${esc(url)}" alt="" loading="lazy" decoding="async" />`
        : `<span class="ff-im__empty">poda</span>`}</a>`;
    } else {
      const cols = shown.length >= 4 ? 3 : 2;
      const cells = lookbookCells(shown.length, cols, s.id || s.title);
      visual = `<div class="ff-lb" style="--cols:${cols}">${shown.map((url, i) =>
        `<a class="ff-lb__i" href="${href}" style="grid-column:${cells[i].col};grid-row:${cells[i].row}">` +
        `<img src="${esc(url)}" alt="" loading="lazy" decoding="async" /></a>`).join("")}</div>`;
    }
    const more = images.length > shown.length ? ` · ${images.length - shown.length} more` : "";
    return `
      <article class="${cls}" data-type="lookbook">${head}
        ${visual}
        <p class="ff-cap">${esc(s.title || "Untitled")}${s.framing ? ` · ${esc(s.framing)}` : ""}</p>
        <div class="ff-ef"><span>${images.length} image${images.length === 1 ? "" : "s"}${more}</span><a href="${href}">Open set →</a></div>
      </article>`;
  }

  function feedHTML(entries) {
    const filters = [["all", "All"], ["notes", "Notes"], ["lookbook", "Lookbook"], ["updates", "Updates"]];
    return `
      <div class="ff-feed" data-feed>
        <div class="ff-filters" role="group" aria-label="Filter the feed">
          ${filters.map(([key, label], i) =>
            `<button type="button" data-f="${key}" aria-pressed="${i === 0}"${i === 0 ? ' class="on"' : ""}>${label}</button>`).join("")}
          <span class="ff-order">Newest ↓</span>
        </div>
        ${entries.length ? `<div class="ff-rail">${entries.map(feedEntryHTML).join("")}</div>` : ""}
        <p class="ff-empty"${entries.length ? " hidden" : ""}>Nothing posted yet. Updates, notes and images appear here as they are published.</p>
      </div>`;
  }

  function applyFeedFilter(feed, key) {
    let shown = 0;
    feed.querySelectorAll(".ff-entry").forEach(el => {
      const on = key === "all" || el.dataset.type === key;
      el.hidden = !on;
      if (on) shown++;
    });
    const empty = feed.querySelector(".ff-empty");
    if (empty) {
      const hasAny = !!feed.querySelector(".ff-entry");
      empty.textContent = hasAny
        ? "Nothing of this kind yet."
        : "Nothing posted yet. Updates, notes and images appear here as they are published.";
      empty.hidden = shown > 0;
    }
    feed.querySelectorAll(".ff-filters button").forEach(b => {
      const on = b.dataset.f === key;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }

  function openFeed(root, opener) {
    const panel = root.querySelector(".ff-panel");
    if (!panel) return;
    root.__ffOpener = opener || null;
    panel.hidden = false;
    const dim = root.querySelector(".ff-dim");
    if (dim) dim.hidden = false;
    document.documentElement.classList.add("ff-lock");
    root.querySelectorAll("[data-feed-open]").forEach(b => b.setAttribute("aria-expanded", "true"));
    if (panel.dataset.seenKey) markSeen(panel.dataset.seenKey);
    root.querySelectorAll(".ff-count").forEach(el => { el.hidden = true; }); // read now
    const close = panel.querySelector("[data-feed-close]");
    if (close) close.focus();
  }

  function closeFeed(root) {
    const panel = root.querySelector(".ff-panel");
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    const dim = root.querySelector(".ff-dim");
    if (dim) dim.hidden = true;
    document.documentElement.classList.remove("ff-lock");
    root.querySelectorAll("[data-feed-open]").forEach(b => b.setAttribute("aria-expanded", "false"));
    if (root.__ffOpener && root.__ffOpener.focus) root.__ffOpener.focus();
  }

  // One delegated listener on the mount point, so it survives the page
  // re-rendering at the drop moment.
  function bindFeedUI(mount) {
    if (mount.dataset.ffBound) return;
    mount.dataset.ffBound = "1";

    mount.addEventListener("click", event => {
      const root = mount.querySelector("[data-ff-root]");
      if (!root) return;

      const opener = event.target.closest("[data-feed-open]");
      if (opener) { openFeed(root, opener); return; }
      if (event.target.closest("[data-feed-close]") || event.target.closest(".ff-dim")) { closeFeed(root); return; }

      const filter = event.target.closest(".ff-filters button[data-f]");
      if (filter) { applyFeedFilter(filter.closest("[data-feed]"), filter.dataset.f); return; }

      const toggle = event.target.closest(".ff-toggle");
      if (toggle) {
        const entry = toggle.closest(".ff-entry");
        const prev = entry.querySelector(".ff-prev");
        const open = prev.hidden;       // about to open
        prev.hidden = !open;
        entry.querySelector(".ff-nb").classList.toggle("is-open", open);
        toggle.setAttribute("aria-expanded", String(open));
        toggle.textContent = open ? "Collapse ▴" : "Preview ▾";
        return;
      }

      const dropFilter = event.target.closest(".ff-dflt button[data-df]");
      if (dropFilter) {
        const key = dropFilter.dataset.df;
        root.querySelectorAll(".items-grid .catalog-card").forEach(card => {
          const a = card.dataset.availability || "unavailable";
          card.hidden = !(key === "all" || a === key);
        });
        dropFilter.parentElement.querySelectorAll("button").forEach(b => {
          const on = b === dropFilter;
          b.classList.toggle("on", on);
          b.setAttribute("aria-pressed", String(on));
        });
      }
    });

    document.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      const root = mount.querySelector("[data-ff-root]");
      if (root) closeFeed(root);
    });
  }

  // "03 days 14 hrs ..." until the drop, by the server's clock.
  function countdownHTML(folder) {
    if (!folder.publish_at) {
      return `
        <div class="ff-cd">
          <span class="ff-cd__lb">THE DROP</span>
          <p class="ff-cd__dt">The drop date hasn't been set yet.</p>
        </div>`;
    }
    const cell = (unit, label) => `<span><b data-u="${unit}">00</b><small>${label}</small></span>`;
    return `
      <div class="ff-cd" data-cd="${esc(folder.publish_at)}" role="timer" aria-label="Time until the drop opens">
        <span class="ff-cd__lb">DROP OPENS IN</span>
        <div class="ff-cd__n">${cell("d", "DAYS")}${cell("h", "HRS")}${cell("m", "MIN")}${cell("s", "SEC")}</div>
        <p class="ff-cd__dt">${esc(fmtDrop(folder))}</p>
      </div>`;
  }

  function startCountdown(root, skew) {
    const el = root.querySelector("[data-cd]");
    if (!el) return;
    const target = Date.parse(el.dataset.cd);
    if (!Number.isFinite(target)) return;
    const set = (unit, value) => {
      const node = el.querySelector(`[data-u="${unit}"]`);
      if (node) node.textContent = pad(value, 2);
    };
    let timer = null;
    // Only reload if the visitor actually watches the timer reach zero. A page
    // that loads already at zero must not reload itself in a loop while the
    // database catches up.
    const watching = target - (Date.now() + skew) > 0;
    const tick = () => {
      const ms = target - (Date.now() + skew);
      const s = Math.max(0, Math.floor(ms / 1000));
      set("d", Math.floor(s / 86400));
      set("h", Math.floor((s % 86400) / 3600));
      set("m", Math.floor((s % 3600) / 60));
      set("s", s % 60);
      if (ms <= 0) {
        clearInterval(timer);
        // The drop is due: reload a moment later, when the database has opened it.
        if (watching) setTimeout(() => window.location.reload(), 1500);
      }
    };
    tick();
    timer = setInterval(tick, 1000);
  }

  // A short line from a post, for the Feed bar.
  function entrySnippet(e) {
    const text = e.update ? e.update.body : e.note ? e.note.title : e.study ? e.study.title : "";
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    return clean.length > 44 ? clean.slice(0, 44).replace(/\s+\S*$/, "") + "…" : clean;
  }

  const STATE_LABELS = { live: "Live", building: "Building", past: "Past" };

  function folderHeadHTML(folder, kind, extra) {
    const num = folder.number == null ? "FOLDER" : `FOLDER ${pad(folder.number, 3)}`;
    return `
      <header class="ff-head">
        <span class="ff-tab">${esc(num)}</span>
        <span class="ff-state ff-state--${kind}">${STATE_LABELS[kind] || "Live"}</span>
        <h1 class="ff-title">${esc(folder.title)}</h1>
        ${extra || ""}
      </header>`;
  }

  // A folder whose drop is open: the header, the Feed bar, the drop grid and
  // the Feed sheet or panel. Used by the Shop (kind "live") and by folder.html
  // for the current drop and for past drops (kind "past").
  // opts: kind, back (HTML above the header), afterDrop and footer (HTML below).
  function liveFolderHTML(folder, content, opts) {
    const o = opts || {};
    const kind = o.kind || "live";
    const products = content.products || [];
    const entries = buildFeed(content, feedSeenMs(folder));
    const newCount = entries.filter(e => e.isNew).length;
    const availOf = p => p.availability || (p.is_available ? "available" : "unavailable");
    const left = products.filter(p => availOf(p) === "available").length;
    const sold = products.filter(p => availOf(p) === "sold").length;
    const opened = fmtOpened(folder);
    const meta = [
      opened ? `Opened ${opened}` : "",
      products.length ? `${products.length} piece${products.length === 1 ? "" : "s"}` : ""
    ].filter(Boolean).join(" · ");
    const countText = newCount > 9 ? "9+" : String(newCount);
    return `
      <div class="ff-root" data-ff-root>
        <article class="folder-page shop-page ff-page">
          ${o.back || ""}
          ${folderHeadHTML(folder, kind, meta ? `<p class="ff-meta">${esc(meta)}</p>` : "")}
          <button type="button" class="ff-bar" data-feed-open aria-expanded="false" aria-controls="ffPanel">
            <b>FEED</b>
            <span class="ff-bar__lt">${esc(entries[0] ? `${entries[0].name} · ${entrySnippet(entries[0])}` : "Updates, notes and lookbook")}</span>
            ${newCount ? `<span class="ff-count">${countText} NEW</span>` : ""}
            <i aria-hidden="true">▾</i>
          </button>
          <section class="ff-drop">
            <div class="section-bar">
              <span class="section-bar__label">01</span>
              <span class="section-bar__title">The Drop</span>
              ${products.length ? `<span class="ff-left">${left} of ${products.length} left</span>` : ""}
            </div>
            ${products.length ? `
            <div class="ff-dflt" role="group" aria-label="Filter the drop">
              <button type="button" data-df="all" aria-pressed="true" class="on">All ${products.length}</button>
              <button type="button" data-df="available" aria-pressed="false">Available ${left}</button>
              <button type="button" data-df="sold" aria-pressed="false">Sold ${sold}</button>
            </div>
            <div class="items-grid">${products.map(p => productCard(folder, p)).join("")}</div>`
              : `<p class="status-message">The drop is live — pieces are being placed.</p>`}
          </section>
          ${o.afterDrop || ""}
          ${o.footer || ""}
        </article>
        <button type="button" class="ff-edge" data-feed-open aria-expanded="false" aria-controls="ffPanel">
          <span>FEED</span>${newCount ? `<b class="ff-count">${countText}</b>` : ""}
        </button>
        <div class="ff-dim" hidden></div>
        <aside class="ff-panel" id="ffPanel" role="dialog" aria-label="Feed" data-seen-key="${esc("feed:" + folder.id)}" hidden>
          <div class="ff-ph">
            <span class="ff-ph__t">Feed<small>${esc(folderName(folder))}</small></span>
            <button type="button" class="ff-close" data-feed-close aria-label="Close the feed">✕</button>
          </div>
          ${feedHTML(entries)}
        </aside>
      </div>`;
  }

  // A folder whose drop has not opened: the countdown and sealed tiles beside
  // the feed. A folder that was archived without ever opening shows a closed
  // notice in place of the countdown. opts.back is HTML above the header.
  function buildingFolderHTML(folder, content, opts) {
    const o = opts || {};
    const closed = folder.status === "archived";
    const entries = buildFeed(content, feedSeenMs(folder));
    const rail = closed
      ? `<div class="ff-cd">
           <span class="ff-cd__lb">CLOSED</span>
           <p class="ff-cd__dt">This release is closed. Its drop never opened.</p>
         </div>`
      : `${countdownHTML(folder)}
         <div class="section-bar ff-brail__bar">
           <span class="section-bar__label">01</span>
           <span class="section-bar__title">The Drop</span>
           <span class="ff-left">Locked</span>
         </div>
         <div class="ff-seals" aria-hidden="true"><div>poda</div><div>poda</div><div>poda</div><div>poda</div></div>`;
    return `
      <div class="ff-root" data-ff-root>
        <article class="folder-page ff-page ff-page--building">
          ${o.back || ""}
          ${folderHeadHTML(folder, closed ? "past" : "building", folder.standfirst ? `<p class="ff-stand">${esc(folder.standfirst)}</p>` : "")}
          <div class="ff-bgrid">
            <aside class="ff-brail">${rail}</aside>
            <section class="ff-bmain">
              <div class="section-bar"><span class="section-bar__title">Feed</span></div>
              ${feedHTML(entries)}
            </section>
          </div>
        </article>
      </div>`;
  }

  function mountBuilding(mount, folder, content, skew, opts) {
    mount.innerHTML = buildingFolderHTML(folder, content, opts);
    bindFeedUI(mount);
    startCountdown(mount, skew);
    markSeen(folder.id);
    markSeen("feed:" + folder.id);
  }

  // Old links such as folder.html?id=…#updates (from the Inbox) now open the
  // Feed on that kind of post. #drop scrolls to the drop.
  const HASH_FILTER = { updates: "updates", notes: "notes", imagery: "lookbook", lookbook: "lookbook", feed: "all" };

  function applyFeedHash(mount) {
    const name = (window.location.hash || "").replace("#", "");
    const root = mount.querySelector("[data-ff-root]");
    if (!name || !root) return;
    if (name === "drop") {
      const drop = root.querySelector(".ff-drop, .ff-brail");
      if (drop) drop.scrollIntoView();
      return;
    }
    const key = HASH_FILTER[name];
    if (!key) return;
    const feed = root.querySelector("[data-feed]");
    if (feed) applyFeedFilter(feed, key);
    if (root.querySelector(".ff-panel")) openFeed(root, null);      // the drop layouts
    else {
      const main = root.querySelector(".ff-bmain");                  // the building layout
      if (main) main.scrollIntoView();
    }
  }

  /* ============================================================
     Shop — the release currently in Shop, and the next drop if one is
     scheduled. The page re-asks the database at the drop moment (using the
     server's clock, not this browser's), and again when a hidden tab becomes
     visible — but the products themselves only ever come from the database.
     ============================================================ */
  function bootShop(mount) {
    let timer = null;
    let lastLoad = 0;
    bindFeedUI(mount);

    function upcomingNotice(upcoming) {
      if (!upcoming) return "";
      return `
        <p class="shop-next">
          <span class="folder-locked__label">Next drop</span>
          ${esc(folderName(upcoming))} — ${esc(upcoming.title)} · ${esc(fmtDrop(upcoming))}
          · <a class="product-link" href="folder.html?id=${encodeURIComponent(upcoming.id)}">See the folder →</a>
        </p>`;
    }

    function render(shop, upcoming, content) {
      if (!shop) {
        mount.innerHTML = `
          <article class="folder-page shop-page">
            <a class="folder-page__back" href="index.html">← Home</a>
            <header class="shop-head">
              <p class="folder-head__no">SHOP</p>
              <h1 class="folder-head__title">Shop</h1>
              <p class="folder-head__standfirst">The first drop is on its way.</p>
            </header>
            ${upcomingNotice(upcoming)}
            <p class="shop-footer"><a class="product-link" href="archive.html">Past releases →</a></p>
          </article>`;
        return;
      }
      // The live page is the drop and nothing else. The updates, notes and
      // lookbook sit behind a Feed bar (a sheet on a phone, a side tab and
      // panel on desktop).
      mount.innerHTML = liveFolderHTML(shop, content, {
        kind: "live",
        afterDrop: upcomingNotice(upcoming),
        footer: `<p class="shop-footer"><a class="product-link" href="archive.html">Past releases →</a></p>`
      });
    }

    function schedule(upcoming, skew) {
      clearTimeout(timer);
      if (!upcoming) return;
      // Server time of the drop minus server "now" = how long to wait, whatever
      // this browser's clock says. +750ms so we ask just after it opens.
      const wait = Date.parse(upcoming.publish_at) - (Date.now() + skew) + 750;
      const delay = wait > 0 ? Math.min(wait, MAX_TIMEOUT) : 3000; // boundary: retry shortly
      timer = setTimeout(load, delay);
    }

    async function load() {
      clearTimeout(timer);
      let folders;
      try {
        folders = await market().getPublicFolders();
      } catch (error) {
        console.error("Could not load Shop:", error);
        if (!mount.querySelector(".shop-page")) {
          mount.innerHTML = `<p class="status-message">Could not load Shop — try refreshing.</p>`;
        }
        timer = setTimeout(load, 30000); // transient failure: try again
        return;
      }
      lastLoad = Date.now();
      const skew = clockSkew(folders);
      const shop = folders.find(f => f.is_shop) || null;
      const upcoming = pickUpcoming(folders, Date.now() + skew);
      const content = shop ? await market().getPublicFolderContent(shop.id) : { products: [] };
      // A visitor reading the Feed should not have it closed under them by a
      // background refresh: keep the open panel until they close it.
      if (shop && mount.dataset.shopId === shop.id && mount.querySelector(".ff-panel:not([hidden])")) {
        schedule(upcoming, skew);
        return;
      }
      render(shop, upcoming, content);
      mount.dataset.shopId = shop ? shop.id : "";
      if (shop) markSeen("shop");
      schedule(upcoming, skew);
    }

    // A tab left open in the background may have slept through the drop.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && Date.now() - lastLoad > 20000) load();
    });

    load();
  }

  // The release being built: opened to the public, not yet dropped, not
  // archived. A scheduled drop wins, soonest first; otherwise the newest.
  // Drafts never reach this list, because the public view does not return them.
  function pickBuilding(folders, nowMs) {
    const open = (folders || []).filter(f => f.status !== "archived" && !f.drop_open);
    const scheduled = open
      .filter(f => f.publish_at && Date.parse(f.publish_at) > nowMs)
      .sort((a, b) => Date.parse(a.publish_at) - Date.parse(b.publish_at));
    return scheduled[0] || open[0] || null;
  }

  // The release being built, shown as the homepage: a countdown to the drop,
  // sealed tiles where the products will be, and the feed as the page. The
  // products themselves stay locked until the database opens the drop; the
  // countdown reloads the page at that moment so it flips to Shop.
  async function bootBuilding(mount, folder, folders) {
    document.title = `${folderName(folder)} — ${folder.title} — poda`;
    let content = { notes: [], studies: [], updates: [], products: [] };
    try { content = await market().getPublicFolderContent(folder.id); }
    catch (error) { console.error("Could not load the building folder:", error); }

    mountBuilding(mount, folder, content, clockSkew(folders));
  }

  /* ============================================================
     Landing (index.html) — one address, three views.
       - a release is in Shop              -> the Shop is the homepage
       - none in Shop, one is being built  -> that folder is the homepage
       - none in Shop, none being built    -> the folder homepage (five folders)
     ?view=shop always shows the Shop; ?view=home always shows the five
     folders. If the data can't be loaded the five folders are shown, because
     their links are static. The header and footer are drawn by layout.js
     after this decides, so the page never flashes the wrong one.
     ============================================================ */
  async function bootLanding() {
    const homeEl = document.getElementById("landingHome");
    const shopEl = document.getElementById("landingShop");
    const buildingEl = document.getElementById("landingBuilding");
    // ?view=shop always shows the Shop; ?view=home always shows the five
    // folders, even while a release is live or being built.
    const view = new URLSearchParams(window.location.search).get("view");
    const forceShop = view === "shop";
    const forceHome = view === "home";

    let folders = null;
    if (window.PodaDB && window.PodaDB.isConfigured && market()) {
      try { folders = await market().getPublicFolders(); }
      catch (error) { console.error("Could not load the landing view:", error); }
    }
    const hasShop = !!(folders && folders.some(f => f.is_shop));
    const showShop = forceHome ? false : (forceShop || hasShop);
    const building = (showShop || forceHome || !buildingEl)
      ? null
      : pickBuilding(folders, Date.now() + clockSkew(folders));
    const showBuilding = !!building;
    const showHome = !showShop && !showBuilding;

    // Header and footer take their look from the view: the stripped one is
    // only for the five-folder homepage.
    const header = document.getElementById("siteHeader");
    const footer = document.getElementById("siteFooter");
    document.body.classList.toggle("site-body", showHome);
    if (showHome) {
      if (header) header.dataset.variant = "minimal";
      if (footer) { footer.dataset.variant = "minimal"; footer.classList.remove("portal-shell"); }
    }
    (showShop ? shopEl : showBuilding ? buildingEl : homeEl).hidden = false;
    document.body.dataset.landing = showShop ? "shop" : showBuilding ? "building" : "home";
    if (window.__landingResolve) window.__landingResolve();

    if (showShop) {
      if (folders || (window.PodaDB && window.PodaDB.isConfigured && market())) bootShop(document.getElementById("shopPage"));
      else document.getElementById("shopPage").innerHTML = `<p class="status-message">This page is unavailable right now.</p>`;
      return;
    }

    if (showBuilding) {
      await bootBuilding(document.getElementById("buildingPage"), building, folders);
      return;
    }

    // The hover link between the scene and the index needs no data.
    bindFolderScene(homeEl);
    bindFolderDrag(homeEl);
    if (folders) bootHome(document.getElementById("homeFolders"));

    // Waiting on a scheduled drop: reload at the drop moment, by the server's
    // clock, so a visitor on the folder homepage lands on the Shop.
    if (folders) {
      const upcoming = pickUpcoming(folders, Date.now() + clockSkew(folders));
      if (upcoming) {
        const wait = Date.parse(upcoming.publish_at) - (Date.now() + clockSkew(folders)) + 1500;
        if (wait > 0) setTimeout(() => window.location.reload(), Math.min(wait, MAX_TIMEOUT));
      }
    }
  }

  /* —— Boot —— */
  // Shared with other pages (the Inbox marks itself opened; the admin
  // renders the private preview with the same markup the public sees).
  window.PodaFolders = { markSeen, renderFolder, stateInfo, folderName };

  function start() {
    // index.html carries both the folder homepage and the Shop.
    if (document.getElementById("landingHome") && document.getElementById("landingShop")) {
      bootLanding().catch(error => {
        console.error("Landing failed:", error);
        const homeEl = document.getElementById("landingHome");
        if (homeEl) homeEl.hidden = false;
        if (window.__landingResolve) window.__landingResolve();
      });
      return;
    }
    const home = document.getElementById("homeFolders");
    const archive = document.getElementById("archiveGrid");
    const page = document.getElementById("folderPage");
    const shop = document.getElementById("shopPage");
    if (!home && !archive && !page && !shop) return;

    const ready = window.PodaDB && window.PodaDB.isConfigured && market();
    if (!ready) {
      // The home folders are static links and still work; the other pages
      // have nothing to show without data.
      const target = archive || page || shop;
      if (target) target.innerHTML = `<p class="status-message">This page is unavailable right now.</p>`;
      return;
    }
    if (home) bootHome(home);
    if (archive) bootArchive(archive);
    if (page) bootFolder(page);
    if (shop) bootShop(shop);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
