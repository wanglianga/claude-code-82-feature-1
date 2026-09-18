import type {
  DB, User, Session, Booking, ZoneId, ZoneLock,
  Institution, InstitutionRental, InstitutionBill, InstitutionBillItem,
  QualificationKey, QualificationItem, CoachAssignment, FacilityInfo,
  RentalConflictPreview, RentalResidentConflict, ResidentTag,
  RentalCoordination, RentalGateKey, RentalClearanceKey,
  RentalViolation, CreditEvent,
} from '../shared/types.js';
import {
  QUALIFICATION_LABEL,
} from '../shared/types.js';
import {
  buildRentalBillItems, billTotal, hoursBetween, requiredCompanions,
} from '../shared/logic.js';
import { nextId } from './store.js';
import { HttpError, activeBookings, zoneLocked, zoneCounts, pushNotification, openIncident } from './domain.js';

const now = () => new Date().toISOString();

const QUAL_KEYS: QualificationKey[] = ['businessLicense', 'coachCert', 'guardCert', 'insurance', 'independentAccess', 'changingRoom'];

function audit(r: InstitutionRental, by: string, byRole: User['role'], event: string, detail?: string) {
  r.audit.unshift({ at: now(), by, byRole, event, detail });
}

function emptyGates(): InstitutionRental['gates'] {
  return {
    roster: { done: false }, visitorId: { done: false }, insurance: { done: false },
    guardReposition: { done: false }, cleaning: { done: false }, maintenance: { done: false },
  };
}
function emptyClearance(): InstitutionRental['clearance'] {
  return {
    clear_pool: { done: false }, clear_lockers: { done: false }, water_retest: { done: false },
    equipment_reset: { done: false }, guard_patrol: { done: false },
  };
}

// ============ 机构档案 ============
export function findOrCreateInstitution(db: DB, name: string, contactName: string, contactPhone: string, userId?: string): Institution {
  let inst = db.institutions.find((i) => i.name === name)
    ?? (userId ? db.institutions.find((i) => i.userId === userId) : undefined);
  if (inst) return inst;
  inst = {
    id: nextId('inst'), name, userId, contactName, contactPhone,
    creditScore: 100, deposit: 0, blocked: false, requiredExtraGuards: 0,
    creditEvents: [], createdAt: now(),
  };
  db.institutions.push(inst);
  return inst;
}

function recordCredit(db: DB, inst: Institution, e: Omit<CreditEvent, 'id' | 'at' | 'rectified'>) {
  const event: CreditEvent = { ...e, id: nextId('ce'), at: now(), rectified: false };
  inst.creditEvents.unshift(event);
  inst.creditScore = Math.max(0, inst.creditScore - e.points);
  // 频繁违规（信用 < 60）自动限制后续包场并要求增派救生员
  if (inst.creditScore < 60 && !inst.blocked) {
    inst.blocked = true;
    inst.requiredExtraGuards = Math.max(inst.requiredExtraGuards, 1);
    inst.blockReason = `信用分 ${inst.creditScore} 低于 60，限制后续包场，需追加押金并每场增派救生员`;
  }
  return event;
}

// ============ 居民标签 ============
function residentTags(db: DB, session: Session, b: Booking): ResidentTag[] {
  const u = db.users.find((x) => x.id === b.userId);
  const tags: ResidentTag[] = [];
  if (b.kind === 'elder_morning') tags.push('elder_morning');
  if (b.kind === 'parent_child') tags.push('parent_child');
  if (b.kind === 'coaching') tags.push('coaching');
  const children = b.childrenInParty ?? (b.withChildren ? b.childCount : 0);
  if (children > 0) tags.push('child');
  if (session.publicWelfare || b.kind === 'elder_morning') tags.push('public_welfare');
  if (b.paymentMethod === 'wallet' || u?.memberTier === 'silver' || u?.memberTier === 'gold') tags.push('stored_value');
  if (u?.deepCert) tags.push('deep_cert');
  return Array.from(new Set(tags));
}

function buildResidentConflict(db: DB, session: Session, b: Booking, offerVoucher = false): RentalResidentConflict {
  const u = db.users.find((x) => x.id === b.userId)!;
  return {
    bookingId: b.id, bookingCode: b.code, userId: u.id, userName: u.name,
    zoneId: b.zoneId, lane: b.lane, kind: b.kind,
    partySize: Math.max(1, b.partySize),
    children: b.childrenInParty ?? (b.withChildren ? b.childCount : 0),
    paidAmount: b.paidAmount, paymentMethod: b.paymentMethod, memberTier: u.memberTier,
    tags: residentTags(db, session, b),
    publicWelfare: !!session.publicWelfare || b.kind === 'elder_morning',
    preference: 'pending', offerVoucher,
  };
}

/** 判断某居民预约是否与给定泳区/泳道范围重叠 */
function overlaps(zoneId: ZoneId, lanes: number[], b: { zoneId: ZoneId; lane?: number }): boolean {
  if (b.zoneId !== zoneId) return false;
  if (lanes.length === 0) return true; // 整区
  if (b.lane == null) return true;    // 居民亲子/团体整区预约与任何道重叠
  return lanes.includes(b.lane);
}

