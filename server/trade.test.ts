// npm test — the arithmetic and the readings behind the one route that can spend money. No
// network here: every call that reaches Bitget is a thin wrapper over these four.
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { sign } from './bitget.ts'
import { cancel, floorTo, reads, setLevels, sizeOf, spec, tpsl } from './trade.ts'

/* The signature covers the body now, or a POST signed like a GET is refused by the exchange —
   and the empty default is what keeps every read in bitget.ts signing exactly as it did. */
const body = '{"symbol":"BTCUSDT"}'
assert.equal(
  sign('s', '1', 'POST', '/api/v2/mix/order/place-order', body),
  createHmac('sha256', 's').update('1POST/api/v2/mix/order/place-order' + body).digest('base64'),
)
assert.equal(sign('s', '1', 'GET', '/x'), createHmac('sha256', 's').update('1GET/x').digest('base64'))

/* Read-only or read/write, read off what a cancel for a made-up order id comes back with. The
   refusal that names the rights is the only one that means read-only — "no such order" means the
   key was allowed to ask, which is the whole trick. */
assert.equal(reads({ code: '40014', msg: 'Incorrect permission' }), true)
assert.equal(reads({ code: '40012', msg: 'apikey does not have permission to trade' }), true)
assert.equal(reads({ code: '43001', msg: 'The order does not exist' }), false)
assert.equal(reads({ code: '22001', msg: 'No order to cancel' }), false)
// a success cannot happen against an id of '0', and it is not a refusal either way
assert.equal(reads({ code: '00000' }), false)

/* The contract's own rules, with a working default behind each: a spec that did not answer must
   not become NaN decimals on a size that is about to be sent. */
assert.deepEqual(
  spec([{ volumePlace: '3', minTradeNum: '0.001', pricePlace: '1', maxLever: '125' }]),
  { sizePlace: 3, min: 0.001, pricePlace: 1, maxLev: 125 },
)
assert.deepEqual(spec(null), { sizePlace: 4, min: 0, pricePlace: 2, maxLev: null })

// down, never up: rounding a size up is margin the account may not have
assert.equal(floorTo(0.0299999, 3), 0.029)
assert.equal(floorTo(1.9999, 0), 1)

/* 100 USDT at 10× is 1000 of notional, which at 50 000 is 0.02 of the coin — and the venue's own
   step is what it gets cut to, not ours. */
const btc = { sizePlace: 3, min: 0.001 }
assert.equal(sizeOf(100, 10, 50_000, btc), 0.02)
assert.equal(sizeOf(33, 7, 50_000, btc), 0.004)   // 0.00462 down to the venue's third place
// under the venue's floor is a refusal here rather than at the exchange, and it says what to do
assert.throws(() => sizeOf(1, 1, 50_000, btc), /smallest size/)

/* The one call that can un-commit money, over a stubbed fetch: what it signs and sends, and that a
   refusal is thrown rather than swallowed — a cancel that quietly did nothing would take the order
   off the card while it was still resting at the venue. */
{
  const real = globalThis.fetch
  let seen: { url: string, body: unknown } | null = null
  const answer = (code: string) => async (url: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(url), body: JSON.parse(String(init?.body ?? 'null')) }
    return new Response(JSON.stringify({ code, msg: 'The order does not exist' }))
  }
  const cred = { key: 'k', secret: 's', passphrase: 'p' }
  globalThis.fetch = answer('00000') as typeof fetch
  await cancel(cred, 'LINKUSDT', '123')
  assert.equal(seen!.url, 'https://api.bitget.com/api/v2/mix/order/cancel-order')
  assert.deepEqual(seen!.body, { symbol: 'LINKUSDT', productType: 'USDT-FUTURES', orderId: '123' })
  globalThis.fetch = answer('43001') as typeof fetch
  await assert.rejects(() => cancel(cred, 'LINKUSDT', '123'), /does not exist/)
  globalThis.fetch = real
}

/* Moving the levels on a position that is already open. Place or modify is the whole decision and
   it is invisible if it goes wrong — a place where a modify was wanted is refused for a duplicate,
   and the stop stays where it was while the chart says it moved. */
const resting = [
  { planType: 'pos_loss', holdSide: 'long', orderId: '900' },
  { planType: 'pos_profit', holdSide: 'short', orderId: '901' },
]

// a stop already resting against the long: moved, at its own order id
{
  const { path, body } = tpsl('stop', 'long', 'BTCUSDT', '61000.5', resting)
  assert.equal(path, '/api/v2/mix/order/modify-tpsl-order')
  assert.deepEqual(body, {
    marginCoin: 'USDT', productType: 'USDT-FUTURES', symbol: 'BTCUSDT',
    triggerPrice: '61000.5', triggerType: 'mark_price', orderId: '900',
  })
}
// nothing resting for the long's target: placed, and told which side it belongs to
{
  const { path, body } = tpsl('target', 'long', 'BTCUSDT', '70000', resting)
  assert.equal(path, '/api/v2/mix/order/place-tpsl-order')
  assert.deepEqual(body, {
    marginCoin: 'USDT', productType: 'USDT-FUTURES', symbol: 'BTCUSDT',
    triggerPrice: '70000', triggerType: 'mark_price', planType: 'pos_profit', holdSide: 'long',
  })
}
/* The side is half the match, not garnish: a hedged account holds both ways at once, and the
   short's own stop must not be modified by a drag on the long's line. */
assert.equal(tpsl('stop', 'short', 'BTCUSDT', '1', resting).path, '/api/v2/mix/order/place-tpsl-order')
assert.equal(tpsl('target', 'short', 'BTCUSDT', '1', resting).body.orderId, '901')
// and an empty book is every level placed rather than every level thrown
assert.equal(tpsl('stop', 'long', 'BTCUSDT', '1', []).path, '/api/v2/mix/order/place-tpsl-order')

/* And over a stubbed fetch: a key that may not trade never reaches the exchange with a level. */
{
  const real = globalThis.fetch
  /* Per path, because `desk` asks four questions before any level is sent and only one of them is
     about rights: a stub that refuses all of them proves nothing about which check fired. */
  globalThis.fetch = (async (url: string | URL | Request) => new Response(JSON.stringify(
    String(url).includes('cancel-order')
      ? { code: '40014', msg: 'Incorrect permission' }
      : { code: '00000', data: String(url).includes('contracts') ? [{}] : {} },
  ))) as typeof fetch
  await assert.rejects(
    () => setLevels({ key: 'ro', secret: 's', passphrase: 'p' }, 'BTCUSDT', 'long', { stop: 1 }),
    /read-only/,
  )
  // and a level nobody named is not a call at all
  await assert.rejects(
    () => setLevels({ key: 'ro', secret: 's', passphrase: 'p' }, 'BTCUSDT', 'long', {}),
    /nothing to move/,
  )
  globalThis.fetch = real
}
