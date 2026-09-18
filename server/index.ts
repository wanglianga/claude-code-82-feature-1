import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import type {
  Role, User, WorkTask, EquipmentStatus,
} from '../shared/types.js';
import { getDB, mutate, nextId } from './store.js';
import {
  HttpError, sessionDetail, createBooking, checkIn,
  addWaterReading, addPatrolIssue, openIncident, changePoolStatus, lockConflicts,
} from './domain.js';
import {
  createCrampRescue, confirmRescueClosure, adjustRescuePost, acknowledgeFocusLane,
  reviewCrampRescue, completeTraining,
} from './cramp.js';
import {
  applyRental, qualifyRental, rejectRental, coordinateRental, answerRebook, expireRebook,
  orgConfirmRental, setActualCount, checkDayItem, startRental, reportRentalViolation,
  rectifyRentalViolation, checkCloseoutItem, reopenAfterRental, settleRentalBill,
  setOrgRestriction, rentalConflictScope, allOrgCreditProfiles,
} from './rental.js';
import { buildStateView, sanitizeSessionDetail, visibleConflictsFor } from './views.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4000);

const app = express();
app.use(express.json({ limit: '1mb' }));

// 简单 token（内存态；重启后重新登录即可）
const tokens = new Map<string, string>(); // token -> userId
let tokenSeq = 1;

function sanitizeUser(u: User) {
  const { password, ...rest } = u;
  return rest;
}

function auth(req: express.Request, _res: express.Response, next: express.NextFunction) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const userId = token && tokens.get(token);
  const user = userId ? getDB().users.find((u) => u.id === userId) : undefined;
  if (!user) throw new HttpError(401, '未登录或登录已失效');
  (req as any).user = user;
  next();
}

function roles(...allowed: Role[]) {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const user = (req as any).user as User;
    if (!allowed.includes(user.role)) throw new HttpError(403, `仅 ${allowed.join('/')} 可操作`);
    next();
  };
}

const ok = (res: express.Response, data: unknown = { ok: true }) => res.json(data);

// ============ 健康检查 ============
app.get('/api/health', (_req, res) => {
  res.json({ status: 'healthy', time: new Date().toISOString() });
});

// ============ 鉴权 ============
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = getDB().users.find((u) => u.username === username);
  if (!user || user.password !== password) throw new HttpError(401, '用户名或密码错误');
  const token = `tok-${tokenSeq++}-${user.id}`;
  tokens.set(token, user.id);
  res.json({ user: sanitizeUser(user), token });
});

app.get('/api/me', auth, (req, res) => {
  const user = (req as any).user as User;
  res.json({ user: sanitizeUser(user), zoneConflicts: visibleConflictsFor(getDB(), user.role) });
});

// ============ 状态快照：服务端按会话用户角色裁剪，前端不做脱敏替代 ============
app.get('/api/state', auth, (req, res) => {
  const user = (req as any).user as User;
  res.json(buildStateView(getDB(), user));
});

// ============ 场次 ============
app.get('/api/sessions/:id', auth, (req, res) => {
  const user = (req as any).user as User;
  res.json(sanitizeSessionDetail(sessionDetail(getDB(), req.params.id), user, getDB()));
});

// ============ 预约 ============
app.post('/api/bookings', auth, roles('resident', 'ops', 'frontdesk'), (req, res) => {
  const user = (req as any).user as User;
  const result = mutate((db) => createBooking(db, user.id, req.body));
  res.status(201).json(result);
});

app.post('/api/bookings/:id/cancel', auth, (req, res) => {
  const user = (req as any).user as User;
  const result = mutate((db) => {
    const b = db.bookings.find((x) => x.id === req.params.id);
    if (!b) throw new HttpError(404, '预约不存在');
    if (b.userId !== user.id && user.role !== 'ops') throw new HttpError(403, '只能取消本人预约');
    if (b.status !== 'booked') throw new HttpError(409, '仅待入场预约可取消');
    // 原路退回
    if (b.paidAmount > 0) {
      const u = db.users.find((x) => x.id === b.userId)!;
      if (b.paymentMethod === 'wallet') {
        u.walletBalance = (u.walletBalance ?? 0) + b.paidAmount;
        db.walletTxns.unshift({ id: nextId('tx'), at: new Date().toISOString(), userId: u.id, amount: b.paidAmount, reason: `取消预约 ${b.code} 退费`, sessionId: b.sessionId });
      }
      if (b.paymentMethod === 'voucher') u.compVouchers = (u.compVouchers ?? 0) + 1;
    }
    b.status = 'cancelled';
    return b;
  });
  res.json(result);
});

