import { Node, mergeAttributes } from "@tiptap/core";
import { validateImageFile } from "../validate-upload.js";
import { updateNodeAttrs, buildControlRow, el } from "./utils.js";

// Editorial Image — Poda's dedicated image block. Atomic (no ProseMirror
// text content): all editing happens through the node view's own controls
// (upload, alt text, caption, display width, alignment), never through
// contentEditable, so the stored src is always a real Storage URL — never
// a pasted base64 data: URL.
export const PodaImage = Node.create({
  name: "podaImage",
  group: "block",
  atom: true,
  draggable: false,

  addOptions() {
    return {
      // (file, { onProgress }) => Promise<string> — supplied by the host app.
      uploadImage: () => Promise.reject(new Error("uploadImage not configured")),
    };
  },

  addAttributes() {
    return {
      src: { default: "" },
      alt: { default: "" },
      caption: { default: "" },
      display: { default: "standard" }, // standard | wide | full
      align: { default: "center" }, // left | center | right
    };
  },

  parseHTML() {
    return [{ tag: "figure[data-poda-image]" }];
  },

  // Also doubles as the canonical website markup: generateHTML() (used by
  // render-website.js) runs this same schema without invoking node views.
  renderHTML({ node }) {
    const { src, alt, caption, display, align } = node.attrs;
    const classes = [
      "note-article__figure",
      `note-article__figure--${display || "standard"}`,
      `note-article__figure--align-${align || "center"}`,
    ].join(" ");
    const children = [
      ["img", { class: "note-article__figure-img", src: src || "", alt: alt || "", loading: "lazy" }],
    ];
    if (caption) children.push(["figcaption", { class: "note-article__caption" }, caption]);
    return ["figure", mergeAttributes({ class: classes, "data-poda-image": "" }), ...children];
  },

  addNodeView() {
    const options = this.options;

    return ({ editor, node: initialNode, getPos }) => {
      let node = initialNode;
      const dom = el("div", "pe-image");

      function render() {
        dom.innerHTML = "";
        dom.appendChild(buildControlRow(editor, getPos, () => node, {
          extra: [labelSpan("Editorial Image")],
        }));

        if (!node.attrs.src) {
          dom.appendChild(renderUploadZone());
        } else {
          dom.appendChild(renderPreview());
        }
      }

      function labelSpan(text) {
        return el("span", "pe-node-controls__label", { text });
      }

      function renderUploadZone() {
        const zone = el("div", "pe-image__dropzone");
        const hint = el("p", "pe-image__hint", { text: "Drag an image here, or" });
        const btn = el("button", "btn btn--small", { type: "button", text: "Choose Image" });
        const input = el("input", "", { type: "file", accept: "image/jpeg,image/png,image/webp", hidden: "" });
        const error = el("p", "pe-image__error", { hidden: "" });

        btn.addEventListener("click", () => input.click());
        input.addEventListener("change", () => {
          const file = input.files && input.files[0];
          if (file) startUpload(file, error);
          input.value = "";
        });

        ["dragenter", "dragover"].forEach(evt => zone.addEventListener(evt, e => {
          e.preventDefault();
          zone.classList.add("pe-image__dropzone--active");
        }));
        ["dragleave", "drop"].forEach(evt => zone.addEventListener(evt, e => {
          e.preventDefault();
          zone.classList.remove("pe-image__dropzone--active");
        }));
        zone.addEventListener("drop", e => {
          const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
          if (file) startUpload(file, error);
        });

        zone.append(hint, btn, input, error);
        return zone;
      }

      function startUpload(file, errorEl) {
        const check = validateImageFile(file);
        if (!check.ok) {
          errorEl.textContent = check.error;
          errorEl.hidden = false;
          return;
        }
        errorEl.hidden = true;

        const progressWrap = el("div", "pe-image__progress");
        const bar = el("div", "pe-image__progress-bar");
        progressWrap.appendChild(bar);
        dom.appendChild(progressWrap);

        options
          .uploadImage(file, {
            onProgress: pct => { bar.style.width = `${Math.round(pct)}%`; },
          })
          .then(url => {
            updateNodeAttrs(editor, getPos, node, { src: url });
          })
          .catch(err => {
            progressWrap.remove();
            const error = el("p", "pe-image__error", { text: (err && err.message) || "Upload failed. Please try again." });
            dom.appendChild(error);
          });
      }

      function renderPreview() {
        const wrap = el("div", `pe-image__preview pe-image__preview--${node.attrs.display}`);
        const img = el("img", "pe-image__img", { src: node.attrs.src, alt: node.attrs.alt || "" });
        wrap.appendChild(img);

        const fields = el("div", "pe-image__fields");

        const altField = labeledInput("Alt text (required)", node.attrs.alt, val => updateNodeAttrs(editor, getPos, node, { alt: val }));
        if (!node.attrs.alt) altField.querySelector("input").classList.add("pe-input--warning");
        fields.appendChild(altField);

        fields.appendChild(labeledInput("Caption (optional)", node.attrs.caption, val => updateNodeAttrs(editor, getPos, node, { caption: val })));

        const displayRow = el("div", "pe-image__option-row");
        displayRow.appendChild(labelSpan("Display"));
        [["standard", "Standard"], ["wide", "Wide"], ["full", "Full-width"]].forEach(([value, label]) => {
          const b = el("button", `pe-chip${node.attrs.display === value ? " pe-chip--active" : ""}`, { type: "button", text: label });
          b.addEventListener("click", () => updateNodeAttrs(editor, getPos, node, { display: value }));
          displayRow.appendChild(b);
        });
        fields.appendChild(displayRow);

        const alignRow = el("div", "pe-image__option-row");
        alignRow.appendChild(labelSpan("Align"));
        [["left", "Left"], ["center", "Center"], ["right", "Right"]].forEach(([value, label]) => {
          const b = el("button", `pe-chip${node.attrs.align === value ? " pe-chip--active" : ""}`, { type: "button", text: label });
          b.addEventListener("click", () => updateNodeAttrs(editor, getPos, node, { align: value }));
          alignRow.appendChild(b);
        });
        fields.appendChild(alignRow);

        const replace = el("button", "btn btn--small btn--ghost", { type: "button", text: "Replace Image" });
        replace.addEventListener("click", () => updateNodeAttrs(editor, getPos, node, { src: "" }));
        fields.appendChild(replace);

        wrap.appendChild(fields);
        return wrap;
      }

      function labeledInput(labelText, value, onChange) {
        const wrap = el("label", "pe-field");
        wrap.appendChild(el("span", "pe-field__label", { text: labelText }));
        const input = el("input", "pe-field__input", { type: "text", value });
        input.value = value || "";
        input.addEventListener("input", () => onChange(input.value));
        wrap.appendChild(input);
        return wrap;
      }

      render();

      return {
        dom,
        update(updatedNode) {
          if (updatedNode.type.name !== "podaImage") return false;
          // Only rebuild the DOM for structural changes. Alt/caption text
          // fields update node.attrs on every keystroke via updateNodeAttrs;
          // re-rendering on those would tear down the focused <input> and
          // make typing impossible.
          const structural =
            updatedNode.attrs.src !== node.attrs.src ||
            updatedNode.attrs.display !== node.attrs.display ||
            updatedNode.attrs.align !== node.attrs.align;
          node = updatedNode;
          if (structural) render();
          return true;
        },
      };
    };
  },
});
