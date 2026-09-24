import { Node, mergeAttributes } from "@tiptap/core";
import { updateNodeAttrs, buildControlRow, el } from "./utils.js";

export const PodaPullQuote = Node.create({
  name: "podaPullQuote",
  group: "block",
  atom: true,

  addAttributes() {
    return {
      quote: { default: "" },
      attribution: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: "blockquote[data-poda-pull-quote]" }];
  },

  renderHTML({ node }) {
    const children = [["p", { class: "note-article__pull-quote-text" }, node.attrs.quote || ""]];
    if (node.attrs.attribution) {
      children.push(["cite", { class: "note-article__pull-quote-attribution" }, node.attrs.attribution]);
    }
    return ["blockquote", mergeAttributes({ class: "note-article__pull-quote", "data-poda-pull-quote": "" }), ...children];
  },

  addNodeView() {
    return ({ editor, node: initialNode, getPos }) => {
      let node = initialNode;
      const dom = el("div", "pe-pull-quote");
      dom.appendChild(buildControlRow(editor, getPos, () => node, {
        extra: [el("span", "pe-node-controls__label", { text: "Pull Quote" })],
      }));

      const textarea = el("textarea", "pe-pull-quote__text");
      textarea.rows = 3;
      textarea.placeholder = "Enter the pull quote…";
      textarea.value = node.attrs.quote || "";
      textarea.addEventListener("input", () => {
        textarea.style.height = "auto";
        textarea.style.height = `${textarea.scrollHeight}px`;
        updateNodeAttrs(editor, getPos, node, { quote: textarea.value });
      });
      dom.appendChild(textarea);

      const attribution = el("input", "pe-pull-quote__attribution", { type: "text" });
      attribution.placeholder = "Attribution (optional)";
      attribution.value = node.attrs.attribution || "";
      attribution.addEventListener("input", () => {
        updateNodeAttrs(editor, getPos, node, { attribution: attribution.value });
      });
      dom.appendChild(attribution);

      return {
        dom,
        update(updatedNode) {
          if (updatedNode.type.name !== "podaPullQuote") return false;
          node = updatedNode;
          if (document.activeElement !== textarea) textarea.value = node.attrs.quote || "";
          if (document.activeElement !== attribution) attribution.value = node.attrs.attribution || "";
          return true;
        },
      };
    };
  },
});
