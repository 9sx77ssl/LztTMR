// ==UserScript==
// @name         LztTMR (Chrome)
// @namespace    https://lolz.team/gay1234
// @version      1.6.4
// @description  LZT Transfer Modal Revert — Chrome build. Single-screen money transfer dialog for Lolzteam.
// @updateURL    https://raw.githubusercontent.com/9sx77ssl/LztTMR/main/LztTMR.chrome.user.js
// @downloadURL  https://raw.githubusercontent.com/9sx77ssl/LztTMR/main/LztTMR.chrome.user.js
// @author       lolz.team/gay1234
// @match        https://lolz.team/*
// @match        https://lolz.live/*
// @match        https://lolz.guru/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

/*
 * LztTMR (LZT Transfer Modal Revert) — one-file userscript for Tampermonkey / Violentmonkey / Greasemonkey.
 *
 * How it works:
 *   1. Captures clicks on any `payment/balance-transfer` link before XenForo's
 *      OverlayTrigger can open the native 3-step wizard.
 *   2. Bootstraps the same server payload the native overlay uses
 *      (`/payment/balance-transfer?...&_xfResponseType=json` -> data-serverData).
 *   3. Renders a single-screen dialog that reuses the forum theme tokens and
 *      control classes (`textCtrl`, `button primary`, CSS variables).
 *   4. Sends the transfer through the same public endpoints as the native UI:
 *      `/login/generate-temporary-token` -> `api.lzt.market/balance/transfer`.
 *
 * No API keys, no secret storage, no background workers. The userscript runs
 * with `@grant none`, so every request uses the current forum session.
 */

