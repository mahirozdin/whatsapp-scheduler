import {
  clockTime,
  dateLabel,
  dayLabel,
  defaultSendAt,
  deviceTimezone,
  inputToInstant,
  offsetLabel,
  quickTimes,
  relativeTime,
  shortWhen,
  wallClock,
  wallToInput,
} from '/time.js';

const $ = (id) => document.getElementById(id);

let tz = deviceTimezone(); // the selected timezone (from the server)
let serverTz = tz;
let linked = false;
let recipient = null; // { jid, name, kind, phone?, avatar }
let messages = [];
let pollTimer = null;
let fastUntil = 0; // poll fast until then (right after a send)
let lastRender = '';
const watching = new Map(); // id -> recipient name, for "Sent to …" toasts
const expanded = new Set(); // message ids whose preview is not clamped
const brokenAvatars = new Set(); // avatar URLs that 404'd
let confirming = null; // { id, timer } for the two-step cancel
let sendAtTouched = false; // the user picked a send time (else it follows the default)
let lastWa = null; // the previous WhatsApp status, to move focus when linking starts or ends

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

// ---- icons (static SVG markup, never user data) ----

const ICONS = {
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  history: '<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5M12 7v5l3.5 2"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"/>',
};

function icon(name, size = 16, strokeWidth = 2) {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
  return tpl.content.firstChild;
}

for (const node of document.querySelectorAll('[data-icon]')) {
  node.prepend(icon(node.dataset.icon, node.classList.contains('tab-icon') ? 20 : node.classList.contains('sm') ? 14 : 18));
}

// ---- avatars ----

const isPhoneName = (name) => /^[+\d]/.test(String(name || '').trim());

const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter() : null;
// First grapheme, so emoji and letters with combining marks stay intact.
const firstGrapheme = (word) => (segmenter ? segmenter.segment(word)[Symbol.iterator]().next().value?.segment : Array.from(word)[0]) || '';

/** Up to two initials, from words that start with a letter or digit (no emoji or symbols). */
function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter((word) => /^[\p{L}\p{N}]/u.test(word));
  return words.slice(0, 2).map(firstGrapheme).join('').toLocaleUpperCase();
}

function avatarHue(jid) {
  return [...String(jid)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % 8;
}

/** Round avatar: the cached profile picture over coloured initials (or a person/group glyph). */
function avatar({ jid, name, kind, avatar: url }, size = 36) {
  const node = el('span', `avatar av-${avatarHue(jid || name)}`);
  node.style.setProperty('--size', `${size}px`);
  node.setAttribute('aria-hidden', 'true');
  const group = kind === 'group' || String(jid).endsWith('@g.us');
  const text = !name || isPhoneName(name) ? '' : initials(name);
  if (group) node.append(icon('users', Math.round(size * 0.5)));
  else if (!text) node.append(icon('user', Math.round(size * 0.5)));
  else node.append(el('span', 'initials', text));
  if (url && !brokenAvatars.has(url)) {
    const img = el('img');
    Object.assign(img, { src: url, alt: '', loading: 'lazy', decoding: 'async', width: size, height: size });
    img.onerror = () => {
      brokenAvatars.add(url);
      img.remove();
    };
    node.append(img);
  }
  return node;
}

/** "+90 555 111 22 33" for Turkish numbers; other countries as plain "+<digits>". */
function formatPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('90') && digits.length === 12) {
    return `+90 ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8, 10)} ${digits.slice(10)}`;
  }
  return `+${digits}`;
}

/** Secondary line for a recipient: phone number, "Group" or the typed number. */
function recipientSub(item) {
  if (item.typed) return 'Send to this number';
  if (item.kind === 'group' || String(item.jid).endsWith('@g.us')) return 'Group';
  if (item.phone) return formatPhone(item.phone);
  if (String(item.jid).endsWith('@s.whatsapp.net')) return formatPhone(item.jid.split('@')[0]);
  return 'Contact';
}

// ---- toasts ----

const TOAST_ICONS = { success: 'check', error: 'alert', info: 'info' };

/** Shows a toast; one with the same `key` as an open toast replaces it. */
function toast(text, { type = 'success', action, key } = {}) {
  const box = $('toasts');
  if (key) box.querySelector(`[data-key="${CSS.escape(key)}"]`)?.remove();
  while (box.children.length >= 3) box.firstElementChild.remove();
  const node = el('div', `toast toast--${type}`);
  if (key) node.dataset.key = key;
  node.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const glyph = el('span', 'toast-icon');
  glyph.append(icon(TOAST_ICONS[type], 16));
  node.append(glyph, el('span', 'toast-text', text));
  if (action) {
    const btn = el('button', 'toast-action', action.label);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      dismiss();
      action.run();
    });
    node.append(btn);
  }
  const close = el('button', 'icon-btn sm toast-close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss');
  close.append(icon('x', 14));
  close.addEventListener('click', () => dismiss());
  node.append(close);

  let timer;
  const life = type === 'error' ? 8000 : 4000;
  const arm = () => (timer = setTimeout(dismiss, life));
  const pause = () => clearTimeout(timer);
  function dismiss() {
    clearTimeout(timer);
    node.remove();
  }
  node.addEventListener('mouseenter', pause);
  node.addEventListener('mouseleave', arm);
  node.addEventListener('focusin', pause);
  node.addEventListener('focusout', arm);
  box.append(node);
  arm();
}

