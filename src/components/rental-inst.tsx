import { useState } from 'react';
import type { User, ZoneId } from '../../shared/types.js';
import type { AppState } from '../api.js';
import { useAction } from '../api.js';
import { Badge, Card, Empty, useNotify } from '../ui.js';
import {
  RentalStatusBadge, FeeBreakdown, DayChecklistView, CloseoutView,
  CreditProfileCard, ScopeSummary, sessionLabelOf, zoneNameOf,
} from './rental.js';

// ============ 机构申请包场（先看冲突范围） ============
export function ApplyRental({ user, state }: { user: User; state: AppState }) {
  const act = useAction();
  const notify = useNotify();
  const [sessionId, setSessionId] = useState(state.sessions.find((s) => s.id === 's-pm')?.id ?? state.sessions[0].id);
  const [zoneId, setZoneId] = useState<ZoneId>('family');
  const [lanes, setLanes] = useState<number[]>([]);
  const [partySize, setPartySize] = useState(20);
  const [childCount, setChildCount] = useState(4);
  const [purpose, setPurpose] = useState('暑期少儿游泳提高班');
  const [independentEntry, setIndependentEntry] = useState(true);
  const [separateChanging, setSeparateChanging] = useState(true);
  const [showerSeats, setShowerSeats] = useState(14);
  const [lockerCount, setLockerCount] = useState(20);
  const [scope, setScope] = useState<any>(null);

  const adultCount = partySize - childCount;
  const allLanes = zoneId === 'family' || zoneId === 'deep' ? [1, 2, 3, 4] : [1, 2, 3, 4, 5, 6];

  const body = {
    sessionId, zoneId, lanes: lanes.length ? lanes : undefined, partySize, adultCount, childCount,
    purpose, independentEntry, separateChanging, showerSeats, lockerCount,
    orgName: user.name, contactName: user.name, contactPhone: user.phone,
  };

  const preview = () =>
    act.mutateAsync({ path: '/rentals/preview', body }).then((r: any) => setScope(r)).catch((e) => notify.err(e));

  const apply = () =>
    act.mutateAsync({ path: '/rentals', body })
      .then(() => { notify.ok('包场申请已提交：平台将核验资质并与居民逐人协调，不会覆盖居民预约'); setScope(null); })
      .catch((e) => notify.err(e));

  return (
    <div className="grid cols-2">
      <Card title="培训机构包场申请">
        <div className="alert info">申请后平台先核验机构资质、教练与救生员配置、保险、人数年龄结构、是否含儿童（按儿童离陪规则核验陪同人）、独立出入口与更衣需求；并就居民改约逐人协商，<b>平台不会直接覆盖居民预约</b>。</div>
        <div className="form-row" style={{ marginTop: 8 }}>
          <label className="field">日期/时段<select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>{state.sessions.map((s) => <option key={s.id} value={s.id}>{s.label}{s.publicWelfare ? '（居民公益）' : ''}</option>)}</select></label>
          <label className="field">泳区<select value={zoneId} onChange={(e) => { setZoneId(e.target.value as ZoneId); setLanes([]); }}>{state.zones.map((z) => <option key={z.id} value={z.id}>{z.name}（容量 {z.capacity}）</option>)}</select></label>
        </div>
        <div style={{ height: 8 }} />
        <div className="small muted">申请泳道（不勾=整区；可只申请部分泳道）：</div>
        <div className="flex" style={{ flexWrap: 'wrap', gap: 8, margin: '4px 0 8px' }}>
          {allLanes.map((n) => (
            <label key={n} className="checkbox" style={{ minWidth: 80 }}><input type="checkbox" checked={lanes.includes(n)}
              onChange={(e) => setLanes((p) => e.target.checked ? [...p, n] : p.filter((x) => x !== n))} />{n} 号道</label>
          ))}
        </div>
        <div className="form-row">
          <label className="field">总人数（≥10）<input type="number" min={10} value={partySize} onChange={(e) => setPartySize(Math.max(10, Number(e.target.value)))} /></label>
          <label className="field">其中儿童人数<input type="number" value={childCount} onChange={(e) => setChildCount(Math.max(0, Math.min(partySize, Number(e.target.value))))} /></label>
        </div>
        <div className="small muted">成人 {adultCount} 人 · 儿童 {childCount} 人（含儿童须逐人登记陪同人，包场不放宽）</div>
        <label className="field" style={{ marginTop: 8 }}>用途说明<input value={purpose} onChange={(e) => setPurpose(e.target.value)} /></label>
        <div className="grid cols-2" style={{ marginTop: 8 }}>
          <label className="field">淋浴位需求<input type="number" value={showerSeats} onChange={(e) => setShowerSeats(Number(e.target.value))} /></label>
          <label className="field">储物柜需求<input type="number" value={lockerCount} onChange={(e) => setLockerCount(Number(e.target.value))} /></label>
          <label className="checkbox"><input type="checkbox" checked={independentEntry} onChange={(e) => setIndependentEntry(e.target.checked)} /> 使用独立出入口</label>
          <label className="checkbox"><input type="checkbox" checked={separateChanging} onChange={(e) => setSeparateChanging(e.target.checked)} /> 独立更衣/淋浴</label>
        </div>
        <div className="flex" style={{ marginTop: 12, gap: 8 }}>
          <button className="btn ghost" disabled={act.isPending} onClick={preview}>先查看冲突范围</button>
          <button className="btn danger" disabled={act.isPending || adultCount < 0} onClick={apply}>提交包场申请</button>
        </div>
      </Card>

      <Card title="冲突范围预览（日期/时段/泳道/泳区/容量/救生排班/已预约居民）">
        {!scope ? <Empty text="选择场次、泳道与人数后点击「先查看冲突范围」" /> : <ScopeSummary scope={scope} state={state} />}
      </Card>
    </div>
  );
}

