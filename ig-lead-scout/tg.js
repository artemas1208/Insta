// tg.js — Telegram-интеграция IG Lead Scout (часть service worker'а).
// Режимы проверки:
//   "site" — быстрый, без аккаунта: t.me превью + t.me/s/ (посты публичных каналов).
//   "tg"   — точный, через залогиненный web.telegram.org (читает любые каналы/чаты).
// Бот принимает команды /start, /mode, /st и ссылки t.me — и кидает отчёты.

const TG_SETTINGS_KEY = 'igx_tg_settings';
const TG_OFFSET_KEY = 'igx_tg_offset';
const TG_REPORTED_KEY = 'igx_tg_reported';
const TG_TAB_KEY = 'igx_tg_tab';
const TG_POLL_ALARM = 'igx-tg-poll';

const TG_DEFAULT_SETTINGS = {
  token: '8809702284:AAHO7ut3ciEsy7Wn7sbNaZTCQkj7htAR4fc',
  chatId: 0,
  mode: 'site', // 'site' | 'tg'
  msgLimit: 20, // сколько сообщений читать в режиме "тг"
  delaySec: 10, // пауза между пачками запросов, сек
  autoReport: true, // слать отчёт в ТГ сразу при подтверждении лида
  safeMode: true, // безопасный режим: автоподбор щадящих значений
};

const TG_SAFE = { msgLimit: 10, delaySec: 30 };

const TG_RESERVED_USERS = new Set([
  'telegram', 'bot', 'username', 'stickers', 'addstickers', 'addemoji',
  'addtheme', 'settheme', 'share', 'proxy', 'socks', 'boost', 'm', 's',
  'invoice', 'game', 'confirmphone', 'login', 'iv', 'bg',
]);

function tgSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function tgApi(method, params, timeoutMs) {
  const s = await getTgSettings();
  if (!s.token) throw new Error('no-token');
  // Жёсткий таймаут: без него бот «зависал» на минуты при проблемах с сетью.
  // getUpdates сам по себе длинный (20с), ему даём запас.
  const limit = timeoutMs || (method === 'getUpdates' ? 30000 : 12000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), limit);
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${s.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {}),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error('network');
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error((data.description || 'api-error').slice(0, 200));
  return data.result;
}

async function tgSay(chatId, text, extra) {
  if (!chatId) return;
  try {
    await tgApi('sendMessage', Object.assign({ chat_id: chatId, text }, extra || {}));
  } catch (_) {}
}

// Юзернейм бота (кэшируем, чтобы открывать чат с ним в приложении ТГ)
let tgBotUsernameCache = null;
async function tgBotUsername() {
  if (tgBotUsernameCache) return tgBotUsernameCache;
  try {
    const data = await chrome.storage.local.get('igx_tg_botname');
    if (data.igx_tg_botname) {
      tgBotUsernameCache = data.igx_tg_botname;
      return tgBotUsernameCache;
    }
    const me = await tgApi('getMe', {});
    tgBotUsernameCache = me.username;
    await chrome.storage.local.set({ igx_tg_botname: me.username });
    return me.username;
  } catch (_) {
    return null;
  }
}

// Открыть чат в приложении Телеграм через протокол tg://.
// force=true — открыть по явному клику пользователя всегда; иначе действует глобальный выключатель.
async function tgOpenApp(domain, force) {
  const d = String(domain || '').replace(/^[@+]/, '');
  if (!d) return false;
  if (!force) {
    // Центральный рубильник: если автооткрытие выключено — автоматом ТГ не дёргаем вообще.
    const flag = await chrome.storage.local.get('igx_auto_open_tg');
    if (flag.igx_auto_open_tg === false) return false;
  }
  try {
    const tab = await chrome.tabs.create({ url: `tg://resolve?domain=${encodeURIComponent(d)}`, active: true });
    // вкладка-пустышка с протоколом не нужна — прикрываем через пару секунд
    setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 4000);
    return true;
  } catch (_) {
    return false;
  }
}

async function getTgSettings() {
  const data = await chrome.storage.local.get(TG_SETTINGS_KEY);
  const s = Object.assign({}, TG_DEFAULT_SETTINGS, data[TG_SETTINGS_KEY] || {});
  if (s.safeMode) {
    s.msgLimit = TG_SAFE.msgLimit;
    s.delaySec = TG_SAFE.delaySec;
  }
  return s;
}

async function saveTgSettings(patch) {
  const data = await chrome.storage.local.get(TG_SETTINGS_KEY);
  const next = Object.assign({}, TG_DEFAULT_SETTINGS, data[TG_SETTINGS_KEY] || {}, patch);
  await chrome.storage.local.set({ [TG_SETTINGS_KEY]: next });
  return next;
}

// ---------- извлечение контактов из текста ----------
function tgExtractFromText(text, out, selfName) {
  if (!text) return;
  const low = (selfName || '').toLowerCase();
  for (const m of text.matchAll(/@([A-Za-z0-9_]{3,32})/g)) {
    const u = m[1].toLowerCase();
    if (TG_RESERVED_USERS.has(u) || u === low) continue;
    out.users.add(u);
  }
  for (const m of text.matchAll(/(?:t\.me|telegram\.me)\/\+([A-Za-z0-9_-]{4,64})/g)) {
    out.invites.add('+' + m[1]);
  }
  for (const m of text.matchAll(/instagram\.com\/([A-Za-z0-9._]{1,30})/gi)) {
    const u = m[1].toLowerCase();
    if (TG_RESERVED_USERS.has(u)) continue;
    out.instagram.add(u);
  }
  for (const m of text.matchAll(/(?:inst|ig|инст|инстаграм)[\s:—–-]+@?([A-Za-z0-9._]{2,30})/gi)) {
    const u = m[1].toLowerCase().replace(/[.,]+$/, '');
    if (!u || TG_RESERVED_USERS.has(u)) continue;
    out.instagram.add(u);
  }
}

