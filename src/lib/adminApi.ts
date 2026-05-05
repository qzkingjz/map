export type AdminRole = 'super_admin' | 'admin' | 'viewer';

export interface AdminUser {
  id: number;
  username: string;
  displayName: string;
  role: AdminRole;
  status: 'active' | 'disabled';
  email?: string | null;
  phone?: string | null;
  lastLoginAt?: string | null;
  lastLoginIp?: string | null;
  createdAt?: string | null;
}

export interface AdminUserInput {
  username: string;
  displayName: string;
  role: AdminRole;
  status: 'active' | 'disabled';
  password?: string;
  email?: string | null;
  phone?: string | null;
}

export interface AdminSummary {
  users: {
    totalUsers?: number;
    activeUsers?: number;
    superAdmins?: number;
  };
  sessions: {
    activeSessions?: number;
  };
  audit: {
    todayAuditLogs?: number;
  };
  settings: Array<{ setting_key: string }>;
  ragflow: {
    enabled: boolean;
    baseURL?: string;
    chatId?: string;
    model?: string;
  };
}

export interface AuditLog {
  id: number;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  detail?: unknown;
  ipAddress?: string | null;
  createdAt: string;
  actorUsername?: string | null;
}

export interface RagflowStatus {
  ok: boolean;
  status: number | string;
  latencyMs?: number;
  baseURL?: string;
  chatId?: string;
  model?: string;
  message?: string;
}

export interface CollectionTask {
  id: number;
  keyword: string;
  sourceType: 'crawler' | 'tavily' | 'bing' | 'gdelt' | 'rss' | 'manual';
  timeRangeDays: number;
  maxRecords: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  totalFound: number;
  totalSaved: number;
  totalSummarized: number;
  errorMessage?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt: string;
  createdByUsername?: string | null;
}

export interface NewsArticle {
  id: number;
  title: string;
  sourceName?: string | null;
  sourceUrl: string;
  publishedAt?: string | null;
  imageUrl?: string | null;
  rawExcerpt?: string | null;
  rawContent?: string | null;
  aiSummary?: string | null;
  qiaoqingPoints?: string[] | string | null;
  regions?: string[] | string | null;
  people?: string[] | string | null;
  organizations?: string[] | string | null;
  tags?: string[] | string | null;
  status?: 'draft' | 'published' | 'hidden';
  language?: string | null;
  importance?: number;
  syncedToRagflowAt?: string | null;
  createdAt?: string | null;
}

export interface LoginCaptcha {
  id: string;
  svg: string;
  expiresInSeconds: number;
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json();
    return [payload.error, payload.details, payload.message].filter(Boolean).join(': ') || fallback;
  } catch {
    return fallback;
  }
}

async function requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(await readApiError(response, `${path} returned ${response.status}`));
  }

  return response.json() as Promise<T>;
}

export async function getLoginCaptcha(): Promise<LoginCaptcha> {
  return requestJson<LoginCaptcha>('/api/auth/captcha');
}

export async function loginAdmin(
  username: string,
  password: string,
  captchaId: string,
  captchaAnswer: string
): Promise<AdminUser> {
  const data = await requestJson<{ user: AdminUser }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password, captchaId, captchaAnswer }),
  });

  return data.user;
}

export async function logoutAdmin(): Promise<void> {
  await requestJson<{ ok: true }>('/api/auth/logout', { method: 'POST' });
}

export async function recordPageView(page: string, path = window.location.pathname): Promise<void> {
  try {
    await requestJson<{ ok: true }>('/api/audit/page-view', {
      method: 'POST',
      body: JSON.stringify({ page, path }),
    });
  } catch (error) {
    console.warn('Failed to record page view:', error);
  }
}

export async function getCurrentAdmin(): Promise<AdminUser | null> {
  const data = await requestJson<{ user: AdminUser | null }>('/api/auth/me');
  return data.user;
}

export async function getAdminSummary(): Promise<AdminSummary> {
  return requestJson<AdminSummary>('/api/admin/summary');
}

export async function getAdminUsers(): Promise<AdminUser[]> {
  const data = await requestJson<{ users: AdminUser[] }>('/api/admin/users');
  return data.users;
}

export async function createAdminUser(input: AdminUserInput): Promise<void> {
  await requestJson<{ id: number }>('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateAdminUser(id: number, input: AdminUserInput): Promise<void> {
  await requestJson<{ ok: true }>(`/api/admin/users/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deleteAdminUser(id: number): Promise<void> {
  await requestJson<{ ok: true }>(`/api/admin/users/${id}`, {
    method: 'DELETE',
  });
}

export async function getAuditLogs(): Promise<AuditLog[]> {
  const data = await requestJson<{ logs: AuditLog[] }>('/api/admin/audit-logs');
  return data.logs;
}

export async function getRagflowStatus(): Promise<RagflowStatus> {
  return requestJson<RagflowStatus>('/api/admin/ragflow/status');
}

export async function runCollectionTask(input: {
  keyword: string;
  timeRangeDays: number;
  maxRecords: number;
  sourceMode?: 'auto' | 'crawler' | 'tavily';
}): Promise<{ taskId: number; status?: string; message?: string }> {
  return requestJson('/api/admin/collection/run', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function getCollectionTasks(): Promise<CollectionTask[]> {
  const data = await requestJson<{ tasks: CollectionTask[] }>('/api/admin/collection/tasks');
  return data.tasks;
}

export async function getCollectionArticles(): Promise<NewsArticle[]> {
  const data = await requestJson<{ articles: NewsArticle[] }>('/api/admin/collection/articles');
  return data.articles;
}

export async function updateCollectionArticleStatus(
  id: number,
  status: 'draft' | 'published' | 'hidden'
): Promise<void> {
  await requestJson<{ ok: true }>(`/api/admin/collection/articles/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export async function getLatestNews(limit = 50): Promise<NewsArticle[]> {
  const data = await requestJson<{ articles: NewsArticle[] }>(`/api/latest-news?limit=${limit}`);
  return data.articles;
}

export async function getLatestNewsDetail(id: number): Promise<NewsArticle> {
  const data = await requestJson<{ article: NewsArticle }>(`/api/latest-news/${id}`);
  return data.article;
}
