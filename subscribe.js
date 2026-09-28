/* ============================================================
   subscribe.js — reusable email signup component (Module 1)
   Auto-mounts into every <div data-poda-subscribe="SOURCE"> found
   on the page, so adding the form anywhere is just dropping a div.
   Talks to window.PodaDB.subscribe (db.js) — no external service
   is wired up yet; this only captures and stores the signup.
   ============================================================ */
(function () {
  "use strict";

  function validEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  function formHTML(compact) {
    const nameField = compact
      ? ""
      : `<input type="text" class="subscribe-form__name" placeholder="First name (optional)" autocomplete="given-name" />`;
    return `
      <form class="subscribe-form${compact ? " subscribe-form--compact" : ""}" novalidate>
        <div class="subscribe-form__row">
          ${nameField}
          <input type="email" class="subscribe-form__email" placeholder="Email address" autocomplete="email" required />
          <button type="submit" class="btn-solid subscribe-form__submit">Join →</button>
        </div>
        <label class="subscribe-form__consent">
          <input type="checkbox" required />
          <span>I'd like to receive poda's Market Notes by email. Unsubscribe anytime.</span>
        </label>
        <p class="subscribe-form__message" hidden></p>
      </form>`;
  }

  function render(container, opts) {
    const source = (opts && opts.source) || container.dataset.podaSubscribe || "unknown";
    container.innerHTML = formHTML(!!(opts && opts.compact));

    const form = container.querySelector(".subscribe-form");
    const nameInput = form.querySelector(".subscribe-form__name");
    const emailInput = form.querySelector(".subscribe-form__email");
    const consentInput = form.querySelector('input[type="checkbox"]');
    const submitBtn = form.querySelector(".subscribe-form__submit");
    const message = form.querySelector(".subscribe-form__message");

    function showMessage(text, kind) {
      message.textContent = text;
      message.hidden = false;
      message.className = "subscribe-form__message subscribe-form__message--" + kind;
    }

    form.addEventListener("submit", async function (event) {
      event.preventDefault();

      const email = emailInput.value.trim().toLowerCase();
      if (!validEmail(email)) {
        showMessage("Enter a valid email address.", "error");
        return;
      }
      if (!consentInput.checked) {
        showMessage("Please check the box to confirm consent.", "error");
        return;
      }
      if (!window.PodaDB || typeof window.PodaDB.subscribe !== "function") {
        showMessage("Signups aren't available right now. Please try again later.", "error");
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = "Joining…";
      message.hidden = true;

      try {
        const result = await window.PodaDB.subscribe({
          email,
          firstName: nameInput ? nameInput.value.trim() : "",
          source
        });
        if (result && result.duplicate) {
          showMessage("You're already on the list.", "duplicate");
        } else {
          showMessage("You're on the list — thank you.", "success");
          form.reset();
        }
      } catch (err) {
        console.error("Subscribe failed:", err);
        showMessage("Something went wrong. Please try again.", "error");
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Join the list";
      }
    });
  }

  function mount(container, opts) {
    if (!container) return;
    render(container, opts || {});
  }

  function autoMount() {
    document.querySelectorAll("[data-poda-subscribe]").forEach(function (el) {
      mount(el, { source: el.dataset.podaSubscribe, compact: el.dataset.compact !== "false" });
    });
  }

  window.PodaSubscribe = { mount };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoMount);
  } else {
    autoMount();
  }
})();
