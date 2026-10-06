/**
 * The two stacks that run side by side (scripts/launch-options.mjs): the paper stack's page on 5174 (API 8787) and
 * the campaign stack's on 5175 (API 8788). A page links to the other one on the same host; the ports are the
 * launcher's defaults (CAMPAIGN_WEB_PORT moves the campaign's, which the page cannot know).
 */
export const PAPER_WEB_PORT = 5174;
export const CAMPAIGN_WEB_PORT = 5175;

export function stackUrl(port: number, loc: Pick<Location, 'protocol' | 'hostname'> = window.location): string {
  return `${loc.protocol}//${loc.hostname}:${port}/`;
}