// ============ 冲突预览（申请前置：日期/时段/泳道/泳区/容量/更衣淋浴/储物柜/救生排班/已预约居民） ============
export function previewRentalConflict(db: DB, req: {
  sessionId: string; zoneId: ZoneId; lanes?: number[]; partySize: number;
  lockersNeeded: number; showerCapacity: number; excludeRentalId?: string;
}): RentalConflictPreview {
  const session = db.sessions.find((s) => s.id === req.sessionId);
  if (!session) throw new HttpError(404, '场次不存在');
  const zone = db.zones.find((z) => z.id === req.zoneId)!;
  const lanes = req.lanes ?? [];
  const parties = Math.max(1, req.partySize);

  // 已预约居民（有效预约，落在申请泳区/泳道）
  const residentKinds: Booking['kind'][] = ['personal', 'parent_child', 'elder_morning', 'coaching', 'guest', 'group'];
  const residents = activeBookings(db, session.id)
    .filter((b) => residentKinds.includes(b.kind) && overlaps(req.zoneId, lanes, b))
    .map((b) => buildResidentConflict(db, session, b));

  const tagCounts: Partial<Record<ResidentTag, number>> = {};
  for (const rc of residents) for (const t of rc.tags) tagCounts[t] = (tagCounts[t] ?? 0) + 1;

  // 泳区容量（扣除其他锁区；本预览不把申请方自身的锁计入）
  const otherLocks = session.locks.filter((l) => {
    if (l.zoneId !== req.zoneId) return false;
    return true;
  });
  const lockedByOthers = otherLocks.reduce((s, l) => s + l.capacity, 0);
  const { inPool, booked } = zoneCounts(db, session.id, req.zoneId);
  const overflowCap = Math.max(0, inPool + booked + lockedByOthers + parties - zone.capacity);

  // 更衣淋浴：在池人数 + 申请人数
  const totalInPool = db.zones.reduce((s, z) => s + zoneCounts(db, session.id, z.id).inPool, 0);
  const showerOverflow = Math.max(0, totalInPool + parties - req.showerCapacity);

  // 储物柜：已分配柜号数
  const occupiedLockers = new Set(
    db.bookings.filter((b) => b.sessionId === session.id && b.status === 'checked_in' && b.lockerNo).map((b) => b.lockerNo),
  ).size;
  const lockerRemaining = Math.max(0, (db.facilities?.lockerCount ?? 220) - occupiedLockers);
  const lockerShortfall = Math.max(0, req.lockersNeeded - lockerRemaining);

  // 救生员排班现状
  const guards = db.guardDuties.filter((d) => d.sessionId === session.id && !d.end).map((d) => ({
    post: d.post, postLabel: ({ tower_deep: '深水区瞭望台', tower_shallow: '浅水区瞭望台', family_patrol: '儿童区巡逻', shower: '淋浴区岗', roaming: '机动巡视' } as Record<string, string>)[d.post],
    guardName: db.users.find((u) => u.id === d.guardUserId)?.name ?? '未知',
  }));

  const existingLocks = session.locks.map((l) => ({
    id: l.id, title: l.title, zoneId: l.zoneId, lane: l.lane, capacity: l.capacity, isCommercial: l.isCommercial,
  }));

  const conflicts: string[] = [];
  if (session.publicWelfare)
    conflicts.push(`申请落在「${session.label}」居民公益时段，商业包场不得占用公益名额，只能拆分配套非公益泳道`);
  if (residents.some((r) => r.tags.includes('elder_morning')))
    conflicts.push(`冲突范围内含老人晨泳预约 ${residents.filter((r) => r.tags.includes('elder_morning')).map((r) => r.bookingCode).join('、')}，不得覆盖`);
  if (residents.some((r) => r.tags.includes('parent_child') || r.tags.includes('child')))
    conflicts.push(`冲突范围内含亲子/儿童预约 ${residents.filter((r) => r.tags.includes('parent_child') || r.tags.includes('child')).map((r) => r.bookingCode).join('、')}，须保留并逐人征询`);
  if (residents.some((r) => r.tags.includes('coaching')))
    conflicts.push(`冲突范围内含教练课 ${residents.filter((r) => r.tags.includes('coaching')).map((r) => r.bookingCode).join('、')}，须顺延或避让教学道`);
  if (residents.some((r) => r.tags.includes('stored_value')))
    conflicts.push(`含会员储值用户 ${residents.filter((r) => r.tags.includes('stored_value')).length} 笔，退改须按原储值渠道返还`);
  if (residents.length)
    conflicts.push(`申请范围已有 ${residents.length} 笔居民预约（共 ${residents.reduce((s, r) => s + r.partySize, 0)} 人），平台不能直接覆盖，须逐人协调改约或压缩包场`);
  if (overflowCap > 0)
    conflicts.push(`超出${zone.name}容量：在池 ${inPool}＋待入场 ${booked}＋已锁 ${lockedByOthers}＋申请 ${parties}，超 ${overflowCap} 人`);
  if (showerOverflow > 0)
    conflicts.push(`更衣淋浴容量不足：在池 ${totalInPool}＋申请 ${parties} ＞ 容量 ${req.showerCapacity}，缺 ${showerOverflow} 人位`);
  if (lockerShortfall > 0)
    conflicts.push(`储物柜不足：需 ${req.lockersNeeded} 个，仅剩 ${lockerRemaining} 个，缺 ${lockerShortfall} 个`);
  if (guards.length === 0)
    conflicts.push('该时段暂无救生员排班记录，须先落实救生员配置（含增派）');

  return {
    sessionId: session.id, sessionLabel: session.label, date: session.date,
    start: session.start, end: session.end, publicWelfare: !!session.publicWelfare,
    zoneId: req.zoneId, zoneName: zone.name, lanes: lanes.length ? lanes : [undefined],
    capacity: { zoneCapacity: zone.capacity, inPool, booked, locked: lockedByOthers, applying: parties, overflow: overflowCap },
    shower: { capacity: req.showerCapacity, occupied: totalInPool, applying: parties, overflow: showerOverflow },
    locker: { total: db.facilities?.lockerCount ?? 220, occupied: occupiedLockers, needed: req.lockersNeeded, remaining: lockerRemaining, shortfall: lockerShortfall },
    guards, residents, tagCounts, existingLocks, conflicts,
  };
}

