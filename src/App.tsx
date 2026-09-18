import { useMemo, useState } from 'react';
import type { Role, User, Notification } from '../shared/types.js';
import { ROLE_LABEL } from '../shared/types.js';
import { useLogin, useStateQuery, getToken, setToken, clearToken, useMe, type AppState } from './api.js';
import { ToastHost, useNotify, Badge } from './ui.js';
import { ResidentPage } from './pages/resident.js';
import { FrontdeskPage } from './pages/frontdesk.js';
import { LifeguardPage } from './pages/lifeguard.js';
import { CleanerPage } from './pages/cleaner.js';
import { MaintenancePage } from './pages/maintenance.js';
import { OpsPage } from './pages/ops.js';
import { NotifyBell } from './components/notifications.js';

const DEMO: { username: string; role: Role; desc: string }[] = [
  { username: 'zhang', role: 'resident', desc: '张为民·金卡居民（深水证）' },
  { username: 'li', role: 'resident', desc: '李娟·银卡居民（亲子）' },
  { username: 'wang', role: 'resident', desc: '王建国·老人晨泳' },
  { username: 'zhao', role: 'resident', desc: '赵晓·外来访客' },
  { username: 'lan', role: 'resident', desc: '蓝鲸培训·机构账号' },
  { username: 'frontdesk', role: 'frontdesk', desc: '陈前台' },
  { username: 'lifeguard', role: 'lifeguard', desc: '刘救生（深水台）' },
  { username: 'lifeguard2', role: 'lifeguard', desc: '周救生（儿童区）' },
  { username: 'cleaner', role: 'cleaner', desc: '吴保洁' },
  { username: 'maintenance', role: 'maintenance', desc: '郑维修' },
  { username: 'ops', role: 'ops', desc: '孙运营（总指挥）' },
];