function htmlToDoc(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

// ---------- проверка через Bot API (api.telegram.org) ----------
// Единственный путь, который гарантированно работает даже когда t.me в браузере
// заблокирован: бот и так через api.telegram.org общается. Ограничения:
//  - getChat видит публичные каналы/группы (тип, название, описание, счётчики);
//  - личку видит только если юз уже писал боту (иначе «неизвестно», но ссылку даём);
//  - посты канала без админки бота прочитать нельзя — читаем описание.
async function tgApiCheck(target) {
  const t = String(target || '').replace(/^[@+]/, '');
  if (!t || /^\+/.test(target)) return null;
  const out = { users: new Set(), invites: new Set(), instagram: new Set() };
  let chat;
  try {
    chat = await tgApi('getChat', { chat_id: '@' + t });
  } catch (_) {
    return null; // «chat not found» / личка не писала боту — не можем подтвердить/опровергнуть
  }
  if (!chat) return null;
  if (chat.type === 'channel' || chat.type === 'supergroup' || chat.type === 'group') {
    tgExtractFromText(chat.description || '', out, t);
    const members = chat.participant_count != null ? `${chat.participant_count} подписчиков` : '';
    return {
      ok: true,
      exists: true,
      isChannel: true,
      title: chat.title || t,
      members,
      desc: chat.description || '',
      postsRead: 0,
      viaApi: true,
      out,
    };
  }
  // type === 'private' -> это личный аккаунт, сам юз и есть личка.
  // (getChat отдаёт личку только если она писала боту, но раз отдал — значит существует)
  return { ok: true, exists: true, isChannel: false, title: [chat.first_name, chat.last_name].filter(Boolean).join(' ') || t, viaApi: true, out };
}

// Быстрая классификация ссылки через Bot API: 'personal' | 'channel' | null.
async function tgClassify(target) {
  const r = await tgApiCheck(target);
  if (!r || !r.ok) return null;
  return r.isChannel ? 'channel' : 'personal';
}

// ---------- режим "сайт": t.me превью + публичные посты /s/ ----------
// Скан идёт fetch'ем ИЗНУТРИ фоновой вкладки, которая припаркована на главной t.me:
//  - трафик идёт через браузерный стек (через браузерные VPN/прокси), а не из SW;
//  - страницы НЕ открываются на виду — нет навигации, нет автозапуска приложения ТГ (tg://).
// Вкладка сворачивается в скрытую группу, чтобы не мозолить глаза.
const TG_SCAN_TAB_KEY = 'igx_tg_scan_tab';

// Ждём, пока DOM вкладки станет читаемым. ВАЖНО: не ждём tab.status==='complete' —
// Хром троттлит фоновые вкладки, и 'complete' может не наступать долго.
// executeScript работает уже на 'interactive', поэтому проверяем readyState напрямую.
// expectedPath — путь НОВОЙ страницы: иначе первый полл вернёт DOM предыдущей.
async function tgTabDomReady(tabId, timeoutMs, expectedPath) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 15000)) {
    await tgSleep(250);
    let st = null;
    try {
      const res = await chrome.scripting.executeScript({
        tabId,
        func: () => ({ rs: document.readyState, path: location.pathname }),
      });
      st = res && res[0] ? res[0].result : null;
    } catch (_) {}
    if (st && st.rs !== 'loading' && (!expectedPath || st.path === expectedPath)) return true;
  }
  return false;
}

async function tgWaitScanTabLoaded(tabId) {
  return tgTabDomReady(tabId, 9000, '/');
}

async function tgGetScanTab() {
  const data = await chrome.storage.session.get(TG_SCAN_TAB_KEY);
  const info = data[TG_SCAN_TAB_KEY];
  if (info) {
    try {
      const t = await chrome.tabs.get(info.id);
      // Вкладка жива — переиспользуем её, НИКОГДА не плодим вторую.
      if (t.discarded) {
        // уснула (экономия памяти) — будим на месте
        await chrome.tabs.reload(info.id).catch(() => {});
        await tgWaitScanTabLoaded(info.id);
      } else if (!/^https:\/\/t\.me\//.test(t.url || '')) {
        // ушла с t.me (страница ошибки сети и т.п.) — возвращаем на место на месте же
        await chrome.tabs.update(info.id, { url: 'https://t.me/' }).catch(() => {});
        await tgWaitScanTabLoaded(info.id);
      }
      return info.id;
    } catch (_) {}
  }
  // Вкладки совсем нет — создаём единственную.
  const tab = await chrome.tabs.create({ url: 'https://t.me/', active: false });
  try {
    const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
    await chrome.tabGroups.update(groupId, { collapsed: true, title: 'IGX скан' });
  } catch (_) {}
  await tgWaitScanTabLoaded(tab.id);
  await chrome.storage.session.set({ [TG_SCAN_TAB_KEY]: { id: tab.id } });
  return tab.id;
}

