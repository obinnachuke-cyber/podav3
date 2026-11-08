/* ============================================================
   apply.js — the Sell with poda application (sell.html).

   One question at a time: name, email, Instagram, closet photos,
   then a review card and a success screen. Answers live in memory
   and survive Back / Continue.

   Storage and database (see SELLER_APPLICATIONS_APPLY.sql):
   - Photos are shrunk in the browser and uploaded to the PRIVATE
     `applications` bucket. The public can add files there but cannot
     read, list or overwrite them.
   - The application row is created only by the RPC
     submit_seller_application(), which re-checks every field and
     that each photo really is in storage. Success is shown only when
     that call answers "ok".
   - A heads-up email goes through /api/submit-request afterwards. It
     carries no photo links and a failure there never blocks success.
   ============================================================ */
(function () {
  "use strict";

  const root = document.getElementById("apply");
  if (!root || !window.supabase || !window.PODA_SUPABASE_URL) return;

  // A plain anonymous client: no session is kept for visitors.
  const sb = window.supabase.createClient(window.PODA_SUPABASE_URL, window.PODA_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const BUCKET = "applications";
  const MAX_PHOTOS = 10;
  const MAX_INPUT_BYTES = 25 * 1024 * 1024;   // before shrinking
  const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;   // bucket limit, after shrinking
  const OK_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
  const OK_EXT = /\.(jpe?g|png|webp|heic|heif)$/i;
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const state = {
    screen: "intro",           // intro | name | email | instagram | photos | review | sent
    fromReview: false,         // true while editing one answer from the review screen
    id: crypto.randomUUID(),   // same id on every retry, so a retry cannot double-submit
    name: "",
    email: "",
    instagram: "",
    offering: "",
    draft: {},                 // unsent typing, kept so Back never loses it
    photos: [],                // { key, file, blob, url, uploaded }
    nextKey: 0,
    submitting: false
  };

  let pendingPhotos = Promise.resolve();   // photos still being shrunk

  const STEPS = ["name", "email", "instagram", "photos"];

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* —— Instagram: accept @handle, handle or profile URL —— */
  function parseInstagram(raw) {
    const v = raw.trim();
    if (!v) return { value: "" };
    let handle = v;
    if (/^(https?:\/\/)?([a-z0-9-]+\.)?instagram\.com\//i.test(v)) {
      const m = v.replace(/^https?:\/\//i, "").split(/[/?#]/)[1];
      handle = m || "";
    }
    handle = handle.replace(/^@/, "");
    if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) return { error: "Enter a handle or profile link." };
    return { value: "@" + handle };
  }

  /* —— Photos —— */
  function shrink(file, maxDim = 1600, quality = 0.82) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width, height } = img;
        if (!width || !height) { reject(new Error("unreadable")); return; }
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";           // flatten transparent PNGs onto white
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error("unreadable"))), "image/jpeg", quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("unreadable")); };
      img.src = url;
    });
  }

  async function addFiles(fileList) {
    const errors = [];
    const files = Array.from(fileList || []);
    for (const file of files) {
      if (state.photos.length >= MAX_PHOTOS) { errors.push(`Up to ${MAX_PHOTOS} photos.`); break; }
      if (state.nextKey > 99) { errors.push("Too many photos added. Reload to start again."); break; }
      if (!OK_TYPES.includes(file.type) && !OK_EXT.test(file.name)) {
        errors.push(`${file.name}: use a JPG, PNG, WebP or HEIC photo.`);
        continue;
      }
      if (file.size > MAX_INPUT_BYTES) {
        errors.push(`${file.name}: file is over 25 MB.`);
        continue;
      }
      try {
        const blob = await shrink(file);
        if (blob.size > MAX_UPLOAD_BYTES) { errors.push(`${file.name}: file is too large.`); continue; }
        state.photos.push({ key: state.nextKey++, file, blob, url: URL.createObjectURL(blob), uploaded: false });
      } catch (e) {
        errors.push(`${file.name}: could not be read. Try a JPG or PNG.`);
      }
    }
    return errors;
  }

  function removePhoto(key) {
    const i = state.photos.findIndex(p => p.key === key);
    if (i < 0) return;
    URL.revokeObjectURL(state.photos[i].url);
    state.photos.splice(i, 1);
  }

  async function uploadPhoto(p) {
    if (p.uploaded) return;
    const { error } = await sb.storage.from(BUCKET).upload(`${state.id}/${p.key}.jpg`, p.blob, {
      contentType: "image/jpeg",
      upsert: false
    });
    // "Already exists" means an earlier attempt got this one through.
    if (error && !/already exists|duplicate/i.test(error.message || "") && String(error.statusCode) !== "409") throw error;
    p.uploaded = true;
  }

  /* —— Submit —— */
  async function submit() {
    // Uploads run three at a time.
    const queue = state.photos.filter(p => !p.uploaded);
    let next = 0;
    async function worker() {
      while (next < queue.length) { const p = queue[next++]; await uploadPhoto(p); }
    }
    await Promise.all([worker(), worker(), worker()]);

    const { data, error } = await sb.rpc("submit_seller_application", {
      app_id: state.id,
      app_name: state.name,
      app_email: state.email,
      app_instagram: state.instagram || null,
      app_offering: state.offering,
      app_photo_paths: state.photos.map(p => `${state.id}/${p.key}.jpg`)
    });
    if (error) throw error;
    return data;
  }

  // Heads-up email for the admin. Best effort: the application is already saved.
  function notify() {
    try {
      fetch("/api/submit-request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "application",
          subjectPrefix: "poda seller application",
          name: state.name,
          email: state.email,
          instagram: state.instagram,
          message: state.offering,
          photoCount: state.photos.length
        })
      }).catch(() => {});
    } catch (e) { /* ignore */ }
  }

  /* —— Rendering —— */
  function progress(step) {
    const n = STEPS.indexOf(step) + 1;
    const segs = STEPS.map((_, i) => `<i class="${i < n ? "is-done" : ""}"></i>`).join("");
    return `<div class="apply-progress" role="img" aria-label="Step ${n} of 4">
      <span class="apply-progress__no" aria-hidden="true">0${n} / 04</span>
      <span class="apply-progress__bar" aria-hidden="true">${segs}</span>
    </div>`;
  }

  function shell(inner, tab) {
    return `<div class="apply-card">
      <span class="apply-tab" aria-hidden="true">${esc(tab || "Sell")}</span>
      <div class="apply-card__body">${inner}</div>
    </div>`;
  }

  function nav({ back = true, skip = false, label = "Continue" } = {}) {
    return `<div class="apply-nav">
      ${back ? `<button type="button" class="btn" data-act="back">Back</button>` : "<span></span>"}
      <span class="apply-nav__right">
        ${skip ? `<button type="button" class="btn" data-act="skip">Skip</button>` : ""}
        <button type="submit" class="btn btn--primary">${esc(label)}</button>
      </span>
    </div>`;
  }

  function fieldHTML(id, label, type, value, extra = "") {
    return `<div class="field">
      <label for="${id}">${esc(label)}</label>
      <input id="${id}" name="${id}" type="${type}" value="${esc(state.draft[id] !== undefined ? state.draft[id] : value)}" ${extra} aria-describedby="applyError" />
    </div>
    <p class="apply-error" id="applyError" role="alert" hidden></p>`;
  }

  const screens = {
    intro() {
      return `<div class="apply-intro">
        <h1 class="visually-hidden-input">Sell with poda</h1>
        <div class="apply-intro__actions">
          <button type="button" class="btn btn--primary" data-act="start">Apply to sell</button>
          <a class="apply-login" href="seller.html">Seller login →</a>
        </div>
      </div>`;
    },
    name() {
      return shell(`<form novalidate data-form="name">
        ${progress("name")}
        <h1 class="visually-hidden-input">What should we call you?</h1>
        ${fieldHTML("name", "Name or nickname", "text", state.name, 'autocomplete="nickname" maxlength="120" required')}
        ${nav()}
      </form>`);
    },
    email() {
      return shell(`<form novalidate data-form="email">
        ${progress("email")}
        <h1 class="visually-hidden-input">What’s your email?</h1>
        ${fieldHTML("email", "Email", "email", state.email, 'autocomplete="email" inputmode="email" maxlength="200" required')}
        ${nav()}
      </form>`);
    },
    instagram() {
      return shell(`<form novalidate data-form="instagram">
        ${progress("instagram")}
        <h1 class="visually-hidden-input">What’s your Instagram?</h1>
        ${fieldHTML("instagram", "Instagram handle or profile URL", "text", state.instagram, 'autocomplete="off" autocapitalize="off" maxlength="200"')}
        ${nav({ skip: true })}
      </form>`);
    },
    photos() {
      return shell(`<form novalidate data-form="photos">
        ${progress("photos")}
        <h1 class="apply-q" tabindex="-1">Show us your closet.</h1>
        <label class="upload-dropzone apply-drop" for="applyFiles" id="applyDrop">
          <span>＋ Add photos</span>
          <input type="file" id="applyFiles" accept="image/*" multiple class="visually-hidden-input" />
        </label>
        <div class="upload-strip apply-strip" id="applyStrip">${thumbsHTML()}</div>
        <div class="field apply-offering">
          <label for="offering">What are you trying to sell?</label>
          <textarea id="offering" name="offering" maxlength="1000" rows="4" required aria-describedby="applyError">${esc(state.draft.offering !== undefined ? state.draft.offering : state.offering)}</textarea>
        </div>
        <p class="apply-error" id="applyError" role="alert" hidden></p>
        ${nav()}
      </form>`);
    },
    review() {
      const photos = state.photos.map((p, i) => `<img src="${p.url}" alt="Closet photo ${i + 1}" />`).join("");
      return `<div class="apply-review">
        <h1 class="apply-title apply-title--sm" tabindex="-1">Your application</h1>
        <div class="apply-profile">
          <span class="apply-tab" aria-hidden="true">Sell</span>
          <div class="apply-card__body">
            <div class="apply-row">
              <h2 class="apply-profile__name">${esc(state.name)}</h2>
              <button type="button" class="apply-edit" data-edit="name" aria-label="Edit name">Edit</button>
            </div>
            <div class="apply-row apply-row--ig">
              <span class="apply-profile__ig">${state.instagram ? esc(state.instagram) : ""}</span>
              <button type="button" class="apply-edit" data-edit="instagram" aria-label="${state.instagram ? "Edit Instagram" : "Add Instagram"}">${state.instagram ? "Edit" : "Add"}</button>
            </div>
            <div class="apply-profile__photos">${photos}</div>
            <p class="apply-profile__offering">${esc(state.offering)}</p>
            <button type="button" class="apply-edit" data-edit="photos" aria-label="Edit photos and description">Edit</button>
          </div>
        </div>
        <div class="apply-private">
          <span class="apply-private__label">Private</span>
          <span class="apply-private__email">${esc(state.email)}</span>
          <button type="button" class="apply-edit" data-edit="email" aria-label="Edit email">Edit</button>
        </div>
        <p class="apply-note">Your application and photos are private and subject to review.</p>
        <p class="apply-error" id="applyError" role="alert" hidden></p>
        <div class="apply-nav">
          <button type="button" class="btn" data-act="back">Back</button>
          <button type="button" class="btn btn--primary" data-act="submit" id="applySubmit">Submit application</button>
        </div>
      </div>`;
    },
    sent() {
      return `<div class="apply-intro">
        <h1 class="apply-title" tabindex="-1">Application sent</h1>
        <div class="apply-intro__actions">
          <a class="btn btn--primary apply-link-btn" href="index.html">Back to poda</a>
        </div>
      </div>`;
    }
  };

  function thumbsHTML() {
    return state.photos.map((p, i) => `<div class="upload-thumb">
      <img src="${p.url}" alt="Photo ${i + 1}" />
      <button type="button" data-rm="${p.key}" aria-label="Remove photo ${i + 1}">×</button>
    </div>`).join("");
  }

  function show(name, { focus = true } = {}) {
    state.screen = name;
    root.dataset.screen = name;
    root.innerHTML = screens[name]();
    root.classList.remove("is-in");
    if (!reduceMotion) { void root.offsetWidth; root.classList.add("is-in"); }
    wire();
    if (focus) {
      const target = root.querySelector("input[type=text],input[type=email]") || root.querySelector(".apply-q,.apply-title");
      if (target) target.focus({ preventScroll: false });
    }
  }

  function err(msg) {
    const box = document.getElementById("applyError");
    if (!box) return;
    box.textContent = msg || "";
    box.hidden = !msg;
    if (msg) {
      const input = root.querySelector("input[aria-describedby=applyError]");
      if (input) input.setAttribute("aria-invalid", "true");
    }
  }

  function goNext(from) {
    if (state.fromReview) { state.fromReview = false; show("review"); return; }
    const i = STEPS.indexOf(from);
    show(STEPS[i + 1] || "review");
  }

  function goBack(from) {
    if (state.fromReview) { state.fromReview = false; show("review"); return; }
    if (from === "review") { show("photos"); return; }
    const i = STEPS.indexOf(from);
    show(i <= 0 ? "intro" : STEPS[i - 1]);
  }

  /* —— Wiring for whichever screen is showing —— */
  function wire() {
    const form = root.querySelector("form[data-form]");
    if (form) {
      const step = form.dataset.form;
      form.addEventListener("submit", e => { e.preventDefault(); onContinue(step, form); });
      const input = form.querySelector("input[type=text],input[type=email],textarea");
      if (input) input.addEventListener("input", () => { state.draft[input.id] = input.value; err(""); input.removeAttribute("aria-invalid"); });
      if (step === "photos") wirePhotos();
    }
  }

  async function onContinue(step, form) {
    if (step === "name") {
      const v = form.elements.name.value.trim();
      if (!v) return err("Enter a name or nickname.");
      state.name = v;
    } else if (step === "email") {
      const v = form.elements.email.value.trim();
      if (!v) return err("Enter your email.");
      if (!EMAIL_RE.test(v)) return err("Enter a valid email.");
      state.email = v;
    } else if (step === "instagram") {
      const r = parseInstagram(form.elements.instagram.value);
      if (r.error) return err(r.error);
      state.instagram = r.value;
    } else if (step === "photos") {
      await pendingPhotos;   // never leave while a photo is still being read
      if (!state.photos.length) return err("Add at least one photo.");
      const what = form.elements.offering.value.trim();
      if (!what) return err("Tell us what you’re trying to sell.");
      state.offering = what;
    }
    delete state.draft[step];
    if (step === "photos") delete state.draft.offering;
    goNext(step);
  }

  function wirePhotos() {
    const input = document.getElementById("applyFiles");
    const drop = document.getElementById("applyDrop");
    const strip = document.getElementById("applyStrip");

    async function handle(list) {
      err("");
      drop.classList.add("is-busy");
      pendingPhotos = addFiles(list);
      const errors = await pendingPhotos;
      drop.classList.remove("is-busy");
      strip.innerHTML = thumbsHTML();
      if (errors.length) err(errors.join(" "));
    }

    input.addEventListener("change", () => { const l = Array.from(input.files); input.value = ""; handle(l); });
    ["dragenter", "dragover"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add("is-over"); }));
    ["dragleave", "drop"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove("is-over"); }));
    drop.addEventListener("drop", e => handle(e.dataTransfer ? e.dataTransfer.files : []));

    strip.addEventListener("click", e => {
      const btn = e.target.closest("[data-rm]");
      if (!btn) return;
      removePhoto(Number(btn.dataset.rm));
      strip.innerHTML = thumbsHTML();
      err("");
      input.focus();
    });
  }

  /* —— Buttons (one delegated listener for every screen) —— */
  root.addEventListener("click", async e => {
    const act = e.target.closest("[data-act]");
    const edit = e.target.closest("[data-edit]");

    if (edit) { state.fromReview = true; show(edit.dataset.edit); return; }
    if (!act) return;

    const a = act.dataset.act;
    const form = root.querySelector("form[data-form]");
    const step = form ? form.dataset.form : state.screen;

    if (a === "start") { show("name"); return; }
    if (a === "back") { goBack(step); return; }
    if (a === "skip") { state.instagram = ""; goNext("instagram"); return; }

    if (a === "submit") {
      if (state.submitting) return;
      state.submitting = true;
      act.disabled = true;
      act.textContent = "Sending…";
      err("");
      try {
        const result = await submit();
        if (result === "ok") {
          notify();
          show("sent");
          return;
        }
        err({
          duplicate: "This email already has an application. We’ll be in touch.",
          busy: "Too many applications right now. Try again in a few minutes.",
          photos: "A photo didn’t upload. Try again.",
          invalid: "Something in the application isn’t valid. Check your answers."
        }[result] || "Could not send. Try again.");
        // 'photos' means a stored file is missing; re-send everything on retry.
        if (result === "photos") state.photos.forEach(p => { p.uploaded = false; });
      } catch (ex) {
        console.error(ex);
        err("Could not send. Your answers and photos are still here. Try again.");
      } finally {
        state.submitting = false;
        const btn = document.getElementById("applySubmit");
        if (btn) { btn.disabled = false; btn.textContent = "Submit application"; }
      }
    }
  });

  show("intro", { focus: false });
})();
