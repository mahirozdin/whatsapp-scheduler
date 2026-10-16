const $ = (id) => document.getElementById(id);

let recipient = null; // { jid, name }
let pollTimer = null;
let searchTimer = null;

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') {
    showLogin();
    throw new Error('login required');
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatTime(iso) {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function toLocalInput(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function defaultSendAt() {
  const date = new Date(Date.now() + 60 * 60_000);
  date.setMinutes(Math.ceil(date.getMinutes() / 15) * 15, 0, 0);
  return toLocalInput(date);
}

// ---- login ----

function showLogin() {
  clearTimeout(pollTimer);
  $('app').hidden = true;
  $('login').hidden = false;
  $('password').focus();
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('login-error').textContent = '';
  try {
    await api('POST', '/api/login', { password: $('password').value });
    $('password').value = '';
    showApp();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

$('logout').addEventListener('click', async () => {
  await api('POST', '/api/logout', {});
  showLogin();
});

// ---- WhatsApp link ----

function renderStatus(status) {
  const wa = status.whatsapp;
  const pill = $('wa-status');
  pill.className = 'pill';
  if (wa.linked && wa.online) {
    pill.textContent = 'WhatsApp connected';
    pill.classList.add('online');
  } else if (wa.linked) {
    pill.textContent = 'Connecting…';
  } else {
    pill.textContent = 'WhatsApp not linked';
    pill.classList.add('warn');
  }

  $('link').hidden = wa.linked;
  $('unlink').hidden = !wa.linked;
  $('link-start').hidden = Boolean(wa.pairing);
  $('link-pending').hidden = !wa.pairing;
  $('link-error').textContent = wa.linked ? '' : wa.error || '';
  if (wa.pairing) {
    $('qr').innerHTML = !wa.pairing.phone && wa.pairing.qrSvg ? wa.pairing.qrSvg : '';
    $('pair-code').textContent = wa.pairing.code || '';
    $('link-wait').textContent = wa.pairing.phone
      ? wa.pairing.code
        ? 'Tap "Link with phone number instead" on your phone and enter this code.'
        : 'Requesting a pairing code…'
      : wa.pairing.qrSvg
        ? 'Scan this QR code with WhatsApp. After scanning, the first sync can take a minute.'
        : 'Starting…';
  }
  $('tz').textContent = `Times are in ${Intl.DateTimeFormat().resolvedOptions().timeZone} (server: ${status.timezone})`;
}

$('link-qr').addEventListener('click', () => api('POST', '/api/whatsapp/link', {}).then(refresh));

$('link-phone-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const phone = $('link-phone').value.trim();
  if (phone) api('POST', '/api/whatsapp/link', { phone }).then(refresh);
});

$('link-cancel').addEventListener('click', () => api('POST', '/api/whatsapp/cancel-link', {}).then(refresh));

$('unlink').addEventListener('click', async () => {
  if (!confirm('Unlink WhatsApp from this scheduler? Scheduled messages stay, but will not be sent until you link again.')) return;
  await api('POST', '/api/whatsapp/unlink', {});
  refresh();
});

// ---- recipient picker ----

function pickRecipient(item) {
  recipient = item;
  $('to-search').value = item.name;
  $('to-results').hidden = true;
}

function renderResults(items, query) {
  const list = $('to-results');
  list.replaceChildren();
  if (/^\+?[\d\s().-]{7,}$/.test(query)) {
    items = [{ jid: query.replace(/[^\d+]/g, ''), name: query, kind: 'phone number' }, ...items];
  }
  for (const item of items) {
    const li = el('li', null, item.name);
    li.append(el('small', null, item.kind === 'group' ? 'group' : item.kind === 'dm' ? item.jid.split('@')[0] : item.kind));
    li.addEventListener('mousedown', (event) => {
      event.preventDefault();
      pickRecipient(item);
    });
    list.append(li);
  }
  list.hidden = items.length === 0;
}

$('to-search').addEventListener('input', () => {
  recipient = null;
  const query = $('to-search').value.trim();
  clearTimeout(searchTimer);
  if (!query) {
    $('to-results').hidden = true;
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      renderResults(await api('GET', `/api/recipients?q=${encodeURIComponent(query)}`), query);
    } catch {
      renderResults([], query);
    }
  }, 200);
});

$('to-search').addEventListener('blur', () => setTimeout(() => ($('to-results').hidden = true), 100));

// ---- scheduling ----

async function submitMessage(sendAt) {
  $('schedule-error').textContent = '';
  if (!recipient) {
    $('schedule-error').textContent = 'Pick a recipient from the list (or type a phone number and pick it).';
    return;
  }
  try {
    await api('POST', '/api/messages', { to: recipient.jid, toName: recipient.name, text: $('text').value, sendAt });
    $('text').value = '';
    $('send-at').value = defaultSendAt();
    refresh();
  } catch (err) {
    $('schedule-error').textContent = err.message;
  }
}

$('schedule-form').addEventListener('submit', (event) => {
  event.preventDefault();
  submitMessage(new Date($('send-at').value).toISOString());
});

$('send-now').addEventListener('click', () => {
  if (!$('text').value.trim()) return $('text').focus();
  submitMessage('now');
});

function renderMessages(messages) {
  const scheduled = messages.filter((m) => m.status === 'scheduled' || m.status === 'sending');
  const history = messages.filter((m) => !scheduled.includes(m)).reverse().slice(0, 100);

  const render = (target, items, empty) => {
    target.replaceChildren();
    if (!items.length) target.append(el('li', 'empty', empty));
    for (const m of items) {
      const li = el('li');
      const head = el('div');
      head.append(el('span', 'who', m.toName), el('span', 'meta', ` · ${formatTime(m.sentAt || m.sendAt)}`));
      li.append(head);
      if (m.status === 'scheduled') {
        const cancel = el('button', 'link', 'Cancel');
        cancel.addEventListener('click', async () => {
          await api('DELETE', `/api/messages/${m.id}`, {}).catch((err) => alert(err.message));
          refresh();
        });
        li.append(cancel);
      } else {
        li.append(el('span', `status ${m.status}`, m.status));
      }
      li.append(el('div', 'body', m.text));
      if (m.error) li.append(el('div', 'err', m.error));
      target.append(li);
    }
  };

  render($('scheduled'), scheduled, 'Nothing scheduled.');
  render($('history'), history, 'No messages sent yet.');
}

// ---- polling ----

async function refresh() {
  clearTimeout(pollTimer);
  try {
    const [status, messages] = await Promise.all([api('GET', '/api/status'), api('GET', '/api/messages')]);
    renderStatus(status);
    renderMessages(messages);
    pollTimer = setTimeout(refresh, status.whatsapp.pairing ? 2000 : 10_000);
  } catch (err) {
    if (err.message !== 'login required') pollTimer = setTimeout(refresh, 10_000);
  }
}

function showApp() {
  $('login').hidden = true;
  $('app').hidden = false;
  if (!$('send-at').value) $('send-at').value = defaultSendAt();
  refresh();
}

const session = await api('GET', '/api/session').catch(() => ({ authenticated: false }));
session.authenticated ? showApp() : showLogin();