// ============ 申请 ============
export function applyRental(db: DB, applicant: User | undefined, req: {
  institutionId?: string; institutionName?: string;
  sessionId: string; zoneId: ZoneId; lanes?: number[];
  partySize: number; adultCount: number; childCount: number; ageMin?: number; ageMax?: number;
  companions: number; purpose: string;
  lockersNeeded: number; showerCapacity: number; independentChanging: boolean; showerNote?: string;
  qualifications?: Partial<Record<QualificationKey, string>>;
  coaches?: { name: string; certNo: string }[];
  insurancePolicyNo: string; insuranceExpiry: string;
}): InstitutionRental {
  const session = db.sessions.find((s) => s.id === req.sessionId);
  if (!session) throw new HttpError(404, '场次不存在');
  if (session.poolStatus === 'closed') throw new HttpError(409, '该场次已闭池，不可申请包场');

  // 机构建档 / 取档
  let inst: Institution;
  if (req.institutionId) {
    inst = db.institutions.find((i) => i.id === req.institutionId)!;
    if (!inst) throw new HttpError(404, '机构档案不存在');
  } else {
    const name = (req.institutionName || '').trim();
    if (!name) throw new HttpError(400, '机构名称必填');
    inst = findOrCreateInstitution(db, name, applicant?.name ?? name, applicant?.phone ?? '', applicant?.memberTier === 'institution' ? applicant.id : undefined);
  }
  if (inst.blocked)
    throw new HttpError(403, `机构「${inst.name}」因${inst.blockReason ?? '违规记录'}被限制包场，须整改并由运营解除限制后方可申请`);

  const partySize = Math.max(1, Number(req.partySize) || 0);
  const childCount = Math.max(0, Number(req.childCount) || 0);
  const adultCount = Math.max(0, Number(req.adultCount) || 0);
  if (partySize < 10) throw new HttpError(400, '机构包场不少于 10 人');
  if (childCount + adultCount > partySize + 1) throw new HttpError(400, '成人＋儿童人数不应超过总人数+1（带队人）');
  if (!req.insurancePolicyNo || !req.insuranceExpiry) throw new HttpError(400, '保险单号与有效期必填');
  if (req.insuranceExpiry < new Date().toISOString().slice(0, 10)) throw new HttpError(400, '保险已过期，请提供有效期内保险');

  // 儿童离陪规则：含儿童即核验陪同人数（不因包场放宽）
  const hasChildren = childCount > 0;
  const needCompanions = requiredCompanions(childCount, req.ageMin);
  const companionRequirement = childCount > 0
    ? (req.ageMin != null && req.ageMin <= 6 ? '6 岁以下幼儿须 1 名成人陪同 1 名儿童（1:1）' : '未成年学员每 3 名至少 1 名成人陪同（1:3），教练/救生员不计入陪同')
    : '无儿童，不适用儿童离陪陪同规则';
  if (hasChildren && req.companions < needCompanions) {
    throw new HttpError(400, `儿童离陪规则：${childCount} 名儿童（最低年龄 ${req.ageMin ?? '—'}）至少需要 ${needCompanions} 名成人陪同，现登记 ${req.companions} 名；包场不放宽该要求`);
  }

  const facility: FacilityInfo = {
    showerCapacity: Number(req.showerCapacity) || 0,
    lockerCount: db.facilities?.lockerCount ?? 220,
    lockersNeeded: Math.max(0, Number(req.lockersNeeded) || 0),
    independentChanging: !!req.independentChanging,
    showerNote: req.showerNote,
  };

  const qualifications: QualificationItem[] = QUAL_KEYS.map((k) => ({
    key: k, detail: req.qualifications?.[k] ?? '', state: 'unverified' as const,
  }));
  // 保险材料用单号回填，便于运营核验
  const ins = qualifications.find((q) => q.key === 'insurance')!;
  ins.detail = `保单号 ${req.insurancePolicyNo}，有效期至 ${req.insuranceExpiry}`;

  const coachAssignments: CoachAssignment[] = (req.coaches ?? []).filter((c) => c.name?.trim());

  const preview = previewRentalConflict(db, {
    sessionId: req.sessionId, zoneId: req.zoneId, lanes: req.lanes, partySize,
    lockersNeeded: facility.lockersNeeded, showerCapacity: facility.showerCapacity,
  });

  const rental: InstitutionRental = {
    id: nextId('ir'), code: `IR-${db.counters.seq}`, institutionId: inst.id,
    applicantUserId: applicant?.id, sessionId: session.id,
    requestZoneId: req.zoneId, requestLanes: req.lanes ?? [],
    requestStart: session.start, requestEnd: session.end,
    partySize, adultCount, childCount, ageMin: req.ageMin, ageMax: req.ageMax,
    hasChildren, companions: Number(req.companions) || 0, companionRequirement,
    purpose: req.purpose || '机构培训包场', facility,
    qualifications, coachAssignments,
    insurancePolicyNo: req.insurancePolicyNo, insuranceExpiry: req.insuranceExpiry,
    status: 'applied', conflictPreview: preview,
    residentConflicts: preview.residents.map((r) => ({ ...r })),
    institutionConfirmed: false, gates: emptyGates(), violations: [], clearance: emptyClearance(),
    audit: [], createdAt: now(),
  };
  audit(rental, applicant?.name ?? inst.contactName, applicant?.role ?? 'frontdesk', '提交包场申请',
    `${inst.name} 申请 ${preview.zoneName}${req.lanes?.length ? ' ' + req.lanes.join('/') + ' 号道' : '整区'} ${partySize} 人（儿童 ${childCount}），冲突 ${preview.conflicts.length} 项`);
  db.rentals.unshift(rental);

  pushNotification(db, {
    title: `机构包场申请待协调：${inst.name}（${session.label}）`,
    body: `${preview.zoneName} ${partySize} 人（儿童 ${childCount}）；冲突 ${preview.conflicts.length} 项、涉及居民 ${preview.residents.length} 笔。请先核验资质并逐人协调，不得直接覆盖居民预约。`,
    level: preview.conflicts.length ? 'critical' : 'warning', roles: ['ops', 'frontdesk'], sessionId: session.id,
  });
  return rental;
}

// ============ 资质逐项核验 ============
export function verifyQualification(db: DB, rentalId: string, key: QualificationKey, pass: boolean, operator: User, note?: string) {
  const r = mustRental(db, rentalId);
  if (r.status !== 'applied' && r.status !== 'coordinating') throw new HttpError(409, '当前状态不可核验资质');
  const q = r.qualifications.find((x) => x.key === key);
  if (!q) throw new HttpError(404, '核验项不存在');
  if (!q.detail) throw new HttpError(400, `机构尚未提交「${QUALIFICATION_LABEL[key]}」材料，无法核验通过`);
  q.state = pass ? 'verified' : 'rejected';
  q.verifiedBy = operator.name; q.verifiedAt = now(); q.note = note;
  audit(r, operator.name, 'ops', pass ? `资质核验通过：${QUALIFICATION_LABEL[key]}` : `资质核验驳回：${QUALIFICATION_LABEL[key]}`, note);
  return r;
}

// ============ 保存协调措施（拆道/缩短/限人/增派救生/暂停非公益道/补偿券/押金） ============
export function saveCoordination(db: DB, rentalId: string, req: RentalCoordination, operator: User): InstitutionRental {
  const r = mustRental(db, rentalId);
  if (!['applied', 'coordinating'].includes(r.status)) throw new HttpError(409, '当前状态不可调整协调方案');
  if (req.approvedPartySize > r.partySize) throw new HttpError(400, '限制后人数不能大于申请人数');
  if (req.approvedChildren > r.childCount) throw new HttpError(400, '批准儿童数不能大于申请儿童数');
  const inst = db.institutions.find((i) => i.id === r.institutionId)!;
  const extraGuards = Math.max(req.extraGuards, inst.requiredExtraGuards);
  r.coordination = { ...req, extraGuards };
  r.status = 'coordinating';
  // 协调后重新圈定受影响居民（按新泳区/泳道）
  const session = db.sessions.find((s) => s.id === r.sessionId)!;
  const inScopeIds = new Set(
    activeBookings(db, session.id)
      .filter((b) => b.status === 'booked' || b.status === 'checked_in')
      .filter((b) => overlaps(req.zoneId, req.lanes, b))
      .map((b) => b.id),
  );
  // 保留已处置结果；新增纳入；不再在范围内的标记 compressed（范围压缩解消）
  const existing = new Map(r.residentConflicts.map((c) => [c.bookingId, c]));
  const next: RentalResidentConflict[] = [];
  for (const b of activeBookings(db, session.id).filter((b) => inScopeIds.has(b.id))) {
    const ex = existing.get(b.id);
    if (ex) next.push(ex);
    else next.push(buildResidentConflict(db, session, b, req.provideVoucher));
  }
  // 不再在批准范围内的既有居民：范围压缩后自然解消，保留原预约并留痕（仍进入场次记录）
  for (const ex of existing.values()) {
    if (!inScopeIds.has(ex.bookingId)) {
      if (!ex.resolution) {
        ex.resolution = 'compressed'; ex.resolvedAt = now();
        ex.offerVoucher = req.provideVoucher || ex.offerVoucher;
      }
      next.push(ex);
    }
  }
  r.residentConflicts = next;
  audit(r, operator.name, 'ops', '制定/调整协调措施',
    `批准 ${req.zoneId}${req.lanes.length ? ' ' + req.lanes.join('/') + ' 号道' : '整区'}，${req.approvedPartySize} 人，增派救生 ${extraGuards} 名${req.shorten ? '，缩短时段' : ''}${req.suspendNonWelfareLanes ? '，暂停部分非公益泳道' : ''}`);
  return r;
}

