import { Node, mergeAttributes } from "@tiptap/core";
import { validateImageFile } from "../validate-upload.js";
import { updateNodeAttrs, buildControlRow, el } from "./utils.js";

// Image + Text Section — laptop shows an image column beside a text column
// (side + width configurable); style.css stacks it vertically below a
// breakpoint. The text column is real ProseMirror content (contentDOM);
// the image side is attrs edited through node-view controls, same as
// PodaImage, so uploads always land in Storage, never as base64.
export const PodaImageText = Node.create({
  name: "podaImageText",
  group: "block",
  content: "paragraph+",
  defining: true,

  addOptions() {
    return {
      uploadImage: () => Promise.reject(new Error("uploadImage not configured")),
    };
  },

  addAttributes() {
    return {
      imageSrc: { default: "" },
      imageAlt: { default: "" },
      imageSide: { default: "left" }, // left | right
      textWidth: { default: 50 }, // 40 | 50 | 60 (image gets the remainder)
    };
  },

  parseHTML() {
    return [{ tag: "div[data-poda-image-text]" }];
  },

  renderHTML({ node }) {
    const { imageSrc, imageAlt, imageSide, textWidth } = node.attrs;
    const classes = [
      "note-article__two-col",
      imageSide === "right" ? "note-article__two-col--image-right" : "note-article__two-col--image-left",
    ].join(" ");
    const image = ["div", { class: "note-article__two-col-image" }, [
      "img", { src: imageSrc || "", alt: imageAlt || "", loading: "lazy" },
    ]];
    const text = ["div", { class: "note-article__two-col-text" }, 0];
    // A data-width attribute (matched against fixed CSS rules), not an
    // inline style — DOMPurify's default config strips the `style`
    // attribute entirely, which would silently drop this on every save.
    return [
      "div",
      mergeAttributes({ class: classes, "data-width": String(textWidth || 50), "data-poda-image-text": "" }),
      image,
      text,
    ];
  },

  addNodeView() {
    const options = this.options;

    return ({ editor, node: initialNode, getPos }) => {
      let node = initialNode;
      const dom = el("div", "pe-image-text");
      dom.appendChild(buildControlRow(editor, getPos, () => node, {
        extra: [el("span", "pe-node-controls__label", { text: "Image + Text Section" })],
      }));

      const optionsRow = el("div", "pe-image-text__options");

      const sideRow = el("div", "pe-image__option-row");
      sideRow.appendChild(el("span", "pe-node-controls__label", { text: "Image side" }));
      [["left", "Left"], ["right", "Right"]].forEach(([value, label]) => {
        const b = el("button", `pe-chip${node.attrs.imageSide === value ? " pe-chip--active" : ""}`, { type: "button", text: label });
        b.addEventListener("click", () => updateNodeAttrs(editor, getPos, node, { imageSide: value }));
        sideRow.appendChild(b);
      });
      optionsRow.appendChild(sideRow);

      const widthRow = el("div", "pe-image__option-row");
      widthRow.appendChild(el("span", "pe-node-controls__label", { text: "Text width" }));
      [40, 50, 60].forEach(value => {
        const b = el("button", `pe-chip${node.attrs.textWidth === value ? " pe-chip--active" : ""}`, { type: "button", text: `${value}%` });
        b.addEventListener("click", () => updateNodeAttrs(editor, getPos, node, { textWidth: value }));
        widthRow.appendChild(b);
      });
      optionsRow.appendChild(widthRow);
      dom.appendChild(optionsRow);

      const grid = el("div", "pe-image-text__grid");
      grid.style.setProperty("--pe-text-width", `${node.attrs.textWidth}%`);
      grid.classList.toggle("pe-image-text__grid--reverse", node.attrs.imageSide === "right");

      const imageCol = el("div", "pe-image-text__image-col");
      renderImageCol(imageCol);
      const contentDOM = el("div", "pe-image-text__text-col");

      grid.append(imageCol, contentDOM);
      dom.appendChild(grid);

      function renderImageCol(col) {
        col.innerHTML = "";
        if (!node.attrs.imageSrc) {
          const zone = el("div", "pe-image__dropzone pe-image__dropzone--compact");
          const btn = el("button", "btn btn--small", { type: "button", text: "Choose Image" });
          const input = el("input", "", { type: "file", accept: "image/jpeg,image/png,image/webp", hidden: "" });
          const error = el("p", "pe-image__error", { hidden: "" });
          btn.addEventListener("click", () => input.click());
          input.addEventListener("change", () => {
            const file = input.files && input.files[0];
            if (file) startUpload(file, error, col);
            input.value = "";
          });
          zone.append(btn, input, error);
          col.appendChild(zone);
        } else {
          const img = el("img", "pe-image__img", { src: node.attrs.imageSrc, alt: node.attrs.imageAlt || "" });
          col.appendChild(img);
          const altField = el("label", "pe-field");
          altField.appendChild(el("span", "pe-field__label", { text: "Alt text" }));
          const altInput = el("input", "pe-field__input", { type: "text" });
          altInput.value = node.attrs.imageAlt || "";
          altInput.addEventListener("input", () => updateNodeAttrs(editor, getPos, node, { imageAlt: altInput.value }));
          altField.appendChild(altInput);
          col.appendChild(altField);
          const replace = el("button", "btn btn--small btn--ghost", { type: "button", text: "Replace Image" });
          replace.addEventListener("click", () => updateNodeAttrs(editor, getPos, node, { imageSrc: "" }));
          col.appendChild(replace);
        }
      }

      function startUpload(file, errorEl, col) {
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
        col.appendChild(progressWrap);

        options
          .uploadImage(file, { onProgress: pct => { bar.style.width = `${Math.round(pct)}%`; } })
          .then(url => updateNodeAttrs(editor, getPos, node, { imageSrc: url }))
          .catch(err => {
            progressWrap.remove();
            errorEl.textContent = (err && err.message) || "Upload failed. Please try again.";
            errorEl.hidden = false;
          });
      }

      return {
        dom,
        contentDOM,
        update(updatedNode) {
          if (updatedNode.type.name !== "podaImageText") return false;
          // imageAlt is deliberately excluded: it's typed into a live
          // <input>, and rebuilding the column on every keystroke would
          // steal focus from it.
          const attrsChanged =
            updatedNode.attrs.imageSrc !== node.attrs.imageSrc ||
            updatedNode.attrs.imageSide !== node.attrs.imageSide ||
            updatedNode.attrs.textWidth !== node.attrs.textWidth;
          node = updatedNode;
          if (attrsChanged) {
            grid.style.setProperty("--pe-text-width", `${node.attrs.textWidth}%`);
            grid.classList.toggle("pe-image-text__grid--reverse", node.attrs.imageSide === "right");
            renderImageCol(imageCol);
          }
          return true;
        },
      };
    };
  },
});
