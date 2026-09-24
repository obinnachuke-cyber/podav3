import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";

import { PodaImage } from "./nodes/image.js";
import { PodaThesis } from "./nodes/thesis.js";
import { PodaPullQuote } from "./nodes/pull-quote.js";
import { PodaImageText } from "./nodes/image-text.js";
import { PodaProductCard } from "./nodes/product-card.js";
import { PodaSources } from "./nodes/sources.js";
import { buildToolbar } from "./toolbar.js";
import { isSafeUrl } from "./safe-url.js";

export const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };

export function extensions(opts) {
  const uploadImage = opts.uploadImage;
  return [
    StarterKit.configure({
      heading: { levels: [2, 3] },
      codeBlock: false,
      code: false,
      strike: false,
    }),
    Link.configure({
      openOnClick: false,
      autolink: true,
      validate: href => isSafeUrl(href),
    }),
    Placeholder.configure({ placeholder: "Start writing your Market Note…" }),
    PodaImage.configure({ uploadImage }),
    PodaThesis,
    PodaPullQuote,
    PodaImageText.configure({ uploadImage }),
    PodaProductCard.configure({
      uploadImage,
      getProducts: opts.getProducts || (() => []),
      itemUrl: opts.itemUrl || (id => `item.html?id=${encodeURIComponent(id)}`),
    }),
    PodaSources,
  ];
}

// Mounts a full editing surface (toolbar + content area) into `container`.
// `opts.uploadImage(file, { onProgress }) => Promise<url>` and
// `opts.getProducts() => item[]` are supplied by admin.js so this bundle
// never talks to Supabase directly.
export function mount(container, opts) {
  opts = opts || {};
  container.innerHTML = "";

  const shell = document.createElement("div");
  shell.className = "pe-shell";
  const toolbarSlot = document.createElement("div");
  toolbarSlot.className = "pe-toolbar-slot";
  const editorSlot = document.createElement("div");
  editorSlot.className = "pe-content";
  shell.append(toolbarSlot, editorSlot);
  container.appendChild(shell);

  const editor = new Editor({
    element: editorSlot,
    extensions: extensions(opts),
    content: opts.content && opts.content.type ? opts.content : EMPTY_DOC,
    onUpdate: ({ editor: ed }) => {
      if (opts.onUpdate) opts.onUpdate(ed.getJSON());
    },
  });

  const toolbar = buildToolbar(editor, { onNotice: opts.onNotice });
  toolbarSlot.appendChild(toolbar);

  return {
    editor,
    getJSON: () => editor.getJSON(),
    setContent: json => editor.commands.setContent(json && json.type ? json : EMPTY_DOC, false),
    focus: () => editor.commands.focus(),
    destroy: () => editor.destroy(),
    isEmpty: () => editor.isEmpty,
  };
}
