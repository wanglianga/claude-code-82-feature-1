// ============ 领域模型（前后端共享） ============

export type Role = 'resident' | 'frontdesk' | 'lifeguard' | 'cleaner' | 'maintenance' | 'ops';

export const ROLE_LABEL: Record<Role, string> = {
  resident: '居民',
  frontdesk: '前台',
  lifeguard: '救生员',
  cleaner: '保洁',
  maintenance: '维修',
  ops: '社区运营',
};

export type ZoneId = 'training' | 'family' | 'deep' | 'shallow';

export interface Zone {
  id: ZoneId;
  name: string;
  capacity: number;
  rules: string[];
  risk: 'low' | 'medium' | 'high';
  /** 需要深水合格证 */
  requireCert: boolean;
  /** 是否为儿童区（统计儿童人数） */
  isChildArea?: boolean;
}

export type MemberTier = 'normal' | 'silver' | 'gold' | 'guest' | 'institution';
export type SwimLevel = 'none' | 'beginner' | 'intermediate' | 'advanced';

export interface User {
  id: string;
  username: string;
  password: string;
  name: string;
  role: Role;
  phone?: string;
  memberTier?: MemberTier;
  /** 深水合格证 */
  deepCert?: boolean;
  walletBalance?: number;
  /** 补偿券：每张可抵一次入场 */
  compVouchers?: number;
  age?: number;
}

/** 预约类型：居民个人 / 亲子 / 老人晨泳公益 / 教练课 / 团体 / 机构包场 / 访客 */
export type BookingKind =
  | 'personal'
  | 'parent_child'
  | 'elder_morning'
  | 'coaching'
  | 'group'
  | 'institution_rental'
  | 'guest';

export type BookingStatus =
  | 'booked'        // 已预约
  | 'checked_in'    // 已入场
  | 'no_show'       // 爽约
  | 'cancelled'     // 已取消
  | 'refunded'      // 已退费（闭池）
  | 'compensated'   // 已补偿（退费+券）
  | 'postponed'     // 已顺延到后续场次（延期处置）
  | 'rebooked';     // 已改约（机构包场冲突协调，居民同意后迁移到新预约）

export interface Booking {
  id: string;
  code: string;              // 预约码 B-xxxx
  userId: string;            // 预约人（机构包场为联系人账号）
  kind: BookingKind;
  sessionId: string;
  zoneId: ZoneId;
  lane?: number;             // 泳道（个人预约泳道）
  periodLabel: string;       // 入场时段文案，如 09:00-10:00
  age: number;
  healthPledge: boolean;     // 健康承诺
  healthCode?: 'green' | 'expired' | 'none'; // 健康码状态（前台核验用）
  medicalCert?: boolean;     // 体检证明
  withChildren: boolean;
  childCount: number;
  childCompanion?: string;   // 儿童陪同人
  childCompanionPhone?: string;
  swimLevel: SwimLevel;
  partySize: number;         // 团体/包场总人数（含成人儿童）
  childrenInParty?: number;
  contactName?: string;
  contactPhone?: string;
  orgName?: string;          // 培训机构名称
  status: BookingStatus;
  paidAmount: number;
  paymentMethod: 'wallet' | 'cash' | 'voucher';
  lockerNo?: string;
  checkedInAt?: string;
  checkedInBy?: string;
  createdAt: string;
  /** 历次闭池档案 id（退费/补偿联动时追加，可多次） */
  closureIds?: string[];
  /** 顺延到的目标场次（延期处置） */
  postponeToSessionId?: string;
  /** 顺延时记录原场次 */
  postponedFromSessionId?: string;
  /** 原预约顺延到目标场次后，新生成预约的 id */
  postponedBookingId?: string;
  /** 目标场次新预约上的反向关联：由哪笔原预约迁移而来 */
  migratedFromBookingId?: string;
  /** 关联的闭池处置档案 id */
  migratedClosureId?: string;
  /** 机构包场协调关联：包场预约 / 居民被改约预约都挂到场次档案 */
  rentalCaseId?: string;
  /** 包场协调改约：新预约指向原预约（同场换泳道或跨场改约） */
  rentalRebookedFromId?: string;
}

export type PoolStatus = 'normal' | 'restricted' | 'partial' | 'closed';

export interface Session {
  id: string;
  label: string;            // 如 09-10 晨泳场
  date: string;             // YYYY-MM-DD
  start: string;
  end: string;
  poolStatus: PoolStatus;
  statusReason?: string;
  /** 关闭/限流时是否已完成退费与通知联动 */
  settled?: boolean;
  closedAt?: string;
  reopenedAt?: string;
  /** 闭池时是否要求水质复测合格后方可恢复 */
  requireWaterRetest?: boolean;
  /** 居民公益时段（老人晨泳等），商业包场与其冲突时预警 */
  publicWelfare?: boolean;
  maxCapacity: number;
  /** 本场锁定的泳区/泳道（机构包场、教练课等商业占用） */
  locks: ZoneLock[];
  /** 历次闭池档案（不可变快照，按时间顺序） */
  closureIds: string[];
  /** 当前生效中的闭池档案 id；恢复开放后清空（历史仍在 closureIds） */
  activeClosureId?: string;
  /** 水质异常等处置中受影响（暂停使用）的泳区；部分开放时其余泳区正常 */
  affectedZoneIds?: ZoneId[];
  /** 计划复测时间（ISO），页面向居民/救生展示 */
  retestPlannedAt?: string;
  /** 救援临停中的泳道（抽筋救援后泳道临停，收尾确认后解除） */
  suspendedLanes?: SuspendedLane[];
  /** 本场救生巡查需重点关注的泳道（由既往场次抽筋救援站位调整带入） */
  guardFocusLanes?: GuardFocusLane[];
  /** 本场发生的抽筋救援数（复盘统计） */
  crampRescueCount?: number;
  /** 本场的机构包场协调档案 id（含历史） */
  rentalCaseIds?: string[];
  createdAt: string;
}

/** 泳道临停（抽筋救援等现场处置） */
export interface SuspendedLane {
  zoneId: ZoneId;
  lane: number;
  reason: string;
  since: string;
  /** 关联救援记录 */
  rescueId: string;
}

export type LockReason = 'institution_rental' | 'coaching' | 'maintenance' | 'private_event';

