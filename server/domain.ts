import type {
  DB, Booking, BookingKind, MemberTier, Incident, IncidentTask, IncidentType,
  Notification, Role, Session, WaterReading, Zone, ZoneId, WorkTask, PatrolIssue,
  LiveBoard, ZoneLiveStat, GuardPost, PoolStatus, ClosureRecord, ClosureAffectedItem,
  AffectedGroup, ClosureLessonPostpone,
} from '../shared/types.js';
import { GUARD_POST_LABEL } from '../shared/types.js';
import { WATER_STD, evaluateWater, priceOf } from '../shared/logic.js';
import { mutate, nextId } from './store.js';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const now = () => new Date().toISOString();

// 水质标准/判定、计价见 shared/logic.ts（前后端共用）
export { WATER_STD, evaluateWater, priceOf };

// ============ 查询辅助 ============
export function activeBookings(db: DB, sessionId: string): Booking[] {
  return db.bookings.filter(
    (b) => b.sessionId === sessionId && b.status !== 'cancelled' && b.status !== 'refunded' && b.status !== 'compensated',
  );
}

export function zoneLocked(db: DB, session: Session, zoneId: ZoneId, lane?: number) {
  let seats = 0;
  const hits = session.locks.filter((l) => {
    if (l.zoneId !== zoneId) return false;
    if (lane == null) return true;
    if (l.lane == null) return true; // 整区锁定覆盖所有泳道
    return l.lane === lane;
  });
  hits.forEach((h) => (seats += h.capacity));
  return { seats, hits };
}

export function zoneCounts(db: DB, sessionId: string, zoneId: ZoneId) {
  const list = activeBookings(db, sessionId).filter((b) => b.zoneId === zoneId);
  const booked = list.filter((b) => b.status === 'booked').reduce((s, b) => s + Math.max(1, b.partySize), 0);
  const checked = list.filter((b) => b.status === 'checked_in');
  const inPool = checked.reduce((s, b) => s + Math.max(1, b.partySize), 0);
  const children = checked.reduce((s, b) => s + (b.childrenInParty ?? (b.withChildren ? b.childCount : 0)), 0);
  const deepHolders = checked.filter((b) => {
    const u = db.users.find((x) => x.id === b.userId);
    return u?.deepCert;
  }).length;
  return { booked, inPool, children, deepHolders, list };
}

/** 商业包场/锁区 vs 居民公益时段、既有居民预约、泳道占用的冲突 */
export function lockConflicts(db: DB, session: Session, lock: { id?: string; zoneId: ZoneId; lane?: number; capacity: number; isCommercial: boolean }) {
  const msgs: string[] = [];
  if (session.publicWelfare && lock.isCommercial) {
    msgs.push(`商业包场与「${session.label}」居民公益时段直接冲突，须先保障公益名额`);
  }
  const residentKinds: BookingKind[] = ['personal', 'parent_child', 'elder_morning', 'coaching', 'guest'];
  const residents = activeBookings(db, session.id).filter(
    (b) => residentKinds.includes(b.kind) && b.zoneId === lock.zoneId &&
      (lock.lane == null || b.lane == null || lock.lane === b.lane),
  );
  if (residents.length) {
    const people = residents.reduce((s, b) => s + Math.max(1, b.partySize), 0);
    msgs.push(`该区域已有 ${residents.length} 笔居民预约（共 ${people} 人，含 ${residents.map((b) => b.code).join('、')}），包场将挤压居民名额`);
  }
  // 自检时排除锁自身，避免“与自己重叠/重复占容量”
  const otherLocks = session.locks.filter((l) => l.id !== lock.id);
  const overlapLock = otherLocks.find(
    (l) => l.zoneId === lock.zoneId &&
      (l.lane == null || lock.lane == null || l.lane === lock.lane),
  );
  if (overlapLock) msgs.push(`与现有锁定「${overlapLock.title}」区域/泳道重叠`);

  const zone = db.zones.find((z) => z.id === lock.zoneId)!;
  const lockedByOthers = otherLocks
    .filter((l) => l.zoneId === lock.zoneId)
    .reduce((s, l) => s + l.capacity, 0);
  const { inPool, booked } = zoneCounts(db, session.id, lock.zoneId);
  if (inPool + booked + lockedByOthers + lock.capacity > zone.capacity) {
    msgs.push(`超出泳区容量：在池 ${inPool} + 待入场 ${booked} + 已锁 ${lockedByOthers} + 本次 ${lock.capacity} > 容量 ${zone.capacity}`);
  }
  return msgs;
}

export function pushNotification(db: DB, n: Omit<Notification, 'id' | 'at'>) {
  const created: Notification = { ...n, id: nextId('nt'), at: now() };
  db.notifications.unshift(created);
  if (db.notifications.length > 300) db.notifications.length = 300;
  return created.id;
}

// ============ 跨角色事件模板 ============
function t(role: Role, content: string): IncidentTask {
  return { id: nextId('it'), role, content, done: false };
}

export function buildIncidentTasks(type: IncidentType): { title: string; severity: Incident['severity']; tasks: IncidentTask[] } {
  switch (type) {
    case 'water_abnormal':
      return { title: '水质异常', severity: 'critical', tasks: [
        t('lifeguard', '立即停止向异常泳区放行，在池泳客岸上观察，准备清场'),
        t('frontdesk', '暂停该场次入场核验，向到场居民说明并登记'),
        t('maintenance', '加氯/反冲洗循环系统，排查加药设备，30 分钟内复测'),
        t('cleaner', '配合清场，清理池岸、铺设防滑垫'),
        t('ops', '评估限流/闭池，组织水质复测并统一对外通知'),
      ] };
    case 'thunderstorm':
      return { title: '雷雨临近', severity: 'critical', tasks: [
        t('lifeguard', '鸣哨清场，所有泳客立即上岸进入室内避险'),
        t('frontdesk', '广播通知，登记提前离场泳客以备退费补偿'),
        t('cleaner', '检查门窗、铺防滑垫、引导室内避雨'),
        t('maintenance', '切断户外用电设备、检查防雷与排水'),
        t('ops', '决定闭池并联动退费、补偿券与居民通知'),
      ] };
    case 'cramp':
      return { title: '泳客抽筋', severity: 'major', tasks: [
        t('lifeguard', '下水施救，转移上岸并做拉伸/急救处置'),
        t('frontdesk', '拨打 120 待命，联系陪同人并取 AED'),
        t('cleaner', '开辟救生通道、疏散围观泳客'),
        t('ops', '跟进送医、记录事件经过'),
      ] };
    case 'child_lost':
      return { title: '儿童走失', severity: 'critical', tasks: [
        t('lifeguard', '封控池区出入口，水中与池岸分片搜寻'),
        t('frontdesk', '广播寻人、核对陪同人信息、调看监控'),
        t('cleaner', '搜寻更衣室、淋浴区与卫生间'),
        t('ops', '统筹寻人，10 分钟未找到立即报警并通知家长'),
      ] };
    case 'locker_dispute':
      return { title: '储物柜纠纷', severity: 'major', tasks: [
        t('frontdesk', '安抚双方，核对储物柜登记与备用钥匙'),
        t('maintenance', '到场技术性开锁/换锁，防止物品损坏'),
        t('ops', '调解并记录，必要时调整储物柜分配规则'),
      ] };
    case 'overbooking':
      return { title: '预约超额', severity: 'major', tasks: [
        t('frontdesk', '现场登记候补，按到场顺序安排入场'),
        t('lifeguard', '严控在池人数不超容量，超额泳客不得放行'),
        t('ops', '临时加开泳道/调整包场区域，无法入场者全额退费+补偿券'),
      ] };
    case 'equipment_fault':
      return { title: '设备故障', severity: 'major', tasks: [
        t('maintenance', '立即抢修、悬挂故障牌，必要时停机'),
        t('lifeguard', '相关泳区加密人工巡视'),
        t('cleaner', '故障区域防滑、清理积水'),
        t('ops', '评估是否需要限流或闭池'),
      ] };
    case 'medical':
      return { title: '突发医疗急救', severity: 'critical', tasks: [
        t('lifeguard', '立即施救并使用 AED，持续监护生命体征'),
        t('frontdesk', '拨打 120、开门引导救护车、联系家属'),
        t('cleaner', '清理急救通道'),
        t('ops', '跟进送医与家属安抚'),
      ] };
  }
}