// ============ 前台核验 ============
app.post('/api/bookings/:id/checkin', auth, roles('frontdesk', 'ops'), (req, res) => {
  const user = (req as any).user as User;
  const b = mutate((db) => checkIn(db, req.params.id, user.name, req.body));
  res.json(b);
});

// ============ 水质 ============
app.post('/api/water', auth, roles('lifeguard', 'maintenance', 'ops'), (req, res) => {
  const user = (req as any).user as User;
  const reading = mutate((db) => addWaterReading(db, user.name, req.body));
  res.status(201).json(reading);
});

// ============ 巡查 ============
app.post('/api/issues', auth, roles('ops', 'lifeguard', 'cleaner', 'maintenance', 'frontdesk'), (req, res) => {
  const user = (req as any).user as User;
  const issue = mutate((db) => addPatrolIssue(db, user.name, req.body));
  res.status(201).json(issue);
});

app.post('/api/issues/:id/resolve', auth, roles('ops', 'lifeguard', 'cleaner', 'maintenance', 'frontdesk'), (req, res) => {
  const user = (req as any).user as User;
  const issue = mutate((db) => {
    const p = db.patrolIssues.find((x) => x.id === req.params.id);
    if (!p) throw new HttpError(404, '巡查记录不存在');
    p.status = 'resolved';
    p.resolution = req.body?.resolution || '已现场处理';
    p.resolvedAt = new Date().toISOString();
    p.assigneeName = p.assigneeName || user.name;
    return p;
  });
  res.json(issue);
});

// ============ 事件协同 ============
app.post('/api/incidents', auth, roles('frontdesk', 'lifeguard', 'cleaner', 'maintenance', 'ops'), (req, res) => {
  const user = (req as any).user as User;
  const incident = mutate((db) => openIncident(db, req.body.sessionId, req.body.type, req.body.title, req.body.description || '（无补充说明）', user.name, req.body.severity));
  res.status(201).json(incident);
});

app.post('/api/incidents/:id/action', auth, roles('frontdesk', 'lifeguard', 'cleaner', 'maintenance', 'ops'), (req, res) => {
  const user = (req as any).user as User;
  const incident = mutate((db) => {
    const inc = db.incidents.find((x) => x.id === req.params.id);
    if (!inc) throw new HttpError(404, '事件不存在');
    if (inc.status === 'resolved') throw new HttpError(409, '事件已关闭');
    inc.status = 'responding';
    inc.actions.push({ id: nextId(`ia`), at: new Date().toISOString(), by: user.name, byRole: user.role, content: String(req.body?.content || '').slice(0, 500) });
    return inc;
  });
  res.json(incident);
});

app.post('/api/incidents/:id/tasks/:taskId/done', auth, roles('frontdesk', 'lifeguard', 'cleaner', 'maintenance', 'ops'), (req, res) => {
  const user = (req as any).user as User;
  const incident = mutate((db) => {
    const inc = db.incidents.find((x) => x.id === req.params.id);
    if (!inc) throw new HttpError(404, '事件不存在');
    const task = inc.tasks.find((x) => x.id === req.params.taskId);
    if (!task) throw new HttpError(404, '处置任务不存在');
    if (task.role !== user.role && user.role !== 'ops') throw new HttpError(403, '该处置项由其他角色负责，运营可代填');
    task.done = true;
    task.doneBy = user.name;
    task.doneAt = new Date().toISOString();
    inc.actions.push({ id: nextId(`ia`), at: new Date().toISOString(), by: user.name, byRole: user.role, content: `完成处置：${task.content}` });
    return inc;
  });
  res.json(incident);
});