export interface ZoneLock {
  id: string;
  zoneId: ZoneId;
  lane?: number;          // 不传 = 整个泳区
  reason: LockReason;
  title: string;          // 如「蓝鲸游泳培训机构·少儿提高班」
  contactName: string;
  contactPhone: string;
  capacity: number;       // 占用名额
  isCommercial: boolean;  // 商业 vs 居民公益
  bookingId?: string;
  /** 关联包场协调档案（协调通过/机构确认后写入；此前 lock 仅为申请占位） */
  rentalCaseId?: string;
  /** 包场申请的更衣淋浴容量需求（占用淋浴位） */
  showerSeats?: number;
  /** 储物柜需求数量 */
  lockerCount?: number;
  /** 是否使用独立出入口 */
  independentEntry?: boolean;
}

/** 水质检测 */
export interface WaterReading {
  id: string;
  sessionId: string;
  at: string;
  tempC: number;          // 水温
  freeChlorine: number;   // 余氯 mg/L
  turbidity: number;      // 浊度 NTU
  ph: number;
  recorder: string;       // 记录人
  /** 自动/人工判定 */
  abnormal: boolean;
  abnormalFields: string[];
  note?: string;
  eventId?: string;
}

/** 设备状态 */
export type EquipmentStatus = 'normal' | 'warning' | 'fault';
export interface Equipment {
  id: string;
  name: string;            // 循环泵 / 加氯机 / 除湿机 / AED / 监控
  zoneId: ZoneId | 'all';
  status: EquipmentStatus;
  lastCheck: string;
  note?: string;
}

/** 救生员站位与巡查 */
export type GuardPost = 'tower_deep' | 'tower_shallow' | 'family_patrol' | 'shower' | 'roaming';
export const GUARD_POST_LABEL: Record<GuardPost, string> = {
  tower_deep: '深水区瞭望台',
  tower_shallow: '浅水区瞭望台',
  family_patrol: '儿童区巡逻',
  shower: '淋浴区岗',
  roaming: '机动巡视',
};

export interface GuardDuty {
  id: string;
  sessionId: string;
  guardUserId: string;
  post: GuardPost;
  start: string;
  end?: string;
  relief?: string;         // 换岗接班人
  note?: string;
  /** 因抽筋救援换岗：关联救援记录 id（复盘时统计救援处置） */
  crampRescueId?: string;
}

// ============ 抽筋救援记录 ============

/** 救援方式 */
export type RescueMethod = 'shore_reach' | 'wading' | 'swim' | 'spinal_board' | 'aed_first_aid';
export const RESCUE_METHOD_LABEL: Record<RescueMethod, string> = {
  shore_reach: '岸上伸援（伸手/抛绳）',
  wading: '下水搀扶上岸',
  swim: '游泳拖带上岸',
  spinal_board: '脊柱板固定转运',
  aed_first_aid: 'AED/心肺复苏急救',
};

/** 抽筋部位 */
export type CrampPart = 'calf' | 'thigh' | 'foot' | 'abdomen' | 'other';
export const CRAMP_PART_LABEL: Record<CrampPart, string> = {
  calf: '小腿', thigh: '大腿', foot: '足底/脚趾', abdomen: '腹部', other: '其他部位',
};

/** 收尾确认项（救援结束后必须逐项确认） */
export type RescueClosureKey = 'guard_relief' | 'lane_reopen' | 'order_restored';
export const RESCUE_CLOSURE_LABEL: Record<RescueClosureKey, string> = {
  guard_relief: '救生员换岗确认',
  lane_reopen: '泳道临停解除确认',
  order_restored: '水面秩序恢复确认',
};

export interface RescueClosureState {
  done: boolean;
  at?: string;
  by?: string;
  note?: string;
}

/** 站位调整（救援后记录：从哪个岗调整、加强哪个岗/哪条泳道），每次调整为一个版本 */
export interface CrampPostAdjustment {
  /** 版本号，从 1 开始（同一救援的第 N 次调整 = 第 N 版站位策略） */
  version: number;
  at: string;
  by: string;
  /** 调整说明，如「深水区瞭望台加派机动巡视，重点盯 3 号道」 */
  content: string;
}

/** 关注泳道的历史版本快照（含该版本当时的确认情况，审计留痕） */
export interface GuardFocusLaneVersion {
  version: number;
  reason: string;
  at: string;
  by?: string;
  /** 该版本被巡查确认的时间/人（被新策略替换前若已确认则保留） */
  ackAt?: string;
  ackBy?: string;
}

/** 下一场救生巡查重点关注泳道（站位调整后自动带入后续场次；多次调整按版本更新） */
export interface GuardFocusLane {
  zoneId: ZoneId;
  lane: number;
  /** 当前（最新）版本策略文案 */
  reason: string;
  /** 当前策略版本号，从 1 开始 */
  version: number;
  /** 来源救援记录 */
  rescueId: string;
  /** 来源场次 */
  fromSessionId: string;
  /** 首版生成时间 */
  at: string;
  /** 首版策略制定人 */
  by?: string;
  /** 最新版本时间 */
  updatedAt?: string;
  /** 最新版本制定人 */
  updatedBy?: string;
  /** 当前版本的巡查确认时间（出现新调整后清空，须重新确认） */
  ackAt?: string;
  ackBy?: string;
  /** 历次版本及各版本确认留档（不含当前版本），按版本顺序 */
  history: GuardFocusLaneVersion[];
}

/** 复盘结果：进入救生员培训 */
export interface GuardTrainingItem {
  id: string;
  source: 'cramp_rescue' | 'incident' | 'routine';
  sourceRescueId?: string;
  sourceIncidentId?: string;
  sessionId: string;
  sessionLabel: string;
  at: string;
  title: string;
  /** 培训要点（复盘结论） */
  content: string;
  /** 需参加培训的救生员（姓名）；空 = 全体救生员 */
  targetGuardNames: string[];
  /** 是否排入近期救生排班（加强岗/带教） */
  intoSchedule: boolean;
  scheduleNote?: string;
  recordedBy: string;
  done: boolean;
  doneAt?: string;
}