// ============ 向居民发起改约征询（同步居民端，不只内部记一笔） ============
export function openReschedule(db: DB, rentalId: string, operator: User, req: { offerSessionId?: string; offerVoucher?: boolean; offerNote?: string }) {
  const r = mustRental(db, rentalId);
  if (!['applied', 'coordinating'].includes(r.status)) throw new HttpError(409, '当前状态不可发起改约征询');
  const session = db.sessions.find((s) => s.id === r.sessionId)!;
  let target = req.offerSessionId ? db.sessions.find((s) => s.id === req.offerSessionId) : undefined;
  if (req.offerSessionId && !target) throw new HttpError(404, '改约目标场次不存在');
  if (!target) {
    target = db.sessions.filter((s) => s.id !== session.id && s.poolStatus !== 'closed' && s.date === session.date)
      .sort((a, b) => a.start.localeCompare(b.start))[0];
  }

  for (const c of r.residentConflicts) {
    if (c.resolution) continue;
    c.preference = 'pending';
    c.offerSessionId = target?.id;
    c.offerVoucher = !!req.offerVoucher;
    c.offerNote = req.offerNote;
    c.notifiedAt = now();
    const n = pushNotification(db, {
      title: `【改约征询】您在「${session.label}」的预约 ${c.bookingCode}`,
      body: `因机构培训包场协调，平台为您保留原预约或协助改约${target ? `至「${target.label}」` : '其他场次'}${req.offerVoucher ? '，并可发放 1 张补偿券' : ''}。请在「我的预约」中选择「同意改约」或「不同意、保留原预约」。${req.offerNote ? req.offerNote : ''}`,
      level: 'warning', roles: [], userId: c.userId, sessionId: session.id,
    });
    c.notificationId = n;
  }
  r.status = 'coordinating';
  audit(r, operator.name, 'ops', '向居民发起逐人改约征询', `目标场次 ${target?.label ?? '待定'}，补偿券 ${req.offerVoucher ? '是' : '否'}`);
  pushNotification(db, { title: `改约征询已发出：${r.code}`, body: `已逐人通知 ${r.residentConflicts.filter((c) => !c.resolution).length} 位居民，等待答复。`, level: 'info', roles: ['ops', 'frontdesk'], sessionId: session.id });
  return r;
}

/** 居民本人答复改约征询（同意 / 不同意保留原预约） */
export function respondReschedule(db: DB, rentalId: string, user: User, agree: boolean) {
  const r = mustRental(db, rentalId);
  const mine = r.residentConflicts.filter((c) => c.userId === user.id && !c.resolution);
  if (!mine.length) throw new HttpError(404, '没有等待您答复的改约征询');
  for (const c of mine) {
    c.preference = agree ? 'agree' : 'reject';
    c.respondedAt = now();
  }
  audit(r, user.name, 'resident', agree ? '居民同意改约' : '居民不同意改约，要求保留原预约', mine.map((c) => c.bookingCode).join('、'));
  pushNotification(db, {
    title: `居民改约答复：${r.code}`, body: `${user.name} 对 ${mine.length} 笔预约选择${agree ? '同意改约' : '不同意（保留原预约，须压缩包场范围）'}。`,
    level: agree ? 'info' : 'critical', roles: ['ops'], sessionId: r.sessionId,
  });
  return r;
}

/** 迁移一笔居民预约到目标场次（生成可核验新预约，不退款、不二次扣款） */
function migrateResidentBooking(db: DB, b: Booking, target: Session, rental: InstitutionRental): Booking {
  const nb: Booking = {
    ...b, id: nextId('bk'), code: `B-${db.counters.seq}`, sessionId: target.id,
    periodLabel: `${target.start}-${target.end}`, status: 'booked',
    lockerNo: undefined, checkedInAt: undefined, checkedInBy: undefined, createdAt: now(),
    migratedFromBookingId: b.id, migratedClosureId: undefined,
  };
  db.bookings.unshift(nb);
  b.status = 'postponed';
  b.postponeToSessionId = target.id;
  b.postponedBookingId = nb.id;
  return nb;
}

