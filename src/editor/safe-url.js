const ALLOWED_PROTOCOLS = ["http:", "https:", "mailto:"];

// Used everywhere a URL from admin-authored content reaches an href/src:
// the Link mark, the toolbar's link popover, and both HTML renderers.
// Blocks javascript:/data: etc. so a pasted or typed link can never
// execute script when clicked on the public site or in an email client.
export function isSafeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  try {
    const url = new URL(raw, "https://example.invalid/");
    return ALLOWED_PROTOCOLS.includes(url.protocol);
  } catch (e) {
    return false;
  }
}

export function safeHref(value, fallback) {
  return isSafeUrl(value) ? String(value).trim() : (fallback || "#");
}
