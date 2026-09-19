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
    { href: "drop.html",         label: "The Edit" },
    { href: "market-notes.html", label: "Inbox" },
    { href: "lookbook.html",     label: "Lookbook" },
    { href: "source.html",       label: "Source" },
    { href: "sell.html",         label: "Sell with poda" }
  ];
  const SECONDARY = [
    { href: "about.html", label: "About" },
    { href: "admin.html", label: "Admin" }
  ];

  const SOCIAL = [
    { href: "https://instagram.com/podacapital", label: "Instagram" },
    { href: "https://x.com/podacap",             label: "X" }
  ];

  function currentFile() {
    const path = window.location.pathname.split("/").pop() || "index.html";
    return path.toLowerCase();
  }

  // Map detail pages back onto their section so the nav highlights correctly.
  function activeFileFor(file) {
    if (file === "item.html") return "drop.html";
    if (file === "note.html") return "market-notes.html";
    if (file === "study.html") return "lookbook.html";
    return file;
  }

  function linkHTML(item, active) {
    const isActive = item.href === active;
    return `<a href="${item.href}"${isActive ? ' class="is-active" aria-current="page"' : ""}>${item.label}</a>`;
  }

  function renderHeader(active) {
    const header = document.querySelector(".site-header");
    const inner = header && header.querySelector(".site-header__inner");
    if (!header || !inner) return;
    inner.innerHTML = `
      <a class="site-logo" href="index.html">poda</a>
      <nav class="site-nav" aria-label="Primary">
        ${PRIMARY.map(i => linkHTML(i, active)).join("")}
      </nav>
      <div class="site-header__utility">
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
    footer.innerHTML = `
      <div class="footer-top">
        <div class="footer-brand-block">
          <span class="footer-brand">poda</span>
          <span class="footer-tag">Selective retail / market intelligence</span>
          <span class="footer-tag">New York + Washington, DC</span>
        </div>
        <nav class="footer-nav" aria-label="Footer">
          ${PRIMARY.concat(SECONDARY).map(i => `<a href="${i.href}">${i.label}</a>`).join("")}
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
        <span class="footer-build" id="footerBuild">DROP 001 — IN ASSEMBLY</span>
      </div>
      <div class="footer-status">PODA SYSTEM ONLINE</div>
    `;
    if (window.PodaSubscribe) {
      const el = footer.querySelector("[data-poda-subscribe]");
      if (el) window.PodaSubscribe.mount(el, { source: "footer" });
    }
  }

  function init() {
    const active = activeFileFor(currentFile());
    renderHeader(active);
    renderFooter();
    bindMobileNav();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
