// Browser-side GameClientApi for online play. Wraps the /api/games/* Pages
// Functions (Phase 3) so the framework's useGame() hook can drive a server
// game. Token travels as the `?t=` query param, matching the route handlers.

import type { GameClientApi } from 'digital-boardgame-framework/client';
import type { GameState } from '../engine/types';
import type { RebellionAction } from '../adapter/rebellionAction';

async function asJson(r: Response): Promise<any> {
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
  return j;
}

export function makeGameClient(
  gameId: string, token: string, getIdentityToken?: () => string | undefined,
  /** Sees every poll response — e.g. its extra `opponentAbandoned` flag, so the
   *  page needn't re-fetch the whole (CPU-heavy) view just to read it. */
  onFetched?: (r: { opponentAbandoned?: boolean }) => void,
): GameClientApi<GameState, RebellionAction> {
  const base = `/api/games/${encodeURIComponent(gameId)}`;
  const q = `?t=${encodeURIComponent(token)}`;
  return {
    // Routes return the framework ViewResult/array shapes directly.
    fetch: () => fetch(`${base}${q}`).then(asJson).then((r) => { onFetched?.(r); return r; }),
    legalActions: () => fetch(`${base}/legal${q}`).then(asJson),
    submit: (action) =>
      fetch(`${base}/submit${q}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, identityToken: getIdentityToken?.() }),
      }).then(asJson),
    report: (body) =>
      fetch(`${base}/report${q}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(asJson),
  };
}

/** Read the invite params (?g=<gameId>&t=<token>) the gameUrl deep-links carry.
 *  Returns null when the URL is not an online-game link. */
export function readOnlineInvite(): { gameId: string; token: string } | null {
  const p = new URLSearchParams(window.location.search);
  const gameId = p.get('g');
  const token = p.get('t');
  return gameId && token ? { gameId, token } : null;
}
