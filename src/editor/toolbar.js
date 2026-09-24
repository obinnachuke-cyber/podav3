import { el } from "./nodes/utils.js";
import { isSafeUrl } from "./safe-url.js";

function hasSourcesNode(editor) {
  let found = false;
  editor.state.doc.forEach(child => {
    if (child.type.name === "podaSources") found = true;
  });
  return found;
}

function appendAtEnd(editor, content) {
  const pos = editor.state.doc.content.size;
  editor.chain().focus().insertContentAt(pos, content).run();
}

function btn(label, opts) {
  const b = el("button", "pe-toolbar__btn", { type: "button", "aria-label": opts && opts.label || label, title: opts && opts.title || label });
  b.textContent = label;
  return b;
}

function linkPopover(editor) {
  const wrap = el("div", "pe-toolbar__link-popover", { hidden: "" });
  const input = el("input", "pe-toolbar__link-input", { type: "url", placeholder: "https://…" });
  const apply = el("button", "btn btn--small", { type: "button", text: "Apply" });
  const remove = el("button", "btn btn--small btn--ghost", { type: "button", text: "Remove link" });
  const error = el("p", "pe-toolbar__link-error", { hidden: "" });
  wrap.append(input, apply, remove, error);

  function open() {
    const prev = editor.getAttributes("link").href || "";
    input.value = prev;
    error.hidden = true;
    wrap.hidden = false;
    input.focus();
  }
  function close() { wrap.hidden = true; }

  apply.addEventListener("click", () => {
    const value = input.value.trim();
    if (!value) { close(); return; }
    if (!isSafeUrl(value)) {
      error.textContent = "Enter a valid http(s) or mailto link.";
      error.hidden = false;
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: value }).run();
    close();
  });
  remove.addEventListener("click", () => {
    editor.chain().focus().unsetLink().run();
    close();
  });
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); apply.click(); }
    if (e.key === "Escape") close();
  });

  return { wrap, open, close };
}