app.post('/api/incidents/:id/resolve', auth, roles('ops'), (req, res) => {
  const incident = mutate((db) => {
    const inc = db.incidents.find((x) => x.id === req.params.id);
    if (!inc) throw new HttpError(404, '事件不存在');
    const undone = inc.tasks.filter((t) => !t.done);
    if (undone.length && !req.body?.force) {
      throw new HttpError(409, `还有 ${undone.length} 项处置未完成：${undone.map((t) => t.content).join('；')}`);
    }
    inc.status = 'resolved';
    inc.resolvedAt = new Date().toISOString();
    inc.actions.push({ id: nextId(`ia`), at: new Date().toISOString(), by: (req as any).user.name, byRole: 'ops', content: req.body?.summary || '事件关闭，现场恢复正常' });
    return inc;
  });
  res.json(incident);
});

// ============ 闭池 / 限流 / 恢复 ============
app.post('/api/pool-status', auth, roles('ops'), (req, res) => {
  const user = (req as any).user as User;
  const result = mutate((db) => changePoolStatus(db, user.name, req.body));
  res.json(result);
});

// ============ 工单（保洁/维修/消毒） ============
app.post('/api/tasks', auth, roles('ops', 'frontdesk'), (req, res) => {
  const user = (req as any).user as User;
  const task = mutate((db) => {
    const wt: WorkTask = {
      id: nextId(`wt`),
      sessionId: req.body.sessionId,
      kind: req.body.kind,
      title: String(req.body.title || '').slice(0, 80),
      detail: String(req.body.detail || ''),
      zoneId: req.body.zoneId || 'all',
      assigneeRole: req.body.assigneeRole,
      status: 'pending',
      createdAt: new Date().toISOString(),
      source: 'routine',
    };
    if (!wt.title || !wt.assigneeRole) throw new HttpError(400, '标题与负责角色必填');
    db.workTasks.unshift(wt);
    return wt;
  });
  void user;
  res.status(201).json(task);
});

app.post('/api/tasks/:id/claim', auth, roles('cleaner', 'maintenance'), (req, res) => {
  const user = (req as any).user as User;
  const task = mutate((db) => {
    const t = db.workTasks.find((x) => x.id === req.params.id);
    if (!t) throw new HttpError(404, '工单不存在');
    if (t.assigneeRole !== user.role) throw new HttpError(403, '这不是您岗位的工单');
    t.status = 'in_progress';
    t.assigneeName = user.name;
    return t;
  });
  res.json(task);
});

app.post('/api/tasks/:id/done', auth, roles('cleaner', 'maintenance', 'ops'), (req, res) => {
  const user = (req as any).user as User;
  const task = mutate((db) => {
    const t = db.workTasks.find((x) => x.id === req.params.id);
    if (!t) throw new HttpError(404, '工单不存在');
    if (t.assigneeRole !== user.role && user.role !== 'ops') throw new HttpError(403, '非负责岗位');
    t.status = 'done';
    t.doneAt = new Date().toISOString();
    t.assigneeName = t.assigneeName || user.name;
    t.result = String(req.body?.result || '已完成');
    return t;
  });
  res.json(task);
});

// ============ 设备 ============
app.post('/api/equipment/:id', auth, roles('maintenance', 'ops'), (req, res) => {
  const eq = mutate((db) => {
    const e = db.equipment.find((x) => x.id === req.params.id);
    if (!e) throw new HttpError(404, '设备不存在');
    if (req.body.status) e.status = req.body.status as EquipmentStatus;
    if (typeof req.body.note === 'string') e.note = req.body.note;
    e.lastCheck = new Date().toISOString();
    return e;
  });
  res.json(eq);
});

