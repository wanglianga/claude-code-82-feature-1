import { useState } from 'react';
import type { User, GuardPost, PatrolIssueType, IssueSeverity } from '../../shared/types.js';
import { GUARD_POST_LABEL } from '../../shared/types.js';
import type { AppState } from '../api.js';
import { useAction } from '../api.js';
import {
  Badge, Card, Empty, ISSUE_TYPE_LABEL, SEVERITY_LABEL,
  EQUIPMENT_LABEL, fmtDateTime, useNotify,
} from '../ui.js';
import { SessionPicker, PoolStatusBanner } from '../components/common.js';
import { IncidentList, IncidentCreateForm } from '../components/incident.js';
import { RescueWorkbench, FocusLaneAlerts, zoneLabel } from '../components/cramp.js';
import { RentalFrontline } from '../components/rental-frontline.js';
import { WATER_STD } from '../../shared/logic.js';

type Props = { user: User; state: AppState; tab: string; sessionId?: string };

// ---------- 实时看板 ----------
function Board({ state, sessionId, setSessionId }: { state: AppState; sessionId: string; setSessionId: (s: string) => void }) {
  const board = state.boards.find((b) => b.session.id === sessionId)!;
  const s = board.session;
  const w = board.water;
  const waterBad = (v: number, std: { min: number; max: number }) => v < std.min || v > std.max;

  return (
    <div>
      <SessionPicker sessions={state.sessions} value={sessionId} onChange={setSessionId} />
      <PoolStatusBanner status={s.poolStatus} reason={s.statusReason} requireRetest={s.requireWaterRetest} closedAt={s.closedAt} reopenedAt={s.reopenedAt} />
      <FocusLaneAlerts state={state} sessionId={sessionId} />
      {board.priorRentalNotCleared && (
        <div className="alert danger">⛔ 上一场机构包场 {board.priorRentalNotCleared.code}（{board.priorRentalNotCleared.orgName}）尚未完成清场/水质复测，<b>不得开放本场</b>，请先完成清场恢复门禁。</div>
      )}
      {board.activeRentals.length > 0 && (
        <div className="alert warn">
          🏢 本场机构包场：{board.activeRentals.map((r) => `${r.code} ${r.orgName}（核准 ${r.approvedCapacity} 人${r.actualCount ? `/实际 ${r.actualCount} 人` : ''}，增派救生 ${r.extraLifeguards} 名，${r.status === 'active' ? '进行中' : r.status === 'suspended' ? '已暂停' : '待核验'}）`).join('；')}。请在「包场站位/巡查」按人数重新站位。
        </div>
      )}
      {board.suspendedLanes.length > 0 && (
        <div className="alert danger">⛔ 泳道临停中：
          {board.suspendedLanes.map((l) => `${zoneLabel(state, l.zoneId)} ${l.lane}号道（${l.reason}）`).join('；')}
          。该泳道已停止放行，救援收尾确认后恢复。
        </div>
      )}
      {board.thunderAlert && <div className="alert danger">⛈️ 雷雨临近预警生效中：鸣哨清场流程已启动，所有泳客须立即上岸！</div>}

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <Card><div className="stat"><span className="num">{board.totalInPool}</span><span className="lbl">全场在池人数 / 容量 {board.totalCapacity}</span></div></Card>
        <Card><div className="stat accent"><span className="num">{board.zones.reduce((a, z) => a + z.children, 0)}</span><span className="lbl">儿童区/在场儿童</span></div></Card>
        <Card><div className="stat"><span className="num">{board.guardOnDuty.length}</span><span className="lbl">在岗救生员（{Object.keys(GUARD_POST_LABEL).length} 个站位）</span></div></Card>
        <Card><div className={`stat ${board.openIncidents.length ? 'danger' : ''}`}><span className="num">{board.openIncidents.length}</span><span className="lbl">未关闭事件</span></div></Card>
      </div>

      <div className="grid cols-2">
        <Card title="各泳区实时人数与权限">
          {board.zones.map((z) => {
            const suspended = (s.affectedZoneIds ?? []).includes(z.zoneId);
            return (
            <div key={z.zoneId} className={`zone-card ${z.zoneId === 'deep' ? 'risk-high' : ''} ${suspended ? 'risk-high' : ''}`} style={{ marginBottom: 10, opacity: suspended ? 0.7 : 1 }}>
              <div className="zone-head">
                <b>{z.name}{z.deepCertRequired && <span className="badge danger" style={{ marginLeft: 6 }}>深水权限</span>}{suspended && <span className="badge danger" style={{ marginLeft: 6 }}>暂停开放</span>}</b>
                <span className="small muted">
                  {suspended ? '水质处置中·禁止入池' : `${z.inPool} 在池 / ${z.booked} 待入`}{!suspended && z.locked > 0 && ` / ${z.locked} 商业锁定`} · 容量 {z.capacity}
                </span>
              </div>
              <div className="meter"><i className={z.occupancyPct > 85 ? 'hot' : ''} style={{ width: `${suspended ? 100 : Math.min(100, z.occupancyPct)}%`, background: suspended ? 'var(--danger)' : undefined }} /></div>
              <div className="small muted">
                占用率 {z.occupancyPct}%
                {z.zoneId === 'family' && z.children > 0 && ` · 在场儿童 ${z.children} 人（须一对一陪同）`}
                {z.zoneId === 'deep' && ` · 在池持深水证 ${z.deepCertHoldersInPool}/${z.inPool} 人`}
                {z.occupancyPct > 85 && <span style={{ color: 'var(--danger)', fontWeight: 700 }}> · 接近满载，通知前台缓发</span>}
              </div>
              {board.suspendedLanes.filter((l) => l.zoneId === z.zoneId).map((l) => (
                <div key={`${l.lane}`} className="badge danger" style={{ marginTop: 6, marginRight: 6 }}>⛔ {l.lane} 号道临停</div>
              ))}
              {board.focusLanes.filter((f) => f.zoneId === z.zoneId).map((f, i) => (
                <div key={`f${i}`} className="badge" style={{ marginTop: 6, marginRight: 6, background: 'var(--warn-bg)', color: 'var(--warn)' }}>🛟 {f.lane} 号道重点关注{f.ackAt ? '✓' : ''}</div>
              ))}
            </div>
            );
          })}
          <h4>在岗救生员站位</h4>
          {board.guardOnDuty.length === 0 ? <div className="alert warn">暂无救生员上哨！请到「站位与换岗」上哨。</div> :
            board.guardOnDuty.map((g, i) => (
              <div key={i} className="queue-row">
                <div><b>🛟 {g.postLabel}</b><div className="small muted">{g.guardName} · {fmtDateTime(g.startedAt)} 起在岗</div></div>
                <Badge tone="ok">在岗</Badge>
              </div>
            ))}
        </Card>

        <div className="grid">
          <Card title="水质实时读数" extra={w ? (w.abnormal ? <Badge tone="danger">异常</Badge> : <Badge tone="ok">达标</Badge>) : <Badge tone="gray">未检测</Badge>}>
            {!w ? <Empty text="本场尚无水质记录，请先到「水质检测」录入" /> : (
              <>
                <div className="water-grid">
                  <div className={`water-cell ${waterBad(w.tempC, WATER_STD.temp) ? 'bad' : ''}`}>
                    <div className="v">{w.tempC}<span className="u">°C</span></div><div className="u">水温 {WATER_STD.temp.min}-{WATER_STD.temp.max}</div></div>
                  <div className={`water-cell ${waterBad(w.freeChlorine, WATER_STD.chlorine) ? 'bad' : ''}`}>
                    <div className="v">{w.freeChlorine}<span className="u">mg/L</span></div><div className="u">余氯 {WATER_STD.chlorine.min}-{WATER_STD.chlorine.max}</div></div>
                  <div className={`water-cell ${w.turbidity > WATER_STD.turbidity.max ? 'bad' : ''}`}>
                    <div className="v">{w.turbidity}<span className="u">NTU</span></div><div className="u">浊度 ≤{WATER_STD.turbidity.max}</div></div>
                  <div className={`water-cell ${waterBad(w.ph, WATER_STD.ph) ? 'bad' : ''}`}>
                    <div className="v">{w.ph}</div><div className="u">pH {WATER_STD.ph.min}-{WATER_STD.ph.max}</div></div>
                </div>
                {w.abnormal && <div className="alert danger" style={{ marginBottom: 0 }}>{w.abnormalFields.join('；')}<div className="small">系统已自动限流并立案水质异常事件。</div></div>}
                <div className="small muted" style={{ marginTop: 8 }}>记录人 {w.recorder} · {fmtDateTime(w.at)}</div>
              </>
            )}
          </Card>

          <Card title="设备状态">
            {state.equipment.map((e) => (
              <div key={e.id} className="queue-row">
                <div><b>{e.name}</b>{e.note && <div className="small muted">{e.note}</div>}<div className="small muted">最近巡检 {fmtDateTime(e.lastCheck)}</div></div>
                <Badge tone={e.status === 'normal' ? 'ok' : e.status === 'warning' ? 'warn' : 'danger'}>{EQUIPMENT_LABEL[e.status]}</Badge>
              </div>
            ))}
          </Card>
        </div>
      </div>
    </div>
  );
}