// ---- mobile tabs ----

const TABS = ['scheduled', 'new', 'history'];
const mobile = matchMedia('(max-width: 759px)');

function setTab(name, { focus = false } = {}) {
  if (!TABS.includes(name)) name = 'new';
  document.body.dataset.tab = name;
  for (const tab of document.querySelectorAll('.tabbar [role=tab]')) {
    const selected = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  }
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  // Bodies in a column that was hidden could not be measured.
  updateExpandable(document);
}

function syncPanelRoles() {
  for (const [col, tab] of [['col-compose', 'tab-new'], ['col-scheduled', 'tab-scheduled'], ['col-history', 'tab-history']]) {
    if (mobile.matches) {
      $(col).setAttribute('role', 'tabpanel');
      $(col).setAttribute('aria-labelledby', tab);
    } else {
      $(col).removeAttribute('role');
      $(col).setAttribute('aria-labelledby', col === 'col-compose' ? 'compose-title' : col.replace('col-', '') + '-title');
    }
  }
}

mobile.addEventListener('change', syncPanelRoles);
syncPanelRoles();

for (const tab of document.querySelectorAll('.tabbar [role=tab]')) {
  tab.addEventListener('click', () => {
    if (document.body.dataset.tab !== tab.dataset.tab) history.pushState(null, '', `#${tab.dataset.tab}`);
    setTab(tab.dataset.tab);
    window.scrollTo(0, 0);
  });
  tab.addEventListener('keydown', (event) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const index = TABS.indexOf(tab.dataset.tab);
    setTab(TABS[(index + step + TABS.length) % TABS.length], { focus: true });
  });
}

window.addEventListener('popstate', () => setTab(location.hash.slice(1)));
setTab(location.hash.slice(1) || 'new');

// ---- login ----

