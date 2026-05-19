USE qiaoqing_admin;

CREATE TABLE IF NOT EXISTS collection_tasks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  keyword VARCHAR(255) NOT NULL,
  source_type ENUM('aggregate', 'crawler', 'tavily', 'bing', 'gdelt', 'rss', 'manual') NOT NULL DEFAULT 'aggregate',
  time_range_days INT UNSIGNED NOT NULL DEFAULT 7,
  max_records INT UNSIGNED NOT NULL DEFAULT 20,
  status ENUM('pending', 'running', 'completed', 'failed') NOT NULL DEFAULT 'pending',
  total_found INT UNSIGNED NOT NULL DEFAULT 0,
  total_saved INT UNSIGNED NOT NULL DEFAULT 0,
  total_summarized INT UNSIGNED NOT NULL DEFAULT 0,
  error_message VARCHAR(500) NULL,
  created_by BIGINT UNSIGNED NULL,
  started_at DATETIME NULL,
  finished_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_collection_tasks_status (status),
  KEY idx_collection_tasks_created_at (created_at),
  CONSTRAINT fk_collection_tasks_creator
    FOREIGN KEY (created_by) REFERENCES users (id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS news_articles (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id BIGINT UNSIGNED NULL,
  title VARCHAR(500) NOT NULL,
  source_name VARCHAR(255) NULL,
  source_url VARCHAR(1000) NOT NULL,
  published_at DATETIME NULL,
  image_url VARCHAR(1000) NULL,
  raw_excerpt TEXT NULL,
  raw_content MEDIUMTEXT NULL,
  ai_summary TEXT NULL,
  qiaoqing_points JSON NULL,
  regions JSON NULL,
  people JSON NULL,
  organizations JSON NULL,
  tags JSON NULL,
  language VARCHAR(32) NULL,
  status ENUM('draft', 'published', 'hidden') NOT NULL DEFAULT 'published',
  importance TINYINT UNSIGNED NOT NULL DEFAULT 3,
  content_hash CHAR(64) NOT NULL,
  ragflow_dataset_id VARCHAR(100) NULL,
  ragflow_document_id VARCHAR(100) NULL,
  synced_to_ragflow_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_news_articles_url (source_url(255)),
  UNIQUE KEY uk_news_articles_hash (content_hash),
  KEY idx_news_articles_task_id (task_id),
  KEY idx_news_articles_published_at (published_at),
  KEY idx_news_articles_status (status),
  CONSTRAINT fk_news_articles_task
    FOREIGN KEY (task_id) REFERENCES collection_tasks (id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