// Навигация вкладки скана на страницу и ожидание читаемого DOM (таймаут 15с).
async function tgNavigateScanTab(tabId, url, timeoutMs) {
  const path = '/' + String(url).replace(/^https?:\/\/t\.me\//i, '').split('?')[0];
  await chrome.tabs.update(tabId, { url });
  return tgTabDomReady(tabId, timeoutMs || 15000, path);
}

// Читает ЖИВОЙ DOM страницы t.me/s/: шапка канала (имя/счётчик/описание) + посты.
// Страницы /s/ не дёргают tg:// — приложение ТГ во время скана не открывается.
// У личного аккаунта шапки канала нет — по этому и отличаем личку от канала.
function tgTabScanFn(limit) {
  const q = (sel) => document.querySelector(sel);
  const info = q('.tgme_channel_info');
  const titleEl = q('.tgme_channel_info_header_title');
  const counters = Array.from(document.querySelectorAll('.tgme_channel_info_counter'))
    .map((e) => e.textContent)
    .join(' ')
    .trim();
  const descEl = q('.tgme_channel_info_description');
  const posts = [];
  for (const el of document.querySelectorAll('.tgme_widget_message_text')) {
    posts.push(el.textContent);
    if (posts.length >= limit) break;
  }
  const ids = Array.from(document.querySelectorAll('.tgme_widget_message')).map((el) => el.getAttribute('data-post'));
  return {
    isChannel: !!info,
    title: titleEl ? titleEl.textContent.trim() : '',
    members: counters,
    desc: descEl ? descEl.textContent : '',
    posts,
    oldest: ids.length ? ids[ids.length - 1] : null,
  };
}

async function tgExtractScanTab(tabId, limit) {
  const res = await chrome.scripting.executeScript({
    tabId,
    func: tgTabScanFn,
    args: [limit || 50],
  });
  return res && res[0] ? res[0].result : null;
}

// quick=true — только первая страница (классификация канал/личка + описание).
async function tgScanSite(target, settings, quick) {
  const out = { users: new Set(), invites: new Set(), instagram: new Set() };
  const isInvite = /^\+/.test(target);
  const name = isInvite ? '' : target.toLowerCase();

  if (isInvite) {
    // Инвайт-ссылки без аккаунта не просматриваются
    return { ok: true, exists: null, privateOnly: true, out };
  }

  let tabId;
  try {
    tabId = await tgGetScanTab();
  } catch (_) {
    return { ok: false, error: 'Не удалось открыть вкладку для скана.' };
  }

  // Лента t.me/s/<name>: шапка канала + посты. Не дёргает tg://.
  let meta = null;
  let before = '';
  let collected = 0;
  let pages = 0;
  const maxPages = quick ? 1 : 6;
  while (pages < maxPages && collected < settings.msgLimit) {
    if (!(await tgNavigateScanTab(tabId, `https://t.me/s/${target}${before}`))) {
      if (pages === 0) return { ok: false, error: 't.me/s не открылся в браузере (сеть/блокировка/таймаут). Проверь, открывается ли сайт вручную.' };
      break;
    }
    let d = null;
    try {
      d = await tgExtractScanTab(tabId, settings.msgLimit - collected + 30);
    } catch (_) {}
    if (!d) {
      if (pages === 0) return { ok: false, error: 'Страница t.me/s открылась, но DOM не читается.' };
      break;
    }
    if (pages === 0) meta = d;
    if (!d.posts.length) break;
    for (const txt of d.posts) {
      if (collected >= settings.msgLimit) break;
      collected++;
      tgExtractFromText(txt, out, name);
    }
    pages++;
    if (!d.oldest || collected >= settings.msgLimit) break;
    before = `?before=${String(d.oldest).split('/').pop()}`;
    await tgSleep(400 + Math.random() * 500); // щадящие паузы между страницами
  }
  if (!meta) return { ok: false, error: 't.me/s не открылся (сеть/блокировка). Проверь вручную.' };

  if (meta.title) tgExtractFromText('@' + meta.title, out, name);
  tgExtractFromText(meta.desc, out, name);
  tgExtractFromText(meta.members, out, name);

  return {
    ok: true,
    // У личного аккаунта на /s/ шапки канала нет — существование не подтверждаем (null).
    exists: meta.isChannel || collected > 0 ? true : null,
    // Канал или ЛИЧКА: у каналов на /s/ есть шапка с именем и счётчиком, у лички — пусто.
    isChannel: meta.isChannel || collected > 0,
    title: meta.title || target,
    members: meta.members,
    postsRead: collected,
    out,
  };
}

// ---------- режим "тг": сканирование через web.telegram.org ----------
async function tgGetWebTab() {
  const data = await chrome.storage.session.get(TG_TAB_KEY);
  const info = data[TG_TAB_KEY];
  if (info && Date.now() - info.ts < 15 * 60 * 1000) {
    try {
      await chrome.tabs.get(info.id);
      return info.id;
    } catch (_) {}
  }
  const tab = await chrome.tabs.create({ url: 'https://web.telegram.org/a/', active: false });
  await chrome.storage.session.set({ [TG_TAB_KEY]: { id: tab.id, ts: Date.now() } });
  return tab.id;
}

async function tgScanFull(target, settings, onProgress) {
  const tabId = await tgGetWebTab();
  const send = (m) => chrome.tabs.sendMessage(tabId, m).catch(() => null);

  // Даем вкладке прогрузиться / залогиниться (не дольше 20 сек — бот не должен молчать)
  let ready = false;
  for (let i = 0; i < 20; i++) {
    await tgSleep(1000);
    const r = await send({ type: 'tgPing' });
    if (r && r.ready) { ready = true; break; }
    if (r && r.needsLogin) return { ok: false, error: 'web.telegram.org не залогинен. Открой вкладку, войди в аккаунт и повтори.' };
  }
  if (!ready) return { ok: false, error: 'web.telegram.org не отвечает. Перезагрузи вкладку с телеграмом.' };

  if (onProgress) onProgress('Открываю чат…');
  await send({ type: 'tgScan', target, msgLimit: settings.msgLimit, delayMs: settings.delaySec * 1000 });

  for (let i = 0; i < 90; i++) {
    await tgSleep(1000);
    const r = await send({ type: 'tgGetResult' });
    if (!r) return { ok: false, error: 'Вкладка телеграма закрылась во время сканирования.' };
    if (r.progress && onProgress) onProgress(r.progress);
    if (r.done) {
      if (r.error) return { ok: false, error: r.error };
      const out = { users: new Set(r.users || []), invites: new Set(r.invites || []), instagram: new Set(r.instagram || []) };
      return { ok: true, exists: true, title: r.title || target, postsRead: r.postsRead || 0, out };
    }
  }
  return { ok: false, error: 'Таймаут сканирования в web.telegram.org.' };
}

// ---------- верификация юза (быстрая, для значков) ----------
async function tgVerify(username) {
  // ТОЛЬКО через Bot API (api.telegram.org) — никаких вкладок и никакого t.me.
  // Верификация срабатывает на КАЖДОМ открытом профиле; раньше она ходила в t.me,
  // и у личек /s/ редиректил на превью-страницу, которая дёргала tg:// и открывала приложение.
  try {
    const r = await tgApiCheck(username);
    if (r && r.ok) return { exists: true };
  } catch (_) {}
  return { exists: null }; // без браузера подтвердить не смогли — статус не ломаем
}

function tgTargetFromUrl(url) {
  const s = String(url || '').trim();
  const m = s.match(/(?:t\.me|telegram\.me)\/(\+?[A-Za-z0-9_]{3,64})/i);
  if (m) return m[1].startsWith('+') ? m[1] : m[1].toLowerCase();
  if (/^\+?[A-Za-z0-9_]{3,64}$/.test(s)) return s.toLowerCase();
  return null;
}

// Проверяет найденные юзы на существование (несуществующие не кидаем).
// Сначала дешёвый Bot API (лишние запросы к браузеру не делаем), потом сайт.
// Если верификация вообще не удалась (сеть/лимиты) — возвращаем как нашли, чтобы не терять лиды.
async function tgVerifyUsers(users, maxCount) {
  const list = users.slice(0, maxCount || 8);
  const confirmed = [];
  const rest = [];
  for (const u of list) {
    try {
      const r = await tgApiCheck(u);
      if (r && r.ok) {
        confirmed.push(u);
        continue;
      }
    } catch (_) {}
    rest.push(u);
  }
  const unknown = [];
  for (const u of rest) {
    try {
      const v = await tgVerify(u);
      if (v.exists === true) confirmed.push(u);
      else unknown.push(u);
    } catch (_) {
      unknown.push(u);
    }
    await tgSleep(200);
  }
  return confirmed.length ? confirmed : unknown;
}

// ---------- отчёт ----------
async function tgCheckTarget(target, mode, opts) {
  opts = opts || {};
  const s = await getTgSettings();
  const useMode = mode || s.mode;
  let r;
  if (useMode === 'tg') {
    r = await tgScanFull(target, s, opts.onProgress);
    if (!r.ok && opts.fallbackToSite !== false) {
      // Фоллбэк: если веб-телеграм не справился — пробуем сайтом
      r = await tgScanSite(target, s);
      if (r.ok && r.privateOnly) {
        return { ok: false, error: 'Приватная ссылка — без залогиненного web.telegram.org (режим ТГ) не прочитать.' };
      }
      if (!r.ok) {
        // И браузер не смог — последний шанс: Bot API (api.telegram.org).
        const api = await tgApiCheck(target);
        if (api) return Object.assign({ mode: useMode }, api);
      }
    }
  } else {
    r = await tgScanSite(target, s);
    // t.me не открылся в браузере (блокировка/сеть) — идём через Bot API: это надёжно.
    if (!r.ok) {
      const api = await tgApiCheck(target);
      if (api) return Object.assign({ mode: useMode }, api);
      return r;
    }
    if (r.privateOnly) {
      return { ok: false, error: 'Приватная ссылка (+...) — сайтом не читается. Переключи режим на ТГ (/mode в боте).' };
    }
  }
  if (!r.ok) return r;
  if (r.exists === false) {
    return { ok: false, error: `@${target} — не существует (t.me не подтверждает).` };
  }
  return Object.assign({ mode: useMode }, r);
}

function tgBuildReport(target, r, instaUrl, igFollowers) {
  const users = Array.from(r.out.users);
  const invites = Array.from(r.out.invites);
  const contacts = users.map((u) => '@' + u).concat(invites.map((i) => `t.me/${i}`));
  const ig = instaUrl || Array.from(r.out.instagram)[0];

  const lines = [];
  if (r.exists === null) {
    lines.push(`@${String(target).replace(/^@/, '')} — TG найден (статус не подтверждён)`);
  } else {
    lines.push(`@${String(target).replace(/^@/, '')} — TG подтверждён`);
  }
  // Подписчики — сразу под ссылкой: только ИГ (счётчик ТГ в отчёте не нужен).
  const f = Number(igFollowers);
  if (isFinite(f) && f > 0) lines.push(`Подписчиков в ИГ: ${f.toLocaleString('ru-RU')}`);
  if (contacts.length) {
    lines.push(`Найдено контактов: ${contacts.length}`);
    lines.push(...contacts);
  } else {
    lines.push('Найдено контактов: 0');
  }
  if (ig) lines.push('', `Инста: https://instagram.com/${ig}`);
  return lines.join('\n');
}

async function tgSendReport(target, r, instaUrl, force, igFollowers) {
  const s = await getTgSettings();
  if (!s.chatId) return false;

  const contacts = Array.from(r.out.users).concat(Array.from(r.out.invites)).sort().join(',');
  const key = String(target).toLowerCase();
  if (!force) {
    const data = await chrome.storage.local.get(TG_REPORTED_KEY);
    const reported = data[TG_REPORTED_KEY] || {};
    const prev = reported[key];
    if (prev && prev.contacts === contacts && Date.now() - prev.ts < 7 * 24 * 3600 * 1000) {
      return false; // уже отчитывались с тем же набором контактов за неделю
    }
    reported[key] = { contacts, ts: Date.now() };
    // подчистка старых записей
    for (const k of Object.keys(reported)) {
      if (Date.now() - reported[k].ts > 30 * 24 * 3600 * 1000) delete reported[k];
    }
    await chrome.storage.local.set({ [TG_REPORTED_KEY]: reported });
  }

  await tgSay(s.chatId, tgBuildReport(target, r, instaUrl, igFollowers));
  return true;
}

// ---------- очередь бот-проверок (кинули ссылку в бота) ----------
let tgBotQueue = [];
let tgBotBusy = false;

async function tgQueueBotCheck(target, chatId) {
  tgBotQueue.push({ target, chatId });
  if (tgBotBusy) return;
  tgBotBusy = true;
  while (tgBotQueue.length) {
    const item = tgBotQueue.shift();
    const s = await getTgSettings();
    // Страховка: один таргет не может висеть дольше 50 секунд — ответ придёт всегда.
    const timeout = new Promise((res) => setTimeout(() => res({ ok: false, error: 'таймаут 50с — не успел проверить' }), 50000));
    try {
      const r = await Promise.race([tgCheckTarget(item.target, s.mode, {}), timeout]);
      if (!r.ok) {
        await tgSay(item.chatId, `${item.target}: ${r.error}`);
      } else {
        await tgSendReport(item.target, r, null, true);
      }
    } catch (e) {
      await tgSay(item.chatId, `${item.target}: ошибка (${e.message || e})`);
    }
    if (tgBotQueue.length) await tgSleep(Math.min(5000, s.delaySec * 1000));
  }
  tgBotBusy = false;
}

// ---------- поллинг бота (команды и ссылки) ----------
function tgModeKeyboard(mode) {
  return {
    inline_keyboard: [[
      { text: mode === 'site' ? '✅ 🌐 Сайт (быстрый)' : '🌐 Сайт (быстрый)', callback_data: 'mode:site' },
      { text: mode === 'tg' ? '✅ 📱 ТГ (точный)' : '📱 ТГ (точный)', callback_data: 'mode:tg' },
    ]],
  };
}

function tgHelpText() {
  return [
    'IG Lead Scout бот. Команды:',
    '/mode — режим проверки (сайт/тг)',
    '/st [сообщений] [задержка сек] — настройки скана',
    'Просто кинь ссылку t.me/... — проверю и пришлю отчёт.',
    '',
    'Проверки выполняются расширением в браузере — он должен быть открыт.',
  ].join('\n');
}

async function tgProcessBotUpdate(u) {
  if (u.callback_query) {
    const cb = u.callback_query;
    try { await tgApi('answerCallbackQuery', { callback_query_id: cb.id }); } catch (_) {}
    const m = String(cb.data || '');
    if (m.startsWith('mode:')) {
      const mode = m.slice(5) === 'tg' ? 'tg' : 'site';
      await saveTgSettings({ mode });
      const chatId = cb.message && cb.message.chat ? cb.message.chat.id : null;
      if (chatId) {
        try {
          await tgApi('editMessageText', {
            chat_id: chatId,
            message_id: cb.message.message_id,
            text: `Режим проверки: ${mode === 'site' ? '🌐 Сайт (быстрый, без риска бана)' : '📱 ТГ (точный, через web.telegram.org)'}`,
            reply_markup: tgModeKeyboard(mode),
          });
        } catch (_) {}
      }
    }
    return;
  }

  const msg = u.message;
  if (!msg || msg.text == null) return;
  const chatId = msg.chat.id;
  const text = msg.text;

  // Запоминаем последний чат, писавший боту — для кнопки «Привязать мой ТГ»
  await chrome.storage.local.set({ igx_tg_lastchat: chatId });

  // Регистрация чата
  const s = await getTgSettings();
  if (!s.chatId) await saveTgSettings({ chatId });

  if (/^\/start/.test(text)) {
    await tgSay(chatId, 'Готов. ' + tgHelpText());
    return;
  }
  if (/^\/help/.test(text)) {
    await tgSay(chatId, tgHelpText());
    return;
  }
  if (/^\/mode/.test(text)) {
    const cur = await getTgSettings();
    await tgSay(chatId, `Режим проверки: ${cur.mode === 'site' ? '🌐 Сайт' : '📱 ТГ'}. Выбери:`, { reply_markup: tgModeKeyboard(cur.mode) });
    return;
  }
  if (/^\/st/.test(text)) {
    const parts = text.trim().split(/\s+/).slice(1);
    const cur = await getTgSettings();
    if (parts.length >= 1) {
      const patch = {};
      const lim = parseInt(parts[0], 10);
      if (lim > 0) patch.msgLimit = Math.min(200, lim);
      const del = parseFloat(parts[1]);
      if (del > 0) patch.delaySec = Math.min(300, del);
      patch.safeMode = false; // ручная настройка выключает авто-режим
      const next = await saveTgSettings(patch);
      await tgSay(chatId, `Настройки: читать ${next.msgLimit} сообщений, задержка ${next.delaySec} c. Безопасный режим выключен.`);
    } else {
      await tgSay(chatId, `Сейчас: читать ${cur.msgLimit} сообщений, задержка ${cur.delaySec} c, безопасный режим ${cur.safeMode ? 'вкл' : 'выкл'}.\nИспользование: /st 20 10`);
    }
    return;
  }

  // Ссылки t.me / telegram.me
  const links = [];
  for (const m of text.matchAll(/(?:t\.me|telegram\.me)\/(\+?[A-Za-z0-9_]{3,64})/gi)) {
    let t = m[1];
    if (!/^\+/.test(t)) {
      t = t.toLowerCase();
      if (TG_RESERVED_USERS.has(t)) continue;
    }
    if (!links.includes(t)) links.push(t);
  }
  if (links.length) {
    await tgSay(chatId, `Принял ${links.length}. Проверяю в режиме ${s.mode === 'site' ? '🌐 сайт' : '📱 тг'}…`);
    for (const t of links) tgQueueBotCheck(t, chatId);
    return;
  }

  await tgSay(chatId, 'Не понял. Кидай ссылку t.me/... или команду /help');
}

let tgPolling = false;
async function tgPollOnce() {
  if (tgPolling) return false;
  tgPolling = true;
  let got = 0;
  try {
    const s = await getTgSettings();
    if (!s.token) return false;
    const offData = await chrome.storage.local.get(TG_OFFSET_KEY);
    const offset = offData[TG_OFFSET_KEY] || 0;
    const updates = await tgApi('getUpdates', { offset, timeout: 20, allowed_updates: ['message', 'callback_query'] });
    got = updates.length;
    for (const u of updates) {
      try {
        await tgProcessBotUpdate(u);
      } catch (_) {}
      if (u.update_id + 1 > offset) {
        await chrome.storage.local.set({ [TG_OFFSET_KEY]: u.update_id + 1 });
      }
    }
  } catch (_) {
    // токен неверный / сеть — молча ждём следующего цикла
  } finally {
    tgPolling = false;
  }
  return got > 0;
}

// Непрерывный цикл поллинга: бот отвечает за 1–2 секунды, а не раз в 30.
// Аларм оставлен как страховка на случай, если воркер прибьют.
let tgPollLoopActive = false;
async function tgPollLoop() {
  if (tgPollLoopActive) return;
  tgPollLoopActive = true;
  try {
    while (true) {
      const s = await getTgSettings();
      if (!s.token) break;
      try {
        await tgPollOnce();
      } catch (_) {}
      await tgSleep(2000);
    }
  } finally {
    tgPollLoopActive = false;
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TG_POLL_ALARM) tgPollLoop();
});