// ---------- 水质录入 ----------
function WaterEntry({ state, sessionId, setSessionId }: { state: AppState; sessionId: string; setSessionId: (s: string) => void }) {
  const act = useAction();
  const notify = useNotify();
  const latest = state.waterReadings.find((w) => w.sessionId === sessionId);
  const [temp, setTemp] = useState(latest?.tempC ?? 27.0);
  const [cl, setCl] = useState(latest?.freeChlorine ?? 0.8);
  const [tu, setTu] = useState(latest?.turbidity ?? 0.6);
  const [ph, setPh] = useState(latest?.ph ?? 7.3);
  const [note, setNote] = useState('');

  const submit = () =>
    act.mutateAsync({ path: '/water', body: { sessionId, tempC: temp, freeChlorine: cl, turbidity: tu, ph, note } })
      .then((r: any) => { notify.ok(r.abnormal ? '读数异常：已自动限流并立案' : '读数达标，已记录'); setNote(''); })
      .catch((e) => notify.err(e));

  const preset = (p: number[]) => { setTemp(p[0]); setCl(p[1]); setTu(p[2]); setPh(p[3]); };

  return (
    <div>
      <SessionPicker sessions={state.sessions} value={sessionId} onChange={(v) => { setSessionId(v); }} />
      <div className="grid cols-2">
        <Card title="录入水质检测（开场 / 每两小时 / 复测）">
          <div className="form-row">
            <label className="field">水温 °C（{WATER_STD.temp.min}-{WATER_STD.temp.max}）<input type="number" step="0.1" value={temp} onChange={(e) => setTemp(Number(e.target.value))} /></label>
            <label className="field">余氯 mg/L（{WATER_STD.chlorine.min}-{WATER_STD.chlorine.max}）<input type="number" step="0.01" value={cl} onChange={(e) => setCl(Number(e.target.value))} /></label>
          </div>
          <div style={{ height: 10 }} />
          <div className="form-row">
            <label className="field">浊度 NTU（≤{WATER_STD.turbidity.max}）<input type="number" step="0.01" value={tu} onChange={(e) => setTu(Number(e.target.value))} /></label>
            <label className="field">pH（{WATER_STD.ph.min}-{WATER_STD.ph.max}）<input type="number" step="0.1" value={ph} onChange={(e) => setPh(Number(e.target.value))} /></label>
          </div>
          <div style={{ height: 10 }} />
          <label className="field">备注<textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：雷雨过后复测、加氯机维修后复测…" /></label>
          <div className="flex" style={{ marginTop: 12 }}>
            <button className="btn" disabled={act.isPending} onClick={submit}>提交检测</button>
            <button className="btn ghost sm" onClick={() => preset([27, 0.8, 0.6, 7.3])}>达标样例</button>
            <button className="btn danger sm" onClick={() => preset([27.1, 0.15, 1.8, 7.4])}>异常样例（余氯低/浊度高）</button>
          </div>
          <div className="small muted" style={{ marginTop: 8 }}>异常读数将自动：暂停新入场（限流）→ 向五角色推送 → 生成维修复测工单与水质事件；达标读数用于闭池后恢复开放校验。</div>
        </Card>
        <Card title="本场检测历史">
          {state.waterReadings.filter((w) => w.sessionId === sessionId).length === 0 ? <Empty text="暂无记录" /> :
            state.waterReadings.filter((w) => w.sessionId === sessionId).map((w) => (
              <div key={w.id} className={`notif ${w.abnormal ? 'critical' : 'info'}`}>
                <div className="flex"><b>{fmtDateTime(w.at)} · {w.recorder}</b><span className="spacer" />
                  <Badge tone={w.abnormal ? 'danger' : 'ok'}>{w.abnormal ? '异常' : '达标'}</Badge></div>
                <div className="small" style={{ marginTop: 4 }}>水温 {w.tempC}°C · 余氯 {w.freeChlorine} · 浊度 {w.turbidity} · pH {w.ph}</div>
                {w.abnormalFields.length > 0 && <div className="small" style={{ color: 'var(--danger)' }}>{w.abnormalFields.join('；')}</div>}
                {w.note && <div className="small muted">{w.note}</div>}
              </div>
            ))}
        </Card>
      </div>
    </div>
  );
}

