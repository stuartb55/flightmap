-- A surface's default view is applied on arrival; pinned views are promoted out
-- of the saved-views popover onto the surface itself. Both invariants live here
-- rather than in the application: "one default per surface" is a uniqueness
-- constraint, and the writer that enforces the pin cap takes the same advisory
-- lock the 20-view limit already uses.
ALTER TABLE saved_views
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pinned_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS saved_views_default_surface_idx
  ON saved_views (surface) WHERE is_default;

-- Pinned chips render in pin order, per surface, and the cap counts this set.
CREATE INDEX IF NOT EXISTS saved_views_pinned_idx
  ON saved_views (surface, pinned_at) WHERE pinned_at IS NOT NULL;
