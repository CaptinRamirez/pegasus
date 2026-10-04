# OKX v5 API notes (consolidated offline reference)

**Purpose.** A single document a developer can use to write a TypeScript OKX v5 client without network access to OKX.

**Scope (from the requester):** manual trading, single user, self-use (手动交易，单用户自用). Broker-program fields (`tag`, injected `clOrdId` prefixes), sub-account order caps and regional entities are noted for completeness but are not required for this use case. Market focus: perpetual swaps (`SWAP`) plus spot/derivative market data.

**Provenance.** Consolidated from five researcher note-sets. No researcher could fetch the official OKX docs (www.okx.com was blocked); every item below is sourced from SDK / client source code or third-party mirrors. Authority ranking used whenever sources disagree:
1. the official `okxapi/python-okx` SDK (vendor-maintained);
2. actively maintained clients: `ccxt`, `nautechsystems/nautilus_trader`, `tiagosiebler/okx-api`;
3. older / narrower clients: `Anode-Trading/okex` (Go), `roytang121/okx-rs`, Hummingbot, cryptofeed, `bmoscon/orderbook`, skip-mev;
4. third-party docs mirrors / guides: `aahl/mcp-okx`, `jwy207/okx-rest-api-guide`, rate-limit explainer repos.

**Tag legend.** `[verified]` = quoted from client source code or typed definitions; `[likely]` = docs-mirror text, third-party guide, or an inference from code; `[unverified]` = search-engine snippet only. Every item carries a source URL (`src:`).

---

## 1. Endpoints

### 1.1 REST base URLs

| Environment | Base URL | Notes | Conf | Source |
|---|---|---|---|---|
| Production (global) | `https://www.okx.com` | `API_URL = 'https://www.okx.com'` in the official SDK; ccxt default hostname `www.okx.com`; REST path is simply `https://{hostname}` | [verified] | https://raw.githubusercontent.com/okxapi/python-okx/master/okx/consts.py ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| Demo (paper) trading | `https://www.okx.com` (**same host**) + header `x-simulated-trading: 1` | No separate demo REST host; python-okx, ccxt, nautilus, tiagosiebler, Go client, okx-rs all agree | [verified] | https://raw.githubusercontent.com/okxapi/python-okx/master/okx/okxclient.py ; https://raw.githubusercontent.com/cocoyes/okex/master/definitions.go ; https://raw.githubusercontent.com/roytang121/okx-rs/dev/src/api/options.rs |
| AWS-hosted alternative | `https://aws.okx.com` | ccxt comment "or aws.okx.com"; Go SDK constant `AwsRestURL` | [verified] | https://raw.githubusercontent.com/cocoyes/okex/master/definitions.go ; https://raw.githubusercontent.com/Anode-Trading/okex/master/definitions.go |
| EEA (accounts registered on my.okx.com) | `https://eea.okx.com` | regional entity | [verified] | https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/requestUtils.ts |
| US (accounts registered on app.okx.com; nautilus says "United States and Australia") | `https://us.okx.com` | regional entity | [verified] | https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/requestUtils.ts ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/enums.rs |
| "OPENAPI_GLOBAL" | `https://openapi.okx.com` | tiagosiebler market option | [verified] | https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/requestUtils.ts |