// ---------- 巡查 ----------
const ISSUES: PatrolIssueType[] = ['diving', 'child_alone', 'wet_floor', 'shower_crowd', 'water_quality', 'guard_missing', 'other'];
function Patrol({ state, sessionId }: Props) {
  const act = useAction();
  const notify = useNotify();
  const [type, setType] = useState<PatrolIssueType>('diving');
  const [severity, setSeverity] = useState<IssueSeverity>('minor');
  const [location, setLocation] = useState('深水区跳板附近');
  const [desc, setDesc] = useState('');
  const list = state.patrolIssues.filter((p) => p.sessionId === sessionId);

  const submit = () =>
    act.mutateAsync({ path: '/issues', body: { sessionId, type, severity, location, description: desc } })
      .then(() => { notify.ok('巡查问题已记录并分派'); setDesc(''); }).catch((e) => notify.err(e));

  return (
    <div className="grid cols-2">
      <Card title="救生 / 运营巡查记录">
        <div className="form-row">
          <label className="field">问题类型
            <select value={type} onChange={(e) => setType(e.target.value as PatrolIssueType)}>
              {ISSUES.map((t) => <option key={t} value={t}>{ISSUE_TYPE_LABEL[t]}</option>)}
            </select>
          </label>
          <label className="field">严重程度
            <select value={severity} onChange={(e) => setSeverity(e.target.value as IssueSeverity)}>
              <option value="minor">一般（提醒纠正）</option>
              <option value="major">较大（需处置）</option>
              <option value="critical">紧急（须立即清场/救援）</option>
            </select>
          </label>
        </div>
        <div style={{ height: 10 }} />
        <label className="field">位置<input value={location} onChange={(e) => setLocation(e.target.value)} /></label>
        <div style={{ height: 10 }} />
        <label className="field">情况描述<textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="如：发现一名男童脱离母亲独自进入深水区…" /></label>
        <div style={{ height: 10 }} />
        <button className="btn" disabled={!desc.trim() || act.isPending} onClick={submit}>记录并分派</button>
        <div className="small muted" style={{ marginTop: 8 }}>地面湿滑/淋浴拥堵自动派保洁，水质类自动派维修并生成消毒工单；紧急项请同步在「事件协同」立案。</div>
      </Card>
      <Card title={`本场巡查记录（${list.length}）`}>
        {list.length === 0 ? <Empty text="暂无巡查问题" /> : list.map((p) => (
          <div key={p.id} className={`notif ${p.severity === 'critical' ? 'critical' : p.severity === 'major' ? 'warning' : 'info'}`}>
            <div className="flex">
              <b>{ISSUE_TYPE_LABEL[p.type]}</b>
              <Badge tone={p.severity === 'critical' ? 'danger' : p.severity === 'major' ? 'warn' : 'gray'}>{SEVERITY_LABEL[p.severity]}</Badge>
              <span className="spacer" />
              <Badge tone={p.status === 'resolved' ? 'ok' : p.status === 'handling' ? 'warn' : 'danger'}>
                {p.status === 'resolved' ? '已处理' : p.status === 'handling' ? '处理中' : '待处理'}
              </Badge>
            </div>
            <div className="small" style={{ marginTop: 4 }}>{p.location}：{p.description}</div>
            <div className="small muted">{fmtDateTime(p.at)} · {p.reporter} 报 → {p.assigneeName ?? '待分派'}
              {p.resolution && ` · 结果：${p.resolution}`}</div>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ---------- 站位与换岗 ----------
const POSTS = Object.keys(GUARD_POST_LABEL) as GuardPost[];
function GuardDuty({ user, state, sessionId }: Props) {
  const act = useAction();
  const notify = useNotify();
  const duties = state.guardDuties.filter((d) => d.sessionId === sessionId);
  const guards = state.users.filter((u) => u.role === 'lifeguard');
  const myActive = duties.find((d) => d.guardUserId === user.id && !d.end);
  const [post, setPost] = useState<GuardPost>('roaming');
  const [reliefName, setReliefName] = useState(guards.find((g) => g.id !== user.id)?.name ?? '');

  return (
    <div className="grid cols-2">
      <Card title="上哨 / 换岗">
        {myActive ? (
          <div className="alert ok">您当前在岗：<b>{GUARD_POST_LABEL[myActive.post]}</b>（{fmtDateTime(myActive.start)} 起）</div>
        ) : <div className="alert warn">您当前未在任何站位。</div>}
        <div className="form-row">
          <label className="field">选择站位
            <select value={post} onChange={(e) => setPost(e.target.value as GuardPost)}>
              {POSTS.map((p) => <option key={p} value={p}>{GUARD_POST_LABEL[p]}</option>)}
            </select>
          </label>
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button className="btn block" disabled={act.isPending || !!myActive}
              onClick={() => act.mutateAsync({ path: '/guards', body: { sessionId, post } }).then(() => notify.ok('已上哨')).catch((e) => notify.err(e))}>
              上哨
            </button>
          </div>
        </div>
        <h4>换岗交接</h4>
        <div className="flex">
          <select value={reliefName} onChange={(e) => setReliefName(e.target.value)} style={{ width: 160 }}>
            {guards.filter((g) => g.id !== user.id).map((g) => <option key={g.id}>{g.name}</option>)}
          </select>
          <button className="btn ghost" disabled={act.isPending || !myActive}
            onClick={() => act.mutateAsync({ path: `/guards/${myActive?.id ?? 'x'}/relief`, body: { relief: reliefName, note: '例行换岗' } })
              .then(() => notify.ok(`已与 ${reliefName} 完成换岗`)).catch((e) => notify.err(e))}>
            交接下哨
          </button>
        </div>
        <div className="small muted" style={{ marginTop: 8 }}>闭池时系统会统一撤哨并记录清场原因；每一个站位同一时间只允许一人在岗。</div>
      </Card>
      <Card title="本场站位记录">
        {duties.length === 0 ? <Empty text="暂无站位记录" /> : duties.map((d) => {
          const g = state.users.find((u) => u.id === d.guardUserId);
          return <div key={d.id} className="queue-row">
            <div><b>🛟 {GUARD_POST_LABEL[d.post]}</b>
              <div className="small muted">{g?.name} · {fmtDateTime(d.start)} - {d.end ? fmtDateTime(d.end) : '在岗'}
                {d.relief && ` · 接班人：${d.relief}`}{d.note ? ` · ${d.note}` : ''}</div></div>
            {!d.end ? <Badge tone="ok">在岗</Badge> : <Badge tone="gray">已下哨</Badge>}
          </div>;
        })}
      </Card>
    </div>
  );
}

export function LifeguardPage(props: Props) {
  const [sessionId, setSessionId] = useState(props.state.boards[1]?.session.id ?? props.state.boards[0].session.id);
  if (props.tab === 'water') return <WaterEntry {...props} sessionId={sessionId} setSessionId={setSessionId} />;
  if (props.tab === 'patrol') return <Patrol {...props} sessionId={sessionId} />;
  if (props.tab === 'guard') return <GuardDuty {...props} sessionId={sessionId} />;
  if (props.tab === 'rescue') return <RescueWorkbench state={props.state} user={props.user} sessionId={sessionId} setSessionId={setSessionId} />;
  if (props.tab === 'rental') return <RentalFrontline user={props.user} state={props.state} role="lifeguard" />;
  if (props.tab === 'incident') return (
    <div className="grid cols-2">
      <IncidentCreateForm sessions={props.state.sessions} defaultSessionId={sessionId} />
      <Card title="事件协同（同场次五角色共用）"><IncidentList incidents={props.state.incidents} user={props.user} /></Card>
    </div>
  );
  return <Board state={props.state} sessionId={sessionId} setSessionId={setSessionId} />;
}
