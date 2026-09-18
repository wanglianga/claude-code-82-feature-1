import React, { createContext, useCallback, useContext, useState } from 'react';
import type {
  BookingStatus, PoolStatus, IncidentType, IncidentStatus, PatrolIssueType,
  IssueSeverity, WorkTaskStatus, MemberTier, BookingKind, EquipmentStatus,
} from '../shared/types.js';

export const BOOKING_STATUS_LABEL: Record<BookingStatus, string> = {
  booked: '待入场',
  checked_in: '已入场',
  no_show: '爽约',
  cancelled: '已取消',
  refunded: '已退费',
  compensated: '退费+补偿',
  postponed: '已顺延',
  rebooked: '已改约',
};

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'purple' | 'gray';

export const BOOKING_STATUS_BADGE: Record<BookingStatus, Tone> = {
  booked: 'info', checked_in: 'ok', no_show: 'gray', cancelled: 'gray',
  refunded: 'purple', compensated: 'purple', postponed: 'warn', rebooked: 'purple',
};

export const POOL_STATUS_LABEL: Record<PoolStatus, string> = {
  normal: '正常开放', restricted: '限流通告', partial: '部分开放', closed: '已闭池',
};
export const POOL_STATUS_BADGE: Record<PoolStatus, Tone> = {
  normal: 'ok', restricted: 'warn', partial: 'warn', closed: 'danger',
};

export const KIND_LABEL: Record<BookingKind, string> = {
  personal: '个人泳道',
  parent_child: '亲子时段',
  elder_morning: '老人晨泳（公益）',
  coaching: '教练课',
  group: '团体预约',
  institution_rental: '机构包场',
  guest: '外来访客',
};

export const TIER_LABEL: Record<MemberTier, string> = {
  normal: '普通会员', silver: '银卡会员', gold: '金卡会员', guest: '外来访客', institution: '培训机构',
};

export const INCIDENT_TYPE_LABEL: Record<IncidentType, string> = {
  water_abnormal: '水质异常',
  thunderstorm: '雷雨临近',
  cramp: '泳客抽筋',
  child_lost: '儿童走失',
  locker_dispute: '储物柜纠纷',
  overbooking: '预约超额',
  equipment_fault: '设备故障',
  medical: '突发医疗急救',
};

export const INCIDENT_STATUS_LABEL: Record<IncidentStatus, string> = {
  open: '待响应', responding: '处置中', resolved: '已关闭',
};

export const ISSUE_TYPE_LABEL: Record<PatrolIssueType, string> = {
  diving: '违规跳水',
  child_alone: '儿童离开陪同人',
  wet_floor: '地面湿滑',
  shower_crowd: '淋浴区拥堵',
  water_quality: '水质检测异常',
  guard_missing: '救生员脱岗',
  other: '其他',
};

export const SEVERITY_LABEL: Record<IssueSeverity, string> = {
  minor: '一般', major: '较大', critical: '紧急',
};

export const TASK_STATUS_LABEL: Record<WorkTaskStatus, string> = {
  pending: '待处理', in_progress: '处理中', done: '已完成',
};

export const EQUIPMENT_LABEL: Record<EquipmentStatus, string> = {
  normal: '正常', warning: '预警', fault: '故障',
};

export const SWIM_LEVEL_LABEL = {
  none: '不会水', beginner: '初学者', intermediate: '中等', advanced: '熟练',
} as const;

export function fmtTime(iso?: string) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export function fmtDateTime(iso?: string) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(iso)}`;
}

export function Badge({ tone = 'gray', children }: { tone?: Tone | string; children: React.ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Card({ title, extra, children, className = '' }: { title?: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={`card ${className}`}>
      {title && <h3>{title}{extra && <span className="spacer" />}{extra}</h3>}
      {children}
    </div>
  );
}

export function Empty({ text = '暂无数据' }: { text?: string }) {
  return <div className="empty">🏊 {text}</div>;
}

// ---------- Toast ----------
interface Toast { id: number; text: string; kind: 'ok' | 'err' | 'info'; }
const ToastCtx = createContext<(t: string, kind?: Toast['kind']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { id, text, kind }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast">
        {toasts.map((t) => <div key={t.id} className={`t ${t.kind}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

/** 把 mutation 错误统一弹 toast */
export function useNotify() {
  const toast = useToast();
  return {
    ok: (m: string) => toast(m, 'ok'),
    err: (e: unknown) => toast(e instanceof Error ? e.message : '操作失败', 'err'),
    info: (m: string) => toast(m, 'info'),
  };
}
