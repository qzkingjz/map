import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import {
  ArrowDownRight,
  FileText,
  Globe2,
  Landmark,
  ShipWheel,
} from 'lucide-react';
import AiMapExperience from './components/AiMapExperience';
import AdminDashboard from './components/AdminDashboard';
import LatestNewsPage from './components/LatestNewsPage';
import LoginPage from './components/LoginPage';
import QuanzhouExhibitMap, { MigrationPoint } from './components/QuanzhouExhibitMap';
import heritageNanyangImage from './assets/heritage-nanyang.png';
import { AdminUser, getCurrentAdmin, logoutAdmin, recordPageView } from './lib/adminApi';

const migrationPoints: MigrationPoint[] = [
  {
    name: '马来西亚',
    coord: [101.6869, 3.139],
    value: 43,
    label: '约43万人',
    note: '槟城、雪兰莪、柔佛、马六甲等地形成密集同乡网络。',
  },
  {
    name: '印度尼西亚',
    coord: [106.8456, -6.2088],
    value: 33,
    label: '约33万人',
    note: '爪哇岛与苏门答腊岛商贸港口，是传统泉商深耕区域。',
  },
  {
    name: '菲律宾',
    coord: [120.9842, 14.5995],
    value: 30,
    label: '约30万人',
    note: '依托南海地缘邻近优势，商贸往来频密。',
  },
  {
    name: '新加坡',
    coord: [103.8198, 1.3521],
    value: 20,
    label: '约20万人',
    note: '从乡村开发到金融、建筑、房地产，跨代社群延续清晰。',
  },
  {
    name: '缅甸',
    coord: [96.1951, 16.8661],
    value: 6.2,
    label: '约6.2万人',
    note: '东南亚次核心聚集地，商贸与血缘聚落稳固。',
  },
  {
    name: '泰国',
    coord: [100.5018, 13.7563],
    value: 4.1,
    label: '约4.1万人',
    note: '海丝沿线重要节点，维系宗亲与经贸双重联系。',
  },
];

const globalStats = [
  ['948万', '泉籍华侨华人'],
  ['130', '国家和地区'],
  ['8000+', '海外泉籍社团'],
  ['90%', '集中在东南亚等海丝沿线'],
];

const economyStats = [
  { label: '2024年GDP', value: '13094.87亿元', width: 92, detail: '同比增长6.5%，领跑27个万亿城市。' },
  { label: '2026年一季度规上工业', value: '+6.5%', width: 68, detail: '工业基本盘回稳，36个大类中26个正增长。' },
  { label: '机械装备产业', value: '+14.1%', width: 84, detail: '先进制造成为侨资与民营经济的新动能。' },
  { label: '侨商投资贸易大会', value: '近1500亿元', width: 96, detail: '79个国家和地区侨商参与，刷新签约纪录。' },
];

const heritageZones = [
  ['鲤城区', '76处', '石崎街洋楼群、中山路骑楼建筑群、郭氏洋楼等。'],
  ['丰泽区', '15处', '虫寻埔村黄宅、环山村洋楼民居、陈氏祠堂等。'],
  ['洛江区', '7处', '彭氏家庙、双溪村民居、前埭何氏宗祠等。'],
];

const memoryItems = [
  {
    icon: FileText,
    title: '侨批档案',
    body: '海外华侨银信兼具汇款凭证与家书情感，2013年入选联合国教科文组织《世界记忆名录》。',
  },
  {
    icon: Globe2,
    title: '寻根平台',
    body: '南洋华裔族群寻根谒祖综合服务平台将谱牒、宗祠、侨情数据库转译为数字人文基础设施。',
  },
  {
    icon: Landmark,
    title: '文化品牌',
    body: '泉州侨批馆成为世界记忆项目教育和研究分委员会国内首个协作单位，推动侨乡记忆国际化。',
  },
];

