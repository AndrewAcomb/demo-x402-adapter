/**
 * Mission Control — live ops dashboard for BuyWith402.
 *
 * A single self-contained HTML page (inline CSS/JS, zero external
 * assets) served at GET /live by the Hono app, so it deploys
 * identically on Vercel. The page talks only to this API:
 *
 *   GET /orders?limit=N        recent order feed (polled ~3s)
 *   GET /orders/:id?since=N    selected-order events (polled ~2s)
 *
 * Modes:
 *   live    — default; polls the real order store.
 *   replay  — /live?replay=ORDER_ID re-animates a past order's event
 *             history with original relative timing (gaps >8s → 2s).
 *   demo    — when the order store isn't configured, the API says so
 *             and the page animates a built-in synthetic order.
 *
 * NOTE for editors: the embedded client JS deliberately avoids
 * backticks and "${" so this file can hold it in one template
 * literal. Keep it that way.
 */

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Mission Control — BuyWith402</title>
<style>
  :root {
    --bg: #0a0e13;
    --panel: #10161e;
    --panel-2: #141c26;
    --line: #1f2937;
    --text: #e2e9f2;
    --dim: #8b98a9;
    --faint: #5b6673;
    --accent: #4cc9f0;
    --green: #34d399;
    --amber: #fbbf24;
    --orange: #fb923c;
    --red: #f87171;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    background: var(--bg);
    color: var(--text);
    font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    overflow: hidden;
  }
  #app { display: flex; flex-direction: column; height: 100vh; }

  /* ---------- header ---------- */
  header {
    display: flex; align-items: center; gap: 16px;
    padding: 14px 22px; border-bottom: 1px solid var(--line);
    background: linear-gradient(180deg, #0d1420, #0a0e13);
    flex-shrink: 0;
  }
  .brand { display: flex; align-items: baseline; gap: 12px; }
  .brand h1 {
    font-size: 20px; letter-spacing: 0.14em; font-weight: 700;
    text-transform: uppercase;
  }
  .brand h1 .dim { color: var(--accent); }
  .brand .sub { color: var(--dim); font-size: 13px; letter-spacing: 0.02em; }
  .spacer { flex: 1; }
  .badge {
    font: 700 12px/1 var(--mono); letter-spacing: 0.12em; text-transform: uppercase;
    padding: 6px 12px; border-radius: 4px; border: 1px solid;
    display: none; align-items: center; gap: 8px;
  }
  .badge.show { display: inline-flex; }
  #badge-live   { color: var(--green);  border-color: rgba(52,211,153,.4);  background: rgba(52,211,153,.08); }
  #badge-demo   { color: var(--amber);  border-color: rgba(251,191,36,.4);  background: rgba(251,191,36,.08); }
  #badge-replay { color: var(--accent); border-color: rgba(76,201,240,.4); background: rgba(76,201,240,.08); }
  .badge .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
  #badge-live .dot { animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .25; } }
  #clock { font: 600 15px var(--mono); color: var(--dim); letter-spacing: 0.06em; }

  /* ---------- layout ---------- */
  .cols { display: flex; flex: 1; min-height: 0; }
  aside {
    width: 330px; flex-shrink: 0; border-right: 1px solid var(--line);
    overflow-y: auto; background: #0c1118;
  }
  aside h2, .panel h2 {
    font: 700 12px var(--mono); letter-spacing: 0.16em; text-transform: uppercase;
    color: var(--faint); padding: 14px 18px 8px;
  }
  main { flex: 1; overflow-y: auto; padding: 20px 26px 60px; min-width: 0; }

  /* ---------- feed ---------- */
  .feed-item {
    padding: 12px 18px; border-bottom: 1px solid #131a24; cursor: pointer;
    display: flex; gap: 12px; align-items: flex-start;
  }
  .feed-item:hover { background: #101825; }
  .feed-item.sel { background: #14202f; box-shadow: inset 3px 0 0 var(--accent); }
  .feed-dot { width: 10px; height: 10px; border-radius: 50%; margin-top: 6px; flex-shrink: 0; }
  .feed-body { min-width: 0; flex: 1; }
  .feed-name { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .feed-meta { font: 12px var(--mono); color: var(--dim); margin-top: 3px; display: flex; gap: 8px; flex-wrap: wrap; }
  .feed-empty { padding: 26px 18px; color: var(--faint); font-size: 14px; }
  .chip {
    font: 700 10px var(--mono); letter-spacing: 0.08em; padding: 2px 6px;
    border-radius: 3px; text-transform: uppercase;
  }
  .chip.dry { color: var(--accent); background: rgba(76,201,240,.12); }
  .chip.real { color: var(--green); background: rgba(52,211,153,.12); }

  /* ---------- status colors ---------- */
  .st-queued          { color: var(--dim); }
  .st-running         { color: var(--amber); }
  .st-retrying        { color: var(--orange); }
  .st-ready_to_place  { color: var(--green); }
  .st-placed          { color: var(--green); }
  .st-failed          { color: var(--red); }
  .bg-queued          { background: var(--dim); }
  .bg-running         { background: var(--amber); animation: pulse 1.4s ease-in-out infinite; }
  .bg-retrying        { background: var(--orange); animation: pulse 1s ease-in-out infinite; }
  .bg-ready_to_place  { background: var(--green); }
  .bg-placed          { background: var(--green); }
  .bg-failed          { background: var(--red); }

  /* ---------- selected order ---------- */
  .placeholder { color: var(--faint); font-size: 17px; padding: 60px 0; text-align: center; }
  .banner {
    display: flex; align-items: center; gap: 18px; flex-wrap: wrap;
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: 18px 22px; margin-bottom: 18px;
  }
  .status-pill {
    font: 800 17px var(--mono); letter-spacing: 0.1em; text-transform: uppercase;
    padding: 10px 18px; border-radius: 6px; border: 2px solid; white-space: nowrap;
  }
  .status-pill.st-queued         { border-color: var(--dim); }
  .status-pill.st-running        { border-color: var(--amber); animation: pulse 1.6s ease-in-out infinite; }
  .status-pill.st-retrying       { border-color: var(--orange); }
  .status-pill.st-ready_to_place { border-color: var(--green); background: rgba(52,211,153,.08); }
  .status-pill.st-placed         { border-color: var(--green); background: rgba(52,211,153,.08); }
  .status-pill.st-failed         { border-color: var(--red); background: rgba(248,113,113,.08); }
  .banner .info { min-width: 0; flex: 1; }
  .banner .prod { font-size: 19px; font-weight: 700; }
  .banner .oid { font: 13px var(--mono); color: var(--dim); margin-top: 4px; word-break: break-all; }
  .timer-box { text-align: right; }
  .timer { font: 800 30px var(--mono); color: var(--accent); letter-spacing: 0.04em; }
  .timer-label { font: 11px var(--mono); color: var(--faint); letter-spacing: 0.14em; text-transform: uppercase; }

  /* ---------- payment card ---------- */
  .panel {
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    margin-bottom: 18px; overflow: hidden;
  }
  .panel h2 { padding: 14px 22px 0; }
  .pay-grid { display: flex; gap: 34px; flex-wrap: wrap; padding: 12px 22px 18px; align-items: flex-end; }
  .pay-cell .k { font: 11px var(--mono); color: var(--faint); letter-spacing: 0.14em; text-transform: uppercase; margin-bottom: 4px; }
  .pay-cell .v { font: 600 16px var(--mono); word-break: break-all; }
  .pay-amount { font: 800 30px var(--mono); color: var(--green); }
  .pay-amount .unit { font-size: 15px; color: var(--dim); font-weight: 600; }
  a.tx-link { color: var(--accent); text-decoration: none; border-bottom: 1px dotted rgba(76,201,240,.5); }
  a.tx-link:hover { border-bottom-style: solid; }
  .pay-pending { padding: 6px 22px 18px; color: var(--faint); font-size: 14px; }

  /* ---------- timeline ---------- */
  .timeline { padding: 6px 22px 20px; }
  .evt { display: flex; gap: 14px; padding: 9px 0; border-bottom: 1px solid #131a24; }
  .evt:last-child { border-bottom: none; }
  .evt-time { font: 13px var(--mono); color: var(--faint); flex-shrink: 0; width: 74px; padding-top: 2px; }
  .evt-stage {
    font: 700 10px var(--mono); letter-spacing: 0.08em; text-transform: uppercase;
    padding: 3px 7px; border-radius: 3px; flex-shrink: 0; height: fit-content; margin-top: 2px;
    min-width: 78px; text-align: center;
  }
  .sg-worker     { color: var(--dim);    background: rgba(139,152,169,.12); }
  .sg-agent      { color: var(--accent); background: rgba(76,201,240,.12); }
  .sg-checkpoint { color: var(--green);  background: rgba(52,211,153,.12); }
  .sg-payment    { color: var(--green);  background: rgba(52,211,153,.18); }
  .sg-live_view  { color: var(--amber);  background: rgba(251,191,36,.12); }
  .sg-other      { color: var(--dim);    background: rgba(139,152,169,.10); }
  .evt-body { min-width: 0; flex: 1; }
  .evt-msg { font-size: 15px; word-break: break-word; }
  .evt-msg a { color: var(--accent); }
  .evt-shot {
    display: block; margin-top: 10px; max-width: 560px; width: 100%;
    border: 1px solid var(--line); border-radius: 6px; cursor: zoom-in;
    background: #000;
  }
  .evt-new { animation: slidein .35s ease-out; }
  @keyframes slidein { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

  /* ---------- lightbox ---------- */
  #lightbox {
    display: none; position: fixed; inset: 0; z-index: 50;
    background: rgba(4,7,10,.92); cursor: zoom-out;
    align-items: center; justify-content: center; padding: 30px;
  }
  #lightbox.show { display: flex; }
  #lightbox img { max-width: 100%; max-height: 100%; border-radius: 8px; border: 1px solid var(--line); }

  ::-webkit-scrollbar { width: 10px; }
  ::-webkit-scrollbar-thumb { background: #222c3a; border-radius: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }

  @media (max-width: 900px) {
    aside { width: 240px; }
    .timer { font-size: 22px; }
  }
</style>
</head>
<body>
<div id="app">
  <header>
    <div class="brand">
      <h1>Mission <span class="dim">Control</span></h1>
      <span class="sub">BuyWith402 &mdash; x402 USDC on Base &rarr; real hardware, fulfilled by a browser agent</span>
    </div>
    <div class="spacer"></div>
    <span class="badge" id="badge-live"><span class="dot"></span>Live</span>
    <span class="badge" id="badge-demo"><span class="dot"></span>Demo data</span>
    <span class="badge" id="badge-replay"><span class="dot"></span>Replay</span>
    <span id="clock"></span>
  </header>
  <div class="cols">
    <aside>
      <h2>Orders</h2>
      <div id="feed"><div class="feed-empty">Waiting for orders&hellip;</div></div>
    </aside>
    <main id="main">
      <div class="placeholder">Select an order &mdash; or wait for one to arrive.</div>
    </main>
  </div>
</div>
<div id="lightbox"><img id="lightbox-img" alt="screenshot"></div>

<script>
'use strict';
/* ================= utilities ================= */
function $(id) { return document.getElementById(id); }
function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function fmtClock(d) {
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + ' UTC';
}
function fmtTime(iso) {
  if (!iso) return '--:--:--';
  var d = new Date(iso);
  if (isNaN(d)) return '--:--:--';
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function fmtAgo(iso) {
  var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return Math.floor(s) + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function fmtDur(ms) {
  var s = Math.max(0, Math.floor(ms / 1000));
  var m = Math.floor(s / 60); s = s % 60;
  function p(n) { return (n < 10 ? '0' : '') + n; }
  if (m >= 60) { var h = Math.floor(m / 60); m = m % 60; return h + ':' + p(m) + ':' + p(s); }
  return p(m) + ':' + p(s);
}
function shortId(id) { return id && id.length > 12 ? id.slice(0, 8) : (id || ''); }
function shortAddr(a) { return a && a.length > 14 ? a.slice(0, 8) + '\\u2026' + a.slice(-6) : (a || ''); }
function usdc(atomic) {
  var n = Number(atomic);
  if (!isFinite(n)) return null;
  return (n / 1e6).toFixed(2);
}
function basescanTx(network, tx) {
  if (!tx) return null;
  if (network === 'eip155:8453') return 'https://basescan.org/tx/' + tx;
  if (network === 'eip155:84532') return 'https://sepolia.basescan.org/tx/' + tx;
  return null;
}
function networkName(network) {
  if (network === 'eip155:8453') return 'Base mainnet';
  if (network === 'eip155:84532') return 'Base Sepolia';
  return network || 'unknown';
}
function isFinalStatus(st) { return st === 'placed' || st === 'ready_to_place' || st === 'failed'; }

/* ================= state ================= */
var MODE = 'live';                 // live | demo | replay
var REPLAY_ID = null;
var orders = [];                   // feed rows
var selectedId = null;
var userPinned = false;            // user clicked a specific order
var sel = null;                    // { order, events, nextSince }
var feedTimer = null, orderTimer = null, tickTimer = null;
var replay = null;                 // replay engine state
var demo = null;                   // demo engine state

var qs = new URLSearchParams(location.search);
if (qs.get('replay')) { MODE = 'replay'; REPLAY_ID = qs.get('replay'); }
var pathMatch = location.pathname.match(/^\\/live\\/orders\\/([^/]+)/);
if (pathMatch && MODE !== 'replay') { selectedId = decodeURIComponent(pathMatch[1]); userPinned = true; }

/* ================= header clock ================= */
setInterval(function () { $('clock').textContent = fmtClock(new Date()); }, 500);
$('clock').textContent = fmtClock(new Date());

function setBadge(mode) {
  $('badge-live').className = 'badge' + (mode === 'live' ? ' show' : '');
  $('badge-demo').className = 'badge' + (mode === 'demo' ? ' show' : '');
  $('badge-replay').className = 'badge' + (mode === 'replay' ? ' show' : '');
}

/* ================= feed rendering ================= */
function renderFeed() {
  var feed = $('feed');
  feed.innerHTML = '';
  if (!orders.length) {
    feed.appendChild(el('div', 'feed-empty', MODE === 'demo'
      ? 'Demo order feed.'
      : 'No orders yet. The next x402 purchase will appear here.'));
    return;
  }
  orders.forEach(function (o) {
    var item = el('div', 'feed-item' + (o.order_id === selectedId ? ' sel' : ''));
    item.appendChild(el('span', 'feed-dot bg-' + o.status));
    var body = el('div', 'feed-body');
    body.appendChild(el('div', 'feed-name', o.product_name || o.product_id || 'unknown product'));
    var meta = el('div', 'feed-meta');
    meta.appendChild(el('span', 'st-' + o.status, o.status.replace(/_/g, ' ')));
    meta.appendChild(el('span', null, shortId(o.order_id)));
    if (o.created_at) meta.appendChild(el('span', null, fmtAgo(o.created_at)));
    meta.appendChild(el('span', 'chip ' + (o.dry_run ? 'dry' : 'real'), o.dry_run ? 'dry run' : 'real'));
    body.appendChild(meta);
    item.appendChild(body);
    item.onclick = function () {
      userPinned = true;
      selectOrder(o.order_id);
    };
    feed.appendChild(item);
  });
}

/* ================= main pane rendering ================= */
function ensureOrderDom() {
  if ($('order-pane')) return;
  var main = $('main');
  main.innerHTML = '';
  var pane = el('div'); pane.id = 'order-pane';

  var banner = el('div', 'banner');
  var pill = el('div', 'status-pill'); pill.id = 'status-pill';
  banner.appendChild(pill);
  var info = el('div', 'info');
  var prod = el('div', 'prod'); prod.id = 'prod-name'; info.appendChild(prod);
  var oid = el('div', 'oid'); oid.id = 'order-id'; info.appendChild(oid);
  banner.appendChild(info);
  var tb = el('div', 'timer-box');
  var timer = el('div', 'timer', '00:00'); timer.id = 'timer';
  tb.appendChild(timer);
  tb.appendChild(el('div', 'timer-label', 'elapsed'));
  banner.appendChild(tb);
  pane.appendChild(banner);

  var pay = el('div', 'panel'); pay.id = 'pay-panel';
  var ph = el('h2', null, 'Payment proof'); pay.appendChild(ph);
  var pbody = el('div'); pbody.id = 'pay-body';
  pbody.appendChild(el('div', 'pay-pending', 'Awaiting settlement details\\u2026'));
  pay.appendChild(pbody);
  pane.appendChild(pay);

  var tpanel = el('div', 'panel');
  tpanel.appendChild(el('h2', null, 'Fulfillment timeline'));
  var tl = el('div', 'timeline'); tl.id = 'timeline';
  tl.appendChild(el('div', 'pay-pending', 'No events yet.'));
  tpanel.appendChild(tl);
  pane.appendChild(tpanel);

  main.appendChild(pane);
}

function renderBanner(order) {
  ensureOrderDom();
  var pill = $('status-pill');
  var st = order.status || 'queued';
  pill.className = 'status-pill st-' + st;
  pill.textContent = st.replace(/_/g, ' ');
  $('prod-name').textContent = (order.product_name || order.product_id || '') +
    (order.quantity > 1 ? ' \\u00d7 ' + order.quantity : '');
  $('order-id').textContent = 'order ' + (order.order_id || '') +
    (order.dry_run ? '  \\u00b7  DRY RUN (stops at merchant review)' : '  \\u00b7  REAL ORDER');
}

function renderPayment(payment) {
  ensureOrderDom();
  var body = $('pay-body');
  if (!payment || (!payment.tx && !payment.payer)) {
    body.innerHTML = '';
    body.appendChild(el('div', 'pay-pending', 'Awaiting settlement details\\u2026'));
    return;
  }
  body.innerHTML = '';
  var grid = el('div', 'pay-grid');

  var amt = el('div', 'pay-cell');
  amt.appendChild(el('div', 'k', 'Amount'));
  var av = el('div', 'pay-amount');
  var usd = usdc(payment.amount);
  av.textContent = usd !== null ? usd : '\\u2014';
  var unit = el('span', 'unit', ' USDC'); av.appendChild(unit);
  amt.appendChild(av);
  grid.appendChild(amt);

  if (payment.payer) {
    var payer = el('div', 'pay-cell');
    payer.appendChild(el('div', 'k', 'Payer'));
    payer.appendChild(el('div', 'v', shortAddr(payment.payer)));
    payer.title = payment.payer;
    grid.appendChild(payer);
  }

  var net = el('div', 'pay-cell');
  net.appendChild(el('div', 'k', 'Network'));
  net.appendChild(el('div', 'v', networkName(payment.network)));
  grid.appendChild(net);

  if (payment.tx) {
    var tx = el('div', 'pay-cell');
    tx.appendChild(el('div', 'k', 'Transaction'));
    var v = el('div', 'v');
    var href = basescanTx(payment.network, payment.tx);
    if (href) {
      var a = el('a', 'tx-link', shortAddr(payment.tx) + ' \\u2197');
      a.href = href; a.target = '_blank'; a.rel = 'noopener';
      a.title = payment.tx;
      v.appendChild(a);
    } else {
      v.textContent = shortAddr(payment.tx);
    }
    tx.appendChild(v);
    grid.appendChild(tx);
  }
  body.appendChild(grid);
}

function stageClass(stage) {
  var known = { worker: 1, agent: 1, checkpoint: 1, payment: 1, live_view: 1 };
  return 'sg-' + (known[stage] ? stage : 'other');
}

function appendEvent(evt, animate) {
  ensureOrderDom();
  var tl = $('timeline');
  var empty = tl.querySelector('.pay-pending');
  if (empty) empty.remove();

  var row = el('div', 'evt' + (animate ? ' evt-new' : ''));
  row.appendChild(el('div', 'evt-time', fmtTime(evt.t)));
  row.appendChild(el('div', 'evt-stage ' + stageClass(evt.stage), evt.stage || '?'));
  var body = el('div', 'evt-body');
  var msg = el('div', 'evt-msg');
  var urlMatch = (evt.message || '').match(/https?:\\/\\/\\S+/);
  if (evt.stage === 'live_view' && urlMatch) {
    msg.appendChild(document.createTextNode((evt.message || '').replace(urlMatch[0], '').trim() + ' '));
    var a = el('a', null, urlMatch[0]);
    a.href = urlMatch[0]; a.target = '_blank'; a.rel = 'noopener';
    msg.appendChild(a);
  } else {
    msg.textContent = evt.message || '';
  }
  body.appendChild(msg);
  if (evt.screenshot_url) {
    var img = el('img', 'evt-shot');
    img.src = evt.screenshot_url;
    img.loading = 'lazy';
    img.alt = 'checkout screenshot';
    img.onerror = function () { img.style.display = 'none'; };
    img.onclick = function () {
      $('lightbox-img').src = evt.screenshot_url;
      $('lightbox').className = 'show';
    };
    body.appendChild(img);
  }
  row.appendChild(body);
  tl.appendChild(row);

  // Follow the tail if the viewer is already near the bottom.
  var main = $('main');
  if (main.scrollHeight - main.scrollTop - main.clientHeight < 320) {
    main.scrollTop = main.scrollHeight;
  }
}

function clearTimeline() {
  ensureOrderDom();
  var tl = $('timeline');
  tl.innerHTML = '';
  tl.appendChild(el('div', 'pay-pending', 'No events yet.'));
}

$('lightbox').onclick = function () { $('lightbox').className = ''; };
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') $('lightbox').className = '';
});

/* ================= duration ticker ================= */
function startTicker() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(function () {
    if (!sel || !sel.order || !sel.order.created_at) return;
    var start = new Date(sel.order.created_at).getTime();
    var end;
    if (isFinalStatus(sel.order.status)) {
      end = new Date(sel.order.updated_at || sel.order.created_at).getTime();
    } else {
      end = Date.now();
    }
    if ($('timer')) $('timer').textContent = fmtDur(end - start);
  }, 1000);
}

/* ================= live mode ================= */
function api(path) {
  return fetch(path, { headers: { Accept: 'application/json' } }).then(function (r) {
    if (!r.ok) throw new Error('http ' + r.status);
    return r.json();
  });
}

function pollFeed() {
  api('/orders?limit=20').then(function (data) {
    if (data && data.configured === false) {
      if (MODE === 'live') startDemo();
      return;
    }
    orders = (data && data.orders) || [];
    if (!userPinned && orders.length && (!selectedId || orders[0].order_id !== selectedId)) {
      selectOrder(orders[0].order_id);
      return;
    }
    renderFeed();
    // Refresh selected order meta from the feed row (status may have moved).
    if (sel && sel.order) {
      for (var i = 0; i < orders.length; i++) {
        if (orders[i].order_id === selectedId) {
          sel.order.status = orders[i].status;
          sel.order.updated_at = orders[i].updated_at || sel.order.updated_at;
          renderBanner(sel.order);
          break;
        }
      }
    }
  }).catch(function () { /* transient feed failure: keep polling */ });
}

function pollSelected() {
  if (!selectedId || MODE !== 'live') return;
  var since = sel ? sel.nextSince : 0;
  api('/orders/' + encodeURIComponent(selectedId) + '?since=' + since).then(function (data) {
    if (!sel || sel.order.order_id !== data.order_id) return;
    sel.order.status = data.status;
    sel.order.created_at = data.created_at || sel.order.created_at;
    sel.order.updated_at = data.updated_at;
    sel.order.dry_run = data.dry_run;
    sel.order.product_name = data.product_name || sel.order.product_name;
    sel.order.quantity = data.quantity;
    renderBanner(sel.order);
    if (data.payment) renderPayment(data.payment);
    var evts = data.events || [];
    evts.forEach(function (e) { appendEvent(e, true); });
    sel.nextSince = data.next_since != null ? data.next_since : since + evts.length;
  }).catch(function () { /* transient poll failure: keep trying */ });
}

function selectOrder(id) {
  selectedId = id;
  if (MODE === 'demo') { selectDemoOrder(id); renderFeed(); return; }
  var row = null;
  for (var i = 0; i < orders.length; i++) if (orders[i].order_id === id) row = orders[i];
  sel = {
    order: row || { order_id: id, status: 'queued', product_name: '', created_at: null },
    nextSince: 0
  };
  ensureOrderDom();
  renderBanner(sel.order);
  renderPayment(row && row.payment);
  clearTimeline();
  renderFeed();
  startTicker();
  pollSelected();
}

function startLive() {
  MODE = 'live';
  setBadge('live');
  pollFeed();
  feedTimer = setInterval(pollFeed, 3000);
  orderTimer = setInterval(pollSelected, 2000);
  if (selectedId) selectOrder(selectedId);
}

/* ================= replay mode ================= */
function startReplay(id) {
  MODE = 'replay';
  setBadge('replay');
  api('/orders/' + encodeURIComponent(id) + '?since=0').then(function (data) {
    var events = data.events || [];
    orders = [{
      order_id: data.order_id, product_id: data.product_id,
      product_name: data.product_name || data.product_id,
      status: events.length ? 'running' : data.status,
      created_at: data.created_at, updated_at: data.updated_at,
      dry_run: data.dry_run
    }];
    selectedId = data.order_id;
    renderFeed();
    sel = { order: orders[0], nextSince: 0 };
    ensureOrderDom();
    renderBanner(sel.order);
    renderPayment(null);
    clearTimeline();

    // Replay ticker: track replayed elapsed time, not wall-clock.
    var replayStart = Date.now();
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(function () {
      if ($('timer')) $('timer').textContent = fmtDur(Date.now() - replayStart);
    }, 500);

    // Schedule events with original relative gaps; compress gaps >8s to 2s.
    var delay = 800;
    var schedule = [];
    for (var i = 0; i < events.length; i++) {
      if (i > 0) {
        var gap = new Date(events[i].t).getTime() - new Date(events[i - 1].t).getTime();
        if (!isFinite(gap) || gap < 0) gap = 1000;
        if (gap > 8000) gap = 2000;
        if (gap < 250) gap = 250;
        delay += gap;
      }
      schedule.push({ evt: events[i], at: delay });
    }
    schedule.forEach(function (item) {
      setTimeout(function () {
        appendEvent(item.evt, true);
        if (item.evt.stage === 'payment' && data.payment) renderPayment(data.payment);
        if (item.evt.stage === 'checkpoint' || item.evt.stage === 'agent') {
          sel.order.status = 'running';
          renderBanner(sel.order);
        }
      }, item.at);
    });
    var total = schedule.length ? schedule[schedule.length - 1].at + 900 : 500;
    setTimeout(function () {
      sel.order.status = data.status;
      orders[0].status = data.status;
      renderBanner(sel.order);
      renderFeed();
      if (data.payment) renderPayment(data.payment);
      clearInterval(tickTimer);
    }, total);
  }).catch(function (err) {
    $('main').innerHTML = '';
    $('main').appendChild(el('div', 'placeholder',
      'Replay failed: could not load order ' + id + ' (' + err.message + ')'));
  });
}

/* ================= demo mode ================= */
function demoShot(title, line1, line2) {
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="560">' +
    '<rect width="900" height="560" fill="#161b22"/>' +
    '<rect width="900" height="46" fill="#21262e"/>' +
    '<circle cx="24" cy="23" r="7" fill="#f87171"/><circle cx="48" cy="23" r="7" fill="#fbbf24"/><circle cx="72" cy="23" r="7" fill="#34d399"/>' +
    '<rect x="100" y="10" width="560" height="26" rx="13" fill="#0d1117"/>' +
    '<text x="118" y="28" font-family="monospace" font-size="15" fill="#8b98a9">' + title + '</text>' +
    '<rect x="60" y="100" width="780" height="70" rx="6" fill="#21262e"/>' +
    '<text x="84" y="144" font-family="sans-serif" font-size="26" fill="#e2e9f2">' + line1 + '</text>' +
    '<rect x="60" y="200" width="500" height="220" rx="6" fill="#1c2129"/>' +
    '<rect x="590" y="200" width="250" height="220" rx="6" fill="#1c2129"/>' +
    '<rect x="614" y="350" width="200" height="46" rx="6" fill="#2da44e"/>' +
    '<text x="640" y="380" font-family="sans-serif" font-size="18" fill="#ffffff">' + line2 + '</text>' +
    '<text x="84" y="250" font-family="sans-serif" font-size="18" fill="#8b98a9">SYNTHETIC SCREENSHOT \\u2014 DEMO DATA</text>' +
    '</svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function buildDemoData() {
  var now = Date.now();
  function iso(msAgo) { return new Date(now - msAgo).toISOString(); }
  var liveId = 'demo-4f2a81c6-live';
  return {
    liveId: liveId,
    orders: [
      {
        order_id: liveId, product_id: 'mcmaster:92224A111',
        product_name: 'Steel Pan Head Phillips Screw 4-40 x 3/16 inch (pack of 100)',
        status: 'queued', created_at: iso(2000), updated_at: iso(2000),
        dry_run: true, quantity: 1,
        payment: { payer: '0xDE3071bCe72Cf5C528EBd3C1cbC4Bd63ba9B4d21', tx: '0x9d1f04c5a2b7e6883e2a4d0f5b1c9a3e7d6f8b2a4c1e0d9f7b5a3c1e8d6f4b2a', amount: '23230000', network: 'eip155:84532' }
      },
      {
        order_id: 'demo-b81e33d0-done', product_id: 'mcmaster:92224A100',
        product_name: 'Steel Pan Head Phillips Screw 2-56 x 1/8 inch (pack of 100)',
        status: 'ready_to_place', created_at: iso(14 * 60000), updated_at: iso(9 * 60000),
        dry_run: true, quantity: 1,
        payment: { payer: '0xA0Cf024611EB77dF09c2D3c8dB6d6bE9cA3E9c11', tx: '0x51c2b8a94e7d3f6a0b5c8e1d4f7a2b9c6e3d0f5a8b1c4e7d2f9a6b3c0e5d8f1b', amount: '35090000', network: 'eip155:84532' }
      },
      {
        order_id: 'demo-7cc90a1f-fail', product_id: 'mcmaster:92224A104',
        product_name: 'Steel Pan Head Phillips Screw 2-56 x 3/8 inch (pack of 50)',
        status: 'failed', created_at: iso(41 * 60000), updated_at: iso(35 * 60000),
        dry_run: true, quantity: 2,
        payment: { payer: '0x6B4e19fA88f7cD012Ee5D2aB93C07C6a41d0AB42', tx: '0xe83a1c5f9b2d7e4a6c0f3b8d1e5a9c2f7b4e0d6a3c8f1b5e9d2a7c4f0b6e3d8a', amount: '55760000', network: 'eip155:84532' }
      }
    ],
    script: [
      { after: 1200, stage: 'payment', message: 'Payment settled: $23.23 USDC from 0xDE3071bCe72Cf5C528EBd3C1cbC4Bd63ba9B4d21' },
      { after: 2200, stage: 'worker', message: 'Order claimed from queue. Starting fulfillment run (attempt 1).' , status: 'running' },
      { after: 3000, stage: 'agent', message: 'started: opening mcmaster.com in hosted browser session' },
      { after: 3200, stage: 'checkpoint', message: 'cart-cleared', shot: ['mcmaster.com/order', 'Shopping Cart \\u2014 empty', 'Continue'] },
      { after: 4200, stage: 'agent', message: 'navigating to product page 92224A111' },
      { after: 3600, stage: 'checkpoint', message: 'product-in-cart', shot: ['mcmaster.com/92224A111', 'Added to cart: 4-40 x 3/16" screws (100)', 'Checkout'] },
      { after: 3800, stage: 'agent', message: 'entering shipping address (Jane Doe, San Francisco CA)' },
      { after: 4400, stage: 'agent', message: 'selecting ground shipping, verifying totals' },
      { after: 3600, stage: 'checkpoint', message: 'place-order-review', shot: ['mcmaster.com/checkout', 'Review order \\u2014 total $5.49 + shipping', 'Place order'] },
      { after: 2600, stage: 'worker', message: 'Dry run: stopping at merchant order-review screen as requested.', status: 'ready_to_place' },
      { after: 1400, stage: 'worker', message: 'Fulfillment finished: ready_to_place.' }
    ]
  };
}

function selectDemoOrder(id) {
  if (!demo) return;
  selectedId = id;
  var row = null;
  for (var i = 0; i < demo.orders.length; i++) if (demo.orders[i].order_id === id) row = demo.orders[i];
  if (!row) return;
  sel = { order: row, nextSince: 0 };
  ensureOrderDom();
  renderBanner(row);
  clearTimeline();
  startTicker();
  if (id === demo.liveId) {
    // Animated order: replay its script from wherever it has progressed.
    renderPayment(null);
    demo.played.forEach(function (e) {
      appendEvent(e, false);
      if (e.stage === 'payment') renderPayment(row.payment);
    });
  } else {
    renderPayment(row.payment);
    // Static synthetic history for finished demo orders.
    var evts = row.status === 'failed'
      ? [
          { t: row.created_at, stage: 'payment', message: 'Payment settled: $' + usdc(row.payment.amount) + ' USDC from ' + row.payment.payer },
          { t: row.created_at, stage: 'worker', message: 'Order claimed from queue. Starting fulfillment run (attempt 1).' },
          { t: row.updated_at, stage: 'worker', message: 'Merchant checkout blocked after 3 attempts. Marking failed.' }
        ]
      : [
          { t: row.created_at, stage: 'payment', message: 'Payment settled: $' + usdc(row.payment.amount) + ' USDC from ' + row.payment.payer },
          { t: row.created_at, stage: 'worker', message: 'Order claimed from queue. Starting fulfillment run (attempt 1).' },
          { t: row.updated_at, stage: 'checkpoint', message: 'place-order-review', screenshot_url: demoShot('mcmaster.com/checkout', 'Review order', 'Place order') },
          { t: row.updated_at, stage: 'worker', message: 'Fulfillment finished: ' + row.status + '.' }
        ];
    evts.forEach(function (e) { appendEvent(e, false); });
  }
}

function startDemo() {
  if (MODE === 'demo') return;
  MODE = 'demo';
  setBadge('demo');
  if (feedTimer) clearInterval(feedTimer);
  if (orderTimer) clearInterval(orderTimer);
  demo = buildDemoData();
  demo.played = [];
  orders = demo.orders;
  renderFeed();
  selectDemoOrder(demo.liveId);

  var live = demo.orders[0];
  var t = 0;
  demo.script.forEach(function (step) {
    t += step.after;
    setTimeout(function () {
      var evt = {
        t: new Date().toISOString(),
        stage: step.stage,
        message: step.message
      };
      if (step.shot) evt.screenshot_url = demoShot(step.shot[0], step.shot[1], step.shot[2]);
      demo.played.push(evt);
      if (step.status) { live.status = step.status; live.updated_at = evt.t; }
      if (selectedId === live.order_id) {
        appendEvent(evt, true);
        if (evt.stage === 'payment') renderPayment(live.payment);
        renderBanner(live);
      }
      renderFeed();
    }, t);
  });
}

/* ================= boot ================= */
if (MODE === 'replay' && REPLAY_ID) {
  startReplay(REPLAY_ID);
} else {
  startLive();
}
</script>
</body>
</html>
`;
