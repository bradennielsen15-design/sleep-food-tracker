/* Sleep & Food Tracker — public app configuration.
   The publishable key below is public by design (same pattern as Saddle):
   it is safe to ship in a client app, and row-level security on the
   database is what protects each person's data. No private credential
   of any kind belongs in this repo. If this file ever gains anything
   other than the two public values below, remove it. */
window.SFT_CONFIG = {
  url: 'https://wuixzqcrlbrazocqaxcw.supabase.co',
  key: 'sb_publishable_IzyYVhwZqm8AaDFg0eaB9Q_tmknJZgz',
  edgeFunction: 'meal-estimate'
};
window.SFT_CONFIG.configured = function () {
  return /^https:\/\/.+\.supabase\.co/.test(window.SFT_CONFIG.url) &&
    window.SFT_CONFIG.key.indexOf('sb_publishable_') === 0;
};
