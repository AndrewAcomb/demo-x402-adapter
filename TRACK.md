# Track C — Voice Concierge

This track puts a voice on the buying side of BuyWith402 and closes the
loop: agents on both sides of a single x402 payment. The presenter
speaks — "order a pack of 4-40 quarter-inch screws to the office" — and
the concierge transcribes it with Gradium's streaming ASR, uses
H Company's Holo3 model to parse the intent, discovers BuyWith402 on
the x402 Bazaar, and picks the exact McMaster-Carr part, justifying the
choice out loud through Gradium TTS. After a spoken "yes", it pays the
merchant's 402 challenge with one signed USDC transfer on Base via
`@x402/fetch`, then polls the order feed and narrates each milestone by
voice while the H browser agent's checkout screenshots stream onto the
projector. The same H platform is therefore both the buyer's brain and
the seller's hands: Holo3 decides what to buy, and H's hosted browser
agent physically checks out on the merchant site, with the x402 payment
as the handshake between them. For the Gradium voice challenge, both
directions are exercised — websocket ASR with semantic endpointing for
the order and the confirmation, TTS for every narration line. The whole
flow also runs fully offline through per-subsystem mocks (typed input,
deterministic matching, a built-in fake merchant with canned
screenshots, simulated payment), each of which flips live independently
with a single API key, and a scripted smoke test drives the complete
WebSocket flow end to end. The result on stage: a spoken sentence
becomes a real, screenshot-verified hardware order with no keyboard, no
account, and no card — just speech and one crypto payment.
