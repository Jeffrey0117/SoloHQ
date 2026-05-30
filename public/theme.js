/* Shared light/dark theme for all SoloHQ pages.
   Include with <script src="/theme.js"></script>. Default light, persisted,
   one preference shared app-wide (key: solohq-theme). */
(function () {
  var KEY = 'solohq-theme';

  var css = [
    'html[data-theme="light"]{',
    '  --bg:#f6f7f4; --surface:#ffffff; --surface-2:#f0f1ec; --border:#e4e6df; --border-2:#d6d9cf;',
    '  --text:#1b1e23; --text-dim:#6c7480; --text-faint:#9aa1ab;',
    '  --green:#1f9d4d; --green-2:#2bb15a; --green-3:#9ad6ad; --green-4:#dcefe2;',
    '  --yellow:#c8881a; --red:#cc4b4b; --accent:#2563eb;',
    '}',
    'html{color-scheme:light dark}',
    'body{transition:background .25s ease,color .25s ease}',
    '.theme-toggle{background:transparent;border:1px solid var(--border);color:var(--text-dim);',
    '  cursor:pointer;width:32px;height:32px;border-radius:8px;font-size:14px;line-height:1;',
    '  display:inline-grid;place-items:center;margin-left:auto;transition:.15s}',
    '.theme-toggle:hover{color:var(--text);border-color:var(--accent)}',
  ].join('\n');

  var style = document.createElement('style');
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  function apply(t) {
    document.documentElement.setAttribute('data-theme', t);
    var b = document.getElementById('themeToggle');
    if (b) b.textContent = t === 'dark' ? '☀️' : '🌙'; // ☀️ / 🌙
  }
  apply(localStorage.getItem(KEY) || 'light');

  function addBtn() {
    var nav = document.querySelector('.nav');
    if (!nav || document.getElementById('themeToggle')) return;
    var b = document.createElement('button');
    b.id = 'themeToggle';
    b.className = 'theme-toggle';
    b.title = '切換淺色 / 深色'; // 切換淺色 / 深色
    b.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      localStorage.setItem(KEY, next);
      apply(next);
    });
    nav.appendChild(b);
    apply(localStorage.getItem(KEY) || 'light');
  }

  if (document.readyState !== 'loading') addBtn();
  else document.addEventListener('DOMContentLoaded', addBtn);
})();
