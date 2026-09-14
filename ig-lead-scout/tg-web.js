// tg-web.js — content-скрипт для web.telegram.org (режим проверки «ТГ»).
// Background управляет этой вкладкой: открывает чат по ссылке, скроллит вверх,
// собирает текст сообщений и описания и ищет там юзы/ссылки на личку.

(function () {
  const RESERVED = new Set([
    'telegram', 'bot', 'username', 'stickers', 'addstickers', 'addemoji',
    'addtheme', 'settheme', 'share', 'proxy', 'socks', 'boost', 'm', 's',
    'invoice', 'game', 'confirmphone', 'login', 'iv', 'bg',
  ]);

  let state = {
    busy: false,
    done: false,
    error: null,
    progress: '',
    title: '',
    postsRead: 0,
    users: new Set(),
    invites: new Set(),
    instagram: new Set(),
  };

  function resetState() {
    state = {
      busy: true, done: false, error: null, progress: '', title: '',
      postsRead: 0, users: new Set(), invites: new Set(), instagram: new Set(),
    };
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function isLoggedIn() {
    // Страница входа показывает QR / форму логина
    if (document.querySelector('.auth-page, .auth-form, [class*="qr"]')) return false;
    // Залогиненный WebA имеет контейнер чатов/сайбар
    return !!(
      document.querySelector('.chat-list, .sidebar-tools-button, .btn-menu, #column-left, .chat-info')
    );
  }

  function openChat(target) {
    // WebA/A-роутер читает hash: #@username, #+invite, #id
    const hash = /^(\+|[0-9-])/.test(target) ? `#${target}` : `#@${target.replace(/^@/, '')}`;
    if (location.hash !== hash) {
      location.hash = hash;
      // Подстраховка для роутеров, которые не реагируют на смену hash
      setTimeout(() => {
        if (!document.querySelector('.message, .chat-background')) {
          location.href = `https://web.telegram.org/a/${hash}`;
        }
      }, 4000);
    }
  }

  function extractFromText(text, selfName) {
    if (!text) return;
    const low = (selfName || '').toLowerCase();
    for (const m of text.matchAll(/@([A-Za-z0-9_]{3,32})/g)) {
      const u = m[1].toLowerCase();
      if (RESERVED.has(u) || u === low) continue;
      state.users.add(u);
    }
    for (const m of text.matchAll(/(?:t\.me|telegram\.me)\/\+([A-Za-z0-9_-]{4,64})/g)) {
      state.invites.add('+' + m[1]);
    }
    for (const m of text.matchAll(/instagram\.com\/([A-Za-z0-9._]{1,30})/gi)) {
      state.instagram.add(m[1].toLowerCase());
    }
    for (const m of text.matchAll(/(?:inst|ig|инст|инстаграм)[\s:—–-]+@?([A-Za-z0-9._]{2,30})/gi)) {
      const u = m[1].toLowerCase().replace(/[.,]+$/, '');
      if (u && !RESERVED.has(u)) state.instagram.add(u);
    }
  }

  function collectMessages(maxNew) {
    // WebA: сообщения — div.message, текст в .text-content
    let added = 0;
    const nodes = document.querySelectorAll('.message .text-content, .message .message-text, .message-content .text-content');
    for (const el of nodes) {
      if (el.dataset.igxScanned) continue;
      el.dataset.igxScanned = '1';
      added++;
      state.postsRead++;
      extractFromText(el.textContent, state.title);
      if (maxNew && added >= maxNew) break;
    }
    return added;
  }

  function getScroller() {
    return (
      document.querySelector('.chat-background') ||
      document.querySelector('.messages-container') ||
      document.querySelector('[class*="messages"]')
    );
  }

  async function runScan(target, msgLimit, delayMs) {
    resetState();
    try {
      state.progress = 'Открываю чат…';
      openChat(target);

      // Ждём, пока чат откроется и появятся сообщения (или описание пустого чата)
      let opened = false;
      for (let i = 0; i < 30; i++) {
        await sleep(1000);
        if (!isLoggedIn()) {
          state.error = 'Сессия web.telegram.org протухла — войди заново.';
          state.done = true;
          return;
        }
        if (document.querySelector('.message') || document.querySelector('.chat-info')) {
          opened = true;
          break;
        }
      }
      if (!opened) {
        state.error = 'Чат не открылся (не существует, или ты не подписан на приватный канал).';
        state.done = true;
        return;
      }

      const titleEl = document.querySelector('.chat-info .title, .chat-info .peer-title, .chat-info h3, .chat-info span');
      state.title = titleEl ? titleEl.textContent.trim().replace(/^@/, '') : String(target).replace(/^[@+]/, '');

      // Описание канала: клик по шапке чата открывает профиль
      try {
        const headerBtn = document.querySelector('.chat-info');
        if (headerBtn) {
          headerBtn.click();
          await sleep(1500);
          const bio = document.querySelector('.ProfileInfo, .profile-info, [class*="bio"], .info-panel, .chat-details');
          if (bio) extractFromText(bio.textContent, state.title);
          const back = document.querySelector('.btn-back, .chat-info-close, [class*="back"]');
          if (back) back.click();
          await sleep(800);
        }
      } catch (_) {}

      // Читаем сообщения в порядке приоритета: описание (выше) -> закрепы -> обычные
      state.progress = 'Читаю закрепы…';
      try {
        const pinned = document.querySelectorAll(
          '.pinned-message .text-content, .pinned-message-text, .message.pinned .text-content, [class*="pinned"] .text-content'
        );
        for (const el of pinned) {
          if (el.dataset.igxScanned) continue;
          el.dataset.igxScanned = '1';
          state.postsRead++;
          extractFromText(el.textContent, state.title);
        }
      } catch (_) {}

      state.progress = 'Читаю сообщения…';
      collectMessages(msgLimit - state.postsRead);

      const scroller = getScroller();
      let idleRounds = 0;
      while (state.postsRead < msgLimit && idleRounds < 6) {
        // Пауза между пачками — чтобы активность выглядела как чтение человеком
        await sleep(Math.max(1500, delayMs) + Math.random() * 1500);
        if (scroller) scroller.scrollTop = 0;
        window.scrollTo(0, 0);
        await sleep(1200);
        const added = collectMessages(msgLimit - state.postsRead);
        state.progress = `Читаю сообщения… (${state.postsRead}/${msgLimit})`;
        if (added === 0) idleRounds++;
        else idleRounds = 0;
      }

      state.done = true;
    } catch (e) {
      state.error = String(e.message || e);
      state.done = true;
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'tgPing') {
      sendResponse({ ready: isLoggedIn(), needsLogin: !isLoggedIn() });
      return;
    }
    if (msg.type === 'tgScan') {
      if (!state.busy) {
        runScan(msg.target, msg.msgLimit || 20, msg.delayMs || 10000);
      }
      sendResponse({ started: true });
      return;
    }
    if (msg.type === 'tgGetResult') {
      sendResponse({
        done: state.done,
        progress: state.progress,
        error: state.error,
        title: state.title,
        postsRead: state.postsRead,
        users: Array.from(state.users),
        invites: Array.from(state.invites),
        instagram: Array.from(state.instagram),
      });
      return;
    }
  });
})();
