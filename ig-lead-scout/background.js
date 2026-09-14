// background.js — служебный воркер расширения

// Разовое автоматическое восстановление старой базы (см. restore_merge.js):
// добавляет только отсутствующие ключи, после первого успеха больше не срабатывает.
try {
  importScripts('restore_merge.js');
} catch (_) {}

// Telegram-интеграция (бот, верификация, скан-режимы)
try {
  importScripts('tg.js');
} catch (_) {}

const QC_MAP_KEY = 'igx_quickcheck_tabs'; // {tabId: {username, createdAt}}

async function getQuickCheckMap() {
  const data = await chrome.storage.session.get(QC_MAP_KEY);
  return data[QC_MAP_KEY] || {};
}
async function setQuickCheckMap(map) {
  await chrome.storage.session.set({ [QC_MAP_KEY]: map });
}

async function getSettings() {
  const data = await chrome.storage.local.get('igx_settings');
  return Object.assign(
    {
      openMode: 'newtab', // 'newtab' | 'splitscreen' | 'sametab'
      throttleMs: 4000,
    },
    data.igx_settings || {}
  );
}

let splitWindowId = null;

// ---------- OCR / распознавание речи (offscreen-документ) ----------
// Контент-скриптам Хром запрещает создавать Worker из файлов расширения,
// поэтому Tesseract и Whisper крутятся в offscreen-странице расширения.
async function ensureOcrDoc() {
  let exists = false;
  try {
    if (chrome.offscreen && typeof chrome.offscreen.hasDocument === 'function') {
      exists = await chrome.offscreen.hasDocument();
    } else if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      exists = contexts && contexts.length > 0;
    }
  } catch (_) {}

  if (!exists) {
    try {
      await chrome.offscreen.createDocument({
        url: 'ocr-offscreen.html',
        reasons: ['WORKERS', 'BLOBS', 'AUDIO_PLAYBACK'],
        justification: 'Распознавание текста и речи с видео Инстаграма',
      });
    } catch (e) {
      if (!String((e && e.message) || e).toLowerCase().includes('single')) throw e;
    }
    // Ожидаем готовности скриптов страницы (handshake)
    for (let i = 0; i < 25; i++) {
      try {
        const r = await chrome.runtime.sendMessage({ type: 'ocrPing' });
        if (r && r.ok) break;
      } catch (_) {}
      await new Promise((res) => setTimeout(res, 100));
    }
  }
  return true;
}

async function offscreenCall(payload) {
  await ensureOcrDoc();
  // Keepalive: не даём Service Worker уснуть во время загрузки нейросети или OCR
  const keepAlive = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 15000);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await chrome.runtime.sendMessage(payload);
        if (res !== undefined) return res;
      } catch (e) {
        if (attempt === 2) throw e;
      }
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
    return { error: 'Распознавалка не ответила.' };
  } finally {
    clearInterval(keepAlive);
  }
}

// ВНИМАНИЕ: здесь была «разовая чистка» igx_viewed, которая при первом же
// запуске удаляла ВСЕ метки просмотренных профилей (сгорел список из ~900
// чекнутых). Убрана полностью — данные пользователей удаляться не должны.

