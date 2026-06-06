-- Turn-notification tracking for online play (deferred "your turn" emails).
--
-- One row per active game records who is currently on the clock, since when,
-- and whether we've already emailed them for this turn. The online server
-- (Cloudflare Pages Functions, syncTurnNotify) reads/writes this to send a
-- "your turn" email only when a player has been on the move >15 minutes and
-- hasn't responded — so an active back-and-forth game produces no emails.
--
-- Service-role only (accessed via the service key by the Functions); do NOT
-- expose to the anon key. Idempotent — safe to re-run.

create table if not exists swr_turn_notify (
  game_id     text primary key,
  actor       text not null,            -- 'Rebel' | 'Empire' currently to move
  started_at  timestamptz not null default now(),
  emailed     boolean not null default false
);
