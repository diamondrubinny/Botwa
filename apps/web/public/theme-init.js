// Runs before first paint (external file: the CSP forbids inline scripts) so the saved theme never flashes.
(function () {
  var r = document.documentElement;
  try {
    var mode = localStorage.getItem('botwa_theme_mode') || 'system';
    var accent = localStorage.getItem('botwa_theme_accent') || 'indigo';
    var dark = mode === 'dark' || (mode === 'system' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
    r.dataset.theme = dark ? 'dark' : mode === 'light' ? 'light' : 'soft';
    r.dataset.accent = accent;
  } catch (e) {
    r.dataset.theme = 'soft';
    r.dataset.accent = 'indigo';
  }
})();
