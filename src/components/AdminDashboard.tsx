import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  Activity,
  CheckCircle2,
  DatabaseZap,
  DoorOpen,
  ExternalLink,
  FileClock,
  FileText,
  Globe2,
  LayoutDashboard,
  Download,
  Newspaper,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  UsersRound,
  X,
} from 'lucide-react';
import {
  AdminPermission,
  AdminRole,
  AdminSummary,
  AdminUser,
  AdminUserInput,
  AuditLog,
  CollectionTask,
  NewsArticle,
  RagflowStatus,
  TextCleaningUploadResult,
  createAdminUser,
  deleteAdminUser,
  getCollectionArticles,
  getCollectionTasks,
  getAdminSummary,
  getAdminUsers,
  getAuditLogs,
  getCurrentAdmin,
  getRagflowStatus,
  logoutAdmin,
  recordPageView,
  runCollectionTask,
  uploadCleaningFile,
  updateCollectionArticleStatus,
  updateAdminUser,
} from '../lib/adminApi';

type AdminTab = 'overview' | 'users' | 'collection' | 'audit' | 'ragflow';

interface AdminDashboardProps {
  onRequireLogin: () => void;
  onBackHome: () => void;
}

const tabs: Array<{ id: AdminTab; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: '总览', icon: LayoutDashboard },
  { id: 'users', label: '用户', icon: UsersRound },
  { id: 'collection', label: '数据采集/清洗', icon: Newspaper },
  { id: 'audit', label: '审计', icon: FileClock },
  { id: 'ragflow', label: 'RAGFlow', icon: DatabaseZap },
];

const configurableAdminTabs = tabs.filter(tab => tab.id !== 'users');

type UserEditorMode = 'create' | 'edit';

interface UserFormState {
  username: string;
  displayName: string;
  role: AdminRole;
  status: 'active' | 'disabled';
  menuPermissions: AdminPermission[];
  password: string;
  email: string;
  phone: string;
}

interface CollectionProgress {
  taskId: number;
  status: CollectionTask['status'];
  message: string;
  startedAt: number;
  totalFound: number;
  totalSaved: number;
  totalSummarized: number;
}

const emptyUserForm: UserFormState = {
  username: '',
  displayName: '',
  role: 'viewer',
  status: 'active',
  menuPermissions: [],
  password: '',
  email: '',
  phone: '',
};

function readAdminTabFromHash(): AdminTab {
  const hash = window.location.hash.replace(/^#/, '');
  return tabs.some(tab => tab.id === hash) ? (hash as AdminTab) : 'overview';
}

function writeAdminTabHash(tab: AdminTab) {
  const nextUrl = `${window.location.pathname}#${tab}`;
  if (`${window.location.pathname}${window.location.hash}` !== nextUrl) {
    window.history.replaceState(null, '', nextUrl);
  }
}

function allowedTabsForUser(user: AdminUser | null): typeof tabs {
  if (!user) return [];
  if (user.role === 'super_admin') return tabs;
  if (user.role !== 'admin') return [];

  const allowed = new Set(user.menuPermissions ?? []);
  return tabs.filter(tab => tab.id !== 'users' && allowed.has(tab.id));
}

function menuPermissionLabel(permission: AdminPermission): string {
  return tabs.find(tab => tab.id === permission)?.label ?? permission;
}

function normalizeUserFormPermissions(role: AdminRole, permissions: AdminPermission[]): AdminPermission[] {
  if (role === 'super_admin') return tabs.map(tab => tab.id);
  if (role === 'viewer') return [];
  return permissions.length > 0 ? permissions : ['collection'];
}

function formatDate(value?: string | null): string {
  if (!value) return '未记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function roleLabel(role: AdminUser['role']): string {
  if (role === 'super_admin') return '超级管理员';
  if (role === 'viewer') return '观察员';
  return '管理员';
}

function auditDetailText(log: AuditLog): string {
  const detail =
    typeof log.detail === 'string'
      ? (() => {
          try {
            return JSON.parse(log.detail);
          } catch {
            return log.detail;
          }
        })()
      : log.detail;

  if (!detail || typeof detail !== 'object') {
    return typeof detail === 'string' ? detail : '-';
  }

  const record = detail as Record<string, unknown>;
  if (typeof record.prompt === 'string') return record.prompt;
  if (typeof record.question === 'string') {
    return typeof record.cityName === 'string'
      ? `${record.cityName}：${record.question}`
      : record.question;
  }
  if (typeof record.page === 'string') return record.page;
  if (typeof record.username === 'string') return record.username;

  return '-';
}

function newsListText(value: NewsArticle['tags']): string {
  if (!value) return '-';
  if (Array.isArray(value)) return value.join('、') || '-';

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.join('、') || '-' : String(value);
  } catch {
    return String(value);
  }
}