// ============ 机构：我的包场 / 账单 / 信用 ============
export function MyRentals({ user, state }: { user: User; state: AppState }) {
  const act = useAction();
  const notify = useNotify();
  const mine = state.rentalCases.filter((r) => r.orgUserId === user.id);
  const bills = state.orgBills.filter((b) => b.orgUserId === user.id);
  const credit = state.orgCredits.find((p) => p.orgUserId === user.id);

  return (
    <div className="grid cols-2">
      <Card title={`我的包场申请（${mine.length}）`}>
        {mine.length === 0 ? <Empty text="还没有包场申请" /> : mine.map((rc) => {
          const pending = rc.residentConflicts.filter((c) => c.status === 'proposed').length;
          return (
            <div key={rc.id} className="notif info" style={{ marginBottom: 10 }}>
              <div className="flex"><b>{rc.code} · {sessionLabelOf(state, rc.sessionId)}</b><RentalStatusBadge status={rc.status} /></div>
              <div className="small" style={{ marginTop: 4 }}>
                {zoneNameOf(state, rc.zoneId)}{rc.lanes?.length ? ' ' + rc.lanes.join('/') + ' 号道' : ''} · {rc.partySize} 人（儿童 {rc.childCount}）
                {rc.coordination?.approvedCapacity != null && ` · 核准 ${rc.coordination.approvedCapacity} 人`}
              </div>
              <div className="small muted">
                受影响居民 {rc.residentConflicts.length} 笔：
                同意 {rc.residentConflicts.filter((c) => c.status === 'accepted').length} ·
                拒绝/保留 {rc.residentConflicts.filter((c) => c.status === 'rejected' || c.status === 'expired').length} ·
                待答复 {pending}
              </div>
              {rc.qualification.rectifyNote && <div className="alert warn" style={{ marginTop: 6 }}>需补充材料：{rc.qualification.rectifyNote}</div>}
              {rc.fee.total > 0 && (
                <details style={{ marginTop: 6 }}><summary className="small" style={{ cursor: 'pointer' }}>费用拆分（合计 ¥{rc.fee.total}，含押金 ¥{rc.fee.deposit}）</summary><FeeBreakdown fee={rc.fee} /></details>
              )}
              {rc.status === 'coordinating' && (
                <div style={{ marginTop: 6 }}>
                  {pending > 0
                    ? <div className="small muted">尚有 {pending} 名居民未答复改约，等待平台协调结果…</div>
                    : <button className="btn sm" disabled={act.isPending}
                      onClick={() => act.mutateAsync({ path: `/rentals/${rc.id}/confirm`, body: {} })
                        .then(() => notify.ok('已确认协调方案，费用进入机构账单，等待当天核验')).catch((e) => notify.err(e))}>
                      确认协调方案（费用五项拆分入账单）
                    </button>}
                </div>
              )}
              {rc.status === 'approved' && <div className="small" style={{ color: 'var(--ok)', marginTop: 6 }}>已确认：当天前台核验名单/访客身份/保险，救生按人数重新站位，保洁维修确认场地后开场。</div>}
              {rc.status === 'suspended' && <div className="alert danger" style={{ marginTop: 6 }}>现场因违规已暂停：{rc.suspendedReason}，整改合格后方可恢复。</div>}
              {rc.status === 'active' && <DayChecklistView checklist={rc.dayChecklist} />}
              {rc.status === 'completed' && <CloseoutView closeout={rc.closeout} />}
            </div>
          );
        })}
      </Card>
      <div className="grid">
        <Card title="机构账单（泳道/时段/救生加班/储物柜/淋浴拆分）">
          {bills.length === 0 ? <Empty text="暂无账单（方案确认后生成）" /> : bills.map((b) => (
            <div key={b.id} className="notif info" style={{ marginBottom: 8 }}>
              <div className="flex"><b>{b.rentalCode} · {b.sessionLabel}</b><span className="spacer" />
                <Badge tone={b.status === 'settled' ? 'ok' : b.status === 'deducted' ? 'warn' : 'danger'}>{b.status === 'settled' ? '已结清' : b.status === 'deducted' ? '押金抵扣' : '待结算'}</Badge>
              </div>
              <FeeBreakdown fee={b.breakdown} />
            </div>
          ))}
        </Card>
        <Card title="机构信用记录">
          {credit ? <CreditProfileCard p={credit} /> : <Empty text="暂无信用记录" />}
          <div className="small muted" style={{ marginTop: 6 }}>超时、超人数、投诉与整改均计入信用；频繁违规将被限制后续包场，或被要求增派救生员、提高押金。</div>
        </Card>
      </div>
    </div>
  );
}

