import { Node, mergeAttributes } from "@tiptap/core";
import { isSafeUrl } from "../safe-url.js";
import { updateNodeAttrs, deleteSelfNode, el } from "./utils.js";

// Sources — a repeatable (name, title, url, date) list. The toolbar only
// ever inserts one of these per document (see studio.js insertSources) and
// always at the end, matching "render this section consistently at the
// end of the Note."
export const PodaSources = Node.create({
  name: "podaSources",
  group: "block",
  atom: true,

  addAttributes() {
    return {
      entries: { default: [] }, // [{ name, title, url, date }]
    };
  },

  parseHTML() {
    return [{ tag: "div[data-poda-sources]" }];
  },

  renderHTML({ node }) {
    const entries = Array.isArray(node.attrs.entries) ? node.attrs.entries : [];
    const items = entries
      .filter(entry => entry && (entry.name || entry.title || entry.url))
      .map(entry => {
        const parts = [];
        if (entry.name) parts.push(["span", { class: "note-article__source-name" }, entry.name]);
        const label = entry.title || entry.url || "Source";
        parts.push(isSafeUrl(entry.url)
          ? ["a", { class: "note-article__source-title", href: entry.url, target: "_blank", rel: "noopener" }, label]
          : ["span", { class: "note-article__source-title" }, label]);
        if (entry.date) parts.push(["span", { class: "note-article__source-date" }, entry.date]);
        return ["li", { class: "note-article__source" }, ...parts];
      });

    const label = ["p", { class: "note-article__sources-label" }, "Sources"];
    const list = ["ul", { class: "note-article__sources-list" }, ...items];
    return ["div", mergeAttributes({ class: "note-article__sources", "data-poda-sources": "" }), label, list];
  },

  addNodeView() {
    return ({ editor, node: initialNode, getPos }) => {
      let node = initialNode;
      const dom = el("div", "pe-sources");

      function render() {
        dom.innerHTML = "";

        const header = el("div", "pe-node-controls");
        header.appendChild(el("span", "pe-node-controls__label", { text: "Sources" }));
        const del = el("button", "pe-node-controls__btn pe-node-controls__btn--danger", { type: "button", text: "×", "aria-label": "Delete Sources section" });
        del.addEventListener("click", () => {
          if (window.confirm("Remove the Sources section?")) deleteSelfNode(editor, getPos, node);
        });
        header.appendChild(del);
        dom.appendChild(header);

        const entries = Array.isArray(node.attrs.entries) ? node.attrs.entries : [];
        const list = el("div", "pe-sources__list");
        entries.forEach((entry, index) => list.appendChild(renderRow(entry, index)));
        dom.appendChild(list);

        const addBtn = el("button", "btn btn--small", { type: "button", text: "+ Add Source" });
        addBtn.addEventListener("click", () => {
          const next = entries.concat([{ name: "", title: "", url: "", date: "" }]);
          updateNodeAttrs(editor, getPos, node, { entries: next });
        });
        dom.appendChild(addBtn);
      }

      function renderRow(entry, index) {
        const row = el("div", "pe-sources__row");

        function field(labelText, key, type) {
          const wrap = el("label", "pe-field pe-field--compact");
          wrap.appendChild(el("span", "pe-field__label", { text: labelText }));
          const input = el("input", "pe-field__input", { type: type || "text" });
          input.value = entry[key] || "";
          input.addEventListener("input", () => {
            const entries = (Array.isArray(node.attrs.entries) ? node.attrs.entries : []).slice();
            entries[index] = { ...entries[index], [key]: input.value };
            updateNodeAttrs(editor, getPos, node, { entries });
          });
          wrap.appendChild(input);
          return wrap;
        }

        row.appendChild(field("Source name", "name"));
        row.appendChild(field("Article / page title", "title"));
        row.appendChild(field("URL", "url", "url"));
        row.appendChild(field("Date (optional)", "date", "date"));

        const remove = el("button", "pe-node-controls__btn pe-node-controls__btn--danger", { type: "button", text: "×", "aria-label": "Remove source" });
        remove.addEventListener("click", () => {
          const entries = (Array.isArray(node.attrs.entries) ? node.attrs.entries : []).slice();
          entries.splice(index, 1);
          updateNodeAttrs(editor, getPos, node, { entries });
        });
        row.appendChild(remove);

        return row;
      }

      render();

      return {
        dom,
        update(updatedNode) {
          if (updatedNode.type.name !== "podaSources") return false;
          node = updatedNode;
          if (!dom.contains(document.activeElement)) render();
          return true;
        },
      };
    };
  },
});