const STAFF_ROLES: Role[] = ['frontdesk', 'lifeguard', 'cleaner', 'maintenance', 'ops'];
const LEVEL_MAP = { critical: 'critical', major: 'warning' } as const;

/** 创建事件：同场次各角色任务一并生成；保洁/维修任务同步进入工单 */
export function openIncident(db: DB, sessionId: string, type: IncidentType, titleOverride: string | undefined, description: string, reporter: string, severityOverride?: Incident['severity']): Incident {
  const session = db.sessions.find((s) => s.id === sessionId);
  if (!session) throw new HttpError(404, '场次不存在');
  const open = db.incidents.find((i) => i.sessionId === sessionId && i.type === type && i.status !== 'resolved');
  if (open) throw new HttpError(409, `同场次已有进行中的「${buildIncidentTasks(type).title}」事件，请直接协同处置 #${open.code}`);

  const tpl = buildIncidentTasks(type);
  const incident: Incident = {
    id: nextId('inc'), code: `INC-${db.counters.seq}`, sessionId, type,
    severity: severityOverride ?? tpl.severity,
    title: titleOverride || tpl.title,
    description, reportedAt: now(), reporter, status: 'open',
    tasks: tpl.tasks, actions: [{ id: nextId('ia'), at: now(), by: reporter, byRole: 'ops', content: `事件上报：${description}` }],
  };
  db.incidents.unshift(incident);

  pushNotification(db, {
    title: `【${session.label}】${incident.title} #${incident.code}`,
    body: description, level: LEVEL_MAP[incident.severity],
    roles: STAFF_ROLES, sessionId,
  });

  // 保洁/维修的处置项自动转工单，保证它们在自己的看板上看到
  for (const task of incident.tasks) {
    if (task.role === 'cleaner' || task.role === 'maintenance') {
      const wt: WorkTask = {
        id: nextId('wt'), sessionId, kind: task.role === 'maintenance' ? 'maintenance' : 'cleaning',
        title: `${incident.title}#${incident.code} · 处置`,
        detail: task.content, zoneId: 'all', assigneeRole: task.role,
        status: 'pending', createdAt: now(), source: 'incident', incidentId: incident.id,
      };
      db.workTasks.unshift(wt);
    }
  }
  return incident;
}

// ============ 预约 ============
export function createBooking(db: DB, userId: string, req: {
  kind: BookingKind; sessionId: string; zoneId: ZoneId; lane?: number; age: number;
  healthPledge: boolean; healthCode?: 'green' | 'expired' | 'none'; medicalCert?: boolean;
  withChildren: boolean; childCount: number; childCompanion?: string; childCompanionPhone?: string;
  swimLevel: Booking['swimLevel']; partySize?: number; childrenInParty?: number;
  contactName?: string; contactPhone?: string; orgName?: string;
  paymentMethod?: 'wallet' | 'cash' | 'voucher';
}) {
  const user = db.users.find((u) => u.id === userId)!;
  const session = db.sessions.find((s) => s.id === req.sessionId);
  if (!session) throw new HttpError(404, '场次不存在');
  if (session.poolStatus === 'closed') throw new HttpError(409, '该场次已闭池，暂不可预约');
  if (session.poolStatus === 'partial' && (session.affectedZoneIds ?? []).includes(req.zoneId))
    throw new HttpError(409, `该泳区因${session.statusReason || '水质异常'}暂停开放，请选择其他泳区或场次`);
  const zone = db.zones.find((z) => z.id === req.zoneId);
  if (!zone) throw new HttpError(404, '泳区不存在');
  if (!req.healthPledge) throw new HttpError(400, '必须勾选健康承诺后方可预约');
  // 抽筋救援等现场处置中的临停泳道不得预约
  const suspendedLane = (session.suspendedLanes ?? []).find((l) => l.zoneId === req.zoneId && l.lane === req.lane);
  if (suspendedLane)
    throw new HttpError(409, `${zone.name} ${req.lane} 号道因现场救援临时关闭，请改选其他泳道或稍后再试`);
  if (req.age < 14 && !(req.withChildren || req.kind === 'parent_child'))
    throw new HttpError(400, '14 岁以下儿童须由成人陪同，按亲子时段预约');
  if (zone.requireCert && !user.deepCert)
    throw new HttpError(403, '深水区须持深水合格证，您可先在前台进行 200 米测试');

  const partySize = req.kind === 'group' || req.kind === 'institution_rental'
    ? Math.max(1, req.partySize ?? 1)
    : req.kind === 'parent_child' ? 1 + Math.max(0, req.childCount) : 1;
  const childrenInParty = req.kind === 'parent_child' ? Math.max(0, req.childCount) : (req.childrenInParty ?? 0);

  if (req.kind === 'institution_rental') {
    if (!req.orgName || !req.contactName || !req.contactPhone) throw new HttpError(400, '机构包场须填写机构名称、联系人与电话');
    if (partySize < 10) throw new HttpError(400, '机构包场不少于 10 人，普通团体请选团体预约');
  }
  if (req.kind === 'group' && partySize < 5) throw new HttpError(400, '团体预约不少于 5 人');

  // 泳道/锁区冲突（对居民不回显机构名称，避免错误消息旁路泄露第三方信息）
  const { hits: lockHits } = zoneLocked(db, session, req.zoneId, req.lane);
  if (lockHits.length) {
    const detail = user.role === 'resident'
      ? '该泳道/区域当前时段已被占用，请改选其他泳道、泳区或场次'
      : lockHits.map((l) => l.title).join('；');
    throw new HttpError(409, `该泳道/区域已被锁定：${detail}`);
  }

  const { seats: locked } = zoneLocked(db, session, req.zoneId);
  const { inPool, booked } = zoneCounts(db, req.sessionId, req.zoneId);
  const remaining = zone.capacity - locked - inPool - booked;
  const overCapacity = remaining < partySize;

  const paymentMethod = req.paymentMethod ?? (req.kind === 'institution_rental' ? 'cash' : 'wallet');
  const amount = priceOf(req.kind, partySize, req.childCount, user.memberTier);

  if (amount > 0) {
    if (paymentMethod === 'wallet') {
      if ((user.walletBalance ?? 0) < amount) throw new HttpError(402, '储值余额不足，请先在「我的钱包」充值');
      user.walletBalance = (user.walletBalance ?? 0) - amount;
    } else if (paymentMethod === 'voucher') {
      if ((user.compVouchers ?? 0) < 1) throw new HttpError(402, '没有可用的补偿券');
      user.compVouchers = (user.compVouchers ?? 0) - 1;
    }
  }

  const booking: Booking = {
    id: nextId('bk'), code: `B-${db.counters.seq}`, userId, kind: req.kind, sessionId: req.sessionId,
    zoneId: req.zoneId, lane: req.lane, periodLabel: `${session.start}-${session.start.slice(0, 2)}:00`,
    age: req.age, healthPledge: true, healthCode: req.healthCode, medicalCert: req.medicalCert,
    withChildren: req.withChildren, childCount: req.childCount,
    childCompanion: req.childCompanion, childCompanionPhone: req.childCompanionPhone,
    swimLevel: req.swimLevel, partySize, childrenInParty,
    contactName: req.contactName, contactPhone: req.contactPhone, orgName: req.orgName,
    status: 'booked', paidAmount: amount, paymentMethod, createdAt: now(),
  };
  // 修正时段标签
  booking.periodLabel = `${session.start}-${session.end.split(':')[0]}:00`;
  db.bookings.unshift(booking);

  if (amount > 0) {
    db.walletTxns.unshift({
      id: nextId('tx'), at: now(), userId, amount: -amount,
      reason: `预约 ${booking.code} ${zone.name}（${paymentMethod === 'wallet' ? '储值' : paymentMethod === 'voucher' ? '补偿券' : '现金/对公'}）`,
      sessionId: session.id,
    });
  }

  // 机构包场同时写入商业锁区
  let conflictWarnings: string[] = [];
  if (req.kind === 'institution_rental') {
    const lock = {
      id: nextId('lock'), zoneId: req.zoneId, lane: req.lane, reason: 'institution_rental' as const,
      title: `${req.orgName}·包场`, contactName: req.contactName!, contactPhone: req.contactPhone!,
      capacity: partySize, isCommercial: true, bookingId: booking.id,
    };
    session.locks.push(lock);
    const rawConflicts = lockConflicts(db, session, lock);
    // 机构账号本身是居民角色：可获知冲突与挤压人数，但不回显其他居民预约码
    conflictWarnings = user.role === 'resident'
      ? rawConflicts.map((m) => m.replace(/B-\d{4}/g, '居民预约'))
      : rawConflicts;
    pushNotification(db, {
      title: `商业包场申请：${req.orgName}（${session.label}）`,
      body: `包场 ${zone.name} ${partySize} 人，联系人 ${req.contactName}。${conflictWarnings.length ? '检测到冲突：' + conflictWarnings.join('；') : '无直接冲突。'}`,
      level: conflictWarnings.length ? 'critical' : 'warning', roles: ['ops', 'frontdesk'], sessionId: session.id,
    });
  }

  // 预约超额自动立案，各角色围绕同场次处理
  if (overCapacity) {
    const inc = openIncident(db, session.id, 'overbooking', undefined,
      `${zone.name} 预约超出可用容量 ${zone.capacity - locked} 人（已锁 ${locked}），最新预约 ${booking.code}，请尽快加道/分流。`,
      user.name);
    pushNotification(db, {
      title: `预约超额预警 ${session.label}`, level: 'critical', roles: ['ops', 'frontdesk', 'lifeguard'],
      body: `${zone.name} 已预约 ${booked + partySize} 人 / 可用 ${zone.capacity - locked} 人，事件 #${inc.code} 已立案。`,
      sessionId: session.id,
    });
  }

  return { booking, overCapacity, conflictWarnings };
}