(function () {
  'use strict';

  // Chrome/Chromium Tampermonkey runs @grant none scripts in the page context.
  const pageWindow = window;
  try {
    if (pageWindow.__lztTMR__) return;
    pageWindow.__lztTMR__ = true;
  } catch (_) { /* page-window expandos are blocked in some sandboxes */ }

  function getXenForo() {
    try { if (pageWindow.XenForo) return pageWindow.XenForo; } catch (_) {}
    try {
      const raw = pageWindow.wrappedJSObject;
      if (raw && raw.XenForo) return raw.XenForo;
    } catch (_) {}
    try { if (window.XenForo) return window.XenForo; } catch (_) {}
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Constants                                                          */
  /* ------------------------------------------------------------------ */

  const VERSION = '1.6.4';
  const PREFIX = 'lzt-tre';
  const STYLE_ID = 'lzt-tmr-styles';
  const OVERLAY_CLASS = `${PREFIX}-overlay`;
  const FIELD_SELECTOR = 'input:not([type="radio"]):not([type="checkbox"]):not([type="button"]):not([type="submit"]):not([type="reset"]), textarea';
  const DEBUG = (() => {
    try {
      return /[?&]lztmr_debug=1(?:&|$)/.test(location.search)
        || pageWindow.localStorage?.getItem('lztTMR_debug') === '1';
    } catch (_) {
      return /[?&]lztmr_debug=1(?:&|$)/.test(location.search);
    }
  })();
  let debugNode = null;
  const debugLines = [];
  const debug = (...args) => {
    if (!DEBUG) return;
    try { console.debug('[LztTMR]', ...args); } catch (_) { /* ignore */ }
    const text = args.map((arg) => {
      if (arg instanceof Error) return String(arg.stack || arg).split('\n').slice(0, 3).join(' | ');
      if (typeof arg === 'string' && arg.includes('\n    at ')) {
        return arg.split('\n').slice(0, 3).join(' | ');
      }
      if (arg && typeof arg === 'object') {
        try { return JSON.stringify(arg); } catch (_) { return String(arg); }
      }
      return String(arg);
    }).join(' ');
    debugLines.push(`${new Date().toISOString().slice(11, 23)} ${text}`);
    if (debugLines.length > 80) debugLines.shift();
    if (debugNode) debugNode.textContent = debugLines.slice(-60).join('\n');
  };

  const DEFAULT_API_BASE = 'https://api.lzt.market';
  const TOKEN_ENDPOINT = '/login/generate-temporary-token';
  const BOOTSTRAP_ENDPOINT = '/payment/balance-transfer';
  const TRANSFER_ENDPOINT = '/balance/transfer';
  const FEE_ENDPOINT = '/balance/transfer-fee';

  const HOLD_MAX = { hour: 720, day: 30, week: 4 };
  const HOLD_INPUT_MAX = 99;
  const HOLD_UNITS = ['hour', 'day', 'week'];
  const HOLD_MIN_RUB = 10;
  const MIN_RUB = 1;
  const AMOUNT_MAX = 10_000_000;

  if (DEBUG) {
    try { console.info('[LztTMR] debug enabled', VERSION); } catch (_) { /* ignore */ }
    const patchEvent = (name) => {
      try {
        const proto = pageWindow.Event?.prototype;
        const original = proto && proto[name];
        if (typeof original !== 'function') return;
        proto[name] = function patched(...args) {
          const type = this?.type || '';
          if (/^(pointer|mouse|click|focus|blur|selection)/.test(type)) {
            debug(`page ${name}`, type, this.target?.className || this.target?.tagName, new Error().stack);
          }
          return original.apply(this, args);
        };
      } catch (_) { /* ignore */ }
    };
    patchEvent('preventDefault');
    patchEvent('stopPropagation');
    patchEvent('stopImmediatePropagation');
    try {
      const proto = pageWindow.HTMLElement?.prototype;
      const originalFocus = proto?.focus;
      if (typeof originalFocus === 'function') {
        proto.focus = function patchedFocus(...args) {
          debug('focus()', this.className || this.tagName, new Error().stack);
          return originalFocus.apply(this, args);
        };
      }
      const originalBlur = proto?.blur;
      if (typeof originalBlur === 'function') {
        proto.blur = function patchedBlur(...args) {
          debug('blur()', this.className || this.tagName, new Error().stack);
          return originalBlur.apply(this, args);
        };
      }
    } catch (_) { /* ignore */ }
  }

  const scopes = Object.freeze({
    read: ['basic', 'read'],
    payment: ['payment'],
  });

  /* ------------------------------------------------------------------ */
  /* Tiny helpers                                                       */
  /* ------------------------------------------------------------------ */

  const doc = pageWindow.document || document;
  const pageFetch = (...args) => {
    try {
      return pageWindow.fetch(...args);
    } catch (_) {
      return fetch(...args);
    }
  };

  function el(tag, attrs, ...children) {
    const node = doc.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value; // trusted constants only
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key.startsWith('on') && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key === 'hidden' || key === 'disabled' || key === 'checked') {
          node[key] = Boolean(value);
        } else {
          node.setAttribute(key, value === true ? '' : String(value));
        }
      }
    }
    for (const child of children.flat(Infinity)) {
      if (child === undefined || child === null || child === false) continue;
      let isNode = false;
      try {
        isNode = Boolean(child && typeof child === 'object' && child.nodeType);
      } catch (_) { /* cross-compartment wrapper */ }
      node.append(isNode ? child : doc.createTextNode(String(child)));
    }
    return node;
  }

  function svg(paths, size = 20, strokeWidth = 2) {
    const node = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.setAttribute('viewBox', '0 0 24 24');
    node.setAttribute('width', String(size));
    node.setAttribute('height', String(size));
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke', 'currentColor');
    node.setAttribute('stroke-width', String(strokeWidth));
    node.setAttribute('stroke-linecap', 'round');
    node.setAttribute('stroke-linejoin', 'round');
    node.setAttribute('aria-hidden', 'true');
    // Parse in the SVG namespace instead of using svg.innerHTML: Firefox and
    // some Chromium builds otherwise create HTML-namespaced <path> nodes that
    // never render.
    try {
      const parsed = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg">${paths}</svg>`,
        'image/svg+xml',
      );
      for (const child of Array.from(parsed.documentElement.childNodes)) {
        node.appendChild(doc.importNode(child, true));
      }
    } catch (_) {
      // Leave the icon empty rather than throwing.
    }
    return node;
  }

  const ICONS = {
    close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  };

  // Reference-counted page scroll lock: reopening the dialog while the old
  // one is still fading out must not leak overflow:hidden on <html>.
  let scrollLockCount = 0;
  let scrollLockOriginal = '';

  function lockPageScroll() {
    if (scrollLockCount === 0) {
      scrollLockOriginal = doc.documentElement.style.overflow;
      doc.documentElement.style.overflow = 'hidden';
    }
    scrollLockCount += 1;
  }

  function unlockPageScroll() {
    if (scrollLockCount > 0) scrollLockCount -= 1;
    if (scrollLockCount === 0) {
      doc.documentElement.style.overflow = scrollLockOriginal;
    }
  }

  function toNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(String(value).replace(',', '.'));
    return Number.isFinite(number) ? number : null;
  }

  function locale() {
    const lang = doc.documentElement.lang || 'ru-RU';
    return /^ru/i.test(lang) ? 'ru-RU' : 'en-US';
  }

  function formatNumber(value, min = 0, max = 2) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return new Intl.NumberFormat(locale(), {
      minimumFractionDigits: min,
      maximumFractionDigits: max,
    }).format(number);
  }

  // The dialog is intentionally Russian-only: the site language can be
  // switched per user, but the requested UX is a stable Russian interface.
  const RU = {
    title: 'Перевести средства',
    wallet: 'Откуда:',
    recipient: 'Получатель',
    recipientPlaceholder: 'Ник',
    amount: 'Сумма',
    currency: 'Валюта',
    commission: 'Взимать комиссию с отправленной суммы',
    commissionShort: 'Комиссия',
    comment: 'Комментарий к переводу',
    telegram: 'Сделка проходит в Telegram?',
    telegramHint: 'Обязательно проверяйте в поле Имя пользователя / Username, а не в поле О себе / BIO',
    telegramPlaceholder: 'Telegram username пользователя, с которым ведете диалог',
    hold: 'Заморозить перевод у получателя',
    holdShort: 'Холд',
    holdDuration: 'Длительность холда',
    removeRecipient: 'Убрать получателя',
    holdNote: 'Это обезопасит вашу сделку. Получатель сможет воспользоваться вашими средствами только спустя указанное время. После перевода Вы сможете отменить заморозку средств, если сделка пройдет успешно.',
    holdNoteDanger: 'Если Вы проводите сделку за пределами форума, сверьте детали через личные сообщения на форуме.',
    secret: 'Секретный вопрос',
    secretPlaceholder: 'Введите ответ',
    recent: 'Недавние получатели',
    searchEmpty: 'Ничего не найдено',
    searchError: 'Не удалось выполнить поиск',
    total: 'Всего',
    recipientReceives: 'Получатель получит',
    sending: 'Отправка…',
    submit: 'Перевести',
    wait: 'Подождите',
    done: 'Готово',
    again: 'Перевести ещё',
    close: 'Закрыть',
    logId: 'Операция',
    loading: 'Загрузка…',
    retry: 'Повторить',
    legacy: 'Открыть стандартную форму',
    loadFailed: 'Не удалось загрузить данные перевода.',
    noWallet: 'У вас нет доступных балансов для перевода.',
    errRecipient: 'Выберите получателя из списка.',
    errAmount: 'Введите сумму перевода.',
    errAmountMax: 'Максимальная сумма перевода — 10 000 000.',
    errMin: 'Минимальная сумма — 1 ₽.',
    errFee: 'Комиссия ещё не рассчитана.',
    errSecret: 'Введите ответ на секретный вопрос.',
    errTelegram: 'Введите Telegram username получателя.',
    errHold: 'Укажите корректный срок холда.',
    errBalance: 'Недостаточно средств для перевода.',
    errComment: 'Комментарий слишком длинный.',
    successTitle: 'Перевод отправлен',
    successFallback: 'Деньги успешно переведены.',
    yes: 'Да',
    no: 'Нет',
  };

  function t(key) {
    return RU[key] !== undefined ? RU[key] : key;
  }

  function plural(count, forms) {
    const abs = Math.abs(count) % 100;
    const last = abs % 10;
    if (abs > 10 && abs < 20) return forms[2];
    if (last > 1 && last < 5) return forms[1];
    if (last === 1) return forms[0];
    return forms[2];
  }

  const UNIT_FORMS = {
    hour: ['час', 'часа', 'часов'],
    day: ['день', 'дня', 'дней'],
    week: ['неделя', 'недели', 'недель'],
    month: ['месяц', 'месяца', 'месяцев'],
  };

  function unitLabel(unit, value) {
    return plural(value, UNIT_FORMS[unit] || [unit, unit, unit]);
  }

  const CURRENCY_RU = {
    rub: 'Рубль',
    uah: 'Гривна',
    kzt: 'Тенге',
    pln: 'Злотый',
    usd: 'Доллар',
    eur: 'Евро',
    gbp: 'Фунт стерлингов',
    cny: 'Юань',
    try: 'Турецкая лира',
    jpy: 'Иена',
    byn: 'Бел. рубль',
    brl: 'Бразильский реал',
  };

  function currencyTitle(id, fallback) {
    return CURRENCY_RU[id] || fallback || String(id).toUpperCase();
  }

  /** Keep only safe markup from the server-rendered username span. */
  function sanitizeUsername(html) {
    const template = doc.createElement('template');
    template.innerHTML = typeof html === 'string' ? html : '';
    const allowed = new Set(['SPAN', 'B', 'I', 'EM', 'STRONG', 'A']);
    const walk = (parent) => {
      for (const node of Array.from(parent.children)) {
        if (!allowed.has(node.tagName)) {
          node.replaceWith(doc.createTextNode(node.textContent || ''));
          continue;
        }
        for (const attr of Array.from(node.attributes)) {
          const name = attr.name.toLowerCase();
          if (name === 'class') continue;
          if (name === 'href' && node.tagName === 'A' && /^\//.test(attr.value)) continue;
          node.removeAttribute(attr.name);
        }
        if (node.tagName === 'A') {
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
        }
        walk(node);
      }
    };
    walk(template.content);
    return template.content;
  }

  /** Safe HTML for server error messages (links, bold, line breaks). */
  function sanitizeRichText(html) {
    const template = doc.createElement('template');
    template.innerHTML = typeof html === 'string' ? html : '';
    const allowed = new Set(['A', 'B', 'STRONG', 'I', 'EM', 'BR', 'SPAN', 'CODE']);
    const walk = (parent) => {
      for (const node of Array.from(parent.children)) {
        if (!allowed.has(node.tagName)) {
          node.replaceWith(doc.createTextNode(node.textContent || ''));
          continue;
        }
        for (const attr of Array.from(node.attributes)) {
          const name = attr.name.toLowerCase();
          if (name === 'href' && node.tagName === 'A' && /^(https?:\/\/|\/)/i.test(attr.value)) continue;
          if (name === 'class' && node.tagName === 'A' && attr.value === 'mainc') continue;
          node.removeAttribute(attr.name);
        }
        if (node.tagName === 'A') {
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
        }
        walk(node);
      }
    };
    walk(template.content);
    return template.content;
  }

  /**
   * The forum anti-flood error contains the remaining seconds in the message,
   * e.g. "Необходимо подождать, по крайней мере, 162 секунд...".
   */
  function parseCooldown(message) {
    const match = String(message || '').match(/(\d+)\s*(?:секунд|second)/i);
    return match ? Number(match[1]) : 0;
  }

  function errorText(json, fallback) {
    if (!json) return fallback;
    if (Array.isArray(json.error) && json.error.length) return String(json.error[0]);
    if (Array.isArray(json.errors) && json.errors.length) return String(json.errors[0]);
    if (typeof json.error === 'string' && json.error) return json.error;
    if (typeof json.message === 'string' && json.message) return json.message;
    return fallback;
  }

  /* ------------------------------------------------------------------ */
  /* API                                                                */
  /* ------------------------------------------------------------------ */

  class ApiError extends Error {
    constructor(message, status = 0, payload = null) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.payload = payload;
    }
  }

  function apiBase() {
    const X = getXenForo();
    const base = X && X.marketApiBaseUri;
    return (typeof base === 'string' && base) || DEFAULT_API_BASE;
  }

  function csrfToken() {
    const X = getXenForo();
    return (X && X._csrfToken) || '';
  }

  function currentUri() {
    return location.pathname + location.search;
  }

  const tokenCache = new Map();

  async function getToken(tokenScopes, secretAnswer) {
    // Payment tokens are intentionally not cached: every transfer must
    // re-validate the secret answer instead of silently reusing an old token.
    const cacheable = !tokenScopes.includes('payment');
    const key = [...tokenScopes].sort().join(',');
    const cached = tokenCache.get(key);
    if (cacheable && cached && cached.expires > Date.now() + 5000) return cached.token;

    const body = new URLSearchParams();
    for (const scope of tokenScopes) body.append('scope[]', scope);
    if (secretAnswer !== undefined) body.append('secret_answer', secretAnswer);
    body.append('_xfRequestUri', currentUri());
    body.append('_xfNoRedirect', '1');
    body.append('_xfToken', csrfToken());
    body.append('_xfResponseType', 'json');

    const res = await pageFetch(TOKEN_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || !json.token) {
      throw new ApiError(errorText(json, `Token request failed (HTTP ${res.status})`), res.status, json);
    }
    if (cacheable) {
      tokenCache.set(key, {
        token: json.token,
        expires: (Number(json.expires) || 0) * 1000,
      });
    }
    return json.token;
  }

  async function apiFetch(path, options = {}) {
    const {
      method = 'GET',
      query = null,
      form = null,
      tokenScopes = scopes.read,
      secretAnswer,
      signal,
    } = options;

    const token = await getToken(tokenScopes, secretAnswer);
    let url = apiBase().replace(/\/+$/, '') + path;
    if (query) url += `?${new URLSearchParams(query).toString()}`;

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    let body;
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      body = new URLSearchParams(form);
    }

    // Never send X-Requested-With here: api.lzt.market's CORS policy only
    // allows Content-Type, Accept and Authorization.
    const res = await pageFetch(url, { method, headers, body, signal, credentials: 'omit' });
    const json = await res.json().catch(() => null);

    if (!res.ok || (json && (json.error || json.errors || json.status === 'error'))) {
      const message = errorText(json, `Request failed (HTTP ${res.status})`);
      if (/token|authoriz/i.test(message)) tokenCache.clear();
      throw new ApiError(message, res.status, json);
    }
    return json;
  }

  async function loadBootstrap({ userId, username }, signal) {
    const url = new URL(BOOTSTRAP_ENDPOINT, location.origin);
    url.searchParams.set('hold', '1');
    if (userId) url.searchParams.set('user_id', String(userId));
    else if (username) url.searchParams.set('username', username);
    url.searchParams.set('_xfRequestUri', currentUri());
    url.searchParams.set('_xfNoRedirect', '1');
    url.searchParams.set('_xfToken', csrfToken());
    url.searchParams.set('_xfResponseType', 'json');

    // A string (not a URL object) is important: the forum patches window.fetch
    // and expects a string input.
    const res = await pageFetch(url.toString(), {
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      signal,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || !json.templateHtml) {
      throw new ApiError(errorText(json, t('loadFailed')), res.status, json);
    }

    const parsed = new DOMParser().parseFromString(json.templateHtml, 'text/html');
    const island = parsed.querySelector('[data-island="money-transfer"]');
    if (!island) throw new ApiError(t('loadFailed'), res.status, json);

    const raw = island.getAttribute('data-serverData');
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new ApiError(t('loadFailed'), res.status, json);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Small UI factories                                                 */
  /* ------------------------------------------------------------------ */

  function makeSelect({ options = [], value, onChange, ariaLabel = '' }) {
    const root = el('div', { class: 'lzt-tre-select' });
    const button = el('button', {
      type: 'button',
      class: 'lzt-tre-select-btn',
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
      'aria-label': ariaLabel,
    });
    const label = el('span', { class: 'lzt-tre-select-label' });
    button.append(label);
    const menu = el('div', { class: 'lzt-tre-menu', role: 'listbox', hidden: true });
    root.append(button, menu);

    let items = options.slice();
    let selected = value;
    let disabled = false;
    let isOpen = false;
    let wheelTarget = null;
    let wheelRaf = 0;

    const find = (candidate) => items.find((item) => String(item.value) === String(candidate));

    const renderLabel = () => {
      const item = find(selected) || items[0];
      if (item) {
        selected = item.value;
        label.textContent = item.label;
      } else {
        label.textContent = '—';
      }
    };

    let api;

    const close = () => {
      isOpen = false;
      menu.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      root.classList.remove('is-open');
      wheelTarget = null;
      cancelAnimationFrame(wheelRaf);
      wheelRaf = 0;
      if (api) openSelects.delete(api);
    };

    const open = () => {
      if (disabled || !items.length || isOpen) return;
      closeAllSelects();
      isOpen = true;
      menu.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      root.classList.add('is-open');
      wheelTarget = null;
      if (api) openSelects.add(api);
      const first = menu.querySelector('[aria-selected="true"]') || menu.firstElementChild;
      if (first) first.focus({ preventScroll: true });
    };

    const setValue = (next) => {
      const item = find(next);
      if (!item) return;
      selected = item.value;
      renderLabel();
      for (const node of menu.children) {
        node.setAttribute('aria-selected', String(String(node.dataset.value) === String(selected)));
      }
    };

    const renderOptions = () => {
      menu.replaceChildren();
      for (const item of items) {
        const option = el('button', {
          type: 'button',
          class: 'lzt-tre-opt',
          role: 'option',
          'data-value': String(item.value),
          'aria-selected': String(String(item.value) === String(selected)),
        });
        option.append(el('span', { class: 'lzt-tre-opt-label', text: item.label }));
        if (item.hint) option.append(el('span', { class: 'lzt-tre-opt-hint', text: item.hint }));
        option.addEventListener('click', () => {
          setValue(item.value);
          close();
          if (typeof onChange === 'function') onChange(item.value);
        });
        menu.append(option);
      }
      renderLabel();
    };

    // Smooth wheel scrolling inside the option list.
    menu.addEventListener('wheel', (event) => {
      if (event.ctrlKey) return;
      const max = menu.scrollHeight - menu.clientHeight;
      if (max <= 0) return;
      event.preventDefault();
      wheelTarget = Math.max(0, Math.min(max, (wheelTarget ?? menu.scrollTop) + event.deltaY * 0.7));
      if (wheelRaf) return;
      const step = () => {
        const diff = wheelTarget - menu.scrollTop;
        if (Math.abs(diff) <= 0.5) {
          menu.scrollTop = wheelTarget;
          wheelRaf = 0;
          return;
        }
        menu.scrollTop += diff * 0.22;
        wheelRaf = requestAnimationFrame(step);
      };
      wheelRaf = requestAnimationFrame(step);
    }, { passive: false });

    button.addEventListener('click', () => (isOpen ? close() : open()));
    button.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      } else if (event.key === 'Escape') {
        close();
      }
    });
    root.addEventListener('keydown', (event) => {
      if (!isOpen) return;
      const nodes = Array.from(menu.children);
      const index = nodes.indexOf(doc.activeElement);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        nodes[Math.min(nodes.length - 1, index + 1)]?.focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        nodes[Math.max(0, index - 1)]?.focus();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close();
        button.focus();
      } else if (event.key === 'Tab') {
        close();
      }
    });

    renderOptions();

    api = {
      root,
      button,
      close,
      setValue,
      getValue: () => selected,
      setOptions(next, preferred) {
        items = next.slice();
        if (preferred !== undefined) selected = preferred;
        renderOptions();
      },
      setDisabled(next) {
        disabled = Boolean(next);
        button.disabled = disabled;
        root.classList.toggle('is-disabled', disabled);
        if (disabled) close();
      },
      destroy: close,
    };
    return api;
  }

  let openSelects = new Set();

  function closeAllSelects() {
    for (const select of openSelects) select.close();
  }

  /**
   * Native-like icon-only segmented control:
   * [×] [✓] with real radio inputs (same as the original Svelte component).
   */
  function makeToggle({ value = false, onChange, ariaLabel = '' }) {
    const root = el('div', { class: 'lzt-tre-seg', role: 'radiogroup', 'aria-label': ariaLabel });
    const group = `lzt-tre-toggle-${Math.random().toString(36).slice(2, 9)}`;
    const items = [];
    let current = Boolean(value);

    const render = () => {
      for (const item of items) item.input.checked = item.isYes === current;
      root.classList.toggle('is-yes', current);
    };

    const setValue = (next, silent = false) => {
      current = Boolean(next);
      render();
      if (!silent && typeof onChange === 'function') onChange(current);
    };

    for (const isYes of [false, true]) {
      const label = el('label', { class: 'lzt-tre-seg-item' });
      const input = el('input', {
        type: 'radio',
        class: 'lzt-tre-seg-input',
        name: group,
        'aria-label': isYes ? t('yes') : t('no'),
      });
      const content = el('span', { class: 'lzt-tre-seg-content' },
        el('span', { class: 'lzt-tre-seg-icon', 'aria-hidden': 'true' },
          svg(isYes ? ICONS.check : ICONS.close, 20, 2.5)));
      input.addEventListener('change', () => {
        if (input.checked) setValue(isYes);
      });
      label.append(input, content);
      root.append(label);
      items.push({ isYes, input, label });
    }

    render();

    return {
      root,
      setValue,
      getValue: () => current,
      setDisabled(next) {
        const disabled = Boolean(next);
        for (const item of items) item.input.disabled = disabled;
        root.classList.toggle('is-disabled', disabled);
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* Dialog                                                             */
  /* ------------------------------------------------------------------ */

  class TransferDialog {
    constructor(options = {}) {
      this.options = {
        userId: options.userId || null,
        username: options.username || null,
      };

      this.data = null;
      this.user = null;
      this.balances = [];
      this.balanceId = '';
      this.currencies = {};
      this.visitorCurrency = 'rub';
      this.currency = 'rub';
      this.amount = '';
      this.commissionFromReceiver = false;
      this.comment = '';
      this.telegramDeal = false;
      this.telegramUsername = '';
      // Both toggles start at "No", as requested.
      this.holdEnabled = false;
      this.holdValue = 1;
      this.holdUnit = 'day';
      this.secret = '';
      this.presets = [];
      this.recent = [];
      this.fee = null;
      this.feeFor = null;
      this.feeError = '';
      this.feeLoading = false;
      this.feeSeq = 0;
      this.feeAbort = null;
      this.loadAbort = null;
      this.searchAbort = null;
      this.searchTimer = 0;
      this.suggestions = [];
      this.suggestIndex = -1;
      this.searchLoading = false;
      this.searchError = '';
      this.error = '';
      this.busy = false;
      this.success = null;
      this.cooldownUntil = 0;
      this.cooldownTimer = null;
      this.trigger = null;
      this.closing = false;
      this.closeTimer = 0;
      this.selects = [];
      this.destroyed = false;
    }

    /* ------------------------------ open ------------------------------ */

    async open(trigger = null) {
      this.trigger = trigger || doc.activeElement;
      lockPageScroll();

      this.build();
      doc.body.append(this.overlay);
      this.bindGlobal();

      if (DEBUG) {
        debugLines.length = 0;
        debugNode = el('pre', { class: 'lzt-tre-debug' });
        doc.body.append(debugNode);
        debug('LztTMR debug', VERSION,
          'pageWindow===window:', pageWindow === window,
          'unsafeWindow:', typeof unsafeWindow,
          'readyState:', doc.readyState);
      }

      // Force a layout pass, then animate to the open state on the next frame.
      void this.overlay.offsetWidth;
      requestAnimationFrame(() => {
        if (!this.destroyed) this.overlay.classList.add('is-open');
      });

      queueMicrotask(() => this.focusFirst());
      await this.load();

      const ensureFocus = () => {
        if (this.destroyed) return;
        const active = doc.activeElement;
        if (active && active !== doc.body && this.dialog.contains(active)) return;
        this.focusFirst();
      };
      setTimeout(ensureFocus, 120);
      setTimeout(ensureFocus, 450);
    }

    /* ----------------------------- build ------------------------------ */

    build() {
      const closeButton = el('button', {
        type: 'button',
        class: 'lzt-tre-close',
        'aria-label': t('close'),
        onclick: () => this.close(),
      }, svg(ICONS.close, 18));

      this.titleNode = el('h2', { class: 'lzt-tre-title', id: 'lzt-tre-title' },
        t('title'));

      const head = el('header', { class: 'lzt-tre-head' },
        el('span', { class: 'lzt-tre-head-icon', 'aria-hidden': 'true' }),
        this.titleNode,
        closeButton);

      this.alertNode = el('div', { class: 'lzt-tre-alert', role: 'alert', hidden: true });
      this.loadingNode = el('div', { class: 'lzt-tre-loading' },
        el('span', { class: 'lzt-tre-spinner', 'aria-hidden': 'true' }),
        el('span', { text: t('loading') }));

      this.retryNode = el('div', { class: 'lzt-tre-retry', hidden: true },
        el('button', {
          type: 'button',
          class: 'button primary lzt-tre-retry-btn',
          onclick: () => this.load(),
        }, t('retry')),
        el('a', {
          class: 'button lzt-tre-retry-btn lzt-tre-ghost',
          href: this.legacyUrl(),
          target: '_blank',
          rel: 'noopener noreferrer',
        }, t('legacy')));

      this.formNode = el('div', { class: 'lzt-tre-form', hidden: true });

      /* wallet */
      this.walletNode = el('div', { class: 'lzt-tre-wallet-slot' });
      const walletField = this.field(
        t('wallet'),
        this.walletNode,
      );

      /* recipient */
      this.recipientChip = el('div', { class: 'lzt-tre-chip', hidden: true });
      this.recipientAvatar = el('img', { class: 'lzt-tre-chip-avatar', alt: '', width: 22, height: 22 });
      this.recipientName = el('span', { class: 'lzt-tre-chip-name' });
      this.recipientRemove = el('button', {
        type: 'button',
        class: 'lzt-tre-chip-remove',
        'aria-label': t('removeRecipient'),
        onclick: () => this.clearUser(),
      }, '×');
      this.recipientChip.append(this.recipientAvatar, this.recipientName, this.recipientRemove);

      // Browsers love to autofill "username" fields. The recipient input is
      // hidden while a recipient is selected, and these attributes keep
      // password managers away from a field that can move money.
      this.recipientInput = el('input', {
        type: 'text',
        id: 'lzt-tre-recipient',
        name: 'lzt_tre_recipient',
        class: 'lzt-tre-userinput-input',
        placeholder: t('recipientPlaceholder'),
        maxlength: '64',
        autocomplete: 'off',
        autocapitalize: 'none',
        autocorrect: 'off',
        spellcheck: 'false',
        'data-form-type': 'other',
        'data-lpignore': 'true',
        'data-1p-ignore': 'true',
        'data-bwignore': 'true',
        'aria-label': t('recipient'),
      });
      this.recipientInput.addEventListener('input', () => this.onRecipientInput());
      this.recipientInput.addEventListener('keydown', (event) => this.onRecipientKeydown(event));
      this.recipientInput.addEventListener('focus', () => {
        if (!this.user && !this.recipientInput.value.trim()) this.renderRecent();
      });

      const userInput = el('div', { class: 'lzt-tre-userinput' },
        this.recipientChip,
        this.recipientInput);
      this.recipientSuggest = el('div', { class: 'lzt-tre-suggest', role: 'listbox', hidden: true });
      this.recentNode = el('div', { class: 'lzt-tre-recent', hidden: true });
      this.recipientWrap = el('div', { class: 'lzt-tre-recipient-wrap' }, userInput, this.recipientSuggest);
      const recipientField = this.field(
        t('recipient'),
        el('div', { class: 'lzt-tre-recipient' }, this.recipientWrap, this.recentNode),
      );

      /* amount + currency */
      this.amountInput = el('input', {
        type: 'text',
        inputmode: 'decimal',
        class: 'textCtrl extraLarge full lzt-tre-input lzt-tre-amount-input',
        id: 'lzt-tre-amount',
        name: 'lzt_tre_amount',
        placeholder: '0',
        maxlength: '11',
        autocomplete: 'off',
        'data-form-type': 'other',
        'data-lpignore': 'true',
        'data-1p-ignore': 'true',
      });
      this.amountInput.addEventListener('input', () => {
        const sanitized = this.sanitizeAmount(this.amountInput.value);
        if (sanitized !== this.amountInput.value) this.amountInput.value = sanitized;
        this.amount = sanitized;
        this.scheduleFee();
        this.render();
      });
      this.amountInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.submit();
        }
      });

      this.amountSuffix = el('span', {
        class: 'lzt-tre-amount-suffix',
        'aria-hidden': 'true',
      });
      this.currencySelect = makeSelect({
        options: [],
        ariaLabel: t('currency'),
        onChange: (value) => {
          this.currency = value;
          this.fee = null;
          this.feeLoading = true;
          this.renderPresets();
          this.render();
          this.scheduleFee();
        },
      });
      this.selects.push(this.currencySelect);

      this.amountRow = el('div', { class: 'lzt-tre-amount-row' },
        el('div', { class: 'lzt-tre-amount' }, this.amountInput, this.amountSuffix),
        el('div', { class: 'lzt-tre-currency' }, this.currencySelect.root));

      this.presetsNode = el('div', { class: 'lzt-tre-presets' });
      const amountField = this.field(
        t('amount'),
        el('div', { class: 'lzt-tre-amount-block' }, this.amountRow, this.presetsNode),
      );

      /* commission */
      this.commissionToggle = makeToggle({
        value: false,
        ariaLabel: t('commission'),
        onChange: (value) => {
          this.commissionFromReceiver = value;
          this.render();
        },
      });
      const commissionCard = this.optionCard(
        el('span', { class: 'lzt-tre-option-label', text: t('commission') }),
        this.commissionToggle.root,
      );
      this.commissionCard = commissionCard;

      /* comment: one compact line, remaining-characters counter on the right */
      this.commentInput = el('input', {
        type: 'text',
        class: 'textCtrl extraLarge full lzt-tre-input lzt-tre-comment-input',
        maxlength: '255',
        autocomplete: 'off',
        name: 'lzt_tre_comment',
        'data-form-type': 'other',
        'data-lpignore': 'true',
        'data-1p-ignore': 'true',
        'aria-label': t('comment'),
      });
      this.commentCounter = el('span', { class: 'lzt-tre-counter', text: '255' });
      this.commentInput.addEventListener('input', () => {
        this.comment = this.commentInput.value.slice(0, 255);
        if (this.commentInput.value !== this.comment) this.commentInput.value = this.comment;
        const left = Math.max(0, 255 - this.comment.length);
        this.commentCounter.textContent = String(left);
        this.commentCounter.classList.toggle('is-low', left <= 20);
      });
      const commentField = this.field(
        t('comment'),
        el('div', { class: 'lzt-tre-comment-wrap' }, this.commentInput, this.commentCounter),
      );

      /* telegram */
      this.telegramToggle = makeToggle({
        value: false,
        ariaLabel: t('telegram'),
        onChange: (value) => {
          this.telegramDeal = value;
          this.render();
        },
      });
      this.telegramInput = el('input', {
        type: 'text',
        class: 'textCtrl extraLarge full lzt-tre-input lzt-tre-telegram-input',
        placeholder: t('telegramPlaceholder'),
        maxlength: '33',
        autocomplete: 'off',
        autocapitalize: 'none',
        spellcheck: 'false',
        name: 'lzt_tre_telegram',
        'data-form-type': 'other',
        'data-lpignore': 'true',
        'data-1p-ignore': 'true',
      });
      this.telegramInput.addEventListener('input', () => {
        this.telegramUsername = this.telegramInput.value.slice(0, 33);
        if (this.telegramInput.value !== this.telegramUsername) {
          this.telegramInput.value = this.telegramUsername;
        }
        this.renderSubmitState();
      });
      this.telegramSub = el('div', { class: 'lzt-tre-sub', hidden: true },
        this.telegramInput,
        el('div', { class: 'lzt-tre-hint lzt-tre-telegram-hint' },
          'Обязательно проверяйте в поле ',
          el('b', { class: 'lzt-tre-green' }, 'Имя пользователя / Username'),
          ', а не в поле ',
          el('b', { class: 'lzt-tre-red' }, 'О себе / BIO')));
      const telegramCard = this.optionCard(
        el('span', { class: 'lzt-tre-option-label', text: t('telegram') }),
        this.telegramToggle.root,
        this.telegramSub,
      );
      this.telegramCard = telegramCard;

      /* hold */
      this.holdToggle = makeToggle({
        value: this.holdEnabled,
        ariaLabel: t('hold'),
        onChange: (value) => {
          this.holdEnabled = value;
          this.render();
        },
      });
      this.holdValueInput = el('input', {
        type: 'text',
        class: 'textCtrl extraLarge full lzt-tre-input lzt-tre-hold-value',
        min: '1',
        max: String(HOLD_INPUT_MAX),
        maxlength: '2',
        step: '1',
        inputmode: 'numeric',
        'aria-label': t('holdDuration'),
      });
      this.holdValueInput.addEventListener('input', () => {
        const raw = this.holdValueInput.value.replace(/\D/g, '').slice(0, 2);
        if (!raw) {
          this.holdValue = 0;
          this.holdValueInput.value = '';
          this.renderHold();
          this.renderSubmitState();
          return;
        }
        const max = Math.min(HOLD_INPUT_MAX, HOLD_MAX[this.holdUnit] || 30);
        const value = Math.max(1, Math.min(max, Number.parseInt(raw, 10)));
        this.holdValue = value;
        this.holdValueInput.value = String(value);
        this.renderHold();
        this.renderSubmitState();
      });
      this.holdValueInput.addEventListener('blur', () => {
        if (!this.holdValueInput.value) {
          this.holdValue = 1;
          this.holdValueInput.value = '1';
          this.renderHold();
          this.renderSubmitState();
        }
      });
      this.holdUnitSelect = makeSelect({
        options: [],
        value: 'day',
        ariaLabel: t('holdDuration'),
        onChange: (value) => {
          this.holdUnit = value;
          this.renderHold();
          this.renderSubmitState();
        },
      });
      this.selects.push(this.holdUnitSelect);
      this.holdSub = el('div', { class: 'lzt-tre-sub', hidden: true },
        el('div', { class: 'lzt-tre-sub-label', text: t('holdDuration') }),
        el('div', { class: 'lzt-tre-hold-row' },
          this.holdValueInput,
          this.holdUnitSelect.root));
      this.holdNoteBody = el('div', { class: 'lzt-tre-notify-text' });
      this.holdNote = el('div', { class: 'lzt-tre-notify is-success', hidden: true },
        svg(ICONS.info, 20),
        this.holdNoteBody);

      const holdCard = this.optionCard(
        el('span', { class: 'lzt-tre-option-label', text: t('hold') }),
        this.holdToggle.root,
        this.holdSub,
        this.holdNote,
      );
      this.holdCard = holdCard;

      /* secret answer */
      const X = getXenForo();
      const visitor = (X && X.visitor) || {};
      this.secretInput = el('input', {
        type: 'text',
        class: 'textCtrl extraLarge full lzt-tre-input',
        placeholder: t('secretPlaceholder'),
        maxlength: '255',
        autocomplete: 'off',
        autocapitalize: 'none',
        spellcheck: 'false',
        name: 'lzt_tre_secret',
        'data-form-type': 'other',
        'data-lpignore': 'true',
        'data-1p-ignore': 'true',
      });
      this.secretInput.addEventListener('input', () => {
        this.secret = this.secretInput.value.slice(0, 255);
        if (this.secretInput.value !== this.secret) this.secretInput.value = this.secret;
        this.renderSubmitState();
      });
      this.secretInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.submit();
        }
      });

      this.secretQuestion = visitor.secret_answer_rendered || '';
      // Minimal, native-like field: label + input, no question text, no
      // first-letter hint, no reset link. Always visible so accounts without
      // a rendered question can still type an answer if the server asks.
      const secretField = this.field(t('secret'), this.secretInput);

      /* summary */
      this.summaryAmount = el('strong', { class: 'lzt-tre-sum-value', text: '—' });
      this.summaryCommission = el('strong', { class: 'lzt-tre-sum-value', text: '—' });
      this.summaryReceive = el('strong', { class: 'lzt-tre-sum-value', text: '—' });
      this.summaryReceiveRow = el('div', { class: 'lzt-tre-sum-row', hidden: true },
        el('span', { class: 'lzt-tre-sum-label', text: t('recipientReceives') }),
        this.summaryReceive);
      this.summaryTotal = el('strong', { class: 'lzt-tre-sum-value lzt-tre-sum-total', text: '—' });
      this.summaryTotalHint = el('span', { class: 'lzt-tre-sum-hint' });
      this.summaryError = el('div', { class: 'lzt-tre-sum-error', hidden: true });
      this.summary = el('div', { class: 'lzt-tre-summary' },
        el('div', { class: 'lzt-tre-sum-row' },
          el('span', { class: 'lzt-tre-sum-label', text: t('amount') }),
          this.summaryAmount),
        el('div', { class: 'lzt-tre-sum-row' },
          el('span', { class: 'lzt-tre-sum-label', text: t('commissionShort') }),
          this.summaryCommission),
        this.summaryReceiveRow,
        el('div', { class: 'lzt-tre-sum-divider' }),
        el('div', { class: 'lzt-tre-sum-row is-total' },
          el('span', { class: 'lzt-tre-sum-label', text: t('total') }),
          el('span', { class: 'lzt-tre-sum-total-wrap' }, this.summaryTotal, this.summaryTotalHint)),
        this.summaryError);

      this.formNode.append(
        walletField,
        recipientField,
        amountField,
        commissionCard,
        commentField,
        telegramCard,
        holdCard,
        secretField,
        this.summary,
      );

      this.submitButton = el('button', {
        type: 'button',
        class: 'button primary lzt-tre-submit',
        disabled: true,
        onclick: () => this.submit(),
      });
      this.submitLabel = el('span', { text: t('submit') });
      this.submitSpinner = el('span', { class: 'lzt-tre-btn-spinner', hidden: true, 'aria-hidden': 'true' });
      this.submitButton.append(this.submitSpinner, this.submitLabel);

      this.footerTotal = el('strong', { class: 'lzt-tre-foot-value', text: '—' });
      this.footerTotalHint = el('span', { class: 'lzt-tre-foot-hint' });
      this.footer = el('footer', { class: 'lzt-tre-foot', hidden: true },
        el('div', { class: 'lzt-tre-foot-total' },
          el('span', { class: 'lzt-tre-foot-label', text: t('total') }),
          el('span', { class: 'lzt-tre-foot-values' }, this.footerTotal, this.footerTotalHint)),
        this.submitButton);

      /* success */
      this.successIcon = el('div', { class: 'lzt-tre-success-icon' }, svg(ICONS.check, 28));
      this.successTitle = el('h3', { class: 'lzt-tre-success-title' });
      this.successMessage = el('p', { class: 'lzt-tre-success-message' });
      this.successDetails = el('div', { class: 'lzt-tre-success-details' });
      this.successDone = el('button', {
        type: 'button',
        class: 'button primary lzt-tre-success-btn',
        onclick: () => this.close(),
      }, t('done'));
      this.successAgain = el('button', {
        type: 'button',
        class: 'button lzt-tre-success-btn lzt-tre-ghost',
        onclick: () => this.openAgain(),
      }, t('again'));
      this.successNode = el('div', { class: 'lzt-tre-success', hidden: true },
        this.successIcon,
        this.successTitle,
        this.successMessage,
        this.successDetails,
        el('div', { class: 'lzt-tre-success-actions' }, this.successDone, this.successAgain));

      this.body = el('div', { class: 'lzt-tre-body' },
        this.alertNode,
        this.loadingNode,
        this.retryNode,
        this.formNode,
        this.successNode);

      this.dialog = el('div', {
        class: 'lzt-tre-dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'lzt-tre-title',
        tabindex: '-1',
      }, head, this.body, this.footer);

      this.overlay = el('div', { class: OVERLAY_CLASS }, this.dialog);
      this.overlay.addEventListener('mousedown', (event) => {
        if (event.target === this.overlay) this.close();
      });

      // Firefox: a page-level pointerdown/mousedown preventDefault (XenForo's
      // disableSelection, an open overlay, etc.) suppresses the native focus
      // action, so text fields cannot be clicked even though buttons work.
      // Keep these events inside our dialog and focus the field ourselves.
      const focusGuard = (event) => {
        event.stopPropagation();
        const target = event.target;
        if (!target || typeof target.closest !== 'function') return;
        let field = null;
        try {
          field = target.closest(FIELD_SELECTOR);
        } catch (_) {
          return;
        }
        if (!field && (event.clientX || event.clientY) && this.dialog?.contains(target)) {
          // A transparent layer (theme pseudo-element, page overlay) may sit
          // above the field; find the real input under the pointer.
          try {
            field = (doc.elementsFromPoint(event.clientX, event.clientY) || []).find(
              (node) => node.matches?.('input.textCtrl, textarea') && !node.disabled && !node.readOnly,
            ) || null;
          } catch (_) { /* ignore */ }
        }
        if (!field || field.disabled || field.readOnly) return;
        setTimeout(() => {
          if (doc.activeElement === field || !doc.contains(field)) return;
          try {
            field.focus({ preventScroll: true });
          } catch (_) {
            try { field.focus(); } catch (_) { /* ignore */ }
          }
        }, 0);
      };

      this.overlay.addEventListener('pointerdown', focusGuard, false);
      this.overlay.addEventListener('mousedown', focusGuard, false);
      this.overlay.addEventListener('click', focusGuard, false);
      this.overlay.addEventListener('selectstart', (event) => event.stopPropagation(), false);
      for (const type of ['keydown', 'keypress', 'keyup', 'input', 'beforeinput']) {
        this.overlay.addEventListener(type, (event) => event.stopPropagation(), false);
      }
    }

    field(label, control, hint) {
      // `label` may be a plain string or a ready-made element.
      // Never stringify a DOM node (that produced '[object HTMLSpanElement]').
      let labelIsNode = false;
      try {
        labelIsNode = Boolean(label && typeof label === 'object' && label.nodeType);
      } catch (_) { /* cross-compartment wrapper */ }
      const labelNode = labelIsNode
        ? label
        : el('span', { class: 'lzt-tre-label', text: label });
      const children = [labelNode, control];
      if (hint) children.push(hint);
      return el('div', { class: 'lzt-tre-field' }, ...children);
    }

    optionCard(labelNode, toggleNode, ...extras) {
      const head = el('div', { class: 'lzt-tre-option-head' }, labelNode, toggleNode);
      return el('div', { class: 'lzt-tre-option' }, head, ...extras);
    }

    /* ---------------------------- loading ----------------------------- */

    async load() {
      this.loadAbort?.abort();
      this.loadAbort = new AbortController();
      this.error = '';
      this.render();

      try {
        const data = await loadBootstrap(this.options, this.loadAbort.signal);
        if (this.destroyed) return;
        this.hydrate(data);
      } catch (error) {
        if (error.name === 'AbortError') return;
        this.error = error.message || t('loadFailed');
        this.render();
      }
    }

    hydrate(data) {
      this.data = data;
      this.currencies = data.currencies && typeof data.currencies === 'object' ? data.currencies : {};
      this.visitorCurrency = String(
        (getXenForo() && getXenForo().visitor && getXenForo().visitor.currency) || 'rub',
      ).toLowerCase();

      const balanceEntries = Object.entries(data.transferableBalances || {}).map(([id, balance]) => ({
        ...balance,
        balance_id: balance.balance_id || id,
      }));
      this.balances = balanceEntries;
      const preferred = balanceEntries.find((item) => item.type === 'balance') || balanceEntries[0];
      this.balanceId = preferred ? preferred.balance_id : '';

      const currencyIds = Object.keys(this.currencies);
      if (!currencyIds.length) currencyIds.push('rub', 'usd', 'eur');
      this.currency = this.currencies[this.visitorCurrency] ? this.visitorCurrency : currencyIds[0];
      this.currencySelect.setOptions(
        currencyIds.map((id) => ({
          value: id,
          label: currencyTitle(id, this.currencies[id]?.title),
        })),
        this.currency,
      );

      this.presets = Array.isArray(data.popularTransfers) ? data.popularTransfers : [];
      this.recent = Array.isArray(data.lastRecipients) ? data.lastRecipients.filter(Boolean) : [];

      if (data.user) {
        this.setUser(data.user);
      } else if (this.options.username) {
        // The username passed in the URL did not resolve — run a live search
        // so the user can pick the right account from the suggestions.
        this.recipientInput.value = this.options.username;
        this.onRecipientInput();
      }

      this.renderWallet();
      this.renderRecent();
      this.renderPresets();
      this.render();
      this.renderRecipient();
      this.renderHold();
      this.renderSubmitState();

      if (doc.activeElement === doc.body || doc.activeElement === this.recipientInput) {
        this.focusFirst();
      }
    }

    /* --------------------------- renderers ---------------------------- */

    render() {
      if (!this.overlay) return;

      this.renderAlert();
      this.renderWallet();
      this.renderAmountSuffix();
      this.renderHold();
      this.renderTelegram();
      this.commissionCard?.classList.toggle('is-selected', this.commissionFromReceiver);
      this.telegramCard?.classList.toggle('is-selected', this.telegramDeal);
      this.holdCard?.classList.toggle('is-selected', this.holdActive());
      this.renderSummary();
      this.renderSubmitState();

      const ready = Boolean(this.data) || Boolean(this.success);
      const failed = !this.data && Boolean(this.error);

      this.loadingNode.hidden = ready || failed;
      this.retryNode.hidden = !failed;
      this.formNode.hidden = !ready || Boolean(this.success);
      this.footer.hidden = !ready || Boolean(this.success);
      this.successNode.hidden = !this.success;
    }

    renderAlert() {
      const message = this.error;
      this.alertNode.hidden = !message;
      this.alertNode.replaceChildren();
      if (!message) return;
      this.alertNode.append(
        svg(ICONS.alert, 18),
        el('span', { class: 'lzt-tre-alert-text' }, sanitizeRichText(message)),
      );
    }

    renderWallet() {
      this.walletNode.replaceChildren();
      if (!this.balances.length) {
        this.walletNode.append(el('div', { class: 'lzt-tre-hint', text: t('noWallet') }));
        return;
      }
      if (this.balances.length === 1) {
        const wallet = this.balances[0];
        this.walletNode.append(el('div', {
          class: 'lzt-tre-readonly',
          text: this.walletLabel(wallet),
        }));
        return;
      }
      if (!this.walletSelect) {
        this.walletSelect = makeSelect({
          options: [],
          value: this.balanceId,
          ariaLabel: t('wallet'),
          onChange: (value) => {
            this.balanceId = value;
            this.renderSummary();
            this.renderSubmitState();
          },
        });
        this.selects.push(this.walletSelect);
      }
      const walletKey = this.balances.map((wallet) => wallet.balance_id).join('|');
      if (walletKey !== this._walletKey) {
        this._walletKey = walletKey;
        this.walletSelect.setOptions(
          this.balances.map((wallet) => ({
            value: wallet.balance_id,
            label: this.walletLabel(wallet),
          })),
          this.balanceId,
        );
      }
      this.walletNode.append(this.walletSelect.root);
    }

    renderAmountSuffix() {
      const symbol = this.currencies[this.currency]?.symbol || this.currency.toUpperCase();
      // Reuse the forum's own currency icon class, exactly like the native
      // amount row (`<span class="amountSuffix svgIcon--rub">`).
      this.amountSuffix.className = `lzt-tre-amount-suffix svgIcon--${this.currency}`;
      // Reading ::before is a style/layout hit. The glyph only depends on the
      // currency, not on the amount, so do it once per currency.
      if (this._suffixGlyphKey !== this.currency) {
        this._suffixGlyphKey = this.currency;
        this.amountSuffix.textContent = '';
        const glyph = getComputedStyle(this.amountSuffix, '::before').content;
        if (!glyph || glyph === 'none' || glyph === 'normal') {
          this.amountSuffix.textContent = symbol;
        }
      }
      this.currencySelect.setValue(this.currency);
    }

    renderPresets() {
      this.presetsNode.replaceChildren();
      const values = new Set();
      const wallet = this.wallet();

      for (const raw of this.presets) {
        const value = this.fromVisitor(Number(raw));
        if (Number.isFinite(value) && this.toRub(value) >= MIN_RUB) {
          values.add(Number(value.toFixed(2)));
        }
      }
      if (wallet && Number.isFinite(Number(wallet.convertedBalance))) {
        const max = this.fromVisitor(Number(wallet.convertedBalance));
        if (Number.isFinite(max) && max > 0) values.add(Number(max.toFixed(2)));
      }

      for (const value of values) {
        const button = el('button', {
          type: 'button',
          class: 'lzt-tre-preset',
          onclick: () => {
            this.amount = this.sanitizeAmount(value.toFixed(2));
            this.amountInput.value = this.amount;
            this.scheduleFee();
            this.render();
          },
        });
        button.append(
          el('span', { text: formatNumber(value, 0, 2) }),
          el('span', { class: 'lzt-tre-preset-symbol', text: this.currencies[this.currency]?.symbol || '' }),
        );
        this.presetsNode.append(button);
      }
      this.presetsNode.hidden = values.size === 0;
    }

    renderRecipient() {
      if (!this.user) {
        this.recipientChip.hidden = true;
        this.recipientInput.hidden = false;
        this.recipientInput.disabled = false;
        this.renderRecent();
        return;
      }
      this.recipientChip.hidden = false;
      // Disable (not just hide) the free-form input while a recipient is
      // selected: Chrome autofill otherwise writes into it and wipes the user.
      this.recipientInput.hidden = true;
      this.recipientInput.disabled = true;
      this.recipientInput.value = '';
      this.recipientSuggest.hidden = true;
      this.recentNode.hidden = true;
      const avatar = this.user.avatar;
      if (avatar) {
        this.recipientAvatar.src = avatar;
        this.recipientAvatar.hidden = false;
      } else {
        this.recipientAvatar.removeAttribute('src');
        this.recipientAvatar.hidden = true;
      }
      this.recipientName.replaceChildren(
        this.user.html ? sanitizeUsername(this.user.html) : doc.createTextNode(this.user.username || ''),
      );
    }

    renderRecent() {
      this.recentNode.replaceChildren();
      const query = this.recipientInput.value.trim();
      const items = this.recent.filter((candidate) => candidate && candidate.user_id);
      if (!items.length || this.user || query || !this.recipientSuggest.hidden) {
        this.recentNode.hidden = true;
        return;
      }
      this.recentNode.hidden = false;
      this.recentNode.append(el('div', { class: 'lzt-tre-recent-title', text: t('recent') }));
      const grid = el('div', { class: 'lzt-tre-recent-grid' });
      for (const item of items.slice(0, 6)) {
        const card = el('button', {
          type: 'button',
          class: 'lzt-tre-recent-card',
          onclick: () => {
            this.setUser(item);
            this.renderRecent();
          },
        });
        const avatar = item.rendered?.avatars?.s || item.rendered?.avatars?.m || item.avatar || '';
        // Keep the server-rendered nickname markup: it carries the user's
        // colour/gradient/icon classes. Plain `username` loses all of that.
        const name = el('span', { class: 'lzt-tre-recent-name' });
        name.append(
          item.rendered?.username
            ? sanitizeUsername(item.rendered.username)
            : doc.createTextNode(item.username || ''),
        );
        card.append(
          el('img', { class: 'lzt-tre-recent-avatar', src: avatar, alt: '', width: 28, height: 28 }),
          name,
        );
        grid.append(card);
      }
      this.recentNode.append(grid);
    }

    /* --------------------------- recipient search --------------------- */

    onRecipientInput() {
      if (this.user) return;
      const value = this.recipientInput.value.slice(0, 64);
      if (value !== this.recipientInput.value) this.recipientInput.value = value;
      const query = value.trim().replace(/^@/, '');
      this.suggestIndex = -1;
      clearTimeout(this.searchTimer);
      this.searchAbort?.abort();

      if (query.length < 2) {
        this.suggestions = [];
        this.searchLoading = false;
        this.searchError = '';
        this.renderSuggestions();
        this.renderRecent();
        this.renderSubmitState();
        return;
      }

      this.searchLoading = true;
      this.searchError = '';
      this.renderSuggestions();
      this.renderSubmitState();
      this.searchTimer = setTimeout(() => this.searchMembers(query), 320);
    }

    async searchMembers(query) {
      this.searchAbort?.abort();
      this.searchAbort = new AbortController();
      const body = new URLSearchParams({
        q: query,
        _xfRequestUri: currentUri(),
        _xfNoRedirect: '1',
        _xfToken: csrfToken(),
        _xfResponseType: 'json',
      });

      try {
        const res = await pageFetch('/members/find', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body,
          signal: this.searchAbort.signal,
        });
        const json = await res.json().catch(() => null);
        if (this.recipientInput.value.trim().replace(/^@/, '') !== query) return;
        if (!res.ok || !json || !json.results) {
          throw new Error(t('searchError'));
        }
        this.suggestions = Object.entries(json.results).slice(0, 8).map(([username, user]) => ({
          username,
          userId: user.user_id,
          avatar: user.avatar || '',
          html: user.username || '',
        }));
        this.searchLoading = false;
        this.searchError = '';
        this.suggestIndex = this.suggestions.length ? 0 : -1;
      } catch (error) {
        if (error.name === 'AbortError') return;
        this.searchLoading = false;
        this.searchError = error.message || t('searchError');
        this.suggestions = [];
      }
      this.renderSuggestions();
    }

    renderSuggestions() {
      const query = this.recipientInput.value.trim().replace(/^@/, '');
      if (this.user || !query) {
        this.recipientSuggest.hidden = true;
        return;
      }

      if (this.searchLoading) {
        this.recipientSuggest.hidden = true;
        return;
      }
      this.recipientSuggest.hidden = false;
      this.recipientSuggest.replaceChildren();

      if (this.searchError) {
        this.recipientSuggest.append(el('div', { class: 'lzt-tre-suggest-state is-error', text: this.searchError }));
        return;
      }
      if (!this.suggestions.length) {
        this.recipientSuggest.append(el('div', { class: 'lzt-tre-suggest-state', text: t('searchEmpty') }));
        return;
      }

      this.suggestions.forEach((item, index) => {
        const option = el('button', {
          type: 'button',
          class: `lzt-tre-suggest-item${index === this.suggestIndex ? ' is-active' : ''}`,
          role: 'option',
          'aria-selected': String(index === this.suggestIndex),
        });
        if (item.avatar) {
          option.append(el('img', { class: 'lzt-tre-suggest-avatar', src: item.avatar, alt: '', width: 28, height: 28 }));
        } else {
          option.append(el('span', { class: 'lzt-tre-suggest-avatar is-empty' }, (item.username || '?')[0].toUpperCase()));
        }
        const name = el('span', { class: 'lzt-tre-suggest-name' });
        name.append(item.html ? sanitizeUsername(item.html) : doc.createTextNode(item.username));
        option.append(name);
        option.addEventListener('mousedown', (event) => event.preventDefault());
        option.addEventListener('click', () => this.selectSuggestion(item));
        this.recipientSuggest.append(option);
      });
    }

    onRecipientKeydown(event) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (this.recipientSuggest.hidden || !this.suggestions.length) return;
        event.preventDefault();
        const length = this.suggestions.length;
        this.suggestIndex = event.key === 'ArrowDown'
          ? (this.suggestIndex + 1) % length
          : (this.suggestIndex - 1 + length) % length;
        this.renderSuggestions();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        if (!this.recipientSuggest.hidden && this.suggestions.length) {
          const index = this.suggestIndex >= 0 ? this.suggestIndex : 0;
          this.selectSuggestion(this.suggestions[index]);
        }
        return;
      }
      if (event.key === 'Escape') {
        event.stopPropagation();
        this.hideSuggestions();
      }
    }

    selectSuggestion(item) {
      this.recipientInput.value = '';
      this.suggestions = [];
      this.suggestIndex = -1;
      this.searchLoading = false;
      this.searchError = '';
      this.recipientSuggest.hidden = true;
      this.setUser({
        user_id: item.userId,
        username: item.username,
        rendered: { username: item.html, avatars: { s: item.avatar } },
      });
      this.renderSuggestions();
      this.renderRecent();
    }

    hideSuggestions() {
      clearTimeout(this.searchTimer);
      this.searchAbort?.abort();
      this.searchLoading = false;
      this.searchError = '';
      this.suggestions = [];
      this.suggestIndex = -1;
      this.recipientSuggest.hidden = true;
      this.renderRecent();
    }

    renderHold() {
      const rub = this.toRub(this.amountNumber());
      const holdPossible = rub !== null && rub >= HOLD_MIN_RUB;
      if (!holdPossible && this.holdEnabled) this.holdEnabled = false;
      const active = this.holdEnabled && holdPossible;

      this.holdToggle.setValue(this.holdEnabled, true);
      // The whole toggle stays visible but dimmed/disabled below 10 ₽.
      this.holdToggle.setDisabled(!holdPossible);
      this.holdSub.hidden = !active;

      const max = Math.min(HOLD_INPUT_MAX, HOLD_MAX[this.holdUnit] || 30);
      if (this.holdValue > max) {
        this.holdValue = max;
        this.holdValueInput.value = String(max);
      }
      this.holdValueInput.max = String(max);
      if (!this.holdValueInput.value && doc.activeElement !== this.holdValueInput) {
        this.holdValue = Math.max(1, Math.min(max, this.holdValue || 1));
        this.holdValueInput.value = String(this.holdValue);
      }
      const unitKey = `${this.holdUnit}:${this.holdValue}`;
      if (unitKey !== this._holdUnitKey) {
        this._holdUnitKey = unitKey;
        this.holdUnitSelect.setOptions(
          HOLD_UNITS.map((unit) => ({ value: unit, label: unitLabel(unit, this.holdValue) })),
          this.holdUnit,
        );
      }

      // No hint text: the control is visibly dimmed/disabled until 10 ₽.

      // No "transfer without hold" scare block. When the hold is enabled we
      // show the same green notice as the native second step.
      this.holdNote.hidden = !active;
      if (active) {
        const html = `<span class="bold">${t('holdNote')}</span><br><br>`
          + `<span class="lzt-tre-danger">${t('holdNoteDanger')}</span>`;
        if (this._holdNoteText !== html) {
          this._holdNoteText = html;
          this.holdNoteBody.innerHTML = html;
        }
      }
    }

    renderTelegram() {
      this.telegramToggle.setValue(this.telegramDeal, true);
      this.telegramSub.hidden = !this.telegramDeal;
    }

    renderSummary() {
      const calc = this.calc();
      const symbol = this.currencies[this.currency]?.symbol || '';
      const visitorSymbol = this.currencies[this.visitorCurrency]?.symbol || '';

      this.summaryError.hidden = !this.feeError;
      this.summaryError.textContent = this.feeError || '';

      if (!calc) {
        this.summaryAmount.textContent = this.amountNumber() ? `${formatNumber(this.amountNumber())} ${symbol}` : '—';
        this.summaryCommission.textContent = this.feeLoading ? '…' : '—';
        this.summaryTotal.textContent = '—';
        this.summaryTotalHint.textContent = '';
        this.footerTotal.textContent = '—';
        this.footerTotalHint.textContent = '';
        this.summaryReceiveRow.hidden = !this.commissionFromReceiver;
        this.summaryReceive.textContent = '—';
        return;
      }

      const commissionText = `${formatNumber(calc.commissionSelected)} ${symbol} `
        + `(${formatNumber(calc.percent, 0, 2)} %)`;

      this.summaryAmount.textContent = `${formatNumber(calc.amount)} ${symbol}`;
      this.summaryCommission.textContent = this.feeLoading ? '…' : commissionText;
      this.summaryReceiveRow.hidden = !this.commissionFromReceiver;
      this.summaryReceive.textContent = `${formatNumber(calc.receiveSelected)} ${symbol}`;
      this.summaryTotal.textContent = `${formatNumber(calc.totalSelected)} ${symbol}`;

      const totalVisitor = calc.totalVisitor;
      this.summaryTotalHint.textContent = this.currency !== this.visitorCurrency && Number.isFinite(totalVisitor)
        ? `≈ ${formatNumber(totalVisitor)} ${visitorSymbol}`
        : '';
      this.footerTotal.textContent = `${formatNumber(calc.totalSelected)} ${symbol}`;
      this.footerTotalHint.textContent = this.currency !== this.visitorCurrency && Number.isFinite(totalVisitor)
        ? `≈ ${formatNumber(totalVisitor)} ${visitorSymbol}`
        : '';
    }

    renderSubmitState() {
      if (!this.submitButton) return;
      const error = this.validate();
      const cooldown = this.cooldownSeconds();
      const canSubmit = !error && !this.busy && !this.success && cooldown <= 0;
      this.submitButton.disabled = !canSubmit;
      this.submitButton.classList.toggle('is-loading', this.busy);
      this.submitSpinner.hidden = !this.busy;
      this.submitLabel.textContent = this.busy
        ? t('sending')
        : cooldown > 0
          ? `${t('wait')} ${cooldown} с`
          : t('submit');
    }

    cooldownSeconds() {
      if (!this.cooldownUntil) return 0;
      return Math.max(0, Math.ceil((this.cooldownUntil - Date.now()) / 1000));
    }

    startCooldown(seconds) {
      if (!Number.isFinite(seconds) || seconds <= 0) return;
      this.cooldownUntil = Date.now() + seconds * 1000;
      clearInterval(this.cooldownTimer);
      this.cooldownTimer = setInterval(() => {
        if (this.cooldownSeconds() <= 0) {
          clearInterval(this.cooldownTimer);
          this.cooldownTimer = null;
        }
        this.renderSubmitState();
      }, 1000);
      this.renderSubmitState();
    }

    /* ---------------------------- helpers ----------------------------- */

    wallet() {
      return this.balances.find((item) => item.balance_id === this.balanceId) || this.balances[0] || null;
    }

    walletLabel(wallet) {
      if (!wallet) return '';
      if (wallet.balance_id === 'balance') {
        const symbol = this.currencies[this.visitorCurrency]?.symbol || '₽';
        const amount = Number(wallet.convertedBalance);
        return `Баланс на Маркете (${Number.isFinite(amount) ? formatNumber(amount) : '—'} ${symbol})`;
      }
      return wallet.fullTitle || wallet.title || wallet.balance_id;
    }

    legacyUrl() {
      const url = new URL(BOOTSTRAP_ENDPOINT, location.origin);
      url.searchParams.set('hold', '1');
      if (this.options.userId) url.searchParams.set('user_id', String(this.options.userId));
      else if (this.options.username) url.searchParams.set('username', this.options.username);
      return url.href;
    }

    rate(currency) {
      const rate = Number(this.currencies[currency]?.rate);
      return Number.isFinite(rate) && rate > 0 ? rate : null;
    }

    toRub(amount) {
      if (!Number.isFinite(amount)) return null;
      const rate = this.rate(this.currency);
      return rate ? amount * rate : null;
    }

    /** Convert an amount from the visitor currency into the selected one. */
    fromVisitor(amount) {
      if (!Number.isFinite(amount)) return NaN;
      const from = this.rate(this.visitorCurrency);
      const to = this.rate(this.currency);
      if (!from || !to) return NaN;
      return (amount * from) / to;
    }

    amountNumber() {
      return toNumber(this.amount);
    }

    sanitizeAmount(value) {
      let next = String(value).replace(/,/g, '.').replace(/[^\d.]/g, '');
      if (!next) return '';
      const dot = next.indexOf('.');
      let integer = dot === -1 ? next : next.slice(0, dot);
      let fraction = dot === -1 ? null : next.slice(dot + 1).replace(/\./g, '').slice(0, 2);
      integer = integer.replace(/^0+(?=\d)/, '') || '0';
      if (Number(integer) > AMOUNT_MAX) integer = String(AMOUNT_MAX);
      next = fraction === null ? integer : `${integer}.${fraction}`;
      const numeric = Number(next);
      if (Number.isFinite(numeric) && numeric > AMOUNT_MAX) next = String(AMOUNT_MAX);
      return next;
    }

    calc() {
      const amount = this.amountNumber();
      if (!amount || amount <= 0 || !this.fee || !this.fee.calculator) return null;
      // Never mix a fresh amount with a fee calculated for the previous one.
      if (!this.feeFor || this.feeFor.amount !== amount || this.feeFor.currency !== this.currency) return null;
      const calculator = this.fee.calculator;
      const inputVisitor = Number(calculator.inputAmount);
      const commissionVisitor = Number(calculator.commissionAmount);
      const totalVisitor = Number(calculator.totalOutputAmount);
      if (![inputVisitor, commissionVisitor, totalVisitor].every(Number.isFinite)) return null;

      const commissionSelected = this.fromVisitor(commissionVisitor);
      const totalSelected = this.commissionFromReceiver ? amount : amount + commissionSelected;
      const receiveSelected = this.commissionFromReceiver ? amount - commissionSelected : amount;
      const debitVisitor = this.commissionFromReceiver ? inputVisitor : totalVisitor;

      return {
        amount,
        percent: Number(this.fee.commission_percentage) || 0,
        commissionVisitor,
        commissionSelected,
        totalSelected,
        totalVisitor: this.commissionFromReceiver ? inputVisitor : totalVisitor,
        receiveSelected,
        debitVisitor,
      };
    }

    setUser(user) {
      if (!user) {
        this.user = null;
        this.renderRecipient();
        this.renderRecent();
        this.renderSubmitState();
        return;
      }
      this.user = {
        userId: Number(user.user_id || user.userId) || null,
        username: user.username || '',
        html: user.rendered?.username || '',
        avatar: user.rendered?.avatars?.s || user.rendered?.avatars?.m || user.avatar || '',
      };
      this.renderRecipient();
      this.renderRecent();
      this.renderSubmitState();
    }

    clearUser() {
      this.user = null;
      this.recipientInput.value = '';
      this.hideSuggestions();
      this.recipientInput.focus();
      this.renderRecipient();
      this.renderRecent();
      this.renderSubmitState();
    }

    setError(message) {
      this.error = message || '';
      this.renderAlert();
      if (message) this.body.scrollTo({ top: 0, behavior: 'smooth' });
    }

    /* ------------------------------ fee ------------------------------- */

    scheduleFee() {
      clearTimeout(this.feeTimer);
      this.feeTimer = setTimeout(() => this.fetchFee(), 250);
    }

    async fetchFee() {
      const amount = this.amountNumber();
      if (!amount || amount <= 0) {
        this.feeAbort?.abort();
        this.fee = null;
        this.feeFor = null;
        this.feeError = '';
        this.feeLoading = false;
        this.render();
        return;
      }

      this.feeAbort?.abort();
      this.feeAbort = new AbortController();
      const seq = ++this.feeSeq;
      const currency = this.currency;
      this.feeLoading = true;
      this.renderSummary();
      this.renderSubmitState();

      try {
        const json = await apiFetch(FEE_ENDPOINT, {
          query: { amount: String(amount), currency },
          tokenScopes: scopes.read,
          signal: this.feeAbort.signal,
        });
        if (seq !== this.feeSeq) return;
        this.fee = json;
        this.feeFor = { amount, currency };
        this.feeError = '';
      } catch (error) {
        if (error.name === 'AbortError') return;
        if (seq !== this.feeSeq) return;
        this.fee = null;
        this.feeFor = null;
        this.feeError = error.message || t('errFee');
      } finally {
        if (seq === this.feeSeq) {
          this.feeLoading = false;
          this.render();
        }
      }
    }

    /* --------------------------- validation --------------------------- */

    validate() {
      if (!this.balances.length) return t('noWallet');
      if (!this.user) return t('errRecipient');
      const amount = this.amountNumber();
      if (amount === null || amount <= 0) return t('errAmount');
      if (amount > AMOUNT_MAX) return t('errAmountMax');
      if ((this.toRub(amount) || 0) < MIN_RUB) return t('errMin');

      if (this.comment.length > 255) return t('errComment');
      if (this.telegramDeal && !this.telegramUsername.trim().replace(/^@/, '')) return t('errTelegram');
      if (this.secretQuestion && !this.secret.trim()) return t('errSecret');

      const rub = this.toRub(amount) || 0;
      if (this.holdEnabled && rub >= HOLD_MIN_RUB) {
        const max = Math.min(HOLD_INPUT_MAX, HOLD_MAX[this.holdUnit] || 0);
        if (!Number.isInteger(this.holdValue) || this.holdValue < 1 || this.holdValue > max) {
          return t('errHold');
        }
      }

      if (this.feeError) return this.feeError;
      if (!this.fee) return t('errFee');

      const calc = this.calc();
      if (!calc) return t('errFee');
      const wallet = this.wallet();
      const balance = Number(wallet?.convertedBalance);
      if (Number.isFinite(balance) && calc.debitVisitor > balance + 1e-6) return t('errBalance');

      return '';
    }

    holdActive() {
      const rub = this.toRub(this.amountNumber());
      return this.holdEnabled && rub !== null && rub >= HOLD_MIN_RUB;
    }

    /* ----------------------------- submit ----------------------------- */

    async submit() {
      if (this.busy || this.success) return;
      this.setError('');
      const problem = this.validate();
      if (problem) {
        this.setError(problem);
        return;
      }

      this.busy = true;
      this.renderSubmitState();

      try {
        const secretAnswer = this.secret.trim();
        const token = await getToken(scopes.payment, secretAnswer);
        const calc = this.calc();

        const form = new URLSearchParams();
        form.append('balance_id', this.balanceId);
        form.append('amount', this.amountNumber().toFixed(2).replace(/\.00$/, ''));
        form.append('currency', this.currency);
        form.append('commission_from_receiver', String(this.commissionFromReceiver));
        form.append('telegram_deal', String(this.telegramDeal));
        form.append('transfer_hold', String(this.holdActive()));

        // user_id is unambiguous and immune to nickname changes/typos.
        if (this.user?.userId) form.append('user_id', String(this.user.userId));
        else if (this.user?.username) form.append('username', this.user.username);
        else throw new ApiError(t('errRecipient'));

        const comment = this.comment.trim();
        if (comment) form.append('comment', comment);
        if (this.telegramDeal) {
          form.append('telegram_username', this.telegramUsername.trim().replace(/^@/, ''));
        }
        if (this.holdActive()) {
          form.append('hold_length_value', String(this.holdValue));
          form.append('hold_length_option', this.holdUnit);
        }

        form.append('_xfRequestUri', currentUri());
        form.append('_xfNoRedirect', '1');
        form.append('_xfToken', csrfToken());
        form.append('_xfResponseType', 'json');

        const res = await pageFetch(apiBase().replace(/\/+$/, '') + TRANSFER_ENDPOINT, {
          method: 'POST',
          credentials: 'omit',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          },
          body: form,
        });
        const json = await res.json().catch(() => null);

        if (!res.ok || !json || json.status !== 'ok') {
          const message = errorText(json, `Request failed (HTTP ${res.status})`);
          if (/token|authoriz/i.test(message)) tokenCache.clear();
          throw new ApiError(message, res.status, json);
        }

        this.success = {
          message: t('successFallback'),
          logId: json.system_info?.log_id || null,
          amount: calc?.amount ?? this.amountNumber(),
          currency: this.currency,
          total: calc?.totalSelected ?? null,
          recipient: this.user?.username || typed,
          hold: this.holdActive(),
        };
        this.render();
        this.renderSuccess();
      } catch (error) {
        const message = error.message || String(error);
        const cooldown = parseCooldown(message);
        if (cooldown) this.startCooldown(cooldown);
        this.setError(message);
      } finally {
        this.busy = false;
        this.renderSubmitState();
      }
    }

    renderSuccess() {
      if (!this.success) return;
      const symbol = this.currencies[this.success.currency]?.symbol || '';
      this.successTitle.textContent = t('successTitle');
      this.successMessage.textContent = this.success.message;
      this.successDetails.replaceChildren();

      const rows = [
        [t('recipient'), this.success.recipient],
        [t('amount'), `${formatNumber(this.success.amount)} ${symbol}`],
      ];
      if (Number.isFinite(this.success.total)) {
        rows.push([t('total'), `${formatNumber(this.success.total)} ${symbol}`]);
      }
      rows.push([t('holdShort'), this.success.hold ? t('yes') : t('no')]);
      if (this.success.logId) rows.push([t('logId'), String(this.success.logId)]);

      for (const [label, value] of rows) {
        this.successDetails.append(
          el('div', { class: 'lzt-tre-success-row' },
            el('span', { class: 'lzt-tre-success-label', text: label }),
            el('strong', { class: 'lzt-tre-success-value', text: value })),
        );
      }
    }

    openAgain() {
      const options = { ...this.options };
      this.close();
      setTimeout(() => openTransfer(options), 260);
    }

    /* ---------------------------- lifecycle --------------------------- */

    bindGlobal() {
      this.onKeyDown = (event) => {
        if (event.key === 'Escape') {
          if (openSelects.size) {
            event.preventDefault();
            event.stopPropagation();
            closeAllSelects();
            return;
          }
          if (!this.recipientSuggest.hidden) {
            event.preventDefault();
            event.stopPropagation();
            this.hideSuggestions();
            return;
          }
          event.preventDefault();
          this.close();
          return;
        }
        if (event.key !== 'Tab') return;
        const focusable = Array.from(this.dialog.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )).filter((node) => node.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && doc.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && doc.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      };

      this.onPointerDown = (event) => {
        const target = event.target;
        if (openSelects.size) {
          let insideSelect = false;
          for (const select of openSelects) {
            if (select.root.contains(target)) insideSelect = true;
          }
          if (!insideSelect) closeAllSelects();
        }
        if (!this.recipientSuggest.hidden && this.recipientWrap && !this.recipientWrap.contains(target)) {
          this.hideSuggestions();
        }
      };

      doc.addEventListener('keydown', this.onKeyDown, true);
      doc.addEventListener('pointerdown', this.onPointerDown, true);
    }

    focusFirst() {
      if (this.destroyed) return;
      const target = this.user ? this.amountInput : this.recipientInput;
      target?.focus({ preventScroll: true });
    }

    close() {
      if (this.destroyed || this.closing) return;
      this.closing = true;
      this.overlay.classList.add('is-closing');
      this.overlay.classList.remove('is-open');

      const finish = () => {
        clearTimeout(this.closeTimer);
        if (!this.destroyed) this.destroy();
      };
      this.overlay.addEventListener('transitionend', (event) => {
        if (event.target === this.overlay) finish();
      }, { once: true });
      // Fallback for reduced-motion / interrupted transitions.
      this.closeTimer = setTimeout(finish, 260);
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.loadAbort?.abort();
      this.searchAbort?.abort();
      this.feeAbort?.abort();
      clearTimeout(this.searchTimer);
      clearTimeout(this.feeTimer);
      clearTimeout(this.closeTimer);
      clearTimeout(this._focusOutTimer);
      clearTimeout(this._refocusTimer);
      clearInterval(this.cooldownTimer);

      doc.removeEventListener('keydown', this.onKeyDown, true);
      doc.removeEventListener('pointerdown', this.onPointerDown, true);
      for (const select of this.selects) select.destroy?.();
      this.selects.length = 0;
      openSelects.clear();

      this.overlay?.remove();
      if (DEBUG && debugNode) {
        debugNode.remove();
        debugNode = null;
      }
      unlockPageScroll();
      if (activeDialog === this) {
        activeDialog = null;
        if (this.trigger && typeof this.trigger.focus === 'function') {
          try { this.trigger.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
        }
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Entry points                                                       */
  /* ------------------------------------------------------------------ */

  let activeDialog = null;

  function isLoggedIn() {
    const X = getXenForo();
    const visitor = X && X.visitor;
    return Boolean(visitor && Number(visitor.user_id) > 0);
  }

  function parseTransferLink(href) {
    try {
      const url = new URL(href, location.href);
      if (!/\/payment\/balance-transfer\/?$/.test(url.pathname)) return null;
      const holdParam = url.searchParams.get('hold');
      return {
        userId: Number(url.searchParams.get('user_id')) || null,
        username: url.searchParams.get('username') || null,
        hold: holdParam === null ? true : holdParam === '1',
        href: url.href,
      };
    } catch (_) {
      return null;
    }
  }

  // XenForo's member card (and any other native overlay) stays open while its
  // transfer link is clicked and keeps enforcing focus on itself. In Firefox
  // that steals focus from our fields on every click, making the dialog
  // unusable. Close native overlays instantly before opening our dialog; the
  // transfer flow itself does not need the card that launched it.
  function closeNativeOverlays() {
    const X = getXenForo();
    const cache = X && X.OverlayLoaderCache;
    if (!cache || typeof cache !== 'object') return 0;

    let closed = 0;
    for (const key of Object.keys(cache)) {
      const overlay = cache[key];
      if (!overlay || typeof overlay.close !== 'function') continue;
      try {
        if (typeof overlay.isOpened === 'function' && !overlay.isOpened()) continue;
        const conf = typeof overlay.getConf === 'function' ? overlay.getConf() : null;
        if (conf) {
          conf.closeSpeed = 0;
          if (conf.mask) conf.mask.closeSpeed = 0;
        }
        overlay.close();
        closed += 1;
      } catch (_) { /* a closed/partial overlay must not block the dialog */ }
    }
    if (closed) debug('native overlays closed', closed);
    return closed;
  }

  function openTransfer(options = {}) {
    if (!isLoggedIn()) return false;
    activeDialog?.close();
    closeNativeOverlays();
    activeDialog = new TransferDialog(options);
    activeDialog.open(options.trigger || null).catch((error) => {
      console.error('[LztTMR] open failed', error);
    });
    return true;
  }

  // Opening a transfer URL (middle-click, "open in new tab", bookmark or
  // direct navigation) bypasses the click interceptor. Replace that page with
  // the same dialog once XenForo has initialised.
  let directOpenTimer = 0;
  let directOpenAttempts = 0;
  function openDirectTransfer() {
    directOpenTimer = 0;
    if (activeDialog) return;
    const parsed = parseTransferLink(location.href);
    if (!parsed) return;
    if (openTransfer(parsed)) return;
    if (directOpenAttempts++ < 30) {
      directOpenTimer = setTimeout(openDirectTransfer, 100);
    }
  }

  function getTransferLink(event) {
    if (event.defaultPrevented) return null;
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return null;

    const target = event.target;
    if (!target || typeof target.closest !== 'function') return null;
    if (target.closest(`.${OVERLAY_CLASS}`)) return null;

    const anchor = target.closest('a[href], [data-href], [data-url]');
    if (!anchor) return null;

    const href = anchor.getAttribute('href') || anchor.getAttribute('data-href') || anchor.getAttribute('data-url') || '';
    if (!/payment\/balance-transfer/.test(href)) return null;
    return { anchor, href };
  }

  // The page may cancel pointerdown/mousedown at window/document capture,
  // and a transparent node may sit above the field. Both prevent the native
  // focus action in Firefox. This runs first (window capture, document-start)
  // and focuses the field under the pointer explicitly.
  function focusPointerField(event, field, dialog) {
    debug('pointer-focus', event.type, field.className, 'active=', doc.activeElement?.className);

    // Keep page-level focus traps and preventDefault handlers out of the way.
    event.stopImmediatePropagation();
    event.stopPropagation();

    const focus = () => {
      if (!doc.contains(field) || doc.activeElement === field) return;
      try {
        field.focus({ preventScroll: true });
      } catch (_) {
        try { field.focus(); } catch (_) { /* ignore */ }
      }
    };
    dialog.lastField = field;
    focus();
    // Some page handlers blur the field after the event; re-focus afterwards.
    setTimeout(focus, 0);
    return true;
  }

  function focusDialogFieldAtPoint(event) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return false;
    const dialog = activeDialog;
    if (!dialog || dialog.destroyed || dialog.closing || !dialog.overlay) return false;
    const overlay = dialog.overlay;

    // Cheap path: a normal click already targets the field. Buttons, links,
    // selects and toggle labels are left completely alone.
    const target = event.target;
    if (target && typeof target.closest === 'function') {
      try {
        if (target.closest('button, a, select, label, [role="button"]')) return false;
        const direct = target.closest(FIELD_SELECTOR);
        if (direct && overlay.contains(direct) && !direct.disabled && !direct.readOnly) {
          return focusPointerField(event, direct, dialog);
        }
      } catch (_) { /* ignore */ }
    }

    if (!event.clientX && !event.clientY) return false;
    let field = null;
    try {
      field = (doc.elementsFromPoint(event.clientX, event.clientY) || []).find(
        (node) => node.matches?.(FIELD_SELECTOR)
          && !node.disabled && !node.readOnly
          && overlay.contains(node),
      ) || null;
    } catch (_) { /* ignore */ }
    if (!field) return false;
    return focusPointerField(event, field, dialog);
  }

  function dialogFallbackField(dialog) {
    if (!dialog) return null;
    if (dialog.lastField && dialog.overlay?.contains(dialog.lastField)) return dialog.lastField;
    return dialog.user ? dialog.amountInput : dialog.recipientInput;
  }

  // Coalesce focus-trap recovery. A hostile page can steal focus hundreds of
  // times per second; without this cap the guard would fight it in a loop.
  function refocusDialogField(dialog) {
    if (!dialog || dialog.destroyed || dialog.closing || !dialog.overlay) return;
    if (dialog._refocusTimer) return;
    dialog._refocusTimer = setTimeout(() => {
      dialog._refocusTimer = 0;
      if (dialog.destroyed || dialog.closing) return;
      const field = dialogFallbackField(dialog);
      if (field && doc.contains(field) && doc.activeElement !== field) {
        try { field.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
      }
    }, 0);
  }

  function onDialogFocusIn(event) {
    const dialog = activeDialog;
    if (!dialog || dialog.destroyed || dialog.closing || !dialog.overlay) return;
    if (dialog.success || dialog.formNode?.hidden) return;

    const target = event.target;
    if (dialog.overlay.contains(target)) {
      try {
        if (target.matches?.(FIELD_SELECTOR) && !target.disabled && !target.readOnly) {
          dialog.lastField = target;
        }
      } catch (_) { /* ignore */ }
      debug('focusin inside', target?.className || target?.tagName);
      // Do not let page focus traps react to focus moving inside the modal.
      event.stopImmediatePropagation();
      event.stopPropagation();
      return;
    }
    debug('focusin OUTSIDE', target?.className || target?.tagName, 'active=', doc.activeElement?.className);

    // Something outside the modal (native overlay, page script) stole focus.
    event.stopImmediatePropagation();
    event.stopPropagation();
    refocusDialogField(dialog);
  }

  function onDialogFocusOut(event) {
    const dialog = activeDialog;
    if (!dialog || dialog.destroyed || dialog.closing || !dialog.overlay) return;
    if (dialog.success || dialog.formNode?.hidden) return;
    if (!dialog.overlay.contains(event.target)) return;
    debug('focusout', event.target?.className || event.target?.tagName, 'active=', doc.activeElement?.className);
    event.stopImmediatePropagation();
    event.stopPropagation();

    clearTimeout(dialog._focusOutTimer);
    dialog._focusOutTimer = setTimeout(() => {
      dialog._focusOutTimer = 0;
      if (activeDialog !== dialog || dialog.destroyed || dialog.closing) return;
      if (doc.activeElement && dialog.overlay.contains(doc.activeElement)) return;
      refocusDialogField(dialog);
    }, 0);
  }

  // XenForo opens its native OverlayTrigger on pointerdown/mousedown as well
  // as click. Suppress those early (window capture, registered at
  // document-start) so its focus trap cannot steal focus from our inputs.
  function shieldTransfer(event) {
    if (!isLoggedIn()) return;
    if (!getTransferLink(event)) return;
    event.stopImmediatePropagation();
    event.stopPropagation();
  }

  function onDocumentClick(event) {
    const link = getTransferLink(event);
    if (!link) return;

    const parsed = parseTransferLink(link.href);
    if (!parsed) return;
    if (!isLoggedIn()) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();

    openTransfer({ ...parsed, trigger: link.anchor });
  }

  /* ------------------------------------------------------------------ */
  /* Styles                                                             */
  /* ------------------------------------------------------------------ */

  const CSS = `
.${OVERLAY_CLASS} {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, .64);
  --lzt-bg: var(--contentBackground, #111615);
  --lzt-surface: var(--primaryDarker, #181e1c);
  --lzt-surface-hover: var(--primaryDark, #1e2725);
  --lzt-card: var(--lzt-surface);
  --lzt-input: var(--lzt-surface);
  --lzt-accent: var(--primaryMedium, #00ba78);
  --lzt-accent-2: var(--primaryLighter, #228e5d);
  --lzt-focus: #2e614a;
  --lzt-border: rgba(255, 255, 255, .04);
  --lzt-border-strong: rgba(255, 255, 255, .14);
  --lzt-text: var(--contentText, #d6d6d6);
  --lzt-muted: var(--mutedTextColor, #8ca29a);
  opacity: 0;
  transition: opacity .2s ease;
  overflow-y: auto;
  font-family: inherit;
  font-size: 14px;
  line-height: 20px;
  color: var(--contentText, #d6d6d6);
}
.${OVERLAY_CLASS}, .${OVERLAY_CLASS} .lzt-tre-dialog { pointer-events: auto; }
.${OVERLAY_CLASS} input.textCtrl, .${OVERLAY_CLASS} textarea { -moz-user-focus: normal; }
.lzt-tre-debug {
  position: fixed;
  left: 8px;
  bottom: 8px;
  z-index: 2147483647;
  width: min(560px, 90vw);
  max-height: 220px;
  overflow: auto;
  margin: 0;
  padding: 8px 10px;
  border: 1px solid #2e614a;
  border-radius: 6px;
  background: rgba(0, 0, 0, .88);
  color: #7dffb0;
  font: 11px/1.35 ui-monospace, monospace;
  white-space: pre-wrap;
  user-select: text;
  pointer-events: auto;
}
.${OVERLAY_CLASS}.is-open { opacity: 1; }
.${OVERLAY_CLASS}.is-closing { opacity: 0; pointer-events: none; }
.${OVERLAY_CLASS}, .${OVERLAY_CLASS} * { box-sizing: border-box; }
.${OVERLAY_CLASS} [hidden] { display: none !important; }
.lzt-tre-dialog, .lzt-tre-dialog * {
  -webkit-user-select: text;
  user-select: text;
}
.lzt-tre-dialog button, .lzt-tre-dialog summary, .lzt-tre-seg, .lzt-tre-select-btn {
  -webkit-user-select: none;
  user-select: none;
}

.lzt-tre-dialog {
  position: relative;
  width: min(680px, 100%);
  max-height: min(90vh, 920px);
  margin: auto;
  display: flex;
  flex-direction: column;
  background: var(--lzt-bg);
  border: 1px solid var(--lzt-border);
  border-radius: 10px;
  overflow: hidden;
  outline: none;
}
.lzt-tre-head {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--lzt-surface);
  background: transparent;
  flex: 0 0 auto;
}
.lzt-tre-head-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: 0 0 20px;
  color: var(--lzt-muted, var(--mutedTextColor, #8ca29a));
  font-family: 'lztIcons', serif;
  font-size: 20px;
  font-style: normal;
  font-weight: normal;
  line-height: 1;
}
.lzt-tre-head-icon::before { content: "\\E039"; }
.lzt-tre-title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  line-height: 24px;
  color: var(--lzt-text);
  flex: 1 1 auto;
}
.lzt-tre-close {
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--lzt-border-strong);
  border-radius: 8px;
  background: var(--lzt-surface);
  color: var(--lzt-muted);
  cursor: pointer;
  transition: background-color .15s ease, color .15s ease, border-color .15s ease;
}
.lzt-tre-close:hover {
  background: var(--lzt-surface-hover);
  border-color: var(--lzt-border-strong);
  color: var(--lzt-text);
}
.lzt-tre-close:focus-visible { outline: 2px solid var(--lzt-accent-2); outline-offset: 2px; }

.lzt-tre-body {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--primary, #242f2b) transparent;
}
.lzt-tre-body::-webkit-scrollbar { width: 8px; }
.lzt-tre-body::-webkit-scrollbar-thumb { background: var(--primary, #242f2b); border-radius: 8px; }

.lzt-tre-field { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.lzt-tre-label, .lzt-tre-label-row {
  font-size: 14px;
  font-weight: 700;
  line-height: 20px;
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.lzt-tre-hint { color: var(--mutedTextColor, #8ca29a); font-size: 13px; line-height: 18px; }
.${OVERLAY_CLASS} .lzt-tre-telegram-hint { text-align: center; }

.lzt-tre-input,
.${OVERLAY_CLASS} input.textCtrl.lzt-tre-input {
  height: 36px;
  padding: 0 13px;
  border: 0;
  border-radius: 10px;
  background: var(--lzt-surface);
  color: var(--lzt-text);
  font: inherit;
  line-height: 36px;
  box-shadow: none;
}
.lzt-tre-input:focus,
.${OVERLAY_CLASS} input.textCtrl.lzt-tre-input:focus {
  outline: 2px solid var(--lzt-focus) !important;
  outline-offset: 0 !important;
}
.lzt-tre-input::placeholder { color: var(--lzt-muted); }

.lzt-tre-comment-wrap { position: relative; }
.${OVERLAY_CLASS} input.textCtrl.lzt-tre-comment-input { padding-right: 46px; }
.lzt-tre-counter {
  position: absolute;
  right: 13px;
  top: 0;
  height: 100%;
  display: flex;
  align-items: center;
  color: var(--mutedTextColor, #8ca29a);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}
.lzt-tre-counter.is-low { color: #ea4c4c; }
.lzt-tre-green { color: var(--lzt-accent); font-weight: 700; }
.lzt-tre-red { color: #ea4c4c; font-weight: 700; }

.lzt-tre-readonly {
  height: 38px;
  padding: 0 13px;
  overflow: hidden;
  background: var(--lzt-surface);
  border: 0;
  border-radius: 8px;
  color: var(--lzt-text);
  font-weight: 700;
  line-height: 38px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lzt-tre-recipient { position: relative; display: flex; flex-direction: column; gap: 8px; }
.lzt-tre-recipient-wrap { position: relative; }
.lzt-tre-userinput {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-height: 38px;
  padding: 4px 10px;
  background: var(--lzt-surface);
  border: 0;
  border-radius: 10px;
}
.lzt-tre-userinput:focus-within {
  outline: 2px solid var(--lzt-focus) !important;
  outline-offset: 0 !important;
}
.lzt-tre-userinput-input {
  flex: 1 1 120px;
  min-width: 100px;
  height: 30px;
  border: 0;
  background: transparent;
  color: var(--contentText, #d6d6d6);
  font: inherit;
  outline: none;
}
.lzt-tre-userinput-input::placeholder { color: var(--mutedTextColor, #8ca29a); }
.lzt-tre-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 100%;
  padding: 3px 6px 3px 4px;
  background: var(--lzt-surface-hover);
  border-radius: 8px;
}
.lzt-tre-chip-avatar { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; background: var(--primaryDarker, #181e1c); }
.lzt-tre-chip-name { font-weight: 600; line-height: 20px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lzt-tre-chip-name a { color: inherit; }
.lzt-tre-chip-remove {
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--mutedTextColor, #8ca29a);
  font-size: 17px;
  line-height: 1;
  cursor: pointer;
}
.lzt-tre-chip-remove:hover { background: rgba(255, 255, 255, .06); color: var(--contentText, #d6d6d6); }

.lzt-tre-recent { display: flex; flex-direction: column; gap: 7px; }
.lzt-tre-recent-title { color: var(--mutedTextColor, #8ca29a); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
.lzt-tre-recent-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
.lzt-tre-recent-card {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  padding: 7px 10px;
  background: var(--lzt-surface);
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--contentText, #d6d6d6);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color .15s ease, border-color .15s ease;
}
.lzt-tre-recent-card:hover { background: var(--lzt-surface-hover); border-color: var(--lzt-border-strong); }
.lzt-tre-recent-avatar { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; background: var(--primaryDark, #1e2725); }
.lzt-tre-recent-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }

.lzt-tre-amount-block { display: flex; flex-direction: column; gap: 8px; }
.lzt-tre-amount-row { display: flex; gap: 8px; align-items: stretch; }
.lzt-tre-amount { position: relative; flex: 1 1 auto; min-width: 0; }
.lzt-tre-amount-input { width: 100%; height: 36px; }
.${OVERLAY_CLASS} input.textCtrl.lzt-tre-amount-input { padding-right: 40px; }
.lzt-tre-amount-suffix {
  position: absolute;
  right: 13px;
  top: 0;
  height: 100%;
  display: flex;
  align-items: center;
  color: var(--lzt-muted);
  pointer-events: none;
  font-weight: 600;
}
.lzt-tre-currency { flex: 0 0 180px; min-width: 0; }
.lzt-tre-presets { display: flex; flex-wrap: wrap; gap: 6px; }
.lzt-tre-preset {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  background: var(--lzt-surface-hover);
  border: 1px solid var(--lzt-border);
  border-radius: 999px;
  color: var(--contentText, #d6d6d6);
  font: inherit;
  font-weight: 700;
  cursor: pointer;
  transition: background-color .15s ease, border-color .15s ease;
}
.lzt-tre-preset:hover { background: var(--primary, #242f2b); border-color: var(--lzt-border-strong); }
.lzt-tre-preset-symbol { color: var(--mutedTextColor, #8ca29a); font-weight: 500; }

.lzt-tre-option {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 8px 16px;
  background: var(--lzt-surface);
  border: 1px solid var(--lzt-border);
  border-radius: 10px;
  transition: border-color .18s ease, background-color .18s ease;
}
.lzt-tre-option.is-selected {
  border-color: rgba(255, 255, 255, .10);
  background: var(--lzt-surface);
}
/* Inner fields of cards are darker, like the modal background. */
.${OVERLAY_CLASS} .lzt-tre-option input.textCtrl.lzt-tre-input,
.${OVERLAY_CLASS} .lzt-tre-option .lzt-tre-select-btn {
  background: var(--lzt-bg);
  border: 1px solid var(--lzt-border);
}
.${OVERLAY_CLASS} .lzt-tre-option .lzt-tre-select-btn:hover {
  background: var(--lzt-bg);
  border-color: var(--lzt-border-strong);
}
.${OVERLAY_CLASS} .lzt-tre-option input.textCtrl.lzt-tre-input:focus,
.${OVERLAY_CLASS} .lzt-tre-option .lzt-tre-select-btn:focus {
  background: var(--lzt-bg);
}
.${OVERLAY_CLASS} input.textCtrl.lzt-tre-telegram-input {
  width: 100%;
  max-width: none;
}
.${OVERLAY_CLASS} .lzt-tre-hold-row { justify-content: flex-start; }
.${OVERLAY_CLASS} .lzt-tre-hold-row input.lzt-tre-hold-value {
  flex: 0 0 84px;
  width: 84px;
}
.${OVERLAY_CLASS} .lzt-tre-hold-row .lzt-tre-select {
  flex: 0 0 110px;
  width: 110px;
}
.lzt-tre-option-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.lzt-tre-option-label { font-weight: 600; line-height: 20px; }
.lzt-tre-sub {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding-top: 12px;
  border-top: 1px solid rgba(255, 255, 255, .06);
}

.lzt-tre-seg {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  flex: 0 0 120px;
  width: 120px;
  height: 38px;
  min-height: 38px;
  background: var(--lzt-surface);
  border: 1px solid var(--lzt-border-strong);
  border-radius: 10px;
  overflow: hidden;
}
.lzt-tre-seg-item {
  position: relative !important;
  display: block !important;
  min-width: 0;
  margin: 0 !important;
  padding: 0 !important;
  cursor: pointer;
}
.lzt-tre-seg-item + .lzt-tre-seg-item { border-left: 1px solid var(--lzt-surface-hover); }
.lzt-tre-seg .lzt-tre-seg-input,
.lzt-tre-seg .lzt-tre-seg-item > input.lzt-tre-seg-input {
  position: absolute !important;
  left: 0 !important;
  top: 0 !important;
  width: 1px !important;
  height: 1px !important;
  min-width: 0 !important;
  min-height: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  opacity: 0 !important;
  appearance: none !important;
  -webkit-appearance: none !important;
  pointer-events: none !important;
}
.lzt-tre-seg-content {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  min-height: 38px;
  padding: 0 12px;
  color: var(--lzt-muted);
  font-weight: 500;
  transition: background-color .16s ease, color .16s ease;
}
.lzt-tre-seg-item:hover .lzt-tre-seg-content {
  background: rgba(30, 39, 37, .56);
  color: var(--lzt-text);
}
.lzt-tre-seg-icon {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  width: 20px !important;
  height: 20px !important;
  flex: 0 0 20px !important;
  color: var(--lzt-muted);
  pointer-events: none;
}
.lzt-tre-seg-icon svg { display: block; width: 100%; height: 100%; }
.lzt-tre-seg-item:hover .lzt-tre-seg-icon { color: var(--lzt-text); }
.lzt-tre-seg-input:checked + .lzt-tre-seg-content {
  background: #192721;
  color: var(--lzt-accent-2);
}
.lzt-tre-seg-input:checked + .lzt-tre-seg-content .lzt-tre-seg-icon { color: var(--lzt-accent); }
.lzt-tre-seg-input:focus-visible + .lzt-tre-seg-content {
  outline: 2px solid var(--lzt-accent-2);
  outline-offset: -2px;
}
.lzt-tre-seg.is-disabled { opacity: .45; filter: grayscale(.35); }
.lzt-tre-seg.is-disabled .lzt-tre-seg-item { cursor: not-allowed; }

.lzt-tre-select { position: relative; min-width: 0; }
.lzt-tre-select-btn {
  width: 100%;
  height: 36px;
  display: flex;
  align-items: center;
  position: relative !important;
  padding: 0 34px 0 13px;
  background: var(--lzt-surface);
  border: 0;
  border-radius: 8px;
  color: var(--lzt-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  position: relative;
}
.lzt-tre-select-btn:hover { background: var(--lzt-surface-hover); }
.lzt-tre-select-btn:focus { outline: none; }
.lzt-tre-select-btn:focus-visible,
.lzt-tre-select.is-open .lzt-tre-select-btn {
  outline: 2px solid var(--lzt-focus) !important;
  outline-offset: 0 !important;
}
.lzt-tre-select-btn:disabled { opacity: .55; cursor: not-allowed; }
.lzt-tre-select-btn::after {
  content: "";
  position: absolute !important;
  right: 13px;
  top: 50%;
  width: 8px;
  height: 8px;
  border-right: 2px solid var(--lzt-muted);
  border-bottom: 2px solid var(--lzt-muted);
  transform: translateY(-70%) rotate(45deg);
  transition: transform .15s ease;
}
.lzt-tre-select.is-open .lzt-tre-select-btn::after { transform: translateY(-30%) rotate(-135deg); }
.lzt-tre-select-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lzt-tre-menu {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + 6px);
  z-index: 20;
  max-height: 230px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--lzt-surface-hover) transparent;
  padding: 6px;
  background: var(--lzt-bg);
  border: 1px solid var(--lzt-border-strong);
  border-radius: 10px;
}
.lzt-tre-menu::-webkit-scrollbar { width: 6px; }
.lzt-tre-menu::-webkit-scrollbar-track { background: transparent; }
.lzt-tre-menu::-webkit-scrollbar-thumb { background: var(--lzt-surface-hover); border-radius: 6px; }
.lzt-tre-menu::-webkit-scrollbar-thumb:hover { background: var(--primary, #242f2b); }
.lzt-tre-opt {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--lzt-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.lzt-tre-opt:hover, .lzt-tre-opt:focus-visible { background: var(--lzt-surface-hover); outline: none; }
.lzt-tre-opt[aria-selected="true"] { background: var(--lzt-surface-hover); color: var(--lzt-accent); }
.lzt-tre-opt-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lzt-tre-opt-hint { color: var(--mutedTextColor, #8ca29a); flex: 0 0 auto; }

.lzt-tre-sub-label { color: var(--mutedTextColor, #8ca29a); font-size: 13px; font-weight: 600; }
.lzt-tre-hold-row { display: flex; gap: 8px; }
.lzt-tre-hold-value { flex: 0 0 84px; width: 84px; }
.lzt-tre-hold-row .lzt-tre-select { flex: 1 1 auto; }
.lzt-tre-hold-row .lzt-tre-select-btn { height: 36px; }

.lzt-tre-notify {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 10px 12px;
  border-radius: 9px;
  font-size: 13px;
  line-height: 18px;
  color: var(--mutedTextColor, #8ca29a);
}
.lzt-tre-notify svg { flex: 0 0 18px; margin-top: 1px; }
.lzt-tre-notify.is-success {
  background: rgba(0, 186, 120, .09);
  border: 1px solid rgba(0, 186, 120, .18);
  color: #a9c9bc;
}
.lzt-tre-notify.is-success svg { color: #2ee0a2; }
.lzt-tre-notify-text { min-width: 0; }
.lzt-tre-notify .bold { color: var(--contentText, #d6d6d6); font-weight: 700; }
.lzt-tre-danger { color: #ea4c4c; font-weight: 700; }

.lzt-tre-suggest {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  z-index: 40;
  max-height: 250px;
  overflow-y: auto;
  padding: 5px;
  background: var(--lzt-bg);
  border: 1px solid rgba(255, 255, 255, .1);
  border-radius: 10px;
  box-shadow: none;
}
.lzt-tre-suggest-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 9px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--contentText, #d6d6d6);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.lzt-tre-suggest-item:hover, .lzt-tre-suggest-item.is-active {
  background: var(--lzt-surface-hover);
  color: var(--lzt-text);
}
.lzt-tre-suggest-avatar {
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  border-radius: 50%;
  object-fit: cover;
  background: var(--primaryDark, #1e2725);
}
.lzt-tre-suggest-avatar.is-empty {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  color: var(--primaryMedium, #00ba78);
}
.lzt-tre-suggest-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.lzt-tre-suggest-state {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  color: var(--mutedTextColor, #8ca29a);
  font-size: 13px;
}
.lzt-tre-suggest-state.is-error { color: #ea4c4c; }



.lzt-tre-summary {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 14px 16px;
  background: var(--lzt-surface);
  border: 0;
  border-radius: 10px;
}
.lzt-tre-sum-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; line-height: 20px; }
.lzt-tre-sum-label { color: var(--mutedTextColor, #8ca29a); }
.lzt-tre-sum-value { font-weight: 600; text-align: right; }
.lzt-tre-sum-divider { height: 1px; background: var(--lzt-surface-hover); }
.lzt-tre-sum-row.is-total .lzt-tre-sum-label { color: var(--contentText, #d6d6d6); font-weight: 700; }
.lzt-tre-sum-total { color: var(--primaryMedium, #00ba78); font-size: 16px; }
.lzt-tre-sum-total-wrap { display: flex; align-items: baseline; gap: 8px; }
.lzt-tre-sum-hint { color: var(--mutedTextColor, #8ca29a); font-size: 12px; }
.lzt-tre-sum-error { color: #ea4c4c; font-size: 12px; line-height: 17px; overflow-wrap: anywhere; }

.lzt-tre-foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 12px 16px;
  border-top: 1px solid var(--lzt-surface);
  background: var(--lzt-bg);
}
.lzt-tre-foot-total { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.lzt-tre-foot-label { color: var(--mutedTextColor, #8ca29a); font-size: 12px; line-height: 16px; }
.lzt-tre-foot-values { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.lzt-tre-foot-value { color: var(--primaryMedium, #00ba78); font-size: 18px; line-height: 22px; white-space: nowrap; }
.lzt-tre-foot-hint { color: var(--mutedTextColor, #8ca29a); font-size: 12px; white-space: nowrap; }
.lzt-tre-submit {
  flex: 0 0 auto;
  min-width: 160px;
  height: 36px;
  border-radius: 10px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  box-shadow: none;
}
.lzt-tre-submit:disabled { cursor: not-allowed; }
.lzt-tre-submit:not(:disabled):hover {
  filter: brightness(1.08);
}
.lzt-tre-submit.is-loading { pointer-events: none; opacity: .85; }

.lzt-tre-alert {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 10px 12px;
  background: rgba(234, 76, 76, .12);
  border: 1px solid rgba(234, 76, 76, .22);
  border-radius: 10px;
  color: #ea4c4c;
  font-size: 13px;
  line-height: 18px;
}
.lzt-tre-alert svg { flex: 0 0 18px; margin-top: 1px; }
.lzt-tre-alert-text { min-width: 0; overflow-wrap: anywhere; }
.lzt-tre-alert a { color: var(--lzt-accent); text-decoration: underline; font-weight: 600; }

.lzt-tre-loading { display: flex; align-items: center; gap: 10px; color: var(--mutedTextColor, #8ca29a); padding: 6px 2px; }
.lzt-tre-retry { display: flex; gap: 8px; flex-wrap: wrap; }
.lzt-tre-retry-btn { flex: 1 1 auto; min-width: 150px; height: 40px; display: inline-flex; align-items: center; justify-content: center; }
.lzt-tre-spinner, .lzt-tre-btn-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, .18);
  border-top-color: var(--primaryMedium, #00ba78);
  border-radius: 50%;
  animation: lzt-tre-spin .8s linear infinite;
  flex: 0 0 auto;
}
.lzt-tre-form { display: flex; flex-direction: column; gap: 14px; }

.lzt-tre-success {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 14px 4px 6px;
  text-align: center;
}
.lzt-tre-success-icon {
  width: 54px;
  height: 54px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(0, 186, 120, .12);
  color: var(--primaryMedium, #00ba78);
  margin-bottom: 2px;
}
.lzt-tre-success-title { margin: 0; font-size: 19px; line-height: 26px; font-weight: 700; }
.lzt-tre-success-message { margin: 0; color: var(--mutedTextColor, #8ca29a); }
.lzt-tre-success-details {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
  padding: 12px 14px;
  background: var(--primaryDarker, #181e1c);
  border-radius: 10px;
  text-align: left;
}
.lzt-tre-success-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.lzt-tre-success-label { color: var(--mutedTextColor, #8ca29a); }
.lzt-tre-success-value { font-weight: 600; text-align: right; overflow-wrap: anywhere; }
.lzt-tre-success-actions { display: flex; gap: 8px; width: 100%; margin-top: 10px; }
.lzt-tre-success-btn { flex: 1 1 0; height: 40px; display: inline-flex; align-items: center; justify-content: center; }
.lzt-tre-ghost { background: var(--primaryDarker, #181e1c); color: var(--contentText, #d6d6d6); border: 1px solid rgba(255, 255, 255, .08); }
.lzt-tre-ghost:hover { background: var(--primaryDark, #1e2725); }

@keyframes lzt-tre-spin { to { transform: rotate(360deg); } }

@media (max-width: 600px) {
  .${OVERLAY_CLASS} { padding: 0; }
  .lzt-tre-dialog {
    width: 100%;
    height: 100vh;
    height: 100dvh;
    max-height: 100dvh;
    border-radius: 0;
    border: 0;
  }
  .lzt-tre-body { padding: 14px; gap: 12px; }
  .lzt-tre-head { padding: 12px 14px; }
  .lzt-tre-foot { padding: 10px 14px calc(10px + env(safe-area-inset-bottom)); gap: 10px; }
  .lzt-tre-submit { min-width: 0; flex: 1 1 auto; }
  .lzt-tre-foot-values { flex-direction: column; gap: 0; }
  .lzt-tre-foot-hint { white-space: normal; }
  .lzt-tre-currency { flex-basis: 132px; }
  .lzt-tre-recent-grid { grid-template-columns: 1fr; }
  .lzt-tre-option-head { flex-wrap: wrap; }
  .lzt-tre-seg { flex: 0 0 120px; width: 120px; }
}

@media (prefers-reduced-motion: reduce) {
  .${OVERLAY_CLASS} { transition: none; }
  .lzt-tre-dialog { transition: none; }
  .lzt-tre-spinner, .lzt-tre-btn-spinner { animation-duration: 1.6s; }
}
`;

  function injectStyles() {
    // Replace an older copy of the stylesheet if one is already present
    // (e.g. an older userscript version still active in the browser).
    doc.getElementById(STYLE_ID)?.remove();
    const style = el('style', { id: STYLE_ID });
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                               */
  /* ------------------------------------------------------------------ */

  const register = () => {
    injectStyles();
    if (parseTransferLink(location.href)) openDirectTransfer();
  };

  // Register at document-start, before XenForo binds its OverlayTrigger.
  // Window capture runs before document capture and every bubble handler.
  for (const captureTarget of [pageWindow, doc]) {
    captureTarget.addEventListener('focusin', onDialogFocusIn, true);
    captureTarget.addEventListener('focusout', onDialogFocusOut, true);
    captureTarget.addEventListener('pointerdown', focusDialogFieldAtPoint, true);
    captureTarget.addEventListener('mousedown', focusDialogFieldAtPoint, true);
    captureTarget.addEventListener('click', focusDialogFieldAtPoint, true);
    captureTarget.addEventListener('click', onDocumentClick, true);
    captureTarget.addEventListener('pointerdown', shieldTransfer, true);
    captureTarget.addEventListener('mousedown', shieldTransfer, true);
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', register, { once: true });
  } else {
    register();
  }

  // Debug/automation hook. Kept intentionally small and immutable.
  const api = Object.freeze({
    version: VERSION,
    open(options = {}) {
      return openTransfer(options);
    },
    close() {
      activeDialog?.close();
    },
  });
  try {
    Object.defineProperty(pageWindow, 'lztTMR', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: api,
    });
  } catch (_) {
    // Another LztTMR version already owns pageWindow.lztTMR; still expose the
    // current one for debugging and automation.
    try { pageWindow.__lztTMR_LATEST__ = api; } catch (_) { /* ignore */ }
  }

  if (DEBUG) {
    console.debug(`[LztTMR] ${VERSION} ready`);
  }
})();