export interface CrampRescue {
  id: string;
  code: string;              // CR-xxxx
  sessionId: string;
  zoneId: ZoneId;
  /** 抽筋泳道（泳客在泳道抽筋） */
  lane: number;
  /** 发现时间 */
  foundAt: string;
  /** 发现/记录救生员 */
  guardName: string;
  crampPart: CrampPart;
  /** 泳客描述（不强制关联预约，避免暴露不必要 PII；可写柜号/外貌/会员） */
  patronDesc: string;
  method: RescueMethod;
  /** 上岸处理（拉伸、保暖、观察、AED 等） */
  shoreTreatment: string;
  /** 是否联系家属 */
  familyContacted: boolean;
  familyNote?: string;
  /** 是否建议就医 */
  medicalAdvised: boolean;
  medicalNote?: string;
  /** 关联协同事件 id（自动立案泳客抽筋） */
  incidentId?: string;
  /** 收尾三项确认 */
  closure: Record<RescueClosureKey, RescueClosureState>;
  /** 站位调整记录（可多次） */
  adjustments: CrampPostAdjustment[];
  /** 该泳道是否仍处临停（收尾确认泳道恢复后置为 false） */
  laneSuspended: boolean;
  laneSuspendReason?: string;
  /** 复盘时间与结论（运营组织本场复盘） */
  reviewedAt?: string;
  reviewedBy?: string;
  reviewSummary?: string;
  /** 复盘生成的培训项 id */
  trainingIds: string[];
  /** 复盘是否进入排班（关注泳道提醒在新场次自动生效，排班调整在培训项中记录） */
  intoSchedule: boolean;
  createdAt: string;
}

/** 运营巡查记录 */
export type PatrolIssueType =
  | 'diving'          // 泳客违规跳水
  | 'child_alone'     // 儿童离开陪同人
  | 'wet_floor'       // 地面湿滑
  | 'shower_crowd'    // 淋浴区拥堵
  | 'water_quality'   // 水质检测异常
  | 'guard_missing'   // 救生员脱岗
  | 'other';

export type IssueSeverity = 'minor' | 'major' | 'critical';
export type IssueStatus = 'open' | 'handling' | 'resolved';

export interface PatrolIssue {
  id: string;
  sessionId: string;
  at: string;
  type: PatrolIssueType;
  severity: IssueSeverity;
  description: string;
  location: string;
  reporter: string;
  /** 分派给的岗位/角色 */
  assigneeRole?: Role;
  assigneeName?: string;
  status: IssueStatus;
  resolution?: string;
  resolvedAt?: string;
  eventId?: string;
}

/** 跨角色协同事件 */
export type IncidentType =
  | 'water_abnormal'   // 水质异常
  | 'thunderstorm'     // 雷雨临近
  | 'cramp'            // 泳客抽筋
  | 'child_lost'       // 儿童走失
  | 'locker_dispute'   // 储物柜纠纷
  | 'overbooking'      // 预约超额
  | 'equipment_fault'  // 设备故障
  | 'medical';         // 其他医疗急救

export type IncidentSeverity = 'major' | 'critical';
export type IncidentStatus = 'open' | 'responding' | 'resolved';

export interface IncidentAction {
  id: string;
  at: string;
  by: string;
  byRole: Role;
  content: string;
}

export interface Incident {
  id: string;
  code: string;
  sessionId: string;
  type: IncidentType;
  severity: IncidentSeverity;
  title: string;
  description: string;
  reportedAt: string;
  reporter: string;
  status: IncidentStatus;
  /** 协同角色与处置要求 */
  tasks: IncidentTask[];
  actions: IncidentAction[];
  resolvedAt?: string;
}

export interface IncidentTask {
  id: string;
  role: Role;
  content: string;
  done: boolean;
  doneBy?: string;
  doneAt?: string;
}

export type TaskKind = 'cleaning' | 'maintenance' | 'disinfection';
export type WorkTaskStatus = 'pending' | 'in_progress' | 'done';

export interface WorkTask {
  id: string;
  sessionId?: string;
  kind: TaskKind;
  title: string;
  detail: string;
  zoneId?: ZoneId | 'all';
  assigneeRole: 'cleaner' | 'maintenance';
  assigneeName?: string;
  status: WorkTaskStatus;
  createdAt: string;
  doneAt?: string;
  result?: string;
  source?: 'routine' | 'incident' | 'patrol' | 'closure' | 'rental';
  incidentId?: string;
  /** 闭池联动生成时，引用不可变闭池档案 id */
  closureId?: string;
  /** 包场保障工单关联包场档案 */
  rentalCaseId?: string;
}

export interface Complaint {
  id: string;
  userId: string;
  at: string;
  category: '水质' | '拥挤' | '救生服务' | '储物柜' | '教练课' | '卫生' | '其他';
  content: string;
  status: 'open' | 'replied';
  reply?: string;
  repliedAt?: string;
}

export interface Notification {
  id: string;
  at: string;
  title: string;
  body: string;
  level: 'info' | 'warning' | 'critical';
  /** 目标角色；空数组 = 全体居民可见 */
  roles: Role[];
  userId?: string;       // 个人通知（退费/补偿）
  sessionId?: string;
  /** 引用触发该通知的闭池档案（不可变） */
  closureId?: string;
  /** 引用机构包场协调档案 */
  rentalCaseId?: string;
}

// ============ 闭池处置档案（不可变快照，同场次可多次闭池） ============

/** 储值渠道退款结果 */
export interface WalletRefundResult {
  channel: 'wallet';
  refunded: boolean;
  amount: number;
  walletTxnId?: string;
}
/** 补偿券渠道：仅返还原券，不产生任何金额流水 */
export interface VoucherRefundResult {
  channel: 'voucher';
  /** 原预约消耗的补偿券是否已返还 */
  originalVoucherReturned: boolean;
  returnedCount: number;
}
/** 现场支付渠道：不进储值，只登记现场退款处理结果 */
export interface OnSiteRefundResult {
  channel: 'cash';
  registered: boolean;
  amount: number;
  /** 现场退款处理说明（凭预约码到前台办理等） */
  note: string;
}
export type RefundResult = WalletRefundResult | VoucherRefundResult | OnSiteRefundResult;

/** 受影响人群分组：已入场 / 未入场 / 教练课（补偿方式按实际影响区分） */
export type AffectedGroup = 'checked_in' | 'not_checked_in' | 'coaching';

export interface ClosureAffectedItem {
  bookingId: string;
  bookingCode: string;
  userId: string;
  userName?: string;
  paidAmount: number;
  /** 原支付渠道，退款严格按该渠道分别处理 */
  paymentMethod: Booking['paymentMethod'];
  /** 是否执行了原渠道退款/返还 */
  refunded: boolean;
  /** 原渠道退款结果（储值 / 原券返还 / 现场登记，互斥） */
  refund: RefundResult | null;
  /** 是否发放了「额外」补偿券（与补偿券预约的原券返还分开统计） */
  extraCompVoucher: boolean;
  /** 兼容旧字段：等价于 extraCompVoucher */
  voucherGranted?: boolean;
  /** 受影响人群分组 */
  group: AffectedGroup;
  /** 该笔预约是否处于受影响泳区（部分开放时决定是否纳入处置） */
  inAffectedZone: boolean;
  /** 是否顺延（延期处置时未入场/教练课） */
  postponed?: boolean;
  /** 顺延后的场次 id */
  postponeToSessionId?: string;
  /** 目标场次新生成的有效预约 id */
  migratedBookingId?: string;
  /** 该居民收到的逐人通知 id */
  notificationId?: string;
}

