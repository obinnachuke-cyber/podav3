/* ============================================================
   tz.js — timezone helpers for scheduled drops.

   A drop time is typed as a wall-clock time in a named IANA timezone
   (e.g. "2026-11-06T09:00" in "America/New_York"), converted to a UTC
   instant for storage (edits.publish_at is timestamptz), and displayed back
   in that same timezone so it never silently shifts with whoever is looking.

   Works in the browser (window.PodaTZ) and in Node (module.exports) so the
   conversion can be unit-tested.
   ============================================================ */
(function (root) {
  "use strict";

  // Offset (ms) of `timeZone` from UTC at the UTC instant `utcMs`.
  function offsetAt(utcMs, timeZone) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    }).formatToParts(new Date(utcMs));
    const get = type => Number(parts.find(p => p.type === type).value);
    const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"),
                           get("hour"), get("minute"), get("second"));
    return asUTC - Math.floor(utcMs / 1000) * 1000;
  }

  // UTC instant → "YYYY-MM-DDTHH:mm" wall-clock text in `timeZone`.
  function utcToZonedLocal(iso, timeZone) {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return "";
    const local = new Date(ms + offsetAt(ms, timeZone));
    const p = n => String(n).padStart(2, "0");
    return `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())}` +
           `T${p(local.getUTCHours())}:${p(local.getUTCMinutes())}`;
  }

  // "YYYY-MM-DDTHH:mm" wall-clock text in `timeZone` → { ok, iso | error }.
  // - A time skipped by a spring-forward clock change doesn't exist: error.
  // - A time repeated by a fall-back change is ambiguous: the earlier one wins.
  function zonedLocalToUtc(localText, timeZone) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(localText || ""));
    if (!m) return { ok: false, error: "Enter a date and time." };
    const [, y, mo, d, h, mi] = m.map(Number);
    const wall = Date.UTC(y, mo - 1, d, h, mi);

    let utc;
    try {
      // Two passes settle on the correct offset around a DST boundary.
      utc = wall - offsetAt(wall, timeZone);
      utc = wall - offsetAt(utc, timeZone);
    } catch (e) {
      return { ok: false, error: "Unknown timezone." };
    }

    // Round-trip: if it doesn't read back the same, the wall time never existed.
    if (utcToZonedLocal(new Date(utc).toISOString(), timeZone) !== localText) {
      return { ok: false, error: "That time doesn't exist in this timezone (clocks change). Pick another." };
    }

    // Ambiguous (repeated) wall time: prefer the earlier instant.
    const earlier = utc - 3600 * 1000;
    if (utcToZonedLocal(new Date(earlier).toISOString(), timeZone) === localText) utc = earlier;

    return { ok: true, iso: new Date(utc).toISOString() };
  }

  // Human text for a UTC instant, in the release's own timezone when known.
  function formatInZone(iso, timeZone, withTime) {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return "";
    const opts = { month: "short", day: "numeric" };
    if (withTime !== false) {
      opts.hour = "numeric";
      opts.minute = "2-digit";
      opts.timeZoneName = "short";
    }
    if (timeZone) opts.timeZone = timeZone;
    try {
      return new Date(ms).toLocaleString("en-US", opts);
    } catch (e) {
      delete opts.timeZone;
      return new Date(ms).toLocaleString("en-US", opts);
    }
  }

  function browserZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
    catch (e) { return "UTC"; }
  }

  // A short, readable list; the full IANA list when the browser offers it.
  function zoneList() {
    const common = [
      "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
      "America/Toronto", "America/Sao_Paulo", "Europe/London", "Europe/Paris",
      "Europe/Berlin", "Africa/Lagos", "Asia/Dubai", "Asia/Kolkata",
      "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney", "UTC"
    ];
    let all = [];
    try { all = Intl.supportedValuesOf("timeZone"); } catch (e) { /* older browsers */ }
    const rest = all.filter(z => !common.includes(z));
    return { common, rest };
  }

  const api = { offsetAt, utcToZonedLocal, zonedLocalToUtc, formatInZone, browserZone, zoneList };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PodaTZ = api;
})(typeof window !== "undefined" ? window : globalThis);