// ============ 居民改约提议答复（不同意则保留原预约并压缩包场） ============
export function ResidentRebookOffers({ user, state }: { user: User; state: AppState }) {
  const act = useAction();
  const notify = useNotify();
  const offers = state.rentalCases.flatMap((rc) =>
    rc.residentConflicts.filter((c) => c.userId === user.id && c.status === 'proposed').map((c) => ({ rc, c })),
  );
  if (offers.length === 0) return null;
  return (
    <Card title="⚖️ 机构包场改约协商（您的预约）" className="section-gap">
      <div className="alert warn">平台不会因机构包场覆盖您的预约。同意改约将获得补偿券/退费；不同意则保留您的原预约，包场范围相应压缩。</div>
      {offers.map(({ rc, c }) => {
        const target = c.offerSessionId ? state.sessions.find((s) => s.id === c.offerSessionId) : null;
        const targetZone = c.offerZoneId ? state.zones.find((z) => z.id === c.offerZoneId) : null;
        return (
          <div key={rc.id + c.bookingId} className="notif warning" style={{ marginTop: 8 }}>
            <div className="flex"><b>您的预约 {c.bookingCode}</b><span className="spacer" /><Badge tone="purple">{rc.orgName} 包场协调</Badge></div>
            <div className="small" style={{ marginTop: 4 }}>
              建议改约：{target ? target.label : '同场分流'} {targetZone ? targetZone.name : zoneNameOf(state, c.zoneId)}{c.offerLane ? ` ${c.offerLane} 号道` : ' 其他泳道'}。
              {c.refundAmount > 0 && ` 原路退费 ¥${c.refundAmount}，`}补偿券 <b>{c.compVouchers}</b> 张。
            </div>
            <div className="flex" style={{ marginTop: 8, gap: 8 }}>
              <button className="btn sm ok" disabled={act.isPending}
                onClick={() => act.mutateAsync({ path: `/rentals/${rc.id}/rebook/${c.bookingId}`, body: { accept: true } })
                  .then(() => notify.ok('已同意改约：新预约已生成，补偿/退费已到账')).catch((e) => notify.err(e))}>
                同意改约
              </button>
              <button className="btn sm ghost danger" disabled={act.isPending}
                onClick={() => act.mutateAsync({ path: `/rentals/${rc.id}/rebook/${c.bookingId}`, body: { accept: false, note: '居民不同意改约' } })
                  .then(() => notify.ok('已保留您的原预约，包场范围已压缩')).catch((e) => notify.err(e))}>
                不同意（保留原预约）
              </button>
            </div>
          </div>
        );
      })}
    </Card>
  );
}
