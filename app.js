/* Sleep & Food Tracker — client-side app, no build step.
   Data: localStorage first. Supabase sync when configured (see config.js).
   Empty state only: no entries exist until the user adds them.
   AI estimates are never presented as verified panels unless the
   edge function returns known_panel === true. */
(function () {
  'use strict';

  /* ---------- Pure logic (also exported for node testing) ---------- */
  function adaptiveTargets(burnKcal) {
    var protein = 160, fat = 90;
    var calories = (burnKcal && burnKcal > 0) ? burnKcal : 3200;
    var carbs = Math.round((calories - protein * 4 - fat * 9) / 4);
    return { calories: calories, protein: protein, fat: fat, carbs: carbs };
  }
  function pctOf(value, target) {
    if (!target || target <= 0) return null;
    return Math.round((value / target) * 100);
  }
  function fmtPct(value, target) {
    var p = pctOf(value, target);
    return p === null ? '—' : p + '%';
  }
  function fmtNum(value) {
    return (value === null || value === undefined || isNaN(value)) ? '—' : String(value);
  }
  function calorieSplit(totals) {
    var p = (totals.protein || 0) * 4, c = (totals.carbs || 0) * 4, f = (totals.fat || 0) * 9;
    var total = p + c + f;
    if (!total || total <= 0) return null;
    // Largest-remainder rounding so the three shares always sum to 100.
    var raw = [p / total * 100, c / total * 100, f / total * 100];
    var base = raw.map(function (v) { return Math.floor(v); });
    var left = 100 - (base[0] + base[1] + base[2]);
    var order = [0, 1, 2].sort(function (a, b) { return (raw[b] - base[b]) - (raw[a] - base[a]); });
    for (var i = 0; i < left; i++) base[order[i]]++;
    return { proteinPct: base[0], carbsPct: base[1], fatPct: base[2], totalKcal: total };
  }
  function eatNextGaps(totals, targets) {
    var remP = Math.max(0, targets.protein - (totals.protein || 0));
    var remC = Math.max(0, targets.carbs - (totals.carbs || 0));
    var remF = Math.max(0, targets.fat - (totals.fat || 0));
    var remCal = Math.max(0, targets.calories - (totals.calories || 0));
    var out = [];
    if (remCal <= 0 && remP <= 0 && remC <= 0 && remF <= 0) {
      out.push({ text: 'Targets met for today — no gap left to close.', tag: 'done' });
      return { remaining: { protein: 0, carbs: 0, fat: 0, calories: 0 }, suggestions: out };
    }
    if (remF >= 20) {
      out.push({ text: 'Fat is the biggest gap (' + remF + 'g left) — a fat-rich option helps most: nuts, olive oil, avocado, cheese, or fatty fish.', tag: 'fat' });
    }
    if (remP >= 30) {
      out.push({ text: 'Protein gap: ' + remP + 'g left — lean protein (chicken, Greek yogurt, eggs, shake) closes it without overshooting carbs.', tag: 'protein' });
    }
    if (remC >= 40) {
      out.push({ text: 'Carbs gap: ' + remC + 'g left — rice, oats, fruit, or bread fit here.', tag: 'carbs' });
    }
    if (!out.length) {
      out.push({ text: 'Close to target — a small balanced snack (' + remCal + ' kcal left) finishes the day.', tag: 'snack' });
    }
    return { remaining: { protein: remP, carbs: remC, fat: remF, calories: remCal }, suggestions: out };
  }
  function sumFood(entries) {
    var t = { calories: 0, protein: 0, carbs: 0, fat: 0 };
    (entries || []).forEach(function (e) {
      t.calories += Number(e.calories) || 0;
      t.protein += Number(e.protein) || 0;
      t.carbs += Number(e.carbs) || 0;
      t.fat += Number(e.fat) || 0;
    });
    t.protein = Math.round(t.protein * 10) / 10;
    t.carbs = Math.round(t.carbs * 10) / 10;
    t.fat = Math.round(t.fat * 10) / 10;
    return t;
  }
  function raceModeFor(now) {
    // After Nov 7, 2026 Race HQ flips to Muncie. Indy day itself stays Indy.
    var cutoff = new Date(2026, 10, 8, 0, 0, 0); // Nov 8 local
    return (now >= cutoff) ? 'muncie' : 'indy';
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { adaptiveTargets: adaptiveTargets, pctOf: pctOf, fmtPct: fmtPct, calorieSplit: calorieSplit, eatNextGaps: eatNextGaps, sumFood: sumFood, raceModeFor: raceModeFor };
  }
  if (typeof document === 'undefined') return;

  /* ---------- Config + sync ---------- */
  var CFG = (typeof window !== 'undefined' && window.SFT_CONFIG) ? window.SFT_CONFIG : { url: '', key: '', edgeFunction: 'meal-estimate' };
  var configured = CFG && typeof CFG.configured === 'function' ? CFG.configured() : false;
  var STORE_KEY = 'sft_store_v1';
  var SESSION_KEY = 'sft_session';
  var session = null;
  try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { session = null; }

  function setBadge(synced) {
    var b = document.getElementById('syncBadge');
    if (!b) return;
    b.textContent = synced ? 'synced' : 'saved on this device — not synced';
    b.className = 'badge' + (synced ? ' synced' : '');
  }
  function supaHeaders(extra) {
    var h = { 'Content-Type': 'application/json', 'apikey': CFG.key };
    if (session && session.access_token) h['Authorization'] = 'Bearer ' + session.access_token;
    Object.keys(extra || {}).forEach(function (k) { h[k] = extra[k]; });
    return h;
  }
  function authCall(path, body) {
    return fetch(CFG.url + '/auth/v1/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': CFG.key },
      body: JSON.stringify(body || {})
    }).then(function (r) { if (!r.ok) throw new Error('sign-in ' + r.status); return r.json(); });
  }
  function ensureSession() {
    if (!configured) return Promise.reject(new Error('not configured'));
    var now = Math.floor(Date.now() / 1000);
    if (session && session.expires_at - 60 > now) return Promise.resolve(session);
    if (session && session.refresh_token) {
      return authCall('token?grant_type=refresh_token', { refresh_token: session.refresh_token })
        .then(function (j) { session = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || (now + (j.expires_in || 3600)), user_id: (j.user && j.user.id) || (session && session.user_id) }; try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) {} return session; })
        .catch(function () { session = null; return ensureSession(); });
    }
    return authCall('signup', { data: {} }).then(function (j) {
      session = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || (now + (j.expires_in || 3600)), user_id: j.user && j.user.id };
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) {}
      return session;
    });
  }
  function supaGet(table, query) {
    return ensureSession().then(function () {
      return fetch(CFG.url + '/rest/v1/' + table + '?' + (query || 'select=*'), { headers: supaHeaders() });
    }).then(function (r) { if (!r.ok) throw new Error(table + ' ' + r.status); return r.json(); });
  }
  function supaInsert(table, row) {
    if (!session || !session.user_id) return Promise.reject(new Error('no user'));
    row.user_id = session.user_id;
    return fetch(CFG.url + '/rest/v1/' + table, {
      method: 'POST', headers: supaHeaders({ 'Prefer': 'return=representation' }), body: JSON.stringify(row)
    }).then(function (r) { if (!r.ok) throw new Error(table + ' insert ' + r.status); return r.json(); });
  }
  function supaDelete(table, id) {
    return ensureSession().then(function () {
      return fetch(CFG.url + '/rest/v1/' + table + '?id=eq.' + encodeURIComponent(id), { method: 'DELETE', headers: supaHeaders() });
    });
  }
  // Best-effort sync: failure always falls back to localStorage, honestly badged.
  function stripLocalId(row) { var clean = {}; Object.keys(row || {}).forEach(function (k) { if (k !== 'id') clean[k] = row[k]; }); return clean; } var UPSERT_CONFLICT = {'sft_sleep_nights':'user_id,date','sft_daily_burn':'user_id,date','sft_settings':'user_id'}; function supaUpsert(table, row, conflict) { if (!session || !session.user_id) return Promise.reject(new Error('no user')); row.user_id = session.user_id; return fetch(CFG.url+'/rest/v1/'+table+'?on_conflict='+conflict, {method:'POST', headers:supaHeaders({'Prefer':'return=representation,resolution=merge-duplicates'}), body:JSON.stringify(row)}).then(function(r){if(!r.ok)throw new Error(table+' upsert '+r.status); return r.json();});} function syncPush(table, row) {
    if (!configured) return Promise.resolve(false);
    return ensureSession().then(function () { var clean = stripLocalId(row); return UPSERT_CONFLICT[table] ? supaUpsert(table, clean, UPSERT_CONFLICT[table]) : supaInsert(table, clean); })
      .then(function () { setBadge(true); return true; })
      .catch(function () { setBadge(false); return false; });
  }

  /* ---------- Local store ---------- */
  var DEFAULT_FAVORITES = [
    { name: 'Overnight oats bowl', meal: 'breakfast', description: 'Oats, whey, PB2, almond milk, berries, honey', calories: 416, protein: 36.5, carbs: 50, fat: 7.5 },
    { name: 'Pro33 shake', meal: 'snack', description: 'Muscle Milk Pro33 Cookies \'N Crème, 11 oz', calories: 190, protein: 33, carbs: 11, fat: 1 },
    { name: 'ONE bar', meal: 'snack', description: 'ONE protein bar', calories: 230, protein: 20, carbs: 23, fat: 8 },
    { name: 'Banana', meal: 'snack', description: 'Medium banana', calories: 105, protein: 1, carbs: 27, fat: 0 },
    { name: 'Chipotle chicken rice bowl', meal: 'lunch', description: 'Rice, mixed veggies, grilled chipotle chicken, hot sauce (no beans)', calories: 527, protein: 46, carbs: 66, fat: 6.5 }
  ];
  var RACE_CHECKLIST = [
    'Taper volume held — no hero workout in race week',
    'Expo / packet pickup done (Thu or Fri)',
    'Race kit, shoes, and throwaway layers laid out',
    'Fuel and hydration plan rehearsed — nothing new on race day',
    'Course notes reviewed: mile 7 trap mile, mile 16 rise = hold effort'
  ];
  var RACE_MORNING_DEFAULTS = [
    { label: 'Bib + safety pins', detail: 'Pinned the night before' },
    { label: 'Shoes + race kit', detail: 'Broken-in pair, nothing new' },
    { label: 'Throwaway layers', detail: 'Donated to charity at the start' },
    { label: 'Fuel + hydration', detail: 'Planned gels / drink, familiar brands only' },
    { label: 'Watch charged', detail: 'Race screen set, goal pace ~7:38/mi in mind' }
  ];
  function defaultStore() {
    return {
      food: [], sleep: [], favorites: DEFAULT_FAVORITES.map(function (f, i) { var c = Object.assign({}, f); c.id = 'seed-' + i; return c; }),
      burn: [], weights: [], grocery: [], settings: { protein_g: 160, fat_g: 90, grocery_target: null, grocery_spent: null, tonight_need_min: 480 },
      activities: [], wellness: [], raceMorning: RACE_MORNING_DEFAULTS.map(function (r, i) { return { id: 'rm-' + i, label: r.label, detail: r.detail, done: false }; })
    };
  }
  function loadStore() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (s && s.favorites) return s;
    } catch (e) {}
    return defaultStore();
  }
  var store = loadStore();
  function saveStore() { try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) {} }
  function uid() { return 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function todayISO(d) {
    var x = d || new Date();
    return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(id) { return document.getElementById(id); }

  /* ---------- Tabs ---------- */
  function showTab(which) {
    var isSleep = which === 'sleep';
    $('panelSleep').hidden = !isSleep; $('panelSleep').classList.toggle('active', isSleep);
    $('panelFood').hidden = isSleep; $('panelFood').classList.toggle('active', !isSleep);
    $('tabSleep').classList.toggle('active', isSleep); $('tabSleep').setAttribute('aria-selected', String(isSleep));
    $('tabFood').classList.toggle('active', !isSleep); $('tabFood').setAttribute('aria-selected', String(!isSleep));
  }
  $('tabSleep').addEventListener('click', function () { showTab('sleep'); });
  $('tabFood').addEventListener('click', function () { showTab('food'); });

  /* ---------- Race HQ ---------- */
  function renderRaceHq() {
    var mode = raceModeFor(new Date());
    $('raceHqIndy').hidden = mode !== 'indy';
    $('raceHqMuncie').hidden = mode !== 'muncie';
    if (mode === 'muncie') {
      $('raceHqTitle').textContent = 'IRONMAN 70.3 Muncie — Jul 10, 2027';
      $('raceHqGoal').textContent = 'Next up after Indianapolis (Nov 7, 2026)';
    } else {
      $('raceHqTitle').textContent = 'Indianapolis Monumental Marathon — Sat Nov 7, 2026, 8:00 AM';
      $('raceHqGoal').textContent = 'Goal: sub-3:20 (~7:38/mi) · Wave B (3:11–3:39:59)';
    }
    $('raceChecklist').innerHTML = RACE_CHECKLIST.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');
    $('raceMorningList').innerHTML = store.raceMorning.map(function (r) {
      return '<li><label><input type="checkbox" data-rm="' + esc(r.id) + '"' + (r.done ? ' checked' : '') + '> ' + esc(r.label) + ' — ' + esc(r.detail) + '</label></li>';
    }).join('');
    $('raceMorningList').querySelectorAll('[data-rm]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var item = store.raceMorning.find(function (x) { return x.id === cb.getAttribute('data-rm'); });
        if (item) { item.done = cb.checked; saveStore(); syncPush('sft_race_morning', { label: item.label, detail: item.detail, done: item.done }); }
      });
    });
  }
  $('raceHqToggle').addEventListener('click', function () {
    var body = $('raceHqBody');
    var open = body.hidden;
    body.hidden = !open;
    $('raceHqToggle').setAttribute('aria-expanded', String(open));
  });

  /* ---------- Dates ---------- */
  $('sleepDate').value = todayISO(); $('foodDate').value = todayISO();
  $('sleepTodayBtn').addEventListener('click', function () { $('sleepDate').value = todayISO(); renderSleep(); });
  $('foodTodayBtn').addEventListener('click', function () { $('foodDate').value = todayISO(); renderFood(); });
  $('sleepDate').addEventListener('change', renderSleep);
  $('foodDate').addEventListener('change', renderFood);

  /* ---------- Sleep rendering ---------- */
  function renderSleep() {
    var date = $('sleepDate').value || todayISO();
    var night = store.sleep.find(function (n) { return n.date === date; });
    var need = (store.settings.tonight_need_min != null) ? store.settings.tonight_need_min : 480;
    $('tonightNeed').textContent = need + ' minutes';
    $('needInput').value = need;
    if (!night) {
      $('sleepEmpty').hidden = false;
      $('scoreBig').textContent = '—'; $('totalSleepBig').textContent = '—'; $('needBig').textContent = need + 'm';
      $('bedWakeLine').textContent = 'Bedtime / wake time: not logged';
      ['segDeep', 'segLight', 'segRem', 'segAwake'].forEach(function (id) { $(id).style.width = '0%'; });
      $('splitLabels').textContent = 'Deep — · Light — · REM — · Awake —';
      $('scoreRingFg').style.strokeDashoffset = 327;
    } else {
      $('sleepEmpty').hidden = true;
      $('scoreBig').textContent = fmtNum(night.score);
      $('totalSleepBig').textContent = (night.total_minutes != null) ? night.total_minutes + 'm' : '—';
      $('needBig').textContent = (night.need_min != null ? night.need_min : need) + 'm';
      $('bedWakeLine').textContent = 'Bedtime / wake time: ' + (night.bedtime || '—') + ' / ' + (night.wake_time || '—');
      var total = (night.deep_min || 0) + (night.light_min || 0) + (night.rem_min || 0) + (night.awake_min || 0) || 1;
      $('segDeep').style.width = ((night.deep_min || 0) / total * 100) + '%';
      $('segLight').style.width = ((night.light_min || 0) / total * 100) + '%';
      $('segRem').style.width = ((night.rem_min || 0) / total * 100) + '%';
      $('segAwake').style.width = ((night.awake_min || 0) / total * 100) + '%';
      $('splitLabels').textContent = 'Deep ' + (night.deep_min || 0) + 'm · Light ' + (night.light_min || 0) + 'm · REM ' + (night.rem_min || 0) + 'm · Awake ' + (night.awake_min || 0) + 'm';
      var sc = Number(night.score) || 0;
      $('scoreRingFg').style.strokeDashoffset = 327 * (1 - Math.min(100, Math.max(0, sc)) / 100);
    }
    var sorted = store.sleep.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    var last7 = sorted.slice(0, 7).reverse();
    $('weekChart').innerHTML = last7.length ? last7.map(function (n) {
      var h = Math.max(6, Number(n.score) || 0);
      return '<div class="week-bar" data-week-date="' + esc(n.date) + '"><i style="height:' + h + 'px"></i>' + esc(n.date.slice(5)) + '<br>' + fmtNum(n.score) + '</div>';
    }).join('') : '<p class="empty">No nights logged yet — the 7-night course appears here.</p>';
    $('weekChart').querySelectorAll('[data-week-date]').forEach(function (el) { el.addEventListener('click', function () { $('sleepDate').value = el.getAttribute('data-week-date'); renderSleep(); }); }); var longest = store.sleep.reduce(function (m, n) { return Math.max(m, Number(n.total_minutes) || 0); }, 0);
    var topScore = store.sleep.reduce(function (m, n) { return Math.max(m, Number(n.score) || 0); }, 0);
    var remBest = store.sleep.reduce(function (m, n) { return Math.max(m, Number(n.rem_min) || 0); }, 0);
    $('prLongest').textContent = longest ? longest + 'm' : '—';
    $('prScore').textContent = topScore ? String(topScore) : '—';
    $('prRem').textContent = remBest ? remBest + 'm' : '—';
    var acts = store.activities.filter(function (a) { return a.date === date; });
    $('activityList').innerHTML = acts.map(function (a) {
      return '<div class="row"><div><strong>' + esc(a.title) + '</strong><small>' + esc(a.type || '') + ' · ' + (a.distance_km != null ? a.distance_km + ' km · ' : '') + (a.duration_min != null ? a.duration_min + ' min' : '') + (a.avg_hr != null ? ' · HR ' + a.avg_hr : '') + '</small></div><button class="btn small ghost" data-del-act="' + esc(a.id) + '">Delete</button></div>';
    }).join('');
    $('activityEmpty').hidden = acts.length > 0;
    $('activityList').querySelectorAll('[data-del-act]').forEach(function (b) {
      b.addEventListener('click', function () { store.activities = store.activities.filter(function (x) { return x.id !== b.getAttribute('data-del-act'); }); saveStore(); renderSleep(); });
    });
    var wells = store.wellness.filter(function (w) { return w.date === date; });
    $('wellnessList').innerHTML = wells.length ? wells.map(function (w) {
      return '<div class="row"><div><strong>' + (w.steps != null ? w.steps + ' steps' : 'Wellness') + '</strong><small>' + esc(w.note || '') + '</small></div><button class="btn small ghost" data-del-well="' + esc(w.id) + '">Delete</button></div>';
    }).join('') : '<p class="empty">No wellness row for this date yet.</p>';
    $('wellnessList').querySelectorAll('[data-del-well]').forEach(function (b) {
      b.addEventListener('click', function () { store.wellness = store.wellness.filter(function (x) { return x.id !== b.getAttribute('data-del-well'); }); saveStore(); renderSleep(); });
    });
  }

  /* ---------- Food rendering ---------- */
  function renderFood() {
    var date = $('foodDate').value || todayISO();
    var entries = store.food.filter(function (e) { return e.date === date; });
    var totals = sumFood(entries);
    var burnRow = store.burn.find(function (b) { return b.date === date; });
    var burn = burnRow ? Number(burnRow.total_kcal) || 0 : 0;
    var targets = adaptiveTargets(burn);
    // Settings overrides for protein/fat if the user changed them (defaults 160/90).
    targets.protein = store.settings.protein_g || 160;
    targets.fat = store.settings.fat_g || 90;
    targets.carbs = Math.round((targets.calories - targets.protein * 4 - targets.fat * 9) / 4);
    if (entries.length === 0) {
      $('calEaten').textContent = '—'; $('calTarget').textContent = targets.calories;
      $('calLeft').textContent = '—';
      $('macroP').textContent = '—'; $('macroC').textContent = '—'; $('macroF').textContent = '—';
      $('pctP').textContent = '—'; $('pctC').textContent = '—'; $('pctF').textContent = '—';
      $('splitPct').textContent = '—';
      $('splitP').style.width = '0%'; $('splitC').style.width = '0%'; $('splitF').style.width = '0%';
    } else {
      $('calEaten').textContent = totals.calories;
      $('calTarget').textContent = targets.calories;
      $('calLeft').textContent = Math.max(0, targets.calories - totals.calories);
      $('macroP').textContent = totals.protein + 'g / ' + targets.protein + 'g';
      $('macroC').textContent = totals.carbs + 'g / ' + targets.carbs + 'g';
      $('macroF').textContent = totals.fat + 'g / ' + targets.fat + 'g';
      $('pctP').textContent = fmtPct(totals.protein, targets.protein);
      $('pctC').textContent = fmtPct(totals.carbs, targets.carbs);
      $('pctF').textContent = fmtPct(totals.fat, targets.fat);
      var split = calorieSplit(totals);
      if (split) {
        $('splitP').style.width = split.proteinPct + '%'; $('splitC').style.width = split.carbsPct + '%'; $('splitF').style.width = split.fatPct + '%';
        $('splitPct').textContent = 'Protein ' + split.proteinPct + '% · Carbs ' + split.carbsPct + '% · Fat ' + split.fatPct + '%';
      } else { $('splitPct').textContent = '—'; }
    }
    $('targetNote').textContent = burn ? ('Target = today\'s burn (' + burn + ' kcal). Protein ' + targets.protein + 'g · Fat ' + targets.fat + 'g · Carbs from remainder.')
      : 'Target = today\'s burn when known, else 3200 kcal. Protein ' + targets.protein + 'g · Fat ' + targets.fat + 'g · Carbs from remainder.';
    $('foodList').innerHTML = entries.map(function (e) {
      return '<div class="row"><div><strong>' + esc(e.description || e.meal || 'Entry') + '</strong><small>' + esc(e.meal || '') + ' · ' + e.calories + ' kcal · ' + e.protein + 'P / ' + e.carbs + 'C / ' + e.fat + 'F' + (e.note ? ' · ' + esc(e.note) : '') + '</small></div><button class="btn small ghost" data-del-food="' + esc(e.id) + '">Delete</button></div>';
    }).join('');
    $('foodEmpty').hidden = entries.length > 0;
    $('foodList').querySelectorAll('[data-del-food]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-del-food');
        store.food = store.food.filter(function (x) { return x.id !== id; }); saveStore(); renderFood();
        if (configured) ensureSession().then(function () { return supaDelete('sft_food_entries', id); }).catch(function () {});
      });
    });
    var gaps = eatNextGaps(totals, targets);
    $('eatNext').innerHTML = gaps.suggestions.map(function (s) { return '<div class="suggestion">' + esc(s.text) + '</div>'; }).join('') +
      '<p class="muted small">Remaining: ' + gaps.remaining.calories + ' kcal · ' + gaps.remaining.protein + 'g protein · ' + gaps.remaining.carbs + 'g carbs · ' + gaps.remaining.fat + 'g fat.</p>';
    $('favList').innerHTML = store.favorites.map(function (f) {
      return '<div class="row"><div><strong>' + esc(f.name) + '</strong><small>' + esc(f.meal || '') + ' · ' + esc(f.description || '') + ' · ' + f.calories + ' kcal · ' + f.protein + 'P / ' + f.carbs + 'C / ' + f.fat + 'F</small></div><button class="btn small" data-add-fav="' + esc(f.id) + '">+ Add</button></div>';
    }).join('');
    $('favList').querySelectorAll('[data-add-fav]').forEach(function (b) {
      b.addEventListener('click', function () {
        var f = store.favorites.find(function (x) { return x.id === b.getAttribute('data-add-fav'); });
        if (f) addFoodEntry({ date: $('foodDate').value || todayISO(), meal: f.meal, description: f.name + (f.description ? ' — ' + f.description : ''), calories: f.calories, protein: f.protein, carbs: f.carbs, fat: f.fat, note: '' });
      });
    });
    // Fuel vs Burn
    $('fuelEaten').textContent = entries.length ? totals.calories + ' kcal' : '—';
    if (burn) {
      $('fuelBurn').textContent = burn + ' kcal';
      $('fuelBalance').textContent = (totals.calories - burn) + ' kcal';
      $('burnNote').textContent = 'Burn synced/entered for this day.';
      $('burnKcal').value = burn;
    } else {
      $('fuelBurn').textContent = 'not synced';
      $('fuelBalance').textContent = '—';
      $('burnNote').textContent = 'Burn not synced for this day — enter it below, or leave it blank and targets fall back to 3200 kcal.';
    }
    // Grocery
    var gt = store.settings.grocery_target, gs = store.settings.grocery_spent;
    $('groceryTarget').textContent = (gt != null) ? '$' + gt : '—';
    $('grocerySpent').textContent = (gs != null) ? '$' + gs : '—';
    $('groceryLeft').textContent = (gt != null && gs != null) ? ('$' + (Math.round((gt - gs) * 100) / 100)) : '—';
    if (gt != null) $('groceryTargetInput').value = gt;
    if (gs != null) $('grocerySpentInput').value = gs;
    $('groceryList').innerHTML = store.grocery.length ? store.grocery.map(function (g) {
      return '<div class="row"><div><label><input type="checkbox" data-groc="' + esc(g.id) + '"' + (g.checked ? ' checked' : '') + '> <strong>' + esc(g.name) + '</strong></label><small>' + esc(g.qty || '') + '</small></div><button class="btn small ghost" data-del-groc="' + esc(g.id) + '">Delete</button></div>';
    }).join('') : '<p class="empty">Grocery list is empty.</p>';
    $('groceryList').querySelectorAll('[data-groc]').forEach(function (cb) {
      cb.addEventListener('change', function () { var g = store.grocery.find(function (x) { return x.id === cb.getAttribute('data-groc'); }); if (g) { g.checked = cb.checked; saveStore(); } });
    });
    $('groceryList').querySelectorAll('[data-del-groc]').forEach(function (b) {
      b.addEventListener('click', function () { store.grocery = store.grocery.filter(function (x) { return x.id !== b.getAttribute('data-del-groc'); }); saveStore(); renderFood(); });
    });
    // Weight
    var ws = store.weights.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    $('weightList').innerHTML = ws.length ? ws.map(function (w) {
      return '<div class="row"><div><strong>' + w.weight_lbs + ' lbs</strong><small>' + esc(w.date) + (w.note ? ' · ' + esc(w.note) : '') + '</small></div><button class="btn small ghost" data-del-w="' + esc(w.id) + '">Delete</button></div>';
    }).join('') : '<p class="empty">No weigh-ins yet.</p>';
    $('weightList').querySelectorAll('[data-del-w]').forEach(function (b) {
      b.addEventListener('click', function () { store.weights = store.weights.filter(function (x) { return x.id !== b.getAttribute('data-del-w'); }); saveStore(); renderFood(); });
    });
  }
  function addFoodEntry(e) {
    e.id = e.id || uid();
    store.food.push(e); saveStore();
    syncPush('sft_food_entries', { date: e.date, meal: e.meal, description: e.description, calories: e.calories, protein: e.protein, carbs: e.carbs, fat: e.fat, note: e.note || '' });
    renderFood();
  }

  /* ---------- Forms: sleep / activity / wellness ---------- */
  $('sleepForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var row = { id: uid(), date: $('sleepDate').value || todayISO(), bedtime: $('sleepBedtime').value, wake_time: $('sleepWake').value, total_minutes: Number($('sleepTotal').value) || null, score: Number($('sleepScore').value) || null, deep_min: Number($('sleepDeep').value) || 0, light_min: Number($('sleepLight').value) || 0, rem_min: Number($('sleepRem').value) || 0, awake_min: Number($('sleepAwake').value) || 0, need_min: store.settings.tonight_need_min || 480, training_note: $('sleepNote').value };
    store.sleep = store.sleep.filter(function (n) { return n.date !== row.date; }); store.sleep.push(row); saveStore();
    syncPush('sft_sleep_nights', row); renderSleep();
  });
  $('saveNeedBtn').addEventListener('click', function () {
    var v = Number($('needInput').value);
    if (v > 0) { store.settings.tonight_need_min = v; saveStore(); syncPush('sft_settings', { protein_g: store.settings.protein_g, fat_g: store.settings.fat_g, grocery_target: store.settings.grocery_target, grocery_spent: store.settings.grocery_spent, tonight_need_min: v }); renderSleep(); }
  });
  $('activityForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var row = { id: uid(), date: $('sleepDate').value || todayISO(), title: $('actTitle').value, type: $('actType').value, distance_km: Number($('actDist').value) || null, duration_min: Number($('actDur').value) || null, avg_hr: Number($('actHr').value) || null, note: $('actNote').value };
    store.activities.push(row); saveStore(); syncPush('sft_activities', row); renderSleep(); ev.target.reset();
  });
  $('wellnessForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var row = { id: uid(), date: $('sleepDate').value || todayISO(), steps: Number($('wellSteps').value) || null, note: $('wellNote').value };
    store.wellness.push(row); saveStore(); syncPush('sft_wellness', row); renderSleep(); ev.target.reset();
  });

  /* ---------- Forms: food / burn / grocery / weight / favorites ---------- */
  $('manualForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    addFoodEntry({ date: $('foodDate').value || todayISO(), meal: $('manMeal').value, description: $('manDesc').value, calories: Number($('manCal').value) || 0, protein: Number($('manP').value) || 0, carbs: Number($('manC').value) || 0, fat: Number($('manF').value) || 0, note: $('manNote').value });
    ev.target.reset();
  });
  $('favForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var f = { id: uid(), name: $('favName').value, meal: $('favMeal').value, description: $('favDesc').value, calories: Number($('favCal').value) || 0, protein: Number($('favP').value) || 0, carbs: Number($('favC').value) || 0, fat: Number($('favF').value) || 0, note: '' };
    store.favorites.push(f); saveStore(); syncPush('sft_favorites', f); renderFood(); ev.target.reset();
  });
  $('burnForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var date = $('foodDate').value || todayISO(), kcal = Number($('burnKcal').value) || 0;
    store.burn = store.burn.filter(function (b) { return b.date !== date; });
    if (kcal > 0) { var row = { id: uid(), date: date, total_kcal: kcal }; store.burn.push(row); syncPush('sft_daily_burn', row); }
    saveStore(); renderFood();
  });
  $('groceryTargetForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    store.settings.grocery_target = $('groceryTargetInput').value !== '' ? Number($('groceryTargetInput').value) : null;
    store.settings.grocery_spent = $('grocerySpentInput').value !== '' ? Number($('grocerySpentInput').value) : null;
    saveStore(); renderFood();
  });
  $('groceryForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var g = { id: uid(), name: $('grocName').value, qty: $('grocQty').value, checked: false };
    store.grocery.push(g); saveStore(); syncPush('sft_grocery_items', g); renderFood(); ev.target.reset();
  });
  $('weightForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var w = { id: uid(), date: $('foodDate').value || todayISO(), weight_lbs: Number($('weightLbs').value) || 0, note: $('weightNote').value };
    store.weights.push(w); saveStore(); syncPush('sft_weight_entries', w); renderFood(); ev.target.reset();
  });

  /* ---------- Camera ---------- */
  var pendingPhoto = null; // { dataUrl, mime }
  $('mealPhoto').addEventListener('change', function () {
    var file = $('mealPhoto').files && $('mealPhoto').files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      pendingPhoto = { dataUrl: reader.result, mime: file.type || 'image/jpeg' };
      $('mealPreview').src = reader.result;
      $('mealPreviewWrap').hidden = false;
    };
    reader.readAsDataURL(file);
  });
  $('clearPhotoBtn').addEventListener('click', function () {
    pendingPhoto = null; $('mealPhoto').value = ''; $('mealPreviewWrap').hidden = true; $('mealPreview').src = '';
  });
  $('sendPhotoToAi').addEventListener('click', function () {
    showTab('food');
    document.querySelector('.ai-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    askAi('', pendingPhoto);
  });

  /* ---------- AI agent chat ---------- */
  var pendingEstimate = null;
  function chatBubble(text, cls) {
    var d = document.createElement('div');
    d.className = 'bubble ' + (cls || '');
    d.textContent = text;
    $('chatLog').appendChild(d);
    $('chatLog').scrollTop = $('chatLog').scrollHeight;
  }
  function showEstimate(est) {
    pendingEstimate = est;
    var box = $('estimateBox');
    var known = est.known_panel === true;
    var unc = (est.uncertainty || est.uncertainty_note) ? ('Uncertainty: ' + esc((est.uncertainty || est.uncertainty_note))) : 'Uncertainty: not stated by the function — treat as a rough estimate.';
    box.innerHTML = '<h3>AI estimate' + (known ? ' — known nutrition panel' : ' — ESTIMATE, not a verified panel') + '</h3>' +
      '<p><strong>' + esc((est.description || est.panel_name) || 'Meal') + '</strong></p>' +
      '<p>' + (est.calories != null ? est.calories : '—') + ' kcal · ' + ((est.protein != null ? est.protein : est.protein_g) != null ? (est.protein != null ? est.protein : est.protein_g) : '—') + 'P / ' + ((est.carbs != null ? est.carbs : est.carbs_g) != null ? (est.carbs != null ? est.carbs : est.carbs_g) : '—') + 'C / ' + ((est.fat != null ? est.fat : est.fat_g) != null ? (est.fat != null ? est.fat : est.fat_g) : '—') + 'F</p>' +
      '<p class="muted small">' + unc + (known ? '' : ' Do not treat this as a verified panel.') + '</p>' +
      '<button class="btn" id="confirmEst">Confirm — save entry</button> ' +
      '<button class="btn ghost" id="editEst">Edit first</button>';
    box.hidden = false;
    $('confirmEst').addEventListener('click', function () {
      addFoodEntry({ date: $('foodDate').value || todayISO(), meal: est.meal || 'snack', description: (est.description || est.panel_name) || 'AI-estimated meal', calories: Number(est.calories) || 0, protein: Number((est.protein != null ? est.protein : est.protein_g)) || 0, carbs: Number((est.carbs != null ? est.carbs : est.carbs_g)) || 0, fat: Number((est.fat != null ? est.fat : est.fat_g)) || 0, note: known ? 'Known panel' : 'AI estimate' });
      chatBubble('Saved: ' + ((est.description || est.panel_name) || 'meal'), 'ai');
      box.hidden = true; pendingEstimate = null;
    });
    $('editEst').addEventListener('click', function () {
      $('manMeal').value = est.meal || 'snack'; $('manDesc').value = (est.description || est.panel_name) || '';
      $('manCal').value = est.calories != null ? est.calories : ''; $('manP').value = (est.protein != null ? est.protein : est.protein_g) != null ? (est.protein != null ? est.protein : est.protein_g) : '';
      $('manC').value = (est.carbs != null ? est.carbs : est.carbs_g) != null ? (est.carbs != null ? est.carbs : est.carbs_g) : ''; $('manF').value = (est.fat != null ? est.fat : est.fat_g) != null ? (est.fat != null ? est.fat : est.fat_g) : '';
      document.querySelector('details.manual').open = true;
      document.querySelector('details.manual').scrollIntoView({ behavior: 'smooth' });
    });
  }
  function aiNotConnected() {
    $('aiStatus').textContent = 'AI not connected yet — enter macros manually';
    chatBubble('AI not connected yet — enter macros manually. The manual form below works without the AI function.', 'ai');
    var d = document.querySelector('details.manual'); if (d) d.open = true;
  }
  function askAi(text, photo) {
    if (text) chatBubble(text, 'me');
    if (photo) chatBubble('📸 Meal photo sent to AI agent.', 'me');
    if (!configured) { aiNotConnected(); return; }
    $('aiStatus').textContent = 'Asking AI…';
    var body = { text: text || '' };
    if (photo) {
      body.imageBase64 = String(photo.dataUrl).split(',')[1] || '';
      body.imageMime = photo.mime;
    }
    ensureSession().then(function () {
      return fetch(CFG.url + '/functions/v1/' + (CFG.edgeFunction || 'meal-estimate'), {
        method: 'POST', headers: supaHeaders(), body: JSON.stringify(body)
      });
    }).then(function (r) {
      if (!r.ok) throw new Error('edge ' + r.status);
      return r.json();
    }).then(function (j) {
      var est = j.estimate || j.data || j;
      if (est == null || (est.calories == null && !(est.description || est.panel_name))) throw new Error('empty estimate');
      $('aiStatus').textContent = (est.known_panel === true) ? 'AI connected — known panel returned' : 'AI connected — estimate returned (not a verified panel)';
      chatBubble('Estimate received — review it below before saving.', 'ai');
      showEstimate(est);
    }).catch(function () { aiNotConnected(); });
  }
  $('chatForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var t = $('chatInput').value.trim();
    if (!t && !pendingPhoto) return;
    askAi(t, pendingPhoto);
    $('chatInput').value = '';
  });

  /* ---------- Init ---------- */
  setBadge(false);
  renderRaceHq();
  renderSleep();
  renderFood();
  if (configured) {
    ensureSession().then(function () { setBadge(true); }).catch(function () { setBadge(false); $('aiStatus').textContent = 'AI not connected yet — enter macros manually'; });
  } else {
    $('aiStatus').textContent = 'AI not connected yet — enter macros manually';
  }
})();
