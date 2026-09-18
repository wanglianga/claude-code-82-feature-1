import { useMemo, useState } from 'react';
import type {
  User, Session, IncidentType, LockReason, ZoneId, TaskKind,
} from '../../shared/types.js';
import type { AppState } from '../api.js';
import { useAction } from '../api.js';
import {
  Badge, Card, Empty, KIND_LABEL, TIER_LABEL, BOOKING_STATUS_LABEL, BOOKING_STATUS_BADGE,
  POOL_STATUS_LABEL, POOL_STATUS_BADGE, INCIDENT_TYPE_LABEL, ISSUE_TYPE_LABEL,
  TASK_STATUS_LABEL, fmtDateTime, useNotify,
} from '../ui.js';
import { SessionPicker, LifecycleSteps, PoolStatusBanner, Stat } from '../components/common.js';
import { IncidentList, IncidentCreateForm } from '../components/incident.js';
import { RescueCard, TrainingRow, rescueStatus, zoneLabel } from '../components/cramp.js';
import { RentalOpsTab } from '../components/rental.js';
import {
  CRAMP_PART_LABEL, RESCUE_METHOD_LABEL, RESCUE_CLOSURE_LABEL,
} from '../../shared/types.js';

type Props = { user: User; state: AppState; tab: string };

const userName = (state: AppState, id: string) => state.users.find((u) => u.id === id);

// ============ 场次指挥台 ============
function stageOf(s: Session): 'booking' | 'live' | 'cleared' | 'closed' {
  if (s.poolStatus === 'closed') return 'closed';
  const hm = new Date().toTimeString().slice(0, 5);
  if (hm < s.start) return 'booking';
  if (hm > s.end) return 'cleared';
  return 'live';
}

type TL = { at: string; title: string; tone?: '' | 'danger' | 'ok'; who: string };

function buildTimeline(state: AppState, sessionId: string): TL[] {
  const tl: TL[] = [];
  const s = state.sessions.find((x) => x.id === sessionId)!;
  for (const b of state.bookings.filter((b) => b.sessionId === sessionId)) {
    tl.push({ at: b.createdAt, title: `预约 ${b.code} · ${KIND_LABEL[b.kind]}（${userName(state, b.userId)?.name}）→ ${state.zones.find((z) => z.id === b.zoneId)?.name}`, who: '居民端' });
    if (b.checkedInAt) tl.push({ at: b.checkedInAt, title: `${b.code} 核验入场${b.lockerNo ? `，储物柜 ${b.lockerNo}` : ''}`, tone: 'ok', who: b.checkedInBy ?? '前台' });
    if (b.status === 'refunded' || b.status === 'compensated') tl.push({ at: b.checkedInAt ?? b.createdAt, title: `${b.code} 闭池联动${b.status === 'compensated' ? '退费+补偿券' : '退费'}`, tone: 'danger', who: '系统联动' });
    if (b.status === 'cancelled') tl.push({ at: b.createdAt, title: `${b.code} 取消`, who: '居民端' });
  }
  for (const w of state.waterReadings.filter((w) => w.sessionId === sessionId))
    tl.push({ at: w.at, title: `水质检测：${w.abnormal ? w.abnormalFields.join('；') : '达标'}（水温 ${w.tempC} / 余氯 ${w.freeChlorine} / 浊度 ${w.turbidity} / pH ${w.ph}）`, tone: w.abnormal ? 'danger' : 'ok', who: w.recorder });
  for (const p of state.patrolIssues.filter((p) => p.sessionId === sessionId))
    tl.push({ at: p.at, title: `巡查：${ISSUE_TYPE_LABEL[p.type]} @ ${p.location} — ${p.description}`, tone: p.severity === 'critical' ? 'danger' : '', who: `${p.reporter}→${p.assigneeName ?? ''}` });
  for (const i of state.incidents.filter((i) => i.sessionId === sessionId)) {
    tl.push({ at: i.reportedAt, title: `事件立案 #${i.code} ${INCIDENT_TYPE_LABEL[i.type]}：${i.title}`, tone: 'danger', who: i.reporter });
    if (i.resolvedAt) tl.push({ at: i.resolvedAt, title: `事件 #${i.code} 关闭`, tone: 'ok', who: '运营' });
  }
  for (const d of state.guardDuties.filter((d) => d.sessionId === sessionId)) {
    tl.push({ at: d.start, title: `救生员上哨：${userName(state, d.guardUserId)?.name} @ ${d.post}`, who: '救生端' });
    if (d.end) tl.push({ at: d.end, title: `救生员下哨/换岗${d.relief ? `：接班人 ${d.relief}` : ''}${d.note ? `（${d.note}）` : ''}`, tone: 'ok', who: '救生端' });
  }
  for (const r of state.crampRescues.filter((x) => x.sessionId === sessionId)) {
    tl.push({
      at: r.foundAt, tone: 'danger', who: r.guardName,
      title: `抽筋救援 ${r.code}：${zoneLabel(state, r.zoneId)} ${r.lane} 号道 ${CRAMP_PART_LABEL[r.crampPart]}（${RESCUE_METHOD_LABEL[r.method]}）${r.familyContacted ? '·家属已联系' : ''}${r.medicalAdvised ? '·建议就医' : ''}`,
    });
    (['guard_relief', 'lane_reopen', 'order_restored'] as const).forEach((k) => {
      const c = r.closure[k];
      if (c.done) tl.push({ at: c.at!, title: `救援 ${r.code}：${RESCUE_CLOSURE_LABEL[k]}`, tone: 'ok', who: c.by ?? '' });
    });
    r.adjustments.forEach((a) => tl.push({ at: a.at, title: `救援 ${r.code} 站位调整：${a.content}`, who: a.by }));
    if (r.reviewedAt) tl.push({ at: r.reviewedAt, title: `救援 ${r.code} 本场复盘完成 → 培训${r.intoSchedule ? '与排班' : ''}已生成`, tone: 'ok', who: r.reviewedBy ?? '运营' });
  }
  for (const t of state.workTasks.filter((t) => t.sessionId === sessionId && t.doneAt))
    tl.push({ at: t.doneAt!, title: `工单完成：${t.title} — ${t.result}`, tone: 'ok', who: t.assigneeName ?? '' });
  // 每一轮闭池都来自不可变档案：原因、退费补偿、清场、复测、通知结果各自固化，互不覆盖
  const closureRecords = state.closureRecords
    .filter((r) => r.sessionId === sessionId)
    .sort((a, b) => a.seq - b.seq);
  for (const r of closureRecords) {
    tl.push({
      at: r.closedAt,
      title: `第${zh(r.seq)}轮闭池：${r.reason}（储值退 ${r.walletRefundCount} 笔/¥${r.walletRefundTotal}、原券返还 ${r.originalVoucherReturnCount} 张、现场退款登记 ${r.cashRefundCount} 笔/¥${r.cashRefundTotal}、额外补偿券 ${r.extraVoucherCount} 张、撤哨 ${r.guardReliefCount} 人、通知 ${r.announcementIds.length} 条、档案 ${r.id}）`,
      tone: 'danger', who: `${r.closedBy}·闭池档案`,
    });
    if (r.status === 'reopened' && r.reopenedAt) {
      tl.push({
        at: r.reopenedAt,
        title: `第${zh(r.seq)}轮闭池结束，恢复开放${r.retestReadingId ? '（依据达标复测 ' + r.retestReadingId + '）' : ''}`,
        tone: 'ok', who: `${r.reopenedBy ?? '运营'}·闭池档案`,
      });
    }
  }
  return tl.sort((a, b) => b.at.localeCompare(a.at));
}

