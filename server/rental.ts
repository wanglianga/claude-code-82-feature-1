import type {
  DB, User, Session, Booking, ZoneId, ZoneLock, Role,
  RentalCase, RentalCaseStatus, RentalQualification, RentalFeeBreakdown, RentalConflictScope,
  ResidentConflict, ResidentConflictKind, RentalCoordination, RentalViolation, RentalViolationType,
  OrgBillItem, OrgCreditProfile, OrgCreditRecord,
  RentalApplyReq, RentalQualifyReq, RentalCoordinateReq, RentalDayCheckReq, RentalCloseoutReq,
} from '../shared/types.js';
import { nextId } from './store.js';
import {
  HttpError, activeBookings, zoneCounts, zoneLocked, lockConflicts, pushNotification, openIncident,
} from './domain.js';
import {
  FACILITY, requiredLifeguards, validateCompanions, rentalFeeOf, facilityConflicts,
  CREDIT, creditRestriction, RENTAL_RATE,
} from '../shared/logic.js';

const now = () => new Date().toISOString();

function zoneName(db: DB, zoneId: ZoneId) {
  return db.zones.find((z) => z.id === zoneId)?.name ?? zoneId;
}
function sessionOf(db: DB, id: string): Session {
  const s = db.sessions.find((x) => x.id === id);
  if (!s) throw new HttpError(404, '场次不存在');
  return s;
}
export function getRentalCase(db: DB, id: string): RentalCase {
  const rc = db.rentalCases.find((x) => x.id === id);
  if (!rc) throw new HttpError(404, '包场协调档案不存在');
  return rc;
}

function addTimeline(rc: RentalCase, by: string, byRole: Role, action: string) {
  rc.timeline.push({ at: now(), by, byRole, action });
}

/** 机构信用画像（实时由记录聚合 + 人工限制覆盖） */
export function orgCreditProfile(db: DB, orgUserId: string): OrgCreditProfile {
  const recs = db.orgCreditRecords.filter((r) => r.orgUserId === orgUserId);
  const orgName = db.users.find((u) => u.id === orgUserId)?.name ?? recs[0]?.orgName ?? '机构';
  let score = CREDIT.initial;
  let overtimeCount = 0;
  let overCapacityCount = 0;
  let complaintCount = 0;
  for (const r of recs) {
    score += r.scoreDelta;
    if (r.type === 'overtime') overtimeCount += 1;
    if (r.type === 'over_capacity') overCapacityCount += 1;
    if (r.type === 'complaint') complaintCount += 1;
  }
  score = Math.max(0, Math.min(100, score));
  const violationCount = recs.filter((r) => r.scoreDelta < 0).length;
  const auto = creditRestriction(score, violationCount);
  // 最新的人工限制覆盖自动画像
  const override = [...recs].reverse().find((r) => r.restrictionOverride)?.restrictionOverride;
  return {
    orgUserId, orgName, violationCount, overtimeCount, overCapacityCount, complaintCount, score,
    rentalRestricted: override ? override.rentalRestricted : auto.rentalRestricted,
    requiredExtraLifeguards: override ? override.requiredExtraLifeguards : auto.requiredExtraLifeguards,
    depositMultiplier: override ? override.depositMultiplier : auto.depositMultiplier,
    restrictionNote: override?.note,
  };
}

export function allOrgCreditProfiles(db: DB): OrgCreditProfile[] {
  const ids = new Set<string>();
  db.orgCreditRecords.forEach((r) => ids.add(r.orgUserId));
  db.rentalCases.forEach((r) => ids.add(r.orgUserId));
  return [...ids].map((id) => orgCreditProfile(db, id));
}

function addCreditRecord(db: DB, rec: Omit<OrgCreditRecord, 'id' | 'at'> & { at?: string }) {
  const r: OrgCreditRecord = { ...rec, id: nextId('ocr'), at: rec.at ?? now() };
  db.orgCreditRecords.unshift(r);
  return r;
}

/** 给居民预约打类别标签：老人晨泳/亲子/公益/教练课/会员储值 */
function residentTags(db: DB, b: Booking, session: Session): ResidentConflictKind[] {
  const tags: ResidentConflictKind[] = [];
  const u = db.users.find((x) => x.id === b.userId);
  if (b.kind === 'elder_morning' || (b.age >= 60)) tags.push('elder_morning');
  if (b.kind === 'parent_child' || b.withChildren || (b.childrenInParty ?? 0) > 0) tags.push('parent_child');
  if (session.publicWelfare) tags.push('public_welfare');
  if (b.kind === 'coaching') tags.push('coaching');
  if (u && (u.memberTier === 'gold' || u.memberTier === 'silver') && b.paymentMethod === 'wallet')
    tags.push('stored_member');
  if (tags.length === 0) tags.push('normal');
  return tags;
}

const RESIDENT_KINDS = new Set(['personal', 'parent_child', 'elder_morning', 'coaching', 'guest']);

/** 计算包场申请对泳区/泳道产生冲突的居民预约（机构自身包场预约除外） */
export function affectedResidents(db: DB, session: Session, zoneId: ZoneId, lanes?: number[], excludeBookingId?: string, excludeRentalCaseId?: string): Booking[] {
  const laneSet = lanes && lanes.length > 0 ? new Set(lanes) : null;
  // 已被其他包场协调改约迁移走的预约（status=rebooked）不再算
  return activeBookings(db, session.id).filter((b) => {
    if (b.id === excludeBookingId) return false;
    if (b.kind === 'institution_rental' || b.kind === 'group') return false;
    if (!RESIDENT_KINDS.has(b.kind)) return false;
    if (b.zoneId !== zoneId) return false;
    // 已归属其他包场档案的居民冲突不再重复纳入
    if (excludeRentalCaseId && b.rentalCaseId && b.rentalCaseId !== excludeRentalCaseId) return false;
    if (laneSet) {
      // 居民预约有具体泳道：命中申请泳道才算；无泳道居民在整区，按占用泳区名额纳入
      if (b.lane != null && !laneSet.has(b.lane)) return false;
    }
    return true;
  });
}

// ============ 冲突范围派生（申请前可预览，申请后挂档案） ============
export function rentalConflictScope(db: DB, input: {
  sessionId: string; zoneId: ZoneId; lanes?: number[]; partySize: number;
  showerSeats: number; lockerCount: number; containsChildren: boolean;
}, excludeBookingId?: string): RentalConflictScope {
  const session = sessionOf(db, input.sessionId);
  const zone = db.zones.find((z) => z.id === input.zoneId)!;
  const req = requiredLifeguards({ partySize: input.partySize, containsChildren: input.containsChildren, zoneId: input.zoneId });
  const scheduled = db.guardDuties.filter((d) => d.sessionId === session.id && !d.end).length;
  const { inPool, booked } = zoneCounts(db, session.id, input.zoneId);
  const { seats: lockedSeats, hits } = zoneLocked(db, session, input.zoneId);

  const resBookings = affectedResidents(db, session, input.zoneId, input.lanes, excludeBookingId);
  const residentPeople = resBookings.reduce((s, b) => s + Math.max(1, b.partySize), 0);

  // 淋浴/储物柜：按在池居民估算（每 2 人 1 淋浴位、每人 1 柜），叠加包场需求
  const residentShowerUse = Math.ceil(inPool / 2);
  const residentLockerUse = inPool;
  const fMsgs = facilityConflicts({
    showerSeats: input.showerSeats, lockerCount: input.lockerCount,
    residentShowerUse, residentLockerUse,
  });

  const laneCount = input.lanes?.length || zoneLaneCount(db, input.zoneId);
  const overCapacity = inPool + booked + lockedSeats + input.partySize > zone.capacity
    || residentPeople + input.partySize > zone.capacity;

  const lockOverlaps = hits
    .filter((l) => l.id && l.bookingId !== excludeBookingId)
    .map((l) => `与现有锁定「${l.title}」区域/泳道重叠`);

  const messages: string[] = [];
  if (session.publicWelfare) messages.push(`「${session.label}」为居民公益时段，商业包场须先保障公益名额，不能覆盖居民预约`);
  if (resBookings.length)
    messages.push(`占用范围内有 ${resBookings.length} 笔居民预约共 ${residentPeople} 人，须逐人协商改约，居民不同意则压缩包场范围`);
  if (req > scheduled) messages.push(`救生员排班不足：含儿童/人数口径需至少 ${req} 名，当前已排 ${scheduled} 名，须增派 ${req - scheduled} 名`);
  messages.push(...fMsgs);
  if (overCapacity) messages.push(`超出${zone.name}容量：在池 ${inPool}+待入 ${booked}+已锁 ${lockedSeats}+本次 ${input.partySize} > 容量 ${zone.capacity}`);
  messages.push(...lockOverlaps);

  return {
    sessionId: session.id, sessionLabel: session.label, publicWelfare: !!session.publicWelfare,
    requiredLifeguards: req, scheduledLifeguards: scheduled, lifeguardShortage: Math.max(0, req - scheduled),
    showerTotal: FACILITY.showerTotal, showerRequested: input.showerSeats, showerResidentUse: residentShowerUse,
    showerConflict: fMsgs.some((m) => m.includes('淋浴')),
    lockerTotal: FACILITY.lockerTotal, lockerRequested: input.lockerCount, lockerResidentUse: residentLockerUse,
    lockerConflict: fMsgs.some((m) => m.includes('储物柜')),
    residents: resBookings.map((b) => {
      const u = db.users.find((x) => x.id === b.userId);
      return {
        bookingId: b.id, bookingCode: b.code, userId: b.userId, userName: u?.name,
        tags: residentTags(db, b, session), zoneId: b.zoneId, lane: b.lane,
        partySize: Math.max(1, b.partySize), childCount: b.childrenInParty ?? b.childCount ?? 0,
        elder: b.age >= 60 || b.kind === 'elder_morning', memberTier: u?.memberTier,
      };
    }),
    zoneCapacity: zone.capacity, zoneInPool: inPool, zoneBooked: booked, zoneLocked: lockedSeats,
    overCapacity, lockOverlaps, messages,
  };
}

