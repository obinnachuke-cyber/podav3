import { Node, mergeAttributes } from "@tiptap/core";
import { updateNodeAttrs, buildControlRow, el } from "./utils.js";

// Poda Thesis — the site's existing purple editorial band (style.css
// .purple-band), repurposed as a callout the admin can drop into a Note.
// Holds real ProseMirror content (paragraphs, with bold/italic/link marks)
// so the thesis text stays fully editable, unlike the atomic blocks below.
export const PodaThesis = Node.create({
  name: "podaThesis",
  group: "block",
  content: "paragraph+",
  defining: true,

  addAttributes() {
    return {
      eyebrow: { default: "The poda thesis" },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-poda-thesis]" }];
  },

  // Reuses the site's existing .purple-band editorial highlight treatment
  // (style.css) — the same band already used for note titles/drop heroes —
  // rather than inventing a new color, per the "preserve the existing
  // minimal editorial identity" requirement.
  renderHTML({ node }) {
    const eyebrow = ["p", { class: "note-article__thesis-eyebrow" }, node.attrs.eyebrow || "The poda thesis"];
    const body = ["div", { class: "note-article__thesis-body" }, 0];
    const inner = ["div", { class: "purple-band__inner" }, eyebrow, body];
    return ["div", mergeAttributes({ class: "purple-band note-article__thesis", "data-poda-thesis": "" }), inner];
  },

  addNodeView() {
    return ({ editor, node: initialNode, getPos }) => {
      let node = initialNode;
      const dom = el("div", "pe-thesis");
      const controls = buildControlRow(editor, getPos, () => node);
      dom.appendChild(controls);

      const eyebrowInput = el("input", "pe-thesis__eyebrow-input", { type: "text" });
      eyebrowInput.value = node.attrs.eyebrow || "";
      eyebrowInput.placeholder = "Eyebrow label";
      eyebrowInput.addEventListener("input", () => {
        updateNodeAttrs(editor, getPos, node, { eyebrow: eyebrowInput.value });
      });
      dom.appendChild(eyebrowInput);

      const contentDOM = el("div", "pe-thesis__content");
      dom.appendChild(contentDOM);

      return {
        dom,
        contentDOM,
        update(updatedNode) {
          if (updatedNode.type.name !== "podaThesis") return false;
          node = updatedNode;
          if (document.activeElement !== eyebrowInput) eyebrowInput.value = node.attrs.eyebrow || "";
          return true;
        },
      };
    };
  },
});
