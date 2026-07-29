CREATE TABLE IF NOT EXISTS application_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  installed_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO application_state (id)
VALUES (true)
ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS alert_events_session_idx
  ON alert_events (session_id, occurred_at DESC)
  WHERE session_id IS NOT NULL;