// Открыть профиль во втором окне рядом (сплит-экран) с повторным использованием окна и вкладки
async function openSplitScreen(url, callerTab) {
  try {
    const displays = await chrome.system.display.getInfo();
    const primary = displays.find((d) => d.isPrimary) || displays[0];
    const wa = primary.workArea;
    const halfW = Math.floor(wa.width / 2);

    // Закрепляем окно с поиском в левой половине экрана
    if (callerTab && callerTab.windowId != null) {
      await chrome.windows.update(callerTab.windowId, {
        left: wa.left,
        top: wa.top,
        width: halfW,
        height: wa.height,
        state: 'normal',
      }).catch(() => {});
    }

    // Если правое окно уже существует — просто заменяем в нём URL текущей вкладки
    if (splitWindowId != null) {
      try {
        const win = await chrome.windows.get(splitWindowId, { populate: true });
        if (win && win.tabs && win.tabs.length > 0) {
          const activeTab = win.tabs.find((t) => t.active) || win.tabs[0];
          await chrome.tabs.update(activeTab.id, { url, active: true });
          return;
        }
      } catch (e) {
        splitWindowId = null;
      }
    }

    // Создаем правое окно
    const win = await chrome.windows.create({
      url,
      left: wa.left + halfW,
      top: wa.top,
      width: wa.width - halfW,
      height: wa.height,
      focused: false,
    });
    splitWindowId = win.id;
  } catch (e) {
    await chrome.tabs.create({ url, active: false });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  // ocr-offscreen.js обрабатывает эти типы — background НЕ должен перехватывать
  if (msg.type === 'ocrPing' || msg.type === 'ocrDo' || msg.type === 'ocrImageUrl' || msg.type === 'ocrVideoDo' || msg.type === 'asrDo' || msg.type === 'asrDoUrl') return false;

  // Снимок вкладки для видео с CORS-защитой (когда canvas.toDataURL блокируется браузером)
  if (msg.type === 'captureTab') {
    const winId = (sender.tab && sender.tab.windowId) != null ? sender.tab.windowId : null;
    chrome.tabs.captureVisibleTab(winId, { format: 'jpeg', quality: 85 }, (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) {
        sendResponse({ ok: false, error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Не удалось сделать снимок вкладки.' });
      } else {
        sendResponse({ ok: true, dataUrl });
      }
    });
    return true;
  }

  // Telegram-блок (tg.js): настройки, верификация, проверки, бот.
  // ВАЖНО: не возвращаем Promise из слушателя — в MV3 возвращённый Promise
  // воспринимается как сам ответ (отправитель мгновенно получал бы `true`
  // вместо результата проверки). Ответ уходит через sendResponse.
  if (typeof handleTgMessage === 'function' && /^tg[A-Z]/.test(msg.type)) {
    handleTgMessage(msg, sendResponse);
    return true;
  }

  // Проверка, является ли вкладка фоновой вкладкой автопроверки —
  // content script запрашивает это, чтобы не помечать профиль «просмотренным».
  if (msg.type === 'isQuickCheck') {
    getQuickCheckMap().then((map) => {
      sendResponse({ isQuickCheck: !!(sender.tab && map[sender.tab.id]) });
    });
    return true;
  }

  // Распознавание текста (OCR) и речи (ASR) с видео/слайдов — в offscreen-документе.
  if (
    msg.type === 'ocrRecognize' ||
    msg.type === 'ocrRecognizeUrl' ||
    msg.type === 'ocrVideoDirect' ||
    msg.type === 'asrRecognize' ||
    msg.type === 'asrRecognizeUrl'
  ) {
    let payload;
    if (msg.type === 'ocrRecognize') payload = { type: 'ocrDo', image: msg.image, apiKey: msg.apiKey };
    else if (msg.type === 'ocrRecognizeUrl') payload = { type: 'ocrImageUrl', url: msg.url, apiKey: msg.apiKey };
    else if (msg.type === 'ocrVideoDirect')
      payload = {
        type: 'ocrVideoDo',
        url: msg.url,
        headTimestamps: msg.headTimestamps,
        tailTimestamps: msg.tailTimestamps,
        apiKey: msg.apiKey,
      };
    else if (msg.type === 'asrRecognize') payload = { type: 'asrDo', audio: msg.audio, apiKey: msg.apiKey };
    else
      payload = {
        type: 'asrDoUrl',
        url: msg.url,
        headTo: msg.headTo,
        tailFrom: msg.tailFrom,
        tailTo: msg.tailTo,
        apiKey: msg.apiKey,
      };

    offscreenCall(payload)
      .then((r) => sendResponse(r || { ok: false, error: 'Распознавалка не ответила.' }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  const bgTypes = new Set(['getSettings', 'openProfile', 'quickCheck', 'checkDone']);
  if (!bgTypes.has(msg.type)) return false;

  (async () => {
    try {
      if (msg.type === 'getSettings') {
        sendResponse(await getSettings());
        return;
      }

      if (msg.type === 'openProfile') {
        const settings = await getSettings();
        if (settings.openMode === 'splitscreen') {
          await openSplitScreen(msg.url, sender.tab);
        } else {
          await chrome.tabs.create({ url: msg.url, active: settings.openMode === 'sametab' });
        }
        sendResponse({ ok: true });
        return;
      }

      // "Быстрая проверка": реальная вкладка в фоне, не активная, автозакрытие после извлечения данных
      if (msg.type === 'quickCheck') {
        const tab = await chrome.tabs.create({ url: msg.url, active: false });
        const map = await getQuickCheckMap();
        map[tab.id] = { username: msg.username, createdAt: Date.now() };
        await setQuickCheckMap(map);

        // подстраховка: если content script не отчитается — закрыть вкладку принудительно
        setTimeout(async () => {
          const m = await getQuickCheckMap();
          if (m[tab.id]) {
            delete m[tab.id];
            await setQuickCheckMap(m);
            chrome.tabs.remove(tab.id).catch(() => {});
          }
        }, 30000);

        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'checkDone') {
        const map = await getQuickCheckMap();
        const info = sender.tab ? map[sender.tab.id] : null;
        if (info) {
          delete map[sender.tab.id];
          await setQuickCheckMap(map);
          chrome.tabs.remove(sender.tab.id).catch(() => {});
        }
        sendResponse({ ok: true });
      }
    } catch (e) {
      try {
        sendResponse({ error: String((e && e.message) || e) });
      } catch (_) {}
    }
  })();
  return true; // держим канал открытым для async sendResponse
});
