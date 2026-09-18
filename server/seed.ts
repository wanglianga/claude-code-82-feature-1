import type {
  DB, User, Zone, Session, Booking, WaterReading, Equipment, GuardDuty,
  PatrolIssue, WorkTask, Complaint, Notification, WalletTxn, CoachingLesson,
  CrampRescue, GuardTrainingItem, Institution, InstitutionRental, RentalResidentConflict,
} from '../shared/types.js';

// 以“当前时刻”为锚生成演示数据：上午公众场正在进行、在池有人、水质读数与上哨时间都在过去，
// 保证任何时间启动容器，业务链路（含闭池后“复测必须晚于闭池时间”）都自洽。
const date = new Date().toISOString().slice(0, 10);
const pad = (n: number) => String(n).padStart(2, '0');
function hhmm(offsetMin: number) {
  const d = new Date(Date.now() + offsetMin * 60000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const rel = (deltaMin: number) => new Date(Date.now() + deltaMin * 60000).toISOString();

let seq = 100;
const nid = (p: string) => `${p}-${++seq}`;

export function seed(): DB {
  seq = 100;

  const users: User[] = [
    // ---- 居民 ----
    { id: 'u-zhang', username: 'zhang', password: '123456', name: '张为民', role: 'resident', phone: '13800000001', memberTier: 'gold', deepCert: true, walletBalance: 320, compVouchers: 0, age: 42 },
    { id: 'u-li', username: 'li', password: '123456', name: '李娟', role: 'resident', phone: '13800000002', memberTier: 'silver', deepCert: false, walletBalance: 80, compVouchers: 0, age: 35 },
    { id: 'u-wang', username: 'wang', password: '123456', name: '王建国', role: 'resident', phone: '13800000003', memberTier: 'normal', deepCert: false, walletBalance: 0, compVouchers: 0, age: 68 },
    { id: 'u-zhao', username: 'zhao', password: '123456', name: '赵晓（访客）', role: 'resident', phone: '13800000004', memberTier: 'guest', deepCert: false, walletBalance: 0, compVouchers: 0, age: 29 },
    { id: 'u-lan', username: 'lan', password: '123456', name: '蓝鲸游泳培训', role: 'resident', phone: '13800000005', memberTier: 'institution', walletBalance: 2000, compVouchers: 0 },
    // ---- 工作人员 ----
    { id: 'u-fd', username: 'frontdesk', password: '123456', name: '陈前台', role: 'frontdesk' },
    { id: 'u-lg1', username: 'lifeguard', password: '123456', name: '刘救生', role: 'lifeguard' },
    { id: 'u-lg2', username: 'lifeguard2', password: '123456', name: '周救生', role: 'lifeguard' },
    { id: 'u-cl', username: 'cleaner', password: '123456', name: '吴保洁', role: 'cleaner' },
    { id: 'u-mt', username: 'maintenance', password: '123456', name: '郑维修', role: 'maintenance' },
    { id: 'u-ops', username: 'ops', password: '123456', name: '孙运营', role: 'ops' },
  ];

  const zones: Zone[] = [
    { id: 'training', name: '训练泳道区', capacity: 48, risk: 'medium', requireCert: false,
      rules: ['按泳道游进，慢速靠右', '禁止潜泳超过 15 米', '教练课走专用教学道'] },
    { id: 'family', name: '亲子儿童区', capacity: 40, risk: 'medium', requireCert: false, isChildArea: true,
      rules: ['14 岁以下儿童须成人一对一陪同', '禁止奔跑推搡', '浮力玩具仅限本区域'] },
    { id: 'deep', name: '深水区', capacity: 30, risk: 'high', requireCert: true,
      rules: ['凭深水合格证入场', '连续游 200 米测试通过', '严禁初学者进入'] },
    { id: 'shallow', name: '浅水休闲区', capacity: 36, risk: 'low', requireCert: false,
      rules: ['水深 1.2 米', '禁止跳水', '老人晨泳优先使用 1-2 号道'] },
  ];

  const sessions: Session[] = [
    {
      id: 's-am', label: '早场·老人晨泳（公益）', date, start: hhmm(-200), end: hhmm(-80),
      poolStatus: 'normal', maxCapacity: 110, publicWelfare: true, locks: [], closureIds: [], createdAt: rel(-230),
    },
    {
      id: 's-mid', label: '当前场次·上午公众场', date, start: hhmm(-55), end: hhmm(65),
      poolStatus: 'normal', maxCapacity: 154, locks: [
        { id: 'lock-1', zoneId: 'training', lane: 1, reason: 'coaching', title: '蓝鲸培训·自由泳提高班', contactName: '赵晓', contactPhone: '13800000005', capacity: 8, isCommercial: false },
      ],
      // 早场老人晨泳 2 号道抽筋救援复盘后，站位调整（第 1 版）带入本场：救生巡查重点关注同一泳道
      guardFocusLanes: [
        { zoneId: 'shallow', lane: 2, version: 1, by: '刘救生', history: [],
          reason: '上场（早场·老人晨泳）该泳道发生抽筋救援 CR-2059，第1版站位策略：复盘要求加强浅水岗瞭望与老人泳道提醒',
          rescueId: 'cr-seed-1', fromSessionId: 's-am', at: rel(-85) },
      ],
      closureIds: [], createdAt: rel(-120),
    },
    {
      id: 's-pm', label: '下午公众场', date, start: hhmm(150), end: hhmm(270),
      poolStatus: 'normal', maxCapacity: 154, locks: [],
      guardFocusLanes: [
        { zoneId: 'shallow', lane: 2, version: 1, by: '刘救生', history: [],
          reason: '早场老人晨泳 2 号道抽筋救援 CR-2059 第1版站位策略：持续重点关注',
          rescueId: 'cr-seed-1', fromSessionId: 's-am', at: rel(-85) },
      ],
      closureIds: [], createdAt: rel(-60),
    },
    {
      id: 's-eve', label: '晚场·暑期儿童高峰', date, start: hhmm(360), end: hhmm(480),
      poolStatus: 'normal', maxCapacity: 154, locks: [], closureIds: [], createdAt: rel(-30),
    },
  ];

  const bookings: Booking[] = [
    {
      id: nid('bk'), code: 'B-2061', userId: 'u-zhang', kind: 'personal', sessionId: 's-mid', zoneId: 'training', lane: 3,
      periodLabel: `${sessions[1].start}-${sessions[1].end}`, age: 42, healthPledge: true, healthCode: 'green', medicalCert: true,
      withChildren: false, childCount: 0, swimLevel: 'advanced', partySize: 1, status: 'checked_in',
      paidAmount: 25, paymentMethod: 'wallet', lockerNo: 'A12', checkedInAt: rel(-18), checkedInBy: '陈前台', createdAt: rel(-95),
    },
    {
      id: nid('bk'), code: 'B-2062', userId: 'u-li', kind: 'parent_child', sessionId: 's-mid', zoneId: 'family',
      periodLabel: `${sessions[1].start}-${sessions[1].end}`, age: 35, healthPledge: true, healthCode: 'green', medicalCert: false,
      withChildren: true, childCount: 1, childCompanion: '李娟（母亲）', childCompanionPhone: '13800000002',
      swimLevel: 'beginner', partySize: 2, childrenInParty: 1, status: 'booked',
      paidAmount: 40, paymentMethod: 'wallet', createdAt: rel(-80),
    },
    {
      id: nid('bk'), code: 'B-2063', userId: 'u-wang', kind: 'elder_morning', sessionId: 's-am', zoneId: 'shallow', lane: 1,
      periodLabel: `${sessions[0].start}-${sessions[0].end}`, age: 68, healthPledge: true, healthCode: 'green', medicalCert: true,
      withChildren: false, childCount: 0, swimLevel: 'beginner', partySize: 1, status: 'checked_in',
      paidAmount: 0, paymentMethod: 'cash', lockerNo: 'B03', checkedInAt: rel(-190), checkedInBy: '陈前台', createdAt: rel(-210),
    },
    {
      id: nid('bk'), code: 'B-2064', userId: 'u-zhao', kind: 'guest', sessionId: 's-mid', zoneId: 'training', lane: 4,
      periodLabel: `${sessions[1].start}-${sessions[1].end}`, age: 29, healthPledge: true, healthCode: 'none', medicalCert: false,
      withChildren: false, childCount: 0, swimLevel: 'intermediate', partySize: 1, status: 'booked',
      paidAmount: 45, paymentMethod: 'cash', createdAt: rel(-55),
    },
    {
      id: nid('bk'), code: 'B-2065', userId: 'u-zhang', kind: 'personal', sessionId: 's-mid', zoneId: 'deep',
      periodLabel: `${sessions[1].start}-${sessions[1].end}`, age: 42, healthPledge: true, healthCode: 'green', medicalCert: true,
      withChildren: false, childCount: 0, swimLevel: 'advanced', partySize: 1, status: 'booked',
      paidAmount: 25, paymentMethod: 'voucher', createdAt: rel(-50),
    },
    {
      id: nid('bk'), code: 'B-2066', userId: 'u-li', kind: 'parent_child', sessionId: 's-pm', zoneId: 'family',
      periodLabel: `${sessions[2].start}-${sessions[2].end}`, age: 35, healthPledge: true, healthCode: 'green', medicalCert: false,
      withChildren: true, childCount: 1, childCompanion: '李娟（母亲）', childCompanionPhone: '13800000002',
      swimLevel: 'beginner', partySize: 2, childrenInParty: 1, status: 'booked',
      paidAmount: 40, paymentMethod: 'wallet', createdAt: rel(-35),
    },
  ];

  const waterReadings: WaterReading[] = [
    {
      id: nid('w'), sessionId: 's-mid', at: rel(-12), tempC: 27.2, freeChlorine: 0.8, turbidity: 0.6, ph: 7.3,
      recorder: '刘救生', abnormal: false, abnormalFields: [], note: '开场前检测，各项正常',
    },
  ];

  const equipment: Equipment[] = [
    { id: 'eq-pump', name: '循环水泵 1 号', zoneId: 'all', status: 'normal', lastCheck: rel(-40) },
    { id: 'eq-cl', name: '自动加氯机', zoneId: 'all', status: 'normal', lastCheck: rel(-40) },
    { id: 'eq-aed', name: 'AED 除颤仪', zoneId: 'all', status: 'normal', lastCheck: rel(-40), note: '电极片有效期至年底' },
    { id: 'eq-dehum', name: '除湿机（更衣室）', zoneId: 'all', status: 'warning', lastCheck: rel(-40), note: '排水略有堵塞，地面易湿滑' },
    { id: 'eq-cam', name: '水下监控', zoneId: 'deep', status: 'normal', lastCheck: rel(-40) },
  ];

  const guardDuties: GuardDuty[] = [
    // 早场老人晨泳抽筋救援：刘救生在浅水岗施救后换岗给周救生（与 cr-seed-1 关联）
    { id: nid('gd'), sessionId: 's-am', guardUserId: 'u-lg1', post: 'tower_shallow', start: rel(-200), end: rel(-160), relief: '周救生', note: '抽筋救援 CR-2059 后换岗：陪同抽筋泳客岸边观察', crampRescueId: 'cr-seed-1' },
    { id: nid('gd'), sessionId: 's-am', guardUserId: 'u-lg2', post: 'tower_shallow', start: rel(-160), end: rel(-80), note: '接替抽筋救援站位，重点关注 2 号道', crampRescueId: 'cr-seed-1' },
    { id: nid('gd'), sessionId: 's-mid', guardUserId: 'u-lg1', post: 'tower_deep', start: rel(-50) },
    { id: nid('gd'), sessionId: 's-mid', guardUserId: 'u-lg2', post: 'family_patrol', start: rel(-50) },
  ];

  const patrolIssues: PatrolIssue[] = [
    {
      id: nid('pi'), sessionId: 's-mid', at: rel(-25), type: 'wet_floor', severity: 'minor',
      description: '女更衣室出口地砖湿滑，已放置小心地滑提示牌', location: '更衣室出口',
      reporter: '吴保洁', assigneeRole: 'cleaner', assigneeName: '吴保洁', status: 'handling',
    },
  ];

  const workTasks: WorkTask[] = [
    { id: nid('wt'), sessionId: 's-mid', kind: 'cleaning', title: '淋浴区地漏清掏', detail: '高峰前清掏毛发、补充地垫', zoneId: 'all', assigneeRole: 'cleaner', assigneeName: '吴保洁', status: 'in_progress', createdAt: rel(-45), source: 'routine' },
    { id: nid('wt'), sessionId: 's-mid', kind: 'disinfection', title: '开场前氯消毒', detail: '按 0.8mg/L 余氯标准完成开场消毒', zoneId: 'all', assigneeRole: 'maintenance', assigneeName: '郑维修', status: 'done', createdAt: rel(-70), doneAt: rel(-55), result: '余氯 0.8，达标', source: 'routine' },
  ];

  const complaints: Complaint[] = [
    { id: nid('cp'), userId: 'u-li', at: rel(-300), category: '拥挤', content: '昨晚高峰场儿童区太挤，希望限流并加派救生员。', status: 'replied', reply: '已将晚场儿童区预约上限下调 15%，并增设机动巡视岗。', repliedAt: rel(-270) },
  ];

  const notifications: Notification[] = [
    { id: nid('nt'), at: rel(-50), title: '今日开场正常', body: '各泳区水质达标，当前场次准时开放。老人晨泳公益场免费。', level: 'info', roles: [], sessionId: 's-mid' },
    { id: nid('nt'), at: rel(-84), title: '🛟 本场救生巡查重点关注：浅水休闲区 2 号道', body: '早场老人晨泳该泳道发生抽筋救援 CR-2059（已复盘），站位调整要求浅水岗加强瞭望、开场广播热身提醒。请当班救生员在实时看板确认。', level: 'warning', roles: ['lifeguard', 'ops'], sessionId: 's-mid' },
    { id: nid('nt'), at: rel(-30), title: '商业包场冲突待协调', body: '蓝鲸培训申请在下午公众场整租亲子儿童区（30 人），与居民亲子公益预约（B-2066）存在冲突，请运营在同场次页面协调。', level: 'warning', roles: ['ops', 'frontdesk'], sessionId: 's-pm' },
  ];

  const walletTxns: WalletTxn[] = [
    { id: nid('tx'), at: rel(-95), userId: 'u-zhang', amount: -25, reason: '预约 B-2061 训练区入场', sessionId: 's-mid' },
    { id: nid('tx'), at: rel(-80), userId: 'u-li', amount: -40, reason: '预约 B-2062 亲子时段', sessionId: 's-mid' },
    { id: nid('tx'), at: rel(-35), userId: 'u-li', amount: -40, reason: '预约 B-2066 亲子时段', sessionId: 's-pm' },
  ];

  const lessons: CoachingLesson[] = [
    { id: 'ls-1', coachName: '马教练', title: '自由泳提高班', sessionId: 's-mid', zoneId: 'training', lane: 1, capacity: 8, enrolled: 5, price: 120, studentIds: ['u-zhang'] },
    { id: 'ls-2', coachName: '林教练', title: '少儿启蒙班', sessionId: 's-eve', zoneId: 'family', lane: 0, capacity: 6, enrolled: 6, price: 150, studentIds: ['u-li'] },
  ];

  // ---- 早场老人晨泳抽筋救援（已完成三项收尾确认、已复盘、站位调整带入当前场） ----
  const crSeed: CrampRescue = {
    id: 'cr-seed-1', code: 'CR-2059', sessionId: 's-am', zoneId: 'shallow', lane: 2,
    foundAt: rel(-170), guardName: '刘救生', crampPart: 'calf',
    patronDesc: '老人晨泳男泳客（约 65 岁，柜 B03），自称下水前未充分热身',
    method: 'wading', shoreTreatment: '搀扶上岸后坐姿伸展小腿、热敷保暖、补充温水，岸边观察 20 分钟无异常',
    familyContacted: true, familyNote: '已由前台电话告知其子，家属知晓并到馆接送',
    medicalAdvised: false, medicalNote: '生命体征平稳，本人与家属均拒绝送医，签署知情登记',
    closure: {
      guard_relief: { done: true, at: rel(-160), by: '刘救生', note: '周救生接替浅水岗，刘救生陪同泳客岸边观察' },
      lane_reopen: { done: true, at: rel(-145), by: '刘救生', note: '2 号道围观泳客疏散后重新开放' },
      order_restored: { done: true, at: rel(-140), by: '周救生', note: '浅水各道游进秩序恢复' },
    },
    adjustments: [
      { version: 1, at: rel(-150), by: '刘救生', content: '老人晨泳场浅水岗增加一名机动巡视，2 号道两端各安排瞭望提醒，下水前广播热身提示' },
    ],
    laneSuspended: false, laneSuspendReason: '抽筋救援处置，泳道临时关闭',
    reviewedAt: rel(-90), reviewedBy: '孙运营',
    reviewSummary: '发现及时、施救规范；暴露问题为晨泳老人热身不足、浅水岗单人瞭望有盲区。已调整为双人浅水岗并加强热身广播。',
    trainingIds: ['gt-seed-1'], intoSchedule: true, createdAt: rel(-170),
  };

  const crampRescues: CrampRescue[] = [crSeed];

  const guardTraining: GuardTrainingItem[] = [
    {
      id: 'gt-seed-1', source: 'cramp_rescue', sourceRescueId: 'cr-seed-1',
      sessionId: 's-am', sessionLabel: '早场·老人晨泳（公益）', at: rel(-90),
      title: '抽筋救援复盘培训：浅水休闲区 2 号道（CR-2059）',
      content: '老年泳客小腿抽筋的识别与岸上伸援/下水搀扶要点；晨泳场开场 10 分钟热身广播；浅水岗双人交叉瞭望，重点关注 1-2 号道老人泳客。',
      targetGuardNames: ['刘救生', '周救生'], intoSchedule: true,
      scheduleNote: '本周晨泳场浅水岗双人值守，由刘救生带教一次',
      recordedBy: '孙运营', done: false,
    },
  ];

  sessions[0].crampRescueCount = 1;

  // ---- 机构包场与居民公益时段冲突协调（下午场亲子区：蓝鲸少儿包场 vs 居民亲子预约 B-2066） ----
  const pm = sessions[2];
  const bk2066 = bookings.find((b) => b.code === 'B-2066')!;

  const institutionLan: Institution = {
    id: 'inst-lan', name: '蓝鲸游泳培训', userId: 'u-lan',
    contactName: '赵晓', contactPhone: '13800000005',
    creditScore: 82, deposit: 500, blocked: false, requiredExtraGuards: 0,
    creditEvents: [
      { id: 'ce-seed-1', at: rel(-60 * 24 * 8), type: 'overtime', title: '超时滞留', detail: '上月晚场包场超时 18 分钟清场', points: 8, recordedBy: '孙运营', rectified: true, rectifiedAt: rel(-60 * 24 * 7), rectifiedNote: '已书面承诺按时清场', rentalId: undefined },
      { id: 'ce-seed-2', at: rel(-60 * 24 * 3), type: 'over_capacity', title: '实际超人数', detail: '签到 32 人超过批准 30 人', points: 10, recordedBy: '陈前台', rectified: true, rectifiedAt: rel(-60 * 24 * 3), rectifiedNote: '当日劝退 2 人，已整改' },
    ],
    createdAt: rel(-60 * 24 * 30),
  };

  const rentalConflictLi: RentalResidentConflict = {
    bookingId: bk2066.id, bookingCode: bk2066.code, userId: 'u-li', userName: '李娟',
    zoneId: bk2066.zoneId, lane: bk2066.lane, kind: bk2066.kind, partySize: 2, children: 1,
    paidAmount: 40, paymentMethod: 'wallet', memberTier: 'silver',
    tags: ['parent_child', 'child', 'stored_value'],
    publicWelfare: false, preference: 'pending',
    offerSessionId: 's-eve', offerVoucher: true,
    offerNote: '可改约至晚场亲子区，另补偿 1 张券', notifiedAt: rel(-25),
  };

  const rentalSeed: InstitutionRental = {
    id: 'ir-seed-1', code: 'IR-2101', institutionId: 'inst-lan', applicantUserId: 'u-lan',
    sessionId: 's-pm', requestZoneId: 'family', requestLanes: [],
    requestStart: pm.start, requestEnd: pm.end,
    partySize: 30, adultCount: 6, childCount: 24, ageMin: 7, ageMax: 12,
    hasChildren: true, companions: 8,
    companionRequirement: '未成年学员每 3 名至少 1 名成人陪同（1:3），教练/救生员不计入陪同',
    purpose: '暑期少儿自由泳提高集训',
    facility: { showerCapacity: 60, lockerCount: 220, lockersNeeded: 30, independentChanging: true, showerNote: '使用东侧独立更衣淋浴区' },
    qualifications: [
      { key: 'businessLicense', detail: '办学许可证 教民13201007号，有效期至 2027-12-31', state: 'verified', verifiedBy: '孙运营', verifiedAt: rel(-40) },
      { key: 'coachCert', detail: '社会体育指导员（游泳）×3：马教练/林教练/高教练', state: 'verified', verifiedBy: '孙运营', verifiedAt: rel(-40) },
      { key: 'guardCert', detail: '救生员证 ×2（随队），另申请场馆增派 1 名', state: 'verified', verifiedBy: '孙运营', verifiedAt: rel(-40) },
      { key: 'insurance', detail: '保单号 INS-LJ-2026-088，有效期至 2026-12-31', state: 'verified', verifiedBy: '孙运营', verifiedAt: rel(-40) },
      { key: 'independentAccess', detail: '使用东侧独立出入口，与居民流线分离', state: 'unverified' },
      { key: 'changingRoom', detail: '申请东侧独立更衣淋浴区（容量 60）', state: 'unverified' },
    ],
    coachAssignments: [
      { name: '马教练', certNo: 'SWIM-COACH-0231' },
      { name: '林教练', certNo: 'SWIM-COACH-0417' },
    ],
    insurancePolicyNo: 'INS-LJ-2026-088', insuranceExpiry: '2026-12-31',
    status: 'coordinating',
    conflictPreview: {
      sessionId: 's-pm', sessionLabel: pm.label, date: pm.date, start: pm.start, end: pm.end,
      publicWelfare: false, zoneId: 'family', zoneName: '亲子儿童区', lanes: [undefined],
      capacity: { zoneCapacity: 40, inPool: 0, booked: 2, locked: 0, applying: 30, overflow: 0 },
      shower: { capacity: 60, occupied: 0, applying: 30, overflow: 0 },
      locker: { total: 220, occupied: 0, needed: 30, remaining: 220, shortfall: 0 },
      guards: [],
      residents: [{ ...rentalConflictLi }],
      tagCounts: { parent_child: 1, child: 1, stored_value: 1 },
      existingLocks: [],
      conflicts: [
        '申请范围已有 1 笔居民预约（共 2 人），平台不能直接覆盖，须逐人协调改约或压缩包场',
        '冲突范围内含亲子/儿童预约 B-2066，须保留并逐人征询',
        '含会员储值用户 1 笔，退改须按原储值渠道返还',
      ],
    },
    residentConflicts: [{ ...rentalConflictLi }],
    coordination: {
      lanes: [], zoneId: 'family', shorten: false,
      approvedPartySize: 26, approvedChildren: 21, extraGuards: 1,
      suspendNonWelfareLanes: false, provideVoucher: true, requireDeposit: 500,
      note: '建议压缩到亲子区东侧并限 26 人；居民 B-2066 不同意改约则保留并进一步压缩为 3 条道',
    },
    institutionConfirmed: false,
    gates: {
      roster: { done: false }, visitorId: { done: false }, insurance: { done: false },
      guardReposition: { done: false }, cleaning: { done: false }, maintenance: { done: false },
    },
    violations: [],
    clearance: {
      clear_pool: { done: false }, clear_lockers: { done: false }, water_retest: { done: false },
      equipment_reset: { done: false }, guard_patrol: { done: false },
    },
    audit: [
      { at: rel(-30), by: '赵晓', byRole: 'resident', event: '提交包场申请', detail: '蓝鲸游泳培训 申请 亲子儿童区整区 30 人（儿童 24），冲突 3 项' },
      { at: rel(-25), by: '孙运营', byRole: 'ops', event: '向居民发起逐人改约征询', detail: '目标场次 晚场·暑期儿童高峰，补偿券 是' },
    ],
    createdAt: rel(-30),
  };

  return {
    users, zones, sessions, bookings, waterReadings, equipment, guardDuties,
    patrolIssues: [...patrolIssues], incidents: [], workTasks, complaints, notifications, walletTxns,
    lessons, closureRecords: [], crampRescues, guardTraining,
    institutions: [institutionLan], rentals: [rentalSeed], institutionBills: [],
    facilities: { showerCapacity: 60, lockerCount: 220 },
    counters: { seq }, seededAt: new Date().toISOString(),
  };
}
