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
    // Делегируем общему разбору компактных чисел: прежняя реализация ломала английские
    // разряды («1,234» превращалось в 1, потому что запятая считалась десятичной).
    return parseCompactCount(raw);
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

  // Сканирование каруселей со слайдами (добавляем кнопки извлечения слайдов и копирования данных)
  function scanForCarousels(root = document) {
    try {
      const uls = root.querySelectorAll('ul._acay, ul[class*="acay"]');
      uls.forEach((ul) => {
        const container = ul.closest('div._aatk, div._aamw, div[class*="_aatk"]') || ul.parentElement;
        if (!container || container.querySelector('.igx-carousel-bar')) return;

        const bar = document.createElement('div');
        bar.className = 'igx-carousel-bar';
        bar.innerHTML =
          '<button type="button" class="igx-carousel-copy-meta" title="Скопировать данные карусели (дни, просмотры, лайки, комментарии, репосты, описание)">📋 Данные</button>' +
          '<button type="button" class="igx-carousel-ocr" title="Извлечь текст из слайдов карусели">📝 Слайды</button>';
        container.appendChild(bar);

        const ocrBtn = bar.querySelector('.igx-carousel-ocr');
        if (ocrBtn) {
          ocrBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openOcrPopup('carousel');
          });
          ocrBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
          ocrBtn.addEventListener('mousedown', (e) => e.stopPropagation());
        }

        const copyBtn = bar.querySelector('.igx-carousel-copy-meta');
        if (copyBtn) {
          copyBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            try {
              const article = findPostArticle(container);
              const postMeta = extractInstagramPostData(article || container);
              const metaStr = formatPostDataText(postMeta);
              // Пустой результат (нет ни одного поля) буфером обмена не затираем.
              if (!metaStr) {
                copyBtn.textContent = '∅';
                setTimeout(() => {
                  copyBtn.textContent = '📋 Данные';
                }, 2000);
                return;
              }
              const ok = await copyToClipboard(metaStr);
              if (ok) {
                copyBtn.textContent = '✓ Скопировано';
                setTimeout(() => {
                  copyBtn.textContent = '📋 Данные';
                }, 2000);
              }
            } catch (_) {}
          });
          copyBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
          copyBtn.addEventListener('mousedown', (e) => e.stopPropagation());
        }
      });
    } catch (_) {}
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
        // Ролик выпал из DOM: снимаем полоску, слушатели и метку data-igx-seek.
        // Без снятия метки ИГ, переиспользуя тот же <video>, оставлял полоску без
        // перерисовки навсегда: scanForVideos ищет только video:not([data-igx-seek]).
        try {
          item.destroy?.();
        } catch (_) {}
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
    try {
      if (!video.crossOrigin) video.crossOrigin = 'anonymous';
    } catch (_) {}
    // Метку ставим ТОЛЬКО когда полоска реально создана: иначе видео (например, до
    // появления document.body) навсегда помечалось бы как обработанное без полоски.
    if (!document.body) return;
    video.dataset.igxSeek = '1';

    const bar = document.createElement('div');
    bar.className = 'igx-seekbar';
    bar.innerHTML =
      '<div class="igx-seek-track"><div class="igx-seek-fill"></div><div class="igx-seek-knob"></div></div>' +
      '<span class="igx-seek-time">0:00 / 0:00</span>' +
      '<button type="button" class="igx-seek-copy-meta" title="Скопировать данные ролика (дни, просмотры, лайки, комменты, репосты, описание)">📋</button>';
    document.body.appendChild(bar);

    const copyMetaSeekBtn = bar.querySelector('.igx-seek-copy-meta');
    if (copyMetaSeekBtn) {
      const handleCopyMeta = async (e) => {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
          if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        }
        try {
          const media = detectCurrentPostMedia();
          const scope = (media && media.scope) || video.closest('article, [role="dialog"], main, section') || document;
          const postMeta = extractInstagramPostData(scope);
          const metaStr = formatPostDataText(postMeta);
          // Данных не нашлось ни по одному полю: буфер обмена не трогаем —
          // иначе затрём его пустой строкой.
          if (!metaStr) {
            copyMetaSeekBtn.textContent = '∅';
            setTimeout(() => {
              copyMetaSeekBtn.textContent = '📋';
            }, 2000);
            return;
          }
          const ok = await copyToClipboard(metaStr);
          if (ok) {
            copyMetaSeekBtn.textContent = '✓';
            setTimeout(() => {
              copyMetaSeekBtn.textContent = '📋';
            }, 2000);
          }
        } catch (err) {
          console.warn('[Insta] copy metadata failed:', err);
        }
      };
      copyMetaSeekBtn.addEventListener('click', handleCopyMeta);
      copyMetaSeekBtn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      });
      copyMetaSeekBtn.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      });
    }

    const track = bar.querySelector('.igx-seek-track');
    const fill = bar.querySelector('.igx-seek-fill');
    const knob = bar.querySelector('.igx-seek-knob');
    const timeEl = bar.querySelector('.igx-seek-time');
    let dragging = false;
    let seekSeq = 0; // инкремент отменяет старые цепочки доводки перемотки — иначе они дерутся между собой и возвращают видео назад

    const seekItem = { video, bar, destroy: null };
    igxSeekRegistry.add(seekItem);
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

    // Проверяем, попал ли клик в нашу кнопку копирования метаданных
    const isSpecialBtn = (e) => {
      if (!e) return false;
      const t = e.target;
      if (copyMetaSeekBtn && (t === copyMetaSeekBtn || copyMetaSeekBtn.contains(t))) return true;
      if (copyMetaSeekBtn && copyMetaSeekBtn.isConnected) {
        const rc = copyMetaSeekBtn.getBoundingClientRect();
        if (rc.width > 0 && e.clientX >= rc.left && e.clientX <= rc.right && e.clientY >= rc.top && e.clientY <= rc.bottom) {
          return true;
        }
      }
      return false;
    };

    // События ловим НА УРОВНЕ ОКНА в фазе захвата (раньше любых обработчиков ИГ).
    // «Наше» событие = либо попало в DOM полоски, либо пришло в её прямоугольник координатами —
    // так его не перехватит даже невидимый оверлей ИГ, лежащий поверх.
    const owns = (e) => {
      if (bar.style.display === 'none') return false;
      if (isSpecialBtn(e)) return false; // кнопка копирования обрабатывает события сама
      if (e.target && bar.contains(e.target)) return true;
      const r = bar.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    };

    const onDown = (e) => {
      if (isSpecialBtn(e)) return;
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
      if (now - lastDragSeekAt > 140 && lastTargetT != null && isFinite(video.duration) && video.duration > 0) {
        lastDragSeekAt = now;
        try {
          video.currentTime = lastTargetT;
        } catch (_) {}
      }
    };
    const onUp = (e) => {
      if (isSpecialBtn(e)) return;
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
      if (isSpecialBtn(e)) return;
      // чтобы ИГ не ставил паузу/плей по клику через нашу полоску
      if (!owns(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('click', onClick, true);

    // Снятие всего, что повесили выше. Вызывается из igxSeekFrame, когда видео
    // больше нет в DOM (ИГ пересоздаёт узлы ленты при скролле).
    seekItem.destroy = () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('click', onClick, true);
      video.removeEventListener('timeupdate', sync);
      video.removeEventListener('durationchange', sync);
      video.removeEventListener('loadedmetadata', sync);
      delete video.dataset.igxSeek;
    };
  }

  // ---------- извлечение текста из видео / слайдов (хук + призыв) ----------
  // Кнопки 📝 в боковой панели и на карусели: снимаем кадры первых и последних секунд
  // видео или слайды карусели, прогоняем через Tesseract / Whisper, копируем результат в буфер.
  function safeStorageGet(keys, fallback = {}) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const res = chrome.storage.local.get(keys);
        if (res && typeof res.then === 'function') {
          return res.catch(() => fallback);
        }
        return new Promise((resolve) => {
          try {
            chrome.storage.local.get(keys, (data) => {
              if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) resolve(fallback);
              else resolve(data || fallback);
            });
          } catch (_) {
            resolve(fallback);
          }
        });
      }
    } catch (_) {}
    return Promise.resolve(fallback);
  }

  function safeStorageSet(obj) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const res = chrome.storage.local.set(obj);
        if (res && typeof res.catch === 'function') {
          res.catch(() => {});
        }
      }
    } catch (_) {}
  }

  const OCR_START_KEY = 'igx_ocr_start_sec';
  const OCR_END_KEY = 'igx_ocr_end_sec';
  const OCR_MODE_KEY = 'igx_ocr_mode';
  const OCR_START_SLIDES_KEY = 'igx_ocr_start_slides';
  const OCR_END_SLIDES_KEY = 'igx_ocr_end_slides';
  const OCR_APIKEY_KEY = 'igx_ocr_apikey';
  const OCR_VIDEO_FPS_KEY = 'igx_ocr_video_fps';
  const OCR_INCLUDE_META_KEY = 'igx_ocr_include_meta';
  let igxOcrPop = null;
  let igxActiveMediaType = 'video'; // 'video' или 'carousel'

  // Распознавание крутится в offscreen-документе расширения (Tesseract rus+eng + Whisper / Cloud API)
  function safeSendMessage(msg) {
    return new Promise((resolve, reject) => {
      if (!chrome.runtime || !chrome.runtime.id) {
        return reject(new Error('Расширение было обновлено в браузере. Пожалуйста, обнови страницу Instagram (F5).'));
      }
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) {
            const err = (chrome.runtime.lastError && chrome.runtime.lastError.message) || '';
            if (err.includes('context invalidated')) {
              return reject(new Error('Расширение было обновлено в браузере. Пожалуйста, обнови страницу Instagram (F5).'));
            }
            return reject(new Error(err));
          }
          resolve(res);
        });
      } catch (e) {
        if (String(e).includes('context invalidated')) {
          return reject(new Error('Расширение было обновлено в браузере. Пожалуйста, обнови страницу Instagram (F5).'));
        }
        reject(e);
      }
    });
  }

  async function ocrRecognize(dataUrl, apiKey) {
    const timer = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('Таймаут распознавания кадра (35 с).')), 35000)
    );
    const r = await Promise.race([
      safeSendMessage({ type: 'ocrRecognize', image: dataUrl, apiKey: apiKey || '' }),
      timer,
    ]);
    if (!r) throw new Error('Распознавалка не ответила.');
    if (r.error) throw new Error(r.error);
    return (r.text || '').trim();
  }

  async function ocrRecognizeUrl(url, apiKey) {
    const timer = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('Таймаут распознавания слайда (35 с).')), 35000)
    );
    const r = await Promise.race([
      safeSendMessage({ type: 'ocrRecognizeUrl', url, apiKey: apiKey || '' }),
      timer,
    ]);
    if (!r) throw new Error('Распознавалка не ответила.');
    if (r.error) throw new Error(r.error);
    return (r.text || '').trim();
  }

  async function ocrVideoDirect(url, headTimestamps, tailTimestamps, apiKey) {
    const timer = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('Таймаут прямого распознавания видео (60 с).')), 60000)
    );
    const res = await Promise.race([
      safeSendMessage({ type: 'ocrVideoDirect', url, headTimestamps, tailTimestamps, apiKey: apiKey || '' }),
      timer,
    ]);
    if (!res) throw new Error('Распознавалка не ответила.');
    if (res.error) throw new Error(res.error);
    return { headText: (res.headText || '').trim(), tailText: (res.tailText || '').trim() };
  }

  // ВАЖНО: тип сообщения должен быть «asrRecognize»/«asrRecognizeUrl» (их разбирает
  // background.js и только он гарантирует создание offscreen-документа). С прежними
  // прямыми «asrDo»/«asrDoUrl» речь не работала, если распознавание речи было первым
  // обращением к offscreen: получателя ещё не существовало, приходило
  // «Could not establish connection».
  async function asrRecognize(base64, apiKey) {
    const timer = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('Таймаут распознавания речи (60 с).')), 60000)
    );
    const r = await Promise.race([
      safeSendMessage({ type: 'asrRecognize', audio: base64, apiKey: apiKey || '' }),
      timer,
    ]);
    if (!r) throw new Error('Распознавалка речи не ответила.');
    if (r.error) throw new Error(r.error);
    return (r.text || '').trim();
  }

  async function asrRecognizeUrl(url, headTo, tailFrom, tailTo, apiKey) {
    const timer = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('Таймаут распознавания речи (120 с).')), 120000)
    );
    const r = await Promise.race([
      safeSendMessage({ type: 'asrRecognizeUrl', url, headTo, tailFrom, tailTo, apiKey: apiKey || '' }),
      timer,
    ]);
    if (!r) throw new Error('Распознавалка речи не ответила.');
    if (r.error) throw new Error(r.error);
    return { headText: (r.headText || '').trim(), tailText: (r.tailText || '').trim() };
  }

  // Поиск прямого HTTP URL видео с очисткой параметров сегментации (bytestart/byteend)
  function findVideoUrl(video) {
    if (!video) return null;
    const cleanUrl = (u) => {
      if (!u || !u.startsWith('http') || !u.includes('.mp4')) return null;
      try {
        const parsed = new URL(u);
        parsed.searchParams.delete('bytestart');
        parsed.searchParams.delete('byteend');
        return parsed.toString();
      } catch (_) {
        return u.replace(/[?&]bytestart=\d+/g, '').replace(/[?&]byteend=\d+/g, '');
      }
    };

    const src = cleanUrl(video.currentSrc || video.src);
    if (src) return src;

    const sourceEl = video.querySelector('source');
    if (sourceEl) {
      const sSrc = cleanUrl(sourceEl.src);
      if (sSrc) return sSrc;
    }
    return null;
  }

  // ---------------- Маскировка всего лишнего перед снимком вкладки ----------------
  // Наш собственный интерфейс (полоска таймкода с кнопкой 📋, полоска карусели,
  // попап OCR, панель) и оверлеи плеера Instagram попадают в снимок вкладки и раньше
  // распознавались как текст — прямо в коде видно, как filterCleanTextLines отдельно
  // вырезает строки вида «0:00 / 1:07», т.е. таймер нашей же полоски.
  const IGX_OVERLAY_SELECTORS = [
    '.igx-seekbar',
    '.igx-carousel-bar',
    '.igx-ocr-pop',
    '.igx-side-panel',
    '.igx-tooltip',
    '.igx-link-menu',
  ];

  // Оверлеи самого Instagram внутри области поста (те же, что прячет captureRange)
  const IGX_IG_OVERLAY_SELECTORS = [
    'svg[aria-label="Play"]',
    'svg[aria-label="Воспроизвести"]',
    '[aria-label*="Play"]',
    '[aria-label*="Воспроизвести"]',
    'div._9zs5',
    'div._aae-',
    'div[role="progressbar"]',
    'div._ab6-',
    'div._aamz',
  ];

  // Прячет наш UI и оверлеи плеера на время снимка. Возвращает функцию восстановления
  // (вызывать её обязательно в finally/на всех ветках, иначе UI останется невидимым).
  function hideCaptureObstructions(element) {
    const hidden = [];
    const hide = (el, prop, value) => {
      if (!el || !el.style) return;
      if (String(el.style[prop]) === String(value)) return;
      const prev = el.style[prop];
      el.style[prop] = value;
      hidden.push({ el, prop, prev });
    };

    // 1. Наш интерфейс — целиком (иначе таймер полоски снова уедет в OCR)
    IGX_OVERLAY_SELECTORS.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        hide(el, 'visibility', 'hidden');
        // Попап OCR прячем только прозрачностью: он перетаскиваемый, и лишние
        // правки его стилей ни к чему.
        if (!el.classList || !el.classList.contains('igx-ocr-pop')) hide(el, 'opacity', '0');
      });
    });

    // 2. Оверлеи плеера Instagram в области поста
    const root =
      (element && element.closest && element.closest('article, [role="dialog"], div._aatk, div._aamw, div._ab6-')) ||
      document.body;
    IGX_IG_OVERLAY_SELECTORS.forEach((sel) => {
      root.querySelectorAll(sel).forEach((el) => {
        const b = el.closest('button, [role="button"]') || el;
        hide(b, 'display', 'none');
      });
    });

    // 3. Текстовый таймер плеера Instagram (0:00 / 1:07)
    root.querySelectorAll('div, span').forEach((el) => {
      const t = (el.innerText || el.textContent || '').trim();
      if (/^\d{1,2}:\d{2}\s*(?:\/|из|of)\s*\d{1,2}:\d{2}$/.test(t) && el.children.length === 0) {
        hide(el, 'display', 'none');
      }
    });

    return () => {
      hidden.forEach(({ el, prop, prev }) => {
        try { el.style[prop] = prev; } catch (_) {}
      });
      hidden.length = 0;
    };
  }

  // Прямой снимок кадра через Canvas без вызова captureVisibleTab (если нет CORS-блокировки).
  // Это ЧИСТЫЙ кадр: без оверлеев Instagram и без нашего UI, поэтому он всегда предпочтительнее.
  function captureVideoDirectCanvas(video) {
    try {
      if (!video || !video.videoWidth || !video.videoHeight) return null;
      const cnv = document.createElement('canvas');
      cnv.width = video.videoWidth;
      cnv.height = video.videoHeight;
      const ctx = cnv.getContext('2d');
      ctx.drawImage(video, 0, 0, cnv.width, cnv.height);
      return cnv.toDataURL('image/jpeg', 0.92);
    } catch (_) {
      return null;
    }
  }

  // Чистый кадр элемента поста (слайда или видео): с <video> сначала пробуем canvas,
  // и только если он недоступен (taint/CORS) — снимок вкладки как фолбэк.
  // Никакой перемотки: кадр берётся как есть, поэтому функция безопасна для карусели.
  async function captureElementClean(el) {
    if (!el) return null;
    if (el.tagName === 'VIDEO') {
      const direct = captureVideoDirectCanvas(el);
      if (direct) return direct;
    }
    try {
      return await captureVideoViaTab(el);
    } catch (e) {
      console.warn('Снимок элемента не удался:', e);
      return null;
    }
  }

  // Захват кадра через снимок вкладки с точным масштабированием (фолбэк).
  // Перед снимком прячем СВОЙ UI (полоска таймкода с 📋, полоска карусели, попап OCR)
  // и оверлеи плеера Instagram, после — возвращаем всё как было.
  function captureVideoViaTab(element) {
    return new Promise((resolve, reject) => {
      const restore = hideCaptureObstructions(element);
      requestAnimationFrame(() => {
        safeSendMessage({ type: 'captureTab' })
          .then((res) => {
            // Снимок уже сделан — сразу возвращаем интерфейс на место
            restore();
            if (!res || !res.dataUrl) {
              return reject(new Error((res && res.error) || 'Снимок вкладки не удался.'));
            }
            const img = new Image();
            img.onload = () => {
              try {
                const r = element.getBoundingClientRect();
                const scaleX = img.naturalWidth / window.innerWidth;
                const scaleY = img.naturalHeight / window.innerHeight;

                const sx = Math.max(0, Math.round(r.left * scaleX));
                const sy = Math.max(0, Math.round(r.top * scaleY));
                const sw = Math.min(img.naturalWidth - sx, Math.max(1, Math.round(r.width * scaleX)));
                const sh = Math.min(img.naturalHeight - sy, Math.max(1, Math.round(r.height * scaleY)));

                if (sw <= 0 || sh <= 0) {
                  return reject(new Error('Элемент за пределами видимой области экрана.'));
                }

                // Раньше длинная сторона ужималась до 1280 px — мелкий стилизованный текст
                // рилсов после такого даунскейла Tesseract уже не разбирал. Теперь ориентир
                // 1600 px, апскейл разрешён (но не выше 2x, чтобы не раздувать кадры).
                const scale = Math.max(0.3, Math.min(2.0, 1600 / Math.max(sw, sh)));
                const cropCnv = document.createElement('canvas');
                cropCnv.width = Math.max(1, Math.round(sw * scale));
                cropCnv.height = Math.max(1, Math.round(sh * scale));
                const cropCtx = cropCnv.getContext('2d');
                cropCtx.imageSmoothingEnabled = true;
                cropCtx.imageSmoothingQuality = 'high';
                cropCtx.drawImage(img, sx, sy, sw, sh, 0, 0, cropCnv.width, cropCnv.height);
                resolve(cropCnv.toDataURL('image/jpeg', 0.94));
              } catch (e) {
                reject(e);
              }
            };
            img.onerror = (e) => {
              restore();
              reject(e);
            };
            img.src = res.dataUrl;
          })
          .catch((err) => {
            restore();
            reject(err);
          });
      });
    });
  }

  function videoSeekTo(video, t) {
    return new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        video.removeEventListener('seeked', onSeeked);
        clearTimeout(timer);
        setTimeout(resolve, 200);
      };
      const onSeeked = () => done();
      const timer = setTimeout(done, 600);
      video.addEventListener('seeked', onSeeked, { once: true });
      try {
        // Защита от перескока в конец: отступаем 0.25 с от конца видео,
        // чтобы Instagram не триггерил авто-луп в 0:00 и экран повтора
        const maxSeek = Math.max(0.02, (video.duration || 10) - 0.25);
        const target = Math.min(maxSeek, Math.max(0.02, t));
        video.currentTime = target;
      } catch (_) {
        done();
      }
    });
  }

  function getRangeTimestamps(from, to, fpsLevel) {
    const dur = Math.max(0.1, to - from);
    const stepMap = {
      1: 2.5,
      2: 1.5,
      3: 1.0,
      4: 0.5,
      5: 0.3,
    };
    const step = stepMap[fpsLevel] || 1.0;
    const timestamps = [];

    // Первый кадр в начале диапазона
    const first = Math.round((from + 0.1) * 10) / 10;
    timestamps.push(first);

    let cur = from + step;
    while (cur < to - 0.05) {
      timestamps.push(Math.round(cur * 10) / 10);
      cur += step;
    }

    const last = Math.round(Math.max(from + 0.1, to - 0.1) * 10) / 10;
    if (!timestamps.includes(last)) timestamps.push(last);

    return Array.from(new Set(timestamps)).sort((a, b) => a - b);
  }

  async function captureRange(video, from, to, fpsLevel, statusEl, label) {
    const frames = [];
    const timestamps = getRangeTimestamps(from, to, fpsLevel);

    try {
      video.scrollIntoView?.({ block: 'center', behavior: 'instant' });
    } catch (_) {}

    // Временно скрываем оверлеи паузы/воспроизведения, полосы прогресса и таймер плеера Instagram
    // Временно скрываем наш UI и оверлеи паузы/воспроизведения, полосы прогресса
    // и таймер плеера Instagram — общий помощник, тот же прячет UI в снимке вкладки.
    const restoreObstructions = hideCaptureObstructions(video);
    try {
      let lastFrame = null;
      for (let i = 0; i < timestamps.length; i++) {
        const t = timestamps[i];
        if (statusEl) {
          statusEl.textContent = `Снимаю кадр ${label} (${i + 1}/${timestamps.length}, ${t.toFixed(1)} с)…`;
        }
        await videoSeekTo(video, t);
        // Чистый кадр (canvas с <video>) в приоритете, снимок вкладки — фолбэк
        const frame = await captureElementClean(video);
        if (frame && frame !== lastFrame) {
          frames.push(frame);
          lastFrame = frame;
        }
      }
    } finally {
      restoreObstructions();
    }
    return frames;
  }

  function compactOcrText(s) {
    const input = Array.isArray(s) ? s.join('\n') : String(s || '');
    const rawLines = input
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => {
        // Отсекаем оверлеи таймеров плеера 0:00 / 1:07
        if (/^\d{1,2}:\d{2}\s*(?:\/|из|of)\s*\d{1,2}:\d{2}$/.test(l)) return false;
        if (l.length <= 1 && !/[\p{L}\p{N}]/u.test(l)) return false;
        return true;
      });

    const unique = [];
    const seen = new Set();
    for (const l of rawLines) {
      const key = l.toLowerCase().replace(/\s+/g, ' ');
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(l);
      }
    }

    // Удаляем обрывочные строки анимации печатной машинки (префиксы более длинных фраз)
    const finalLines = [];
    for (let i = 0; i < unique.length; i++) {
      const a = unique[i];
      const aNorm = a.toLowerCase().replace(/\s+/g, ' ');
      let isSub = false;
      for (let j = 0; j < unique.length; j++) {
        if (i === j) continue;
        const bNorm = unique[j].toLowerCase().replace(/\s+/g, ' ');
        if (bNorm.length > aNorm.length && bNorm.includes(aNorm)) {
          isSub = true;
          break;
        }
      }
      if (!isSub) {
        const validShort = new Set(['в', 'и', 'с', 'к', 'у', 'о', 'а', 'не', 'на', 'по', 'за', 'из', 'от', 'до', 'об']);
        if (aNorm.length <= 2 && !validShort.has(aNorm) && !/^\d+$/.test(aNorm)) {
          continue;
        }
        finalLines.push(a);
      }
    }

    return finalLines.join('\n');
  }

  // Поиск встроенных субтитров Instagram в DOM
  function findReelsCaptionText(scope) {
    if (!scope) return '';
    const candidates = scope.querySelectorAll(
      'div[data-testid*="caption"], div[class*="caption"], div[class*="subtitle"], span[class*="caption"]'
    );
    const texts = [];
    for (const el of candidates) {
      const txt = (el.innerText || '').trim();
      if (txt && txt.length > 2 && !txt.includes('Follow') && !txt.includes('Подписаться')) {
        texts.push(txt);
      }
    }
    return texts.join(' ').trim();
  }

  // Самое видимое видео на экране
  function pickBestVideo() {
    let best = null;
    let bestArea = 0;
    document.querySelectorAll('video').forEach((v) => {
      if (!isFinite(v.duration) || v.duration <= 0.5) return;
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

  // Поиск статьи (article) текущего поста
  function findPostArticle(scope) {
    if (scope && scope !== document && scope !== document.body) {
      if (scope.tagName === 'ARTICLE') return scope;
      const art = scope.closest?.('article');
      if (art) return art;
      const innerArt = scope.querySelector?.('article');
      if (innerArt) return innerArt;
    }

    // 1. Модальное окно поста (если пост открыт во всплывающем окне)
    const dialogArt = document.querySelector('[role="dialog"] article, [role="dialog"]');
    if (dialogArt) return dialogArt;

    // 2. Если на экране активно играет/виден рилс или видео
    const bestVid = pickBestVideo();
    if (bestVid) {
      const art = bestVid.closest('article, [role="dialog"], main, section');
      if (art) return art;
    }

    // 3. Если есть карусель в области видимости
    const acays = document.querySelectorAll('ul._acay, ul[class*="acay"]');
    for (const ul of acays) {
      const r = ul.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.bottom > 0) {
        const art = ul.closest('article, [role="dialog"], main, section');
        if (art) return art;
      }
    }

    // 4. Поиск наиболее видимой статьи (article) в области просмотра
    let bestArt = null;
    let maxArea = 0;
    document.querySelectorAll('article').forEach((art) => {
      const r = art.getBoundingClientRect();
      const visW = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
      const visH = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
      const area = visW > 0 && visH > 0 ? visW * visH : 0;
      if (area > maxArea) {
        maxArea = area;
        bestArt = art;
      }
    });
    if (bestArt) return bestArt;

    return document.querySelector('article') || document.body;
  }

  // Поиск медиа-контейнера поста (исключая внутренний scroll-viewport div._acaw!)
  function findMediaContainer(scope) {
    const article = findPostArticle(scope);
    const ul = article.querySelector('ul._acay, ul[class*="acay"]');
    if (ul) {
      // Ищем верхний контейнер div._aatk (где живут и стрелки, и точки), а НЕ div._acaw
      const topMedia = ul.closest('div._aatk, div._aamw, div[class*="_aatk"]');
      if (topMedia) return topMedia;
      return ul.parentElement?.parentElement || article;
    }
    const video = article.querySelector('video');
    if (video) {
      const topMedia = video.closest('div._aatk, div._aamw, div[class*="_aatk"]');
      if (topMedia) return topMedia;
      return video.parentElement?.parentElement || article;
    }
    return article.querySelector('div._aatk, div._aamw, div[class*="_aatk"]') || article;
  }

  // Определение типа медиа на текущем посте (видео или карусель со слайдами)
  function detectCurrentPostMedia() {
    const article = findPostArticle();
    const mediaContainer = findMediaContainer(article);
    const scope = mediaContainer || article || document;

    const ul = scope.querySelector?.('ul._acay, ul[class*="acay"]');
    const refRect = getCarouselRefRect(scope);
    const nextBtn = findCarouselNextButton(scope, refRect);
    const prevBtn = findCarouselPrevButton(scope, refRect);
    // Точки карусели ищем ТОЛЬКО внутри контейнера поста, а НЕ по глобальному tablist навигации Instagram!
    const carouselMedia = ul ? (ul.closest('div._aatk, div._aamw') || ul.parentElement) : (scope.querySelector?.('div._aatk, div._aamw') || scope);
    const dots = carouselMedia ? carouselMedia.querySelectorAll('div._acaz, div[role="tablist"] > *, ul._acay > li') : [];
    // Структурные индикаторы и слайд-трек: работают без <article> (лента Reels)
    // и без хешированных классов Instagram.
    const structDots = findSlideDots(scope, refRect);
    const hasSlideTrack = hasHorizontalSlideTrack(scope);
    const video = (scope.querySelector && scope.querySelector('video')) || pickBestVideo();

    // ВАЖНО: карусель проверяем РАНЬШЕ видео. Видео-слайд внутри карусели не должен
    // переводить пост в тип 'video' — иначе включалась видео-ветка с перемоткой видео
    // вместо перелистывания слайдов.
    if (ul || nextBtn || prevBtn || (dots && dots.length > 1) || structDots.length > 1 || hasSlideTrack) {
      const dotsForTotal = structDots.length > 1 ? structDots : Array.from(dots || []);
      let totalSlides = detectSlideTotal(scope, dotsForTotal);
      const textScope = carouselMedia || scope;
      const textContent = textScope ? (textScope.innerText || textScope.textContent || '') : '';
      const textIndicators = textContent.match(/(\d+)\s*(?:\/|из|of)\s*(\d+)/i);
      if (textIndicators && textIndicators[2]) {
        const parsed = parseInt(textIndicators[2], 10);
        if (parsed > 0 && parsed <= 30 && parsed > totalSlides) totalSlides = parsed;
      }
      return {
        type: 'carousel',
        totalSlides: Math.max(2, totalSlides || 10),
        scope: article || carouselMedia || document,
        mediaContainer: carouselMedia,
        video,
      };
    }

    if (video && isFinite(video.duration) && video.duration > 0.5) {
      return {
        type: 'video',
        video,
        scope: article || video.closest('article, [role="dialog"], main') || document,
        mediaContainer: video.parentElement,
      };
    }

    return null;
  }

  // Расчёт временных окон для видео:
  function getVideoWindows(duration, startSec, endSec) {
    const d = Math.max(0.1, duration);
    const s = Math.max(0, Number(startSec) || 0);
    const e = Math.max(0, Number(endSec) || 0);
    let headTo = 0;
    let tailFrom = 0;
    let tailTo = d;

    if (e === 0 && s > 0) {
      headTo = Math.min(s, d);
      tailFrom = d;
      tailTo = d;
    } else if (s === 0 && e > 0) {
      headTo = 0;
      tailFrom = Math.max(0, d - e);
      tailTo = d;
    } else if (s + e > d) {
      const mid = d / 2;
      headTo = mid;
      tailFrom = mid;
      tailTo = d;
    } else {
      headTo = Math.min(s, d);
      tailFrom = Math.max(0, d - e);
      tailTo = d;
    }
    return { headTo, tailFrom, tailTo };
  }

  // Расчёт слайдов для карусели:
  function getSlideWindows(total, startCount, endCount) {
    const n = Math.max(1, total);
    const s = Math.max(0, Math.min(startCount, n));
    const e = Math.max(0, Math.min(endCount, n));
    let headSlides = [];
    let tailSlides = [];

    if (e === 0 && s > 0) {
      for (let i = 1; i <= Math.min(s, n); i++) headSlides.push(i);
    } else if (s === 0 && e > 0) {
      for (let i = Math.max(1, n - e + 1); i <= n; i++) tailSlides.push(i);
    } else if (s + e > n) {
      const mid = Math.ceil(n / 2);
      const headLimit = Math.min(s, Math.max(1, mid));
      for (let i = 1; i <= headLimit; i++) headSlides.push(i);
      for (let i = Math.max(headLimit + 1, n - e + 1); i <= n; i++) tailSlides.push(i);
    } else {
      for (let i = 1; i <= s; i++) headSlides.push(i);
      for (let i = Math.max(1, n - e + 1); i <= n; i++) tailSlides.push(i);
    }
    return { headSlides, tailSlides };
  }

  function isElementVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !el.disabled && el.style.display !== 'none' && el.style.visibility !== 'hidden';
  }

  // ---------------- Навигация по слайдам карусели без хешированных классов ----------------
  // Instagram регулярно меняет хешированные классы (ul._acay / div._acaz / button._afxw),
  // поэтому вся геометрия и структура ниже опирается на layout, role/aria и иконку-шеврон,
  // а классы используются только как необязательная подсказка.

  // Опорный прямоугольник карусели: самое крупное видимое медиа внутри области поста.
  // Нужен, чтобы искать точки и стрелки ВНУТРИ конкретного поста: в ленте Reels <article>
  // нет, и глобальный поиск попадает в навигацию чужих постов или верхнее меню.
  function getCarouselRefRect(scope) {
    const root = (scope && scope.querySelectorAll) ? scope : document;
    let best = null;
    let bestArea = 0;
    const consider = (el) => {
      if (!el || !isElementVisible(el)) return;
      const r = el.getBoundingClientRect();
      const visW = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
      const visH = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
      const area = visW > 0 && visH > 0 ? visW * visH : 0;
      if (area > bestArea) {
        bestArea = area;
        best = el;
      }
    };
    root.querySelectorAll('video').forEach(consider);
    root.querySelectorAll('img[src*="cdninstagram"], img[src*="fbcdn"], div._aagv img, ul._acay img').forEach(consider);
    if (best) return best.getBoundingClientRect();

    const art = findPostArticle(scope);
    const rect = (art && art.getBoundingClientRect) ? art.getBoundingClientRect() : null;
    if (rect && rect.width > 0 && rect.height > 0) return rect;
    return {
      top: 0,
      left: 0,
      width: window.innerWidth,
      height: window.innerHeight,
      right: window.innerWidth,
      bottom: window.innerHeight,
    };
  }

  // Точки-индикаторы слайдов. Ищем структурно (role="tablist" или ряд мелких
  // «квадратиков» у кромки медиа) и лишь как подсказку — по классу *acaz*.
  // Все кандидаты обязаны лежать в области конкретной карусели (refRect).
  function findSlideDots(scope, refRect) {
    const root = (scope && scope.querySelectorAll) ? scope : document;
    const R = refRect || getCarouselRefRect(scope);
    const near = (r) =>
      r.width > 0 && r.height > 0 &&
      r.bottom > R.top - 16 && r.top < R.bottom + 16 &&
      r.right > R.left - 16 && r.left < R.right + 16;
    const byX = (a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left;

    // 1) Явный таб-лист слайдов
    const tablists = Array.from(root.querySelectorAll('[role="tablist"]'));
    for (const tl of tablists) {
      const kids = Array.from(tl.children).filter(isElementVisible);
      if (kids.length > 1 && kids.length <= 30 && kids.filter((k) => near(k.getBoundingClientRect())).length >= kids.length - 1) {
        return kids;
      }
    }

    // 2) Подсказка по классу (у Instagram это *acaz*), но только внутри области поста
    const byClass = Array.from(root.querySelectorAll('div[class*="acaz"], button[class*="acaz"], span[class*="acaz"]'))
      .filter((el) => isElementVisible(el) && near(el.getBoundingClientRect()));
    if (byClass.length > 1) return byClass.sort(byX);

    // 3) Структурно: у одного родителя >=2 маленьких квадратных элемента в один ряд
    const groups = new Map();
    Array.from(root.querySelectorAll('div, span, li')).forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 3 || r.width > 26 || r.height < 3 || r.height > 26) return;
      if (Math.abs(r.width - r.height) > 12) return;
      if (!near(r)) return;
      const p = el.parentElement;
      if (!p) return;
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p).push(el);
    });
    let bestKids = null;
    for (const kids of groups.values()) {
      if (kids.length < 2 || kids.length > 30) continue;
      const ys = kids.map((k) => {
        const r = k.getBoundingClientRect();
        return r.top + r.height / 2;
      });
      if (Math.max(...ys) - Math.min(...ys) > 10) continue;
      if (!bestKids || kids.length > bestKids.length) bestKids = kids;
    }
    return bestKids ? bestKids.sort(byX) : [];
  }

  // Индекс активной точки (текущий слайд). Признаки — aria, затем класс,
  // фолбэк — самая крупная/непрозрачная точка (у Instagram активная залита).
  function getActiveDotIndex(dots) {
    if (!dots || !dots.length) return -1;
    for (let i = 0; i < dots.length; i++) {
      const d = dots[i];
      const aria = `${d.getAttribute('aria-selected') || ''} ${d.getAttribute('aria-current') || ''}`.toLowerCase();
      if (aria.includes('true') || aria.includes('current') || aria.includes('step')) return i;
      const cls = String(d.className || '');
      if (/active|selected|current/i.test(cls)) return i;
    }
    let bestIdx = -1;
    let bestScore = -1;
    for (let i = 0; i < dots.length; i++) {
      const r = dots[i].getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue; // оторванные от DOM точки пропускаем
      let op = 1;
      try { op = parseFloat(getComputedStyle(dots[i]).opacity || '1'); } catch (_) {}
      const score = r.width * r.height * (isFinite(op) ? op : 1);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  // Стабильный id DOM-узла: смена самого элемента активного слайда — тоже признак
  // того, что карусель перелистнулась (Instagram иногда пересоздаёт узлы).
  const igxElIds = new WeakMap();
  let igxElIdSeq = 0;
  function igxElId(el) {
    if (!el) return -1;
    if (!igxElIds.has(el)) igxElIds.set(el, ++igxElIdSeq);
    return igxElIds.get(el);
  }

  // Бейдж «N/M» у карусели (если Instagram его показывает): текущий слайд и всего.
  function getSlideBadge(scope, refRect) {
    const root = (scope && scope.querySelectorAll) ? scope : document;
    const R = refRect || getCarouselRefRect(scope);
    const nodes = root.querySelectorAll('span, div');
    let scanned = 0;
    for (const n of nodes) {
      if (++scanned > 900) break;
      if (n.children.length) continue;
      if (n.closest && n.closest('.igx-seekbar, .igx-carousel-bar, .igx-ocr-pop, .igx-side-panel')) continue;
      const t = (n.textContent || '').trim();
      if (!t || t.length > 12) continue;
      const m = t.match(/^(\d{1,2})\s*(?:\/|из|of)\s*(\d{1,2})$/i);
      if (!m) continue;
      const r = n.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.bottom < R.top - 16 || r.top > R.bottom + 16) continue;
      const cur = parseInt(m[1], 10);
      const total = parseInt(m[2], 10);
      if (cur > 0) return { cur, total: total > 0 ? total : -1 };
    }
    return { cur: -1, total: -1 };
  }

  // Общее число слайдов: точки-индикаторы + бейдж «N/M» + элементы списка слайдов.
  // Не опирается на конкретный хеш класса (раньше считалось только по ul._acay).
  function detectSlideTotal(scope, dots) {
    let total = dots && dots.length > 1 ? dots.length : 0;
    const badge = getSlideBadge(scope);
    if (badge.total > total && badge.total <= 30) total = badge.total;
    const root = (scope && scope.querySelectorAll) ? scope : document;
    Array.from(root.querySelectorAll('ul._acay, ul[class*="acay"], ul[class*="slides"]')).forEach((ul) => {
      const n = ul.children.length;
      if (n > total && n <= 30) total = n;
    });
    return total;
  }

  // «Самый крупный» вариант из srcset: у Instagram первый кандидат часто оказывается
  // 150-пиксельным плейсхолдером, поэтому брать его вслепую нельзя — сравниваем
  // дескрипторы (1000w или 2x) и берём максимум.
  function igxBestSrcFromSrcset(srcset) {
    if (!srcset) return '';
    let best = '';
    let bestScore = -1;
    String(srcset).split(',').forEach((part) => {
      const bits = part.trim().split(/\s+/);
      const u = bits[0];
      if (!u) return;
      const d = bits[1] || '';
      let score = 500; // без дескриптора — середина: лучше «1x», хуже «1000w»
      if (/^\d+w$/i.test(d)) score = parseInt(d, 10);
      else if (/^\d+(?:\.\d+)?x$/i.test(d)) score = parseFloat(d) * 1000;
      if (score > bestScore) {
        bestScore = score;
        best = u;
      }
    });
    return best;
  }

  // URL картинки слайда. Порядок: currentSrc → src → самый крупный из srcset → data-src.
  // Встроенные data:-плейсхолдеры пропускаем — распознавать по ним нечего.
  function igxImageUrl(img) {
    if (!img) return null;
    const direct = img.currentSrc || img.src;
    if (direct && direct.startsWith('http')) return direct;
    const fromSet = igxBestSrcFromSrcset(img.getAttribute('srcset') || img.getAttribute('data-srcset'));
    if (fromSet && fromSet.startsWith('http')) return fromSet;
    const ds = img.getAttribute('data-src');
    if (ds && ds.startsWith('http')) return ds;
    return null;
  }

  // Медиа одного слайда (ребёнка дорожки). Видео проверяем первым: его URL — это .mp4,
  // для OCR картинкой он не годится, кадр снимается отдельно (captureElementClean).
  function igxSlideMedia(itemEl) {
    if (!itemEl) return null;
    const video = itemEl.tagName === 'VIDEO' ? itemEl : itemEl.querySelector('video');
    if (video) return { el: video, itemEl, isVideo: true, url: findVideoUrl(video) };
    const imgs = itemEl.tagName === 'IMG' ? [itemEl] : Array.from(itemEl.querySelectorAll('img'));
    if (!imgs.length) return null;
    let best = null;
    let bestArea = -1;
    imgs.forEach((img) => {
      const r = img.getBoundingClientRect();
      const area = Math.max(0, r.width) * Math.max(0, r.height);
      if (area > bestArea) {
        bestArea = area;
        best = img;
      }
    });
    const img = best || imgs[0];
    return { el: img, itemEl, isVideo: false, url: igxImageUrl(img) };
  }

  // «Дорожка» слайдов карусели, найденная ГЕОМЕТРИЧЕСКИ, а не по хешированным классам:
  // контейнер, у которого >=2 ребёнка, каждый содержит крупный (>=120 px) img/video,
  // а сами дети стоят В ОДНОМ горизонтальном ряду на одной высоте (в ленте элементы
  // идут по вертикали, а сетка постов в профиле — в несколько рядов, поэтому оба
  // признака отсекают ложные срабатывания).
  // Возвращает детей контейнера слева направо — это и есть слайды, ВКЛЮЧАЯ уехавшие
  // за край экрана: именно поэтому сбор перестал зависеть от перелистывания.
  function findHorizontalSlideTrack(scope) {
    const root = (scope && scope.querySelectorAll) ? scope : document;

    const rowOf = (parent) => {
      const kids = Array.from(parent.children).filter((k) => {
        const r = k.getBoundingClientRect();
        if (r.width < 120 || r.height < 120) return false;
        // Ряд должен быть на экране: иначе это чужая невидимая карусель из ленты
        if (r.bottom <= 0 || r.top >= window.innerHeight) return false;
        return k.tagName === 'IMG' || k.tagName === 'VIDEO' || !!k.querySelector('img, video');
      });
      if (kids.length < 2 || kids.length > 30) return null;
      const sorted = kids
        .map((k) => ({ k, r: k.getBoundingClientRect() }))
        .sort((a, b) => a.r.left - b.r.left);
      const tops = sorted.map((s) => s.r.top);
      if (Math.max(...tops) - Math.min(...tops) > 40) return null; // это сетка, а не ряд
      for (let i = 1; i < sorted.length; i++) {
        const a = sorted[i - 1].r;
        const b = sorted[i].r;
        const vOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        const hGap = b.left - a.right;
        if (vOverlap > 100 && Math.abs(hGap) <= 40) return sorted.map((s) => s.k);
      }
      return null;
    };

    // 0) Дополнительная подсказка: старый селектор списка слайдов (у Instagram ul._acay).
    // Он больше НЕ обязателен — используется только как быстрый путь.
    const hinted = root.querySelector('ul._acay, ul[class*="acay"]');
    if (hinted) {
      const hr = hinted.getBoundingClientRect();
      if (hr.width > 0 && hr.height > 0 && hr.bottom > 0 && hr.top < window.innerHeight) {
        const row = rowOf(hinted);
        if (row) return row;
      }
    }

    // 1) Геометрия: контейнер — один из предков крупного медиа (не выше 3 уровней)
    const cands = new Set();
    let bigMedias = 0;
    Array.from(root.querySelectorAll('img, video')).forEach((m) => {
      const r = m.getBoundingClientRect();
      if (r.width < 120 || r.height < 120) return;
      bigMedias++;
      let p = m.parentElement;
      for (let up = 0; p && up < 3; up++, p = p.parentElement) cands.add(p);
    });
    if (bigMedias < 2) return [];

    let bestRow = null;
    cands.forEach((c) => {
      const row = rowOf(c);
      if (!row) return;
      if (!bestRow || row.length > bestRow.length) bestRow = row;
    });
    return bestRow || [];
  }

  // Есть ли на экране дорожка слайдов (нужно для определения типа медиа).
  function hasHorizontalSlideTrack(scope) {
    return findHorizontalSlideTrack(scope).length > 1;
  }

  // «Отпечаток» текущего слайда: id активного медиа-элемента, его src, активная точка
  // и номер из бейджа. Используется, чтобы проверить ФАКТ смены слайда после клика.
  function getSlideFingerprint(scope, dots) {
    const el = getVisibleSlideElement(scope);
    const src = el ? String(el.currentSrc || el.src || (el.getAttribute && el.getAttribute('src')) || '') : '';
    const badge = getSlideBadge(scope);
    return {
      elId: igxElId(el),
      src,
      dotIdx: getActiveDotIndex(dots),
      badge: badge.cur,
      // У играющего видео кадры меняются сами по себе — сравнение снимков к нему
      // неприменимо (иначе плеер «подтверждал» бы несуществующий переход).
      volatile: !!(el && el.tagName === 'VIDEO'),
    };
  }

  // Решение «слайд реально сменился». Признаки по убыванию надёжности:
  // снимок кадра → id/src активного медиа → активная точка → бейдж.
  // true  — хотя бы один доступный признак говорит «сменилось»;
  // false — все доступные признаки говорят «не сменилось»;
  // null  — проверить нечем (нет ни снимка, ни src, ни индикаторов).
  function slideChanged(before, after, prevShot, newShot) {
    const signals = [];
    if (prevShot && newShot && before && after && !before.volatile && !after.volatile) {
      signals.push(prevShot !== newShot);
    }
    if (before && after && before.src && after.src) signals.push(before.src !== after.src);
    if (before && after && before.elId >= 0 && after.elId >= 0) signals.push(before.elId !== after.elId);
    if (before && after && before.dotIdx >= 0 && after.dotIdx >= 0) signals.push(before.dotIdx !== after.dotIdx);
    if (before && after && before.badge > 0 && after.badge > 0) signals.push(before.badge !== after.badge);
    if (!signals.length) return null;
    return signals.some(Boolean);
  }

  // Ждём, пока отпечаток слайда изменится: Instagram анимирует переход ~200–500 мс.
  async function waitForSlideAdvance(scope, dots, before, timeoutMs) {
    const t0 = Date.now();
    const limit = timeoutMs || 1500;
    while (Date.now() - t0 < limit) {
      await new Promise((r) => setTimeout(r, 120));
      const now = getSlideFingerprint(scope, dots);
      if (now.src && before.src && now.src !== before.src) return true;
      if (now.elId >= 0 && before.elId >= 0 && now.elId !== before.elId) return true;
      if (now.dotIdx >= 0 && before.dotIdx >= 0 && now.dotIdx !== before.dotIdx) return true;
      if (now.badge > 0 && before.badge > 0 && now.badge !== before.badge) return true;
    }
    return false;
  }

  // Короткое описание кандидата навигации — для честной причины остановки
  // (когда точка/стрелка найдена, но отсеяна проверкой видимости).
  function describeNavCandidate(el) {
    if (!el) return 'пустой элемент';
    const r = el.getBoundingClientRect();
    const label = String((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('role'))) || '').trim();
    const kind = label ? `«${label.slice(0, 40)}»` : String(el.tagName || '').toLowerCase();
    return `${kind} ${Math.round(r.width)}×${Math.round(r.height)}`;
  }

  // Переход к следующему слайду. Клавиатуру не используем ВООБЩЕ: ArrowLeft/ArrowRight
  // всплывают до обработчиков Instagram, и плеер трактует их как перемотку видео —
  // именно поэтому «перелистывалось видео» вместо слайдов.
  // Порядок способов: точка-индикатор (самый надёжный) → кнопка «Далее».
  // opts.nextUrlHint — URL следующего слайда, уже известный из DOM: если проверка
  // смены ничего не подтвердила, но следующий слайд заведомо другой, идём дальше —
  // ложнострицательная проверка не должна обрывать прогон по карусели.
  async function goToNextSlide(scope, curIndex, opts) {
    const refRect = getCarouselRefRect(scope);
    const dots = findSlideDots(scope, refRect);
    const activeIdx = getActiveDotIndex(dots);
    // ВАЖНО: в отпечаток передаём РЕАЛЬНЫЙ список точек. С null признак «сменилась
    // активная точка» не участвовал в проверке (dotIdx всегда -1) — отсюда могли
    // браться ложные «карусель не перелистнулась» при реально сработавшем клике.
    const before = getSlideFingerprint(scope, dots);
    const curSrc = before.src || '';

    const attempts = [];
    if (dots.length > 1) {
      const nextDot = activeIdx >= 0 ? dots[activeIdx + 1] : dots[curIndex];
      if (nextDot && nextDot !== dots[activeIdx]) attempts.push(nextDot);
    }
    const nextBtn = findCarouselNextButton(scope, refRect);
    if (nextBtn) attempts.push(nextBtn);
    if (dots.length > 1 && activeIdx < 0 && dots[curIndex] && !attempts.includes(dots[curIndex])) {
      attempts.push(dots[curIndex]);
    }

    const skipped = [];
    const tried = [];
    for (const el of attempts) {
      // Кандидатов, отсеянных isElementVisible(), НЕ пропускаем молча: жмём один раз
      // всё равно (нулевой размер бывает у ещё не отрисованной кнопки), но запоминаем,
      // что именно было отсеяно, — это попадёт в причину остановки.
      tried.push(describeNavCandidate(el));
      if (!isElementVisible(el)) skipped.push(describeNavCandidate(el));
      clickElement(el, { nav: true });
      if (await waitForSlideAdvance(scope, dots, before, 1500)) return { moved: true };
    }

    // Проверка ничего не подтвердила, но из DOM известно, что следующий слайд другой:
    // считаем переход состоявшимся и продолжаем (дубли отсекает проверка в вызывающем
    // коде: она сравнивает отпечатки и НЕ записывает повтор того же слайда).
    const nextUrlHint = (opts && opts.nextUrlHint) || null;
    if (nextUrlHint && curSrc && nextUrlHint !== curSrc) return { moved: true, optimistic: true };

    const skippedNote = skipped.length ? `; отсеяно проверкой видимости: ${skipped.join(', ')}` : '';
    return {
      moved: false,
      reason: attempts.length
        ? `клик не перелистнул карусель (нажимал: ${tried.join(', ')}${skippedNote})`
        : 'не нашёл ни точек-индикаторов, ни кнопки «Далее»',
    };
  }

  // Направление шеврона по иконке (polyline/path), без привязки к хешу класса.
  // 1 — вправо, -1 — влево, 0 — иконка не похожа на шеврон (сердце, лайк, звук и пр.).
  // Признак: у «>» средняя точка смещена ВПРАВО от середины отрезка «первая-последняя»,
  // у «<» — влево. Суммировать смещения нельзя: у симметричного шеврона они взаимно
  // уничтожаются (x конца равен x начала), поэтому сравниваем именно среднюю точку.
  function detectChevronDirection(svg) {
    if (!svg) return 0;
    const geo = svg.querySelector('polyline, path');
    if (!geo) return 0;
    const raw = `${geo.getAttribute('points') || ''} ${geo.getAttribute('d') || ''}`;
    const nums = (raw.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    if (nums.length < 6 || nums.length > 12) return 0; // 3–6 точек
    // Кривые/дуги (C/S/Q/T/A) — это пиктограмма (сердце, «поделиться»), а не стрелка
    const cmds = raw.replace(/[^a-z]/gi, '').toLowerCase();
    if (/[csqta]/.test(cmds)) return 0;
    const pts = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
    if (pts.length < 3) return 0;
    const xFirst = pts[0][0];
    const xLast = pts[pts.length - 1][0];
    const xMid = pts[Math.floor(pts.length / 2)][0];
    // ВНИМАНИЕ: для относительных path-команд («l6-6») разбор приблизительный,
    // поэтому направление по геометрии — вспомогательный признак, а основной — aria-label.
    const delta = xMid - (xFirst + xLast) / 2;
    if (Math.abs(delta) < 0.5) return 0;
    return delta > 0 ? 1 : -1;
  }

  // Подписи кнопок, которые НЕ являются навигацией по слайдам (лайк, коммент, звук):
  // защита от ложного срабатывания структурного поиска стрелки в ленте Reels.
  const IGX_NOT_NAV_LABEL = /(like|comment|share|save|more|mute|audio|music|tag|нравит|коммент|подел|сохран|ещ[её]|звук|музык|отмет)/i;

  // Гаситель наших синтетических кликов по навигации карусели.
  // Он висит на document в фазе ВСПЛЫТИЯ: обработчики React живут на корневом
  // контейнере (он ниже document) и к этому моменту уже отработали — поэтому точка
  // или кнопка «Далее» срабатывает, а само событие не доходит до слушателей
  // document/window Instagram (там живут обработчики плеера и меню).
  // Ставить гаситель в фазе перехвата нельзя: тогда React вообще не увидит клик.
  let igxNavShieldOn = false;
  // Нативное el.click() (см. clickElement) отправляет НЕпомеченное событие: флаг на него
  // поставить нельзя. Но вызов синхронный, поэтому на время его выполнения гаситель
  // считает клик навигационным — другие события в этот промежуток выполниться не могут.
  let igxNativeNavClick = false;
  function igxInstallNavShield() {
    if (igxNavShieldOn) return;
    igxNavShieldOn = true;
    const shield = (e) => {
      if (!e || !(e.__igxNavClick || (igxNativeNavClick && e.type === 'click'))) return;
      // ВАЖНО: у pointerdown/mousedown preventDefault НЕ вызываем — он подавляет
      // совместимые mouse-события (mousedown/mouseup/click), а на них и завязана
      // навигация Instagram. Достаточно остановить всплытие; для остальных фаз
      // prevention безопасен.
      if (e.type !== 'pointerdown' && e.type !== 'mousedown') {
        try { e.preventDefault(); } catch (_) {}
      }
      try { e.stopPropagation(); } catch (_) {}
      try { if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation(); } catch (_) {}
    };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) => {
      document.addEventListener(t, shield, false);
    });
  }

  // Симуляция полноценного клика по элементу в React 18 с точными координатами.
  // opts.nav = true — клик НАВИГАЦИИ по карусели (точка-индикатор / «Далее» / «Назад»):
  // событие помечается флагом __igxNavClick и гасится igxInstallNavShield().
  function clickElement(el, opts) {
    if (!el) return false;
    const isNav = !!(opts && opts.nav);
    if (isNav) igxInstallNavShield();
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const common = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
    };
    const fire = (Ctor, type, extra) => {
      const ev = new Ctor(type, { ...common, ...extra });
      if (isNav) {
        try { ev.__igxNavClick = true; } catch (_) {}
      }
      el.dispatchEvent(ev);
    };
    try { el.focus?.(); } catch (_) {}
    fire(PointerEvent, 'pointerover');
    fire(PointerEvent, 'pointerenter');
    fire(PointerEvent, 'pointerdown', { button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: 'mouse' });
    fire(MouseEvent, 'mousedown', { button: 0, buttons: 1 });
    fire(PointerEvent, 'pointerup', { button: 0, buttons: 0, isPrimary: true, pointerId: 1, pointerType: 'mouse' });
    fire(MouseEvent, 'mouseup', { button: 0, buttons: 0 });
    fire(MouseEvent, 'click', { button: 0 });
    // Нативный el.click() нужен и для навигации: именно его ждут обработчики Instagram,
    // срабатывающие от «настоящего» клика. Событие, созданное el.click(), пометить флагом
    // нельзя, поэтому на время синхронного вызова поднимаем igxNativeNavClick — гаситель
    // (igxInstallNavShield) по нему узнаёт своё событие и не пускает его выше document.
    if (isNav) {
      igxNativeNavClick = true;
      try { el.click(); } finally { igxNativeNavClick = false; }
    } else {
      try { el.click(); } catch (_) {}
    }
    return true;
  }

  // Поиск кнопки «Далее» СТРОГО внутри публикации (article).
  // refRect — уже известный прямоугольник медиа-контейнера (в ленте Reels <article>
  // нет, поэтому геометрию лучше передать снаружи, а не искать по классам заново).
  function findCarouselNextButton(scope, refRect) {
    const article = findPostArticle(scope);
    if (!article) return null;
    const mRect = refRect || (findMediaContainer(article) || article).getBoundingClientRect();

    const selectors = [
      'button[aria-label="Next"]',
      'button[aria-label="Далее"]',
      'button[aria-label="Next slide"]',
      'button[aria-label="Следующий слайд"]',
      'button[aria-label="Вперед"]',
      'button[aria-label*="Next"]',
      'button[aria-label*="Далее"]',
      'button[aria-label*="Следующ"]',
      'button[aria-label*="Вперед"]',
      'div._aaqg._aaqh button',
      'div._aaqh button',
      'div._aaqg button',
      'button._afxw, button[class*="afxw"]',
      'div[role="button"][aria-label*="Next"]',
      'div[role="button"][aria-label*="Далее"]',
    ];

    for (const sel of selectors) {
      const list = Array.from(article.querySelectorAll(sel)).filter(isElementVisible);
      for (const b of list) {
        const br = b.getBoundingClientRect();
        // Кнопка Далее находится справа от центра медиа
        if (br.left >= mRect.left + mRect.width * 0.35 && br.left <= mRect.right + 70) {
          return b;
        }
      }
    }

    const svgs = Array.from(article.querySelectorAll('svg')).filter(isElementVisible);
    for (const svg of svgs) {
      const label = `${svg.getAttribute('aria-label') || ''} ${svg.querySelector('title')?.textContent || ''}`.toLowerCase();
      const isNextLabel =
        label.includes('далее') ||
        label.includes('next') ||
        label.includes('следующ') ||
        label.includes('вперед');

      const poly = svg.querySelector('polyline');
      const pts = poly ? (poly.getAttribute('points') || '') : '';
      // Хеш-подсказки Instagram оставляем, но основной признак — геометрия иконки
      const isChevronRight = detectChevronDirection(svg) === 1 || pts.includes('19.84') || pts.includes('22.565') || pts.includes('9.276');

      if (isNextLabel || isChevronRight) {
        const btn = svg.closest('button, [role="button"]') || svg.parentElement;
        if (btn && isElementVisible(btn)) {
          const br = btn.getBoundingClientRect();
          if (br.left >= mRect.left + mRect.width * 0.35 && br.left <= mRect.right + 70) {
            return btn;
          }
        }
      }
    }

    // Структурный фолбэк: маленькая кнопка-шеврон у правого края медиа на середине
    // по высоте. Отсекаем кнопки лайка/коммента/звука по aria-label и по форме иконки.
    const structCands = Array.from(article.querySelectorAll('button, [role="button"]')).filter(isElementVisible);
    for (const b of structCands) {
      const br = b.getBoundingClientRect();
      if (br.width < 12 || br.width > 72 || br.height < 12 || br.height > 72) continue;
      if (IGX_NOT_NAV_LABEL.test(String(b.getAttribute('aria-label') || ''))) continue;
      const cy = br.top + br.height / 2;
      if (cy < mRect.top + mRect.height * 0.2 || cy > mRect.bottom - mRect.height * 0.2) continue;
      if (br.left < mRect.left + mRect.width * 0.72 || br.left > mRect.right + 40) continue;
      if (detectChevronDirection(b.querySelector('svg')) !== 1) continue;
      return b;
    }

    return null;
  }

  // Поиск кнопки «Назад» СТРОГО внутри публикации (article)
  function findCarouselPrevButton(scope, refRect) {
    const article = findPostArticle(scope);
    if (!article) return null;
    const mRect = refRect || (findMediaContainer(article) || article).getBoundingClientRect();

    const selectors = [
      'button[aria-label="Previous"]',
      'button[aria-label="Назад"]',
      'button[aria-label="Previous slide"]',
      'button[aria-label="Предыдущий слайд"]',
      'button[aria-label*="Previous"]',
      'button[aria-label*="Назад"]',
      'button[aria-label*="Back"]',
      'div._aaqi button',
      'button._afxw, button[class*="afxw"]',
      'div[role="button"][aria-label*="Previous"]',
      'div[role="button"][aria-label*="Назад"]',
    ];

    for (const sel of selectors) {
      const list = Array.from(article.querySelectorAll(sel)).filter(isElementVisible);
      for (const b of list) {
        const br = b.getBoundingClientRect();
        // Кнопка Назад находится слева от центра медиа
        if (br.left <= mRect.left + mRect.width * 0.65 && br.left >= mRect.left - 70) {
          return b;
        }
      }
    }

    const svgs = Array.from(article.querySelectorAll('svg')).filter(isElementVisible);
    for (const svg of svgs) {
      const label = `${svg.getAttribute('aria-label') || ''} ${svg.querySelector('title')?.textContent || ''}`.toLowerCase();
      const isPrevLabel =
        label.includes('назад') ||
        label.includes('previous') ||
        label.includes('back') ||
        label.includes('предыдущ');

      const poly = svg.querySelector('polyline');
      const pts = poly ? (poly.getAttribute('points') || '') : '';
      const isChevronLeft = detectChevronDirection(svg) === -1 || pts.includes('16.564') || pts.includes('6 12');

      if (isPrevLabel || isChevronLeft) {
        const btn = svg.closest('button, [role="button"]') || svg.parentElement;
        if (btn && isElementVisible(btn)) {
          const br = btn.getBoundingClientRect();
          if (br.left <= mRect.left + mRect.width * 0.65 && br.left >= mRect.left - 70) {
            return btn;
          }
        }
      }
    }

    // Структурный фолбэк: маленькая кнопка-шеврон у левого края медиа на середине высоты
    const structCands = Array.from(article.querySelectorAll('button, [role="button"]')).filter(isElementVisible);
    for (const b of structCands) {
      const br = b.getBoundingClientRect();
      if (br.width < 12 || br.width > 72 || br.height < 12 || br.height > 72) continue;
      if (IGX_NOT_NAV_LABEL.test(String(b.getAttribute('aria-label') || ''))) continue;
      const cy = br.top + br.height / 2;
      if (cy < mRect.top + mRect.height * 0.2 || cy > mRect.bottom - mRect.height * 0.2) continue;
      if (br.left > mRect.left + mRect.width * 0.28 || br.left < mRect.left - 40) continue;
      if (detectChevronDirection(b.querySelector('svg')) !== -1) continue;
      return b;
    }

    return null;
  }

  // Получение активного/видимого изображения текущего слайда
  // Получение активного/видимого изображения текущего слайда
  function getVisibleSlideElement(scope) {
    const article = findPostArticle(scope);
    const ul = article.querySelector('ul._acay, ul[class*="acay"]');
    const ulRect = ul ? ul.getBoundingClientRect() : null;
    // Доверяем списку слайдов только если он реально на экране: в ленте Reels первый
    // ul._acay в документе может принадлежать другому, невидимому посту.
    const ulOnScreen = !!(ulRect && ulRect.width > 0 && ulRect.height > 0 && ulRect.bottom > 0 && ulRect.top < window.innerHeight);
    if (ul && ulOnScreen) {
      const lis = Array.from(ul.children);
      const parent = ul.parentElement || ul;
      const pRect = parent.getBoundingClientRect();
      const pCenter = pRect.left + pRect.width / 2;

      let bestLi = null;
      let bestDist = Infinity;
      for (const li of lis) {
        const r = li.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const c = r.left + r.width / 2;
        const d = Math.abs(c - pCenter);
        if (d < bestDist) {
          bestDist = d;
          bestLi = li;
        }
      }
      if (bestLi) {
        const media = bestLi.querySelector('img, video');
        if (media) return media;
        return bestLi;
      }
    }

    // Опора — видимый контейнер медиа, а не первый попавшийся в документе
    const viewports = Array.from(article.querySelectorAll('div._aatk, div._aamw')).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
    });
    const viewport = viewports[0] || findMediaContainer(article) || article;
    const vRect = viewport.getBoundingClientRect();
    const vCenter = vRect.left + vRect.width / 2;

    const imgs = Array.from(
      article.querySelectorAll('ul._acay img, div._acaw img, div._aatk img, div._aagv img, img[src*="cdninstagram"], img[src*="fbcdn"]')
    ).filter((img) => {
      const r = img.getBoundingClientRect();
      // Кадр слайда должен быть крупным И на экране — иначе выбирались картинки
      // соседних (невидимых) постов ленты.
      return r.width > 120 && r.height > 120 && r.bottom > 0 && r.top < window.innerHeight;
    });

    if (imgs.length === 0) {
      return article.querySelector('video') || article.querySelector('img');
    }

    imgs.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const distA = Math.abs(ra.left + ra.width / 2 - vCenter);
      const distB = Math.abs(rb.left + rb.width / 2 - vCenter);
      return distA - distB;
    });

    return imgs[0];
  }

  // Кадр слайда-видео БЕЗ перемотки: видимый элемент снимаем обычным чистым способом
  // (canvas, при неудаче — снимок вкладки), невидимый — только canvas. Снимок вкладки
  // для элемента за кадром вырезал бы чужой участок экрана и дал бы мусорный текст.
  async function igxCaptureFrameFor(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const onScreen = r.width > 0 && r.height > 0 &&
      r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
    if (onScreen) return captureElementClean(el);
    if (el.tagName === 'VIDEO') return captureVideoDirectCanvas(el);
    return null;
  }

  // Виден ли сейчас именно этот медиа-элемент слайда (нужно, чтобы подвести карусель
  // к слайду-видео и снять с него кадр).
  function igxIsSlideVisible(scope, mediaEl) {
    if (!mediaEl) return false;
    const vis = getVisibleSlideElement(scope);
    if (!vis) return false;
    return vis === mediaEl || vis.contains(mediaEl) || mediaEl.contains(vis);
  }

  // Извлечение текста со слайдов карусели.
  // ГЛАВНЫЙ путь — DOM: URL слайдов берутся прямо из «дорожки» (findHorizontalSlideTrack),
  // а клики по точкам/«Далее» остаются лишь вспомогательным механизмом — только для
  // слайдов, которых в DOM ещё нет (ленивая подгрузка), и для видео, кадр которого надо
  // снять. Поэтому «карусель не перелистывается» больше не обрывает прогон: если URL
  // слайда известен, он уходит в распознавание и попадает в результат.
  async function extractCarouselSlides(postMedia, startCount, endCount, apiKey, statusEl) {
    const scope = postMedia.scope || document;
    const initialUrl = window.location.href;
    // Область поиска навигации: контейнер медиа конкретного поста, а если его нет —
    // переданная область. В ленте Reels <article> отсутствует, поэтому привязка идёт
    // по геометрии медиа (см. getCarouselRefRect/findSlideDots), а не по классам.
    const navScope =
      (postMedia.mediaContainer && isElementVisible(postMedia.mediaContainer) && postMedia.mediaContainer) ||
      scope;

    // Собираем точки-индикаторы: сначала в области медиа, затем (если пусто) шире
    const collectDots = () => {
      let d = findSlideDots(navScope, getCarouselRefRect(scope));
      if (!d.length && navScope !== scope) d = findSlideDots(scope, getCarouselRefRect(scope));
      return d;
    };
    // Дорожка слайдов: тоже сначала в области медиа, затем шире
    const collectTrack = () => {
      let t = findHorizontalSlideTrack(navScope);
      if (t.length < 2 && navScope !== scope) t = findHorizontalSlideTrack(scope);
      return t;
    };

    // 1. ГЛАВНОЕ: слайды добываем из DOM, без единого клика — у каждого ребёнка дорожки
    // уже есть URL медиа, и перелистывать карусель ради этого не нужно.
    if (statusEl) statusEl.textContent = 'Собираю слайды из DOM…';
    const slideDescs = collectTrack().map(igxSlideMedia).filter(Boolean);
    // URL → номер слайда по DOM: по нему узнаём, что клик НЕ перелистнул карусель
    // (видимый слайд оказался чужой картинкой из уже известных)
    const domUrlIndex = new Map();
    slideDescs.forEach((d, i) => {
      if (d.url && !domUrlIndex.has(d.url)) domUrlIndex.set(d.url, i + 1);
    });

    // 2. Общее число слайдов: дорожка из DOM + индикаторы + бейдж «N/M» + список слайдов
    // (раньше считалось только по хешированному ul._acay и часто оставалось нулём).
    let dots = collectDots();
    let detectedTotal = detectSlideTotal(navScope, dots);
    if (slideDescs.length > detectedTotal && slideDescs.length <= 30) detectedTotal = slideDescs.length;

    // Рассчитываем, какие слайды нам нужны
    const totalToUse = detectedTotal > 0 ? detectedTotal : Math.max(startCount + endCount, 12);
    const { headSlides: plannedHead, tailSlides: plannedTail } = getSlideWindows(totalToUse, startCount, endCount);
    const neededSet = new Set([...plannedHead, ...plannedTail]);
    const maxNeeded = neededSet.size > 0 ? Math.max(...Array.from(neededSet)) : 10;
    const scanLimit = detectedTotal > 0 ? Math.min(detectedTotal, maxNeeded) : maxNeeded;
    const neededList = Array.from(neededSet).filter((i) => i >= 1 && i <= scanLimit).sort((a, b) => a - b);

    // Клики нужны ТОЛЬКО там, где URL слайда в DOM отсутствует
    const clicksNeeded = neededList.some((cur) => {
      const d = slideDescs[cur - 1];
      return !d || !d.url;
    });

    // 3. Переход к первому слайду — только если без кликов не обойтись (точка-индикатор,
    // затем «Назад»). Клавиатуру не используем вообще: dispatchEvent(new KeyboardEvent
    // ('ArrowLeft')) всплывал до обработчиков Instagram, и плеер трактовал его как
    // перемотку видео — из-за этого «перелистывалось видео» вместо слайдов.
    let rewindAttempted = false;
    let firstSlideConfirmed = !clicksNeeded;
    if (clicksNeeded) {
      if (statusEl) statusEl.textContent = 'Перехожу к началу слайдов…';
      const dots0 = collectDots();
      const active0 = getActiveDotIndex(dots0);
      if (dots0.length > 1 && active0 === 0) {
        firstSlideConfirmed = true; // индикаторы уже показывают первый слайд
      } else if (dots0.length > 1 && dots0[0]) {
        const before0 = getSlideFingerprint(navScope, dots0);
        clickElement(dots0[0], { nav: true });
        rewindAttempted = true;
        firstSlideConfirmed = await waitForSlideAdvance(navScope, dots0, before0, 1500);
      }
      if (!firstSlideConfirmed) {
        for (let step = 0; step < 20; step++) {
          const dotsN = collectDots();
          const activeN = getActiveDotIndex(dotsN);
          if (dotsN.length > 1 && activeN === 0) {
            firstSlideConfirmed = true;
            break;
          }
          const prevBtn = findCarouselPrevButton(navScope, getCarouselRefRect(scope));
          if (!prevBtn) break;
          const beforeN = getSlideFingerprint(navScope, dotsN);
          clickElement(prevBtn, { nav: true });
          rewindAttempted = true;
          if (!(await waitForSlideAdvance(navScope, dotsN, beforeN, 1200))) break;
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    // 4. Сбор нужных слайдов: сначала всё, что уже есть в DOM (без кликов), затем —
    // только недостающее, перелистыванием.
    const captured = {};
    const obtained = new Set();
    let unverified = 0;
    let stopReason = '';
    let prevShot = null;
    let prevFp = null;
    let visibleIdx = 1; // номер слайда, который считаем видимым (для кликового пути)

    for (const cur of neededList) {
      if (window.location.href !== initialUrl) {
        stopReason = 'страница сменилась';
        break;
      }
      const desc = slideDescs[cur - 1];

      // 4a. URL слайда уже известен из DOM — ни кликов, ни проверок смены не требуется
      if (desc && desc.url) {
        if (statusEl) statusEl.textContent = `Слайд ${cur}: медиа взято из DOM…`;
        const item = { url: desc.url, isVideo: !!desc.isVideo, dataUrl: null };
        if (desc.isVideo) {
          // У видео URL — это .mp4: для распознавания нужен кадр, снимаем без перемотки
          const frame = await igxCaptureFrameFor(desc.el);
          if (frame) {
            item.dataUrl = frame;
            item.url = null;
          }
        } else if (igxIsSlideVisible(navScope, desc.el)) {
          // Слайд на экране: снимок пойдёт фолбэком, если распознать по URL не выйдет
          const frame = await igxCaptureFrameFor(desc.el);
          if (frame) item.dataUrl = frame;
        }
        captured[cur] = item;
        obtained.add(cur);
        // Отпечаток сбрасываем: проверка «слайд сменился» относится только к кликовому пути
        prevFp = null;
        prevShot = null;
        continue;
      }

      // 4b. Медиа слайда в DOM нет (ленивая подгрузка) — добираем перелистыванием
      if (statusEl) statusEl.textContent = `Слайд ${cur}: медиа нет в DOM, перелистываю…`;
      let reached = true;
      while (visibleIdx < cur) {
        const nextDesc = slideDescs[visibleIdx] || null;
        const nav = await goToNextSlide(navScope, visibleIdx, {
          nextUrlHint: (nextDesc && nextDesc.url) || null,
        });
        if (!nav.moved) {
          stopReason = nav.reason || 'переход на следующий слайд не сработал';
          reached = false;
          break;
        }
        visibleIdx++;
      }
      if (!reached) break;

      const el = getVisibleSlideElement(navScope);
      const curSrc = el ? String(el.currentSrc || el.src || '') : '';
      const isVid = !!(el && el.tagName === 'VIDEO');

      // Защита от «мёртвых» кликов: если видимый слайд — это картинка, чей URL уже
      // известен из DOM под ДРУГИМ номером, значит карусель не перелистнулась.
      // Записывать её как слайд cur нельзя — это была бы подмена одного слайда другим.
      const seenIdx = curSrc ? domUrlIndex.get(curSrc) : 0;
      if (seenIdx && seenIdx !== cur) {
        stopReason = `карусель осталась на слайде ${seenIdx}`;
        break;
      }

      // Чистый кадр слайда: с <video> снимаем прямо с canvas (без оверлеев Instagram),
      // снимок вкладки остаётся фолбэком. Перемотки видео здесь нет вообще.
      const dUrl = await captureElementClean(el);

      // Со 2-го кликового слайда проверяем, что карусель РЕАЛЬНО перелистнулась: иначе мы бы
      // записали один и тот же слайд несколько раз и отчитались о несуществующих.
      if (prevFp) {
        const verdict = slideChanged(prevFp, getSlideFingerprint(navScope, dots), prevShot, dUrl);
        if (verdict === false) {
          stopReason = `карусель не перелистнулась на слайд ${cur}`;
          break;
        }
        if (verdict === null) {
          unverified++;
          if (unverified >= 2) {
            stopReason = 'смену слайда нечем подтвердить (нет ни кадра, ни src, ни индикаторов)';
            break;
          }
        } else {
          unverified = 0;
        }
      }

      captured[cur] = {
        url: (!isVid && curSrc.startsWith('http')) ? curSrc : null,
        isVideo: isVid,
        dataUrl: dUrl,
      };
      if (isVid && !dUrl) {
        // Кадра нет — оставляем mp4-URL как последний фолбэк распознавания
        const vu = findVideoUrl(el);
        if (vu) captured[cur].url = vu;
      }
      obtained.add(cur);
      prevShot = dUrl;
      prevFp = getSlideFingerprint(navScope, dots);
      // Индикаторы могли перерисоваться после перехода — перечитываем их
      dots = collectDots();
    }

    // 5. Слайды-видео, кадр которых снять не удалось: подводим к ним карусель кликами —
    // единственный случай, когда клик нужен для слайда с уже известным из DOM URL.
    for (const cur of neededList) {
      const item = captured[cur];
      if (!item || !item.isVideo || item.dataUrl) continue;
      const desc = slideDescs[cur - 1];
      if (!desc || !desc.el) continue;
      let guard = 0;
      while (guard++ < 12 && !igxIsSlideVisible(navScope, desc.el)) {
        const nextDesc = slideDescs[visibleIdx] || null;
        const nav = await goToNextSlide(navScope, visibleIdx, {
          nextUrlHint: (nextDesc && nextDesc.url) || null,
        });
        if (!nav.moved) break;
        visibleIdx++;
      }
      if (igxIsSlideVisible(navScope, desc.el)) {
        const frame = await igxCaptureFrameFor(desc.el);
        if (frame) {
          item.dataUrl = frame;
          item.url = null;
        }
      }
    }

    // 6. Честный отчёт: сколько ВЫБРАННЫХ слайдов удалось получить и каких именно нет.
    // Если всё получилось (missing пуст) — лишнего текста в предупреждениях не появляется.
    const missing = neededList.filter((i) => !obtained.has(i));
    const warnings = [];
    if (!firstSlideConfirmed && clicksNeeded) {
      warnings.push(rewindAttempted
        ? 'начало карусели (1-й слайд) подтвердить не удалось'
        : 'не нашёл индикаторов/кнопки «Назад» — не смог убедиться, что захват начат с 1-го слайда');
    }
    if (detectedTotal <= 0) {
      warnings.push('всего слайдов определить не удалось');
    }
    if (missing.length) {
      const tail = stopReason ? `: ${stopReason}` : '';
      warnings.push(
        `получено слайдов — ${obtained.size} из ${neededList.length}${tail}; не удалось получить слайды ${missing.join(', ')}`
      );
    }

    // Итоговое число слайдов: реальный размер карусели, если он определён, иначе — максимум
    // из добытого. По нему раскладываем слайды на хук и призыв.
    const actualTotal = detectedTotal > 0
      ? detectedTotal
      : (obtained.size ? Math.max(...Array.from(obtained)) : 1);
    const { headSlides, tailSlides } = getSlideWindows(actualTotal, startCount, endCount);

    async function ocrItem(item) {
      if (!item) return '';
      if (item.url) {
        try {
          const txt = await ocrRecognizeUrl(item.url, apiKey);
          if (txt && txt.trim()) return txt.trim();
        } catch (e) {
          console.warn('ocrRecognizeUrl failed:', e);
        }
      }
      if (item.dataUrl) {
        try {
          const txt = await ocrRecognize(item.dataUrl, apiKey);
          if (txt && txt.trim()) return txt.trim();
        } catch (e) {
          console.warn('ocrRecognize screen capture failed:', e);
        }
      }
      return '';
    }

    const headTexts = [];
    for (const s of headSlides) {
      if (!captured[s]) {
        // Честная пометка: слайд выбран, но добыть его не удалось (см. предупреждение)
        headTexts.push(`Слайд ${s}:\n(не удалось получить)`);
        continue;
      }
      if (statusEl) statusEl.textContent = apiKey ? `Распознаю слайд ${s} (Vision AI)…` : `Распознаю слайд ${s}…`;
      try {
        const txt = await ocrItem(captured[s]);
        const clean = compactOcrText(txt);
        headTexts.push(clean ? `Слайд ${s}:\n${clean}` : `Слайд ${s}:\n(нет текста)`);
      } catch (e) {
        console.warn(`Ошибка OCR слайда ${s}:`, e);
        headTexts.push(`Слайд ${s}:\n(ошибка распознавания)`);
      }
    }
    if (headTexts.length === 0) {
      headTexts.push('(не выбрано)');
    }

    const tailTexts = [];
    for (const s of tailSlides) {
      if (!captured[s]) {
        // Честная пометка: слайд выбран, но добыть его не удалось (см. предупреждение)
        tailTexts.push(`Слайд ${s}:\n(не удалось получить)`);
        continue;
      }
      if (statusEl) statusEl.textContent = apiKey ? `Распознаю слайд ${s} (Vision AI)…` : `Распознаю слайд ${s}…`;
      try {
        const txt = await ocrItem(captured[s]);
        const clean = compactOcrText(txt);
        tailTexts.push(clean ? `Слайд ${s}:\n${clean}` : `Слайд ${s}:\n(нет текста)`);
      } catch (e) {
        console.warn(`Ошибка OCR слайда ${s}:`, e);
        tailTexts.push(`Слайд ${s}:\n(ошибка распознавания)`);
      }
    }
    if (tailTexts.length === 0) {
      tailTexts.push('(не выбрано)');
    }

    return {
      actualTotal,
      plannedTotal: scanLimit,
      warnings,
      headSlides,
      tailSlides,
      headText: headTexts.join('\n\n'),
      tailText: tailTexts.join('\n\n'),
    };
  }

  async function recordRange(video, from, to) {
    if (typeof video.captureStream !== 'function' && typeof video.mozCaptureStream !== 'function') {
      throw new Error('Браузер не даёт захватить звук из этого видео.');
    }
    const cs = video.captureStream ? video.captureStream() : video.mozCaptureStream();
    const tracks = cs.getAudioTracks();
    if (!tracks || !tracks.length) throw new Error('В этом видео нет звуковой дорожки.');

    // Изолируем только аудиодорожку, чтобы MediaRecorder не падал из-за наличия видеодорожки
    const audioStream = new MediaStream(tracks);

    let mimeType = '';
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
      mimeType = 'audio/webm;codecs=opus';
    } else if (MediaRecorder.isTypeSupported('audio/webm')) {
      mimeType = 'audio/webm';
    } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
      mimeType = 'audio/mp4';
    }

    let rec;
    try {
      rec = mimeType ? new MediaRecorder(audioStream, { mimeType }) : new MediaRecorder(audioStream);
    } catch (e) {
      console.warn('MediaRecorder audioStream init failed, trying raw stream:', e);
      rec = new MediaRecorder(cs);
    }

    const chunks = [];
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    const stopped = new Promise((res) => {
      rec.onstop = res;
    });

    const prevTime = video.currentTime;
    const prevVolume = video.volume;
    const wasMuted = video.muted;

    video.muted = false;
    video.volume = 0.5;

    // Восстановление состояния плеера — в finally: раньше при любой ошибке записи
    // видео оставалось со снятым mute и громкостью 0.5, а позиция не возвращалась.
    try {
      await videoSeekTo(video, from);
      await new Promise((r) => setTimeout(r, 150));

      try {
        rec.start(100);
      } catch (e) {
        console.warn('rec.start failed on audioStream, fallback to cs:', e);
        rec = new MediaRecorder(cs);
        rec.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunks.push(e.data);
        };
        rec.start(100);
      }

      try {
        await video.play();
      } catch (_) {}

      const dur = Math.max(0.5, to - from);
      await new Promise((r) => setTimeout(r, Math.round(dur * 1000)));

      try {
        if (rec.state !== 'inactive') rec.stop();
      } catch (_) {}
      await stopped;

      try {
        video.pause();
      } catch (_) {}

      return new Blob(chunks, { type: 'audio/webm' });
    } finally {
      try {
        video.currentTime = prevTime;
      } catch (_) {}
      video.volume = prevVolume;
      video.muted = wasMuted;
    }
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
      fr.onerror = () => reject(new Error('Не смог прочитать звук.'));
      fr.readAsDataURL(blob);
    });
  }

  async function ocrFrames(frames, apiKey, statusEl, label) {
    const out = [];
    for (let i = 0; i < frames.length; i++) {
      if (statusEl) {
        statusEl.textContent = `Распознаю текст ${label} (${i + 1}/${frames.length})…`;
      }
      try {
        const txt = await ocrRecognize(frames[i], apiKey);
        if (txt) out.push(txt);
      } catch (e) {
        console.warn(`Ошибка OCR кадра ${i + 1}:`, e);
      }
    }
    return out;
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {}
    // Фолбэк через скрытый textarea. Удаление — в finally: если execCommand бросит
    // исключение, textarea не должна остаться висеть в DOM.
    let ta = null;
    try {
      ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '-9999px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      return document.execCommand('copy');
    } catch (_) {
      return false;
    } finally {
      try {
        ta?.remove();
      } catch (_) {}
    }
  }

  // ---------- метрики поста: просмотры / лайки / комментарии / репосты ----------
  // Instagram отдаёт числа сразу в нескольких местах и форматах, а вёрстка лент
  // (Reels, модалка поста, профиль) отличается. Поэтому ниже не один селектор, а
  // цепочка независимых стратегий — выигрывает первая, вернувшая значение:
  //   1) React Fiber (точное число из props)                        — igxExtractMetric
  //   2) aria-label / title кнопок, иконок и подписей-счётчиков      — igxCountByAttributes
  //   3) короткий числовой текст внутри кнопки и рядом с ней (в ленте
  //      Reels число лежит в соседнем span под иконкой)              — igxCountNear
  //   4) ключевые фразы в тексте области поста («N отметок "Нравится"»,
  //      «Посмотреть все N комментариев», «N репостов»)              — igxCountByText
  // Если ни одна стратегия не сработала — возвращаем null, а НЕ 0:
  // ноль не должен маскировать поломку извлечения.

  const IGX_LIKE_WORDS = ['нравится', 'лайк', 'like', 'unlike', 'liked'];
  const IGX_COMMENT_WORDS = ['комментар', 'коммент', 'comment'];
  const IGX_SHARE_WORDS = ['поделиться', 'поделились', 'репост', 'share', 'repost', 'отправить'];
  // Слова соседних кнопок: по ним отсекаем чужие числа (иначе лайки уезжали бы в репосты)
  const IGX_OTHER_ACTION_WORDS = [].concat(
    IGX_LIKE_WORDS,
    IGX_COMMENT_WORDS,
    IGX_SHARE_WORDS,
    ['сохран', 'save', 'bookmark', 'ещё', 'еще', 'more', 'дополнительно']
  );

  // Фразы в тексте области поста. Число обязано стоять вплотную к ключевому слову,
  // иначе легко выдернуть из описания случайную цифру. ВАЖНО: \w в JS не матчит
  // кириллицу, поэтому окончания слов пишем явным классом [а-яё].
  // Точка после множителя («1,2 тыс. репостов») и перед самим ключевым словом —
  // необязательная, но допустимая: в русской локали ИГ пишет именно так.
  const IGX_LIKE_TEXT_PATTERNS = [
    /([\d][\d\s.,]*(?:\s*(?:тыс[а-яё]*|млн|млрд|k|m|b)\.?)?)\s*\.?\s*отмет[а-яё]*\s*["«”']?\s*нравится/i,
    /(?:нравится|likes?)\s*[:—-]\s*([\d][\d\s.,]*(?:\s*(?:тыс[а-яё]*|млн|млрд|k|m|b)\.?)?)/i,
    /([\d][\d\s.,]*(?:\s*(?:тыс[а-яё]*|млн|млрд|k|m|b)\.?)?)\s*\.?\s*(?:likes?|лайк[а-яё]*)/i,
  ];
  const IGX_COMMENT_TEXT_PATTERNS = [
    /(?:посмотреть\s+(?:все\s+)?|показать\s+(?:все\s+)?|view\s+all\s+|все\s+)([\d][\d\s.,]*(?:\s*(?:тыс[а-яё]*|млн|k|m)\.?)?)\s*\.?\s*(?:комментар[а-яё]*|comments?)/i,
    /([\d][\d\s.,]*(?:\s*(?:тыс[а-яё]*|млн|k|m)\.?)?)\s*\.?\s*(?:комментар[а-яё]*|comments?)/i,
    /(?:комментар[а-яё]*|comments?)\s*[:—-]\s*([\d][\d\s.,]*(?:\s*(?:тыс[а-яё]*|млн|k|m)\.?)?)/i,
  ];
  const IGX_REPOST_TEXT_PATTERNS = [
    /([\d][\d\s.,]*(?:\s*(?:тыс[а-яё]*|млн|k|m)\.?)?)\s*\.?\s*(?:репост[а-яё]*|reposts?|shares?)/i,
    /(?:репост[а-яё]*|reposts?|shares?)\s*[:—-]\s*([\d][\d\s.,]*(?:\s*(?:тыс[а-яё]*|млн|k|m)\.?)?)/i,
  ];

  // Просмотры: под описанием это «N просмотров» / «N views» / «N воспроизведений»,
  // а в ленте Reels число часто стоит рядом с иконкой play вообще без подписи —
  // такой случай ловит igxCountNear (стратегия 3: короткое число рядом с иконкой).
  const IGX_VIEW_WORDS = ['просмотр', 'просмотры', 'просмотров', 'воспроизведен', 'view', 'views', 'play', 'plays', 'played'];
  const IGX_VIEW_TEXT_PATTERNS = [
    /([\d][\d\s.,]*(?:\s*(?:тыс[а-яё]*|млн|млрд|k|m|b)\.?)?)\s*\.?\s*(?:просмотр[а-яё]*|воспроизведен[а-яё]*|views?|plays?)/i,
    /(?:просмотр[а-яё]*|воспроизведен[а-яё]*|views?|plays?)\s*[:—-]\s*([\d][\d\s.,]*(?:\s*(?:тыс[а-яё]*|млн|млрд|k|m|b)\.?)?)/i,
  ];

  // Скрытые лайки: «Отметки "Нравится" скрыты» / «likes are hidden». Написания «Нравится
  // X и другим» / «liked by X and others» оставлены как было (X — ник, только латиница).
  const IGX_LIKES_HIDDEN_RE = new RegExp(
    [
      'отметк[а-яё]*\\s*["«”\']?\\s*нравится["»”\']?\\s*скрыт',
      'скрыт[а-яё]*[^.]{0,24}отметк',
      'likes?\\s*(?:are|is)?\\s*hidden',
      'hidden\\s+likes?',
      'нравится\\s+[\\w.]+\\s+и\\s+(?:другим|ещё|еще)',
      'liked\\s+by\\s+[\\w.]+\\s+and\\s+others',
    ].join('|'),
    'i'
  );

  // Неразрывные и узкие пробелы ИГ использует как разделитель разрядов — приводим к обычному
  function igxNormalizeText(raw) {
    return String(raw == null ? '' : raw)
      .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Компактные числа Instagram: «1 234» → 1234, «1,2 тыс.» → 1200, «1.2K» → 1200,
  // «3,4 млн» → 3400000, «1,234» → 1234 (англ. разряды), «1.234» → 1234 (европ. разряды).
  function parseCompactCount(raw) {
    let s = igxNormalizeText(raw).toLowerCase();
    if (!/\d/.test(s)) return null;

    // Множитель: «1,2 тыс.», «3.4M», «2 млн». Буква после множителя = это уже другое слово.
    let mult = 1;
    const suf = s.match(/(тыс[а-яё]*|млн|млрд|k|m|b)(?![a-zа-яё0-9])/);
    if (suf) {
      if (suf[1].startsWith('тыс') || suf[1] === 'k') mult = 1e3;
      else if (suf[1] === 'млн' || suf[1] === 'm') mult = 1e6;
      else if (suf[1] === 'млрд' || suf[1] === 'b') mult = 1e9;
      s = s.slice(0, suf.index) + ' ' + s.slice(suf.index + suf[1].length);
    }

    // Берём первое ЧИСЛО, а не «всё числоподобное»: разряды идут группами по 3 цифры
    // («1 234 567», «1,234,567»), поэтому группа другого размера — уже другое число.
    const num = s.match(/\d{1,3}(?:[ .,]\d{3})+|\d+(?:[.,]\d+)?/);
    if (!num) return null;
    let t = num[0].replace(/\s/g, '').replace(/^[.,]+|[.,]+$/g, '');
    if (!t) return null;

    if (mult === 1 && /^\d{1,3}(?:,\d{3})+$/.test(t)) t = t.replace(/,/g, '');
    else if (mult === 1 && /^\d{1,3}(?:\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
    else t = t.replace(/,/g, '.');

    const value = parseFloat(t);
    if (!isFinite(value)) return null;
    return Math.round(value * mult);
  }

  // Первое число из подписи/строки («Нравится: 1 234», «1,2 тыс. отметок», «View all 12 comments»)
  function igxCountFromText(raw) {
    const s = igxNormalizeText(raw);
    if (!/\d/.test(s)) return null;
    const m = s.match(/(\d{1,3}(?:[ .,]\d{3})+|\d+(?:[.,]\d+)?)\s*(?:тыс[а-яё]*|млн|млрд|k|m|b)?(?![a-zа-яё0-9])/i);
    if (!m) return null;
    return parseCompactCount(m[0]);
  }

  // Совпадает ли подпись с одним из «слов» метрики. Сравниваем по токенам и по началу
  // токена — так «комментариев» попадает в «комментар», а «Likes» в «like».
  function igxLabelMatches(label, words) {
    const s = igxNormalizeText(label).toLowerCase();
    if (!s || !words || !words.length) return false;
    const tokens = s.split(/[^0-9a-zа-яё]+/i).filter(Boolean);
    if (!tokens.length) return false;
    return words.some((w) => tokens.some((t) => t === w || t.startsWith(w)));
  }

  // Короткий ЧИСТО числовой текст элемента («1 234», «1,2 тыс.»). Длинные тексты
  // (описания, подписи) отсекаем, чтобы не выдернуть оттуда случайное число.
  function igxShortNumberFrom(el) {
    if (!el || !el.textContent) return null;
    const t = igxNormalizeText(el.textContent.replace(/[^\d\s.,a-zа-яё]/gi, ''));
    if (!t || t.length > 20) return null;
    if (!/^\d[\d\s.,]*(?:\s*(?:тыс[а-яё]*|млн|млрд|k|m|b))?\.?$/i.test(t)) return null;
    return igxCountFromText(t);
  }

  // Есть ли внутри элемента подпись ДРУГОЙ кнопки действия (лайк/коммент/поделиться/
  // сохранить)? Такие узлы пропускаем, чтобы не подставить чужое число.
  function igxForeignAction(el, myWords) {
    if (!el || !el.querySelectorAll) return false;
    const nodes = el.querySelectorAll('[aria-label], [title]');
    for (const n of nodes) {
      const label = igxNormalizeText(n.getAttribute('aria-label') || n.getAttribute('title'));
      if (!label) continue;
      if (igxLabelMatches(label, myWords)) continue;
      if (igxLabelMatches(label, IGX_OTHER_ACTION_WORDS)) return true;
    }
    return false;
  }

  // Иконки/кнопки действия внутри области (в ИГ подписи живут в aria-label у svg и кнопок).
  // Порядок — от внешних к глубоким: кнопки действий самого поста лежат выше, а одноимённые
  // кнопки внутри комментариев («Нравится» у каждого комментария) — глубже в DOM.
  function igxMetricButtons(root, words, excludeWords) {
    const out = [];
    if (!root || !root.querySelectorAll) return out;
    const seen = new Set();
    const add = (el) => {
      if (el && !seen.has(el)) {
        seen.add(el);
        out.push(el);
      }
    };
    root.querySelectorAll('svg[aria-label], svg[title]').forEach((svg) => {
      const label = igxNormalizeText(svg.getAttribute('aria-label') || svg.getAttribute('title'));
      if (!igxLabelMatches(label, words)) return;
      if (excludeWords && igxLabelMatches(label, excludeWords)) return;
      add(svg.closest('button, [role="button"], a') || svg.parentElement || svg);
    });
    root
      .querySelectorAll('button[aria-label], button[title], [role="button"][aria-label], [role="button"][title], a[aria-label], a[title]')
      .forEach((btn) => {
        const label = igxNormalizeText(btn.getAttribute('aria-label') || btn.getAttribute('title'));
        if (!igxLabelMatches(label, words)) return;
        if (excludeWords && igxLabelMatches(label, excludeWords)) return;
        add(btn);
      });
    const depthOf = (el) => {
      let d = 0;
      let cur = el;
      while (cur && cur !== root && d < 100) {
        cur = cur.parentElement;
        d++;
      }
      return d;
    };
    out.sort((a, b) => depthOf(a) - depthOf(b));
    return out;
  }

  // Стратегия 2: подписи aria-label/title, в которых лежит само число
  // («Нравится: 1 234», «1 234 отметок "Нравится"», «Посмотреть все 12 комментариев»).
  // excludeWords — подписи чужих метрик, которые содержит слова этой: для просмотров это
  // «View all 12 comments» (число там от комментариев, а не от просмотров).
  function igxCountByAttributes(root, words, excludeWords) {
    if (!root || !root.querySelectorAll) return null;
    const nodes = root.querySelectorAll('[aria-label], [title]');
    for (const el of nodes) {
      for (const attr of ['aria-label', 'title']) {
        const v = igxNormalizeText(el.getAttribute && el.getAttribute(attr));
        if (!v || v.length > 60 || !/\d/.test(v)) continue;
        if (!igxLabelMatches(v, words)) continue;
        if (excludeWords && igxLabelMatches(v, excludeWords)) continue;
        const n = igxCountFromText(v);
        if (n !== null) return n;
      }
    }
    return null;
  }

  // Стратегия 3: число рядом с иконкой/кнопкой. Порядок: подпись кнопки → её текст →
  // ближайшие соседи (столбик Reels: иконка, рядом число) → короткий числовой текст родителя.
  // boundary — область поиска: за её пределы не выходим, иначе из поста можно «вылезти»
  // в body и подставить число соседнего поста (в ленте — соседнего ролика).
  function igxCountNear(el, words, boundary) {
    if (!el) return null;
    const btn = el.closest?.('button, [role="button"], a') || el;
    const nodes = btn === el ? [el] : [el, btn];

    for (const node of nodes) {
      for (const attr of ['aria-label', 'title']) {
        const v = igxNormalizeText(node.getAttribute && node.getAttribute(attr));
        if (!v) continue;
        const n = igxCountFromText(v);
        if (n !== null) return n;
      }
    }
    for (const node of nodes) {
      const n = igxShortNumberFrom(node);
      if (n !== null) return n;
    }

    let cur = btn;
    for (let up = 0; up < 3 && cur && cur.parentElement; up++) {
      const parent = cur.parentElement;
      if (boundary && parent !== boundary && !boundary.contains(parent)) break;
      const kids = Array.from(parent.children || []);
      const idx = kids.indexOf(cur);
      const ordered = [];
      if (idx >= 0) {
        // сначала ближайшие соседи, потом всё дальше (число почти всегда вплотную к иконке)
        for (let d = 1; d < kids.length; d++) {
          if (kids[idx + d]) ordered.push(kids[idx + d]);
          if (idx - d >= 0) ordered.push(kids[idx - d]);
        }
      } else {
        ordered.push(...kids);
      }
      for (const sib of ordered) {
        if (sib === cur || sib.contains?.(btn)) continue;
        if (igxForeignAction(sib, words)) continue;
        const n = igxShortNumberFrom(sib);
        if (n !== null) return n;
      }
      if (!igxForeignAction(parent, words)) {
        const n = igxShortNumberFrom(parent);
        if (n !== null) return n;
      }
      cur = parent;
    }
    return null;
  }

  // Стратегия 4: ключевые фразы в тексте области поста
  function igxCountByText(root, patterns) {
    if (!root) return null;
    let txt = '';
    try {
      txt = root.innerText || root.textContent || '';
    } catch (_) {}
    if (!txt) return null;
    txt = igxNormalizeText(txt);
    for (const re of patterns) {
      const m = txt.match(re);
      if (!m) continue;
      const n = igxCountFromText(m[1] || m[0]);
      if (n !== null) return n;
    }
    return null;
  }

  // Контейнер поста вокруг видимого ролика: ближайший предок, внутри которого есть
  // кнопки действий. В ленте Reels <article> отсутствует, а <body> слишком широко —
  // в виртуализированной ленте там лежат числа соседних роликов.
  function igxPostScopeFromVideo(video) {
    if (!video) return null;
    let cur = video.parentElement;
    for (let up = 0; up < 12 && cur && cur !== document.body; up++, cur = cur.parentElement) {
      if (igxMetricButtons(cur, IGX_LIKE_WORDS).length || igxMetricButtons(cur, IGX_COMMENT_WORDS).length) return cur;
    }
    return null;
  }

  // Области поиска метрик: от самой точной к самой широкой. Если article не нашёлся
  // (лента Reels, сторис, попапы) — findPostArticle отдаёт body, и по нему искать нельзя.
  function igxMetricRoots(root) {
    const list = [];
    const add = (el) => {
      if (el && el.nodeType === 1 && !list.includes(el)) list.push(el);
    };
    const bodyLike = !root || root === document || root === document.body || !root.tagName;
    if (!bodyLike) add(root);
    add(igxPostScopeFromVideo(pickBestVideo()));
    if (!list.length) add(document.body);
    // Вложенную область проверяем первой: в ленте Reels контейнер ролика точнее,
    // чем article/main/body, которые отдаёт findPostArticle.
    list.sort((a, b) => (a === b ? 0 : a.contains(b) ? 1 : b.contains(a) ? -1 : 0));
    return list;
  }

  // Скрыты ли лайки: по тексту области поста (innerText — видимый текст, textContent — запас)
  function igxLikesHidden(roots) {
    for (const r of roots) {
      let txt = '';
      try {
        txt = r.innerText || r.textContent || '';
      } catch (_) {}
      if (txt && IGX_LIKES_HIDDEN_RE.test(txt)) return true;
    }
    return false;
  }

  // Прогон стратегий 2-4 по всем областям поиска
  function igxExtractMetric(roots, words, patterns, excludeWords) {
    for (const r of roots) {
      const byAttr = igxCountByAttributes(r, words, excludeWords);
      if (byAttr !== null) return byAttr;
    }
    for (const r of roots) {
      for (const el of igxMetricButtons(r, words, excludeWords)) {
        const near = igxCountNear(el, words, r);
        if (near !== null) return near;
      }
    }
    for (const r of roots) {
      const byText = igxCountByText(r, patterns);
      if (byText !== null) return byText;
    }
    return null;
  }

  // Извлечение детальных данных публикации (Reels / видео / карусель / фото)
  function extractInstagramPostData(scope) {
    const article = findPostArticle(scope);
    const root = article || document;

    // 1. Попытка достать точные данные из React Fiber / Props
    let fiberData = null;
    try {
      const candidates = [
        root.querySelector('video'),
        root.querySelector('ul._acay'),
        root,
        document.querySelector('[role="dialog"] article'),
        document.querySelector('article'),
      ].filter(Boolean);

      for (const el of candidates) {
        const k = Object.keys(el).find((key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'));
        if (!k) continue;
        let curr = el[k];
        for (let depth = 0; depth < 25 && curr; depth++) {
          const p = curr.memoizedProps || curr.pendingProps;
          if (p) {
            const item = p.item || p.media || p.post || p.clip;
            if (item && (item.like_count !== undefined || item.caption !== undefined || item.taken_at !== undefined || item.pk)) {
              fiberData = item;
              break;
            }
          }
          curr = curr.return;
        }
        if (fiberData) break;
      }
    } catch (_) {}

    // 2. Сколько дней назад выложен ролик
    let daysAgo = null;
    if (fiberData && typeof fiberData.taken_at === 'number') {
      const diffMs = Date.now() - fiberData.taken_at * 1000;
      daysAgo = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
    }
    if (daysAgo === null) {
      const timeEl = root.querySelector('time[datetime], time');
      if (timeEl) {
        const dtStr = timeEl.getAttribute('datetime');
        if (dtStr) {
          const dt = new Date(dtStr);
          if (!isNaN(dt.getTime())) {
            const diffMs = Date.now() - dt.getTime();
            daysAgo = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
          }
        }
        if (daysAgo === null) {
          const rawT = (timeEl.getAttribute('title') || timeEl.textContent || '').trim().toLowerCase();
          const mDays = rawT.match(/(\d+)\s*(?:д|дн|days?|d)/i);
          const mWeeks = rawT.match(/(\d+)\s*(?:нед|w|weeks?)/i);
          const mMonths = rawT.match(/(\d+)\s*(?:мес|mo|months?)/i);
          const mHours = rawT.match(/(\d+)\s*(?:ч|h|hours?|мин|m|минут|minutes?)/i);
          if (mDays) daysAgo = parseInt(mDays[1], 10);
          else if (mWeeks) daysAgo = parseInt(mWeeks[1], 10) * 7;
          else if (mMonths) daysAgo = parseInt(mMonths[1], 10) * 30;
          else if (mHours) daysAgo = 0;
        }
      }
    }

    // Области поиска метрик общие для просмотров/лайков/комментариев/репостов:
    // статья или модалка поста (если нашлась), затем контейнер видимого ролика
    // (лента Reels, где <article> нет вообще), и только в последнюю очередь body —
    // если ничего точнее не нашлось.
    const metricRoots = igxMetricRoots(root);

    // 3. Просмотры — та же цепочка стратегий, что у лайков/комментариев/репостов.
    // Раньше здесь брался первый span/div, где в innerText есть «просмотр» и цифра:
    // в это часто попадал контейнер со всем текстом поста, и просмотры уезжали.
    // Из слов исключаем комментарии: в англ. интерфейсе «View all 12 comments» —
    // это счётчик комментариев, хотя и содержит слово view.
    let views = null;
    if (fiberData) {
      if (typeof fiberData.play_count === 'number') views = fiberData.play_count;
      else if (typeof fiberData.view_count === 'number') views = fiberData.view_count;
    }
    if (views === null) {
      views = igxExtractMetric(metricRoots, IGX_VIEW_WORDS, IGX_VIEW_TEXT_PATTERNS, IGX_COMMENT_WORDS);
    }

    // 4. Лайки (если скрыты — так и пишем, но не 0)
    let likes = null;
    let likesHidden = !!(fiberData && fiberData.like_and_view_counts_disabled);
    if (!likesHidden && fiberData && typeof fiberData.like_count === 'number') {
      likes = fiberData.like_count;
    }
    if (!likesHidden && likes === null) {
      likes = igxExtractMetric(metricRoots, IGX_LIKE_WORDS, IGX_LIKE_TEXT_PATTERNS);
    }
    if (!likesHidden && likes === null) {
      likesHidden = igxLikesHidden(metricRoots);
    }

    // 5. Комментарии
    let comments = null;
    if (fiberData && typeof fiberData.comment_count === 'number') {
      comments = fiberData.comment_count;
    }
    if (comments === null) {
      comments = igxExtractMetric(metricRoots, IGX_COMMENT_WORDS, IGX_COMMENT_TEXT_PATTERNS);
    }

    // 6. Репосты
    let reposts = null;
    if (fiberData) {
      if (typeof fiberData.reshare_count === 'number') reposts = fiberData.reshare_count;
      else if (typeof fiberData.share_count === 'number') reposts = fiberData.share_count;
    }
    if (reposts === null) {
      reposts = igxExtractMetric(metricRoots, IGX_SHARE_WORDS, IGX_REPOST_TEXT_PATTERNS);
    }

    // 7. Описание (если нет, просто пишет нет)
    let caption = null;
    if (fiberData && fiberData.caption && typeof fiberData.caption.text === 'string') {
      caption = fiberData.caption.text.trim();
    }
    if (!caption) {
      const capEl = root.querySelector('div._a9zs, h1, span._ap3a._aaco, div[data-testid="post-comment-root"] span');
      if (capEl) {
        const innerSpan = capEl.querySelector('span');
        const raw = innerSpan ? (innerSpan.innerText || innerSpan.textContent || '') : (capEl.innerText || capEl.textContent || '');
        caption = raw.trim();
      }
    }
    if (!caption) {
      caption = findReelsCaptionText(root);
    }
    if (caption) {
      caption = caption.replace(/\s*(?:…|\.\.\.)?\s*(?:ещё|more)\s*$/i, '').trim();
    }

    // Отсутствующие значения отдаём как null, а не строками-заглушками («нет», «нет данных»,
    // «не определено»): печатать строку или нет, решает formatPostDataText. Честно найденный
    // ноль остаётся нулём. Скрытые лайки — реальная информация, её оставляем.
    return {
      daysAgo,
      views,
      likes: likesHidden ? 'скрыто' : likes,
      comments,
      reposts,
      description: caption && caption.length > 0 ? caption : null,
    };
  }

  // Значение поля → строка для вывода. Пустое/отсутствующее значение даёт '': такую
  // строку в текст не пишем вовсе и поле не упоминаем. Строки-заглушки («нет»,
  // «нет данных», «не определено») тоже не печатаем — они означают «данных нет».
  function igxMetaValue(v) {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'number' ? (Number.isFinite(v) ? v.toLocaleString('ru-RU') : '') : String(v).trim();
    if (!s) return '';
    const low = s.toLowerCase();
    if (low === 'нет' || low === 'нет данных' || low === 'не определено') return '';
    return s;
  }

  function formatPostDataText(data) {
    if (!data) return '';
    const rows = [
      ['Сколько дней назад выложен ролик: ', data.daysAgo],
      ['Просмотры: ', data.views],
      ['Лайки: ', data.likes],
      ['Комментарии: ', data.comments],
      ['Репосты: ', data.reposts],
    ];
    const lines = [];
    for (const [label, value] of rows) {
      const v = igxMetaValue(value);
      if (v) lines.push(label + v);
    }
    // Описание — по-прежнему последней строкой; многострочный текст переносим как было.
    const desc = igxMetaValue(data.description);
    if (desc) lines.push(`Описание: ${desc.includes('\n') ? '\n' + desc : desc}`);
    // Ни одного поля с данными — возвращаем пустую строку (вызывающий код не должен
    // в этом случае затирать буфер обмена).
    return lines.join('\n');
  }

  function initOcrPopDrag(pop) {
    const head = pop.querySelector('.igx-ocr-head');
    if (!head) return;

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;

    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = pop.getBoundingClientRect();
      origLeft = rect.left;
      origTop = rect.top;
      pop.style.left = `${origLeft}px`;
      pop.style.top = `${origTop}px`;
      pop.style.right = 'auto';
      pop.style.bottom = 'auto';
      head.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });

    head.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const newL = Math.max(10, Math.min(window.innerWidth - pop.offsetWidth - 10, origLeft + dx));
      const newT = Math.max(10, Math.min(window.innerHeight - pop.offsetHeight - 10, origTop + dy));
      pop.style.left = `${newL}px`;
      pop.style.top = `${newT}px`;
    });

    const endDrag = (e) => {
      if (!isDragging) return;
      isDragging = false;
      try {
        head.releasePointerCapture?.(e.pointerId);
      } catch (_) {}
      chrome.storage.local.set({
        igx_ocr_pos: { left: pop.style.left, top: pop.style.top },
      });
    };

    head.addEventListener('pointerup', endDrag);
    head.addEventListener('pointercancel', endDrag);
  }

  function ensureOcrPopup() {
    if (igxOcrPop && document.body.contains(igxOcrPop)) return igxOcrPop;
    const pop = document.createElement('div');
    pop.className = 'igx-ocr-pop';
    pop.innerHTML =
      '<div class="igx-ocr-head"><span class="igx-ocr-title">Извлечение текста</span><button class="igx-ocr-close" title="Закрыть">✕</button></div>' +
      '<div class="igx-ocr-tabs">' +
      '<button type="button" class="igx-ocr-tab igx-tab-video active">🎬 Видео</button>' +
      '<button type="button" class="igx-ocr-tab igx-tab-slides">🖼 Слайды</button>' +
      '</div>' +
      '<div class="igx-ocr-inputs">' +
      '<div class="igx-ocr-field">' +
      '<div class="igx-ocr-field-label igx-lbl-start">Первые сек</div>' +
      '<input type="number" class="igx-ocr-start" min="0" max="60" value="7">' +
      '</div>' +
      '<div class="igx-ocr-field">' +
      '<div class="igx-ocr-field-label igx-lbl-end">Последние сек</div>' +
      '<input type="number" class="igx-ocr-end" min="0" max="60" value="7">' +
      '</div>' +
      '</div>' +
      '<div class="igx-ocr-modes">' +
      '<label title="Распознаёт надписи на кадрах"><input type="radio" name="igx-ocr-mode" value="text" checked> Текст с экрана</label>' +
      '<label title="Распознаёт речь из звука"><input type="radio" name="igx-ocr-mode" value="audio"> Речь из звука</label>' +
      '</div>' +
      '<div class="igx-ocr-fps-wrap" style="margin-top:6px; padding:6px 10px; background:rgba(255,255,255,0.04); border-radius:6px; border:1px solid rgba(255,255,255,0.08);">' +
      '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">' +
      '<span style="font-size:11px; color:#cbd5e1; font-weight:600;">🎯 Частота анализа кадров:</span>' +
      '<span class="igx-ocr-fps-label" style="font-size:11px; color:#38bdf8; font-weight:700;">1 кадр / 1.0 с</span>' +
      '</div>' +
      '<input type="range" class="igx-ocr-fps-slider" min="1" max="5" step="1" value="3" style="width:100%; accent-color:#38bdf8; cursor:pointer;" />' +
      '<div style="display:flex; justify-content:space-between; font-size:9px; color:#64748b; margin-top:2px;">' +
      '<span>2.5с (быстро)</span>' +
      '<span>1.5с</span>' +
      '<span>1.0с (норма)</span>' +
      '<span>0.5с</span>' +
      '<span>0.3с (макс)</span>' +
      '</div>' +
      '</div>' +
      '<div class="igx-ocr-badge igx-ocr-slide-note" style="display:none;">На слайдах текст распознаётся со слайдов</div>' +
      '<label class="igx-ocr-chk-meta-label" title="При копировании добавлять данные ролика (дни, просмотры, лайки, комментарии, репосты, описание) перед текстом транскрипции">' +
      '<input type="checkbox" class="igx-ocr-chk-meta" />' +
      '<span>📋 Добавлять данные видео к тексту</span>' +
      '</label>' +
      '<details class="igx-ocr-api-details" style="margin-top: 8px; margin-bottom: 8px; font-size: 11px; color: #8fa3b8; cursor: pointer;">' +
      '<summary style="outline: none; user-select: none; font-weight: 600;">⚡ Ключ Groq API (бесплатно, точность 100% Premiere)</summary>' +
      '<div style="margin-top: 6px; display: flex; flex-direction: column; gap: 4px;">' +
      '<input type="password" class="igx-ocr-apikey-input" placeholder="gsk_... (бесплатно на console.groq.com) или sk-..." style="width: 100%; box-sizing: border-box; padding: 6px 8px; font-size: 11px; background: #1a2129; border: 1px solid #37424f; border-radius: 6px; color: #e7edf3;" />' +
      '<span style="font-size: 10px; color: #64748b; line-height: 1.3;">Распознаёт речь через Whisper Large v3 и текст на слайдах/видео через Vision AI (Qwen 3.6 / GPT-4o). Если пусто — работает локально.</span>' +
      '</div>' +
      '</details>' +
      '<button class="igx-btn igx-ocr-run">📝 Извлечь и скопировать</button>' +
      '<div class="igx-ocr-status"></div>' +
      '<div class="igx-ocr-result-wrap" style="display:none;">' +
      '<div class="igx-ocr-result-head"><span>Результат:</span><button type="button" class="igx-ocr-copy-btn">📋 Скопировать</button></div>' +
      '<textarea class="igx-ocr-result-text" rows="5" readonly></textarea>' +
      '</div>';
    document.body.appendChild(pop);

    initOcrPopDrag(pop);

    pop.querySelector('.igx-ocr-close').addEventListener('click', () => {
      pop.style.display = 'none';
    });
    pop.querySelector('.igx-ocr-run').addEventListener('click', () => ocrRun());

    const copyBtn = pop.querySelector('.igx-ocr-copy-btn');
    const resultText = pop.querySelector('.igx-ocr-result-text');
    copyBtn.addEventListener('click', async () => {
      const text = resultText.value;
      if (!text) return;
      const ok = await copyToClipboard(text);
      if (ok) {
        copyBtn.textContent = '✓ Скопировано!';
        setTimeout(() => {
          copyBtn.textContent = '📋 Скопировать';
        }, 2000);
      } else {
        resultText.focus();
        resultText.select();
        document.execCommand('copy');
        copyBtn.textContent = '✓ Скопировано!';
        setTimeout(() => {
          copyBtn.textContent = '📋 Скопировать';
        }, 2000);
      }
    });

    const metaChk = pop.querySelector('.igx-ocr-chk-meta');
    if (metaChk) {
      chrome.storage.local.get([OCR_INCLUDE_META_KEY]).then((d) => {
        if (d && typeof d[OCR_INCLUDE_META_KEY] === 'boolean') {
          metaChk.checked = d[OCR_INCLUDE_META_KEY];
        }
      });
      metaChk.addEventListener('change', () => {
        chrome.storage.local.set({ [OCR_INCLUDE_META_KEY]: metaChk.checked });
        if (resultText && resultText.value) {
          const currentVal = resultText.value;
          const hasSep = currentVal.includes('\n\n---\n');
          if (metaChk.checked && !hasSep) {
            const media = detectCurrentPostMedia();
            const postMeta = extractInstagramPostData((media && media.scope) || findPostArticle() || document);
            const metaStr = formatPostDataText(postMeta);
            if (metaStr) resultText.value = `${metaStr}\n\n---\n${currentVal}`;
          } else if (!metaChk.checked && hasSep) {
            const parts = currentVal.split('\n\n---\n');
            if (parts.length > 1) resultText.value = parts.slice(1).join('\n\n---\n');
          }
        }
      });
    }

    const apiKeyInput = pop.querySelector('.igx-ocr-apikey-input');
    chrome.storage.local.get([OCR_APIKEY_KEY]).then((d) => {
      if (d && d[OCR_APIKEY_KEY]) apiKeyInput.value = d[OCR_APIKEY_KEY];
    });
    const saveApiKey = () => {
      chrome.storage.local.set({ [OCR_APIKEY_KEY]: apiKeyInput.value.trim() });
    };
    apiKeyInput.addEventListener('input', saveApiKey);
    apiKeyInput.addEventListener('change', saveApiKey);

    const fpsWrap = pop.querySelector('.igx-ocr-fps-wrap');
    const fpsSlider = pop.querySelector('.igx-ocr-fps-slider');
    const fpsLabel = pop.querySelector('.igx-ocr-fps-label');
    const fpsLabels = {
      1: '1 кадр / 2.5 с (быстро)',
      2: '1 кадр / 1.5 с',
      3: '1 кадр / 1.0 с (рекомендуется)',
      4: '2 кадра / с (высокая)',
      5: '3 кадра / с (максимальная)',
    };

    if (fpsSlider) {
      fpsSlider.addEventListener('input', () => {
        const lvl = parseInt(fpsSlider.value, 10) || 3;
        if (fpsLabel) fpsLabel.textContent = fpsLabels[lvl] || '1 кадр / 1.0 с';
        chrome.storage.local.set({ [OCR_VIDEO_FPS_KEY]: lvl });
      });
      chrome.storage.local.get([OCR_VIDEO_FPS_KEY]).then((d) => {
        const lvl = (d && d[OCR_VIDEO_FPS_KEY]) || 3;
        fpsSlider.value = lvl;
        if (fpsLabel) fpsLabel.textContent = fpsLabels[lvl] || '1 кадр / 1.0 с';
      });
    }

    function updateFpsVisibility() {
      const isVideo = igxActiveMediaType === 'video';
      const curMode = (pop.querySelector('input[name="igx-ocr-mode"]:checked')?.value) || 'text';
      if (fpsWrap) {
        fpsWrap.style.display = (isVideo && curMode === 'text') ? 'block' : 'none';
      }
    }

    ['pointerdown', 'mousedown', 'click'].forEach((ev) => {
      pop.addEventListener(ev, (e) => e.stopPropagation());
    });

    const tabVideo = pop.querySelector('.igx-tab-video');
    const tabSlides = pop.querySelector('.igx-tab-slides');

    function setMediaTypeUI(type) {
      igxActiveMediaType = type;
      if (type === 'carousel') {
        tabSlides.classList.add('active');
        tabVideo.classList.remove('active');
        pop.querySelector('.igx-lbl-start').textContent = 'Первые слайды';
        pop.querySelector('.igx-lbl-end').textContent = 'Последние слайды';
        pop.querySelector('.igx-ocr-modes').style.display = 'none';
        pop.querySelector('.igx-ocr-slide-note').style.display = 'block';
        pop.querySelector('.igx-ocr-api-details').style.display = 'block';
        chrome.storage.local.get([OCR_START_SLIDES_KEY, OCR_END_SLIDES_KEY]).then((d) => {
          pop.querySelector('.igx-ocr-start').value = (d && d[OCR_START_SLIDES_KEY] != null) ? d[OCR_START_SLIDES_KEY] : 2;
          pop.querySelector('.igx-ocr-end').value = (d && d[OCR_END_SLIDES_KEY] != null) ? d[OCR_END_SLIDES_KEY] : 2;
        });
      } else {
        tabVideo.classList.add('active');
        tabSlides.classList.remove('active');
        pop.querySelector('.igx-lbl-start').textContent = 'Первые сек';
        pop.querySelector('.igx-lbl-end').textContent = 'Последние сек';
        pop.querySelector('.igx-ocr-modes').style.display = 'flex';
        pop.querySelector('.igx-ocr-slide-note').style.display = 'none';
        pop.querySelector('.igx-ocr-api-details').style.display = 'block';
        chrome.storage.local.get([OCR_START_KEY, OCR_END_KEY]).then((d) => {
          pop.querySelector('.igx-ocr-start').value = (d && d[OCR_START_KEY] != null) ? d[OCR_START_KEY] : 7;
          pop.querySelector('.igx-ocr-end').value = (d && d[OCR_END_KEY] != null) ? d[OCR_END_KEY] : 7;
        });
      }
      updateFpsVisibility();
    }

    tabVideo.addEventListener('click', () => setMediaTypeUI('video'));
    tabSlides.addEventListener('click', () => setMediaTypeUI('carousel'));

    pop.querySelectorAll('input[name="igx-ocr-mode"]').forEach((r) => {
      r.addEventListener('change', () => {
        chrome.storage.local.set({ [OCR_MODE_KEY]: r.value });
        updateFpsVisibility();
      });
    });

    chrome.storage.local.get([OCR_START_KEY, OCR_END_KEY, OCR_MODE_KEY, OCR_VIDEO_FPS_KEY, OCR_INCLUDE_META_KEY]).then((d) => {
      pop.querySelector('.igx-ocr-start').value = (d && d[OCR_START_KEY] != null) ? d[OCR_START_KEY] : 7;
      pop.querySelector('.igx-ocr-end').value = (d && d[OCR_END_KEY] != null) ? d[OCR_END_KEY] : 7;
      if (metaChk && d && typeof d[OCR_INCLUDE_META_KEY] === 'boolean') {
        metaChk.checked = d[OCR_INCLUDE_META_KEY];
      }
      const mode = d[OCR_MODE_KEY] || 'text';
      const radio = pop.querySelector(`input[name="igx-ocr-mode"][value="${mode}"]`);
      if (radio) radio.checked = true;
      const lvl = d[OCR_VIDEO_FPS_KEY] || 3;
      if (fpsSlider) fpsSlider.value = lvl;
      if (fpsLabel) fpsLabel.textContent = fpsLabels[lvl] || '1 кадр / 1.0 с';
      updateFpsVisibility();
    });

    igxOcrPop = pop;
    return pop;
  }

  function ocrClampInt(val, fallback, min = 0) {
    const n = parseInt(val, 10);
    return isNaN(n) || n < min ? fallback : Math.min(n, 60);
  }

  async function openOcrModal(anchorOrType) {
    try {
      const pop = ensureOcrPopup();
      if (!pop) return;

      // Сразу отображаем попап, чтобы не зависеть от асинхронного storage
      pop.style.display = 'flex';
      pop.style.visibility = 'visible';
      pop.style.opacity = '1';
      pop.style.zIndex = '2147483647';
      pop.style.top = '70px';
      pop.style.right = '24px';
      pop.style.left = 'auto';
      pop.style.bottom = 'auto';

      safeStorageGet(['igx_ocr_pos']).then((d) => {
        try {
          if (d && d.igx_ocr_pos && d.igx_ocr_pos.left && d.igx_ocr_pos.top) {
            const leftVal = parseInt(d.igx_ocr_pos.left, 10);
            const topVal = parseInt(d.igx_ocr_pos.top, 10);
            if (!isNaN(leftVal) && !isNaN(topVal)) {
              const maxW = (window.innerWidth || 1000) - 360;
              const maxH = (window.innerHeight || 800) - 300;
              const clampedLeft = Math.max(10, Math.min(maxW, leftVal));
              const clampedTop = Math.max(10, Math.min(maxH, topVal));
              pop.style.left = `${clampedLeft}px`;
              pop.style.top = `${clampedTop}px`;
              pop.style.right = 'auto';
              pop.style.bottom = 'auto';
            }
          }
        } catch (_) {}
      });

      const statusEl = pop.querySelector('.igx-ocr-status');
      const resWrap = pop.querySelector('.igx-ocr-result-wrap');
      if (statusEl) statusEl.textContent = '';
      if (resWrap) resWrap.style.display = 'none';

      let media = null;
      try {
        media = detectCurrentPostMedia();
      } catch (err) {
        console.warn('[Insta OCR] detectCurrentPostMedia warning:', err);
      }

      const explicitType = typeof anchorOrType === 'string' ? anchorOrType : null;
      const type = explicitType || (media && media.type) || igxActiveMediaType || 'video';

      const tabVideo = pop.querySelector('.igx-tab-video');
      const tabSlides = pop.querySelector('.igx-tab-slides');
      if (type === 'carousel' && tabSlides) {
        tabSlides.click();
      } else if (tabVideo) {
        tabVideo.click();
      }
    } catch (err) {
      console.error('[Insta OCR] openOcrModal error:', err);
    }
  }

  function openOcrPopup(anchorOrType) {
    return openOcrModal(anchorOrType);
  }

  async function ocrRun() {
    const pop = igxOcrPop;
    if (!pop) return;
    const statusEl = pop.querySelector('.igx-ocr-status');
    const runBtn = pop.querySelector('.igx-ocr-run');
    const resWrap = pop.querySelector('.igx-ocr-result-wrap');
    const resText = pop.querySelector('.igx-ocr-result-text');
    const metaChk = pop.querySelector('.igx-ocr-chk-meta');
    const includeMeta = metaChk ? metaChk.checked : false;

    const media = detectCurrentPostMedia();
    // Тип берём с ВИДИМОЙ вкладки попапа, а не из залипшего igxActiveMediaType:
    // раньше при неудачном определении медиа (media === null) оставалось прежнее
    // значение 'video' — и на карусели запускалась видео-ветка с перемоткой.
    const tabSlidesActive = !!pop.querySelector('.igx-tab-slides.active');
    const activeType = tabSlidesActive
      ? 'carousel'
      : ((media && media.type) || igxActiveMediaType || 'video');

    if (activeType === 'carousel') {
      // В этом режиме НИ ОДНО обращение к currentTime/play/pause не выполняется:
      // перемотка видео здесь запрещена, листаются только слайды.
      const startCount = ocrClampInt(pop.querySelector('.igx-ocr-start').value, 2, 0);
      const endCount = ocrClampInt(pop.querySelector('.igx-ocr-end').value, 2, 0);
      chrome.storage.local.set({ [OCR_START_SLIDES_KEY]: startCount, [OCR_END_SLIDES_KEY]: endCount });

      const storedKey = await chrome.storage.local.get(OCR_APIKEY_KEY);
      const apiKey = (storedKey && storedKey[OCR_APIKEY_KEY]) || '';

      runBtn.disabled = true;
      try {
        const { actualTotal, warnings, headSlides, tailSlides, headText, tailText } = await extractCarouselSlides(
          media || { scope: document },
          startCount,
          endCount,
          apiKey,
          statusEl
        );

        // Честный отчёт: сколько слайдов реально удалось захватить и где встали
        const warnList = Array.isArray(warnings) ? warnings : [];
        const warnLine = warnList.length ? `\n\n(⚠ ${warnList.join('; ')})` : '';
        const ocrBody = `Хук:\n${headText}\n\nПризыв:\n${tailText}${warnLine}`;
        let fullResult = ocrBody;
        if (includeMeta) {
          const postMeta = extractInstagramPostData((media && media.scope) || findPostArticle() || document);
          const metaStr = formatPostDataText(postMeta);
          if (metaStr) fullResult = `${metaStr}\n\n---\n${ocrBody}`;
        }

        if (resText && resWrap) {
          resText.value = fullResult;
          resWrap.style.display = 'block';
        }

        const ok = await copyToClipboard(fullResult);
        statusEl.textContent = ok
          ? (warnList.length
            ? `✓ Скопировано. Захвачено слайдов: ${actualTotal} — ⚠ ${warnList[warnList.length - 1]}`
            : '✓ Скопировано в буфер обмена!')
          : (warnList.length ? `Текст извлечён (⚠ ${warnList.join('; ')})` : 'Текст извлечён! Нажми «📋 Скопировать» ниже.');
      } catch (err) {
        statusEl.textContent = String((err && err.message) || err);
      } finally {
        runBtn.disabled = false;
      }
      return;
    }

    const video = (media && media.video) || pickBestVideo();
    if (!video) {
      statusEl.textContent = 'На экране нет видео — открой рилс/видео или переключи на вкладку «Слайды».';
      return;
    }
    const d = video.duration;
    if (!isFinite(d) || d <= 0.5) {
      statusEl.textContent = 'У этого видео нет длины (эфир или ещё грузится).';
      return;
    }

    const startSec = ocrClampInt(pop.querySelector('.igx-ocr-start').value, 7, 0);
    const endSec = ocrClampInt(pop.querySelector('.igx-ocr-end').value, 7, 0);
    const modeRadio = pop.querySelector('input[name="igx-ocr-mode"]:checked');
    const mode = modeRadio ? modeRadio.value : 'text';
    chrome.storage.local.set({ [OCR_START_KEY]: startSec, [OCR_END_KEY]: endSec, [OCR_MODE_KEY]: mode });

    const storedData = await chrome.storage.local.get([OCR_APIKEY_KEY, OCR_VIDEO_FPS_KEY]);
    const apiKey = (storedData && storedData[OCR_APIKEY_KEY]) || '';
    const fpsLevel = (storedData && storedData[OCR_VIDEO_FPS_KEY]) || 3;

    runBtn.disabled = true;
    const wasPlaying = !video.paused;
    const prevTime = video.currentTime;

    try {
      // ОБЯЗАТЕЛЬНО ставим видео на паузу перед анализом, чтобы плеер Instagram
      // не зацикливался и не сбрасывал currentTime в 0:00!
      try { video.pause(); } catch (_) {}

      const { headTo, tailFrom, tailTo } = getVideoWindows(d, startSec, endSec);
      let headText = '';
      let tailText = '';

      const directUrl = findVideoUrl(video);

      if (mode === 'audio') {
        let asrSuccess = false;
        if (directUrl) {
          try {
            statusEl.textContent = apiKey ? 'Распознаю речь через Cloud API…' : 'Распознаю речь (прямая загрузка аудио)…';
            const asrRes = await asrRecognizeUrl(directUrl, headTo, tailFrom, tailTo, apiKey);
            headText = asrRes.headText;
            tailText = asrRes.tailText;
            asrSuccess = true;
          } catch (e) {
            console.warn('Прямое извлечение аудио не удалось, переключаюсь на запись из плеера:', e);
          }
        }
        if (!asrSuccess) {
          statusEl.textContent = `Записываю звук хука (0–${headTo.toFixed(1)} с)…`;
          const headB64 = await blobToBase64(await recordRange(video, 0, headTo));
          statusEl.textContent = `Записываю звук призыва (${tailFrom.toFixed(1)}–${tailTo.toFixed(1)} с)…`;
          const tailB64 = await blobToBase64(await recordRange(video, tailFrom, tailTo));
          statusEl.textContent = apiKey ? 'Распознаю речь хука (Cloud API)…' : 'Распознаю речь хука (Whisper)…';
          headText = await asrRecognize(headB64, apiKey);
          statusEl.textContent = apiKey ? 'Распознаю речь призыва (Cloud API)…' : 'Распознаю речь призыва (Whisper)…';
          tailText = await asrRecognize(tailB64, apiKey);
        }
      } else {
        // Текст с экрана: пробуем прямое извлечение кадров из MP4 без оверлеев Instagram
        let directOcrSuccess = false;
        if (directUrl) {
          try {
            statusEl.textContent = apiKey ? 'Распознаю текст видео через прямой поток (Vision AI)…' : 'Распознаю текст видео через прямой поток…';
            const headTs = getRangeTimestamps(0, headTo, fpsLevel);
            const tailTs = getRangeTimestamps(tailFrom, tailTo, fpsLevel);
            const directRes = await ocrVideoDirect(directUrl, headTs, tailTs, apiKey);
            if (directRes && (directRes.headText || directRes.tailText)) {
              headText = compactOcrText(directRes.headText);
              tailText = compactOcrText(directRes.tailText);
              directOcrSuccess = true;
            }
          } catch (e) {
            console.warn('Прямое OCR видео не удалось, переключаюсь на захват кадров из вкладки:', e);
          }
        }

        if (!directOcrSuccess) {
          statusEl.textContent = apiKey ? 'Снимаю кадры видео и распознаю текст (Vision AI)…' : 'Снимаю кадры видео и распознаю текст…';
          const headFrames = await captureRange(video, 0, headTo, fpsLevel, statusEl, 'начала');
          const tailFrames = await captureRange(video, tailFrom, tailTo, fpsLevel, statusEl, 'конца');

          headText = compactOcrText(await ocrFrames(headFrames, apiKey, statusEl, 'хука'));
          tailText = compactOcrText(await ocrFrames(tailFrames, apiKey, statusEl, 'призыва'));

          // Если OCR не нашёл текст на кадрах, проверяем встроенные DOM-субтитры Instagram
          if (!headText) {
            const domSub = findReelsCaptionText(media ? media.scope : document);
            if (domSub) headText = domSub;
          }
        }
      }

      const hookFormatted = headTo <= 0 ? '(не выбрано)' : (headText || '(текст на видео не найден)');
      const ctaFormatted = tailFrom >= tailTo ? '(не выбрано)' : (tailText || '(текст на видео не найден)');
      const ocrBody = `Хук:\n${hookFormatted}\n\nПризыв:\n${ctaFormatted}`;
      let fullResult = ocrBody;

      if (includeMeta) {
        const postMeta = extractInstagramPostData((media && media.scope) || findPostArticle() || document);
        const metaStr = formatPostDataText(postMeta);
        if (metaStr) fullResult = `${metaStr}\n\n---\n${ocrBody}`;
      }

      if (resText && resWrap) {
        resText.value = fullResult;
        resWrap.style.display = 'block';
      }

      const ok = await copyToClipboard(fullResult);
      statusEl.textContent = ok
        ? '✓ Скопировано в буфер обмена!'
        : 'Текст извлечён! Нажми «📋 Скопировать» ниже.';
    } catch (err) {
      statusEl.textContent = String((err && err.message) || err);
    } finally {
      try {
        video.currentTime = prevTime;
      } catch (_) {}
      if (wasPlaying) {
        video.play().catch(() => {});
      } else {
        try {
          video.pause();
        } catch (_) {}
      }
      runBtn.disabled = false;
    }
  }

  // Узлы нашего собственного интерфейса. Их добавление (тултип через innerHTML, панель,
  // полоска) не должно запускать пересканирование страницы: раньше фильтр отсекал только
  // сам .igx-tooltip, а его дочерние узлы проходили — и каждый показ тултипа дергал
  // полный обход всех a[href] на странице.
  const IGX_OWN_UI_SELECTOR =
    '.igx-tooltip, .igx-badge-wrap, .igx-bolt, .igx-side-panel, .igx-seekbar, .igx-carousel-bar, .igx-ocr-pop, .igx-link-menu, .igx-link-btn';
  function igxIsOwnUiNode(n) {
    if (!n || n.nodeType !== 1) return false;
    try {
      return !!(n.matches?.(IGX_OWN_UI_SELECTOR) || n.closest?.(IGX_OWN_UI_SELECTOR));
    } catch (_) {
      return false;
    }
  }

  const observer = new MutationObserver((mutations) => {
    let hasNewNodes = false;
    for (const m of mutations) {
      if (m.type === 'childList' && m.addedNodes.length > 0) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && !igxIsOwnUiNode(n)) {
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
      scanForCarousels();
      debouncedApplyFilters();
    }, 250);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  scanForRows();
  scanForVideos();
  scanForCarousels();

  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg && (msg.action === 'open_ocr_modal' || msg.action === 'open_ocr')) {
          openOcrPopup(msg.mediaType || null);
          sendResponse({ ok: true });
        }
      });
    }
  } catch (_) {}

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

    const dialog = afkDialog();
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
  // Состояние АФК строго изолировано для каждой вкладки (через sessionStorage + chrome.storage),
  // чтобы можно было массово запускать АФК сразу в нескольких вкладках без конфликтов!
  const AFK_TAB_STORAGE_KEY = 'igx_afk_tab_state';
  const AFK_LAST_WORD_KEY = 'igx_afk_last_word';
  try {
    chrome.storage.local.remove('igx_afk_state');
  } catch (_) {}

  function getAfkSessionKey() {
    try {
      let id = sessionStorage.getItem('igx_afk_tab_id');
      if (!id) {
        id = 'tab_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
        sessionStorage.setItem('igx_afk_tab_id', id);
      }
      return 'igx_afk_' + id;
    } catch (_) {
      return 'igx_afk_local_tab';
    }
  }

  function getSessionAfkState() {
    try {
      const raw = sessionStorage.getItem(AFK_TAB_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function setSessionAfkState(st) {
    try {
      if (st) {
        sessionStorage.setItem(AFK_TAB_STORAGE_KEY, JSON.stringify(st));
      } else {
        sessionStorage.removeItem(AFK_TAB_STORAGE_KEY);
      }
    } catch (_) {}
  }

  let cachedTabId = null;
  async function getTabId() {
    if (cachedTabId !== null) return cachedTabId;
    try {
      const res = await igxSend({ type: 'getTabId' }, 1500);
      if (res && typeof res.tabId === 'number') {
        cachedTabId = res.tabId;
        return cachedTabId;
      }
    } catch (_) {}
    return null;
  }
  const AFK_MAX_FOLLOWERS = 50000;
  // ИГ редиректит /followers/ → mutualOnly (только твои подписки).
  // Нужен mutualFirst — полный список подписчиков (сначала общие, потом все).
  const AFK_FOLLOWERS_MODE = 'mutualFirst';
  let afkLoopActive = false;

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

  async function afkGetState() {
    // 1. Сначала читаем из sessionStorage этой конкретной вкладки (мгновенно и полностью изолированно)
    const mem = getSessionAfkState();
    if (mem && typeof mem === 'object') return mem;

    // 2. Читаем из storage по ключу сессии вкладки
    const key = getAfkSessionKey();
    try {
      const d = await chrome.storage.local.get(key);
      if (d && d[key]) {
        setSessionAfkState(d[key]);
        return d[key];
      }
    } catch (_) {}

    // 3. Запасной вариант: проверяем tabId
    try {
      const tabId = await getTabId();
      if (tabId) {
        const tabKey = `igx_afk_tab_${tabId}`;
        const td = await chrome.storage.local.get(tabKey);
        if (td && td[tabKey]) {
          setSessionAfkState(td[tabKey]);
          return td[tabKey];
        }
      }
    } catch (_) {}

    return null;
  }

  async function afkPatchState(patch) {
    const cur = (await afkGetState()) || {};
    const st = Object.assign({ on: false, word: '', visited: [], lists: [], needSearch: false, plainTried: false, jumped: false }, cur, patch);

    // Сохраняем в sessionStorage этой вкладки
    setSessionAfkState(st);

    // Сохраняем в storage под индивидуальным ключом вкладки
    const key = getAfkSessionKey();
    try {
      await chrome.storage.local.set({ [key]: st });
    } catch (_) {}

    // Дублируем по tabId
    try {
      const tabId = await getTabId();
      if (tabId) {
        await chrome.storage.local.set({ [`igx_afk_tab_${tabId}`]: st });
      }
    } catch (_) {}

    // Сохраняем последнее введённое слово как глобальное значение по умолчанию для новых вкладок
    if (patch && typeof patch.word === 'string' && patch.word.trim()) {
      try {
        await chrome.storage.local.set({ [AFK_LAST_WORD_KEY]: patch.word.trim() });
      } catch (_) {}
    }

    return st;
  }

  async function afkRunning() {
    if (afkLoopActive) return true;
    const st = await afkGetState();
    return !!(st && st.on);
  }

  function afkDialog() {
    for (const d of document.querySelectorAll('[role="dialog"]')) {
      if (afkUserCount(d) > 0 || d.querySelector('input')) return d;
    }
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
    afkLoopActive = false;
    await afkPatchState({ on: false, needSearch: false });
    setSessionAfkState(null);
    const key = getAfkSessionKey();
    try {
      await chrome.storage.local.remove(key);
    } catch (_) {}
    const tabId = await getTabId();
    if (tabId) {
      try {
        await chrome.storage.local.remove(`igx_afk_tab_${tabId}`);
      } catch (_) {}
    }
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

  function afkSetBtnText(text) {
    const panel = document.querySelector('.igx-side-panel');
    if (!panel) return;
    const btn = panel.querySelector('.igx-btn-autocheck');
    if (!btn) return;
    btn.textContent = text;
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

  // Поиск поля ввода поиска внутри модалки списка (исключая UI расширения)
  function afkFindSearchInput(root) {
    const scope = root || afkDialog() || document;
    const allInputs = scope.querySelectorAll('input');
    // 1. Поле с признаком поиска (Search / Поиск)
    for (const inp of allInputs) {
      if (inp.closest('.igx-side-panel, .igx-ocr-pop, .igx-tooltip')) continue;
      const type = (inp.getAttribute('type') || 'text').toLowerCase();
      if (type !== 'text' && type !== 'search') continue;
      const ph = (inp.getAttribute('placeholder') || '').toLowerCase();
      const aria = (inp.getAttribute('aria-label') || '').toLowerCase();
      if (/search|поиск/i.test(ph) || /search|поиск/i.test(aria)) {
        const r = inp.getBoundingClientRect();
        if (r.width > 20 && r.height >= 8) return inp;
      }
    }
    // 2. Любое видимое текстовое поле в модалке
    for (const inp of allInputs) {
      if (inp.closest('.igx-side-panel, .igx-ocr-pop, .igx-tooltip')) continue;
      const type = (inp.getAttribute('type') || 'text').toLowerCase();
      if (type !== 'text' && type !== 'search') continue;
      const r = inp.getBoundingClientRect();
      if (r.width > 40 && r.height >= 8) return inp;
    }
    return null;
  }

  // Надёжный ввод текста в React-инпут Инстаграма
  async function afkSetInputValue(input, val) {
    if (!input) return false;
    try {
      input.focus();
    } catch (_) {}

    // 1. Выделяем всё и очищаем
    try {
      input.select();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    } catch (_) {}

    // 2. Вводим текст через execCommand (браузер генерирует нативные события с вводом)
    let typed = false;
    if (val) {
      try {
        typed = document.execCommand('insertText', false, val);
      } catch (_) {}
    }

    // 3. Фолбэк нативным сеттером + сброс React _valueTracker
    if (!typed || input.value !== val) {
      try {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) {
          setter.call(input, val);
        } else {
          input.value = val;
        }
      } catch (_) {
        input.value = val;
      }
      try {
        if (input._valueTracker) {
          input._valueTracker.setValue('__igx_reset__');
        }
      } catch (_) {}
    }

    // 4. Диспатчим события для React 16/17/18 и Instagram
    try {
      input.dispatchEvent(new Event('focus', { bubbles: true }));
      input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: val, inputType: val ? 'insertText' : 'deleteContentBackward' }));
      input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: val, inputType: val ? 'insertText' : 'deleteContentBackward' }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
    } catch (_) {}

    return input.value === val;
  }

  async function afkClearWord(box) {
    const root = box || afkDialog() || document;
    const input = afkFindSearchInput(root);
    if (!input) return;
    await afkSetInputValue(input, '');
    await igxSleep(1200);
  }

  // Ввести слово в поиск списка. Возврат: 'ok' | 'empty' (по слову никого) | 'failed' (ввести не вышло) | 'noinput'
  async function afkTypeWord(word, box) {
    if (!word) return 'ok';
    const root = box || afkDialog() || document;
    let input = null;
    for (let i = 0; i < 30 && !input; i++) {
      input = afkFindSearchInput(root);
      if (!input) await igxSleep(300);
    }
    if (!input) return 'noinput';

    for (let attempt = 0; attempt < 3; attempt++) {
      await afkSetInputValue(input, word);
      await igxSleep(600);
      if (input.value === word) break;
    }
    if (input.value !== word) return 'failed';

    // Ждём загрузки отфильтрованных результатов от Инстаграма
    const t0 = Date.now();
    let count = 0;
    while (Date.now() - t0 < 8000) {
      await igxSleep(600);
      count = afkUserCount(root);
      if (count > 0) return 'ok';
      const text = (root.innerText || '').toLowerCase();
      if (/ничего не найдено|результатов нет|нет результатов|no results found|no results/i.test(text)) {
        return 'empty';
      }
    }
    return count > 0 ? 'ok' : 'empty';
  }

  async function startAfk() {
    const wordEl = sidePanelEl && sidePanelEl.querySelector('.igx-afk-word');
    const word = wordEl ? wordEl.value.trim() : '';
    await afkPatchState({ on: true, word, visited: [], lists: [], needSearch: true, plainTried: false, jumped: false });
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
    if (afkLoopActive) return;
    afkLoopActive = true;
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
        if (st0.needSearch && st0.word) {
          await afkPatchState({ needSearch: false });
          const res = await afkTypeWord(st0.word, box);
          if (res === 'failed') {
            await afkStop('не смог ввести слово в поиск модалки.');
            break;
          }
          if (res === 'noinput') {
            await afkStop(`в этом списке нет поля поиска — слово «${st0.word}» ввести некуда. Открой список, где есть поиск, или убери слово.`);
            break;
          }
          if (res === 'empty') {
            // В этом конкретном списке по слову никого нет: не останавливаем весь АФК!
            // Очищаем поиск, чтобы вернуть общий список, и прыгаем к следующему кандидату.
            afkSetBtnText(`🤖 АФК: «${st0.word}» не найден, беру следующего…`);
            await afkClearWord(box);
            await igxSleep(1500);
            const next = await afkPickNext(box);
            if (!next) {
              await afkStop(`по слову «${st0.word}» никого нет, и в списке больше нет кандидатов.`);
              break;
            }
            const stNow = await afkGetState();
            const visited = new Set((stNow && stNow.visited) || []);
            visited.add(next.username.toLowerCase());
            await afkPatchState({ visited: Array.from(visited), needSearch: true, jumped: true });
            location.href = afkFollowersUrl(next.username);
            return;
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
        let next = await afkPickNext(box);
        if (!next && st0.word) {
          // Если среди отфильтрованных по слову брать больше некого —
          // очищаем поле поиска, чтобы взять кандидата для следующего прыжка из общего списка!
          afkSetBtnText('🤖 АФК: ищу следующего кандидата…');
          await afkClearWord(box);
          await igxSleep(1500);
          next = await afkPickNext(box);
        }
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
      afkLoopActive = false;
      if (!(await afkRunning())) afkSetBtn(false);
    }
  }

  // Возобновление АФК после перехода: вкладка перезагрузилась на профиле или /подписчиках следующего чела.
  (async () => {
    // В фоновых вкладках автопроверки — сразу выходим, не трогая storage
    try {
      if (await isQuickCheckTab()) return;
    } catch (_) {}
    const st = await afkGetState();
    if (!st || !st.on) return;
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
          <button type="button" class="igx-btn-ocr" title="Извлечь хук и призыв из видео (секунды) или карусели со слайдами (слайды) и скопировать в буфер">📝 Хук и призыв (видео / слайды)</button>
          <button type="button" class="igx-btn-copy-meta" title="Скопировать данные ролика: дни публикации, просмотры, лайки, комментарии, репосты и описание">📋 Скопировать данные видео</button>
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
          if (afkLoopActive || (await afkRunning())) {
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
        if (st && st.word && afkWord) {
          afkWord.value = st.word;
        } else if (afkWord && !afkWord.value) {
          chrome.storage.local.get(AFK_LAST_WORD_KEY, (d) => {
            if (d && d[AFK_LAST_WORD_KEY] && afkWord && !afkWord.value) {
              afkWord.value = d[AFK_LAST_WORD_KEY];
            }
          });
        }
        if (st && st.on) {
          if (afkChk) afkChk.checked = true;
          afkSetBtn(true);
        }
      });
      afkWord.addEventListener('input', async (e) => {
        const val = e.target.value;
        await afkPatchState({ word: val });
        chrome.storage.local.set({ [AFK_LAST_WORD_KEY]: val.trim() });
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
      const copyMetaBtn = sidePanelEl.querySelector('.igx-btn-copy-meta');
      if (copyMetaBtn) {
        copyMetaBtn.addEventListener('click', async () => {
          const media = detectCurrentPostMedia();
          const scope = (media && media.scope) || findPostArticle() || document;
          const postMeta = extractInstagramPostData(scope);
          const metaStr = formatPostDataText(postMeta);
          // Пустой результат (нет ни одного поля) буфером обмена не затираем.
          if (!metaStr) {
            copyMetaBtn.textContent = '∅';
            setTimeout(() => {
              copyMetaBtn.textContent = '📋 Скопировать данные видео';
            }, 2000);
            return;
          }
          const ok = await copyToClipboard(metaStr);
          if (ok) {
            copyMetaBtn.textContent = '✓ Данные скопированы!';
            setTimeout(() => {
              copyMetaBtn.textContent = '📋 Скопировать данные видео';
            }, 2000);
          } else {
            showTooltip('Не удалось скопировать данные ролика', sidePanelEl);
          }
        });
      }
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
