import type {
  RentalCase, RentalCaseStatus, ResidentConflict, ResidentConflictKind,
  RentalDayChecklist, RentalCloseoutChecklist, OrgBillItem, OrgCreditProfile,
} from '../../shared/types.js';
import { Badge } from '../ui.js';

export const RENTAL_STATUS_LABEL: Record<RentalCaseStatus, string> = {
  pending: '待资质核验',
  verifying: '材料整改中',
  coordinating: '居民改约协调中',
  approved: '已确认·待当天核验',
  active: '包场进行中',
  suspended: '已现场暂停',
  completed: '已清场恢复',
  rejected: '已驳回',
  cancelled: '已取消',
};

export const RENTAL_STATUS_BADGE: Record<RentalCaseStatus, string> = {
  pending: 'warn', verifying: 'warn', coordinating: 'danger', approved: 'info',
  active: 'ok', suspended: 'danger', completed: 'ok', rejected: 'gray', cancelled: 'gray',
};

export const CONFLICT_TAG_LABEL: Record<ResidentConflictKind, string> = {
  elder_morning: '老人晨泳',
  parent_child: '亲子时段',
  public_welfare: '居民公益',
  coaching: '教练课',
  stored_member: '会员储值',
  normal: '普通居民',
};

export const REBOOK_STATUS_LABEL = {
  identified: '待协商',
  proposed: '已提议·待居民答复',
  accepted: '居民已同意改约',
  rejected: '居民拒绝·保留原预约',
  expired: '超时未答·保留原预约',
} as const;

export function zoneNameOf(state: { zones: { id: string; name: string }[] }, id: string) {
  return state.zones.find((z) => z.id === id)?.name ?? id;
}

export function sessionLabelOf(state: { sessions: { id: string; label: string }[] }, id?: string) {
  return state.sessions.find((s) => s.id === id)?.label ?? id ?? '';
}

export function RentalStatusBadge({ status }: { status: RentalCaseStatus }) {
  return <Badge tone={RENTAL_STATUS_BADGE[status]}>{RENTAL_STATUS_LABEL[status]}</Badge>;
}

export function ConflictTags({ tags }: { tags: ResidentConflictKind[] }) {
  return (
    <span className="flex" style={{ gap: 4, flexWrap: 'wrap' }}>
      {tags.map((t) => (
        <span key={t} className={`badge ${t === 'elder_morning' || t === 'public_welfare' ? 'purple' : t === 'stored_member' ? 'ok' : 'info'}`}>
          {CONFLICT_TAG_LABEL[t]}
        </span>
      ))}
    </span>
  );
}

export function ResidentConflictRow({ c, state }: { c: ResidentConflict; state: { zones: { id: string; name: string }[]; sessions: { id: string; label: string }[]; bookings: { id: string; code: string }[] } }) {
  return (
    <div className="queue-row" style={{ alignItems: 'flex-start' }}>
      <div>
        <div className="flex">
          <b className="code-mono">{c.bookingCode}</b>
          <ConflictTags tags={c.tags} />
          {c.childCount > 0 && <Badge tone="purple">带儿童 ×{c.childCount}</Badge>}
        </div>
        <div className="small muted">
          {zoneNameOf(state, c.zoneId)}{c.lane ? ` ${c.lane}号道` : ''} · {c.partySize} 人
          {c.offerSessionId || c.offerZoneId ? ` → 建议：${c.offerSessionId && c.offerSessionId !== c.zoneId ? sessionLabelOf(state, c.offerSessionId) + ' ' : ''}${c.offerZoneId ? zoneNameOf(state, c.offerZoneId) : ''}${c.offerLane ? ` ${c.offerLane}号道` : ''}` : ''}
        </div>
        {c.status === 'accepted' && (
          <div className="small" style={{ color: 'var(--ok)' }}>
            已改约为 {state.bookings.find((b) => b.id === c.newBookingId)?.code ?? '新预约'} · 补偿券 {c.compVouchers} 张{c.refundAmount ? ` · 退费 ¥${c.refundAmount}` : ''} 已到账居民端
          </div>
        )}
        {(c.status === 'rejected' || c.status === 'expired') && (
          <div className="small" style={{ color: 'var(--danger)' }}>{REBOOK_STATUS_LABEL[c.status]}，包场范围已压缩</div>
        )}
        {c.note && <div className="small muted">{c.note}</div>}
      </div>
      <Badge tone={c.status === 'accepted' ? 'ok' : c.status === 'rejected' || c.status === 'expired' ? 'danger' : c.status === 'proposed' ? 'warn' : 'gray'}>
        {REBOOK_STATUS_LABEL[c.status]}
      </Badge>
    </div>
  );
}

