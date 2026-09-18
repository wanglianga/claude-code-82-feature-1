import { useState } from 'react';
import type { User, RentalCase, RentalViolationType } from '../../shared/types.js';
import type { AppState } from '../api.js';
import { useAction } from '../api.js';
import { Badge, Card, Empty, fmtDateTime, useNotify } from '../ui.js';
import { SessionPicker } from './common.js';
import { RentalStatusBadge, DayChecklistView, CloseoutView, zoneNameOf } from './rental.js';

const VLABEL: Record<RentalViolationType, string> = {
  over_capacity: '超人数', overtime: '超时', occupy_welfare: '占用公益泳道',
  child_unaccompanied: '儿童无人陪同', unauthorized_addon: '机构私自加人', other: '其他',
};

/** 一线岗位包场保障面板：前台核验/救生站位/保洁维修确认/违规上报/清场确认 */
export function RentalFrontline({ user, state, role }: { user: User; state: AppState; role: 'frontdesk' | 'lifeguard' | 'cleaner' | 'maintenance' }) {
  const act = useAction();
  const notify = useNotify();
  const [sessionId, setSessionId] = useState(state.sessions.find((s) => s.id === 's-eve')?.id ?? state.sessions[0].id);
  const list = state.rentalCases.filter((r) => r.sessionId === sessionId
    && ['approved', 'active', 'suspended', 'completed'].includes(r.status));

  const run = (rc: RentalCase, path: string, body?: unknown) =>
    act.mutateAsync({ path: `/rentals/${rc.id}${path}`, body }).catch((e) => notify.err(e));

  return (
    <div>
      <SessionPicker sessions={state.sessions} value={sessionId} onChange={setSessionId} />
      {list.length === 0 ? <Card><Empty text="本场暂无已确认待核验的机构包场" /></Card> : list.map((rc) => (
        <Card key={rc.id} className="section-gap" title={`${rc.code} · ${rc.orgName} · ${zoneNameOf(state, rc.zoneId)}${rc.lanes?.length ? ' ' + rc.lanes.join('/') + ' 号道' : ''}`}
          extra={<RentalStatusBadge status={rc.status} />}>
          <div className="small muted">
            核准上限 {rc.coordination?.approvedCapacity ?? rc.partySize} 人{rc.actualCount != null ? ` · 实际到场 ${rc.actualCount} 人` : ''}
            {rc.containsChildren && <span className="badge purple" style={{ marginLeft: 6 }}>含儿童·逐人陪同</span>}
            {role === 'frontdesk' && rc.contactPhone ? <span className="badge info" style={{ marginLeft: 6 }}>联系人 {rc.contactName} {rc.contactPhone}</span> : null}
          </div>

          {role === 'frontdesk' && <FrontdeskOps rc={rc} onRun={run} notify={notify} act={act} />}
          {role === 'lifeguard' && <LifeguardOps rc={rc} state={state} onRun={run} notify={notify} act={act} />}
          {role === 'cleaner' && <CleanerOps rc={rc} onRun={run} notify={notify} act={act} />}
          {role === 'maintenance' && <MaintenanceOps rc={rc} onRun={run} notify={notify} act={act} />}

          <ViolationReport rc={rc} onRun={run} notify={notify} act={act} role={role} />

          <details style={{ marginTop: 10 }}>
            <summary className="small muted" style={{ cursor: 'pointer' }}>当天核验总览</summary>
            <div style={{ marginTop: 6 }}><DayChecklistView checklist={rc.dayChecklist} /></div>
          </details>
          <details>
            <summary className="small muted" style={{ cursor: 'pointer' }}>清场恢复门禁（未复测/未清场不得开放下一场）</summary>
            <div style={{ marginTop: 6 }}><CloseoutView closeout={rc.closeout} /></div>
          </details>
          {rc.violations.length > 0 && (
            <div style={{ marginTop: 6 }}>
              {rc.violations.map((v) => (
                <div key={v.id} className={`notif ${v.suspended ? 'critical' : 'warning'}`} style={{ marginBottom: 4 }}>
                  <b>{VLABEL[v.type]}</b> <Badge tone={v.rectified ? 'ok' : 'danger'}>{v.rectified ? '已整改' : '未整改'}</Badge>
                  <div className="small">{v.description}{v.actualCount ? `（实际 ${v.actualCount}）` : ''}</div>
                  <div className="small muted">{fmtDateTime(v.at)} · {v.by}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

type RunFn = (rc: RentalCase, path: string, body?: unknown) => Promise<any>;
type Act = ReturnType<typeof useAction>;
type Notify = ReturnType<typeof useNotify>;

function ActualCountRow({ rc, onRun, notify }: { rc: RentalCase; onRun: RunFn; notify: Notify; act: Act }) {
  const [n, setN] = useState(rc.actualCount ?? rc.coordination?.approvedCapacity ?? rc.partySize);
  return (
    <div className="form-row" style={{ marginTop: 8 }}>
      <label className="field">名单实际到场人数<input type="number" value={n} onChange={(e) => setN(Number(e.target.value))} /></label>
      <button className="btn sm" onClick={() => onRun(rc, '/actual-count', { actualCount: n }).then(() => notify.ok('名单人数已登记')).catch(() => {})}>登记人数</button>
    </div>
  );
}

function FrontdeskOps({ rc, onRun, notify, act }: { rc: RentalCase; onRun: RunFn; notify: Notify; act: Act }) {
  const ok = (key: string, extra?: any) => onRun(rc, '/day-check', { key, done: true, ...extra }).then(() => notify.ok('已确认')).catch(() => {});
  return (
    <div style={{ marginTop: 8 }}>
      <ActualCountRow rc={rc} onRun={onRun} notify={notify} act={act} />
      <div className="flex" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        <button className="btn sm" disabled={act.isPending} onClick={() => ok('rosterMatched', { note: '机构名单与申报一致' })}>✓ 核验机构名单</button>
        <button className="btn sm" disabled={act.isPending} onClick={() => ok('visitorIdChecked', { note: '访客身份逐人核验' })}>✓ 访客身份核验</button>
        <button className="btn sm" disabled={act.isPending} onClick={() => ok('insuranceChecked', { note: '保险现场复核通过' })}>✓ 保险现场复核</button>
        <button className="btn" disabled={act.isPending || rc.status !== 'approved'} onClick={() => onRun(rc, '/start').then(() => notify.ok('六岗核验齐备，已放行开场')).catch(() => {})}>六岗齐备·放行开场</button>
      </div>
      {rc.status === 'suspended' && <div className="alert danger" style={{ marginTop: 8 }}>包场已暂停：{rc.suspendedReason}</div>}
    </div>
  );
}

function LifeguardOps({ rc, state, onRun, notify, act }: { rc: RentalCase; state: AppState; onRun: RunFn; notify: Notify; act: Act }) {
  const guards = state.users.filter((u) => u.role === 'lifeguard');
  const [names, setNames] = useState<string[]>([]);
  return (
    <div style={{ marginTop: 8 }}>
      <div className="small muted">按包场实际人数重新站位（勾选本次上岗救生员，含儿童区巡逻/机动）：</div>
      <div className="flex" style={{ gap: 6, flexWrap: 'wrap', margin: '6px 0' }}>
        {guards.map((g) => (
          <label key={g.id} className="checkbox" style={{ minWidth: 90 }}><input type="checkbox" checked={names.includes(g.name)}
            onChange={(e) => setNames((p) => e.target.checked ? [...p, g.name] : p.filter((x) => x !== g.name))} />{g.name}</label>
        ))}
      </div>
      <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
        <button className="btn sm" disabled={act.isPending} onClick={() => onRun(rc, '/day-check', { key: 'guardRepositioned', done: true, guardNames: names }).then(() => notify.ok('已按人数重新站位')).catch(() => {})}>✓ 救生重新站位确认</button>
        <button className="btn sm" disabled={act.isPending || rc.status !== 'active'} onClick={() => onRun(rc, '/closeout', { key: 'guardPatrolConfirmed', done: true }).then(() => notify.ok('救生巡查已确认')).catch(() => {})}>结束救生巡查确认</button>
      </div>
    </div>
  );
}

function CleanerOps({ rc, onRun, notify, act }: { rc: RentalCase; onRun: RunFn; notify: Notify; act: Act }) {
  return (
    <div className="flex" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
      <button className="btn sm" disabled={act.isPending} onClick={() => onRun(rc, '/day-check', { key: 'cleaningReady', done: true, note: '地面防滑/淋浴/储物柜/消毒安排到位' }).then(() => notify.ok('保洁保障已确认')).catch(() => {})}>✓ 场地/淋浴/储物柜/消毒确认</button>
      <button className="btn sm" disabled={act.isPending || rc.status !== 'active'} onClick={() => onRun(rc, '/closeout', { key: 'cleared', done: true }).then(() => notify.ok('清场完成')).catch(() => {})}>结束清场✓</button>
      <button className="btn sm" disabled={act.isPending || rc.status !== 'active'} onClick={() => onRun(rc, '/closeout', { key: 'lockersCleared', done: true }).then(() => notify.ok('储物柜已清空')).catch(() => {})}>清储物柜✓</button>
    </div>
  );
}

function MaintenanceOps({ rc, onRun, notify, act }: { rc: RentalCase; onRun: RunFn; notify: Notify; act: Act }) {
  const [w, setW] = useState({ tempC: 27, freeChlorine: 0.8, turbidity: 0.6, ph: 7.3 });
  return (
    <div style={{ marginTop: 8 }}>
      <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
        <button className="btn sm" disabled={act.isPending} onClick={() => onRun(rc, '/day-check', { key: 'maintenanceReady', done: true, note: '设备/独立动线/消毒安排确认' }).then(() => notify.ok('维修保障已确认')).catch(() => {})}>✓ 设备与消毒安排确认</button>
        <button className="btn sm" disabled={act.isPending || rc.status !== 'active'} onClick={() => onRun(rc, '/closeout', { key: 'equipmentReset', done: true }).then(() => notify.ok('设备已复位')).catch(() => {})}>设备复位✓</button>
      </div>
      <div className="form-row" style={{ marginTop: 8 }}>
        <label className="field">水温<input type="number" step="0.1" value={w.tempC} onChange={(e) => setW((p) => ({ ...p, tempC: Number(e.target.value) }))} /></label>
        <label className="field">余氯<input type="number" step="0.01" value={w.freeChlorine} onChange={(e) => setW((p) => ({ ...p, freeChlorine: Number(e.target.value) }))} /></label>
        <label className="field">浊度<input type="number" step="0.01" value={w.turbidity} onChange={(e) => setW((p) => ({ ...p, turbidity: Number(e.target.value) }))} /></label>
        <label className="field">pH<input type="number" step="0.1" value={w.ph} onChange={(e) => setW((p) => ({ ...p, ph: Number(e.target.value) }))} /></label>
        <button className="btn sm ok" disabled={act.isPending || rc.status !== 'active'} onClick={() => onRun(rc, '/closeout', { key: 'waterRetested', done: true, reading: w }).then(() => notify.ok('水质复测达标已记录')).catch(() => {})}>水质复测达标✓</button>
      </div>
    </div>
  );
}

function ViolationReport({ rc, onRun, notify, act, role }: { rc: RentalCase; onRun: RunFn; notify: Notify; act: Act; role: string }) {
  const canReport = role === 'frontdesk' || role === 'lifeguard';
  const [type, setType] = useState<RentalViolationType>('over_capacity');
  const [desc, setDesc] = useState('');
  const [count, setCount] = useState(0);
  const [suspend, setSuspend] = useState(true);
  if (!canReport || (rc.status !== 'active' && rc.status !== 'suspended' && rc.status !== 'approved')) return null;
  return (
    <div className="notif critical" style={{ marginTop: 10 }}>
      <b>现场异常处置（出现下列情形可暂停包场并通知社区运营）</b>
      <div className="form-row" style={{ marginTop: 6 }}>
        <label className="field">类型<select value={type} onChange={(e) => setType(e.target.value as RentalViolationType)}>
          {(Object.keys(VLABEL) as RentalViolationType[]).map((k) => <option key={k} value={k}>{VLABEL[k]}</option>)}
        </select></label>
        <label className="field">实际人数（超人数时）<input type="number" value={count} onChange={(e) => setCount(Number(e.target.value))} /></label>
      </div>
      <label className="field" style={{ marginTop: 6 }}>情况描述<input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="如：清点发现 24 人，超上限 4 人 / 发现 2 名儿童无陪同" /></label>
      <label className="checkbox" style={{ marginTop: 6 }}><input type="checkbox" checked={suspend} onChange={(e) => setSuspend(e.target.checked)} /> 当场暂停包场并通知社区运营</label>
      <div style={{ marginTop: 6 }}>
        <button className="btn danger sm" disabled={act.isPending || !desc.trim()}
          onClick={() => onRun(rc, '/violations', { type, description: desc, actualCount: count || undefined, suspend })
            .then(() => { notify.ok(suspend ? '已暂停包场并通知运营、计入信用' : '违规已记录并计入信用'); setDesc(''); }).catch(() => {})}>
          上报违规{suspend ? '并暂停' : ''}
        </button>
      </div>
    </div>
  );
}
