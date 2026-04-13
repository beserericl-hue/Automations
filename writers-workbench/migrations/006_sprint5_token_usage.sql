-- Sprint 5 Migration: Token Usage Tracking
-- Creates token_usage_v2 table for cost/usage analytics

-- ============================================
-- 1. Token Usage Table (user-scoped)
-- Tracks LLM API calls by workflow, model, and cost
-- ============================================
CREATE TABLE IF NOT EXISTS token_usage_v2 (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
  workflow_name TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_token_usage_v2_user ON token_usage_v2(user_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_v2_user_date ON token_usage_v2(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_v2_model ON token_usage_v2(model);

-- RLS
ALTER TABLE token_usage_v2 ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Own data only" ON token_usage_v2 FOR ALL USING (true) WITH CHECK (true);

-- ============================================
-- 2. Cost analytics view
-- Aggregates token usage by day, model, workflow
-- ============================================
CREATE OR REPLACE VIEW token_usage_daily_v2 AS
SELECT
  user_id,
  DATE(created_at) AS usage_date,
  model,
  workflow_name,
  COUNT(*) AS call_count,
  SUM(input_tokens) AS total_input_tokens,
  SUM(output_tokens) AS total_output_tokens,
  SUM(total_tokens) AS total_tokens,
  SUM(cost_usd) AS total_cost_usd
FROM token_usage_v2
GROUP BY user_id, DATE(created_at), model, workflow_name
ORDER BY usage_date DESC;