function showLogin() {
  clearTimeout(pollTimer);
  if ($('settings').open) $('settings').close();
  $('app').hidden = true;
  $('login').hidden = false;
  $('password').focus();
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('login-error').textContent = '';
  const button = event.target.querySelector('button');
  button.disabled = true;
  try {
    await api('POST', '/api/login', { password: $('password').value });
    $('password').value = '';
    showApp();
  } catch (err) {
    $('login-error').textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

$('logout').addEventListener('click', async () => {
  await api('POST', '/api/logout', {}).catch(() => {});
  showLogin();
});

// ---- WhatsApp status and linking ----

function renderStatus(status) {
  const wa = status.whatsapp;
  const previous = lastWa;
  lastWa = wa;
  linked = wa.linked;
  const pill = $('wa-status');
  const [className, label] = wa.linked && wa.online ? ['online', 'Connected'] : wa.linked ? ['connecting', 'Connecting…'] : ['warn', 'Not linked'];
  pill.className = `pill ${className}`;
  pill.querySelector('.pill-label').textContent = label;
  pill.setAttribute('aria-label', `WhatsApp: ${label}`);
  $('wa-detail').textContent = wa.linked
    ? wa.online
      ? 'Linked and connected. Messages are sent from your own WhatsApp account.'
      : 'Linked. Connecting to WhatsApp…'
    : 'Not linked. Link WhatsApp from the main screen to send messages.';

  $('link').hidden = wa.linked;
  $('unlink').hidden = !wa.linked;
  $('compose-fields').disabled = !wa.linked;
  $('compose-note').hidden = wa.linked;
  $('link-start').hidden = Boolean(wa.pairing);
  $('link-pending').hidden = !wa.pairing;
  $('link-error').textContent = wa.linked ? '' : wa.error || '';
  if (wa.pairing) {
    // The QR SVG is generated by our own server from the pairing code.
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

  // Keep keyboard focus when the control that had it is hidden: on the
  // Cancel button once pairing starts, back on "Show QR code" when it is
  // canceled, and on the recipient search once linked.
  const focusLost = document.activeElement === document.body || $('link').contains(document.activeElement);
  if (previous && focusLost) {
    if (!previous.linked && wa.linked) search.focus({ preventScroll: true });
    else if (!previous.pairing && wa.pairing) $('link-cancel').focus();
    else if (previous.pairing && !wa.pairing && !wa.linked) $('link-qr').focus();
  }

  const prevTz = tz;
  tz = status.timezone || tz;
  serverTz = status.serverTimezone || serverTz;
  if (tz !== prevTz) onTimezoneChanged(prevTz);
}

$('wa-status').addEventListener('click', () => {
  if (linked) return openSettings();
  setTab('new');
  $('link').scrollIntoView({ block: 'start', behavior: 'smooth' });
  ($('link-start').hidden ? $('link-cancel') : $('link-qr')).focus();
});

$('link-qr').addEventListener('click', () => api('POST', '/api/whatsapp/link', {}).then(refresh, (err) => toast(err.message, { type: 'error' })));

$('link-phone-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const phone = $('link-phone').value.trim();
  if (phone) api('POST', '/api/whatsapp/link', { phone }).then(refresh, (err) => toast(err.message, { type: 'error' }));
});

$('link-cancel').addEventListener('click', () => api('POST', '/api/whatsapp/cancel-link', {}).then(refresh));

let unlinkArmed = null;
$('unlink').addEventListener('click', async () => {
  const button = $('unlink');
  if (!unlinkArmed) {
    button.textContent = 'Click again to unlink';
    button.classList.add('armed');
    unlinkArmed = setTimeout(resetUnlink, 4000);
    return;
  }
  resetUnlink();
  button.disabled = true;
  try {
    await api('POST', '/api/whatsapp/unlink', {});
    toast('WhatsApp unlinked. Scheduled messages wait until you link again.', { type: 'info' });
    $('settings').close();
  } catch (err) {
    toast(err.message, { type: 'error' });
  } finally {
    button.disabled = false;
    refresh();
  }
});

function resetUnlink() {
  clearTimeout(unlinkArmed);
  unlinkArmed = null;
  $('unlink').textContent = 'Unlink WhatsApp';
  $('unlink').classList.remove('armed');
}

// ---- settings and timezone ----

let opener = null;
let zones = null; // [{ name, label, search }]

function openSettings({ focusTimezone = false } = {}) {
  opener = document.activeElement;
  resetUnlink();
  $('tz-filter').value = '';
  renderZones();
  renderTimezoneHints();
  $('settings').showModal();
  if (focusTimezone) $('tz-filter').focus();
}

$('settings-btn').addEventListener('click', () => openSettings());
$('tz').addEventListener('click', () => openSettings({ focusTimezone: true }));
$('when-tz').addEventListener('click', () => openSettings({ focusTimezone: true }));
$('settings-close').addEventListener('click', () => $('settings').close());
$('settings').addEventListener('click', (event) => {
  if (event.target === $('settings')) $('settings').close(); // backdrop
});
$('settings').addEventListener('close', () => {
  // A zone picked right before closing is still saved.
  if (pendingZone) saveTimezone(pendingZone);
  (opener && document.contains(opener) ? opener : $('settings-btn')).focus();
});

function loadZones() {
  if (zones) return zones;
  const names = new Set(Intl.supportedValuesOf?.('timeZone') || []);
  names.add('UTC');
  names.add(tz);
  names.add(deviceTimezone());
  const now = Date.now();
  zones = [...names].sort().map((name) => {
    const offset = offsetLabel(name, now);
    return { name, label: `${name.replaceAll('_', ' ')} (${offset})`, search: `${name} ${offset}`.toLowerCase().replaceAll('_', ' ') };
  });
  return zones;
}

function renderZones() {
  const query = $('tz-filter').value.trim().toLowerCase().replaceAll('_', ' ');
  const select = $('tz-select');
  select.replaceChildren();
  for (const zone of loadZones()) {
    if (query && !zone.search.includes(query)) continue;
    const option = el('option', null, zone.label);
    option.value = zone.name;
    option.selected = zone.name === tz;
    select.append(option);
  }
  if (!select.options.length) {
    const option = el('option', null, 'No matching time zone');
    option.disabled = true;
    select.append(option);
  }
}

function renderTimezoneHints() {
  const device = deviceTimezone();
  $('tz-hint').textContent = `Messages without an explicit offset are scheduled in this zone. Server: ${serverTz}.`;
  $('tz-use-device').hidden = device === tz;
  $('tz-use-device').textContent = `Use this device's zone (${device})`;
}

$('tz-filter').addEventListener('input', renderZones);
$('tz-filter').addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    $('tz-select').focus();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const first = [...$('tz-select').options].find((o) => !o.disabled);
    // Close first, so the confirmation toast and the new clock are visible.
    if (first) saveTimezone(first.value).then((saved) => saved && $('settings').close());
  }
});

// Arrow keys fire `change` on every step; save once the selection settles.
let saveTimer = null;
let pendingZone = null;
$('tz-select').addEventListener('change', () => {
  clearTimeout(saveTimer);
  pendingZone = $('tz-select').value;
  saveTimer = setTimeout(() => saveTimezone(pendingZone), 600);
});
$('tz-use-device').addEventListener('click', () => saveTimezone(deviceTimezone()));

