'use strict';
// Runs dl-track.js inside a fake browser (node:vm). No network: dryRun records what would be sent.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'dl-track.js'), 'utf8');
const IPHONE_SNAP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Snapchat/13.9.0.40 (like Safari/8618.2.12.10.4, panda)';

function memoryStorage(seed) {
  const m = new Map(Object.entries(seed || {}));
  return {
    getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k), get length() { return m.size; }, key: i => [...m.keys()][i], _m: m,
  };
}
function unrefTimers() {
  return {
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; },
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref(); return t; },
    clearTimeout, clearInterval,
  };
}
function makeEnv(opts = {}) {
  const url = new URL(opts.url || 'https://darlena.com/');
  const storage = opts.storage || memoryStorage();
  let cookieJar = opts.cookies || '';
  const elements = opts.elements || {};
  const document = {
    readyState: 'complete', referrer: opts.referrer || '', visibilityState: 'visible',
    get cookie() { return cookieJar; },
    set cookie(v) { const kv = v.split(';')[0]; const name = kv.split('=')[0]; cookieJar = cookieJar.split('; ').filter(c => c && !c.startsWith(name + '=')).concat(kv).join('; '); },
    querySelector: sel => elements[sel] || null,
    addEventListener() {},
  };
  const performance = {now: () => 612.4};
  if (opts.navEntry) performance.getEntriesByType = type => (type === 'navigation' ? [opts.navEntry] : []);
  const user = opts.user || null;
  const salla = opts.userRef ? {config: {get: k => (k === 'user' ? opts.userRef.u : null)}, event: {}} : undefined;
  const window = {
    location: {href: url.href, protocol: url.protocol, host: url.host, hostname: url.hostname, pathname: url.pathname, search: url.search},
    localStorage: storage, sessionStorage: opts.session || memoryStorage(), navigator: {userAgent: opts.ua || IPHONE_SNAP, language: 'ar-SA', languages: ['ar-SA', 'en'], maxTouchPoints: 5, platform: 'iPhone'},
    screen: {width: 393, height: 852}, devicePixelRatio: 3, innerWidth: 393, innerHeight: 700,
    crypto: crypto.webcrypto, TextEncoder, performance,
    dataLayer: opts.dataLayer || [], DL_TRACK_CONFIG: Object.assign({dryRun: true}, opts.config || {}),
    salla: opts.salla || (user ? {config: {get: k => (k === 'user' ? user : null)}, event: {}, onReady: fn => fn()} : salla),
    addEventListener() {}, console,
  };
  const ctx = vm.createContext(Object.assign({window, document, Promise, JSON, Date, Math, Intl, URL, Uint8Array,
    unescape, encodeURIComponent, decodeURIComponent, String, Number, Array, Object, RegExp, parseInt, console}, unrefTimers()));
  vm.runInContext(SRC, ctx);
  return {window, document, api: window.__dlTrack, storage};
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const evsOf = api => api.sent.flatMap(s => s.body.ev).concat(Array.from(api.queue));
const types = api => JSON.stringify(evsOf(api).map(e => e.t));
const USER = {id: 123456, mobile: '+966512345678', country_code: 'SA', email: ' Test@Example.com ', first_name: 'Noura'};

test('phone normalisation matches Snap format', () => {
  const n = makeEnv().api.h.normalizePhone;
  assert.strictEqual(n('+966512345678', 'SA'), '966512345678');
  assert.strictEqual(n('0512345678', 'SA'), '966512345678');
  assert.strictEqual(n('512345678', 'SA'), '966512345678');
  assert.strictEqual(n('00966512345678'), '966512345678');
  assert.strictEqual(n('+9660512345678'), '966512345678');
  assert.strictEqual(n('٠٥١٢٣٤٥٦٧٨', 'SA'), '966512345678');
  assert.strictEqual(n('+971501234567', 'AE'), '971501234567');
  assert.strictEqual(n('abc'), null);
  assert.strictEqual(n(null), null);
});

test('fallback SHA-256 equals real SHA-256', async () => {
  const {api} = makeEnv();
  for (const s of ['966512345678', 'test@example.com', 'نورة@example.com', '', 'a'.repeat(200)]) {
    assert.strictEqual(api.h.sha256Fallback(s), sha(s), s);
    assert.strictEqual(await api.h.sha256(s), sha(s), s);
  }
});

test('address keys: ad tags kept, personal keys dropped from the parsed list', () => {
  const r = makeEnv().api.h.readParams('?Ad-ID=Snapchat_abc&utm_source=snapchat&utm_content=ad1%3FScCid%3Dx&phone=0555&token=t&page=2');
  assert.strictEqual(r.ad, true);
  assert.deepStrictEqual(Object.keys(r.q).sort(), ['Ad-ID', 'page', 'utm_content', 'utm_source']);
  assert.strictEqual(r.q.utm_content, 'ad1?ScCid=x');
});

test('full address kept; only personal / secret values blanked', () => {
  const s = makeEnv().api.h.sanitizeUrl;
  assert.strictEqual(s('https://darlena.com/x/c1?utm_source=a&phone=0555&token=abc&x=1&Ad-ID=Snapchat_9#otp=1'),
    'https://darlena.com/x/c1?utm_source=a&phone=x&token=x&x=1&Ad-ID=Snapchat_9#x');
  assert.strictEqual(s('https://darlena.com/?ScCid=abc-123'), 'https://darlena.com/?ScCid=abc-123');
});

test('browser parsing', () => {
  const p = makeEnv().api.h.parseUa;
  const snap = p(IPHONE_SNAP);
  assert.strictEqual(JSON.stringify([snap.os, snap.osv, snap.app, snap.appv]), JSON.stringify(['iOS', '17.5.1', 'Snapchat', '13.9.0.40']));
  const and = p('Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.6668.81 Mobile Safari/537.36');
  assert.strictEqual(JSON.stringify([and.os, and.osv, and.dev, and.br]), JSON.stringify(['Android', '14', 'SM-S918B', 'Chrome']));
  assert.strictEqual(p('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.21.106').app, 'Instagram');
});

test('idle on other hosts', () => {
  assert.strictEqual(makeEnv({url: 'https://darlena-checkout.pages.dev/'}).api.vid, undefined);
});

test('ad landing: one full page view with the exact address, both IP copies, nothing raw', async () => {
  const href = 'https://darlena.com/x/c1?Ad-ID=Snapchat_ad9&utm_source=snapchat&utm_content=ad9&ScCid=11111111-2222-3333-4444-555555555555';
  const {api} = makeEnv({url: href, referrer: 'https://snapchat.com/', cookies: '_scid=abc; _fbp=fb.1.2.3'});
  await wait(400);
  assert.strictEqual(types(api), JSON.stringify(['pv']));
  const pv = evsOf(api)[0];
  assert.strictEqual(pv.land, 1);
  assert.strictEqual(pv.url, href);
  assert.strictEqual(pv.lurl, href);
  assert.strictEqual(pv.furl, href);
  assert.strictEqual(pv.q.utm_content, 'ad9');
  assert.strictEqual(pv.ids._scid, 'abc');
  assert.strictEqual(pv.uai.app, 'Snapchat');
  assert.ok(pv.ua && pv.dev, 'browser and device');
  assert.strictEqual(pv.touch.u, href);
  assert.strictEqual(JSON.stringify(api.sent[0].v4.ip4), JSON.stringify([pv.id]));
});

test('landing address is saved once per visit and the first-ever one never changes', async () => {
  const storage = memoryStorage();
  const first = 'https://darlena.com/?utm_source=snapchat&utm_content=adA';
  const a = makeEnv({url: first, storage});
  await wait(400);
  const b = makeEnv({url: 'https://darlena.com/abaya/p1749301787', storage, referrer: 'https://darlena.com/'});
  await wait(400);
  const pvB = evsOf(b.api)[0];
  assert.strictEqual(b.api.sid, a.api.sid);
  assert.strictEqual(pvB.land, 0);
  assert.strictEqual(pvB.url, 'https://darlena.com/abaya/p1749301787');
  assert.strictEqual(pvB.lurl, first, 'visit landing unchanged on later pages');
  assert.strictEqual(pvB.pid, '1749301787');
  assert.ok(pvB.ua && pvB.dev && 'ids' in pvB, 'every page view is a full record');
  assert.ok(b.api.sent[0].v4, 'IPv4 copy on every page view');
  const second = 'https://darlena.com/?utm_source=tiktok&ttclid=t9';
  const c = makeEnv({url: second, storage});
  await wait(400);
  const pvC = evsOf(c.api)[0];
  assert.notStrictEqual(c.api.sid, a.api.sid);
  assert.strictEqual(pvC.lurl, second, 'new visit, new landing');
  assert.strictEqual(pvC.furl, first, 'first-ever landing never overwritten');
});

test('the address the page was opened with wins over a rewritten address bar', async () => {
  const opened = 'https://darlena.com/c5?utm_source=snapchat&utm_content=adZ&ScCid=c-1';
  const {api} = makeEnv({url: 'https://darlena.com/c5', navEntry: {name: opened, type: 'navigate'}});
  await wait(400);
  const pv = evsOf(api)[0];
  assert.strictEqual(pv.url, opened);
  assert.strictEqual(pv.cur, 'https://darlena.com/c5');
  assert.strictEqual(pv.q.utm_content, 'adZ');
  assert.strictEqual(pv.nav, 'navigate');
  assert.strictEqual(pv.touch.sc, 'c-1');
});

test('customer already logged in (one-tap, or returning with a cart): every page view carries the hashed customer', async () => {
  const storage = memoryStorage();
  const a = makeEnv({url: 'https://darlena.com/', user: USER, storage});
  await wait(400);
  const b = makeEnv({url: 'https://darlena.com/cart', user: USER, storage, referrer: 'https://darlena.com/'});
  await wait(3400);
  for (const env of [a, b]) {
    const pv = evsOf(env.api).find(e => e.t === 'pv');
    assert.strictEqual(pv.cid, '123456');
    assert.strictEqual(pv.ph, sha('966512345678'));
    assert.strictEqual(pv.em, sha('test@example.com'));
    assert.ok(!evsOf(env.api).some(e => e.t === 'identify'), 'no separate login event needed');
    const text = JSON.stringify(env.api.sent);
    assert.ok(!text.includes('512345678"') && !text.includes('Example.com') && !text.includes('Noura'), 'nothing raw');
  }
});

test('customer appears after the page view (one-tap login on the page): identify follows the page view', async () => {
  const userRef = {u: null};
  const {api} = makeEnv({url: 'https://darlena.com/?utm_source=snapchat&utm_content=adL', userRef});
  await wait(400);
  userRef.u = USER;
  await wait(3300);
  assert.strictEqual(types(api), JSON.stringify(['pv', 'identify']));
  const [pv, id] = evsOf(api);
  assert.strictEqual(pv.cid, null);
  assert.strictEqual(id.ph, sha('966512345678'));
  assert.strictEqual(id.lurl, 'https://darlena.com/?utm_source=snapchat&utm_content=adL');
  assert.ok(pv.seq < id.seq);
});

test('thank-you page: purchase with order number and full browser snapshot, once per order', async () => {
  const el = {getAttribute: a => (a === 'data-content' ? '293161122' : null), textContent: '#293161122'};
  const idEl = {getAttribute: a => (a === 'data-experiment-order-id' ? '1234567890' : null)};
  const elements = {'[data-testid="store-thankyou-order-id"]': el, '[data-experiment-order-id]': idEl};
  const storage = memoryStorage();
  const env = makeEnv({url: 'https://darlena.com/thankyou/abc', elements, storage, user: {id: 9, mobile: '+966512345678', country_code: 'SA'}});
  await wait(1200);
  const p = evsOf(env.api).find(e => e.t === 'purchase');
  assert.ok(p, 'purchase sent');
  assert.strictEqual(JSON.stringify([p.order.ref, p.order.oid]), JSON.stringify(['293161122', '1234567890']));
  assert.strictEqual(p.ph, sha('966512345678'));
  assert.ok(p.ua && p.dev && p.uai && p.lurl, 'browser snapshot and landing');
  assert.ok(env.api.sent.some(s => s.v4 && s.v4.ip4.includes(p.id)), 'IPv4 copy for the purchase');
  const again = makeEnv({url: 'https://darlena.com/thankyou/abc', elements, storage});
  await wait(1200);
  assert.ok(!evsOf(again.api).some(e => e.t === 'purchase'), 'reopened link does not resend');
});

test('cookie updates: a new Snap cookie is sent once; the _gcl_au timestamp tail alone is not', async () => {
  const storage = memoryStorage();
  makeEnv({url: 'https://darlena.com/?utm_source=snapchat&utm_content=adD', storage, cookies: '_gcl_au=1.1.111.222.-.-.333.444.555'});
  await wait(400);
  const sameTail = makeEnv({url: 'https://darlena.com/p1', storage, cookies: '_gcl_au=1.1.111.222.-.-.999.888.777', referrer: 'https://darlena.com/'});
  await wait(6400);
  assert.ok(!evsOf(sameTail.api).some(e => e.t === 'ids'), 'no update for the timestamp tail');
  const newSnap = makeEnv({url: 'https://darlena.com/p2', storage, cookies: '_gcl_au=1.1.111.222.-.-.999.888.777', referrer: 'https://darlena.com/'});
  await wait(300);
  newSnap.document.cookie = '_scid=newcookie'; // the Snap pixel sets its cookie after our page view
  await wait(6400);
  const ids = evsOf(newSnap.api).filter(e => e.t === 'ids');
  assert.strictEqual(ids.length, 1);
  assert.strictEqual(ids[0].ids._scid, 'newcookie');
});

test('multi-touch: every click and referral kept in order with full landing addresses', async () => {
  const storage = memoryStorage();
  const snapUrl = 'https://darlena.com/?Ad-ID=Snapchat_A1&utm_source=snapchat&utm_content=A1&ScCid=c1';
  makeEnv({url: snapUrl, storage});
  await wait(400);
  makeEnv({url: 'https://darlena.com/p1?ttclid=t1&utm_source=tiktok', storage});
  await wait(400);
  const reload = makeEnv({url: 'https://darlena.com/p1?ttclid=t1&utm_source=tiktok', storage});
  await wait(400);
  const pvReload = evsOf(reload.api)[0];
  assert.strictEqual(pvReload.tpn, 2, 'reload is not a new touch');
  assert.strictEqual(pvReload.tnew, 0);
  makeEnv({url: 'https://darlena.com/c5', storage, referrer: 'https://www.google.com/'});
  await wait(400);
  const el = {getAttribute: a => (a === 'data-content' ? '293000001' : null), textContent: ''};
  const buy = makeEnv({url: 'https://darlena.com/thankyou/x', storage, user: {id: 55, mobile: '+966512345678', country_code: 'SA'},
    referrer: 'https://darlena.com/checkout', elements: {'[data-testid="store-thankyou-order-id"]': el}});
  await wait(1200);
  const p = evsOf(buy.api).find(e => e.t === 'purchase');
  assert.strictEqual(JSON.stringify(p.tp.map(x => x.s)), JSON.stringify(['snapchat', 'tiktok', 'ref:www.google.com']));
  assert.strictEqual(p.tp[0].u, snapUrl);
  assert.strictEqual(p.tp[0].sc, 'c1');
  assert.strictEqual(p.tp[1].tt, 't1');
  assert.ok(p.tp[0].ts < p.tp[1].ts && p.tp[1].ts < p.tp[2].ts, 'in click order');
});

test('touch list keeps 20 within 90 days', async () => {
  const storage = memoryStorage();
  const old = [{ts: Date.now() - 91 * 86400000, k: 'ad', s: 'snapchat', a: 'Snapchat_old'}];
  for (let i = 0; i < 25; i++) old.push({ts: Date.now() - (30 - i) * 86400000, k: 'ad', s: 'snapchat', a: 'Snapchat_' + i});
  storage.setItem('dl_tp', JSON.stringify(old));
  const {api} = makeEnv({url: 'https://darlena.com/?Ad-ID=Snapchat_new&utm_source=snapchat', storage});
  await wait(400);
  const kept = JSON.parse(storage.getItem('dl_tp'));
  assert.strictEqual(kept.length, 20);
  assert.ok(!kept.some(x => x.a === 'Snapchat_old'));
  assert.strictEqual(kept[kept.length - 1].a, 'Snapchat_new');
  const pv = evsOf(api)[0];
  assert.strictEqual(pv.touch.a, 'Snapchat_new');
  assert.strictEqual(pv.tp.length, 20, 'landing carries the path');
});

test('guests are not customers: Salla guest token never sent as a customer, no login event', async () => {
  const guest = {id: '0123456789abcdef0123456789abcdef', type: 'guest', mobile: null, email: null};
  const {api} = makeEnv({url: 'https://darlena.com/?utm_source=snapchat&utm_content=adG', user: guest});
  await wait(3400);
  const evs = evsOf(api);
  assert.strictEqual(types(api), JSON.stringify(['pv']));
  assert.strictEqual(evs[0].cid, null);
  assert.strictEqual(evs[0].ph, undefined);
});

test('iPhone on iOS 26+: real version read from Version/, frozen 18.7 kept apart; real iOS 18.7 left alone', () => {
  const p = makeEnv().api.h.parseUa;
  const snap = p('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Snapchat/14.27.0.54 (like Safari/8624.5.1.10.3)');
  assert.strictEqual(JSON.stringify([snap.osv, snap.osf, snap.app, snap.appv]), JSON.stringify(['26.6.1', '18.7', 'Snapchat', '14.27.0.54']));
  const safari = p('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1');
  assert.strictEqual(JSON.stringify([safari.osv, safari.osf]), JSON.stringify(['26.0', '18.7']));
  const oldPhone = p('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1');
  assert.strictEqual(JSON.stringify([oldPhone.osv, oldPhone.osf]), JSON.stringify(['18.7', undefined]));
  const tiktok = p('Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_47.0.0 JsSdk/2.0');
  assert.strictEqual(JSON.stringify([tiktok.osv, tiktok.osf, tiktok.app]), JSON.stringify(['26.6', undefined, 'TikTok']));
});

test('WhatsApp\'s own browser is recognised on iPhone and Android', () => {
  const p = makeEnv().api.h.parseUa;
  const ios = p('Mozilla/5.0 (iPhone; CPU iPhone OS 26_6_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.2 Mobile/15E148 Safari/604.1 [WAiOS/2.26.39]');
  assert.strictEqual(JSON.stringify([ios.app, ios.appv, ios.osv]), JSON.stringify(['WhatsApp', '2.26.39', '26.6.2']));
  const and = p('Mozilla/5.0 (Linux; Android 13; SM-S908E Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/153.0.8010.57 Mobile Safari/537.36 WA4A/2.26.38.73');
  assert.strictEqual(JSON.stringify([and.app, and.appv, and.dev]), JSON.stringify(['WhatsApp', '2.26.38.73', 'SM-S908E']));
  assert.strictEqual(p('Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1').app, null);
});

test('ad tags on our own page we came from become the click when this browser never saw it; not twice', async () => {
  const adPage = 'https://darlena.com/c22?ttclid=TT9&utm_source=tiktok&utm_campaign=Spring&utm_content=ad77';
  const fresh = makeEnv({url: 'https://darlena.com/abaya/p1126339486', referrer: adPage});
  await wait(400);
  const pv = evsOf(fresh.api)[0];
  assert.strictEqual(JSON.stringify([pv.touch.s, pv.touch.k, pv.touch.o, pv.touch.tt, pv.touch.uc]), JSON.stringify(['tiktok', 'ad', 'ref', 'TT9', 'Spring']));
  assert.strictEqual(pv.touch.u, adPage);
  assert.strictEqual(pv.tp.length, 1);
  // The same browser landed on the ad page itself: the next page (new visit after a long gap) adds nothing.
  const storage = memoryStorage();
  makeEnv({url: adPage, storage});
  await wait(400);
  storage.setItem('dl_sat', String(Date.now() - 31 * 60000));
  const later = makeEnv({url: 'https://darlena.com/abaya/p1126339486', referrer: adPage, storage});
  await wait(400);
  const pv2 = evsOf(later.api)[0];
  assert.strictEqual(pv2.land, 1);
  assert.strictEqual(pv2.touch, null);
  assert.strictEqual(pv2.tpn, 1, 'click kept once');
});

test('thank-you reached first in this browser: Salla checkout link UTMs recorded as the click (o: checkout)', async () => {
  const el = {getAttribute: a => (a === 'data-content' ? '293609214' : null), textContent: ''};
  const checkout = 'https://darlena.com/checkout/XmwYE9V?utm_term=BGID_10&currency=SAR&utm_campaign=Snapchat-Sales&utm_content=aad71557&has_apple_pay=true&utm_source=snapchat&ScCid=9144207a&utm_medium=paid';
  const env = makeEnv({url: 'https://darlena.com/thankyou/WAbNYYP', referrer: checkout, elements: {'[data-testid="store-thankyou-order-id"]': el}});
  await wait(1200);
  const p = evsOf(env.api).find(e => e.t === 'purchase');
  const t = p.tp[p.tp.length - 1];
  assert.strictEqual(JSON.stringify([t.s, t.o, t.sc, t.ux, t.uc]), JSON.stringify(['snapchat', 'checkout', '9144207a', 'aad71557', 'Snapchat-Sales']));
  assert.strictEqual(p.ref, checkout);
});

test('click IDs the theme saved, with their times, and Salla\'s cart ID ride along', async () => {
  const storage = memoryStorage({snap_ScCid: 'c-old', snap_ScCid_ts: '1791682445110', tiktok_ttclid: 'E_C_P_x', tiktok_ttclid_ts: '1790259679103',
    'darlena:reco:v1:cart': JSON.stringify({v: 2, cart: '3203808174170559083', lines: {}, at: Date.now() - 3600000})});
  const session = memoryStorage({'darlena:cart-journey:v1': JSON.stringify({at: Date.now(), cart: '3209999999999999999'})});
  const env = makeEnv({url: 'https://darlena.com/cart', storage, session});
  await wait(400);
  const pv = evsOf(env.api)[0];
  assert.strictEqual(JSON.stringify(pv.pc), JSON.stringify({sc: 'c-old', sc_at: 1791682445110, tt: 'E_C_P_x', tt_at: 1790259679103}));
  assert.strictEqual(pv.cart_id, '3209999999999999999', 'this tab\'s cart first');
  const other = makeEnv({url: 'https://darlena.com/', storage});
  await wait(400);
  assert.strictEqual(evsOf(other.api)[0].cart_id, '3203808174170559083', 'else the saved cart record');
});

test('add to cart carries Salla\'s cart ID from Salla\'s reply', async () => {
  let added = null;
  const salla = {config: {get: () => null}, event: {cart: {onItemAdded: fn => { added = fn; }}}, onReady: fn => fn()};
  const env = makeEnv({url: 'https://darlena.com/abaya/p1', salla});
  await wait(400);
  added({data: {cart: {id: 3201657834988832063n.toString(), total: 299, count: 1}}}, 1126339486);
  await wait(2400);
  const a = evsOf(env.api).find(e => e.t === 'add_to_cart');
  assert.strictEqual(JSON.stringify([a.pid, a.cart_id, a.total]), JSON.stringify(['1126339486', '3201657834988832063', 299]));
});

test('purchase sent at once; the amount and currency follow on the same event when Salla adds them', async () => {
  const el = {getAttribute: a => (a === 'data-content' ? '293619369' : null), textContent: ''};
  const dataLayer = [];
  const env = makeEnv({url: 'https://darlena.com/thankyou/BKygyjR', dataLayer, elements: {'[data-testid="store-thankyou-order-id"]': el}});
  await wait(1200);
  dataLayer.push({event: 'purchase', ecommerce: {currencyCode: 'SAR', purchase: {actionField: {id: 293619369, revenue: 281.37, currency_code: 'SAR'}}}});
  await wait(1200);
  const ps = env.api.sent.flatMap(s => s.body.ev).filter(e => e.t === 'purchase');
  assert.strictEqual(ps.length, 2);
  assert.strictEqual(ps[0].id, ps[1].id, 'same event, merged by the server');
  assert.strictEqual(ps[0].order.value, null);
  assert.strictEqual(JSON.stringify([ps[1].order.ref, ps[1].order.value, ps[1].order.cur]), JSON.stringify(['293619369', 281.37, 'SAR']));
});

test('amount already there: one purchase only, currency read from currencyCode', async () => {
  const el = {getAttribute: a => (a === 'data-content' ? '293600001' : null), textContent: ''};
  const dataLayer = [{event: 'purchase', ecommerce: {currencyCode: 'SAR', purchase: {actionField: {id: 293600001, revenue: 99.5}}}}];
  const env = makeEnv({url: 'https://darlena.com/thankyou/x1', dataLayer, elements: {'[data-testid="store-thankyou-order-id"]': el}});
  await wait(2500);
  const ps = env.api.sent.flatMap(s => s.body.ev).filter(e => e.t === 'purchase');
  assert.strictEqual(ps.length, 1);
  assert.strictEqual(JSON.stringify([ps[0].order.value, ps[0].order.cur]), JSON.stringify([99.5, 'SAR']));
});

test('checkout link without Ad-ID is the same click as the ad landing (same ScCid): not added twice', async () => {
  const storage = memoryStorage();
  makeEnv({url: 'https://darlena.com/p9?Ad-ID=Snapchat_aad7&utm_source=snapchat&utm_content=aad7&ScCid=9144207a', storage});
  await wait(400);
  storage.setItem('dl_sat', String(Date.now() - 40 * 60000));
  const el = {getAttribute: a => (a === 'data-content' ? '293609999' : null), textContent: ''};
  const env = makeEnv({url: 'https://darlena.com/thankyou/z', storage, elements: {'[data-testid="store-thankyou-order-id"]': el},
    referrer: 'https://darlena.com/checkout/abc?utm_source=snapchat&utm_content=aad7&ScCid=9144207a&currency=SAR'});
  await wait(1200);
  const p = evsOf(env.api).find(e => e.t === 'purchase');
  assert.strictEqual(p.tp.length, 1);
  assert.strictEqual(p.tp[0].a, 'Snapchat_aad7');
});

test('the placeholder "fbclid=fbclid" (copied into a Google Ads link) is not a Meta click; every other fbclid still is', async () => {
  const href = 'https://darlena.com/%D8%B5%D9%8A%D9%81-2026/tag-776177565?fbclid=fbclid&scid=VKvVOxXR7SLY0SznpfUU6VkwkbfjS5btYO0lQg&ttp=9rFktSvRJpIniCn9EsU5Y9p2gap.tt.1' +
    '&fbc=fb.1.1784640824821.fbclid.AQYAAQIB&fbp=fb.1.1738499339689.974886038599938637.AQYAAQIB&utm_source=google&utm_medium=cpc&gad_source=1&gad_campaignid=21028209101&gclid=CjwKCAjwrbfWBhAeEiwAc2e6Ptx4';
  const storage = memoryStorage({darlena_fbclid: 'fbclid', darlena_fbclid_ts: '1791835368000'});
  const {api} = makeEnv({url: href, referrer: 'https://www.google.com/', storage});
  await wait(400);
  const pv = evsOf(api)[0];
  assert.strictEqual(pv.touch.s, 'google');
  assert.strictEqual(pv.touch.fb, undefined, 'the placeholder is not kept as a Meta click ID');
  assert.ok(pv.touch.g.startsWith('CjwKCAjwrbfWBhAe'));
  assert.strictEqual(pv.pc, null, 'a saved placeholder is not sent as a Meta click');
  // Every other fbclid still counts, short or long.
  for (const v of ['PAZXh0bgNhZW0BMABkaWQBqzm3NIEw7nNydGMGYXBwX2lk', 'IwAR3x', 'abc']) {
    const meta = makeEnv({url: 'https://darlena.com/p1?fbclid=' + v});
    await wait(400);
    const t = evsOf(meta.api)[0].touch;
    assert.strictEqual(JSON.stringify([t.s, t.fb]), JSON.stringify(['meta', v]), v);
  }
  assert.strictEqual(makeEnv().api.h.readParams('?fbclid=fbclid').ad, false);
  assert.strictEqual(makeEnv().api.h.readParams('?fbclid=IwAR3x').ad, true);
  const real = memoryStorage({darlena_fbclid: 'IwAR3xyz', darlena_fbclid_ts: '1791835368000'});
  const r = makeEnv({url: 'https://darlena.com/', storage: real});
  await wait(400);
  assert.strictEqual(evsOf(r.api)[0].pc.fb, 'IwAR3xyz');
});
