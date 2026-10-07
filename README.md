# Meds

A small, installable web app for one job: knowing what to take and when, and whether you already did.

- **Today**: Morning, Afternoon and Evening cards. Tap a med to mark it taken (it stamps the time). Tap again to undo. "Take all" logs the whole slot. Use ‹ to fix a day you forgot to log.
- **Meds**: add, edit, reorder, pause, delete. Scheduled at any mix of morning, afternoon and evening. Most meds have one dose; a med can instead have a different dose at each time of day, a different dose each weekday, or both. Or as needed (PRN), with an optional daily limit ("up to 2 a day") that Today enforces.
- **Doses by meal, day and over time**: a med can be 200 mg at breakfast and 600 mg at dinner, or 8 mg on Thursday and Sunday and 6 mg the rest of the week, as one entry. Changing a dose starts on a day you pick; earlier days keep what applied then, and every logged dose keeps the dose it was logged at.
- **As needed**: log a PRN med whenever you take it, as often as needed, at the time you took it. It's never "due" and never counts as missed.
- **History**: last 30 days, adherence percent, day streak. Tap a day to open it.
- **Settings**: reminder times for each slot, sync between iPhone and Mac, push reminders, calendar reminders, JSON backup and restore.

No accounts to create, no server to run, no build step. Plain HTML, CSS and JavaScript, so it's readable end to end.

## Files

| File | What it does |
| --- | --- |
| `index.html` | The page shell: header, tab bar, the add/edit dialog. |
| `app.js` | Everything you see and tap, plus the sync and push-subscribe code. |
| `sync-core.js` | The data format, which dose applies on which day, the merge rule, and encryption. No page code, so Node can test it. |
| `config.js` | The public push key. Shared by the app and the reminder sender. |
| `sw.js` | Service worker: offline cache, and shows push notifications with today's doses. |
| `version.json` | The current release number. The app checks it on every open to catch updates. |
| `scripts/send-push.mjs` | Sends the reminders. Run by GitHub Actions, not by you. |
| `tests/` | Node tests for doses by meal and day, schedule history, PRN, the merge, encryption, and reminder timing. `tests/fixtures/` holds the v1.1 and v2.0 sync code (to test old and new devices together) and the real medication list as dose patterns. Names are neutral because this repo is public; real names can go in `tests/private/names.json`, which git ignores. |

## Where it runs