/** Saves the selected timezone. Resolves to true when it was saved. */
async function saveTimezone(name) {
  clearTimeout(saveTimer);
  pendingZone = null;
  if (!name || name === tz) return false;
  try {
    const result = await api('PUT', '/api/settings', { timezone: name });
    const prevTz = tz;
    tz = result.timezone;
    onTimezoneChanged(prevTz);
    renderZones();
    toast(`Time zone set to ${tz}`);
    return true;
  } catch (err) {
    toast(err.message, { type: 'error' });
    return false;
  }
}

/**
 * Re-renders everything shown in the timezone. An untouched send time follows
 * the default in the new zone; one the user picked keeps its instant.
 */
function onTimezoneChanged(prevTz) {
  const input = $('send-at');
  if (!sendAtTouched) {
    input.value = defaultSendAt(tz);
  } else if (prevTz && input.value) {
    const at = inputToInstant(input.value, prevTz);
    if (!Number.isNaN(at)) {
      const moved = wallToInput(wallClock(at, tz));
      if (moved !== input.value) {
        input.value = moved;
        toast(`The send time is now shown in ${tz}: ${shortWhen(at, tz)}`, { type: 'info', key: 'send-at-moved' });
      }
    }
  }
  renderTimezoneHints();
  renderClock();
  renderWhen();
  lastRender = '';
  renderMessages();
}

function renderClock() {
  $('tz').querySelector('.clock-time').textContent = clockTime(Date.now(), tz);
  $('tz').querySelector('.clock-zone').textContent = tz;
  // On small screens only the time fits; show the offset when it is not this device's zone.
  const offset = $('tz').querySelector('.clock-offset');
  offset.textContent = offsetLabel(tz, Date.now(), 'shortOffset');
  offset.hidden = tz === deviceTimezone();
  $('tz').setAttribute('aria-label', `Time zone ${tz}, ${clockTime(Date.now(), tz)}. Change time zone`);
  $('when-tz').textContent = `${tz} · ${offsetLabel(tz, Date.now(), 'shortOffset')}`;
}

// ---- recipient picker (ARIA 1.2 combobox) ----

const search = $('to-search');
const list = $('to-results');
let results = [];
let active = -1;
let searchTimer = null;
let loadingTimer = null;
let searchSeq = 0;

const looksLikePhone = (query) => /^\+?[\d\s().-]{7,}$/.test(query);

function openList() {
  list.hidden = false;
  search.setAttribute('aria-expanded', 'true');
}

function closeList() {
  list.hidden = true;
  search.setAttribute('aria-expanded', 'false');
  search.removeAttribute('aria-activedescendant');
  clearTimeout(loadingTimer);
}

function setActive(index) {
  const options = list.querySelectorAll('[role=option]');
  active = options.length ? (index + options.length) % options.length : -1;
  options.forEach((option, i) => {
    option.classList.toggle('active', i === active);
    option.setAttribute('aria-selected', String(i === active));
  });
  if (active >= 0) {
    search.setAttribute('aria-activedescendant', options[active].id);
    options[active].scrollIntoView({ block: 'nearest' });
  } else {
    search.removeAttribute('aria-activedescendant');
  }
}

function listMessage(text) {
  const li = el('li', 'list-note', text);
  li.setAttribute('aria-disabled', 'true');
  list.replaceChildren(li);
  results = [];
  active = -1;
  search.removeAttribute('aria-activedescendant');
  openList();
}

function renderResults(items, query) {
  if (looksLikePhone(query)) {
    const jid = query.replace(/[^\d+]/g, '');
    items = [{ jid, name: query, kind: 'dm', typed: true }, ...items.filter((i) => i.jid.split('@')[0] !== jid.replace('+', ''))];
  }
  results = items;
  $('to-status').textContent = items.length ? `${items.length} result${items.length === 1 ? '' : 's'}` : 'No results';
  if (!items.length) return listMessage('No contacts match. Type a full number with country code.');
  list.replaceChildren();
  items.forEach((item, i) => {
    const li = el('li', 'option');
    li.id = `to-opt-${i}`;
    li.setAttribute('role', 'option');
    const text = el('span', 'option-text');
    text.append(el('span', 'option-name', item.name), el('span', 'option-sub', recipientSub(item)));
    li.append(avatar(item, 32), text);
    li.addEventListener('mousedown', (event) => event.preventDefault()); // keep focus in the input
    li.addEventListener('click', () => pickRecipient(item));
    li.addEventListener('mousemove', () => active !== i && setActive(i));
    list.append(li);
  });
  openList();
  setActive(0);
}