function Login() {
  const login = useLogin();
  const notify = useNotify();
  const [username, setUsername] = useState('ops');
  const [password, setPassword] = useState('123456');

  const submit = (u?: string, p?: string) => {
    login.mutate(
      { username: u ?? username, password: p ?? password },
      {
        onSuccess: (r) => {
          setToken(r.token);
          localStorage.setItem('pool-user', JSON.stringify(r.user));
          location.hash = '';
          location.reload();
        },
        onError: (e) => notify.err(e),
      },
    );
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-hero">
          <h1>🏊 蓝鲸社区泳池<br />预约入场与安全巡查协同平台</h1>
          <p>居民预约、前台核验、救生巡查、水质监测、保洁维修与运营指挥，围绕同一场次共享同一份实时状态。</p>
          <ul>
            <li>泳道 / 亲子 / 老人晨泳 / 访客 / 团体 / 教练课 / 机构包场</li>
            <li>健康承诺 · 健康码 · 儿童陪同人 · 储物柜 · 深水权限</li>
            <li>水温 / 余氯 / 浊度 / pH 自动判异，异常即限流立案</li>
            <li>雷雨、抽筋、走失、超额等事件五角色同屏协同</li>
            <li>抽筋救援记录：泳道临停、换岗/恢复三确认、站位调整带入下一场、复盘进培训排班</li>
            <li>闭池一键联动退费、补偿券、复测、清场与居民通知</li>
          </ul>
        </div>
        <div className="login-form">
          <h2>选择工作台登录</h2>
          <div className="sub">所有演示账号密码均为 <b className="code-mono">123456</b></div>
          <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <label className="field">用户名
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
            </label>
            <div style={{ height: 10 }} />
            <label className="field">密码
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <div style={{ height: 14 }} />
            <button className="btn block" disabled={login.isPending}>登录工作台</button>
          </form>
          <div className="account-grid">
            {DEMO.map((d) => (
              <button key={d.username} className="account-chip" onClick={() => submit(d.username, '123456')}>
                <b>{ROLE_LABEL[d.role]} · {d.username}</b>
                <span>{d.desc}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const NAV: Record<Role, { key: string; label: string; icon: string }[]> = {
  resident: [
    { key: 'book', label: '预约入场', icon: '🎟️' },
    { key: 'mine', label: '我的预约·钱包', icon: '👛' },
    { key: 'lesson', label: '教练课', icon: '🏅' },
    { key: 'rental', label: '机构包场', icon: '🏢' },
    { key: 'notice', label: '通告与投诉', icon: '📣' },
  ],
  frontdesk: [
    { key: 'checkin', label: '入场核验台', icon: '✅' },
    { key: 'rental', label: '包场当天核验', icon: '🏢' },
    { key: 'locker', label: '储物柜与在场', icon: '🗄️' },
    { key: 'incident', label: '事件协同', icon: '🚨' },
    { key: 'notice', label: '现场通告', icon: '📣' },
  ],
  lifeguard: [
    { key: 'board', label: '实时看板', icon: '🌊' },
    { key: 'rescue', label: '抽筋救援', icon: '🆘' },
    { key: 'rental', label: '包场站位/巡查', icon: '🏢' },
    { key: 'water', label: '水质检测', icon: '🧪' },
    { key: 'patrol', label: '救生巡查', icon: '🔭' },
    { key: 'guard', label: '站位与换岗', icon: '🛟' },
    { key: 'incident', label: '事件协同', icon: '🚨' },
  ],
  cleaner: [
    { key: 'tasks', label: '我的工单', icon: '🧹' },
    { key: 'rental', label: '包场保洁保障', icon: '🏢' },
    { key: 'patrol', label: '巡查上报', icon: '🔭' },
    { key: 'incident', label: '事件协同', icon: '🚨' },
  ],
  maintenance: [
    { key: 'tasks', label: '维修/消毒工单', icon: '🔧' },
    { key: 'rental', label: '包场设备/复测', icon: '🏢' },
    { key: 'equip', label: '设备与水质复测', icon: '⚙️' },
    { key: 'incident', label: '事件协同', icon: '🚨' },
  ],
  ops: [
    { key: 'command', label: '场次指挥台', icon: '🎛️' },
    { key: 'rescue', label: '救援复盘培训', icon: '🆘' },
    { key: 'conflict', label: '包场冲突协调', icon: '⚖️' },
    { key: 'close', label: '闭池与恢复', icon: '🌧️' },
    { key: 'incident', label: '事件指挥', icon: '🚨' },
    { key: 'tasks', label: '工单派发', icon: '📋' },
    { key: 'complaint', label: '居民投诉', icon: '📨' },
  ],
};

function Shell({ user, state }: { user: User; state: AppState }) {
  const [tab, setTab] = useState(NAV[user.role][0].key);
  const page = () => {
    switch (user.role) {
      case 'resident': return <ResidentPage user={user} state={state} tab={tab} />;
      case 'frontdesk': return <FrontdeskPage user={user} state={state} tab={tab} />;
      case 'lifeguard': return <LifeguardPage user={user} state={state} tab={tab} />;
      case 'cleaner': return <CleanerPage user={user} state={state} tab={tab} />;
      case 'maintenance': return <MaintenancePage user={user} state={state} tab={tab} />;
      case 'ops': return <OpsPage user={user} state={state} tab={tab} />;
    }
  };
  const critical = state.notifications.filter((n) => n.level === 'critical' && (n.roles.length === 0 || n.roles.includes(user.role) || n.userId === user.id)).length;
  // 抽筋救援待办：救生员=临停中/收尾未完成/有未确认关注泳道；运营=三确认完成待复盘
  const rescueTodo = user.role === 'lifeguard'
    ? state.boards.reduce((n, b) => n + b.suspendedLanes.length + b.focusLanes.filter((f) => !f.ackAt).length, 0)
      + state.crampRescues.filter((r) => !r.laneSuspended && !r.reviewedAt
        && (['guard_relief', 'lane_reopen', 'order_restored'] as const).some((k) => !r.closure[k].done)).length
    : user.role === 'ops'
      ? state.crampRescues.filter((r) => !r.reviewedAt
        && (['guard_relief', 'lane_reopen', 'order_restored'] as const).every((k) => r.closure[k].done)).length
      : 0;
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand"><span className="logo">🏊</span> 蓝鲸泳池协同</div>
        {NAV[user.role].map((n) => (
          <button key={n.key} className={`nav-item ${tab === n.key ? 'active' : ''}`} onClick={() => setTab(n.key)}>
            <span>{n.icon}</span>{n.label}
            {n.key.includes('incident') && state.incidents.some((i) => i.status !== 'resolved' && (i.tasks.some((t) => t.role === user.role && !t.done) || user.role === 'ops')) && (
              <span className="badge danger" style={{ marginLeft: 'auto' }}>
                {state.incidents.filter((i) => i.status !== 'resolved' && (i.tasks.some((t) => t.role === user.role && !t.done) || user.role === 'ops')).length}
              </span>
            )}
            {n.key === 'rescue' && rescueTodo > 0 && (
              <span className="badge danger" style={{ marginLeft: 'auto' }}>{rescueTodo}</span>
            )}
          </button>
        ))}
        <div className="sidebar-foot">
          <div><b>{user.name}</b></div>
          <div>{ROLE_LABEL[user.role]}{user.memberTier ? ` · ${user.id}` : ''}</div>
          <button className="btn ghost sm" onClick={() => { clearToken(); localStorage.removeItem('pool-user'); location.reload(); }}>退出登录</button>
        </div>
      </aside>
      <main className="main">
        <div className="topbar">
          <h1>{NAV[user.role].find((n) => n.key === tab)?.label}</h1>
          <div className="flex">
            <span className="poll-dot"><i />实时同步 4s</span>
            {critical > 0 && <Badge tone="danger">{critical} 条紧急通告</Badge>}
            <NotifyBell user={user} notifications={state.notifications} />
            <span className="who">{user.name} · {ROLE_LABEL[user.role]}</span>
          </div>
        </div>
        {page()}
      </main>
    </div>
  );
}

function Root() {
  const hasToken = !!getToken();
  const me = useMe();
  const stateQ = useStateQuery();
  const cachedUser = useMemo(() => {
    try { return JSON.parse(localStorage.getItem('pool-user') || 'null') as User | null; } catch { return null; }
  }, []);
  const [, force] = useState(0);

  if (!hasToken) return <Login />;
  if (me.isLoading || stateQ.isLoading) {
    return <div className="login-wrap"><div className="card" style={{ padding: 30 }}>正在加载现场状态…</div></div>;
  }
  if (me.isError || !me.data || !stateQ.data) {
    clearToken();
    localStorage.removeItem('pool-user');
    return <Login />;
  }
  const user = me.data.user;
  localStorage.setItem('pool-user', JSON.stringify(user));
  void cachedUser;
  void force;
  return <Shell user={user} state={stateQ.data} />;
}

export function App() {
  return <ToastHost><Root /></ToastHost>;
}
