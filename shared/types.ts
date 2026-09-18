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
  | 'postponed';    // 已顺延到后续场次（延期处置）

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
  source?: 'routine' | 'incident' | 'patrol' | 'closure';
  incidentId?: string;
  /** 闭池联动生成时，引用不可变闭池档案 id */
  closureId?: string;
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

/** 机构资质材料核验项（平台不能直接覆盖居民预约，须先核验） */
export type QualificationKey =
  | 'businessLicense'   // 办学/营业执照
  | 'coachCert'         // 教练资质（教练配置）
  | 'guardCert'         // 救生员资质/配置
  | 'insurance'         // 保险
  | 'independentAccess' // 独立出入口
  | 'changingRoom';     // 独立更衣/淋浴需求

export const QUALIFICATION_LABEL: Record<QualificationKey, string> = {
  businessLicense: '办学/营业执照',
  coachCert: '教练资质与配置',
  guardCert: '救生员资质与配置',
  insurance: '场地/人员保险',
  independentAccess: '独立出入口',
  changingRoom: '独立更衣淋浴安排',
};

/** 资质核验状态：材料在申请时登记，运营逐项核验通过后方可批准 */
export type VerifyState = 'unverified' | 'verified' | 'rejected';

export interface QualificationItem {
  key: QualificationKey;
  /** 材料说明/编号/有效期等（机构申请时填报） */
  detail: string;
  state: VerifyState;
  verifiedBy?: string;
  verifiedAt?: string;
  note?: string;
}

/** 机构包场申请中的教练配置 */
export interface CoachAssignment {
  name: string;
  certNo: string;
}

/** 机构信用记录条目 */
export interface CreditEvent {
  id: string;
  at: string;
  type: 'overtime' | 'over_capacity' | 'occupy_welfare' | 'child_alone' | 'add_people' | 'complaint' | 'rectified';
  title: string;
  detail: string;
  /** 扣分（正整数；rectified 整改通过可记 0 或回补） */
  points: number;
  recordedBy: string;
  /** 是否已整改 */
  rectified: boolean;
  rectifiedAt?: string;
  rectifiedNote?: string;
  rentalId?: string;
}

/** 培训机构档案（资质、联系人、信用、限制） */
export interface Institution {
  id: string;
  name: string;
  /** 关联的平台账号（memberTier=institution） */
  userId?: string;
  contactName: string;
  contactPhone: string;
  /** 信用分起始 100，违规扣减、整改可部分回补 */
  creditScore: number;
  /** 押金余额（元）；频繁违规可被要求追加 */
  deposit: number;
  /** 是否被限制后续包场（信用过低或整改未完成） */
  blocked: boolean;
  blockReason?: string;
  /** 要求每场额外增派救生员人数 */
  requiredExtraGuards: number;
  creditEvents: CreditEvent[];
  createdAt: string;
}

/** 机构账单（一个场次包场一条账单，费用按泳道/时段/救生加班/储物柜/淋浴拆分） */
export interface InstitutionBill {
  id: string;
  institutionId: string;
  rentalId: string;
  sessionId: string;
  /** 已支付（机构对公/储值） */
  paid: boolean;
  paidAt?: string;
  /** 支付方式：机构对公现金/转账 或 机构账号储值 */
  paymentMethod: 'cash' | 'wallet';
  items: InstitutionBillItem[];
  /** 合计（拆分项求和，后端核算，前端不可改） */
  total: number;
  /** 押金扣减（违规赔偿时使用） */
  depositDeducted: number;
  note?: string;
  createdAt: string;
}

export interface InstitutionBillItem {
  /** lane=泳道时段 guard=救生员加班 locker=储物柜 shower=淋浴区占用 deposit=押金 */
  kind: 'lane' | 'guard_overtime' | 'locker' | 'shower' | 'deposit';
  label: string;
  /** 数量（泳道数/救生员人次/储物柜数/淋浴位/小时） */
  qty: number;
  unitPrice: number;
  amount: number;
}

/** 受冲突影响的居民预约（按特殊人群标签标出） */
export type ResidentTag =
  | 'elder_morning'   // 老人晨泳
  | 'parent_child'    // 亲子时段
  | 'public_welfare'  // 居民公益时段
  | 'coaching'        // 教练课
  | 'stored_value'    // 会员储值用户
  | 'child'           // 含儿童
  | 'deep_cert';      // 深水证用户

export const RESIDENT_TAG_LABEL: Record<ResidentTag, string> = {
  elder_morning: '老人晨泳',
  parent_child: '亲子时段',
  public_welfare: '居民公益',
  coaching: '教练课',
  stored_value: '会员储值',
  child: '含儿童',
  deep_cert: '深水证',
};