function runSearch() {
  const query = search.value.trim();
  clearTimeout(searchTimer);
  clearTimeout(loadingTimer);
  if (!query) {
    results = [];
    return closeList();
  }
  const seq = ++searchSeq;
  // A typed number is usable right away; contacts are merged in when they arrive.
  if (looksLikePhone(query)) renderResults([], query);
  else loadingTimer = setTimeout(() => seq === searchSeq && listMessage('Searching…'), 300);
  searchTimer = setTimeout(async () => {
    let items = [];
    try {
      items = await api('GET', `/api/recipients?q=${encodeURIComponent(query)}`);
    } catch {
      // fall through with no results
    }
    if (seq !== searchSeq || document.activeElement !== search) return;
    clearTimeout(loadingTimer);
    renderResults(items, query);
  }, 150);
}

function pickRecipient(item) {
  recipient = item;
  closeList();
  searchSeq++;
  search.value = '';
  const chip = $('to-chip');
  chip.querySelector('.chip-avatar').replaceChildren(avatar(item, 24));
  chip.querySelector('.chip-name').textContent = item.name;
  // A typed number is already the name.
  chip.querySelector('.chip-sub').textContent = item.typed ? 'Phone number' : recipientSub(item);
  chip.setAttribute('aria-label', `To ${item.name}. Press Backspace to change.`);
  chip.hidden = false;
  search.parentElement.hidden = true;
  $('schedule-error').textContent = '';
  $('text').focus();
}

function clearRecipient({ focus = true } = {}) {
  recipient = null;
  $('to-chip').hidden = true;
  search.parentElement.hidden = false;
  search.value = '';
  if (focus) search.focus();
}

search.addEventListener('input', runSearch);
search.addEventListener('focus', () => {
  if (mobile.matches) search.closest('.picker').scrollIntoView({ block: 'start', behavior: 'smooth' });
  if (search.value.trim() && list.hidden) runSearch();
});
search.addEventListener('blur', () => setTimeout(closeList, 120));
search.addEventListener('keydown', (event) => {
  const open = !list.hidden && results.length > 0;
  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowUp':
      event.preventDefault();
      if (list.hidden) return runSearch();
      if (results.length) setActive(active + (event.key === 'ArrowDown' ? 1 : -1));
      break;
    case 'Enter':
      // Never submit the form from the recipient field.
      event.preventDefault();
      if (open && active >= 0) pickRecipient(results[active]);
      break;
    case 'Tab':
      if (open && active >= 0 && !event.shiftKey) {
        event.preventDefault();
        pickRecipient(results[active]);
      }
      break;
    case 'Escape':
      if (!list.hidden) {
        event.preventDefault();
        closeList();
      } else if (search.value) {
        event.preventDefault();
        search.value = '';
        results = [];
      }
      break;
  }
});

$('to-chip').querySelector('button').addEventListener('click', () => clearRecipient());
$('to-chip').addEventListener('keydown', (event) => {
  if ((event.key === 'Backspace' || event.key === 'Delete') && event.target === $('to-chip')) {
    event.preventDefault();
    clearRecipient();
  }
});

// ---- compose ----

const mode = () => document.querySelector('input[name=mode]:checked').value;
let submitting = false;

$('text').addEventListener('input', () => {
  const text = $('text');
  text.style.height = 'auto';
  text.style.height = `${text.scrollHeight + 2}px`;
  const count = $('text-count');
  count.hidden = text.value.length <= 1000;
  count.textContent = `${text.value.length} / 4000`;
});

function renderQuickTimes() {
  const box = document.querySelector('.quick-times');
  box.replaceChildren();
  for (const pick of quickTimes(tz)) {
    const button = el('button', 'chip-btn', pick.label);
    button.type = 'button';
    button.classList.toggle('selected', $('send-at').value === pick.value);
    button.addEventListener('click', () => {
      $('send-at').value = pick.value;
      sendAtTouched = true;
      renderWhen();
    });
    box.append(button);
  }
}

function setSubmitLabel(label, iconName) {
  const button = $('submit-btn');
  button.querySelector('.btn-label').textContent = label;
  button.querySelector('.btn-icon').replaceChildren(iconName === 'spinner' ? el('span', 'spinner') : icon(iconName, 16));
}

