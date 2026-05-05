import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowLeft, ExternalLink, Newspaper, RefreshCw } from 'lucide-react';
import { NewsArticle, getLatestNews, getLatestNewsDetail } from '../lib/adminApi';

interface LatestNewsPageProps {
  onBack: () => void;
}

function formatDate(value?: string | null): string {
  if (!value) return '未记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function listValue(value: NewsArticle['tags']): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export default function LatestNewsPage({ onBack }: LatestNewsPageProps) {
  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedArticle, setSelectedArticle] = useState<NewsArticle | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const selectedTags = useMemo(() => listValue(selectedArticle?.tags), [selectedArticle]);
  const selectedPoints = useMemo(
    () => listValue(selectedArticle?.qiaoqingPoints),
    [selectedArticle]
  );

  async function loadArticles() {
    setError('');
    setIsLoading(true);

    try {
      const nextArticles = await getLatestNews(60);
      setArticles(nextArticles);
      if (nextArticles[0]) {
        setSelectedId(nextArticles[0].id);
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : '最新侨情加载失败');
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadArticles();
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setSelectedArticle(null);
      return;
    }

    let isActive = true;
    getLatestNewsDetail(selectedId)
      .then(article => {
        if (isActive) setSelectedArticle(article);
      })
      .catch(caughtError => {
        if (isActive) {
          setError(caughtError instanceof Error ? caughtError.message : '资讯详情加载失败');
        }
      });

    return () => {
      isActive = false;
    };
  }, [selectedId]);

  return (
    <main className="latest-news-page">
      <header className="latest-news-topbar">
        <button type="button" onClick={onBack}>
          <ArrowLeft />
          <span>返回首页</span>
        </button>
        <button type="button" onClick={loadArticles} disabled={isLoading}>
          <RefreshCw />
          <span>{isLoading ? '刷新中' : '刷新资讯'}</span>
        </button>
      </header>

      <section className="latest-news-heading">
        <span>最新侨情</span>
        <h1>侨情资讯</h1>
        <p>按发布时间倒序展示后台采集并整理后的侨情资讯，点击条目查看摘要、要点和原文链接。</p>
      </section>

      {error ? <p className="latest-news-error">{error}</p> : null}

      <section className="latest-news-layout">
        <div className="latest-news-list">
          {articles.length === 0 && !isLoading ? (
            <div className="latest-news-empty">暂无采集资讯，请先在后台运行数据采集。</div>
          ) : null}
          {articles.map(article => (
            <button
              key={article.id}
              type="button"
              className={article.id === selectedId ? 'is-active' : ''}
              onClick={() => setSelectedId(article.id)}
            >
              <span>{formatDate(article.publishedAt ?? article.createdAt)}</span>
              <strong>{article.title}</strong>
              <small>{article.sourceName ?? '未知来源'}</small>
            </button>
          ))}
        </div>

        <motion.article
          className="latest-news-detail"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
        >
          {selectedArticle ? (
            <>
              <div className="latest-news-detail-kicker">
                <Newspaper />
                <span>{selectedArticle.sourceName ?? '资讯来源'}</span>
              </div>
              <h2>{selectedArticle.title}</h2>
              <time>{formatDate(selectedArticle.publishedAt ?? selectedArticle.createdAt)}</time>
              <p>{selectedArticle.aiSummary ?? selectedArticle.rawExcerpt ?? '暂无摘要'}</p>

              {selectedPoints.length > 0 ? (
                <div className="latest-news-points">
                  <span>侨情要点</span>
                  {selectedPoints.map(point => (
                    <strong key={point}>{point}</strong>
                  ))}
                </div>
              ) : null}

              {selectedTags.length > 0 ? (
                <div className="latest-news-tags">
                  {selectedTags.map(tag => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
              ) : null}

              <a href={selectedArticle.sourceUrl} target="_blank" rel="noreferrer">
                <ExternalLink />
                <span>查看原文</span>
              </a>
            </>
          ) : (
            <div className="latest-news-empty">请选择一条资讯查看详情。</div>
          )}
        </motion.article>
      </section>
    </main>
  );
}
