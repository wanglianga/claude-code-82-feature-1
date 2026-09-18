import { useMemo, useState } from 'react';
import type {
  User, RentalCase, RentalViolationType, ZoneId, OrgCreditProfile,
} from '../../shared/types.js';
import type { AppState } from '../api.js';
import { useAction } from '../api.js';
import { Badge, Card, Empty, fmtDateTime, useNotify } from '../ui.js';
import { SessionPicker } from './common.js';
import {
  RentalStatusBadge, ConflictTags, ResidentConflictRow, FeeBreakdown,
  DayChecklistView, CloseoutView, CreditProfileCard, zoneNameOf,
} from './rental.js';

const VIOLATION_TYPES: RentalViolationType[] = [
  'over_capacity', 'overtime', 'occupy_welfare', 'child_unaccompanied', 'unauthorized_addon', 'other',
];
const VIOLATION_LABEL: Record<RentalViolationType, string> = {
  over_capacity: '超人数', overtime: '超时', occupy_welfare: '占用公益泳道',
  child_unaccompanied: '儿童无人陪同', unauthorized_addon: '机构私自加人', other: '其他',
};

function useRentalAction(notify: ReturnType<typeof useNotify>) {
  const act = useAction();
  return (path: string, body?: unknown) =>
    act.mutateAsync({ path, body }).catch((e) => { notify.err(e); throw e; });
}