/** 处置方式：闭池 / 部分开放 / 延期 */
export type ClosureDisposition = 'closed' | 'partial' | 'postponed';

export type ClosureStatus = 'closed' | 'reopened';

export interface ClosureRecord {
  id: string;
  /** 同一场次第几次闭池，从 1 开始 */
  seq: number;
  sessionId: string;
  sessionLabel: string;
  cause: IncidentType | 'other';
  /** 闭池原因原文（雷雨/水质…），固化后不再被后续状态覆盖 */
  reason: string;
  closedAt: string;
  closedBy: string;
  status: ClosureStatus;
  /** 处置方式：闭池 / 部分开放 / 延期 */
  disposition: ClosureDisposition;
  /** 受影响（暂停使用）泳区 */
  affectedZoneIds: ZoneId[];
  /** 计划复测时间（ISO） */
  retestPlannedAt?: string;
  /** 延期目标场次 id（disposition=postponed 时） */
  postponeToSessionId?: string;
  requireWaterRetest: boolean;
  options: { refund: boolean; compVoucher: boolean; notifyResidents: boolean };
  /** 受影响预约与逐人退费/补偿结果快照 */
  affected: ClosureAffectedItem[];
  /** 退回储值余额的金额合计与笔数（仅 wallet 渠道，voucher/cash 不计入） */
  walletRefundTotal: number;
  walletRefundCount: number;
  /** 现场支付退款登记金额与笔数（不进储值） */
  cashRefundTotal: number;
  cashRefundCount: number;
  /** 补偿券预约的原券返还张数 */
  originalVoucherReturnCount: number;
  /** 额外补偿券张数（与原券返还分开） */
  extraVoucherCount: number;
  /** 兼容旧汇总：受影响且执行退款/返还的总笔数 */
  refundCount: number;
  /** 全员公告 + 岗位通知 id */
  announcementIds: string[];
  /** 撤哨救生员人数 */
  guardReliefCount: number;
  /** 联动生成的消毒复测 / 清场工单 id */
  taskIds: string[];
  /** 关联协同事件 id */
  incidentIds: string[];
  reopenedAt?: string;
  reopenedBy?: string;
  /** 恢复开放所依据的达标复测读数 id */
  retestReadingId?: string;
  reopenNote?: string;
  /** 恢复时实际送达的通知 id（回写同一轮档案） */
  reopenNotificationIds?: string[];
  /** 恢复门禁核验快照：恢复瞬间固化各项处置完成结果，之后不再变化 */
  reopenChecklist?: {
    cleaning: ClosureTaskResult | null;
    disinfection: ClosureTaskResult | null;
    /** 必要时（requireWaterRetest）的达标水质记录快照；不需要时为 null */
    water: ClosureWaterResult | null;
  };
  /** 教练课顺延结果（闭池发生在培训课时段时同步处理） */
  lessonPostponements?: ClosureLessonPostpone[];
  /** 各人群分组计数（已入场/未入场/教练课） */
  groupCounts?: Record<AffectedGroup, number>;
  /** 真实迁移到目标场次的预约笔数（目标场已生成可核验新预约） */
  migratedBookingCount?: number;
  /** 各目标场次迁入笔数 */
  migrationSummary?: { sessionId: string; sessionLabel: string; count: number }[];
}

export interface ClosureLessonPostpone {
  lessonId: string;
  lessonTitle: string;
  coachName: string;
  fromSessionId: string;
  toSessionId: string;
  /** 受影响学员人数 */
  studentCount: number;
  /** 是否通知机构账号 */
  institutionNotified: boolean;
  notificationId?: string;
}

/** 闭池联动工单的完成结果快照 */
export interface ClosureTaskResult {
  taskId: string;
  title: string;
  kind: TaskKind;
  assigneeRole: 'cleaner' | 'maintenance';
  assigneeName?: string;
  doneAt: string;
  result?: string;
}

/** 恢复开放所依据的达标水质复测快照 */
export interface ClosureWaterResult {
  readingId: string;
  at: string;
  recorder: string;
  tempC: number;
  freeChlorine: number;
  turbidity: number;
  ph: number;
}

/** 钱包流水 */
export interface WalletTxn {
  id: string;
  at: string;
  userId: string;
  amount: number;         // 正=充值/退费，负=消费
  reason: string;
  sessionId?: string;
  /** 引用产生该退费的闭池档案（第几轮闭池不可变） */
  closureId?: string;
  /** 引用包场改约退费 */
  rentalCaseId?: string;
}

/** 教练课 */
export interface CoachingLesson {
  id: string;
  coachName: string;
  title: string;             // 少儿启蒙/自由泳提高
  sessionId: string;
  zoneId: ZoneId;
  lane: number;
  capacity: number;
  enrolled: number;
  price: number;
  studentIds: string[];
  /** 顺延状态：原场次水质异常闭池时，课程顺延到后续场次 */
  postponed?: {
    fromSessionId: string;
    toSessionId: string;
    at: string;
    closureId: string;
  };
  /** 顺延通知机构账号 id（如适用） */
  institutionNotifiedUserIds?: string[];
}

// ============ 培训机构包场与居民公益时段冲突协调 ============

/** 包场档案状态（全流程不可删除，只能推进/驳回/终止） */
export type RentalCaseStatus =
  | 'pending'          // 已申请，待运营资质核验与冲突协调
  | 'verifying'        // 资质/保险/教练救生核验中
  | 'coordinating'     // 与居民改约协商中（平台不得覆盖居民预约）
  | 'approved'         // 协调完成、机构已确认，等待当天
  | 'active'           // 当天核验通过，包场进行中
  | 'suspended'        // 现场违规被暂停，等待整改/终止
  | 'completed'        // 清场复测确认完成，居民预约恢复
  | 'rejected'         // 资质/保险/儿童陪同核验不通过，驳回（不产生锁区）
  | 'cancelled';       // 机构/运营取消