export function buildToolbar(editor, options) {
  const root = el("div", "pe-toolbar");

  const format = el("div", "pe-toolbar__group pe-toolbar__group--format");
  const more = el("div", "pe-toolbar__group pe-toolbar__group--more");
  const insert = el("div", "pe-toolbar__group pe-toolbar__group--insert");

  const moreToggle = btn("More ▾", { label: "More formatting options" });
  moreToggle.className = "pe-toolbar__btn pe-toolbar__more-toggle";
  const insertToggle = btn("+ Insert ▾", { label: "Insert block" });
  insertToggle.className = "pe-toolbar__btn pe-toolbar__insert-toggle";

  const link = linkPopover(editor);

  function toggle(container, toggleBtn) {
    const opening = container.classList.contains("pe-open") === false;
    document.querySelectorAll(".pe-toolbar__group.pe-open").forEach(g => g.classList.remove("pe-open"));
    if (opening) container.classList.add("pe-open");
  }

  moreToggle.addEventListener("click", () => toggle(more, moreToggle));
  insertToggle.addEventListener("click", () => toggle(insert, insertToggle));

  const boldBtn = btn("B", { title: "Bold" });
  boldBtn.addEventListener("click", () => editor.chain().focus().toggleBold().run());

  const italicBtn = btn("I", { title: "Italic" });
  italicBtn.addEventListener("click", () => editor.chain().focus().toggleItalic().run());

  const linkBtn = btn("Link", { title: "Link" });
  linkBtn.addEventListener("click", () => link.open());

  const bulletBtn = btn("• List", { title: "Bulleted list" });
  bulletBtn.addEventListener("click", () => editor.chain().focus().toggleBulletList().run());

  format.append(boldBtn, italicBtn, linkBtn, bulletBtn, link.wrap);

  const h2Btn = btn("H2", { title: "Heading 2" });
  h2Btn.addEventListener("click", () => editor.chain().focus().toggleHeading({ level: 2 }).run());
  const h3Btn = btn("H3", { title: "Heading 3" });
  h3Btn.addEventListener("click", () => editor.chain().focus().toggleHeading({ level: 3 }).run());
  const orderedBtn = btn("1. List", { title: "Numbered list" });
  orderedBtn.addEventListener("click", () => editor.chain().focus().toggleOrderedList().run());
  const quoteBtn = btn("Quote", { title: "Blockquote" });
  quoteBtn.addEventListener("click", () => editor.chain().focus().toggleBlockquote().run());
  const hrBtn = btn("Divider", { title: "Horizontal divider" });
  hrBtn.addEventListener("click", () => editor.chain().focus().setHorizontalRule().run());
  const undoBtn = btn("Undo", { title: "Undo" });
  undoBtn.addEventListener("click", () => editor.chain().focus().undo().run());
  const redoBtn = btn("Redo", { title: "Redo" });
  redoBtn.addEventListener("click", () => editor.chain().focus().redo().run());

  more.append(moreToggle, el("div", "pe-toolbar__menu", {}));
  const moreMenu = more.querySelector(".pe-toolbar__menu");
  moreMenu.append(h2Btn, h3Btn, orderedBtn, quoteBtn, hrBtn, undoBtn, redoBtn);

  const thesisBtn = btn("Poda Thesis", { title: "Insert Poda Thesis callout" });
  thesisBtn.addEventListener("click", () => {
    appendInsertAtSelection(editor, { type: "podaThesis", content: [{ type: "paragraph" }] });
  });
  const quoteBlockBtn = btn("Pull Quote", { title: "Insert pull quote" });
  quoteBlockBtn.addEventListener("click", () => {
    appendInsertAtSelection(editor, { type: "podaPullQuote" });
  });
  const imageBtn = btn("Image", { title: "Insert editorial image" });
  imageBtn.addEventListener("click", () => {
    appendInsertAtSelection(editor, { type: "podaImage" });
  });
  const imageTextBtn = btn("Image + Text", { title: "Insert image + text section" });
  imageTextBtn.addEventListener("click", () => {
    appendInsertAtSelection(editor, { type: "podaImageText", content: [{ type: "paragraph" }] });
  });
  const productBtn = btn("Product Card", { title: "Insert product card" });
  productBtn.addEventListener("click", () => {
    appendInsertAtSelection(editor, { type: "podaProductCard" });
  });
  const sourcesBtn = btn("Sources", { title: "Insert Sources section" });
  sourcesBtn.addEventListener("click", () => {
    if (hasSourcesNode(editor)) {
      if (options && options.onNotice) options.onNotice("This Note already has a Sources section — edit it below instead of adding another.");
      return;
    }
    appendAtEnd(editor, { type: "podaSources", attrs: { entries: [] } });
  });

  insert.append(insertToggle, el("div", "pe-toolbar__menu", {}));
  const insertMenu = insert.querySelector(".pe-toolbar__menu");
  insertMenu.append(thesisBtn, quoteBlockBtn, imageBtn, imageTextBtn, productBtn, sourcesBtn);

  // Inserting one of our atom blocks (Pull Quote, Image, Product Card…)
  // leaves ProseMirror's selection as a NodeSelection wrapping that atom.
  // insertContent() replaces "the current selection" — so a second
  // toolbar click right after the first would replace the atom just
  // inserted instead of adding after it, silently discarding content.
  // insertContentAt(pos, …) with a single numeric position is a pure
  // insertion at that offset instead, immune to what shape the current
  // selection is.
  function appendInsertAtSelection(ed, content) {
    const pos = ed.state.selection.to;
    ed.chain().focus().insertContentAt(pos, content).run();
  }

  root.append(format, more, insert);

  document.addEventListener("click", e => {
    if (!root.contains(e.target)) {
      root.querySelectorAll(".pe-toolbar__group.pe-open").forEach(g => g.classList.remove("pe-open"));
      link.close();
    }
  });

  function setActive(button, isActive) {
    button.classList.toggle("pe-toolbar__btn--active", !!isActive);
  }

  function updateActiveStates() {
    setActive(boldBtn, editor.isActive("bold"));
    setActive(italicBtn, editor.isActive("italic"));
    setActive(linkBtn, editor.isActive("link"));
    setActive(bulletBtn, editor.isActive("bulletList"));
    setActive(h2Btn, editor.isActive("heading", { level: 2 }));
    setActive(h3Btn, editor.isActive("heading", { level: 3 }));
    setActive(orderedBtn, editor.isActive("orderedList"));
    setActive(quoteBtn, editor.isActive("blockquote"));
  }

  editor.on("transaction", updateActiveStates);
  editor.on("selectionUpdate", updateActiveStates);
  updateActiveStates();

  return root;
}