export type ReschedulePreference = 'pending' | 'agree' | 'reject';
export type RescheduleResolution = 'keep' | 'reschedule' | 'refund' | 'voucher' | 'compressed';

/** 包场冲突中的一笔居民预约及其改约征询/处置结果（全程进入场次记录） */
export interface RentalResidentConflict {
  bookingId: string;
  bookingCode: string;
  userId: string;
  userName: string;
  zoneId: ZoneId;
  lane?: number;
  kind: BookingKind;
  partySize: number;
  children: number;
  paidAmount: number;
  paymentMethod: Booking['paymentMethod'];
  memberTier?: MemberTier;
  tags: ResidentTag[];
  /** 公益时段（老人晨泳等）——压缩/退费/补偿券口径 */
  publicWelfare: boolean;
  /** 征询状态：待回复 / 同意改约 / 不同意（保留原预约） */
  preference: ReschedulePreference;
  /** 平台提供的改约方案 */
  offerSessionId?: string;
  /** 是否额外补偿券 */
  offerVoucher: boolean;
  offerNote?: string;
  notifiedAt?: string;
  respondedAt?: string;
  /** 最终处置：保留 / 改约 / 退费 / 补偿券 / 因范围压缩自然解消 */
  resolution?: RescheduleResolution;
  /** 改约后在目标场次生成的新预约 id */
  migratedBookingId?: string;
  /** 退费时的钱包流水 id */
  refundTxnId?: string;
  /** 发放补偿券数 */
  voucherGranted?: number;
  resolvedAt?: string;
  /** 送达居民端的个人通知 id */
  notificationId?: string;
}

/** 运营协调措施（可叠加多项） */
export interface RentalCoordination {
  /** 实际批准占用的泳道（拆分泳道；空 = 整区） */
  lanes: number[];
  /** 批准泳区（可被压缩到更小泳区） */
  zoneId: ZoneId;
  /** 缩短后的时段（不传=原申请时段） */
  adjustedStart?: string;
  adjustedEnd?: string;
  shorten: boolean;
  /** 限制后人数（<= 申请人数） */
  approvedPartySize: number;
  /** 批准儿童数 */
  approvedChildren: number;
  /** 增派救生员人数 */
  extraGuards: number;
  /** 是否暂停部分非公益泳道（腾挪名额，公益泳道不得占用） */
  suspendNonWelfareLanes: boolean;
  suspendedLaneDesc?: string;
  /** 向改约居民提供补偿券 */
  provideVoucher: boolean;
  /** 是否需要机构追加押金（信用偏低时） */
  requireDeposit: number;
  note?: string;
}

/** 包场生命周期状态 */
export type RentalStatus =
  | 'applied'          // 已申请，待资质核验/冲突协调
  | 'coordinating'    // 协调中（居民改约征询中）
  | 'approved'        // 已批准（费用已入账单）
  | 'rejected'        // 已驳回
  | 'active'          // 当天进行中
  | 'suspended'       // 现场违规被暂停
  | 'ended'           // 包场时间结束，待清场复测门禁
  | 'completed'       // 清场复测通过、居民预约已恢复
  | 'cancelled';      // 取消

/** 包场现场/收尾确认项 */
export type RentalGateKey =
  | 'roster'           // 前台核验机构名单
  | 'visitorId'        // 访客身份核验
  | 'insurance'        // 保险核验
  | 'guardReposition'  // 救生员按包场人数重新站位
  | 'cleaning'         // 保洁确认地面/淋浴/储物柜/消毒
  | 'maintenance';     // 维修确认设备/消毒安排

export const RENTAL_GATE_LABEL: Record<RentalGateKey, string> = {
  roster: '前台核验机构名单',
  visitorId: '访客身份核验',
  insurance: '现场保险核验',
  guardReposition: '救生员按包场人数重新站位',
  cleaning: '保洁确认地面/淋浴/储物柜/消毒',
  maintenance: '维修确认设备与消毒安排',
};

export type RentalGateState = {
  done: boolean;
  at?: string;
  by?: string;
  note?: string;
};

/** 清场恢复开放门禁（五项，全部完成才能恢复居民预约；未复测或未清场不得开放下一场） */
export type RentalClearanceKey =
  | 'clear_pool'       // 先清场
  | 'clear_lockers'    // 清储物柜
  | 'water_retest'     // 水质复测
  | 'equipment_reset'  // 设备复位
  | 'guard_patrol';    // 救生巡查确认