function zh(n: number) {
  return ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][n] ?? String(n);
}

function dispositionLabel(d: string) {
  return d === 'partial' ? '部分开放' : d === 'postponed' ? '延期' : '闭池';
}

/** 按原支付渠道描述退款/返还结果（财务结算与居民通知口径一致） */
function refundResultText(a: import('../../shared/types.js').ClosureAffectedItem) {
  if (!a.refunded || !a.refund) return '未退款';
  const r = a.refund;
  if (r.channel === 'wallet') return `已退储值 ¥${r.amount}`;
  if (r.channel === 'voucher') return `原补偿券已返还 ${r.returnedCount} 张（无金额流水）`;
  return r.amount > 0 ? `现场退款登记 ¥${r.amount}` : (r.note || '公益免费无需退款');
}

function Command({ state }: Props) {
  const [sessionId, setSessionId] = useState(state.boards[1]?.session.id ?? state.boards[0].session.id);
  const session = state.sessions.find((s) => s.id === sessionId)!;
  const board = state.boards.find((b) => b.session.id === sessionId)!;
  const bookings = state.bookings.filter((b) => b.sessionId === sessionId);
  const issues = state.patrolIssues.filter((p) => p.sessionId === sessionId);
  const duties = state.guardDuties.filter((d) => d.sessionId === sessionId);
  const tasks = state.workTasks.filter((t) => t.sessionId === sessionId);
  const incs = state.incidents.filter((i) => i.sessionId === sessionId);
  const timeline = useMemo(() => buildTimeline(state, sessionId), [state, sessionId]);
  const stage = stageOf(session);

  return (
    <div>
      <SessionPicker sessions={state.sessions} value={sessionId} onChange={setSessionId} />
      <LifecycleSteps session={session} stage={stage} />
      <PoolStatusBanner status={session.poolStatus} reason={session.statusReason} requireRetest={session.requireWaterRetest} closedAt={session.closedAt} reopenedAt={session.reopenedAt} />

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <Card><Stat num={bookings.filter((b) => b.status === 'booked').length} label="待入场预约" /></Card>
        <Card><Stat num={board.totalInPool} label="当前在池人数" tone="accent" /></Card>
        <Card><Stat num={issues.filter((p) => p.status !== 'resolved').length} label="未结巡查问题" tone={issues.some((p) => p.status !== 'resolved') ? 'warn' : ''} /></Card>
        <Card><Stat num={incs.filter((i) => i.status !== 'resolved').length} label="处置中事件" tone={incs.some((i) => i.status !== 'resolved') ? 'danger' : ''} /></Card>
      </div>

      <div className="grid cols-2">
        <Card title="泳区占用（含商业锁定）">
          {board.zones.map((z) => (
            <div key={z.zoneId} className={`zone-card ${z.zoneId === 'deep' ? 'risk-high' : ''}`} style={{ marginBottom: 10 }}>
              <div className="zone-head">
                <b>{z.name}</b>
                <span className="small muted">在池 {z.inPool} · 待入 {z.booked} · 锁 {z.locked} / 容量 {z.capacity}</span>
              </div>
              <div className="meter"><i className={z.occupancyPct > 85 ? 'hot' : ''} style={{ width: `${Math.min(100, z.occupancyPct)}%` }} /></div>
              <div className="small muted">儿童 {z.children} · 深水证持有者 {z.deepCertHoldersInPool} · 占用率 {z.occupancyPct}%</div>
            </div>
          ))}
          {session.locks.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <h4>本场锁定（商业/教学）</h4>
              {session.locks.map((l) => (
                <div key={l.id} className="queue-row">
                  <div><b>{l.title}</b><div className="small muted">{state.zones.find((z) => z.id === l.zoneId)?.name}{l.lane ? ` ${l.lane}号道` : '整区'} · {l.capacity}人 · {l.contactName} {l.contactPhone}</div></div>
                  <Badge tone={l.isCommercial ? 'danger' : 'purple'}>{l.isCommercial ? '商业' : '教学/公益'}</Badge>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="本场完整时间线（预约→入场→巡查→清场）">
          {timeline.length === 0 ? <Empty text="暂无动态" /> : (
            <ul className="timeline">
              {timeline.map((t, i) => (
                <li key={i} className={t.tone === 'danger' ? 'danger' : t.tone === 'ok' ? 'ok' : ''}>
                  <div>{t.title}</div>
                  <div className="at">{fmtDateTime(t.at)} · {t.who}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid cols-2 section-gap">
        <Card title={`预约与入场明细（${bookings.length}）`}>
          {bookings.length === 0 ? <Empty text="暂无预约" /> : (
            <div className="table-wrap"><table>
              <thead><tr><th>码</th><th>泳客</th><th>类型</th><th>泳区</th><th>人数</th><th>状态</th><th>柜</th></tr></thead>
              <tbody>{bookings.map((b) => (
                <tr key={b.id}>
                  <td className="code-mono">{b.code}</td>
                  <td className="small">{userName(state, b.userId)?.name}<div className="muted">{TIER_LABEL[userName(state, b.userId)?.memberTier ?? 'normal']}</div></td>
                  <td className="small">{KIND_LABEL[b.kind]}</td>
                  <td className="small">{state.zones.find((z) => z.id === b.zoneId)?.name}{b.lane ? ` ${b.lane}号道` : ''}</td>
                  <td>{b.partySize}{b.childrenInParty ? `（童${b.childrenInParty}）` : ''}</td>
                  <td><Badge tone={BOOKING_STATUS_BADGE[b.status]}>{BOOKING_STATUS_LABEL[b.status]}</Badge></td>
                  <td>{b.lockerNo ?? '—'}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
        <div className="grid">
          <Card title="救生站位">
            {duties.length === 0 ? <Empty text="暂无站位" /> : duties.map((d) => (
              <div key={d.id} className="queue-row">
                <div className="small">{userName(state, d.guardUserId)?.name} · {d.post} · {fmtDateTime(d.start)}{d.end ? ` 下哨${d.relief ? ` →${d.relief}` : ''}` : ' 在岗'}</div>
                {d.end ? <Badge tone="gray">已结束</Badge> : <Badge tone="ok">在岗</Badge>}
              </div>
            ))}
          </Card>
          <Card title="工单与巡查">
            {[...tasks, ...issues.map((p) => ({ kind: 'patrol' as const, title: `巡查：${ISSUE_TYPE_LABEL[p.type]}`, status: p.status === 'resolved' ? 'done' as const : 'pending' as const, detail: p.description, id: p.id }))].length === 0 ? <Empty text="暂无" /> : (
              <>
                {tasks.map((t) => (
                  <div key={t.id} className="queue-row">
                    <div className="small">[{t.kind === 'disinfection' ? '消毒' : t.kind === 'maintenance' ? '维修' : '保洁'}] {t.title}</div>
                    <Badge tone={t.status === 'done' ? 'ok' : t.status === 'in_progress' ? 'warn' : 'danger'}>{TASK_STATUS_LABEL[t.status]}</Badge>
                  </div>
                ))}
                {issues.map((p) => (
                  <div key={p.id} className="queue-row">
                    <div className="small">[巡查] {ISSUE_TYPE_LABEL[p.type]} @{p.location}</div>
                    <Badge tone={p.status === 'resolved' ? 'ok' : p.status === 'handling' ? 'warn' : 'danger'}>{p.status === 'resolved' ? '已处理' : p.status === 'handling' ? '处理中' : '待处理'}</Badge>
                  </div>
                ))}
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
// ============ 闭池 / 恢复 ============
const CAUSES: { v: IncidentType | 'other'; label: string }[] = [
  { v: 'water_abnormal', label: '水质异常' }, { v: 'thunderstorm', label: '雷雨临近' },
  { v: 'equipment_fault', label: '设备故障' }, { v: 'medical', label: '突发医疗事件' }, { v: 'other', label: '其他原因' },
];

function CloseReopen({ state, user }: Props) {
  const act = useAction();
  const notify = useNotify();
  const [sessionId, setSessionId] = useState(state.boards[1]?.session.id ?? state.boards[0].session.id);
  const [reason, setReason] = useState('余氯不足/浊度超标，部分泳区暂停开放');
  const [cause, setCause] = useState<IncidentType | 'other'>('water_abnormal');
  const [refund, setRefund] = useState(true);
  const [voucher, setVoucher] = useState(true);
  const [push, setPush] = useState(true);
  const [retest, setRetest] = useState(true);
  const [disposition, setDisposition] = useState<'closed' | 'partial' | 'postponed'>('partial');
  const [zonePicks, setZonePicks] = useState<Record<string, boolean>>({ training: true });
  const [postponeTo, setPostponeTo] = useState('');
  const [retestInMin, setRetestInMin] = useState(60);

  const session = state.sessions.find((s) => s.id === sessionId)!;
  const affected = state.bookings.filter((b) => b.sessionId === sessionId && (b.status === 'booked' || b.status === 'checked_in'));
  const estWallet = affected.filter((b) => b.paymentMethod === 'wallet').reduce((s, b) => s + b.paidAmount, 0);
  const estVoucher = affected.filter((b) => b.paymentMethod === 'voucher').length;
  const estCash = affected.filter((b) => b.paymentMethod === 'cash').reduce((s, b) => s + b.paidAmount, 0);

  // 受影响泳区集合（闭池/延期=全部；部分开放=勾选）
  const allZoneIds = state.zones.map((z) => z.id);
  const chosenZoneIds = disposition === 'partial' ? allZoneIds.filter((id) => zonePicks[id]) : allZoneIds;
  const affectedByZone = (b: typeof affected[number]) => chosenZoneIds.includes(b.zoneId);
  // 三类人群（仅受影响泳区）
  const inAffected = affected.filter(affectedByZone);
  const lessonsIn = state.lessons.filter((l) => l.sessionId === sessionId && chosenZoneIds.includes(l.zoneId));
  const coachingUserIds = new Set(lessonsIn.flatMap((l) => l.studentIds));
  const groupCheckedIn = inAffected.filter((b) => b.status === 'checked_in' && !coachingUserIds.has(b.userId));
  const groupNotIn = inAffected.filter((b) => b.status === 'booked' && !coachingUserIds.has(b.userId));
  const groupCoaching = inAffected.filter((b) => coachingUserIds.has(b.userId));
  const retestPlannedAt = retest ? new Date(Date.now() + retestInMin * 60000).toISOString() : undefined;
  const futureSessions = state.sessions.filter((s) => s.id !== sessionId);

  // 恢复门禁以“当前生效闭池档案”为唯一依据（清场清洁 + 消毒复测 + 必要的达标水质）
  const activeRecord = state.closureRecords.find((r) => r.id === session.activeClosureId);
  const closureTask = (kind: 'cleaning' | 'disinfection') => {
    if (!activeRecord) return undefined;
    const t = state.workTasks.find((x) => activeRecord.taskIds.includes(x.id) && x.kind === kind);
    return t;
  };
  const cleaningTask = closureTask('cleaning');
  const disinfectionTask = closureTask('disinfection');
  const cleaningDone = cleaningTask?.status === 'done';
  const disinfectionDone = disinfectionTask?.status === 'done';
  const afterCloseReadings = activeRecord
    ? state.waterReadings.filter((w) => w.sessionId === sessionId && w.at > activeRecord.closedAt)
    : [];
  const retestPass = afterCloseReadings.some((w) => !w.abnormal);
  const waterRequired = activeRecord?.requireWaterRetest;
  const needCleaning = activeRecord?.disposition === 'closed' || activeRecord?.disposition === 'postponed';
  const canReopen = !!activeRecord && disinfectionDone && (!needCleaning || cleaningDone) && (!waterRequired || retestPass);
  const reopenBlockers = [
    needCleaning && !cleaningDone ? '清场清洁工单未完成' : '',
    !disinfectionDone ? '消毒复测工单未完成' : '',
    waterRequired && !retestPass ? '尚无达标水质复测' : '',
  ].filter(Boolean);

  const submitDisposition = () => {
    if (disposition === 'partial' && chosenZoneIds.length === 0) { notify.err('请至少选择一个暂停泳区'); return; }
    if (disposition === 'postponed' && !postponeTo) { notify.err('请选择顺延目标场次'); return; }
    const body = {
      sessionId, status: 'closed' as const, reason, cause,
      disposition, affectedZoneIds: chosenZoneIds, retestPlannedAt,
      postponeToSessionId: disposition === 'postponed' ? postponeTo : undefined,
      refund, compVoucher: voucher, notifyResidents: push, requireWaterRetest: retest,
    };
    act.mutateAsync({ path: '/pool-status', body })
      .then((r: any) => notify.ok(`处置完成：储值退 ${r.walletRefundCount ?? 0} 笔、券 ${r.extraVoucherCount ?? 0} 张、课程顺延 ${r.lessonPostponed ?? 0} 节`))
      .catch((e) => notify.err(e));
  };
  const reopen = () =>
    act.mutateAsync({ path: '/pool-status', body: { sessionId, status: 'normal' } })
      .then(() => notify.ok('已恢复开放，居民端/现场端状态同步刷新')).catch((e) => notify.err(e));

  return (
    <div>
      <SessionPicker sessions={state.sessions} value={sessionId} onChange={setSessionId} />
      <PoolStatusBanner status={session.poolStatus} reason={session.statusReason} requireRetest={session.requireWaterRetest} closedAt={session.closedAt} reopenedAt={session.reopenedAt}
        affectedZoneNames={(session.affectedZoneIds ?? []).map((id) => state.zones.find((z) => z.id === id)?.name ?? id)}
        retestPlannedAt={session.retestPlannedAt} />
      <div className="grid cols-2">
        <Card title="闭池决策与一键联动">
          {session.poolStatus === 'closed' && activeRecord ? (
            <div>
              <div className="alert danger">第{zh(activeRecord.seq)}轮闭池中：{activeRecord.reason}</div>
              <h4>恢复开放前置条件核对（以本轮闭池档案为唯一依据）</h4>
              <div className="task-row done"><div className="content">退费/补偿：{bookingsDone(state, sessionId)}</div><Badge tone="ok">已联动</Badge></div>
              <div className={`task-row ${cleaningDone ? 'done' : ''}`}>
                <div className="content">清场清洁工单{cleaningTask ? `（${cleaningTask.assigneeName ?? '保洁'} ${cleaningTask.status === 'done' ? '已完成：' + (cleaningTask.result ?? '') : cleaningTask.status === 'in_progress' ? '处理中' : '待处理'}）` : '缺失'}</div>
                {cleaningDone ? <Badge tone="ok">已完成</Badge> : <Badge tone="danger">未完成</Badge>}
              </div>
              <div className={`task-row ${disinfectionDone ? 'done' : ''}`}>
                <div className="content">消毒复测工单{disinfectionTask ? `（${disinfectionTask.assigneeName ?? '维修'} ${disinfectionTask.status === 'done' ? '已完成：' + (disinfectionTask.result ?? '') : disinfectionTask.status === 'in_progress' ? '处理中' : '待处理'}）` : '缺失'}</div>
                {disinfectionDone ? <Badge tone="ok">已完成</Badge> : <Badge tone="danger">未完成</Badge>}
              </div>
              {waterRequired && (
                <div className={`task-row ${retestPass ? 'done' : ''}`}>
                  <div className="content">达标水质复测（晚于本轮闭池时间）{afterCloseReadings.length ? `，已提交 ${afterCloseReadings.length} 次${retestPass ? '，最近一次达标' : ''}` : '，维修尚未提交复测'}</div>
                  {retestPass ? <Badge tone="ok">已达标</Badge> : <Badge tone="danger">未达标</Badge>}
                </div>
              )}
              {!canReopen && (
                <div className="alert warn">还不能恢复开放：{reopenBlockers.join('、')}。请在保洁/维修完成各自工单{waterRequired ? '，并由维修/救生员录入一次达标水质复测' : ''}后再恢复。</div>
              )}
              <button className="btn" style={{ marginTop: 10 }} disabled={act.isPending || !canReopen} onClick={reopen}>
                {canReopen ? '✅ 处置全部完成，恢复开放（同步居民端与现场端）' : '处置未完成，禁止恢复开放'}
              </button>
            </div>
          ) : (
            <div>
              <div className="form-row">
                <label className="field">触发原因<select value={cause} onChange={(e) => {
                  const v = e.target.value as IncidentType | 'other';
                  setCause(v);
                  if (v === 'thunderstorm') { setDisposition('closed'); setReason('雷电预警，全场暂停开放'); }
                  if (v === 'water_abnormal') { setDisposition('partial'); setReason('余氯不足/浊度超标，受影响泳区暂停开放'); }
                }}>{CAUSES.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}</select></label>
                <label className="field">处置方式
                  <select value={disposition} onChange={(e) => setDisposition(e.target.value as any)}>
                    <option value="partial">部分开放（仅暂停受影响泳区）</option>
                    <option value="closed">闭池（全场清场）</option>
                    <option value="postponed">延期（顺延到后续场次）</option>
                  </select>
                </label>
              </div>
              <div style={{ height: 10 }} />
              <label className="field">说明<textarea value={reason} onChange={(e) => setReason(e.target.value)} /></label>

              {/* 受影响时段锁定视图 */}
              <h4>受影响时段与人群</h4>
              {disposition === 'partial' && (
                <div>
                  <div className="small muted" style={{ marginBottom: 6 }}>勾选暂停使用的泳区（其余泳区继续开放、可正常核验）：</div>
                  <div className="flex" style={{ flexWrap: 'wrap', gap: 8 }}>
                    {state.zones.map((z) => (
                      <label key={z.id} className="checkbox" style={{ minWidth: 130 }}>
                        <input type="checkbox" checked={!!zonePicks[z.id]} onChange={(e) => setZonePicks((p) => ({ ...p, [z.id]: e.target.checked }))} />
                        {z.name}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <div className="grid cols-3" style={{ margin: '10px 0' }}>
                <div className="zone-card"><div className="stat"><span className="num">{groupCheckedIn.length}</span><span className="lbl">已入场（清场·安抚券）</span></div></div>
                <div className="zone-card"><div className="stat accent"><span className="num">{groupNotIn.length}</span><span className="lbl">未入场（原路退款）</span></div></div>
                <div className="zone-card"><div className="stat warn"><span className="num">{groupCoaching.length + lessonsIn.length}</span><span className="lbl">教练课（顺延）</span></div></div>
              </div>

              {disposition === 'postponed' && (
                <label className="field">顺延目标场次
                  <select value={postponeTo} onChange={(e) => setPostponeTo(e.target.value)}>
                    <option value="">请选择…</option>
                    {futureSessions.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </select>
                </label>
              )}

              <h4>复测计划</h4>
              <label className="checkbox"><input type="checkbox" checked={retest} onChange={(e) => setRetest(e.target.checked)} /> 恢复前须达标复测</label>
              {retest && (
                <label className="field" style={{ marginTop: 6 }}>计划复测时间（分钟后）
                  <select value={retestInMin} onChange={(e) => setRetestInMin(Number(e.target.value))}>
                    {[30, 60, 90, 120, 240].map((m) => <option key={m} value={m}>{m} 分钟后</option>)}
                  </select>
                </label>
              )}

              <h4>补偿方式（按实际影响区分）</h4>
              <label className="checkbox"><input type="checkbox" checked={refund} onChange={(e) => setRefund(e.target.checked)} disabled={disposition === 'postponed'} /> 未入场预约原路退款（储值退余额 / 券返原券 / 现金登记）{disposition === 'postponed' && '（延期为顺延，不退款）'}</label>
              <label className="checkbox"><input type="checkbox" checked={voucher} onChange={(e) => setVoucher(e.target.checked)} /> 未入场额外补偿券 + 已入场安抚券（已入场不退现金）</label>
              <label className="checkbox"><input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} /> 分别通知已入场 / 未入场 / 教练课用户与机构</label>

              <div className="alert warn" style={{ marginTop: 10 }}>
                将处理受影响泳区 <b>{chosenZoneIds.length}</b> 个：未入场 <b>{groupNotIn.length}</b> 笔（储值退 ¥{groupNotIn.filter((b) => b.paymentMethod === 'wallet').reduce((s, b) => s + b.paidAmount, 0)}、原券 {groupNotIn.filter((b) => b.paymentMethod === 'voucher').length} 张、现场登记 ¥{groupNotIn.filter((b) => b.paymentMethod === 'cash').reduce((s, b) => s + b.paidAmount, 0)}）、已入场 <b>{groupCheckedIn.length}</b> 人发安抚券、教练课 <b>{lessonsIn.length}</b> 节顺延；同时派发消毒复测{disposition === 'closed' || disposition === 'postponed' ? '与清场清洁' : ''}工单。
              </div>
              <button className="btn danger" disabled={!reason.trim() || act.isPending || (disposition === 'partial' && chosenZoneIds.length === 0) || (disposition === 'postponed' && !postponeTo)}
                onClick={() => { if (confirm(`确认执行「${disposition === 'partial' ? '部分开放' : disposition === 'closed' ? '闭池' : '延期'}」并联动通知？`)) submitDisposition(); }}>
                {disposition === 'partial' ? '🔶 锁定受影响泳区并执行处置' : disposition === 'closed' ? '🚫 确认闭池并执行联动' : '⏭️ 确认延期并顺延'}
              </button>
            </div>
          )}
        </Card>

        <Card title="联动结果核对（防止两端状态不一致）">
          <h4>受影响预约</h4>
          {affected.length === 0 && <Empty text="无受影响预约" />}
          <div className="table-wrap"><table>
            <thead><tr><th>码</th><th>泳客</th><th>金额</th><th>支付</th><th>状态</th></tr></thead>
            <tbody>{state.bookings.filter((b) => b.sessionId === sessionId).map((b) => (
              <tr key={b.id}><td className="code-mono">{b.code}</td><td className="small">{userName(state, b.userId)?.name}</td><td>{b.paidAmount}</td>
                <td className="small">{b.paymentMethod === 'wallet' ? '储值' : b.paymentMethod === 'voucher' ? '券' : '现金'}</td>
                <td><Badge tone={BOOKING_STATUS_BADGE[b.status]}>{BOOKING_STATUS_LABEL[b.status]}</Badge></td></tr>
            ))}</tbody></table></div>
          <h4>最近的居民通知</h4>
          {state.notifications.filter((n) => n.sessionId === sessionId).slice(0, 6).map((n) => (
            <div key={n.id} className={`notif ${n.level}`}><b className="small">{n.title}</b><div className="small muted">{n.body}</div></div>
          ))}
        </Card>
      </div>

      <ClosureArchives state={state} sessionId={sessionId} />
    </div>
  );
}

/** 历次闭池处置档案：不可变快照，多轮闭池独立呈现 */
function ClosureArchives({ state, sessionId }: { state: AppState; sessionId: string }) {
  const records = state.closureRecords
    .filter((r) => r.sessionId === sessionId)
    .sort((a, b) => b.seq - a.seq);
  if (records.length === 0) return null;
  return (
    <Card className="section-gap" title={`闭池处置档案（本场共 ${records.length} 轮，归档后不可被当前状态覆盖）`}>
      <div className="grid cols-2">
        {records.map((r) => (
          <div key={r.id} className={`notif ${r.status === 'closed' ? 'critical' : 'info'}`}>
            <div className="flex">
              <b>第{zh(r.seq)}轮{dispositionLabel(r.disposition)} · {r.cause === 'other' ? '其他原因' : INCIDENT_TYPE_LABEL[r.cause]}</b>
              <span className="spacer" />
              <Badge tone={r.status === 'closed' ? 'danger' : 'ok'}>{r.status === 'closed' ? '处置中' : '已恢复'}</Badge>
            </div>
            <div className="small" style={{ marginTop: 4 }}>原因：{r.reason}</div>
            <dl className="kv small" style={{ marginTop: 6 }}>
              <dt>处置时间</dt><dd>{fmtDateTime(r.closedAt)} · {r.closedBy}{r.retestPlannedAt ? ` · 计划复测 ${fmtDateTime(r.retestPlannedAt)}` : ''}</dd>
              <dt>受影响人群</dt>
              <dd>已入场 {r.groupCounts?.checked_in ?? 0} · 未入场 {r.groupCounts?.not_checked_in ?? 0} · 教练课 {r.groupCounts?.coaching ?? 0}{r.affectedZoneIds.length ? ` · 泳区 ${r.affectedZoneIds.length} 个` : ''}</dd>
              <dt>原渠道退款</dt>
              <dd>储值 {r.walletRefundCount} 笔/¥{r.walletRefundTotal} · 原券返还 {r.originalVoucherReturnCount} 张 · 现场登记 {r.cashRefundCount} 笔/¥{r.cashRefundTotal}
                {r.extraVoucherCount > 0 && <span className="badge purple" style={{ marginLeft: 6 }}>额外/安抚券 {r.extraVoucherCount} 张</span>}
              </dd>
              <dt>教练课顺延</dt><dd>{(r.lessonPostponements ?? []).length === 0 ? '无' : r.lessonPostponements?.map((l) => `${l.lessonTitle}→${state.sessions.find((s) => s.id === l.toSessionId)?.label ?? l.toSessionId}（${l.studentCount} 人${l.institutionNotified ? '，机构已通知' : ''}）`).join('；')}</dd>
              <dt>清场</dt><dd>撤哨 {r.guardReliefCount} 人 · 联动工单 {r.taskIds.length} 个</dd>
              <dt>通知</dt><dd>{r.announcementIds.length} 条（全员公告+已入场/未入场/教练课逐人通知）</dd>
              <dt>恢复门禁</dt>
              <dd>{r.status === 'reopened'
                ? `清场${r.reopenChecklist?.cleaning ? '✓(' + (r.reopenChecklist.cleaning.assigneeName ?? '保洁') + ')' : '—'} · 消毒${r.reopenChecklist?.disinfection ? '✓(' + (r.reopenChecklist.disinfection.assigneeName ?? '维修') + ')' : '—'}${r.requireWaterRetest ? ' · 水质复测✓' : ''}`
                : '等待消毒与必要复测全部完成'}</dd>
              <dt>恢复</dt><dd>{r.status === 'reopened' ? `${fmtDateTime(r.reopenedAt)} · ${r.reopenedBy ?? ''}${r.retestReadingId ? ' · 复测 ' + r.retestReadingId + ' 达标' : ''}` : '处置未完成，禁止恢复'}</dd>
            </dl>
            <details style={{ marginTop: 6 }}>
              <summary className="small muted" style={{ cursor: 'pointer' }}>逐人处置结果（{r.affected.length}）</summary>
              <div className="table-wrap" style={{ marginTop: 6 }}><table>
                <thead><tr><th>预约码</th><th>泳客</th><th>人群</th><th>原渠道</th><th>处置结果</th><th>额外/安抚券</th><th>通知</th></tr></thead>
                <tbody>{r.affected.map((a) => (
                  <tr key={a.bookingId}>
                    <td className="code-mono small">{a.bookingCode}</td><td className="small">{a.userName}</td>
                    <td className="small">{a.group === 'checked_in' ? '已入场' : a.group === 'coaching' ? '教练课' : '未入场'}{a.postponed ? '·顺延' : ''}</td>
                    <td>{a.paymentMethod === 'wallet' ? '储值' : a.paymentMethod === 'voucher' ? '补偿券' : '现场支付'}</td>
                    <td className="small">{a.postponed ? `顺延至 ${state.sessions.find((s) => s.id === a.postponeToSessionId)?.label ?? a.postponeToSessionId}` : refundResultText(a)}</td>
                    <td>{a.extraCompVoucher ? '1 张' : '—'}</td>
                    <td>{a.notificationId ? '已送达' : '—'}</td>
                  </tr>
                ))}</tbody></table></div>
            </details>
            <div className="small muted" style={{ marginTop: 4 }}>档案号 {r.id}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function bookingsDone(state: AppState, sessionId: string) {
  const list = state.bookings.filter((b) => b.sessionId === sessionId && (b.status === 'refunded' || b.status === 'compensated'));
  return list.length ? `已处理 ${list.length} 笔（退费/补偿到账）` : '进行中';
}

// ============ 抽筋救援复盘 → 培训 / 排班 ============
function RescueReviewTab({ state }: Props) {
  const [sessionId, setSessionId] = useState(state.boards[1]?.session.id ?? state.boards[0].session.id);
  const list = state.crampRescues.filter((r) => r.sessionId === sessionId);
  const pendingReview = list.filter((r) => !r.reviewedAt
    && (['guard_relief', 'lane_reopen', 'order_restored'] as const).every((k) => r.closure[k].done));

  return (
    <div>
      <SessionPicker sessions={state.sessions} value={sessionId} onChange={setSessionId} />
      <div className="grid cols-2">
        <div className="grid">
          <Card title={`本场抽筋救援记录（${list.length}）`}>
            {list.length === 0 ? <Empty text="本场暂无抽筋救援" /> :
              list.map((r) => (
                <div key={r.id} style={{ marginBottom: 12 }}>
                  <RescueCard rescue={r} state={state} user={{ role: 'ops' } as User} />
                  {!r.reviewedAt && <ReviewForm rescue={r} state={state} canReview={pendingReview.some((x) => x.id === r.id)} />}
                </div>
              ))}
          </Card>
        </div>
        <div className="grid">
          <Card title="复盘结论 → 救生员培训与排班">
            {state.guardTraining.length === 0 ? <Empty text="暂无复盘培训项" /> :
              state.guardTraining.map((t) => <TrainingRow key={t.id} t={t} state={state} user={{ role: 'ops' } as User} />)}
          </Card>
          <Card title="后续场次重点关注泳道（站位调整自动带入）">
            {state.sessions.filter((s) => (s.guardFocusLanes ?? []).length > 0).length === 0 ? <Empty text="暂无" /> :
              state.sessions.filter((s) => (s.guardFocusLanes ?? []).length > 0).map((s) => (
                <div key={s.id} className="queue-row">
                  <div>
                    <b className="small">{s.label}</b>
                    {(s.guardFocusLanes ?? []).map((f, i) => (
                      <div key={i} className="small muted">
                        🛟 {state.zones.find((z) => z.id === f.zoneId)?.name} {f.lane} 号道
                        <span className="badge purple" style={{ margin: '0 4px' }}>第{f.version}版</span>
                        {f.ackBy ? `· ${f.ackBy} ${fmtDateTime(f.ackAt)} 已确认当前版` : '· 当前版待救生确认'}
                        <div>{f.reason}</div>
                        {f.updatedAt && <div>最新更新 {fmtDateTime(f.updatedAt)} · {f.updatedBy}</div>}
                        {f.history.length > 0 && (
                          <details>
                            <summary style={{ cursor: 'pointer' }}>历次策略与确认（{f.history.length}）</summary>
                            {f.history.map((h) => (
                              <div key={h.version} style={{ paddingLeft: 8 }}>
                                第{h.version}版{h.by ? ` · ${h.by}` : ''}：{h.reason}
                                {h.ackAt ? `（该版由 ${h.ackBy} ${fmtDateTime(h.ackAt)} 确认，后被新版替换）` : '（该版未确认即被替换）'}
                              </div>
                            ))}
                          </details>
                        )}
                      </div>
                    ))}
                  </div>
                  <Badge tone="warn">下一场重点</Badge>
                </div>
              ))}
          </Card>
        </div>
      </div>
    </div>
  );
}

function ReviewForm({ rescue, state, canReview }: { rescue: import('../../shared/types.js').CrampRescue; state: AppState; canReview: boolean }) {
  const act = useAction();
  const notify = useNotify();
  const guards = state.users.filter((u) => u.role === 'lifeguard');
  const [summary, setSummary] = useState('');
  const [content, setContent] = useState(
    `${CRAMP_PART_LABEL[rescue.crampPart]}抽筋的识别与${RESCUE_METHOD_LABEL[rescue.method]}要点复训；加强${zoneLabel(state, rescue.zoneId)} ${rescue.lane} 号道瞭望，提醒泳客下水前热身。`,
  );
  const [targets, setTargets] = useState<string[]>([rescue.guardName]);
  const [intoSchedule, setIntoSchedule] = useState(true);
  const [scheduleNote, setScheduleNote] = useState(`近期排班加强${zoneLabel(state, rescue.zoneId)}岗位瞭望/带教`);

  const toggle = (name: string) =>
    setTargets((t) => (t.includes(name) ? t.filter((x) => x !== name) : [...t, name]));

  if (!canReview) {
    const pending = (['guard_relief', 'lane_reopen', 'order_restored'] as const).filter((k) => !rescue.closure[k].done);
    return <div className="alert warn" style={{ marginTop: 8 }}>收尾确认未完成（缺：{pending.map((k) => RESCUE_CLOSURE_LABEL[k]).join('、')}），救生员完成三确认后才能组织本场复盘。</div>;
  }

  return (
    <div className="notif warning" style={{ marginTop: 8 }}>
      <b>组织本场复盘（复盘结果进入救生员培训与排班）</b>
      <label className="field" style={{ marginTop: 8 }}>复盘结论
        <textarea value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="发现是否及时、施救是否规范、暴露的站位/预案问题…" />
      </label>
      <label className="field" style={{ marginTop: 8 }}>培训要点
        <textarea value={content} onChange={(e) => setContent(e.target.value)} />
      </label>
      <div className="small muted" style={{ margin: '6px 0 2px' }}>参训救生员（不勾=全体救生员）：</div>
      <div className="flex" style={{ flexWrap: 'wrap', gap: 8 }}>
        {guards.map((g) => (
          <label key={g.id} className="checkbox" style={{ margin: 0 }}>
            <input type="checkbox" checked={targets.includes(g.name)} onChange={() => toggle(g.name)} />{g.name}
          </label>
        ))}
      </div>
      <label className="checkbox" style={{ marginTop: 8 }}><input type="checkbox" checked={intoSchedule} onChange={(e) => setIntoSchedule(e.target.checked)} /> 同步进入近期救生排班（加强岗/带教）</label>
      {intoSchedule && <input style={{ marginTop: 6 }} value={scheduleNote} onChange={(e) => setScheduleNote(e.target.value)} />}
      <div style={{ marginTop: 8 }}>
        <button className="btn sm danger" disabled={act.isPending || !summary.trim() || !content.trim()}
          onClick={() => act.mutateAsync({
            path: `/cramp-rescues/${rescue.id}/review`,
            body: { summary, trainingContent: content, targetGuardNames: targets, intoSchedule, scheduleNote },
          }).then(() => notify.ok('复盘完成：培训项已生成并同步排班')).catch((e) => notify.err(e))}>
          提交复盘并生成培训项
        </button>
      </div>
    </div>
  );
}

// ============ 事件指挥 ============
function IncidentTab({ user, state }: Props) {
  return (
    <div className="grid cols-2">
      <IncidentCreateForm sessions={state.sessions} />
      <Card title="事件指挥（前台/救生/保洁/维修同屏协同）">
        <IncidentList incidents={state.incidents} user={user} />
      </Card>
    </div>
  );
}

// ============ 工单派发 ============
function Dispatch({ state }: Props) {
  const act = useAction();
  const notify = useNotify();
  const [kind, setKind] = useState<TaskKind>('cleaning');
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [role, setRole] = useState<'cleaner' | 'maintenance'>('cleaner');
  const [sessionId, setSessionId] = useState(state.sessions[1]?.id ?? state.sessions[0].id);

  return (
    <div className="grid cols-2">
      <Card title="派发工单（保洁/维修/消毒）">
        <div className="form-row">
          <label className="field">类型<select value={kind} onChange={(e) => setKind(e.target.value as TaskKind)}>
            <option value="cleaning">保洁</option><option value="maintenance">维修</option><option value="disinfection">泳池消毒</option>
          </select></label>
          <label className="field">负责岗位<select value={role} onChange={(e) => setRole(e.target.value as any)}>
            <option value="cleaner">保洁</option><option value="maintenance">维修</option>
          </select></label>
        </div>
        <div style={{ height: 10 }} />
        <label className="field">关联场次<select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>{state.sessions.map((s) => <option key={s.id}>{s.label}</option>)}</select></label>
        <div style={{ height: 10 }} />
        <label className="field">标题<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：晚高峰前淋浴区深度清洁" /></label>
        <div style={{ height: 10 }} />
        <label className="field">详细要求<textarea value={detail} onChange={(e) => setDetail(e.target.value)} /></label>
        <div style={{ height: 10 }} />
        <button className="btn" disabled={!title.trim() || act.isPending}
          onClick={() => act.mutateAsync({ path: '/tasks', body: { kind, title, detail, assigneeRole: role, sessionId } }).then(() => { notify.ok('工单已派发'); setTitle(''); setDetail(''); }).catch((e) => notify.err(e))}>派发</button>
      </Card>
      <Card title="全部工单">
        {state.workTasks.length === 0 ? <Empty text="暂无工单" /> : state.workTasks.map((t) => (
          <div key={t.id} className="queue-row">
            <div><b className="small">{t.title}</b>
              <div className="small muted">{t.detail} · {t.assigneeRole === 'cleaner' ? '保洁' : '维修'}{t.assigneeName ? ` · ${t.assigneeName}` : ''} · {fmtDateTime(t.createdAt)}</div></div>
            <div className="flex">
              <Badge tone={t.kind === 'disinfection' ? 'purple' : 'gray'}>{t.kind === 'disinfection' ? '消毒' : t.kind === 'maintenance' ? '维修' : '保洁'}</Badge>
              <Badge tone={t.status === 'done' ? 'ok' : t.status === 'in_progress' ? 'warn' : 'danger'}>{TASK_STATUS_LABEL[t.status]}</Badge>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ============ 投诉 ============
function Complaints({ state }: Props) {
  const act = useAction();
  const notify = useNotify();
  const [reply, setReply] = useState<Record<string, string>>({});
  const open = state.complaints.filter((c) => c.status === 'open');
  const done = state.complaints.filter((c) => c.status === 'replied');
  return (
    <div className="grid cols-2">
      <Card title={`待处理投诉（${open.length}）`}>
        {open.length === 0 ? <Empty text="暂无待处理投诉" /> : open.map((c) => (
          <div key={c.id} className="notif warning">
            <div className="flex"><b>[{c.category}]</b><span className="spacer" /><span className="small muted">{userName(state, c.userId)?.name} · {fmtDateTime(c.at)}</span></div>
            <div className="small" style={{ margin: '4px 0' }}>{c.content}</div>
            <textarea placeholder="回复处理结果（居民端立即可见）" value={reply[c.id] ?? ''} onChange={(e) => setReply((r) => ({ ...r, [c.id]: e.target.value }))} />
            <button className="btn sm" style={{ marginTop: 8 }} disabled={act.isPending || !(reply[c.id] ?? '').trim()}
              onClick={() => act.mutateAsync({ path: `/complaints/${c.id}/reply`, body: { reply: reply[c.id] } }).then(() => notify.ok('已回复居民')).catch((e) => notify.err(e))}>回复</button>
          </div>
        ))}
      </Card>
      <Card title="已回复">
        {done.length === 0 ? <Empty text="暂无" /> : done.map((c) => (
          <div key={c.id} className="notif info">
            <div className="flex"><b>[{c.category}] {userName(state, c.userId)?.name}</b><span className="spacer" /><Badge tone="ok">已回复</Badge></div>
            <div className="small">{c.content}</div>
            <div className="small" style={{ marginTop: 4, padding: 7, background: 'var(--ok-bg)', borderRadius: 7 }}>{c.reply}</div>
          </div>
        ))}
      </Card>
    </div>
  );
}

export function OpsPage(props: Props) {
  if (props.tab === 'rescue') return <RescueReviewTab {...props} />;
  if (props.tab === 'conflict') return <RentalOpsTab user={props.user} state={props.state} />;
  if (props.tab === 'close') return <CloseReopen {...props} />;
  if (props.tab === 'incident') return <IncidentTab {...props} />;
  if (props.tab === 'tasks') return <Dispatch {...props} />;
  if (props.tab === 'complaint') return <Complaints {...props} />;
  return <Command {...props} />;
}