function zoneLaneCount(db: DB, zoneId: ZoneId) {
  // 演示口径：训练区/浅水区 6 道，亲子区 4 道，深水区 4 道
  return zoneId === 'family' || zoneId === 'deep' ? 4 : 6;
}

// ============ 1. 机构申请包场（生成预约+锁区占位+协调档案 pending；不覆盖任何居民预约） ============
export function applyRental(db: DB, org: User, req: RentalApplyReq): { rentalCase: RentalCase; scope: RentalConflictScope; booking: Booking; lock: ZoneLock } {
  if (org.memberTier !== 'institution' && org.role !== 'ops')
    throw new HttpError(403, '仅培训机构账号可申请机构包场');
  const session = sessionOf(db, req.sessionId);
  if (session.poolStatus === 'closed') throw new HttpError(409, '该场次已闭池，不能申请包场');
  const zone = db.zones.find((z) => z.id === req.zoneId);
  if (!zone) throw new HttpError(404, '泳区不存在');
  const partySize = Math.max(10, Math.trunc(Number(req.partySize)) || 0);
  if (partySize < 10) throw new HttpError(400, '机构包场不少于 10 人');
  const adultCount = Math.max(0, Math.trunc(Number(req.adultCount)) || 0);
  const childCount = Math.max(0, Math.trunc(Number(req.childCount)) || 0);
  if (adultCount + childCount !== partySize) throw new HttpError(400, '成人与儿童人数之和须等于总人数');
  const containsChildren = childCount > 0;
  const showerSeats = Math.max(0, Math.trunc(Number(req.showerSeats)) || 0);
  const lockerCount = Math.max(0, Math.trunc(Number(req.lockerCount)) || 0);
  const orgName = (req.orgName || org.name).slice(0, 40);
  const contactName = (req.contactName || org.name).slice(0, 40);
  const contactPhone = (req.contactPhone || org.phone || '').slice(0, 20);
  if (!contactPhone) throw new HttpError(400, '请填写联系人电话');

  // 频繁违规机构被限制：直接拒绝申请（须解除限制后再申请）
  const profile = orgCreditProfile(db, org.id);
  if (profile.rentalRestricted)
    throw new HttpError(409, `该机构当前信用分 ${profile.score}、累计违规 ${profile.violationCount} 次，已被限制后续包场：${profile.restrictionNote ?? '需联系社区运营解除限制或整改'}。`);

  // 生成机构包场预约（对公现场价，先不扣款，协调通过机构确认后进入账单结算）
  const booking: Booking = {
    id: nextId('bk'), code: `B-${db.counters.seq}`, userId: org.id, kind: 'institution_rental',
    sessionId: session.id, zoneId: req.zoneId, lane: undefined,
    periodLabel: `${session.start}-${session.end}`, age: 0, healthPledge: true,
    withChildren: containsChildren, childCount: 0, swimLevel: 'none',
    partySize, childrenInParty: childCount,
    contactName, contactPhone, orgName,
    status: 'booked', paidAmount: 0, paymentMethod: 'cash', createdAt: now(),
  };
  db.bookings.unshift(booking);

  const lock: ZoneLock = {
    id: nextId('lock'), zoneId: req.zoneId,
    lane: req.lanes && req.lanes.length === 1 ? req.lanes[0] : undefined,
    reason: 'institution_rental', title: `${orgName}·包场申请（待核验）`,
    contactName, contactPhone, capacity: partySize, isCommercial: true, bookingId: booking.id,
    showerSeats, lockerCount, independentEntry: !!req.independentEntry,
  };
  session.locks.push(lock);

  const id = nextId('rc');
  const code = `RC-${db.counters.seq}`;
  lock.rentalCaseId = id;
  booking.rentalCaseId = id;

  const req0 = requiredLifeguards({ partySize, containsChildren, zoneId: req.zoneId });
  const qualification: RentalQualification = {
    institutionCert: false, coachNames: '', coachCert: false,
    lifeguardCount: Math.max(req0, profile.requiredExtraLifeguards), lifeguardNames: '', lifeguardCert: false,
    insurancePolicyNo: '', insuranceCoverage: 0, insuranceVerified: false,
    partySize, adultCount, childCount, ageStructure: containsChildren ? `含儿童 ${childCount} 人` : '成人团体',
    containsChildren, companions: [], companionRulePassed: false,
    independentEntry: !!req.independentEntry, separateChanging: !!req.separateChanging,
    showerSeats, lockerCount,
  };

  const scope = rentalConflictScope(db, {
    sessionId: session.id, zoneId: req.zoneId, lanes: req.lanes, partySize,
    showerSeats, lockerCount, containsChildren,
  }, booking.id);

  // 预填逐人居民冲突（运营尚未发起协商，前端展示“待协商”）
  const residentConflicts: ResidentConflict[] = scope.residents.map((r) => ({
    bookingId: r.bookingId, bookingCode: r.bookingCode, userId: r.userId, tags: r.tags,
    zoneId: r.zoneId, lane: r.lane, partySize: r.partySize, childCount: r.childCount,
    compVouchers: 0, refundAmount: 0, status: 'identified',
  }));

  const rc: RentalCase = {
    id, code, sessionId: session.id, orgUserId: org.id, orgName, contactName, contactPhone,
    bookingId: booking.id, lockId: lock.id, status: 'pending',
    zoneId: req.zoneId, lanes: req.lanes, partySize, adultCount, childCount, containsChildren,
    purpose: (req.purpose || '').slice(0, 120), appliedAt: now(), appliedBy: org.name,
    qualification, residentConflicts,
    fee: emptyFee(), violations: [], timeline: [],
  };
  addTimeline(rc, org.name, 'resident', `机构申请包场：${zoneName(db, req.zoneId)}${req.lanes?.length ? ` ${req.lanes.join('/')} 号道` : '整区'} ${partySize} 人（含儿童 ${childCount}）；冲突范围 ${scope.messages.length} 项`);
  db.rentalCases.unshift(rc);
  session.rentalCaseIds = [...(session.rentalCaseIds ?? []), id];

  pushNotification(db, {
    title: `机构包场申请 ${code}：${orgName}（${session.label}）`,
    body: `申请 ${zone.name} ${partySize} 人（儿童 ${childCount}）。冲突范围：${scope.messages.slice(0, 4).join('；') || '无'}。请运营核验机构资质、教练/救生配置、保险、人数年龄结构、儿童陪同、独立出入口与更衣需求。`,
    level: scope.messages.length ? 'critical' : 'warning', roles: ['ops', 'frontdesk'], sessionId: session.id, rentalCaseId: id,
  });

  return { rentalCase: rc, scope, booking, lock };
}

function emptyFee(): RentalFeeBreakdown {
  return { laneFee: 0, periodFee: 0, lifeguardOvertimeFee: 0, lockerFee: 0, showerFee: 0, deposit: 0, total: 0 };
}

