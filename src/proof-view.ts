import type { OrderEvent, OrderRecord } from './orders.js';
import type { EvidenceVerification } from './proof.js';

const escapeHtml = (value: unknown): string =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const shortHash = (value: string | null): string =>
  value ? `${value.slice(0, 10)}…${value.slice(-8)}` : 'pending';

export function renderProofStoryboard(
  order: OrderRecord,
  events: OrderEvent[],
  verification: EvidenceVerification,
  receiptHash: string,
): string {
  const final = ['ready_to_place', 'placed', 'failed'].includes(order.status);
  const checkpoints = events.filter(
    (event) => event.stage === 'checkpoint' && event.screenshot_url,
  );
  const proofClass = verification.verified ? 'verified' : verification.status;
  const proofLabel = verification.verified
    ? `CHAIN VERIFIED · ${verification.event_count} EVENTS`
    : verification.status === 'unavailable'
      ? 'PROOF PENDING / LEGACY'
      : 'CHAIN INVALID';
  const cards = checkpoints.length
    ? checkpoints
        .map(
          (event, index) => `
            <article class="frame" style="--i:${index}">
              <div class="frame-top"><span>0${index + 1}</span><code>${escapeHtml(shortHash(event.event_hash ?? null))}</code></div>
              <img src="${escapeHtml(event.screenshot_url)}" alt="${escapeHtml(event.message)} checkout checkpoint">
              <div class="frame-copy">
                <p>${escapeHtml(event.message)}</p>
                <small>SCREENSHOT SHA-256 · ${escapeHtml(shortHash(event.screenshot_sha256 ?? null))}</small>
              </div>
            </article>`,
        )
        .join('')
    : `<div class="empty">The H computer-use agent is working. Checkpoint frames appear here as they are captured.</div>`;
  const timeline = events
    .map(
      (event) => `
        <li>
          <span class="dot"></span>
          <time>${escapeHtml(event.t || 'pending')}</time>
          <strong>${escapeHtml(event.stage)}</strong>
          <p>${escapeHtml(event.message)}</p>
          <code>${escapeHtml(shortHash(event.event_hash ?? null))}</code>
        </li>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  ${final ? '' : '<meta http-equiv="refresh" content="4">'}
  <title>Checkout proof · ${escapeHtml(order.order_id.slice(0, 8))}</title>
  <style>
    :root{color-scheme:dark;--ink:#f6f2e8;--muted:#a8aaa4;--acid:#c8ff57;--red:#ff6b6b;--panel:#161916;--line:#30352f}
    *{box-sizing:border-box} body{margin:0;background:#0a0c0a;color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,sans-serif}
    body:before{content:"";position:fixed;inset:0;pointer-events:none;background:radial-gradient(circle at 70% 0,#24311a 0,transparent 38%),linear-gradient(90deg,#ffffff05 1px,transparent 1px);background-size:auto,42px 42px}
    main{position:relative;max-width:1400px;margin:auto;padding:56px 40px 80px} header{display:grid;grid-template-columns:1fr auto;gap:32px;align-items:end;border-bottom:1px solid var(--line);padding-bottom:32px}
    .eyebrow{color:var(--acid);letter-spacing:.18em;font:700 12px ui-monospace,monospace}.eyebrow:before{content:"●";margin-right:10px}
    h1{font-size:clamp(48px,8vw,110px);letter-spacing:-.07em;line-height:.82;margin:24px 0 18px;max-width:920px}.lede{color:var(--muted);font-size:18px;max-width:760px;line-height:1.55}
    .status{text-align:right}.status b{display:block;font-size:28px;text-transform:uppercase}.status small{color:var(--muted);font:12px ui-monospace,monospace}
    .proofbar{display:grid;grid-template-columns:1fr repeat(3,auto);gap:24px;align-items:center;margin:28px 0 48px;padding:18px 20px;background:var(--panel);border:1px solid var(--line);border-radius:12px}
    .seal{font:700 12px ui-monospace,monospace;letter-spacing:.09em}.seal.verified{color:var(--acid)}.seal.invalid{color:var(--red)}.seal.unavailable{color:#ffd36b}.metric{border-left:1px solid var(--line);padding-left:24px}.metric span{display:block;color:var(--muted);font-size:10px;letter-spacing:.12em}.metric code{font-size:12px}
    h2{font-size:13px;letter-spacing:.16em;text-transform:uppercase;margin:0 0 18px}.frames{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(310px,1fr);overflow-x:auto;gap:18px;padding-bottom:20px;scroll-snap-type:x mandatory}
    .frame{scroll-snap-align:start;background:var(--panel);border:1px solid var(--line);border-radius:16px;overflow:hidden;animation:arrive .5s both;animation-delay:calc(var(--i)*.09s)}.frame-top{display:flex;justify-content:space-between;padding:13px 16px;border-bottom:1px solid var(--line);font:11px ui-monospace,monospace;color:var(--muted)}
    .frame img{display:block;width:100%;aspect-ratio:16/10;object-fit:cover;background:#20241f}.frame-copy{padding:17px}.frame-copy p{font-weight:700;text-transform:uppercase;margin:0 0 10px}.frame-copy small{color:var(--muted);font:9px ui-monospace,monospace}
    .empty{grid-column:1/-1;padding:80px 30px;text-align:center;border:1px dashed var(--line);border-radius:16px;color:var(--muted)}
    .audit{display:grid;grid-template-columns:310px 1fr;gap:50px;margin-top:60px}.audit-copy p{color:var(--muted);line-height:1.6}.audit a{display:inline-block;color:#0a0c0a;background:var(--acid);text-decoration:none;font-weight:800;padding:12px 16px;border-radius:8px;margin-top:10px}
    ol{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}li{display:grid;grid-template-columns:12px 190px 110px 1fr auto;gap:14px;align-items:start;border-bottom:1px solid var(--line);padding:16px 0;color:var(--muted);font-size:12px}.dot{width:7px;height:7px;border-radius:50%;background:var(--acid);margin-top:4px}li strong{color:var(--ink);text-transform:uppercase}li p{margin:0;color:var(--ink)}li code{font-size:10px}
    footer{display:flex;justify-content:space-between;gap:20px;border-top:1px solid var(--line);margin-top:56px;padding-top:20px;color:var(--muted);font:10px ui-monospace,monospace}@keyframes arrive{from{opacity:0;transform:translateY(18px)}}
    @media(max-width:800px){main{padding:32px 18px}header{grid-template-columns:1fr}.status{text-align:left}.proofbar{grid-template-columns:1fr}.metric{border-left:0;border-top:1px solid var(--line);padding:12px 0 0}.audit{grid-template-columns:1fr}li{grid-template-columns:12px 1fr}li time,li code{display:none}}
  </style>
</head>
<body><main>
  <header><div><div class="eyebrow">H COMPUTER-USE EVIDENCE</div><h1>Proof, not just<br>“order confirmed.”</h1><div class="lede">Each browser checkpoint is content-hashed and each fulfillment event commits to the one before it. This is the inspectable execution trail behind an x402 purchase.</div></div><div class="status"><small>ORDER ${escapeHtml(order.order_id)}</small><b>${escapeHtml(order.status.replaceAll('_', ' '))}</b></div></header>
  <section class="proofbar"><div class="seal ${proofClass}">${proofLabel}</div><div class="metric"><span>ROOT</span><code>${escapeHtml(shortHash(verification.root))}</code></div><div class="metric"><span>HEAD</span><code>${escapeHtml(shortHash(verification.head))}</code></div><div class="metric"><span>RECEIPT</span><code>${escapeHtml(shortHash(receiptHash))}</code></div></section>
  <section><h2>Checkout storyboard</h2><div class="frames">${cards}</div></section>
  <section class="audit"><div class="audit-copy"><h2>Append-only event trail</h2><p>Change a message, reorder a checkpoint, or replace a screenshot hash and verification fails. The JSON artifact includes the canonical scheme and every event.</p><a href="/orders/${encodeURIComponent(order.order_id)}/proof?download=1">Save proof artifact</a></div><ol>${timeline}</ol></section>
  <footer><span>BUYWITH402 · HACKATHON EVIDENCE VIEW</span><span>HASH CHAIN ≠ THIRD-PARTY ATTESTATION</span></footer>
</main></body></html>`;
}