// ============ 前台核验入场 ============
export function checkIn(db: DB, bookingId: string, operator: string, req: {
  healthCode: 'green' | 'expired' | 'none'; medicalCert: boolean;
  childCompanion: string; childCompanionPhone: string; lockerNo: string;
}) {
  const b = db.bookings.find((x) => x.id === bookingId);
  if (!b) throw new HttpError(404, '预约不存在');
  if (b.status !== 'booked') throw new HttpError(409, `当前状态不可入场：${b.status}`);
  const session = db.sessions.find((s) => s.id === b.sessionId)!;
  if (session.poolStatus === 'closed') throw new HttpError(409, '本场已闭池，停止入场');
  if (session.poolStatus === 'restricted') throw new HttpError(409, `本场限流中：${session.statusReason || '水质/天气异常待复测'}，暂不放行`);
  if (session.poolStatus === 'partial' && (session.affectedZoneIds ?? []).includes(b.zoneId))
    throw new HttpError(409, `该泳区因${session.statusReason || '水质异常'}暂停开放，请为泳客改约其他泳区或办理退款`);
  // 预约泳道因抽筋救援临停：不得放行到该泳道（泳道级拦截，不影响同泳区其他泳道）
  const suspendedLane = b.lane != null
    ? (session.suspendedLanes ?? []).find((l) => l.zoneId === b.zoneId && l.lane === b.lane)
    : undefined;
  if (suspendedLane)
    throw new HttpError(409, `${b.lane} 号道因${suspendedLane.reason}临时关闭，请为泳客改道或稍后放行`);
  if (req.healthCode !== 'green') throw new HttpError(400, '健康码非绿码/已过期，请引导居民更新后再核验');

  const user = db.users.find((u) => u.id === b.userId)!;
  const zone = db.zones.find((z) => z.id === b.zoneId)!;
  if (zone.requireCert && !user.deepCert) throw new HttpError(403, '该泳客无深水合格证，不得进入深水区');
  if (b.withChildren || (b.childrenInParty ?? 0) > 0) {
    if (!req.childCompanion || !req.childCompanionPhone) throw new HttpError(400, '带儿童入场必须登记陪同人及联系电话');
  }
  if (!req.lockerNo.trim()) throw new HttpError(400, '请分配储物柜号');
  const clash = db.bookings.find((x) => x.status === 'checked_in' && x.lockerNo === req.lockerNo.trim());
  if (clash) throw new HttpError(409, `储物柜 ${req.lockerNo} 已被预约 ${clash.code} 使用，请先处理储物柜纠纷或换柜`);

  // 在池人数硬上限（容量扣除锁区）
  const { seats: locked } = zoneLocked(db, session, b.zoneId);
  const { inPool } = zoneCounts(db, session.id, b.zoneId);
  if (inPool + Math.max(1, b.partySize) > zone.capacity - locked) {
    const inc = db.incidents.find((i) => i.sessionId === session.id && i.type === 'overbooking' && i.status !== 'resolved')
      ?? openIncident(db, session.id, 'overbooking', undefined,
        `${zone.name} 入场核验时在池人数将达 ${inPool + b.partySize}，超出可用容量 ${zone.capacity - locked}，预约 ${b.code} 暂缓入场。`, operator);
    throw new HttpError(429, `${zone.name} 在池人数已达上限，请运营加道/分流后再放行（事件 #${inc.code}）`);
  }

  b.status = 'checked_in';
  b.checkedInAt = now();
  b.checkedInBy = operator;
  b.healthCode = req.healthCode;
  b.medicalCert = req.medicalCert;
  b.childCompanion = req.childCompanion || b.childCompanion;
  b.childCompanionPhone = req.childCompanionPhone || b.childCompanionPhone;
  b.lockerNo = req.lockerNo.trim();
  return b;
}