/** 运营对单居民做最终处置：保留/改约/退费/补偿券/范围压缩解消；结果同步居民端 */
export function resolveResident(db: DB, rentalId: string, bookingId: string, resolution: RentalResidentConflict['resolution'], operator: User, targetSessionId?: string) {
  const r = mustRental(db, rentalId);
  const c = r.residentConflicts.find((x) => x.bookingId === bookingId);
  if (!c) throw new HttpError(404, '该居民不在本包场冲突范围内');
  if (c.resolution) throw new HttpError(409, `该预约已处置：${c.resolution}`);
  const b = db.bookings.find((x) => x.id === bookingId)!;
  const u = db.users.find((x) => x.id === c.userId)!;
  const session = db.sessions.find((s) => s.id === r.sessionId)!;
  const detail: string[] = [];

  switch (resolution) {
    case 'keep':
    case 'compressed':
      c.resolution = resolution;
      detail.push(resolution === 'keep' ? '居民不同意改约，保留原预约，包场范围相应压缩' : '协调范围已压缩，该预约不再在冲突范围内，保留原预约');
      break;
    case 'reschedule': {
      const target = db.sessions.find((s) => s.id === (targetSessionId || c.offerSessionId));
      if (!target) throw new HttpError(400, '请指定有效的改约目标场次');
      if (target.poolStatus === 'closed' || target.poolStatus === 'partial') throw new HttpError(409, '目标场次闭池/部分开放，无法改约');
      const nb = migrateResidentBooking(db, b, target, r);
      c.migratedBookingId = nb.id; c.resolution = 'reschedule';
      detail.push(`已改约至「${target.label}」（新预约 ${nb.code} 可核验），费用保留`);
      break;
    }
    case 'refund':
    case 'voucher': {
      // 公益时段被压缩：退费或补偿券同步居民端
      if (b.paymentMethod === 'wallet' && b.paidAmount > 0) {
        u.walletBalance = (u.walletBalance ?? 0) + b.paidAmount;
        const tx = { id: nextId('tx'), at: now(), userId: u.id, amount: b.paidAmount, reason: `包场 ${r.code} 协调原路退储值 ${b.code}`, sessionId: session.id };
        db.walletTxns.unshift(tx); c.refundTxnId = tx.id;
        detail.push(`${b.paidAmount} 元已原路退回储值余额`);
      } else if (b.paymentMethod === 'voucher') {
        u.compVouchers = (u.compVouchers ?? 0) + 1;
        detail.push('原 1 张补偿券已返还');
      } else if (b.paidAmount > 0) {
        detail.push(`现场支付 ${b.paidAmount} 元已登记凭证退款`);
      } else {
        detail.push('公益免费预约，无需退款');
      }
      if (resolution === 'voucher') {
        u.compVouchers = (u.compVouchers ?? 0) + 1;
        c.voucherGranted = (c.voucherGranted ?? 0) + 1;
        detail.push('并发放 1 张补偿券（可抵一次入场）');
        b.status = 'compensated';
      } else {
        b.status = 'refunded';
      }
      c.resolution = resolution;
      break;
    }
  }
  c.resolvedAt = now();
  const n = pushNotification(db, {
    title: `【包场协调结果】预约 ${c.bookingCode}（${session.label}）`,
    body: `${detail.join('；')}。该结果已进入场次记录，可在投诉追溯中核对。`,
    level: 'warning', roles: [], userId: u.id, sessionId: session.id,
  });
  c.notificationId = n;
  audit(r, operator.name, 'ops', `居民预约处置：${c.bookingCode} → ${resolution}`, detail.join('；'));
  return r;
}

/** 居民答复"同意改约"后由运营一键按方案落单（也可直接 resolve reschedule） */
export function applyAgreedReschedules(db: DB, rentalId: string, operator: User) {
  const r = mustRental(db, rentalId);
  for (const c of r.residentConflicts) {
    if (c.preference === 'agree' && !c.resolution && c.offerSessionId) {
      resolveResident(db, rentalId, c.bookingId, 'reschedule', operator, c.offerSessionId);
    }
  }
  return r;
}

// ============ 机构确认协调方案（费用/范围） ============
export function confirmByInstitution(db: DB, rentalId: string, user: User) {
  const r = mustRental(db, rentalId);
  const inst = db.institutions.find((i) => i.id === r.institutionId)!;
  if (inst.userId !== user.id && user.role !== 'ops') throw new HttpError(403, '仅机构账号或运营可确认方案');
  if (!r.coordination) throw new HttpError(409, '协调方案尚未制定');
  r.institutionConfirmed = true; r.institutionConfirmedAt = now();
  audit(r, user.name, user.role, '机构确认协调方案与费用拆分');
  return r;
}