// ============ 2. 运营核验机构资质/教练/救生/保险/人数年龄/儿童陪同/独立动线 ============
export function qualifyRental(db: DB, operator: User, caseId: string, req: RentalQualifyReq): RentalCase {
  const rc = getRentalCase(db, caseId);
  if (rc.status !== 'pending' && rc.status !== 'verifying')
    throw new HttpError(409, `当前状态（${rc.status}）不能进行资质核验`);
  const session = sessionOf(db, rc.sessionId);
  const companions = (req.companions ?? []).map((c) => ({
    childName: String(c.childName || '').slice(0, 30),
    childAge: Math.trunc(Number(c.childAge)) || 0,
    companion: String(c.companion || '').slice(0, 30),
    companionPhone: String(c.companionPhone || '').slice(0, 20),
    relation: String(c.relation || '').slice(0, 20),
  }));

  // 儿童离陪规则：包场不放宽，逐人核验陪同人
  let companionPass = true;
  const companionErrors: string[] = [];
  if (rc.containsChildren) {
    const v = validateCompanions(companions, rc.childCount);
    companionPass = v.pass;
    companionErrors.push(...v.missing);
  }

  const need = requiredLifeguards({ partySize: rc.partySize, containsChildren: rc.containsChildren, zoneId: rc.zoneId });
  const configured = Math.max(0, Math.trunc(Number(req.lifeguardCount)) || 0);
  if (configured < need)
    companionErrors.push(`救生员配置不足：按人数/儿童/泳区口径至少 ${need} 名，申报 ${configured} 名`);

  const q: RentalQualification = {
    institutionCert: !!req.institutionCert, institutionCertNote: req.institutionCertNote,
    coachNames: String(req.coachNames || '').slice(0, 200), coachCert: !!req.coachCert, coachCertNote: req.coachCertNote,
    lifeguardCount: configured, lifeguardNames: String(req.lifeguardNames || '').slice(0, 200),
    lifeguardCert: !!req.lifeguardCert, lifeguardCertNote: req.lifeguardCertNote,
    insurancePolicyNo: String(req.insurancePolicyNo || '').slice(0, 40),
    insuranceCoverage: Math.max(0, Math.trunc(Number(req.insuranceCoverage)) || 0),
    insuranceVerified: !!req.insuranceVerified, insuranceExpiry: req.insuranceExpiry,
    partySize: rc.partySize, adultCount: rc.adultCount, childCount: rc.childCount,
    ageStructure: String(req.ageStructure || '').slice(0, 200) || rc.qualification.ageStructure,
    containsChildren: rc.containsChildren, companions, companionRulePassed: companionPass,
    independentEntry: !!req.independentEntry, separateChanging: !!req.separateChanging,
    showerSeats: Math.max(0, Math.trunc(Number(req.showerSeats)) || 0),
    lockerCount: Math.max(0, Math.trunc(Number(req.lockerCount)) || 0),
    rectifyNote: req.rectifyNote,
  };

  // 硬性核验项不通过：可暂存（verifying）要求整改；选择驳回则不产生锁区
  const hardFails: string[] = [];
  if (!q.institutionCert) hardFails.push('机构资质未核验');
  if (!q.coachCert) hardFails.push('教练资质不齐全');
  if (!q.lifeguardCert || configured < need) hardFails.push('救生员配置/资质不足');
  if (!q.insuranceVerified || !q.insurancePolicyNo || q.insuranceCoverage <= 0) hardFails.push('公众责任险未核验或保额未填');
  if (rc.containsChildren && !companionPass) hardFails.push(`儿童陪同规则不满足：${companionErrors.join('；')}`);

  rc.qualification = q;
  if (req.rectifyNote && hardFails.length === 0) {
    rc.status = 'verifying';
    addTimeline(rc, operator.name, 'ops', `资质材料暂存，待机构整改：${req.rectifyNote}`);
    pushNotification(db, {
      title: `包场 ${rc.code} 需补充材料`, level: 'warning', roles: [], userId: rc.orgUserId,
      body: `贵机构 ${session.label} 包场申请需补充/整改：${req.rectifyNote}。整改通过前不得确认包场。`,
      sessionId: session.id, rentalCaseId: rc.id,
    });
    return rc;
  }
  if (hardFails.length) {
    rc.status = 'verifying';
    addTimeline(rc, operator.name, 'ops', `资质核验未通过：${hardFails.join('；')}`);
    pushNotification(db, {
      title: `⛔ 包场 ${rc.code} 资质核验未通过`, level: 'critical', roles: ['ops', 'frontdesk'],
      body: hardFails.join('；'), sessionId: session.id, rentalCaseId: rc.id,
    });
    throw new HttpError(409, `核验未通过，不得进入协调：${hardFails.join('；')}`);
  }

  q.verifiedAt = now();
  q.verifiedBy = operator.name;
  rc.status = 'coordinating';
  addTimeline(rc, operator.name, 'ops', '资质/教练/救生/保险/人数年龄结构/儿童陪同/独立动线全部核验通过，进入居民改约协调');
  pushNotification(db, {
    title: `✅ 包场 ${rc.code} 资质核验通过`, level: 'info', roles: ['ops', 'frontdesk'],
    body: `救生员配置 ${configured} 名（最低 ${need}），保险 ${q.insurancePolicyNo}，儿童陪同 ${companions.length} 人均已登记。进入居民改约协商，平台不覆盖居民预约。`,
    sessionId: session.id, rentalCaseId: rc.id,
  });
  return rc;
}

/** 驳回包场（资质不通过）：释放锁区占位、取消机构预约，不影响居民 */
export function rejectRental(db: DB, operator: User, caseId: string, reason: string): RentalCase {
  const rc = getRentalCase(db, caseId);
  if (!['pending', 'verifying', 'coordinating'].includes(rc.status))
    throw new HttpError(409, '当前状态不能驳回');
  const session = sessionOf(db, rc.sessionId);
  session.locks = session.locks.filter((l) => l.id !== rc.lockId);
  const b = db.bookings.find((x) => x.id === rc.bookingId);
  if (b && b.status !== 'checked_in') b.status = 'cancelled';
  rc.status = 'rejected';
  rc.rejectReason = String(reason || '资质核验不通过').slice(0, 200);
  addTimeline(rc, operator.name, 'ops', `驳回包场并释放锁区：${rc.rejectReason}`);
  pushNotification(db, {
    title: `包场申请 ${rc.code} 未通过`, level: 'warning', roles: [], userId: rc.orgUserId,
    body: `您在 ${session.label} 的包场申请未通过核验：${rc.rejectReason}。锁区已释放，居民预约不受影响。`,
    sessionId: session.id, rentalCaseId: rc.id,
  });
  return rc;
}