// ============ 水质检测 ============
export function addWaterReading(db: DB, recorder: string, req: { sessionId: string; tempC: number; freeChlorine: number; turbidity: number; ph: number; note?: string }) {
  const session = db.sessions.find((s) => s.id === req.sessionId);
  if (!session) throw new HttpError(404, '场次不存在');
  for (const [k, v] of Object.entries({ tempC: req.tempC, freeChlorine: req.freeChlorine, turbidity: req.turbidity, ph: req.ph })) {
    if (typeof v !== 'number' || Number.isNaN(v)) throw new HttpError(400, `${k} 数值不合法`);
  }
  const ev = evaluateWater(req);
  const reading: WaterReading = {
    id: nextId('w'), sessionId: req.sessionId, at: now(),
    tempC: req.tempC, freeChlorine: req.freeChlorine, turbidity: req.turbidity, ph: req.ph,
    recorder, abnormal: ev.abnormal, abnormalFields: ev.fields, note: req.note,
  };
  db.waterReadings.unshift(reading);

  if (ev.abnormal) {
    const open = db.incidents.find((i) => i.sessionId === session.id && i.type === 'water_abnormal' && i.status !== 'resolved');
    let inc = open;
    if (!inc) {
      inc = openIncident(db, session.id, 'water_abnormal', undefined,
        `检测超标：${ev.fields.join('；')}。记录人 ${recorder}。`, recorder);
      reading.eventId = inc.id;
      // 自动限流：异常期间暂停新入场，等待运营复测/闭池决策
      if (session.poolStatus === 'normal') {
        session.poolStatus = 'restricted';
        session.statusReason = '水质异常，暂停新入场，等待复测';
        session.requireWaterRetest = true;
      }
      db.workTasks.unshift({
        id: nextId('wt'), sessionId: session.id, kind: 'disinfection',
        title: '水质异常处置：加药/反冲洗并复测', detail: ev.fields.join('；'),
        zoneId: 'all', assigneeRole: 'maintenance', status: 'pending',
        createdAt: now(), source: 'incident', incidentId: inc.id,
      });
    } else {
      inc.actions.push({ id: nextId('ia'), at: now(), by: recorder, byRole: 'lifeguard', content: `复测数据：${ev.fields.join('；')}（仍异常）` });
      reading.eventId = inc.id;
    }
    pushNotification(db, {
      title: `水质异常 ${session.label}`, body: ev.fields.join('；'),
      level: 'critical', roles: ['ops', 'lifeguard', 'maintenance', 'frontdesk'], sessionId: session.id,
    });
  } else {
    const open = db.incidents.find((i) => i.sessionId === session.id && i.type === 'water_abnormal' && i.status !== 'resolved');
    if (open) {
      open.actions.push({ id: nextId('ia'), at: now(), by: recorder, byRole: 'lifeguard',
        content: `复测达标：水温 ${req.tempC}°C / 余氯 ${req.freeChlorine}mg/L / 浊度 ${req.turbidity}NTU / pH ${req.ph}` });
      pushNotification(db, {
        title: `水质复测已达标 ${session.label}`, body: '请运营确认后恢复开放。',
        level: 'info', roles: ['ops', 'lifeguard', 'maintenance'], sessionId: session.id,
      });
    }
  }
  return reading;
}

// ============ 巡查 ============
const PATROL_ASSIGNEE: Record<string, Role> = {
  diving: 'lifeguard', child_alone: 'lifeguard', wet_floor: 'cleaner',
  shower_crowd: 'cleaner', water_quality: 'maintenance', guard_missing: 'ops', other: 'ops',
};