export function FeeBreakdown({ fee }: { fee: RentalCase['fee'] }) {
  const rows: [string, number, string][] = [
    ['泳道占用费', fee.laneFee, '按泳道×时长'],
    ['时段费', fee.periodFee, '公益/高峰时段'],
    ['救生员加班费', fee.lifeguardOvertimeFee, '增派救生×工时'],
    ['储物柜占用费', fee.lockerFee, '储物柜数量'],
    ['淋浴区占用费', fee.showerFee, '淋浴位数量'],
    ['押金', fee.deposit, '信用异常时上浮，结算抵扣/退回'],
  ];
  return (
    <div className="table-wrap"><table>
      <thead><tr><th>费用项</th><th>金额</th><th>口径</th></tr></thead>
      <tbody>
        {rows.map(([label, amount, note]) => (
          <tr key={label}><td>{label}</td><td className="code-mono">¥{amount}</td><td className="small muted">{note}</td></tr>
        ))}
        <tr><td><b>合计（进入机构账单）</b></td><td className="code-mono"><b>¥{fee.total}</b></td><td></td></tr>
      </tbody>
    </table></div>
  );
}

const DAY_ITEMS: { key: keyof RentalDayChecklist; label: string; role: string }[] = [
  { key: 'rosterMatched', label: '前台核验机构名单', role: '前台' },
  { key: 'visitorIdChecked', label: '访客身份逐人核验', role: '前台' },
  { key: 'insuranceChecked', label: '保险现场复核', role: '前台' },
  { key: 'guardRepositioned', label: '救生员按人数重新站位', role: '救生' },
  { key: 'cleaningReady', label: '保洁确认地面/淋浴/储物柜/消毒', role: '保洁' },
  { key: 'maintenanceReady', label: '维修确认设施与消毒安排', role: '维修' },
];

export function DayChecklistView({ checklist }: { checklist?: RentalDayChecklist }) {
  if (!checklist) return <div className="small muted">尚未开始当天核验</div>;
  const at = (v?: string) => v ? new Date(v).toTimeString().slice(0, 5) : '';
  return (
    <div>
      {DAY_ITEMS.map(({ key, label, role }) => {
        const done = (checklist as any)[key] as boolean;
        const by = (checklist as any)[`${key}By`] as string | undefined;
        return (
          <div key={key} className={`task-row ${done ? 'done' : ''}`}>
            <div className="content">{label}<span className="small muted">（{role}）{by ? ` · ${by} ${at((checklist as any)[`${key}At`])}` : ''}</span></div>
            {done ? <Badge tone="ok">已确认</Badge> : <Badge tone="danger">待确认</Badge>}
          </div>
        );
      })}
    </div>
  );
}

const CLOSE_ITEMS: { key: keyof RentalCloseoutChecklist; label: string; role: string }[] = [
  { key: 'cleared', label: '先清场（机构人员全部离场）', role: '保洁/运营' },
  { key: 'lockersCleared', label: '清储物柜（无遗留）', role: '保洁/前台' },
  { key: 'waterRetested', label: '水质复测达标', role: '维修/救生' },
  { key: 'equipmentReset', label: '设备复位', role: '维修' },
  { key: 'guardPatrolConfirmed', label: '救生巡查确认', role: '救生' },
];

export function CloseoutView({ closeout }: { closeout?: RentalCloseoutChecklist }) {
  if (!closeout) return <div className="small muted">包场结束后进行清场恢复确认（未复测或未清场不得开放下一场）</div>;
  return (
    <div>
      {CLOSE_ITEMS.map(({ key, label, role }) => {
        const done = (closeout as any)[key] as boolean;
        const by = (closeout as any)[`${key}By`] as string | undefined;
        return (
          <div key={key} className={`task-row ${done ? 'done' : ''}`}>
            <div className="content">{label}<span className="small muted">（{role}）{by ? ` · ${by}` : ''}</span></div>
            {done ? <Badge tone="ok">已完成</Badge> : <Badge tone="danger">未完成</Badge>}
          </div>
        );
      })}
      {closeout.reopenedAt && <div className="alert ok" style={{ marginTop: 8 }}>✅ {closeout.reopenedBy} 已确认恢复居民预约，居民端已同步通知</div>}
    </div>
  );
}

