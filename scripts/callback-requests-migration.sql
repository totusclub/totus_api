-- Manual migration for callback_requests (home page "Перезвоните мне" form)
-- Or run: node scripts/migrate-callback-requests.js

CREATE TABLE IF NOT EXISTS callback_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  phone VARCHAR(20) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_callback_requests_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- If upgrading from older schema:
-- ALTER TABLE callback_requests DROP INDEX idx_callback_requests_status;
-- ALTER TABLE callback_requests DROP COLUMN processed_at;
-- ALTER TABLE callback_requests DROP COLUMN status;