export function addPatrolIssue(db: DB, reporter: string, req: {
  sessionId: string; type: PatrolIssue['type']; severity: PatrolIssue['severity'];
  description: string; location: string; assigneeRole?: Role;
}) {
  const session = db.sessions.find((s) => s.id === req.sessionId);
  if (!session) throw new HttpError(404, '场次不存在');
  const role = req.assigneeRole ?? PATROL_ASSIGNEE[req.type] ?? 'ops';
  const assignee = db.users.find((u) => u.role === role);
  const issue: PatrolIssue = {
    id: nextId('pi'), sessionId: req.sessionId, at: now(),
    type: req.type, severity: req.severity, description: req.description, location: req.location,
    reporter, assigneeRole: role, assigneeName: assignee?.name, status: 'open',
  };
  db.patrolIssues.unshift(issue);
  if (role === 'cleaner' || role === 'maintenance') {
    db.workTasks.unshift({
      id: nextId('wt'), sessionId: req.sessionId,
      kind: role === 'maintenance' ? (req.type === 'water_quality' ? 'disinfection' : 'maintenance') : 'cleaning',
      title: `巡查问题处置：${req.location}`, detail: req.description, zoneId: 'all',
      assigneeRole: role, status: 'pending', createdAt: now(), source: 'patrol',
    });
  }
  pushNotification(db, {
    title: `巡查上报（${session.label}）`, body: `${req.location}：${req.description}`,
    level: req.severity === 'critical' ? 'critical' : 'warning', roles: [role, 'ops'], sessionId: session.id,
  });
  return issue;
}
// ============ 闭池 / 恢复开放（不可变档案 + 联动编排，支持同场次多次闭池） ============
export function changePoolStatus(db: DB, operator: string, req: {
  sessionId: string; status: PoolStatus; reason?: string; cause?: IncidentType | 'other';
  refund?: boolean; compVoucher?: boolean; notifyResidents?: boolean; requireWaterRetest?: boolean;
  disposition?: 'closed' | 'partial' | 'postponed';
  affectedZoneIds?: ZoneId[];
  retestPlannedAt?: string;
  postponeToSessionId?: string;
  checkedInVoucher?: boolean;
}) {
  const session = db.sessions.find((s) => s.id === req.sessionId);
  if (!session) throw new HttpError(404, '场次不存在');
  const prev = session.poolStatus;
  session.closureIds = session.closureIds ?? [];

  // 部分开放 / 延期都属于“处置”，默认落为闭池类处置方式
  const disposition = req.disposition ?? 'closed';

  // ---------- 恢复开放：以“当前生效闭池档案”为唯一门禁依据，历史档案不可变 ----------
  if (req.status === 'normal') {
    if (prev !== 'closed' && prev !== 'restricted' && prev !== 'partial') return { session, reopened: false as const };
    const active = session.activeClosureId
      ? db.closureRecords.find((r) => r.id === session.activeClosureId)
      : undefined;
    if (!active) {
      // 限流（无闭池档案）：处置完成后直接解除限流，不涉及闭池门禁
      session.poolStatus = 'normal';
      session.statusReason = undefined;
      session.reopenedAt = now();
      pushNotification(db, {
        title: `限流解除：${session.label}`, level: 'info', roles: [],
        body: '现场异常已处置，限流解除，恢复正常入场。', sessionId: session.id,
      });
      return { session, reopened: true as const, closure: undefined };
    }

    // 仅核验本轮闭池联动生成的工单（closureId 精确匹配，其他场次/例行工单不算数）
    const taskResult = (kind: 'cleaning' | 'disinfection') => {
      const t = db.workTasks.find((x) => active.taskIds.includes(x.id) && x.kind === kind);
      if (!t) return { ok: false as const, reason: '缺少联动处置工单', task: undefined as WorkTask | undefined };
      if (t.status !== 'done') return { ok: false as const, reason: `${t.title}仍为${t.status === 'in_progress' ? '处理中' : '待处理'}`, task: t };
      return { ok: true as const, reason: '', task: t };
    };
    const cleaning = taskResult('cleaning');
    const disinfection = taskResult('disinfection');

    let retestReading: WaterReading | undefined;
    if (active.requireWaterRetest) {
      retestReading = db.waterReadings.find(
        (w) => w.sessionId === session.id && w.at > active.closedAt && !w.abnormal,
      );
    }

    // 门禁按处置方式区分：部分开放/延期无需全场清场（清场工单可能未生成或非必需）
    const needCleaning = active.disposition === 'closed';
    // 任一门禁未完成：拒绝恢复，且不改动场次状态、不发送恢复通知、不改动档案与退费补偿
    const missing: string[] = [];
    if (needCleaning && !cleaning.ok) missing.push(`清场清洁未完成（${cleaning.reason}）`);
    if (!disinfection.ok) missing.push(`消毒复测未完成（${disinfection.reason}）`);
    if (active.requireWaterRetest && !retestReading) missing.push('尚无晚于本轮闭池时间的达标水质复测读数');
    if (missing.length) {
      throw new HttpError(409, `本轮处置尚未完成，不能恢复开放：${missing.join('；')}。恢复开放必须以本轮处置事件为唯一依据，消毒复测与必要的达标水质全部完成后方可放行。`);
    }

    const at = now();
    session.poolStatus = 'normal';
    session.statusReason = undefined;
    session.reopenedAt = at;
    session.requireWaterRetest = false;
    session.activeClosureId = undefined;
    session.affectedZoneIds = undefined;
    session.retestPlannedAt = undefined;

    // 回写本轮档案（仅回写恢复结果；闭池原因/退费/补偿等历史字段不变）
    active.status = 'reopened';
    active.reopenedAt = at;
    active.reopenedBy = operator;
    if (retestReading) active.retestReadingId = retestReading.id;
    active.reopenNote = '本轮清场清洁、消毒复测与水质复测全部完成，恢复开放';
    active.reopenChecklist = {
      cleaning: cleaning.task ? {
        taskId: cleaning.task.id, title: cleaning.task.title, kind: cleaning.task.kind,
        assigneeRole: cleaning.task.assigneeRole, assigneeName: cleaning.task.assigneeName,
        doneAt: cleaning.task.doneAt!, result: cleaning.task.result,
      } : null,
      disinfection: disinfection.task ? {
        taskId: disinfection.task.id, title: disinfection.task.title, kind: disinfection.task.kind,
        assigneeRole: disinfection.task.assigneeRole, assigneeName: disinfection.task.assigneeName,
        doneAt: disinfection.task.doneAt!, result: disinfection.task.result,
      } : null,
      water: retestReading ? {
        readingId: retestReading.id, at: retestReading.at, recorder: retestReading.recorder,
        tempC: retestReading.tempC, freeChlorine: retestReading.freeChlorine,
        turbidity: retestReading.turbidity, ph: retestReading.ph,
      } : null,
    };

    const reason = active.reason;
    const seq = `第${toZh(active.seq)}轮`;
    const reopenIds: string[] = [];
    const n1 = pushNotification(db, {
      title: `恢复开放：${session.label}`, level: 'info', roles: [],
      body: `${seq}闭池（${reason}）已结束：清场清洁、消毒复测${retestReading ? '与达标水质复测' : ''}均已完成，泳池恢复开放。本轮退费与补偿券已发放，居民可重新预约后续场次。`,
      sessionId: session.id, closureId: active.id,
    });
    const n2 = pushNotification(db, {
      title: `恢复开放提醒：${session.label}`, level: 'info', roles: ['lifeguard', 'frontdesk', 'cleaner'],
      body: '请救生员重新到岗、前台恢复核验、保洁完成开场清洁。', sessionId: session.id, closureId: active.id,
    });
    reopenIds.push(n1, n2);
    active.reopenNotificationIds = reopenIds;

    return { session, reopened: true as const, closure: active };
  }

  if (req.status === 'restricted') {
    session.poolStatus = 'restricted';
    session.statusReason = req.reason || '现场异常，限流管理';
    pushNotification(db, {
      title: `限流：${session.label}`, level: 'warning', roles: STAFF_ROLES,
      body: session.statusReason, sessionId: session.id,
    });
    return { session, reopened: false as const };
  }

  // ---------- 生成一份新的不可变处置档案（闭池 / 部分开放 / 延期） ----------
  if (prev === 'closed' || prev === 'partial') throw new HttpError(409, '该场次已处于处置状态，请先恢复开放后再发起新一轮处置');

  // 延期必须指定目标场次；在修改任何状态前完成目标场开放状态与容量预检（失败则整体拒绝、不留死单）
  let postponeTarget: Session | undefined;
  if (disposition === 'postponed') {
    if (!req.postponeToSessionId) throw new HttpError(400, '延期处置必须选择顺延目标场次');
    postponeTarget = db.sessions.find((s) => s.id === req.postponeToSessionId);
    if (!postponeTarget) throw new HttpError(404, '顺延目标场次不存在');
    if (postponeTarget.id === session.id) throw new HttpError(400, '不能顺延到当前场次');
    if (postponeTarget.poolStatus === 'closed' || postponeTarget.poolStatus === 'partial')
      throw new HttpError(409, `顺延目标场次「${postponeTarget.label}」已闭池或部分开放，无法承接，请改选其他场次`);
  }

  const at = now();
  const reason = req.reason || (disposition === 'postponed' ? '场次延期' : '临时闭池');
  const waterCause = req.cause === 'water_abnormal' || /水质|余氯|浊度|水温/.test(reason);
  const requireRetest = req.requireWaterRetest ?? waterCause;
  const seq = (session.closureIds?.length ?? 0) + 1;
  const closureId = nextId('closure');

  // 受影响泳区：闭池=全部；部分开放=指定；延期=全部
  const allZoneIds = db.zones.map((z) => z.id);
  const affectedZoneIds: ZoneId[] = disposition === 'partial'
    ? (req.affectedZoneIds ?? [])
    : allZoneIds;
  if (disposition === 'partial' && affectedZoneIds.length === 0)
    throw new HttpError(400, '部分开放必须选择至少一个暂停使用的泳区');
  const zoneAffected = (zoneId: ZoneId) => affectedZoneIds.includes(zoneId);

  // 场次状态：部分开放=partial；闭池/延期=closed（延期对现场等同于暂停当前场）
  const poolStatus: PoolStatus = disposition === 'partial' ? 'partial' : 'closed';

  // 课程/预约自动顺延目标：优先同日后续且未闭池的场次，其次任意其他场（缓存保证课程与学员迁同一场）
  let _autoTarget: Session | undefined | null = null;
  const autoTarget = (): Session | undefined => {
    if (_autoTarget !== null) return _autoTarget;
    _autoTarget = db.sessions
      .filter((s) => s.id !== session.id && s.poolStatus !== 'closed' && s.poolStatus !== 'partial'
        && s.date === session.date && s.start >= session.start)
      .sort((a, b) => a.start.localeCompare(b.start))[0]
      ?? db.sessions.find((s) => s.id !== session.id);
    return _autoTarget;
  };

  // 受影响预约：仅统计受影响泳区内的有效预约（部分开放时其余泳区预约不受影响、可正常核验）
  const affectedBookings = db.bookings.filter(
    (b) => b.sessionId === session.id
      && (b.status === 'booked' || b.status === 'checked_in')
      && zoneAffected(b.zoneId),
  );

  const affected: ClosureAffectedItem[] = [];
  const notificationIds: string[] = [];
  // 按原支付渠道分别统计，互不混记
  let walletRefundTotal = 0;
  let walletRefundCount = 0;
  let cashRefundTotal = 0;
  let cashRefundCount = 0;
  let originalVoucherReturnCount = 0;
  let extraVoucherCount = 0;
  let processedCount = 0;
  const groupCounts: Record<AffectedGroup, number> = { checked_in: 0, not_checked_in: 0, coaching: 0 };

  const pushN = (n: Omit<Notification, 'id' | 'at'>) => {
    db.notifications.unshift({ ...n, id: nextId('nt'), at: now() });
    if (db.notifications.length > 400) db.notifications.length = 400;
    notificationIds.push(db.notifications[0].id);
    return db.notifications[0];
  };

  /** 逐居民聚合通知文案（一人多笔只发一条个人通知） */
  const perUser = new Map<string, { texts: string[]; extra: boolean }>();

  // 教练课：判定一笔预约是否为教练课（kind=coaching）归入教练课组；普通泳道预约即使本人是学员也按已入场/未入场处理
  const isCoachingBooking = (b: Booking) => b.kind === 'coaching';
  // 本场课程（用于课程顺延与学员/机构通知，独立于预约分组）
  const lessonsInSession = db.lessons.filter((l) => l.sessionId === session.id);

  // 延期：先预算目标场各泳区迁入人数（未入场普通预约 + 教练课预约），容量不足整体拒绝
  if (disposition === 'postponed' && postponeTarget) {
    const incoming = new Map<ZoneId, number>();
    for (const b of affectedBookings) {
      if (b.status === 'checked_in') continue; // 已入场人在现场，不迁移
      incoming.set(b.zoneId, (incoming.get(b.zoneId) ?? 0) + Math.max(1, b.partySize));
    }
    for (const [zid, add] of incoming) {
      const zone = db.zones.find((z) => z.id === zid)!;
      const { seats: locked } = zoneLocked(db, postponeTarget, zid);
      const { inPool, booked } = zoneCounts(db, postponeTarget.id, zid);
      if (inPool + booked + locked + add > zone.capacity) {
        throw new HttpError(409, `顺延目标场次「${postponeTarget.label}」的${zone.name}容量不足（现有在池 ${inPool}+待入 ${booked}+锁定 ${locked}+迁入 ${add} > 容量 ${zone.capacity}），请改选其他场次或改约泳区`);
      }
    }
  }

  // 所有前置校验通过后才修改当前场次状态（容量不足/目标关闭时上面已整体拒绝，原预约保持不变）
  session.poolStatus = poolStatus;
  session.statusReason = reason;
  if (poolStatus === 'closed') session.closedAt = at;
  session.settled = true;
  session.requireWaterRetest = requireRetest;
  session.activeClosureId = closureId;
  session.reopenedAt = undefined;
  session.affectedZoneIds = affectedZoneIds;
  session.retestPlannedAt = req.retestPlannedAt;

  /**
   * 延期/部分开放时把预约真实迁移到目标场次：在目标场生成一笔 booked 新预约，
   * 原预约标记 postponed 并双向关联；不退款、不二次扣款。返回新预约。
   */
  const migrateBooking = (b: Booking, target: Session): Booking => {
    const id = nextId('bk');
    const newBooking: Booking = {
      ...b,
      id,
      code: `B-${db.counters.seq}`,
      sessionId: target.id,
      periodLabel: `${target.start}-${target.end}`,
      status: 'booked',
      lockerNo: undefined,
      checkedInAt: undefined,
      checkedInBy: undefined,
      createdAt: now(),
      closureIds: [closureId],
      postponeToSessionId: undefined,
      postponedFromSessionId: undefined,
      postponedBookingId: undefined,
      migratedFromBookingId: b.id,
      migratedClosureId: closureId,
    };
    db.bookings.unshift(newBooking);
    b.status = 'postponed';
    b.postponedFromSessionId = session.id;
    b.postponeToSessionId = target.id;
    b.postponedBookingId = newBooking.id;
    return newBooking;
  };

  for (const b of affectedBookings) {
    const u = db.users.find((x) => x.id === b.userId);
    if (!u) continue;
    const coaching = isCoachingBooking(b);
    const group: AffectedGroup = coaching ? 'coaching'
      : b.status === 'checked_in' ? 'checked_in' : 'not_checked_in';
    groupCounts[group]++;
    const item: ClosureAffectedItem = {
      bookingId: b.id, bookingCode: b.code, userId: u.id, userName: u.name,
      paidAmount: b.paidAmount, paymentMethod: b.paymentMethod, refunded: false,
      refund: null, extraCompVoucher: false, voucherGranted: false,
      group, inAffectedZone: true,
    };

    let actionText = '';

    // ---- 教练课人群：受影响泳区的课程一律顺延（部分开放/闭池/延期），不退费 ----
    if (group === 'coaching') {
      const target = postponeTarget ?? autoTarget();
      if (target) {
        const nb = migrateBooking(b, target);
        item.postponed = true;
        item.postponeToSessionId = target.id;
        item.migratedBookingId = nb.id;
        actionText = `教练课顺延至「${target.label}」（新预约 ${nb.code} 可核验），费用保留不作退款`;
      } else {
        actionText = '教练课顺延安排将另行通知';
      }
    } else if (group === 'checked_in') {
      // ---- 已入场：人在现场，任何处置方式下都提前清场、发安抚券，不迁移 ----
      if (req.checkedInVoucher !== false) {
        u.compVouchers = (u.compVouchers ?? 0) + 1;
        extraVoucherCount++;
        item.extraCompVoucher = true;
        item.voucherGranted = true;
        item.refund = null;
        b.status = 'compensated';
        actionText = disposition === 'postponed'
          ? '您已入场，场次延期现场提前清场，发放 1 张安抚补偿券（不退现金、不迁移）'
          : '您已入场，现场提前清场，发放 1 张安抚补偿券（不退现金）';
      } else {
        b.status = 'refunded';
        actionText = '您已入场，现场提前清场，已登记现场处置（不退款）';
      }
    } else if (disposition === 'postponed') {
      // ---- 延期：未入场预约真实迁移到目标场次（生成可核验新预约），不退费 ----
      const target = postponeTarget!;
      const nb = migrateBooking(b, target);
      item.postponed = true;
      item.postponeToSessionId = target.id;
      item.migratedBookingId = nb.id;
      actionText = `预约顺延至「${target.label}」（新预约 ${nb.code} 可核验），费用保留`;
    } else {
      // ---- 未入场：原路全额退款 + 可选补偿券 ----
      let refundText = '';
      if (req.refund) {
        processedCount++;
        item.refunded = true;
        if (b.paymentMethod === 'wallet' && b.paidAmount > 0) {
          u.walletBalance = (u.walletBalance ?? 0) + b.paidAmount;
          const tx = {
            id: nextId('tx'), at: now(), userId: u.id, amount: b.paidAmount,
            reason: `第${toZh(seq)}轮处置原路退储值 ${b.code}（${reason}）`,
            sessionId: session.id, closureId,
          };
          db.walletTxns.unshift(tx);
          walletRefundTotal += b.paidAmount;
          walletRefundCount++;
          item.refund = { channel: 'wallet', refunded: true, amount: b.paidAmount, walletTxnId: tx.id };
          refundText = `${b.paidAmount} 元已原路退回您的储值余额`;
        } else if (b.paymentMethod === 'voucher') {
          u.compVouchers = (u.compVouchers ?? 0) + 1;
          originalVoucherReturnCount++;
          item.refund = { channel: 'voucher', originalVoucherReturned: true, returnedCount: 1 };
          refundText = '原预约使用的 1 张补偿券已返还至您的账户';
        } else if (b.paymentMethod === 'cash' && b.paidAmount > 0) {
          cashRefundTotal += b.paidAmount;
          cashRefundCount++;
          const note = `凭预约码 ${b.code} 到前台办理现场退款 ${b.paidAmount} 元（原路为现场支付，不退入储值）`;
          item.refund = { channel: 'cash', registered: true, amount: b.paidAmount, note };
          refundText = note;
        } else if (b.paidAmount === 0) {
          item.refund = { channel: 'cash', registered: false, amount: 0, note: '公益免费预约，无需退款' };
          refundText = '本场为公益免费预约，无需退款';
        }
      }
      let extraText = '';
      if (req.compVoucher) {
        u.compVouchers = (u.compVouchers ?? 0) + 1;
        extraVoucherCount++;
        item.extraCompVoucher = true;
        item.voucherGranted = true;
        b.status = 'compensated';
        extraText = '另额外发放 1 张补偿券（可抵一次入场，与原支付返还分开）';
      } else if (req.refund) {
        b.status = 'refunded';
      }
      actionText = [refundText, extraText].filter(Boolean).join('；');
    }
    b.closureIds = [...(b.closureIds ?? []), closureId];

    if (req.notifyResidents) {
      const agg = perUser.get(u.id) ?? { texts: [], extra: false };
      agg.texts.push(`${b.code}：${actionText || '预约已取消'}`);
      if (item.extraCompVoucher) agg.extra = true;
      perUser.set(u.id, agg);
    }
    affected.push(item);
  }

  // ---- 教练课顺延：更新课程场次、通知学员与机构 ----
  const lessonPostponements: ClosureLessonPostpone[] = [];
  const lessonsToMove = lessonsInSession.filter((l) => zoneAffected(l.zoneId));
  for (const lesson of lessonsToMove) {
    const target = disposition === 'postponed' ? postponeTarget : autoTarget();
    if (!target) continue;
    lesson.sessionId = target.id;
    lesson.postponed = { fromSessionId: session.id, toSessionId: target.id, at, closureId };
    // 学员通知（教练课人群）
    for (const stuId of lesson.studentIds) {
      if (req.notifyResidents) {
        pushN({
          title: `教练课顺延通知：${lesson.title}`, level: 'warning', roles: [], userId: stuId,
          sessionId: target.id, closureId,
          body: `因「${session.label}」${reason}，${lesson.coachName}的《${lesson.title}》顺延至「${target.label}」，费用保留，请按时到场。`,
        });
      }
    }
    // 机构通知：培训机构账号或教练（演示中机构账号 u-lan）
    const institution = db.users.find((u) => u.memberTier === 'institution');
    let notifId: string | undefined;
    if (institution && req.notifyResidents) {
      const n = pushN({
        title: `机构通知：教练课顺延（${lesson.title}）`, level: 'warning', roles: [],
        userId: institution.id, sessionId: target.id, closureId,
        body: `贵机构/团队相关课程《${lesson.title}》因${reason}由「${session.label}」顺延至「${target.label}」，涉及学员 ${lesson.studentIds.length} 人，请协调教练与场地。`,
      });
      notifId = n.id;
      lesson.institutionNotifiedUserIds = [...(lesson.institutionNotifiedUserIds ?? []), institution.id];
    }
    lessonPostponements.push({
      lessonId: lesson.id, lessonTitle: lesson.title, coachName: lesson.coachName,
      fromSessionId: session.id, toSessionId: target.id, studentCount: lesson.studentIds.length,
      institutionNotified: !!notifId, notificationId: notifId,
    });
  }

  // 每位受影响居民只发一条合并的个人通知（区分已入场/未入场/教练课口径）
  const dispositionLabel = disposition === 'partial' ? '部分泳区暂停开放'
    : disposition === 'postponed' ? '场次延期' : '闭池';
  for (const [uid, agg] of perUser) {
    const n = pushN({
      title: `${dispositionLabel}通知（第${toZh(seq)}轮）：${session.label}`,
      body: `原因：${reason}。您的受影响预约：${agg.texts.join('；')}。${req.retestPlannedAt ? `计划复测时间 ${fmtClock(req.retestPlannedAt)}。` : ''}后续安排请以通知为准。`,
      level: 'critical', roles: [], userId: uid, sessionId: session.id, closureId,
    });
    for (const a of affected) if (a.userId === uid) a.notificationId = n.id;
  }

  if (req.notifyResidents) {
    pushN({
      title: `【${dispositionLabel}·第${toZh(seq)}轮】${session.label}`, level: 'critical', roles: [],
      body: `${reason}。受影响泳区 ${affectedZoneIds.length}/${allZoneIds.length} 个；储值退款 ${walletRefundCount} 笔、原券返还 ${originalVoucherReturnCount} 张、现场退款登记 ${cashRefundCount} 笔、补偿/安抚券 ${extraVoucherCount} 张、教练课顺延 ${lessonPostponements.length} 节。`,
      sessionId: session.id, closureId,
    });
  }

  // 救生巡查同步：完全闭池撤全部在岗救生员；部分开放只撤受影响泳区对应岗（简化：记录清场人数但保留其他岗）
  let guardReliefCount = 0;
  for (const d of db.guardDuties) {
    if (d.sessionId === session.id && !d.end) {
      if (disposition === 'closed' || disposition === 'postponed') {
        d.end = now();
        d.note = `第${toZh(seq)}轮${dispositionLabel}清场：${reason}`;
        guardReliefCount++;
      }
    }
  }

  // 工单：完全闭池生成消毒复测+清场清洁；部分开放/延期只生成受影响泳区消毒复测
  const taskIds: string[] = [];
  const disinfection: WorkTask = {
    id: nextId('wt'), sessionId: session.id, kind: 'disinfection',
    title: `第${toZh(seq)}轮${dispositionLabel}后消毒与水质复测`,
    detail: `原因：${reason}。受影响泳区：${affectedZoneIds.join('、') || '全部'}。恢复开放前须提交达标水质读数。`,
    zoneId: 'all', assigneeRole: 'maintenance', status: 'pending',
    createdAt: now(), source: 'closure', closureId,
  };
  db.workTasks.unshift(disinfection);
  taskIds.push(disinfection.id);
  if (disposition === 'closed' || disposition === 'postponed') {
    const cleaning: WorkTask = {
      id: nextId('wt'), sessionId: session.id, kind: 'cleaning',
      title: `第${toZh(seq)}轮${dispositionLabel}清场清洁`,
      detail: '清场后清洁池岸、淋浴区、更衣室，检查遗落物品。',
      zoneId: 'all', assigneeRole: 'cleaner', status: 'pending',
      createdAt: now(), source: 'closure', closureId,
    };
    db.workTasks.unshift(cleaning);
    taskIds.push(cleaning.id);
  }

  // 关联事件追加联动记录
  const incidentIds: string[] = [];
  if (req.cause && req.cause !== 'other') {
    const inc = db.incidents.find((i) => i.sessionId === session.id && i.type === req.cause && i.status !== 'resolved');
    if (inc) {
      inc.actions.push({
        id: nextId('ia'), at: now(), by: operator, byRole: 'ops',
        content: `第${toZh(seq)}轮${dispositionLabel}联动：储值退款 ${walletRefundCount} 笔、原券返还 ${originalVoucherReturnCount} 张、现场退款 ${cashRefundCount} 笔、补偿券 ${extraVoucherCount} 张、课程顺延 ${lessonPostponements.length} 节、复测计划 ${req.retestPlannedAt ? fmtClock(req.retestPlannedAt) : '待定'}。`,
      });
      incidentIds.push(inc.id);
    }
  }

  // ---------- 固化不可变处置档案 ----------
  const migrationMap = new Map<string, number>();
  for (const a of affected) {
    if (a.migratedBookingId && a.postponeToSessionId)
      migrationMap.set(a.postponeToSessionId, (migrationMap.get(a.postponeToSessionId) ?? 0) + 1);
  }
  const migrationSummary = [...migrationMap.entries()].map(([sid, count]) => ({
    sessionId: sid,
    sessionLabel: db.sessions.find((s) => s.id === sid)?.label ?? sid,
    count,
  }));
  const record: ClosureRecord = {
    id: closureId, seq, sessionId: session.id, sessionLabel: session.label,
    cause: req.cause ?? 'other', reason, closedAt: at, closedBy: operator,
    status: 'closed', disposition, affectedZoneIds,
    retestPlannedAt: req.retestPlannedAt,
    postponeToSessionId: disposition === 'postponed' ? postponeTarget?.id : undefined,
    requireWaterRetest: requireRetest,
    options: { refund: !!req.refund, compVoucher: !!req.compVoucher, notifyResidents: !!req.notifyResidents },
    affected,
    walletRefundTotal, walletRefundCount,
    cashRefundTotal, cashRefundCount,
    originalVoucherReturnCount, extraVoucherCount,
    refundCount: processedCount,
    announcementIds: notificationIds, guardReliefCount, taskIds, incidentIds,
    lessonPostponements, groupCounts,
    migratedBookingCount: affected.filter((a) => a.migratedBookingId).length,
    migrationSummary: migrationSummary,
  };
  db.closureRecords.unshift(record);
  session.closureIds.push(closureId);

  pushN({
    title: `${dispositionLabel}处置完成（第${toZh(seq)}轮）：${session.label}`, level: 'critical', roles: STAFF_ROLES,
    body: `储值退款 ${walletRefundCount} 笔(¥${walletRefundTotal}) / 原券返还 ${originalVoucherReturnCount} 张 / 现场退款 ${cashRefundCount} 笔(¥${cashRefundTotal}) / 补偿安抚券 ${extraVoucherCount} 张 / 课程顺延 ${lessonPostponements.length} 节 / 已入场 ${groupCounts.checked_in}、未入场 ${groupCounts.not_checked_in}、教练课 ${groupCounts.coaching}。档案号 ${closureId}。`,
    sessionId: session.id, closureId,
  });

  return {
    session, closure: record,
    walletRefundTotal, walletRefundCount,
    cashRefundTotal, cashRefundCount,
    originalVoucherReturnCount, extraVoucherCount,
    lessonPostponed: lessonPostponements.length,
    affected: affected.length, reopened: false as const,
  };
}

