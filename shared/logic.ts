import type { BookingKind, MemberTier, ZoneId } from './types.js';

// ============ 水质标准（人工游泳场所卫生限值，平台演示口径） ============
export const WATER_STD = {
  temp: { min: 26, max: 28, label: '水温', unit: '°C' },
  chlorine: { min: 0.3, max: 1.0, label: '余氯', unit: 'mg/L' },
  turbidity: { max: 1.0, label: '浊度', unit: 'NTU' },
  ph: { min: 7.0, max: 7.8, label: 'pH', unit: '' },
};

export function evaluateWater(r: { tempC: number; freeChlorine: number; turbidity: number; ph: number }) {
  const fields: string[] = [];
  if (r.tempC < WATER_STD.temp.min || r.tempC > WATER_STD.temp.max)
    fields.push(`水温 ${r.tempC}°C 超出 ${WATER_STD.temp.min}-${WATER_STD.temp.max}°C`);
  if (r.freeChlorine < WATER_STD.chlorine.min || r.freeChlorine > WATER_STD.chlorine.max)
    fields.push(`余氯 ${r.freeChlorine}mg/L 超出 ${WATER_STD.chlorine.min}-${WATER_STD.chlorine.max}mg/L`);
  if (r.turbidity > WATER_STD.turbidity.max)
    fields.push(`浊度 ${r.turbidity}NTU 高于 ${WATER_STD.turbidity.max}NTU`);
  if (r.ph < WATER_STD.ph.min || r.ph > WATER_STD.ph.max)
    fields.push(`pH ${r.ph} 超出 ${WATER_STD.ph.min}-${WATER_STD.ph.max}`);
  return { abnormal: fields.length > 0, fields };
}

// ============ 计价 ============
export function priceOf(kind: BookingKind, partySize: number, childCount: number, _tier?: MemberTier, lessonPrice?: number) {
  switch (kind) {
    case 'elder_morning': return 0;
    case 'parent_child': return 30 + 10 * childCount;
    case 'guest': return 45;
    case 'personal': return 25;
    case 'group': return 20 * Math.max(partySize, 1);
    case 'institution_rental': return Math.max(300, 15 * Math.max(partySize, 1));
    case 'coaching': return lessonPrice ?? 120;
  }
}

// ============ 机构包场：设施容量 / 救生配比 / 儿童陪同 / 费用拆分规则 ============

/** 场馆更衣淋浴与储物柜总量（演示口径，参与包场冲突范围计算） */
export const FACILITY = {
  /** 淋浴位总数 */
  showerTotal: 40,
  /** 储物柜总数 */
  lockerTotal: 120,
  /** 独立出入口可用（机构申请独立动线时核验） */
  independentEntryAvailable: true,
  /** 包场同时段居民常规预留淋浴位（商业占用不得全部挤占） */
  residentShowerReserve: 12,
  /** 储物柜居民预留 */
  residentLockerReserve: 40,
};

/** 救生员配比：每 25 人至少 1 名救生员；含儿童的包场按每 15 人 1 名且不少于 2 名；深水区再上浮 */
export function requiredLifeguards(opts: { partySize: number; containsChildren: boolean; zoneId: ZoneId }): number {
  const unit = opts.containsChildren ? 15 : 25;
  let n = Math.max(1, Math.ceil(opts.partySize / unit));
  if (opts.containsChildren) n = Math.max(2, n);
  if (opts.zoneId === 'deep') n += 1;
  return n;
}

/** 儿童离陪规则：≤13 岁儿童必须逐人登记陪同人，包场不放宽 */
export const CHILD_COMPANION_MAX_AGE = 13;

export function validateCompanions(
  companions: { childAge: number; companion: string; companionPhone: string }[],
  childCount: number,
): { pass: boolean; missing: string[] } {
  const missing: string[] = [];
  if (childCount > 0 && companions.length < childCount) {
    missing.push(`申报儿童 ${childCount} 人，仅登记 ${companions.length} 名陪同人，须逐人登记`);
  }
  companions.forEach((c, i) => {
    if (c.childAge > CHILD_COMPANION_MAX_AGE)
      missing.push(`第 ${i + 1} 名儿童年龄 ${c.childAge} 超过 ${CHILD_COMPANION_MAX_AGE} 岁，不应按儿童陪同登记`);
    if (!c.companion?.trim()) missing.push(`第 ${i + 1} 名儿童缺少陪同人姓名`);
    if (!/^1\d{10}$/.test((c.companionPhone ?? '').trim())) missing.push(`第 ${i + 1} 名儿童陪同人电话无效`);
  });
  return { pass: missing.length === 0, missing };
}