/** 机构资质与配置核验项（运营逐项核验，不通过即驳回/要求整改） */
export interface RentalQualification {
  /** 培训机构办学/经营资质 */
  institutionCert: boolean;
  institutionCertNote?: string;
  /** 带队教练名单与资质 */
  coachNames: string;
  coachCert: boolean;
  coachCertNote?: string;
  /** 配置救生员人数（不得低于按人数/泳区测算的最低配比） */
  lifeguardCount: number;
  lifeguardNames: string;
  lifeguardCert: boolean;
  lifeguardCertNote?: string;
  /** 公众责任险单号与保额 */
  insurancePolicyNo: string;
  insuranceCoverage: number;
  insuranceVerified: boolean;
  insuranceExpiry?: string;
  /** 申报总人数 / 成人 / 儿童 */
  partySize: number;
  adultCount: number;
  childCount: number;
  ageStructure: string;           // 年龄结构说明
  containsChildren: boolean;
  /** 儿童陪同规则核验：每名 ≤13 岁儿童须有登记陪同人，包场不放宽 */
  companions: RentalChildCompanion[];
  companionRulePassed: boolean;
  /** 独立出入口与独立更衣淋浴需求 */
  independentEntry: boolean;
  separateChanging: boolean;
  showerSeats: number;            // 淋浴位占用需求
  lockerCount: number;            // 储物柜需求
  /** 运营核验结论时间/人 */
  verifiedAt?: string;
  verifiedBy?: string;
  /** 要求整改说明（未达标项） */
  rectifyNote?: string;
}

/** 包场内儿童与陪同人（按儿童离陪规则逐人登记） */
export interface RentalChildCompanion {
  childName: string;
  childAge: number;
  companion: string;
  companionPhone: string;
  relation: string;
}

/** 费用拆分（按泳道、时段、救生员加班、储物柜、淋浴区占用），进入机构账单 */
export interface RentalFeeBreakdown {
  /** 泳道占用费（每条泳道 × 时长） */
  laneFee: number;
  /** 时段费（公益/高峰溢价） */
  periodFee: number;
  /** 救生员加班费（增派救生员 × 工时） */
  lifeguardOvertimeFee: number;
  /** 储物柜占用费 */
  lockerFee: number;
  /** 淋浴区占用费 */
  showerFee: number;
  /** 押金（频繁违规机构上浮，结算时退回或抵扣） */
  deposit: number;
  /** 合计 */
  total: number;
}

/** 单个居民预约与包场的冲突及协商结果（平台不得直接覆盖居民预约） */
export type ResidentConflictKind =
  | 'elder_morning'   // 老人晨泳公益
  | 'parent_child'    // 亲子时段
  | 'public_welfare'  // 居民公益时段（其他）
  | 'coaching'        // 教练课
  | 'stored_member'   // 会员储值用户
  | 'normal';

export type RebookOfferStatus =
  | 'identified'  // 已识别为受影响居民，运营尚未发起改约提议
  | 'proposed'    // 已向居民发起改约提议，待答复
  | 'accepted'    // 居民同意：已改约（同场换道或跨场迁移），按方案补偿
  | 'rejected'    // 居民不同意：保留原预约，压缩包场范围
  | 'expired';    // 超时未答复（按保留原预约处理）

export interface ResidentConflict {
  bookingId: string;
  bookingCode: string;
  userId: string;
  /** 居民类别标注（多标签：老人晨泳/亲子/公益/教练课/会员储值） */
  tags: ResidentConflictKind[];
  zoneId: ZoneId;
  lane?: number;
  partySize: number;
  childCount: number;
  /** 建议改约目标场次 */
  offerSessionId?: string;
  /** 建议改约泳区/泳道（同场分流到非公益、非锁定泳道） */
  offerZoneId?: ZoneId;
  offerLane?: number;
  /** 改约补偿券数量（居民同意改约时到账居民端） */
  compVouchers: number;
  /** 是否额外原路退费（公益免费单为 0；储值单可部分退费） */
  refundAmount: number;
  status: RebookOfferStatus;
  proposedAt?: string;
  /** 居民答复时间 */
  answeredAt?: string;
  /** 改约后新预约 id（accepted 时真实生成，可核验） */
  newBookingId?: string;
  /** 送达居民的个人通知 id（不能只在内部记一笔） */
  notificationId?: string;
  /** 补偿券/退费落账的钱包流水 id（退费部分） */
  walletTxnId?: string;
  note?: string;
}

/** 运营协调措施（可组合：拆泳道/缩短包场/限制人数/增派救生员/暂停部分非公益泳道/补偿券） */
export interface RentalCoordination {
  /** 最终批准占用的泳道（拆分泳道后的实际范围；空=整区） */
  approvedLanes?: number[];
  /** 缩短后的实际开始/结束时间（HH:mm） */
  approvedStart?: string;
  approvedEnd?: string;
  /** 限制后的实际人数上限 */
  approvedCapacity?: number;
  /** 增派救生员人数 */
  extraLifeguards: number;
  /** 暂停的非公益泳道（为包场腾挪；公益泳道不得暂停） */
  suspendedNonWelfareLanes?: { zoneId: ZoneId; lane: number }[];
  /** 给居民的改约补偿券数量（默认口径） */
  residentCompVouchers: number;
  /** 公益时段被压缩时的退费/补偿口径 */
  welfareRefund: boolean;
  note?: string;
  decidedAt?: string;
  decidedBy?: string;
}

/** 包场当天现场核验清单（前台/救生/保洁/维修分岗确认） */
export interface RentalDayChecklist {
  /** 前台：机构名单与申报一致 */
  rosterMatched: boolean; rosterMatchedAt?: string; rosterMatchedBy?: string; rosterNote?: string;
  /** 前台：访客身份逐人核验 */
  visitorIdChecked: boolean; visitorIdCheckedAt?: string; visitorIdCheckedBy?: string; visitorIdNote?: string;
  /** 前台：保险现场复核 */
  insuranceChecked: boolean; insuranceCheckedAt?: string; insuranceCheckedBy?: string; insuranceNote?: string;
  /** 救生员：按包场人数重新站位完成 */
  guardRepositioned: boolean; guardRepositionedAt?: string; guardRepositionedBy?: string;
  guardRepositionNote?: string; guardDutyIds?: string[];
  /** 保洁：地面/淋浴/储物柜/消毒安排确认 */
  cleaningReady: boolean; cleaningReadyAt?: string; cleaningReadyBy?: string; cleaningNote?: string;
  /** 维修：设施与消毒安排确认 */
  maintenanceReady: boolean; maintenanceReadyAt?: string; maintenanceReadyBy?: string; maintenanceNote?: string;
}