function fmtClock(iso: string) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function toZh(n: number) {
  const map = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  return n <= 10 ? map[n] : String(n);
}

// ============ 实时看板 ============
export function pickCurrentSession(db: DB): Session {
  const hm = new Date().toTimeString().slice(0, 5);
  const todayStr = new Date().toISOString().slice(0, 10);
  const todays = db.sessions.filter((s) => s.date === todayStr);
  return todays.find((s) => hm >= s.start && hm <= s.end)
    ?? todays.find((s) => hm < s.start)
    ?? todays[0]
    ?? db.sessions[0];
}

export function liveBoard(db: DB, sessionId?: string): LiveBoard {
  const session = (sessionId && db.sessions.find((s) => s.id === sessionId)) || pickCurrentSession(db);
  const zones: ZoneLiveStat[] = db.zones.map((z) => {
    const { inPool, booked, children, deepHolders } = zoneCounts(db, session.id, z.id);
    const { seats: locked } = zoneLocked(db, session, z.id);
    const usable = Math.max(1, z.capacity - locked);
    return {
      zoneId: z.id, name: z.name, capacity: z.capacity, inPool, booked, children, locked,
      deepCertRequired: z.requireCert, deepCertHoldersInPool: deepHolders,
      occupancyPct: Math.round((inPool / usable) * 100),
    };
  });
  const water = db.waterReadings.find((w) => w.sessionId === session.id) ?? null;
  const openIncidents = db.incidents.filter((i) => i.sessionId === session.id && i.status !== 'resolved');
  const guardOnDuty = db.guardDuties
    .filter((d) => d.sessionId === session.id && !d.end)
    .map((d) => ({
      post: d.post as GuardPost, postLabel: GUARD_POST_LABEL[d.post],
      guardName: db.users.find((u) => u.id === d.guardUserId)?.name ?? '未知', startedAt: d.start,
    }));
  return {
    session,
    zones,
    totalInPool: zones.reduce((s, z) => s + z.inPool, 0),
    totalCapacity: db.zones.reduce((s, z) => s + z.capacity, 0),
    water, openIncidents, guardOnDuty,
    poolStatus: session.poolStatus,
    thunderAlert: openIncidents.some((i) => i.type === 'thunderstorm'),
    equipment: db.equipment,
    focusLanes: session.guardFocusLanes ?? [],
    suspendedLanes: session.suspendedLanes ?? [],
  };
}