// ============ 批准（不覆盖居民；拒绝者保留并压缩范围；费用拆分进机构账单） ============
export function approveRental(db: DB, rentalId: string, operator: User, req: { paymentMethod?: 'cash' | 'wallet'; note?: string }) {
  const r = mustRental(db, rentalId);
  if (!['applied', 'coordinating'].includes(r.status)) throw new HttpError(409, '当前状态不可批准');
  const inst = db.institutions.find((i) => i.id === r.institutionId)!;
  const session = db.sessions.find((s) => s.id === r.sessionId)!;
  const coord = r.coordination;

  // 1) 资质必须逐项核验通过
  const bad = r.qualifications.filter((q) => q.state !== 'verified');
  if (bad.length) throw new HttpError(409, `资质未全部核验通过：${bad.map((q) => QUALIFICATION_LABEL[q.key]).join('、')}；不得批准`);
  if (r.insuranceExpiry < new Date().toISOString().slice(0, 10)) throw new HttpError(409, '保险已过期，不得批准');
  // 2) 教练配置
  if (r.coachAssignments.length === 0) throw new HttpError(409, '未登记持证教练配置，不得批准');
  // 3) 儿童离陪（含儿童不放宽）
  if (r.hasChildren && r.companions < requiredCompanions(r.childCount, r.ageMin))
    throw new HttpError(409, '儿童陪同人数不满足离陪规则，不得批准');
  if (!coord) throw new HttpError(409, '请先制定协调措施（拆道/限人/增派救生等）');

  // 4) 公益时段保护：商业包场不得整区占用公益时段（优先提示，须拆分配套非公益泳道）
  if (session.publicWelfare && coord.lanes.length === 0)
    throw new HttpError(409, '居民公益时段不得整区商业包场，须拆分配套非公益泳道并保留公益名额');

  // 5) 未处置或拒绝改约且仍在批准范围内的居民：必须保留 → 需进一步压缩范围
  const keepers = r.residentConflicts.filter((c) => !c.resolution || c.resolution === 'keep');
  const blocking = keepers.filter((c) => overlaps(coord.zoneId, coord.lanes, { zoneId: c.zoneId, lane: c.lane }));
  if (blocking.length)
    throw new HttpError(409, `以下居民保留原预约且仍在批准范围：${blocking.map((c) => c.bookingCode).join('、')}。平台不能覆盖居民预约，请拆分泳道/调整泳区压缩包场，或继续协调退费/补偿。`);

  // 6) 容量复检（按批准人数与范围）
  const zone = db.zones.find((z) => z.id === coord.zoneId)!;
  const { inPool, booked } = zoneCounts(db, session.id, coord.zoneId);
  const { seats: locked } = zoneLocked(db, session, coord.zoneId);
  if (inPool + booked + locked + coord.approvedPartySize > zone.capacity)
    throw new HttpError(409, `批准后${zone.name}容量不足：在池 ${inPool}＋待入 ${booked}＋已锁 ${locked}＋批准 ${coord.approvedPartySize} ＞ 容量 ${zone.capacity}`);

  // 7) 费用拆分进机构账单
  const hours = hoursBetween(coord.shorten && coord.adjustedStart && coord.adjustedEnd ? coord.adjustedStart : r.requestStart,
    coord.shorten && coord.adjustedStart && coord.adjustedEnd ? coord.adjustedEnd : r.requestEnd);
  const items: InstitutionBillItem[] = buildRentalBillItems({
    coordination: coord, requestWholeZone: r.requestLanes.length === 0, hours,
    lockersNeeded: r.facility.lockersNeeded, depositRequired: coord.requireDeposit,
  });
  const total = billTotal(items);
  const paymentMethod = req.paymentMethod ?? 'cash';

  // 机构账号储值支付
  if (paymentMethod === 'wallet' && inst.userId) {
    const u = db.users.find((x) => x.id === inst.userId)!;
    if ((u.walletBalance ?? 0) < total) throw new HttpError(402, `机构账号储值余额不足（需 ${total}，余 ${u.walletBalance ?? 0}），可改用对公登记`);
    u.walletBalance = (u.walletBalance ?? 0) - total;
    db.walletTxns.unshift({ id: nextId('tx'), at: now(), userId: u.id, amount: -total, reason: `机构包场 ${r.code} 费用（${inst.name}）`, sessionId: session.id });
  }
  if (coord.requireDeposit > 0) inst.deposit += coord.requireDeposit;

  const bill: InstitutionBill = {
    id: nextId('bill'), institutionId: inst.id, rentalId: r.id, sessionId: session.id,
    paid: true, paidAt: now(), paymentMethod, items, total, depositDeducted: 0,
    note: paymentMethod === 'cash' ? '对公转账/现场登记，费用按泳道/救生加班/储物柜/淋浴/押金拆分' : '机构账号储值支付',
    createdAt: now(),
  };
  db.institutionBills.unshift(bill);

  // 8) 写入商业锁区（批准范围）：拆分为多条泳道时逐道加锁，避免把未售出泳道也锁成整区
  const lockIds: string[] = [];
  const perLane = coord.lanes.length > 1 ? Math.ceil(coord.approvedPartySize / coord.lanes.length) : coord.approvedPartySize;
  const lockLanes = coord.lanes.length > 0 ? coord.lanes : [undefined];
  for (const lane of lockLanes) {
    const lock: ZoneLock = {
      id: nextId('lock'), zoneId: coord.zoneId, lane,
      reason: 'institution_rental', title: `${inst.name}·包场 ${coord.approvedPartySize} 人`,
      contactName: inst.contactName, contactPhone: inst.contactPhone,
      capacity: lockLanes.length > 1 ? perLane : coord.approvedPartySize, isCommercial: true,
    };
    session.locks.push(lock);
    lockIds.push(lock.id);
  }

  r.billId = bill.id; r.lockId = lockIds.join(',');
  r.status = 'approved'; r.decidedBy = operator.name; r.decidedAt = now(); r.decisionNote = req.note;
  audit(r, operator.name, 'ops', '批准包场并生成机构账单', `费用合计 ¥${total}（${items.length} 项拆分），支付方式 ${paymentMethod === 'cash' ? '对公' : '储值'}`);
  pushNotification(db, {
    title: `机构包场已批准：${inst.name}（${session.label}）`,
    body: `批准 ${zone.name}${coord.lanes.length ? ' ' + coord.lanes.join('/') + ' 号道' : '整区'} ${coord.approvedPartySize} 人，费用 ¥${total} 已入机构账单（按泳道/救生加班/储物柜/淋浴拆分）。当天前台核验名单/身份/保险，救生按人数重新站位。`,
    level: 'warning', roles: ['frontdesk', 'lifeguard', 'cleaner', 'maintenance', 'ops'], sessionId: session.id,
  });
  if (inst.userId) {
    pushNotification(db, {
      title: `包场已确认：${r.code}（${session.label}）`,
      body: `协调方案已批准，费用 ¥${total}（${paymentMethod === 'cash' ? '对公支付' : '储值支付'}）。请按批准人数/泳道到场，前台核验名单、访客身份与保险，含儿童须满足陪同规则。`,
      level: 'info', roles: [], userId: inst.userId, sessionId: session.id,
    });
  }
  return { rental: r, bill, lockIds };
}

/** 驳回（释放洽谈占位，通知机构） */
export function rejectRental(db: DB, rentalId: string, operator: User, note?: string) {
  const r = mustRental(db, rentalId);
  if (!['applied', 'coordinating'].includes(r.status)) throw new HttpError(409, '当前状态不可驳回');
  r.status = 'rejected'; r.decidedBy = operator.name; r.decidedAt = now(); r.decisionNote = note;
  audit(r, operator.name, 'ops', '驳回包场申请', note);
  const inst = db.institutions.find((i) => i.id === r.institutionId)!;
  pushNotification(db, { title: `包场申请未通过：${r.code}`, body: note || '资质或冲突协调未通过，平台不能覆盖居民预约。', level: 'warning', roles: [], userId: inst.userId });
  return r;
}

// ============ 当天：开始/现场核验项 ============
export function startRental(db: DB, rentalId: string, user: User) {
  const r = mustRental(db, rentalId);
  if (r.status !== 'approved') throw new HttpError(409, '仅已批准包场可开始');
  r.status = 'active';
  audit(r, user.name, user.role, '包场开始（机构到场）');
  return r;
}

const GATE_ROLE: Record<RentalGateKey, User['role'][]> = {
  roster: ['frontdesk', 'ops'],
  visitorId: ['frontdesk', 'ops'],
  insurance: ['frontdesk', 'ops'],
  guardReposition: ['lifeguard', 'ops'],
  cleaning: ['cleaner', 'ops'],
  maintenance: ['maintenance', 'ops'],
};

export function setGate(db: DB, rentalId: string, key: RentalGateKey, user: User, req: { note?: string; guardPlan?: string }) {
  const r = mustRental(db, rentalId);
  if (r.status !== 'active' && r.status !== 'suspended' && !(key === 'roster' && r.status === 'approved'))
    throw new HttpError(409, '包场未开始或已结束，不能登记现场核验');
  if (!GATE_ROLE[key].includes(user.role)) throw new HttpError(403, `该项由 ${GATE_ROLE[key].join('/')} 核验`);

  if (key === 'insurance' && r.insuranceExpiry < new Date().toISOString().slice(0, 10))
    throw new HttpError(409, '保险已过期，不得通过现场保险核验');
  if (key === 'guardReposition') {
    // 救生员按包场人数重新站位：记录一条机动岗 duty
    const roaming = db.guardDuties.find((d) => d.sessionId === r.sessionId && !d.end && d.post === 'roaming');
    if (!roaming && user.role === 'lifeguard') {
      db.guardDuties.unshift({ id: nextId('gd'), sessionId: r.sessionId, guardUserId: user.id, post: 'roaming', start: now(), note: `包场 ${r.code} 按 ${r.coordination?.approvedPartySize ?? r.partySize} 人增派/重新站位` });
    }
  }
  r.gates[key] = { done: true, at: now(), by: user.name, note: req.note ?? req.guardPlan };
  audit(r, user.name, user.role, `现场核验完成：${({ roster: '机构名单', visitorId: '访客身份', insurance: '保险', guardReposition: '救生重新站位', cleaning: '保洁地面/淋浴/储物柜/消毒', maintenance: '维修设备/消毒' } as Record<RentalGateKey, string>)[key]}`, req.note ?? req.guardPlan);
  return r;
}

