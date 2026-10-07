/* Meds v3.2
 * A single-file, no-build web app. Data lives in localStorage on this device and, if sync is
 * turned on, in an encrypted private GitHub Gist shared by your devices.
 * Sections: storage, date helpers, rendering per tab, medication form, as-needed log,
 * sync, push, updates, calendar export, backup.
 * The data format, dose schedules and merge rule are documented at the top of sync-core.js,
 * which also holds the "which dose applies on which day" logic so it can be tested in Node.
 */
(() => {
  'use strict';

  // When releasing: bump this, VERSION in sync-core.js, CACHE_VERSION in sw.js, version.json,
  // and every ?v= in index.html and sw.js. tests/dosing.test.js fails if any disagree.
  const APP_VERSION = '3.2';
  const STORE_KEY = 'meds.v2';
  const OLD_STORE_KEY = 'meds.v1'; // left in place after migrating, as a just-in-case copy
  const SYNC_KEY = 'meds.sync';    // token, passphrase, gist id. This device only: never synced or exported.
  const Core = window.MedsSyncCore;
  const SLOTS = [
    { id: 'morning', title: 'Morning', meal: 'with breakfast', icon: '☀️', settingKey: 'breakfast', defaultTime: '08:00' },
    { id: 'afternoon', title: 'Afternoon', meal: 'midday', icon: '🌤️', settingKey: 'afternoon', defaultTime: '14:00' },
    { id: 'evening', title: 'Evening', meal: 'with dinner', icon: '🌙', settingKey: 'dinner', defaultTime: '18:00' },
  ];
  const SLOT_LABEL = { morning: 'Breakfast', afternoon: 'Afternoon', evening: 'Dinner' };

  // Half-updated install (new page, old script, or the reverse): show nothing about doses.
  // Mixed versions could compute a dose with the wrong rules.
  if (!Core || Core.VERSION !== APP_VERSION) {
    document.querySelector('#screen').innerHTML = `<div class="card update-card"><div class="empty"><strong>Meds didn't finish updating</strong>
      Close Meds completely and open it again. On iPhone: swipe up from the bottom and hold, then swipe Meds away.
      On Mac: press ⌘Q. If you still see this after reopening twice, wait 10 minutes and try again.</div></div>`;
    throw new Error(`Version mismatch: app ${APP_VERSION}, core ${Core && Core.VERSION}`);
  }

  // ---------- storage ----------
  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return Core.purge(Core.migrate(JSON.parse(raw)));
      const old = localStorage.getItem(OLD_STORE_KEY);
      if (old) {
        const migrated = Core.migrate(JSON.parse(old));
        localStorage.setItem(STORE_KEY, JSON.stringify(migrated));
        return migrated;
      }
    } catch (e) {
      console.warn('Could not read saved data, starting fresh', e);
    }
    return Core.emptyState();
  }

  // Save on this device only. Used by sync itself.
  function saveLocal() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      toast('Could not save. Storage may be full or blocked.');
    }
    mirrorForServiceWorker();
  }

  // The service worker can't read localStorage, but it builds the push reminder text
  // ("Warfarin 8 mg") from this device's meds when a reminder arrives. So keep a copy of the
  // meds and the last two days of logs where it can read it.
  const DATA_CACHE = 'meds-data';
  let mirrorTimer;
  function mirrorForServiceWorker() {
    if (!('caches' in window)) return;
    clearTimeout(mirrorTimer);
    mirrorTimer = setTimeout(async () => {
      try {
        const keep = new Set([todayKey(), dayKey(addDays(new Date(), -1))]);
        const logs = Object.fromEntries(Object.entries(state.logs).filter(([k]) => keep.has(k.split('|')[0])));
        const cache = await caches.open(DATA_CACHE);
        await cache.put('./meds-data.json', new Response(JSON.stringify({ meds: state.meds, logs, settings: state.settings }), { headers: { 'Content-Type': 'application/json' } }));
      } catch (e) { /* reminder falls back to the generic text */ }
    }, 300);
  }

  // Save after a change you made, then sync it a couple of seconds later.
  function save() {
    saveLocal();
    scheduleSync();
  }

  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const stamp = (prev) => Core.nextStamp(prev);

  // ---------- date helpers ----------
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromDayKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const sameDay = (a, b) => dayKey(a) === dayKey(b);
  const todayKey = () => dayKey(new Date());

  function friendlyDay(d) {
    const now = new Date();
    if (sameDay(d, now)) return 'Today';
    if (sameDay(d, addDays(now, -1))) return 'Yesterday';
    if (sameDay(d, addDays(now, 1))) return 'Tomorrow';
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  const longDate = (d) => d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const shortTime = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  function slotTime(slot, day) {
    const [h, m] = (state.settings[slot.settingKey] || slot.defaultTime).split(':').map(Number);
    const d = new Date(day); d.setHours(h, m, 0, 0); return d;
  }

  // ---------- derived data ----------
  // Which meds are due, and at what dose, depends on the day: see slotMeds in sync-core.js.
  const byOrder = (a, b) => (a.order - b.order) || (a.id < b.id ? -1 : 1);
  const liveMeds = () => state.meds.filter((m) => !m.deleted).sort(byOrder); // everything except deleted
  const activeMeds = () => liveMeds().filter((m) => m.active);
  const medsFor = (slot, key) => Core.slotMeds(state, slot.id, key); // [{ med, version, dose }] for that day
  const logKey = Core.logKey;
  const takenAt = (key, slotId, medId) => (state.logs[logKey(key, slotId, medId)] || {}).takenAt || null;
  const isTaken = (key, slotId, medId) => Boolean(takenAt(key, slotId, medId));

  function slotStatus(key, slot) {
    const due = medsFor(slot, key);
    const taken = due.filter((x) => isTaken(key, slot.id, x.med.id)).length;
    return { total: due.length, taken };
  }

  // Taking saves the dose that applies that day with the log, so a later schedule edit can't
  // change what the record says you took. Un-taking writes { takenAt: null } rather than
  // deleting, so the undo reaches your other device.
  function setTaken(key, slotId, medId, taken, when, dose) {
    const k = logKey(key, slotId, medId);
    const prev = state.logs[k];
    if (!taken && !(prev && prev.takenAt)) return;
    state.logs[k] = taken
      ? { takenAt: (when || new Date()).toISOString(), updatedAt: stamp(prev && prev.updatedAt), dose: dose || '' }
      : { takenAt: null, updatedAt: stamp(prev && prev.updatedAt) };
    save();
  }

  // When logging for a past day, stamp it at that day's slot time rather than "now".
  function stampFor(key, slot) {
    if (key === todayKey()) return new Date();
    return slotTime(slot, fromDayKey(key));
  }

  // ---------- routing ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const screen = $('#screen');
  const titleEl = $('#screen-title');
  const actionsEl = $('#topbar-actions');

  let viewDay = new Date();
  let pinnedToToday = true; // true while the user is looking at "today"; lets the view roll over at midnight

  function currentTab() {
    const h = (location.hash || '#today').replace('#', '');
    return ['today', 'meds', 'history', 'settings'].includes(h) ? h : 'today';
  }

  // keepScroll: for background refreshes (sync, the minute timer) so the page doesn't jump.
  function render(opts) {
    const keepScroll = opts && opts.keepScroll;
    const y = window.scrollY;
    const tab = currentTab();
    document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
    actionsEl.innerHTML = '';
    ({ today: renderToday, meds: renderMeds, history: renderHistory, settings: renderSettings })[tab]();
    window.scrollTo(0, keepScroll ? y : 0);
  }

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- Today ----------
  function renderToday() {
    titleEl.textContent = 'Today';
    const key = dayKey(viewDay);
    const isToday = key === todayKey();
    pinnedToToday = isToday;
    screen.innerHTML = '';

    const nav = el(`
      <div class="day-nav">
        <button class="btn icon" id="day-prev" aria-label="Previous day">‹</button>
        <div class="label" style="text-align:center">${esc(friendlyDay(viewDay))}<small>${esc(longDate(viewDay))}</small></div>
        <button class="btn icon" id="day-next" aria-label="Next day" ${isToday ? 'disabled' : ''}>›</button>
      </div>`);
    screen.appendChild(nav);
    $('#day-prev', nav).onclick = () => { viewDay = addDays(viewDay, -1); render(); };
    $('#day-next', nav).onclick = () => { if (!isToday) { viewDay = addDays(viewDay, 1); render(); } };
    if (syncCfg) screen.appendChild(el(`<div class="sync-line" id="today-sync"></div>`));
    if (!isToday) {
      const back = el(`<button class="btn subtle block" style="margin:-6px 0 12px">Jump to today</button>`);
      back.onclick = () => { viewDay = new Date(); render(); };
      screen.appendChild(back);
    }
    updateSyncUI();

    if (activeMeds().length === 0) {
      screen.appendChild(el(`
        <div class="card"><div class="empty">
          <strong>No medications yet</strong>
          Add your meds under the Meds tab and they will show up here, sorted by time of day.
        </div></div>`));
      const go = el(`<button class="btn primary block">Add a medication</button>`);
      go.onclick = () => { location.hash = '#meds'; setTimeout(openMedForm, 50); };
      screen.appendChild(go);
      return;
    }

    const weekday = Core.WEEKDAY_NAMES[Core.weekdayOf(key)];
    for (const slot of SLOTS) {
      const due = medsFor(slot, key);
      if (due.length === 0) continue;
      const { total, taken } = slotStatus(key, slot);
      const now = new Date();
      const overdue = isToday && taken < total && now > slotTime(slot, now);
      const countClass = taken === total ? 'done' : (overdue ? 'overdue' : '');
      const countText = taken === total ? 'All taken ✓' : (overdue ? `${taken} of ${total} · due` : `${taken} of ${total}`);

      const card = el(`
        <section class="card">
          <div class="card-head">
            <h2>${slot.icon} ${slot.title} <span class="sub">${slot.meal}</span></h2>
            <span class="count ${countClass}">${countText}</span>
          </div>
        </section>`);

      for (const { med: m, version, dose } of due) {
        const shownTakenAt = takenAt(key, slot.id, m.id);
        // Taken: show the dose saved with the log. Not taken: the dose scheduled for this date.
        const shownDose = shownTakenAt ? Core.loggedDose(state, key, slot.id, m) : dose;
        // Say which way this dose is special, so a different number than yesterday or than the
        // other time of day reads as intended: "Thursday dose", "Breakfast dose", "Thursday dinner dose".
        const byDay = Core.variesByDay(version, slot.id);
        const bySlot = Core.variesBySlot(version);
        const tag = [byDay ? weekday : '', bySlot ? (byDay ? Core.SLOT_NAMES[slot.id] : SLOT_LABEL[slot.id]) : ''].filter(Boolean).join(' ');
        const changed = shownTakenAt && shownDose !== dose;
        const meta = [
          shownDose ? `<span class="dose">${esc(shownDose)}</span>` : '',
          tag ? `<span class="pill">${esc(tag)} dose</span>` : '',
          changed ? `<span class="dose-note">schedule for this day now says ${esc(dose || 'no dose')}</span>` : '',
        ].filter(Boolean).join(' ');
        const row = el(`
          <button class="dose-row ${shownTakenAt ? 'taken' : ''}" aria-pressed="${shownTakenAt ? 'true' : 'false'}">
            <span class="box">✓</span>
            <span class="body">
              <div class="name">${esc(m.name)}</div>
              <div class="meta">${meta}</div>
            </span>
            ${shownTakenAt ? `<span class="when">${esc(shortTime(shownTakenAt))}</span>` : ''}
          </button>`);
        row.onclick = () => {
          // Act on what the screen showed, not on data a background sync may have changed since.
          // That way a tap always does what you meant: mark taken if it looked untaken, and the reverse.
          // The dose saved is the one that was on screen.
          const nowTaken = !shownTakenAt;
          setTaken(key, slot.id, m.id, nowTaken, stampFor(key, slot), dose);
          if (nowTaken && navigator.vibrate) navigator.vibrate(10);
          render({ keepScroll: true });
        };
        card.appendChild(row);
      }

      if (taken < total) {
        const foot = el(`<div class="card-foot"><button class="btn primary">Take all ${slot.title.toLowerCase()} meds</button></div>`);
        foot.firstElementChild.onclick = () => {
          const when = stampFor(key, slot);
          due.forEach(({ med: m, dose }) => { if (!isTaken(key, slot.id, m.id)) setTaken(key, slot.id, m.id, true, when, dose); });
          toast(`${slot.title} meds logged`);
          render({ keepScroll: true });
        };
        card.appendChild(foot);
      }
      screen.appendChild(card);
    }

    renderPrnCard(key, isToday);

    screen.appendChild(el(`<div class="note">Tap a med to mark it taken. Tap again to undo. Use ‹ to log a day you forgot to record. Doses shown are the ones scheduled for this date.</div>`));
  }

  // As-needed meds: not due, never missed. Log each dose when you take it. A med with a daily
  // limit ("up to 2 a day") shows how many are logged and stops at the limit.
  function renderPrnCard(key, isToday) {
    const meds = Core.prnMeds(state, key);
    const logs = Core.prnLogs(state, key);
    if (meds.length === 0 && logs.length === 0) return;
    const card = el(`
      <section class="card">
        <div class="card-head"><h2>💊 As needed <span class="sub">${isToday ? 'log when you take one' : 'logged this day'}</span></h2></div>
      </section>`);
    const name = (id) => (state.meds.find((m) => m.id === id) || {}).name || 'Deleted med';
    for (const l of logs.slice().reverse()) {
      const row = el(`
        <div class="list-row prn-log">
          <div class="body"><div class="name">${esc(name(l.medId))}</div><div class="meta">${esc(l.dose || '')}</div></div>
          <span class="when">${esc(shortTime(l.takenAt))}</span>
          <button class="btn icon" title="Remove this dose" aria-label="Remove this dose">✕</button>
        </div>`);
      row.querySelector('button').onclick = () => {
        if (!confirm(`Remove ${name(l.medId)} at ${shortTime(l.takenAt)}?`)) return;
        state.logs[l.key] = { takenAt: null, updatedAt: stamp(state.logs[l.key].updatedAt) };
        save(); render({ keepScroll: true });
      };
      card.appendChild(row);
    }
    if (meds.length) {
      const foot = el(`<div class="card-foot prn-buttons"></div>`);
      for (const m of meds) {
        const { count, max, atMax } = Core.prnStatus(state, m, key);
        const label = max ? `+ ${esc(m.name)} <span class="prn-count">${count} of ${max} today</span>` : `+ ${esc(m.name)}`;
        const b = el(`<button class="btn" ${atMax ? 'disabled title="Daily limit reached"' : ''}>${label}</button>`);
        b.onclick = () => openPrnForm(m, key);
        foot.appendChild(b);
      }
      card.appendChild(foot);
    }
    screen.appendChild(card);
  }

  // ---------- Meds ----------
  // Grouped the way Today is: Morning, Afternoon, Evening, then As needed, then Paused.
  // A med taken at two times of day appears under each, with that time's dose.
  function renderMeds() {
    titleEl.textContent = 'Meds';
    const add = el(`<button class="btn primary">+ Add</button>`);
    add.onclick = () => openMedForm();
    actionsEl.appendChild(add);
    screen.innerHTML = '';

    const meds = liveMeds();
    if (meds.length === 0) {
      screen.appendChild(el(`<div class="card"><div class="empty"><strong>Nothing here yet</strong>Tap + Add to enter your first medication.</div></div>`));
      return;
    }

    const today = todayKey();
    const groups = [];
    for (const slot of SLOTS) {
      const list = medsFor(slot, today).map(({ med, version }) => ({ med, meta: slotLine(med, version, slot, today) }));
      groups.push({ title: `${slot.icon} ${slot.title}`, sub: slot.meal, list });
    }
    groups.push({ title: '💊 As needed', sub: 'log when you take one', list: Core.prnMeds(state, today).map((med) => ({ med, meta: Core.scheduleSummary(Core.scheduleOn(med, today)) })) });
    const placed = new Set(groups.flatMap((g) => g.list.map((x) => x.med.id)));
    const rest = meds.filter((m) => !placed.has(m.id));
    const paused = rest.filter((m) => !m.active), unscheduled = rest.filter((m) => m.active);
    if (unscheduled.length) groups.push({ title: 'No schedule today', sub: 'a schedule that starts later, or none', list: unscheduled.map((med) => ({ med, meta: Core.scheduleSummary(Core.scheduleOn(med, today) || (med.schedule || [])[0]) })) });
    if (paused.length) groups.push({ title: 'Paused', sub: 'kept, but not on Today', list: paused.map((med) => ({ med, meta: Core.scheduleSummary(Core.scheduleOn(med, today) || (med.schedule || [])[0]) })) });

    for (const g of groups) {
      if (!g.list.length) continue;
      const card = el(`
        <section class="card">
          <div class="card-head"><h2>${g.title} <span class="sub">${esc(g.sub)}</span></h2><span class="count">${g.list.length}</span></div>
        </section>`);
      g.list.forEach(({ med: m, meta }, i) => {
        const upcoming = (m.schedule || []).find((v) => v.from > today);
        const row = el(`
          <div class="list-row ${m.active ? '' : 'inactive'}">
            <div class="body">
              <div class="name">${esc(m.name)}</div>
              <div class="meta">${esc(meta)}</div>
              ${upcoming ? `<div class="meta">From ${esc(friendlyDay(fromDayKey(upcoming.from)))}: ${esc(Core.scheduleSummary(upcoming))}</div>` : ''}
            </div>
            <div class="actions">
              <button class="btn icon" title="Move up" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button class="btn icon" title="Move down" aria-label="Move down" ${i === g.list.length - 1 ? 'disabled' : ''}>↓</button>
              <button class="btn icon" title="Edit" aria-label="Edit">✎</button>
            </div>
          </div>`);
        const [up, down, edit] = row.querySelectorAll('button');
        up.onclick = () => swapOrder(m.id, g.list[i - 1].med.id);
        down.onclick = () => swapOrder(m.id, g.list[i + 1].med.id);
        edit.onclick = () => openMedForm(m);
        card.appendChild(row);
      });
      screen.appendChild(card);
    }
    screen.appendChild(el(`<div class="note">A med taken at two times of day is listed under each. Arrows change the order within a time of day, and Today follows it. Pausing a med keeps its history but hides it from Today.</div>`));
  }

  // One line for a med under a time-of-day heading: that time's dose, plus where else it's taken.
  function slotLine(med, version, slot, today) {
    const dose = Core.variesByDay(version, slot.id) ? Core.slotDoseText(version, slot.id) : Core.doseOn(version, today, slot.id);
    const others = SLOTS.filter((s) => s.id !== slot.id && version.doses[s.id] != null).map((s) => s.title.toLowerCase());
    return [dose, others.length ? `also ${others.join(' and ')}` : ''].filter(Boolean).join(' · ');
  }

  // Swap two meds' places in the overall order (the order Today uses too).
  function swapOrder(idA, idB) {
    const a = state.meds.find((m) => m.id === idA), b = state.meds.find((m) => m.id === idB);
    if (!a || !b) return;
    // Orders can collide after a merge from two devices; renumber first so a swap is a real swap.
    liveMeds().forEach((m, idx) => { if (m.order !== idx) { m.order = idx; m.updatedAt = stamp(m.updatedAt); } });
    [a.order, b.order] = [b.order, a.order];
    a.updatedAt = stamp(a.updatedAt); b.updatedAt = stamp(b.updatedAt);
    save(); render({ keepScroll: true });
  }

  // ---------- medication form ----------
  const dialog = $('#med-dialog');
  const form = $('#med-form');
  const delBtn = $('#med-delete');

  // The dose boxes. Usually one box. "Different dose at different times of day" splits it into a
  // column per slot; "Different dose on different days" into a row per weekday; both gives a
  // 7 x 2 grid. What you typed is kept when you switch, and fills the new boxes.
  let cells = {}; // "col|row" -> text. col: 'all' or a slot id. row: 'any' or 0..6.
  const cellKey = (col, row) => `${col}|${row}`;

  function doseShape() {
    const f = form.elements;
    const prn = f.kind.value === 'prn';
    const slots = prn ? [] : SLOTS.filter((s) => f[s.id].checked).map((s) => s.id);
    const bySlot = slots.length >= 2 && f.bySlot.checked;
    const byDay = slots.length > 0 && f.byDay.checked;
    return { prn, slots, bySlot, byDay, cols: bySlot ? slots : ['all'], rows: byDay ? [0, 1, 2, 3, 4, 5, 6] : ['any'] };
  }

  // A box's value, or the closest thing already typed (the same meal's single dose, then the
  // same day's shared dose, then the one shared dose).
  function cellValue(col, row) {
    for (const k of [cellKey(col, row), cellKey(col, 'any'), cellKey('all', row), cellKey('all', 'any')]) {
      if (cells[k] != null && cells[k] !== '') return cells[k];
    }
    return '';
  }

  function renderDoseGrid() {
    const shape = doseShape();
    const grid = $('#dose-grid');
    grid.innerHTML = '';
    for (const col of shape.cols) for (const row of shape.rows) cells[cellKey(col, row)] = cellValue(col, row);
    if (shape.cols.length === 1 && shape.rows.length === 1) {
      grid.appendChild(el(`<label>${shape.prn ? 'Usual dose' : 'Dose'}
        <input type="text" autocomplete="off" placeholder="e.g. 10 mg, 1 tablet" data-col="${shape.cols[0]}" data-row="any" value="${esc(cells[cellKey(shape.cols[0], 'any')])}"></label>`));
    } else {
      const head = shape.cols.map((c) => `<div class="dg-h">${c === 'all' ? 'Dose' : SLOT_LABEL[c]}</div>`).join('');
      const table = el(`<div class="dg" style="grid-template-columns: auto repeat(${shape.cols.length}, 1fr)"><div></div>${head}</div>`);
      for (const row of shape.rows) {
        table.appendChild(el(`<div class="dg-r">${row === 'any' ? 'Every day' : Core.WEEKDAY_NAMES[row]}</div>`));
        for (const col of shape.cols) {
          const label = `${row === 'any' ? '' : Core.WEEKDAY_NAMES[row] + ' '}${col === 'all' ? 'dose' : SLOT_LABEL[col].toLowerCase() + ' dose'}`;
          table.appendChild(el(`<input type="text" autocomplete="off" aria-label="${esc(label)}" data-col="${col}" data-row="${row}" value="${esc(cells[cellKey(col, row)])}">`));
        }
      }
      grid.appendChild(table);
    }
    updateDoseSummary();
  }

  // What the boxes add up to, in the saved shape. `missing` lists empty boxes when the dose is split.
  function readDoses() {
    const shape = doseShape();
    const missing = [];
    const val = (col, row) => {
      const v = (cells[cellKey(col, row)] || '').trim();
      if (!v && (shape.bySlot || shape.byDay)) {
        missing.push(`${row === 'any' ? '' : Core.WEEKDAY_NAMES[row] + ' '}${col === 'all' ? '' : SLOT_LABEL[col].toLowerCase()}`.trim() || 'dose');
      }
      return v;
    };
    if (shape.prn) return { shape, missing, fields: { prn: true, dose: val('all', 'any'), maxPerDay: form.elements.maxPerDay.value } };
    const doses = Object.fromEntries(Core.SLOT_IDS.map((s) => [s, null]));
    for (const slot of shape.slots) {
      const col = shape.bySlot ? slot : 'all';
      doses[slot] = shape.byDay ? shape.rows.map((r) => val(col, r)) : val(col, 'any');
    }
    return { shape, missing: [...new Set(missing)], fields: { prn: false, doses } };
  }

  function updateDoseSummary() {
    const { shape, fields } = readDoses();
    const text = shape.prn || !(shape.bySlot || shape.byDay) ? '' : Core.dosesText({ prn: false, doses: fields.doses });
    $('#dose-summary').textContent = text;
  }

  // Show the fields that fit: as-needed meds have no meals or split doses.
  function syncFormVisibility() {
    const shape = doseShape();
    $('#sched-block').hidden = shape.prn;
    $('#dose-options').hidden = shape.prn;
    $('#prn-block').hidden = !shape.prn;
    $('#opt-slot').hidden = shape.slots.length < 2;
    renderDoseGrid();
  }
  // Only the fields that change the form's shape redraw the dose boxes. (Redrawing on every
  // change, e.g. the name field's, replaced the dose box just as you tapped into it.)
  const SHAPE_FIELDS = new Set(['kind', 'bySlot', 'byDay', ...SLOTS.map((s) => s.id)]);
  form.addEventListener('change', (e) => { if (SHAPE_FIELDS.has(e.target.name)) syncFormVisibility(); });
  form.addEventListener('input', (e) => {
    if (!e.target.dataset.col) return;
    cells[cellKey(e.target.dataset.col, e.target.dataset.row)] = e.target.value;
    updateDoseSummary();
  });

  function openMedForm(med) {
    form.reset();
    const f = form.elements;
    const today = todayKey();
    const v = med ? (Core.scheduleOn(med, today) || med.schedule[0]) : null;
    $('#med-dialog-title').textContent = med ? 'Edit medication' : 'Add medication';
    f.id.value = med ? med.id : '';
    f.name.value = med ? med.name : '';
    f.kind.value = v && v.prn ? 'prn' : 'scheduled';
    for (const s of SLOTS) f[s.id].checked = v ? v.doses[s.id] != null : s.id === 'morning';
    f.maxPerDay.value = v && v.prn && v.maxPerDay ? v.maxPerDay : '';
    f.bySlot.checked = Boolean(v && !v.prn && Core.variesBySlot(v));
    f.byDay.checked = Boolean(v && !v.prn && SLOTS.some((s) => Core.variesByDay(v, s.id)));
    // Load the saved doses into the boxes in the same layout the form will show.
    cells = {};
    if (v && v.prn) cells[cellKey('all', 'any')] = v.dose || '';
    else if (v) {
      for (const s of SLOTS) {
        const spec = v.doses[s.id];
        if (spec == null) continue;
        const col = f.bySlot.checked ? s.id : 'all';
        if (Array.isArray(spec)) spec.forEach((d, i) => { cells[cellKey(col, i)] = d; });
        else if (f.byDay.checked) for (let i = 0; i < 7; i++) cells[cellKey(col, i)] = spec;
        else cells[cellKey(col, 'any')] = spec;
      }
    }
    f.notes.value = med ? med.notes || '' : '';
    f.active.checked = med ? Boolean(med.active) : true;
    f.from.value = today;
    $('#from-block').hidden = !med;
    $('#sched-history').innerHTML = med && med.schedule.length > 1
      ? '<strong>Schedule history</strong>' + med.schedule.map((s) =>
        `<div>${s.from ? 'From ' + esc(fromDayKey(s.from).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })) : 'From the start'}: ${esc(Core.scheduleSummary(s))}</div>`).join('')
      : '';
    delBtn.hidden = !med;
    syncFormVisibility();
    dialog.showModal();
    setTimeout(() => f.name.focus(), 50);
  }

  $('#med-cancel').onclick = () => dialog.close();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = form.elements;
    const name = f.name.value.trim();
    if (!name) return;
    const { shape, missing, fields } = readDoses();
    if (!shape.prn && shape.slots.length === 0) {
      toast('Pick at least one time of day.');
      return;
    }
    if (missing.length) {
      toast(`Fill in every dose box (missing: ${missing.join(', ')}).`);
      return;
    }
    const split = shape.bySlot || shape.byDay;
    const basics = { name, notes: f.notes.value.trim(), active: f.active.checked };
    const today = todayKey();
    const id = f.id.value;
    const i = id ? state.meds.findIndex((x) => x.id === id && !x.deleted) : -1;
    if (id && i < 0) {
      // Deleted on your other device while this form was open.
      dialog.close(); render(); toast('That med was deleted on another device');
      return;
    }

    if (i >= 0) {
      const m = state.meds[i];
      const from = f.from.value;
      if (!from) { toast('Pick the day the change starts.'); return; }
      let next = Core.editSchedule(m, from, fields, today);
      if (next !== m) {
        const when = from === today ? 'starting today' : from < today
          ? `starting ${friendlyDay(fromDayKey(from))}, a past day. Days before today will show this dose if you look back, but doses already logged keep what they recorded`
          : `starting ${friendlyDay(fromDayKey(from))}`;
        if (!confirm(`${name}: ${Core.scheduleSummary(Core.scheduleOn(next, from))}, ${when}.\n\nSave this schedule?`)) return;
      }
      if (basics.name !== m.name || basics.notes !== (m.notes || '') || basics.active !== Boolean(m.active)) {
        next = { ...next, ...basics, updatedAt: stamp(next.updatedAt) };
      }
      if (next === m) { dialog.close(); toast('No changes'); return; }
      state.meds[i] = next;
    } else {
      const order = liveMeds().reduce((max, x) => Math.max(max, x.order + 1), 0);
      const med = Core.newMed(uid(), { ...basics, ...fields }, order, today);
      // A split dose is easy to mistype, so read it back before saving.
      if (split && !confirm(`${name}: ${Core.scheduleSummary(med.schedule[0])}.\n\nSave this schedule?`)) return;
      state.meds.push(med);
    }
    save(); dialog.close(); render();
    toast(id ? 'Saved' : `${name} added`);
  });

  // ---------- as-needed log ----------
  const prnDialog = $('#prn-dialog');
  const prnForm = $('#prn-form');
  let prnTarget = null;

  function openPrnForm(med, key) {
    prnForm.reset();
    prnTarget = { med, key };
    const isToday = key === todayKey();
    const now = new Date();
    $('#prn-title').textContent = `Log ${med.name}`;
    $('#prn-day').textContent = `${friendlyDay(fromDayKey(key))}, ${longDate(fromDayKey(key))}`;
    // Today: default to now. A past day: leave the time blank so it has to be chosen.
    prnForm.elements.time.value = isToday ? `${pad(now.getHours())}:${pad(now.getMinutes())}` : '';
    prnForm.elements.dose.value = Core.doseOn(Core.scheduleOn(med, key), key);
    prnDialog.showModal();
  }
  $('#prn-cancel').onclick = () => prnDialog.close();

  prnForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!prnTarget) return;
    const { med, key } = prnTarget;
    const t = prnForm.elements.time.value;
    if (!t) { toast('Pick the time you took it.'); return; }
    const [h, m] = t.split(':').map(Number);
    const at = fromDayKey(key); at.setHours(h, m, 0, 0);
    if (at.getTime() > Date.now() + 60000 && !confirm(`${shortTime(at.toISOString())} is later than now. Log it anyway?`)) return;
    // A new key per dose, so two in one day (or one per device) never collide.
    state.logs[Core.prnKey(key, med.id, uid())] = { takenAt: at.toISOString(), updatedAt: new Date().toISOString(), dose: prnForm.elements.dose.value.trim() };
    save(); prnDialog.close(); render({ keepScroll: true });
    toast(`${med.name} logged at ${shortTime(at.toISOString())}`);
  });

  // Deleting leaves a tombstone so the delete reaches your other device instead of the med coming back.
  delBtn.onclick = () => {
    const id = form.elements.id.value;
    const i = state.meds.findIndex((x) => x.id === id);
    const m = state.meds[i];
    if (!m) return;
    if (!confirm(`Delete ${m.name} and its history? Pausing it instead keeps the record.`)) return;
    state.meds[i] = { id, deleted: true, order: m.order, updatedAt: stamp(m.updatedAt) };
    for (const [k, v] of Object.entries(state.logs)) {
      if (k.endsWith(`|${id}`) && v.takenAt) state.logs[k] = { takenAt: null, updatedAt: stamp(v.updatedAt) };
    }
    save(); dialog.close(); render();
    toast('Deleted');
  };

  // ---------- History ----------
  function renderHistory() {
    titleEl.textContent = 'History';
    screen.innerHTML = '';
    const days = 30;
    const now = new Date();
    let sumTaken = 0, sumTotal = 0, streak = 0, streakAlive = true;
    const rows = [];

    // Don't count days before the app was in use as misses.
    const firstKeys = [
      ...liveMeds().map((m) => m.createdAt ? dayKey(new Date(m.createdAt)) : todayKey()),
      ...Object.entries(state.logs).filter(([k, v]) => v.takenAt && !Core.parseKey(k).slot.startsWith('prn:')).map(([k]) => k.split('|')[0]),
    ].filter(Boolean).sort();
    const firstKey = firstKeys[0] || todayKey();

    for (let i = 0; i < days; i++) {
      const d = addDays(now, -i);
      const key = dayKey(d);
      if (key < firstKey) break;
      const perSlot = SLOTS.map((s) => ({ slot: s, ...slotStatus(key, s) })).filter((x) => x.total > 0);
      const total = perSlot.reduce((a, x) => a + x.total, 0);
      const taken = perSlot.reduce((a, x) => a + x.taken, 0);
      // Only count slots whose time has passed today, so a morning-only record doesn't look like a miss at noon.
      const due = perSlot.filter((x) => i > 0 || now > slotTime(x.slot, now));
      const dueTotal = due.reduce((a, x) => a + x.total, 0);
      const dueTaken = due.reduce((a, x) => a + x.taken, 0);
      sumTotal += dueTotal; sumTaken += dueTaken;
      if (streakAlive && dueTotal > 0) { if (dueTaken === dueTotal) streak++; else streakAlive = false; }
      rows.push({ d, key, perSlot, total, taken, dueTotal, dueTaken, isToday: i === 0 });
    }

    const pct = sumTotal ? Math.round((sumTaken / sumTotal) * 100) : 0;
    screen.appendChild(el(`
      <div class="summary">
        <div class="stat"><div class="n">${pct}%</div><div class="l">30-day adherence</div></div>
        <div class="stat"><div class="n">${streak}</div><div class="l">Day streak</div></div>
      </div>`));

    if (activeMeds().length === 0) {
      screen.appendChild(el(`<div class="card"><div class="empty"><strong>No history yet</strong>Add meds and start logging on Today.</div></div>`));
      return;
    }

    const card = el(`<div class="card"></div>`);
    for (const r of rows) {
      const cls = r.dueTotal === 0 ? '' : r.dueTaken === r.dueTotal ? 'full' : r.dueTaken === 0 ? 'none' : 'part';
      const dots = r.perSlot.map((x) => {
        const passed = !r.isToday || now > slotTime(x.slot, now);
        const c = x.taken === x.total ? 'on' : (passed ? 'miss' : '');
        return `<span class="dot ${c}" title="${x.slot.title}: ${x.taken}/${x.total}"></span>`;
      }).join('');
      const row = el(`
        <div class="hist-row" role="button" tabindex="0">
          <div class="d">${esc(friendlyDay(r.d))}<small>${esc(r.d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</small></div>
          <div class="dots">${dots}</div>
          <div class="score ${cls}">${r.taken}/${r.total}</div>
        </div>`);
      row.onclick = () => { viewDay = r.d; location.hash = '#today'; };
      card.appendChild(row);
    }
    screen.appendChild(card);
    screen.appendChild(el(`<div class="note">Expected doses follow each med's schedule on that day. Paused meds are left out. As-needed meds never count as missed. Tap a day to view or fix it.</div>`));

    // As-needed doses, newest first, for the same 30 days.
    const since = dayKey(addDays(now, -(days - 1)));
    const prn = Core.prnLogs(state).filter((l) => l.day >= since);
    if (prn.length) {
      const name = (id) => (state.meds.find((m) => m.id === id) || {}).name || 'Deleted med';
      const pc = el(`<div class="card"></div>`);
      const byDay = new Map();
      for (const l of prn) { if (!byDay.has(l.day)) byDay.set(l.day, []); byDay.get(l.day).push(l); }
      for (const [day, list] of byDay) {
        const row = el(`
          <div class="hist-row prn-hist" role="button" tabindex="0">
            <div class="d">${esc(friendlyDay(fromDayKey(day)))}<small>${esc(fromDayKey(day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</small></div>
            <div class="prn-list">${list.slice().reverse().map((l) => `<div>${esc(shortTime(l.takenAt))} · ${esc(name(l.medId))}${l.dose ? ' ' + esc(l.dose) : ''}</div>`).join('')}</div>
            <div class="score">${list.length}</div>
          </div>`);
        row.onclick = () => { viewDay = fromDayKey(day); location.hash = '#today'; };
        pc.appendChild(row);
      }
      screen.appendChild(sectionTitle('As needed, last 30 days'));
      screen.appendChild(pc);
    }
  }

  // ---------- Settings ----------
  const sectionTitle = (text, first) => el(`<h2 style="font-size:15px;color:var(--muted);margin:${first ? 6 : 16}px 0 8px">${text}</h2>`);

  function renderSettings() {
    titleEl.textContent = 'Settings';
    screen.innerHTML = '';

    const times = el(`<div class="card"></div>`);
    for (const slot of SLOTS) {
      const row = el(`
        <div class="settings-row">
          <div class="l">${slot.icon} ${slot.title} <small>${slot.meal}. Used for "due" status and calendar reminders.</small></div>
          <input type="time" value="${esc(state.settings[slot.settingKey] || slot.defaultTime)}">
        </div>`);
      row.querySelector('input').onchange = (e) => {
        if (!e.target.value) return;
        state.settings = { ...state.settings, [slot.settingKey]: e.target.value, updatedAt: stamp(state.settings.updatedAt) };
        save(); toast('Saved');
      };
      times.appendChild(row);
    }
    times.appendChild(el(`<div class="note">Push reminder times are not set here. They live in the repo, in <code>.github/workflows/push-reminders.yml</code>. If you change a time above, change it there too.</div>`));
    screen.appendChild(sectionTitle('Reminder times', true));
    screen.appendChild(times);

    screen.appendChild(sectionTitle('Sync'));
    screen.appendChild(syncCard());
    if (syncCfg) screen.appendChild(revisionsCard());

    // Reminders
    screen.appendChild(sectionTitle('Reminders'));
    screen.appendChild(pushCard());
    const rem = el(`
      <div class="card">
        <div class="settings-row"><div class="l">Calendar reminders <small>A daily alert for each time of day you use, at the times above. Each one opens this app. Works even if push doesn't.</small></div>
          <button class="btn">Get file</button></div>
        <div class="note">
          On iPhone: tap Get file, open it from Files or the download bar, then <strong>Add All</strong>. Do this from Safari rather than the home-screen app.
          On Mac: the file opens straight into Calendar. Change the times above? Delete the old events and get a fresh file.
        </div>
      </div>`);
    rem.querySelector('button').onclick = downloadICS;
    screen.appendChild(rem);

    // Notifications test (a local notification, to check this device allows alerts)
    if ('Notification' in window) {
      const n = el(`
        <div class="card">
          <div class="settings-row"><div class="l">Test notification <small>Confirms this device allows alerts from the app.</small></div>
            <button class="btn">Test</button></div>
        </div>`);
      n.querySelector('button').onclick = async () => {
        try {
          const perm = await Notification.requestPermission();
          if (perm !== 'granted') { toast('Notifications not allowed'); return; }
          const reg = await navigator.serviceWorker?.getRegistration();
          if (reg) reg.showNotification('Meds', { body: 'Notifications work on this device.', icon: './icons/icon-192.png' });
          else new Notification('Meds', { body: 'Notifications work on this device.' });
        } catch (e) { toast('Could not show a notification here'); }
      };
      screen.appendChild(n);
    }

    // Backup
    const bk = el(`
      <div class="card">
        <div class="settings-row"><div class="l">Back up <small>Downloads everything as a JSON file.</small></div><button class="btn">Export</button></div>
        <div class="settings-row"><div class="l">Restore <small>${syncCfg ? 'Merges a backup file into your synced data. Newer changes win; nothing is deleted.' : "Replaces what's on this device with a backup file."}</small></div>
          <label class="btn" style="margin:0">Import<input type="file" accept="application/json,.json" hidden></label></div>
        <div class="note">A manual fallback to sync. Export now and then and keep the file somewhere safe.</div>
      </div>`);
    bk.querySelectorAll('button')[0].onclick = exportJSON;
    bk.querySelector('input[type=file]').onchange = importJSON;
    screen.appendChild(sectionTitle('Backup'));
    screen.appendChild(bk);

    screen.appendChild(sectionTitle('App'));
    screen.appendChild(updatesCard());

    const installed = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    screen.appendChild(el(`
      <div class="note" style="margin-top:8px">
        Meds v${APP_VERSION} · ${installed ? 'Installed as an app' : 'Running in the browser. On iPhone: Share → Add to Home Screen. On Mac Safari: File → Add to Dock.'}
        <br>${esc(medsCountLabel())}
      </div>`));
    updateSyncUI();
  }

  function medsCountLabel() {
    const n = liveMeds().length, l = Object.values(state.logs).filter((v) => v.takenAt).length;
    return `${n} medication${n === 1 ? '' : 's'}, ${l} dose${l === 1 ? '' : 's'} logged.`;
  }

  // ---------- sync ----------
  // Read the gist, merge it with this device (sync-core.js), write the result back if it changed.
  // Runs on open, when the app comes back on screen, every 2 minutes while on screen, and
  // 2 seconds after any change. Never blocks the UI: logging a dose saves locally first.
  const GIST_DESC = 'meds-sync';
  const GIST_FILE = 'meds-sync.json';
  const STALE_MIN = 10;

  let syncCfg = loadSyncCfg();
  const syncStatus = { kind: syncCfg ? 'idle' : 'off', text: '' };
  let syncing = false, syncAgain = false, syncTimer = null, verifyTimer = null, gistChecked = false;

  function loadSyncCfg() {
    try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || null; } catch (e) { return null; }
  }
  function saveSyncCfg() {
    try {
      if (syncCfg) localStorage.setItem(SYNC_KEY, JSON.stringify(syncCfg));
      else localStorage.removeItem(SYNC_KEY);
    } catch (e) { /* storage blocked; sync just won't remember */ }
  }

  class SyncError extends Error {
    constructor(kind, message) { super(message); this.kind = kind; }
  }

  async function gh(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch('https://api.github.com' + path, {
        method, cache: 'no-store',
        headers: {
          Authorization: `Bearer ${syncCfg.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new SyncError('offline', 'Offline, will retry');
    }
    if (res.status === 401) throw new SyncError('auth', 'GitHub rejected the token. Check it, or make a new one with the gist scope.');
    if (res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.get('retry-after')))) {
      throw new SyncError('rate', 'GitHub asked us to slow down. Will retry.');
    }
    if (res.status === 403) throw new SyncError('auth', 'GitHub refused. The token needs the gist scope.');
    if (res.status === 404) throw new SyncError('gone', 'Sync gist not found');
    if (!res.ok) throw new SyncError('other', `GitHub error ${res.status}. Will retry.`);
    return res.json();
  }

  // The oldest gist with our description, so two devices always pick the same one.
  async function findGist() {
    const found = [];
    for (let page = 1; page <= 10; page++) {
      const list = await gh(`/gists?per_page=100&page=${page}`);
      found.push(...list.filter((g) => g.description === GIST_DESC && g.files && g.files[GIST_FILE]));
      if (list.length < 100) break;
    }
    found.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return found.length ? found[0].id : null;
  }

  async function readRemote(gistId, passphrase) {
    const g = await gh(`/gists/${gistId}`);
    const f = g.files && g.files[GIST_FILE];
    if (!f) throw new SyncError('gone', 'Sync file missing from the gist');
    let text = f.content;
    if (f.truncated) {
      try { text = await (await fetch(f.raw_url, { cache: 'no-store' })).text(); }
      catch (e) { throw new SyncError('offline', 'Offline, will retry'); }
    }
    let blob;
    try { blob = JSON.parse(text); } catch (e) { throw new SyncError('passphrase', "The sync file is damaged. Nothing was overwritten."); }
    try {
      return Core.migrate(await Core.decrypt(blob, passphrase));
    } catch (e) {
      throw new SyncError('passphrase', e.message);
    }
  }

  // ---------- older copies ----------
  // Every sync writes a new revision of the gist, and GitHub keeps them all. If a device ever
  // connected while empty and its copy won, or something was deleted by mistake, the full
  // copy is still in the gist's history: list the revisions, decrypt each with this device's
  // passphrase, and merge the one you choose back in. Merging never deletes anything.
  async function listRevisions() {
    const cfg = syncCfg;
    if (!cfg || !cfg.gistId) throw new SyncError('other', 'Connect sync first.');
    const commits = await gh(`/gists/${cfg.gistId}/commits?per_page=100`);
    const out = [];
    for (const c of commits.slice(0, 40)) {
      const row = { version: c.version, at: c.committed_at, meds: 0, doses: 0, names: [], error: null, data: null };
      try {
        const g = await gh(`/gists/${cfg.gistId}/${c.version}`);
        const f = g.files && g.files[GIST_FILE];
        if (!f) throw new Error('No sync file in this revision');
        let text = f.content;
        if (f.truncated) text = await (await fetch(f.raw_url, { cache: 'no-store' })).text();
        const data = Core.migrate(await Core.decrypt(JSON.parse(text), cfg.passphrase));
        const live = data.meds.filter((m) => !m.deleted);
        row.data = data;
        row.meds = live.length;
        row.names = live.map((m) => m.name);
        row.doses = Object.values(data.logs).filter((v) => v.takenAt).length;
      } catch (e) {
        row.error = e instanceof Core.DecryptError ? 'Saved with a different passphrase' : (e.message || 'Could not read');
      }
      out.push(row);
    }
    return out;
  }

  function revisionsCard() {
    const card = el(`
      <div class="card">
        <div class="settings-row"><div class="l">Older copies <small>GitHub keeps every sync. If your meds vanished after a device connected while empty, bring a full copy back from here. Restoring merges; nothing is deleted.</small></div>
          <button class="btn">Look</button></div>
        <div class="rev-list" hidden></div>
      </div>`);
    const btn = card.querySelector('button');
    const list = card.querySelector('.rev-list');
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = 'Looking';
      list.hidden = false; list.innerHTML = '<div class="note">Reading the gist\'s history. This can take a minute.</div>';
      let rows;
      try { rows = await listRevisions(); }
      catch (e) { list.innerHTML = `<div class="note">${esc(e.message || 'Could not read the gist history.')}</div>`; btn.disabled = false; btn.textContent = 'Look'; return; }
      list.innerHTML = '';
      if (!rows.length) list.appendChild(el('<div class="note">No revisions found.</div>'));
      for (const r of rows) {
        const when = new Date(r.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        const what = r.error ? r.error : `${r.meds} med${r.meds === 1 ? '' : 's'}, ${r.doses} dose${r.doses === 1 ? '' : 's'} logged`;
        const row = el(`
          <div class="settings-row rev-row">
            <div class="l">${esc(when)} <small>${esc(what)}${r.names.length ? ' · ' + esc(r.names.join(', ')) : ''}</small></div>
            <button class="btn" ${r.error || (!r.meds && !r.doses) ? 'disabled' : ''}>Restore</button>
          </div>`);
        row.querySelector('button').onclick = () => {
          if (!confirm(`Merge the copy from ${when} (${what}) into this device? Newer changes win and nothing is deleted.`)) return;
          state = Core.merge(state, r.data);
          save(); render(); toast('Restored. Check Today and History.');
        };
        list.appendChild(row);
      }
      btn.disabled = false; btn.textContent = 'Look again';
    };
    return card;
  }

  async function syncNow() {
    if (!syncCfg) return;
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    const cfg = syncCfg; // if you disconnect mid-sync, stop before writing anything
    setSyncStatus('syncing');
    try {
      let gistId = cfg.gistId;
      // Once per app open, make sure we're on the oldest meds-sync gist. If both devices ever
      // created one at the same moment, this moves them onto the same gist instead of each
      // syncing with its own copy forever.
      if (!gistId || !gistChecked) {
        gistId = (await findGist()) || gistId;
        gistChecked = true;
      }
      let remote = null;
      if (gistId) {
        try {
          remote = await readRemote(gistId, cfg.passphrase);
        } catch (e) {
          if (e.kind !== 'gone') throw e;
          // Gist was deleted. Look for another one before making a new one.
          const other = await findGist();
          gistId = other && other !== gistId ? other : null;
          if (gistId) remote = await readRemote(gistId, cfg.passphrase);
        }
      }
      if (syncCfg !== cfg) return;

      // From here to saveLocal is synchronous, so a tap can't slip in between merge and save.
      const r = Core.reconcile(state, remote);
      state = r.merged;
      saveLocal();
      if (r.localChanged) refreshAfterSync();

      if (r.remoteNeedsWrite) {
        const content = JSON.stringify(await Core.encrypt(r.merged, cfg.passphrase));
        if (syncCfg !== cfg) return;
        const files = { [GIST_FILE]: { content } };
        if (gistId) {
          try { await gh(`/gists/${gistId}`, { method: 'PATCH', body: { files } }); }
          catch (e) { if (e.kind === 'gone') gistId = null; else throw e; }
        }
        if (!gistId) gistId = (await gh('/gists', { method: 'POST', body: { description: GIST_DESC, public: false, files } })).id;
        // Your other device may have written at the same moment and replaced this write.
        // Check again shortly; if anything of ours is missing, it gets written back.
        clearTimeout(verifyTimer);
        verifyTimer = setTimeout(syncNow, 10000);
      }

      cfg.gistId = gistId;
      cfg.lastSyncAt = new Date().toISOString();
      saveSyncCfg();
      setSyncStatus('ok');
    } catch (e) {
      console.warn('Sync failed', e);
      if (syncCfg === cfg) setSyncStatus(e.kind || 'other', e instanceof SyncError ? e.message : 'Sync failed. Will retry.');
    } finally {
      syncing = false;
      if (syncAgain) { syncAgain = false; syncNow(); }
    }
  }

  function scheduleSync() {
    if (!syncCfg) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncNow, 2000);
  }

  // After sync brought in changes, redraw, unless you're typing in Settings.
  function refreshAfterSync() {
    if (currentTab() !== 'settings') render({ keepScroll: true });
  }

  function setSyncStatus(kind, text = '') {
    syncStatus.kind = kind;
    syncStatus.text = text;
    updateSyncUI();
  }

  function syncStatusText() {
    const last = syncCfg && syncCfg.lastSyncAt;
    switch (syncStatus.kind) {
      case 'syncing': return 'Syncing';
      case 'ok': return `Synced ${shortTime(last)}`;
      case 'idle': return last ? `Last synced ${shortTime(last)}` : 'Not synced yet';
      default: return syncStatus.text;
    }
  }

  // Today shows a warning when this device may be missing doses logged on the other one.
  function updateSyncUI() {
    const s = $('#sync-status');
    if (s) {
      s.textContent = syncStatusText();
      s.classList.toggle('bad', ['auth', 'passphrase'].includes(syncStatus.kind));
    }
    const t = $('#today-sync');
    if (t && syncCfg) {
      const last = syncCfg.lastSyncAt;
      // "Fresh" = the last attempt worked and was recent. Any failed attempt shows the warning.
      const fresh = last && Date.now() - Date.parse(last) < STALE_MIN * 60000 && ['ok', 'idle', 'syncing'].includes(syncStatus.kind);
      if (syncStatus.kind === 'syncing') t.textContent = 'Syncing';
      else if (fresh) t.textContent = `Synced ${shortTime(last)}`;
      else {
        const why = ['auth', 'passphrase'].includes(syncStatus.kind) ? 'Sync is failing (see Settings). '
          : syncStatus.kind === 'offline' ? 'Offline. ' : syncStatus.kind === 'off' || syncStatus.kind === 'idle' ? '' : 'Sync hit a problem, will retry. ';
        t.textContent = `${why}${last ? `Last synced ${shortTime(last)}${sameDay(new Date(last), new Date()) ? '' : ' ' + friendlyDay(new Date(last)).toLowerCase()}` : 'Not synced yet'}. A dose logged on your other device may not show here yet.`;
      }
      t.classList.toggle('warn', !fresh && syncStatus.kind !== 'syncing');
    }
  }

  function syncCard() {
    if (syncCfg) {
      const card = el(`
        <div class="card">
          <div class="settings-row"><div class="l">Sync is on <small id="sync-status" class="status"></small></div><button class="btn">Sync now</button></div>
          <div class="settings-row"><div class="l">Disconnect <small>Forgets the token and passphrase on this device. Your data stays here.</small></div><button class="btn danger">Disconnect</button></div>
          <div class="note">Your meds and doses are encrypted with your passphrase before they leave this device, then stored in a private GitHub Gist.
            The token and passphrase are saved in this browser's storage on this device only. They are never put in the gist, the repo, or a link.</div>
        </div>`);
      const [now, off] = card.querySelectorAll('button');
      now.onclick = () => syncNow();
      off.onclick = () => {
        if (!confirm('Stop syncing on this device? Your data stays here, and the other device keeps its copy.')) return;
        disconnectSync(); render(); toast('Sync is off on this device');
      };
      return card;
    }

    const card = el(`
      <div class="card">
        <div class="settings-row"><div class="l">Sync iPhone and Mac <small>Keeps the same meds and doses on each device through a private, encrypted GitHub Gist.</small></div></div>
        <form class="form" style="padding:0 14px" autocomplete="off">
          <label>GitHub token (classic, gist scope only)<input type="password" name="token" placeholder="ghp_…" spellcheck="false" autocapitalize="off"></label>
          <label>Passphrase<input type="password" name="pass" autocomplete="new-password"></label>
          <label>Passphrase again<input type="password" name="pass2" autocomplete="new-password"></label>
          <div class="sync-error" role="alert"></div>
          <div class="form-actions" style="margin-bottom:12px"><span class="spacer"></span><button class="btn primary" type="submit">Connect</button></div>
        </form>
        <div class="note">Use the same passphrase on every device. It encrypts your list before it leaves this device, and nobody can recover it for you, so write it down somewhere safe.
          The token and passphrase are saved in this browser's storage on this device only. They are never put in the gist, the repo, or a link.</div>
      </div>`);
    const f = card.querySelector('form');
    const err = card.querySelector('.sync-error');
    f.onsubmit = async (e) => {
      e.preventDefault();
      const token = f.elements.token.value.trim(), pass = f.elements.pass.value;
      err.textContent = '';
      if (!token) { err.textContent = 'Paste your GitHub token.'; return; }
      if (pass.length < 8) { err.textContent = 'Use a passphrase of at least 8 characters.'; return; }
      if (pass !== f.elements.pass2.value) { err.textContent = "The two passphrases don't match."; return; }
      const btn = f.querySelector('button');
      btn.disabled = true; btn.textContent = 'Connecting';
      syncCfg = { token, passphrase: pass, gistId: null, lastSyncAt: null };
      saveSyncCfg();
      await syncNow();
      if (['auth', 'passphrase', 'other'].includes(syncStatus.kind)) {
        // Didn't work: forget the details so a wrong passphrase can't linger, and say why.
        const msg = syncStatus.text;
        disconnectSync();
        err.textContent = msg;
        btn.disabled = false; btn.textContent = 'Connect';
        return;
      }
      render();
      toast(syncStatus.kind === 'ok' ? 'Sync is on' : 'Saved. Will sync when back online.');
    };
    return card;
  }

  function disconnectSync() {
    clearTimeout(syncTimer); clearTimeout(verifyTimer);
    syncCfg = null;
    gistChecked = false;
    saveSyncCfg();
    setSyncStatus('off');
  }

  // ---------- push ----------
  // The app only subscribes. GitHub Actions (scripts/send-push.mjs) sends the reminders,
  // using the subscription you paste into the PUSH_SUBSCRIPTION repo secret.
  function b64urlToBytes(s) {
    const b64 = (s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  }
  function sameBytes(a, b) {
    if (!a || !b) return false;
    const x = new Uint8Array(a), y = new Uint8Array(b);
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }

  function pushCard() {
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    const card = el(`
      <div class="card">
        <div class="settings-row"><div class="l">Push reminders <small>A notification at each reminder time (breakfast, afternoon, dinner), sent by GitHub. Tap it to open Today.</small></div>
          <button class="btn primary" ${supported ? '' : 'disabled'}>Enable</button></div>
        <div class="push-out" hidden>
          <div class="note">Copy this and paste it into the repo secret <code>PUSH_SUBSCRIPTION</code> (GitHub → medication-tracker → Settings → Secrets and variables → Actions).
            Using push on both iPhone and Mac? Put both in the secret as a list: <code>[</code> first <code>,</code> second <code>]</code>.</div>
          <textarea readonly rows="5" class="code-box"></textarea>
          <div class="card-foot"><button class="btn">Copy</button></div>
        </div>
        <div class="note">${supported
          ? 'iPhone needs iOS 16.4 or later, and Meds must be opened from its Home Screen icon. Tap Enable, then Allow.'
          : 'Push isn\'t available here. On iPhone: add Meds to the Home Screen (Share → Add to Home Screen), open it from that icon, and come back here. Needs iOS 16.4 or later.'}
          Push times are set in the repo, not on this screen. The calendar file below is the backup if push ever stops.</div>
      </div>`);
    if (!supported) return card;

    const [enable, copy] = card.querySelectorAll('button');
    const out = card.querySelector('.push-out');
    const box = card.querySelector('textarea');
    const show = (sub) => { box.value = JSON.stringify(sub); out.hidden = false; enable.textContent = 'Show again'; };

    // Already subscribed on this device? Show it without asking again.
    if (Notification.permission === 'granted') {
      navigator.serviceWorker.getRegistration().then((reg) => reg && reg.pushManager.getSubscription()).then((sub) => {
        if (sub) enable.textContent = 'Show subscription';
      }).catch(() => {});
    }

    enable.onclick = async () => {
      try {
        // Must be the first thing in the tap handler, or iOS ignores it.
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') { toast('Notifications are off for Meds. Turn them on in Settings → Notifications → Meds.'); return; }
        const reg = await navigator.serviceWorker.ready;
        const key = b64urlToBytes(MedsConfig.vapidPublicKey);
        let sub = await reg.pushManager.getSubscription();
        if (sub && !sameBytes(sub.options.applicationServerKey, key)) { await sub.unsubscribe(); sub = null; }
        if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        show(sub);
      } catch (e) {
        console.warn('Push subscribe failed', e);
        toast('Could not turn on push here. ' + (e.message || ''));
      }
    };
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(box.value); toast('Copied'); }
      catch (e) { box.select(); toast('Selected. Copy it from the menu.'); }
    };
    return card;
  }

  // ---------- updates ----------
  // An installed copy must never keep running old dosing code after a fix ships. On open and
  // whenever the app comes back on screen, ask the server (bypassing every cache) which
  // version is current. If it's newer than this one, show a banner that updates in one tap.
  let latestVersion = null;

  async function checkForUpdate() {
    try {
      const res = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return null;
      latestVersion = String((await res.json()).version || '');
    } catch (e) { return null; } // offline: keep going with what's installed
    updateBanner();
    return latestVersion;
  }

  function updateBanner() {
    let b = $('#update-banner');
    const stale = latestVersion && latestVersion !== APP_VERSION;
    if (!stale) { if (b) b.remove(); return; }
    if (!b) {
      b = el(`<div id="update-banner" class="update-banner" role="alert">
        <span>A new version of Meds (v<span class="v"></span>) is ready. You're on v${APP_VERSION}.</span>
        <button class="btn primary">Update now</button></div>`);
      b.querySelector('button').onclick = forceUpdate;
      document.body.prepend(b);
    }
    b.querySelector('.v').textContent = latestVersion;
  }

  // Clear the cached app files (never your data) and reload from the network.
  async function forceUpdate() {
    toast('Updating');
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) await reg.update().catch(() => {});
      if ('caches' in window) {
        for (const k of await caches.keys()) if (k !== DATA_CACHE) await caches.delete(k);
      }
    } catch (e) { /* reload anyway */ }
    location.reload();
  }

  function updatesCard() {
    const card = el(`
      <div class="card">
        <div class="settings-row"><div class="l">Meds v${APP_VERSION} <small class="upd-status">Checks for a new version each time you open the app.</small></div>
          <button class="btn">Check for updates</button></div>
      </div>`);
    const status = card.querySelector('.upd-status');
    card.querySelector('button').onclick = async () => {
      status.textContent = 'Checking';
      const v = await checkForUpdate();
      if (v === null) status.textContent = "Couldn't reach the server. Try again when online.";
      else if (v === APP_VERSION) status.textContent = `You're on the latest version.`;
      else { status.textContent = `v${v} is available. Updating`; forceUpdate(); }
    };
    return card;
  }

  // ---------- calendar export ----------
  function downloadICS() {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
    const appUrl = location.origin + location.pathname.replace(/[^/]*$/, '') + '#today';
    const dtstamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const today = new Date();
    const dt = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
    const escText = (s) => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => '\\' + c);

    // A repeating calendar event can't change by weekday, so day-of-week meds list their full pattern.
    const events = SLOTS.filter((s) => medsFor(s, todayKey()).length > 0).map((s) => {
      const list = medsFor(s, todayKey()).map(({ med, version }) => {
        const d = Core.slotDoseText(version, s.id); // this meal's dose only
        return med.name + (d ? ` (${d})` : '');
      }).join(', ');
      return [
        'BEGIN:VEVENT',
        `UID:meds-${s.id}-daily@srichards`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART;TZID=${tz}:${dt(slotTime(s, today))}`,
        'DURATION:PT15M',
        'RRULE:FREQ=DAILY',
        `SUMMARY:${escText(`${s.title} meds ${s.meal}`)}`,
        `DESCRIPTION:${escText(list + '\nLog them: ' + appUrl)}`,
        `URL:${appUrl}`,
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `DESCRIPTION:${escText(`${s.title} meds: ${list}`)}`,
        'TRIGGER:PT0S',
        'END:VALARM',
        'END:VEVENT',
      ].join('\r\n');
    });

    if (events.length === 0) { toast('Add some meds first'); return; }

    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Meds//Daily reminders//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', ...events, 'END:VCALENDAR'].join('\r\n') + '\r\n';
    downloadFile('meds-reminders.ics', ics, 'text/calendar');
  }

  // ---------- backup ----------
  function exportJSON() {
    const payload = { app: 'meds', version: APP_VERSION, exportedAt: new Date().toISOString(), ...state };
    downloadFile(`meds-backup-${todayKey()}.json`, JSON.stringify(payload, null, 2), 'application/json');
  }

  // Accepts v1.0 and v1.1 backups. With sync on, a restore merges (newer wins, nothing deleted)
  // because replacing would just be undone by the next sync anyway.
  function importJSON(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.meds) || typeof data.logs !== 'object') throw new Error('Not a Meds backup');
        const incoming = Core.migrate(data);
        const nMeds = incoming.meds.filter((m) => !m.deleted).length;
        const nDoses = Object.values(incoming.logs).filter((v) => v.takenAt).length;
        if (syncCfg) {
          if (!confirm(`Merge a backup with ${nMeds} medications and ${nDoses} logged doses into your synced data? Newer changes win and nothing is deleted.`)) return;
          state = Core.merge(state, incoming);
        } else {
          if (!confirm(`Replace this device's data with ${nMeds} medications and ${nDoses} logged doses?`)) return;
          state = incoming;
        }
        save(); render(); toast(syncCfg ? 'Merged' : 'Restored');
      } catch (err) {
        toast('That file is not a Meds backup');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function downloadFile(name, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
  }

  // ---------- toast ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  // ---------- boot ----------
  window.addEventListener('hashchange', () => render());
  // Coming back to the app: roll "Today" over at midnight, refresh "due" status, and sync.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (pinnedToToday && !sameDay(viewDay, new Date())) viewDay = new Date();
      render({ keepScroll: true });
      syncNow();
      checkForUpdate();
    }
  });
  window.addEventListener('online', () => syncNow());
  setInterval(() => { if (document.visibilityState === 'visible' && currentTab() === 'today') render({ keepScroll: true }); }, 60 * 1000);
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 2 * 60 * 1000);

  if ('serviceWorker' in navigator) {
    // updateViaCache 'none': the browser always asks the server for sw.js (and what it imports)
    // instead of trusting its HTTP cache, so a new version is noticed on the next open.
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => {}));
    // When a new service worker takes over an open page, reload once so the page runs the
    // new code too. (Not on first install, when there was no worker before.)
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      location.reload();
    });
    // Tapping a push notification while the app is already open: jump to today.
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'open-today') {
        viewDay = new Date();
        if (location.hash !== '#today') location.hash = '#today'; else render();
      }
    });
  }

  render();
  mirrorForServiceWorker();
  syncNow();
  checkForUpdate();
})();