/** Updates the time hint, quick picks and the submit label for the current mode and time. */
function renderWhen() {
  const now = mode() === 'now';
  document.querySelector('.when-row').hidden = now;
  const hint = $('send-at-hint');
  hint.classList.remove('danger');
  if (submitting) return;
  if (now) {
    hint.textContent = 'Sends immediately.';
    setSubmitLabel('Send now', 'send');
    return;
  }
  renderQuickTimes();
  const at = inputToInstant($('send-at').value, tz);
  if (Number.isNaN(at)) {
    hint.textContent = `Pick a date and time (${tz}).`;
    setSubmitLabel('Schedule', 'clock');
    return;
  }
  setSubmitLabel(`Schedule for ${shortWhen(at, tz)}`, 'clock');
  if (at < Date.now() - 60_000) {
    hint.textContent = 'This time is in the past.';
    hint.classList.add('danger');
    return;
  }
  const lines = [`${dateLabel(at, tz)}, ${clockTime(at, tz)} · ${tz} (${offsetLabel(tz, at, 'shortOffset')}) · ${relativeTime(at, tz)}`];
  const device = deviceTimezone();
  if (device !== tz && clockTime(at, device) + dateLabel(at, device) !== clockTime(at, tz) + dateLabel(at, tz)) {
    lines.push(`= ${shortWhen(at, device)} on this device (${device})`);
  }
  hint.textContent = lines.join('\n');
}

for (const radio of document.querySelectorAll('input[name=mode]')) radio.addEventListener('change', renderWhen);
$('send-at').addEventListener('input', () => {
  sendAtTouched = true;
  renderWhen();
});

$('schedule-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting) return;
  const error = $('schedule-error');
  error.textContent = '';
  if (!recipient) {
    error.textContent = search.value.trim() ? 'Pick a recipient from the list.' : 'Choose who to send the message to.';
    return search.focus();
  }
  const text = $('text').value;
  if (!text.trim()) {
    error.textContent = 'Write a message first.';
    return $('text').focus();
  }
  const sendNow = mode() === 'now';
  let sendAt = 'now';
  if (!sendNow) {
    const at = inputToInstant($('send-at').value, tz);
    if (Number.isNaN(at)) {
      error.textContent = 'Pick a date and time.';
      return $('send-at').focus();
    }
    if (at < Date.now() - 60_000) {
      error.textContent = 'This time is in the past.';
      return $('send-at').focus();
    }
    // Send the instant shown to the user, not the wall-clock text: the server
    // would read that in its current timezone, which may have changed elsewhere.
    sendAt = new Date(at).toISOString();
  }

  submitting = true;
  $('submit-btn').disabled = true;
  setSubmitLabel(sendNow ? 'Sending…' : 'Scheduling…', 'spinner');
  const to = recipient;
  try {
    const message = await api('POST', '/api/messages', { to: to.jid, toName: to.name, text, sendAt });
    messages = [...messages.filter((m) => m.id !== message.id), sendNow ? { ...message, status: 'sending' } : message];
    if (sendNow) {
      watching.set(message.id, to.name);
      fastUntil = Date.now() + 20_000;
      toast(`Sending to ${to.name}…`, { type: 'info', key: `send-${message.id}` });
    } else {
      toast(`Scheduled for ${shortWhen(new Date(message.sendAt).getTime(), tz)} to ${to.name}`, { action: { label: 'View', run: () => viewMessage(message.id) } });
    }
    $('text').value = '';
    $('text').dispatchEvent(new Event('input'));
    $('send-at').value = defaultSendAt(tz);
    sendAtTouched = false;
    // Never leave "Send now" on: the next message would go out right away.
    if (sendNow) document.querySelector('input[name=mode][value=schedule]').checked = true;
    clearRecipient({ focus: false });
    search.focus();
    renderMessages();
    setTimeout(refresh, sendNow ? 300 : 0);
  } catch (err) {
    error.textContent = err.message;
  } finally {
    submitting = false;
    $('submit-btn').disabled = false;
    renderWhen();
  }
});

function viewMessage(id) {
  const message = messages.find((m) => m.id === id);
  const done = message && !['scheduled', 'sending'].includes(message.status);
  setTab(done ? 'history' : 'scheduled');
  const row = document.querySelector(`li.msg[data-id="${CSS.escape(id)}"]`);
  if (!row) return;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.remove('flash');
  void row.offsetWidth;
  row.classList.add('flash');
}

// ---- message lists ----

const STATUS = {
  scheduled: ['Scheduled', 'clock'],
  sending: ['Sending', null],
  sent: ['Sent', 'check'],
  failed: ['Failed', 'alert'],
  canceled: ['Canceled', 'ban'],
};

function badge(status) {
  const [label, glyph] = STATUS[status] || [status, null];
  const node = el('span', `badge badge--${status}`);
  node.append(glyph ? icon(glyph, 11, 2.5) : el('span', 'badge-dot'), el('span', null, label));
  return node;
}

function timeEl(ms, text, title) {
  const node = el('time', null, text);
  node.dateTime = new Date(ms).toISOString();
  if (title) node.title = title;
  return node;
}

const historyTime = (m) => new Date(m.sentAt || m.canceledAt || m.sendAt).getTime();
const fullTime = (ms) => `${dateLabel(ms, tz)} · ${clockTime(ms, tz)} (${tz})`;