// ============ 违规（超人数/超时/占公益道/儿童无人陪同/私自加人 → 暂停并通知运营） ============
const VIOLATION_META: Record<string, { title: string; points: number }> = {
  overtime: { title: '超时滞留', points: 8 },
  over_capacity: { title: '实际超人数', points: 12 },
  occupy_welfare: { title: '占用居民公益泳道', points: 15 },
  child_alone: { title: '儿童无人陪同', points: 15 },
  add_people: { title: '机构私自加人', points: 12 },
  complaint: { title: '投诉成立', points: 6 },
};

export function reportViolation(db: DB, rentalId: string, user: User, req: { type: RentalViolation['type']; detail: string; suspend: boolean; rectifyNote?: string; points?: number }) {
  const r = mustRental(db, rentalId);
  if (r.status !== 'active' && r.status !== 'suspended') throw new HttpError(409, '仅进行中的包场可登记违规');
  const meta = VIOLATION_META[req.type] ?? { title: '违规', points: 8 };
  const points = req.points ?? meta.points;

  // 自动立案协同事件（现场可暂停包场并通知社区运营）
  const session = db.sessions.find((s) => s.id === r.sessionId)!;
  const incident = openIncident(db, r.sessionId, 'overbooking',
    `包场违规：${meta.title}`, `机构包场 ${r.code} ${meta.title}：${req.detail}；登记人 ${user.name}${req.suspend ? '，已现场暂停包场' : ''}。`, user.name, 'major');

  const v: RentalViolation = {
    id: nextId('rv'), at: now(), type: req.type, title: meta.title, detail: req.detail,
    reportedBy: user.name, suspended: !!req.suspend, points, rectifyNote: req.rectifyNote,
    resolved: false, incidentId: incident.id,
  };
  r.violations.unshift(v);
  const inst = db.institutions.find((i) => i.id === r.institutionId)!;
  recordCredit(db, inst, { type: req.type, title: meta.title, detail: `${r.code} ${req.detail}`, points, recordedBy: user.name, rentalId: r.id });

  if (req.suspend) {
    r.status = 'suspended';
    audit(r, user.name, user.role, `现场暂停包场：${meta.title}`, req.detail);
    pushNotification(db, {
      title: `⛔ 包场已现场暂停：${r.code}（${meta.title}）`,
      body: `${req.detail}。已通知社区运营，机构整改并经运营确认后方可继续；整改不到位将压缩/终止包场并扣减信用与押金。`,
      level: 'critical', roles: ['ops', 'frontdesk', 'lifeguard'], sessionId: r.sessionId,
    });
  } else {
    audit(r, user.name, user.role, `登记违规：${meta.title}`, req.detail);
    pushNotification(db, {
      title: `包场违规预警：${r.code}（${meta.title}）`, body: req.detail,
      level: 'warning', roles: ['ops', 'frontdesk'], sessionId: r.sessionId,
    });
  }
  return r;
}

/** 整改通过：运营确认后恢复进行中（信用回补少量分） */
export function resolveViolation(db: DB, rentalId: string, violationId: string, operator: User, note?: string) {
  const r = mustRental(db, rentalId);
  const v = r.violations.find((x) => x.id === violationId);
  if (!v) throw new HttpError(404, '违规记录不存在');
  if (v.resolved) throw new HttpError(409, '该违规已整改');
  v.resolved = true; v.resolvedAt = now(); v.resumedBy = operator.name;
  const inst = db.institutions.find((i) => i.id === r.institutionId)!;
  const ce = inst.creditEvents.find((e) => e.rentalId === r.id && e.type === v.type && !e.rectified);
  if (ce) {
    ce.rectified = true; ce.rectifiedAt = now(); ce.rectifiedNote = note;
    inst.creditScore = Math.min(100, inst.creditScore + Math.round(v.points / 2));
  }
  if (r.status === 'suspended' && r.violations.every((x) => x.resolved || !x.suspended)) {
    r.status = 'active';
    audit(r, operator.name, 'ops', '整改通过，恢复包场', note);
  } else {
    audit(r, operator.name, 'ops', `登记整改完成：${v.title}`, note);
  }
  return r;
}

// ============ 包场结束 → 清场/复测/复位/巡查五项门禁 → 恢复居民预约 ============
export function endRental(db: DB, rentalId: string, user: User) {
  const r = mustRental(db, rentalId);
  if (r.status !== 'active' && r.status !== 'suspended') throw new HttpError(409, '仅进行中/暂停的包场可结束');
  r.status = 'ended';
  audit(r, user.name, user.role, '包场时间结束，进入清场恢复门禁');
  pushNotification(db, {
    title: `包场结束待清场：${r.code}`,
    body: '须依次完成：清场、清储物柜、水质复测达标、设备复位、救生巡查确认；未复测或未清场不得开放下一场/恢复居民预约。',
    level: 'warning', roles: ['frontdesk', 'lifeguard', 'cleaner', 'maintenance', 'ops'], sessionId: r.sessionId,
  });
  return r;
}

const CLEARANCE_ROLE: Record<RentalClearanceKey, User['role'][]> = {
  clear_pool: ['frontdesk', 'lifeguard', 'ops'],
  clear_lockers: ['cleaner', 'frontdesk', 'ops'],
  water_retest: ['lifeguard', 'maintenance', 'ops'],
  equipment_reset: ['maintenance', 'ops'],
  guard_patrol: ['lifeguard', 'ops'],
};

export function setClearance(db: DB, rentalId: string, key: RentalClearanceKey, user: User, note?: string) {
  const r = mustRental(db, rentalId);
  if (r.status !== 'ended') throw new HttpError(409, '仅已结束待清场的包场可登记清场恢复项');
  if (!CLEARANCE_ROLE[key].includes(user.role)) throw new HttpError(403, `该项由 ${CLEARANCE_ROLE[key].join('/')} 确认`);
  if (key === 'water_retest') {
    // 必须存在晚于包场结束登记时刻的达标水质读数
    const endedAt = r.audit.find((a) => a.event.startsWith('包场时间结束'))?.at;
    const reading = db.waterReadings.find((w) => w.sessionId === r.sessionId && !w.abnormal && (!endedAt || w.at > endedAt));
    if (!reading) throw new HttpError(409, '尚无晚于包场结束时间的达标水质复测读数，不能确认复测；请先录入达标水质。');
    r.clearance.water_retest = { done: true, at: now(), by: user.name, note, readingId: reading.id };
  } else {
    r.clearance[key] = { done: true, at: now(), by: user.name, note };
  }
  audit(r, user.name, user.role, `清场恢复项确认：${({ clear_pool: '清场', clear_lockers: '清储物柜', water_retest: '水质复测达标', equipment_reset: '设备复位', guard_patrol: '救生巡查确认' } as Record<RentalClearanceKey, string>)[key]}`, note);
  return r;
}