// ============ 3. 运营协调：发起居民改约提议（不覆盖预约）+ 方案措施 + 费用拆分 ============
export function coordinateRental(db: DB, operator: User, caseId: string, req: RentalCoordinateReq): RentalCase {
  const rc = getRentalCase(db, caseId);
  if (!['coordinating', 'pending', 'verifying'].includes(rc.status))
    throw new HttpError(409, `当前状态（${rc.status}）不能发起协调`);
  const session = sessionOf(db, rc.sessionId);

  // 3.1 逐笔发起/更新改约提议（居民未答复前可改；已 accepted/rejected 的不可改）
  for (const offer of req.offers ?? []) {
    let c = rc.residentConflicts.find((x) => x.bookingId === offer.bookingId);
    const b = db.bookings.find((x) => x.id === offer.bookingId);
    if (!b) throw new HttpError(404, `居民预约 ${offer.bookingId} 不存在`);
    if (!c) {
      // 协调阶段可能因拆分泳道新增/减少受影响居民：动态补入当前范围内有效居民预约
      const s0 = sessionOf(db, rc.sessionId);
      const tags = residentTags(db, b, s0);
      c = {
        bookingId: b.id, bookingCode: b.code, userId: b.userId, tags, zoneId: b.zoneId, lane: b.lane,
        partySize: Math.max(1, b.partySize), childCount: b.childrenInParty ?? b.childCount ?? 0,
        compVouchers: 0, refundAmount: 0, status: 'identified',
      };
      rc.residentConflicts.push(c);
    }
    if (c.status === 'accepted') throw new HttpError(409, `居民 ${c.bookingCode} 已同意改约，不能变更方案`);
    if (c.status === 'rejected') throw new HttpError(409, `居民 ${c.bookingCode} 已拒绝改约，须保留原预约并压缩包场范围`);

    c.offerSessionId = offer.offerSessionId;
    c.offerZoneId = offer.offerZoneId;
    c.offerLane = offer.offerLane;
    c.compVouchers = Math.max(0, Math.trunc(Number(offer.compVouchers ?? req.residentCompVouchers ?? 1)) || 0);
    c.refundAmount = Math.max(0, Math.round((Number(offer.refundAmount ?? 0)) * 100) / 100);
    c.status = 'proposed';
    c.proposedAt = now();
    c.note = undefined;

    const targetSession = offer.offerSessionId ? sessionOf(db, offer.offerSessionId) : session;
    const targetZone = offer.offerZoneId ? db.zones.find((z) => z.id === offer.offerZoneId) : undefined;
    const isCrossSession = !!offer.offerSessionId && offer.offerSessionId !== session.id;
    // 向居民逐人发送改约提议（居民端真实可见、可答复，不是仅内部记账）
    const nid = pushNotification(db, {
      title: `包场改约协商：您的预约 ${b.code}（${session.label}）`,
      level: 'warning', roles: [], userId: b.userId, sessionId: session.id, rentalCaseId: rc.id,
      body: `因培训机构「${rc.orgName}」申请在该时段包场，平台不会覆盖您的预约。建议改约：${isCrossSession ? `改至「${targetSession.label}」` : '同场分流'}${targetZone ? ` ${targetZone.name}` : ''}${offer.offerLane ? ` ${offer.offerLane} 号道` : ''}。`
        + `若您同意，将${c.refundAmount > 0 ? `原路退费 ¥${c.refundAmount} 并` : ''}发放 ${c.compVouchers} 张补偿券（可抵入场）；若您不同意，将保留您的原预约并压缩包场范围。请在「我的预约」中答复。`,
    });
    c.notificationId = nid;
  }

  // 3.2 协调措施
  const coord: RentalCoordination = {
    approvedLanes: req.approvedLanes,
    approvedStart: req.approvedStart, approvedEnd: req.approvedEnd,
    approvedCapacity: req.approvedCapacity,
    extraLifeguards: Math.max(0, Math.trunc(Number(req.extraLifeguards)) || 0),
    suspendedNonWelfareLanes: req.suspendedNonWelfareLanes,
    residentCompVouchers: Math.max(0, Math.trunc(Number(req.residentCompVouchers ?? 1)) || 0),
    welfareRefund: req.welfareRefund !== false,
    note: req.note, decidedAt: now(), decidedBy: operator.name,
  };
  // 公益泳道不得暂停：暂停非公益泳道校验（被暂停泳道所在泳区/场若标 publicWelfare 整体则禁止）
  for (const sl of coord.suspendedNonWelfareLanes ?? []) {
    const z = db.zones.find((x) => x.id === sl.zoneId);
    if (session.publicWelfare) throw new HttpError(409, '本场为居民公益时段，不得暂停泳道为商业包场腾挪，只能压缩包场范围');
    void z;
  }
  rc.coordination = coord;

  // 3.3 重新计算费用拆分（按拆分泳道/缩短时长/限人/增派救生/储物柜/淋浴；押金按信用上浮）
  const profile = orgCreditProfile(db, rc.orgUserId);
  const finalCapacity = coord.approvedCapacity ?? rc.partySize;
  const laneCount = coord.approvedLanes?.length ?? rc.lanes?.length ?? zoneLaneCount(db, rc.zoneId);
  let hours = hoursBetween(session.start, session.end);
  if (coord.approvedStart && coord.approvedEnd) hours = Math.max(0.5, hoursBetween(coord.approvedStart, coord.approvedEnd));
  rc.fee = rentalFeeOf({
    laneCount, hours, partySize: finalCapacity,
    welfarePeriod: session.publicWelfare || rc.residentConflicts.some((c) => c.tags.includes('public_welfare') || c.tags.includes('elder_morning')),
    extraLifeguards: coord.extraLifeguards, lifeguardHours: hours,
    lockerCount: rc.qualification.lockerCount, showerSeats: rc.qualification.showerSeats,
    depositMultiplier: profile.depositMultiplier,
  });

  rc.status = 'coordinating';
  addTimeline(rc, operator.name, 'ops',
    `发起居民改约协商 ${(req.offers ?? []).length} 笔；方案：${coord.approvedLanes?.length ? `拆分为 ${coord.approvedLanes.join('/')} 号道` : ''}`
    + `${coord.approvedCapacity ? `、限人 ${coord.approvedCapacity}` : ''}、增派救生 ${coord.extraLifeguards} 名；费用合计 ¥${rc.fee.total}（含押金 ¥${rc.fee.deposit}）`);

  // 仍标记为 proposed 的人数（待答复）
  const pending = rc.residentConflicts.filter((c) => c.status === 'proposed').length;
  pushNotification(db, {
    title: `包场 ${rc.code} 改约协商进行中`, level: 'warning', roles: ['ops', 'frontdesk'],
    body: `已向 ${pending} 名居民逐人发起改约提议。居民不同意改约的，保留原预约并自动压缩包场范围；平台不直接覆盖居民预约。`,
    sessionId: session.id, rentalCaseId: rc.id,
  });
  return rc;
}

function hoursBetween(a: string, b: string) {
  const [h1, m1] = a.split(':').map(Number);
  const [h2, m2] = b.split(':').map(Number);
  return Math.max(0, (h2 * 60 + m2 - (h1 * 60 + m1)) / 60);
}

// ============ 4. 居民答复改约：同意=真实迁移+退费/补偿券到账居民端；拒绝=保留原预约+压缩包场 ============
export function answerRebook(db: DB, resident: User, caseId: string, conflictBookingId: string, accept: boolean, note?: string): RentalCase {
  const rc = getRentalCase(db, caseId);
  const c = rc.residentConflicts.find((x) => x.bookingId === conflictBookingId);
  if (!c) throw new HttpError(404, '没有找到与您相关的改约协商');
  if (c.userId !== resident.id && resident.role !== 'ops') throw new HttpError(403, '只能答复本人的改约提议');
  if (c.status !== 'proposed') throw new HttpError(409, `该提议当前状态为 ${c.status}，不能重复答复`);
  const session = sessionOf(db, rc.sessionId);
  const b = db.bookings.find((x) => x.id === c.bookingId)!;
  const org = db.users.find((u) => u.id === rc.orgUserId);

  if (!accept) {
    // 居民不同意：保留原预约，压缩包场范围
    c.status = 'rejected';
    c.answeredAt = now();
    c.note = (note || '居民不同意改约，保留原预约').slice(0, 120);
    // 自动压缩包场：从批准泳道中排除该居民泳道、下调人数上限
    if (!rc.coordination) rc.coordination = { extraLifeguards: 0, residentCompVouchers: 1, welfareRefund: true };
    if (b.lane != null) {
      const lanes = new Set(rc.coordination.approvedLanes ?? rc.lanes ?? []);
      lanes.delete(b.lane);
      if (lanes.size >= 0) rc.coordination.approvedLanes = [...lanes];
    }
    const cap = (rc.coordination.approvedCapacity ?? rc.partySize);
    rc.coordination.approvedCapacity = Math.max(0, cap - Math.max(1, b.partySize));
    addTimeline(rc, resident.name, 'resident', `居民 ${b.code} 拒绝改约：保留原预约，包场范围自动压缩（释放 ${b.zoneId}${b.lane ? ` ${b.lane} 号道` : ''}、名额 ${Math.max(1, b.partySize)}）`);
    pushNotification(db, {
      title: `居民拒绝改约：${b.code} 保留原预约`, level: 'critical', roles: ['ops', 'frontdesk'],
      body: `居民不同意「${rc.orgName}」包场改约，原预约保留；包场范围已压缩，机构侧不得占用该泳道/名额。`,
      sessionId: session.id, rentalCaseId: rc.id,
    });
    pushNotification(db, {
      title: `您的预约 ${b.code} 已保留`, level: 'info', roles: [], userId: resident.id,
      sessionId: session.id, rentalCaseId: rc.id,
      body: '我们已尊重您的选择保留原预约，并相应压缩了机构包场范围，您可按原时段到场。',
    });
    return rc;
  }

  // 居民同意：真实迁移到目标场次/泳道（同事务生成可核验新预约），不退二次费
  const targetSession = c.offerSessionId && c.offerSessionId !== session.id ? sessionOf(db, c.offerSessionId) : session;
  const targetZoneId: ZoneId = c.offerZoneId ?? b.zoneId;
  const targetZone = db.zones.find((z) => z.id === targetZoneId)!;
  // 容量预检：目标泳区在池+待入+锁定+迁入不得超容量
  const { seats: locked } = zoneLocked(db, targetSession, targetZoneId);
  const { inPool, booked } = zoneCounts(db, targetSession.id, targetZoneId);
  const add = Math.max(1, b.partySize);
  if (inPool + booked + locked + add > targetZone.capacity)
    throw new HttpError(409, `改约目标${targetZone.name}容量不足，暂无法确认改约，请联系运营调整改约方案`);

  const newBooking: Booking = {
    ...b,
    id: nextId('bk'), code: `B-${db.counters.seq}`, sessionId: targetSession.id, zoneId: targetZoneId,
    lane: c.offerLane ?? b.lane, periodLabel: `${targetSession.start}-${targetSession.end}`,
    status: 'booked', lockerNo: undefined, checkedInAt: undefined, checkedInBy: undefined,
    createdAt: now(), rentalCaseId: rc.id, rentalRebookedFromId: b.id,
  };
  db.bookings.unshift(newBooking);
  b.status = 'rebooked';
  b.rentalCaseId = rc.id;
  c.status = 'accepted';
  c.answeredAt = now();
  c.newBookingId = newBooking.id;
  c.note = note?.slice(0, 120);

  // 补偿券到账居民端
  const user = db.users.find((u) => u.id === resident.id)!;
  if (c.compVouchers > 0) user.compVouchers = (user.compVouchers ?? 0) + c.compVouchers;
  // 公益时段被压缩：退费或补偿券同步居民端（原路退费，产生流水，不能只内部记账）
  let txnId: string | undefined;
  if (c.refundAmount > 0 && b.paidAmount > 0) {
    const amt = Math.min(c.refundAmount, b.paidAmount);
    if (b.paymentMethod === 'wallet') {
      user.walletBalance = (user.walletBalance ?? 0) + amt;
      const tx = { id: nextId('tx'), at: now(), userId: user.id, amount: amt, reason: `包场改约原路退储值 ${b.code}（${rc.orgName}包场协调）`, sessionId: session.id, rentalCaseId: rc.id };
      db.walletTxns.unshift(tx);
      txnId = tx.id;
    } else if (b.paymentMethod === 'voucher') {
      user.compVouchers = (user.compVouchers ?? 0) + 1;
    }
  }
  c.walletTxnId = txnId;

  const nid = pushNotification(db, {
    title: `改约完成：${b.code} → 新预约 ${newBooking.code}`, level: 'info', roles: [], userId: resident.id,
    sessionId: targetSession.id, rentalCaseId: rc.id,
    body: `感谢您配合机构包场改约。新预约 ${newBooking.code}：${targetSession.label} ${targetZone.name}${newBooking.lane ? ` ${newBooking.lane} 号道` : ''}，可正常核验。`
      + `${c.refundAmount > 0 ? `已原路退费 ¥${c.refundAmount}，` : ''}${c.compVouchers > 0 ? `${c.compVouchers} 张补偿券已到账（可在「我的钱包」查看）。` : ''}`,
  });
  c.notificationId = nid;
  addTimeline(rc, resident.name, 'resident', `居民同意改约 ${b.code} → ${newBooking.code}（${targetSession.label} ${targetZone.name}）；补偿券 ${c.compVouchers} 张${c.refundAmount ? `、退费 ¥${c.refundAmount}` : ''} 已到账居民端`);
  void org;
  return rc;
}