Deploys to GitHub Pages via `.github/workflows/pages.yml` on every push to this branch (the repo's default) or `main`:

```
https://srichards391.github.io/medication-tracker/
```

If the first deploy fails with a Pages permissions error, turn on Pages once: repo **Settings → Pages → Source: GitHub Actions**, then re-run the workflow from the **Actions** tab.

## Install it

**iPhone (Safari):** open the URL, Share → **Add to Home Screen**. It opens full screen like a native app and works offline. Push reminders only work when Meds is opened from this Home Screen icon.

**Mac (Safari):** open the URL, File → **Add to Dock**. Chrome also works: the install icon in the address bar.

## Sync between iPhone and Mac

Each device keeps a full copy. Sync keeps them the same through a private GitHub Gist.

- Your data is **encrypted on the device** with your passphrase (AES-GCM, key from PBKDF2 with 200,000 rounds) before it's uploaded. The gist only holds scrambled text. A secret gist is unlisted, not truly private, which is why the encryption matters.
- The **token and passphrase stay on each device**, in the browser's storage. They are never put in the gist, this repo, or a link.
- It syncs when the app opens, when you come back to it, every 2 minutes while it's on screen, and 2 seconds after any change. Logging a dose saves on the device first, instantly, whether or not there's a connection.
- **Today** shows "Synced 8:14 AM" under the date. If the last sync failed or is more than 10 minutes old, that line turns orange and says a dose logged on your other device may not show yet. When you see orange, check the other device before taking anything twice.

**Set up** (once): make a classic GitHub token with only the `gist` scope, then in Meds → Settings → Sync paste the token and a passphrase on each device. The first device creates the gist; the second finds it.

**How conflicts are settled.** Every med, every dose, and the settings carry a "last changed" time. When the two copies differ, the newer change wins, record by record. Nothing only one side has is ever dropped. Un-taking a dose is saved as "not taken at 8:05", not deleted, so the undo reaches the other device. A dose is stored once per day, slot, and med, so tapping it on both devices still counts as one dose.

Dose and schedule changes merge one version at a time: change warfarin's dose on the Mac and its notes on the phone, and both survive.

**Limits worth knowing:**
- If you change the *same* schedule start day on both devices before either syncs, the later one wins. Name, notes, and paused/active also go to the later edit as a group. Re-check a med after editing it on two devices.
- "Newer" uses each device's clock. iPhones and Macs set their clocks automatically, so this is fine unless one clock is set by hand.
- Deleted meds and un-taken doses are forgotten after 90 days. A device that has been offline longer than that could bring an old one back when it reconnects.

**Forgot the passphrase?** Your data is still on each device. On gist.github.com, delete the gist named `meds-sync`, then Connect again on each device with a new passphrase. The first one to connect uploads its copy, and the second merges into it.

## Reminders

### Push notifications (v1.1)

GitHub Actions sends a push notification at each reminder time (morning, afternoon, evening). Tapping it opens Today.

- Times live in `.github/workflows/push-reminders.yml` (`MORNING_TIME`, `AFTERNOON_TIME`, `EVENING_TIME`, New York time), **not** in the app. The app's Settings times are for "due" status and the calendar file. Keep them matching. The workflow file explains how to change the cron lines.
- The app never sends anything itself. It subscribes, and you paste the subscription into the repo secret `PUSH_SUBSCRIPTION` (one object, or a JSON list `[ ... , ... ]` for iPhone and Mac). The private key is the repo secret `VAPID_PRIVATE_KEY`.
- GitHub can't see your meds, so it sends a plain "Morning meds" signal. When it arrives, your device fills in the meds and doses still to take for that slot today (e.g. "With dinner: Warfarin 8 mg. Tap to log."), from its own copy of your data. As-needed meds are never included. If it can't read that copy it falls back to "With breakfast. Tap to log." Note this puts med names on the lock screen; to hide them, iPhone Settings → Notifications → Meds → Show Previews → When Unlocked.
- If a device's subscription expires, the workflow run fails with "Subscription expired…" and GitHub emails you. Re-enable push in Settings and update the secret.
- **GitHub pauses scheduled workflows after 60 days with no commits to the repo.** If reminders stop, open the Actions tab, pick "Push reminders", and click "Enable workflow".
- GitHub sometimes runs scheduled jobs late (the script still sends up to 45 minutes after the target) and, rarely, skips one. **Keep the calendar reminders below as a backup.** Don't make push your only reminder.
- To test: Actions → Push reminders → Run workflow → pick `morning` → Run.

### Calendar reminders (fallback, still works)

1. Settings → Reminders → **Get file** (do this in Safari, not the home-screen app).
2. Open the downloaded `meds-reminders.ics` and tap **Add All**.

You get one daily event per time of day you use, with alerts at the times in Settings. Each one links back to the app. If you change the times later, delete the old events and get a fresh file.

## Updating an installed copy

Installed copies update themselves: on every open, Meds asks the server which version is current. If there's a newer one it shows an orange **Update now** banner at the top. Tap it. You can also check any time in Settings → App → **Check for updates**. The version you're running is shown there and at the bottom of Settings.

If Meds ever says "Meds didn't finish updating", close it completely and open it again. It shows no doses in that state on purpose, so a mix of old and new code can never show a wrong one.

**Releasing a new version** (for whoever changes the code): bump `APP_VERSION` in `app.js`, `VERSION` in `sync-core.js`, `CACHE_VERSION` and every `?v=` in `sw.js`, every `?v=` in `index.html`, and `version.json`. `node --test` fails if any of them disagree.

## If the app's address changes (a repo rename)

GitHub Pages serves the app at the repo's name, so renaming the repo moves the app. Before you delete an old Home Screen icon: open it, Settings → Backup → Export, and keep the file. On iPhone each Home Screen icon has its own storage; deleting the icon deletes its data. If it's already gone, Settings → Sync → Older copies on the new install lists every revision GitHub kept of the sync gist and can restore one.

## Backup

Settings → Backup → **Export** downloads everything as JSON. **Import** accepts files from any version. With sync on, Import merges the file in (newer wins, nothing deleted) instead of replacing.

## Local development

Any static server works:

```
python3 -m http.server 8080
```

then open `http://localhost:8080/`. When you change files, do the version bump described under "Releasing a new version" so installed copies refresh.

Run the tests (Node 22 or later, nothing to install):

```
node --test
```

## Versioning

See `CHANGELOG.md`. Point releases add, whole numbers change something an old edition would notice.