function tgEnsureAlarm() {
  chrome.alarms.create(TG_POLL_ALARM, { periodInMinutes: 0.5 });
}
tgEnsureAlarm();
// Запускаем цикл сразу, не дожидаясь первого аларма
tgPollLoop();

// ---------- диагностика: пошагово показывает, где именно рвётся ----------
async function tgDiagnose() {
  const lines = [];
  const s = await getTgSettings();
  lines.push(`настройки: режим=${s.mode}, msgLimit=${s.msgLimit}, delay=${s.delaySec}с, chatId=${s.chatId || 'не привязан'}, токен=${s.token ? 'задан' : 'НЕТ'}`);
  lines.push('');

  // 1. Бот
  try {
    const me = await tgApi('getMe', {});
    lines.push(`[1] Бот: ОК (@${me.username})`);
  } catch (e) {
    lines.push(`[1] Бот: ОШИБКА — ${e.message || e} (токен/сеть до api.telegram.org)`);
  }

  // 2. Вкладка скана
  let tabId = null;
  try {
    tabId = await tgGetScanTab();
    const t = await chrome.tabs.get(tabId);
    lines.push(`[2] Вкладка скана: id=${tabId}, url=${t.url}, статус=${t.status}`);
  } catch (e) {
    lines.push(`[2] Вкладка скана: ОШИБКА — ${e.message || e}`);
  }

  // 3. Скан t.me/s из вкладки (тот же путь, что и обычный браузер)
  if (tabId != null) {
    try {
      const okNav = await tgNavigateScanTab(tabId, 'https://t.me/s/durov');
      if (!okNav) {
        const t2 = await chrome.tabs.get(tabId).catch(() => null);
        lines.push(`[3] вкладка НЕ смогла открыть t.me/s/durov (url=${t2 ? t2.url : '?'}, статус=${t2 ? t2.status : '?'}) — сеть/блокировка`);
      } else {
        const d = await tgExtractScanTab(tabId, 5);
        if (!d) lines.push('[3] страница открылась, но DOM не читается (executeScript)');
        else lines.push(`[3] t.me/s из вкладки: ОК — канал=${d.isChannel}, «${d.title}», постов: ${d.posts.length}`);
      }
    } catch (e) {
      lines.push(`[3] t.me/s из вкладки: ОШИБКА — ${e.message || e}`);
    }
  }

  // 4. Прямой fetch из воркера (для сравнения — так раньше и работало)
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch('https://t.me/durov', { credentials: 'omit', signal: ctrl.signal });
    clearTimeout(timer);
    lines.push(`[4] fetch напрямую из воркера: статус ${res.status}`);
  } catch (e) {
    lines.push(`[4] fetch напрямую из воркера: ОШИБКА — ${e.message || e} (скорее всего, не идёт через твой VPN)`);
  }

  return lines.join('\n');
}

