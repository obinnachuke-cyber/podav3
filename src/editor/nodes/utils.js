// Shared helpers for Poda's custom Tiptap node views. Node views render their
// own plain-DOM controls (inputs, buttons) outside ProseMirror's managed
// content, so attribute edits and reordering go through the editor's
// transaction API directly rather than through NodeView contentDOM.

export function updateNodeAttrs(editor, getPos, node, patch) {
  if (typeof getPos !== "function") return;
  const pos = getPos();
  if (pos == null) return;
  const tr = editor.view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...patch });
  editor.view.dispatch(tr);
}

export function deleteSelfNode(editor, getPos, node) {
  if (typeof getPos !== "function") return;
  const pos = getPos();
  if (pos == null) return;
  editor.view.dispatch(editor.view.state.tr.delete(pos, pos + node.nodeSize));
}

// Swaps this node with its previous/next top-level sibling. Blunt but
// reliable: Market Notes are short documents, so rebuilding the doc's
// top-level child list is cheap and avoids fiddly step-by-step ProseMirror
// range math for a "move block up/down" action.
export function moveSelfNode(editor, getPos, direction) {
  if (typeof getPos !== "function") return;
  const pos = getPos();
  if (pos == null) return;

  const { state, view } = editor;
  const doc = state.doc;
  let index = -1;
  let i = 0;
  doc.forEach((_child, offset) => {
    if (offset === pos) index = i;
    i += 1;
  });
  if (index < 0) return;

  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= doc.childCount) return;

  const nodes = [];
  doc.forEach(child => nodes.push(child));
  const [moved] = nodes.splice(index, 1);
  nodes.splice(targetIndex, 0, moved);

  const tr = state.tr.replaceWith(0, doc.content.size, nodes);
  view.dispatch(tr);
}

export function el(tag, className, attrs) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (attrs) {
    Object.keys(attrs).forEach(key => {
      if (attrs[key] == null) return;
      if (key === "text") node.textContent = attrs[key];
      else node.setAttribute(key, attrs[key]);
    });
  }
  return node;
}

// Every custom node view gets the same "move up / move down / delete"
// control row so behavior is consistent and touch targets stay >=44px.
export function buildControlRow(editor, getPos, getNode, opts) {
  const row = el("div", "pe-node-controls");
  const up = el("button", "pe-node-controls__btn", { type: "button", "aria-label": "Move block up", title: "Move up" });
  up.textContent = "↑";
  const down = el("button", "pe-node-controls__btn", { type: "button", "aria-label": "Move block down", title: "Move down" });
  down.textContent = "↓";
  const del = el("button", "pe-node-controls__btn pe-node-controls__btn--danger", { type: "button", "aria-label": "Delete block", title: "Delete" });
  del.textContent = "×";

  up.addEventListener("click", () => moveSelfNode(editor, getPos, -1));
  down.addEventListener("click", () => moveSelfNode(editor, getPos, 1));
  del.addEventListener("click", () => {
    if (window.confirm("Remove this block?")) deleteSelfNode(editor, getPos, getNode());
  });

  row.append(up, down, del);
  if (opts && opts.extra) opts.extra.forEach(node => row.appendChild(node));
  return row;
}
