-- Add bedsync_user_id to link SMS dealers to main Bed Sync users
ALTER TABLE dealers ADD COLUMN IF NOT EXISTS bedsync_user_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_dealers_bedsync_user ON dealers(bedsync_user_id) WHERE bedsync_user_id IS NOT NULL;
