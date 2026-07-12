/**
 * Placeholder "browser screenshots" for the mock merchant's canned
 * fulfillment run — embedded SVG data URIs so the offline demo streams
 * images just like the real H browser agent does.
 */

function browserFrame(urlBar: string, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">
  <rect width="1280" height="800" fill="#e8e9ec"/>
  <rect width="1280" height="76" fill="#2b2d33"/>
  <circle cx="34" cy="38" r="9" fill="#ff5f57"/>
  <circle cx="64" cy="38" r="9" fill="#febc2e"/>
  <circle cx="94" cy="38" r="9" fill="#28c840"/>
  <rect x="130" y="20" width="1120" height="36" rx="18" fill="#3d4048"/>
  <text x="156" y="44" font-family="monospace" font-size="18" fill="#b8bcc4">${urlBar}</text>
  <rect x="0" y="76" width="1280" height="86" fill="#1a5632"/>
  <text x="48" y="132" font-family="Georgia,serif" font-size="34" font-weight="bold" fill="#ffffff">MOCK MERCHANT SUPPLY CO.</text>
  <text x="1080" y="132" font-family="sans-serif" font-size="22" fill="#d7e5dc">Cart</text>
  ${body}
  <text x="640" y="784" font-family="sans-serif" font-size="14" fill="#9aa0a8" text-anchor="middle">simulated screenshot — offline demo mode</text>
</svg>`;
}

function toDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

export const SCREEN_CART_CLEARED = toDataUri(
  browserFrame(
    'https://merchant.example/cart',
    `<rect x="48" y="210" width="1184" height="340" rx="10" fill="#ffffff" stroke="#c9ccd2"/>
     <text x="640" y="360" font-family="sans-serif" font-size="34" fill="#4a4f57" text-anchor="middle">Your cart is empty</text>
     <text x="640" y="410" font-family="sans-serif" font-size="22" fill="#8a8f98" text-anchor="middle">Previous items removed — starting a clean checkout</text>
     <rect x="540" y="460" width="200" height="52" rx="8" fill="#1a5632"/>
     <text x="640" y="494" font-family="sans-serif" font-size="20" fill="#ffffff" text-anchor="middle">Shop products</text>`,
  ),
);

export const SCREEN_PRODUCT_IN_CART = toDataUri(
  browserFrame(
    'https://merchant.example/cart',
    `<rect x="48" y="200" width="1184" height="180" rx="10" fill="#ffffff" stroke="#c9ccd2"/>
     <rect x="80" y="228" width="124" height="124" rx="6" fill="#d9dce1"/>
     <circle cx="142" cy="278" r="34" fill="#6b7078"/>
     <rect x="132" y="304" width="20" height="42" fill="#6b7078"/>
     <text x="236" y="262" font-family="sans-serif" font-size="26" font-weight="bold" fill="#2b2d33">Steel Pan Head Phillips Screw 4-40 x 1/4"</text>
     <text x="236" y="300" font-family="sans-serif" font-size="20" fill="#5c626b">Black-Oxide Steel, Fully Threaded — Package of 100</text>
     <text x="236" y="338" font-family="sans-serif" font-size="20" fill="#5c626b">Qty: 1</text>
     <text x="1180" y="300" font-family="sans-serif" font-size="28" font-weight="bold" fill="#2b2d33" text-anchor="end">$5.36</text>
     <rect x="900" y="420" width="332" height="58" rx="8" fill="#1a5632"/>
     <text x="1066" y="458" font-family="sans-serif" font-size="22" fill="#ffffff" text-anchor="middle">Proceed to checkout</text>`,
  ),
);

export const SCREEN_ORDER_REVIEW = toDataUri(
  browserFrame(
    'https://merchant.example/checkout/review',
    `<text x="48" y="230" font-family="sans-serif" font-size="30" font-weight="bold" fill="#2b2d33">Review your order</text>
     <rect x="48" y="260" width="580" height="240" rx="10" fill="#ffffff" stroke="#c9ccd2"/>
     <text x="76" y="300" font-family="sans-serif" font-size="20" font-weight="bold" fill="#2b2d33">Ship to</text>
     <text x="76" y="338" font-family="sans-serif" font-size="20" fill="#5c626b">Farsight Labs — Office</text>
     <text x="76" y="368" font-family="sans-serif" font-size="20" fill="#5c626b">548 Market St, Suite 26404</text>
     <text x="76" y="398" font-family="sans-serif" font-size="20" fill="#5c626b">San Francisco, CA 94104</text>
     <rect x="652" y="260" width="580" height="240" rx="10" fill="#ffffff" stroke="#c9ccd2"/>
     <text x="680" y="300" font-family="sans-serif" font-size="20" font-weight="bold" fill="#2b2d33">Order summary</text>
     <text x="680" y="338" font-family="sans-serif" font-size="20" fill="#5c626b">Screws 4-40 x 1/4" (pack of 100)</text>
     <text x="1204" y="338" font-family="sans-serif" font-size="20" fill="#5c626b" text-anchor="end">$5.36</text>
     <text x="680" y="368" font-family="sans-serif" font-size="20" fill="#5c626b">Shipping + tax</text>
     <text x="1204" y="368" font-family="sans-serif" font-size="20" fill="#5c626b" text-anchor="end">$6.84</text>
     <text x="680" y="410" font-family="sans-serif" font-size="24" font-weight="bold" fill="#2b2d33">Total</text>
     <text x="1204" y="410" font-family="sans-serif" font-size="24" font-weight="bold" fill="#2b2d33" text-anchor="end">$12.20</text>
     <rect x="900" y="560" width="332" height="58" rx="8" fill="#b8860b"/>
     <text x="1066" y="598" font-family="sans-serif" font-size="22" fill="#ffffff" text-anchor="middle">Place order</text>
     <text x="640" y="680" font-family="sans-serif" font-size="20" fill="#8a2b2b" text-anchor="middle">DRY RUN — the agent stops here without placing the order</text>`,
  ),
);
