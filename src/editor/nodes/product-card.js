import { Node, mergeAttributes } from "@tiptap/core";
import { validateImageFile } from "../validate-upload.js";
import { isSafeUrl } from "../safe-url.js";
import { updateNodeAttrs, buildControlRow, el } from "./utils.js";

// Product Card — either linked to an existing Poda item (The Edit) or an
// external URL. `getProducts` is supplied by the host app (already-loaded
// items from PodaDB.getItems()); this bundle never talks to Supabase itself.
export const PodaProductCard = Node.create({
  name: "podaProductCard",
  group: "block",
  atom: true,

  addOptions() {
    return {
      getProducts: () => [],
      uploadImage: () => Promise.reject(new Error("uploadImage not configured")),
      itemUrl: id => `item.html?id=${encodeURIComponent(id)}`,
    };
  },

  addAttributes() {
    return {
      itemId: { default: null },
      externalUrl: { default: "" },
      linkTarget: { default: "item" }, // item | external
      name: { default: "" },
      brand: { default: "" },
      price: { default: "" },
      image: { default: "" },
      commentary: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: "a[data-poda-product-card]" }];
  },

  renderHTML({ node }) {
    const { name, brand, price, image, commentary, linkTarget, itemId, externalUrl } = node.attrs;
    const rawHref = linkTarget === "item" && itemId ? this.options.itemUrl(itemId) : externalUrl;
    const attrs = { class: "note-article__product-card", href: isSafeUrl(rawHref) ? rawHref : "#", "data-poda-product-card": "" };
    if (linkTarget === "external") {
      attrs.target = "_blank";
      attrs.rel = "noopener";
    }

    const children = [];
    if (image) {
      children.push(["div", { class: "note-article__product-image" }, ["img", { src: image, alt: name || "", loading: "lazy" }]]);
    }
    const info = [];
    if (brand) info.push(["p", { class: "note-article__product-brand" }, brand]);
    info.push(["p", { class: "note-article__product-name" }, name || "Untitled product"]);
    if (price) info.push(["p", { class: "note-article__product-price" }, `$${price}`]);
    if (commentary) info.push(["p", { class: "note-article__product-commentary" }, commentary]);
    info.push(["span", { class: "note-article__product-cta" }, linkTarget === "item" ? "Shop The Edit →" : "Shop →"]);
    children.push(["div", { class: "note-article__product-info" }, ...info]);

    return ["a", mergeAttributes(attrs), ...children];
  },

  addNodeView() {
    const options = this.options;

    return ({ editor, node: initialNode, getPos }) => {
      let node = initialNode;
      const dom = el("div", "pe-product-card");

      function render() {
        dom.innerHTML = "";
        dom.appendChild(buildControlRow(editor, getPos, () => node, {
          extra: [el("span", "pe-node-controls__label", { text: "Product Card" })],
        }));

        const typeRow = el("div", "pe-image__option-row");
        [["item", "Poda Product"], ["external", "External URL"]].forEach(([value, label]) => {
          const b = el("button", `pe-chip${node.attrs.linkTarget === value ? " pe-chip--active" : ""}`, { type: "button", text: label });
          b.addEventListener("click", () => updateNodeAttrs(editor, getPos, node, { linkTarget: value }));
          typeRow.appendChild(b);
        });
        dom.appendChild(typeRow);

        if (node.attrs.linkTarget === "item") {
          dom.appendChild(renderProductPicker());
        } else {
          dom.appendChild(labeledInput("External product URL", node.attrs.externalUrl, val =>
            updateNodeAttrs(editor, getPos, node, { externalUrl: val })));
        }

        const fields = el("div", "pe-product-card__fields");
        fields.appendChild(labeledInput("Product name", node.attrs.name, val => updateNodeAttrs(editor, getPos, node, { name: val })));
        fields.appendChild(labeledInput("Brand", node.attrs.brand, val => updateNodeAttrs(editor, getPos, node, { brand: val })));
        fields.appendChild(labeledInput("Price", node.attrs.price, val => updateNodeAttrs(editor, getPos, node, { price: val })));
        dom.appendChild(fields);

        dom.appendChild(renderImageField());

        const commentaryField = el("label", "pe-field");
        commentaryField.appendChild(el("span", "pe-field__label", { text: "Editorial commentary (optional)" }));
        const textarea = el("textarea", "pe-field__input", {});
        textarea.rows = 2;
        textarea.value = node.attrs.commentary || "";
        textarea.addEventListener("input", () => updateNodeAttrs(editor, getPos, node, { commentary: textarea.value }));
        commentaryField.appendChild(textarea);
        dom.appendChild(commentaryField);
      }

      function labeledInput(labelText, value, onChange) {
        const wrap = el("label", "pe-field");
        wrap.appendChild(el("span", "pe-field__label", { text: labelText }));
        const input = el("input", "pe-field__input", { type: "text" });
        input.value = value || "";
        input.addEventListener("input", () => onChange(input.value));
        wrap.appendChild(input);
        return wrap;
      }

      function renderProductPicker() {
        const wrap = el("div", "pe-product-card__picker");
        const search = el("input", "pe-field__input", { type: "text", placeholder: "Search Poda items by name or brand…" });
        const results = el("div", "pe-product-card__results");
        wrap.append(search, results);

        function runSearch(query) {
          const products = options.getProducts() || [];
          const q = query.trim().toLowerCase();
          const matches = (q
            ? products.filter(p =>
                String(p.itemName || "").toLowerCase().includes(q) ||
                String(p.brand || "").toLowerCase().includes(q))
            : products
          ).slice(0, 8);

          results.innerHTML = "";
          if (!matches.length) {
            results.appendChild(el("p", "pe-product-card__no-results", { text: "No matching items." }));
            return;
          }
          matches.forEach(item => {
            const row = el("button", "pe-product-card__result", { type: "button" });
            const price = item.pricing && item.pricing.currentListPrice;
            row.textContent = `${item.brand || "—"} · ${item.itemName || "Untitled"}${price ? ` · $${price}` : ""}`;
            row.addEventListener("click", () => {
              const image = item.primaryImage || (Array.isArray(item.images) && item.images[0]) || "";
              updateNodeAttrs(editor, getPos, node, {
                itemId: item.id,
                name: item.itemName || "",
                brand: item.brand || "",
                price: price ? String(price) : "",
                image,
              });
            });
            results.appendChild(row);
          });
        }

        search.addEventListener("input", () => runSearch(search.value));
        runSearch("");

        if (node.attrs.itemId) {
          const selected = el("p", "pe-product-card__selected", { text: `Linked to item: ${node.attrs.itemId}` });
          wrap.appendChild(selected);
        }

        return wrap;
      }

      function renderImageField() {
        const wrap = el("div", "pe-product-card__image");
        if (node.attrs.image) {
          const img = el("img", "pe-image__img", { src: node.attrs.image, alt: "" });
          wrap.appendChild(img);
          const replace = el("button", "btn btn--small btn--ghost", { type: "button", text: "Replace Image" });
          replace.addEventListener("click", () => updateNodeAttrs(editor, getPos, node, { image: "" }));
          wrap.appendChild(replace);
        } else {
          const btn = el("button", "btn btn--small", { type: "button", text: "Upload Product Image" });
          const input = el("input", "", { type: "file", accept: "image/jpeg,image/png,image/webp", hidden: "" });
          const error = el("p", "pe-image__error", { hidden: "" });
          btn.addEventListener("click", () => input.click());
          input.addEventListener("change", () => {
            const file = input.files && input.files[0];
            if (!file) return;
            const check = validateImageFile(file);
            if (!check.ok) {
              error.textContent = check.error;
              error.hidden = false;
              return;
            }
            error.hidden = true;
            options.uploadImage(file, {}).then(url => {
              updateNodeAttrs(editor, getPos, node, { image: url });
            }).catch(err => {
              error.textContent = (err && err.message) || "Upload failed.";
              error.hidden = false;
            });
            input.value = "";
          });
          wrap.append(btn, input, error);
        }
        return wrap;
      }

      render();

      return {
        dom,
        update(updatedNode) {
          if (updatedNode.type.name !== "podaProductCard") return false;
          // name/brand/price/commentary/externalUrl are typed into live
          // inputs — only rebuild for changes that alter the card's shape
          // (switching link type, picking a product, adding/removing the
          // image), or focus would be lost mid-keystroke.
          const structural =
            updatedNode.attrs.linkTarget !== node.attrs.linkTarget ||
            updatedNode.attrs.itemId !== node.attrs.itemId ||
            Boolean(updatedNode.attrs.image) !== Boolean(node.attrs.image);
          node = updatedNode;
          if (structural) render();
          return true;
        },
      };
    };
  },
});