// ============ 资质核验表单 ============
function QualifyForm({ rc, notify }: { rc: RentalCase; state: AppState; notify: ReturnType<typeof useNotify> }) {
  const q0 = rc.qualification;
  const [f, setF] = useState({
    institutionCert: q0.institutionCert, coachCert: q0.coachCert, lifeguardCert: q0.lifeguardCert,
    coachNames: q0.coachNames || '马教练、林教练',
    lifeguardCount: q0.lifeguardCount, lifeguardNames: q0.lifeguardNames || '刘救生、周救生',
    insurancePolicyNo: q0.insurancePolicyNo || 'PUB-2026-', insuranceCoverage: q0.insuranceCoverage || 1000000,
    insuranceVerified: q0.insuranceVerified, insuranceExpiry: q0.insuranceExpiry || '2026-12-31',
    ageStructure: q0.ageStructure, independentEntry: q0.independentEntry, separateChanging: q0.separateChanging,
    showerSeats: q0.showerSeats, lockerCount: q0.lockerCount, rectifyNote: '',
  });
  const [companions, setCompanions] = useState(
    q0.companions.length ? q0.companions : Array.from({ length: rc.childCount }, () => ({ childName: '', childAge: 8, companion: '', companionPhone: '', relation: '' })),
  );
  const run = useRentalAction(notify);
  const act = useAction();
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));

  const submit = () =>
    run(`/rentals/${rc.id}/qualify`, {
      ...f,
      institutionCertNote: f.institutionCert ? '办学/经营资质齐全' : '',
      coachCertNote: f.coachCert ? '教练社会体育指导员证齐全' : '',
      lifeguardCertNote: f.lifeguardCert ? '救生员证齐全' : '',
      companions: rc.containsChildren ? companions : [],
      rectifyNote: f.rectifyNote || undefined,
    }).then((r: any) => { if (r) notify.ok('资质核验完成，进入居民改约协调'); }).catch(() => {});

  return (
    <div className="notif warning">
      <b>机构资质 / 教练 / 救生员 / 保险 / 人数年龄结构 / 儿童陪同 / 独立动线 核验</b>
      <div className="grid cols-2" style={{ marginTop: 8 }}>
        <label className="checkbox"><input type="checkbox" checked={f.institutionCert} onChange={(e) => set('institutionCert', e.target.checked)} /> 机构办学/经营资质已核验</label>
        <label className="checkbox"><input type="checkbox" checked={f.coachCert} onChange={(e) => set('coachCert', e.target.checked)} /> 教练资质证齐全</label>
        <label className="checkbox"><input type="checkbox" checked={f.lifeguardCert} onChange={(e) => set('lifeguardCert', e.target.checked)} /> 救生员资质证齐全</label>
        <label className="checkbox"><input type="checkbox" checked={f.insuranceVerified} onChange={(e) => set('insuranceVerified', e.target.checked)} /> 公众责任险已核验</label>
      </div>
      <div className="form-row" style={{ marginTop: 8 }}>
        <label className="field">教练名单<input value={f.coachNames} onChange={(e) => set('coachNames', e.target.value)} /></label>
        <label className="field">救生员人数<input type="number" value={f.lifeguardCount} onChange={(e) => set('lifeguardCount', Number(e.target.value))} /></label>
      </div>
      <div className="form-row" style={{ marginTop: 8 }}>
        <label className="field">救生员名单<input value={f.lifeguardNames} onChange={(e) => set('lifeguardNames', e.target.value)} /></label>
        <label className="field">年龄结构<input value={f.ageStructure} onChange={(e) => set('ageStructure', e.target.value)} /></label>
      </div>
      <div className="form-row" style={{ marginTop: 8 }}>
        <label className="field">保险单号<input value={f.insurancePolicyNo} onChange={(e) => set('insurancePolicyNo', e.target.value)} /></label>
        <label className="field">保额（元）<input type="number" value={f.insuranceCoverage} onChange={(e) => set('insuranceCoverage', Number(e.target.value))} /></label>
        <label className="field">保险有效期<input value={f.insuranceExpiry} onChange={(e) => set('insuranceExpiry', e.target.value)} /></label>
      </div>
      <div className="grid cols-2" style={{ marginTop: 8 }}>
        <label className="checkbox"><input type="checkbox" checked={f.independentEntry} onChange={(e) => set('independentEntry', e.target.checked)} /> 使用独立出入口</label>
        <label className="checkbox"><input type="checkbox" checked={f.separateChanging} onChange={(e) => set('separateChanging', e.target.checked)} /> 独立更衣/淋浴需求</label>
        <label className="field">淋浴位需求<input type="number" value={f.showerSeats} onChange={(e) => set('showerSeats', Number(e.target.value))} /></label>
        <label className="field">储物柜需求<input type="number" value={f.lockerCount} onChange={(e) => set('lockerCount', Number(e.target.value))} /></label>
      </div>

      {rc.containsChildren && (
        <div style={{ marginTop: 10 }}>
          <div className="alert danger" style={{ marginBottom: 6 }}>涉及 {rc.childCount} 名儿童：按儿童离陪规则逐人核验陪同人，包场不得放宽（≤13 岁须登记陪同人+电话）。</div>
          {companions.map((c, i) => (
            <div key={i} className="form-row" style={{ marginBottom: 6 }}>
              <input placeholder="儿童姓名" value={c.childName} onChange={(e) => setCompanions((p) => p.map((x, j) => j === i ? { ...x, childName: e.target.value } : x))} />
              <input type="number" placeholder="年龄" style={{ width: 80 }} value={c.childAge} onChange={(e) => setCompanions((p) => p.map((x, j) => j === i ? { ...x, childAge: Number(e.target.value) } : x))} />
              <input placeholder="陪同人" value={c.companion} onChange={(e) => setCompanions((p) => p.map((x, j) => j === i ? { ...x, companion: e.target.value } : x))} />
              <input placeholder="陪同电话" value={c.companionPhone} onChange={(e) => setCompanions((p) => p.map((x, j) => j === i ? { ...x, companionPhone: e.target.value } : x))} />
              <input placeholder="关系" style={{ width: 90 }} value={c.relation} onChange={(e) => setCompanions((p) => p.map((x, j) => j === i ? { ...x, relation: e.target.value } : x))} />
            </div>
          ))}
        </div>
      )}

      <label className="field" style={{ marginTop: 8 }}>整改要求（材料不全时填写，暂存并通知机构补充；留空且全部勾选=核验通过）<input value={f.rectifyNote} onChange={(e) => set('rectifyNote', e.target.value)} placeholder="如：补交本年度保险单、补齐 1 名救生员" /></label>
      <div className="flex" style={{ marginTop: 10 }}>
        <button className="btn danger sm" disabled={act.isPending} onClick={submit}>提交核验</button>
        <button className="btn ghost danger sm" disabled={act.isPending}
          onClick={() => { if (confirm('确认驳回该包场申请？锁区将释放，居民预约不受影响。')) run(`/rentals/${rc.id}/reject`, { reason: '资质/保险/儿童陪同核验不通过' }).then(() => notify.ok('已驳回并释放锁区')).catch(() => {}); }}>
          驳回包场
        </button>
      </div>
      <div className="small muted" style={{ marginTop: 6 }}>人数 {rc.partySize}（成人 {rc.adultCount} / 儿童 {rc.childCount}）；救生员最低配置由系统按人数与是否含儿童测算。</div>
    </div>
  );
}

