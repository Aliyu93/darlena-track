/*!
 * darlena-track v0.2.3
 * First-party ad-click and visitor log for darlena.com, served from jsDelivr
 * (loaded through Salla custom code or GTM; no theme change).
 *
 * The page view is the core record. Every page view sends everything the server needs to match a
 * Salla order to this visitor on its own: the exact address the page was opened with, this visit's
 * landing address and the first-ever landing address (both saved once, never overwritten), referrer,
 * browser, OS version, device, the ad platforms' cookies, and the customer's hashed phone / email
 * whenever Salla shows them as logged in (including Salla's one-tap login). Nothing depends on a
 * login, cart or checkout step happening on our pages.
 *
 * Events, sent to our own collector (darlena.shop = IPv6 when the phone has it) plus a small copy with
 * the same event IDs to darlena.co (always IPv4), so the server records both addresses:
 *   pv             every page view (the first page of a visit carries land: 1 and the click path)
 *   ids            platform cookies that appear after the page view (Snap/Meta/TikTok pixels load later)
 *   identify       Salla customer appears on a page after its page view was sent
 *   add_to_cart    Salla cart event (extra signal only)
 *   checkout_start click on the cart's checkout button (extra signal only)
 *   purchase       thank-you page: the order number with the buyer's own browser at the moment of
 *                  purchase. Salla's server-side order sometimes has the payment company's server IP /
 *                  browser instead of the buyer's; this fills that gap. Salla's orders stay the truth.
 *
 * Multi-touch: every ad click or outside referral starts a new visit and is its own landing page view
 * on the server. The browser also keeps the last 20 clicks within 90 days and sends the whole list
 * ("tp") with each landing, identify, checkout_start and purchase.
 *
 * It never sends raw phone, email or names, blanks the values of personal or secret address keys
 * (token, phone, email, ...), never reads Salla's page.link/page.referrer (Salla's guest page cache
 * serves another visitor's values), and never throws into the page.
 * Config (optional, set before the script): window.DL_TRACK_CONFIG =
 *   {endpoint, endpointV4 (null = off), hosts: [...], dryRun: true, debug: true}
 */