/** 包场结束清场恢复门禁（未复测或未清场不得开放下一场） */
export interface RentalCloseoutChecklist {
  /** 清场（机构人员全部离场） */
  cleared: boolean; clearedAt?: string; clearedBy?: string;
  /** 储物柜清空检查 */
  lockersCleared: boolean; lockersClearedAt?: string; lockersClearedBy?: string;
  /** 水质复测合格 */
  waterRetested: boolean; waterRetestedAt?: string; waterRetestedBy?: string; waterReadingId?: string;
  /** 设备复位 */
  equipmentReset: boolean; equipmentResetAt?: string; equipmentResetBy?: string;
  /** 救生巡查确认（恢复居民预约前最后一道） */
  guardPatrolConfirmed: boolean; guardPatrolConfirmedAt?: string; guardPatrolConfirmedBy?: string;
  /** 恢复开放通知（居民端同步，非仅内部记账） */
  residentResumeNotified: boolean; resumeNotificationId?: string;
  reopenedAt?: string; reopenedBy?: string;
}

/** 现场违规记录（超人数/超时/占用公益泳道/儿童无人陪同/私自加人） */
export type RentalViolationType =
  | 'over_capacity'      // 超人数
  | 'overtime'           // 超时
  | 'occupy_welfare'     // 占用公益泳道
  | 'child_unaccompanied'// 儿童无人陪同
  | 'unauthorized_addon' // 机构私自加人
  | 'other';

export interface RentalViolation {
  id: string;
  type: RentalViolationType;
  at: string;
  by: string;            // 记录人（前台/救生/运营）
  byRole: Role;
  description: string;
  /** 实际人数（超人数时） */
  actualCount?: number;
  /** 现场处置：是否当场暂停包场 */
  suspended: boolean;
  notifiedOps: boolean;
  /** 整改情况（信用记录一部分） */
  rectified: boolean;
  rectifiedAt?: string;
  rectifyNote?: string;
}

/** 包场场次协调档案（所有冲突协调、改约、补偿、确认、恢复结果均进入该记录） */
export interface RentalCase {
  id: string;
  code: string;                    // RC-xxxx
  sessionId: string;
  /** 申请机构账号 id（机构账单/信用主体） */
  orgUserId: string;
  orgName: string;
  contactName: string;
  contactPhone: string;
  bookingId: string;               // 机构包场预约 id（institution_rental）
  lockId: string;                  // 申请时登记的锁区 id
  status: RentalCaseStatus;
  /** 申请占用泳区/泳道/人数 */
  zoneId: ZoneId;
  lanes?: number[];
  partySize: number;
  adultCount: number;
  childCount: number;
  containsChildren: boolean;
  purpose: string;                 // 用途说明（少儿提高班/商业团建…）
  appliedAt: string;
  appliedBy: string;
  qualification: RentalQualification;
  coordination?: RentalCoordination;
  /** 受影响居民预约的逐笔冲突与协商结果 */
  residentConflicts: ResidentConflict[];
  /** 费用拆分（进入机构账单） */
  fee: RentalFeeBreakdown;
  /** 账单条目 id（机构确认后落账） */
  billId?: string;
  dayChecklist?: RentalDayChecklist;
  closeout?: RentalCloseoutChecklist;
  violations: RentalViolation[];
  /** 机构对协调方案的确认 */
  orgConfirmedAt?: string;
  orgConfirmNote?: string;
  /** 当天实际到场人数（前台名单核验后登记；用于判断超人数与救生重新站位） */
  actualCount?: number;
  /** 各阶段时间线（机器可读，供排期与投诉追溯） */
  timeline: { at: string; by: string; byRole: Role; action: string }[];
  /** 暂停原因/时间 */
  suspendedAt?: string;
  suspendedReason?: string;
  /** 恢复包场（整改后） */
  resumedAt?: string;
  completedAt?: string;
  /** 驳回/取消原因 */
  rejectReason?: string;
}

/** 机构账单条目（包场费用五项拆分；支持结算/押金抵扣） */
export type OrgBillStatus = 'unsettled' | 'settled' | 'deducted';
export interface OrgBillItem {
  id: string;
  orgUserId: string;
  orgName: string;
  rentalCaseId: string;
  rentalCode: string;
  sessionId: string;
  sessionLabel: string;
  breakdown: RentalFeeBreakdown;
  /** 已支付（机构对公/储值） */
  paidAmount: number;
  /** 押金已收 */
  depositHeld: number;
  status: OrgBillStatus;
  createdAt: string;
  settledAt?: string;
  note?: string;
}

/** 机构信用记录（超时、超人数、投诉、整改；频繁违规限制后续包场/加救生员/加押金） */
export interface OrgCreditRecord {
  id: string;
  orgUserId: string;
  orgName: string;
  rentalCaseId?: string;
  rentalCode?: string;
  at: string;
  type: RentalViolationType | 'complaint' | 'rectify_ok' | 'rental_done';
  description: string;
  /** 扣分（违规为负） */
  scoreDelta: number;
  recordedBy: string;
  /** 人工限制后续包场（运营对该机构的限制决定，覆盖自动画像） */
  restrictionOverride?: {
    rentalRestricted: boolean;
    requiredExtraLifeguards: number;
    depositMultiplier: number;
    note?: string;
    by: string;
    at: string;
  };
}

export interface OrgCreditProfile {
  orgUserId: string;
  orgName: string;
  /** 累计违规次数（按类型统计） */
  violationCount: number;
  overtimeCount: number;
  overCapacityCount: number;
  complaintCount: number;
  /** 当前信用分（初始 100，违规扣分，整改良好不恢复上限） */
  score: number;
  /** 是否被限制后续包场 */
  rentalRestricted: boolean;
  /** 后续包场强制增派救生员人数 */
  requiredExtraLifeguards: number;
  /** 后续包场押金上浮倍数 */
  depositMultiplier: number;
  restrictionNote?: string;
}

/** 实时看板（救生员端 + 运营） */
export interface ZoneLiveStat {
  zoneId: ZoneId;
  name: string;
  capacity: number;
  inPool: number;
  booked: number;
  children: number;
  locked: number;           // 被商业/包场占用名额
  deepCertRequired: boolean;
  deepCertHoldersInPool: number;
  occupancyPct: number;
}