// ============ 救生员站位 / 换岗 ============
app.post('/api/guards', auth, roles('lifeguard', 'ops'), (req, res) => {
  const user = (req as any).user as User;
  const duty = mutate((db) => {
    const session = db.sessions.find((s) => s.id === req.body.sessionId);
    if (!session) throw new HttpError(404, '场次不存在');
    if (session.poolStatus === 'closed') throw new HttpError(409, '场次已闭池，不能上哨');
    const existing = db.guardDuties.find((d) => d.sessionId === session.id && d.post === req.body.post && !d.end);
    if (existing) throw new HttpError(409, '该站位已有救生员在岗，请先安排换岗');
    const myActive = db.guardDuties.find((d) => d.guardUserId === user.id && !d.end && d.sessionId === session.id);
    if (myActive) throw new HttpError(409, '您已在其他站位在岗，请先下岗/换岗');
    const d = { id: nextId(`gd`), sessionId: session.id, guardUserId: user.id, post: req.body.post, start: new Date().toISOString() };
    db.guardDuties.unshift(d);
    return d;
  });
  res.status(201).json(duty);
});

app.post('/api/guards/:id/relief', auth, roles('lifeguard', 'ops'), (req, res) => {
  const result = mutate((db) => {
    const duty = db.guardDuties.find((d) => d.id === req.params.id);
    if (!duty) throw new HttpError(404, '站岗记录不存在');
    if (duty.end) throw new HttpError(409, '该岗已结束');
    duty.end = new Date().toISOString();
    duty.relief = String(req.body.relief || '').slice(0, 40) || '（接班人已到岗）';
    duty.note = req.body.note || duty.note;
    // 接班人自动上同一站位
    const reliefUser = db.users.find((u) => u.name === duty.relief && u.role === 'lifeguard');
    let newDutyId: string | undefined;
    if (reliefUser) {
      const nd = { id: nextId(`gd`), sessionId: duty.sessionId, guardUserId: reliefUser.id, post: duty.post, start: new Date().toISOString() };
      db.guardDuties.unshift(nd);
      newDutyId = nd.id;
    }
    return { duty, newDutyId };
  });
  res.json(result);
});

// ============ 抽筋救援记录（发现→救援→收尾三确认→站位调整→下一场关注→复盘培训排班） ============
app.post('/api/cramp-rescues', auth, roles('lifeguard', 'ops'), (req, res) => {
  const user = (req as any).user as User;
  const rescue = mutate((db) => createCrampRescue(db, user, req.body));
  res.status(201).json(rescue);
});

app.post('/api/cramp-rescues/:id/closure/:key', auth, roles('lifeguard', 'ops'), (req, res) => {
  const user = (req as any).user as User;
  const rescue = mutate((db) => confirmRescueClosure(db, user, req.params.id, req.params.key, req.body || {}));
  res.json(rescue);
});

app.post('/api/cramp-rescues/:id/adjust', auth, roles('lifeguard', 'ops'), (req, res) => {
  const user = (req as any).user as User;
  const result = mutate((db) => adjustRescuePost(db, user, req.params.id, req.body || {}));
  res.json(result);
});

app.post('/api/sessions/:id/focus-lanes/ack', auth, roles('lifeguard', 'ops'), (req, res) => {
  const user = (req as any).user as User;
  const focus = mutate((db) => acknowledgeFocusLane(db, user, req.params.id, {
    rescueId: String(req.body?.rescueId || ''), zoneId: req.body?.zoneId, lane: Number(req.body?.lane),
  }));
  res.json(focus);
});

app.post('/api/cramp-rescues/:id/review', auth, roles('ops'), (req, res) => {
  const user = (req as any).user as User;
  const result = mutate((db) => reviewCrampRescue(db, user, req.params.id, req.body || {}));
  res.json(result);
});

app.post('/api/guard-training/:id/done', auth, roles('lifeguard', 'ops'), (req, res) => {
  const user = (req as any).user as User;
  const item = mutate((db) => {
    const t = db.guardTraining.find((x) => x.id === req.params.id);
    if (!t) throw new HttpError(404, '培训项不存在');
    // 救生员只能登记本人参训（或面向全体）的培训项；运营可代确认
    if (user.role === 'lifeguard' && t.targetGuardNames.length > 0 && !t.targetGuardNames.includes(user.name))
      throw new HttpError(403, '该培训项不包含您，不能登记参训');
    return completeTraining(db, req.params.id, String(req.body?.result || '') || undefined);
  });
  res.json(item);
});