export const RENTAL_CLEARANCE_LABEL: Record<RentalClearanceKey, string> = {
  clear_pool: '清场（机构人员全部撤离）',
  clear_lockers: '清储物柜（无遗落、全部清空）',
  water_retest: '水质复测达标',
  equipment_reset: '设备复位（泳道线/救生器材/更衣淋浴）',
  guard_patrol: '救生巡查确认（各泳道秩序与安全）',
};

export type RentalClearanceState = {
  done: boolean;
  at?: string;
  by?: string;
  note?: string;
  /** 水质复测项关联的达标读数 id */
  readingId?: string;
};

/** 现场违规记录（超人数/超时/占公益泳道/儿童无人陪同/私自加人 → 可暂停包场并通知社区运营） */
export interface RentalViolation {
  id: string;
  at: string;
  type: CreditEvent['type'];
  title: string;
  detail: string;
  reportedBy: string;
  /** 是否当场暂停包场 */
  suspended: boolean;
  /** 信用扣分 */
  points: number;
  /** 整改要求 */
  rectifyNote?: string;
  /** 是否已整改并恢复 */
  resolved: boolean;
  resolvedAt?: string;
  /** 关联协同事件 id */
  incidentId?: string;
  /** 恢复/继续的批准人 */
  resumedBy?: string;
}

/** 设施容量（申请时用于冲突检测：更衣淋浴、储物柜） */
export interface FacilityInfo {
  /** 更衣淋浴容量（同时使用人数） */
  showerCapacity: number;
  /** 储物柜总数 */
  lockerCount: number;
  /** 申请占用储物柜数 */
  lockersNeeded: number;
  /** 是否使用独立更衣/淋浴 */
  independentChanging: boolean;
  showerNote?: string;
}

/** 一条时间线留痕（所有冲突协调/改约/补偿/机构确认/恢复结果进入场次记录） */
export interface RentalAuditEntry {
  at: string;
  by: string;
  byRole: Role;
  event: string;
  detail?: string;
}

/** 冲突预览返回结构（申请前先按日期/时段/泳道/泳区/容量/救生排班/已预约居民列出） */
export interface RentalConflictPreview {
  sessionId: string;
  sessionLabel: string;
  date: string;
  start: string;
  end: string;
  publicWelfare: boolean;
  zoneId: ZoneId;
  zoneName: string;
  lanes: (number | undefined)[];
  /** 泳区容量冲突 */
  capacity: { zoneCapacity: number; inPool: number; booked: number; locked: number; applying: number; overflow: number };
  /** 更衣淋浴容量冲突 */
  shower: { capacity: number; occupied: number; applying: number; overflow: number };
  /** 储物柜冲突 */
  locker: { total: number; occupied: number; needed: number; remaining: number; shortfall: number };
  /** 救生员排班现状 */
  guards: { post: GuardPost; postLabel: string; guardName: string }[];
  /** 已预约居民（含标签） */
  residents: RentalResidentConflict[];
  /** 老人晨泳/亲子/公益/教练课/会员储值 命中数 */
  tagCounts: Partial<Record<ResidentTag, number>>;
  /** 现有商业/教学锁区 */
  existingLocks: { id: string; title: string; zoneId: ZoneId; lane?: number; capacity: number; isCommercial: boolean }[];
  /** 冲突结论文案 */
  conflicts: string[];
}

