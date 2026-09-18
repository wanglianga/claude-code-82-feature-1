import { useState } from 'react';
import type { User, EquipmentStatus } from '../../shared/types.js';
import type { AppState } from '../api.js';
import { useAction } from '../api.js';
import { Badge, Card, Empty, TASK_STATUS_LABEL, EQUIPMENT_LABEL, fmtDateTime, useNotify } from '../ui.js';
import { SessionPicker, PoolStatusBanner } from '../components/common.js';
import { IncidentList, IncidentCreateForm } from '../components/incident.js';
import { RentalDayBoard } from '../components/rental.js';
import { WATER_STD } from '../../shared/logic.js';

type Props = { user: User; state: AppState; tab: string };

function Tasks({ user, state }: Props) {
  const act = useAction();
  const notify = useNotify();
  const [result, setResult] = useState('');
  const tasks = state.workTasks.filter((t) => t.assigneeRole === 'maintenance');
  const run = (path: string, body?: unknown) =>
    act.mutateAsync({ path, body }).then(() => notify.ok('已同步运营与救生端')).catch((e) => notify.err(e));
  return (
    <Card title="🔧 维修 / 泳池消毒 / 水质复测工单">
      {tasks.length === 0 ? <Empty text="暂无工单" /> : tasks.map((t) => (
        <div key={t.id} className="notif info">
          <div className="flex">
            <b>{t.title}</b>
            <span className="spacer" />
            <Badge tone={t.kind === 'disinfection' ? 'purple' : 'warn'}>{t.kind === 'disinfection' ? '消毒/复测' : '维修'}</Badge>
            <Badge tone={t.status === 'done' ? 'ok' : t.status === 'in_progress' ? 'warn' : 'danger'}>{TASK_STATUS_LABEL[t.status]}</Badge>
          </div>
          <div className="small" style={{ marginTop: 4 }}>{t.detail}</div>
          <div className="small muted">来源：{t.source === 'incident' ? '事件联动' : t.source === 'patrol' ? '巡查上报' : '例行'} · {fmtDateTime(t.createdAt)}</div>
          {t.status !== 'done' && (
            <div className="flex" style={{ marginTop: 8 }}>
              {t.status === 'pending'
                ? <button className="btn sm" onClick={() => run(`/tasks/${t.id}/claim`)}>接单</button>
                : <>
                  <input placeholder="处置结果（如：加氯至 0.8mg/L，反冲洗完成）" value={result} onChange={(e) => setResult(e.target.value)} />
                  <button className="btn sm" disabled={act.isPending}
                    onClick={() => run(`/tasks/${t.id}/done`, { result: result || '已完成' }).then(() => setResult(''))}>完成工单</button>
                </>}
            </div>
          )}
          {t.result && <div className="small" style={{ marginTop: 6, color: 'var(--ok)' }}>✓ {fmtDateTime(t.doneAt)} {t.result}</div>}
        </div>
      ))}
      <div className="alert info" style={{ marginTop: 12 }}>
        提示：闭池后的「全面消毒与水质复测」工单完成后，还需到「设备与水质复测」录入一次达标读数，运营才能恢复开放。
      </div>
      <div style={{ marginTop: 10 }}>
        <IncidentList incidents={state.incidents.filter((i) => i.tasks.some((t) => t.role === 'maintenance'))} user={user} empty="暂无需要维修参与的事件" />
      </div>
    </Card>
  );
}

