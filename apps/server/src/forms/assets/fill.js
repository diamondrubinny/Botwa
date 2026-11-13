/* Fill and sign a form from its personal link: verify with a code sent to the same chat, fill, sign, get a copy. No libraries. */
(function () {
  'use strict';
  var token = (location.pathname.match(/^\/f\/(f_[\w-]{20,60})$/) || [])[1];
  var main = document.getElementById('main');
  var info = null, key = null, pads = {};
  var KEY = 'botwa_form_' + token;
  try { key = sessionStorage.getItem(KEY); } catch (e) { /* storage unavailable */ }

  var ERR = {
    required: 'שדה חובה', date: 'תאריך לא תקין', id_number: 'מספר תעודת זהות לא תקין', phone: 'מספר טלפון לא תקין', email: 'כתובת אימייל לא תקינה',
    number: 'יש להזין מספר', too_long: 'הטקסט ארוך מדי', signature: 'החתימה לא נקלטה, נסו שוב', checkbox: 'ערך לא תקין', type: 'ערך לא תקין',
  };

  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { var v = attrs[k]; if (v === null || v === undefined || v === false) return; if (k === 'text') e.textContent = v; else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v); });
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function api(method, path, body) {
    return fetch('/f/' + token + path, { method: method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, credentials: 'omit', cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || 'error'); e.status = r.status; e.data = j; throw e; } return j; }); });
  }
  function screen(kids, focusFirst) {
    main.innerHTML = '';
    kids.forEach(function (k) { if (k) main.appendChild(k); });
    main.focus();
    if (focusFirst) { var f = main.querySelector('input,textarea,button'); if (f) f.focus(); }
  }
  function head(step) {
    var steps = ['אימות', 'מילוי וחתימה', 'סיום'];
    return h('div', { class: 'card' }, [
      h('h1', { text: info.title }),
      info.description ? h('p', { class: 'muted', text: info.description }) : null,
      h('p', { class: 'hint', text: 'טופס מס׳ ' + info.number + ' · בתוקף עד ' + new Date(info.expiresAt).toLocaleDateString('he-IL') }),
      h('a', { class: 'btn', href: '/f/' + token + '/document.pdf', target: '_blank', rel: 'noopener', text: 'צפייה בטופס המלא (PDF)' }),
      h('ol', { class: 'steps', 'aria-label': 'שלבים' }, steps.map(function (s, i) { return h('li', { 'aria-current': i === step ? 'step' : null, text: (i + 1) + '. ' + s }); })),
    ]);
  }
  function message(title, text, cls) { screen([h('div', { class: 'card ' + (cls || '') }, [h('h1', { text: title }), h('p', { text: text })])]); }

  function start() {
    if (!token) return message('הקישור לא תקין', 'בדקו שהעתקתם את כל הקישור מההודעה.');
    api('GET', '/info').then(function (j) {
      info = j;
      if (j.org) document.getElementById('org').textContent = j.org;
      document.title = j.title + ' · חתימה';
      if (j.status === 'signed') return message('הטופס כבר נחתם', 'תודה! עותק חתום נשלח לצ׳אט. אם צריך עותק נוסף, כתבו לנו.');
      if (j.status === 'expired') return message('תוקף הקישור פג', 'אפשר לבקש קישור חדש בצ׳אט.');
      if (j.status === 'cancelled') return message('הבקשה בוטלה', 'הטופס כבר לא נדרש. לשאלות אפשר לכתוב לנו בצ׳אט.');
      if (key && j.verified) return fillForm();
      verifyScreen();
    }).catch(function () { message('הקישור לא תקין', 'ייתכן שהקישור לא הועתק במלואו, או שהוא כבר לא בתוקף.'); });
  }

  function verifyScreen(msg) {
    var status = h('p', { role: 'status', class: msg ? 'err' : 'hint', text: msg || '' });
    var codeIn = h('input', { id: 'code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', pattern: '[0-9]*', class: 'code', 'aria-describedby': 'code-h' });
    var codeBox = h('form', { hidden: true, onsubmit: function (e) {
      e.preventDefault();
      var v = codeIn.value.replace(/\D/g, '');
      if (v.length !== 6) { status.className = 'err'; status.textContent = 'הקוד הוא 6 ספרות.'; codeIn.focus(); return; }
      btnV.disabled = true;
      api('POST', '/verify', { code: v }).then(function (r) {
        key = r.key; try { sessionStorage.setItem(KEY, key); } catch (e2) { /* storage unavailable */ }
        fillForm();
      }).catch(function (err) {
        btnV.disabled = false;
        status.className = 'err';
        status.textContent = err.message === 'otp_wrong' ? 'הקוד שגוי. נסו שוב.' : err.message === 'otp_expired' ? 'תוקף הקוד פג. בקשו קוד חדש.' : err.message === 'otp_too_many' ? 'יותר מדי ניסיונות. בקשו קוד חדש.' : 'לא ניתן לאמת כרגע. נסו שוב.';
        codeIn.focus();
      });
    } }, [h('div', { class: 'field' }, [h('label', { for: 'code', text: 'קוד אימות (6 ספרות)' }), codeIn, h('p', { id: 'code-h', class: 'hint', text: 'הקוד נשלח לצ׳אט שבו קיבלתם את הקישור.' })]),
      h('button', { class: 'primary', type: 'submit', text: 'אימות והמשך' })]);
    var btnV = codeBox.querySelector('button');
    var send = h('button', { class: 'primary', type: 'button', onclick: function () {
      send.disabled = true;
      api('POST', '/otp').then(function () {
        status.className = 'okmsg'; status.textContent = 'הקוד נשלח' + (info.phoneHint ? ' ל-' + info.phoneHint : '') + '. הוא בתוקף 10 דקות.';
        codeBox.hidden = false; send.textContent = 'שליחת קוד חדש'; codeIn.focus();
        setTimeout(function () { send.disabled = false; }, 45000);
      }).catch(function (err) {
        send.disabled = false;
        status.className = 'err';
        status.textContent = err.message === 'too_soon' ? 'קוד נשלח לפני רגע. אפשר לבקש שוב בעוד דקה.' : err.message === 'too_many' ? 'נשלחו יותר מדי קודים לטופס הזה. כתבו לנו בצ׳אט.' : 'לא הצלחנו לשלוח קוד. נסו שוב בעוד רגע.';
      });
    }, text: 'שליחת קוד אימות לצ׳אט' });
    screen([head(0), h('div', { class: 'card' }, [
      h('h2', { text: 'אימות' }),
      h('p', { text: 'כדי לוודא שהטופס נחתם על ידיכם, נשלח קוד חד-פעמי לצ׳אט שבו קיבלתם את הקישור' + (info.phoneHint ? ' (' + info.phoneHint + ')' : '') + '.' }),
      send, status, codeBox,
    ])]);
  }

  function padFor(f) {
    var wrap = h('div', { class: 'field', id: 'w-' + f.id });
    var canvas = h('canvas', { class: 'pad', role: 'img', 'aria-label': f.label + ': אזור לציור חתימה באצבע או בעכבר' });
    var typed = h('input', { type: 'text', id: 'in-' + f.id, autocomplete: 'name', maxlength: '80', hidden: true, 'aria-describedby': 'tn-' + f.id });
    var state = { strokes: 0, typedMode: false };
    pads[f.id] = { canvas: canvas, typed: typed, state: state };
    var ctx = canvas.getContext('2d'), drawing = false, last = null;
    function size() {
      var r = canvas.getBoundingClientRect(), d = window.devicePixelRatio || 1;
      if (!r.width) return;
      canvas.width = Math.round(r.width * d); canvas.height = Math.round(r.height * d);
      ctx.setTransform(d, 0, 0, d, 0, 0); ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0f1f6b';
      state.strokes = 0;
    }
    function pos(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    canvas.addEventListener('pointerdown', function (e) { drawing = true; last = pos(e); canvas.setPointerCapture(e.pointerId); e.preventDefault(); });
    canvas.addEventListener('pointermove', function (e) { if (!drawing) return; var p = pos(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; state.strokes++; });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) { canvas.addEventListener(t, function () { drawing = false; }); });
    setTimeout(size, 0); window.addEventListener('resize', function () { if (!state.strokes) size(); });
    var clear = h('button', { type: 'button', onclick: function () { size(); }, text: 'ניקוי' });
    var toggle = h('button', { type: 'button', 'aria-pressed': 'false', onclick: function () {
      state.typedMode = !state.typedMode; toggle.setAttribute('aria-pressed', String(state.typedMode));
      canvas.hidden = state.typedMode; clear.hidden = state.typedMode; typed.hidden = !state.typedMode; tn.hidden = !state.typedMode;
      toggle.textContent = state.typedMode ? 'ציור חתימה במקום הקלדה' : 'הקלדת שם במקום ציור';
      if (state.typedMode) typed.focus();
    }, text: 'הקלדת שם במקום ציור' });
    var tn = h('p', { id: 'tn-' + f.id, class: 'hint', hidden: true, text: 'הקלידו את שמכם המלא. הוא יופיע במקום החתימה.' });
    wrap.appendChild(h('label', { for: 'in-' + f.id }, [f.label, f.required ? h('span', { class: 'req', 'aria-hidden': 'true', text: ' *' }) : null]));
    wrap.appendChild(canvas); wrap.appendChild(typed); wrap.appendChild(tn);
    wrap.appendChild(h('div', { class: 'padbar' }, [clear, toggle]));
    wrap.appendChild(h('p', { class: 'ferr', id: 'e-' + f.id, hidden: true }));
    return wrap;
  }

  function inputFor(f) {
    var v = info.prefill[f.id];
    if (f.type === 'signature' || f.type === 'initials') return padFor(f);
    if (f.type === 'checkbox') {
      return h('div', { class: 'field', id: 'w-' + f.id }, [h('label', { class: 'check' }, [h('input', { type: 'checkbox', id: 'in-' + f.id, checked: v === 'true' || v === true }), h('span', { text: f.label + (f.required ? ' *' : '') })]),
        f.hint ? h('p', { class: 'hint', text: f.hint }) : null, h('p', { class: 'ferr', id: 'e-' + f.id, hidden: true })]);
    }
    var type = { date: 'date', phone: 'tel', email: 'email', number: 'text' }[f.type] || 'text';
    var attrs = { id: 'in-' + f.id, type: type, value: v || '', readonly: f.locked, required: f.required, 'aria-required': f.required ? 'true' : null, 'aria-describedby': (f.hint ? 'h-' + f.id + ' ' : '') + 'e-' + f.id };
    if (f.type === 'id_number') { attrs.inputmode = 'numeric'; attrs.maxlength = '9'; attrs.autocomplete = 'off'; }
    if (f.type === 'number') attrs.inputmode = 'decimal';
    if (f.type === 'phone') { attrs.autocomplete = 'tel'; attrs.dir = 'ltr'; }
    if (f.type === 'email') { attrs.autocomplete = 'email'; attrs.dir = 'ltr'; }
    if (/^שם|name/i.test(f.label) && f.type === 'text') attrs.autocomplete = 'name';
    var el = f.type === 'textarea' ? h('textarea', { id: attrs.id, readonly: f.locked, maxlength: '2000', 'aria-describedby': attrs['aria-describedby'], 'aria-required': attrs['aria-required'] }) : h('input', attrs);
    if (f.type === 'textarea') el.value = v || '';
    return h('div', { class: 'field', id: 'w-' + f.id }, [h('label', { for: 'in-' + f.id }, [f.label, f.required ? h('span', { class: 'req', 'aria-hidden': 'true', text: ' *' }) : null, f.required ? h('span', { class: 'skip', text: ' (חובה)' }) : null]), el,
      f.hint ? h('p', { class: 'hint', id: 'h-' + f.id, text: f.hint }) : null, h('p', { class: 'ferr', id: 'e-' + f.id, hidden: true })]);
  }

  function validId(s) { var d = s.replace(/\D/g, ''); if (!d || d.length > 9) return false; d = ('000000000' + d).slice(-9); var sum = 0; for (var i = 0; i < 9; i++) { var n = Number(d[i]) * ((i % 2) + 1); if (n > 9) n -= 9; sum += n; } return sum % 10 === 0; }

  function collect() {
    var values = {}, marks = {}, errors = {};
    info.fields.forEach(function (f) {
      if (f.type === 'signature' || f.type === 'initials') {
        var p = pads[f.id];
        if (p.state.typedMode) { if (p.typed.value.trim().length >= 2) marks[f.id] = { typed: p.typed.value.trim() }; else if (f.required) errors[f.id] = 'required'; }
        else if (p.state.strokes > 3) marks[f.id] = { png: p.canvas.toDataURL('image/png') };
        else if (f.required) errors[f.id] = 'required';
        return;
      }
      var el = document.getElementById('in-' + f.id);
      if (f.type === 'checkbox') { values[f.id] = el.checked; if (f.required && !el.checked) errors[f.id] = 'required'; return; }
      var v = el.value.trim();
      values[f.id] = v || null;
      if (!v) { if (f.required) errors[f.id] = 'required'; return; }
      if (f.type === 'id_number' && !validId(v)) errors[f.id] = 'id_number';
      if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) errors[f.id] = 'email';
      if (f.type === 'phone' && !/^\+?[0-9][0-9 -]{6,18}[0-9]$/.test(v)) errors[f.id] = 'phone';
    });
    return { values: values, marks: marks, errors: errors };
  }

  function showErrors(errors, box) {
    info.fields.forEach(function (f) {
      var e = document.getElementById('e-' + f.id), el = document.getElementById('in-' + f.id);
      if (!e) return;
      e.hidden = !errors[f.id]; e.textContent = errors[f.id] ? (ERR[errors[f.id]] || 'ערך לא תקין') : '';
      if (el) el.setAttribute('aria-invalid', errors[f.id] ? 'true' : 'false');
    });
    var ids = Object.keys(errors);
    box.innerHTML = ''; box.hidden = !ids.length;
    if (!ids.length) return;
    box.appendChild(h('h2', { text: 'יש לתקן ' + ids.length + ' שדות:' }));
    box.appendChild(h('ul', null, ids.map(function (id) { var f = info.fields.filter(function (x) { return x.id === id; })[0]; return h('li', null, [h('a', { href: '#w-' + id, onclick: function (ev) { ev.preventDefault(); var t = document.getElementById('in-' + id) || document.getElementById('w-' + id); if (t) t.focus(); }, text: (f ? f.label : id) + ': ' + (ERR[errors[id]] || 'ערך לא תקין') })]); })));
    box.focus();
  }

  function fillForm() {
    var summary = h('div', { class: 'summary', tabindex: '-1', role: 'alert', hidden: true });
    var groups = {}, order = [];
    info.fields.forEach(function (f) { if (!groups[f.page]) { groups[f.page] = []; order.push(f.page); } groups[f.page].push(f); });
    var body = [];
    order.forEach(function (p) {
      if (order.length > 1) body.push(h('h2', { class: 'page-h', text: 'עמוד ' + (Number(p) + 1) }));
      groups[p].forEach(function (f) { body.push(inputFor(f)); });
    });
    var consent = h('input', { type: 'checkbox', id: 'consent' });
    var status = h('p', { role: 'status' });
    var btn = h('button', { class: 'primary', type: 'submit', text: 'חתימה ושליחה' });
    var form = h('form', { novalidate: true, onsubmit: function (e) {
      e.preventDefault();
      var c = collect();
      if (!consent.checked) c.errors._consent = 'required';
      showErrors(c.errors, summary);
      document.getElementById('e-consent').hidden = !c.errors._consent;
      if (Object.keys(c.errors).length) return;
      btn.disabled = true; status.className = ''; status.textContent = 'חותם ושומר…';
      api('POST', '/submit', { key: key, consent: true, values: c.values, marks: c.marks }).then(function (r) {
        try { sessionStorage.removeItem(KEY); } catch (e2) { /* ignore */ }
        doneScreen(r.sha256);
      }).catch(function (err) {
        btn.disabled = false;
        if (err.message === 'invalid' && err.data && err.data.fields) { showErrors(err.data.fields, summary); status.textContent = ''; return; }
        if (err.message === 'not_verified') { key = null; return verifyScreen('תוקף האימות פג. שלחו קוד חדש כדי להמשיך.'); }
        status.className = 'err'; status.textContent = err.message === 'signed' ? 'הטופס כבר נחתם.' : 'השליחה נכשלה. נסו שוב בעוד רגע.';
      });
    } }, [h('div', { class: 'card' }, [h('h2', { text: 'מילוי וחתימה' }), h('p', { class: 'hint', text: 'שדות עם * הם חובה.' }), summary].concat(body).concat([
      h('div', { class: 'field' }, [h('label', { class: 'check' }, [consent, h('span', { text: 'קראתי את הטופס, הפרטים שמילאתי נכונים, ואני חותם/ת עליו באופן אלקטרוני.' })]), h('p', { class: 'ferr', id: 'e-consent', hidden: true, text: 'יש לאשר כדי לחתום.' })]),
      btn, status]))]);
    screen([head(1), form], true);
  }

  function doneScreen(hash) {
    var status = h('p', { role: 'status' });
    var dl = h('button', { type: 'button', onclick: function () {
      fetch('/f/' + token + '/signed.pdf', { method: 'POST', credentials: 'omit' }).then(function (r) { if (!r.ok) throw new Error(); return r.blob(); }).then(function (b) {
        var a = h('a', { href: URL.createObjectURL(b), download: info.title + ' - חתום.pdf' }); document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      }).catch(function () { status.className = 'err'; status.textContent = 'ההורדה זמינה רק בחצי השעה הראשונה. עותק נשלח לצ׳אט.'; });
    }, text: 'הורדת עותק חתום' });
    screen([head(2), h('div', { class: 'card done' }, [h('p', { class: 'big', 'aria-hidden': 'true', text: '✓' }), h('h2', { text: 'הטופס נחתם ונשלח. תודה!' }),
      h('p', { text: 'עותק חתום נשלח גם לצ׳אט.' }), dl, status, h('p', { class: 'hint', text: 'טביעת המסמך (SHA-256): ' + hash.slice(0, 16) + '…' })])]);
  }

  start();
})();
