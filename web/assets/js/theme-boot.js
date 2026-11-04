// 首屏前应用主题，避免闪烁（CSP 允许的同源外部脚本）
(function () {
  try {
    var t = localStorage.getItem('memo-theme');
    if (!t) t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = t;
  } catch (e) { /* ignore */ }
})();