function taskStatusText(status: CollectionTask['status']): string {
  if (status === 'completed') return '已完成';
  if (status === 'running') return '采集中';
  if (status === 'failed') return '失败';
  return '待执行';
}

function articleStatusText(status?: NewsArticle['status']): string {
  if (status === 'hidden') return '已隐藏';
  if (status === 'draft') return '草稿';
  return '已发布';
}

function sourceTypeText(sourceType: CollectionTask['sourceType']): string {
  if (sourceType === 'crawler') return '国内爬虫';
  if (sourceType === 'tavily') return 'Tavily';
  if (sourceType === 'bing') return 'Bing';
  if (sourceType === 'gdelt') return 'GDELT';
  if (sourceType === 'rss') return 'RSS';
  return '手动';
}

function cleaningModeText(mode: TextCleaningUploadResult['mode']): string {
  if (mode === 'cleaned') return '已完成清洗';
  if (mode === 'ragflow_parse_required') return '需先解析';
  return '暂不支持';
}

function cleanedDownloadName(filename: string): string {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex <= 0) return `${filename}.cleaned.txt`;
  return `${filename.slice(0, dotIndex)}.cleaned${filename.slice(dotIndex)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    window.setTimeout(resolve, ms);
  });
}

function elapsedText(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}分${restSeconds}秒` : `${restSeconds}秒`;
}

