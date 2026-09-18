import { useMemo, useState } from 'react';
import type {
  User, ZoneId, InstitutionRental, RentalStatus,
  QualificationKey, ResidentTag,
  RentalGateKey, RentalClearanceKey,
} from '../../shared/types.js';
import {
  QUALIFICATION_LABEL, RESIDENT_TAG_LABEL, RENTAL_GATE_LABEL, RENTAL_CLEARANCE_LABEL,
} from '../../shared/types.js';
import type { AppState } from '../api.js';
import { useAction } from '../api.js';
import { Badge, Card, Empty, useNotify, fmtDateTime } from '../ui.js';
import { buildRentalBillItems, billTotal, hoursBetween, requiredCompanions } from '../../shared/logic.js';

type Props = { user: User; state: AppState };

const RENTAL_STATUS_LABEL: Record<RentalStatus, string> = {
  applied: '待核验', coordinating: '协调中', approved: '已批准', rejected: '已驳回',
  active: '进行中', suspended: '已暂停', ended: '待清场', completed: '已完成', cancelled: '已取消',
};
const RENTAL_STATUS_TONE: Record<RentalStatus, string> = {
  applied: 'warn', coordinating: 'warn', approved: 'info', rejected: 'gray',
  active: 'ok', suspended: 'danger', ended: 'purple', completed: 'ok', cancelled: 'gray',
};

const TAG_TONE: Record<ResidentTag, string> = {
  elder_morning: 'purple', parent_child: 'warn', public_welfare: 'purple',
  coaching: 'info', stored_value: 'gray', child: 'danger', deep_cert: 'info',
};

const VIOLATION_TYPES: { v: 'overtime' | 'over_capacity' | 'occupy_welfare' | 'child_alone' | 'add_people' | 'complaint'; label: string }[] = [
  { v: 'overtime', label: '超时滞留' },
  { v: 'over_capacity', label: '超人数' },
  { v: 'occupy_welfare', label: '占用公益泳道' },
  { v: 'child_alone', label: '儿童无人陪同' },
  { v: 'add_people', label: '私自加人' },
  { v: 'complaint', label: '投诉成立' },
];

function zoneName(state: AppState, id: ZoneId) { return state.zones.find((z) => z.id === id)?.name ?? id; }
function instName(state: AppState, id: string) { return state.institutions.find((i) => i.id === id)?.name ?? '机构'; }
function instOf(state: AppState, r: InstitutionRental) { return state.institutions.find((i) => i.id === r.institutionId); }

function BillPreview({ state, rental }: { state: AppState; rental: InstitutionRental }) {
  const coord = rental.coordination;
  if (!coord) return <div className="small muted">保存协调措施后自动核算费用拆分。</div>;
  const s = state.sessions.find((x) => x.id === rental.sessionId)!;
  const hours = hoursBetween(coord.shorten && coord.adjustedStart ? coord.adjustedStart : s.start,
    coord.shorten && coord.adjustedEnd ? coord.adjustedEnd : s.end);
  const items = buildRentalBillItems({ coordination: coord, requestWholeZone: rental.requestLanes.length === 0, hours, lockersNeeded: rental.facility.lockersNeeded, depositRequired: coord.requireDeposit });
  const total = billTotal(items);
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>费用项</th><th>数量</th><th>单价</th><th>金额</th></tr></thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={i}><td className="small">{it.label}</td><td>{it.qty}</td><td>¥{it.unitPrice}</td><td className="code-mono">¥{it.amount}</td></tr>
          ))}
        </tbody>
      </table>
      <div className="flex" style={{ marginTop: 8 }}><span className="spacer" /><b>合计（进入机构账单）：¥{total}</b></div>
    </div>
  );
}

