-- Admin system database for the qiaoqing map site.
-- Intended to reuse the MySQL service already installed with RAGFlow.
-- Execute as a MySQL user that can CREATE DATABASE / CREATE USER / GRANT.

CREATE DATABASE IF NOT EXISTS qiaoqing_admin
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'qiaoqing_app'@'%' IDENTIFIED BY 'fjma1234';
ALTER USER 'qiaoqing_app'@'%' IDENTIFIED BY 'fjma1234';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
  ON qiaoqing_admin.* TO 'qiaoqing_app'@'%';
FLUSH PRIVILEGES;

USE qiaoqing_admin;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(64) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('super_admin', 'admin', 'viewer') NOT NULL DEFAULT 'admin',
  status ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
  email VARCHAR(255) NULL,
  phone VARCHAR(32) NULL,
  last_login_at DATETIME NULL,
  last_login_ip VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_username (username),
  UNIQUE KEY uk_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  session_token_hash CHAR(64) NOT NULL,
  refresh_token_hash CHAR(64) NULL,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(512) NULL,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_auth_sessions_token (session_token_hash),
  KEY idx_auth_sessions_user_id (user_id),
  KEY idx_auth_sessions_expires_at (expires_at),
  CONSTRAINT fk_auth_sessions_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_user_id BIGINT UNSIGNED NULL,
  action VARCHAR(80) NOT NULL,
  target_type VARCHAR(80) NULL,
  target_id VARCHAR(80) NULL,
  detail JSON NULL,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(512) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_logs_actor (actor_user_id),
  KEY idx_audit_logs_action (action),
  KEY idx_audit_logs_created_at (created_at),
  CONSTRAINT fk_audit_logs_actor
    FOREIGN KEY (actor_user_id) REFERENCES users (id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS system_settings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  setting_key VARCHAR(120) NOT NULL,
  setting_value JSON NOT NULL,
  description VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_system_settings_key (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ragflow_connections (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  base_url VARCHAR(255) NOT NULL,
  api_key_hint VARCHAR(32) NULL,
  chat_id VARCHAR(80) NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  last_check_status ENUM('unknown', 'ok', 'failed') NOT NULL DEFAULT 'unknown',
  last_check_message VARCHAR(255) NULL,
  last_checked_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_ragflow_connections_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS collection_tasks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  keyword VARCHAR(255) NOT NULL,
  source_type ENUM('crawler', 'tavily', 'bing', 'gdelt', 'rss', 'manual') NOT NULL DEFAULT 'crawler',
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

INSERT INTO system_settings (setting_key, setting_value, description)
VALUES
  ('auth.password_policy', JSON_OBJECT('minLength', 8, 'requireMixedType', false), 'Password policy for admin accounts'),
  ('auth.session_policy', JSON_OBJECT('ttlHours', 12), 'Admin session lifetime')
ON DUPLICATE KEY UPDATE
  setting_value = VALUES(setting_value),
  description = VALUES(description);

INSERT INTO ragflow_connections (name, base_url, api_key_hint, chat_id, enabled)
VALUES ('default', 'http://117.50.226.240', NULL, NULL, 1)
ON DUPLICATE KEY UPDATE
  base_url = VALUES(base_url),
  enabled = VALUES(enabled);
