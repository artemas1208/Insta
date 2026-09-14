// content.js — работает на страницах instagram.com

(function () {
  const RESERVED = new Set([
    'explore', 'reels', 'stories', 'direct', 'accounts', 'p', 'tv', 'about',
    'legal', 'developer', 'ads', 'api', 'challenge', 'emails', 'session',
    'push', 'web', 'nametag', 'topics', 'locations', 'directory', 'privacy',
    'terms', 'lite', 'graphql', 'oauth', 'create', 'settings',
  ]);

  const TG_RE = /(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{3,32})/i;

  function extractUsername(elOrPath) {
    if (!elOrPath) return null;
    let path = '';
    if (typeof elOrPath === 'string') {
      path = elOrPath;
    } else if (elOrPath.pathname) {
      path = elOrPath.pathname;
    } else if (elOrPath.getAttribute) {
      path = elOrPath.getAttribute('href') || '';
    }
    path = path.replace(/^https?:\/\/[^/]+/i, '');
    path = path.split('?')[0].split('#')[0];
    const m = path.match(/^\/([A-Za-z0-9._]{1,30})\/?$/);
    if (!m) return null;
    const u = m[1].toLowerCase();
    if (RESERVED.has(u)) return null;
    return m[1];
  }

  // ---------- storage: ключи ----------
  const PROFILE_PREFIX = 'igx_profile:';
  const VIEWED_PREFIX = 'igx_viewed:';
  const DONE_PREFIX = 'igx_done:' // эксперты, чьи списки подписок уже полностью прочеканы
  const profileKey = (u) => PROFILE_PREFIX + u.toLowerCase();
  const viewedKey = (u) => VIEWED_PREFIX + u.toLowerCase();
  const doneKey = (u) => DONE_PREFIX + u.toLowerCase();

  // Кэш профилей/просмотров в памяти. Раньше каждый проход фильтра ходил в
  // chrome.storage по 2 раза НА КАЖДУЮ строку списка — на больших списках это
  // подвешивало страницу (лагали кнопки и панель). Теперь читаем storage один
  // раз при старте и держим актуальным через storage.onChanged.
  const profileCache = new Map(); // username(lower) -> запись профиля или null
  const viewedCache = new Set(); // username(lower)
  const doneCache = new Set(); // username(lower) -> список эксперта прочекан
  (async () => {
    try {
      const all = await chrome.storage.local.get(null);
      for (const k of Object.keys(all)) {
        if (k.startsWith(PROFILE_PREFIX)) profileCache.set(k.slice(PROFILE_PREFIX.length), all[k]);
        else if (k.startsWith(VIEWED_PREFIX)) viewedCache.add(k.slice(VIEWED_PREFIX.length));
        else if (k.startsWith(DONE_PREFIX)) doneCache.add(k.slice(DONE_PREFIX.length));
      }
    } catch (_) {}
  })();

  async function getProfile(username) {
    const u = username.toLowerCase();
    if (profileCache.has(u)) return profileCache.get(u);
    const key = profileKey(u);
    const data = await chrome.storage.local.get(key);
    const rec = data[key] || null;
    profileCache.set(u, rec);
    return rec;
  }
  async function saveProfile(record) {
    profileCache.set(record.username.toLowerCase(), record);
    await chrome.storage.local.set({
      [profileKey(record.username)]: record,
    });
  }
  async function isViewed(username) {
    const u = username.toLowerCase();
    if (viewedCache.has(u)) return true;
    const key = viewedKey(u);
    const data = await chrome.storage.local.get(key);
    const v = !!data[key];
    if (v) viewedCache.add(u);
    return v;
  }
  async function markViewed(username) {
    viewedCache.add(username.toLowerCase());
    await chrome.storage.local.set({ [viewedKey(username)]: Date.now() });
  }

  // Эксперт «выжат»: его список подписок/подписчиков прочекан целиком (или 5+ человек).
  function isDone(username) {
    return doneCache.has(username.toLowerCase());
  }
  async function markDone(username, count) {
    const u = username.toLowerCase();
    doneCache.add(u);
    try {
      await chrome.storage.local.set({ [doneKey(u)]: { count: count || 0, checkedAt: Date.now() } });
    } catch (_) {}
  }

  function igxSend(msg, timeoutMs = 10000) {
    return Promise.race([
      chrome.runtime.sendMessage(msg),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
  }

  function getSettings() {
    return igxSend({ type: 'getSettings' }, 5000).catch(() => ({
      openMode: 'splitscreen',
      throttleMs: 4000,
    }));
  }

  // Кэш настроек: обработчику клика режим открытия нужен СИНХРОННО — раньше
  // он сначала глотал клик (preventDefault) и только потом узнавал режим,
  // из-за чего при «в этой же вкладке» профиль вообще не открывался.
  let cachedSettings = { openMode: 'newtab', throttleMs: 4000 };
  getSettings()
    .then((s) => {
      cachedSettings = s;
    })
    .catch(() => {});

  // ---------- парсинг чисел и ссылок ----------
  function parseCount(raw) {
    if (!raw) return null;
    let s = raw.trim().toLowerCase().replace(/\s/g, '').replace(',', '.');
    let mult = 1;
    if (/тыс\.?|k/i.test(s)) {
      mult = 1e3;
      s = s.replace(/тыс\.?|k/gi, '');
    } else if (/млн|m/i.test(s)) {
      mult = 1e6;
      s = s.replace(/млн|m/gi, '');
    }
    s = s.replace(/[^0-9.]/g, '');
    const num = parseFloat(s);
    return isNaN(num) ? null : Math.round(num * mult);
  }

  function findTelegram(container) {
    if (!container) return null;
    const links = container.querySelectorAll('a[href]');
    for (const a of links) {
      let rawHref = a.href;
      try {
        rawHref = decodeURIComponent(a.href);
      } catch (_) {}
      const m = rawHref.match(TG_RE);
      if (m) return `https://t.me/${m[1]}`;

      const mText = a.textContent.match(TG_RE);
      if (mText) return `https://t.me/${mText[1]}`;
    }

    // Берём только ВИДИМЫЙ текст (innerText), чтобы не матчить служебный JSON
    // из <script>-тегов страницы Instagram — оттуда прилетали ложные срабатывания.
    let text = '';
    try {
      text = container.innerText || '';
    } catch (_) {}
    if (!text) text = container.textContent || '';

    const m = text.match(TG_RE);
    if (m) return `https://t.me/${m[1]}`;

    // Поиск формата "TG: @username" или "тг: username" в описании
    const mBio = text.match(/(?:tg|тг|telegram|телеграм|телега)[\s:—–-]+@?([A-Za-z0-9_]{3,32})/i);
    if (mBio) return `https://t.me/${mBio[1]}`;

    return null;
  }

  // Собирает ВСЕ Telegram-юзы из контейнера (на аккаунте может быть несколько ссылок,
  // включая ссылки вида t.me/user?text=... с готовым сообщением в личку).
  function collectTelegram(container, acc) {
    if (!container || !acc) return;
    const tgReG = new RegExp(TG_RE.source, 'gi');
    const bioReG = /(?:tg|тг|telegram|телеграм|телега)[\s:—–-]+@?([A-Za-z0-9_]{3,32})/gi;

    const links = container.querySelectorAll('a[href]');
    for (const a of links) {
      let rawHref = a.href;
      try {
        rawHref = decodeURIComponent(a.href);
      } catch (_) {}
      for (const m of rawHref.matchAll(tgReG)) acc.add(m[1].toLowerCase());
      for (const m of (a.textContent || '').matchAll(tgReG)) acc.add(m[1].toLowerCase());
    }

    let text = '';
    try {
      text = container.innerText || '';
    } catch (_) {}
    if (!text) text = container.textContent || '';
    for (const m of text.matchAll(tgReG)) acc.add(m[1].toLowerCase());
    for (const m of text.matchAll(bioReG)) acc.add(m[1].toLowerCase());
  }

  function extractFollowersFromHeader() {
    const candidates = Array.from(
      document.querySelectorAll('header li, header span, header div, header a, main li, main span, main a')
    ).filter((el) => /(?:подписч|follower)/i.test(el.textContent || ''));
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.textContent.length - b.textContent.length);
    const best = candidates[0];
    const numEl = best.querySelector('span[title]') || best.querySelector('span') || best;
    const raw = (numEl.getAttribute && numEl.getAttribute('title')) || numEl.textContent;
    return parseCount(raw);
  }

  // ---------- определение и извлечение данных со страницы профиля ----------
  let lastPath = null;
  function tryExtractProfile(username, attempt = 0, tgAttempt = 0) {
    const header = document.querySelector('header') || document.querySelector('main');
    const followers = header ? extractFollowersFromHeader() : null;

    if (followers === null && attempt < 24) {
      setTimeout(() => tryExtractProfile(username, attempt + 1, tgAttempt), 500);
      return;
    }

    // Собираем ВСЕ Telegram-ссылки (на аккаунте их может быть несколько):
    // header (био) -> main -> body (модалки «Ссылки»)
    const tgSet = new Set();
    if (header) collectTelegram(header, tgSet);
    collectTelegram(document.querySelector('main'), tgSet);
    collectTelegram(document.body, tgSet);
    const tgList = Array.from(tgSet).slice(0, 10);
    const telegram = tgList.length ? `https://t.me/${tgList[0]}` : null;
    const telegrams = tgList.map((t) => `https://t.me/${t}`);

    const fullNameEl = header ? header.querySelector('h1, h2') : null;
    const fullName = fullNameEl ? fullNameEl.textContent.trim() : '';

    // Если telegram не найден на первых попытках — пробуем ещё раз (ссылки могут подгружаться позже).
    // Счётчик отдельный от ожидания подписчиков: раньше медленная загрузка шапки
    // съедала все попытки, и профиль сохранялся без TG (ложное «Telegram не найден»).
    if (!telegram && tgAttempt < 16) {
      setTimeout(() => tryExtractProfile(username, attempt, tgAttempt + 1), 500);
      return;
    }

    saveProfile({ username, fullName, followers, telegram, telegrams, checkedAt: Date.now() }).then(async () => {
      if (telegram) {
        // Верификация найденного TG-юза + автоотчёт ботом (если включён).
        // Важно дождаться ДО checkDone, иначе фоновая вкладка закроется раньше времени.
        const tgUser = telegram.replace(/^https?:\/\/(?:t\.me|telegram\.me)\//i, '').replace(/^\//, '');
        try {
          const r = await igxSend({ type: 'tgVerify', username: tgUser }, 20000);
          const exists = r && typeof r.exists === 'boolean' ? r.exists : null;
          if (exists !== null) {
            await saveProfile({ username, fullName, followers, telegram, telegrams, tgExists: exists, checkedAt: Date.now() });
          }
        } catch (_) {}
        // Отчёт в бота — только если эксперт проходит фильтр по подписчикам.
        // Порог читаем из storage: фоновые вкладки автопроверки не видят filterState панели.
        const minData = await chrome.storage.local.get('igx_min_followers');
        const minF = parseInt(minData.igx_min_followers, 10) || 0;
        const meetsFilter = minF <= 0 || (followers != null && followers >= minF);
        if (meetsFilter) {
          try {
            await igxSend({ type: 'tgReportLead', username, telegram, followers }, 20000);
          } catch (_) {}
        }
      }
      try {
        await igxSend({ type: 'checkDone', username }, 5000);
      } catch (_) {}
    });
  }

  function handleRouteChange() {
    const path = location.pathname;
    if (path === lastPath) return;
    lastPath = path;
    const username = extractUsername(path);
    if (username) {
      // В фоновых вкладках автопроверки НЕ помечаем профиль просмотренным —
      // иначе каждый автопроверенный аккаунт считается «посещённым вручную».
      isQuickCheckTab().then((qc) => {
        if (!qc) markViewed(username);
      });
      tryExtractProfile(username);
    }
  }

  let quickCheckTabFlag = null;
  function isQuickCheckTab() {
    if (quickCheckTabFlag !== null) return Promise.resolve(quickCheckTabFlag);
    return chrome.runtime
      .sendMessage({ type: 'isQuickCheck' })
      .then((r) => (quickCheckTabFlag = !!(r && r.isQuickCheck)))
      .catch(() => (quickCheckTabFlag = false));
  }

  (function watchRoute() {
    const _push = history.pushState;
    const _replace = history.replaceState;
    history.pushState = function (...args) { _push.apply(this, args); handleRouteChange(); };
    history.replaceState = function (...args) { _replace.apply(this, args); handleRouteChange(); };
    window.addEventListener('popstate', handleRouteChange);
    setInterval(handleRouteChange, 800);
    handleRouteChange();
  })();

  // ---------- глобальный плавающий тултип ----------
  let globalTooltip = null;
  function getTooltipEl() {
    if (!globalTooltip) {
      globalTooltip = document.createElement('div');
      globalTooltip.className = 'igx-tooltip';
      document.body.appendChild(globalTooltip);
    }
    return globalTooltip;
  }

  function showTooltip(html, targetEl) {
    const tip = getTooltipEl();
    tip.innerHTML = html;
    tip.style.display = 'block';

    const rect = targetEl.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();

    let top = rect.top - tipRect.height - 8;
    let left = rect.left;

    if (top < 10) {
      top = rect.bottom + 8;
    }
    if (left + tipRect.width > window.innerWidth - 12) {
      left = window.innerWidth - tipRect.width - 12;
    }
    if (left < 12) {
      left = 12;
    }

    tip.style.top = `${Math.round(top)}px`;
    tip.style.left = `${Math.round(left)}px`;
  }

  function hideTooltip() {
    if (globalTooltip) {
      globalTooltip.style.display = 'none';
    }
  }

  // ---------- поиск строки пользователя в списке / модалке ----------
  function findUserRow(el) {
    if (!el) return null;
    const li = el.closest('li, [role="listitem"]');
    if (li) return li;

    let curr = el;
    let bestRow = null;

    while (curr && curr !== document.body && !curr.matches('[role="dialog"], main, body, section')) {
      const hasImg = !!curr.querySelector('img');
      const hasLink = !!curr.querySelector('a[href]');
      const hasButton = !!curr.querySelector('button');

      if (hasImg && (hasLink || hasButton)) {
        bestRow = curr;
        if (curr.parentElement && curr.parentElement.children.length >= 2) {
          let imgCount = 0;
          const kids = curr.parentElement.children;
          for (let i = 0; i < Math.min(kids.length, 6); i++) {
            if (kids[i].querySelector('img')) imgCount++;
          }
          if (imgCount >= 2) {
            return curr;
          }
        }
      }
      curr = curr.parentElement;
    }
    return bestRow || el.closest('div') || el;
  }

  // ---------- отслеживание активных проверок ----------
  const pendingUsers = new Set();
  function isPending(username) {
    return pendingUsers.has(username.toLowerCase());
  }

  // ---------- обновление статуса кнопки и подсветки всей строки ----------
  async function refreshRowStatus(username, avatarBox, row) {
    const bolt = avatarBox.querySelector('.igx-bolt');
    if (!bolt) return;

    const p = await getProfile(username);
    const viewed = await isViewed(username);
    const done = isDone(username); // список этого эксперта уже прочекан -> красно-пурпурный
    const minF = filterState?.minFollowers || 0;

    // Очищаем предыдущие классы подсветки со строки и аватарки
    if (row) {
      row.classList.remove('igx-row-tg', 'igx-row-checked', 'igx-row-visited', 'igx-row-pending', 'igx-row-tg-pending', 'igx-row-gold', 'igx-row-done');
    }
    if (avatarBox) {
      avatarBox.classList.remove('igx-avatar-pending', 'igx-avatar-tg-pending', 'igx-avatar-gold', 'igx-avatar-done');
    }

    // Идёт глубокая проверка Telegram (поиск лички) — фиолетовый, другая иконка
    if (isTgPending(username)) {
      bolt.textContent = '🔍';
      bolt.title = 'Ищу личку в Telegram…';
      bolt.className = 'igx-bolt is-tg-pending';
      if (row) row.classList.add('igx-row-tg-pending');
      if (avatarBox) avatarBox.classList.add('igx-avatar-tg-pending');
      return;
    }

    if (isPending(username)) {
      bolt.textContent = '⏳';
      bolt.title = 'Проверяется в фоне...';
      bolt.className = 'igx-bolt is-pending';
      if (row) {
        row.classList.add('igx-row-pending');
      }
      if (avatarBox) avatarBox.classList.add('igx-avatar-pending');
      return;
    }

    // Личка в Telegram найдена глубокой проверкой -> ярко-золотой
    if (p && Array.isArray(p.tgContacts) && p.tgContacts.length) {
      bolt.textContent = '💰';
      bolt.title = `Личка найдена: ${p.tgContacts.map((c) => '@' + c).join(', ')}\nКлик — перепроверить Telegram`;
      bolt.className = 'igx-bolt is-gold';
      if (row) row.classList.add('igx-row-gold');
      if (avatarBox) avatarBox.classList.add('igx-avatar-gold');
      return;
    }

    if (p) {
      const hasTg = !!p.telegram;
      const meetsFollowers = minF <= 0 || (p.followers != null && p.followers >= minF);

      if (hasTg && meetsFollowers) {
        if (p.tgExists === false) {
          // Верификация показала, что юз не существует
          bolt.textContent = '⚠️';
          bolt.title = `TG @${p.telegram.replace(/^https?:\/\/(?:t\.me|telegram\.me)\//i, '')} не подтверждён (возможно, не существует)`;
          bolt.className = 'igx-bolt is-no-tg' + (done ? ' is-done' : '');
          if (row) {
            row.classList.add(done ? 'igx-row-done' : 'igx-row-checked');
          }
        } else if (p.tgExists === true) {
          // Подтверждённый TG -> галочка, повторный клик открывает меню проверок
          bolt.textContent = '✅';
          bolt.title = `TG подтверждён: ${p.telegram}\n(Подписчиков: ${p.followers != null ? p.followers.toLocaleString('ru-RU') : '—'})\nКлик — искать личку внутри Telegram`;
          bolt.className = 'igx-bolt is-tg is-verified';
          if (viewed) {
            if (row) row.classList.add('igx-row-visited');
          } else {
            if (row) row.classList.add('igx-row-tg');
          }
        } else {
          bolt.textContent = '✅';
          bolt.title = `TG: ${p.telegram} (Подписчиков: ${p.followers != null ? p.followers.toLocaleString('ru-RU') : '—'})`;
          bolt.className = 'igx-bolt is-tg';
          if (viewed) {
            // Профиль с TG уже просмотрен вами -> перекрашивается в СИНИЙ
            if (row) {
              row.classList.add('igx-row-visited');
            }
          } else {
            // Свежий непросмотренный лид с TG -> ЗЕЛЁНЫЙ
            if (row) {
              row.classList.add('igx-row-tg');
            }
          }
        }
      } else if (hasTg && !meetsFollowers) {
        // Есть TG, но подписчиков меньше минимального фильтра -> НЕ проходит, жёлтый
        bolt.textContent = '⚠️';
        bolt.title = `TG: ${p.telegram}, но не проходит по фильтру: подписчиков (${p.followers ?? '—'}) < ${minF}`;
        bolt.className = 'igx-bolt is-no-tg' + (done ? ' is-done' : '');
        if (row) {
          row.classList.add(done ? 'igx-row-done' : 'igx-row-checked');
        }
      } else {
        // Нет TG -> СИНИЙ (или красно-пурпурный, если эксперт уже «выжат»)
        bolt.textContent = '❌';
        bolt.title = 'Telegram не найден (нажмите для повторной проверки)';
        bolt.className = 'igx-bolt is-no-tg' + (done ? ' is-done' : '');
        if (row) {
          row.classList.add(done ? 'igx-row-done' : 'igx-row-checked');
        }
      }
      return;
    }

    if (viewed) {
      bolt.textContent = done ? '🏁' : '⚡';
      bolt.title = done
        ? 'Список этого эксперта уже прочекан (все или 5+ проверены) — внутрь больше можно не лезть'
        : 'Вы уже заходили сюда. Нажмите для быстрой проверки';
      bolt.className = 'igx-bolt' + (done ? ' is-done' : '');
      if (row) {
        row.classList.add(done ? 'igx-row-done' : 'igx-row-visited');
      }
      if (done && avatarBox) {
        avatarBox.classList.add('igx-avatar-done');
      }
      return;
    }

    // Не проверен
    bolt.textContent = '⚡';
    bolt.title = 'Быстро проверить наличие Telegram';
    bolt.className = 'igx-bolt';
  }

  function updateUIForUser(username) {
    const u = username.toLowerCase();
    document.querySelectorAll(`.igx-badge-wrap[data-igx-user="${u}"]`).forEach((wrap) => {
      const avatarBox = wrap.parentElement;
      if (!avatarBox) return;
      const row = findUserRow(wrap);
      refreshRowStatus(username, avatarBox, row);
    });
  }

  async function decorateElement(link) {
    const username = extractUsername(link);
    if (!username) return;

    // Кнопки ⚡ — только внутри модалок со списками (подписчики/подписки).
    // На страницах профилей, в сетке похожих аккаунтов и т.п. ничего не вешаем,
    // чтобы клики по странице не цепляли наши кнопки.
    if (!link.closest('[role="dialog"]')) return;

    const row = findUserRow(link);
    const img = link.querySelector('img') || (row ? row.querySelector('img') : null);
    if (!img) return;

    let avatarBox = img.closest('a, [role="button"], div[style*="width"], div[style*="height"]') || img.parentElement;
    if (avatarBox === img.parentElement && avatarBox.parentElement) {
      avatarBox = avatarBox.parentElement;
    }

    // Защита от дублирования значков внутри строки
    if (row && row.dataset.igxDecorated === username.toLowerCase()) {
      const existingWrap = avatarBox.querySelector('.igx-badge-wrap');
      if (existingWrap) refreshRowStatus(username, avatarBox, row);
      return;
    }

    if (avatarBox.querySelector('.igx-badge-wrap')) {
      const existingWrap = avatarBox.querySelector('.igx-badge-wrap');
      if (existingWrap) {
        if (row) row.dataset.igxDecorated = username.toLowerCase();
        refreshRowStatus(username, avatarBox, row);
        return;
      }
    }

    if (row) row.dataset.igxDecorated = username.toLowerCase();
    avatarBox.style.position = 'relative';
    avatarBox.style.overflow = 'visible';

    const wrap = document.createElement('span');
    wrap.className = 'igx-badge-wrap';
    wrap.dataset.igxUser = username.toLowerCase();

    const bolt = document.createElement('button');
    bolt.type = 'button';
    bolt.className = 'igx-bolt';
    bolt.title = 'Быстро проверить Telegram-ссылку';
    bolt.textContent = '⚡';

    wrap.appendChild(bolt);
    avatarBox.appendChild(wrap);

    const onEnter = async () => {
      const p = await getProfile(username);
      const viewed = await isViewed(username);
      let html;
      if (p) {
        html = `<b>@${username}</b><br>Подписчиков: ${p.followers != null ? p.followers.toLocaleString('ru-RU') : '—'}<br>TG: ${
          p.telegram ? p.telegram.replace('https://t.me/', '@') : 'не найден'
        }${p.tgContacts && p.tgContacts.length ? `<br>💰 Личка: ${p.tgContacts.map((c) => '@' + c).join(', ')}` : ''}${viewed ? '<br><i>(Вы уже просматривали этот профиль)</i>' : ''}`;
      } else if (viewed) {
        html = `<b>@${username}</b><br>Вы уже заходили, данные не извлечены`;
      } else {
        html = `<b>@${username}</b><br>Ещё не проверен (нажмите ⚡)`;
      }
      if (isDone(username)) html += '<br>🏁 Список этого эксперта уже прочекан';
      showTooltip(html, wrap);
    };

    wrap.addEventListener('mouseenter', onEnter);
    wrap.addEventListener('mouseleave', hideTooltip);
    link.addEventListener('mouseenter', onEnter);
    link.addEventListener('mouseleave', hideTooltip);

    bolt.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Если TG уже найден:
      //  1 клик  — открыть ссылку в Телеграме (если их несколько — показать кнопки);
      //  2 клика быстрее 0.5 сек — режим проверки (поиск лички внутри).
      const p = await getProfile(username);
      if (p && p.telegram) {
        const links = (Array.isArray(p.telegrams) && p.telegrams.length ? p.telegrams : [p.telegram]).filter(Boolean);
        if (bolt._dblTimer) {
          clearTimeout(bolt._dblTimer);
          bolt._dblTimer = null;
          hideLinkMenu();
          runTgDeepCheck(username, p, wrap);
          return;
        }
        bolt._dblTimer = setTimeout(() => {
          bolt._dblTimer = null;
          tgSingleClickAction(links, wrap);
        }, 480);
        return;
      }
      enqueueQuickCheck(username, `https://www.instagram.com/${username}/`);
    });

    refreshRowStatus(username, avatarBox, row);
  }

  // ---------- один клик по ⚡: открыть ссылку в ТГ или показать кнопки всех ссылок ----------
  function openTgDomain(url) {
    const domain = tgUserOf(url);
    if (!domain) return;
    chrome.runtime.sendMessage({ type: 'tgOpenApp', domain }).catch(() => {});
  }

  function tgSingleClickAction(links, anchorEl) {
    if (!links.length) return;
    // Клик по ⚡ — явное действие пользователя, открываем всегда (галочка автооткрытия на это не влияет).
    if (links.length === 1) {
      openTgDomain(links[0]);
      showTooltip(`Открываю в Телеграме: <b>@${tgUserOf(links[0])}</b>`, anchorEl);
      setTimeout(hideTooltip, 2500);
      return;
    }
    showTgLinkMenu(links, anchorEl);
  }

  let linkMenuEl = null;
  function onDocClickCloseMenu(e) {
    if (linkMenuEl && linkMenuEl.contains(e.target)) return;
    hideLinkMenu();
  }
  function hideLinkMenu() {
    if (linkMenuEl) {
      linkMenuEl.remove();
      linkMenuEl = null;
    }
    document.removeEventListener('mousedown', onDocClickCloseMenu, true);
  }

  // Меню с кнопками всех TG-ссылок аккаунта (левее авы). Каждая подпись — тип ссылки.
  async function showTgLinkMenu(links, anchorEl) {
    hideLinkMenu();
    linkMenuEl = document.createElement('div');
    linkMenuEl.className = 'igx-link-menu';
    const title = document.createElement('div');
    title.className = 'igx-link-menu-title';
    title.textContent = 'Ссылки Телеграм — клик откроет в ТГ';
    linkMenuEl.appendChild(title);

    // Определяем тип каждой ссылки (личка/канал) через Bot API
    const targets = links.map(tgUserOf).filter(Boolean);
    let types = {};
    try {
      const r = await chrome.runtime.sendMessage({ type: 'tgClassifyLinks', targets });
      if (r && r.ok) types = r.result || {};
    } catch (_) {}
    if (!linkMenuEl) return;

    links.forEach((url) => {
      const t = tgUserOf(url);
      const kind = types[t];
      const label = kind === 'personal' ? '👤 Личка' : kind === 'channel' ? '📢 Канал' : '❔ Неизвестно';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'igx-link-btn' + (kind === 'personal' ? ' is-personal' : kind === 'channel' ? ' is-channel' : '');
      btn.innerHTML = `<span class="igx-link-kind">${label}</span><span class="igx-link-url">@${t}</span>`;
      btn.title = `Открыть @${t} в приложении Телеграм`;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openTgDomain(url);
        hideLinkMenu();
      });
      linkMenuEl.appendChild(btn);
    });

    document.body.appendChild(linkMenuEl);
    // Позиция — левее авы; если не влезает — правее.
    const rect = anchorEl.getBoundingClientRect();
    const mr = linkMenuEl.getBoundingClientRect();
    let left = rect.left - mr.width - 12;
    if (left < 8) left = rect.right + 12;
    const top = Math.min(Math.max(8, rect.top - mr.height / 2), Math.max(8, window.innerHeight - mr.height - 8));
    linkMenuEl.style.left = `${Math.round(left)}px`;
    linkMenuEl.style.top = `${Math.round(top)}px`;

    setTimeout(() => {
      document.addEventListener('mousedown', onDocClickCloseMenu, true);
    }, 0);
  }

  // ---------- повторная проверка: поиск лички внутри найденного Telegram ----------
  const pendingTgUsers = new Set();
  function isTgPending(username) {
    return pendingTgUsers.has(username.toLowerCase());
  }

  function tgUserOf(url) {
    return String(url || '')
      .replace(/^https?:\/\/(?:t\.me|telegram\.me)\//i, '')
      .replace(/^\//, '');
  }

  async function runTgDeepCheck(username, profile, anchorEl) {
    const u = username.toLowerCase();
    if (pendingTgUsers.has(u)) return;
    pendingTgUsers.add(u);
    updateUIForUser(username);
    const target = tgUserOf(profile.telegram);
    showTooltip(`🔍 Ищу личку в Telegram <b>@${target}</b>…<br>Порядок: описание → закрепы → сообщения.<br>Отчёт придёт в Telegram.`, anchorEl);
    try {
      const r = await chrome.runtime.sendMessage({
        type: 'tgDeepCheck',
        igUsername: username,
        telegram: profile.telegram,
        telegrams: profile.telegrams || [],
      });
      if (r && r.ok && r.contacts && r.contacts.length) {
        const openedNote = r.openedPersonal ? '<br>Открыл личку в приложении ТГ.' : r.openedBot ? '<br>Открыл чат с ботом в ТГ (отчёт там).' : '';
        showTooltip(`💰 Личка найдена: ${r.contacts.map((c) => '@' + c).join(', ')}<br>Отчёт отправлен в Telegram.${openedNote}`, anchorEl);
      } else {
        showTooltip(`❌ Личка в Telegram не найдена${r && r.error ? `<br>${String(r.error).replace(/\n/g, '<br>')}` : ''}`, anchorEl);
      }
    } catch (err) {
      showTooltip(`❌ Ошибка: ${err.message || err}`, anchorEl);
    }
    pendingTgUsers.delete(u);
    updateUIForUser(username);
    setTimeout(hideTooltip, 8000);
  }

  function scanForRows(root = document) {
    root.querySelectorAll('a[href]').forEach(decorateElement);
  }

  // ---------- полоска перемотки на видео Инстаграма ----------
  // В ИГ нет перемотки видео/рилсов — рисуем свою полоску поверх: клик или перетаскивание =
  // мгновенный прыжок на таймкод (например, глянуть призыв к действию в конце, не пересматривая всё).
  function scanForVideos(root = document) {
    root.querySelectorAll('video:not([data-igx-seek])').forEach(enhanceVideo);
  }

  function fmtTime(s) {
    if (!isFinite(s)) return '—';
    s = Math.max(0, Math.floor(s));
    const m = Math.floor(s / 60);
    const sec = String(s % 60).padStart(2, '0');
    return `${m}:${sec}`;
  }

  // Полоска живёт НЕ внутри контейнера видео (ИГ глушит там события и накрывает оверлеями),
  // а прямо в document.body с position:fixed — поверх ВСЕГО на странице. Её позиция каждый кадр
  // синхронизируется с прямоугольником видео. Реестр + один общий цикл позиционирования.
  const igxSeekRegistry = new Set();
  let igxSeekLoopOn = false;

  function igxSeekFrame() {
    for (const item of Array.from(igxSeekRegistry)) {
      if (!item.video.isConnected) {
        item.bar.remove();
        igxSeekRegistry.delete(item);
        continue;
      }
      const r = item.video.getBoundingClientRect();
      const visible =
        r.width > 40 && r.height > 40 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
      if (!visible) {
        item.bar.style.display = 'none';
        continue;
      }
      item.bar.style.display = '';
      item.bar.style.left = r.left + 'px';
      item.bar.style.width = r.width + 'px';
      // Поднимаем на 46px над нижней кромкой — там у ИГ кнопка громкости/звука,
      // полоска не должна её накрывать.
      item.bar.style.top = Math.max(0, r.bottom - item.bar.offsetHeight - 46) + 'px';
    }
    if (igxSeekRegistry.size > 0) {
      requestAnimationFrame(igxSeekFrame);
    } else {
      igxSeekLoopOn = false;
    }
  }

  function enhanceVideo(video) {
    video.dataset.igxSeek = '1';
    try {
      if (!video.crossOrigin) video.crossOrigin = 'anonymous';
    } catch (_) {}
    if (!document.body) return;

    const bar = document.createElement('div');
    bar.className = 'igx-seekbar';
    bar.innerHTML =
      '<div class="igx-seek-track"><div class="igx-seek-fill"></div><div class="igx-seek-knob"></div></div>' +
      '<span class="igx-seek-time">0:00 / 0:00</span>';
    document.body.appendChild(bar);

    const track = bar.querySelector('.igx-seek-track');
    const fill = bar.querySelector('.igx-seek-fill');
    const knob = bar.querySelector('.igx-seek-knob');
    const timeEl = bar.querySelector('.igx-seek-time');
    let dragging = false;
    let seekSeq = 0; // инкремент отменяет старые цепочки доводки перемотки — иначе они дерутся между собой и возвращают видео назад

    igxSeekRegistry.add({ video, bar });
    if (!igxSeekLoopOn) {
      igxSeekLoopOn = true;
      requestAnimationFrame(igxSeekFrame);
    }

    const paint = (ratio) => {
      const pct = (Math.min(1, Math.max(0, ratio)) * 100).toFixed(2) + '%';
      fill.style.width = pct;
      knob.style.left = pct;
    };

    // Доводка: если плеер ИГ проигнорировал прыжок — повторяем. ВАЖНО: цепочка живёт только пока
    // её seq актуален (новый клик её убивает) и пока не идёт перетаскивание. Иначе старые цепочки
    // возвращали видео на старые таймкоды («нажал — видос начался заново»).
    let lastTargetT = null;
    const verifySeek = (t, seq, tries) => {
      setTimeout(() => {
        if (!video.isConnected || seq !== seekSeq || dragging) return;
        if (Math.abs(video.currentTime - t) > 1.5 && tries < 2) {
          try {
            video.currentTime = t;
          } catch (_) {}
          verifySeek(t, seq, tries + 1);
        }
      }, 400);
    };

    const ratioFromX = (clientX) => {
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0) return null;
      return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    };

    const seekTo = (clientX, withRetry) => {
      const ratio = ratioFromX(clientX);
      if (ratio == null) return;
      const d = video.duration;
      if (isFinite(d) && d > 0) {
        // не даём прыгнуть в самый конец — ИГ считает это «видео кончилось» и запускает заново с нуля.
        const t = Math.min(Math.max(0, d - 0.25), ratio * d);
        lastTargetT = t;
        seekSeq++;
        try {
          video.currentTime = t;
        } catch (_) {}
        if (withRetry) verifySeek(t, seekSeq, 0);
        timeEl.textContent = `${fmtTime(t)} / ${fmtTime(d)}`;
      }
      paint(ratio);
    };

    const sync = () => {
      if (dragging) return;
      const d = video.duration;
      paint(isFinite(d) && d > 0 ? video.currentTime / d : 0);
      timeEl.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(d)}`;
    };

    video.addEventListener('timeupdate', sync);
    video.addEventListener('durationchange', sync);
    video.addEventListener('loadedmetadata', sync);
    sync();

    // События ловим НА УРОВНЕ ОКНА в фазе захвата (раньше любых обработчиков ИГ).
    // «Наше» событие = либо попало в DOM полоски, либо пришло в её прямоугольник координатами —
    // так его не перехватит даже невидимый оверлей ИГ, лежащий поверх.
    const owns = (e) => {
      if (bar.style.display === 'none') return false;
      if (e.target && bar.contains(e.target)) return true;
      const r = bar.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    };

    const onDown = (e) => {
      if (!owns(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      dragging = true;
      seekTo(e.clientX, true);
    };
    let lastDragSeekAt = 0;
    const onMove = (e) => {
      if (!dragging) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // Во время перетаскивания долбим плеер не чаще ~7 раз/сек, иначе лагает;
      // полоска при этом рисуется плавно каждый раз.
      const now = Date.now();
      const ratio = ratioFromX(e.clientX);
      if (ratio != null) {
        const d = video.duration;
        if (isFinite(d) && d > 0) {
          lastTargetT = Math.min(Math.max(0, d - 0.25), ratio * d);
          timeEl.textContent = `${fmtTime(lastTargetT)} / ${fmtTime(d)}`;
        }
        paint(ratio);
      }
      if (now - lastDragSeekAt > 140 && isFinite(video.duration) && video.duration > 0) {
        lastDragSeekAt = now;
        try {
          video.currentTime = lastTargetT;
        } catch (_) {}
      }
    };
    const onUp = (e) => {
      if (!dragging) return;
      e.stopImmediatePropagation();
      dragging = false;
      // финальная доводка на то место, где отпустили (одна цепочка, без драк)
      if (lastTargetT != null && isFinite(video.duration) && video.duration > 0) {
        seekSeq++;
        try {
          video.currentTime = lastTargetT;
        } catch (_) {}
        verifySeek(lastTargetT, seekSeq, 0);
      }
      sync();
    };
    const onClick = (e) => {
      // чтобы ИГ не ставил паузу/плей по клику через нашу полоску
      if (!owns(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('click', onClick, true);
  }

  // ---------- извлечение текста из видео (хук + призыв) ----------
  // Кнопка 📝 на полоске: снимаем кадры первых и последних секунд видео,
  // прогоняем через Tesseract в воркере расширения, копируем результат в буфер.
  const OCR_START_KEY = 'igx_ocr_start_sec';
  const OCR_END_KEY = 'igx_ocr_end_sec';
  const OCR_MODE_KEY = 'igx_ocr_mode';
  let igxOcrPop = null;

  // Распознавание крутится в offscreen-документе расширения: контент-скриптам Хром
  // ЗАПРЕЩАЕТ создавать Worker из файлов расширения (та была прежняя ошибка).
  // Сюда — только сообщения.
  function ocrRecognize(dataUrl) {
    const req = chrome.runtime.sendMessage({ type: 'ocrRecognize', image: dataUrl });
    const timeout = new Promise((_, rej) =>
      setTimeout(
        () =>
          rej(
            new Error(
              'Таймаут распознавания (45 с). Проверь, что в lib/ есть rus.traineddata.gz, и перезагрузи расширение.'
            )
          ),
        45000
      )
    );
    return Promise.race([req, timeout]).then((r) => {
      if (!r) throw new Error('Распознавалка не ответила.');
      if (r.error) throw new Error(r.error);
      return r.text || '';
    });
  }

  function asrRecognize(base64) {
    return chrome.runtime.sendMessage({ type: 'asrRecognize', audio: base64 }).then((r) => {
      if (!r) throw new Error('Распознавалка не ответила.');
      if (r.error) throw new Error(r.error);
      return (r.text || '').trim();
    });
  }

  function asrRecognizeUrl(url, headTo, tailFrom, tailTo) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Таймаут распознавания речи (120 с).')), 120000);
      chrome.runtime.sendMessage(
        { type: 'asrRecognizeUrl', url, headTo, tailFrom, tailTo },
        (r) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            return reject(new Error(chrome.runtime.lastError.message));
          }
          if (!r) return reject(new Error('Распознавалка речи не ответила.'));
          if (r.error) return reject(new Error(r.error));
          resolve({ headText: (r.headText || '').trim(), tailText: (r.tailText || '').trim() });
        }
      );
    });
  }

  // Захват кадра видео через снимок вкладки, когда canvas блокируется CORS-защитой видео
  function captureVideoViaTab(video) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'captureTab' }, (res) => {
        if (!res || !res.dataUrl) {
          return reject(new Error((res && res.error) || 'Снимок вкладки не удался.'));
        }
        const img = new Image();
        img.onload = () => {
          try {
            const r = video.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            const cropCnv = document.createElement('canvas');
            const w = Math.max(1, r.width * dpr);
            const h = Math.max(1, r.height * dpr);
            const scale = Math.min(1, 960 / Math.max(w, h));
            cropCnv.width = Math.max(1, Math.round(w * scale));
            cropCnv.height = Math.max(1, Math.round(h * scale));
            const cropCtx = cropCnv.getContext('2d');
            cropCtx.drawImage(
              img,
              Math.round(r.left * dpr),
              Math.round(r.top * dpr),
              Math.round(w),
              Math.round(h),
              0,
              0,
              cropCnv.width,
              cropCnv.height
            );
            resolve(cropCnv.toDataURL('image/jpeg', 0.85));
          } catch (e) {
            reject(e);
          }
        };
        img.onerror = reject;
        img.src = res.dataUrl;
      });
    });
  }

  function videoSeekTo(video, t) {
    return new Promise((resolve) => {
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        video.removeEventListener('seeked', fin);
        clearTimeout(to);
        resolve();
      };
      const to = setTimeout(fin, 2500);
      video.addEventListener('seeked', fin);
      try {
        video.currentTime = t;
      } catch (_) {
        fin();
      }
    });
  }

  async function captureRange(video, from, to) {
    const frames = [];
    const w = video.videoWidth || 720;
    const h = video.videoHeight || 1280;
    const scale = Math.min(1, 960 / Math.max(w, h)); // крупнее — точнее распознавание, но не гигантские кадры
    const cnv = document.createElement('canvas');
    cnv.width = Math.max(1, Math.round(w * scale));
    cnv.height = Math.max(1, Math.round(h * scale));
    const ctx = cnv.getContext('2d', { willReadFrequently: true });

    let isTainted = false;
    const dur = Math.max(0.1, to - from);
    const step = Math.max(1.2, dur / 5); // 5–6 ключевых кадров вместо 30 (в 3 раза быстрее)
    for (let t = from; t <= to + 0.01 && frames.length < 8; t += step) {
      await videoSeekTo(video, t);
      if (!isTainted) {
        try {
          ctx.drawImage(video, 0, 0, cnv.width, cnv.height);
          const dataUrl = cnv.toDataURL('image/jpeg', 0.85);
          frames.push(dataUrl);
          continue;
        } catch (_) {
          // Canvas tainted cross-origin — переключаемся на захват вкладки
          isTainted = true;
        }
      }

      // Запасной путь при CORS-защите: снимок через вкладку
      try {
        const tabFrame = await captureVideoViaTab(video);
        if (tabFrame) frames.push(tabFrame);
      } catch (err) {
        console.warn('Ошибка захвата кадра через вкладку:', err);
      }
    }
    return frames;
  }

  function compactOcrText(s) {
    const seen = new Set();
    return String(s || '')
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => {
        const key = l.toLowerCase().replace(/\s+/g, ' ');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .join('\n');
  }

  // Самое видимое видео на экране (у которого есть длина) — его и мотаем/слушаем.
  function pickBestVideo() {
    let best = null;
    let bestArea = 0;
    document.querySelectorAll('video').forEach((v) => {
      if (!isFinite(v.duration) || v.duration <= 1) return;
      const r = v.getBoundingClientRect();
      const visW = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
      const visH = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
      const area = visW > 0 && visH > 0 ? visW * visH : 0;
      if (area > bestArea) {
        bestArea = area;
        best = v;
      }
    });
    return best;
  }

  // Запись звука из куска видео: перемотал, проиграл беззвучно для тебя, записал дорожку.
  async function recordRange(video, from, to) {
    if (typeof video.captureStream !== 'function') throw new Error('Браузер не даёт захватить звук из этого видео.');
    let stream;
    try {
      stream = video.captureStream();
    } catch (e) {
      throw new Error('CORS-защита видео не даёт захватить аудиопоток (' + ((e && e.message) || e) + ').');
    }
    const tracks = stream.getAudioTracks();
    if (!tracks.length) throw new Error('В этом видео нет звуковой дорожки.');
    const rec = new MediaRecorder(new MediaStream(tracks));
    const chunks = [];
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    const stopped = new Promise((res) => {
      rec.onstop = res;
    });
    const wasMuted = video.muted;
    const prevVolume = video.volume;
    video.muted = true;
    await videoSeekTo(video, from);
    // На время записи включаем звук на минимальной громкости, чтобы captureStream не глушился
    video.muted = false;
    video.volume = 0.02;
    try {
      video.play();
    } catch (_) {}
    rec.start(250);
    await new Promise((res) => setTimeout(res, Math.max(500, (to - from) * 1000)));
    try {
      rec.stop();
    } catch (_) {}
    await stopped;
    tracks.forEach((t) => t.stop());
    try {
      video.pause();
    } catch (_) {}
    video.volume = prevVolume;
    video.muted = wasMuted;
    return new Blob(chunks, { type: 'audio/webm' });
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
      fr.onerror = () => reject(new Error('Не смог прочитать звук.'));
      fr.readAsDataURL(blob);
    });
  }

  async function ocrFrames(frames, statusEl, label) {
    const out = [];
    for (let i = 0; i < frames.length; i++) {
      if (statusEl) statusEl.textContent = `Распознаю ${label}: ${i + 1}/${frames.length}…`;
      try {
        out.push(await ocrRecognize(frames[i]));
      } catch (err) {
        if (i === 0) throw err; // первый кадр не распознался — движка нет, сообщаем дальше
      }
    }
    return out.join('\n');
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  function ocrClampInt(v, def) {
    const n = parseInt(v, 10);
    if (!isFinite(n)) return def;
    return Math.min(60, Math.max(1, n));
  }

  function ensureOcrPopup() {
    if (igxOcrPop && document.body.contains(igxOcrPop)) return igxOcrPop;
    const pop = document.createElement('div');
    pop.className = 'igx-ocr-pop';
    pop.innerHTML =
      '<div class="igx-ocr-head"><span>Извлечение текста из видео</span><button class="igx-ocr-close" title="Закрыть">✕</button></div>' +
      '<div class="igx-ocr-row">' +
      '<label>Первые сек <input type="number" class="igx-ocr-start" min="1" max="60" value="7"></label>' +
      '<label>Последние сек <input type="number" class="igx-ocr-end" min="1" max="60" value="7"></label>' +
      '</div>' +
      '<div class="igx-ocr-row igx-ocr-modes">' +
      '<label title="Распознаёт надписи на кадрах"><input type="radio" name="igx-ocr-mode" value="text" checked> Текст с экрана</label>' +
      '<label title="Распознаёт речь из звука (первый запуск качает модель ~40 МБ)"><input type="radio" name="igx-ocr-mode" value="audio"> Речь из звука</label>' +
      '</div>' +
      '<button class="igx-btn igx-ocr-run">📝 Извлечь и скопировать</button>' +
      '<div class="igx-ocr-status"></div>';
    document.body.appendChild(pop);
    pop.querySelector('.igx-ocr-close').addEventListener('click', () => {
      pop.style.display = 'none';
    });
    pop.querySelector('.igx-ocr-run').addEventListener('click', () => ocrRun());
    // клики внутри попапа не должны уходить ИГ (пауза видео и т.п.)
    ['pointerdown', 'mousedown', 'click'].forEach((ev) => {
      pop.addEventListener(ev, (e) => e.stopPropagation());
    });
    chrome.storage.local.get([OCR_START_KEY, OCR_END_KEY, OCR_MODE_KEY]).then((d) => {
      pop.querySelector('.igx-ocr-start').value = d[OCR_START_KEY] || 7;
      pop.querySelector('.igx-ocr-end').value = d[OCR_END_KEY] || 7;
      const mode = d[OCR_MODE_KEY] === 'audio' ? 'audio' : 'text';
      const radio = pop.querySelector(`input[name="igx-ocr-mode"][value="${mode}"]`);
      if (radio) radio.checked = true;
    });
    igxOcrPop = pop;
    return pop;
  }

  function openOcrPopup(anchorEl) {
    const pop = ensureOcrPopup();
    pop.style.display = 'block';
    const ar = (anchorEl || document.body).getBoundingClientRect();
    const h = pop.offsetHeight || 190;
    let top = ar.top - h - 10;
    if (top < 8) top = Math.min(window.innerHeight - h - 8, ar.bottom + 10);
    pop.style.left = Math.max(8, Math.min(ar.left, window.innerWidth - 320)) + 'px';
    pop.style.top = Math.max(8, top) + 'px';
    pop.querySelector('.igx-ocr-status').textContent = '';
  }

  async function ocrRun() {
    const pop = igxOcrPop;
    if (!pop) return;
    const statusEl = pop.querySelector('.igx-ocr-status');
    const runBtn = pop.querySelector('.igx-ocr-run');
    const video = pickBestVideo();
    if (!video) {
      statusEl.textContent = 'На экране нет видео — открой рилс/видео и нажми кнопку заново.';
      return;
    }
    const d = video.duration;
    if (!isFinite(d) || d <= 1) {
      statusEl.textContent = 'У этого видео нет длины (эфир или ещё грузится).';
      return;
    }
    const startSec = ocrClampInt(pop.querySelector('.igx-ocr-start').value, 7);
    const endSec = ocrClampInt(pop.querySelector('.igx-ocr-end').value, 7);
    const modeRadio = pop.querySelector('input[name="igx-ocr-mode"]:checked');
    const mode = modeRadio ? modeRadio.value : 'text';
    chrome.storage.local.set({ [OCR_START_KEY]: startSec, [OCR_END_KEY]: endSec, [OCR_MODE_KEY]: mode });

    runBtn.disabled = true;
    const wasPlaying = !video.paused;
    const prevTime = video.currentTime;

    try {
      const headTo = Math.min(startSec, Math.max(0, d - 0.3));
      // если видео короче суммы двух окон — не дублируем кадры начала в конце
      const tailFrom = Math.min(Math.max(d - endSec, headTo + 0.5), Math.max(0, d - 0.3));
      const tailTo = Math.max(0, d - 0.3);
      let headText = '';
      let tailText = '';

      if (mode === 'audio') {
        const directUrl =
          video.currentSrc && video.currentSrc.startsWith('http')
            ? video.currentSrc
            : video.src && video.src.startsWith('http')
              ? video.src
              : video.querySelector('source') &&
                  video.querySelector('source').src &&
                  video.querySelector('source').src.startsWith('http')
                ? video.querySelector('source').src
                : null;

        if (directUrl) {
          statusEl.textContent = 'Распознаю речь из видео (прямая загрузка аудио)…';
          const asrRes = await asrRecognizeUrl(directUrl, headTo, tailFrom, tailTo);
          headText = asrRes.headText;
          tailText = asrRes.tailText;
        } else {
          statusEl.textContent = 'Записываю звук начала…';
          const headB64 = await blobToBase64(await recordRange(video, 0, headTo));
          statusEl.textContent = 'Записываю звук конца…';
          const tailB64 = await blobToBase64(await recordRange(video, tailFrom, tailTo));
          statusEl.textContent = 'Распознаю речь начала…';
          headText = await asrRecognize(headB64);
          statusEl.textContent = 'Распознаю речь конца…';
          tailText = await asrRecognize(tailB64);
        }
      } else {
        try {
          video.pause();
        } catch (_) {}
        statusEl.textContent = 'Снимаю кадры начала…';
        const headFrames = await captureRange(video, 0, headTo);
        statusEl.textContent = 'Снимаю кадры конца…';
        const tailFrames = await captureRange(video, tailFrom, tailTo);
        statusEl.textContent = 'Загружаю движок распознавания (первый раз ~10–15 с)…';
        headText = compactOcrText(await ocrFrames(headFrames, statusEl, 'начало'));
        tailText = compactOcrText(await ocrFrames(tailFrames, statusEl, 'конец'));
      }

      const result = `Хук: ${headText || '(текст на видео не найден)'}\nПризыв: ${tailText || '(текст на видео не найден)'}`;
      const ok = await copyToClipboard(result);
      statusEl.textContent = ok ? 'Скопировано в буфер обмена ✓' : 'Не смог скопировать в буфер.';
    } catch (err) {
      statusEl.textContent = String((err && err.message) || err);
    } finally {
      try {
        video.currentTime = prevTime;
      } catch (_) {}
      if (wasPlaying) video.play().catch(() => {});
      runBtn.disabled = false;
    }
  }

  const observer = new MutationObserver((mutations) => {
    let hasNewNodes = false;
    for (const m of mutations) {
      if (m.type === 'childList' && m.addedNodes.length > 0) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && !n.classList?.contains('igx-tooltip') && !n.classList?.contains('igx-badge-wrap')) {
            hasNewNodes = true;
            break;
          }
        }
      }
      if (hasNewNodes) break;
    }
    if (!hasNewNodes) return;

    clearTimeout(scanForRows._t);
    scanForRows._t = setTimeout(() => {
      scanForRows();
      scanForVideos();
      debouncedApplyFilters();
    }, 250);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  scanForRows();
  scanForVideos();

  chrome.storage.onChanged.addListener((changes) => {
    let shouldUpdate = false;
    for (const key of Object.keys(changes)) {
      if (key === 'igx_settings') {
        cachedSettings = Object.assign({}, cachedSettings, changes[key].newValue || {});
        continue;
      }
      if (key === 'igx_min_followers') {
        // Синхронизация порога между вкладками (главная / фоновые автопроверки).
        filterState.minFollowers = parseInt(changes[key].newValue, 10) || 0;
        const inp = sidePanelEl && sidePanelEl.querySelector('.igx-min-followers');
        if (inp && document.activeElement !== inp) inp.value = filterState.minFollowers || '';
        shouldUpdate = true;
        continue;
      }
      if (key.startsWith(DONE_PREFIX)) {
        if (changes[key].newValue == null) doneCache.delete(key.slice(DONE_PREFIX.length));
        else doneCache.add(key.slice(DONE_PREFIX.length));
        updateUIForUser(key.slice(DONE_PREFIX.length));
        shouldUpdate = true;
        continue;
      }
      if (key.startsWith(PROFILE_PREFIX) || key.startsWith(VIEWED_PREFIX)) {
        const username = key.replace(/^(?:igx_profile:|igx_viewed:)/, '');
        if (key.startsWith(PROFILE_PREFIX)) {
          profileCache.set(username, changes[key].newValue || null);
        } else if (changes[key].newValue == null) {
          viewedCache.delete(username);
        } else {
          viewedCache.add(username);
        }
        pendingUsers.delete(username.toLowerCase());
        updateUIForUser(username);
        shouldUpdate = true;
      }
    }
    if (shouldUpdate) debouncedApplyFilters();
  });

  // ---------- очередь быстрых проверок с соблюдением задержки ----------
  let queue = [];
  let processingQueue = false;

  function enqueueQuickCheck(username, url) {
    const u = username.toLowerCase();
    if (pendingUsers.has(u)) return;
    pendingUsers.add(u);
    updateUIForUser(username);
    queue.push({ username, url });
    if (!processingQueue) processQueue();
  }

  async function processQueue() {
    processingQueue = true;
    while (queue.length) {
      const item = queue.shift();
      const settings = await getSettings();
      const throttle = Math.max(2000, settings.throttleMs || 4000);

      try {
        await igxSend({ type: 'quickCheck', username: item.username, url: item.url }, 8000);
      } catch (_) {}

      // Ожидание заданной задержки для безопасности аккаунта
      await new Promise((r) => setTimeout(r, throttle));
      pendingUsers.delete(item.username.toLowerCase());
      updateUIForUser(item.username);
    }
    processingQueue = false;
  }

  // ---------- клик по строке внутри модалки -> сплит / новая вкладка ----------
  // Открываем профиль ТОЛЬКО если клик пришёл непосредственно по ссылке на профиль
  // (ник или аватарка). Клики по кнопкам IG, пустому месту строки и т.п. игнорируем.
  function handleRowClick(e) {
    if (e.target.closest('.igx-badge-wrap, .igx-tooltip, .igx-side-panel, .igx-link-menu')) return;
    // Ctrl/Cmd/Shift/Alt и средняя кнопка — родное поведение браузера (открыть в новой вкладке), не трогаем
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;

    const link = e.target.closest('a[href]');
    if (!link) return;

    const username = extractUsername(link);
    if (!username) return;

    if (!link.closest('[role="dialog"]')) return;

    // Режим «как обычно, в этой же вкладке» — вообще не перехватываем клик.
    // Раньше preventDefault вызывался ДО проверки режима: клик глотался,
    // и профиль не открывался вообще.
    if (cachedSettings.openMode === 'sametab') return;

    // Предотвращаем переход на основной вкладке
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    chrome.runtime
      .sendMessage({ type: 'openProfile', url: `https://www.instagram.com/${username}/` })
      .catch(() => {});
  }

  document.addEventListener('click', handleRowClick, true);

  // ---------- автоматическая пакетная проверка списка ----------
  let isBatchRunning = false;
  let batchTotal = 0;
  let batchCurrent = 0;

  function stopBatchCheck() {
    isBatchRunning = false;
    updateBatchUI();
  }

  function updateBatchUI() {
    const panel = document.querySelector('.igx-side-panel');
    if (!panel) return;
    const btn = panel.querySelector('.igx-btn-autocheck');
    if (!btn) return;

    if (isBatchRunning) {
      btn.textContent = `⏹ Остановить (проверено ${batchCurrent} из ${batchTotal})`;
      btn.className = 'igx-btn-autocheck is-running';
    } else {
      btn.textContent = '⚡ Автопроверка списка';
      btn.className = 'igx-btn-autocheck';
    }
  }

  async function startBatchCheck() {
    if (isBatchRunning) {
      stopBatchCheck();
      return;
    }

    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) {
      const anchor = sidePanelEl || document.body;
      showTooltip('Открой модалку подписчиков или подписок', anchor);
      setTimeout(hideTooltip, 5000);
      return;
    }

    const links = dialog.querySelectorAll('a[href]');
    const toCheck = [];
    const seen = new Set();

    for (const link of links) {
      const u = extractUsername(link);
      if (!u) continue;
      const low = u.toLowerCase();
      if (seen.has(low)) continue;
      seen.add(low);

      const p = await getProfile(u);
      if (!p) {
        toCheck.push({ username: u, url: `https://www.instagram.com/${u}/` });
      }
    }

    if (toCheck.length === 0) {
      alert('Все видимые профили в этом списке уже проверены!');
      return;
    }

    isBatchRunning = true;
    batchTotal = toCheck.length;
    batchCurrent = 0;
    updateBatchUI();

    try {
      for (const item of toCheck) {
        if (!isBatchRunning) break;
        batchCurrent++;
        updateBatchUI();

        pendingUsers.add(item.username.toLowerCase());
        updateUIForUser(item.username);

        const settings = await getSettings();
        const throttle = Math.max(2000, settings.throttleMs || 4000);

        try {
          await igxSend({ type: 'quickCheck', username: item.username, url: item.url }, 8000);
        } catch (_) {}

        if (isBatchRunning) {
          await new Promise((r) => setTimeout(r, throttle));
        }
        pendingUsers.delete(item.username.toLowerCase());
        updateUIForUser(item.username);
      }
    } finally {
      isBatchRunning = false;
      updateBatchUI();
      // Проверены все из списка (или 5+) — эксперт считается «выжатым»,
      // подсвечиваем его красно-пурпурным в остальных списках.
      const owner = afkOwnerFromUrl();
      if (owner && batchCurrent > 0 && (batchCurrent >= 5 || batchCurrent >= seen.size)) {
        markDone(owner, batchCurrent).catch(() => {});
      }
    }
  }

  // ---------- АФК-режим ----------
  // Стартует ТОЛЬКО по кнопке «⚡ Автопроверка списка» при включённой галочке «АФК».
  // Состояние живёт в storage (igx_afk_state), поэтому режим переживает переходы:
  // прыжок к следующему челу — полная навигация в ЭТОЙ ЖЕ вкладке на его подписчиков,
  // после перезагрузки скрипт читает состояние и продолжает с того же места.
  // Цикл: листает модалку до конца -> чекает всех -> отчёт в бота -> берёт самого
  // популярного (до 50к сабов, у гигантов список не грузится) -> вводит слово в поиск -> повтор.
  const igxSleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const AFK_STATE_KEY = 'igx_afk_state';
  const AFK_MAX_FOLLOWERS = 50000;
  // ИГ редиректит /followers/ → mutualOnly (только твои подписки).
  // Нужен mutualFirst — полный список подписчиков (сначала общие, потом все).
  const AFK_FOLLOWERS_MODE = 'mutualFirst';
  let afkBusy = false;

  function afkFollowersUrl(username) {
    return `https://www.instagram.com/${username}/followers/${AFK_FOLLOWERS_MODE}`;
  }

  function afkIsFollowersPage() {
    return /\/followers(?:\/|$)/i.test(location.pathname);
  }

  function afkIsMutualOnlyPage() {
    return /\/followers\/mutualonly/i.test(location.pathname);
  }

  // Закрытый список подписчиков: вместо людей ИГ показывает «Только X может
  // смотреть/видеть всех своих подписчиков» (RU) / «Only X can see …» (EN).
  function afkIsClosedList(box) {
    if (!box) return false;
    let t = '';
    try {
      t = (box.innerText || '').slice(0, 3000);
    } catch (_) {}
    return /может (?:видеть|смотреть)|can see|закрыт\w* аккаунт|private account|this account is private/i.test(t);
  }

  // Если ИГ открыл mutualOnly — принудительно переходим на mutualFirst.
  async function afkEnsureMutualFirst() {
    if (!afkIsMutualOnlyPage()) return true;
    const owner = afkProfileOwner();
    if (!owner) return true;
    location.href = afkFollowersUrl(owner);
    return false;
  }

  function afkGetState() {
    return chrome.storage.local.get(AFK_STATE_KEY).then((d) => d[AFK_STATE_KEY] || null);
  }
  async function afkPatchState(patch) {
    const cur = (await afkGetState()) || {};
    const st = Object.assign({ on: false, word: '', visited: [], lists: [], needSearch: false }, cur, patch);
    await chrome.storage.local.set({ [AFK_STATE_KEY]: st });
    return st;
  }
  async function afkRunning() {
    const st = await afkGetState();
    return !!(st && st.on);
  }

  function afkDialog() {
    return document.querySelector('[role="dialog"]');
  }

  function afkUserCount(dialog) {
    if (!dialog) return 0;
    const seen = new Set();
    dialog.querySelectorAll('a[href]').forEach((a) => {
      const u = extractUsername(a);
      if (u) seen.add(u.toLowerCase());
    });
    return seen.size;
  }

  async function afkWaitDialog(timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeoutMs || 20000)) {
      const d = afkDialog();
      if (d && afkUserCount(d) > 0) return d;
      await igxSleep(700);
    }
    return afkDialog();
  }

  // Владелец профиля из URL (профиль, /followers/, /followers/mutualFirst и т.п.).
  function afkProfileOwner() {
    const m = location.pathname.match(/^\/([A-Za-z0-9._]{1,30})(?:\/(?:followers|following)(?:\/[^/]+)?)?\/?/i);
    return m ? m[1].toLowerCase() : null;
  }

  // Надёжный клик по элементу (ИГ иногда игнорирует простой .click()).
  function afkSimulateClick(el) {
    if (!el) return;
    try {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
    } catch (_) {}
    try {
      el.click();
    } catch (_) {}
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    } catch (_) {}
  }

  // Секция «Подписаны (твои подписки)» в модалке — это люди, на которых ты уже подписан.
  // Их нельзя брать как «следующего эксперта» и не стоит тратить на них автопроверку.
  const AFK_SUBSCRIBED_HDR_RE = /подписаны|твои подписки|accounts you follow|people you follow/i;
  // Кнопка в строке: ты УЖЕ подписан на этого человека.
  const AFK_FOLLOWING_BTN_RE = /^(подписки|подписан|отправлен|запрош|following|requested|message|сообщени|друзья)/i;
  const AFK_FOLLOW_BTN_RE = /^(подписаться|follow)$/i;

  // Кэш найденных секций «Подписаны»: раньше при каждом обращении заново
  // сканировался весь DOM модалки — на больших списках это O(n²) и страница
  // зависала. Кэш живёт 5 секунд, потом пересчитывается.
  const afkSubscribedCache = new WeakMap(); // root -> {at, containers}
  function afkSubscribedContainers(root) {
    if (!root) return [];
    const hit = afkSubscribedCache.get(root);
    if (hit && Date.now() - hit.at < 5000) return hit.containers;
    const containers = [];
    for (const el of root.querySelectorAll('span, div, h2, h3, h4')) {
      const direct = [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join('')
        .trim();
      const t = (direct || el.textContent || '').trim();
      if (!t || t.length > 70) continue;
      if (!AFK_SUBSCRIBED_HDR_RE.test(t)) continue;
      // Поднимаемся к контейнеру секции (там лежат строки людей).
      let box = el.parentElement;
      for (let i = 0; i < 4 && box && box !== root; i++) {
        if (box.querySelectorAll('a[href]').length >= 2) break;
        box = box.parentElement;
      }
      if (box && !containers.includes(box)) containers.push(box);
    }
    afkSubscribedCache.set(root, { at: Date.now(), containers });
    return containers;
  }

  // Заголовок секции «Подписаны» — всё внутри неё пропускаем.
  function afkIsInSubscribedSection(a, root) {
    return afkSubscribedContainers(root).some((c) => c.contains(a));
  }

  // В строке списка: кнопка «Подписки» / Following = ты уже подписан.
  function afkBtnLabel(btn) {
    const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    const aria = (btn.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    return t || aria;
  }

  function afkRowForLink(a) {
    if (!a) return null;
    const li = a.closest('li, [role="listitem"]');
    if (li) return li;
    let row = a.parentElement;
    for (let i = 0; i < 8 && row; i++) {
      if (row.querySelector('button, [role="button"]') && (row.querySelector('img') || row === a.closest('div'))) {
        return row;
      }
      row = row.parentElement;
    }
    return findUserRow(a);
  }

  function afkRowShowsFollowButton(row) {
    if (!row) return false;
    for (const btn of row.querySelectorAll('button, [role="button"]')) {
      const label = afkBtnLabel(btn);
      if (!label || label.length > 50) continue;
      if (AFK_FOLLOW_BTN_RE.test(label)) return true;
    }
    return false;
  }

  function afkRowShowsFollowing(row) {
    if (!row) return false;
    for (const btn of row.querySelectorAll('button, [role="button"]')) {
      const label = afkBtnLabel(btn);
      if (!label || label.length > 50) continue;
      if (AFK_FOLLOW_BTN_RE.test(label)) continue;
      if (AFK_FOLLOWING_BTN_RE.test(label)) return true;
    }
    return false;
  }

  function afkIsAlreadyFollowingUser(a, root) {
    if (afkIsInSubscribedSection(a, root)) return true;
    return afkRowShowsFollowing(afkRowForLink(a));
  }

  // Ссылки на юзеров в списке, без владельца и без тех, на кого уже подписан.
  function afkIterUserLinks(root, skipSubscribed) {
    const owner = afkOwnerFromUrl();
    const seen = new Set();
    const out = [];
    for (const a of (root || document).querySelectorAll('a[href]')) {
      const u = extractUsername(a);
      if (!u) continue;
      const low = u.toLowerCase();
      if (seen.has(low)) continue;
      if (owner && low === owner) continue;
      if (skipSubscribed && afkIsAlreadyFollowingUser(a, root)) continue;
      seen.add(low);
      out.push({ a, u, low });
    }
    return out;
  }

  // Найти кликабельный элемент «подписчики» на странице профиля.
  function afkFindFollowersEl() {
    const owner = afkProfileOwner();
    const dialog = afkDialog();
    const isInDialog = (el) => dialog && dialog.contains(el);

    // 1. Ссылка на /owner/followers/mutualFirst в шапке (не mutualOnly, не внутри модалки).
    if (owner) {
      let fallback = null;
      for (const a of document.querySelectorAll('a[href*="followers"]')) {
        if (isInDialog(a)) continue;
        const href = (a.getAttribute('href') || '').toLowerCase();
        if (!href.includes(`/${owner}/followers`)) continue;
        if (href.includes('mutualonly')) continue;
        if (href.includes('mutualfirst')) return a;
        if (!fallback) fallback = a;
      }
      if (fallback) return fallback;
    }

    // 2. Счётчик «подписчики» в header — но не «подписаны/подписки» (это про подписки владельца).
    // ВАЖНО: нельзя пропускать по /подписк/ — оно содержится и в «подписчиков»,
    // из-за этого АФК вообще не находил счётчик в русской локали.
    const header = document.querySelector('header');
    if (header) {
      for (const el of header.querySelectorAll('a, li, span, [role="button"]')) {
        if (isInDialog(el)) continue;
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 40) continue;
        if (/подписан|подписки\b|\bfollowing\b|\bfollows\b/i.test(t)) continue;
        if (/подписчик|\bfollowers?\b/i.test(t)) {
          const click = el.closest('a, [role="button"]') || el;
          if (!isInDialog(click)) return click;
        }
      }
    }
    return null;
  }

  async function afkClickFollowers() {
    const el = afkFindFollowersEl();
    if (!el) return false;
    afkSimulateClick(el);
    await igxSleep(800);
    return true;
  }

  // В модалке ИГ может открыться вкладка «Подписки» вместо «Подписчики» — переключаем.
  async function afkEnsureFollowersTab(box) {
    const root = box || afkDialog();
    if (!root) return;
    const tabs = root.querySelectorAll('a, button, [role="tab"], li');
    for (const el of tabs) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/^(подписчики|followers)$/i.test(t)) continue;
      const selected = el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current') === 'true';
      const cls = el.className || '';
      if (selected || /active|selected/i.test(cls)) return;
      afkSimulateClick(el);
      await igxSleep(1500);
      return;
    }
  }

  // Добиться открытого списка подписчиков и вернуть контейнер со строками.
  // После перехода на /юзернейм/followers/ ИГ не всегда сам открывает модалку —
  // тогда кликаем по ссылке «подписчики» на профиле. Если ИГ показывает список всей страницей — работаем со страницей.
  async function afkEnsureList(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 30000);
    let clickAttempts = 0;

    while (Date.now() < deadline) {
      let d = afkDialog();
      if (d && afkUserCount(d) > 0) return d;

      // На URL /followers/ без модалки — кликаем по счётчику подписчиков (до 5 попыток).
      if (clickAttempts < 5) {
        const clicked = await afkClickFollowers();
        if (clicked) clickAttempts++;
        d = await afkWaitDialog(6000);
        if (d && afkUserCount(d) > 0) return d;
      }

      // Запасной вариант: модалка есть, но afkWaitDialog не дождался — берём только её.
      const d2 = afkDialog();
      if (d2 && afkUserCount(d2) > 0) return d2;

      await igxSleep(1000);
    }
    return null;
  }

  async function afkStop(reason) {
    await afkPatchState({ on: false, needSearch: false });
    afkSetBtn(false);
    if (sidePanelEl) {
      const chk = sidePanelEl.querySelector('.igx-chk-afk');
      if (chk) chk.checked = false;
      if (reason) {
        // Если панель скрыта (модалки нет) — тултип на неё был бы невидим, якоримся к body.
        const anchor = sidePanelEl.style.display === 'none' ? document.body : sidePanelEl;
        showTooltip(`🤖 АФК стоп: ${reason}`, anchor);
        setTimeout(hideTooltip, 9000);
      }
    } else if (reason) {
      showTooltip(`🤖 АФК стоп: ${reason}`, document.body);
      setTimeout(hideTooltip, 9000);
    }
  }

  // Кнопка автопроверки показывает, что сейчас крутится АФК и сколько уже проверено.
  function afkSetBtn(running, count) {
    const panel = document.querySelector('.igx-side-panel');
    if (!panel) return;
    const btn = panel.querySelector('.igx-btn-autocheck');
    if (!btn) return;
    if (running) {
      btn.textContent = `🤖 АФК: проверено ${count || 0} — нажми для стопа`;
      btn.className = 'igx-btn-autocheck is-running';
    } else if (!isBatchRunning) {
      btn.textContent = '⚡ Автопроверка списка';
      btn.className = 'igx-btn-autocheck';
    }
  }

  // Фаза скролла до дна списка (проверки ещё не начались — показываем это отдельно).
  function afkSetBtnScroll() {
    const panel = document.querySelector('.igx-side-panel');
    if (!panel) return;
    const btn = panel.querySelector('.igx-btn-autocheck');
    if (!btn) return;
    btn.textContent = '🤖 АФК: листаю список до конца… — нажми для стопа';
    btn.className = 'igx-btn-autocheck is-running';
  }

  // Скроллим контейнер вниз, пока не перестанут подгружаться новые строки.
  // box может быть модалкой или всей страницей (тогда крутим окно).
  async function afkScrollToEnd(box) {
    const isPage = box === document.body;
    let sc = null;
    if (!isPage) {
      for (const el of box.querySelectorAll('div')) {
        if (el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200) {
          if (!sc || el.clientHeight > sc.clientHeight) sc = el;
        }
      }
    }
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 400; i++) {
      if (!(await afkRunning()) || !document.contains(box)) return false;
      if (sc) sc.scrollTop = sc.scrollHeight;
      else window.scrollTo(0, document.documentElement.scrollHeight);
      await igxSleep(1500);
      const count = afkUserCount(box);
      if (count === last) {
        stable++;
        if (stable >= 4) return true; // 4 круга без новичков — дно
      } else {
        stable = 0;
        last = count;
      }
    }
    return true;
  }

  // Чекает всех непроверенных в модалке (с троттлом из настроек).
  // Пропускаем блок «Подписаны (твои подписки)» — это не целевые эксперты.
  async function afkCheckAll(dialog) {
    const toCheck = [];
    for (const { u } of afkIterUserLinks(dialog, true)) {
      const p = await getProfile(u);
      if (!p) toCheck.push(u);
    }
    const checked = [];
    for (const u of toCheck) {
      if (!(await afkRunning())) break;
      pendingUsers.add(u.toLowerCase());
      updateUIForUser(u);
      const settings = await getSettings();
      const throttle = Math.max(2000, settings.throttleMs || 4000);
      try {
        await igxSend({ type: 'quickCheck', username: u, url: `https://www.instagram.com/${u}/` }, 8000);
      } catch (_) {}
      await igxSleep(throttle);
      pendingUsers.delete(u.toLowerCase());
      updateUIForUser(u);
      checked.push(u);
      afkSetBtn(true, checked.length); // живой счётчик на кнопке: видно что процесс идёт
    }
    await igxSleep(1500); // хвост: последние вкладки доизвлекают данные
    return checked;
  }

  // Владелец текущего списка — из URL (/username/followers/... или страница профиля под модалкой).
  function afkOwnerFromUrl() {
    const m = location.pathname.match(/^\/([A-Za-z0-9._]{1,30})\/(?:followers|following)/i);
    if (m) return m[1].toLowerCase();
    const u = extractUsername(location.pathname);
    return u ? u.toLowerCase() : null;
  }

  // Копим проверенные списки (для отчёта): владелец + сколько профилей в нём перечекано.
  async function afkRecordList(owner, count) {
    const st = await afkGetState();
    if (!st) return;
    const lists = Array.isArray(st.lists) ? st.lists.slice() : [];
    const name = owner || `список ${lists.length + 1}`;
    const ex = lists.find((l) => l.owner === name);
    if (ex) ex.count += count;
    else lists.push({ owner: name, count });
    await afkPatchState({ lists });
  }

  // Отчёт в бота: сколько длилось, перечекал, нашёл с TG и с нужными сабами + список листов.
  async function afkSendReport(checked, startedAt) {
    const minF = filterState.minFollowers || 0;
    let foundTg = 0;
    let foundFit = 0;
    for (const u of checked) {
      const p = await getProfile(u);
      if (p && p.telegram) {
        foundTg++;
        if (minF <= 0 || (p.followers != null && p.followers >= minF)) foundFit++;
      }
    }
    const st = await afkGetState();
    const durationMin = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
    chrome.runtime
      .sendMessage({
        type: 'tgAfkReport',
        durationMin,
        checked: checked.length,
        foundTg,
        foundFit,
        minFollowers: minF,
        lists: (st && Array.isArray(st.lists) ? st.lists : []),
      })
      .catch(() => {});
  }

  // Следующий прыжок: самый популярный чел списка, КРОМЕ уже открытых, гигантов,
  // и тех, на кого ты уже подписан (секция «Подписаны» или кнопка «Подписки» в строке).
  async function afkPickNext(dialog) {
    const st = await afkGetState();
    const visited = new Set((st && st.visited) || []);
    let best = null;
    let bestNew = null; // приоритет: у кого кнопка «Подписаться» (точно не подписан)
    for (const { a, u, low } of afkIterUserLinks(dialog, true)) {
      if (visited.has(low)) continue;
      // Розовая подсветка = список этого эксперта уже прочекан целиком — не прыгаем к нему снова.
      if (isDone(u)) continue;
      if (afkIsAlreadyFollowingUser(a, dialog)) continue;
      const p = await getProfile(u);
      if (!p || p.followers == null) continue;
      if (p.followers > AFK_MAX_FOLLOWERS) continue;
      const row = afkRowForLink(a);
      if (afkRowShowsFollowButton(row)) {
        if (!bestNew || p.followers > bestNew.followers) bestNew = { username: u, followers: p.followers };
      }
      if (!best || p.followers > best.followers) best = { username: u, followers: p.followers };
    }
    return bestNew || best;
  }

  // Ввести слово в поиск списка. Возврат: 'ok' | 'empty' (по слову никого) | 'failed' (ввести не вышло)
  // | 'noinput' (поля поиска в этом списке нет вообще).
  // Раньше если поле не находилось — молча чекали ВСЕХ подряд. Теперь это явный стоп:
  // проверять неотфильтрованный список опасно и бессмысленно.
  async function afkTypeWord(word, box) {
    if (!word) return 'ok';
    const root = box || afkDialog() || document;
    let input = null;
    for (let i = 0; i < 50 && !input; i++) {
      // Ищем ЛЮБОЙ видимый текстовый инпут в модалке: ИГ не всегда ставит
      // type="search"/placeholder, из-за чего старый селектор поле не находил.
      for (const inp of root.querySelectorAll('input')) {
        const t = (inp.getAttribute('type') || 'text').toLowerCase();
        if (t !== 'text' && t !== 'search') continue;
        const r = inp.getBoundingClientRect();
        if (r.width > 40 && r.height >= 8) {
          input = inp;
          break;
        }
      }
      if (!input) await igxSleep(400);
    }
    if (!input) return 'noinput';
    // React-инпут: значение ставим нативным сеттером, иначе ИГ его не увидит.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    for (let attempt = 0; attempt < 4; attempt++) {
      input.focus();
      setter.call(input, word);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await igxSleep(700);
      if (input.value === word) break;
      // Фолбэк: выделить всё и вставить через execCommand — React такое надёжно ест
      try {
        input.focus();
        input.select();
        document.execCommand('insertText', false, word);
      } catch (_) {}
      await igxSleep(700);
    }
    if (input.value !== word) return 'failed'; // слово так и не вошло в поле, чекать такой список нельзя
    await igxSleep(3000); // даём ИГ отфильтровать список по слову
    return afkUserCount(root) > 0 ? 'ok' : 'empty';
  }

  async function startAfk() {
    const wordEl = sidePanelEl && sidePanelEl.querySelector('.igx-afk-word');
    const word = wordEl ? wordEl.value.trim() : '';
    await chrome.storage.local.set({
      [AFK_STATE_KEY]: { on: true, word, visited: [], lists: [], needSearch: true, plainTried: false, jumped: false },
    });
    afkSetBtn(true);
    // Пытаемся открыть список подписчиков автоматически, если модалка ещё не открыта.
    const box = await afkEnsureList(25000);
    if (!box) {
      await afkStop('не удалось открыть список подписчиков — открой его вручную или проверь профиль.');
      return;
    }
    if (!(await afkEnsureMutualFirst())) return;
    afkLoop();
  }

  async function afkLoop() {
    if (afkBusy) return;
    afkBusy = true;
    afkSetBtn(true); // в т.ч. после перезагрузки страницы при возобновлении
    try {
      while (true) {
        const st0 = await afkGetState();
        if (!st0 || !st0.on) break;
        let box = await afkEnsureList(20000);
        // Закрытый список: в модалке нет людей, а есть надпись «только автор может…».
        // Считаем списком только модалку с >= 3 людьми — иначе это заглушка (в ней
        // бывает ссылка на самого чела, и раньше АФК чекал её как «человека из списка»).
        const closedStub = box && afkUserCount(box) <= 2 && afkIsClosedList(box);
        if (closedStub) box = null;
        if (!box) {
          const st1 = await afkGetState();
          if (closedStub && st1 && st1.jumped) {
            // Прыжок попал на закрытый список — разворачиваемся к предыдущему
            // списку, АФК продолжится там и выберет другого кандидата.
            await afkPatchState({ jumped: false, needSearch: true });
            if (history.length > 1) {
              history.back(); // полная навигация назад; resume-логика продолжит цикл
              return;
            }
            await afkStop('у следующего эксперта закрытый список подписчиков, а возвращаться некуда — запусти АФК заново.');
            break;
          }
          const owner = afkProfileOwner();
          if (owner && /\/followers\/[^/]+/i.test(location.pathname) && !(st1 && st1.plainTried)) {
            // ИГ мог не понять URL вида /followers/mutualFirst — один раз пробуем чистый /followers/.
            await afkPatchState({ plainTried: true });
            location.href = `https://www.instagram.com/${owner}/followers/`;
            return;
          }
          if (st1 && st1.jumped) {
            // Модалка после прыжка вообще не открылась (приват/глюк) — тоже назад, не стопорим АФК.
            await afkPatchState({ jumped: false, needSearch: true });
            if (history.length > 1) {
              history.back();
              return;
            }
            await afkStop('после прыжка список не открылся и назад идти некуда — запусти АФК заново.');
            break;
          }
          await afkStop('список подписчиков не открылся (приват или ИГ не дал).');
          break;
        }
        await afkPatchState({ plainTried: false, jumped: false });
        await afkEnsureFollowersTab(box);
        if (!(await afkEnsureMutualFirst())) return;
        // Слово вводится в КАЖДОМ списке: и в первом, и после каждого прыжка.
        if (st0.needSearch) {
          await afkPatchState({ needSearch: false });
          const res = await afkTypeWord(st0.word || '', box);
          if (res === 'failed') {
            await afkStop('не смог ввести слово в поиск модалки.');
            break;
          }
          if (res === 'empty') {
            await afkStop(`по слову «${st0.word}» в этом списке никого нет.`);
            break;
          }
          if (res === 'noinput') {
            await afkStop(`в этом списке нет поля поиска — слово «${st0.word}» ввести некуда. Открой список, где есть поиск, или убери слово.`);
            break;
          }
        }
        afkSetBtnScroll();
        if (!(await afkScrollToEnd(box))) break;
        if (!(await afkRunning())) break;
        const startedAt = Date.now();
        const checked = await afkCheckAll(box);
        const listOwner = afkOwnerFromUrl();
        await afkRecordList(listOwner, checked.length);
        // Эксперт «выжат»: всех из списка прочекали (или 5+ человек) —
        // помечаем, дальше он будет подсвечен красно-пурпурным.
        if (listOwner && checked.length > 0 && (checked.length >= 5 || checked.length >= afkUserCount(box))) {
          await markDone(listOwner, checked.length);
        }
        await afkSendReport(checked, startedAt);
        if (!(await afkRunning())) break;
        const next = await afkPickNext(box);
        if (!next) {
          await afkStop('брать больше некого — остались только проверенные или гиганты (>50к).');
          break;
        }
        const stNow = await afkGetState();
        const visited = new Set((stNow && stNow.visited) || []);
        visited.add(next.username.toLowerCase());
        // jumped: true — если у следующего чела окажется закрытый список,
        // цикл поймёт, что был прыжок, и вернётся сюда (history.back).
        await afkPatchState({ visited: Array.from(visited), needSearch: true, jumped: true });
        // Прыжок в этой же вкладке: mutualFirst = полный список, не mutualOnly.
        location.href = afkFollowersUrl(next.username);
        return;
      }
    } catch (_) {
      await afkStop('внутренняя ошибка цикла.');
    } finally {
      afkBusy = false;
      if (!(await afkRunning())) afkSetBtn(false);
    }
  }

  // Возобновление АФК после перехода: вкладка перезагрузилась на профиле или /подписчиках следующего чела.
  (async () => {
    const st = await afkGetState();
    if (!st || !st.on) return;
    if (await isQuickCheckTab()) return; // фоновые вкладки проверок — не трогаем
    const path = location.pathname;
    const onFollowers = afkIsFollowersPage();
    const onProfile = /^\/[A-Za-z0-9._]{1,30}\/?$/i.test(path);
    if (!onFollowers && !onProfile) {
      await afkPatchState({ on: false });
      return;
    }
    if (afkIsMutualOnlyPage()) {
      const owner = afkProfileOwner();
      if (owner) {
        location.href = afkFollowersUrl(owner);
        return;
      }
    }
    const markAfkChk = () => {
      const chk = sidePanelEl && sidePanelEl.querySelector('.igx-chk-afk');
      if (chk) chk.checked = true;
    };
    markAfkChk();
    if (!sidePanelEl) {
      const t0 = Date.now();
      const iv = setInterval(() => {
        markAfkChk();
        if (sidePanelEl || Date.now() - t0 > 30000) clearInterval(iv);
      }, 500);
    }
    await igxSleep(5000); // даём ИГ отрисовать профиль и модалку после загрузки
    afkLoop();
  })();

  // ---------- экспорт найденных Telegram-лидов в CSV ----------
  async function exportLeadsCSV() {
    const all = await chrome.storage.local.get(null);
    const rows = [['username', 'fullName', 'followers', 'telegram', 'checkedAt']];
    for (const k of Object.keys(all)) {
      if (k.startsWith('igx_profile:')) {
        const p = all[k];
        if (p && p.telegram) {
          rows.push([p.username, p.fullName || '', p.followers ?? '', p.telegram ?? '', new Date(p.checkedAt).toISOString()]);
        }
      }
    }
    if (rows.length <= 1) {
      alert('В базе пока нет профилей с Telegram для экспорта.');
      return;
    }
    function csvEscape(v) {
      if (v == null) return '';
      const s = String(v).replace(/"/g, '""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    }
    const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ig_tg_leads_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---------- боковая панель фильтров (сбоку от модалки) ----------
  let filterState = {
    minFollowers: 0,
    showTg: true,
    showNoTg: true,
    showUnchecked: true,
    showVisited: true,
  };

  // Мин. подписчики хранится в storage: значение живёт между вкладками/сессиями,
  // видно фоновым вкладкам автопроверки и самому боту (он тоже режет тех, кто ниже).
  // Пока сам не поменяешь — будет стоять то, что выставил.
  chrome.storage.local.get('igx_min_followers', (d) => {
    filterState.minFollowers = parseInt(d.igx_min_followers, 10) || 0;
  });

  let sidePanelEl = null;

  // Пользовательская позиция панели (перетаскивание). Храним, чтобы не сбрасывалась.
  let panelCustomPos = null;
  chrome.storage.local.get('igx_panel_pos', (d) => {
    if (d && d.igx_panel_pos) panelCustomPos = d.igx_panel_pos;
  });

  // Перетаскивание панели за шапку. Позиция сохраняется в storage.
  function initPanelDrag() {
    const head = sidePanelEl.querySelector('.igx-side-head');
    if (!head || head.dataset.igxDragInit) return;
    head.dataset.igxDragInit = '1';
    head.classList.add('igx-draggable');

    const resetBtn = sidePanelEl.querySelector('.igx-pos-reset');
    if (resetBtn) {
      resetBtn.addEventListener('mousedown', (e) => e.stopPropagation());
      resetBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        panelCustomPos = null;
        chrome.storage.local.remove('igx_panel_pos');
      });
    }

    let dragging = null;
    head.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const r = sidePanelEl.getBoundingClientRect();
      dragging = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      sidePanelEl.classList.add('is-dragging');
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging || !sidePanelEl) return;
      const x = Math.min(Math.max(0, e.clientX - dragging.dx), Math.max(0, window.innerWidth - 120));
      const y = Math.min(Math.max(0, e.clientY - dragging.dy), Math.max(0, window.innerHeight - 50));
      sidePanelEl.style.left = `${Math.round(x)}px`;
      sidePanelEl.style.top = `${Math.round(y)}px`;
      sidePanelEl.style.right = 'auto';
      panelCustomPos = { x: Math.round(x), y: Math.round(y) };
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = null;
      if (sidePanelEl) sidePanelEl.classList.remove('is-dragging');
      if (panelCustomPos) chrome.storage.local.set({ igx_panel_pos: panelCustomPos });
    });
  }

  function syncSidePanel() {
    const dialog = document.querySelector('[role="dialog"]');
    document.querySelectorAll('.igx-filterbar').forEach((b) => b.remove());

    if (!dialog) {
      if (sidePanelEl) sidePanelEl.style.display = 'none';
      return;
    }

    if (!sidePanelEl) {
      sidePanelEl = document.createElement('div');
      sidePanelEl.className = 'igx-side-panel';
      sidePanelEl.innerHTML = `
        <div class="igx-side-head">
          <div class="igx-side-title">⚡ IG Lead Scout</div>
          <span class="igx-side-badge">Active</span>
          <button type="button" class="igx-pos-reset" title="Сбросить позицию панели (вернётся к модалке)">⟲</button>
        </div>

        <div class="igx-side-section">
          <button type="button" class="igx-btn-autocheck">⚡ Автопроверка списка</button>
          <div class="igx-afk-row">
            <label class="igx-afk-chk" title="АФК-режим: запускается кнопкой «⚡ Автопроверка списка». Сам листает подписчиков до конца, чекает всех, затем переходит к самому популярному челу в его подписчиков, вводит слово из поля в поиск — и так по кругу">
              <input type="checkbox" class="igx-chk-afk" />
              АФК
            </label>
            <input type="text" class="igx-afk-word" placeholder="слово для поиска" />
          </div>
          <label class="igx-autoopen-chk" title="При проверке эксперта автоматически открывать найденную ссылку ТГ в приложении Телеграм. Выключи, если не хочешь чтобы оно само открывало">
            <input type="checkbox" class="igx-chk-autoopen" checked />
            Автооткрывать ТГ при проверке
          </label>
          <button type="button" class="igx-btn-ocr" title="Извлечь из самого видимого видео хук (первые секунды) и призыв (последние секунды) — текстом с экрана или речью из звука, и скопировать в буфер">📝 Хук и призыв из видео</button>
        </div>

        <div class="igx-side-section">
          <div class="igx-side-label">Фильтры отображения</div>
          <div class="igx-side-chips">
            <label class="igx-filter-chip chip-tg">
              <input type="checkbox" class="igx-chk-tg" ${filterState.showTg ? 'checked' : ''} />
              🟩 ✅ С Telegram (зелёные)
            </label>
            <label class="igx-filter-chip chip-no-tg">
              <input type="checkbox" class="igx-chk-no-tg" ${filterState.showNoTg ? 'checked' : ''} />
              🟦 ❌ Без TG / Не подошли (синие)
            </label>
            <label class="igx-filter-chip chip-un">
              <input type="checkbox" class="igx-chk-un" ${filterState.showUnchecked ? 'checked' : ''} />
              ⬜ ⚡ Не проверенные (новые)
            </label>
            <label class="igx-filter-chip chip-vis">
              <input type="checkbox" class="igx-chk-vis" ${filterState.showVisited ? 'checked' : ''} />
              👁️ Посещённые
            </label>
          </div>
        </div>

        <div class="igx-side-section">
          <div class="igx-side-input-row">
            <span>Мин. подписчиков:</span>
            <input type="number" min="0" placeholder="0" class="igx-min-followers" value="${filterState.minFollowers || ''}" />
          </div>
        </div>

        <div class="igx-side-stats">
          <div>Показано: <b class="igx-st-vis">0</b> из <b class="igx-st-total">0</b></div>
          <div>🟩 Подходящих (TG): <b class="igx-st-tg">0</b></div>
          <div>🟦 Проверенных / Без TG: <b class="igx-st-notg">0</b></div>
          <div>⬜ Новых: <b class="igx-st-un">0</b></div>
        </div>

        <div class="igx-side-buttons">
          <button type="button" class="igx-btn-csv">📥 Скачать CSV</button>
          <button type="button" class="igx-btn-reset">Сбросить</button>
        </div>
      `;

      document.body.appendChild(sidePanelEl);

      // События
      sidePanelEl.querySelector('.igx-chk-tg').addEventListener('change', (e) => {
        filterState.showTg = e.target.checked;
        debouncedApplyFilters();
      });
      sidePanelEl.querySelector('.igx-chk-no-tg').addEventListener('change', (e) => {
        filterState.showNoTg = e.target.checked;
        debouncedApplyFilters();
      });
      sidePanelEl.querySelector('.igx-chk-un').addEventListener('change', (e) => {
        filterState.showUnchecked = e.target.checked;
        debouncedApplyFilters();
      });
      sidePanelEl.querySelector('.igx-chk-vis').addEventListener('change', (e) => {
        filterState.showVisited = e.target.checked;
        debouncedApplyFilters();
      });
      sidePanelEl.querySelector('.igx-min-followers').addEventListener('input', (e) => {
        filterState.minFollowers = parseInt(e.target.value, 10) || 0;
        // Сохраняем навсегда: пока сам не поменяешь — порог будет стоять.
        chrome.storage.local.set({ igx_min_followers: filterState.minFollowers });
        debouncedApplyFilters();
      });
      sidePanelEl.querySelector('.igx-btn-autocheck').addEventListener('click', async () => {
        const chk = sidePanelEl.querySelector('.igx-chk-afk');
        const afkOn = chk && chk.checked;
        if (afkOn) {
          if (afkBusy || (await afkRunning())) {
            await afkStop('остановлено вручную.');
          } else {
            try {
              await startAfk();
            } catch (err) {
              showTooltip(`АФК: ${(err && err.message) || err}`, sidePanelEl);
              setTimeout(hideTooltip, 6000);
            }
          }
          return;
        }
        startBatchCheck();
      });

      // АФК: слово сохраняется в состояние; снять галочку во время работы = стоп.
      const afkWord = sidePanelEl.querySelector('.igx-afk-word');
      const afkChk = sidePanelEl.querySelector('.igx-chk-afk');
      afkGetState().then((st) => {
        if (!st) return;
        // Галочку не восстанавливаем из storage — иначе кнопка всегда запускает АФК, а не проверку списка.
        if (afkWord && st.word) afkWord.value = st.word;
      });
      afkWord.addEventListener('input', async (e) => {
        await afkPatchState({ word: e.target.value });
      });
      afkChk.addEventListener('change', async (e) => {
        if (!e.target.checked && (await afkRunning())) await afkStop('остановлено галочкой.');
      });

      // Автооткрытие ТГ при проверке (по умолчанию включено).
      const autoChk = sidePanelEl.querySelector('.igx-chk-autoopen');
      chrome.storage.local.get('igx_auto_open_tg', (d) => {
        autoChk.checked = d.igx_auto_open_tg !== false;
      });
      autoChk.addEventListener('change', (e) => {
        chrome.storage.local.set({ igx_auto_open_tg: e.target.checked });
      });
      sidePanelEl.querySelector('.igx-btn-csv').addEventListener('click', () => {
        exportLeadsCSV();
      });
      sidePanelEl.querySelector('.igx-btn-ocr').addEventListener('click', () => {
        openOcrPopup(sidePanelEl);
      });
      sidePanelEl.querySelector('.igx-btn-reset').addEventListener('click', () => {
        filterState.showTg = true;
        filterState.showNoTg = true;
        filterState.showUnchecked = true;
        filterState.showVisited = true;
        filterState.minFollowers = 0;
        chrome.storage.local.set({ igx_min_followers: 0 });
        sidePanelEl.querySelector('.igx-chk-tg').checked = true;
        sidePanelEl.querySelector('.igx-chk-no-tg').checked = true;
        sidePanelEl.querySelector('.igx-chk-un').checked = true;
        sidePanelEl.querySelector('.igx-chk-vis').checked = true;
        sidePanelEl.querySelector('.igx-min-followers').value = '';
        debouncedApplyFilters();
      });

      initPanelDrag();
    }

    // Позиционирование: если панель перетащили — держим её там, где поставили.
    if (panelCustomPos) {
      const x = Math.min(panelCustomPos.x, Math.max(0, window.innerWidth - 140));
      const y = Math.min(panelCustomPos.y, Math.max(0, window.innerHeight - 60));
      sidePanelEl.style.left = `${x}px`;
      sidePanelEl.style.top = `${y}px`;
      sidePanelEl.style.right = 'auto';
      sidePanelEl.style.display = 'flex';
      return;
    }

    // Иначе — сбоку от модалки
    const modalBox = dialog.querySelector('div:has(input[placeholder]), [role="dialog"] > div > div') || dialog;
    const rect = modalBox.getBoundingClientRect();
    const panelWidth = 260;

    if (rect.right + panelWidth + 20 < window.innerWidth) {
      sidePanelEl.style.top = `${Math.max(20, Math.min(rect.top, window.innerHeight - 440))}px`;
      sidePanelEl.style.left = `${Math.round(rect.right + 14)}px`;
      sidePanelEl.style.right = 'auto';
    } else if (rect.left - panelWidth - 20 > 0) {
      sidePanelEl.style.top = `${Math.max(20, Math.min(rect.top, window.innerHeight - 440))}px`;
      sidePanelEl.style.left = `${Math.round(rect.left - panelWidth - 14)}px`;
      sidePanelEl.style.right = 'auto';
    } else {
      sidePanelEl.style.top = '80px';
      sidePanelEl.style.right = '16px';
      sidePanelEl.style.left = 'auto';
    }

    sidePanelEl.style.display = 'flex';
  }

  setInterval(syncSidePanel, 500);

  let filterTimeout = null;
  function debouncedApplyFilters() {
    clearTimeout(filterTimeout);
    filterTimeout = setTimeout(applyFilters, 150);
  }

  function applyFilters() {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return;
    const links = dialog.querySelectorAll('a[href]');
    const seenRows = new Set();

    let countTgNew = 0;
    let countTgViewed = 0;
    let countChecked = 0;
    let countUnchecked = 0;
    let totalVisible = 0;
    let totalCount = 0;

    const minF = filterState.minFollowers || 0;

    for (const link of links) {
      const username = extractUsername(link);
      if (!username) continue;
      const row = findUserRow(link);
      if (!row || seenRows.has(row)) continue;
      seenRows.add(row);
      totalCount++;

      const avatarBox = row.querySelector('.igx-badge-wrap')?.parentElement;
      if (avatarBox) {
        refreshRowStatus(username, avatarBox, row);
      }

      // Данные берём из кэша (он поддерживается storage.onChanged), а не из
      // chrome.storage на каждую строку — раньше именно это лагало на списках.
      const p = profileCache.get(username.toLowerCase()) || null;
      const viewed = viewedCache.has(username.toLowerCase());

      const hasTg = !!(p && p.telegram);
      const meetsFollowers = minF <= 0 || (p && p.followers != null && p.followers >= minF);
      const isNewTg = hasTg && meetsFollowers && !viewed;
      const isViewedTg = hasTg && meetsFollowers && viewed;
      const isOtherChecked = p && (!hasTg || !meetsFollowers);
      const isVisOnly = !p && viewed;
      const isUn = !p && !viewed;

      if (isNewTg) countTgNew++;
      else if (isViewedTg) countTgViewed++;
      else if (isOtherChecked || isVisOnly) countChecked++;
      else countUnchecked++;

      let visible = true;

      // Фильтрация по типам
      if (isNewTg && !filterState.showTg) visible = false;
      if (isViewedTg && !filterState.showTg && !filterState.showVisited) visible = false;
      if (isOtherChecked && !filterState.showNoTg) visible = false;
      if (isVisOnly && !filterState.showVisited) visible = false;
      if (isUn && !filterState.showUnchecked) visible = false;

      // Прячем строку только через visibility, не меняя её высоту/место в списке.
      // Если убрать высоту (display:none / height:0), Instagram решает, что место
      // освободилось, и начинает бесконечно догружать/перерисовывать строки
      // (список "мигает" случайными людьми).
      if (visible) {
        totalVisible++;
        row.style.visibility = '';
        row.style.pointerEvents = '';
      } else {
        row.style.visibility = 'hidden';
        row.style.pointerEvents = 'none';
      }
    }

    // Обновление сводки в боковой панели
    if (sidePanelEl) {
      const stVis = sidePanelEl.querySelector('.igx-st-vis');
      const stTotal = sidePanelEl.querySelector('.igx-st-total');
      const stTg = sidePanelEl.querySelector('.igx-st-tg');
      const stNoTg = sidePanelEl.querySelector('.igx-st-notg');
      const stUn = sidePanelEl.querySelector('.igx-st-un');

      if (stVis) stVis.textContent = totalVisible;
      if (stTotal) stTotal.textContent = totalCount;
      if (stTg) stTg.textContent = `${countTgNew} нов. (${countTgViewed} просм.)`;
      if (stNoTg) stNoTg.textContent = countChecked;
      if (stUn) stUn.textContent = countUnchecked;
    }
  }
})();