- An API key registered in one region is rejected by another region's endpoints with "API key doesn't exist" (Global = www.okx.com accounts, Eea = my.okx.com, Us = app.okx.com). For a single global account use `www.okx.com`. [verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/enums.rs
- Use the `www.` host, not bare `okx.com`: nautilus notes cross-domain redirects can strip auth headers in some HTTP clients/middleboxes. [verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/consts.rs
- Regional hosts and the AWS host come from third-party SDK constants only; the official production-services list was not fetched. [verified as to the SDK constants; the official list is unresolved] src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/requestUtils.ts

### 1.2 WebSocket URLs

**Port 8443 is being retired (changelog "Upcoming Changes", updated 2026-09-30)**: OKX stops accepting WebSocket connections on port 8443 on **2026-10-31**, for production (`ws.okx.com`) and demo trading (`wspap.okx.com`) and for every path (`/ws/v5/public`, `/ws/v5/private`, `/ws/v5/business`). Only the port changes: drop `:8443` from the URL (default TLS port 443); host, path and the demo `?brokerId=9999` query stay the same. `wss://ws.okx.com/ws/v5/public` and `/business` were confirmed to connect and deliver data without the port. Pegasus' defaults in `packages/okx/src/endpoints.ts` therefore carry no port; the table below records what other clients used when it was compiled. [verified] src: https://www.okx.com/docs-v5/log_en/

| Environment | Public | Private | Business | Conf | Source |
|---|---|---|---|---|---|
| Production (port **8443**, used by official SDK tests, nautilus, tiagosiebler, Hummingbot, skip-mev, cryptofeed, okx-rs) | `wss://ws.okx.com:8443/ws/v5/public` | `wss://ws.okx.com:8443/ws/v5/private` | `wss://ws.okx.com:8443/ws/v5/business` | [verified] | https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/consts.rs ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/websocket-util.ts |
| Production (port **443**, ccxt pro only) | `wss://ws.okx.com:443/ws/v5/public` | `.../private` | `.../business` | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts |
| Demo (official python-okx tests, ccxt sandbox, okx-rs) | `wss://wspap.okx.com:8443/ws/v5/public?brokerId=9999` | `wss://wspap.okx.com:8443/ws/v5/private?brokerId=9999` | `wss://wspap.okx.com:8443/ws/v5/business?brokerId=9999` | [verified] | https://raw.githubusercontent.com/okxapi/python-okx/master/test/test_ws_private_async.py ; https://raw.githubusercontent.com/okxapi/python-okx/master/test/test_ws_public_async.py ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts ; https://raw.githubusercontent.com/roytang121/okx-rs/dev/src/api/options.rs |
| Demo (nautilus — **no** `brokerId` query) | `wss://wspap.okx.com:8443/ws/v5/public` | `wss://wspap.okx.com:8443/ws/v5/private` | `wss://wspap.okx.com:8443/ws/v5/business` | [verified] | https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/consts.rs |
| Demo (tiagosiebler — `brokerId` on business only) | `wss://wspap.okx.com:8443/ws/v5/public` | `wss://wspap.okx.com:8443/ws/v5/private` | `wss://wspap.okx.com:8443/ws/v5/business?brokerId=9999` | [verified] | https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/websocket-util.ts |
| Demo (Go client — public+private with `brokerId`; no business endpoint at all) | `wss://wspap.okx.com:8443/ws/v5/public?brokerId=9999` | `wss://wspap.okx.com:8443/ws/v5/private?brokerId=9999` | n/a | [verified] | https://raw.githubusercontent.com/Anode-Trading/okex/master/definitions.go |
| Demo (ccxt pro, port 443) | `wss://wspap.okx.com:443/ws/v5/public?brokerId=9999` | `.../private?brokerId=9999` | `.../business?brokerId=9999` | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts |
| AWS alternative | `wss://wsaws.okx.com:8443/ws/v5/public` | `wss://wsaws.okx.com:8443/ws/v5/private` | (not listed) | [verified] | https://raw.githubusercontent.com/hummingbot/hummingbot/master/hummingbot/connector/derivative/okx_perpetual/okx_perpetual_constants.py ; https://raw.githubusercontent.com/Anode-Trading/okex/master/definitions.go |
| Regional (EEA / US) | `wseea.okx.com` / `wsus.okx.com` (live); `wseeapap.okx.com` / `wsuspap.okx.com` (demo) | same paths | same paths | [verified] | https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/websocket-util.ts ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/docs/integrations/okx.md |

**Verdicts for the two WS disagreements**
- *Port 443 vs 8443*: when this survey was made only ccxt used 443; the official SDK and every other client used 8443. Superseded by the retirement of 8443 on 2026-10-31 (see above): default to **no explicit port (443)**; the URLs stay overridable through `OKX_WS_*_URL`. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/consts.rs
- *`?brokerId=9999` on demo URLs*: the official python-okx tests put it on all three demo endpoints (most authoritative); ccxt and okx-rs agree; tiagosiebler only on business; nautilus on none. Actively maintained clients dropped it for public/private without stating why. Recommendation: **append `?brokerId=9999` to all three demo URLs by default (harmless if ignored) and make it configurable.** [verified for each client's behaviour; requirement itself unresolved] src: https://raw.githubusercontent.com/okxapi/python-okx/master/test/test_ws_private_async.py ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/websocket-util.ts ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/consts.rs

### 1.3 Demo-trading summary
- REST demo = live host + `x-simulated-trading: 1`; WebSocket demo = separate `wspap.okx.com` host. [verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/docs/integrations/okx.md
- Demo API keys are created separately in the demo-trading UI; python-okx switches environment purely via its `flag` value (`'0'` live, `'1'` demo; SDK default is `'1'`). [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/README.md ; https://raw.githubusercontent.com/okxapi/python-okx/master/okx/okxclient.py
- rust-okx README: "OKX demo trading uses separate credentials." [likely] src: https://docs.rs/crate/rust-okx/0.6.4
- Using a demo key against live (or vice-versa) yields error `50101` "Broker id of APIKey does not match current environment". [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
- Official SDK opens the socket with plain TLS `websockets.connect(url)`: no custom headers, no subprotocol; demo vs live is selected purely by URL. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/websocket/WebSocketFactory.py
- tiagosiebler rejects `market: 'demo'` and requires `demoTrading: true`, which maps every live wsKey to a demo wsKey and forces WS-API calls onto demo keys. [verified] src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/websocket-client.ts

---

## 2. REST authentication and signing

### 2.1 Headers
| Header | Value | Conf | Source |
|---|---|---|---|
| `OK-ACCESS-KEY` | API key | [verified] | https://raw.githubusercontent.com/okxapi/python-okx/master/okx/consts.py |
| `OK-ACCESS-SIGN` | Base64 HMAC-SHA256 signature (2.3) | [verified] | https://raw.githubusercontent.com/okxapi/python-okx/master/okx/consts.py |
| `OK-ACCESS-TIMESTAMP` | ISO-8601 UTC with milliseconds + `Z` (2.2) | [verified] | https://raw.githubusercontent.com/okxapi/python-okx/master/okx/consts.py |
| `OK-ACCESS-PASSPHRASE` | API-key passphrase (plain text) | [verified] | https://raw.githubusercontent.com/okxapi/python-okx/master/okx/consts.py |
| `Content-Type` | `application/json` — required on POST (error `50006` otherwise); python-okx and tiagosiebler send it on every request, ccxt only on non-GET; sending it always is safe | [likely] (requirement) / [verified] (client behaviour) | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/okxapi/python-okx/master/okx/utils.py ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/BaseRestClient.ts |
| `Accept` | `application/json` (tiagosiebler sets it globally; optional) | [verified] | https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/BaseRestClient.ts |
| `x-simulated-trading` | `1` for demo trading. ccxt/nautilus/tiagosiebler/Go/okx-rs add it only for demo and omit it for live; python-okx sends it on every request (signed or not) with `'0'` live / `'1'` demo | [verified] | https://raw.githubusercontent.com/okxapi/python-okx/master/okx/utils.py ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/http/client.rs ; https://raw.githubusercontent.com/Anode-Trading/okex/master/api/rest/client.go |

- Public (unauthenticated) endpoints can be called with no auth headers at all; python-okx uses sentinel `'-1'` credentials and then sends only `Content-Type` and `x-simulated-trading`. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/consts.py ; https://raw.githubusercontent.com/okxapi/python-okx/master/okx/okxclient.py
- The `x-simulated-trading` header is **not** part of the signed prehash (no client includes any header in the prehash). [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/utils.py

### 2.2 Timestamp (`OK-ACCESS-TIMESTAMP`)
- Format: UTC ISO-8601 with **millisecond** precision and a literal trailing `Z`, e.g. `2020-12-08T09:08:57.715Z`. python-okx: `utcnow().isoformat('T','milliseconds') + 'Z'`. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/utils.py
- TypeScript: `new Date().toISOString()` is used unchanged by tiagosiebler (yields `YYYY-MM-DDTHH:MM:SS.mmmZ`). [verified] src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/BaseRestClient.ts
- ccxt: `this.iso8601(this.nonce())` → `YYYY-MM-DDTHH:MM:SS.mmmZ` (3-digit ms); `nonce()` = `milliseconds() - options.timeDifference` (default 0); `adjustForTimeDifference` option (default false) corrects for measured clock offset. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/base/functions/time.ts ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
- nautilus: "OKX requires milliseconds in the timestamp" — formats with exactly 3 fractional digits. [verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/http/client.rs
- Counter-examples NOT to copy: Go client layout `2006-01-02T15:04:05.999Z07:00` trims trailing zero milliseconds (0–3 digits); okx-rs emits no fractional seconds (`%Y-%m-%dT%H:%M:%SZ`). **Always emit exactly 3 fractional digits.** [verified] src: https://raw.githubusercontent.com/Anode-Trading/okex/master/api/rest/client.go ; https://raw.githubusercontent.com/roytang121/okx-rs/dev/src/api/mod.rs
- Server time: `GET /api/v5/public/time` → `{"code":"0","data":[{"ts":"1621247923668"}],"msg":""}`; `ts` is epoch **milliseconds as a string**. python-okx can derive the signing timestamp from it (ms → UTC ISO with ms, `+00:00` replaced by `Z`). [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/okxapi/python-okx/master/okx/okxclient.py
- Clock tolerance: a request is rejected with `50102` "Timestamp request expired" if the timestamp differs from server time by more than **30 seconds**; fix = NTP sync or use `/api/v5/public/time`. [likely] (third-party guide; no SDK enforces it client-side) src: https://raw.githubusercontent.com/jwy207/okx-rest-api-guide/main/README.md

### 2.3 Prehash and signature
- Prehash string = `timestamp + METHOD + requestPath + body`, concatenated with **no separators**; METHOD upper-case (`GET`/`POST`). [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/utils.py
- `requestPath` starts at `/api/v5/...` (ccxt: `'/api/' + version + '/' + path`). [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
- **GET**: the `?key=value&...` query string is appended to the requestPath **before** signing (query is part of the signed path) and the body is the empty string `''`. The query string must be **byte-identical** in the URL and in the prehash. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/okxclient.py ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/requestUtils.ts
- **POST**: body = the JSON string (`json.dumps(params)` / `JSON.stringify(params)`); the identical string is both signed and sent. nautilus signs the exact body bytes to avoid re-serialization mismatches. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/okxclient.py ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/credential.rs
- Empty body: a body of `'{}'` or `'None'` must be signed as `''` (python-okx `signature()` helper; Go client; ccxt sends no body when the non-GET query is empty). [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/utils.py ; https://raw.githubusercontent.com/Anode-Trading/okex/master/api/rest/client.go
- Signature = `Base64( HMAC-SHA256( key = secret (UTF-8 bytes), message = prehash (UTF-8 bytes) ) )` using the **raw digest** (not hex) before Base64; standard Base64 alphabet with `=` padding. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/utils.py ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/credential.rs
- Query-string encoding: python-okx builds `?k=v&k2=v2` by plain string concatenation (skips `None`/empty values, **no URL-encoding**); tiagosiebler likewise `key=value` joined with `&`; ccxt uses `urlencode()`; Go uses `q.Encode()`. All work for typical values (`instId`, `ordId` contain no reserved characters); which the server expects for reserved characters is unresolved (see §12). [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/utils.py ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/requestUtils.ts ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
- Signed-GET example message (nautilus unit test): `2020-12-08T09:08:57.715ZGET/api/v5/account/balance?ccy=BTC`. [verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/credential.rs

### 2.4 Known-answer test vector (use in a unit test)
```
API key     : 985d5b66-57ce-40fb-b714-afc0b9787083
API secret  : chNOOS4KvNXR_Xq4k4c9qsfoKWvnDecLATCRlcBwyKDYnWgO
passphrase  : 1234567890
timestamp   : 2020-12-08T09:08:57.715Z
method/path : GET /api/v5/account/balance
body        : ""   (empty)
prehash     : 2020-12-08T09:08:57.715ZGET/api/v5/account/balance
signature   : PJ61e1nb2F2Qd7D8SPiaIcx2gjdELc+o0ygzre9z33k=
```
[verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/credential.rs

### 2.5 Worked TypeScript pseudo-code
```ts
import { createHmac } from 'node:crypto';

const BASE = 'https://www.okx.com';                 // same host for live and demo
const DEMO = true;                                   // demo => add x-simulated-trading: 1

function okxSign(secret: string, ts: string, method: 'GET' | 'POST', requestPath: string, body: string): string {
  const prehash = ts + method + requestPath + body;  // no separators; method upper-case
  return createHmac('sha256', secret).update(prehash, 'utf8').digest('base64'); // raw digest -> base64
}

function authHeaders(key: string, secret: string, pass: string, ts: string, sig: string): Record<string, string> {
  const h: Record<string, string> = {
    'OK-ACCESS-KEY': key,
    'OK-ACCESS-SIGN': sig,
    'OK-ACCESS-TIMESTAMP': ts,
    'OK-ACCESS-PASSPHRASE': pass,
    'Content-Type': 'application/json',
  };
  if (DEMO) h['x-simulated-trading'] = '1';
  return h;
}

// ---- signed GET with query -------------------------------------------------
const ts = new Date().toISOString();                 // e.g. 2020-12-08T09:08:57.715Z (3 ms digits + Z)
const query = '?ccy=BTC';                            // build once; reuse the SAME string in URL and prehash
const path = '/api/v5/account/balance' + query;      // query IS part of the signed requestPath
const sig = okxSign(SECRET, ts, 'GET', path, '');    // GET body is ''
await fetch(BASE + path, { method: 'GET', headers: authHeaders(KEY, SECRET, PASS, ts, sig) });

// ---- signed POST ------------------------------------------------------------
const body = JSON.stringify({
  instId: 'BTC-USDT-SWAP', tdMode: 'isolated', side: 'buy', posSide: 'long',
  ordType: 'limit', sz: '1', px: '30000.0',          // example from python-okx tests
});
const ts2 = new Date().toISOString();
const sig2 = okxSign(SECRET, ts2, 'POST', '/api/v5/trade/order', body);
const res = await fetch(BASE + '/api/v5/trade/order', {
  method: 'POST', headers: authHeaders(KEY, SECRET, PASS, ts2, sig2), body, // send the identical string that was signed
});
const json = await res.json();                       // { code: '0', msg: '', data: [...] }
if (json.code !== '0' && json.code !== '2') { /* inspect json.msg and json.data[i].sCode / sMsg */ }
```
Sources for each line: prehash/HMAC/Base64 https://raw.githubusercontent.com/okxapi/python-okx/master/okx/utils.py ; `toISOString()` https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/BaseRestClient.ts ; GET query in path https://raw.githubusercontent.com/okxapi/python-okx/master/okx/okxclient.py ; order example https://raw.githubusercontent.com/okxapi/python-okx/master/test/test_trade.py ; envelope https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/http/client.rs

### 2.6 Response envelope
- Shape: `{ code: string, msg: string, data: array }`; `data` is always an array. `code === "0"` is success. [verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/http/client.rs ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/types/rest/shared.ts
- `code === "2"` = bulk operation partially succeeded (nautilus `OKX_PARTIAL_SUCCESS_CODE`; ccxt treats `'0'` and `'2'` as non-error). [verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/http/client.rs ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
- Business errors arrive with HTTP 200: ccxt's `handleErrors` reads `code`, then per-item `data[i].sCode` / `data[i].sMsg` (e.g. top-level `code: "1"` with `sCode: "51119"` inside `data`), then matches the top-level code. tiagosiebler resolves `data` only when HTTP status is 200 **and** `code === '0'`, otherwise throws the body. Clients must inspect `code`, not just HTTP status. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/BaseRestClient.ts
- Order-type responses may also carry top-level `inTime` / `outTime` (microsecond strings) — seen on a failed close-position response. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
- Rate limiting can surface as HTTP **429** (ccxt maps 429 → ExchangeNotAvailable) or as code `50011` in a 200 body; handle both. nautilus retries 5xx/429 and honours a `Retry-After` header. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/http/client.rs
- Retry policy (nautilus): retryable OKX codes `50001, 50004, 50005, 50013, 50026, 50011` (+ WS `60001, 60005, 64008`); **never retry order-submit POSTs** (`/api/v5/trade/order`, `/batch-orders`, `/order-algo`, `/sprd/order`) because a lost response may already have filled and freed the `clOrdId`; resolve ambiguous outcomes via stream updates / reconciliation. [verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/consts.rs ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/http/client.rs
- Broker-program injection: ccxt auto-injects a broker-prefixed `clOrdId` + `tag` on `trade/order`, `trade/batch-orders`, `trade/order-algo` when none is supplied; tiagosiebler injects `tag` `159881cb7207BCDE` on every private POST; nautilus uses `5328c82e5542BCDE`. **A self-use client should omit `tag`** (or use its own). [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/BaseRestClient.ts

---

## 3. WebSocket fundamentals

### 3.1 Login
- Request: `{"op":"login","args":[{"apiKey":"...","passphrase":"...","timestamp":"<unix seconds>","sign":"<base64>"}]}`; optional top-level `"id"`. `args` is an array (multi-account login possible). [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/websocket/WsUtils.py ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/types/websockets/ws-request.ts
- `timestamp` = **Unix epoch seconds** (integer, sent as string), NOT ISO and NOT milliseconds. python-okx `int(time.time())`; ccxt `this.seconds().toString()` (= `Math.floor(now/1000)`); tiagosiebler `(Date.now()/1000).toFixed(0)`; Hummingbot `str(int(time))`; nautilus `as_seconds().to_string()` (test expects `"1700000000"`); Go `time.Now().UTC().Unix()`; okx-rs `as_secs()`. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/websocket/WsUtils.py ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/base/functions/time.ts ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/websocket-client.ts ; https://raw.githubusercontent.com/hummingbot/hummingbot/master/hummingbot/connector/exchange/okx/okx_auth.py ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/websocket/client.rs ; https://raw.githubusercontent.com/Anode-Trading/okex/master/api/ws/client.go ; https://raw.githubusercontent.com/roytang121/okx-rs/dev/src/websocket/mod.rs
- Prehash = `timestamp + 'GET' + '/users/self/verify'` (no body); `sign` = Base64(HMAC-SHA256(secret, prehash)) — same HMAC as REST. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/websocket/WsUtils.py
- Login ack: `{"event":"login","code":"0","msg":"...","connId":"..."}` (nautilus test fixture uses `msg: "Login successful"`; ccxt comment shows `{ event: 'login', msg: '', code: '0' }` and elsewhere `{event:'login', success:true}`). Exact `msg` text unresolved. [verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/websocket/messages.rs ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts
- Wait for the login ack before subscribing private channels: python-okx sleeps 5 s after login (crude); Hummingbot reads the first message and treats `event != 'login'` as auth failure. A robust client waits for `{event:'login', code:'0'}`. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/websocket/WsPrivateAsync.py ; https://raw.githubusercontent.com/hummingbot/hummingbot/master/hummingbot/connector/exchange/okx/okx_api_user_stream_data_source.py
- Login result codes: `'0'` OK, `'60009'` login failed, `'60022'` login partially failed (multi-account); nautilus tests also list `'60014'` Too many requests. [verified] src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/websocket-util.ts ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/consts.rs
- nautilus authentication timeout constant: 10 s (`AUTHENTICATION_TIMEOUT_SECS`). [verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/network/src/websocket/consts.rs
- Go client throttles re-login to once per 30 s and discards a login reply arriving >30 s after the request (then re-logs in). [verified] src: https://raw.githubusercontent.com/Anode-Trading/okex/master/api/ws/client.go
- Up to 100 accounts can be logged in on one private connection. [likely] src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/README.md
- On reconnect: re-run login **before** resubscribing; cache subscriptions so the same channel set is rebuilt (nautilus); tiagosiebler re-sends login, then resubscribes public topics immediately and private topics after auth is confirmed. [verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/websocket/client.rs ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/BaseWSClient.ts

```ts
// WS login (TypeScript)
const ts = Math.floor(Date.now() / 1000).toString();                 // whole seconds, as string
const sign = createHmac('sha256', SECRET).update(ts + 'GET' + '/users/self/verify').digest('base64');
ws.send(JSON.stringify({ op: 'login', args: [{ apiKey: KEY, passphrase: PASS, timestamp: ts, sign }] }));
// then wait for {"event":"login","code":"0",...} before sending {"op":"subscribe",...} on the private socket
```

### 3.2 Keepalive (text ping/pong)
- OKX does **not** use protocol-level WebSocket ping/pong frames; the client sends the literal text frame `ping` and the server replies with the literal text `pong`. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/BaseWSClient.ts
- Server idle rule (docs text mirrored by skip-mev): the connection is closed automatically if no subscription is established or no data is pushed for more than **30 seconds**. Recommended: timer of N < 30 s reset on every received message; when it fires send `ping`; expect `pong` within N s, else reconnect. [verified] src: https://raw.githubusercontent.com/skip-mev/connect/main/providers/websockets/okx/README.md
- nautilus lists code `60005` as "Connection closed as there was no data transmission in the last 30 seconds" (retryable). Note ccxt's comment uses `60005` for "Invalid OK_ACCESS_KEY" — conflicting meanings, see §12. [verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/consts.rs ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts
- Client cadences observed: ccxt 18 s (`keepAlive: 18000`); tiagosiebler 10 s with 2 s pong timeout; Hummingbot 24 s receive-timeout (`30*0.8`); nautilus `OKX_WS_HEARTBEAT_SECS = 20` (tests use 30); Go 24 s only when idle (`pongWait*8/10`) with a 30 s read deadline. Recommendation: send `ping` every ~15–20 s when idle, reconnect if no `pong` within that window. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/BaseWSClient.ts ; https://raw.githubusercontent.com/hummingbot/hummingbot/master/hummingbot/connector/exchange/okx/okx_constants.py ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/consts.rs ; https://raw.githubusercontent.com/Anode-Trading/okex/master/api/ws/client.go
- Detect `pong` by comparing the raw message string to `'pong'` **before** `JSON.parse` (it is not JSON). Also answer an inbound text `ping` with `pong` (tiagosiebler, nautilus do this). [verified] src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/websocket-util.ts ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/websocket-client.ts ; https://raw.githubusercontent.com/Anode-Trading/okex/master/api/ws/client.go ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/network/src/websocket/consts.rs

### 3.3 Subscribe / unsubscribe
- Request: `{"op":"subscribe","args":[{"channel":"<name>", "instId"|"instType"|"instFamily"|"ccy": ...}, ...]}` with optional top-level `"id"` (echoed back in the response). Unsubscribe is identical with `"op":"unsubscribe"`. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/websocket/WsPublicAsync.py ; https://raw.githubusercontent.com/okxapi/python-okx/master/test/test_ws_public_async.py
- Example args (official tests): `{"channel":"instruments","instType":"FUTURES"}`, `{"channel":"tickers","instId":"BTC-USDT-SWAP"}`, `{"channel":"candle1m","instId":"BTC-USDT"}` (business), `{"channel":"account","ccy":"BTC"}`, `{"channel":"orders","instType":"ANY"}`, `{"channel":"balance_and_position"}`. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/test/test_ws_public_async.py ; https://raw.githubusercontent.com/okxapi/python-okx/master/test/test_ws_private_async.py
- Ack: `{"event":"subscribe","arg":{"channel":"instruments","instType":"SPOT"},"connId":"380cfa6a"}` — one ack per arg. [verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/websocket/messages.rs
- Limits: max 256 args per subscribe/unsubscribe frame (nautilus constant) [likely]; total frame length ≤ 4096 bytes (Go client comment) [likely]. src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/websocket/client.rs ; https://raw.githubusercontent.com/Anode-Trading/okex/master/api/ws/client.go
- The old `uly` subscription parameter was replaced by `instFamily` (error `64000` if used). [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts

### 3.4 Message shapes and dispatch
- **Event frames** (`event` present): `event` ∈ `'error' | 'login' | 'subscribe' | 'unsubscribe' | 'channel-conn-count' | 'notice'`; optional `code`, `msg`, `connId`, `arg`, `data`. `channel-conn-count` adds `channel`, `connId`, `connCount`. [verified] src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/types/websockets/ws-events.ts
- **Data pushes** (no `event`): `{"arg":{"channel":..., "instId"?:..., "instType"?:..., "instFamily"?:..., "uid"?:...}, "data":[...]}`; order-book channels add top-level `"action":"snapshot"|"update"`. Dispatch on presence of `event` first, then on `arg.channel`. [verified] src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/types/websockets/ws-events.ts ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/typeGuards.ts
- **WS-API (trade op) responses**: `{id, op, code, msg, data[], inTime, outTime}`; recognised by string `id` + string `inTime`. See §6.6. [verified] src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/typeGuards.ts ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/types/websockets/ws-api.ts
- ccxt dispatch: `event`/`op` ∈ login, subscribe, unsubscribe, order, batch-orders, amend-order, batch-amend-orders, cancel-order, mass-cancel → handlers; otherwise route on `arg.channel` (books*, tickers, trades, account, orders, orders-algo, balance_and_position, …; any channel starting with `candle` → OHLCV). [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts
- **Error frame**: `{"event":"error","code":"60012","msg":"Illegal request: {...}"}` optionally with `arg`, `connId`. Examples: `60012` Illegal request, `60018` channel doesn't exist, `60005` Invalid OK_ACCESS_KEY (ccxt comment). A trade-op error may be an `event:'error'` whose `msg` embeds the original request JSON (including its `id`). [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts
- ccxt error rule: any `code` not `''`, `'0'` or `'1'` is an error matched against the code map; for `'1'` iterate `data[]` and use each item's `sCode`/`sMsg`; if the frame (or the embedded request JSON) carries an `id`, reject only that request, else reject the whole connection's futures. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts
- Go client rule: a frame with non-empty `id` and non-zero `code` is an error; otherwise `{id, op, code, msg, data}` is a Success event. [verified] src: https://raw.githubusercontent.com/Anode-Trading/okex/master/api/ws/client.go
- **Notice**: `{"event":"notice","code":"64008","msg":"..."}` = "The connection will soon be closed for a service upgrade. Please reconnect." tiagosiebler and nautilus close and reconnect immediately. [verified] src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/websocket-client.ts ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts

### 3.5 Business endpoint routing
- Channels that only work on `/ws/v5/business`: all `candle*` (incl. `candle1s` and `*utc` variants), `mark-price-candle*`, `index-candle*`, `orders-algo`, `algo-advance`, `deposit-info`, `withdrawal-info`, `grid-orders-spot/contract/moon`, `grid-positions`, `grid-sub-orders`, `algo-recurring-buy`. [verified] src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/websocket-util.ts
- Warning: tiagosiebler's `BUSINESS_CHANNELS` list contains a typo entry `'index-candle4H index -candle2H'`, so `index-candle4H`/`index-candle2H` are mis-routed there — do not copy the list verbatim. [verified] src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/websocket-util.ts
- ccxt routes any channel containing `candle`, `orders-algo`, `trades-all` (with login) and the `mass-cancel` op to `/business`; demo adds `?brokerId=9999`. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts
- cryptofeed: candle channel on business; books/trades/tickers/funding-rate/open-interest on public. [verified] src: https://raw.githubusercontent.com/bmoscon/cryptofeed/master/cryptofeed/exchanges/okx.py
- nautilus docs: algo-order status channels (`orders-algo` for stop/touched, `algo-advance` for trailing) are on `/ws/v5/business`. [verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/docs/integrations/okx.md
- Wrong-endpoint errors: `64001` channel migrated to the business URL; `64002` channel not supported by business URL (use `/private` or `/public`). [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
- Login on `/business`: ccxt subscribes candles on business **without** login; the official python-okx test logs in on business before subscribing `candle1m` (`WsPublicAsync.login()` exists "for business channel that requires authentication"). Treat login as optional for public business channels (candles) and mandatory for private ones (`orders-algo`, `deposit-info`, …). [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts ; https://raw.githubusercontent.com/okxapi/python-okx/master/okx/websocket/WsPublicAsync.py ; https://raw.githubusercontent.com/okxapi/python-okx/master/test/test_ws_public_async.py
- `books-l2-tbt` (VIP5+) and `books50-l2-tbt` (VIP4+) are **public**-endpoint channels that nevertheless require the public connection to be logged in (ccxt: "requires authentication for this depth"; the researcher's claim text cites error codes `60029`/`60030`, which are not visible in the quoted snippet). tiagosiebler lists them as `PUBLIC_CHANNELS_WITH_AUTH` (note its entry is spelled `books50-l2-tpt`). [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/websocket-util.ts
- The Go client predates the business endpoint (public/private only, candles via public) — do not use it as a routing reference. [verified] src: https://raw.githubusercontent.com/Anode-Trading/okex/master/api/api.go

---

## 4. Public market-data channels (WebSocket)

All numeric values are **strings**; `ts` fields are epoch milliseconds as strings.

### 4.1 `tickers`
- Subscribe arg: `{"channel":"tickers","instId":"BTC-USDT"}`. Push `data[]` fields: `instType, instId, last, lastSz, askPx, askSz, bidPx, bidSz, open24h, high24h, low24h, sodUtc0, sodUtc8, volCcy24h, vol24h, ts`. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/llms.txt
- Semantics: `lastSz` = base size (spot) or contracts (derivatives); `volCcy24h` = quote volume for spot but **base-amount** for derivatives; `vol24h` = contract/base volume. ccxt uses `volCcy24h` as quoteVolume only for spot. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
- Cadence: tickers 100 ms (ccxt comment). [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts
- REST equivalents return the same object shape (§5.4). [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts

### 4.2 Order-book channels
| Channel | Depth | Cadence / tier | `action` field | checksum / seqId | Login | Conf | Source |
|---|---|---|---|---|---|---|---|
| `bbo-tbt` | 1 | 10 ms, L1 tick-by-tick, public | none — every push is a full snapshot | no | no | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts ; https://raw.githubusercontent.com/hummingbot/hummingbot/master/hummingbot/connector/derivative/okx_perpetual/okx_perpetual_constants.py |
| `books5` | 5 | 100 ms, public | none — every push is a full snapshot (ccxt `orderbook.reset`) | no | no | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts |
| `books` | 400 | 100 ms (Hummingbot constant name `..._400_DEPTH_100_MS_...`), public | `snapshot` first, then `update` | yes (`checksum`, `prevSeqId`, `seqId`) | no | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts ; https://raw.githubusercontent.com/hummingbot/hummingbot/master/hummingbot/connector/derivative/okx_perpetual/okx_perpetual_constants.py |
| `books-rpi` | 400 | 100 ms, public | snapshot/update | **no checksum** (nautilus) | no | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/docs/integrations/okx.md |
| `books-l2-tbt` | 400 | tick-by-tick, VIP5 + identity verification | snapshot/update | yes | **yes** (on public socket) | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts |
| `books50-l2-tbt` | 50 | tick-by-tick, VIP4 + identity verification | snapshot/update | yes | **yes** (on public socket) | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts |

- Subscribe arg: `{"channel":"books","instId":"BTC-USDT"}` (okx-rs maps books5, books, bbo-tbt, books-l2-tbt the same way). [verified] src: https://raw.githubusercontent.com/roytang121/okx-rs/dev/src/websocket/conn.rs
- Wire shape (`books`): `{"arg":{"channel":"books","instId":"BTC-USDT"},"action":"snapshot","data":[{"asks":[["8476.98","415","0","13"],...],"bids":[...],"ts":"1597026383085","checksum":-855196043,"prevSeqId":-1,"seqId":123456}]}`; update: `{"arg":{"channel":"books","instId":"ETH-USDT"},"action":"update","data":[{"asks":[["3000.5","2","0","3"]],"bids":[["2999.5","4","1","5"]],"ts":"1640995200001","checksum":-42,"prevSeqId":1001,"seqId":1002}]}`. [verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/test_data/ws_books_snapshot.json ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/websocket/messages.rs
- Level format: 4-element string array `[price, size, liquidatedOrdersCount, ordersCount]`; a `size` of `"0"` means delete that price level. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/websocket/messages.rs
- `action` has exactly two values: `snapshot` (full) and `update` (incremental), lowercase. [verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/enums.rs
- `checksum` is an optional **signed 32-bit** integer (can be negative); `prevSeqId` optional, "Only applicable to books, books-l2-tbt, books50-l2-tbt"; `seqId` unsigned. `books5` / `bbo-tbt` frames have `asks, bids, ts` (books5 also `instId`) and no action/checksum/seqId. [verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/websocket/messages.rs ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts

**Sequence (seqId / prevSeqId) rule**
- Each update's `prevSeqId` must equal the last accepted `seqId`; values need not increase by exactly 1; a snapshot carries `prevSeqId: -1`; a mismatch means the book is out of sync → resync by re-subscribing for a fresh snapshot. ccxt validates `prevSeqId` against the stored `seqId` unless `prevSeqId === -1`. [verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/docs/integrations/okx.md ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/book/sync.rs ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts
- cryptofeed variant: if `prevSeqId == -1` or nothing stored → accept and store; if `seqId == last && prevSeqId == last` → duplicate frame, skip; else `prevSeqId` must equal last or raise. [verified] src: https://raw.githubusercontent.com/bmoscon/cryptofeed/master/cryptofeed/exchanges/okx.py
- okx-rs: `seqId < prevSeqId` indicates a sequence reset due to maintenance; duplicate `seqId` ignored; first update must be a snapshot. [verified] src: https://raw.githubusercontent.com/roytang121/okx-rs/dev/src/book/book_manager.rs
- nautilus recovery triggers: sequence gap, initial subscribe send failure, snapshot timeout, venue rejection; on a gap it drops the batch and suppresses increments until a new snapshot (`prevSeqId: -1`) is accepted; reconnect resets book sync. [verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/docs/integrations/okx.md

**Checksum retired (2026-06-23)**: `books`, `books-l2-tbt` and `books50-l2-tbt` still carry the `checksum` field, but its value is fixed to `0` and must not be used for verification; OKX directs clients to `seqId`/`prevSeqId`. Observed on 2026-10-03 on both the live and the demo `books` feed (every snapshot and update had `checksum: 0`). `LocalOrderBook` therefore never compares the checksum, whatever its value (mock-okx still sends real ones), and relies on `seqId`/`prevSeqId` alone; the algorithm below is kept for reference and as the `bookChecksum` helper. [verified] src: https://www.okx.com/docs-v5/log_en/

**Checksum algorithm** (CRC32; reference implementations cryptofeed v1.9.3 and bmoscon/orderbook C — ccxt, nautilus, okx-rs and tiagosiebler do NOT implement it)
1. Take the top **25** bids (price descending) and top 25 asks (price ascending), using the **raw price/size strings** from the payload (do not re-format numbers). [verified] src: https://raw.githubusercontent.com/bmoscon/cryptofeed/v1.9.3/cryptofeed/exchanges/okex.py
2. Render each level as `price:size`. [verified] src: https://raw.githubusercontent.com/bmoscon/cryptofeed/v1.9.3/cryptofeed/exchanges/okex.py
3. Interleave `bid1, ask1, bid2, ask2, ...`; if one side has fewer than 25 levels, append the remaining levels of the longer side after the interleaved part. [verified] src: https://raw.githubusercontent.com/bmoscon/cryptofeed/v1.9.3/cryptofeed/exchanges/okex.py ; https://raw.githubusercontent.com/bmoscon/orderbook/master/orderbook/orderbook.c
4. Join everything with `:` (no trailing separator) and compute CRC32 (zlib.crc32 / IEEE) over the UTF-8 bytes → unsigned 32-bit. [verified] src: https://raw.githubusercontent.com/bmoscon/cryptofeed/v1.9.3/cryptofeed/exchanges/okex.py ; https://raw.githubusercontent.com/bmoscon/orderbook/master/orderbook/orderbook.c
5. Compare with the server's signed `checksum` converted to unsigned: `checksum & 0xFFFFFFFF` (JS: `checksum >>> 0`). Apply after each snapshot and after applying each update. [verified] src: https://raw.githubusercontent.com/bmoscon/cryptofeed/v2.4.0/cryptofeed/exchanges/okx.py
- Combined reading: the string layout is `bidPx:bidSz:askPx:askSz:bidPx:bidSz:...` for the top 25 levels per side. [likely] src: https://raw.githubusercontent.com/bmoscon/cryptofeed/v1.9.3/cryptofeed/exchanges/okex.py
- ccxt only validates seqId/prevSeqId and keeps the checksum in comments; its base class exposes a generic "orderbook data checksum validation failed" error. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/base/Exchange.ts

```ts
// Order-book checksum (TypeScript pseudo-code). bids sorted by price desc, asks asc; keep raw strings.
function okxChecksum(bids: [string, string][], asks: [string, string][]): number {
  const b = bids.slice(0, 25).map(([px, sz]) => `${px}:${sz}`);
  const a = asks.slice(0, 25).map(([px, sz]) => `${px}:${sz}`);
  const parts: string[] = [];
  const n = Math.min(b.length, a.length);
  for (let i = 0; i < n; i++) parts.push(b[i], a[i]);     // bid, ask, bid, ask, ...
  parts.push(...b.slice(n), ...a.slice(n));               // leftover levels of the longer side
  return crc32(Buffer.from(parts.join(':'), 'utf8')) >>> 0; // unsigned CRC32
}
const ok = okxChecksum(bids, asks) === (msg.data[0].checksum >>> 0); // server value is signed int32
```

### 4.3 `trades` / `trades-all`
- `trades` arg `{"channel":"trades","instId":"BTC-USDT"}`; push `data[]`: `instId, tradeId, px, sz, side ('buy'|'sell'), ts`, plus `count` (number of aggregated trades; absent on spread trades), optional `source` (`0` normal, `1` RPI) and optional `seqId`. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/websocket/messages.rs
- `trades-all` adds `source`; ccxt routes it to the **business** endpoint with login. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts

### 4.4 Candles (`candle<bar>`) — business endpoint
- Channel name = `'candle' + bar` (e.g. `candle1m`, `candle1D`); arg `{"channel":"candle1m","instId":"BTC-USDT"}`; ccxt recovers the timeframe by stripping the `candle` prefix. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts ; https://raw.githubusercontent.com/okxapi/python-okx/master/test/test_ws_public_async.py
- Row: `[ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]` — `vol` = base amount (spot/margin) or contracts (derivatives); `volCcy` = quote amount (spot) or base amount (derivatives); `volCcyQuote` = quote amount; `confirm` `"0"` = still forming, `"1"` = complete. ccxt uses index 5 as volume for spot and index 6 for derivatives. [verified] src: https://raw.githubusercontent.com/bmoscon/cryptofeed/master/cryptofeed/exchanges/okx.py ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/enums.rs
- `bar` values are case-sensitive: minutes lowercase `1m,3m,5m,15m,30m`; hours/days/weeks/months uppercase `1H,2H,4H,6H,12H,1D,1W,1M,3M` (tiagosiebler's business list also has `1s,2D,3D,5D,6M,1Y`). ccxt appends `utc` for bars ≥ 6 h when the timezone option is UTC (e.g. `6Hutc`, `1Dutc`). [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/websocket-util.ts ; https://raw.githubusercontent.com/bmoscon/cryptofeed/master/cryptofeed/exchanges/okx.py
- Older ccxt sample rows have 7 elements; current rows have 9 — parse defensively (`closed = row.length > 8 && row[8] === '1'`). [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts ; https://raw.githubusercontent.com/bmoscon/cryptofeed/master/cryptofeed/exchanges/okx.py

### 4.5 `mark-price`
- Public endpoint; push `data[]`: `instId, markPx, ts` (no bid/ask fields — must not overwrite a bid/ask cache). ccxt routes it to `handleTicker`. [verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/websocket/messages.rs ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts

### 4.6 `funding-rate`
- Push fields: `fundingRate, fundingTime, instId, instType, method, maxFundingRate, minFundingRate, nextFundingRate, nextFundingTime, premium, settFundingRate, settState, ts`. ccxt notes `nextFundingRate` is actually **two** funding periods ahead and derives the interval as `nextFundingTime - fundingTime`. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts

### 4.7 Other public channel names seen (fields not captured in the notes)
- `instruments` (arg `instType`), `index-tickers`, `open-interest`, `trades-all`. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/test/test_ws_public_async.py ; https://raw.githubusercontent.com/hummingbot/hummingbot/master/hummingbot/connector/derivative/okx_perpetual/okx_perpetual_constants.py ; https://raw.githubusercontent.com/bmoscon/cryptofeed/master/cryptofeed/exchanges/okx.py

---

## 5. REST market / public endpoints

All responses are `{code, msg, data:[...]}`; all params are strings. Paths from python-okx `consts.py`. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/consts.py

### 5.1 `GET /api/v5/public/instruments`
- Params: `instType` (required: `SPOT|MARGIN|SWAP|FUTURES|OPTION`), optional `uly`, `instId`, `instFamily`; options require `uly` (ccxt loops `BTC-USD`, `ETH-USD`). [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/PublicData.py
- Fields: `instType, instId, uly, instFamily, category, baseCcy, quoteCcy, settleCcy, ctVal, ctMult, ctValCcy, optType, stk, listTime, expTime, lever, tickSz, lotSz, minSz, ctType, alias, state, maxLmtSz, maxMktSz, maxTwapSz, maxIcebergSz, maxTriggerSz, maxStopSz, ruleType, auctionEndTime` + optional `maxLmtAmt, maxMktAmt, openType, contTdSwTime, preMktSwTime`. [verified] src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/llms.txt ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
- Semantics used by ccxt: `contractSize = ctVal`, amount precision = `lotSz`, price precision = `tickSz`, min amount = `minSz`, max limit amount = `maxLmtSz`, `maxMktSz` = max market size, `lever` = max leverage, `state` for active status; `alias` ∈ this_week/next_week/quarter/next_quarter (futures); for SWAP `ctVal/ctValCcy/settleCcy/ctType` populated. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
- `ctType` ∈ `linear | inverse | ''` (empty for non-contracts). `state` values: live, suspend, rebase (SWAP), post_only (SWAP), preopen, test, expired, settling. [verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/enums.rs ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/llms.txt
- nautilus: derivative multiplier = `ctMult * ctVal` (missing field defaults to 1; SPOT has both empty). [verified for code] / [likely for the "keeps sizing aligned" statement] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/parse.rs ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/docs/integrations/okx.md
- Rows may be `preopen` placeholders with empty `instId` — skip them; in demo mode ccxt also skips `instFamily` starting with `TEST`. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts

### 5.2 `GET /api/v5/market/candles` and `GET /api/v5/market/history-candles`
- Params (both): `instId` (required), `bar`, `after`, `before`, `limit`. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/MarketData.py ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/llms.txt
- `candles`: `limit` default 100, max **300** (max 100 for mark-price/index candles). [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
- `history-candles`: nautilus documents ≤ **100** rows/call (20 req/2 s) and uses it when the requested start is older than ~100 days; ccxt requests up to **300** and switches to it when `since` is older than `(1440-1)` bars. **Conflict → cap at 100 unless a live test shows 300 works** (see §12). [verified for both behaviours] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/http/client.rs ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
- Row format identical to the WS candle row: `["1678928760000","24341.4","24344","24313.2","24323","628","2.5819","62800","0"]` = `[ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]`. Rows are returned **newest first** (descending `ts`). [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/llms.txt
- Windowing (ccxt): `before = since - 1`, `after = since + duration*limit`; `after = until`. nautilus pages backwards with `before`. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/http/client.rs
- Related paths: `/api/v5/market/index-candles`, `/api/v5/market/mark-price-candles`. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/consts.py

### 5.3 `GET /api/v5/market/books` (and `books-full`)
- Params: `instId` (required), `sz` (depth; max 400; ccxt default 100). `books-full` exists for deeper books (ccxt default 5000). `books-rpi` returns code `51000` above 400. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/MarketData.py ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
- Response: `data:[{asks:[[price, amount, liquidatedOrders, totalOpenOrders],...], bids:[...], ts}]`; TS type `OrderBookLevel = [price, qty, '0', orderCount]`. RPI variant levels `[price, totalQty, nonRpiQty, count]` with `seqId`. `seqId` on the plain REST snapshot is optional/unresolved. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/llms.txt

### 5.4 `GET /api/v5/market/ticker` and `GET /api/v5/market/tickers`
- `ticker`: `instId`. `tickers`: `instType` (+ optional `uly`, `instFamily`). Object shape identical to the WS `tickers` push (§4.1). [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/MarketData.py ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts

### 5.5 `GET /api/v5/market/trades` and `history-trades`
- `trades`: `instId`, `limit` (default 100; ccxt max page 100). Rows `{instId, side, sz, px, tradeId, ts}` newest first; ccxt paginates by `tradeId` cursor via `after`. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/MarketData.py ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
- `history-trades`: `instId, type, after, before, limit`. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/MarketData.py

### 5.6 `GET /api/v5/public/funding-rate` and `funding-rate-history`
- `funding-rate?instId=` (SWAP only). Fields: `instType, instId, method, formulaType, fundingRate, nextFundingRate, fundingTime, nextFundingTime, minFundingRate, maxFundingRate, interestRate, impactValue, settState, settFundingRate, premium, ts`. `funding-rate-history`: `instId, after, before, limit`. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/llms.txt ; https://raw.githubusercontent.com/okxapi/python-okx/master/okx/consts.py

### 5.7 `GET /api/v5/public/mark-price`
- Params: `instType` (required), optional `uly`, `instId`, `instFamily`. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/PublicData.py

### 5.8 `GET /api/v5/public/time`
- No params; `data[0].ts` = epoch ms string. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/okxapi/python-okx/master/okx/consts.py

---

## 6. Trading endpoints (REST) and WS trade operations

Paths (python-okx `consts.py`): `/api/v5/trade/order` (POST place, GET details), `/api/v5/trade/batch-orders`, `/api/v5/trade/cancel-order`, `/api/v5/trade/cancel-batch-orders`, `/api/v5/trade/amend-order`, `/api/v5/trade/amend-batch-orders`, `/api/v5/trade/close-position`, `/api/v5/trade/orders-pending`, `/api/v5/trade/orders-history`, `/api/v5/trade/orders-history-archive`, `/api/v5/trade/fills`, `/api/v5/trade/fills-history`. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/consts.py ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/rest-client.ts

### 6.1 `POST /api/v5/trade/order` — place order
| Param | Required | Values / notes | Conf | Source |
|---|---|---|---|---|
| `instId` | yes | e.g. `BTC-USDT-SWAP` | [verified] | https://raw.githubusercontent.com/okxapi/python-okx/master/okx/Trade.py |
| `tdMode` | yes | `cross \| isolated \| cash \| spot_isolated` (TS type). Futures mode: `cash` for SPOT, `cross`/`isolated` for MARGIN/FUTURES/SWAP/OPTION; Multi-currency / Portfolio margin use `cross` | [verified] (type) / [likely] (descriptions) | https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/types/rest/shared.ts ; https://raw.githubusercontent.com/aahl/mcp-okx/master/mcp_okx/trading.py |
| `side` | yes | `buy \| sell` | [verified] | https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/types/rest/shared.ts |
| `ordType` | yes | `market, limit, post_only, fok, ioc, optimal_limit_ioc` (+ `mmp, mmp_and_post_only, elp, rpi`). post_only = cancelled if it would execute on placement; fok = cancel unless fully filled; ioc = fill what you can, cancel rest; optimal_limit_ioc = market-with-ioc, only Expiry/Perpetual Futures | [verified] (values) / [likely] (descriptions) | https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/types/rest/shared.ts ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/aahl/mcp-okx/master/mcp_okx/trading.py |
| `sz` | yes | quantity; for FUTURES/SWAP/OPTION = **number of contracts** (multiples of `lotSz`, ≥ `minSz`; error `51121` if not a lot-size multiple, `51007` if < 1 contract). ccxt maps `contractSize = ctVal` | [likely] (docs mirror) / [verified] (ccxt mapping) | https://raw.githubusercontent.com/aahl/mcp-okx/master/mcp_okx/trading.py ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| `px` | for limit-type | only for `limit, post_only, fok, ioc, mmp, mmp_and_post_only` | [likely] | https://raw.githubusercontent.com/aahl/mcp-okx/master/mcp_okx/trading.py |
| `posSide` | hedge mode | `net \| long \| short`. Required in long/short mode (FUTURES/SWAP only), must be `long`/`short`; in net mode omit or `net`. Open long = buy+long; open short = sell+short; close long = sell+long; close short = buy+short | [verified] (type/ccxt) / [likely] (combinations text) | https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/types/rest/shared.ts ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/aahl/mcp-okx/master/mcp_okx/trading.py |
| `reduceOnly` | no | `true`/`false` (default false); only MARGIN orders and FUTURES/SWAP in **net** mode. python-okx sends a string, TS type is boolean; in long/short mode ccxt omits it and uses the opposite `posSide` instead (buy→`short`, sell→`long`) | [likely] (rule) / [verified] (ccxt behaviour) | https://raw.githubusercontent.com/aahl/mcp-okx/master/mcp_okx/trading.py ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| `clOrdId` | no | 1–32 chars, case-sensitive **alphanumeric only** (nautilus rejects hyphens/underscores); must be unique | [verified] | https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/consts.rs ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| `tag` | no | broker tag; docs mirror says up to 16 chars (ccxt's older comment says 8). Omit for self-use | [likely] | https://raw.githubusercontent.com/aahl/mcp-okx/master/mcp_okx/trading.py ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| `ccy`, `tgtCcy`, `stpMode` (`cancel_maker\|cancel_taker\|cancel_both`, default cancel_maker), `attachAlgoOrds`, `pxUsd`, `pxVol`, `banAmend`, `tradeQuoteCcy`, `pxAmendType` (`'0'` no amend / `'1'` allow within price limit), `isElpTakerAccess`, `instIdCode` | no | optional | [verified] | https://raw.githubusercontent.com/okxapi/python-okx/master/okx/Trade.py ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/types/rest/request/trade.ts |

- Example (official test): `instId=BTC-USDT-SWAP, tdMode=isolated, clOrdId=asCai1234, side=buy, posSide=long, ordType=limit, sz="1", px="30000.0"`. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/test/test_trade.py
- Response `data[0]`: `{clOrdId, ordId, tag, ts, sCode, sMsg, subCode?}`; `sCode "0"` = success; any other `sCode` = rejected (ccxt marks status `rejected`). Failure example: top-level `code "1"`, `data[0] = {clOrdId:"", ordId:"", sCode:"51119", sMsg:"Order placement failed due to insufficient balance. ", tag:""}`. [verified] src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/types/rest/response/private-trade.ts ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
- `51149` = order request timed out, outcome unknown → reconcile via order query / `orders` channel, never assume rejection; likewise `50004`. [verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/consts.rs ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts

### 6.2 `POST /api/v5/trade/batch-orders`
- Body is a JSON **array** of order objects (max 20 per batch); response `OrderResult[]` with per-item `sCode`/`sMsg`; top-level `code "2"` = partial success. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/okxapi/python-okx/master/test/test_ws_private_async.py

### 6.3 `POST /api/v5/trade/cancel-order` / `cancel-batch-orders`
- Params: `instId` (required) + `ordId` **or** `clOrdId`; if both are passed `ordId` is used. Response: `{"code":"0","data":[{"clOrdId":"","ordId":"317251910906576896","sCode":"0","sMsg":""}],"msg":""}` (TS type adds `ts`). [verified] (params/response) / [likely] (precedence) src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/aahl/mcp-okx/master/mcp_okx/trading.py ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/types/websockets/ws-api.ts
- Codes: `51400` order does not exist, `51401` already canceled, `51402` already completed, `51407` ordId or clOrdId required, `51410` already under cancelling. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts

### 6.4 `POST /api/v5/trade/amend-order` / `amend-batch-orders`
- Params: `instId` (required), `ordId`/`clOrdId`, `cxlOnFail` (boolean in TS type), `reqId`, `newSz`, `newPx`, plus `newTpTriggerPx, newTpOrdPx, newSlTriggerPx, newSlOrdPx, newTpTriggerPxType, newSlTriggerPxType, attachAlgoOrds, newTriggerPx, newOrdPx, pxAmendType, newTpTriggerRatio, newSlTriggerRatio`. ccxt formats `newSz` with amount precision and `newPx` with price precision. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/Trade.py ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
- Response `data[0]`: `{clOrdId, ordId, reqId, sCode, sMsg, subCode?}`. [verified] src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/types/rest/response/private-trade.ts ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
- Codes: `51500` price or amount required, `51501` max N orders modifiable, `51502` insufficient margin, `51503` order does not exist. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts

### 6.5 `POST /api/v5/trade/close-position`
- Params: `instId`, `mgnMode` (`cross|isolated`, required), `posSide` (required in long/short mode: `long`/`short`; net mode: omit or `net`), optional `ccy`, `autoCxl` (boolean), `clOrdId`, `tag`. ccxt defaults `mgnMode` to `cross` and maps side buy→`long`, sell→`short`. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/Trade.py ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/types/rest/request/trade.ts ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
- Success response `data[0] = {instId, posSide}`. Failure sample: `{"code":"1","data":[{"clOrdId":"...","ordId":"","sCode":"51000","sMsg":"Parameter posSide error ","tag":"..."}],"inTime":"1701877077101064","msg":"All operations failed","outTime":"1701877077102579"}`. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts

### 6.6 WebSocket trade operations (`/ws/v5/private`, after login)
- Request envelope: `{"id": "<optional id>", "op": "<op>", "expTime"?: "<string>", "args": [ {...}, ... ]}`; `args` is always an array. Ops: `order, batch-orders, cancel-order, batch-cancel-orders, amend-order, batch-amend-orders, mass-cancel`. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/websocket/WsPrivateAsync.py ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/types/websockets/ws-api.ts ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/websocket-client.ts
- Response: `{"id":"1689281055","op":"batch-orders","code":"0","msg":"","data":[{"tag":"...","ordId":"599823446566084608","clOrdId":"...","sCode":"0","sMsg":"Order successfully placed."}],"inTime":"...","outTime":"..."}` — `id` and `op` are echoed; match pending requests by `id` (tiagosiebler key = `${id}_${op}`); filter `data` by `sCode === '0'` for successes. Example error: `code "1"` with `data[0].sCode "51008"`, `sMsg "Order failed. Insufficient USDT balance in account."`. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/websocket-client.ts ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/websocket-util.ts
- Typed response data: `order`/`amend-order` → `[OrderResult]`; `batch-orders` → `OrderResult[]`; `cancel-order` → `[{clOrdId, ordId, ts, sCode, sMsg}]`; `mass-cancel` → `[{result: boolean}]`. [verified] src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/types/websockets/ws-api.ts
- `id` formats used: ccxt = ms timestamp + 4 random digits (numeric string); tiagosiebler = string counter; python-okx tests `"order001"`, `"cancel001"`. Exact charset/length constraint unresolved (see §12). [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts ; https://raw.githubusercontent.com/okxapi/python-okx/master/test/test_ws_private_async.py
- `order` arg mirrors the REST place-order body (`instId, tdMode, clOrdId, side, posSide, ordType, sz, px, tag, reduceOnly, stpMode, ...`). ccxt defaults op to `batch-orders` even for a single order and only allows `order`/`batch-orders`. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/test/test_ws_private_async.py ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/types/websockets/ws-api-request.ts ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts
- `instIdCode` migration: tiagosiebler types say `instId` is deprecated for WS place-order since March 2026 and ignored on WS cancel since 2026-04-07 (use `ordId`/`clOrdId`, optionally `instIdCode` from `GET /public/instruments`); ccxt already substitutes `instIdCode` when the market carries one. REST still uses `instId`. Whether WS still accepts `instId` as of 2026-10 is unresolved. [verified] src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/types/websockets/ws-api-request.ts ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/types/rest/request/trade.ts ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts
- `cancel-order` arg (official test): `{"instId":"BTC-USDT","ordId":"..."}` or `{"instId":..., "clOrdId":"client_order_001"}`. `amend-order` arg: `{"instId":"BTC-USDT","ordId":"...","newSz":"0.002","newPx":"31000"}`. Batch ops: max 20 orders. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/test/test_ws_private_async.py
- `mass-cancel`: sent on `/ws/v5/business`, rate limit 1 request/second; args contain `instType` and `instFamily`. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/websocket/WsPrivateAsync.py
- nautilus WS order: `sz` = quantity string as-is (contract units for derivatives), `px` = price string, `{id, op:'order', expTime: null, args:[params]}`. [verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/websocket/client.rs

### 6.7 Order queries
- `GET /api/v5/trade/order`: `instId` (required) + `ordId` or `clOrdId`. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/Trade.py
- `GET /api/v5/trade/orders-pending`: all optional — `instType, uly, instId, ordType, state (live|partially_filled), after, before (order IDs), limit (default 100, max 100), instFamily`. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/Trade.py ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
- `GET /api/v5/trade/orders-history` (last 7 days) requires `instType`; optional `uly, instId, ordType, state (canceled|filled|mmp_canceled), after, before, begin, end, limit, instFamily`. `orders-history-archive` (3 months) has the same params. [verified] (params) / [likely] (state filter values from docs mirror) src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/Trade.py ; https://raw.githubusercontent.com/aahl/mcp-okx/master/mcp_okx/trading.py
- Order object fields: `instType, instId, ccy, ordId, clOrdId, tag, px, sz, pnl, ordType, side, posSide, tdMode, accFillSz, fillPx, tradeId, fillSz, fillTime, state, avgPx, lever, tpTriggerPx/tpOrdPx/slTriggerPx/slOrdPx (tp/sl fields), attachAlgoOrds, feeCcy, fee, rebateCcy, rebate, tgtCcy, category, uTime, cTime` (+ `reduceOnly` as string `'true'/'false'`, `stpMode`, `isTpLimit`). [verified] src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/types/rest/response/private-trade.ts ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
- Semantics: `accFillSz` = accumulated filled qty; `fillSz` = **last** filled qty; `avgPx` = average fill price (`""` if none); `state` ∈ `canceled|live|partially_filled|filled|mmp_canceled`; `category` ∈ `normal|twap|adl|full_liquidation|partial_liquidation|delivery|ddh|auto_conversion`. [likely] src: https://raw.githubusercontent.com/aahl/mcp-okx/master/mcp_okx/trading.py
- ccxt status map: `live`/`partially_filled` → open; `filled` → closed; `canceled`/`mmp_canceled`/`order_failed` → canceled. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
- Parsing hints (ccxt): id = `ordId`; timestamps `cTime` (created), `uTime` (updated), `fillTime` (last trade); filled = `accFillSz`; average = `avgPx`; fee = `fee` + `feeCcy` with `fee` negative (e.g. `"-0.00026284"`); empty-string `clOrdId` = none; `reduceOnly === 'true'`. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
- WS-only order fields (present on the `orders` channel but not REST): `reqId, msg, amendResult, code, fillNotionalUsd, fillPnl, fillFee, fillFeeCcy, execType, notionalUsd, lastPx`. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts

### 6.8 Fills
- `GET /api/v5/trade/fills` (last 3 days): optional `instType, uly, instId, ordId, after, before, limit, instFamily, begin, end`. `GET /api/v5/trade/fills-history` (3 months) requires `instType`. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/Trade.py
- Fill fields: `instType, instId, tradeId, ordId, clOrdId, billId, tag, fillPx, fillSz, side, posSide, execType ('T' taker | 'M' maker), feeCcy, fee (negative), ts`; paginate with `after`/`before` = `billId`. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/types/rest/response/private-trade.ts


---

## 7. Account endpoints (REST)

Paths (python-okx `consts.py`): `/api/v5/account/balance`, `/api/v5/account/positions`, `/api/v5/account/config`, `/api/v5/account/set-position-mode`, `/api/v5/account/set-leverage`, `/api/v5/account/leverage-info`, `/api/v5/account/max-size`, `/api/v5/account/max-avail-size`, `/api/v5/account/position/margin-balance`, `/api/v5/account/bills`, `/api/v5/account/bills-archive`, `/api/v5/account/max-loan`, `/api/v5/account/trade-fee`. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/consts.py

### 7.1 `GET /api/v5/account/config`
- No params. Fields: `acctLv, acctStpMode, autoLoan, ctIsoMode, mgnIsoMode, greeksType, ip, kycLv, label, level, levelTmp, liquidationGear, mainUid, uid, opAuth, perm ("read_only,withdraw,trade"), posMode, roleType, traderInsts, spotRoleType, spotTraderInsts, type, enableSpotBorrow, spotBorrowAutoRepay, feeType, settleCcy, settleCcyList`. [verified] (sampled fields) src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
- `acctLv`: `1` Spot mode, `2` Futures mode, `3` Multi-currency margin, `4` Portfolio margin. `posMode`: `long_short_mode` (long/short, FUTURES/SWAP only) or `net_mode`. TS types: `AccountLevel '1'|'2'|'3'|'4'`, `PosMode 'long_short_mode'|'net_mode'`. [likely] (meanings) / [verified] (enum values) src: https://raw.githubusercontent.com/aahl/mcp-okx/master/mcp_okx/account.py ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
- ccxt derives `hedged = (posMode === 'long_short_mode')`. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts

### 7.2 `POST /api/v5/account/set-position-mode`
- Body `{"posMode": "long_short_mode" | "net_mode"}` → `data[0] = {posMode}`. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/okxapi/python-okx/master/test/test_account.py

### 7.3 `GET /api/v5/account/balance`
- Param: optional `ccy` (comma-separated); python-okx sends it only when non-empty. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/Account.py ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/types/rest/response/private-account.ts
- `data[0]` fields: `totalEq, adjEq, availEq, imr, mmr, mgnRatio, notionalUsd, ordFroz, isoEq, uTime, upl, spotCopyTradingEq, details[]`. `details[]`: `ccy, eq, availEq, cashBal, availBal, frozenBal, ordFrozen, upl, uplLiab, isoEq, disEq, eqUsd, crossLiab, twap, uTime` (and more). [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/types/rest/response/private-account.ts
- Semantics: `totalEq` = total equity in USD; `isoEq` = isolated margin equity in USD; `adjEq` = adjusted/effective equity in USD; account-level `availEq` applies to Multi-currency/Portfolio margin; `details.eq` = equity of currency; `details.cashBal` = cash balance; `details.availBal` = available balance; `details.frozenBal` = frozen balance. [likely] src: https://raw.githubusercontent.com/aahl/mcp-okx/master/mcp_okx/account.py
- ccxt parsing: total = `details.eq`; free = `details.availEq` if present else `availBal` (used = `frozenBal`); timestamp = `data[0].uTime`. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts

### 7.4 `GET /api/v5/account/positions`
- Params (all optional): `instType` (`MARGIN|SWAP|FUTURES|OPTION`), `instId` (comma-separated allowed), `posId` (up to 20 comma-separated). [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/Account.py ; https://raw.githubusercontent.com/okxapi/python-okx/master/test/test_account.py
- Fields: `adl, availPos, avgPx, cTime, ccy, deltaBS, deltaPA, gammaBS, gammaPA, imr, instId, instType, interest, last, lever, liab, liabCcy, liqPx, markPx, margin, mgnMode, mgnRatio, mmr, notionalUsd, optVal, pos, posCcy, posId, posSide, thetaBS, thetaPA, tradeId, uTime, upl, uplRatio, vegaBS, vegaPA` (+ `idxPx`, `pTime` on WS). [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts
- `pos` sign: in **net** mode `pos > 0` = long, `pos < 0` = short; in long/short mode `pos` is positive and `posSide` gives direction. ccxt: collateral for `isolated` = `margin`, for `cross` = `imr + upl`. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
- Semantics (docs mirror): `avgPx` = average open price; `markPx` = latest mark price; `upl`/`uplRatio` computed by mark price; `liqPx` = estimated liquidation price; `imr` initial margin requirement; `margin` = margin (can be added/reduced); `mgnRatio` = maintenance margin ratio; `mmr` = maintenance margin requirement; `notionalUsd`; `adl` 0–5; `ccy` = margin currency. [likely] src: https://raw.githubusercontent.com/aahl/mcp-okx/master/mcp_okx/account.py

### 7.5 `POST /api/v5/account/set-leverage`
- Params: `lever` (string), `mgnMode` (`cross|isolated`), `instId` (for SWAP), `ccy` (for cross MARGIN), `posSide` (`long|short`; required for isolated in long/short mode — ccxt adds it only for isolated, allowing `net` too). ccxt validates 1 ≤ leverage ≤ 125. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/Account.py ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/types/rest/request/account.ts
- Response `data[0] = {instId:"BTC-USDT-SWAP", lever:"5", mgnMode:"isolated", posSide:"long"}`. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts

### 7.6 `GET /api/v5/account/leverage-info`
- Params: `instId` (comma-separated allowed), `mgnMode` (required), `ccy`. Response `data[]` = `{instId, lever (e.g. "5.00000000"), mgnMode, posSide}` — one entry per posSide in long/short mode, `posSide:"net"` in net mode. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/okxapi/python-okx/master/okx/Account.py

### 7.7 `GET /api/v5/account/max-avail-size`
- Params: `instId`, `tdMode`, optional `ccy`, `reduceOnly`, `unSpotOffset`, `quickMgnType`, `tradeQuoteCcy` → `{instId, availBuy, availSell}`. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/Account.py

---

## 8. Private WebSocket channels (`/ws/v5/private`, after login)

- Subscribe after the login ack: `{"op":"subscribe","args":[...],"id"?}`; python-okx logs in, waits 5 s, then subscribes. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/websocket/WsPrivateAsync.py
- Typed args: `orders | positions | orders-algo | liquidation-warning` → `{channel, instType: SPOT|MARGIN|SWAP|FUTURES|OPTION|EVENTS|'ANY', instFamily?, instId?}`; `account | account-greeks | withdrawal-info` → `{channel, ccy?}`; `balance_and_position` → `{channel}` only. [verified] src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/types/websockets/ws-request.ts
- Private channel list: `account, positions, balance_and_position, orders, orders-algo, algo-advance, liquidation-warning, account-greeks, grid-*` (of these `orders-algo`, `algo-advance`, `grid-*` go to `/business`). [verified] src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/websocket-util.ts
- ccxt: `orders` with `{instType: 'SWAP'}` (uppercase) + optional `instId`; `positions` with `{instType:'ANY'}`; `account` with no extra args. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts

### 8.1 `orders`
- Push: `{"arg":{"channel":"orders","instType":"SPOT"},"data":[{...full order object...}]}` with fields `accFillSz, amendResult, avgPx, cTime, category, ccy, clOrdId, code, execType, fee, feeCcy, fillFee, fillFeeCcy, fillNotionalUsd, fillPx, fillSz, fillTime, instId, instType, lever, msg, notionalUsd, ordId, ordType, pnl, posSide, px, rebate, rebateCcy, reqId, side, slOrdPx, slTriggerPx, state, sz, tag, tdMode, tgtCcy, tpOrdPx, tpTriggerPx, tradeId, uTime` (+ `fillPnl`, `lastPx`). [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
- Deriving a fill from an `orders` push: `fillTime`, `tradeId`, `fillPx`, `fillSz`, `fillFee`, `fillFeeCcy`, `execType` (`'T'` taker else maker). [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts

### 8.2 `positions`
- Push: `{"arg":{"channel":"positions","instType":"ANY","instId":"XRP-USDT-SWAP","uid":"..."},"data":[{adl, availPos, avgPx, cTime, ccy, idxPx, imr, instId, instType, last, lever, liqPx, margin, markPx, mgnMode, mgnRatio, mmr, notionalUsd, pTime, pos, posCcy, posId, posSide, tradeId, uTime, upl, ...}]}`. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts

### 8.3 `account`
- Push: `{"arg":{"channel":"account","uid":"..."},"eventType":"snapshot","curPage":1,"lastPage":true,"data":[{adjEq, availEq, details:[{availBal, availEq, cashBal, ccy, eq, eqUsd, frozenBal, ordFrozen, uTime, upl, ...}], imr, isoEq, mgnRatio, mmr, notionalUsd, ordFroz, totalEq, uTime, upl}]}` (same object as REST balance). [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts

### 8.4 `balance_and_position`
- Push: `{"arg":{"channel":"balance_and_position","uid":"..."},"data":[{"pTime":"...","eventType":"snapshot","balData":[{"ccy","cashBal","uTime"}],"posData":[{"posId","tradeId","instId","instType","mgnMode","posSide","pos","ccy","posCcy","avgPx","uTime"}],"trades":[{"instId","tradeId"}]}]}` (note the ccxt sample has the typo key `uTIme` in `posData`). [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts

### 8.5 `orders-algo` / `algo-advance` (business endpoint, login required)
- Stop/touched orders use `orders-algo`; trailing stops use `algo-advance`; both on `/ws/v5/business`. ccxt subscribes `orders-algo` for trigger orders. [verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/docs/integrations/okx.md ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts

---

## 9. Rate limits

> No official rate-limit page was fetched. Numbers come from client quotas (nautilus), ccxt cost weights, the official SDK's docstrings, docs text mirrored by skip-mev, and third-party explainer repos. They agree with each other but are not primary.

### 9.1 REST
| Endpoint | Limit | Conf | Source |
|---|---|---|---|
| Global default (nautilus model) | 500 requests / 2 s | [likely] | https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/http/client.rs |
| `POST /trade/order`, `cancel-order`, `amend-order` | 60 req / 2 s (explainers; nautilus 30/s); reported bucket "per User ID + Instrument ID" came only from search summaries | [likely] | https://github.com/dojez25/okx-rate-limits-explained ; https://github.com/cbjh079/okx-api-limits-explained ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/http/client.rs |
| `POST /trade/batch-orders` (and other batch endpoints) | 7 req / s (nautilus) | [likely] | https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/http/client.rs |
| Sub-account order cap | 1,000 order requests / 2 s across new-order + amend (error `50061`) | [likely] | https://github.com/cbjh079/okx-api-limits-explained |
| `GET /trade/orders-pending`, `GET /trade/fills` | 30 req / s (= 60/2 s) | [likely] | https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/http/client.rs |
| `GET /trade/orders-history` | 20 req / s | [likely] | https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/http/client.rs |
| `GET /trade/fills-history` | 5 req / s | [likely] | https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/http/client.rs |
| `GET /account/balance`, `GET /account/positions` | 10 req / 2 s | [likely] | https://github.com/dojez25/okx-rate-limits-explained ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/http/client.rs |
| `GET /account/config`, `POST /account/set-position-mode` | 2 req / s (= 5/2 s) | [likely] | https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/http/client.rs |
| `GET /public/instruments` | 20 req / 2 s per User ID + instType | [likely] | https://github.com/cbjh079/okx-api-limits-explained ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/http/client.rs |
| `GET /market/candles`, `GET /market/books` | 40 req / 2 s | [verified] (nautilus comment) | https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/http/client.rs |
| `GET /market/history-candles` | 20 req / 2 s | [verified] (nautilus comment) | https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/http/client.rs |
| `set-leverage`, `leverage-info` | not present in any fetched source (unresolved) | — | — |

- ccxt relative cost weights (base `rateLimit` 100 ms × 1.10): `trade/order`, `cancel-order`, `amend-order`, `orders-pending`, `fills` = 1/3; `batch-orders`, `cancel-batch-orders` = 1/15; `amend-batch-orders` = 1/150; `close-position` = 1; `orders-history` = 1/2; `orders-history-archive` = 1; `fills-history` = 2; `account/balance` = 2; `account/positions` = 2; `account/config` = 4; `set-position-mode` = 4; `set-leverage` = 1; `leverage-info` = 1; `max-avail-size` = 1; `trade-fee` = 4; `market/books` = 1/2; `market/candles` = 1/2; `market/history-candles` = 1; `market/trades` = 1/5. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
- Exceeding a limit returns code `50011` "Request too frequent" and/or HTTP 429; nautilus honours `Retry-After`. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/http/client.rs

### 9.2 WebSocket
| Limit | Value | Conf | Source |
|---|---|---|---|
| New connections | 3 per second per IP | [verified] | https://raw.githubusercontent.com/skip-mev/connect/main/providers/websockets/okx/README.md ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/websocket/client.rs |
| `subscribe` / `unsubscribe` / `login` | 480 per hour per connection | [verified] | https://raw.githubusercontent.com/skip-mev/connect/main/providers/websockets/okx/README.md ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/websocket/client.rs |
| Single `order` / `cancel-order` / `amend-order` ops | python-okx docstring: "60 requests/second"; nautilus: 30/s; nautilus docs: order/cancel/amend 60 req per 2 s. Conflict — treat 60/2 s as the conservative figure | [verified] (SDK docstring) / [likely] (nautilus) | https://raw.githubusercontent.com/okxapi/python-okx/master/test/test_ws_private_async.py ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/websocket/client.rs ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/docs/integrations/okx.md |
| Batch ops | max 20 orders per batch (SDK); 7 req/s (nautilus); 300 orders per 2 s (nautilus docs) | [verified] (20) / [likely] (7/s, 300/2s) | https://raw.githubusercontent.com/okxapi/python-okx/master/test/test_ws_private_async.py ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/websocket/client.rs |
| `mass-cancel` (business) | 1 req/s (SDK); nautilus 2/s; nautilus docs 5 per 2 s | [verified] (SDK) / [likely] (nautilus) | https://raw.githubusercontent.com/okxapi/python-okx/master/okx/websocket/WsPrivateAsync.py ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/websocket/client.rs |
| Algo order / algo cancel | 10/s and 1/s (nautilus); algo order 20 per 2 s (nautilus docs) | [likely] | https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/websocket/client.rs ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/docs/integrations/okx.md |
| Subscribe frame size | ≤ 256 args per message (nautilus); ≤ 4096 bytes total (Go comment) | [likely] | https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/websocket/client.rs ; https://raw.githubusercontent.com/Anode-Trading/okex/master/api/ws/client.go |
| Connections per channel per sub-account | 30 | [unverified] (search snippet only) | https://www.okx.com/docs-v5/en/#overview-websocket-overview |
| Accounts per private connection | up to 100 | [likely] | https://raw.githubusercontent.com/tiagosiebler/okx-api/master/README.md |
| Hummingbot's conservative throttle (reference only) | 3 conn/s, 100 WS requests/10 s, 240 subscriptions/hour, 1 login/15 s | [verified] | https://raw.githubusercontent.com/hummingbot/hummingbot/master/hummingbot/connector/exchange/okx/okx_constants.py |

---

## 10. Error codes

Messages are ccxt's / nautilus's inline paraphrases of the docs; exact official wording may differ (e.g. `50113` "Invalid signature" vs docs' "Invalid Sign"). Unless noted, source is https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts [verified].

### 10.1 General / system (`500xx`)
| Code | Meaning | Action | Conf | Source |
|---|---|---|---|---|
| 50000 | Body can not be empty | fix request | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 50001 | Matching engine upgrading / service temporarily unavailable | retry later | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/consts.rs |
| 50002 | JSON data format error | fix body | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 50004 | Endpoint request timeout — does not indicate order success/failure; check order status | reconcile, do not blindly retry orders | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/consts.rs |
| 50005 | API offline or unavailable | retry later | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 50006 | Invalid Content_Type, use `application/json` | set header | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 50007 / 50009 | Account blocked / suspended due to liquidation | — | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 50008 | User does not exist | — | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 50011 | Request too frequent (rate limit) | back off | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/jwy207/okx-rest-api-guide/main/README.md |
| 50013 | System is busy | retry later | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/consts.rs |
| 50014 | Parameter {0} can not be empty | fix request | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 50026 | System error, please try again later | retry | [verified] | https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/consts.rs |
| 50061 | Sub-account order request rate limit exceeded (1,000/2 s cap) | back off | [likely] | https://github.com/cbjh079/okx-api-limits-explained |

### 10.2 Authentication (`501xx`)
| Code | Meaning | Conf | Source |
|---|---|---|---|
| 50100 | API frozen, contact customer service | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 50101 | Broker id of APIKey does not match current environment (demo key vs live, or vice-versa) | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 50102 | Timestamp request expired (clock skew; 30 s window per third-party guide) | [verified] (code) / [likely] (30 s) | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/jwy207/okx-rest-api-guide/main/README.md |
| 50103 / 50104 / 50106 / 50107 | Request header `OK_ACCESS_KEY` / `OK_ACCESS_PASSPHRASE` / `OK_ACCESS_SIGN` / `OK_ACCESS_TIMESTAMP` can not be empty | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 50105 | `OK_ACCESS_PASSPHRASE` incorrect | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 50108 / 50109 | Exchange ID / Exchange domain does not exist | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 50110 | Invalid IP (IP allow-list) | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 50111 | Invalid `OK_ACCESS_KEY` | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 50112 | Invalid `OK_ACCESS_TIMESTAMP` | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 50113 | Invalid signature | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 50114 | Invalid authorization | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 50115 | Invalid request method | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |

### 10.3 Trading (`51xxx`) — appear as `data[i].sCode` with top-level `code "1"`/`"2"`
| Code | Meaning | Conf | Source |
|---|---|---|---|
| 51000 | Parameter {0} error (e.g. "Parameter posSide error"; also returned by `books-rpi` above 400 levels) | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 51001 | Instrument ID does not exist | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 51003 | Either client order ID or order ID is required | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 51006 | Order price out of the limit | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 51007 | Order amount should be at least 1 contract | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 51008 | Insufficient balance or margin (WS sample: "Order failed. Insufficient USDT balance in account.") | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/websocket-client.ts |
| 51010 | The current account mode does not support this API interface | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 51011 | Duplicated order ID | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 51016 | Duplicated client order ID | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 51020 | Order amount should be greater than the min available amount | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 51023 | Position does not exist | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 51112 | Close order size exceeds your available size | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 51119 | Order placement failed due to insufficient balance | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 51121 | Order count should be the integer multiples of the lot size | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 51127 | Available balance is 0 | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 51131 | Insufficient balance | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 51149 | Order request timed out — outcome unknown, must reconcile | [verified] | https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/consts.rs |
| 51205 | Reduce-Only is not available | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 51400 | Cancellation failed as the order does not exist | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 51401 | Cancellation failed as the order is already canceled | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 51402 | Cancellation failed as the order is already completed | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 51407 | Either order ID or client order ID is required | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 51410 | Cancellation failed as the order is already under cancelling status | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 51500 | Either order price or amount is required (amend) | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 51501 | Maximum {0} orders can be modified | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 51502 | Order modification failed for insufficient margin or balance | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 51503 | Order modification failed as the order does not exist | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 51603 | Order does not exist | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |

### 10.4 WebSocket (`60xxx`, `64xxx`)
| Code | Meaning | Conf | Source |
|---|---|---|---|
| 60001 | OK not received in time (retryable) | [verified] | https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/consts.rs |
| 60005 | **Conflict:** ccxt comment = "Invalid OK_ACCESS_KEY"; nautilus = "Connection closed as there was no data transmission in the last 30 seconds" (retryable) | [verified] (both comments) | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/consts.rs |
| 60009 | Login failed | [verified] | https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/websocket-util.ts |
| 60012 | Illegal request (bad JSON / op; `msg` embeds the offending request) | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts |
| 60014 | Too many requests | [verified] | https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/consts.rs |
| 60018 | channel:…,instId:… doesn't exist | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts |
| 60022 | Login partially failed (multi-account) | [verified] | https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/websocket-util.ts |
| 60029 / 60030 | cited by a researcher as the errors for subscribing `books-l2-tbt`/`books50-l2-tbt` without login (not visible in the quoted snippet) | [verified] (per note tag; weak) | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts |
| 64000 | Subscription parameter `uly` unavailable, use `instFamily` | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 64001 | Channel migrated to the business URL | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 64002 | Channel not supported by business URL (use `/private` or `/public`) | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts |
| 64008 | Connection will soon be closed for a service upgrade — reconnect (arrives as `event:'notice'`) | [verified] | https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/websocket-client.ts |

---

## 11. Gotchas (implementation checklist)

1. **Inspect `code`, not HTTP status.** Business errors come back HTTP 200 with `code != "0"`; order failures put the real code in `data[i].sCode`. `"2"` = partial success. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
2. **Sign exactly what you send.** GET: the `?query` string is in the signed path and must be byte-identical in the URL. POST: sign the exact JSON string you transmit; `{}` body → sign `''` and send no body. [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/okxclient.py ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/credential.rs
3. **Two timestamp formats.** REST = ISO-8601 with exactly 3 ms digits + `Z`; WS login = Unix seconds string. Do not copy Go (trims zeros) or okx-rs (no ms). [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/utils.py ; https://raw.githubusercontent.com/okxapi/python-okx/master/okx/websocket/WsUtils.py
4. **Clock skew** → `50102`; keep within 30 s (third-party figure) or derive timestamps from `/api/v5/public/time`. [likely] src: https://raw.githubusercontent.com/jwy207/okx-rest-api-guide/main/README.md
5. **Demo** = same REST host + `x-simulated-trading: 1`, separate WS host `wspap.okx.com`, separate demo API keys; mixing keys/environments → `50101`. [verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/docs/integrations/okx.md ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
6. **Never auto-retry order submits** (`trade/order`, `batch-orders`, `order-algo`); on `50004`/`51149` reconcile via `GET /trade/order` or the `orders` channel. [verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/http/client.rs
7. **WS keepalive is text** `ping`/`pong` — handle the non-JSON `pong` before `JSON.parse`; ping every ~15–20 s; server drops idle connections after 30 s. [verified] src: https://raw.githubusercontent.com/skip-mev/connect/main/providers/websockets/okx/README.md ; https://raw.githubusercontent.com/Anode-Trading/okex/master/api/ws/client.go
8. **Wait for the login ack** before subscribing private channels; re-login before resubscribing after reconnect. [verified] src: https://raw.githubusercontent.com/hummingbot/hummingbot/master/hummingbot/connector/exchange/okx/okx_api_user_stream_data_source.py ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/websocket/client.rs
9. **Candles live on `/ws/v5/business`** (`64001` otherwise); `orders-algo`/`algo-advance` too. `books-l2-tbt`/`books50-l2-tbt` need login on the *public* socket. [verified] src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/websocket-util.ts ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts
10. **Handle `notice` 64008** by reconnecting immediately. [verified] src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/websocket-client.ts
11. **Order book**: `books5`/`bbo-tbt` have no `action` and every push is a full replacement; `books` sends `snapshot` then `update`; size `"0"` deletes a level; verify `prevSeqId == lastSeqId` (the CRC32 checksum is retired, see "Checksum retired (2026-06-23)" above); on mismatch resubscribe, with a backoff so a book that never syncs cannot exhaust the 480 requests/hour limit. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts ; https://raw.githubusercontent.com/bmoscon/cryptofeed/v2.4.0/cryptofeed/exchanges/okx.py
12. **Keep raw strings** for checksum inputs; do not re-format prices/sizes. [verified] src: https://raw.githubusercontent.com/bmoscon/cryptofeed/v2.4.0/cryptofeed/exchanges/okx.py
13. **Candles & trades come newest-first**; candle volume index differs: spot uses `vol` (idx 5), derivatives use `volCcy` (idx 6) for base amount; `confirm` `"1"` = closed. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
14. **`bar` is case-sensitive** (`1m` vs `1H`); UTC variants append `utc`. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
15. **Ticker volume semantics flip** between spot and derivatives (`volCcy24h`). [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
16. **`nextFundingRate` is two periods ahead.** [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
17. **`sz` for SWAP is contracts**: round to `lotSz`, ≥ `minSz`, ≥ 1 contract (`51007`, `51121`); notional = `sz × ctVal` (ccxt `contractSize = ctVal`; nautilus multiplier `ctMult × ctVal`). [likely] (docs mirror) / [verified] (ccxt/nautilus mapping) src: https://raw.githubusercontent.com/aahl/mcp-okx/master/mcp_okx/trading.py ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
18. **Hedge mode**: `posSide` is mandatory (`long`/`short`); `reduceOnly` is not supported there — close by sending the opposite `posSide` (ccxt). In net mode omit `posSide` (or `net`) and use `reduceOnly`. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
19. **`clOrdId`**: ≤ 32 chars, alphanumeric only (no `-`/`_`); duplicates → `51016`. [verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/docs/integrations/okx.md
20. **`tag`** is a broker-program field — omit for self-use. [verified] src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/BaseRestClient.ts
21. **Empty strings** are common in responses (`avgPx: ""`, `clOrdId: ""`, `posSide: ""`); `reduceOnly` is the string `'true'`/`'false'` in responses. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
22. **`instType: 'ANY'`** is valid for private subscriptions (`orders`, `positions`). [verified] src: https://raw.githubusercontent.com/okxapi/python-okx/master/test/test_ws_private_async.py
23. **Skip placeholder instruments** with empty `instId` (and `TEST*` families in demo). [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
24. **Use `www.okx.com`**, not `okx.com` (redirects may strip auth headers). [verified] src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/consts.rs
25. **WS `instId` → `instIdCode` migration** is in progress for trade ops; keep `instId` for REST, be ready to send `instIdCode` on WS. [verified] src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/types/websockets/ws-api-request.ts
26. **Do not copy tiagosiebler's `BUSINESS_CHANNELS` verbatim** (typo entry). [verified] src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/websocket-util.ts
27. **Rate limiting**: handle both HTTP 429 and code `50011`; respect `Retry-After`. [verified] src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/http/client.rs

---

## 12. Disagreements and unresolved items

Each item lists the conflicting sources and a verdict (which is more recent / authoritative), or states that the detail is missing from the notes.

1. **`?brokerId=9999` on demo WS URLs.** python-okx tests (official, all three endpoints), ccxt (all three), okx-rs (all three), Hummingbot (public), Go (public+private) include it; tiagosiebler only on business; nautilus on none. Verdict: official SDK wins → include on all three, configurable. src: https://raw.githubusercontent.com/okxapi/python-okx/master/test/test_ws_private_async.py ; https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/websocket-util.ts ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/consts.rs
2. **WS port 443 vs 8443.** ccxt pro uses 443; official SDK tests + all others use 8443. Verdict: superseded, OKX retires 8443 on 2026-10-31; default to no explicit port (443), URLs overridable. src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts ; https://raw.githubusercontent.com/okxapi/python-okx/master/test/test_ws_public_async.py
3. **REST timestamp millisecond precision.** python-okx/tiagosiebler/nautilus always 3 digits; Go trims zeros; okx-rs none. Verdict: official SDK + nautilus ("OKX requires milliseconds") → always 3 digits. src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/http/client.rs ; https://raw.githubusercontent.com/Anode-Trading/okex/master/api/rest/client.go ; https://raw.githubusercontent.com/roytang121/okx-rs/dev/src/api/mod.rs
4. **Timestamp tolerance (30 s).** Only from a third-party guide; no SDK enforces it; nautilus merely logs drift. Unverified against official docs. src: https://raw.githubusercontent.com/jwy207/okx-rest-api-guide/main/README.md
5. **`Content-Type` on signed GET.** python-okx and tiagosiebler send it always; ccxt only on non-GET; both in production. Verdict: send always (safe). src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/utils.py ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
6. **`x-simulated-trading: 0` for live.** python-okx sends `'0'`; ccxt/nautilus/tiagosiebler omit the header. Verdict: omitting appears safe. src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/utils.py ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/http/client.rs
7. **Query-string encoding for signing.** python-okx raw `k=v` (no URL-encoding); ccxt `urlencode()`; Go `q.Encode()`. Which the server expects for reserved characters is unknown; typical values contain none. src: https://raw.githubusercontent.com/okxapi/python-okx/master/okx/utils.py ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
8. **Regional / AWS hosts** come from third-party constants; the official production-services list was not fetched. src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/util/requestUtils.ts
9. **HTTP status for rate limiting** (429 vs 200 + `50011`): handle both. src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
10. **Official error-message wording** could not be read; messages are client comments. src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
11. **Login on `/business` for candles.** ccxt does not log in; python-okx test does. Verdict: optional for public business channels, required for private ones. src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts ; https://raw.githubusercontent.com/okxapi/python-okx/master/test/test_ws_public_async.py
12. **Login ack `msg` text and payloads of `channel-conn-count`, `channel-conn-count-error`, `notice`** not seen beyond type definitions / one fixture. src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/types/websockets/ws-events.ts
13. **30 WS connections per channel per sub-account** — search snippet only. src: https://www.okx.com/docs-v5/en/#overview-websocket-overview
14. **Ping cadence** differs per client (10 s / 18 s / 20 s / 24 s); docs rule only requires N < 30 s. src: https://raw.githubusercontent.com/skip-mev/connect/main/providers/websockets/okx/README.md
15. **`history-candles` max `limit`**: nautilus 100 vs ccxt 300. Verdict: cap at 100 until tested. src: https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/http/client.rs ; https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
16. **`books` push cadence** (100 ms) only inferred from ccxt comments and a Hummingbot constant name. src: https://raw.githubusercontent.com/hummingbot/hummingbot/master/hummingbot/connector/derivative/okx_perpetual/okx_perpetual_constants.py
17. **Checksum string formatting edge cases** (scientific notation): implementations rely on original strings; keep raw strings. Official wording (`bid1:ask1:...`, "signed int") is from memory only; the algorithm is verified by two implementations. src: https://raw.githubusercontent.com/bmoscon/orderbook/master/orderbook/orderbook.c
18. **`seqId` on the REST `/market/books` snapshot**: optional (cryptofeed reads it optionally; TS type lacks it). src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/llms.txt
19. **All REST rate-limit numbers** are from third-party explainers / nautilus quotas / ccxt weights, not primary; the "User ID + Instrument ID" bucket for `trade/order` came from search summaries only. src: https://github.com/cbjh079/okx-api-limits-explained
20. **WS trade-op `id` constraints** (charset/length) not found; from memory "up to 32 alphanumerics" (unverified). src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts
21. **`tag` max length**: ccxt comment 8 vs docs mirror 16. Verdict: 16 is more recent; 8 historical. src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts ; https://raw.githubusercontent.com/aahl/mcp-okx/master/mcp_okx/trading.py
22. **WS order-op rate**: python-okx docstring "60 requests/second" vs nautilus/explainers 60 per 2 s. Verdict: the SDK docstring is probably sloppy; use 60/2 s. src: https://raw.githubusercontent.com/okxapi/python-okx/master/test/test_ws_private_async.py ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/docs/integrations/okx.md
23. **`set-leverage` / `leverage-info` rate limits** absent from all fetched sources (from memory 20 req/2 s, unverified).
24. **`instId` vs `instIdCode` on WS trade ops**: deprecation noted by tiagosiebler (March / 2026-04-07) and ccxt already sends `instIdCode`; whether `instId` is still accepted as of 2026-10 is unconfirmed; REST still uses `instId`. src: https://raw.githubusercontent.com/tiagosiebler/okx-api/master/src/types/rest/request/trade.ts
25. **Per-fill PnL via REST**: `/trade/fills` has no pnl (only WS `orders` pushes carry `fillPnl`); `orders-history` has cumulative `pnl`. src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/okx.ts
26. **Code `60005` meaning**: ccxt "Invalid OK_ACCESS_KEY" vs nautilus "no data transmission in 30 s". Both are code comments; unresolved. src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/crates/adapters/okx/src/common/consts.rs
27. **`sz` in contracts for SWAP** is inferred from docs-mirror text plus ccxt (`contractSize = ctVal`) and nautilus (multiplier `ctMult × ctVal`); no client comment states it verbatim. src: https://raw.githubusercontent.com/aahl/mcp-okx/master/mcp_okx/trading.py ; https://raw.githubusercontent.com/nautechsystems/nautilus_trader/develop/docs/integrations/okx.md
28. **Error codes `60029`/`60030`** for unauthenticated `books-l2-tbt` subscriptions appear only in a researcher's claim text, not in a quoted snippet. src: https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/pro/okx.ts
29. **Fields of the `instruments`, `index-tickers`, `open-interest` WS channels** are not in the notes (names only).
30. **Query parameter ordering** for signed GETs is not specified by any source; clients use insertion order. Build the query string once and reuse it for both URL and prehash.