function ResidentRows({ state, rental, act, notify, editable }: { state: AppState; rental: InstitutionRental; act: ReturnType<typeof useAction>; notify: ReturnType<typeof useNotify>; editable: boolean }) {
  const [target, setTarget] = useState(rental.residentConflicts.find((c) => c.offerSessionId)?.offerSessionId ?? '');
  const [voucher, setVoucher] = useState(true);
  const resolve = (bookingId: string, resolution: any, targetSessionId?: string) =>
    act.mutateAsync({ path: `/rentals/${rental.id}/residents/${bookingId}/resolve`, body: { resolution, targetSessionId } })
      .then(() => notify.ok('已处置并同步居民端')).catch((e) => notify.err(e));
  if (rental.residentConflicts.length === 0) return <Empty text="协调范围内暂无居民预约" />;
  return (
    <div>
      {editable && (
        <div className="flex" style={{ gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <select value={target} onChange={(e) => setTarget(e.target.value)} style={{ width: 200 }}>
            <option value="">系统自动选改约场次</option>
            {state.sessions.filter((s) => s.id !== rental.sessionId).map((s) => <option key={s.id} value={s.id}>改约至 {s.label}</option>)}
          </select>
          <label className="checkbox" style={{ margin: 0 }}><input type="checkbox" checked={voucher} onChange={(e) => setVoucher(e.target.checked)} /> 附补偿券</label>
          <button className="btn sm" disabled={act.isPending}
            onClick={() => act.mutateAsync({ path: `/rentals/${rental.id}/reschedule-open`, body: { offerSessionId: target || undefined, offerVoucher: voucher } }).then(() => notify.ok('已逐人发起改约征询，居民端可见')).catch((e) => notify.err(e))}>
            发起/刷新逐人改约征询
          </button>
          <button className="btn sm ghost" disabled={act.isPending}
            onClick={() => act.mutateAsync({ path: `/rentals/${rental.id}/apply-agreed` }).then(() => notify.ok('同意改约的居民已按方案落单')).catch((e) => notify.err(e))}>
            一键落单「同意改约」
          </button>
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead><tr><th>预约</th><th>居民</th><th>泳区/道</th><th>人群标签</th><th>支付</th><th>居民答复</th><th>处置结果</th>{editable && <th>操作</th>}</tr></thead>
          <tbody>
            {rental.residentConflicts.map((c) => (
              <tr key={c.bookingId}>
                <td className="code-mono">{c.bookingCode}{c.children > 0 && <div className="small muted">含儿童 {c.children}</div>}</td>
                <td className="small">{c.userName}{c.offerSessionId && <div className="small muted">建议→{state.sessions.find((s) => s.id === c.offerSessionId)?.label}</div>}</td>
                <td className="small">{zoneName(state, c.zoneId)}{c.lane ? ` ${c.lane}号道` : ''}</td>
                <td>{c.tags.map((t) => <Badge key={t} tone={TAG_TONE[t]}>{RESIDENT_TAG_LABEL[t]}</Badge>)}</td>
                <td className="small">{c.paidAmount === 0 ? '公益免费' : `¥${c.paidAmount}·${c.paymentMethod === 'wallet' ? '储值' : c.paymentMethod === 'voucher' ? '补偿券' : '现场'}`}</td>
                <td>{c.preference === 'pending' ? <Badge tone="warn">待答复</Badge> : c.preference === 'agree' ? <Badge tone="ok">同意改约</Badge> : <Badge tone="danger">不同意·保留</Badge>}</td>
                <td>{c.resolution ? <Badge tone="info">{resolutionLabel(c.resolution)}</Badge> : <span className="small muted">未处置</span>}{c.migratedBookingId && <div className="small ok">新单 {state.bookings.find((b) => b.id === c.migratedBookingId)?.code}</div>}</td>
                {editable && (
                  <td>
                    {!c.resolution && (
                      <div className="flex" style={{ gap: 4, flexWrap: 'wrap' }}>
                        <button className="btn sm ghost" title="按征询方案改约" onClick={() => resolve(c.bookingId, 'reschedule', c.offerSessionId)}>改约</button>
                        <button className="btn sm ghost" title="保留原预约，压缩包场" onClick={() => resolve(c.bookingId, 'keep')}>保留</button>
                        <button className="btn sm ghost" title="原路退费" onClick={() => resolve(c.bookingId, 'refund')}>退费</button>
                        <button className="btn sm ghost" title="退费+补偿券" onClick={() => resolve(c.bookingId, 'voucher')}>退费+券</button>
                      </div>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function resolutionLabel(r: string) {
  return ({ keep: '保留原预约', reschedule: '已改约', refund: '已退费', voucher: '退费+补偿券', compressed: '范围压缩解消' } as Record<string, string>)[r] ?? r;
}

// ============ 单个包场的运营协调工作台 ============
function RentalDetail({ state, rental, act, notify, onBack }: { state: AppState; rental: InstitutionRental; act: ReturnType<typeof useAction>; notify: ReturnType<typeof useNotify>; onBack: () => void }) {
  const inst = instOf(state, rental);
  const session = state.sessions.find((s) => s.id === rental.sessionId)!;
  const coord = rental.coordination;
  const [zoneId, setZoneId] = useState<ZoneId>(coord?.zoneId ?? rental.requestZoneId);
  const [lanes, setLanes] = useState<number[]>(coord?.lanes ?? rental.requestLanes ?? []);
  const [approvedPartySize, setApprovedPartySize] = useState(coord?.approvedPartySize ?? rental.partySize);
  const [approvedChildren, setApprovedChildren] = useState(coord?.approvedChildren ?? rental.childCount);
  const [extraGuards, setExtraGuards] = useState(coord?.extraGuards ?? Math.max(1, inst?.requiredExtraGuards ?? 0));
  const [shorten, setShorten] = useState(coord?.shorten ?? false);
  const [adjustedStart, setAdjustedStart] = useState(coord?.adjustedStart ?? session.start);
  const [adjustedEnd, setAdjustedEnd] = useState(coord?.adjustedEnd ?? session.end);
  const [suspendNonWelfare, setSuspendNonWelfare] = useState(coord?.suspendNonWelfareLanes ?? false);
  const [provideVoucher, setProvideVoucher] = useState(coord?.provideVoucher ?? true);
  const [deposit, setDeposit] = useState(coord?.requireDeposit ?? inst?.deposit ?? 500);
  const [coordNote, setCoordNote] = useState(coord?.note ?? '');
  const [pay, setPay] = useState<'cash' | 'wallet'>('cash');
  const [vType, setVType] = useState<any>('over_capacity');
  const [vDetail, setVDetail] = useState('');
  const [vSuspend, setVSuspend] = useState(true);
  const [gateNote, setGateNote] = useState('');
  const [clearNote, setClearNote] = useState('');

  const canEdit = ['applied', 'coordinating'].includes(rental.status);
  const needCompanions = requiredCompanions(rental.childCount, rental.ageMin);
  const latestReading = [...state.waterReadings].filter((w) => w.sessionId === rental.sessionId && !w.abnormal)[0];

  const saveCoord = () =>
    act.mutateAsync({ path: `/rentals/${rental.id}/coordination`, body: {
      zoneId, lanes, shorten, adjustedStart: shorten ? adjustedStart : undefined, adjustedEnd: shorten ? adjustedEnd : undefined,
      approvedPartySize, approvedChildren, extraGuards, suspendNonWelfareLanes: suspendNonWelfare,
      suspendedLaneDesc: suspendNonWelfare ? '暂停部分非公益泳道为包场腾挪名额（公益泳道保留）' : undefined,
      provideVoucher, requireDeposit: deposit, note: coordNote,
    } }).then(() => notify.ok('协调措施已保存，冲突居民范围已重算')).catch((e) => notify.err(e));

  const qualState = (k: QualificationKey) => rental.qualifications.find((q) => q.key === k);

  return (
    <div className="grid">
      <Card title={<span>↩ <button className="btn sm ghost" onClick={onBack}>返回列表</button> <b className="code-mono">{rental.code}</b> {instName(state, rental.institutionId)} · {session.label}</span>}
        extra={<Badge tone={RENTAL_STATUS_TONE[rental.status]}>{RENTAL_STATUS_LABEL[rental.status]}</Badge>}>
        <div className="small muted">
          申请：{zoneName(state, rental.requestZoneId)}{rental.requestLanes.length ? ' ' + rental.requestLanes.join('/') + ' 号道' : '整区'} · {rental.partySize} 人（成人 {rental.adultCount} / 儿童 {rental.childCount}，{rental.ageMin}-{rental.ageMax} 岁）· 陪同成人 {rental.companions} 名（至少需 {needCompanions}）· 储物柜 {rental.facility.lockersNeeded} · 独立更衣 {rental.facility.independentChanging ? '是' : '否'} · 用途 {rental.purpose}
        </div>
        {inst && <div className="flex" style={{ marginTop: 6, gap: 8 }}>
          <Badge tone={inst.creditScore >= 60 ? 'ok' : 'danger'}>机构信用 {inst.creditScore}</Badge>
          <Badge tone="gray">押金 ¥{inst.deposit}</Badge>
          {inst.blocked && <Badge tone="danger">已限制包场：{inst.blockReason}</Badge>}
          {inst.requiredExtraGuards > 0 && <Badge tone="warn">强制增派救生 {inst.requiredExtraGuards} 名</Badge>}
        </div>}
      </Card>

      {/* 冲突范围预览 */}
      <Card title="⚖️ 冲突范围（按日期/时段/泳道/泳区/更衣淋浴/储物柜/救生排班/已预约居民）">
        <div className="grid cols-3">
          <div className="stat"><span className="num">{rental.conflictPreview.capacity.overflow}</span><span className="lbl">泳区超员（容量{rental.conflictPreview.capacity.zoneCapacity}：在池{rental.conflictPreview.capacity.inPool}+待入{rental.conflictPreview.capacity.booked}+申请{rental.conflictPreview.capacity.applying}）</span></div>
          <div className={`stat ${rental.conflictPreview.shower.overflow ? 'warn' : ''}`}><span className="num">{rental.conflictPreview.shower.overflow}</span><span className="lbl">更衣淋浴缺口（容量{rental.conflictPreview.shower.capacity}）</span></div>
          <div className={`stat ${rental.conflictPreview.locker.shortfall ? 'warn' : ''}`}><span className="num">{rental.conflictPreview.locker.shortfall}</span><span className="lbl">储物柜缺口（需{rental.conflictPreview.locker.needed}/余{rental.conflictPreview.locker.remaining}）</span></div>
        </div>
        <div className="small" style={{ margin: '8px 0' }}>
          救生排班：{rental.conflictPreview.guards.length ? rental.conflictPreview.guards.map((g) => `${g.postLabel}:${g.guardName}`).join('；') : '暂无在岗，须落实救生配置'}
          {rental.conflictPreview.publicWelfare && <Badge tone="purple">居民公益时段</Badge>}
        </div>
        {rental.conflictPreview.conflicts.length > 0 && (
          <div className="alert danger">{rental.conflictPreview.conflicts.map((m, i) => <div key={i}>· {m}</div>)}</div>
        )}
        <h4>受影响居民（老人晨泳/亲子/公益/教练课/会员储值 已标出）</h4>
        <ResidentRows state={state} rental={rental} act={act} notify={notify} editable={canEdit} />
      </Card>

      {/* 资质核验 */}
      <Card title="🪪 机构资质 / 教练 / 救生 / 保险 / 出入口 / 更衣 核验（含儿童按离陪规则核验陪同，不因包场放宽）">
        {rental.hasChildren && (
          <div className={`alert ${rental.companions >= needCompanions ? 'ok' : 'danger'}`}>
            儿童离陪规则：{rental.childCount} 名儿童（最低 {rental.ageMin} 岁）至少需 <b>{needCompanions}</b> 名成人陪同，登记 {rental.companions} 名。{rental.companions >= needCompanions ? '满足，批准与当天核验仍须逐一核对。' : '不满足，不得批准。'}
          </div>
        )}
        {rental.qualifications.map((q) => (
          <div key={q.key} className="queue-row">
            <div><b>{QUALIFICATION_LABEL[q.key]}</b><div className="small muted">{q.detail || '机构未提交材料'}</div>
              {q.verifiedBy && <div className="small">{q.verifiedBy} · {fmtDateTime(q.verifiedAt)}</div>}</div>
            <div className="flex">
              <Badge tone={q.state === 'verified' ? 'ok' : q.state === 'rejected' ? 'danger' : 'warn'}>{q.state === 'verified' ? '已通过' : q.state === 'rejected' ? '已驳回' : '待核验'}</Badge>
              {canEdit && <>
                <button className="btn sm" disabled={act.isPending || !q.detail} onClick={() => act.mutateAsync({ path: `/rentals/${rental.id}/qualifications`, body: { key: q.key, pass: true } }).then(() => notify.ok('已核验通过')).catch((e) => notify.err(e))}>通过</button>
                <button className="btn sm ghost danger" disabled={act.isPending} onClick={() => act.mutateAsync({ path: `/rentals/${rental.id}/qualifications`, body: { key: q.key, pass: false, note: '材料不符' } }).then(() => notify.ok('已驳回')).catch((e) => notify.err(e))}>驳回</button>
              </>}
            </div>
          </div>
        ))}
        <h4>随队教练（{rental.coachAssignments.length}）</h4>
        <div className="small">{rental.coachAssignments.map((c) => `${c.name}(${c.certNo})`).join('、') || '未登记'}</div>
        <div className="small" style={{ marginTop: 6 }}>保险：{rental.insurancePolicyNo}，有效期至 {rental.insuranceExpiry}</div>
      </Card>

      {/* 协调措施 + 费用 */}
      {(canEdit || coord) && (
        <div className="grid cols-2">
          <Card title="🛠️ 协调措施（拆泳道/缩短/限人数/增派救生/暂停非公益道/补偿券/押金）">
            <div className="form-row">
              <label className="field">批准泳区<select value={zoneId} onChange={(e) => setZoneId(e.target.value as ZoneId)} disabled={!canEdit}>{state.zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}</select></label>
              <label className="field">批准人数<input type="number" value={approvedPartySize} disabled={!canEdit} onChange={(e) => setApprovedPartySize(Number(e.target.value))} /></label>
            </div>
            <div style={{ height: 8 }} />
            <div className="form-row">
              <label className="field">批准儿童<input type="number" value={approvedChildren} disabled={!canEdit} onChange={(e) => setApprovedChildren(Number(e.target.value))} /></label>
              <label className="field">增派救生员<input type="number" value={extraGuards} disabled={!canEdit} onChange={(e) => setExtraGuards(Number(e.target.value))} /></label>
            </div>
            <div style={{ height: 8 }} />
            <label className="field">拆分泳道（不勾=整区；公益时段只可拆非公益道）
              <div className="flex" style={{ gap: 6, marginTop: 4 }}>
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <button key={n} type="button" className={`btn sm ${lanes.includes(n) ? '' : 'ghost'}`} disabled={!canEdit} onClick={() => setLanes((ls) => ls.includes(n) ? ls.filter((x) => x !== n) : [...ls, n].sort())}>{n}</button>
                ))}
              </div>
            </label>
            <div style={{ height: 8 }} />
            <label className="checkbox"><input type="checkbox" checked={shorten} disabled={!canEdit} onChange={(e) => setShorten(e.target.checked)} /> 缩短包场时段</label>
            {shorten && (
              <div className="form-row" style={{ marginTop: 6 }}>
                <label className="field">起<input value={adjustedStart} disabled={!canEdit} onChange={(e) => setAdjustedStart(e.target.value)} /></label>
                <label className="field">止<input value={adjustedEnd} disabled={!canEdit} onChange={(e) => setAdjustedEnd(e.target.value)} /></label>
              </div>
            )}
            <div style={{ height: 6 }} />
            <label className="checkbox"><input type="checkbox" checked={suspendNonWelfare} disabled={!canEdit} onChange={(e) => setSuspendNonWelfare(e.target.checked)} /> 暂停部分非公益泳道腾挪名额（公益泳道不暂停）</label>
            <label className="checkbox"><input type="checkbox" checked={provideVoucher} disabled={!canEdit} onChange={(e) => setProvideVoucher(e.target.checked)} /> 向改约/压缩居民提供补偿券</label>
            <div className="form-row" style={{ marginTop: 6 }}>
              <label className="field">追加押金 ¥<input type="number" value={deposit} disabled={!canEdit} onChange={(e) => setDeposit(Number(e.target.value))} /></label>
            </div>
            <label className="field" style={{ marginTop: 6 }}>协调说明<input value={coordNote} disabled={!canEdit} onChange={(e) => setCoordNote(e.target.value)} /></label>
            {canEdit && <div style={{ marginTop: 10 }}><button className="btn" disabled={act.isPending} onClick={saveCoord}>保存协调措施并重算冲突范围</button></div>}
          </Card>
          <Card title="💰 包场费用拆分（进入机构账单）"><BillPreview state={state} rental={rental} /></Card>
        </div>
      )}

      {/* 批准 / 驳回 */}
      {canEdit && (
        <Card title="✅ 机构确认与批准（平台不能覆盖居民预约）">
          <div className="alert warn">批准前置：资质六项全部通过、保险有效、教练已登记、儿童陪同达标、范围内居民全部完成处置（不同意改约者保留原预约并已压缩包场范围）。</div>
          <div className="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn ghost" disabled={act.isPending || !coord} onClick={() => act.mutateAsync({ path: `/rentals/${rental.id}/institution-confirm` }).then(() => notify.ok('已代机构确认方案与费用')).catch((e) => notify.err(e))}>代机构确认方案</button>
            <select value={pay} onChange={(e) => setPay(e.target.value as any)} style={{ width: 180 }}><option value="cash">对公转账/现场登记</option><option value="wallet">机构账号储值支付</option></select>
            <button className="btn" disabled={act.isPending || !coord} onClick={() => act.mutateAsync({ path: `/rentals/${rental.id}/approve`, body: { paymentMethod: pay } }).then(() => notify.ok('已批准：费用入机构账单，锁区生效')).catch((e) => notify.err(e))}>批准包场</button>
            <button className="btn ghost danger" disabled={act.isPending} onClick={() => act.mutateAsync({ path: `/rentals/${rental.id}/reject`, body: { note: '资质或冲突协调未通过' } }).then(() => notify.ok('已驳回')).catch((e) => notify.err(e))}>驳回</button>
            <span className="small muted">{rental.institutionConfirmed ? '机构已确认方案' : '机构尚未确认'}</span>
          </div>
        </Card>
      )}

      {/* 当天现场协同 */}
      {['approved', 'active', 'suspended', 'ended'].includes(rental.status) && (
        <Card title="🏟️ 包场当天：名单/身份/保险 · 救生站位 · 保洁维修">
          <div className="flex" style={{ gap: 8, marginBottom: 8 }}>
            {rental.status === 'approved' && <button className="btn" disabled={act.isPending} onClick={() => act.mutateAsync({ path: `/rentals/${rental.id}/start` }).then(() => notify.ok('包场开始')).catch((e) => notify.err(e))}>机构到场·开始包场</button>}
            {(rental.status === 'active' || rental.status === 'suspended') && <button className="btn ghost" disabled={act.isPending} onClick={() => act.mutateAsync({ path: `/rentals/${rental.id}/end` }).then(() => notify.ok('包场结束，进入清场门禁')).catch((e) => notify.err(e))}>包场结束·进入清场</button>}
            {rental.status === 'suspended' && <Badge tone="danger">已现场暂停，待整改</Badge>}
          </div>
          <div className="grid cols-3">
            {(Object.keys(RENTAL_GATE_LABEL) as RentalGateKey[]).map((k) => (
              <div key={k} className="queue-row">
                <div><b>{RENTAL_GATE_LABEL[k]}</b><div className="small muted">{rental.gates[k].done ? `${rental.gates[k].by} · ${fmtDateTime(rental.gates[k].at)}${rental.gates[k].note ? ' · ' + rental.gates[k].note : ''}` : '待核验'}</div></div>
                {!rental.gates[k].done && ['approved', 'active', 'suspended'].includes(rental.status) && (
                  <button className="btn sm" disabled={act.isPending} onClick={() => act.mutateAsync({ path: `/rentals/${rental.id}/gates/${k}`, body: { note: gateNote || undefined } }).then(() => notify.ok('已登记')).catch((e) => notify.err(e))}>确认</button>
                )}
                {rental.gates[k].done && <Badge tone="ok">✓</Badge>}
              </div>
            ))}
          </div>
          <input className="field" style={{ marginTop: 6 }} placeholder="核验备注（如实际人数、站位安排、消毒情况）" value={gateNote} onChange={(e) => setGateNote(e.target.value)} />

          <h4>现场违规（超人数/超时/占公益泳道/儿童无人陪同/私自加人 → 可暂停并通知社区运营）</h4>
          <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
            <select value={vType} onChange={(e) => setVType(e.target.value)}>{VIOLATION_TYPES.map((x) => <option key={x.v} value={x.v}>{x.label}</option>)}</select>
            <input style={{ flex: 1, minWidth: 200 }} placeholder="现场情况描述" value={vDetail} onChange={(e) => setVDetail(e.target.value)} />
            <label className="checkbox" style={{ margin: 0 }}><input type="checkbox" checked={vSuspend} onChange={(e) => setVSuspend(e.target.checked)} /> 当场暂停包场</label>
            <button className="btn danger sm" disabled={act.isPending || !vDetail.trim()} onClick={() => act.mutateAsync({ path: `/rentals/${rental.id}/violations`, body: { type: vType, detail: vDetail, suspend: vSuspend } }).then(() => { notify.ok('已登记违规并通知社区运营'); setVDetail(''); }).catch((e) => notify.err(e))}>登记违规</button>
          </div>
          {rental.violations.map((v) => (
            <div key={v.id} className={`notif ${v.suspended && !v.resolved ? 'critical' : 'warning'}`}>
              <div className="flex"><b>{v.title}（扣信用 {v.points}）</b><span className="spacer" />{v.suspended && <Badge tone="danger">暂停</Badge>}{v.resolved ? <Badge tone="ok">已整改</Badge> : <Badge tone="warn">待整改</Badge>}</div>
              <div className="small">{v.detail} · {v.reportedBy} · {fmtDateTime(v.at)}</div>
              {!v.resolved && ['active', 'suspended'].includes(rental.status) && <button className="btn sm" style={{ marginTop: 4 }} disabled={act.isPending} onClick={() => act.mutateAsync({ path: `/rentals/${rental.id}/violations/${v.id}/resolve`, body: { note: '现场整改到位' } }).then(() => notify.ok('整改已确认，信用部分回补')).catch((e) => notify.err(e))}>整改通过</button>}
            </div>
          ))}
        </Card>
      )}

      {/* 清场恢复门禁 */}
      {['ended', 'completed'].includes(rental.status) && (
        <Card title="🧹 清场复测 → 恢复居民预约（五项全完成方可开放；未复测或未清场不得开放下一场）">
          <div className="grid cols-3">
            {(Object.keys(RENTAL_CLEARANCE_LABEL) as RentalClearanceKey[]).map((k) => (
              <div key={k} className="queue-row">
                <div><b>{RENTAL_CLEARANCE_LABEL[k]}</b><div className="small muted">{rental.clearance[k].done ? `${rental.clearance[k].by} · ${fmtDateTime(rental.clearance[k].at)}` : '待确认'}{k === 'water_retest' && !rental.clearance[k].done && <div className="small">最新达标复测：{latestReading ? fmtDateTime(latestReading.at) : '无（请救生/维修先录入达标水质）'}</div>}</div></div>
                {!rental.clearance[k].done && rental.status === 'ended' && (
                  <button className="btn sm" disabled={act.isPending} onClick={() => act.mutateAsync({ path: `/rentals/${rental.id}/clearance/${k}`, body: { note: clearNote || undefined } }).then(() => notify.ok('已确认')).catch((e) => notify.err(e))}>确认</button>
                )}
                {rental.clearance[k].done && <Badge tone="ok">✓</Badge>}
              </div>
            ))}
          </div>
          <input className="field" style={{ marginTop: 6 }} placeholder="清场/复位说明" value={clearNote} onChange={(e) => setClearNote(e.target.value)} />
          {rental.status === 'ended' && <button className="btn" style={{ marginTop: 10 }} disabled={act.isPending} onClick={() => act.mutateAsync({ path: `/rentals/${rental.id}/complete` }).then(() => notify.ok('已恢复居民预约开放，锁区释放')).catch((e) => notify.err(e))}>五项齐备·恢复居民预约</button>}
          {rental.status === 'completed' && <div className="alert ok" style={{ marginTop: 10 }}>✅ {rental.reopenNote}（{rental.reopenedBy} · {fmtDateTime(rental.reopenedAt)}）</div>}
        </Card>
      )}

      {/* 时间线 */}
      <Card title="🕘 场次记录时间线（冲突协调/改约/补偿/机构确认/恢复结果全程留痕，供排期与投诉追溯）">
        {rental.audit.map((a, i) => (
          <div key={i} className="task-row"><span className="nt">{fmtDateTime(a.at)}</span> <b>[{a.by}]</b> {a.event}{a.detail ? <div className="small muted">{a.detail}</div> : null}</div>
        ))}
      </Card>
    </div>
  );
}

// ============ 申请新包场 + 列表 ============
function ApplyForm({ state, act, notify }: { state: AppState; act: ReturnType<typeof useAction>; notify: ReturnType<typeof useNotify> }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    institutionName: '蓝鲸游泳培训', sessionId: state.sessions.find((s) => s.id === 's-pm')?.id ?? state.sessions[0].id,
    zoneId: 'family' as ZoneId, lanes: [] as number[], partySize: 24, adultCount: 6, childCount: 18, ageMin: 7,
    companions: 6, lockersNeeded: 24, showerCapacity: 60, independentChanging: true,
    insurancePolicyNo: 'INS-LJ-2026-090', insuranceExpiry: '2026-12-31', purpose: '少儿游泳集训',
  });
  const [quals, setQuals] = useState<Record<string, string>>({ businessLicense: '办学许可证', coachCert: '社会体育指导员证', guardCert: '救生员证', insurance: '保险单', independentAccess: '东侧独立出入口', changingRoom: '东侧独立更衣淋浴' });
  const [coaches, setCoaches] = useState('马教练:SWIM-0231,林教练:SWIM-0417');
  const [preview, setPreview] = useState<any>(null);
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));

  const body = () => ({
    ...f,
    lanes: f.lanes,
    qualifications: quals,
    coaches: coaches.split(/[，,;；]/).map((s) => { const [name, certNo] = s.split(/[:：]/); return { name: name?.trim(), certNo: (certNo ?? '').trim() }; }).filter((c) => c.name),
  });

  const doPreview = () => act.mutateAsync({ path: '/rentals/preview', body: { sessionId: f.sessionId, zoneId: f.zoneId, lanes: f.lanes, partySize: f.partySize, lockersNeeded: f.lockersNeeded, showerCapacity: f.showerCapacity } })
    .then((r: any) => { setPreview(r); notify.info(`检测到 ${r.conflicts.length} 项冲突`); }).catch((e) => notify.err(e));

  const doApply = () => act.mutateAsync({ path: '/rentals', body: body() })
    .then(() => { notify.ok('包场申请已提交，等待运营核验协调'); setOpen(false); setPreview(null); }).catch((e) => notify.err(e));

  if (!open) return <button className="btn" onClick={() => setOpen(true)}>＋ 登记新的机构包场申请</button>;

  return (
    <Card title="登记机构包场申请（提交即按日期/时段/泳道/泳区/容量/救生排班/已预约居民做冲突检测）">
      <div className="form-row">
        <label className="field">机构名称<input value={f.institutionName} onChange={(e) => set('institutionName', e.target.value)} /></label>
        <label className="field">场次<select value={f.sessionId} onChange={(e) => set('sessionId', e.target.value)}>{state.sessions.map((s) => <option key={s.id} value={s.id}>{s.label}{s.publicWelfare ? '（公益）' : ''}</option>)}</select></label>
      </div>
      <div style={{ height: 8 }} />
      <div className="form-row">
        <label className="field">泳区<select value={f.zoneId} onChange={(e) => set('zoneId', e.target.value as ZoneId)}>{state.zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}</select></label>
        <label className="field">总人数<input type="number" value={f.partySize} onChange={(e) => set('partySize', Number(e.target.value))} /></label>
      </div>
      <div style={{ height: 8 }} />
      <div className="form-row">
        <label className="field">成人<input type="number" value={f.adultCount} onChange={(e) => set('adultCount', Number(e.target.value))} /></label>
        <label className="field">儿童<input type="number" value={f.childCount} onChange={(e) => set('childCount', Number(e.target.value))} /></label>
        <label className="field">最低年龄<input type="number" value={f.ageMin} onChange={(e) => set('ageMin', Number(e.target.value))} /></label>
        <label className="field">陪同成人<input type="number" value={f.companions} onChange={(e) => set('companions', Number(e.target.value))} /></label>
      </div>
      <div className="small muted" style={{ margin: '4px 0' }}>含 {f.childCount} 名儿童（最低 {f.ageMin} 岁）至少需 {requiredCompanions(f.childCount, f.ageMin)} 名成人陪同（教练/救生不计入）。</div>
      <label className="field">拆分泳道（不选=整区）
        <div className="flex" style={{ gap: 6, marginTop: 4 }}>{[1, 2, 3, 4, 5, 6].map((n) => <button key={n} type="button" className={`btn sm ${f.lanes.includes(n) ? '' : 'ghost'}`} onClick={() => set('lanes', f.lanes.includes(n) ? f.lanes.filter((x: number) => x !== n) : [...f.lanes, n].sort())}>{n}</button>)}</div>
      </label>
      <div style={{ height: 8 }} />
      <div className="form-row">
        <label className="field">储物柜数<input type="number" value={f.lockersNeeded} onChange={(e) => set('lockersNeeded', Number(e.target.value))} /></label>
        <label className="field">更衣淋浴容量<input type="number" value={f.showerCapacity} onChange={(e) => set('showerCapacity', Number(e.target.value))} /></label>
        <label className="field">保单号<input value={f.insurancePolicyNo} onChange={(e) => set('insurancePolicyNo', e.target.value)} /></label>
        <label className="field">保险有效期<input type="date" value={f.insuranceExpiry} onChange={(e) => set('insuranceExpiry', e.target.value)} /></label>
      </div>
      <div style={{ height: 8 }} />
      <label className="checkbox"><input type="checkbox" checked={f.independentChanging} onChange={(e) => set('independentChanging', e.target.checked)} /> 使用独立出入口与更衣淋浴</label>
      <div style={{ height: 6 }} />
      <div className="form-row">
        <label className="field">资质材料（逐项，逗号分隔可留空）{Object.keys(QUALIFICATION_LABEL).map((k) => (
          <input key={k} style={{ marginTop: 4 }} placeholder={QUALIFICATION_LABEL[k as QualificationKey]} value={quals[k] ?? ''} onChange={(e) => setQuals((q) => ({ ...q, [k]: e.target.value }))} />
        ))}</label>
        <label className="field">教练（姓名:证号，逗号分隔）<textarea value={coaches} onChange={(e) => setCoaches(e.target.value)} /></label>
      </div>
      <label className="field" style={{ marginTop: 6 }}>用途<input value={f.purpose} onChange={(e) => set('purpose', e.target.value)} /></label>
      {preview && (
        <div className={`alert ${preview.conflicts.length ? 'danger' : 'ok'}`} style={{ marginTop: 8 }}>
          冲突 {preview.conflicts.length} 项 · 涉及居民 {preview.residents.length} 笔 · 泳区超员 {preview.capacity.overflow} · 淋浴缺口 {preview.shower.overflow} · 储物柜缺口 {preview.locker.shortfall}
          {preview.conflicts.map((m: string, i: number) => <div key={i}>· {m}</div>)}
        </div>
      )}
      <div className="flex" style={{ marginTop: 10 }}>
        <button className="btn ghost" disabled={act.isPending} onClick={doPreview}>仅做冲突预览</button>
        <button className="btn" disabled={act.isPending} onClick={doApply}>提交包场申请</button>
        <span className="spacer" /><button className="btn ghost sm" onClick={() => setOpen(false)}>收起</button>
      </div>
    </Card>
  );
}

function InstitutionCredit({ state, act, notify }: { state: AppState; act: ReturnType<typeof useAction>; notify: ReturnType<typeof useNotify> }) {
  return (
    <Card title="🏛️ 机构信用 / 押金 / 限包场">
      {state.institutions.length === 0 ? <Empty text="暂无机构档案" /> : state.institutions.map((inst) => (
        <div key={inst.id} className="notif info">
          <div className="flex"><b>{inst.name}</b><span className="spacer" />
            <Badge tone={inst.creditScore >= 60 ? 'ok' : 'danger'}>信用 {inst.creditScore}</Badge>
            <Badge tone="gray">押金 ¥{inst.deposit}</Badge>
            {inst.blocked ? <Badge tone="danger">已限制</Badge> : <Badge tone="ok">可包场</Badge>}
          </div>
          <div className="small muted" style={{ margin: '4px 0' }}>强制增派救生 {inst.requiredExtraGuards} 名{inst.blockReason ? ` · ${inst.blockReason}` : ''}</div>
          <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
            <button className="btn sm ghost" disabled={act.isPending} onClick={() => act.mutateAsync({ path: `/institutions/${inst.id}/restriction`, body: { blocked: !inst.blocked, blockReason: inst.blocked ? undefined : '频繁违规，限制后续包场', requiredExtraGuards: Math.max(1, inst.requiredExtraGuards) } }).then(() => notify.ok('已更新限制')).catch((e) => notify.err(e))}>{inst.blocked ? '解除限制' : '限制后续包场+要求增派救生'}</button>
            <button className="btn sm ghost" disabled={act.isPending} onClick={() => act.mutateAsync({ path: `/institutions/${inst.id}/restriction`, body: { blocked: inst.blocked, depositDelta: 500 } }).then(() => notify.ok('已要求追加押金 ¥500')).catch((e) => notify.err(e))}>追加押金 ¥500</button>
          </div>
          <details style={{ marginTop: 6 }}><summary className="small">信用记录（{inst.creditEvents.length}）</summary>
            {inst.creditEvents.map((e) => <div key={e.id} className="small">· {fmtDateTime(e.at)} {e.title}（-{e.points}）{e.rectified ? ' ✓已整改' : ''} <span className="muted">{e.detail}</span></div>)}
          </details>
        </div>
      ))}
    </Card>
  );
}

export function RentalOpsTab({ state }: Props) {
  const act = useAction();
  const notify = useNotify();
  const [selected, setSelected] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const rentals = useMemo(() => state.rentals.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [state.rentals]);
  const current = rentals.find((r) => r.id === selected);

  if (current) return <RentalDetail state={state} rental={current} act={act} notify={notify} onBack={() => setSelected(null)} />;

  const visible = rentals.filter((r) => showDone || !['completed', 'rejected', 'cancelled'].includes(r.status));
  return (
    <div className="grid cols-2">
      <div className="grid">
        <ApplyForm state={state} act={act} notify={notify} />
        <Card title="📋 包场协调记录">
          <label className="checkbox"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> 显示已完成/已驳回历史</label>
          <div style={{ height: 8 }} />
          {visible.length === 0 ? <Empty text="暂无包场申请" /> : visible.map((r) => {
            const s = state.sessions.find((x) => x.id === r.sessionId)!;
            const unresolved = r.residentConflicts.filter((c) => !c.resolution).length;
            return (
              <div key={r.id} className="queue-row" role="button" onClick={() => setSelected(r.id)} style={{ cursor: 'pointer' }}>
                <div><b className="code-mono">{r.code}</b> {instName(state, r.institutionId)}
                  <div className="small muted">{s.label} · {zoneName(state, r.requestZoneId)}{r.requestLanes.length ? ' ' + r.requestLanes.join('/') + '道' : '整区'} · {r.partySize}人(童{r.childCount})</div>
                </div>
                <div className="flex">
                  {unresolved > 0 && <Badge tone="danger">{unresolved} 居民待处置</Badge>}
                  {r.violations.some((v) => !v.resolved) && <Badge tone="danger">违规待整改</Badge>}
                  <Badge tone={RENTAL_STATUS_TONE[r.status]}>{RENTAL_STATUS_LABEL[r.status]}</Badge>
                </div>
              </div>
            );
          })}
        </Card>
      </div>
      <div className="grid">
        <InstitutionCredit state={state} act={act} notify={notify} />
        <Card title="🧾 机构账单（费用按泳道/时段/救生加班/储物柜/淋浴区占用拆分）">
          {state.institutionBills.length === 0 ? <Empty text="暂无账单（批准包场后生成）" /> : state.institutionBills.map((b) => (
            <div key={b.id} className="notif info">
              <div className="flex"><b className="code-mono">{b.rentalId}</b><span className="spacer" /><Badge tone="ok">¥{b.total}</Badge></div>
              <div className="small">{b.items.map((i) => `${i.label} ¥${i.amount}`).join('；')}</div>
              <div className="small muted">{b.paymentMethod === 'cash' ? '对公/现场' : '机构储值'} · 押金已扣 ¥{b.depositDeducted}</div>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

// ============ 居民端：改约征询卡 ============
export function ResidentRentalOffers({ user, state }: Props) {
  const act = useAction();
  const notify = useNotify();
  const mine = state.rentals.filter((r) => r.residentConflicts.some((c) => c.userId === user.id && !c.resolution));
  if (!mine.length) return null;
  return (
    <Card title="⚖️ 机构包场改约征询（平台不会替机构覆盖您的预约）">
      {mine.map((r) => {
        const s = state.sessions.find((x) => x.id === r.sessionId)!;
        return r.residentConflicts.filter((c) => c.userId === user.id && !c.resolution).map((c) => (
          <div key={c.bookingId} className="notif warning">
            <div className="flex"><b>预约 {c.bookingCode} · {s.label}</b><span className="spacer" />
              {c.preference === 'pending' ? <Badge tone="warn">待您选择</Badge> : c.preference === 'agree' ? <Badge tone="ok">您已同意改约</Badge> : <Badge tone="danger">您已选择保留原预约</Badge>}
            </div>
            <div className="small" style={{ margin: '4px 0' }}>
              因机构培训包场协调，平台征询您的意见{c.offerSessionId ? <>：可改约至 <b>{state.sessions.find((x) => x.id === c.offerSessionId)?.label}</b></> : ''}
              {c.offerVoucher && '，并发放 1 张补偿券'}。{c.offerNote ? `（${c.offerNote}）` : ''}
              {c.tags.includes('public_welfare') && ' 您的公益时段权益优先，平台不得因包场取消。'}
            </div>
            {c.preference === 'pending' && (
              <div className="flex" style={{ gap: 8 }}>
                <button className="btn sm" disabled={act.isPending} onClick={() => act.mutateAsync({ path: `/rentals/${r.id}/reschedule-response`, body: { agree: true } }).then(() => notify.ok('已同意改约，运营将为您落单')).catch((e) => notify.err(e))}>同意改约</button>
                <button className="btn sm ghost danger" disabled={act.isPending} onClick={() => act.mutateAsync({ path: `/rentals/${r.id}/reschedule-response`, body: { agree: false } }).then(() => notify.ok('已选择保留原预约，平台将压缩包场范围')).catch((e) => notify.err(e))}>不同意·保留原预约</button>
              </div>
            )}
          </div>
        ));
      })}
    </Card>
  );
}

// ============ 现场岗位协同板（前台/救生/保洁/维修） ============
const ROLE_GATES: Record<User['role'], RentalGateKey[]> = {
  frontdesk: ['roster', 'visitorId', 'insurance'],
  lifeguard: ['guardReposition'],
  cleaner: ['cleaning'],
  maintenance: ['maintenance'],
  ops: [], resident: [],
};
const ROLE_CLEAR: Record<User['role'], RentalClearanceKey[]> = {
  frontdesk: ['clear_pool', 'clear_lockers'],
  lifeguard: ['clear_pool', 'water_retest', 'guard_patrol'],
  cleaner: ['clear_lockers'],
  maintenance: ['water_retest', 'equipment_reset'],
  ops: [], resident: [],
};

export function RentalDayBoard({ user, state }: Props) {
  const act = useAction();
  const notify = useNotify();
  const active = state.rentals.filter((r) => ['approved', 'active', 'suspended', 'ended'].includes(r.status));
  if (!active.length) return null;
  const myGates = ROLE_GATES[user.role] ?? [];
  const myClear = ROLE_CLEAR[user.role] ?? [];
  const canViolation = ['frontdesk', 'lifeguard', 'ops'].includes(user.role);
  const [vType, setVType] = useState<any>('over_capacity');
  const [vDetail, setVDetail] = useState('');

  return (
    <div className="grid">
      {active.map((r) => {
        const s = state.sessions.find((x) => x.id === r.sessionId)!;
        const gateTodo = myGates.filter((k) => !r.gates[k].done);
        const clearTodo = myClear.filter((k) => !r.clearance[k].done);
        return (
          <Card key={r.id} title={`🏟️ 机构包场 ${r.code} · ${s.label}（${zoneName(state, r.coordination?.zoneId ?? r.requestZoneId)}）`}
            extra={<Badge tone={RENTAL_STATUS_TONE[r.status]}>{RENTAL_STATUS_LABEL[r.status]}</Badge>}>
            <div className="small muted" style={{ marginBottom: 6 }}>
              批准 {r.coordination?.approvedPartySize ?? r.partySize} 人（儿童 {r.coordination?.approvedChildren ?? r.childCount}）{r.coordination?.extraGuards ? ` · 增派救生 ${r.coordination.extraGuards} 名` : ''} · 保险至 {r.insuranceExpiry || '—'}
            </div>
            {r.hasChildren && <div className="small" style={{ color: 'var(--warn)' }}>含儿童：须核对陪同成人 {r.companions} 名（至少 {requiredCompanions(r.childCount, r.ageMin)}），儿童不得离陪。</div>}

            {['approved', 'active', 'suspended'].includes(r.status) && gateTodo.length > 0 && (
              <div className="flex" style={{ gap: 6, flexWrap: 'wrap', margin: '6px 0' }}>
                {gateTodo.map((k) => (
                  <button key={k} className="btn sm" disabled={act.isPending}
                    onClick={() => act.mutateAsync({ path: `/rentals/${r.id}/gates/${k}` }).then(() => notify.ok(`${RENTAL_GATE_LABEL[k]} 已确认`)).catch((e) => notify.err(e))}>
                    确认：{RENTAL_GATE_LABEL[k]}
                  </button>
                ))}
              </div>
            )}
            {r.status === 'ended' && clearTodo.length > 0 && (
              <div className="alert warn" style={{ margin: '6px 0' }}>
                包场已结束，未清场/复测不得开放下一场。请完成本岗确认：
                <div className="flex" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                  {clearTodo.map((k) => (
                    <button key={k} className="btn sm" disabled={act.isPending || (k === 'water_retest' && !state.waterReadings.some((w) => w.sessionId === r.sessionId && !w.abnormal))}
                      title={k === 'water_retest' && !state.waterReadings.some((w) => w.sessionId === r.sessionId && !w.abnormal) ? '请先在水质页录入一次达标复测' : ''}
                      onClick={() => act.mutateAsync({ path: `/rentals/${r.id}/clearance/${k}` }).then(() => notify.ok(`${RENTAL_CLEARANCE_LABEL[k]} 已确认`)).catch((e) => notify.err(e))}>
                      确认：{RENTAL_CLEARANCE_LABEL[k]}{k === 'water_retest' && !state.waterReadings.some((w) => w.sessionId === r.sessionId && !w.abnormal) ? '（需先达标复测）' : ''}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {r.status === 'suspended' && <div className="alert danger">⛔ 本场已被现场暂停，等待机构整改与运营确认。</div>}
            {r.violations.filter((v) => !v.resolved).length > 0 && <div className="small" style={{ color: 'var(--danger)' }}>未整改违规：{r.violations.filter((v) => !v.resolved).map((v) => v.title).join('、')}</div>}

            {canViolation && ['active', 'suspended'].includes(r.status) && (
              <div className="flex" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                <select value={vType} onChange={(e) => setVType(e.target.value)} style={{ width: 130 }}>{VIOLATION_TYPES.map((x) => <option key={x.v} value={x.v}>{x.label}</option>)}</select>
                <input style={{ flex: 1, minWidth: 160 }} placeholder="现场异常（超人数/超时/占公益道/儿童离陪/私自加人）" value={vDetail} onChange={(e) => setVDetail(e.target.value)} />
                <button className="btn sm danger" disabled={act.isPending || !vDetail.trim()}
                  onClick={() => act.mutateAsync({ path: `/rentals/${r.id}/violations`, body: { type: vType, detail: vDetail, suspend: true } }).then(() => { notify.ok('已暂停包场并通知社区运营'); setVDetail(''); }).catch((e) => notify.err(e))}>
                  暂停包场并上报
                </button>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
