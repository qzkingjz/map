import { FormEvent, useEffect, useState } from 'react';
import { motion } from 'motion/react';
import {
  ArrowRight,
  Database,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { AdminUser, LoginCaptcha, getLoginCaptcha, loginAdmin } from '../lib/adminApi';

interface LoginPageProps {
  onLogin: (user: AdminUser) => void;
  onBackHome: () => void;
}

export default function LoginPage({ onLogin, onBackHome }: LoginPageProps) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [captchaAnswer, setCaptchaAnswer] = useState('');
  const [captcha, setCaptcha] = useState<LoginCaptcha | null>(null);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isCaptchaLoading, setIsCaptchaLoading] = useState(false);

  async function refreshCaptcha() {
    setIsCaptchaLoading(true);
    try {
      const nextCaptcha = await getLoginCaptcha();
      setCaptcha(nextCaptcha);
      setCaptchaAnswer('');
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : '验证码加载失败，请刷新页面重试');
    } finally {
      setIsCaptchaLoading(false);
    }
  }

  useEffect(() => {
    void refreshCaptcha();
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');

    if (!captcha) {
      setError('验证码还未加载完成，请稍后重试');
      return;
    }

    if (!captchaAnswer.trim()) {
      setError('请输入验证码');
      return;
    }

    setIsLoading(true);

    try {
      const user = await loginAdmin(username, password, captcha.id, captchaAnswer);
      onLogin(user);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : '登录失败，请稍后重试');
      void refreshCaptcha();
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className="admin-auth-page">
      <div className="admin-auth-bg" aria-hidden="true">
        <span />
        <i />
      </div>

      <motion.section
        className="admin-auth-hero"
        initial={{ opacity: 0, y: 28 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, ease: 'easeOut' }}
      >
        <button className="admin-ghost-link" type="button" onClick={onBackHome}>
          返回展示首页
        </button>

        <div className="admin-auth-copy">
          <span>侨情数据中枢</span>
          <h1>海丝侨情与侨务治理垂直大模型门户网</h1>
          <p>
            管理知识库连接、系统账号、访问会话与系统日志，保持侨情监测服务稳定运行。
          </p>
        </div>

        <div className="admin-auth-points" aria-label="系统状态">
          <div>
            <ShieldCheck />
            <strong>权限管控</strong>
            <span>会话隔离</span>
          </div>
          <div>
            <Database />
            <strong>RAGFlow MySQL</strong>
            <span>独立业务库</span>
          </div>
        </div>
      </motion.section>

      <motion.form
        className="admin-login-panel"
        onSubmit={handleSubmit}
        initial={{ opacity: 0, x: 24 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: 0.15, duration: 0.55, ease: 'easeOut' }}
      >
        <div className="admin-login-head">
          <span>管理员登录</span>
          <strong>进入后台</strong>
        </div>

        <label>
          <span>账号</span>
          <div>
            <UserRound />
            <input
              autoComplete="username"
              value={username}
              onChange={event => setUsername(event.target.value)}
              placeholder="请输入管理员账号"
            />
          </div>
        </label>

        <label>
          <span>密码</span>
          <div>
            <LockKeyhole />
            <input
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              placeholder="请输入登录密码"
            />
          </div>
        </label>

        <label>
          <span>验证码</span>
          <div className="admin-captcha-row">
            <input
              autoComplete="off"
              inputMode="text"
              maxLength={6}
              value={captchaAnswer}
              onChange={event => setCaptchaAnswer(event.target.value)}
              placeholder="请输入验证码"
            />
            <button
              aria-label="刷新验证码"
              className="admin-captcha-image"
              disabled={isCaptchaLoading}
              type="button"
              onClick={refreshCaptcha}
            >
              {captcha ? (
                <span dangerouslySetInnerHTML={{ __html: captcha.svg }} />
              ) : (
                <small>加载中</small>
              )}
            </button>
            <button
              aria-label="换一张验证码"
              className="admin-captcha-refresh"
              disabled={isCaptchaLoading}
              type="button"
              onClick={refreshCaptcha}
            >
              <RefreshCw />
            </button>
          </div>
        </label>

        {error ? <p className="admin-login-error">{error}</p> : null}

        <button className="admin-primary-action" type="submit" disabled={isLoading}>
          <span>{isLoading ? '正在验证' : '登录系统'}</span>
          <ArrowRight />
        </button>
      </motion.form>
    </main>
  );
}