// ---------- сообщения из content/popup для Telegram-блока ----------
async function handleTgMessage(msg, sendResponse) {
  if (msg.type === 'tgGetSettings') {
    sendResponse(await getTgSettings());
    return true;
  }
  if (msg.type === 'tgSaveSettings') {
    sendResponse(await saveTgSettings(msg.patch || {}));
    return true;
  }
  if (msg.type === 'tgVerify') {
    sendResponse(await tgVerify(msg.username));
    return true;
  }
  if (msg.type === 'tgOpenApp') {
    // Открыть чат/канал в приложении Телеграм на ПК (протокол tg://).
    (async () => {
      try {
        const ok = await tgOpenApp(msg.domain, true); // явный клик пользователя — открываем всегда
        sendResponse({ ok });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    })();
    return true;
  }
  if (msg.type === 'tgClassifyLinks') {
    // Для кнопок ссылок у авы: определяем тип каждой (личка/канал) через Bot API.
    (async () => {
      const result = {};
      for (const t of (msg.targets || []).slice(0, 8)) {
        try {
          result[t] = await tgClassify(t);
        } catch (_) {
          result[t] = null;
        }
      }
      sendResponse({ ok: true, result });
    })();
    return true;
  }
  if (msg.type === 'tgDiagnose') {
    (async () => {
      try {
        sendResponse({ ok: true, report: await tgDiagnose() });
      } catch (e) {
        sendResponse({ ok: false, report: `Диагностика упала: ${e.message || e}` });
      }
    })();
    return true;
  }
  if (msg.type === 'tgCheck') {
    // Полная проверка с прогрессом (клик по галочке в списке)
    try {
      const r = await tgCheckTarget(msg.target, msg.mode || null, {});
      if (r.ok) {
        await tgSendReport(msg.target, r, msg.instaUrl || null, true);
        sendResponse({ ok: true, sent: true });
      } else {
        sendResponse({ ok: false, error: r.error });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
    return true;
  }
  if (msg.type === 'tgReportLead') {
    // Автоотчёт при обнаружении лида из Instagram.
    // Кидаем юз КАЖДОГО, у кого нашлась TG-ссылка: даже если скан не смог подтвердить
    // существование (личка/приват/сеть), лид не должен теряться.
    try {
      const s = await getTgSettings();
      if (s.autoReport && s.chatId && msg.username && msg.telegram) {
        // ГЛАВНЫЙ фильтр по сабам: порог хранится в storage, поэтому режем здесь,
        // в воркере — фоновые вкладки автопроверки свой фильтр не видят (у них он всегда 0).
        const minData = await chrome.storage.local.get('igx_min_followers');
        const minF = parseInt(minData.igx_min_followers, 10) || 0;
        if (minF > 0 && msg.followers != null && msg.followers < minF) {
          sendResponse({ ok: true }); // не прошёл порог — в бота не кидаем
          return true;
        }
        const tgUser = msg.telegram.replace(/^https?:\/\/(?:t\.me|telegram\.me)\//i, '').replace(/^\//, '');
        let r = null;
        try {
          // Автоотчёт ходит ТОЛЬКО через Bot API. Браузерный скан здесь запрещён:
          // он открывал t.me, и у личек редирект на превью дёргал tg:// — само открывалось приложение ТГ.
          r = await tgApiCheck(tgUser);
        } catch (_) {}
        if (r && r.ok && r.exists !== false) {
          await tgSendReport(tgUser, r, msg.username, false, msg.followers);
        } else {
          // Скан не подтвердил — кидаем сам найденный юз как контакт (с пометкой «не подтверждён»).
          const clean = String(tgUser).replace(/^@/, '').toLowerCase();
          const out = { users: new Set([clean]), invites: new Set(), instagram: new Set() };
          await tgSendReport(tgUser, { ok: true, exists: null, out }, msg.username, false, msg.followers);
        }
      }
      sendResponse({ ok: true });
    } catch (_) {
      sendResponse({ ok: false });
    }
    return true;
  }
  if (msg.type === 'tgDeepCheck') {
    // Глубокая проверка: ищем ЛИЧКУ внутри найденного Telegram.
    // Порядок внутри одного таргета: описание -> закрепы -> сообщения (по возможностям режима).
    // Сначала чекаем первую ссылку; если лички нет — идём по остальным TG-ссылкам аккаунта.
    (async () => {
      // Страховка: проверка не может висеть дольше 75 секунд.
      let finished = false;
      const failSafe = setTimeout(() => {
        if (!finished) {
          finished = true;
          sendResponse({ ok: false, error: 'Таймаут 75с — не успел (медленная сеть). Попробуй ещё раз.' });
        }
      }, 75000);
      const done = (payload) => {
        if (finished) return;
        finished = true;
        clearTimeout(failSafe);
        sendResponse(payload);
      };
      try {
        const s = await getTgSettings();
        const targets = [];
        const pushT = (url) => {
          const t = tgTargetFromUrl(url);
          if (t && !targets.includes(t)) targets.push(t);
        };
        pushT(msg.telegram);
        (msg.telegrams || []).forEach(pushT);
        if (!targets.length) {
          done({ ok: false, error: 'TG-ссылка не найдена.' });
          return;
        }

        // Сначала классифицируем ссылки: ЛИЧНЫЕ аккаунты чекаем раньше каналов.
        // Быстрый путь — Bot API (работает даже при блокировке t.me); браузер только если API молчит.
        const classified = [];
        for (const target of targets.slice(0, 4)) {
          let cls = null;
          try {
            cls = await tgApiCheck(target);
          } catch (_) {}
          if (!cls || !cls.ok) {
            try {
              cls = await tgScanSite(target, s, true);
            } catch (_) {}
          }
          classified.push({
            target,
            exists: cls && cls.ok ? cls.exists : null,
            isChannel: cls && cls.ok && !cls.privateOnly ? cls.isChannel : undefined,
            apiResult: cls && cls.ok && cls.viaApi ? cls : null,
          });
          await tgSleep(150);
        }
        const rank = (c) => (c.isChannel === false ? 0 : c.isChannel === undefined ? 1 : 2);
        classified.sort((a, b) => rank(a) - rank(b));

        let users = [];
        let scanned = 0;
        let personalHit = false; // личка = сам аккаунт, а не юз внутри канала
        const errors = []; // реальные причины по каждому таргету — чтобы не молчать «не найдено»
        for (const c of classified) {
          const target = c.target;
          if (c.exists === false) {
            errors.push(`@${target}: не существует (t.me не подтверждает).`);
            continue;
          }
          // Личный аккаунт — сам юз и есть личка, внутрь лезть не надо.
          if (c.isChannel === false && !/^\+/.test(target)) {
            users = [target];
            personalHit = true;
            scanned++;
            break;
          }
          let r;
          if (c.apiResult) {
            // Уже есть результат из Bot API — не лезем в браузер повторно.
            r = c.apiResult;
          } else {
            try {
              r = await tgCheckTarget(target, null, {});
            } catch (e) {
              r = { ok: false, error: String(e.message || e) };
            }
          }
          scanned++;
          if (!r.ok) errors.push(`@${target}: ${r.error || 'ошибка скана'}`);
          if (r.ok && r.out) {
            users = Array.from(r.out.users);
            if (users.length) break;
          }
          // Небольшая пауза между таргетами
          await tgSleep(600 + Math.random() * 600);
        }

        // Юзы считаем за личку, только если они реально существуют (макс 3 — ради скорости)
        const verified = await tgVerifyUsers(users, 3);

        // Записываем результат в профиль — в списке загорится золотым
        const key = `igx_profile:${String(msg.igUsername || '').toLowerCase()}`;
        const data = await chrome.storage.local.get(key);
        const profile = data[key] || {};
        profile.tgContacts = verified;
        profile.tgDeepCheckedAt = Date.now();
        await chrome.storage.local.set({ [key]: profile });

        // Отчёт в ТГ — только если реально что-то нашлось (подписчики ИГ — сразу под юзом)
        if (verified.length && s.chatId) {
          const f = Number(profile.followers);
          const lines = [
            `@${String(msg.igUsername || '').replace(/^@/, '')} — личка в TG найдена`,
            isFinite(f) && f > 0 ? `Подписчиков в ИГ: ${f.toLocaleString('ru-RU')}` : null,
            `Найдено контактов: ${verified.length}`,
            ...verified.map((c) => '@' + c),
            '',
            `Инста: https://instagram.com/${msg.igUsername}`,
          ].filter((l) => l !== null);
          await tgSay(s.chatId, lines.join('\n'));
        }

        // Открыть результат в приложении Телеграм (если пользователь не выключил автооткрытие):
        // нашли личку эксперта — открываем её; нашли юзов внутри канала — чат с ботом (отчёт там).
        const autoData = await chrome.storage.local.get('igx_auto_open_tg');
        const autoOpen = autoData.igx_auto_open_tg !== false; // по умолчанию включено
        let openedPersonal = false;
        let openedBot = false;
        if (autoOpen && verified.length) {
          if (personalHit) openedPersonal = await tgOpenApp(verified[0]);
          else openedBot = await tgOpenApp(await tgBotUsername());
        } else if (autoOpen && errors.length && !classified.some((c) => c.isChannel === true)) {
          // Совсем ничего не проверилось и ни одна ссылка не подтвердилась как канал —
          // лучше открыть первую ссылку в ТГ, чем молча сказать «не найдено».
          openedPersonal = await tgOpenApp(targets[0]);
        }

        done(
          verified.length
            ? { ok: true, contacts: verified, scanned, openedPersonal, openedBot }
            : {
                ok: false,
                contacts: [],
                scanned,
                openedPersonal,
                error: errors.length
                  ? errors.slice(0, 3).join('\n') +
                    (openedPersonal ? '\nОткрыл первую ссылку в ТГ — проверь глазами.' : '\nПодсказка: 1 клик по ⚡ сразу открывает ссылку в ТГ.')
                  : 'Проверил все ссылки — лички внутри не нашлось.',
              }
        );
      } catch (e) {
        done({ ok: false, error: String(e.message || e) });
      }
    })();
    return true;
  }
  if (msg.type === 'tgAfkReport') {
    // АФК-режим перечекан список — сводка в бота. Если перечекано больше одного списка —
    // ниже цитатой идёт разбивка: сколько профилей в каждом и ссылка на владельца списка.
    (async () => {
      try {
        const s = await getTgSettings();
        if (s.chatId) {
          const minF = msg.minFollowers || 0;
          const lines = [
            '🤖 АФК: список перечекан',
            `Длилось: ${msg.durationMin || 0} мин`,
            `Перечекано: ${msg.checked || 0}`,
            `Нашлось с TG: ${msg.foundTg || 0}`,
          ];
          if (minF > 0) lines.push(`Из них с сабами ≥ ${minF}: ${msg.foundFit || 0}`);
          let extra = null;
          const lists = Array.isArray(msg.lists) ? msg.lists.filter((l) => l && l.count > 0) : [];
          if (lists.length > 1) {
            const rows = lists
              .map((l, i) => `${i + 1}. ${l.count} — instagram.com/${String(l.owner || '').replace(/[^A-Za-z0-9._]/g, '')}`)
              .join('\n');
            lines.push('', 'Прочеканные списки:', `<blockquote>${rows}</blockquote>`);
            extra = { parse_mode: 'HTML' };
          }
          await tgSay(s.chatId, lines.join('\n'), extra);
        }
        sendResponse({ ok: true });
      } catch (_) {
        sendResponse({ ok: false });
      }
    })();
    return true;
  }
  if (msg.type === 'tgTest') {
    try {
      const me = await tgApi('getMe', {});
      const s = await getTgSettings();
      sendResponse({ ok: true, botName: me.username, chatId: s.chatId });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
    return true;
  }
  if (msg.type === 'tgBindChat') {
    // chat_id берём из последнего сообщения, которое бот видел при поллинге
    try {
      const data = await chrome.storage.local.get('igx_tg_lastchat');
      let chatId = data.igx_tg_lastchat || 0;
      if (!chatId) {
        const s = await getTgSettings();
        chatId = s.chatId;
      }
      sendResponse({ ok: !!chatId, chatId });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
    return true;
  }
  return false;
}
