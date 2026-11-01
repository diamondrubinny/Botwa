/* Chat UI that runs inside the iframe. Text is only ever inserted with textContent / DOM nodes (never as HTML). */
(function () {
  'use strict';
  var key = decodeURIComponent((location.pathname.match(/^\/w\/([\w-]+)/) || [])[1] || '');
  var app = document.getElementById('app');
  var T = {
    he: { loading: 'טוען…', send: 'שליחה', msg: 'כתבו הודעה…', msgLabel: 'ההודעה שלכם', start: 'התחלת שיחה', name: 'שם', email: 'אימייל', phone: 'טלפון', optional: ' (לא חובה)', close: 'סגירת הצ׳אט', you: 'אתם', team: 'הצוות', bot: 'הבוט', consent: 'יש לאשר כדי להמשיך.', required: 'שדה חובה', badEmail: 'כתובת אימייל לא תקינה', badPhone: 'מספר טלפון לא תקין', failed: 'השליחה נכשלה. נסו שוב.', offline: 'לא ניתן להתחבר כרגע. נסו שוב מאוחר יותר.', limit: 'שלחתם הרבה הודעות. נסו שוב בעוד רגע.', privacy: 'מדיניות הפרטיות', log: 'שיחה', newmsg: 'הודעה חדשה' },
    en: { loading: 'Loading…', send: 'Send', msg: 'Type a message…', msgLabel: 'Your message', start: 'Start chat', name: 'Name', email: 'Email', phone: 'Phone', optional: ' (optional)', close: 'Close chat', you: 'You', team: 'Team', bot: 'Bot', consent: 'Please accept to continue.', required: 'Required', badEmail: 'Invalid email address', badPhone: 'Invalid phone number', failed: 'Sending failed. Please try again.', offline: 'Cannot connect right now. Please try again later.', limit: 'You are sending too fast. Try again in a moment.', privacy: 'Privacy policy', log: 'Conversation', newmsg: 'New message' }
  };
  var L = T.he, cfg = null, token = null, identity = null, after = 0, polling = false, shown = {}, started = false, formShownAt = Date.now();
  var els = {};

  function store(k, v) { var name = 'botwa_wc_' + key + '_' + k; try { if (v === undefined) return localStorage.getItem(name); if (v === null) localStorage.removeItem(name); else localStorage.setItem(name, v); } catch (e) { return mem[name] || null; } mem[name] = v; return v; }
  var mem = {};
  function h(tag, attrs, children) { var n = document.createElement(tag); Object.keys(attrs || {}).forEach(function (k) { if (k === 'text') n.textContent = attrs[k]; else if (k === 'class') n.className = attrs[k]; else n.setAttribute(k, attrs[k]); }); (children || []).forEach(function (c) { n.appendChild(c); }); return n; }
  function api(method, path, body, auth) {
    var headers = { 'content-type': 'application/json' };
    if (auth && token) headers.authorization = 'Bearer ' + token;
    return fetch(path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, credentials: 'omit' }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || 'error'); e.status = r.status; throw e; } return j; }); });
  }
  function parent(msg) { try { window.parent.postMessage(msg, '*'); } catch (e) { /* standalone preview */ } }

  // plain-text -> DOM with safe http(s) links
  function linkify(text, into) {
    var re = /(https?:\/\/[^\s<>"']+)/g, last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) into.appendChild(document.createTextNode(text.slice(last, m.index)));
      var a = h('a', { href: m[1], target: '_blank', rel: 'noopener noreferrer nofollow', text: m[1] }); into.appendChild(a); last = m.index + m[1].length;
    }
    if (last < text.length) into.appendChild(document.createTextNode(text.slice(last)));
  }

  function addMessage(m) {
    if (shown[m.seq]) return; shown[m.seq] = true; after = Math.max(after, m.seq);
    var mine = m.direction === 'in';
    var box = h('div', { class: 'msg ' + (mine ? 'me' : 'them') });
    var who = mine ? L.you : (m.auto ? L.bot : (m.sender || L.team));
    box.appendChild(h('span', { class: 'who', text: who }));
    var body = h('span'); linkify(m.text, body); box.appendChild(body);
    els.log.appendChild(box);
    els.log.scrollTop = els.log.scrollHeight;
    if (!mine) parent({ type: 'botwa:message' });
  }

  function poll() {
    if (polling || !token) return;
    polling = true;
    api('GET', '/widget/messages?after=' + after + '&wait=20', null, true)
      .then(function (r) { (r.messages || []).forEach(addMessage); polling = false; setTimeout(poll, 300); })
      .catch(function (e) { polling = false; if (e.status === 401) { store('token', null); token = null; return; } setTimeout(poll, 5000); });
  }

  function showChat() {
    app.textContent = '';
    var close = h('button', { type: 'button', class: 'close', 'aria-label': L.close, text: '×' });
    close.addEventListener('click', function () { parent({ type: 'botwa:close' }); });
    var head = h('header', {}, [h('div', { class: 'grow' }, [h('h1', { text: cfg.design.title }), h('p', { text: cfg.design.subtitle })]), close]);
    var kids = [head];
    if (!cfg.online) kids.push(h('div', { class: 'offline', role: 'status', text: cfg.behavior.offlineMessage }));
    els.log = h('div', { class: 'log', role: 'log', 'aria-live': 'polite', 'aria-label': L.log });
    if (cfg.design.welcome) els.log.appendChild(h('div', { class: 'notice', text: cfg.design.welcome }));
    var ta = h('textarea', { rows: '1', maxlength: String(cfg.behavior.maxLength), placeholder: L.msg, 'aria-label': L.msgLabel });
    var btn = h('button', { type: 'submit', class: 'send', 'aria-label': L.send, text: '➤' });
    var err = h('div', { class: 'err', role: 'alert' });
    var form = h('form', { class: 'composer' }, [ta, btn]);
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = ta.value.trim(); if (!text) return;
      btn.disabled = true; err.textContent = '';
      var extra = pending; pending = null;
      api('POST', '/widget/messages', Object.assign({ text: text }, extra || {}), true)
        .then(function () { ta.value = ''; if (!started) { started = true; parent({ type: 'botwa:started' }); } poll(); })
        .catch(function (er) { pending = extra; err.textContent = er.status === 429 ? L.limit : L.failed; })
        .then(function () { btn.disabled = false; ta.focus(); });
    });
    kids.push(els.log, err, form);
    kids.forEach(function (k) { app.appendChild(k); });
    api('GET', '/widget/messages?after=0', null, true).then(function (r) { (r.messages || []).forEach(addMessage); started = (r.messages || []).length > 0; poll(); }).catch(function () { /* retried by poll */ });
    ta.focus();
  }
  var pending = null;

  function showForm() {
    var b = cfg.behavior, fields = [], values = {};
    app.textContent = '';
    var close = h('button', { type: 'button', class: 'close', 'aria-label': L.close, text: '×' });
    close.addEventListener('click', function () { parent({ type: 'botwa:close' }); });
    app.appendChild(h('header', {}, [h('div', { class: 'grow' }, [h('h1', { text: cfg.design.title }), h('p', { text: cfg.design.subtitle })]), close]));
    var form = h('form', { class: 'pre', novalidate: 'novalidate' });
    form.appendChild(h('p', { text: cfg.design.welcome }));
    [['name', 'askName', 'text'], ['email', 'askEmail', 'email'], ['phone', 'askPhone', 'tel']].forEach(function (d) {
      var mode = b[d[1]]; if (mode === 'off') return;
      var id = 'f-' + d[0];
      var input = h('input', { type: d[2], id: id, name: d[0], autocomplete: d[0] === 'phone' ? 'tel' : d[0], maxlength: '100', 'aria-required': mode === 'required' ? 'true' : 'false' });
      if (identity && identity[d[0]]) input.value = String(identity[d[0]]).slice(0, 100);
      var errp = h('div', { class: 'err', id: id + '-e', role: 'alert' });
      input.setAttribute('aria-describedby', id + '-e');
      form.appendChild(h('div', { class: 'field' }, [h('label', { for: id, text: L[d[0]] + (mode === 'optional' ? L.optional : '') }), input, errp]));
      fields.push({ key: d[0], mode: mode, input: input, err: errp, type: d[2] });
    });
    var consent = null, consentErr = h('div', { class: 'err', id: 'consent-e', role: 'alert' });
    if (b.consentText) {
      consent = h('input', { type: 'checkbox', id: 'consent', 'aria-describedby': 'consent-e', 'aria-required': 'true' });
      var lab = h('label', { for: 'consent', class: 'check' }, [consent, h('span', { text: b.consentText + ' ' })]);
      if (b.consentLink) lab.lastChild.appendChild(h('a', { href: b.consentLink, target: '_blank', rel: 'noopener noreferrer', text: L.privacy }));
      form.appendChild(h('div', { class: 'field' }, [lab, consentErr]));
    }
    form.appendChild(h('div', { class: 'hp', 'aria-hidden': 'true' }, [h('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off' })]));
    form.appendChild(h('button', { type: 'submit', class: 'primary', text: L.start }));
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var ok = true;
      fields.forEach(function (f) {
        var v = f.input.value.trim(); f.err.textContent = '';
        if (!v && f.mode === 'required') { f.err.textContent = L.required; ok = false; return; }
        if (v && f.type === 'email' && !/^[^\s@]{1,64}@[^\s@]{1,200}\.[^\s@]{2,}$/.test(v)) { f.err.textContent = L.badEmail; ok = false; return; }
        if (v && f.type === 'tel' && !/^\+?[\d\s()-]{7,20}$/.test(v)) { f.err.textContent = L.badPhone; ok = false; return; }
        if (v) values[f.key] = v;
      });
      consentErr.textContent = '';
      if (consent && !consent.checked) { consentErr.textContent = L.consent; ok = false; }
      if (!ok) { var first = form.querySelector('.err:not(:empty)'); if (first && first.previousElementSibling) first.previousElementSibling.focus(); return; }
      var hp = form.querySelector('input[name=website]').value;
      pending = Object.assign({}, values, { consent: consent ? true : undefined, hp: hp, ms: Date.now() - formShownAt });
      showChat();
    });
    app.appendChild(form);
    var firstInput = form.querySelector('input'); if (firstInput) firstInput.focus();
  }

  function session() {
    token = store('token');
    var body = { key: key, token: token || undefined, identity: identity || undefined };
    return api('POST', '/widget/session', body).then(function (r) { if (r.token) { token = r.token; store('token', token); } return r; });
  }

  function init() {
    api('GET', '/widget/config?key=' + encodeURIComponent(key)).then(function (c) {
      cfg = c; L = T[c.design.language] || T.he;
      document.documentElement.lang = c.design.language; document.documentElement.dir = c.design.language === 'he' ? 'rtl' : 'ltr';
      document.title = c.design.title;
      document.documentElement.style.setProperty('--c', c.design.color); document.documentElement.style.setProperty('--on', c.textColor);
      return session();
    }).then(function (r) {
      var needForm = !r.hasConversation && (cfg.behavior.askName !== 'off' || cfg.behavior.askEmail !== 'off' || cfg.behavior.askPhone !== 'off' || !!cfg.behavior.consentText);
      if (needForm) showForm(); else showChat();
      parent({ type: 'botwa:frame-ready' });
    }).catch(function () { app.textContent = ''; app.appendChild(h('p', { style: 'padding:16px', role: 'alert', text: L.offline })); });
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent || !e.data || typeof e.data.type !== 'string') return;
    if (e.data.type === 'botwa:identity') {
      identity = e.data.identity && typeof e.data.identity === 'object' ? e.data.identity : null;
      if (cfg && identity && identity.id && identity.signature && token) api('POST', '/widget/session', { key: key, token: token, identity: identity }).then(function () { /* identity linked */ }).catch(function () { /* unsigned or wrong: ignored */ });
    } else if (e.data.type === 'botwa:open') { var t = document.querySelector('textarea, input'); if (t) t.focus(); }
  });
  if (!key) { app.textContent = ''; return; }
  init();
})();
