-- ============================================================
-- CMS pages migration (safe if table already exists)
-- ============================================================
-- If you see: Note #1050 Table 'pages' already exists
-- that is OK — skip Part 1 and run Part 2 only.
-- Or run:  node scripts/migrate-pages.js
-- ============================================================

-- Part 1 — only for NEW databases (skip if table exists)
-- CREATE TABLE IF NOT EXISTS pages (
--   id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
--   name VARCHAR(255) NOT NULL,
--   slug VARCHAR(255) NOT NULL,
--   seo_title VARCHAR(255) DEFAULT '',
--   seo_desc TEXT,
--   seo_keywords VARCHAR(500) DEFAULT '',
--   section VARCHAR(50) DEFAULT 'company',
--   breadcrumb_label VARCHAR(255) DEFAULT '',
--   mobile_header_title VARCHAR(255) DEFAULT '',
--   content LONGTEXT,
--   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
--   updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
--   UNIQUE KEY uq_pages_slug (slug)
-- );

-- Part 2 — upgrade EXISTING pages table (run this)
-- Ignore "Duplicate column name" if a column already exists.

ALTER TABLE pages ADD COLUMN seo_keywords VARCHAR(500) DEFAULT '' AFTER seo_desc;
ALTER TABLE pages ADD COLUMN section VARCHAR(50) DEFAULT 'company' AFTER seo_keywords;
ALTER TABLE pages ADD COLUMN breadcrumb_label VARCHAR(255) DEFAULT '' AFTER section;
ALTER TABLE pages ADD COLUMN mobile_header_title VARCHAR(255) DEFAULT '' AFTER breadcrumb_label;
ALTER TABLE pages ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP AFTER content;
ALTER TABLE pages ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at;

-- Unique slug (skip if index already exists)
-- ALTER TABLE pages ADD UNIQUE KEY uq_pages_slug (slug);
