-- #ai-worker perf: lets /api/admin/ai-due find AI-due games with one indexed
-- query instead of scanning + decoding every active game. Written by
-- recordTurnTiming (gameServer.ts); read by listAiDueGames. Safe to run anytime
-- — until it runs, ai-due falls back to the full scan (correct, just slower).
-- Run in the Supabase SQL editor for the Rebellion project.
ALTER TABLE swr_turn_notify ADD COLUMN IF NOT EXISTS actor_is_ai boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS swr_turn_notify_actor_is_ai_idx
  ON swr_turn_notify (actor_is_ai) WHERE actor_is_ai;
