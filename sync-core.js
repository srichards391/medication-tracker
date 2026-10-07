/* Meds core
 * Everything about the data that doesn't touch the network or the page: the data format,
 * migration from older versions, which dose applies on which day, the merge rule, and
 * encryption. Kept in its own file so the exact same code runs in the app, in the service
 * worker (for the push reminder text), and in the Node tests (tests/*.test.*).
 *
 * Data format (stored under localStorage "meds.v2"; schedules since v2.0, per-slot doses since v2.1,
 * the afternoon slot and as-needed daily limits since v3.0):
 *
 *   meds: [{ id, name, notes, active, order, createdAt, updatedAt, schedule: [version, ...],
 *            dosage, morning, evening, _mirror }]
 *     schedule: the med's dosing over time, oldest first. Each version applies from its
 *       `from` day ("YYYY-MM-DD", or "" for "from the beginning") until the next version.
 *       version = { from, prn, doses: { morning, afternoon, evening }, dose, maxPerDay, updatedAt,
 *                   + morning, evening, doseByDay (a copy for devices on v2.0) }
 *         doses: per slot, null (not taken then), one dose ("25 mg"), or 7 doses Sunday first.
 *           split by meal    { morning: "10 mg", afternoon: null, evening: "20 mg" }
 *           split by weekday { morning: null, afternoon: null, evening: ["2 mg","1 mg","1 mg","1 mg","2 mg","1 mg","1 mg"] }
 *           afternoon only   { morning: null, afternoon: "300 mg", evening: null }
 *         prn:  true for as-needed meds, with their usual `dose` and an optional `maxPerDay`
 *               (null = no limit). Never due, never missed, never in a reminder.
 *         Devices on v2.x know only morning and evening: they never show an afternoon dose as
 *           due, and a version they write back lacks the afternoon dose (and any maxPerDay), so
 *           it loses a same-time tie to the full copy, which has everything it has and more
 *           (see covers()).
 *         morning, evening, dose, doseByDay: what v2.0 reads. Derived from `doses`; a version
 *           with no `doses` (written by v2.0) gets them derived the other way.
 *       Editing a dose or schedule adds a version starting on a chosen day (default today),
 *       so earlier days keep showing the dose that applied then.
 *     dosage, morning, evening: a copy of the current version in the v1.x shape, so a device
 *       still running v1.1 shows something sensible. _mirror records what that copy was when
 *       this version wrote it; if they differ, a v1.1 device edited the med (see migrateMed).
 *     A deleted med becomes a tombstone { id, deleted: true, order, updatedAt }.
 *
 *   logs: { key: { takenAt, updatedAt, dose? } }
 *     Scheduled dose: key "YYYY-MM-DD|morning|medId" (or evening). One per day, slot and med,
 *       so a dose can never be counted twice.
 *     As-needed dose: key "YYYY-MM-DD|prn:<unique id>|medId". A new key per dose, so several
 *       in one day never collide.
 *     takenAt: ISO time taken, or null when un-taken (the tombstone that lets an undo sync).
 *     dose: the dose as it was when logged. Later schedule edits never change it.
 *       Logs written by v1.x have no dose; the schedule for that day is shown instead.
 *
 *   settings: { breakfast, afternoon, dinner, updatedAt }
 *
 * Merge rule: for each med, each log key, and the settings, the copy with the newest
 * updatedAt wins. A record only one side has is always kept. A med's schedule versions are
 * merged one by one (by `from` day), so a dose change on one device and a note edit on the
 * other both survive. Ties (same updatedAt) go to the copy that has everything the other
 * has plus more (so a v1.1 device dropping a log's dose can't erase it), else to the larger
 * text, so both devices always pick the same winner.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MedsSyncCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '3.1'; // must match APP_VERSION in app.js (checked at startup and by tests)
  const EPOCH = '1970-01-01T00:00:00.000Z';
  const TOMBSTONE_DAYS = 90;
  const PBKDF2_ITERATIONS = 200000;
  const DEFAULT_SETTINGS = { breakfast: '08:00', afternoon: '14:00', dinner: '18:00' };
  const SLOT_IDS = ['morning', 'afternoon', 'evening'];
  const LEGACY_SLOT_IDS = ['morning', 'evening']; // the slots devices on v2.x and v1.x know
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const emptyState = () => ({ meds: [], logs: {}, settings: { ...DEFAULT_SETTINGS, updatedAt: EPOCH } });
  const time = (iso) => { const t = Date.parse(iso); return Number.isNaN(t) ? 0 : t; };
  const byId = (x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  const clone = (v) => JSON.parse(JSON.stringify(v));

  // A timestamp for a local edit. Normally "now", but always later than the version being
  // replaced, so an edit you make always beats the record you were looking at even if this
  // device's clock is a little behind the other one.
  function nextStamp(prevUpdatedAt, now = new Date()) {
    const t = Math.max(now.getTime(), time(prevUpdatedAt) + 1);
    return new Date(t).toISOString();
  }

  // JSON with keys sorted, so two equal records always produce the same text.
  function stableStringify(v) {
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined)
        .map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
    }
    return JSON.stringify(v);
  }

  // ---------- days ----------
  const pad = (n) => String(n).padStart(2, '0');
  // "YYYY-MM-DD" for a Date, in this device's time zone.
  const dayKeyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  // 0 = Sunday ... 6 = Saturday, for a "YYYY-MM-DD" key. Pure calendar math, no time zone.
  function weekdayOf(dayKey) {
    const [y, m, d] = dayKey.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  }

  // ---------- schedules and doses ----------
  // A dose "spec" for one slot is either one dose for every day ("25 mg") or seven doses,
  // Sunday first (["8 mg", "6 mg", ...]). A version's `doses` has one spec per slot, or null
  // when the med isn't taken in that slot. So a dose resolves on two axes, slot and weekday:
  //   { morning: '10 mg', afternoon: null, evening: '20 mg' }          different by slot
  //   { morning: null, afternoon: null, evening: ['2 mg', '1 mg', …] }  different by weekday
  //   { morning: '5 mg', afternoon: null, evening: '5 mg' }            neither
  const cleanDose = (s) => String(s == null ? '' : s).trim();
  const SLOT_NAMES = { morning: 'breakfast', afternoon: 'afternoon', evening: 'dinner' };
  // How a reminder opens: "With breakfast: …", "This afternoon: …", "With dinner: …".
  const SLOT_PHRASES = { morning: 'With breakfast', afternoon: 'This afternoon', evening: 'With dinner' };
  const emptyDoses = () => Object.fromEntries(SLOT_IDS.map((s) => [s, null]));
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function cleanSpec(spec) {
    if (spec == null) return null;
    if (Array.isArray(spec)) return spec.length === 7 ? spec.map(cleanDose) : null;
    if (typeof spec === 'string' || typeof spec === 'number') return cleanDose(spec);
    return null;
  }
  const specsEqual = (a, b) => stableStringify(a) === stableStringify(b);

  // Doses in the v2.0 shape ({ morning, evening, dose, doseByDay }), for versions written by
  // v2.0 or earlier (which have no `doses`), and for input from older callers.
  function dosesFromLegacy(v) {
    if (v.prn) return emptyDoses();
    const byDay = Array.isArray(v.doseByDay) && v.doseByDay.length === 7 ? v.doseByDay.map(cleanDose) : null;
    const spec = byDay || cleanDose(v.dose);
    return { ...emptyDoses(), morning: v.morning ? spec : null, evening: v.evening ? spec : null };
  }

  // "8 mg Sun, Thu · 6 mg Mon, Tue, Wed, Fri, Sat" for a weekday spec, the dose itself otherwise.
  function specText(spec, sep = ' · ') {
    if (spec == null) return '';
    if (!Array.isArray(spec)) return spec;
    const groups = new Map();
    spec.forEach((d, i) => { if (!groups.has(d)) groups.set(d, []); groups.get(d).push(WEEKDAYS[i]); });
    if (groups.size === 1) return spec[0];
    return [...groups].map(([d, days]) => `${d || '(blank)'} ${days.join(', ')}`).join(sep);
  }

  // The fields a device on v2.0 reads, written exactly as v2.0 itself would store them, so its
  // stripped copy of a version is always a subset of ours and loses every merge tie.
  // v2.0 can hold one dose per version: when the slots differ it gets the full description
  // ("200 mg breakfast · 600 mg dinner") as the dose, which is right, just wordy.
  function legacyVersionFields(prn, doses, dose) {
    if (prn) return { morning: false, evening: false, dose, doseByDay: null };
    const present = SLOT_IDS.filter((s) => doses[s] != null).map((s) => doses[s]);
    const same = present.every((spec) => specsEqual(spec, present[0]));
    // Only the slots v2.0 knows get a flag; an afternoon-only med reads as "no schedule" there.
    const out = { morning: doses.morning != null, evening: doses.evening != null, dose: '', doseByDay: null };
    if (present.length && same && Array.isArray(present[0])) out.doseByDay = present[0];
    else if (present.length && same) out.dose = present[0];
    else out.dose = dosesText({ prn, doses, dose });
    return out;
  }

  // As-needed daily limit: a whole number of doses, or null for no limit.
  function cleanMax(n) {
    const x = Math.floor(Number(n));
    return Number.isFinite(x) && x > 0 ? x : null;
  }

  // Accepts the current shape ({ prn, doses, dose, maxPerDay }), the v2.x shapes, or form input in any.
  function normalizeVersion(v, fallbackUpdatedAt) {
    const prn = Boolean(v.prn);
    const hasDoses = !prn && v.doses && typeof v.doses === 'object';
    let doses = hasDoses ? Object.fromEntries(SLOT_IDS.map((s) => [s, cleanSpec(v.doses[s])])) : dosesFromLegacy(v);
    // As-needed meds have one usual dose, an optional daily limit, and no slots.
    const dose = prn ? cleanDose(v.dose) : '';
    if (prn) doses = emptyDoses();
    return {
      from: typeof v.from === 'string' ? v.from : '',
      prn,
      doses,
      ...(prn ? { maxPerDay: cleanMax(v.maxPerDay) } : {}),
      ...legacyVersionFields(prn, doses, dose),
      updatedAt: v.updatedAt || fallbackUpdatedAt || EPOCH,
      // Doses worked out from the v2.0 fields rather than stored. A device on v2.0 drops
      // `doses` from versions it syncs; without this mark, its copy of a split-dose med (10 mg
      // breakfast, 20 mg dinner) would come back as one dose text for both slots and could
      // win a same-time tie. With it, the real copy always wins the tie (see newer()).
      // Once marked, it stays marked (until an edit writes a fresh version).
      // (A v2.1 copy keeps `doses` but drops the afternoon slot; covers() handles that one.)
      ...(!prn && (!hasDoses || v.derived === true) ? { derived: true } : {}),
    };
  }

  // The parts of a version that decide what you take. Two versions with the same text here are the same schedule.
  const scheduleText = (v) => stableStringify({ prn: v.prn, doses: v.doses, dose: v.prn ? v.dose : '', maxPerDay: v.prn ? v.maxPerDay || null : null });

  // Which version applies on a day (the last one starting on or before it).
  function scheduleOn(med, dayKey) {
    let found = null;
    for (const v of med.schedule || []) if (v.from <= dayKey) found = v;
    return found;
  }

  // The dose to take in a slot on a day. As-needed meds: their usual dose.
  // Without a slot it only answers when every slot agrees, and throws otherwise, so no
  // caller can quietly show the breakfast dose at dinner.
  function doseOn(version, dayKey, slotId) {
    if (!version) return '';
    if (version.prn) return version.dose || '';
    const pick = (spec) => (spec == null ? '' : Array.isArray(spec) ? spec[weekdayOf(dayKey)] || '' : spec);
    if (slotId) return pick(version.doses[slotId]);
    const all = SLOT_IDS.filter((s) => version.doses[s] != null).map((s) => pick(version.doses[s]));
    if (all.every((d) => d === all[0])) return all[0] || '';
    throw new Error('doseOn: this med has different doses by slot; pass the slot');
  }

  // Does this slot's dose vary by weekday? Differ between the slots the med is taken in?
  const variesByDay = (version, slotId) => Array.isArray(version.doses[slotId]);
  function variesBySlot(version) {
    const present = SLOT_IDS.filter((s) => version.doses[s] != null).map((s) => version.doses[s]);
    return present.length > 1 && !present.every((spec) => specsEqual(spec, present[0]));
  }

  // The whole dose pattern in words.
  //   "25 mg"   "8 mg Sun, Thu · 6 mg Mon, Tue, Wed, Fri, Sat"   "200 mg breakfast · 600 mg dinner"
  function dosesText(version) {
    if (!version) return '';
    if (version.prn) return version.dose || '';
    const slots = SLOT_IDS.filter((s) => version.doses[s] != null);
    if (!slots.length) return '';
    if (!variesBySlot(version)) return specText(version.doses[slots[0]]);
    return slots.map((s) => Array.isArray(version.doses[s])
      ? `${SLOT_NAMES[s]}: ${specText(version.doses[s], ', ')}`
      : `${version.doses[s]} ${SLOT_NAMES[s]}`).join(' · ');
  }
  const doseSummary = dosesText;

  // One slot's pattern in words, e.g. for the dinner calendar event: "8 mg Sun, Thu · 6 mg …".
  const slotDoseText = (version, slotId) => specText(version && version.doses[slotId]);

  // One line describing a version, for the Meds list and the schedule history.
  function scheduleSummary(version) {
    if (!version) return '';
    const dose = dosesText(version);
    if (version.prn) return `As needed${dose ? ' · ' + dose : ''}${version.maxPerDay ? ` · up to ${version.maxPerDay} a day` : ''}`;
    const when = SLOT_IDS.filter((s) => version.doses[s] != null).map((s) => cap(SLOT_NAMES[s])).join(' + ') || 'No schedule';
    if (variesBySlot(version)) return dose;
    return dose ? `${dose} · ${when}` : when;
  }

  // The v1.x-shaped copy kept on each med for devices still running v1.1.
  function legacyFields(version) {
    return { dosage: dosesText(version), morning: Boolean(version && version.doses.morning != null), evening: Boolean(version && version.doses.evening != null) };
  }
  const legacyText = (m) => stableStringify({ dosage: cleanDose(m.dosage), morning: Boolean(m.morning), evening: Boolean(m.evening) });

  // Add or replace the version starting on `from` (pure: returns a new med).
  function upsertVersion(schedule, version) {
    const out = schedule.filter((v) => v.from !== version.from);
    const existing = schedule.find((v) => v.from === version.from);
    out.push(existing ? newer(existing, version) : version);
    return out.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  }

  // Apply an edit to a med's dose or schedule, starting on day `from`. Earlier days, and every
  // dose already logged, are untouched. Returns the med unchanged if nothing about the
  // schedule actually changed on that day. `todayKey` picks which version the v1.x copy shows.
  function editSchedule(med, from, fields, todayKey, now = new Date()) {
    const current = scheduleOn(med, from);
    const next = normalizeVersion({ ...fields, from }, EPOCH);
    if (current && scheduleText(current) === scheduleText(next)) return med;
    const prevSame = (med.schedule || []).find((v) => v.from === from);
    next.updatedAt = nextStamp(prevSame ? prevSame.updatedAt : med.updatedAt, now);
    const out = { ...med, schedule: upsertVersion(med.schedule || [], next), updatedAt: nextStamp(med.updatedAt, now) };
    return withLegacyFields(out, todayKey);
  }

  function withLegacyFields(med, todayKey) {
    const legacy = legacyFields(scheduleOn(med, todayKey) || (med.schedule || [])[0]);
    return { ...med, ...legacy, _mirror: legacyText(legacy) };
  }

  // A brand-new med. Its first version applies "from the beginning" so a forgotten earlier
  // day can still be logged.
  function newMed(id, fields, order, todayKey, now = new Date()) {
    const at = now.toISOString();
    const version = normalizeVersion({ ...fields, from: '' }, at);
    const med = { id, name: fields.name, notes: fields.notes || '', active: fields.active !== false, order, createdAt: at, updatedAt: at, schedule: [version] };
    return withLegacyFields(med, todayKey);
  }

  // ---------- migration ----------
  // Bring one med from any older shape to the current one. Deterministic, so two devices
  // migrating the same data get the same result.
  function migrateMed(m) {
    const updatedAt = m.updatedAt || m.createdAt || EPOCH;
    if (m.deleted) return { id: m.id, deleted: true, order: Number(m.order) || 0, updatedAt };
    const med = { ...m, updatedAt };

    if (!Array.isArray(m.schedule) || m.schedule.length === 0) {
      // v1.x med: its single dose and meal flags become one version covering all time.
      med.schedule = [normalizeVersion({ from: '', prn: false, morning: m.morning, evening: m.evening, dose: m.dosage }, updatedAt)];
      med._mirror = legacyText(m);
      return med;
    }

    med.schedule = m.schedule.filter((v) => v && typeof v === 'object')
      .map((v) => normalizeVersion(v, updatedAt))
      .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
    // Duplicate `from` days (shouldn't happen) collapse to the newer version.
    med.schedule = med.schedule.reduce((acc, v) => upsertVersion(acc, v), []);

    if (typeof m._mirror === 'string' && legacyText(m) !== m._mirror) {
      // A device still on v1.1 changed the dose text or meal checkboxes. Honour it as a new
      // version starting the day that edit was made. (It can only express one dose for every
      // day; a v1.1 edit to a day-of-week med replaces the day-of-week doses from then on.)
      const from = dayKeyOf(new Date(updatedAt));
      med.schedule = upsertVersion(med.schedule, normalizeVersion({ from, prn: false, morning: m.morning, evening: m.evening, dose: m.dosage, updatedAt }, updatedAt));
      med._mirror = legacyText(m);
    } else if (typeof m._mirror !== 'string') {
      med._mirror = legacyText(m);
    }
    return med;
  }

  // Bring any saved or synced data (v1.x or v2.x) into the current shape. Never throws on odd input.
  function migrate(raw) {
    const out = emptyState();
    if (!raw || typeof raw !== 'object') return out;

    if (Array.isArray(raw.meds)) {
      for (const m of raw.meds) {
        if (!m || typeof m.id !== 'string') continue;
        out.meds.push(migrateMed(m));
      }
    }

    if (raw.logs && typeof raw.logs === 'object') {
      for (const [k, v] of Object.entries(raw.logs)) {
        if (typeof v === 'string') out.logs[k] = { takenAt: v, updatedAt: v };           // v1.0: "key -> ISO taken"
        else if (v && typeof v === 'object') {
          const log = { takenAt: v.takenAt || null, updatedAt: v.updatedAt || v.takenAt || EPOCH };
          if (log.takenAt && typeof v.dose === 'string') log.dose = v.dose;
          out.logs[k] = log;
        }
      }
    }

    const s = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
    out.settings = { ...DEFAULT_SETTINGS, ...s, updatedAt: s.updatedAt || EPOCH };
    return out;
  }

  // ---------- merge ----------
  // True if `a` has every field `b` has, with the same value. Looks inside nested objects
  // (a version's `doses`), where a null or missing field in `b` counts as "b doesn't have
  // it", so a copy written by an older device that dropped a slot never beats the full one.
  function covers(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return stableStringify(a) === stableStringify(b);
    return Object.keys(b).every((k) => b[k] == null || covers(a[k], b[k]));
  }

  // Pick the newer of two versions of the same record.
  function newer(a, b) {
    if (!a) return b;
    if (!b) return a;
    const ta = time(a.updatedAt), tb = time(b.updatedAt);
    if (ta !== tb) return ta > tb ? a : b;
    if (Boolean(a.derived) !== Boolean(b.derived)) return a.derived ? b : a; // stored beats worked-out
    const ab = covers(a, b), ba = covers(b, a);
    if (ab !== ba) return ab ? a : b; // same time, one just has more detail: keep the detail
    return stableStringify(a) >= stableStringify(b) ? a : b;
  }

  function mergeMed(a, b) {
    const win = newer(a, b);
    if (!a || !b || win.deleted) return win;
    // Both sides are live, or the newer side is live: merge schedule versions one by one.
    let schedule = [];
    for (const v of [...(a.schedule || []), ...(b.schedule || [])]) schedule = upsertVersion(schedule, v);
    return { ...win, schedule };
  }

  // Merge two states. Symmetric: merge(a, b) and merge(b, a) give the same result.
  function merge(a, b) {
    a = migrate(a); b = migrate(b);

    const meds = new Map();
    for (const m of [...a.meds, ...b.meds]) meds.set(m.id, mergeMed(meds.get(m.id), m));

    const logs = {};
    for (const k of new Set([...Object.keys(a.logs), ...Object.keys(b.logs)])) logs[k] = newer(a.logs[k], b.logs[k]);

    return clone({
      meds: [...meds.values()].sort(byId),
      logs,
      settings: newer(a.settings, b.settings),
    });
  }

  // Drop tombstones (deleted meds, un-taken doses) older than 90 days so the data doesn't grow
  // forever. Known limit: a device that stays offline longer than that could bring an old
  // deleted med or an old un-taken dose back when it finally syncs.
  function purge(state, now = new Date()) {
    const cutoff = now.getTime() - TOMBSTONE_DAYS * 86400000;
    const logs = {};
    for (const [k, v] of Object.entries(state.logs)) if (v.takenAt || time(v.updatedAt) >= cutoff) logs[k] = v;
    return { ...state, meds: state.meds.filter((m) => !m.deleted || time(m.updatedAt) >= cutoff), logs };
  }

  // One text form per state, for "did anything change?" checks.
  function canonical(state) {
    const s = migrate(state);
    return stableStringify({ ...s, meds: [...s.meds].sort(byId) });
  }

  // One sync step: merge what's on the gist (null if there is no gist yet) into this device's
  // data. Returns the merged state and whether this device and the gist each need updating.
  function reconcile(local, remote, now = new Date()) {
    const merged = purge(merge(remote || emptyState(), local), now);
    const text = canonical(merged);
    return {
      merged,
      localChanged: text !== canonical(local),
      remoteNeedsWrite: !remote || text !== canonical(purge(migrate(remote), now)),
    };
  }

  // ---------- what's due on a day ----------
  const parseKey = (k) => { const [day, slot, medId] = k.split('|'); return { day, slot, medId }; };
  const liveMeds = (state) => state.meds.filter((m) => !m.deleted).sort((a, b) => (a.order - b.order) || (a.id < b.id ? -1 : 1));
  const logKey = (dayKey, slotId, medId) => `${dayKey}|${slotId}|${medId}`;
  const prnKey = (dayKey, medId, uniqueId) => `${dayKey}|prn:${uniqueId}|${medId}`;

  // Scheduled meds for a slot on a day, with the dose for that slot on that day.
  // As-needed meds never appear.
  function slotMeds(state, slotId, dayKey) {
    const out = [];
    for (const med of liveMeds(state)) {
      if (!med.active) continue;
      const version = scheduleOn(med, dayKey);
      if (!version || version.prn || version.doses[slotId] == null) continue;
      out.push({ med, version, dose: doseOn(version, dayKey, slotId) });
    }
    return out;
  }

  // As-needed meds available on a day.
  function prnMeds(state, dayKey) {
    return liveMeds(state).filter((m) => m.active && (scheduleOn(m, dayKey) || {}).prn);
  }

  // As-needed doses logged on a day (or on every day if dayKey is omitted), newest first.
  function prnLogs(state, dayKey) {
    const out = [];
    for (const [key, log] of Object.entries(state.logs)) {
      const p = parseKey(key);
      if (!p.slot || !p.slot.startsWith('prn:') || !log.takenAt) continue;
      if (dayKey && p.day !== dayKey) continue;
      out.push({ key, day: p.day, medId: p.medId, takenAt: log.takenAt, dose: log.dose || '' });
    }
    return out.sort((a, b) => (a.takenAt < b.takenAt ? 1 : -1));
  }

  // What a scheduled log says was taken: the dose saved with it, or (for logs from v1.x,
  // which didn't save one) what the schedule said for that day.
  function loggedDose(state, dayKey, slotId, med) {
    const log = state.logs[logKey(dayKey, slotId, med.id)];
    if (log && log.takenAt && typeof log.dose === 'string') return log.dose;
    return doseOn(scheduleOn(med, dayKey), dayKey, slotId);
  }

  // As-needed doses of one med logged on a day, and whether its daily limit is reached.
  function prnStatus(state, med, dayKey) {
    const count = prnLogs(state, dayKey).filter((l) => l.medId === med.id).length;
    const version = scheduleOn(med, dayKey);
    const max = version && version.prn ? version.maxPerDay || null : null;
    return { count, max, atMax: Boolean(max) && count >= max };
  }

  // Push notification body, built on the device from its own data when the reminder arrives.
  function reminderBody(state, slotId, dayKey) {
    const due = slotMeds(state, slotId, dayKey);
    if (due.length === 0) return `No ${slotId} meds scheduled today.`;
    const left = due.filter((x) => !(state.logs[logKey(dayKey, slotId, x.med.id)] || {}).takenAt);
    if (left.length === 0) return `All ${slotId} meds already logged.`;
    return `${SLOT_PHRASES[slotId] || 'Now'}: ` + left.map((x) => x.med.name + (x.dose ? ` ${x.dose}` : '')).join(', ') + '. Tap to log.';
  }

  // ---------- encryption ----------
  // PBKDF2 (SHA-256, 200k rounds, random salt) turns the passphrase into an AES-GCM key.
  // Every write gets a new random salt and IV. The gist only ever holds { v, salt, iv, ciphertext }.
  const subtle = () => globalThis.crypto.subtle;
  const keyCache = new Map(); // "salt|passphrase" -> CryptoKey, so repeat syncs skip the slow derivation

  function toB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  async function deriveKey(passphrase, salt) {
    const id = toB64(salt) + '|' + passphrase;
    if (keyCache.has(id)) return keyCache.get(id);
    const base = await subtle().importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    const key = await subtle().deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    if (keyCache.size > 8) keyCache.clear();
    keyCache.set(id, key);
    return key;
  }

  async function encrypt(data, passphrase) {
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(passphrase, salt);
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(data)));
    return { v: 1, salt: toB64(salt), iv: toB64(iv), ciphertext: toB64(new Uint8Array(ct)) };
  }

  class DecryptError extends Error {}

  // Throws DecryptError for a wrong passphrase or a damaged file. The caller must not
  // overwrite the remote copy when that happens.
  async function decrypt(blob, passphrase) {
    if (!blob || blob.v !== 1 || !blob.salt || !blob.iv || !blob.ciphertext) throw new DecryptError('Sync file is not in a format this version understands.');
    try {
      const key = await deriveKey(passphrase, fromB64(blob.salt));
      const pt = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv) }, key, fromB64(blob.ciphertext));
      return JSON.parse(new TextDecoder().decode(pt));
    } catch (e) {
      throw new DecryptError("Couldn't decrypt. Check the passphrase.");
    }
  }

  return {
    VERSION, EPOCH, TOMBSTONE_DAYS, SLOT_IDS, LEGACY_SLOT_IDS, SLOT_PHRASES, WEEKDAYS, WEEKDAY_NAMES,
    emptyState, nextStamp, stableStringify, dayKeyOf, weekdayOf,
    SLOT_NAMES, scheduleOn, doseOn, doseSummary, dosesText, slotDoseText, variesByDay, variesBySlot,
    scheduleSummary, scheduleText, editSchedule, newMed, withLegacyFields,
    migrate, merge, purge, canonical, reconcile,
    logKey, prnKey, parseKey, slotMeds, prnMeds, prnLogs, prnStatus, loggedDose, reminderBody,
    encrypt, decrypt, DecryptError,
  };
});