/** 机构包场协调主记录 */
export interface InstitutionRental {
  id: string;
  code: string;                 // IR-xxxx
  institutionId: string;
  /** 申请联系人账号（如有） */
  applicantUserId?: string;
  sessionId: string;
  /** 申请泳区/泳道（lanes 空=整区） */
  requestZoneId: ZoneId;
  requestLanes: number[];
  requestStart: string;
  requestEnd: string;
  partySize: number;            // 总人数
  adultCount: number;
  childCount: number;
  ageMin?: number;
  ageMax?: number;
  hasChildren: boolean;
  /** 儿童离陪规则核验：成人陪同人数、一对一比例要求 */
  companions: number;
  companionRequirement: string;
  purpose: string;
  facility: FacilityInfo;
  qualifications: QualificationItem[];
  coachAssignments: CoachAssignment[];
  /** 保险单号/有效期（申请登记，前台当天核验） */
  insurancePolicyNo: string;
  insuranceExpiry: string;
  status: RentalStatus;
  conflictPreview: RentalConflictPreview;
  residentConflicts: RentalResidentConflict[];
  coordination?: RentalCoordination;
  billId?: string;
  /** 批准/驳回 */
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
  /** 机构对协调方案（费用/范围）的确认 */
  institutionConfirmed: boolean;
  institutionConfirmedAt?: string;
  gates: Record<RentalGateKey, RentalGateState>;
  violations: RentalViolation[];
  clearance: Record<RentalClearanceKey, RentalClearanceState>;
  /** 恢复开放结果 */
  reopenedAt?: string;
  reopenedBy?: string;
  reopenNote?: string;
  /** 批准时写入场次的锁区 id（恢复时释放） */
  lockId?: string;
  audit: RentalAuditEntry[];
  createdAt: string;
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
  /** 培训机构档案（资质/信用/押金/限制） */
  institutions: Institution[];
  /** 机构包场协调记录（申请→核验→协调→批准→当天→违规→清场→恢复全生命周期） */
  rentals: InstitutionRental[];
  /** 机构账单（费用按泳道/时段/救生加班/储物柜/淋浴拆分） */
  institutionBills: InstitutionBill[];
  /** 场地设施容量（更衣淋浴、储物柜），包场冲突检测用 */
  facilities: { showerCapacity: number; lockerCount: number };
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
  institutionId?: string;
  /** 机构名称（无档案时申请并建档） */
  institutionName?: string;
  sessionId: string;
  zoneId: ZoneId;
  /** 申请泳道（空数组=整区） */
  lanes?: number[];
  start?: string;
  end?: string;
  partySize: number;
  adultCount: number;
  childCount: number;
  ageMin?: number;
  ageMax?: number;
  /** 成人陪同人数（含儿童时按儿童离陪规则核验） */
  companions: number;
  purpose: string;
  lockersNeeded: number;
  showerCapacity: number;
  independentChanging: boolean;
  showerNote?: string;
  /** 资质材料：key -> 说明/编号 */
  qualifications?: Partial<Record<QualificationKey, string>>;
  coaches?: { name: string; certNo: string }[];
  insurancePolicyNo: string;
  insuranceExpiry: string;
}

export interface RentalQualVerifyReq {
  key: QualificationKey;
  pass: boolean;
  note?: string;
}

export interface RentalCoordinationReq {
  zoneId: ZoneId;
  lanes: number[];
  shorten: boolean;
  adjustedStart?: string;
  adjustedEnd?: string;
  approvedPartySize: number;
  approvedChildren: number;
  extraGuards: number;
  suspendNonWelfareLanes: boolean;
  suspendedLaneDesc?: string;
  provideVoucher: boolean;
  requireDeposit: number;
  note?: string;
}

export interface RentalOpenRescheduleReq {
  /** 给居民的改约目标场次；不传则由系统选取同日后续场 */
  offerSessionId?: string;
  offerVoucher?: boolean;
  offerNote?: string;
}

export interface RentalRescheduleResponseReq {
  agree: boolean;
}

export interface RentalResolveResidentReq {
  bookingId: string;
  /** keep=保留原预约（压缩包场范围） refund=退费 voucher=退费+补偿券 reschedule=按方案改约 compressed=范围压缩后已不冲突，保留 */
  resolution: 'keep' | 'refund' | 'voucher' | 'reschedule' | 'compressed';
  targetSessionId?: string;
}

export interface RentalApproveReq {
  note?: string;
  /** 账单支付方式：机构对公现金/转账 或 机构账号储值 */
  paymentMethod?: 'cash' | 'wallet';
}

export interface RentalGateReq {
  note?: string;
  /** 救生重新站位：附加说明（人数/岗位） */
  guardPlan?: string;
}

export interface RentalViolationReq {
  type: 'overtime' | 'over_capacity' | 'occupy_welfare' | 'child_alone' | 'add_people' | 'complaint';
  detail: string;
  /** 是否当场暂停包场 */
  suspend: boolean;
  rectifyNote?: string;
  points?: number;
}

export interface RentalClearanceReq {
  note?: string;
}

export interface InstitutionRestrictionReq {
  blocked: boolean;
  blockReason?: string;
  requiredExtraGuards?: number;
  /** 追加/退还押金 */
  depositDelta?: number;
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
  /** 机构包场协调记录：运营/前台全量；救生/保洁/维修见当天本岗协同；居民仅见与本人改约相关包场 */
  rentals: InstitutionRental[];
  /** 机构档案：仅运营（信用/押金/限制处置所需） */
  institutions: Institution[];
  /** 机构账单：仅运营/前台（财务）；居民不下发 */
  institutionBills: InstitutionBill[];
  /** 场地设施容量 */
  facilities: { showerCapacity: number; lockerCount: number };
  boards: LiveBoard[];
  conflicts: { sessionId: string; sessionLabel: string; message: string }[];
}
