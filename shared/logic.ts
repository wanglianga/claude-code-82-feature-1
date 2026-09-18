import type { BookingKind, MemberTier, RentalCoordination, InstitutionBillItem } from './types.js';

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

// ============ 机构包场费用拆分（泳道 / 救生加班 / 储物柜 / 淋浴 / 押金） ============
export const RENTAL_PRICE = {
  /** 每条泳道每小时场租 */
  lanePerHour: 200,
  /** 整区包场（未拆泳道）每小时基础场租 */
  zonePerHour: 900,
  /** 每名增派救生员的加班费（整场） */
  guardOvertime: 180,
  /** 每个储物柜租用 */
  locker: 5,
  /** 淋浴区按占用人数（清洁/热水成本） */
  showerPerPerson: 3,
  /** 标准押金 */
  baseDeposit: 500,
};

/** 一场时长（小时），由 HH:MM 起止计算 */
export function hoursBetween(start: string, end: string): number {
  const [h1, m1] = start.split(':').map(Number);
  const [h2, m2] = end.split(':').map(Number);
  let mins = h2 * 60 + m2 - (h1 * 60 + m1);
  if (mins <= 0) mins += 12 * 60; // 跨午间兜底
  return Math.max(1, Math.round((mins / 60) * 10) / 10);
}

/**
 * 依据协调后的批准方案拆分机构包场账单。
 * 费用严格按：泳道（拆分泳道按道·小时，整区按整区·小时）+ 救生员加班 + 储物柜 + 淋浴区占用 +（追加押金单列）。
 */
export function buildRentalBillItems(input: {
  coordination: RentalCoordination;
  /** 申请原始泳道数（用于判断整区 vs 拆道） */
  requestWholeZone: boolean;
  hours: number;
  lockersNeeded: number;
  depositRequired: number;
}): InstitutionBillItem[] {
  const c = input.coordination;
  const items: InstitutionBillItem[] = [];
  const splitLanes = c.lanes.length > 0;
  if (splitLanes) {
    const laneAmt = Math.round(RENTAL_PRICE.lanePerHour * c.lanes.length * input.hours);
    items.push({ kind: 'lane', label: `泳道场租（${c.lanes.length} 条道 × ${input.hours} 小时）`, qty: c.lanes.length, unitPrice: Math.round(RENTAL_PRICE.lanePerHour * input.hours), amount: laneAmt });
  } else {
    const zoneAmt = Math.round(RENTAL_PRICE.zonePerHour * input.hours);
    items.push({ kind: 'lane', label: `整区包场场租（${input.hours} 小时）`, qty: 1, unitPrice: zoneAmt, amount: zoneAmt });
  }
  if (c.extraGuards > 0) {
    items.push({ kind: 'guard_overtime', label: `增派救生员加班（${c.extraGuards} 名）`, qty: c.extraGuards, unitPrice: RENTAL_PRICE.guardOvertime, amount: c.extraGuards * RENTAL_PRICE.guardOvertime });
  }
  if (input.lockersNeeded > 0) {
    items.push({ kind: 'locker', label: `储物柜租用（${input.lockersNeeded} 个）`, qty: input.lockersNeeded, unitPrice: RENTAL_PRICE.locker, amount: input.lockersNeeded * RENTAL_PRICE.locker });
  }
  const showerPeople = c.approvedPartySize;
  if (showerPeople > 0) {
    items.push({ kind: 'shower', label: `淋浴区占用（${showerPeople} 人）`, qty: showerPeople, unitPrice: RENTAL_PRICE.showerPerPerson, amount: showerPeople * RENTAL_PRICE.showerPerPerson });
  }
  if (input.depositRequired > 0) {
    items.push({ kind: 'deposit', label: `履约/安全押金（可退）`, qty: 1, unitPrice: input.depositRequired, amount: input.depositRequired });
  }
  void input.requestWholeZone;
  return items;
}

export function billTotal(items: InstitutionBillItem[]): number {
  return items.reduce((s, i) => s + i.amount, 0);
}

/**
 * 儿童离陪规则：含儿童包场不得因包场放宽。
 * - 6 岁以下幼儿：1 名成人至多陪同 1 名儿童（1:1）；
 * - 其余未成年人：每 3 名儿童至少 1 名成人陪同（1:3），且教练/救生员不计入陪同人数（看护职责分离）。
 * 返回需要的最少成人陪同人数。
 */
export function requiredCompanions(childCount: number, ageMin?: number): number {
  if (childCount <= 0) return 0;
  const ratio = ageMin != null && ageMin <= 6 ? 1 : 3;
  return Math.ceil(childCount / ratio);
}