(function (w, d) {
  'use strict';
  try {
    if (!w || !d || !w.location || (w.__dlTrack && w.__dlTrack.version)) return;
  } catch (e) { return; }

  var VERSION = '0.2.3';
  var cfg = w.DL_TRACK_CONFIG || {};
  var ENDPOINT = cfg.endpoint || 'https://darlena.shop/collectTouch';
  var ENDPOINT_V4 = cfg.endpointV4 === null ? null : (cfg.endpointV4 || 'https://darlena.co/collectTouch');
  var HOSTS = cfg.hosts || ['darlena.com', 'www.darlena.com'];
  var DRY_RUN = cfg.dryRun === true;
  var DEBUG = cfg.debug === true || /[?&]dl_debug=1(&|$)/.test(w.location.search || '');

  var SESSION_IDLE_MS = 30 * 60 * 1000;
  var FLUSH_DELAY_MS = 2000;
  var HINT_WAIT_MS = 250;
  var IDENTIFY_POLL_MS = 3000;
  var IDENTIFY_POLL_MAX_MS = 2 * 60 * 1000;
  var MAX_PARAMS = 40;
  var MAX_VALUE = 300;
  var URL_MAX = 2000;
  var COOKIE_DAYS = 400;
  var TOUCH_MAX = 20;
  var TOUCH_DAYS = 90;
  var TOUCH_RELOAD_MS = 30 * 60 * 1000;

  // Address-bar keys that mark an ad click or a campaign link.
  var AD_KEY = /^(utm_|adj_)|^(ad-?id|sccid|_sccid|ttclid|fbclid|gclid|gbraid|wbraid|dclid|msclkid|twclid|epik|li_fat_id|irclickid|ad_sku|promote_product|snapchat_ua)$/i;
  // Keys whose values are never logged (personal data or secrets); the key itself is kept.
  var DENY_KEY = /^(token|access_token|id_token|auth|authorization|code|otp|password|pass|pwd|data|email|e-?mail|phone|mobile|tel|name|first_?name|last_?name|address|national_?id|iban|card)$/i;
  // Cookies that identify the visitor to ad platforms (raw values; the server normalises them).
  var COOKIES = ['_scid', '_scclid', '_ttp', '_fbp', '_fbc', '_ga', '_gcl_aw', '_gcl_au', '_pin_unauth', '_epik'];

  var api = {
    version: VERSION, dryRun: DRY_RUN, sent: [], queue: [],
    flush: function () { flush(); },
    track: function (type, data) { safe(function () { enqueue(make(String(type).slice(0, 32), sanitizeCustom(data)), false); }); }
  };
  w.__dlTrack = api;

  function safe(fn) { try { return fn(); } catch (e) { if (DEBUG && w.console) console.warn('[dl-track]', e); } }
  function log() { if (DEBUG && w.console) console.log.apply(console, ['[dl-track]'].concat([].slice.call(arguments))); }
  function now() { return Date.now ? Date.now() : new Date().getTime(); }
  function trunc(v, n) { v = v == null ? '' : String(v); return v.length > n ? v.slice(0, n) : v; }

  var hostOk = false;
  safe(function () {
    var h = (w.location.hostname || '').toLowerCase();
    for (var i = 0; i < HOSTS.length; i++) if (h === HOSTS[i]) hostOk = true;
  });
  if (!hostOk) { log('host not allowed, idle'); return; }

  // ---------------------------------------------------------------- the address this page was opened with
  // The browser's own record of the navigation, before any script could rewrite the address bar.
  function originalUrl() {
    var u = null;
    safe(function () {
      var nav = w.performance && w.performance.getEntriesByType && w.performance.getEntriesByType('navigation')[0];
      if (nav && nav.name && /^https?:/i.test(nav.name)) u = nav.name;
    });
    return u || w.location.href;
  }
  function navType() {
    var t = null;
    safe(function () {
      var nav = w.performance.getEntriesByType('navigation')[0];
      if (nav && nav.type) t = nav.type;
    });
    return t;
  }
  // Keeps the whole address; only the values of personal / secret keys are blanked.
  function sanitizeUrl(url) {
    if (!url) return null;
    var s = String(url);
    var hashAt = s.indexOf('#');
    var hash = hashAt >= 0 ? s.slice(hashAt) : '';
    if (hashAt >= 0) s = s.slice(0, hashAt);
    var qAt = s.indexOf('?');
    if (qAt >= 0) {
      var base = s.slice(0, qAt), parts = s.slice(qAt + 1).split('&');
      for (var i = 0; i < parts.length; i++) {
        var eq = parts[i].indexOf('=');
        var k = eq < 0 ? parts[i] : parts[i].slice(0, eq);
        var key = k;
        try { key = decodeURIComponent(k.replace(/\+/g, ' ')); } catch (e) {}
        if (eq >= 0 && DENY_KEY.test(key)) parts[i] = k + '=x';
      }
      s = base + '?' + parts.join('&');
    }
    if (hash && /token|access|code|otp/i.test(hash)) hash = '#x';
    return trunc(s + hash, URL_MAX);
  }
  function searchOf(url) {
    var s = String(url || '');
    var h = s.indexOf('#');
    if (h >= 0) s = s.slice(0, h);
    var q = s.indexOf('?');
    return q >= 0 ? s.slice(q) : '';
  }
  function pathOf(url) {
    var m = /^https?:\/\/[^\/?#]+([^?#]*)/i.exec(String(url || ''));
    return m ? (m[1] || '/') : '';
  }

  // ---------------------------------------------------------------- storage
  function lsGet(k) { try { return w.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { w.localStorage.setItem(k, v); } catch (e) {} }
  function cookieGet(name) {
    try {
      var parts = ('; ' + d.cookie).split('; ' + name + '=');
      if (parts.length < 2) return null;
      return decodeURIComponent(parts.pop().split(';').shift());
    } catch (e) { return null; }
  }
  function cookieSet(name, value, days) {
    try {
      d.cookie = name + '=' + encodeURIComponent(value) + '; max-age=' + Math.round(days * 86400) +
        '; path=/; SameSite=Lax; Secure';
    } catch (e) {}
  }
  function uuid() {
    try { if (w.crypto && w.crypto.randomUUID) return w.crypto.randomUUID(); } catch (e) {}
    var s = '', i, r;
    var b = new Array(16);
    try { if (w.crypto && w.crypto.getRandomValues) { b = w.crypto.getRandomValues(new Uint8Array(16)); } } catch (e) { b = null; }
    for (i = 0; i < 16; i++) {
      r = b && b[i] != null ? b[i] : Math.floor(Math.random() * 256);
      if (i === 6) r = (r & 0x0f) | 0x40;
      if (i === 8) r = (r & 0x3f) | 0x80;
      s += (r < 16 ? '0' : '') + r.toString(16);
      if (i === 3 || i === 5 || i === 7 || i === 9) s += '-';
    }
    return s;
  }

  // ---------------------------------------------------------------- address keys
  function readParams(search) {
    var out = {}, n = 0, ad = false;
    var q = String(search || '').replace(/^\?/, '');
    if (!q) return {q: out, ad: false, n: 0};
    var pairs = q.split('&');
    for (var i = 0; i < pairs.length && n < MAX_PARAMS; i++) {
      if (!pairs[i]) continue;
      var eq = pairs[i].indexOf('=');
      var k = eq < 0 ? pairs[i] : pairs[i].slice(0, eq);
      var v = eq < 0 ? '' : pairs[i].slice(eq + 1);
      try { k = decodeURIComponent(k.replace(/\+/g, ' ')); } catch (e) {}
      try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) {}
      k = trunc(k, 64);
      if (!k || DENY_KEY.test(k)) continue;
      if (AD_KEY.test(k)) ad = true;
      if (!Object.prototype.hasOwnProperty.call(out, k)) n++;
      out[k] = trunc(v, MAX_VALUE);
    }
    return {q: out, ad: ad, n: n};
  }
  function adSignature(q) {
    var keys = [];
    for (var k in q) if (Object.prototype.hasOwnProperty.call(q, k) && AD_KEY.test(k)) keys.push(k + '=' + q[k]);
    return keys.sort().join('&').slice(0, 500);
  }
  function refHost(ref) { var m = /^https?:\/\/([^\/?#]+)/i.exec(ref || ''); return m ? m[1].toLowerCase() : ''; }
  function isOwnHost(h) { return !h || /(^|\.)darlena\.(com|shop|co)$/.test(h) || h === 'pay.darlena.com'; }
  function pickParam(q, names) {
    for (var k in q) {
      if (!Object.prototype.hasOwnProperty.call(q, k)) continue;
      for (var i = 0; i < names.length; i++) if (k.toLowerCase() === names[i]) return q[k];
    }
    return null;
  }

  // ---------------------------------------------------------------- touches (multi-touch path)
  // Which platform a touch came from (the server re-derives this; kept for a readable path).
  function touchSource(q, refHostName) {
    var adId = String(pickParam(q, ['ad-id', 'adid']) || '');
    var src = String(pickParam(q, ['utm_source']) || '').toLowerCase();
    if (pickParam(q, ['sccid', '_sccid']) || /^snapchat_/i.test(adId) || /snap/.test(src)) return 'snapchat';
    if (pickParam(q, ['ttclid']) || /^tiktok_/i.test(adId) || /tiktok/.test(src)) return 'tiktok';
    if (pickParam(q, ['fbclid']) || /^(meta|facebook|instagram)_/i.test(adId) || /facebook|instagram|meta|\bfb\b|\big\b/.test(src)) return 'meta';
    if (pickParam(q, ['gclid', 'gbraid', 'wbraid', 'dclid'])) return 'google';
    if (pickParam(q, ['epik']) || /pinterest/.test(src)) return 'pinterest';
    if (src) return src.slice(0, 30);
    if (refHostName) return 'ref:' + refHostName.slice(0, 60);
    return 'other';
  }
  // One touch: when, how (ad / referral), where from, the raw ad keys and the full landing address.
  function makeTouch(q, refHostName, ts, kind, url) {
    var t = {ts: ts, k: kind, s: touchSource(q, refHostName)};
    var fields = [['a', ['ad-id', 'adid']], ['us', ['utm_source']], ['um', ['utm_medium']], ['uc', ['utm_campaign']],
      ['ux', ['utm_content']], ['ut', ['utm_term']], ['ui', ['utm_id']], ['sc', ['sccid', '_sccid']], ['tt', ['ttclid']],
      ['fb', ['fbclid']], ['g', ['gclid', 'gbraid', 'wbraid', 'dclid']]];
    for (var i = 0; i < fields.length; i++) {
      var v = pickParam(q, fields[i][1]);
      if (v) t[fields[i][0]] = trunc(v, 120);
    }
    if (refHostName) t.h = refHostName.slice(0, 80);
    if (url) t.u = trunc(url, 1000);
    return t;
  }
  function readTouches(nowTs) {
    var list = [];
    try { list = JSON.parse(lsGet('dl_tp') || '[]') || []; } catch (e) { list = []; }
    var cutoff = nowTs - TOUCH_DAYS * 86400000, out = [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].ts >= cutoff) out.push(list[i]);
    return out.slice(-TOUCH_MAX);
  }
  function touchKey(t) { return [t.k, t.s, t.a, t.ux, t.uc, t.sc, t.tt, t.fb, t.g, t.h].join('|'); }
  function addTouch(t) {
    var list = readTouches(t.ts);
    var last = list[list.length - 1];
    // A reload or back-navigation of the same link is not a new touch.
    if (last && touchKey(last) === touchKey(t) && t.ts - last.ts < TOUCH_RELOAD_MS) return false;
    list.push(t);
    lsSet('dl_tp', JSON.stringify(list.slice(-TOUCH_MAX)));
    return true;
  }

  // ---------------------------------------------------------------- device
  function parseUa(ua) {
    ua = ua || '';
    var o = {os: null, osv: null, br: null, brv: null, app: null, appv: null, dev: null};
    var m;
    if ((m = /\b(iPhone|iPad|iPod)\b.*? OS (\d+[_.]\d+(?:[_.]\d+)?)/.exec(ua))) {
      o.os = 'iOS'; o.osv = m[2].replace(/_/g, '.'); o.dev = m[1];
      // iOS 26+ freezes "OS 18_6 / 18_7" in the user agent; the real version is in Version/26.x.
      var real = /Version\/(\d+(?:\.\d+){0,2})/.exec(ua);
      if (/^18\.[67]/.test(o.osv) && real && parseInt(real[1], 10) >= 26) { o.osf = o.osv; o.osv = real[1]; }
    }
    else if ((m = /Android (\d+(?:\.\d+)*)/.exec(ua))) { o.os = 'Android'; o.osv = m[1]; m = /Android [^;)]*;\s*([^;)]+?)(?:\sBuild|\))/.exec(ua); if (m) o.dev = trunc(m[1], 40); }
    else if ((m = /Mac OS X (\d+[_.]\d+(?:[_.]\d+)?)/.exec(ua))) { o.os = 'macOS'; o.osv = m[1].replace(/_/g, '.'); }
    else if ((m = /Windows NT (\d+\.\d+)/.exec(ua))) { o.os = 'Windows'; o.osv = m[1]; }
    else if (/CrOS/.test(ua)) { o.os = 'ChromeOS'; }
    else if (/Linux/.test(ua)) { o.os = 'Linux'; }
    // In-app browsers first (they also carry Safari/Chrome tokens).
    var apps = [['Snapchat', /Snapchat\/([\d.]+)/], ['TikTok', /(?:musical_ly|TikTok|BytedanceWebview)[\/_ ]?([\d.]+)?/i],
      ['Instagram', /Instagram ([\d.]+)/], ['Facebook', /FB(?:AN|AV)\/([\d.]+)?/], ['WhatsApp', /WhatsApp\/([\d.]+)/],
      ['Twitter', /Twitter(?:Android)?\/?([\d.]+)?/], ['Pinterest', /Pinterest\/?([\d.]+)?/], ['Darlena', /DARLENA\/([\d.]+)/]];
    for (var i = 0; i < apps.length; i++) {
      if ((m = apps[i][1].exec(ua))) { o.app = apps[i][0]; o.appv = m[1] || null; break; }
    }
    var brs = [['SamsungBrowser', /SamsungBrowser\/([\d.]+)/], ['Edge', /Edg(?:A|iOS)?\/([\d.]+)/], ['Opera', /OPR\/([\d.]+)/],
      ['Chrome', /(?:CriOS|Chrome)\/([\d.]+)/], ['Firefox', /(?:FxiOS|Firefox)\/([\d.]+)/], ['Safari', /Version\/([\d.]+).*Safari/]];
    for (i = 0; i < brs.length; i++) {
      if ((m = brs[i][1].exec(ua))) { o.br = brs[i][0]; o.brv = m[1]; break; }
    }
    if (!o.br && o.os === 'iOS') o.br = 'WebKit';
    return o;
  }
  var hints = null;
  var hintsPromise = null;
  function startHints() {
    safe(function () {
      var uad = w.navigator.userAgentData;
      if (!uad || !uad.getHighEntropyValues) return;
      hintsPromise = uad.getHighEntropyValues(['platformVersion', 'model', 'fullVersionList', 'architecture'])
        .then(function (h) {
          var list = [];
          (h.fullVersionList || []).forEach(function (b) { if (!/Not.?A.?Brand/i.test(b.brand)) list.push(b.brand + '/' + b.version); });
          hints = {mobile: !!h.mobile, platform: h.platform || null, platformVersion: h.platformVersion || null,
            model: h.model || null, arch: h.architecture || null, brands: list.slice(0, 4)};
        })['catch'](function () {});
    });
  }
  function device() {
    var o = {};
    safe(function () {
      var s = w.screen || {}, nav = w.navigator || {}, conn = nav.connection || {};
      o.sw = s.width; o.sh = s.height; o.dpr = w.devicePixelRatio || null;
      o.vw = w.innerWidth; o.vh = w.innerHeight;
      o.lang = nav.language || null;
      o.langs = (nav.languages || []).slice(0, 4).join(',') || null;
      try { o.tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) { o.tz = null; }
      o.tzo = new Date().getTimezoneOffset();
      o.touch = nav.maxTouchPoints != null ? nav.maxTouchPoints : null;
      o.conn = conn.effectiveType || null;
      o.save = conn.saveData === true ? 1 : 0;
      o.mem = nav.deviceMemory || null;
      o.cpu = nav.hardwareConcurrency || null;
      o.plat = nav.platform || null;
    });
    return o;
  }
  function platformIds() {
    var o = {}, any = false;
    for (var i = 0; i < COOKIES.length; i++) {
      var v = cookieGet(COOKIES[i]);
      if (v) { o[COOKIES[i]] = trunc(v, 300); any = true; }
    }
    return any ? o : null;
  }
  // Only the stable part of each cookie decides whether an "ids" update is needed
  // (_gcl_au carries a last-seen timestamp after its 4th part that changes on every page).
  function idsSignature(ids) {
    if (!ids) return '';
    var keys = [];
    for (var k in ids) {
      if (!Object.prototype.hasOwnProperty.call(ids, k)) continue;
      var v = k === '_gcl_au' ? String(ids[k]).split('.').slice(0, 4).join('.') : ids[k];
      keys.push(k + '=' + v);
    }
    return keys.sort().join('&');
  }

  // ---------------------------------------------------------------- Salla page + customer
  function dataLayerFind(test) {
    try {
      var dl = w.dataLayer || [];
      for (var i = dl.length - 1; i >= 0; i--) { var e = dl[i]; if (e && typeof e === 'object' && test(e)) return e; }
    } catch (e) {}
    return null;
  }
  function pageInfo() {
    var e = dataLayerFind(function (x) { return x.page && x.page.pageName; });
    return e ? {name: trunc(e.page.pageName, 64), app: e.page.mobileApp ? 1 : 0} : null;
  }
  function productIdFromPath(path) {
    var m = /\/p(\d{5,})(?:[\/?#]|$)/.exec(path || '');
    return m ? m[1] : null;
  }
  // A logged-in customer only. Salla also gives guests an id (a 32-character token, type 'guest').
  function sallaUser() {
    try {
      var u = w.salla && w.salla.config && w.salla.config.get && w.salla.config.get('user');
      if (u && u.id && u.type !== 'guest' && /^\d{1,15}$/.test(String(u.id))) return u;
    } catch (e) {}
    return null;
  }
  var ARABIC_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g;
  function westernDigits(s) {
    return String(s).replace(ARABIC_DIGITS, function (c) {
      var code = c.charCodeAt(0);
      return String(code >= 0x06F0 ? code - 0x06F0 : code - 0x0660);
    });
  }
  // Snap / Meta format: digits with country code, no "+", no leading 0 on the national part.
  function normalizePhone(mobile, countryCode) {
    if (mobile == null || mobile === '') return null;
    var s = westernDigits(mobile).replace(/[^\d+]/g, '');
    var hadPlus = s.charAt(0) === '+';
    s = s.replace(/\+/g, '');
    if (!hadPlus && s.indexOf('00') === 0) { s = s.slice(2); hadPlus = true; }
    var cc = String(countryCode || '').toUpperCase();
    if (!hadPlus) {
      if (/^05\d{8}$/.test(s) && (!cc || cc === 'SA')) s = '966' + s.slice(1);
      else if (/^5\d{8}$/.test(s) && (!cc || cc === 'SA')) s = '966' + s;
    } else if (/^9660\d{9}$/.test(s)) {
      s = '966' + s.slice(4);
    }
    return /^\d{8,15}$/.test(s) ? s : null;
  }
  function normalizeEmail(email) {
    if (!email) return null;
    var e = String(email).trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
  }

  // ---------------------------------------------------------------- SHA-256
  function utf8(str) { return unescape(encodeURIComponent(str)); }
  function sha256Fallback(ascii) {
    function rr(v, a) { return (v >>> a) | (v << (32 - a)); }
    var mp = Math.pow, maxWord = mp(2, 32), result = '', words = [], bitLen = ascii.length * 8;
    var hash = [], k = [], primeCounter = 0, isComposite = {}, i, j;
    for (var candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (i = 0; i < 313; i += candidate) isComposite[i] = candidate;
        hash[primeCounter] = (mp(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (mp(candidate, 1 / 3) * maxWord) | 0;
      }
    }
    hash = hash.slice(0, 8);
    ascii += '\x80';
    while (ascii.length % 64 - 56) ascii += '\x00';
    for (i = 0; i < ascii.length; i++) {
      j = ascii.charCodeAt(i);
      if (j >> 8) return null;
      words[i >> 2] |= j << ((3 - i) % 4) * 8;
    }
    words[words.length] = ((bitLen / maxWord) | 0);
    words[words.length] = bitLen;
    for (j = 0; j < words.length;) {
      var ww = words.slice(j, j += 16), oldHash = hash;
      hash = hash.slice(0, 8);
      for (i = 0; i < 64; i++) {
        var w15 = ww[i - 15], w2 = ww[i - 2], a = hash[0], e = hash[4];
        var t1 = hash[7] + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & hash[5]) ^ ((~e) & hash[6])) + k[i] +
          (ww[i] = (i < 16) ? ww[i] : (ww[i - 16] + (rr(w15, 7) ^ rr(w15, 18) ^ (w15 >>> 3)) + ww[i - 7] +
            (rr(w2, 17) ^ rr(w2, 19) ^ (w2 >>> 10))) | 0);
        var t2 = (rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(t1 + t2) | 0].concat(hash);
        hash[4] = (hash[4] + t1) | 0;
      }
      for (i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }
    for (i = 0; i < 8; i++) {
      for (j = 3; j + 1; j--) { var b = (hash[i] >> (j * 8)) & 255; result += ((b < 16) ? 0 : '') + b.toString(16); }
    }
    return result;
  }
  function sha256(str) {
    if (str == null) return Promise.resolve(null);
    try {
      if (w.crypto && w.crypto.subtle && w.TextEncoder) {
        return w.crypto.subtle.digest('SHA-256', new w.TextEncoder().encode(str)).then(function (buf) {
          var bytes = new Uint8Array(buf), hex = '';
          for (var i = 0; i < bytes.length; i++) hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
          return hex;
        })['catch'](function () { return sha256Fallback(utf8(str)); });
      }
    } catch (e) {}
    return Promise.resolve(sha256Fallback(utf8(str)));
  }
  // The logged-in customer as hashes (null when Salla shows nobody).
  function identity() {
    var u = sallaUser();
    if (!u) return Promise.resolve(null);
    var phone = normalizePhone(u.mobile, u.country_code);
    var email = normalizeEmail(u.email);
    return Promise.all([sha256(phone), sha256(email)]).then(function (h) {
      return {key: String(u.id), cid: String(u.id), ph: h[0], em: h[1], cc: u.country_code || null};
    })['catch'](function () { return {key: String(u.id), cid: String(u.id), ph: null, em: null, cc: u.country_code || null}; });
  }

  // ---------------------------------------------------------------- this page view
  var t0 = now();
  var url = sanitizeUrl(originalUrl());
  var curUrl = sanitizeUrl(w.location.href);
  var params = readParams(searchOf(originalUrl()));
  var path = pathOf(url) || trunc(w.location.pathname, 300);

  var vid = lsGet('dl_vid') || cookieGet('dl_vid');
  var vidNew = false;
  if (!vid || !/^[0-9a-f-]{36}$/i.test(vid)) { vid = uuid(); vidNew = true; lsSet('dl_vid_at', String(t0)); }
  lsSet('dl_vid', vid);
  cookieSet('dl_vid', vid, COOKIE_DAYS);
  api.vid = vid;

  // First-ever landing address of this browser: saved once, never overwritten.
  if (!lsGet('dl_furl')) { lsSet('dl_furl', url || ''); lsSet('dl_fat', String(t0)); }

  var ref = '';
  safe(function () { ref = d.referrer || ''; });
  var refH = refHost(ref);
  var outsideRef = !!refH && !isOwnHost(refH);
  var adSig = params.ad ? adSignature(params.q) : '';

  var sid = lsGet('dl_sid');
  var lastSeen = parseInt(lsGet('dl_sat') || '', 10);
  var reasons = [];
  if (!sid || !lastSeen || t0 - lastSeen > SESSION_IDLE_MS) reasons.push(sid ? 'idle' : 'new');
  if (adSig && adSig !== (lsGet('dl_sad') || '')) reasons.push('ad');
  if (outsideRef && reasons.length === 0 && refH !== (lsGet('dl_sref') || '')) reasons.push('ref');
  var newSession = reasons.length > 0;
  if (newSession) {
    sid = uuid();
    lsSet('dl_sid', sid);
    lsSet('dl_seq', '0');
    lsSet('dl_sad', adSig);
    lsSet('dl_sref', outsideRef ? refH : '');
    lsSet('dl_idsid', '');
    lsSet('dl_ckv', '');
    // This visit's landing address: saved once at the start of the visit, never overwritten.
    lsSet('dl_lurl', url || '');
    lsSet('dl_lat', String(t0));
  }
  lsSet('dl_sat', String(t0));
  api.sid = sid;

  function nextSeq() {
    var n = (parseInt(lsGet('dl_seq') || '0', 10) || 0) + 1;
    lsSet('dl_seq', String(n));
    return n;
  }
  function landingInfo() {
    return {lurl: lsGet('dl_lurl') || null, lat: parseInt(lsGet('dl_lat') || '', 10) || null,
      furl: lsGet('dl_furl') || null, fat: parseInt(lsGet('dl_fat') || '', 10) || null};
  }

  // ---------------------------------------------------------------- events + transport
  var ua = '';
  safe(function () { ua = w.navigator.userAgent || ''; });
  var uaInfo = parseUa(ua);

  function make(type, extra) {
    var u = sallaUser();
    var e = {t: type, id: uuid(), ts: now(), seq: nextSeq(), path: path, page: pageInfo(),
      cid: u ? String(u.id) : null};
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k];
    lsSet('dl_sat', String(e.ts));
    return e;
  }
  function sanitizeCustom(data) {
    var out = {};
    if (!data || typeof data !== 'object') return out;
    var n = 0;
    for (var k in data) {
      if (!Object.prototype.hasOwnProperty.call(data, k) || n >= 20 || DENY_KEY.test(k)) continue;
      var v = data[k];
      if (v == null || typeof v === 'number' || typeof v === 'boolean') out[trunc(k, 32)] = v;
      else out[trunc(k, 32)] = trunc(v, MAX_VALUE);
      n++;
    }
    return {data: out};
  }

  var flushTimer = null;
  var V4_TYPES = {pv: 1, identify: 1, checkout_start: 1, purchase: 1};
  function enqueue(evt, urgent) {
    api.queue.push(evt);
    log('queued', evt.t, evt);
    if (urgent) { flush(); return; }
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
  }
  function post(target, body) {
    if (DRY_RUN) return true;
    try { if (w.navigator.sendBeacon && w.navigator.sendBeacon(target, body)) return true; } catch (e) {}
    try {
      if (w.fetch) {
        w.fetch(target, {method: 'POST', body: body, keepalive: true, mode: 'no-cors', credentials: 'omit',
          headers: {'Content-Type': 'text/plain;charset=UTF-8'}})['catch'](function () {});
        return true;
      }
    } catch (e) {}
    try {
      var x = new XMLHttpRequest();
      x.open('POST', target, true);
      x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
      x.send(body);
      return true;
    } catch (e) {}
    return false;
  }
  function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!api.queue.length) return;
    var batch = api.queue.splice(0, api.queue.length);
    var body = JSON.stringify({v: VERSION, vid: vid, sid: sid, at: now(), ev: batch});
    var ok = post(ENDPOINT, body);
    var v4ids = [];
    for (var i = 0; i < batch.length; i++) if (V4_TYPES[batch[i].t]) v4ids.push(batch[i].id);
    var v4body = null;
    if (ENDPOINT_V4 && v4ids.length) {
      v4body = JSON.stringify({v: VERSION, vid: vid, sid: sid, at: now(), ip4: v4ids});
      post(ENDPOINT_V4, v4body);
    }
    if (DRY_RUN) {
      api.sent.push({to: ENDPOINT, body: JSON.parse(body), v4: v4body ? JSON.parse(v4body) : null});
      if (api.sent.length > 50) api.sent.shift();
    }
    log(ok ? 'sent' : 'send failed', batch.length, 'event(s)');
  }
  function waitHints(cb) {
    if (!hintsPromise || hints) { cb(); return; }
    var done = false;
    var finish = function () { if (!done) { done = true; cb(); } };
    hintsPromise.then(finish, finish);
    setTimeout(finish, HINT_WAIT_MS);
  }
  function withIdentity(extra, id) {
    if (id) { extra.cid = id.cid; extra.ph = id.ph; extra.em = id.em; extra.cc = id.cc; }
    return extra;
  }

  // ---------------------------------------------------------------- identify (customer appears after the page view)
  var identifying = false;
  var pvPending = true;
  var identifyAfterPv = null;
  function checkIdentity(trigger) {
    // The page view goes first and already carries the customer when Salla knows them at that point.
    if (pvPending) { identifyAfterPv = identifyAfterPv || trigger; return; }
    if (identifying) return;
    var u = sallaUser();
    if (!u) return;
    if (lsGet('dl_idsid') === String(u.id) + '|' + sid) return;
    identifying = true;
    identity().then(function (id) {
      if (!id) return;
      lsSet('dl_idsid', id.key + '|' + sid);
      var li = landingInfo();
      enqueue(make('identify', withIdentity({via: trigger, lurl: li.lurl, ids: platformIds(), ua: ua,
        tp: readTouches(now())}, id)), true);
    })['catch'](function () {}).then(function () { identifying = false; });
  }

  // ---------------------------------------------------------------- thank-you page (buyer's own browser at purchase)
  function readOrderFromPage() {
    var oref = null, oid = null, value = null, currency = null;
    safe(function () {
      var el = d.querySelector('[data-testid="store-thankyou-order-id"]');
      if (el) oref = el.getAttribute('data-content') || (el.textContent || '').replace(/[^\d]/g, '') || null;
      var idEl = d.querySelector('[data-experiment-order-id]');
      if (idEl) oid = idEl.getAttribute('data-experiment-order-id') || null;
    });
    var e = dataLayerFind(function (x) {
      var ec = x.ecommerce;
      return ec && (ec.transaction_id || (ec.purchase && ec.purchase.actionField));
    });
    if (e) {
      var ec = e.ecommerce;
      var tid = ec.transaction_id || (ec.purchase && ec.purchase.actionField && ec.purchase.actionField.id);
      if (!oref && tid) oref = String(tid);
      value = ec.value != null ? ec.value : (ec.purchase && ec.purchase.actionField && ec.purchase.actionField.revenue);
      currency = ec.currency || null;
    }
    oref = oref ? trunc(String(oref).replace(/[^\d]/g, ''), 20) : null;
    oid = oid ? trunc(String(oid).replace(/[^\d]/g, ''), 20) : null;
    return oref || oid ? {ref: oref, oid: oid, value: value != null ? Number(value) || null : null, cur: currency} : null;
  }
  function watchThankYou() {
    if (!/\/thank-?you/i.test(path)) return;
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      var o = readOrderFromPage();
      if (o || tries >= 30) clearInterval(timer);
      if (!o) return;
      var key = o.ref || o.oid;
      var seen = [];
      try { seen = JSON.parse(lsGet('dl_po') || '[]') || []; } catch (e) { seen = []; }
      if (seen.indexOf(key) !== -1) return;
      seen.push(key);
      lsSet('dl_po', JSON.stringify(seen.slice(-30)));
      sendPurchase('thankyou', o);
    }, 500);
  }
  // Full browser snapshot with the order and the customer, so it never depends on event order.
  function sendPurchase(via, order) {
    waitHints(function () {
      identity().then(function (id) {
        var li = landingInfo();
        enqueue(make('purchase', withIdentity({via: via, order: order, url: url, ref: ref ? sanitizeUrl(ref) : null,
          lurl: li.lurl, lat: li.lat, furl: li.furl, ua: ua, uai: uaInfo, uah: hints, dev: device(), ids: platformIds(),
          tp: readTouches(now())}, id)), true);
      })['catch'](function () {});
    });
  }

  // ---------------------------------------------------------------- Salla events (extra signals)
  function hookSalla() {
    var s = w.salla;
    if (!s || !s.event) return false;
    safe(function () {
      var auth = s.event.auth;
      if (auth) {
        ['onLoggedIn', 'onVerified', 'onRegistered'].forEach(function (fn) {
          if (typeof auth[fn] === 'function') auth[fn](function () { setTimeout(function () { checkIdentity(fn); }, 300); });
        });
      }
      var prof = s.event.profile;
      if (prof && typeof prof.onUpdated === 'function') prof.onUpdated(function () { lsSet('dl_idsid', ''); checkIdentity('profile'); });
      var cart = s.event.cart;
      if (cart && typeof cart.onItemAdded === 'function') {
        cart.onItemAdded(function (res, productId) {
          safe(function () {
            var data = res && res.data;
            var c = data && data.cart;
            enqueue(make('add_to_cart', {pid: productId != null ? String(productId) : null,
              total: c && c.total != null ? Number(c.total) || null : null,
              items: c && c.count != null ? c.count : null}), false);
          });
        });
      }
      var order = s.event.order;
      if (order && typeof order.onOrderCreated === 'function') {
        order.onOrderCreated(function (res) {
          safe(function () {
            var o = res && res.data;
            if (o && (o.reference_id || o.id)) sendPurchase('salla_event', {ref: trunc(String(o.reference_id || ''), 20) || null,
              oid: o.id != null ? trunc(String(o.id), 20) : null, value: null, cur: null});
          });
        });
      }
    });
    return true;
  }
  function onCheckoutClick(ev) {
    safe(function () {
      if (!/^\/cart\/?$/i.test(w.location.pathname)) return;
      var el = ev.target, depth = 0;
      while (el && depth < 6) {
        var tag = (el.tagName || '').toLowerCase();
        if (tag === 'button' || tag === 'salla-button' || tag === 'a') {
          var text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          var href = el.getAttribute && (el.getAttribute('href') || '');
          if (/\u0625\u062A\u0645\u0627\u0645 \u0627\u0644\u0637\u0644\u0628|\u0627\u062A\u0645\u0627\u0645 \u0627\u0644\u0637\u0644\u0628|checkout|complete order/i.test(text) || /checkout/i.test(href)) {
            if (lsGet('dl_cks') === sid) return;
            lsSet('dl_cks', sid);
            checkIdentity('checkout');
            enqueue(make('checkout_start', {lurl: landingInfo().lurl, ids: platformIds(), tp: readTouches(now())}), true);
            return;
          }
        }
        el = el.parentNode; depth++;
      }
    });
  }

  // ---------------------------------------------------------------- start: the page view
  startHints();
  var touch = null, touchNew = false;
  if (params.ad || outsideRef) {
    safe(function () {
      touch = makeTouch(params.q, outsideRef ? refH : '', t0, params.ad ? 'ad' : 'ref', url);
      touchNew = addTouch(touch);
    });
  }
  waitHints(function () {
    identity().then(function (id) {
      var ids = platformIds();
      lsSet('dl_ckv', idsSignature(ids));
      var li = landingInfo();
      var pv = {
        land: newSession ? 1 : 0,
        why: newSession ? reasons : null,
        url: url,
        cur: curUrl !== url ? curUrl : null,
        nav: navType(),
        lurl: li.lurl, lat: li.lat, furl: li.furl, fat: li.fat,
        ref: ref ? sanitizeUrl(ref) : null,
        q: params.n ? params.q : null,
        pid: productIdFromPath(path),
        touch: touch, tnew: touchNew ? 1 : 0, tpn: readTouches(now()).length,
        ua: ua, uai: uaInfo, uah: hints, dev: device(), ids: ids,
        fv: vidNew ? 1 : 0,
        ms: safe(function () { return Math.round(w.performance.now()); }) || null
      };
      if (newSession || touchNew) pv.tp = readTouches(now());
      if (id) lsSet('dl_idsid', id.key + '|' + sid);
      enqueue(make('pv', withIdentity(pv, id)), true);
      pvPending = false;
      if (identifyAfterPv) checkIdentity(identifyAfterPv);
    })['catch'](function () { pvPending = false; });
  });

  // Platform pixels set their cookies after us; send them once they appear.
  setTimeout(function () {
    safe(function () {
      var ids = platformIds();
      var sig = idsSignature(ids);
      if (sig && sig !== (lsGet('dl_ckv') || '')) {
        lsSet('dl_ckv', sig);
        enqueue(make('ids', {ids: ids}), false);
      }
    });
  }, 6000);

  var hooked = false;
  var identifyStarted = now();
  var identifyTimer = setInterval(function () {
    safe(function () {
      if (!hooked) hooked = hookSalla();
      checkIdentity('poll');
      if (now() - identifyStarted > IDENTIFY_POLL_MAX_MS) clearInterval(identifyTimer);
    });
  }, IDENTIFY_POLL_MS);
  safe(function () {
    if (w.salla && typeof w.salla.onReady === 'function') {
      w.salla.onReady(function () { if (!hooked) hooked = hookSalla(); checkIdentity('ready'); });
    }
  });
  safe(function () {
    d.addEventListener('click', onCheckoutClick, true);
    d.addEventListener('visibilitychange', function () {
      if (d.visibilityState === 'hidden') flush(); else checkIdentity('visible');
    });
    w.addEventListener('pagehide', flush);
  });
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', watchThankYou); else watchThankYou();

  api.h = {readParams: readParams, parseUa: parseUa, normalizePhone: normalizePhone, normalizeEmail: normalizeEmail,
    sanitizeUrl: sanitizeUrl, sha256: sha256, sha256Fallback: function (s) { return sha256Fallback(utf8(s)); },
    readOrderFromPage: readOrderFromPage};
  log('ready', {vid: vid, sid: sid, newSession: newSession, reasons: reasons, ad: params.ad});
})(typeof window !== 'undefined' ? window : null, typeof document !== 'undefined' ? document : null);
