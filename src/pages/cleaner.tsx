import { useState } from 'react';
import type { User, TaskKind } from '../../shared/types.js';
import type { AppState } from '../api.js';
import { useAction } from '../api.js';
import { Badge, Card, Empty, TASK_STATUS_LABEL, ISSUE_TYPE_LABEL, fmtDateTime, useNotify } from '../ui.js';
import { IncidentList, IncidentCreateForm } from '../components/incident.js';
import { RentalDayBoard } from '../components/rental.js';

type Props = { user: User; state: AppState; tab: string };

function TaskBoard({ user, state, role }: Props & { role: 'cleaner' | 'maintenance' }) {
  const act = useAction();
  const notify = useNotify();
  const [filter, setFilter] = useState<'mine' | 'all'>('mine');
  const [result, setResult] = useState('');

  const tasks = state.workTasks
    .filter((t) => t.assigneeRole === role)
    .filter((t) => filter === 'all' || t.status !== 'done');

  const run = (path: string, body?: unknown) =>
    act.mutateAsync({ path, body }).then(() => notify.ok('状态已同步到运营指挥台')).catch((e) => notify.err(e));

  return (
    <div className="grid">
      <RentalDayBoard user={user} state={state} />
      <div className="grid cols-2">
      <Card title={role === 'cleaner' ? '🧹 我的保洁工单' : '🔧 维修 / 消毒工单'}
        extra={<div className="tabs" style={{ margin: 0 }}>
          <button className={`tab ${filter === 'mine' ? 'active' : ''}`} onClick={() => setFilter('mine')}>待办/处理中</button>
          <button className={`tab ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>全部</button>
        </div>}>
        {tasks.length === 0 ? <Empty text="暂无派给您的工单" /> : tasks.map((t) => (
          <div key={t.id} className="notif info">
            <div className="flex">
              <b>{t.title}</b>
              <span className="spacer" />
              <Badge tone={t.kind === 'disinfection' ? 'purple' : t.kind === 'maintenance' ? 'warn' : 'info'}>
                {t.kind === 'disinfection' ? '泳池消毒' : t.kind === 'maintenance' ? '维修' : '保洁'}
              </Badge>
              <Badge tone={t.status === 'done' ? 'ok' : t.status === 'in_progress' ? 'warn' : 'danger'}>{TASK_STATUS_LABEL[t.status]}</Badge>
            </div>
            <div className="small" style={{ marginTop: 4 }}>{t.detail}</div>
            <div className="small muted">来源：{t.source === 'incident' ? '事件联动' : t.source === 'patrol' ? '巡查上报' : '例行/运营派发'} · {fmtDateTime(t.createdAt)}{t.assigneeName ? ` · ${t.assigneeName}` : ''}</div>
            {t.status !== 'done' && (
              <div className="flex" style={{ marginTop: 8 }}>
                {t.status === 'pending'
                  ? <button className="btn sm" onClick={() => run(`/tasks/${t.id}/claim`)}>接单</button>
                  : <>
                    <input placeholder={role === 'maintenance' ? '处置结果，如：余氯恢复 0.8mg/L' : '处置结果，如：已铺防滑垫并拖干'}
                      value={result} onChange={(e) => setResult(e.target.value)} />
                    <button className="btn sm ok" disabled={act.isPending}
                      onClick={() => run(`/tasks/${t.id}/done`, { result: result || '已完成' }).then(() => setResult(''))}>
                      完成
                    </button>
                  </>}
              </div>
            )}
            {t.result && <div className="small" style={{ marginTop: 6, color: 'var(--ok)' }}>✓ {fmtDateTime(t.doneAt)} {t.result}</div>}
          </div>
        ))}
      </Card>

      <div className="grid">
        <Card title="与我相关的巡查上报">
          {state.patrolIssues.filter((p) => p.assigneeRole === role).length === 0 ? <Empty text="暂无巡查问题分派" /> :
            state.patrolIssues.filter((p) => p.assigneeRole === role).slice(0, 8).map((p) => (
              <div key={p.id} className={`notif ${p.status === 'resolved' ? 'info' : 'warning'}`}>
                <div className="flex"><b>{ISSUE_TYPE_LABEL[p.type]} · {p.location}</b>
                  <span className="spacer" />
                  <Badge tone={p.status === 'resolved' ? 'ok' : 'warn'}>{p.status === 'resolved' ? '已处理' : '待处理'}</Badge></div>
                <div className="small">{p.description}</div>
                <div className="small muted">{p.reporter} 报 · {fmtDateTime(p.at)}</div>
              </div>
            ))}
        </Card>
        <Card title="我的处置职责在事件中的位置">
          <div className="small muted" style={{ marginBottom: 8 }}>
            {role === 'cleaner'
              ? '闭池/雷雨/走失等事件中，您负责清场清洁、防滑垫、搜寻更衣室与淋浴区。'
              : '水质异常/设备故障事件中，您负责加药反冲洗、设备抢修，并录入复测数据；复测达标是恢复开放的前置条件。'}
          </div>
          <IncidentList incidents={state.incidents.filter((i) => i.tasks.some((t) => t.role === role))} user={user} empty="暂无需要您参与的事件" />
        </Card>
      </div>
      </div>
    </div>
  );
}

function PatrolReport({ user, state, kind }: Props & { kind: 'cleaning' | 'maintenance' }) {
  const act = useAction();
  const notify = useNotify();
  const [sessionId, setSessionId] = useState(state.sessions[1]?.id ?? state.sessions[0].id);
  const [type, setType] = useState(kind === 'cleaning' ? 'wet_floor' : 'water_quality');
  const [desc, setDesc] = useState('');
  const [location, setLocation] = useState(kind === 'cleaning' ? '更衣室出口' : '设备间');
  const submit = () =>
    act.mutateAsync({ path: '/issues', body: { sessionId, type, severity: 'minor', location, description: desc, assigneeRole: kind } })
      .then(() => { notify.ok('已上报，同时生成工单'); setDesc(''); }).catch((e) => notify.err(e));
  void user;
  return (
    <Card title="主动巡查上报">
      <div className="form-row">
        <label className="field">场次<select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>{state.sessions.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
        <label className="field">类型
          <select value={type} onChange={(e) => setType(e.target.value as any)}>
            {kind === 'cleaning'
              ? <><option value="wet_floor">地面湿滑</option><option value="shower_crowd">淋浴区拥堵</option><option value="other">其他卫生问题</option></>
              : <><option value="water_quality">水质检测异常</option><option value="other">其他设备问题</option></>}
          </select>
        </label>
      </div>
      <div style={{ height: 10 }} />
      <label className="field">位置<input value={location} onChange={(e) => setLocation(e.target.value)} /></label>
      <div style={{ height: 10 }} />
      <label className="field">描述<textarea value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
      <div style={{ height: 10 }} />
      <button className="btn" disabled={!desc.trim() || act.isPending} onClick={submit}>上报并生成工单</button>
    </Card>
  );
}

function IncidentTab({ user, state }: Props) {
  return (
    <div className="grid cols-2">
      <IncidentCreateForm sessions={state.sessions} />
      <Card title="事件协同"><IncidentList incidents={state.incidents} user={user} /></Card>
    </div>
  );
}

export function CleanerPage(props: Props) {
  if (props.tab === 'patrol') return <PatrolReport {...props} kind="cleaning" />;
  if (props.tab === 'incident') return <IncidentTab {...props} />;
  return <TaskBoard {...props} role="cleaner" />;
}