export interface RentalFeeInput {
  laneCount: number;
  /** 实际包场时长（小时，支持缩短后口径） */
  hours: number;
  partySize: number;
  /** 是否占用居民公益时段（时段费上浮用于补偿居民） */
  welfarePeriod: boolean;
  extraLifeguards: number;
  /** 救生员加班工时（小时） */
  lifeguardHours: number;
  lockerCount: number;
  showerSeats: number;
  depositMultiplier?: number;
}

export const RENTAL_RATE = {
  lanePerHour: 120,        // 每条泳道每小时
  periodWelfareExtra: 300, // 公益/高峰时段附加
  lifeguardPerHour: 80,    // 增派救生员每人每小时加班费
  lockerEach: 2,           // 储物柜每只
  showerEach: 3,           // 淋浴位每位
  depositBase: 500,        // 基础押金
};

/** 包场费用拆分：泳道 / 时段 / 救生加班 / 储物柜 / 淋浴区占用 / 押金，进入机构账单 */
export function rentalFeeOf(input: RentalFeeInput) {
  const laneFee = RENTAL_RATE.lanePerHour * Math.max(1, input.laneCount) * Math.max(1, Math.round(input.hours * 2) / 2);
  const periodFee = input.welfarePeriod ? RENTAL_RATE.periodWelfareExtra : 100;
  const lifeguardOvertimeFee = RENTAL_RATE.lifeguardPerHour * Math.max(0, input.extraLifeguards) * Math.max(1, input.lifeguardHours);
  const lockerFee = RENTAL_RATE.lockerEach * Math.max(0, input.lockerCount);
  const showerFee = RENTAL_RATE.showerEach * Math.max(0, input.showerSeats);
  const deposit = Math.round(RENTAL_RATE.depositBase * (input.depositMultiplier ?? 1));
  const total = laneFee + periodFee + lifeguardOvertimeFee + lockerFee + showerFee + deposit;
  return {
    laneFee, periodFee, lifeguardOvertimeFee, lockerFee, showerFee, deposit, total,
  };
}

/** 淋浴/储物柜冲突范围：机构需求 + 同场居民在池预留不得超总量 */
export function facilityConflicts(input: { showerSeats: number; lockerCount: number; residentShowerUse: number; residentLockerUse: number }) {
  const msgs: string[] = [];
  if (input.showerSeats + input.residentShowerUse > FACILITY.showerTotal - FACILITY.residentShowerReserve)
    msgs.push(`淋浴位不足：机构需求 ${input.showerSeats} + 居民在场约 ${input.residentShowerUse} 超过可用 ${FACILITY.showerTotal - FACILITY.residentShowerReserve}（预留 ${FACILITY.residentShowerReserve}）`);
  if (input.lockerCount + input.residentLockerUse > FACILITY.lockerTotal - FACILITY.residentLockerReserve)
    msgs.push(`储物柜不足：机构需求 ${input.lockerCount} + 居民在用 ${input.residentLockerUse} 超过可用 ${FACILITY.lockerTotal - FACILITY.residentLockerReserve}（预留 ${FACILITY.residentLockerReserve}）`);
  return msgs;
}

/** 信用分阈值：低于该分限制后续包场，并强制增派救生员与上浮押金 */
export const CREDIT = {
  initial: 100,
  restrictThreshold: 80,
  violationScore: {
    over_capacity: -10,
    overtime: -6,
    occupy_welfare: -15,
    child_unaccompanied: -15,
    unauthorized_addon: -12,
    other: -4,
    complaint: -6,
    rectify_ok: 0,
    rental_done: 0,
  } as Record<string, number>,
};

/** 依据累计违规计算机构信用画像的限制项 */
export function creditRestriction(score: number, violationCount: number) {
  const restricted = score < CREDIT.restrictThreshold || violationCount >= 3;
  return {
    rentalRestricted: restricted,
    requiredExtraLifeguards: restricted ? 1 : 0,
    depositMultiplier: restricted ? 2 : score < 90 ? 1.5 : 1,
  };
}

