/* shell.js — sidebar toggle for the two-column app shell (desktop only) */
(function () {
  const shell  = document.getElementById("appShell");
  const btn    = document.getElementById("sidebarToggle");
  if (!shell || !btn) return;

  btn.addEventListener("click", function () {
    const isNowFullscreen = shell.classList.toggle("app-shell--fullscreen");
    btn.setAttribute("aria-expanded", String(!isNowFullscreen));
  });
})();
