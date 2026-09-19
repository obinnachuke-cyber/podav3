/* ============================================================
   submit.js — shared handler for the simple public forms
   (Sell with poda + Sourcing Desk).

   Both forms are just: name + email + Instagram + one message
   box + photos. Photos are compressed in the browser, uploaded
   to the public `submissions` bucket, and their links are added
   to a pre-filled email to poda (mailto can't attach files).

   Usage on a page:
     PodaSubmit.wire({ subjectPrefix: "poda sourcing request",
                       prompt: "What you're looking for" });
   ============================================================ */
(function () {
  "use strict";

  // Shrink big phone photos before upload so emails/links stay light.
  function compressImage(file, maxDim = 1600, quality = 0.82) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          blob => (blob ? resolve(blob) : reject(new Error("Could not process image."))),
          "image/jpeg",
          quality
        );
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read image.")); };
      img.src = url;
    });
  }

  function wire(opts) {
    const subjectPrefix = opts.subjectPrefix || "poda submission";
    const prompt = opts.prompt || "Message";

    const form = document.getElementById("submitForm");
    if (!form) return;

    const email = window.PODA_CONTACT_EMAIL || "";
    const handle = window.PODA_INSTAGRAM || "podacapital";
    const errorBox = document.getElementById("formError");
    const successBox = document.getElementById("formSuccess");
    const submitBtn = document.getElementById("submitBtn");
    const instaLink = document.getElementById("instaLink");
    const input = document.getElementById("imageInput");
    const strip = document.getElementById("imageStrip");
    if (instaLink) instaLink.href = "https://instagram.com/" + handle;

    const get = id => (document.getElementById(id).value || "").trim();

    // —— Photo selection + preview (kept in memory until submit) ——
    let files = [];
    input.addEventListener("change", event => {
      Array.from(event.target.files || []).forEach(f => { if (f.type.startsWith("image/")) files.push(f); });
      event.target.value = "";
      renderStrip();
    });
    strip.addEventListener("click", event => {
      const btn = event.target.closest("[data-rm]");
      if (!btn) return;
      files.splice(Number(btn.dataset.rm), 1);
      renderStrip();
    });
    function renderStrip() {
      strip.innerHTML = files.map((f, i) =>
        `<div class="upload-thumb">
           <img src="${URL.createObjectURL(f)}" alt="Selected photo ${i + 1}" />
           <button type="button" data-rm="${i}" aria-label="Remove photo">×</button>
         </div>`
      ).join("");
    }

    function reset() {
      submitBtn.disabled = false;
      submitBtn.textContent = "Send";
    }

    form.addEventListener("submit", async event => {
      event.preventDefault();
      errorBox.hidden = true;
      successBox.hidden = true;

      const name = get("name");
      const from = get("email");
      const message = get("message");

      if (!name || !from || !message) {
        errorBox.textContent = "Name, email, and your message are required.";
        errorBox.hidden = false;
        return;
      }
      if (!email) {
        errorBox.textContent = "Contact email isn't set up yet — DM poda on Instagram instead.";
        errorBox.hidden = false;
        return;
      }

      submitBtn.disabled = true;

      // Upload photos (if any) → collect public URLs.
      let urls = [];
      if (files.length) {
        submitBtn.textContent = "Uploading photos…";
        successBox.hidden = false;
        successBox.textContent = `Uploading ${files.length} photo${files.length === 1 ? "" : "s"}…`;
        try {
          for (const file of files) {
            const blob = await compressImage(file).catch(() => file);
            urls.push(await window.PodaDB.uploadPublicImage(blob));
          }
        } catch (err) {
          console.error(err);
          errorBox.textContent = "Photo upload failed. You can send without photos, or DM on Instagram.";
          errorBox.hidden = false;
          successBox.hidden = true;
          reset();
          return;
        }
      }

      submitBtn.textContent = "Opening email…";
      successBox.hidden = false;
      successBox.textContent = "Opening your email to send to poda…";

      const lines = [
        subjectPrefix + ":", "",
        "Name: " + name,
        "Email: " + from,
        "Instagram: " + get("instagram"), "",
        prompt + ":",
        message
      ];
      if (urls.length) {
        lines.push("", "Photos:");
        urls.forEach(u => lines.push(u));
      }

      window.location.href =
        "mailto:" + email +
        "?subject=" + encodeURIComponent(subjectPrefix + " — " + name) +
        "&body=" + encodeURIComponent(lines.join("\n"));

      setTimeout(reset, 2500);
    });
  }

  window.PodaSubmit = { wire };
})();