function EquipWater({ state }: Props) {
  const act = useAction();
  const notify = useNotify();
  const [sessionId, setSessionId] = useState(state.boards[1]?.session.id ?? state.boards[0].session.id);
  const [temp, setTemp] = useState(27);
  const [cl, setCl] = useState(0.8);
  const [tu, setTu] = useState(0.6);
  const [ph, setPh] = useState(7.3);
  const [note, setNote] = useState('维修处置后复测');
  const session = state.sessions.find((s) => s.id === sessionId)!;

  const setEq = (id: string, status: EquipmentStatus) =>
    act.mutateAsync({ path: `/equipment/${id}`, method: 'POST', body: { status, note: status === 'fault' ? '已挂故障牌，抢修中' : '巡检正常' } })
      .then(() => notify.ok('设备状态已更新，救生端同步')).catch((e) => notify.err(e));

  const retest = () =>
    act.mutateAsync({ path: '/water', body: { sessionId, tempC: temp, freeChlorine: cl, turbidity: tu, ph, note } })
      .then((r: any) => notify.ok(r.abnormal ? '复测仍异常，继续处置' : '复测达标，可通知运营恢复开放')).catch((e) => notify.err(e));

  return (
    <div>
      <SessionPicker sessions={state.sessions} value={sessionId} onChange={setSessionId} />
      <PoolStatusBanner status={session.poolStatus} reason={session.statusReason} requireRetest={session.requireWaterRetest} closedAt={session.closedAt} reopenedAt={session.reopenedAt} />
      <div className="grid cols-2">
        <Card title="设备巡检与状态">
          {state.equipment.map((e) => (
            <div key={e.id} className="queue-row">
              <div><b>{e.name}</b><div className="small muted">{e.note || '运行正常'} · 最近 {fmtDateTime(e.lastCheck)}</div></div>
              <div className="flex">
                <Badge tone={e.status === 'normal' ? 'ok' : e.status === 'warning' ? 'warn' : 'danger'}>{EQUIPMENT_LABEL[e.status]}</Badge>
                <select style={{ width: 92 }} defaultValue="" onChange={(ev) => ev.target.value && setEq(e.id, ev.target.value as EquipmentStatus)}>
                  <option value="">更新…</option>
                  <option value="normal">正常</option>
                  <option value="warning">预警</option>
                  <option value="fault">故障</option>
                </select>
              </div>
            </div>
          ))}
          <div className="small muted" style={{ marginTop: 8 }}>设备置为故障会提示救生端加密人工巡视；重大故障请在事件页发起「设备故障」事件。</div>
        </Card>

        <Card title="水质复测（恢复开放前置条件）">
          <div className="alert warn">
            标准：水温 {WATER_STD.temp.min}-{WATER_STD.temp.max}°C，余氯 {WATER_STD.chlorine.min}-{WATER_STD.chlorine.max}mg/L，浊度 ≤{WATER_STD.turbidity.max}NTU，pH {WATER_STD.ph.min}-{WATER_STD.ph.max}。
          </div>
          <div className="form-row">
            <label className="field">水温<input type="number" step="0.1" value={temp} onChange={(e) => setTemp(Number(e.target.value))} /></label>
            <label className="field">余氯<input type="number" step="0.01" value={cl} onChange={(e) => setCl(Number(e.target.value))} /></label>
          </div>
          <div style={{ height: 10 }} />
          <div className="form-row">
            <label className="field">浊度<input type="number" step="0.01" value={tu} onChange={(e) => setTu(Number(e.target.value))} /></label>
            <label className="field">pH<input type="number" step="0.1" value={ph} onChange={(e) => setPh(Number(e.target.value))} /></label>
          </div>
          <div style={{ height: 10 }} />
          <label className="field">备注<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <div style={{ height: 12 }} />
          <button className="btn" disabled={act.isPending} onClick={retest}>提交复测读数</button>
          <div className="flex" style={{ marginTop: 10 }}>
            <button className="btn ghost sm" onClick={() => { setTemp(27); setCl(0.8); setTu(0.6); setPh(7.3); }}>填入达标值</button>
            <button className="btn danger sm" onClick={() => { setCl(0.1); setTu(1.6); }}>填入仍异常值</button>
          </div>
        </Card>
      </div>
    </div>
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

export function MaintenancePage(props: Props) {
  if (props.tab === 'equip') return <EquipWater {...props} />;
  if (props.tab === 'incident') return <IncidentTab {...props} />;
  return (
    <div className="grid">
      <RentalDayBoard user={props.user} state={props.state} />
      <Tasks {...props} />
    </div>
  );
}
