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
     • #homeFolders (index.html)   — the six folders on the homepage
     • #shopPage    (shop.html)    — the release currently in Shop
     • #folderPage  (folder.html)  — one release: notes, imagery, updates, drop
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

  function folderTile(folder) {
    const name = folderName(folder);
    const state = stateInfo(folder);
    return `
      <a class="folder-tile" href="folder.html?id=${encodeURIComponent(folder.id)}" aria-label="${esc(`${name}, ${folder.title}`)}">
        ${folderArt(false)}
        <span class="folder-tile__no">${esc(name)}</span>
        <span class="folder-tile__label">${esc(folder.title)}</span>
        <span class="folder-tile__state folder-tile__state--${state.mod}">${esc(state.label)}</span>
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
     Homepage — six fixed folders (markup lives in index.html so the links
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
      <article class="catalog-card${available ? "" : " catalog-card--sold"}">
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
        ${preview ? "" : `<a class="folder-page__back" href="index.html">← Home</a>`}
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
    const content = await market().getPublicFolderContent(folder.id);
    renderFolder(mount, folder, content);
    markSeen(folder.id);
    // Deep links such as folder.html?id=…#updates (from the Inbox) are
    // resolved before the content exists, so scroll once it's rendered.
    const target = window.location.hash && document.getElementById(window.location.hash.slice(1));
    if (target) target.scrollIntoView();
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
      const products = content.products;
      mount.innerHTML = `
        <article class="folder-page shop-page">
          <a class="folder-page__back" href="index.html">← Home</a>
          <header class="shop-head">
            <p class="folder-head__no">SHOP <span class="folder-state folder-state--live">${esc(folderName(shop))}</span></p>
            <h1 class="folder-head__title">${esc(shop.title)}</h1>
            ${shop.standfirst ? `<p class="folder-head__standfirst">${esc(shop.standfirst)}</p>` : ""}
            <p class="shop-readmore"><a class="product-link" href="folder.html?id=${encodeURIComponent(shop.id)}">Read the folder — notes, lookbook, updates →</a></p>
          </header>
          ${products.length
            ? `<div class="items-grid">${products.map(p => productCard(shop, p)).join("")}</div>`
            : `<p class="status-message">The drop is live — pieces are being placed.</p>`}
          ${upcomingNotice(upcoming)}
          <p class="shop-footer"><a class="product-link" href="archive.html">Past releases →</a></p>
        </article>`;
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
      render(shop, upcoming, content);
      if (shop) markSeen("shop");
      schedule(upcoming, skew);
    }

    // A tab left open in the background may have slept through the drop.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && Date.now() - lastLoad > 20000) load();
    });

    load();
  }

  /* —— Boot —— */
  // Shared with other pages (the Inbox marks itself opened; the admin
  // renders the private preview with the same markup the public sees).
  window.PodaFolders = { markSeen, renderFolder, stateInfo, folderName };

  function start() {
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