export default function App() {
  const [view, setView] = useState<'exhibit' | 'map'>('exhibit');
  const [activePoint, setActivePoint] = useState<MigrationPoint>(migrationPoints[0]);
  const [route, setRoute] = useState(window.location.pathname);
  const [authUser, setAuthUser] = useState<AdminUser | null>(null);
  const [authStatus, setAuthStatus] = useState<'checking' | 'authenticated' | 'anonymous'>('checking');

  useEffect(() => {
    const handlePopState = () => setRoute(window.location.pathname);
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  function navigate(
    path: string,
    state: Record<string, unknown> = {},
    options: { replace?: boolean } = {}
  ) {
    if (options.replace) {
      window.history.replaceState(state, '', path);
    } else {
      window.history.pushState(state, '', path);
    }
    setRoute(path);
  }

  async function handleLogout() {
    try {
      await logoutAdmin();
    } finally {
      setAuthUser(null);
      setAuthStatus('anonymous');
      setView('exhibit');
      navigate('/login', {}, { replace: true });
    }
  }

  function recordSectionView(page: string) {
    void recordPageView(page, `${route}${window.location.hash}`);
  }

  useEffect(() => {
    let isActive = true;

    async function checkSession() {
      if (route === '/login') {
        setAuthStatus('anonymous');
        return;
      }

      setAuthStatus('checking');

      try {
        const user = await getCurrentAdmin();
        if (!isActive) return;

        if (!user) {
          setAuthUser(null);
          setAuthStatus('anonymous');
          navigate('/login', {}, { replace: true });
          return;
        }

        setAuthUser(user);
        setAuthStatus('authenticated');

        if (route === '/admin' && user.role !== 'super_admin' && user.role !== 'admin') {
          navigate('/', { authenticatedEntry: true }, { replace: true });
        }
      } catch {
        if (!isActive) return;
        setAuthUser(null);
        setAuthStatus('anonymous');
        navigate('/login', {}, { replace: true });
      }
    }

    void checkSession();

    return () => {
      isActive = false;
    };
  }, [route]);

  useEffect(() => {
    if (authStatus !== 'authenticated') return;

    if (route === '/') {
      void recordPageView(view === 'map' ? '侨情监测' : '展示首页', route);
    }
    if (route === '/latest') {
      void recordPageView('最新侨情', route);
    }
  }, [authStatus, route, view]);

  if (route === '/login') {
    return (
        <LoginPage
        onLogin={user => {
          setAuthUser(user);
          setAuthStatus('authenticated');
          const canEnterAdmin = user.role === 'super_admin' || user.role === 'admin';
          navigate(
            canEnterAdmin ? '/admin' : '/',
            canEnterAdmin ? {} : { authenticatedEntry: true }
          );
        }}
        onBackHome={() => navigate('/login')}
      />
    );
  }

  if (authStatus === 'checking' || !authUser) {
    return (
      <main className="admin-auth-loading">
        <div>
          <span>泉州华侨大学</span>
          <strong>正在校验登录状态</strong>
        </div>
      </main>
    );
  }

  if (route === '/admin') {
    return (
      <AdminDashboard
        onRequireLogin={() => navigate('/login')}
        onBackHome={() => {
          navigate('/', { authenticatedEntry: true });
        }}
      />
    );
  }

  if (route === '/latest') {
    return <LatestNewsPage onBack={() => navigate('/')} />;
  }

  if (view === 'map') {
    return <AiMapExperience onBack={() => setView('exhibit')} />;
  }

  return (
    <main className="qz-site">
      <header className="qz-nav">
        <a href="#top" className="qz-brand">
          <span>泉州华侨研究</span>
          <strong>世界泉州</strong>
        </a>
        <nav>
          <a href="#atlas" onClick={() => recordSectionView('时空图谱')}>
            时空图谱
          </a>
          <a href="#economy" onClick={() => recordSectionView('经济动能')}>
            经济动能
          </a>
          <a href="#memory" onClick={() => recordSectionView('文化根脉')}>
            文化根脉
          </a>
          <a href="#heritage" onClick={() => recordSectionView('建筑遗产')}>
            建筑遗产
          </a>
          <button type="button" onClick={() => navigate('/latest')}>
            最新侨情
          </button>
          <button type="button" onClick={() => setView('map')}>
            侨情监测
          </button>
          <button className="qz-logout" type="button" onClick={handleLogout}>
            退出系统
          </button>
        </nav>
      </header>

      <section id="top" className="qz-hero">
        <div className="qz-hero-visual" aria-hidden="true">
          <div className="qz-roofline" />
          <div className="qz-sea-route route-one" />
          <div className="qz-sea-route route-two" />
          <div className="qz-brick-field" />
        </div>

        <motion.div
          className="qz-hero-copy"
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: 'easeOut' }}
        >
          <span className="qz-kicker">海丝起点 · 世界侨乡 · 闽南红砖</span>
          <h1>世界泉州</h1>
          <p>
            一座因海而立、因侨而兴的城市。这个数字展把泉州华侨的跨国迁徙、产业反哺、
            侨批记忆与番仔楼遗产，整理成一条可浏览、可感知的海丝叙事。
          </p>
          <div className="qz-hero-actions">
            <a href="#atlas" onClick={() => recordSectionView('进入展厅')}>
              进入展厅
            </a>
            <button type="button" onClick={() => setView('map')}>
              侨情监测
            </button>
            <a href="#heritage" onClick={() => recordSectionView('查看遗产')}>
              查看遗产
            </a>
            <button type="button" onClick={() => navigate('/latest')}>
              最新侨情
            </button>
          </div>
        </motion.div>

        <motion.div
          className="qz-stat-ribbon"
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25, duration: 0.7 }}
        >
          {globalStats.map(([value, label]) => (
            <div key={label}>
              <strong>{value}</strong>
              <span>{label}</span>
            </div>
          ))}
        </motion.div>
      </section>

      <section id="atlas" className="qz-section qz-atlas">
        <div className="qz-section-head">
          <span>第一展厅</span>
          <h2>时空图谱：百万华侨的跨国足迹</h2>
          <p>泉籍华侨以东南亚为核心聚集圈，同时向全球130个国家和地区放射分布。</p>
        </div>

        <div className="qz-atlas-layout">
          <QuanzhouExhibitMap
            points={migrationPoints}
            activePoint={activePoint}
            onSelect={setActivePoint}
          />

          <aside className="qz-map-inspector">
            <span>当前节点</span>
            <h3>{activePoint.name}</h3>
            <strong>{activePoint.label}</strong>
            <p>{activePoint.note}</p>
            <div className="qz-point-list">
              {migrationPoints.map(point => (
                <button
                  key={point.name}
                  type="button"
                  className={point.name === activePoint.name ? 'is-active' : ''}
                  onClick={() => setActivePoint(point)}
                >
                  {point.name}
                </button>
              ))}
            </div>
          </aside>
        </div>
      </section>

      <section id="economy" className="qz-section qz-economy">
        <div className="qz-section-head">
          <span>第二展厅</span>
          <h2>经济动能：从侨汇到千亿产业</h2>
          <p>泉州模式从侨汇赡养、公益建设，升级为侨商资本与现代产业链的双向奔赴。</p>
        </div>

        <div className="qz-economy-grid">
          {economyStats.map((item, index) => (
            <motion.div
              className="qz-bar-row"
              key={item.label}
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.35 }}
              transition={{ delay: index * 0.08, duration: 0.45 }}
            >
              <div>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
                <p>{item.detail}</p>
              </div>
              <div className="qz-bar-track">
                <motion.i
                  initial={{ width: 0 }}
                  whileInView={{ width: `${item.width}%` }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.8, ease: 'easeOut' }}
                />
              </div>
            </motion.div>
          ))}
        </div>
      </section>

      <section id="memory" className="qz-section qz-memory">
        <div className="qz-section-head">
          <span>第三展厅</span>
          <h2>文化根脉：侨批与寻根平台</h2>
          <p>当代泉州正在用档案、平台与数字人文，把跨国亲缘重新组织成可持续的认同坐标。</p>
        </div>

        <div className="qz-memory-grid">
          {memoryItems.map(({ icon: Icon, title, body }) => (
            <motion.article
              key={title}
              className="qz-memory-item"
              whileHover={{ y: -6 }}
              transition={{ type: 'spring', stiffness: 260, damping: 20 }}
            >
              <Icon />
              <h3>{title}</h3>
              <p>{body}</p>
            </motion.article>
          ))}
        </div>
      </section>

      <section id="heritage" className="qz-section qz-heritage">
        <div className="qz-section-head">
          <span>第四展厅</span>
          <h2>建筑遗产：百年番仔楼里的家国情</h2>
          <p>番仔楼、红砖厝与骑楼街区记录着海外资本回流后的审美融合，也记录着侨乡社会的公共记忆。</p>
        </div>

        <div className="qz-heritage-layout">
          <img
            className="qz-building-figure"
            src={heritageNanyangImage}
            alt="泉州番仔楼与南洋回流意象"
          />
          <div className="qz-heritage-table">
            {heritageZones.map(([zone, count, desc]) => (
              <div key={zone}>
                <strong>{zone}</strong>
                <span>{count}</span>
                <p>{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="qz-footer">
        <div>
          <ShipWheel />
          <span>资料依据：zanshi.md 与《泉州华侨研究深度指南.pdf》</span>
        </div>
        <a href="#top">
          回到顶部
          <ArrowDownRight />
        </a>
      </footer>
    </main>
  );
}