// ============ 机构包场与居民公益时段冲突协调 ============
// 申请前冲突范围预览（机构/运营）：日期时段、泳道泳区、更衣淋浴、储物柜、救生排班、已预约居民与特殊人群标注
app.post('/api/rentals/preview', auth, roles('resident', 'ops', 'frontdesk'), (req, res) => {
  const user = (req as any).user as User;
  const scope = mutate((db) => {
    if (user.memberTier !== 'institution' && user.role !== 'ops')
      throw new HttpError(403, '仅培训机构账号可预览包场冲突范围');
    return rentalConflictScope(db, {
      sessionId: String(req.body?.sessionId || ''),
      zoneId: req.body?.zoneId,
      lanes: Array.isArray(req.body?.lanes) ? req.body.lanes.map(Number) : undefined,
      partySize: Math.max(1, Number(req.body?.partySize) || 0),
      showerSeats: Number(req.body?.showerSeats) || 0,
      lockerCount: Number(req.body?.lockerCount) || 0,
      containsChildren: Number(req.body?.childCount) > 0,
    });
  });
  res.json(scope);
});

app.post('/api/rentals', auth, roles('resident', 'ops'), (req, res) => {
  const user = (req as any).user as User;
  const result = mutate((db) => applyRental(db, user, req.body));
  res.status(201).json(result);
});

app.post('/api/rentals/:id/qualify', auth, roles('ops'), (req, res) => {
  const user = (req as any).user as User;
  const rc = mutate((db) => qualifyRental(db, user, req.params.id, req.body));
  res.json(rc);
});

app.post('/api/rentals/:id/reject', auth, roles('ops'), (req, res) => {
  const user = (req as any).user as User;
  const rc = mutate((db) => rejectRental(db, user, req.params.id, String(req.body?.reason || '')));
  res.json(rc);
});

app.post('/api/rentals/:id/coordinate', auth, roles('ops'), (req, res) => {
  const user = (req as any).user as User;
  const rc = mutate((db) => coordinateRental(db, user, req.params.id, req.body));
  res.json(rc);
});

// 居民答复本人改约提议（同意=迁移+补偿到账；拒绝=保留原预约并压缩包场）
app.post('/api/rentals/:id/rebook/:bookingId', auth, roles('resident', 'ops'), (req, res) => {
  const user = (req as any).user as User;
  const rc = mutate((db) => answerRebook(db, user, req.params.id, req.params.bookingId,
    !!req.body?.accept, String(req.body?.note || '') || undefined));
  res.json(rc);
});

app.post('/api/rentals/:id/rebook/:bookingId/expire', auth, roles('ops'), (req, res) => {
  const user = (req as any).user as User;
  const rc = mutate((db) => expireRebook(db, user, req.params.id, req.params.bookingId));
  res.json(rc);
});

// 机构确认协调方案（费用五项拆分进入机构账单）
app.post('/api/rentals/:id/confirm', auth, roles('resident', 'ops'), (req, res) => {
  const user = (req as any).user as User;
  const rc = mutate((db) => orgConfirmRental(db, user, req.params.id, String(req.body?.note || '') || undefined));
  res.json(rc);
});

// 前台登记实际到场人数
app.post('/api/rentals/:id/actual-count', auth, roles('frontdesk', 'ops'), (req, res) => {
  const user = (req as any).user as User;
  const rc = mutate((db) => setActualCount(db, user, req.params.id, Number(req.body?.actualCount),
    String(req.body?.note || '') || undefined));
  res.json(rc);
});

// 包场当天分岗核验（前台名单/访客/保险；救生重新站位；保洁；维修）
app.post('/api/rentals/:id/day-check', auth, roles('frontdesk', 'lifeguard', 'cleaner', 'maintenance', 'ops'), (req, res) => {
  const user = (req as any).user as User;
  const rc = mutate((db) => checkDayItem(db, user, req.params.id, {
    key: String(req.body?.key || ''), done: req.body?.done !== false,
    note: req.body?.note, guardNames: Array.isArray(req.body?.guardNames) ? req.body.guardNames : undefined,
  }));
  res.json(rc);
});

