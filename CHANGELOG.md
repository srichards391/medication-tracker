# Meds changelog

Point releases add. Whole numbers change something an old edition would notice.

## v3.1 (10/07/2026)
- **Older copies.** Settings → Sync → Older copies lists every revision of the sync gist (GitHub keeps one per sync), decrypted on the device, with the med names and dose counts in each. Restore merges a chosen copy back in; nothing is deleted. For when a device connected while empty and its copy won, or an installed app was deleted before its data was synced.
- README: moving the app to a new address (a repo rename) and what to do before deleting an old Home Screen icon.

## v3.0 (09/29/2026)
A whole-number release: a v2.1 device syncing with a v3.0 one never sees an afternoon dose as due. Update both devices.
- **Afternoon slot.** Today now has Morning, Afternoon and Evening cards. A med can be scheduled in any mix of the three, with its own dose per slot as before. Default afternoon reminder time 2:00 PM (Settings), with its own calendar alert and push reminder (two new cron lines in `push-reminders.yml`, `AFTERNOON_TIME`).
- **Daily limit for as-needed meds.** "Most doses in a day" on an as-needed med (e.g. up to 2). Today shows "1 of 2 today" on its + button and stops at the limit; removing a dose frees it again. The limit is part of the schedule history, so changing it starts on a chosen day.
- Reminder text: "This afternoon: Lithium 300 mg. Tap to log."
- Sync: a copy written by a v2.1 device lacks the afternoon dose and the daily limit. The full copy always wins that tie (the merge now looks inside a version's doses), and a v2.1 device leaves the full copy on the gist. Tested against the real v2.1 core (tests/fixtures/sync-core-v2.1.js).
- Removed docs/HANDOFF_v1.1.md: that work shipped in v1.1 and v2.0.
- Tests: 89.

## v2.1 (09/26/2026)
- **Different doses at breakfast and dinner.** A dose now depends on the meal as well as the weekday, in one model: each meal has its own dose, and any meal's dose can vary by weekday. So 200 mg at breakfast and 600 mg at dinner is one med, not two entries, and "all taken" counts it once per meal.
- The form stays one dose box for most meds. Two options split it: "Different dose at breakfast and dinner" (a column per meal) and "Different dose on different days of the week" (a row per day). Split doses are read back for confirmation before saving.
- Today tags doses that differ ("Breakfast dose", "Thursday dose", "Thursday dinner dose"). Logs, history, the push reminder and the calendar file all use the dose for that meal on that day.
- Syncs with devices still on v2.0 or v1.1: they see a split dose written out in words ("200 mg breakfast · 600 mg dinner"), never one wrong number, and their older copy can't overwrite the split dose.
- Tests: 75, including the full real medication list (dose patterns; names are neutral in the public repo, see tests/fixtures/med-list.js).

## v2.0 (09/26/2026)
A whole-number release: the data format changed in ways a v1.1 device would notice. Update both devices.
- **Day-of-week doses.** A med can have a different dose each weekday (e.g. warfarin 8 mg Thu and Sun, 6 mg other days). Today shows the dose for the date you're looking at, tagged with the weekday.
- **Schedule history.** Changing a dose or schedule starts on a chosen day (default today). Earlier days keep the dose that applied then. The edit form lists the history.
- **Doses are recorded when logged.** Each log saves the dose it was taken at, so a later schedule edit never changes what the record says. If the schedule for a logged day has since changed, Today says so.
- **As-needed (PRN) meds.** Log them any time, several times a day, at a chosen time and dose. Never due, never missed, never in a reminder. Shown on Today and in History.
- **Push reminders name the meds and doses** still to take for that slot today, built on the device from its own data when the reminder arrives.
- **Updates can't leave you on old code.** The app checks for a new version on every open and shows an "Update now" banner; files load with version-stamped addresses; the service worker always checks with the server; a half-updated app refuses to show doses. Settings → App → Check for updates.
- Sync merges schedule changes one version at a time, so a dose change on one device and a note edit on the other both survive. A v1.1 device syncing in the meantime can't erase recorded doses or schedules.
- Tests: 59 (`node --test`), including a real v1.1 device (tests/fixtures) syncing with v2.0.

## v1.1 (09/26/2026)
- Sync between iPhone and Mac through a private GitHub Gist, encrypted on the device (PBKDF2 + AES-GCM). Settings → Sync: token, passphrase, Connect, status, Disconnect.
- Newest-change-wins merge per med, per dose, and for settings. Deletes and un-takes are kept as markers so they reach the other device. Tested in Node (`node --test`).
- Today shows when it last synced, and turns orange if this device might be missing doses from the other one.
- Push reminders at breakfast and dinner, sent by GitHub Actions (`push-reminders.yml`) with Web Push. Settings → Reminders → Enable. Tapping the notification opens Today.
- Data format bumped to `meds.v2`. v1.0 data and backups migrate automatically; the old copy is left in place.
- Import merges instead of replacing when sync is on.
- Service worker no longer caches requests to other sites (sync must always be live).
- Pages deploys from this branch as well as `main`.

## v1.0 (09/26/2026)
- First edition. Today screen with breakfast and dinner slots, one-tap "taken" logging, "take all" per slot.
- Medication list with add, edit, reorder, deactivate, delete.
- 30-day history with per-slot dots and a daily score.
- Settings: breakfast and dinner reminder times, calendar reminder export (.ics), JSON backup and restore.
- Installable web app (iPhone home screen, Mac dock) with offline support via service worker.
- Deploys to GitHub Pages from `main` via GitHub Actions.
