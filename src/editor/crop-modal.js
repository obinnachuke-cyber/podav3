// Minimal, dependency-free crop UI. Runs entirely against a local File (via
// an object URL) before it ever reaches uploadImage(), so there's no
// cross-origin/tainted-canvas concern reading pixel data back out for the
// crop — that only becomes a problem for images already served from Storage.
export function openCropModal(file) {
  return new Promise(resolve => {
    const objectUrl = URL.createObjectURL(file);

    const overlay = document.createElement("div");
    overlay.className = "pe-crop-overlay";

    const dialog = document.createElement("div");
    dialog.className = "pe-crop-dialog";

    const hint = document.createElement("p");
    hint.className = "pe-crop-hint";
    hint.textContent = "Drag to select the crop area.";

    const stage = document.createElement("div");
    stage.className = "pe-crop-stage";

    const img = document.createElement("img");
    img.className = "pe-crop-image";
    img.src = objectUrl;
    img.alt = "";

    const selection = document.createElement("div");
    selection.className = "pe-crop-selection";
    selection.hidden = true;

    stage.append(img, selection);

    const actions = document.createElement("div");
    actions.className = "pe-crop-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn btn--small btn--ghost";
    cancelBtn.textContent = "Cancel";
    const useOriginalBtn = document.createElement("button");
    useOriginalBtn.type = "button";
    useOriginalBtn.className = "btn btn--small btn--ghost";
    useOriginalBtn.textContent = "Use Original";
    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.className = "btn btn--small btn--primary";
    applyBtn.textContent = "Apply Crop";
    actions.append(cancelBtn, useOriginalBtn, applyBtn);

    dialog.append(hint, stage, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    let rect = null; // {x, y, w, h} in stage-relative CSS px
    let settled = false;

    function finish(result) {
      if (settled) return;
      settled = true;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      URL.revokeObjectURL(objectUrl);
      overlay.remove();
      resolve(result);
    }

    cancelBtn.addEventListener("click", () => finish(null));
    useOriginalBtn.addEventListener("click", () => finish(file));
    overlay.addEventListener("mousedown", e => {
      if (e.target === overlay) finish(null);
    });

    applyBtn.addEventListener("click", () => {
      if (!rect || rect.w < 4 || rect.h < 4) { finish(file); return; }
      const scaleX = img.naturalWidth / stage.clientWidth;
      const scaleY = img.naturalHeight / stage.clientHeight;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(rect.w * scaleX));
      canvas.height = Math.max(1, Math.round(rect.h * scaleY));
      const ctx = canvas.getContext("2d");
      ctx.drawImage(
        img,
        rect.x * scaleX, rect.y * scaleY, rect.w * scaleX, rect.h * scaleY,
        0, 0, canvas.width, canvas.height,
      );
      const mime = file.type || "image/jpeg";
      canvas.toBlob(blob => {
        if (!blob) { finish(file); return; }
        finish(new File([blob], file.name, { type: mime }));
      }, mime, 0.92);
    });

    function stagePoint(e) {
      const b = stage.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(e.clientX - b.left, b.width)),
        y: Math.max(0, Math.min(e.clientY - b.top, b.height)),
      };
    }

    function updateSelectionDOM() {
      if (!rect) { selection.hidden = true; return; }
      selection.hidden = false;
      selection.style.left = `${rect.x}px`;
      selection.style.top = `${rect.y}px`;
      selection.style.width = `${rect.w}px`;
      selection.style.height = `${rect.h}px`;
    }

    let dragging = false;
    let startX = 0, startY = 0;

    function onMouseMove(e) {
      if (!dragging) return;
      const p = stagePoint(e);
      rect = {
        x: Math.min(startX, p.x),
        y: Math.min(startY, p.y),
        w: Math.abs(p.x - startX),
        h: Math.abs(p.y - startY),
      };
      updateSelectionDOM();
    }
    function onMouseUp() { dragging = false; }

    stage.addEventListener("mousedown", e => {
      dragging = true;
      const p = stagePoint(e);
      startX = p.x; startY = p.y;
      rect = { x: p.x, y: p.y, w: 0, h: 0 };
      updateSelectionDOM();
      e.preventDefault();
    });
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    img.addEventListener("load", () => {
      // Default to the full image so "Apply Crop" without dragging first
      // is a harmless no-op instead of a disabled/confusing button.
      rect = { x: 0, y: 0, w: stage.clientWidth, h: stage.clientHeight };
      updateSelectionDOM();
    });
  });
}
