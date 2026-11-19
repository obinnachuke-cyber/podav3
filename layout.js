/* ============================================================
   layout.js — shared site chrome (header nav + footer)
   Centralizes navigation so the vocabulary lives in ONE place
   (brief §14/§20). Runs on any page that includes an
   .app-sidebar and/or .site-footer; fills them in and marks the
   active link based on the current filename. The hard-coded nav
   in each HTML file stays as a no-JS fallback and is replaced
   here on load.
   ============================================================ */
(function () {
  "use strict";

  // Primary navigation — the one source of truth for the site's structure.
  const PRIMARY = [
    { href: "index.html?view=shop", label: "Shop" },
    { href: "market-notes.html", label: "Inbox" },
    { href: "lookbook.html",     label: "Index" },
    { href: "archive.html",      label: "Archive" },
    { href: "sell.html",         label: "Sell with poda" }
  ];
  // The 3D folder homepage. index.html shows the Shop while a release is live,
  // so the folders need their own way in: ?view=home always shows them. On
  // desktop the link sits with Seller login and Admin; on phones it is in the
  // menu.
  const FOLDERS_HREF = "index.html?view=home";

  // "seller" marks the link that turns into "My Closet" for a signed-in seller.
  const SECONDARY = [
    { href: "seller.html", label: "Seller login", seller: true },
    { href: "admin.html", label: "Admin" }
  ];

  // Footer only, so the header stays short.
  const FOOTER_EXTRA = [
    { href: "policies.html", label: "Shipping & returns" }
  ];

  const SOCIAL = [
    { href: "https://instagram.com/podacapital", label: "Instagram" },
    { href: "https://x.com/podacap",             label: "X" }
  ];

  function currentFile() {
    // An Index entry lives at /index/<name> but is the study page.
    if (window.location.pathname.indexOf("/index/") === 0) return "study.html";
    const path = window.location.pathname.split("/").pop() || "index.html";
    return path.toLowerCase();
  }

  // Map detail pages back onto their section so the nav highlights correctly.
  function activeFileFor(file) {
    if (file === "item.html") return "index.html";
    // The Shop is the homepage; old shop.html links redirect there.
    if (file === "shop.html") return "index.html";
    if (file === "note.html") return "market-notes.html";
    // A study opens from the Index; a release page sits under Shop.
    if (file === "study.html") return "lookbook.html";
    if (file === "folder.html") return "index.html";
    return file;
  }

  function linkHTML(item, active) {
    const isActive = item.href.split("?")[0] === active;
    const seller = item.seller ? " data-seller-link" : "";
    return `<a href="${item.href}"${isActive ? ' class="is-active" aria-current="page"' : ""}${seller}>${item.label}</a>`;
  }

  function renderHeader(active) {
    const header = document.querySelector(".site-header");
    const inner = header && header.querySelector(".site-header__inner");
    if (!header || !inner) return;

    // The folder-desktop homepage (index.html) gets a stripped header: the
    // logo, and on the right the links that do not belong to a folder. It IS
    // the homepage, so there is no separate "Home" link.
    if (header.dataset.variant === "minimal") {
      const homeLinks = [PRIMARY[PRIMARY.length - 1]].concat(SECONDARY);
      inner.innerHTML = `
        <a class="site-logo" href="index.html"><img src="logo-blue.png" alt="poda" /></a>
        <nav class="site-header__utility site-header__utility--home" aria-label="More from poda">
          ${homeLinks.map(i => linkHTML(i, active)).join("")}
        </nav>
      `;
      return;
    }

    inner.innerHTML = `
      <a class="site-logo" href="index.html"><img src="logo-blue.png" alt="poda" /></a>
      <nav class="site-nav" aria-label="Primary">
        ${PRIMARY.map(i => linkHTML(i, active)).join("")}
        <a class="site-nav__folders" href="${FOLDERS_HREF}">Folders</a>
        <a class="site-nav__seller" href="seller.html" data-seller-link>Seller login</a>
      </nav>
      <div class="site-header__utility">
        <a class="site-header__folders" href="${FOLDERS_HREF}">Folders</a>
        ${SECONDARY.map(i => linkHTML(i, active)).join("")}
        <button type="button" class="site-header__menu" id="navToggle" aria-label="Open menu" aria-expanded="false">Menu</button>
      </div>
    `;
  }

  // —— Mobile menu: one delegated handler covers every page's header. ——
  function bindMobileNav() {
    document.addEventListener("click", event => {
      const toggle = event.target.closest("#navToggle");
      if (toggle) {
        const header = document.querySelector(".site-header");
        if (!header) return;
        const isOpen = header.classList.toggle("is-open");
        toggle.setAttribute("aria-expanded", String(isOpen));
        toggle.textContent = isOpen ? "Close" : "Menu";
        return;
      }
      if (event.target.closest(".site-nav a")) {
        const openHeader = document.querySelector(".site-header.is-open");
        if (openHeader) closeMobileNav(openHeader);
      }
    });
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      const openHeader = document.querySelector(".site-header.is-open");
      if (openHeader) closeMobileNav(openHeader);
    });
  }

  function closeMobileNav(header) {
    header.classList.remove("is-open");
    const toggle = document.getElementById("navToggle");
    if (toggle) {
      toggle.setAttribute("aria-expanded", "false");
      toggle.textContent = "Menu";
    }
  }

  function renderFooter() {
    const footer = document.querySelector(".site-footer");
    if (!footer) return;

    // Folder-desktop homepage: just the social links, nothing else.
    if (footer.dataset.variant === "minimal") {
      footer.innerHTML = `
        <nav class="footer-links footer-links--standalone" aria-label="Social">
          ${SOCIAL.map(s => `<a href="${s.href}" target="_blank" rel="noopener">${s.label} ↗</a>`).join("")}
        </nav>
      `;
      return;
    }

    footer.innerHTML = `
      <div class="footer-top">
        <div class="footer-brand-block">
          <img class="footer-brand" src="logo-white.png" alt="poda" />
          <span class="footer-tag">Selective retail / market intelligence</span>
          <span class="footer-tag">New York + Washington, DC + Los Angeles</span>
        </div>
        <nav class="footer-nav" aria-label="Footer">
          ${PRIMARY.concat(SECONDARY, FOOTER_EXTRA).map(i => `<a href="${i.href}"${i.seller ? " data-seller-link" : ""}>${i.label}</a>`).join("")}
        </nav>
        <nav class="footer-links" aria-label="Social">
          ${SOCIAL.map(s => `<a href="${s.href}" target="_blank" rel="noopener">${s.label} ↗</a>`).join("")}
        </nav>
      </div>
      <div class="footer-signup">
        <span class="footer-tag">Get the Market Note by email</span>
        <div data-poda-subscribe="footer"></div>
      </div>
      <div class="footer-bottom">
        <span>© ${new Date().getFullYear()} poda</span>
      </div>
      <div class="footer-status">PODA SYSTEM ONLINE</div>
    `;
    if (window.PodaSubscribe) {
      const el = footer.querySelector("[data-poda-subscribe]");
      if (el) window.PodaSubscribe.mount(el, { source: "footer", compact: true });
    }
  }

  // Accepted sellers get a clear way back to their closet. Only runs on
  // pages that load the marketplace data layer, and only for a signed-in
  // supplier (admins can read every supplier row, so the role is checked
  // rather than just "has a supplier").
  async function addClosetLink() {
    const db = window.PodaDB;
    const market = window.PodaMarketplace;
    if (!db || !db.isConfigured || !market) return;
    try {
      const profile = await market.myProfile();
      if (!profile || profile.role !== "supplier") return;
      // Every "Seller login" link, in the header, the menu and the footer,
      // becomes "My Closet" for a signed-in supplier.
      document.querySelectorAll("[data-seller-link]").forEach(a => { a.textContent = "My Closet"; });
    } catch (e) { /* no closet link is better than a broken header */ }
  }

  function init() {
    const active = activeFileFor(currentFile());
    renderHeader(active);
    renderFooter();
    bindMobileNav();
    addClosetLink();
  }

  // index.html chooses between the Shop and the folder homepage first, so
  // the header and footer are drawn for the right one. The timeout means a
  // failed script can never leave the page without a header.
  function boot() {
    const ready = window.PODA_LANDING_READY;
    if (!ready) { init(); return; }
    Promise.race([ready, new Promise(resolve => setTimeout(resolve, 4000))]).then(init);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