function messageRow(m, scheduled) {
  const li = el('li', `msg msg--${m.status}`);
  li.dataset.id = m.id;
  const person = { jid: m.to, name: m.toName, avatar: m.avatar };
  li.append(avatar(person, 36));
  li.append(el('span', 'name', m.toName || m.to));

  const end = el('span', 'end');
  const at = scheduled ? new Date(m.sendAt).getTime() : historyTime(m);
  end.append(scheduled ? timeEl(at, m.status === 'sending' ? 'now' : relativeTime(at, tz), fullTime(at)) : timeEl(at, clockTime(at, tz), fullTime(at)));
  if (m.status === 'scheduled') end.append(cancelButton(m));
  li.append(end);

  const body = el('div', 'body', m.text);
  body.dataset.role = 'body';
  body.classList.toggle('expanded', expanded.has(m.id));
  body.addEventListener('click', () => {
    if (!getSelection()?.toString()) toggleBody(body);
  });
  body.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggleBody(body);
  });
  li.append(body);

  const foot = el('div', 'foot');
  foot.append(badge(m.status));
  // The day is in the group header above.
  if (scheduled) foot.append(el('span', 'abs', clockTime(at, tz)));
  else if (m.status === 'failed' && m.sendAt) foot.append(el('span', 'abs', `due ${clockTime(new Date(m.sendAt).getTime(), tz)}`));
  if (m.error) foot.append(el('span', 'err', m.error));
  li.append(foot);
  return li;
}

/** Expands or collapses a message body that is clamped (see updateExpandable). */
function toggleBody(body) {
  if (body.getAttribute('role') !== 'button') return;
  const id = body.closest('li.msg').dataset.id;
  expanded.has(id) ? expanded.delete(id) : expanded.add(id);
  updateExpandable(body.closest('li.msg'));
}

/**
 * Only bodies that are clamped (or were expanded) toggle, as buttons. Runs
 * after rendering, and again when a hidden column is shown or the width changes.
 */
function updateExpandable(root) {
  for (const body of root.querySelectorAll('li.msg .body')) {
    const open = expanded.has(body.closest('li.msg').dataset.id);
    body.classList.toggle('expanded', open);
    const clamped = !open && body.scrollHeight > body.clientHeight + 1;
    body.classList.toggle('clamped', clamped);
    if (open || clamped) {
      body.setAttribute('role', 'button');
      body.tabIndex = 0;
      body.setAttribute('aria-expanded', String(open));
      body.title = open ? 'Show less' : 'Show more';
    } else {
      for (const name of ['role', 'tabindex', 'aria-expanded', 'title']) body.removeAttribute(name);
    }
  }
}

let resizeFrame = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => updateExpandable(document));
});