/** 运营代居民标记超时未答复：按保留原预约处理并压缩包场 */
export function expireRebook(db: DB, operator: User, caseId: string, conflictBookingId: string): RentalCase {
  const rc = getRentalCase(db, caseId);
  const c = rc.residentConflicts.find((x) => x.bookingId === conflictBookingId);
  if (!c) throw new HttpError(404, '改约协商不存在');
  if (c.status !== 'proposed') throw new HttpError(409, '仅待答复提议可标记超时');
  const b = db.bookings.find((x) => x.id === c.bookingId)!;
  c.status = 'expired';
  c.answeredAt = now();
  c.note = '超时未答复，按保留原预约处理';
  if (!rc.coordination) rc.coordination = { extraLifeguards: 0, residentCompVouchers: 1, welfareRefund: true };
  if (b.lane != null) {
    const lanes = new Set(rc.coordination.approvedLanes ?? rc.lanes ?? []);
    lanes.delete(b.lane);
    rc.coordination.approvedLanes = [...lanes];
  }
  rc.coordination.approvedCapacity = Math.max(0, (rc.coordination.approvedCapacity ?? rc.partySize) - Math.max(1, b.partySize));
  addTimeline(rc, operator.name, 'ops', `居民 ${b.code} 超时未答复，按规则保留原预约并压缩包场范围`);
  return rc;
}

// ============ 5. 机构确认协调方案（锁定批准范围+费用进入机构账单） ============
export function orgConfirmRental(db: DB, org: User, caseId: string, note?: string): RentalCase {
  const rc = getRentalCase(db, caseId);
  if (rc.orgUserId !== org.id && org.role !== 'ops') throw new HttpError(403, '仅申请机构可确认本包场方案');
  if (rc.status !== 'coordinating') throw new HttpError(409, `当前状态（${rc.status}）不能确认`);

  // 仍有待答复居民：必须等其答复或由运营标记超时；拒绝/超时者已压缩范围
  const pending = rc.residentConflicts.filter((c) => c.status === 'proposed');
  if (pending.length)
    throw new HttpError(409, `仍有 ${pending.length} 名居民尚未答复改约（${pending.map((c) => c.bookingCode).join('、')}），居民不同意或超时须保留原预约并压缩包场后才能确认`);

  const session = sessionOf(db, rc.sessionId);
  const coord = rc.coordination!;
  // 按最终方案更新锁区（拆分泳道/缩短/限人后的实际占用），不得覆盖拒绝改约/未协商居民的泳道
  const lock = session.locks.find((l) => l.id === rc.lockId);
  // 凡未同意改约的居民（identified/rejected/expired）一律保留原预约，其泳道/名额从包场范围剔除
  const keptResidentPeople = rc.residentConflicts
    .filter((c) => c.status !== 'accepted')
    .reduce((s, c) => s + Math.max(1, c.partySize), 0);
  const rejectedLanes = new Set(
    rc.residentConflicts.filter((c) => c.status !== 'accepted' && c.lane != null).map((c) => c.lane!),
  );
  let finalLanes = coord.approvedLanes ?? rc.lanes;
  if (finalLanes) finalLanes = finalLanes.filter((ln) => !rejectedLanes.has(ln));
  const plannedCap = coord.approvedCapacity ?? rc.partySize;
  const finalCapacity = Math.max(0, Math.min(plannedCap, rc.partySize - keptResidentPeople));

  if (lock) {
    lock.title = `${rc.orgName}·包场（已确认）`;
    lock.capacity = finalCapacity;
    lock.rentalCaseId = rc.id;
    lock.showerSeats = rc.qualification.showerSeats;
    lock.lockerCount = rc.qualification.lockerCount;
    lock.independentEntry = rc.qualification.independentEntry;
    if (finalLanes && finalLanes.length === 1) lock.lane = finalLanes[0];
    else if (finalLanes && finalLanes.length > 1) lock.lane = undefined; // 多道：锁区按名额占用
  }
  // 暂停部分非公益泳道（为包场腾挪）：以维护锁占位，明确非公益
  for (const sl of coord.suspendedNonWelfareLanes ?? []) {
    const exists = session.locks.find((l) => l.rentalCaseId === rc.id && l.zoneId === sl.zoneId && l.lane === sl.lane && l.reason === 'maintenance');
    if (!exists) {
      session.locks.push({
        id: nextId('lock'), zoneId: sl.zoneId, lane: sl.lane, reason: 'maintenance',
        title: `为${rc.orgName}包场临时暂停（非公益道）`, contactName: rc.contactName, contactPhone: rc.contactPhone,
        capacity: 0, isCommercial: false, rentalCaseId: rc.id,
      });
    }
  }

  // 费用五项拆分进入机构账单（含押金）
  const bill: OrgBillItem = {
    id: nextId('bill'), orgUserId: rc.orgUserId, orgName: rc.orgName,
    rentalCaseId: rc.id, rentalCode: rc.code, sessionId: session.id, sessionLabel: session.label,
    breakdown: rc.fee, paidAmount: 0, depositHeld: rc.fee.deposit, status: 'unsettled',
    createdAt: now(), note: '机构确认方案后落账；当天结束结算，押金按违规情况退回或抵扣',
  };
  db.orgBills.unshift(bill);
  rc.billId = bill.id;

  rc.status = 'approved';
  rc.orgConfirmedAt = now();
  rc.orgConfirmNote = note?.slice(0, 200);
  rc.coordination!.approvedLanes = finalLanes;
  rc.coordination!.approvedCapacity = finalCapacity;
  addTimeline(rc, org.name, 'resident', `机构确认协调方案：${finalLanes?.length ? finalLanes.join('/') + ' 号道' : '原泳区'}、上限 ${finalCapacity} 人、增派救生 ${coord.extraLifeguards} 名；费用 ¥${rc.fee.total}（泳道 ¥${rc.fee.laneFee}/时段 ¥${rc.fee.periodFee}/救生加班 ¥${rc.fee.lifeguardOvertimeFee}/储物柜 ¥${rc.fee.lockerFee}/淋浴 ¥${rc.fee.showerFee}/押金 ¥${rc.fee.deposit}）进入机构账单`);

  // 保洁/维修包场当天保障确认工单（救生重新站位走当天核验清单，由救生员在岗位上确认）
  db.workTasks.unshift({
    id: nextId('wt'), sessionId: session.id, kind: 'cleaning',
    title: `包场 ${rc.code} 场地保障：地面/淋浴/储物柜/消毒`,
    detail: `包场前确认地面防滑、淋浴区 ${rc.qualification.showerSeats} 位、储物柜 ${rc.qualification.lockerCount} 只、消毒安排。`,
    zoneId: rc.zoneId, assigneeRole: 'cleaner', status: 'pending', createdAt: now(),
    source: 'rental', rentalCaseId: rc.id,
  });
  db.workTasks.unshift({
    id: nextId('wt'), sessionId: session.id, kind: 'disinfection',
    title: `包场 ${rc.code} 设备与消毒安排确认`,
    detail: '确认循环/加氯设备、独立出入口动线、包场结束后水质复测安排。',
    zoneId: rc.zoneId, assigneeRole: 'maintenance', status: 'pending', createdAt: now(),
    source: 'rental', rentalCaseId: rc.id,
  });

  pushNotification(db, {
    title: `✅ 包场 ${rc.code} 机构已确认，等待当天核验`, level: 'info',
    roles: ['ops', 'frontdesk', 'lifeguard', 'cleaner', 'maintenance'], sessionId: session.id, rentalCaseId: rc.id,
    body: `最终范围：${finalLanes?.length ? finalLanes.join('/') + ' 号道' : zoneName(db, rc.zoneId)}、上限 ${finalCapacity} 人；账单 ¥${rc.fee.total} 已入机构账单。当天须前台核验名单/访客身份/保险，救生按人数重新站位，保洁维修确认场地与消毒。`,
  });
  return rc;
}


