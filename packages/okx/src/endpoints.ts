export const OKX_REST_URL = 'https://www.okx.com';
/** Demo (paper) trading uses the same REST host plus the `x-simulated-trading: 1` header. */
export const OKX_REST_URL_DEMO = 'https://www.okx.com';

export const OKX_WS_PUBLIC_URL = 'wss://ws.okx.com:8443/ws/v5/public';
export const OKX_WS_PRIVATE_URL = 'wss://ws.okx.com:8443/ws/v5/private';
export const OKX_WS_BUSINESS_URL = 'wss://ws.okx.com:8443/ws/v5/business';

export const OKX_WS_PUBLIC_URL_DEMO = 'wss://wspap.okx.com:8443/ws/v5/public';
export const OKX_WS_PRIVATE_URL_DEMO = 'wss://wspap.okx.com:8443/ws/v5/private';
export const OKX_WS_BUSINESS_URL_DEMO = 'wss://wspap.okx.com:8443/ws/v5/business';

export interface OkxEndpoints {
  rest: string;
  wsPublic: string;
  wsPrivate: string;
  wsBusiness: string;
}

export function defaultEndpoints(demo: boolean): OkxEndpoints {
  return demo
    ? { rest: OKX_REST_URL_DEMO, wsPublic: OKX_WS_PUBLIC_URL_DEMO, wsPrivate: OKX_WS_PRIVATE_URL_DEMO, wsBusiness: OKX_WS_BUSINESS_URL_DEMO }
    : { rest: OKX_REST_URL, wsPublic: OKX_WS_PUBLIC_URL, wsPrivate: OKX_WS_PRIVATE_URL, wsBusiness: OKX_WS_BUSINESS_URL };
}