app.post('/api/rentals/:id/start', auth, roles('frontdesk', 'ops'), (req, res) => {
  const user = (req as any).user as User;
  const rc = mutate((db) => startRental(db, user, req.params.id));
  res.json(rc);
});

// 现场违规（超人数/超时/占公益道/儿童脱陪/私自加人）→ 可暂停并通知运营、计入信用
app.post('/api/rentals/:id/violations', auth, roles('frontdesk', 'lifeguard', 'ops'), (req, res) => {
  const user = (req as any).user as User;
  const rc = mutate((db) => reportRentalViolation(db, user, req.params.id, {
    type: req.body?.type, description: String(req.body?.description || ''),
    actualCount: req.body?.actualCount ? Number(req.body.actualCount) : undefined,
    suspend: !!req.body?.suspend,
  }));
  res.status(201).json(rc);
});

app.post('/api/rentals/:id/violations/:vid/rectify', auth, roles('ops'), (req, res) => {
  const user = (req as any).user as User;
  const rc = mutate((db) => rectifyRentalViolation(db, user, req.params.id, req.params.vid,
    String(req.body?.note || '已现场整改')));
  res.json(rc);
});

// 包场结束清场恢复门禁（清场/清柜/复测/设备复位/救生巡查）
app.post('/api/rentals/:id/closeout', auth, roles('frontdesk', 'lifeguard', 'cleaner', 'maintenance', 'ops'), (req, res) => {
  const user = (req as any).user as User;
  const rc = mutate((db) => checkCloseoutItem(db, user, req.params.id, {
    key: String(req.body?.key || '') as 'cleared' | 'lockersCleared' | 'waterRetested' | 'equipmentReset' | 'guardPatrolConfirmed',
    done: req.body?.done !== false, note: req.body?.note,
    reading: req.body?.reading, waterReadingId: req.body?.waterReadingId,
  }));
  res.json(rc);
});

app.post('/api/rentals/:id/reopen', auth, roles('lifeguard', 'ops'), (req, res) => {
  const user = (req as any).user as User;
  const rc = mutate((db) => reopenAfterRental(db, user, req.params.id));
  res.json(rc);
});

app.post('/api/rentals/:id/settle', auth, roles('ops'), (req, res) => {
  const user = (req as any).user as User;
  const bill = mutate((db) => settleRentalBill(db, user, req.params.id, {
    paymentMethod: req.body?.paymentMethod, depositDeducted: Number(req.body?.depositDeducted) || 0,
    note: String(req.body?.note || '') || undefined,
  }));
  res.json(bill);
});

app.post('/api/orgs/:orgUserId/restriction', auth, roles('ops'), (req, res) => {
  const user = (req as any).user as User;
  const profile = mutate((db) => setOrgRestriction(db, user, req.params.orgUserId, {
    rentalRestricted: !!req.body?.rentalRestricted,
    requiredExtraLifeguards: Number(req.body?.requiredExtraLifeguards),
    depositMultiplier: Number(req.body?.depositMultiplier),
    note: String(req.body?.note || '') || undefined,
  }));
  res.json(profile);
});

// ============ 锁区（商业包场/教学道） ============
app.post('/api/locks', auth, roles('ops', 'frontdesk'), (req, res) => {
  const result = mutate((db) => {
    const session = db.sessions.find((s) => s.id === req.body.sessionId);
    if (!session) throw new HttpError(404, '场次不存在');
    const lock = {
      id: nextId(`lock`),
      zoneId: req.body.zoneId, lane: req.body.lane, reason: req.body.reason || 'private_event',
      title: String(req.body.title || ''), contactName: String(req.body.contactName || ''),
      contactPhone: String(req.body.contactPhone || ''), capacity: Number(req.body.capacity) || 0,
      isCommercial: !!req.body.isCommercial,
    };
    if (!lock.title || !lock.contactName) throw new HttpError(400, '锁区标题与联系人必填');
    session.locks.push(lock);
    return { lock, conflicts: lockConflicts(db, session, lock) };
  });
  res.status(201).json(result);
});