// ============ 6. 包场当天：分岗核验清单（前台/救生/保洁/维修） ============
export function emptyDayChecklist() {
  return {
    rosterMatched: false, visitorIdChecked: false, insuranceChecked: false,
    guardRepositioned: false, cleaningReady: false, maintenanceReady: false,
  };
}

/** 前台登记实际到场人数（名单核验时），超人数不在此拦截，而在开场/违规环节处理 */
export function setActualCount(db: DB, _user: User, caseId: string, actualCount: number, note?: string): RentalCase {
  const rc = getRentalCase(db, caseId);
  if (!['approved', 'active', 'suspended'].includes(rc.status)) throw new HttpError(409, '包场尚未确认，不能核验名单');
  rc.actualCount = Math.max(0, Math.trunc(Number(actualCount)) || 0);
  addTimeline(rc, _user.name, _user.role, `前台核验机构名单：实际到场 ${rc.actualCount} 人（核准上限 ${rc.coordination?.approvedCapacity ?? rc.partySize}）${note ? `；${note}` : ''}`);
  return rc;
}

export function checkDayItem(db: DB, user: User, caseId: string, req: RentalDayCheckReq): RentalCase {
  const rc = getRentalCase(db, caseId);
  if (!['approved', 'active', 'suspended'].includes(rc.status)) throw new HttpError(409, '包场未到当天核验阶段');
  if (!rc.dayChecklist) rc.dayChecklist = emptyDayChecklist();
  const c = rc.dayChecklist;
  const at = now();
  const note = req.note?.slice(0, 200);
  const role = user.role;

  const staffOnly: Role[] = ['frontdesk', 'lifeguard', 'cleaner', 'maintenance', 'ops'];
  if (!staffOnly.includes(role)) throw new HttpError(403, '仅现场岗位可核验');

  const guardDutyIds: string[] = [];
  switch (req.key) {
    case 'rosterMatched':
      if (role !== 'frontdesk' && role !== 'ops') throw new HttpError(403, '机构名单由前台核验');
      c.rosterMatched = !!req.done; c.rosterMatchedAt = at; c.rosterMatchedBy = user.name; c.rosterNote = note; break;
    case 'visitorIdChecked':
      if (role !== 'frontdesk' && role !== 'ops') throw new HttpError(403, '访客身份由前台核验');
      c.visitorIdChecked = !!req.done; c.visitorIdCheckedAt = at; c.visitorIdCheckedBy = user.name; c.visitorIdNote = note; break;
    case 'insuranceChecked':
      if (role !== 'frontdesk' && role !== 'ops') throw new HttpError(403, '保险由前台现场复核');
      c.insuranceChecked = !!req.done; c.insuranceCheckedAt = at; c.insuranceCheckedBy = user.name; c.insuranceNote = note; break;
    case 'guardRepositioned': {
      if (role !== 'lifeguard' && role !== 'ops') throw new HttpError(403, '救生重新站位由救生员确认');
      // 按包场人数重新站位：为点名救生员补岗（儿童区巡逻/机动），已在岗的不重复上哨
      const session = sessionOf(db, rc.sessionId);
      const names = (req.guardNames ?? []).map((s) => s.trim()).filter(Boolean);
      names.forEach((nm, i) => {
        const g = db.users.find((u) => u.name === nm && u.role === 'lifeguard');
        if (!g) return;
        const busy = db.guardDuties.find((d) => d.sessionId === session.id && d.guardUserId === g.id && !d.end);
        if (busy) { guardDutyIds.push(busy.id); return; }
        const d = {
          id: nextId('gd'), sessionId: session.id, guardUserId: g.id,
          post: (rc.containsChildren && i === 0 ? 'family_patrol' : 'roaming') as 'family_patrol' | 'roaming',
          start: at, note: `包场 ${rc.code} 按 ${rc.actualCount ?? rc.partySize} 人重新站位`,
        };
        db.guardDuties.unshift(d);
        guardDutyIds.push(d.id);
      });
      c.guardRepositioned = !!req.done; c.guardRepositionedAt = at; c.guardRepositionedBy = user.name;
      c.guardRepositionNote = note; c.guardDutyIds = [...(c.guardDutyIds ?? []), ...guardDutyIds];
      break;
    }
    case 'cleaningReady':
      if (role !== 'cleaner' && role !== 'ops') throw new HttpError(403, '地面/淋浴/储物柜/消毒安排由保洁确认');
      c.cleaningReady = !!req.done; c.cleaningReadyAt = at; c.cleaningReadyBy = user.name; c.cleaningNote = note; break;
    case 'maintenanceReady':
      if (role !== 'maintenance' && role !== 'ops') throw new HttpError(403, '设施与消毒安排由维修确认');
      c.maintenanceReady = !!req.done; c.maintenanceReadyAt = at; c.maintenanceReadyBy = user.name; c.maintenanceNote = note; break;
    default:
      throw new HttpError(400, '未知的当天核验项');
  }
  addTimeline(rc, user.name, role, `当天核验·${dayLabel(req.key)} = ${req.done ? '完成' : '未完成'}${note ? `：${note}` : ''}`);
  return rc;
}

function dayLabel(k: string) {
  return ({
    rosterMatched: '机构名单', visitorIdChecked: '访客身份', insuranceChecked: '保险复核',
    guardRepositioned: '救生重新站位', cleaningReady: '保洁场地/消毒安排', maintenanceReady: '维修设施/消毒安排',
  } as Record<string, string>)[k] ?? k;
}

/** 六项核验齐备后开场（前台/运营）；实际人数超上限直接拒绝，须先登记超人数违规并整改 */
export function startRental(db: DB, user: User, caseId: string): RentalCase {
  const rc = getRentalCase(db, caseId);
  if (rc.status !== 'approved') throw new HttpError(409, `当前状态（${rc.status}）不能开场`);
  if (user.role !== 'frontdesk' && user.role !== 'ops') throw new HttpError(403, '仅前台/运营可放行包场开场');
  const c = rc.dayChecklist ?? emptyDayChecklist();
  rc.dayChecklist = c;
  const missing: string[] = [];
  if (!c.rosterMatched) missing.push('机构名单核验');
  if (!c.visitorIdChecked) missing.push('访客身份核验');
  if (!c.insuranceChecked) missing.push('保险现场复核');
  if (!c.guardRepositioned) missing.push('救生员按人数重新站位');
  if (!c.cleaningReady) missing.push('保洁场地/淋浴/储物柜/消毒确认');
  if (!c.maintenanceReady) missing.push('维修设施/消毒安排确认');
  if (missing.length) throw new HttpError(409, `包场开场前核验未完成：${missing.join('、')}`);
  const cap = rc.coordination?.approvedCapacity ?? rc.partySize;
  if ((rc.actualCount ?? rc.partySize) > cap)
    throw new HttpError(409, `实际到场 ${rc.actualCount} 人超过核准上限 ${cap} 人：不得开场，须清退超额人员或先登记「超人数」违规并由运营处置`);

  rc.status = 'active';
  addTimeline(rc, user.name, user.role, `包场开场：名单/访客身份/保险核验通过，救生已按 ${rc.actualCount ?? cap} 人重新站位，保洁维修保障到位`);
  pushNotification(db, {
    title: `🏊 包场 ${rc.code} 已开场（${sessionOf(db, rc.sessionId).label}）`, level: 'info',
    roles: ['ops', 'lifeguard', 'frontdesk'], sessionId: rc.sessionId, rentalCaseId: rc.id,
    body: `${rc.orgName} 包场正式开始，核准 ${cap} 人、实际 ${rc.actualCount ?? cap} 人。出现超人数、超时、占用公益泳道、儿童无人陪同或私自加人，现场可暂停并通知社区运营。`,
  });
  return rc;
}