/** 恢复居民预约：五项门禁全完成方可；释放锁区 */
export function completeRental(db: DB, rentalId: string, operator: User, note?: string) {
  const r = mustRental(db, rentalId);
  if (r.status !== 'ended') throw new HttpError(409, '仅待清场的包场可恢复开放');
  const keys: RentalClearanceKey[] = ['clear_pool', 'clear_lockers', 'water_retest', 'equipment_reset', 'guard_patrol'];
  const missing = keys.filter((k) => !r.clearance[k].done);
  if (missing.length) {
    const label: Record<RentalClearanceKey, string> = { clear_pool: '清场', clear_lockers: '清储物柜', water_retest: '水质复测', equipment_reset: '设备复位', guard_patrol: '救生巡查' };
    throw new HttpError(409, `未复测或未清场不得开放下一场，尚缺：${missing.map((k) => label[k]).join('、')}`);
  }
  // 释放包场锁区（拆分多道时为多把锁），恢复居民可预约容量
  const session = db.sessions.find((s) => s.id === r.sessionId)!;
  if (r.lockId) {
    for (const lid of r.lockId.split(',')) {
      const idx = session.locks.findIndex((l) => l.id === lid);
      if (idx >= 0) session.locks.splice(idx, 1);
    }
  }
  r.status = 'completed';
  r.reopenedAt = now(); r.reopenedBy = operator.name;
  r.reopenNote = note || '清场、清储物柜、水质复测达标、设备复位、救生巡查确认全部完成，恢复居民预约';
  audit(r, operator.name, 'ops', '恢复居民预约开放', r.reopenNote);
  pushNotification(db, {
    title: `✅ 包场清场完成，恢复居民预约：${session.label}`,
    body: `${r.code} 已完成清场、清储物柜、水质复测达标、设备复位与救生巡查确认，包场锁区释放，居民可正常预约/入场。全部协调与恢复结果已进入该场次记录。`,
    level: 'info', roles: [], sessionId: r.sessionId,
  });
  pushNotification(db, {
    title: `包场恢复开放：${r.code}`, level: 'info', roles: ['frontdesk', 'lifeguard', 'cleaner', 'maintenance'],
    body: '场地已复位复测达标，按下一场次常规排班到岗、核验与保洁。', sessionId: r.sessionId,
  });
  return r;
}

// ============ 机构限制 / 押金 / 增派救生（信用处置） ============
export function setInstitutionRestriction(db: DB, instId: string, operator: User, req: { blocked: boolean; blockReason?: string; requiredExtraGuards?: number; depositDelta?: number }) {
  const inst = db.institutions.find((i) => i.id === instId);
  if (!inst) throw new HttpError(404, '机构不存在');
  inst.blocked = req.blocked;
  inst.blockReason = req.blocked ? (req.blockReason ?? '违规限制') : undefined;
  if (typeof req.requiredExtraGuards === 'number') inst.requiredExtraGuards = Math.max(0, req.requiredExtraGuards);
  if (req.depositDelta) {
    inst.deposit = Math.max(0, inst.deposit + req.depositDelta);
    recordCredit(db, inst, {
      type: 'rectified', title: req.depositDelta > 0 ? '追加押金' : '退还/扣减押金',
      detail: `押金调整 ${req.depositDelta > 0 ? '+' : ''}${req.depositDelta}，当前押金 ${inst.deposit}`,
      points: 0, recordedBy: operator.name,
    });
  }
  return inst;
}

/** 从押金扣减赔偿（违规） */
export function deductDeposit(db: DB, billId: string, amount: number, operator: User, note: string) {
  const bill = db.institutionBills.find((b) => b.id === billId);
  if (!bill) throw new HttpError(404, '账单不存在');
  const inst = db.institutions.find((i) => i.id === bill.institutionId)!;
  if (amount > inst.deposit) throw new HttpError(409, `扣减金额超过押金余额（${inst.deposit}）`);
  inst.deposit -= amount;
  bill.depositDeducted += amount;
  recordCredit(db, inst, { type: 'rectified', title: '押金扣抵', detail: `${note}；扣 ¥${amount}`, points: 0, recordedBy: operator.name, rentalId: bill.rentalId });
  return bill;
}

// ============ 查询辅助 ============
export function mustRental(db: DB, id: string): InstitutionRental {
  const r = db.rentals.find((x) => x.id === id || x.code === id);
  if (!r) throw new HttpError(404, '包场记录不存在');
  return r;
}

/** 发往居民端/非财务角色的脱敏裁剪（不含他人 PII 与账单） */
export function sanitizeRental(r: InstitutionRental, viewer: User): InstitutionRental | null {
  if (viewer.role === 'ops' || viewer.role === 'frontdesk') return r;
  if (viewer.role === 'resident') {
    const mine = r.residentConflicts.filter((c) => c.userId === viewer.id);
    if (!mine.length && r.applicantUserId !== viewer.id) return null;
    const isApplicant = r.applicantUserId === viewer.id;
    // 申请人（机构账号）可见冲突人数与处置进度，但其他居民姓名/联系方式一律脱敏
    const conflicts = isApplicant
      ? r.residentConflicts.map((c) => ({ ...c, userName: c.userId === viewer.id ? c.userName : '居民', userId: c.userId === viewer.id ? c.userId : '' }))
      : mine;
    // 审计明细可能含机构名称/他人信息：申请人保留；受影响居民仅保留动作不留文案
    const audit = isApplicant
      ? r.audit
      : r.audit.map((a) => ({ ...a, detail: undefined, by: a.byRole === 'resident' && a.by !== viewer.name ? '居民' : a.by }));
    // 冲突预览中的其他居民姓名同样泛化
    const previewResidents = r.conflictPreview.residents
      .filter((c) => isApplicant || c.userId === viewer.id)
      .map((c) => c.userId === viewer.id ? { ...c, userName: viewer.name } : { ...c, userName: '居民', userId: '' });
    return {
      ...r,
      residentConflicts: conflicts,
      conflictPreview: { ...r.conflictPreview, residents: previewResidents },
      audit,
      qualifications: [], coachAssignments: [], insurancePolicyNo: '', insuranceExpiry: '',
    };
  }
  // 救生/保洁/维修：只见现场协同所需状态，不见居民明细/资质/费用
  return {
    ...r, residentConflicts: [], qualifications: [], coachAssignments: [],
    insurancePolicyNo: '', insuranceExpiry: '',
  };
}