export default function AdminDashboard({ onRequireLogin, onBackHome }: AdminDashboardProps) {
  const [activeTab, setActiveTab] = useState<AdminTab>(() => readAdminTabFromHash());
  const [currentUser, setCurrentUser] = useState<AdminUser | null>(null);
  const [summary, setSummary] = useState<AdminSummary | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [ragflowStatus, setRagflowStatus] = useState<RagflowStatus | null>(null);
  const [collectionTasks, setCollectionTasks] = useState<CollectionTask[]>([]);
  const [collectionArticles, setCollectionArticles] = useState<NewsArticle[]>([]);
  const [collectionKeyword, setCollectionKeyword] = useState('泉州 华侨 侨情');
  const [collectionDays, setCollectionDays] = useState(7);
  const [collectionMax, setCollectionMax] = useState(10);
  const [collectionSourceMode, setCollectionSourceMode] = useState<'auto' | 'crawler' | 'tavily'>('auto');
  const [isCollecting, setIsCollecting] = useState(false);
  const [collectionProgress, setCollectionProgress] = useState<CollectionProgress | null>(null);
  const [cleaningFile, setCleaningFile] = useState<File | null>(null);
  const [cleaningResult, setCleaningResult] = useState<TextCleaningUploadResult | null>(null);
  const [cleaningError, setCleaningError] = useState('');
  const [isCleaningUploading, setIsCleaningUploading] = useState(false);
  const [progressNow, setProgressNow] = useState(Date.now());
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [userEditorMode, setUserEditorMode] = useState<UserEditorMode | null>(null);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [userForm, setUserForm] = useState<UserFormState>(emptyUserForm);
  const [userActionError, setUserActionError] = useState('');
  const [isSavingUser, setIsSavingUser] = useState(false);

  const statusText = useMemo(() => {
    if (!ragflowStatus) return '待检测';
    if (ragflowStatus.ok) return '连接正常';
    return '连接异常';
  }, [ragflowStatus]);
  const visibleTabs = useMemo(() => allowedTabsForUser(currentUser), [currentUser]);
  const canViewOverview = visibleTabs.some(tab => tab.id === 'overview');
  const canViewUsers = currentUser?.role === 'super_admin';
  const canViewAudit = visibleTabs.some(tab => tab.id === 'audit');
  const canViewCollection = visibleTabs.some(tab => tab.id === 'collection');

  async function loadDashboard() {
    setError('');
    setIsLoading(true);

    try {
      const me = await getCurrentAdmin();
      if (!me) {
        onRequireLogin();
        return;
      }

      if (me.role !== 'super_admin' && me.role !== 'admin') {
        onBackHome();
        return;
      }

      setCurrentUser(me);
      const nextVisibleTabs = allowedTabsForUser(me);
      if (nextVisibleTabs.length === 0) {
        setError('当前账号没有可访问的后台菜单，请联系系统管理员分配权限');
        return;
      }

      const nextActiveTab = nextVisibleTabs.some(tab => tab.id === activeTab)
        ? activeTab
        : nextVisibleTabs[0].id;
      if (nextActiveTab !== activeTab) {
        handleTabChange(nextActiveTab);
      }

      const [nextSummary, nextUsers, nextLogs] = await Promise.all([
        nextVisibleTabs.some(tab => tab.id === 'overview') ? getAdminSummary() : Promise.resolve(null),
        me.role === 'super_admin' ? getAdminUsers() : Promise.resolve([]),
        nextVisibleTabs.some(tab => tab.id === 'audit') ? getAuditLogs() : Promise.resolve([]),
      ]);

      setSummary(nextSummary);
      setUsers(nextUsers);
      setLogs(nextLogs);
      if (nextActiveTab === 'collection') {
        const [tasks, articles] = await Promise.all([
          getCollectionTasks(),
          getCollectionArticles(),
        ]);
        setCollectionTasks(tasks);
        setCollectionArticles(articles);
      }
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : '后台数据加载失败';
      if (message.includes('Not authenticated') || message.includes('Session expired')) {
        onRequireLogin();
        return;
      }

      setError(message);
    } finally {
      setIsLoading(false);
    }
  }

  async function checkRagflow() {
    setError('');
    try {
      setRagflowStatus(await getRagflowStatus());
    } catch (caughtError) {
      setRagflowStatus({
        ok: false,
        status: 'failed',
        message: caughtError instanceof Error ? caughtError.message : 'RAGFlow 检测失败',
      });
    }
  }

  async function loadCollectionData() {
    const [tasks, articles] = await Promise.all([
      getCollectionTasks(),
      getCollectionArticles(),
    ]);
    setCollectionTasks(tasks);
    setCollectionArticles(articles);
    return { tasks, articles };
  }

  async function handleLogout() {
    await logoutAdmin();
    onRequireLogin();
  }

  function handleTabChange(tab: AdminTab) {
    writeAdminTabHash(tab);
    setActiveTab(tab);
  }

  function handleUserRoleChange(role: AdminRole) {
    setUserForm(current => ({
      ...current,
      role,
      menuPermissions: normalizeUserFormPermissions(role, current.menuPermissions),
    }));
  }

  function toggleUserPermission(permission: AdminPermission) {
    setUserForm(current => {
      const currentPermissions = new Set(current.menuPermissions);
      if (currentPermissions.has(permission)) {
        currentPermissions.delete(permission);
      } else {
        currentPermissions.add(permission);
      }

      return {
        ...current,
        menuPermissions: normalizeUserFormPermissions(
          current.role,
          Array.from(currentPermissions)
        ),
      };
    });
  }

  function updateProgressFromTask(task: CollectionTask, startedAt: number) {
    const sourceText = sourceTypeText(task.sourceType);
    const message =
      task.status === 'completed'
        ? '采集完成'
        : task.status === 'failed'
          ? `采集失败：${task.errorMessage ?? '请查看任务记录'}`
          : task.totalFound > 0
            ? `正在整理资讯：${task.totalSummarized}/${task.totalFound}`
            : `正在连接${sourceText}并抓取列表`;

    setCollectionProgress({
      taskId: task.id,
      status: task.status,
      message,
      startedAt,
      totalFound: task.totalFound,
      totalSaved: task.totalSaved,
      totalSummarized: task.totalSummarized,
    });
  }

  async function waitForCollectionTask(taskId: number, startedAt: number) {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const { tasks } = await loadCollectionData();
      const task = tasks.find(item => item.id === taskId);
      if (task) {
        updateProgressFromTask(task, startedAt);

        if (task.status === 'completed') {
          await loadCollectionData();
          return;
        }

        if (task.status === 'failed') {
          throw new Error(task.errorMessage ?? '采集任务失败');
        }
      }

      await sleep(2000);
    }

    throw new Error('采集任务等待超时，请稍后刷新任务记录查看结果');
  }

  async function handleRunCollection() {
    const keyword = collectionKeyword.trim();
    if (!keyword) {
      setError('请输入采集关键词');
      return;
    }

    setError('');
    setIsCollecting(true);
    const startedAt = Date.now();
    setProgressNow(startedAt);
    setCollectionProgress({
      taskId: 0,
      status: 'pending',
      message: '正在创建采集任务',
      startedAt,
      totalFound: 0,
      totalSaved: 0,
      totalSummarized: 0,
    });
    try {
      const task = await runCollectionTask({
        keyword,
        timeRangeDays: collectionDays,
        maxRecords: collectionMax,
        sourceMode: collectionSourceMode,
      });
      setCollectionProgress(current => ({
        taskId: task.taskId,
        status: 'pending',
        message: '任务已创建，正在开始采集',
        startedAt: current?.startedAt ?? startedAt,
        totalFound: 0,
        totalSaved: 0,
        totalSummarized: 0,
      }));
      await waitForCollectionTask(task.taskId, startedAt);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : '数据采集失败');
    } finally {
      setIsCollecting(false);
      await loadCollectionData();
    }
  }

  async function handleArticleStatus(id: number, status: 'draft' | 'published' | 'hidden') {
    setError('');
    try {
      await updateCollectionArticleStatus(id, status);
      await loadCollectionData();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : '资讯状态更新失败');
    }
  }

  async function handleUploadCleaningFile() {
    if (!cleaningFile) {
      setCleaningError('请先选择一个文本类文件');
      return;
    }

    setCleaningError('');
    setIsCleaningUploading(true);
    writeAdminTabHash('collection');
    try {
      setCleaningResult(await uploadCleaningFile(cleaningFile));
    } catch (caughtError) {
      setCleaningResult(null);
      setCleaningError(caughtError instanceof Error ? caughtError.message : '文件清洗失败');
    } finally {
      setIsCleaningUploading(false);
    }
  }

  function handleDownloadCleaningResult() {
    if (!cleaningResult?.text) return;

    const blob = new Blob([cleaningResult.text], {
      type: cleaningResult.mimeType?.startsWith('text/')
        ? `${cleaningResult.mimeType};charset=utf-8`
        : 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = cleanedDownloadName(cleaningResult.filename);
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function openCreateUser() {
    setEditingUser(null);
    setUserForm(emptyUserForm);
    setUserActionError('');
    setUserEditorMode('create');
  }

  function openEditUser(user: AdminUser) {
    setEditingUser(user);
    setUserForm({
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      status: user.status,
      menuPermissions: normalizeUserFormPermissions(user.role, user.menuPermissions ?? []),
      password: '',
      email: user.email ?? '',
      phone: user.phone ?? '',
    });
    setUserActionError('');
    setUserEditorMode('edit');
  }

  function closeUserEditor() {
    setUserEditorMode(null);
    setEditingUser(null);
    setUserForm(emptyUserForm);
    setUserActionError('');
  }

  function toUserInput(): AdminUserInput {
    return {
      username: userForm.username.trim(),
      displayName: userForm.displayName.trim(),
      role: userForm.role,
      status: userForm.status,
      menuPermissions: normalizeUserFormPermissions(userForm.role, userForm.menuPermissions),
      password: userForm.password.trim() ? userForm.password : undefined,
      email: userForm.email.trim() || null,
      phone: userForm.phone.trim() || null,
    };
  }

  async function handleSaveUser() {
    setUserActionError('');
    setIsSavingUser(true);

    try {
      const input = toUserInput();
      if (!input.username || !input.displayName) {
        throw new Error('请填写账号和姓名');
      }

      if (userEditorMode === 'create') {
        if (!input.password || input.password.length < 6) {
          throw new Error('新用户密码至少 6 位');
        }

        await createAdminUser(input);
      } else if (editingUser) {
        await updateAdminUser(editingUser.id, input);
      }

      closeUserEditor();
      await loadDashboard();
      handleTabChange('users');
    } catch (caughtError) {
      setUserActionError(caughtError instanceof Error ? caughtError.message : '用户保存失败');
    } finally {
      setIsSavingUser(false);
    }
  }

  async function handleDeleteUser(user: AdminUser) {
    if (!window.confirm(`确认删除用户“${user.displayName}”？该操作会同时清理其登录会话。`)) {
      return;
    }

    setUserActionError('');
    try {
      await deleteAdminUser(user.id);
      await loadDashboard();
      handleTabChange('users');
    } catch (caughtError) {
      setUserActionError(caughtError instanceof Error ? caughtError.message : '用户删除失败');
    }
  }

  useEffect(() => {
    void loadDashboard();
  }, []);

  useEffect(() => {
    writeAdminTabHash(activeTab);
  }, [activeTab]);

  useEffect(() => {
    const handleHashChange = () => {
      setActiveTab(readAdminTabFromHash());
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  useEffect(() => {
    if (activeTab === 'ragflow' && !ragflowStatus) {
      void checkRagflow();
    }
    if (activeTab === 'collection') {
      void loadCollectionData();
    }
  }, [activeTab, ragflowStatus]);

  useEffect(() => {
    if (!currentUser) return;

    const currentTab = tabs.find(tab => tab.id === activeTab);
    void recordPageView(`后台-${currentTab?.label ?? activeTab}`, `/admin#${activeTab}`);
  }, [activeTab, currentUser]);

  useEffect(() => {
    if (!isCollecting || !collectionProgress) return;

    const timer = window.setInterval(() => {
      setProgressNow(Date.now());
    }, 1000);

    return () => window.clearInterval(timer);
  }, [isCollecting, collectionProgress]);

  return (
    <main className="admin-shell">
      <aside className="admin-sidebar">
        <button className="admin-brand" type="button" onClick={onBackHome}>
          <span>侨情监测</span>
          <strong>管理展示系统</strong>
        </button>

        <nav className="admin-nav" aria-label="后台导航">
          {visibleTabs.map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                className={activeTab === tab.id ? 'is-active' : ''}
                onClick={() => handleTabChange(tab.id)}
              >
                <Icon />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="admin-sidebar-foot">
          <span>{currentUser?.displayName ?? '管理员'}</span>
          <button type="button" onClick={handleLogout}>
            <DoorOpen />
            <span>退出系统</span>
          </button>
        </div>
      </aside>

      <section className="admin-workspace">
        <header className="admin-topbar">
          <div>
            <span>泉州华侨大学</span>
            <h1>海丝侨情与侨务治理垂直大模型门户网</h1>
          </div>
          <div className="admin-topbar-actions">
            <button type="button" onClick={loadDashboard} disabled={isLoading}>
              <RefreshCw />
              <span>{isLoading ? '刷新中' : '刷新'}</span>
            </button>
            <button className="admin-topbar-logout" type="button" onClick={handleLogout}>
              <DoorOpen />
              <span>退出系统</span>
            </button>
          </div>
        </header>

        {error ? <p className="admin-alert">{error}</p> : null}

        {activeTab === 'overview' && canViewOverview ? (
          <motion.div
            className="admin-view"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35 }}
          >
            <section className="admin-metrics">
              <div>
                <UsersRound />
                <span>用户总数</span>
                <strong>{summary?.users.totalUsers ?? '-'}</strong>
              </div>
              <div>
                <ShieldCheck />
                <span>活跃用户</span>
                <strong>{summary?.users.activeUsers ?? '-'}</strong>
              </div>
              <div>
                <Activity />
                <span>有效会话</span>
                <strong>{summary?.sessions.activeSessions ?? '-'}</strong>
              </div>
              <div>
                <FileClock />
                <span>今日审计</span>
                <strong>{summary?.audit.todayAuditLogs ?? '-'}</strong>
              </div>
            </section>

            <section className="admin-overview-grid">
              <div className="admin-panel admin-panel-wide">
                <div className="admin-panel-head">
                  <span>运行状态</span>
                  <strong>系统配置</strong>
                </div>
                <div className="admin-status-lines">
                  <p>
                    <span>知识库模式</span>
                    <strong>{summary?.ragflow.enabled ? '已启用' : '未启用'}</strong>
                  </p>
                  <p>
                    <span>RAGFlow 地址</span>
                    <strong>{summary?.ragflow.baseURL ?? '未配置'}</strong>
                  </p>
                  <p>
                    <span>Chat ID</span>
                    <strong>{summary?.ragflow.chatId ?? '未配置'}</strong>
                  </p>
                  <p>
                    <span>管理库</span>
                    <strong>qiaoqing_admin</strong>
                  </p>
                </div>
              </div>

              <div className="admin-panel">
                <div className="admin-panel-head">
                  <span>最近登录</span>
                  <strong>账号活动</strong>
                </div>
                <div className="admin-compact-list">
                  {users.slice(0, 4).map(user => (
                    <p key={user.id}>
                      <span>{user.displayName}</span>
                      <strong>{formatDate(user.lastLoginAt)}</strong>
                    </p>
                  ))}
                </div>
              </div>
            </section>
          </motion.div>
        ) : null}

        {activeTab === 'users' && canViewUsers ? (
          <motion.section
            className="admin-view admin-panel"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35 }}
          >
            <div className="admin-panel-head">
              <span>账号权限</span>
              <strong>管理员用户</strong>
              <button className="admin-panel-action" type="button" onClick={openCreateUser}>
                <Plus />
                <span>新增用户</span>
              </button>
            </div>
            {userActionError ? <p className="admin-inline-error">{userActionError}</p> : null}
            <div className="admin-table">
              <div className="admin-table-row admin-user-table-row admin-table-head">
                <span>用户</span>
                <span>角色</span>
                <span>状态</span>
                <span>最后登录</span>
                <span>操作</span>
              </div>
              {users.map(user => (
                <div className="admin-table-row admin-user-table-row" key={user.id}>
                  <span>
                    <strong>{user.displayName}</strong>
                    <small>{user.username}</small>
                  </span>
                  <span>{roleLabel(user.role)}</span>
                  <span className={user.status === 'active' ? 'admin-good' : 'admin-bad'}>
                    {user.status === 'active' ? '启用' : '停用'}
                  </span>
                  <span>{formatDate(user.lastLoginAt)}</span>
                  <span className="admin-row-actions">
                    <button type="button" onClick={() => openEditUser(user)} aria-label="编辑用户">
                      <Pencil />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteUser(user)}
                      disabled={currentUser?.id === user.id}
                      aria-label="删除用户"
                    >
                      <Trash2 />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </motion.section>
        ) : null}

        {activeTab === 'collection' && canViewCollection ? (
          <motion.section
            className="admin-view"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35 }}
          >
            <div className="admin-panel admin-collector-panel">
              <div className="admin-panel-head">
                <span>新闻采集</span>
                <strong>数据采集</strong>
              </div>
              <div className="admin-collector-form">
                <label>
                  <span>采集关键词</span>
                  <input
                    value={collectionKeyword}
                    onChange={event => setCollectionKeyword(event.target.value)}
                    placeholder="例如：泉州 华侨 侨情"
                  />
                </label>
                <label>
                  <span>时间范围</span>
                  <select
                    value={collectionDays}
                    onChange={event => setCollectionDays(Number(event.target.value))}
                  >
                    <option value={1}>最近 1 天</option>
                    <option value={7}>最近 7 天</option>
                    <option value={30}>最近 30 天</option>
                  </select>
                </label>
                <label>
                  <span>采集方式</span>
                  <select
                    value={collectionSourceMode}
                    onChange={event =>
                      setCollectionSourceMode(event.target.value as 'auto' | 'crawler' | 'tavily')
                    }
                  >
                    <option value="auto">爬虫优先，Tavily备用</option>
                    <option value="crawler">只用国内爬虫</option>
                    <option value="tavily">只用Tavily</option>
                  </select>
                </label>
                <label>
                  <span>采集数量</span>
                  <select
                    value={collectionMax}
                    onChange={event => setCollectionMax(Number(event.target.value))}
                  >
                    <option value={10}>10 条</option>
                    <option value={20}>20 条</option>
                    <option value={50}>50 条</option>
                  </select>
                </label>
                <button type="button" onClick={handleRunCollection} disabled={isCollecting}>
                  <Search />
                  <span>{isCollecting ? '采集中' : '开始采集'}</span>
                </button>
              </div>
              {collectionProgress ? (
                <div className="admin-collection-progress">
                  <div className="admin-progress-bar" aria-hidden="true">
                    <span
                      style={{
                        width: collectionProgress.totalFound
                          ? `${Math.min(
                              100,
                              Math.round(
                                (collectionProgress.totalSummarized /
                                  collectionProgress.totalFound) *
                                  100
                              )
                            )}%`
                          : isCollecting
                            ? '38%'
                            : '100%',
                      }}
                    />
                  </div>
                  <div className="admin-progress-lines">
                    <strong>{collectionProgress.message}</strong>
                    <span>
                      任务 #{collectionProgress.taskId || '-'} · 已用时{' '}
                      {elapsedText(collectionProgress.startedAt, progressNow)} · 找到{' '}
                      {collectionProgress.totalFound} 条 · 已入库{' '}
                      {collectionProgress.totalSaved} 条 · 已总结{' '}
                      {collectionProgress.totalSummarized} 条
                    </span>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="admin-panel admin-cleaning-panel">
              <div className="admin-panel-head">
                <span>本地文件</span>
                <strong>轻量清洗</strong>
              </div>
              <div className="admin-cleaning-body">
                <div className="admin-cleaning-upload">
                  <label className="admin-file-picker">
                    <FileText />
                    <span>{cleaningFile ? cleaningFile.name : '选择上传文件'}</span>
                    <input
                      type="file"
                      accept=".txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.html,.htm,.xml,.yaml,.yml,.log,.sql,.pdf,.doc,.docx,.xls,.xlsx,.xlsm,.ppt,.pptx,.png,.jpg,.jpeg,.webp,.zip,.rar,.7z,.tar,.gz,.tgz,.bz2,text/*,application/json,application/pdf,application/zip,application/x-rar-compressed,application/x-7z-compressed"
                      onChange={event => {
                        const file = event.target.files?.[0] ?? null;
                        setCleaningFile(file);
                        setCleaningResult(null);
                        setCleaningError('');
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={handleUploadCleaningFile}
                    disabled={!cleaningFile || isCleaningUploading}
                  >
                    <Upload />
                    <span>{isCleaningUploading ? '清洗中' : '上传清洗'}</span>
                  </button>
                </div>

                {cleaningError ? <p className="admin-inline-error">{cleaningError}</p> : null}

                {cleaningResult ? (
                  <div className="admin-cleaning-result">
                    <div className="admin-cleaning-stats">
                      <p>
                        <span>文件</span>
                        <strong>{cleaningResult.filename}</strong>
                      </p>
                      <p>
                        <span>大小</span>
                        <strong>{Math.round(cleaningResult.bytes / 1024)} KB</strong>
                      </p>
                      <p>
                        <span>处理方式</span>
                        <strong>{cleaningModeText(cleaningResult.mode)}</strong>
                      </p>
                      <p>
                        <span>原始字符</span>
                        <strong>{cleaningResult.stats.originalLength}</strong>
                      </p>
                      <p>
                        <span>清洗后</span>
                        <strong>{cleaningResult.stats.cleanedLength}</strong>
                      </p>
                      <p>
                        <span>移除行</span>
                        <strong>{cleaningResult.stats.removedLines}</strong>
                      </p>
                      <p>
                        <span>重复行</span>
                        <strong>{cleaningResult.stats.dedupedLines}</strong>
                      </p>
                    </div>
                    {cleaningResult.savedFiles?.length ? (
                      <div className="admin-saved-files">
                        <strong>服务器已保存</strong>
                        {cleaningResult.savedFiles.map(file => (
                          <p key={`${file.kind}-${file.path}`}>
                            <span>{file.kind === 'cleaned' ? '清洗结果' : '原始文件'}</span>
                            <code>{file.path}</code>
                          </p>
                        ))}
                      </div>
                    ) : null}
                    {cleaningResult.mode === 'cleaned' ? (
                      <>
                        <div className="admin-cleaning-actions">
                          <button type="button" onClick={handleDownloadCleaningResult}>
                            <Download />
                            <span>下载清洗结果</span>
                          </button>
                        </div>
                        <textarea readOnly value={cleaningResult.text} aria-label="清洗后的文本" />
                      </>
                    ) : (
                      <div className="admin-cleaning-guidance">
                        <strong>{cleaningResult.message}</strong>
                        <ol>
                          {cleaningResult.suggestedSteps.map(step => (
                            <li key={step}>{step}</li>
                          ))}
                        </ol>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="admin-panel">
              <div className="admin-panel-head">
                <span>任务记录</span>
                <strong>最近采集任务</strong>
              </div>
              <div className="admin-table admin-task-table">
                <div className="admin-table-row admin-table-head">
                  <span>关键词</span>
                  <span>来源</span>
                  <span>状态</span>
                  <span>找到/入库</span>
                  <span>时间</span>
                </div>
                {collectionTasks.slice(0, 8).map(task => (
                  <div className="admin-table-row" key={task.id}>
                    <span>{task.keyword}</span>
                    <span>{sourceTypeText(task.sourceType)}</span>
                    <span>{taskStatusText(task.status)}</span>
                    <span>{task.totalFound} / {task.totalSaved}</span>
                    <span>{formatDate(task.createdAt)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="admin-panel">
              <div className="admin-panel-head">
                <span>资讯入库</span>
                <strong>采集资讯</strong>
              </div>
              <div className="admin-table admin-article-table">
                <div className="admin-table-row admin-table-head">
                  <span>标题</span>
                  <span>摘要</span>
                  <span>标签</span>
                  <span>状态</span>
                  <span>操作</span>
                </div>
                {collectionArticles.map(article => (
                  <div className="admin-table-row" key={article.id}>
                    <span>
                      <strong>{article.title}</strong>
                      <small>{article.sourceName ?? '未知来源'} · {formatDate(article.publishedAt)}</small>
                    </span>
                    <span>{article.aiSummary ?? '-'}</span>
                    <span>{newsListText(article.tags)}</span>
                    <span>{articleStatusText(article.status)}</span>
                    <span className="admin-row-actions">
                      <a href={article.sourceUrl} target="_blank" rel="noreferrer" aria-label="打开原文">
                        <ExternalLink />
                      </a>
                      <button
                        type="button"
                        onClick={() =>
                          handleArticleStatus(
                            article.id,
                            article.status === 'published' ? 'hidden' : 'published'
                          )
                        }
                      >
                        {article.status === 'published' ? '隐藏' : '发布'}
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </motion.section>
        ) : null}

        {activeTab === 'audit' && canViewAudit ? (
          <motion.section
            className="admin-view admin-panel"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35 }}
          >
            <div className="admin-panel-head">
              <span>访问记录</span>
              <strong>操作审计</strong>
            </div>
            <div className="admin-table admin-audit-table">
              <div className="admin-table-row admin-table-head">
                <span>动作</span>
                <span>账号</span>
                <span>详情</span>
                <span>IP</span>
                <span>时间</span>
              </div>
              {logs.map(log => (
                <div className="admin-table-row" key={log.id}>
                  <span>{log.action}</span>
                  <span>{log.actorUsername ?? '系统'}</span>
                  <span>{auditDetailText(log)}</span>
                  <span>{log.ipAddress ?? '未记录'}</span>
                  <span>{formatDate(log.createdAt)}</span>
                </div>
              ))}
            </div>
          </motion.section>
        ) : null}

        {activeTab === 'ragflow' && visibleTabs.some(tab => tab.id === 'ragflow') ? (
          <motion.section
            className="admin-view admin-ragflow"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35 }}
          >
            <div className="admin-panel admin-ragflow-hero">
              <Globe2 />
              <div>
                <span>知识库连接</span>
                <strong>{statusText}</strong>
                <p>{ragflowStatus?.message ?? ragflowStatus?.baseURL ?? summary?.ragflow.baseURL}</p>
              </div>
              <button type="button" onClick={checkRagflow}>
                <RefreshCw />
                <span>重新检测</span>
              </button>
            </div>

            <div className="admin-status-lines admin-panel">
              <p>
                <span>HTTP 状态</span>
                <strong>{ragflowStatus?.status ?? '未检测'}</strong>
              </p>
              <p>
                <span>响应耗时</span>
                <strong>{ragflowStatus?.latencyMs ? `${ragflowStatus.latencyMs}ms` : '未记录'}</strong>
              </p>
              <p>
                <span>模型</span>
                <strong>{summary?.ragflow.model ?? '未配置'}</strong>
              </p>
              <p>
                <span>Chat ID</span>
                <strong>{summary?.ragflow.chatId ?? '未配置'}</strong>
              </p>
            </div>
          </motion.section>
        ) : null}

        {userEditorMode ? (
          <div className="admin-modal-layer" role="dialog" aria-modal="true" aria-label="用户表单">
            <motion.div
              className="admin-user-editor"
              initial={{ opacity: 0, y: 18, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.24 }}
            >
              <div className="admin-editor-head">
                <div>
                  <span>账号维护</span>
                  <strong>{userEditorMode === 'create' ? '新增用户' : '编辑用户'}</strong>
                </div>
                <button type="button" onClick={closeUserEditor} aria-label="关闭">
                  <X />
                </button>
              </div>

              <div className="admin-editor-grid">
                <label>
                  <span>登录账号</span>
                  <input
                    value={userForm.username}
                    onChange={event => setUserForm({ ...userForm, username: event.target.value })}
                    placeholder="例如 hqu_admin"
                  />
                </label>
                <label>
                  <span>显示名称</span>
                  <input
                    value={userForm.displayName}
                    onChange={event => setUserForm({ ...userForm, displayName: event.target.value })}
                    placeholder="例如 数据管理员"
                  />
                </label>
                <label>
                  <span>角色</span>
                  <select
                    value={userForm.role}
                    onChange={event => handleUserRoleChange(event.target.value as AdminRole)}
                  >
                    <option value="viewer">观察员</option>
                    <option value="admin">管理员</option>
                    <option value="super_admin">超级管理员</option>
                  </select>
                </label>
                <label>
                  <span>状态</span>
                  <select
                    value={userForm.status}
                    onChange={event =>
                      setUserForm({
                        ...userForm,
                        status: event.target.value as 'active' | 'disabled',
                      })
                    }
                  >
                    <option value="active">启用</option>
                    <option value="disabled">停用</option>
                  </select>
                </label>
                <label>
                  <span>{userEditorMode === 'create' ? '初始密码' : '重置密码'}</span>
                  <input
                    type="password"
                    value={userForm.password}
                    onChange={event => setUserForm({ ...userForm, password: event.target.value })}
                    placeholder={userEditorMode === 'create' ? '至少 6 位' : '留空则不修改'}
                  />
                </label>
                <div className="admin-permission-field">
                  <span>后台权限</span>
                  <div className="admin-permission-options">
                    {configurableAdminTabs.map(tab => (
                      <label key={tab.id}>
                        <input
                          type="checkbox"
                          checked={userForm.menuPermissions.includes(tab.id)}
                          disabled={userForm.role !== 'admin'}
                          onChange={() => toggleUserPermission(tab.id)}
                        />
                        <span>{menuPermissionLabel(tab.id)}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <label>
                  <span>邮箱</span>
                  <input
                    value={userForm.email}
                    onChange={event => setUserForm({ ...userForm, email: event.target.value })}
                    placeholder="可选"
                  />
                </label>
                <label>
                  <span>电话</span>
                  <input
                    value={userForm.phone}
                    onChange={event => setUserForm({ ...userForm, phone: event.target.value })}
                    placeholder="可选"
                  />
                </label>
              </div>

              {userActionError ? <p className="admin-inline-error">{userActionError}</p> : null}

              <div className="admin-editor-actions">
                <button type="button" onClick={closeUserEditor}>
                  取消
                </button>
                <button type="button" onClick={handleSaveUser} disabled={isSavingUser}>
                  <CheckCircle2 />
                  <span>{isSavingUser ? '保存中' : '保存用户'}</span>
                </button>
              </div>
            </motion.div>
          </div>
        ) : null}
      </section>
    </main>
  );
}
