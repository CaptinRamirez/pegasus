// The web app's own Vite settings (apps/web/vite.config.ts) with the ports of one stack of the launcher: the page on
// PEGASUS_WEB_PORT, its /api and /ws proxied to the API on PEGASUS_API_PORT (5174 and 8787 by default, as in
// vite.config.ts). scripts/start.mjs serves the page with it (`vite preview --config`, and `vite --config` with --dev),
// so that `pnpm start --campaign` (page 5175, API 8788) runs beside `pnpm start` or `pnpm start --paper`.
import base from '../apps/web/vite.config.ts';
import { DEFAULT_PORTS, webServerOptions } from './launch-options.mjs';

const server = webServerOptions(Number(process.env.PEGASUS_WEB_PORT ?? DEFAULT_PORTS.web), Number(process.env.PEGASUS_API_PORT ?? DEFAULT_PORTS.api));

export default { ...base, server: { ...base.server, ...server }, preview: { ...base.preview, ...server } };