// ============ 居民改约协商 + 协调方案 ============
function CoordinatePanel({ rc, state, notify }: { rc: RentalCase; state: AppState; notify: ReturnType<typeof useNotify> }) {
  const run = useRentalAction(notify);
  const act = useAction();
  const otherSessions = state.sessions.filter((s) => s.id !== rc.sessionId);
  const [offerOverride, setOfferOverride] = useState<Record<string, { session: string; zone: string; vouchers: number; refund: number }>>({});
  const [lanes, setLanes] = useState<number[]>([]);
  const [capacity, setCapacity] = useState(rc.partySize);
  const [extraGuards, setExtraGuards] = useState(1);
  const [vouchers, setVouchers] = useState(1);
  const [welfareRefund, setWelfareRefund] = useState(true);
  const [note, setNote] = useState('');

  const allLanes = rc.zoneId === 'family' || rc.zoneId === 'deep' ? [1, 2, 3, 4] : [1, 2, 3, 4, 5, 6];

  const submit = () => {
    const offers = rc.residentConflicts
      .filter((c) => c.status !== 'accepted')
      .map((c) => {
        const ov = offerOverride[c.bookingId];
        return {
          bookingId: c.bookingId,
          offerSessionId: ov?.session ? ov.session : undefined,
          offerZoneId: (ov?.zone as ZoneId) || undefined,
          compVouchers: ov?.vouchers ?? vouchers,
          refundAmount: ov?.refund ?? 0,
        };
      });
    run(`/rentals/${rc.id}/coordinate`, {
      offers,
      approvedLanes: lanes.length ? lanes : undefined,
      approvedCapacity: capacity,
      extraLifeguards: extraGuards,
      residentCompVouchers: vouchers,
      welfareRefund,
      note: note || undefined,
    }).then(() => notify.ok('已逐人发起改约提议并保存协调方案')).catch(() => {});
  };

  const setOv = (bid: string, patch: Record<string, unknown>) =>
    setOfferOverride((p) => {
      const cur = p[bid] ?? { session: '', zone: '', vouchers, refund: 0 };
      return { ...p, [bid]: { ...cur, ...patch } };
    });

  return (
    <div>
      <h4>受影响居民逐人协商（平台不能直接覆盖居民预约）</h4>
      {rc.residentConflicts.length === 0 && <div className="alert ok">占用范围内无居民预约，可直接确认方案。</div>}
      {rc.residentConflicts.map((c) => (
        <div key={c.bookingId} className="notif warning" style={{ marginBottom: 8 }}>
          <ResidentConflictRow c={c} state={state} />
          {c.status !== 'accepted' && (
            <div className="form-row" style={{ marginTop: 6 }}>
              <label className="field">改约场次
                <select value={offerOverride[c.bookingId]?.session ?? ''} onChange={(e) => setOv(c.bookingId, { session: e.target.value })}>
                  <option value="">同场分流（不跨场）</option>
                  {otherSessions.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </label>
              <label className="field">改约泳区
                <select value={offerOverride[c.bookingId]?.zone ?? ''} onChange={(e) => setOv(c.bookingId, { zone: e.target.value })}>
                  <option value="">原泳区其他泳道</option>
                  {state.zones.filter((z) => z.id !== rc.zoneId).map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
                </select>
              </label>
              <label className="field">补偿券<input type="number" style={{ width: 80 }} value={offerOverride[c.bookingId]?.vouchers ?? vouchers} onChange={(e) => setOv(c.bookingId, { vouchers: Number(e.target.value) })} /></label>
              <label className="field">部分退费¥<input type="number" style={{ width: 90 }} value={offerOverride[c.bookingId]?.refund ?? 0} onChange={(e) => setOv(c.bookingId, { refund: Number(e.target.value) })} /></label>
            </div>
          )}
          {c.status === 'proposed' && (
            <div className="flex" style={{ marginTop: 6 }}>
              <button className="btn sm" disabled={act.isPending} onClick={() => run(`/rentals/${rc.id}/rebook/${c.bookingId}`, { accept: true }).then(() => notify.ok('代居民确认同意')).catch(() => {})}>代填：居民同意</button>
              <button className="btn sm ghost danger" disabled={act.isPending} onClick={() => run(`/rentals/${rc.id}/rebook/${c.bookingId}`, { accept: false }).then(() => notify.ok('居民拒绝，已保留原预约并压缩包场')).catch(() => {})}>代填：居民拒绝</button>
              <button className="btn sm ghost" disabled={act.isPending} onClick={() => run(`/rentals/${rc.id}/rebook/${c.bookingId}/expire`).then(() => notify.ok('已标记超时未答复')).catch(() => {})}>标记超时未答复</button>
            </div>
          )}
        </div>
      ))}

      <h4>协调措施（可拆分泳道/缩短包场/限制人数/增派救生员/暂停部分非公益泳道/补偿）</h4>
      <div className="small muted" style={{ marginBottom: 4 }}>实际批准泳道（不勾=原申请范围；居民拒绝改约的泳道确认时自动剔除）：</div>
      <div className="flex" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        {allLanes.map((n) => (
          <label key={n} className="checkbox" style={{ minWidth: 90 }}>
            <input type="checkbox" checked={lanes.includes(n)} onChange={(e) => setLanes((p) => e.target.checked ? [...p, n] : p.filter((x) => x !== n))} />{n} 号道
          </label>
        ))}
      </div>
      <div className="form-row">
        <label className="field">限制后人数上限<input type="number" value={capacity} onChange={(e) => setCapacity(Number(e.target.value))} /></label>
        <label className="field">增派救生员（名）<input type="number" value={extraGuards} onChange={(e) => setExtraGuards(Number(e.target.value))} /></label>
        <label className="field">默认改约补偿券（张）<input type="number" value={vouchers} onChange={(e) => setVouchers(Number(e.target.value))} /></label>
      </div>
      <label className="checkbox" style={{ marginTop: 8 }}><input type="checkbox" checked={welfareRefund} onChange={(e) => setWelfareRefund(e.target.checked)} /> 居民公益时段被压缩时退费/补偿券同步到居民端（不能只内部记账）</label>
      <label className="field" style={{ marginTop: 8 }}>方案说明<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：拆 5-6 号道、限 16 人、增派 1 名救生、亲子居民改约晚场" /></label>
      <button className="btn danger" style={{ marginTop: 10 }} disabled={act.isPending} onClick={submit}>发起/更新改约提议并保存协调方案（自动重算费用拆分）</button>
    </div>
  );
}

// ============ 当天核验 + 开场（运营可代各岗确认） ============
function DayOpsPanel({ rc, state, notify }: { rc: RentalCase; state: AppState; notify: ReturnType<typeof useNotify> }) {
  const run = useRentalAction(notify);
  const act = useAction();
  const [actual, setActual] = useState(rc.actualCount ?? rc.coordination?.approvedCapacity ?? rc.partySize);
  const guards = state.users.filter((u) => u.role === 'lifeguard').map((u) => u.name);
  const [guardNames, setGuardNames] = useState<string[]>([]);
  const [water, setWater] = useState({ tempC: 27, freeChlorine: 0.8, turbidity: 0.6, ph: 7.3 });

  const day = (key: string, extra?: any) => run(`/rentals/${rc.id}/day-check`, { key, done: true, ...extra }).then(() => notify.ok('当天核验已记录')).catch(() => {});
  const co = (key: string, extra?: any) => run(`/rentals/${rc.id}/closeout`, { key, done: true, ...extra }).then(() => notify.ok('收尾项已确认')).catch(() => {});

  return (
    <div className="grid cols-2">
      <Card title="包场当天六岗核验">
        <DayChecklistView checklist={rc.dayChecklist} />
        <div className="form-row" style={{ marginTop: 8 }}>
          <label className="field">实际到场人数<input type="number" value={actual} onChange={(e) => setActual(Number(e.target.value))} /></label>
          <button className="btn sm" disabled={act.isPending} onClick={() => run(`/rentals/${rc.id}/actual-count`, { actualCount: actual }).then(() => notify.ok('名单人数已登记')).catch(() => {})}>登记名单人数</button>
        </div>
        <div className="flex" style={{ flexWrap: 'wrap', gap: 6, margin: '8px 0' }}>
          <button className="btn sm" disabled={act.isPending} onClick={() => day('rosterMatched')}>前台名单✓</button>
          <button className="btn sm" disabled={act.isPending} onClick={() => day('visitorIdChecked')}>访客身份✓</button>
          <button className="btn sm" disabled={act.isPending} onClick={() => day('insuranceChecked')}>保险复核✓</button>
        </div>
        <div className="small muted">救生按人数重新站位（勾选本次站位救生员）：</div>
        <div className="flex" style={{ flexWrap: 'wrap', gap: 6, margin: '4px 0' }}>
          {guards.map((g) => (
            <label key={g} className="checkbox" style={{ minWidth: 90 }}><input type="checkbox" checked={guardNames.includes(g)}
              onChange={(e) => setGuardNames((p) => e.target.checked ? [...p, g] : p.filter((x) => x !== g))} />{g}</label>
          ))}
          <button className="btn sm" disabled={act.isPending} onClick={() => day('guardRepositioned', { guardNames })}>救生重新站位✓</button>
        </div>
        <div className="flex" style={{ gap: 6, margin: '8px 0' }}>
          <button className="btn sm" disabled={act.isPending} onClick={() => day('cleaningReady')}>保洁保障✓</button>
          <button className="btn sm" disabled={act.isPending} onClick={() => day('maintenanceReady')}>维修保障✓</button>
        </div>
        <button className="btn" style={{ marginTop: 8 }} disabled={act.isPending || rc.status !== 'approved'}
          onClick={() => run(`/rentals/${rc.id}/start`).then(() => notify.ok('核验齐备，包场开场')).catch(() => {})}>
          六项齐备，放行包场开场
        </button>
        {rc.status === 'active' && <div className="alert ok" style={{ marginTop: 8 }}>包场进行中。</div>}
      </Card>

      <Card title="现场违规处置（可暂停并通知社区运营，计入机构信用）">
        <ViolationPanel rc={rc} notify={notify} />
      </Card>

      <Card title="包场结束清场恢复门禁（未复测或未清场不得开放下一场）">
        <CloseoutView closeout={rc.closeout} />
        <div className="form-row" style={{ marginTop: 8 }}>
          <label className="field">水温<input type="number" step="0.1" value={water.tempC} onChange={(e) => setWater((p) => ({ ...p, tempC: Number(e.target.value) }))} /></label>
          <label className="field">余氯<input type="number" step="0.01" value={water.freeChlorine} onChange={(e) => setWater((p) => ({ ...p, freeChlorine: Number(e.target.value) }))} /></label>
          <label className="field">浊度<input type="number" step="0.01" value={water.turbidity} onChange={(e) => setWater((p) => ({ ...p, turbidity: Number(e.target.value) }))} /></label>
          <label className="field">pH<input type="number" step="0.1" value={water.ph} onChange={(e) => setWater((p) => ({ ...p, ph: Number(e.target.value) }))} /></label>
        </div>
        <div className="flex" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          <button className="btn sm" disabled={act.isPending} onClick={() => co('cleared')}>清场✓</button>
          <button className="btn sm" disabled={act.isPending} onClick={() => co('lockersCleared')}>清储物柜✓</button>
          <button className="btn sm" disabled={act.isPending} onClick={() => co('waterRetested', { reading: water })}>水质复测达标✓</button>
          <button className="btn sm" disabled={act.isPending} onClick={() => co('equipmentReset')}>设备复位✓</button>
          <button className="btn sm" disabled={act.isPending} onClick={() => co('guardPatrolConfirmed')}>救生巡查✓</button>
        </div>
        <button className="btn ok" style={{ marginTop: 10 }} disabled={act.isPending || rc.status !== 'active'}
          onClick={() => run(`/rentals/${rc.id}/reopen`).then(() => notify.ok('五项齐备，已恢复居民预约并通知居民端')).catch(() => {})}>
          五项齐备，恢复居民预约（释放锁区+居民端通知）
        </button>
      </Card>

      <Card title="机构账单结算（费用五项拆分 + 押金）">
        <FeeBreakdown fee={rc.fee} />
        <SettlePanel rc={rc} notify={notify} />
      </Card>
    </div>
  );
}

function ViolationPanel({ rc, notify }: { rc: RentalCase; notify: ReturnType<typeof useNotify> }) {
  const run = useRentalAction(notify);
  const act = useAction();
  const [type, setType] = useState<RentalViolationType>('over_capacity');
  const [desc, setDesc] = useState('');
  const [actualCount, setActualCount] = useState<number>(0);
  const [suspend, setSuspend] = useState(true);
  return (
    <div>
      {rc.violations.length === 0 ? <Empty text="暂无现场违规记录" /> : rc.violations.map((v) => (
        <div key={v.id} className={`notif ${v.suspended ? 'critical' : 'warning'}`}>
          <div className="flex"><b>{VIOLATION_LABEL[v.type]}</b><span className="spacer" /><Badge tone={v.rectified ? 'ok' : 'danger'}>{v.rectified ? '已整改' : '未整改'}</Badge></div>
          <div className="small">{v.description}{v.actualCount ? `（实际 ${v.actualCount} 人）` : ''}</div>
          <div className="small muted">{fmtDateTime(v.at)} · {v.by} · 已通知社区运营</div>
          {!v.rectified && <button className="btn sm" style={{ marginTop: 6 }} disabled={act.isPending}
            onClick={() => run(`/rentals/${rc.id}/violations/${v.id}/rectify`, { note: '现场已清退/纠正并复查合格' }).then(() => notify.ok('整改已记录')).catch(() => {})}>登记整改合格</button>}
        </div>
      ))}
      <div className="form-row" style={{ marginTop: 8 }}>
        <label className="field">违规类型<select value={type} onChange={(e) => setType(e.target.value as RentalViolationType)}>{VIOLATION_TYPES.map((t) => <option key={t} value={t}>{VIOLATION_LABEL[t]}</option>)}</select></label>
        <label className="field">实际人数（超人数时）<input type="number" value={actualCount} onChange={(e) => setActualCount(Number(e.target.value))} /></label>
      </div>
      <label className="field" style={{ marginTop: 8 }}>情况描述<input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="如：清点 24 人，超核准上限 4 人" /></label>
      <label className="checkbox" style={{ marginTop: 8 }}><input type="checkbox" checked={suspend} onChange={(e) => setSuspend(e.target.checked)} /> 当场暂停包场并通知社区运营</label>
      <button className="btn danger sm" style={{ marginTop: 8 }} disabled={act.isPending || !desc.trim()}
        onClick={() => run(`/rentals/${rc.id}/violations`, { type, description: desc, actualCount: actualCount || undefined, suspend }).then(() => { notify.ok('违规已记录并计入机构信用'); setDesc(''); }).catch(() => {})}>
        登记违规{suspend ? '并暂停包场' : ''}
      </button>
    </div>
  );
}

function SettlePanel({ rc, notify }: { rc: RentalCase; notify: ReturnType<typeof useNotify> }) {
  const run = useRentalAction(notify);
  const act = useAction();
  const [deduct, setDeduct] = useState(0);
  const [method, setMethod] = useState<'cash' | 'wallet'>('cash');
  const bill = rc.billId;
  if (!bill) return <div className="small muted">机构确认方案后费用才进入账单。</div>;
  return (
    <div className="flex" style={{ marginTop: 8, gap: 8, flexWrap: 'wrap' }}>
      <select value={method} onChange={(e) => setMethod(e.target.value as any)}><option value="cash">对公/现场结算</option><option value="wallet">机构储值支付</option></select>
      <label className="field" style={{ minWidth: 180 }}>押金抵扣（违规赔偿）¥<input type="number" value={deduct} onChange={(e) => setDeduct(Number(e.target.value))} /></label>
      <button className="btn sm" disabled={act.isPending || rc.status !== 'completed'}
        onClick={() => run(`/rentals/${rc.id}/settle`, { paymentMethod: method, depositDeducted: deduct }).then(() => notify.ok('账单已结算')).catch(() => {})}>
        结算账单{rc.status !== 'completed' ? '（清场恢复后）' : ''}
      </button>
    </div>
  );
}

// ============ 单个包场档案工作台 ============
function RentalCaseCard({ rc, state, notify, user }: { rc: RentalCase; state: AppState; notify: ReturnType<typeof useNotify>; user: User }) {
  const session = state.sessions.find((s) => s.id === rc.sessionId);
  const run = useRentalAction(notify);
  const act = useAction();
  const pendingResidents = rc.residentConflicts.filter((c) => c.status === 'proposed').length;

  return (
    <Card title={`${rc.code} · ${rc.orgName} · ${zoneNameOf(state, rc.zoneId)}${rc.lanes?.length ? ' ' + rc.lanes.join('/') + ' 号道' : ''}`}
      extra={<div className="flex" style={{ gap: 6 }}><RentalStatusBadge status={rc.status} /></div>}>
      <div className="small muted">
        {session?.label} · 申请 {rc.partySize} 人（成人 {rc.adultCount}/儿童 {rc.childCount}）
        {rc.coordination?.approvedCapacity != null && ` · 核准上限 ${rc.coordination.approvedCapacity} 人`}
        {rc.actualCount != null && ` · 实际到场 ${rc.actualCount} 人`}
        {rc.containsChildren && <span className="badge purple" style={{ marginLeft: 6 }}>含儿童·逐人陪同</span>}
        <span className="badge" style={{ marginLeft: 6 }}>联系人 {rc.contactName} {rc.contactPhone}</span>
      </div>

      {/* 阶段 1：资质核验 */}
      {(rc.status === 'pending' || rc.status === 'verifying') && user.role === 'ops' && <QualifyForm rc={rc} state={state} notify={notify} />}

      {/* 阶段 2：居民协商 + 协调方案 */}
      {(rc.status === 'coordinating' || rc.status === 'pending' || rc.status === 'verifying') && user.role === 'ops' && (
        <CoordinatePanel rc={rc} state={state} notify={notify} />
      )}

      {/* 机构确认（运营代确认） */}
      {rc.status === 'coordinating' && user.role === 'ops' && (
        <div className="alert warn" style={{ marginTop: 10 }}>
          {pendingResidents > 0 ? `还有 ${pendingResidents} 名居民待答复，须全部答复/标记超时后机构才能确认。` : '所有受影响居民已处理（同意改约或拒绝保留并压缩包场）。'}
          <button className="btn" style={{ marginLeft: 10 }} disabled={act.isPending || pendingResidents > 0}
            onClick={() => run(`/rentals/${rc.id}/confirm`, {}).then(() => notify.ok('机构方案已确认，费用五项拆分进入机构账单，等待当天核验')).catch(() => {})}>
            代机构确认协调方案（锁定范围+费用入账单）
          </button>
        </div>
      )}

      {/* 阶段 3-5：当天核验/违规/清场恢复/结算（运营全量操作） */}
      {(rc.status === 'approved' || rc.status === 'active' || rc.status === 'suspended' || rc.status === 'completed') && user.role === 'ops' && (
        <DayOpsPanel rc={rc} state={state} notify={notify} />
      )}

      {/* 时间线（供排期与投诉追溯） */}
      <details style={{ marginTop: 10 }}>
        <summary className="small muted" style={{ cursor: 'pointer' }}>该场次协调/改约/补偿/确认/恢复全记录（{rc.timeline.length}）</summary>
        <ul className="timeline" style={{ marginTop: 6 }}>
          {rc.timeline.map((t, i) => (
            <li key={i}><div className="small">{t.action}</div><div className="at">{fmtDateTime(t.at)} · {t.by}（{t.byRole}）</div></li>
          ))}
        </ul>
      </details>
    </Card>
  );
}

// ============ 运营包场协调主页面 ============
export function OpsRentalTab({ state, user }: { state: AppState; user: User }) {
  const notify = useNotify();
  const [sessionId, setSessionId] = useState(state.sessions.find((s) => s.id === 's-pm')?.id ?? state.sessions[0].id);
  const [caseId, setCaseId] = useState<string | undefined>(undefined);
  const list = useMemo(() =>
    [...state.rentalCases].sort((a, b) => b.appliedAt.localeCompare(a.appliedAt)),
  [state.rentalCases]);
  const current = list.find((r) => r.id === caseId) ?? list.find((r) => r.sessionId === sessionId) ?? list[0];

  return (
    <div>
      <SessionPicker sessions={state.sessions} value={sessionId} onChange={(v) => { setSessionId(v); setCaseId(undefined); }} />
      <div className="grid cols-2">
        <div className="grid">
          <Card title={`包场协调档案（${list.length}）`}>
            {list.length === 0 ? <Empty text="暂无机构包场申请" /> : list.map((rc) => (
              <button key={rc.id} className={`queue-row ${current?.id === rc.id ? 'is-sel' : ''}`} style={{ width: '100%', textAlign: 'left', border: 'none', background: current?.id === rc.id ? 'var(--aqua-soft)' : undefined, borderRadius: 10, padding: 10, cursor: 'pointer' }}
                onClick={() => setCaseId(rc.id)}>
                <div>
                  <div className="flex"><b>{rc.code}</b><RentalStatusBadge status={rc.status} /></div>
                  <div className="small muted">{rc.orgName} · {state.sessions.find((s) => s.id === rc.sessionId)?.label} · {zoneNameOf(state, rc.zoneId)} · {rc.partySize} 人{rc.childCount > 0 ? `（童${rc.childCount}）` : ''}</div>
                  <div className="small">居民冲突 {rc.residentConflicts.length} 笔 · 违规 {rc.violations.length} 次{rc.fee.total > 0 ? ` · 账单 ¥${rc.fee.total}` : ''}</div>
                </div>
              </button>
            ))}
          </Card>
          <Card title="机构信用档案（频繁违规→限制包场/增派救生/加押金）">
            <OrgCreditPanel state={state} notify={notify} />
          </Card>
        </div>
        <div>
          {current ? <RentalCaseCard rc={current} state={state} notify={notify} user={user} /> : <Empty text="选择左侧包场档案进行协调" />}
        </div>
      </div>
    </div>
  );
}

function OrgCreditPanel({ state, notify }: { state: AppState; notify: ReturnType<typeof useNotify> }) {
  const run = useRentalAction(notify);
  const act = useAction();
  const [note, setNote] = useState('');
  if (state.orgCredits.length === 0) return <Empty text="暂无机构信用记录" />;
  return (
    <div>
      {state.orgCredits.map((p: OrgCreditProfile) => (
        <div key={p.orgUserId} style={{ marginBottom: 10 }}>
          <CreditProfileCard p={p} />
          <div className="flex" style={{ gap: 6, marginTop: 6 }}>
            <button className="btn sm danger" disabled={act.isPending || p.rentalRestricted}
              onClick={() => run(`/orgs/${p.orgUserId}/restriction`, { rentalRestricted: true, requiredExtraLifeguards: 1, depositMultiplier: 2, note: note || '频繁违规，限制后续包场并增派救生、加倍押金' }).then(() => notify.ok('已限制该机构后续包场')).catch(() => {})}>
              限制后续包场（+1救生/押金×2）
            </button>
            <button className="btn sm ghost" disabled={act.isPending || !p.rentalRestricted}
              onClick={() => run(`/orgs/${p.orgUserId}/restriction`, { rentalRestricted: false, requiredExtraLifeguards: 0, depositMultiplier: 1, note: '整改验收合格，解除限制' }).then(() => notify.ok('已解除限制')).catch(() => {})}>
              解除限制
            </button>
          </div>
        </div>
      ))}
      <input placeholder="限制/解除说明" value={note} onChange={(e) => setNote(e.target.value)} style={{ marginTop: 6 }} />
    </div>
  );
}