/** 场次完整状态：预约 → 入场 → 巡查 → 清场 */
export function sessionDetail(db: DB, id: string) {
  const session = db.sessions.find((s) => s.id === id);
  if (!session) throw new HttpError(404, '场次不存在');
  const bookings = db.bookings.filter((b) => b.sessionId === id).map((b) => ({
    ...b, userName: db.users.find((u) => u.id === b.userId)?.name ?? '已删除用户',
    userPhone: db.users.find((u) => u.id === b.userId)?.phone,
    memberTier: db.users.find((u) => u.id === b.userId)?.memberTier,
  }));
  const conflicts = session.locks.flatMap((l) =>
    lockConflicts(db, session, l).map((message) => ({ lockTitle: l.title, message })));
  const hm = new Date().toTimeString().slice(0, 5);
  const stage = session.poolStatus === 'closed' ? 'closed'
    : hm < session.start ? 'booking' : hm > session.end ? 'cleared' : 'live';
  // 本场历次闭池档案，按发生先后排序（不可变快照）
  const closureRecords = (session.closureIds ?? [])
    .map((cid) => db.closureRecords.find((r) => r.id === cid))
    .filter((r): r is ClosureRecord => !!r);
  return {
    session, stage,
    bookings,
    locks: session.locks,
    closureRecords,
    waterReadings: db.waterReadings.filter((w) => w.sessionId === id),
    patrolIssues: db.patrolIssues.filter((p) => p.sessionId === id),
    incidents: db.incidents.filter((i) => i.sessionId === id),
    guardDuties: db.guardDuties.filter((d) => d.sessionId === id).map((d) => ({
      ...d, guardName: db.users.find((u) => u.id === d.guardUserId)?.name ?? '未知',
    })),
    workTasks: db.workTasks.filter((w) => w.sessionId === id),
    conflicts,
    counts: {
      booked: bookings.filter((b) => b.status === 'booked').length,
      checkedIn: bookings.filter((b) => b.status === 'checked_in').length,
      refunded: bookings.filter((b) => b.status === 'refunded' || b.status === 'compensated').length,
      peopleInPool: bookings.filter((b) => b.status === 'checked_in').reduce((s, b) => s + Math.max(1, b.partySize), 0),
    },
  };
}