// ============ 7. 现场违规：超人数/超时/占公益道/儿童脱陪/私自加人 → 可暂停并通知运营、计入信用 ============
export const RENTAL_VIOLATION_LABEL: Record<RentalViolationType, string> = {
  over_capacity: '超人数', overtime: '超时', occupy_welfare: '占用公益泳道',
  child_unaccompanied: '儿童无人陪同', unauthorized_addon: '机构私自加人', other: '其他违规',
};

export function reportRentalViolation(db: DB, user: User, caseId: string, req: {
  type: RentalViolationType; description: string; actualCount?: number; suspend?: boolean;
}): RentalCase {
  const rc = getRentalCase(db, caseId);
  if (!['active', 'suspended', 'approved'].includes(rc.status)) throw new HttpError(409, '仅已核准/进行中的包场可登记违规');
  if (!RENTAL_VIOLATION_LABEL[req.type]) throw new HttpError(400, '违规类型不合法');
  const session = sessionOf(db, rc.sessionId);
  const v: RentalViolation = {
    id: nextId('rv'), type: req.type, at: now(), by: user.name, byRole: user.role,
    description: String(req.description || RENTAL_VIOLATION_LABEL[req.type]).slice(0, 200),
    actualCount: req.actualCount, suspended: !!req.suspend, notifiedOps: true, rectified: false,
  };
  rc.violations.push(v);
  addCreditRecord(db, {
    orgUserId: rc.orgUserId, orgName: rc.orgName, rentalCaseId: rc.id, rentalCode: rc.code,
    at: now(), type: req.type, description: v.description, scoreDelta: CREDIT.violationScore[req.type] ?? -4,
    recordedBy: user.name,
  });

  // 自动立案（现场五角色协同处置）
  try {
    openIncident(db, session.id, 'overbooking', undefined,
      `机构包场 ${rc.code}（${rc.orgName}）现场违规：${RENTAL_VIOLATION_LABEL[req.type]}。${v.description}${req.actualCount ? ` 实际 ${req.actualCount} 人。` : ''}`,
      user.name, 'major');
  } catch { /* 已有进行中事件则忽略 */ }

  addTimeline(rc, user.name, user.role, `现场违规：${RENTAL_VIOLATION_LABEL[req.type]} — ${v.description}${req.suspend ? '；当场暂停包场' : ''}`);

  if (req.suspend) {
    rc.status = 'suspended';
    rc.suspendedAt = now();
    rc.suspendedReason = `${RENTAL_VIOLATION_LABEL[req.type]}：${v.description}`;
    pushNotification(db, {
      title: `⛔ 包场 ${rc.code} 已现场暂停`, level: 'critical', roles: ['ops', 'frontdesk', 'lifeguard'],
      sessionId: session.id, rentalCaseId: rc.id,
      body: `违规类型：${RENTAL_VIOLATION_LABEL[req.type]}。${v.description} 现场已暂停包场并通知社区运营，整改合格后方可恢复；机构信用已记录。`,
    });
  } else {
    pushNotification(db, {
      title: `⚠️ 包场 ${rc.code} 违规记录：${RENTAL_VIOLATION_LABEL[req.type]}`, level: 'warning',
      roles: ['ops', 'frontdesk'], sessionId: session.id, rentalCaseId: rc.id,
      body: v.description,
    });
  }
  return rc;
}

/** 整改合格后恢复包场（运营） */
export function rectifyRentalViolation(db: DB, operator: User, caseId: string, violationId: string, note: string): RentalCase {
  const rc = getRentalCase(db, caseId);
  const v = rc.violations.find((x) => x.id === violationId);
  if (!v) throw new HttpError(404, '违规记录不存在');
  v.rectified = true; v.rectifiedAt = now(); v.rectifyNote = note.slice(0, 200);
  addCreditRecord(db, {
    orgUserId: rc.orgUserId, orgName: rc.orgName, rentalCaseId: rc.id, rentalCode: rc.code,
    at: now(), type: 'rectify_ok', description: `违规已整改：${RENTAL_VIOLATION_LABEL[v.type]} - ${note}`, scoreDelta: 0, recordedBy: operator.name,
  });
  addTimeline(rc, operator.name, 'ops', `违规 ${RENTAL_VIOLATION_LABEL[v.type]} 整改合格：${note}`);
  if (rc.status === 'suspended' && rc.violations.every((x) => x.rectified)) {
    rc.status = 'active';
    rc.resumedAt = now();
    addTimeline(rc, operator.name, 'ops', '全部违规整改完成，恢复包场');
    pushNotification(db, {
      title: `包场 ${rc.code} 恢复进行`, level: 'info', roles: ['ops', 'frontdesk', 'lifeguard'],
      sessionId: rc.sessionId, rentalCaseId: rc.id, body: '现场违规已整改合格，包场恢复。',
    });
  }
  return rc;
}

// ============ 8. 包场结束：清场/清柜/水质复测/设备复位/救生巡查 五项门禁，齐备才恢复居民预约 ============
export function checkCloseoutItem(db: DB, user: User, caseId: string, req: RentalCloseoutReq): RentalCase {
  const rc = getRentalCase(db, caseId);
  if (!['active', 'suspended', 'completed'].includes(rc.status)) throw new HttpError(409, '包场未开场，不能做收尾确认');
  if (!rc.closeout) rc.closeout = emptyCloseout();
  const co = rc.closeout!;
  const at = now();

  if (req.key === 'waterRetested') {
    if (user.role !== 'maintenance' && user.role !== 'lifeguard' && user.role !== 'ops')
      throw new HttpError(403, '水质复测由维修/救生提交');
    let readingId = req.waterReadingId;
    if (req.reading) {
      const ev = evaluateWaterLocal(req.reading);
      if (ev.abnormal) throw new HttpError(409, `复测未达标，不得开放下一场：${ev.fields.join('；')}`);
      const reading = {
        id: nextId('w'), sessionId: rc.sessionId, at, tempC: req.reading.tempC, freeChlorine: req.reading.freeChlorine,
        turbidity: req.reading.turbidity, ph: req.reading.ph, recorder: user.name, abnormal: false, abnormalFields: [] as string[],
        note: `包场 ${rc.code} 结束水质复测`, rentalCaseId: rc.id,
      };
      db.waterReadings.unshift(reading);
      readingId = reading.id;
    }
    if (!readingId) throw new HttpError(400, '请提交复测读数或引用已有达标读数');
    const r = db.waterReadings.find((x) => x.id === readingId);
    if (!r || r.abnormal) throw new HttpError(409, '引用的复测读数不存在或未达标');
    co.waterRetested = true; co.waterRetestedAt = at; co.waterRetestedBy = user.name; co.waterReadingId = readingId;
  } else {
    const map = {
      cleared: { roles: ['cleaner', 'ops'] as Role[], field: 'cleared' as const },
      lockersCleared: { roles: ['cleaner', 'frontdesk', 'ops'] as Role[], field: 'lockersCleared' as const },
      equipmentReset: { roles: ['maintenance', 'ops'] as Role[], field: 'equipmentReset' as const },
      guardPatrolConfirmed: { roles: ['lifeguard', 'ops'] as Role[], field: 'guardPatrolConfirmed' as const },
    }[req.key];
    if (!map) throw new HttpError(400, '未知收尾项');
    if (!map.roles.includes(user.role)) throw new HttpError(403, '该收尾项非本岗位确认');
    (co as any)[map.field] = !!req.done;
    (co as any)[`${map.field}At`] = at;
    (co as any)[`${map.field}By`] = user.name;
  }
  addTimeline(rc, user.name, user.role, `收尾确认·${closeLabel(req.key)} = 完成${req.note ? `：${req.note.slice(0, 120)}` : ''}`);
  return rc;
}

function emptyCloseout() {
  return { cleared: false, lockersCleared: false, waterRetested: false, equipmentReset: false, guardPatrolConfirmed: false, residentResumeNotified: false };
}
function closeLabel(k: string) {
  return ({
    cleared: '清场', lockersCleared: '清储物柜', waterRetested: '水质复测',
    equipmentReset: '设备复位', guardPatrolConfirmed: '救生巡查确认',
  } as Record<string, string>)[k] ?? k;
}
function evaluateWaterLocal(r: { tempC: number; freeChlorine: number; turbidity: number; ph: number }) {
  const fields: string[] = [];
  if (r.tempC < 26 || r.tempC > 28) fields.push('水温超标');
  if (r.freeChlorine < 0.3 || r.freeChlorine > 1.0) fields.push('余氯超标');
  if (r.turbidity > 1.0) fields.push('浊度超标');
  if (r.ph < 7.0 || r.ph > 7.8) fields.push('pH 超标');
  return { abnormal: fields.length > 0, fields };
}

