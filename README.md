# darlena-track

Our own first-party log of ad clicks and visitors on darlena.com, used to match Salla orders (taken server side) to the ads that brought them. One file: `dl-track.js` (v0.2.0, plain ES5, no dependencies, ASCII only).

## Design rules

- The page view is the core record. Every page view carries everything the server needs to match an order on its own. Nothing depends on a login, cart or checkout step on our pages: Salla often logs people in with one tap (their phone from another Salla store), most logins happen on Salla's checkout where we can't run code, and returning shoppers often already have a cart.
- The landing address is taken from the browser's own record of the navigation (`performance` navigation entry), so a script that rewrites the address bar can't hide the ad tags. It is never read back from storage for the current page.
- This visit's landing address (`dl_lurl`) is saved once when the visit starts and never overwritten during the visit. The first-ever landing address of the browser (`dl_furl`) is saved once and never overwritten at all.
- The thank-you page is part of the plan: it records the buyer's own browser at the moment of purchase, which covers Salla orders whose IP / browser is the payment company's server.
- Multi-touch: every ad click or outside referral starts a new visit (its own landing page view), and the browser also keeps the last 20 clicks (90 days) and sends the whole list with landings, identify, checkout start and purchase.

## Loading

Served from jsDelivr and added through Salla's custom JS (store design settings), not the theme. Paste this into the custom JS box as is (plain JavaScript, no `<script>` tag):

```js
/* darlena-track: our own ad-click and visit log (github.com/Aliyu93/darlena-track) */
(function () {
  try {
    if (window.__dlTrackLoader) return;
    window.__dlTrackLoader = 1;
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/gh/Aliyu93/darlena-track@v0.2.0/dl-track.min.js';
    s.async = true;
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {}
})();
```

A new version is a new tag (`v0.2.1`, ...) and a one-line change of the address above. Add the snippet only after the collector (`collectTouch`, darlenaapp `functions/lib/webTouch.js`) is live, or every beacon is a 404.

Optional config, set before the script: `window.DL_TRACK_CONFIG = {endpoint, endpointV4 (null = off), hosts, dryRun, debug}`. `dryRun: true` records what would be sent in `window.__dlTrack.sent` and sends nothing. `?dl_debug=1` logs to the console.

## What it sends

Beacons (`text/plain` JSON, no preflight) to `https://darlena.shop/collectTouch` (IPv6 when the phone has it) plus a small copy with the same event IDs to `https://darlena.co/collectTouch` (IPv4 only), so the collector records both addresses from the requests themselves.

Body: `{v, vid, sid, at, ev: [...]}`; IPv4 copy: `{v, vid, sid, at, ip4: [event ids]}`.

Every event: `t`, `id`, `ts`, `seq`, `path`, `page` (Salla page name), `cid` (Salla customer ID when logged in).

| t | when | extra fields |
|---|---|---|
| `pv` | every page view (+ IPv4 copy) | `land` (1 = first page of a visit), `why`, `url` (exact address the page was opened with), `cur` (address bar if rewritten), `nav`, `lurl`/`lat` (this visit's landing), `furl`/`fat` (first-ever landing), `ref`, `q` (address keys), `pid` (product ID), `touch` (this click), `tnew`, `tpn`, `tp` (click path, on landings), `ua`, `uai` (OS, version, browser, in-app browser), `uah` (Chrome device hints), `dev`, `ids` (platform cookies), `fv`, `ms`, and `ph`/`em`/`cc` (hashed customer) whenever Salla shows a logged-in customer |
| `ids` | platform cookies appear or change after the page view | `ids` |
| `identify` | customer appears on the page after its page view was sent (+ IPv4 copy) | `via`, `ph`, `em`, `cc`, `lurl`, `ids`, `ua`, `tp` |
| `add_to_cart` | Salla cart event (extra signal) | `pid`, `total`, `items` |
| `checkout_start` | click on the cart's checkout button (extra signal, + IPv4 copy) | `lurl`, `ids`, `tp` |
| `purchase` | thank-you page, and Salla's order event (+ IPv4 copy) | `via`, `order {ref, oid, value, cur}`, `url`, `ref`, `lurl`, `lat`, `furl`, `ua`, `uai`, `uah`, `dev`, `ids`, `tp`, `ph`, `em`, `cc` |

Click path entries (`tp`, `touch`): `ts`, `k` (ad / ref), `s` (snapchat, tiktok, meta, google, pinterest, utm source or `ref:<host>`), `a` (Ad-ID), `us/um/uc/ux/ut/ui` (utm source / medium / campaign / content / term / id), `sc`/`tt`/`fb`/`g` (click IDs), `h` (referrer host), `u` (full landing address). A reload of the same link within 30 minutes is not a new click.

Hashing: phone = SHA-256 of digits with country code, no `+`, no leading 0 (Snap / Meta format; Salla gives `+9665…`); email = SHA-256 of trimmed lower case.

Never sent: raw phone, email or names; the values of address keys like `phone`, `email`, `token`, `otp`, `data` (the key stays, the value becomes `x`); Salla's `page.link` / `page.referrer` (Salla's guest page cache serves another visitor's values).

Stored in the browser: `dl_vid` (localStorage + cookie), `dl_vid_at`, `dl_sid`, `dl_sat`, `dl_seq`, `dl_sad`, `dl_sref`, `dl_lurl`, `dl_lat`, `dl_furl`, `dl_fat`, `dl_idsid`, `dl_ckv`, `dl_cks`, `dl_po`, `dl_tp`.

## Tests

```bash
node --test test/dl-track.test.cjs
```

15 checks in a fake browser (`node:vm`, dry run): phone format, SHA-256 with fallback, address keys, full address with personal values blanked, browser parsing, host guard, ad landing page view with both IP copies, landing address kept per visit and first-ever never changed, opened-with address beats a rewritten address bar, logged-in customer on every page view without a login event, customer appearing mid-page, thank-you purchase once per order, cookie updates, click path in order with full landing addresses, 20 clicks / 90 days.

Live check (2026-10-13, Chrome on darlena.com, dry run, exact file fingerprint `cef57b2385a520d1`):
1. Fresh visitor, ad click A: one page view with the exact address, ad tags, device, 7 platform cookies and the hashed phone (equal to an independent hash), no login event needed; IPv4 copy.
2. In-page move to the cart: page view with the visit's landing address unchanged, the category as previous page, hashed phone, full record, IPv4 copy.
3. Ad click B with the address bar stripped by another script before ours ran: page view still has the original address and ad tags, the stripped bar as `cur`, a new visit with B as its landing, A kept as the first-ever landing, click path A then B.