export function BillCard({ bill }: { bill: OrgBillItem }) {
  return (
    <div className="notif info">
      <div className="flex"><b>{bill.rentalCode} · {bill.sessionLabel}</b><span className="spacer" />
        <Badge tone={bill.status === 'settled' ? 'ok' : bill.status === 'deducted' ? 'warn' : 'danger'}>
          {bill.status === 'settled' ? '已结清' : bill.status === 'deducted' ? '押金抵扣结清' : '待结算'}
        </Badge>
      </div>
      <FeeBreakdown fee={bill.breakdown} />
      <div className="small muted">已收押金 ¥{bill.depositHeld} · 已入账 ¥{bill.paidAmount}{bill.note ? ` · ${bill.note}` : ''}</div>
    </div>
  );
}

export function CreditProfileCard({ p }: { p: OrgCreditProfile }) {
  const tone = p.score >= 90 ? 'ok' : p.score >= 80 ? 'warn' : 'danger';
  return (
    <div className="notif info">
      <div className="flex"><b>{p.orgName}</b><span className="spacer" />
        <Badge tone={tone}>信用分 {p.score}</Badge>
        {p.rentalRestricted && <Badge tone="danger">已限制包场</Badge>}
      </div>
      <div className="small" style={{ marginTop: 4 }}>
        违规 {p.violationCount} 次（超时 {p.overtimeCount} · 超人数 {p.overCapacityCount}）· 投诉 {p.complaintCount}
        {p.requiredExtraLifeguards > 0 && ` · 后续强制增派救生 ${p.requiredExtraLifeguards} 名`}
        {p.depositMultiplier > 1 && ` · 押金 ×${p.depositMultiplier}`}
      </div>
      {p.restrictionNote && <div className="small muted">限制说明：{p.restrictionNote}</div>}
    </div>
  );
}

/** 冲突范围摘要（申请预览/申请结果共用） */
export function ScopeSummary({ scope, state }: { scope: any; state: { zones: { id: string; name: string }[] } }) {
  return (
    <div>
      <div className="grid cols-3" style={{ margin: '8px 0' }}>
        <div className="zone-card"><div className="stat"><span className="num">{scope.requiredLifeguards}</span><span className="lbl">需救生员（已排 {scope.scheduledLifeguards}，缺口 {scope.lifeguardShortage}）</span></div></div>
        <div className={`zone-card ${scope.showerConflict ? 'risk-high' : ''}`}><div className="stat"><span className="num">{scope.showerRequested}</span><span className="lbl">淋浴位需求（总 {scope.showerTotal}，居民约用 {scope.showerResidentUse}）</span></div></div>
        <div className={`zone-card ${scope.lockerConflict ? 'risk-high' : ''}`}><div className="stat"><span className="num">{scope.lockerRequested}</span><span className="lbl">储物柜需求（总 {scope.lockerTotal}，居民用 {scope.lockerResidentUse}）</span></div></div>
      </div>
      {scope.publicWelfare && <div className="alert danger">⛔ 撞上居民公益时段：商业包场须先保障公益名额，平台不能覆盖居民预约。</div>}
      <div className="small muted">
        {state.zones.find((z) => z.id === scope.zoneId)?.name} 容量 {scope.zoneCapacity}：在池 {scope.zoneInPool} · 待入 {scope.zoneBooked} · 已锁 {scope.zoneLocked} · 本次申请 {''}
        {scope.overCapacity && <b style={{ color: 'var(--danger)' }}> · 超出容量</b>}
      </div>
      {scope.residents.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <b className="small">已预约居民（{scope.residents.length} 笔，须逐人协商，标出特殊人群）：</b>
          {scope.residents.map((r: any) => (
            <div key={r.bookingId} className="queue-row">
              <div><b className="code-mono small">{r.bookingCode}</b> {r.userName ? <span className="small muted">{r.userName}</span> : null}
                <div className="small"><ConflictTags tags={r.tags} /> {r.elder && <span className="badge purple">老人</span>} {r.childCount > 0 && <span className="badge purple">儿童×{r.childCount}</span>}</div>
              </div>
              <span className="small muted">{r.partySize} 人</span>
            </div>
          ))}
        </div>
      )}
      {scope.messages.length > 0 && (
        <div className="alert warn" style={{ marginTop: 8 }}>
          {scope.messages.map((m: string, i: number) => <div key={i}>· {m}</div>)}
        </div>
      )}
    </div>
  );
}