export interface LiveBoard {
  session: Session;
  zones: ZoneLiveStat[];
  totalInPool: number;
  totalCapacity: number;
  water: WaterReading | null;
  openIncidents: Incident[];
  guardOnDuty: { post: GuardPost; postLabel: string; guardName: string; startedAt: string }[];
  poolStatus: PoolStatus;
  thunderAlert: boolean;
  equipment: Equipment[];
  /** 本场救生巡查重点关注泳道（上一场抽筋救援站位调整带入） */
  focusLanes: GuardFocusLane[];
  /** 本场临停中的泳道 */
  suspendedLanes: SuspendedLane[];
  /** 本场生效中的机构包场档案（救生按人数站位、前台核验、保洁维修保障用） */
  activeRentals: { rentalCaseId: string; code: string; orgName: string; zoneId: ZoneId; lanes?: number[]; approvedCapacity: number; actualCount: number; status: RentalCaseStatus; extraLifeguards: number }[];
  /** 上一场包场未清场/复测，本场不得开放（未复测或未清场不得开放下一场） */
  priorRentalNotCleared?: { code: string; sessionLabel: string; orgName: string };
}

export interface DB {
  users: User[];
  zones: Zone[];
  sessions: Session[];
  bookings: Booking[];
  waterReadings: WaterReading[];
  equipment: Equipment[];
  guardDuties: GuardDuty[];
  patrolIssues: PatrolIssue[];
  incidents: Incident[];
  workTasks: WorkTask[];
  complaints: Complaint[];
  notifications: Notification[];
  walletTxns: WalletTxn[];
  lessons: CoachingLesson[];
  /** 全部场次的闭池处置档案（不可变快照） */
  closureRecords: ClosureRecord[];
  /** 抽筋救援记录 */
  crampRescues: CrampRescue[];
  /** 救生员培训项（复盘结果进入培训与排班） */
  guardTraining: GuardTrainingItem[];
  /** 机构包场冲突协调档案 */
  rentalCases: RentalCase[];
  /** 机构账单（费用按泳道/时段/救生加班/储物柜/淋浴拆分） */
  orgBills: OrgBillItem[];
  /** 机构信用记录 */
  orgCreditRecords: OrgCreditRecord[];
  counters: Record<string, number>;
  seededAt: string;
}

// ============ API 请求/响应 ============

export interface LoginReq { username: string; password: string; }
export interface LoginResp { user: User; token: string; }

export interface CreateBookingReq {
  kind: BookingKind;
  sessionId: string;
  zoneId: ZoneId;
  lane?: number;
  age: number;
  healthPledge: boolean;
  healthCode?: 'green' | 'expired' | 'none';
  medicalCert?: boolean;
  withChildren: boolean;
  childCount: number;
  childCompanion?: string;
  childCompanionPhone?: string;
  swimLevel: SwimLevel;
  partySize?: number;
  childrenInParty?: number;
  contactName?: string;
  contactPhone?: string;
  orgName?: string;
  paymentMethod?: 'wallet' | 'cash' | 'voucher';
}

export interface CheckInReq {
  bookingId: string;
  healthCode: 'green' | 'expired' | 'none';
  medicalCert: boolean;
  childCompanion: string;
  childCompanionPhone: string;
  lockerNo: string;
}

export interface WaterReadingReq {
  sessionId: string;
  tempC: number;
  freeChlorine: number;
  turbidity: number;
  ph: number;
  note?: string;
}

export interface PatrolReq {
  sessionId: string;
  type: PatrolIssueType;
  severity: IssueSeverity;
  description: string;
  location: string;
  assigneeRole?: Role;
}

export interface IncidentCreateReq {
  sessionId: string;
  type: IncidentType;
  severity?: IncidentSeverity;
  title: string;
  description: string;
}

export interface IncidentActionReq { content: string; }
export interface IncidentTaskDoneReq { taskId: string; }

export interface PoolStatusReq {
  sessionId: string;
  status: PoolStatus;
  reason?: string;
  cause?: IncidentType | 'other';
  /** 处置方式（水质异常闭池）：闭池 / 部分开放 / 延期 */
  disposition?: ClosureDisposition;
  /** 受影响泳区（部分开放时为暂停使用的泳区；闭池可留空=全部） */
  affectedZoneIds?: ZoneId[];
  /** 计划复测时间 ISO */
  retestPlannedAt?: string;
  /** 延期目标场次 id（disposition=postponed 时必填） */
  postponeToSessionId?: string;
  /** 闭池时联动：退费、发补偿券、复测、清场巡查、居民通知 */
  refund?: boolean;
  compVoucher?: boolean;
  notifyResidents?: boolean;
  requireWaterRetest?: boolean;
  /** 已入场人群补偿券（区别于未入场全额退） */
  checkedInVoucher?: boolean;
}

export interface WorkTaskReq {
  sessionId?: string;
  kind: TaskKind;
  title: string;
  detail: string;
  zoneId?: ZoneId | 'all';
  assigneeRole: 'cleaner' | 'maintenance';
}

export interface ComplaintReq {
  category: Complaint['category'];
  content: string;
}

export interface RechargeReq { amount: number; }

export interface LessonEnrollReq { lessonId: string; }

export interface GuardDutyReq {
  sessionId: string;
  post: GuardPost;
}

export interface GuardReliefReq {
  dutyId: string;
  relief: string;
  note?: string;
}

// ============ 抽筋救援 ============
export interface CrampRescueReq {
  sessionId: string;
  zoneId: ZoneId;
  lane: number;
  /** 发现时间（ISO，可由前端传入；缺省服务端取当前时间） */
  foundAt?: string;
  crampPart: CrampPart;
  patronDesc: string;
  method: RescueMethod;
  shoreTreatment: string;
  familyContacted: boolean;
  familyNote?: string;
  medicalAdvised: boolean;
  medicalNote?: string;
}

export interface RescueClosureReq {
  note?: string;
  /** 换岗确认时：接班人姓名（救生员名册内），服务端联动完成换岗 */
  relief?: string;
}

export interface RescueAdjustReq {
  content: string;
  /** 是否把该泳道写入后续场次重点关注（默认 true） */
  propagateToNextSessions?: boolean;
}

export interface RescueReviewReq {
  summary: string;
  /** 培训要点 */
  trainingContent: string;
  /** 参加培训救生员（姓名）；空 = 全体救生员 */
  targetGuardNames?: string[];
  /** 是否进入近期排班（加强岗/带教） */
  intoSchedule: boolean;
  scheduleNote?: string;
}

export interface TrainingDoneReq {
  result?: string;
}

export interface LockReq {
  sessionId: string;
  zoneId: ZoneId;
  lane?: number;
  reason: LockReason;
  title: string;
  contactName: string;
  contactPhone: string;
  capacity: number;
  isCommercial: boolean;
}

// ============ 机构包场冲突协调请求 ============