app.delete('/api/locks/:id', auth, roles('ops'), (req, res) => {
  mutate((db) => {
    for (const s of db.sessions) {
      const idx = s.locks.findIndex((l) => l.id === req.params.id);
      if (idx >= 0) {
        const removed = s.locks.splice(idx, 1)[0];
        const booking = db.bookings.find((b) => b.id === removed.bookingId && b.status === 'booked');
        if (booking) booking.status = 'cancelled';
        return;
      }
    }
    throw new HttpError(404, '锁区不存在');
  });
  ok(res);
});

// ============ 钱包 ============
app.post('/api/wallet/recharge', auth, roles('resident'), (req, res) => {
  const user = (req as any).user as User;
  const amount = Math.round(Number(req.body?.amount) * 100) / 100;
  if (!(amount >= 10) || amount > 5000) throw new HttpError(400, '充值金额需在 10-5000 元之间');
  mutate((db) => {
    const u = db.users.find((x) => x.id === user.id)!;
    u.walletBalance = Math.round(((u.walletBalance ?? 0) + amount) * 100) / 100;
    db.walletTxns.unshift({ id: nextId(`tx`), at: new Date().toISOString(), userId: u.id, amount, reason: '储值充值' });
  });
  ok(res);
});

// ============ 教练课 ============
app.post('/api/lessons/:id/enroll', auth, roles('resident'), (req, res) => {
  const user = (req as any).user as User;
  mutate((db) => {
    const ls = db.lessons.find((x) => x.id === req.params.id);
    if (!ls) throw new HttpError(404, '课程不存在');
    if (ls.studentIds.includes(user.id)) throw new HttpError(409, '您已报名该课程');
    if (ls.enrolled >= ls.capacity) throw new HttpError(409, '课程已满员');
    const u = db.users.find((x) => x.id === user.id)!;
    if ((u.walletBalance ?? 0) < ls.price) throw new HttpError(402, '余额不足，请先充值');
    u.walletBalance = (u.walletBalance ?? 0) - ls.price;
    ls.studentIds.push(u.id);
    ls.enrolled += 1;
    db.walletTxns.unshift({ id: nextId(`tx`), at: new Date().toISOString(), userId: u.id, amount: -ls.price, reason: `报名教练课：${ls.title}（${ls.coachName}）`, sessionId: ls.sessionId });
  });
  ok(res);
});

// ============ 投诉 ============
app.post('/api/complaints', auth, roles('resident'), (req, res) => {
  const user = (req as any).user as User;
  const c = mutate((db) => {
    if (!req.body?.content?.trim()) throw new HttpError(400, '投诉内容不能为空');
    const complaint = {
      id: nextId(`cp`), userId: user.id, at: new Date().toISOString(),
      category: req.body.category || '其他', content: String(req.body.content).slice(0, 500), status: 'open' as const,
    };
    db.complaints.unshift(complaint);
    return complaint;
  });
  res.status(201).json(c);
});

app.post('/api/complaints/:id/reply', auth, roles('ops'), (req, res) => {
  const user = (req as any).user as User;
  const c = mutate((db) => {
    const x = db.complaints.find((q) => q.id === req.params.id);
    if (!x) throw new HttpError(404, '投诉不存在');
    x.status = 'replied';
    x.reply = String(req.body?.reply || '').slice(0, 500);
    x.repliedAt = new Date().toISOString();
    return x;
  });
  void user;
  res.json(c);
});

// ============ 错误处理 ============
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
  } else {
    console.error(err);
    res.status(500).json({ error: err?.message || '服务器内部错误' });
  }
});

// ============ 静态前端（dist 由多阶段构建产出） ============
const distDir = join(__dirname, '../../dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => res.sendFile(join(distDir, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`🏊 社区泳池协同平台已启动: http://0.0.0.0:${PORT}`);
});