// ============ 派生：全局冲突摘要 ============
export function conflictSummary(db: DB) {
  const out: { sessionId: string; sessionLabel: string; message: string }[] = [];
  for (const s of db.sessions) {
    for (const l of s.locks) {
      for (const message of lockConflicts(db, s, l)) {
        out.push({ sessionId: s.id, sessionLabel: s.label, message: `【${l.title}】${message}` });
      }
    }
  }
  // 机构包场协调中的冲突（未完成/未驳回），运营与前台需在全局冲突看板跟进
  for (const r of db.rentals) {
    if (['completed', 'rejected', 'cancelled'].includes(r.status)) continue;
    const inst = db.institutions.find((i) => i.id === r.institutionId);
    const instLabel = inst?.name ?? '机构';
    const session = db.sessions.find((s) => s.id === r.sessionId);
    if (!session) continue;
    const unresolved = r.residentConflicts.filter((c) => !c.resolution).length;
    for (const m of r.conflictPreview.conflicts.slice(0, 3)) {
      out.push({ sessionId: session.id, sessionLabel: session.label, message: `【${r.code}·${instLabel}包场】${m}` });
    }
    if (unresolved > 0) {
      out.push({ sessionId: session.id, sessionLabel: session.label, message: `【${r.code}·${instLabel}包场】尚有 ${unresolved} 笔居民预约待协调（不得覆盖），状态：${r.status}` });
    }
  }
  return out;
}