export interface RentalApplyReq {
  sessionId: string;
  zoneId: ZoneId;
  lanes?: number[];
  partySize: number;
  adultCount: number;
  childCount: number;
  purpose?: string;
  independentEntry?: boolean;
  separateChanging?: boolean;
  showerSeats?: number;
  lockerCount?: number;
  /** 复用机构账号已填联系人，也可覆盖 */
  contactName?: string;
  contactPhone?: string;
  orgName?: string;
}

export interface RentalQualifyReq {
  institutionCert: boolean;
  institutionCertNote?: string;
  coachNames: string;
  coachCert: boolean;
  coachCertNote?: string;
  lifeguardCount: number;
  lifeguardNames: string;
  lifeguardCert: boolean;
  lifeguardCertNote?: string;
  insurancePolicyNo: string;
  insuranceCoverage: number;
  insuranceVerified: boolean;
  insuranceExpiry?: string;
  ageStructure: string;
  companions?: RentalChildCompanion[];
  independentEntry: boolean;
  separateChanging: boolean;
  showerSeats: number;
  lockerCount: number;
  rectifyNote?: string;
}

/** 运营协调决策：改约提议、拆泳道/缩短/限人/增派救生/暂停非公益道、补偿口径 */
export interface RentalCoordinateReq {
  /** 对每笔冲突居民预约发起/更新改约提议 */
  offers?: {
    bookingId: string;
    offerSessionId?: string;
    offerZoneId?: ZoneId;
    offerLane?: number;
    compVouchers?: number;
    refundAmount?: number;
  }[];
  approvedLanes?: number[];
  approvedStart?: string;
  approvedEnd?: string;
  approvedCapacity?: number;
  extraLifeguards?: number;
  suspendedNonWelfareLanes?: { zoneId: ZoneId; lane: number }[];
  residentCompVouchers?: number;
  welfareRefund?: boolean;
  note?: string;
}

export interface RentalRebookAnswerReq {
  /** 居民对本人改约提议的答复：true=同意（迁移+补偿），false=拒绝（保留原预约，压缩包场） */
  accept: boolean;
  note?: string;
}

export interface RentalOrgConfirmReq { note?: string }

/** 包场当天分岗核验 */
export interface RentalDayCheckReq {
  key: keyof RentalDayChecklist | string;
  done: boolean;
  note?: string;
  /** 救生重新站位时关联的新站岗记录（可由后端按增派人数自动补岗） */
  guardNames?: string[];
}

export interface RentalViolationReq {
  type: RentalViolationType;
  description: string;
  actualCount?: number;
  suspend?: boolean;
}

export interface RentalCloseoutReq {
  key: 'cleared' | 'lockersCleared' | 'waterRetested' | 'equipmentReset' | 'guardPatrolConfirmed';
  done: boolean;
  note?: string;
  /** 水质复测读数（waterRetested 时可直接提交，或引用已有达标读数 id） */
  reading?: { tempC: number; freeChlorine: number; turbidity: number; ph: number };
  waterReadingId?: string;
}

export interface OrgRestrictionReq {
  rentalRestricted: boolean;
  requiredExtraLifeguards?: number;
  depositMultiplier?: number;
  note?: string;
}

/** 申请前/申请后的冲突范围派生结果（页面先列出冲突范围与特殊人群标注） */
export interface RentalConflictScope {
  sessionId: string;
  sessionLabel: string;
  /** 是否撞上居民公益时段（老人晨泳/亲子/公益） */
  publicWelfare: boolean;
  /** 救生员排班缺口（按人数/儿童/泳区测算的最低在岗 - 已排班） */
  requiredLifeguards: number;
  scheduledLifeguards: number;
  lifeguardShortage: number;
  /** 更衣淋浴容量冲突 */
  showerTotal: number;
  showerRequested: number;
  showerResidentUse: number;
  showerConflict: boolean;
  /** 储物柜数量冲突 */
  lockerTotal: number;
  lockerRequested: number;
  lockerResidentUse: number;
  lockerConflict: boolean;
  /** 受影响的已预约居民（带类别标注），平台不得直接覆盖 */
  residents: {
    bookingId: string; bookingCode: string; userId: string; userName?: string;
    tags: ResidentConflictKind[]; zoneId: ZoneId; lane?: number;
    partySize: number; childCount: number; elder: boolean; memberTier?: MemberTier;
  }[];
  /** 泳区/泳道占用与容量口径 */
  zoneCapacity: number;
  zoneInPool: number;
  zoneBooked: number;
  zoneLocked: number;
  overCapacity: boolean;
  /** 现有锁区重叠提示 */
  lockOverlaps: string[];
  messages: string[];
}


export interface Me {
  user: User;
  zoneConflicts: { sessionId: string; sessionLabel: string; message: string }[];
}

// ============ 服务端按角色裁剪后的状态视图（/api/state） ============
/** 对外最小人员卡片：绝不含余额、补偿券、密码、年龄等 PII */
export interface PatronCard {
  id: string;
  name: string;
  role: Role;
  phone?: string;
  memberTier?: MemberTier;
  deepCert?: boolean;
}

export interface StateView {
  viewerRole: Role;
  users: PatronCard[];
  zones: Zone[];
  sessions: Session[];
  bookings: Booking[];
  waterReadings: WaterReading[];
  equipment: Equipment[];
  guardDuties: GuardDuty[];
  patrolIssues: PatrolIssue[];
  incidents: Incident[];
  workTasks: WorkTask[];
  complaints: Complaint[];
  notifications: Notification[];
  walletTxns: WalletTxn[];
  lessons: CoachingLesson[];
  /** 闭池处置档案：ops 全量；其他角色为按本人/脱敏裁剪后的快照 */
  closureRecords: ClosureRecord[];
  /** 抽筋救援记录：救生员/运营/前台可见；保洁/维修仅见本岗协同事件关联；居民不可见 */
  crampRescues: CrampRescue[];
  /** 救生员培训项（运营全量；救生员见与本人/全体相关项） */
  guardTraining: GuardTrainingItem[];
  /** 机构包场协调档案：ops/frontdesk/lifeguard 按需裁剪；机构见本机构；居民仅见含本人改约项的脱敏卡片 */
  rentalCases: RentalCase[];
  /** 机构账单：ops 全量；机构仅本机构；其他角色不可见 */
  orgBills: OrgBillItem[];
  /** 机构信用：ops/frontdesk 全量；机构见本机构；其他角色不可见 */
  orgCredits: OrgCreditProfile[];
  boards: LiveBoard[];
  conflicts: { sessionId: string; sessionLabel: string; message: string }[];
}