function cancelButton(m) {
  const button = el('button', 'cancel');
  button.type = 'button';
  button.dataset.role = 'cancel';
  const armed = confirming?.id === m.id;
  if (armed) {
    button.classList.add('armed');
    button.textContent = 'Confirm';
    button.setAttribute('aria-label', `Confirm canceling the message to ${m.toName}`);
  } else {
    button.append(icon('x', 16));
    button.setAttribute('aria-label', `Cancel message to ${m.toName}`);
    button.title = 'Cancel message';
  }
  button.addEventListener('click', async () => {
    if (confirming?.id !== m.id) {
      clearTimeout(confirming?.timer);
      confirming = { id: m.id, timer: setTimeout(() => ((confirming = null), renderMessages({ force: true })), 3000) };
      return renderMessages({ force: true });
    }
    clearTimeout(confirming.timer);
    confirming = null;
    try {
      await api('DELETE', `/api/messages/${encodeURIComponent(m.id)}`, {});
      toast(`Canceled the message to ${m.toName}`, { type: 'info' });
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
    refresh();
  });
  return button;
}

function emptyState(glyph, title, body, action) {
  const li = el('li', 'empty');
  const circle = el('span', 'empty-icon');
  circle.append(icon(glyph, 20));
  li.append(circle, el('strong', null, title), el('span', null, body));
  if (action) li.append(action);
  return li;
}

function renderGroups(target, items, timeOf, rowOf) {
  let day = null;
  for (const m of items) {
    const label = dayLabel(timeOf(m), tz);
    if (label !== day) {
      day = label;
      const li = el('li', 'day');
      li.setAttribute('role', 'presentation');
      li.append(el('h3', null, label));
      target.append(li);
    }
    target.append(rowOf(m));
  }
}

const historyFilter = () => document.querySelector('input[name=history-filter]:checked').value;
for (const radio of document.querySelectorAll('input[name=history-filter]')) radio.addEventListener('change', () => renderMessages());

function renderMessages({ force = false } = {}) {
  const filter = historyFilter();
  const key = JSON.stringify([messages, tz, filter, confirming?.id, Math.floor(Date.now() / 30_000)]);
  if (!force && key === lastRender) return;
  lastRender = key;

  // Keep keyboard focus on the same control across re-renders.
  const focused = document.activeElement?.closest?.('li.msg');
  const focusKey = focused && [focused.dataset.id, document.activeElement.dataset.role];

  const scheduled = messages.filter((m) => m.status === 'scheduled' || m.status === 'sending').sort((a, b) => a.sendAt.localeCompare(b.sendAt));
  const done = messages.filter((m) => !scheduled.includes(m)).sort((a, b) => historyTime(b) - historyTime(a));
  const shown = (filter === 'all' ? done : done.filter((m) => m.status === filter)).slice(0, 200);

  $('count-scheduled').textContent = scheduled.length;
  $('count-history').textContent = done.length;
  $('tab-count').textContent = scheduled.length;
  $('tab-count').hidden = !scheduled.length;

  const target = $('scheduled');
  target.replaceChildren();
  if (!scheduled.length) {
    const button = el('button', 'secondary mobile-only', 'New message');
    button.type = 'button';
    button.addEventListener('click', () => {
      setTab('new');
      (recipient ? $('text') : search).focus();
    });
    target.append(emptyState('clock', 'Nothing scheduled', "Messages you schedule show up here until they're sent.", button));
  }
  renderGroups(target, scheduled, (m) => new Date(m.sendAt).getTime(), (m) => messageRow(m, true));

  const historyList = $('history');
  historyList.replaceChildren();
  if (!shown.length) {
    historyList.append(
      filter === 'all'
        ? emptyState('check', 'No history yet', 'Sent, failed and canceled messages appear here.')
        : emptyState(filter === 'failed' ? 'alert' : 'check', `No ${filter} messages`, 'Try another filter.'),
    );
  }
  renderGroups(historyList, shown, historyTime, (m) => messageRow(m, false));
  updateExpandable(target);
  updateExpandable(historyList);

  if (focusKey) {
    const row = document.querySelector(`li.msg[data-id="${CSS.escape(focusKey[0])}"]`);
    (row?.querySelector(focusKey[1] ? `[data-role="${focusKey[1]}"]` : 'button') || row)?.focus?.();
  }
}

/** Toasts for Send-now messages once they leave the "sending" state. */
function reportWatched() {
  for (const [id, name] of watching) {
    const m = messages.find((x) => x.id === id);
    if (!m) continue;
    if (m.status === 'sent') {
      watching.delete(id);
      toast(`Sent to ${name}`, { key: `send-${id}`, action: { label: 'View', run: () => viewMessage(id) } });
    } else if (m.status === 'failed' || m.status === 'canceled') {
      watching.delete(id);
      toast(`Could not send to ${name}${m.error ? `: ${m.error}` : ''}`, { type: 'error', key: `send-${id}` });
    }
  }
}

// ---- polling ----

function pollDelay(status) {
  const now = Date.now();
  // Poll fast while something is sending, about to send, or right after Send now.
  const soon = messages.some((m) => m.status === 'sending' || (m.status === 'scheduled' && new Date(m.sendAt).getTime() - now < 15_000));
  if (soon || watching.size || now < fastUntil) return 1500;
  if (status.whatsapp.pairing) return 2000;
  if (status.whatsapp.linked && !status.whatsapp.online) return 4000;
  return document.hidden ? 30_000 : 10_000;
}

async function refresh() {
  clearTimeout(pollTimer);
  try {
    const [status, list] = await Promise.all([api('GET', '/api/status'), api('GET', '/api/messages')]);
    messages = list;
    renderStatus(status);
    renderMessages();
    reportWatched();
    if (!$('send-at').value) {
      $('send-at').value = defaultSendAt(tz);
      renderWhen();
    }
    pollTimer = setTimeout(refresh, pollDelay(status));
  } catch (err) {
    if (err.message !== 'login required') pollTimer = setTimeout(refresh, 10_000);
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !$('app').hidden) refresh();
});

// The clock, relative times and the time hint follow the wall clock.
setInterval(() => {
  if ($('app').hidden) return;
  renderClock();
  renderWhen();
  renderMessages();
}, 30_000);

async function showApp() {
  $('login').hidden = true;
  $('app').hidden = false;
  try {
    const settings = await api('GET', '/api/settings');
    tz = settings.timezone || tz;
  } catch {
    // refresh() below reads it from /api/status as well
  }
  if (!$('send-at').value) $('send-at').value = defaultSendAt(tz);
  renderClock();
  renderWhen();
  await refresh();
  if (!mobile.matches || document.body.dataset.tab === 'new') (linked ? search : $('link-qr')).focus({ preventScroll: true });
}

const session = await api('GET', '/api/session').catch(() => ({ authenticated: false }));
session.authenticated ? showApp() : showLogin();