/** 五项齐备 → 恢复居民预约（释放包场锁区、居民端同步通知）；未复测或未清场不得开放下一场 */
export function reopenAfterRental(db: DB, user: User, caseId: string): RentalCase {
  const rc = getRentalCase(db, caseId);
  if (user.role !== 'ops' && user.role !== 'lifeguard') throw new HttpError(403, '仅运营/救生班长可确认恢复开放');
  if (rc.status === 'suspended') throw new HttpError(409, '包场仍处暂停状态，须先完成全部违规整改恢复后再清场开放');
  if (rc.status !== 'active' && rc.status !== 'completed') throw new HttpError(409, '包场未在进行中');
  const co = rc.closeout;
  const missing: string[] = [];
  if (!co?.cleared) missing.push('清场');
  if (!co?.lockersCleared) missing.push('清储物柜');
  if (!co?.waterRetested) missing.push('水质复测达标');
  if (!co?.equipmentReset) missing.push('设备复位');
  if (!co?.guardPatrolConfirmed) missing.push('救生巡查确认');
  if (missing.length) throw new HttpError(409, `未复测或未清场不得开放下一场，尚缺：${missing.join('、')}`);
  const c0 = co!;

  const session = sessionOf(db, rc.sessionId);
  // 释放本包场全部锁区（含为腾挪暂停的非公益道），居民预约恢复
  session.locks = session.locks.filter((l) => l.rentalCaseId !== rc.id && l.id !== rc.lockId);

  const nid = pushNotification(db, {
    title: `🟢 包场结束，居民预约恢复：${session.label}`, level: 'info', roles: [],
    sessionId: session.id, rentalCaseId: rc.id,
    body: `培训机构「${rc.orgName}」包场 ${rc.code} 已完成清场、清储物柜、水质复测达标、设备复位与救生巡查确认，场地恢复居民使用，后续居民预约正常核验入场。`,
  });
  c0.residentResumeNotified = true;
  c0.resumeNotificationId = nid;
  c0.reopenedAt = now();
  c0.reopenedBy = user.name;

  rc.status = 'completed';
  rc.completedAt = now();
  addTimeline(rc, user.name, user.role, '清场/清柜/水质复测/设备复位/救生巡查五项确认完成，释放包场锁区，居民预约恢复并已居民端同步通知');
  addCreditRecord(db, {
    orgUserId: rc.orgUserId, orgName: rc.orgName, rentalCaseId: rc.id, rentalCode: rc.code,
    at: now(), type: 'rental_done', description: '包场按规完成并恢复居民预约', scoreDelta: CREDIT.violationScore.rental_done, recordedBy: user.name,
  });
  return rc;
}

// ============ 9. 账单结算（费用五项拆分 + 押金抵扣） ============
export function settleRentalBill(db: DB, operator: User, caseId: string, req: {
  paymentMethod?: 'wallet' | 'cash'; depositDeducted?: number; note?: string;
}): OrgBillItem {
  const rc = getRentalCase(db, caseId);
  const bill = db.orgBills.find((x) => x.id === rc.billId);
  if (!bill) throw new HttpError(404, '该包场暂无账单（机构确认方案后落账）');
  if (bill.status === 'settled') throw new HttpError(409, '账单已结算');
  const deduct = Math.max(0, Math.round((Number(req.depositDeducted ?? 0)) * 100) / 100);
  if (deduct > bill.depositHeld) throw new HttpError(400, '押金抵扣金额不能超过已收押金');
  // 应收 = 费用合计 - 押金（押金单独收退）。演示口径：账单总额含押金，机构按 total-deposit 支付服务费，押金抵扣后退补
  const serviceFee = bill.breakdown.total - bill.breakdown.deposit;
  const method = req.paymentMethod ?? 'cash';
  if (method === 'wallet') {
    const org = db.users.find((u) => u.id === rc.orgUserId)!;
    if ((org.walletBalance ?? 0) < serviceFee) throw new HttpError(402, '机构储值余额不足，请改用对公/现场结算');
    org.walletBalance = (org.walletBalance ?? 0) - serviceFee;
    db.walletTxns.unshift({
      id: nextId('tx'), at: now(), userId: org.id, amount: -serviceFee,
      reason: `包场 ${rc.code} 服务费（泳道/时段/救生加班/储物柜/淋浴）`, sessionId: rc.sessionId, rentalCaseId: rc.id,
    });
    if (deduct > 0) {
      // 押金抵扣违规赔偿：记一笔扣款流水（演示中押金视同已预授，抵扣入泳池公共账户）
      db.walletTxns.unshift({
        id: nextId('tx'), at: now(), userId: org.id, amount: -deduct,
        reason: `包场 ${rc.code} 押金抵扣（违规赔偿）`, sessionId: rc.sessionId, rentalCaseId: rc.id,
      });
    }
  }
  bill.paidAmount = serviceFee + deduct;
  bill.status = deduct > 0 ? 'deducted' : 'settled';
  bill.settledAt = now();
  bill.note = `${req.note ?? ''} 服务费 ¥${serviceFee}（${method === 'wallet' ? '机构储值支付' : '对公/现场登记'}），押金 ¥${bill.depositHeld}${deduct ? ` 中抵扣 ¥${deduct}，余 ¥${bill.depositHeld - deduct} 退回` : ' 全额退回'}。`;
  addTimeline(rc, operator.name, 'ops', `机构账单结算：服务费 ¥${serviceFee}，押金抵扣 ¥${deduct}，合计入账 ¥${bill.paidAmount}`);
  return bill;
}

// ============ 10. 运营对机构采取信用限制（频繁违规：限制包场/增派救生/加押金） ============
export function setOrgRestriction(db: DB, operator: User, orgUserId: string, req: {
  rentalRestricted: boolean; requiredExtraLifeguards?: number; depositMultiplier?: number; note?: string;
}): OrgCreditProfile {
  const org = db.users.find((u) => u.id === orgUserId);
  if (!org) throw new HttpError(404, '机构账号不存在');
  addCreditRecord(db, {
    orgUserId, orgName: org.name, at: now(), type: 'other',
    description: req.rentalRestricted
      ? `运营限制该机构后续包场：强制增派救生 ${req.requiredExtraLifeguards ?? 1} 名、押金 ×${req.depositMultiplier ?? 2}。${req.note ?? ''}`
      : `运营解除该机构包场限制。${req.note ?? ''}`,
    scoreDelta: 0, recordedBy: operator.name,
    restrictionOverride: {
      rentalRestricted: !!req.rentalRestricted,
      requiredExtraLifeguards: Math.max(0, Math.trunc(Number(req.requiredExtraLifeguards ?? (req.rentalRestricted ? 1 : 0))) || 0),
      depositMultiplier: Math.max(1, Number(req.depositMultiplier ?? (req.rentalRestricted ? 2 : 1)) || 1),
      note: req.note, by: operator.name, at: now(),
    },
  });
  return orgCreditProfile(db, orgUserId);
}

// ============ 11. 未清场/未复测不得开放下一场：对后续场次的拦截判断 ============
/**
 * 返回阻挡目标场次开放的上一场包场：
 * 同日更早（或同场已过结束时间）的包场仍处 active/suspended（未完成五项收尾）即阻挡。
 */
export function priorRentalBlocking(db: DB, target: Session): RentalCase | undefined {
  const targetStart = new Date(`${target.date}T${target.start}:00`).getTime();
  for (const rc of db.rentalCases) {
    if (rc.status === 'completed' || rc.status === 'rejected' || rc.status === 'cancelled') continue;
    const s = db.sessions.find((x) => x.id === rc.sessionId);
    if (!s || s.date !== target.date) continue;
    const sStart = new Date(`${s.date}T${s.start}:00`).getTime();
    if (sStart > targetStart) continue;
    // 已开场但未收尾完成，且其场次时间已到/已过
    if ((rc.status === 'active' || rc.status === 'suspended') && !rc.closeout?.reopenedAt) return rc;
  }
  return undefined;
}

/** 实时看板用：本场生效中的包场摘要 */
export function activeRentalsOf(db: DB, session: Session) {
  return db.rentalCases
    .filter((rc) => rc.sessionId === session.id && ['approved', 'active', 'suspended'].includes(rc.status))
    .map((rc) => ({
      rentalCaseId: rc.id, code: rc.code, orgName: rc.orgName, zoneId: rc.zoneId,
      lanes: rc.coordination?.approvedLanes ?? rc.lanes,
      approvedCapacity: rc.coordination?.approvedCapacity ?? rc.partySize,
      actualCount: rc.actualCount ?? 0,
      status: rc.status as RentalCaseStatus,
      extraLifeguards: rc.coordination?.extraLifeguards ?? 0,
    }));
}
