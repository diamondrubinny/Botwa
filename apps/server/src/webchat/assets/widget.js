/* Botwa chat widget loader. Add to a page:  <script src="https://YOUR-SERVER/widget.js" data-key="wc_..." async></script>
   It draws only a launcher button; the chat itself runs in an iframe from the chat server, so it cannot read the host page and the page cannot read it. */
(function () {
  'use strict';
  if (window.BotwaChat && window.BotwaChat.__loaded) return;
  var script = document.currentScript || document.querySelector('script[data-key][src*="widget.js"]');
  if (!script) return;
  var key = script.getAttribute('data-key');
  if (!key || !/^wc_[\w-]{10,60}$/.test(key)) return;
  var origin = new URL(script.src, location.href).origin;
  var listeners = {};
  var state = { open: false, unread: 0, ready: false, identity: null, destroyed: false };
  var cfg = null;
  var host, launcher, badge, popup, frameBox, frame;

  function emit(name, data) { (listeners[name] || []).slice().forEach(function (f) { try { f(data); } catch (e) { /* host callback errors must not break the widget */ } }); }
  function el(tag, attrs, css) { var n = document.createElement(tag); Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); }); if (css) n.style.cssText = css; return n; }
  var ICONS = {
    chat: 'M21 12a8 8 0 0 1-11.7 7.1L4 20l1-4.2A8 8 0 1 1 21 12z',
    help: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7M12 17h.01',
    message: 'M4 4h16v12H8l-4 4V4z'
  };

  function post(msg) { if (frame && frame.contentWindow) frame.contentWindow.postMessage(msg, origin); }

  function setOpen(v) {
    if (state.destroyed || !cfg) return;
    state.open = v;
    frameBox.style.display = v ? 'block' : 'none';
    launcher.setAttribute('aria-expanded', v ? 'true' : 'false');
    if (popup) popup.style.display = 'none';
    if (v) { state.unread = 0; renderBadge(); post({ type: 'botwa:open' }); }
    emit(v ? 'open' : 'close');
  }
  function renderBadge() { badge.textContent = state.unread > 9 ? '9+' : String(state.unread); badge.style.display = state.unread ? 'flex' : 'none'; }

  function build(c) {
    cfg = c;
    var side = c.design.position === 'right' ? 'right' : 'left';
    var small = window.matchMedia && window.matchMedia('(max-width: 480px)').matches;
    host = el('div', { 'data-botwa-widget': '' }, 'all:initial;position:fixed;bottom:16px;' + side + ':16px;z-index:2147483000;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;');
    host.setAttribute('dir', c.design.language === 'he' ? 'rtl' : 'ltr');
    frameBox = el('div', {}, 'display:none;position:fixed;bottom:84px;' + side + ':16px;width:380px;max-width:calc(100vw - 24px);height:600px;max-height:calc(100vh - 100px);border-radius:16px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.28);background:#fff;');
    frame = el('iframe', {
      src: origin + '/w/' + encodeURIComponent(key), title: c.design.title, allow: 'clipboard-write', referrerpolicy: 'strict-origin',
      sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox', loading: 'lazy'
    }, 'border:0;width:100%;height:100%;display:block;');
    frameBox.appendChild(frame);
    launcher = el('button', { type: 'button', 'aria-label': c.design.launcherLabel || c.design.title, 'aria-expanded': 'false', 'aria-haspopup': 'dialog' },
      'all:unset;box-sizing:border-box;cursor:pointer;display:flex;align-items:center;gap:8px;min-width:56px;height:56px;padding:0 16px;border-radius:28px;justify-content:center;background:' + c.design.color + ';color:' + c.textColor + ';box-shadow:0 4px 16px rgba(0,0,0,.28);font:600 15px system-ui,sans-serif;position:relative;');
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '26'); svg.setAttribute('height', '26'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', ICONS[c.design.launcherIcon] || ICONS.chat); svg.appendChild(path);
    launcher.appendChild(svg);
    if (c.design.launcherLabel && !small) launcher.appendChild(document.createTextNode(c.design.launcherLabel));
    badge = el('span', { 'aria-hidden': 'true' }, 'display:none;position:absolute;top:-4px;' + (side === 'left' ? 'right' : 'left') + ':-4px;min-width:20px;height:20px;border-radius:10px;background:#b42318;color:#fff;font:700 12px system-ui;align-items:center;justify-content:center;padding:0 5px;');
    launcher.appendChild(badge);
    launcher.addEventListener('click', function () { setOpen(!state.open); });
    launcher.addEventListener('focus', function () { launcher.style.outline = '3px solid ' + c.textColor; launcher.style.outlineOffset = '2px'; });
    launcher.addEventListener('blur', function () { launcher.style.outline = 'none'; });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.open) { setOpen(false); launcher.focus(); } });
    host.appendChild(launcher);
    document.body.appendChild(frameBox);
    document.body.appendChild(host);

    var b = c.behavior;
    if (b.popupText) {
      setTimeout(function () {
        if (state.open || state.destroyed || sessionStorageGet('popup')) return;
        popup = el('div', { role: 'status' }, 'position:absolute;bottom:68px;' + side + ':0;max-width:240px;width:max-content;background:#fff;color:#111;padding:10px 14px;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.25);font:14px/1.4 system-ui,sans-serif;cursor:pointer;');
        popup.textContent = b.popupText;
        popup.addEventListener('click', function () { setOpen(true); });
        host.appendChild(popup);
        sessionStorageSet('popup', '1');
      }, b.popupDelaySec * 1000);
    }
    if (b.autoOpenSec) setTimeout(function () { if (!sessionStorageGet('opened') && !state.destroyed) { sessionStorageSet('opened', '1'); setOpen(true); } }, b.autoOpenSec * 1000);
    state.ready = true;
    emit('ready');
  }
  function sessionStorageGet(k) { try { return sessionStorage.getItem('botwa_' + key + k); } catch (e) { return null; } }
  function sessionStorageSet(k, v) { try { sessionStorage.setItem('botwa_' + key + k, v); } catch (e) { /* private mode */ } }

  window.addEventListener('message', function (e) {
    if (e.origin !== origin || !frame || e.source !== frame.contentWindow || !e.data || typeof e.data.type !== 'string') return;
    var d = e.data;
    if (d.type === 'botwa:frame-ready') { if (state.identity) post({ type: 'botwa:identity', identity: state.identity }); }
    else if (d.type === 'botwa:close') { setOpen(false); launcher.focus(); }
    else if (d.type === 'botwa:message' && !state.open) { state.unread = Math.min(99, state.unread + 1); renderBadge(); emit('newMessage', { unread: state.unread }); }
    else if (d.type === 'botwa:started') emit('conversationStarted');
  });

  window.BotwaChat = {
    __loaded: true,
    open: function () { setOpen(true); }, close: function () { setOpen(false); }, toggle: function () { setOpen(!state.open); },
    /** Link the chat to a signed-in customer. `signature` = hex HMAC-SHA256(identity secret, id) computed on YOUR server, never in the browser. */
    identify: function (identity) { state.identity = identity && typeof identity === 'object' ? { id: String(identity.id || ''), name: identity.name, email: identity.email, phone: identity.phone, signature: identity.signature } : null; post({ type: 'botwa:identity', identity: state.identity }); },
    on: function (name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    destroy: function () { state.destroyed = true; [host, frameBox].forEach(function (n) { if (n && n.parentNode) n.parentNode.removeChild(n); }); emit('destroyed'); }
  };
  if (window.botwaChatIdentity) window.BotwaChat.identify(window.botwaChatIdentity);

  function start() {
    fetch(origin + '/widget/config?key=' + encodeURIComponent(key), { credentials: 'omit', mode: 'cors' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (c) { if (c && !state.destroyed) build(c); })
      .catch(function () { /* the host page must never break because the chat server is unreachable */ });
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
