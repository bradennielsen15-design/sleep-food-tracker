# Sleep & Food Tracker

A standalone, offline-first PWA for tracking sleep, food, training, and recovery.
No build step, no dependencies — pure HTML, CSS, and JavaScript, so GitHub Pages
serves it as-is from the repo root.

## What it is

- **Two tabs only:** SLEEP ("Dream Lab", cyan/teal) and FOOD ("Fuel Station", orange/lime).
- **Race HQ banner** above the tabs: Indianapolis Monumental Marathon, Sat Nov 7, 2026,
  8:00 AM, goal sub-3:20 (~7:38/mi), Wave B (3:11–3:39:59), expo Thu Nov 5, 4–7 PM and
  Fri Nov 6, 11 AM–8 PM, plus course notes, taper checklist, carb-load general info,
  and a race-morning checklist. After Nov 7, 2026 it flips to IRONMAN 70.3 Muncie, Jul 10, 2027.
- **Sleep:** score ring, night-splits bar (deep/light/REM/awake), 7-night course chart,
  PRs strip, Tonight's Sleep Plan (need in minutes + 90+ checklist + wind-down nudge),
  training + recovery lists. No fixed bedtime is prescribed anywhere.
- **Food:** calories vs adaptive targets, eaten-food list, "What should I eat next"
  gap suggestions, one-tap favorites, photo-log explainer, Fuel vs Burn, grocery list,
  weight trend, camera meal capture, and an AI meal-agent chat.
- **Adaptive targets:** protein 160g, fat 90g, calories = that day's burn when known
  else 3200, carbs = (calories − protein×4 − fat×9) ÷ 4. A zero-calorie day shows
  dashes, never NaN.

## Empty state, honestly

The app ships with **no personal health data and no logged entries**. Every list is
empty until you add something. The only seeded items are five generic favorite
food definitions (overnight oats bowl, Pro33 shake, ONE bar, banana, chipotle
chicken rice bowl) — defaults a first-time user can tap, not a logged history.

## AI meal agent

The FOOD tab chat sends text ("2 eggs and toast") or a meal photo to the Supabase
edge function `meal-estimate` (see `config.js`). Estimates are shown with their
uncertainty plainly, and are **never** presented as verified nutrition panels
unless the function returns `known_panel: true`. Confirm saves the entry;
Edit lets you change the numbers first. If the function is not deployed or not
reachable, the chat says so honestly ("AI not connected yet — enter macros
manually") and the manual form works on its own.

## Sync

Data lives in `localStorage` first. When Supabase is configured in `config.js`,
the app signs in anonymously and syncs to tables prefixed `sft_` (food entries,
sleep nights, favorites, daily burn, weight entries, grocery items, settings,
activities, wellness, race-morning items). The backend migration and row-level
security for those tables are owned separately. When Supabase is unreachable or
unconfigured, everything still works locally and the header badge says
"saved on this device — not synced".

The publishable key in `config.js` is public by design (same pattern as Saddle).
No private credential of any kind belongs in this repo. The AI provider key, if
any, lives only in Supabase edge-function settings, never here.

## Publish (GitHub Pages)

1. Put these files at the root of a new public repo (keep the `icons/` folder).
2. In the repo: Settings → Pages → Deploy from a branch → main branch, root folder.
3. Wait for the Pages URL, then open it on your phone.

No build, no install, no deploy command — Pages serves the static files directly.

## iOS: Add to Home Screen

1. Open the Pages URL in Safari (not an in-app browser).
2. Tap Share → **Add to Home Screen**.
3. Tap Add. The app opens standalone with its own icon, and works offline
   after the first load thanks to the service worker (`sw.js`).

On Android, Chrome offers "Install app" from the same Pages URL.

## Files

- `index.html` — the single-page app
- `styles.css` — dark futuristic theme, mobile-first
- `app.js` — all tab, tracker, camera, chat, and sync logic
- `config.js` — public Supabase project wiring
- `manifest.webmanifest` — installable PWA manifest
- `sw.js` — offline app-shell cache
- `icons/` — SVG + PNG icons (180px, 192px, 512px)
