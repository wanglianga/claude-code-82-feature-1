import { useState } from 'react';
import type {
  User, BookingKind, ZoneId, SwimLevel, Session,
} from '../../shared/types.js';
import type { AppState } from '../api.js';
import { useAction } from '../api.js';
import {
  Badge, Card, Empty, KIND_LABEL, SWIM_LEVEL_LABEL, TIER_LABEL,
  BOOKING_STATUS_LABEL, BOOKING_STATUS_BADGE, POOL_STATUS_BADGE, POOL_STATUS_LABEL,
  fmtDateTime, useNotify,
} from '../ui.js';
import { priceOf } from '../../shared/logic.js';
import { visibleNotifications } from '../components/notifications.js';
import { IncidentList } from '../components/incident.js';
import { ResidentRentalOffers } from '../components/rental.js';

type Props = { user: User; state: AppState; tab: string };

const KIND_OPTIONS: BookingKind[] = ['personal', 'parent_child', 'elder_morning', 'guest', 'group', 'coaching', 'institution_rental'];

function sessionOpen(s: Session) {
  return s.poolStatus !== 'closed';
}

function BookingForm({ user, state }: { user: User; state: AppState }) {
  const act = useAction();
  const notify = useNotify();
  const [sessionId, setSessionId] = useState(state.sessions[1]?.id ?? state.sessions[0].id);
  const [kind, setKind] = useState<BookingKind>('personal');
  const [zoneId, setZoneId] = useState<ZoneId>('training');
  const [lane, setLane] = useState<number | undefined>(3);
  const [age, setAge] = useState(user.age ?? 30);
  const [pledge, setPledge] = useState(false);
  const [healthCode, setHealthCode] = useState<'green' | 'expired' | 'none'>('green');
  const [medicalCert, setMedicalCert] = useState(false);
  const [withChildren, setWithChildren] = useState(false);
  const [childCount, setChildCount] = useState(1);
  const [companion, setCompanion] = useState(user.name);
  const [companionPhone, setCompanionPhone] = useState(user.phone ?? '');
  const [level, setLevel] = useState<SwimLevel>('beginner');
  const [partySize, setPartySize] = useState(10);
  const [orgName, setOrgName] = useState('蓝鲸游泳培训');
  const [contactName, setContactName] = useState(user.name);
  const [contactPhone, setContactPhone] = useState(user.phone ?? '');
  const [pay, setPay] = useState<'wallet' | 'cash' | 'voucher'>('wallet');
  const [result, setResult] = useState<{ overCapacity?: boolean; conflictWarnings?: string[]; code?: string } | null>(null);

  const session = state.sessions.find((s) => s.id === sessionId)!;
  const board = state.boards.find((b) => b.session.id === sessionId)!;
  const zoneStat = board.zones.find((z) => z.zoneId === zoneId)!;
  const zone = state.zones.find((z) => z.id === zoneId)!;
  const isPC = kind === 'parent_child';
  const isGroup = kind === 'group' || kind === 'institution_rental';
  const size = kind === 'parent_child' ? 1 + childCount : isGroup ? partySize : 1;
  const price = priceOf(kind, size, childCount);

  const submit = () => {
    const body = {
      kind, sessionId, zoneId, lane: kind === 'personal' || kind === 'coaching' ? lane : undefined,
      age, healthPledge: pledge, healthCode, medicalCert,
      withChildren: isPC, childCount: isPC ? childCount : 0,
      childCompanion: isPC ? companion : undefined, childCompanionPhone: isPC ? companionPhone : undefined,
      swimLevel: level, partySize: isGroup ? partySize : undefined,
      childrenInParty: isPC ? childCount : undefined,
      orgName: kind === 'institution_rental' ? orgName : undefined,
      contactName: isGroup ? contactName : undefined, contactPhone: isGroup ? contactPhone : undefined,
      paymentMethod: price > 0 ? pay : undefined,
    };
    act.mutateAsync({ path: '/bookings', body }).then((r: any) => {
      notify.ok(`预约成功：${r.booking.code}${r.overCapacity ? '（已触发超额预警）' : ''}`);
      setResult({ overCapacity: r.overCapacity, conflictWarnings: r.conflictWarnings, code: r.booking.code });
    }).catch((e) => notify.err(e));
  };

  return (
    <div className="grid cols-2">
      <Card title="填写预约信息">
        <div className="form-row">
          <label className="field">入场场次
            <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
              {state.sessions.map((s) => (
                <option key={s.id} value={s.id} disabled={!sessionOpen(s)}>
                  {s.label}{s.publicWelfare ? '（公益）' : ''}{s.poolStatus !== 'normal' ? `·${POOL_STATUS_LABEL[s.poolStatus]}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="field">预约类型
            <select value={kind} onChange={(e) => setKind(e.target.value as BookingKind)}>
              {KIND_OPTIONS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
          </label>
        </div>
        <div style={{ height: 10 }} />
        <div className="form-row">
          <label className="field">泳区
            <select value={zoneId} onChange={(e) => setZoneId(e.target.value as ZoneId)}>
              {state.zones.map((z) => <option key={z.id} value={z.id}>{z.name}（容量 {z.capacity}·风险 {z.risk === 'high' ? '高' : z.risk === 'medium' ? '中' : '低'}{z.requireCert ? '·需深水证' : ''}）</option>)}
            </select>
          </label>
          {(kind === 'personal' || kind === 'coaching') && (
            <label className="field">泳道
              <select value={lane} onChange={(e) => setLane(Number(e.target.value))}>
                {[1, 2, 3, 4, 5, 6].map((n) => {
                  const suspended = board.suspendedLanes.find((l) => l.zoneId === zoneId && l.lane === n);
                  return <option key={n} value={n} disabled={!!suspended}>{n} 号道{suspended ? '（临时关闭）' : ''}</option>;
                })}
              </select>
            </label>
          )}
        </div>

        {zone.requireCert && (
          <div className="alert warn">深水区需深水合格证：{user.deepCert ? '您已持证，可以预约。' : '您尚未持证，预约将被系统拒绝，可先到前台进行 200 米测试。'}</div>
        )}

        <div style={{ height: 10 }} />
        <div className="form-row">
          <label className="field">年龄 <input type="number" value={age} onChange={(e) => setAge(Number(e.target.value))} /></label>
          <label className="field">游泳水平
            <select value={level} onChange={(e) => setLevel(e.target.value as SwimLevel)}>
              {Object.entries(SWIM_LEVEL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
        </div>
        <div style={{ height: 10 }} />
        <label className="checkbox">
          <input type="checkbox" checked={pledge} onChange={(e) => setPledge(e.target.checked)} />
          <span><b>健康承诺</b>：本人确认无心脏病、高血压、皮肤病、传染性疾病等不适宜游泳的情形，饮酒后不下水，如实填报健康信息。</span>
        </label>
        <div style={{ height: 8 }} />
        <div className="form-row">
          <label className="field">健康码状态
            <select value={healthCode} onChange={(e) => setHealthCode(e.target.value as any)}>
              <option value="green">绿码</option>
              <option value="expired">已过期</option>
              <option value="none">未携带/无</option>
            </select>
          </label>
          <label className="checkbox" style={{ alignSelf: 'flex-end', paddingBottom: 9 }}>
            <input type="checkbox" checked={medicalCert} onChange={(e) => setMedicalCert(e.target.checked)} />
            持有一年内体检证明
          </label>
        </div>

        {isPC && (
          <>
            <h4>儿童信息（亲子时段需登记陪同人）</h4>
            <div className="form-row">
              <label className="field">儿童人数 <input type="number" min={1} max={4} value={childCount} onChange={(e) => setChildCount(Math.max(1, Number(e.target.value)))} /></label>
              <label className="field">陪同人姓名 <input value={companion} onChange={(e) => setCompanion(e.target.value)} /></label>
            </div>
            <div style={{ height: 10 }} />
            <label className="field">陪同人联系电话 <input value={companionPhone} onChange={(e) => setCompanionPhone(e.target.value)} placeholder="儿童离开陪同人时用于广播联系" /></label>
          </>
        )}

        {isGroup && (
          <>
            <h4>{kind === 'institution_rental' ? '机构包场信息' : '团体预约信息'}</h4>
            <div className="form-row">
              <label className="field">总人数（含儿童） <input type="number" min={1} value={partySize} onChange={(e) => setPartySize(Number(e.target.value))} /></label>
              <label className="field">联系人 <input value={contactName} onChange={(e) => setContactName(e.target.value)} /></label>
            </div>
            <div style={{ height: 10 }} />
            <div className="form-row">
              <label className="field">联系电话 <input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} /></label>
              {kind === 'institution_rental' && <label className="field">机构名称 <input value={orgName} onChange={(e) => setOrgName(e.target.value)} /></label>}
            </div>
          </>
        )}

        <div style={{ height: 14 }} />
        <div className="flex">
          <div style={{ fontSize: 18 }}>费用：<b className="code-mono" style={{ color: price === 0 ? 'var(--ok)' : 'var(--deep)' }}>{price === 0 ? '公益免费' : `¥${price}`}</b></div>
          {price > 0 && (
            <select style={{ width: 150 }} value={pay} onChange={(e) => setPay(e.target.value as any)}>
              <option value="wallet">储值余额（¥{user.walletBalance?.toFixed(0)}）</option>
              <option value="voucher">补偿券（{user.compVouchers} 张）</option>
              <option value="cash">现场支付</option>
            </select>
          )}
          <span className="spacer" />
          <button className="btn" onClick={submit} disabled={!pledge || act.isPending || !sessionOpen(session)}>
            {sessionOpen(session) ? '提交预约' : '本场已闭池'}
          </button>
        </div>
        {result && (
          <div className={`alert ${result.overCapacity || result.conflictWarnings?.length ? 'warn' : 'ok'}`} style={{ marginTop: 12 }}>
            预约 {result.code} 已生成。
            {result.overCapacity && ' ⚠️ 该泳区预约量超出容量，前台已收到超额预警，现场可能需要候补/分流，无法入场将自动退费并补偿。'}
            {result.conflictWarnings?.map((m, i) => <div key={i}>⚖️ {m}</div>)}
          </div>
        )}
      </Card>

      <div className="grid">
        <Card title={`${session.label} · 各泳区实况`} extra={<Badge tone={POOL_STATUS_BADGE[session.poolStatus]}>{POOL_STATUS_LABEL[session.poolStatus]}</Badge>}>
          {board.zones.map((z) => (
            <div key={z.zoneId} className={`zone-card ${z.zoneId === 'deep' ? 'risk-high' : ''}`}
              onClick={() => setZoneId(z.zoneId)} role="button"
              style={{ marginBottom: 10, outline: z.zoneId === zoneId ? '2px solid var(--aqua)' : undefined, cursor: 'pointer' }}>
              <div className="zone-head">
                <b>{z.name}{z.deepCertRequired && <span className="badge danger" style={{ marginLeft: 6 }}>深水证</span>}</b>
                <span className="small muted">在池 {z.inPool} / 可用 {z.capacity - z.locked}{z.locked > 0 && `（商业锁定 ${z.locked}）`}</span>
              </div>
              <div className="meter"><i className={z.occupancyPct > 85 ? 'hot' : ''} style={{ width: `${Math.min(100, z.occupancyPct)}%` }} /></div>
              <div className="small muted">待入场 {z.booked} 人{z.children > 0 && ` · 在场儿童 ${z.children}`} · 占用率 {z.occupancyPct}%</div>
              {z.zoneId === 'family' && <div className="small" style={{ color: 'var(--warn)' }}>14 岁以下须成人一对一陪同</div>}
            </div>
          ))}
        </Card>
        <Card title="泳区规则与风险提示">
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {zone.rules.map((r) => <li key={r} style={{ margin: '4px 0' }}>{r}</li>)}
          </ul>
          <div className="small muted" style={{ marginTop: 8 }}>
            风险等级：{zone.risk === 'high' ? '高（深水区，凭证入场）' : zone.risk === 'medium' ? '中' : '低'}；容量 {zone.capacity} 人。
          </div>
        </Card>
      </div>
    </div>
  );
}

function MyBookings({ user, state }: Props) {
  const act = useAction();
  const notify = useNotify();
  const mine = state.bookings.filter((b) => b.userId === user.id);
  const txns = state.walletTxns.filter((t) => t.userId === user.id);
  const [amount, setAmount] = useState(100);

  return (
    <div className="grid">
      <ResidentRentalOffers user={user} state={state} />
      <div className="grid cols-2">
      <Card title="我的预约">
        {mine.length === 0 ? <Empty text="还没有预约，去「预约入场」下单吧" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>预约码</th><th>场次/泳区</th><th>类型</th><th>金额</th><th>状态</th><th>储物柜</th><th></th></tr></thead>
              <tbody>
                {mine.map((b) => {
                  const s = state.sessions.find((x) => x.id === b.sessionId);
                  const z = state.zones.find((x) => x.id === b.zoneId);
                  return (
                    <tr key={b.id}>
                      <td className="code-mono">{b.code}</td>
                      <td>{s?.label}{b.status === 'postponed' && b.postponeToSessionId && (() => {
                        const nb = state.bookings.find((x) => x.id === b.postponedBookingId);
                        return (
                          <div className="small" style={{ color: 'var(--warn)' }}>
                            顺延至 {state.sessions.find((x) => x.id === b.postponeToSessionId)?.label}
                            {nb ? `（新预约 ${nb.code}，可正常核验）` : ''}
                          </div>
                        );
                      })()}<div className="small muted">{z?.name}{b.lane ? ` · ${b.lane}号道` : ''}</div></td>
                      <td>{KIND_LABEL[b.kind]}</td>
                      <td>{b.paidAmount === 0 ? '免费' : `¥${b.paidAmount}`}</td>
                      <td><Badge tone={BOOKING_STATUS_BADGE[b.status]}>{BOOKING_STATUS_LABEL[b.status]}</Badge></td>
                      <td>{b.lockerNo ?? '—'}</td>
                      <td>{b.status === 'booked' && <button className="btn sm ghost" disabled={act.isPending}
                        onClick={() => act.mutateAsync({ path: `/bookings/${b.id}/cancel` }).then(() => notify.ok('已取消并原路退费')).catch((e) => notify.err(e))}>取消</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid">
        <Card title="会员钱包">
          <div className="grid cols-3">
            <div className="stat accent"><span className="num">¥{(user.walletBalance ?? 0).toFixed(0)}</span><span className="lbl">储值余额</span></div>
            <div className="stat"><span className="num">{user.compVouchers ?? 0}</span><span className="lbl">补偿券</span></div>
            <div className="stat"><span className="num">{TIER_LABEL[user.memberTier ?? 'normal']}</span><span className="lbl">会员身份</span></div>
          </div>
          <div className="flex" style={{ marginTop: 12 }}>
            <select value={amount} onChange={(e) => setAmount(Number(e.target.value))} style={{ width: 130 }}>
              {[50, 100, 200, 500, 1000].map((v) => <option key={v} value={v}>充 ¥{v}</option>)}
            </select>
            <button className="btn sm" disabled={act.isPending}
              onClick={() => act.mutateAsync({ path: '/wallet/recharge', body: { amount } }).then(() => notify.ok(`已充值 ¥${amount}`)).catch((e) => notify.err(e))}>
              储值充值
            </button>
            <span className="small muted">闭池退费用原路退回本钱包，另发补偿券</span>
          </div>
          <h4>收支流水</h4>
          {txns.length === 0 ? <Empty text="暂无流水" /> : (
            <div className="table-wrap"><table><thead><tr><th>时间</th><th>说明</th><th>金额</th></tr></thead>
              <tbody>{txns.map((t) => (
                <tr key={t.id}><td className="small">{fmtDateTime(t.at)}</td><td className="small">{t.reason}</td>
                  <td style={{ color: t.amount > 0 ? 'var(--ok)' : 'var(--danger)', fontWeight: 700 }}>{t.amount > 0 ? '+' : ''}{t.amount}</td></tr>
              ))}</tbody></table></div>
          )}
        </Card>
      </div>
      </div>
    </div>
  );
}

function Lessons({ user, state }: Props) {
  const act = useAction();
  const notify = useNotify();
  return (
    <div className="grid cols-2">
      {state.lessons.map((l) => {
        const s = state.sessions.find((x) => x.id === l.sessionId)!;
        const z = state.zones.find((x) => x.id === l.zoneId)!;
        const enrolled = l.studentIds.includes(user.id);
        const full = l.enrolled >= l.capacity;
        return (
          <Card key={l.id} title={`${l.title} · ${l.coachName}`} extra={<Badge tone={full ? 'danger' : 'ok'}>{l.enrolled}/{l.capacity} 人</Badge>}>
            <dl className="kv">
              <dt>时间场次</dt><dd>{s.label}{l.postponed && (
                <span className="badge warn" style={{ marginLeft: 6 }}>已自 {state.sessions.find((x) => x.id === l.postponed?.fromSessionId)?.label} 顺延</span>
              )}</dd>
              <dt>地点</dt><dd>{z.name} · {l.lane > 0 ? `${l.lane} 号教学道` : '教学专区'}</dd>
              <dt>费用</dt><dd className="code-mono">¥{l.price} / 节（储值扣款）</dd>
            </dl>
            <div style={{ marginTop: 12 }}>
              {enrolled ? <Badge tone="ok">已报名，开场前到教学道集合</Badge>
                : <button className="btn" disabled={full || act.isPending}
                  onClick={() => act.mutateAsync({ path: `/lessons/${l.id}/enroll` }).then(() => notify.ok('报名成功，已从钱包扣费')).catch((e) => notify.err(e))}>
                  {full ? '已满员' : '报名（占用教学道名额）'}
                </button>}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function NoticeComplaint({ user, state }: Props) {
  const act = useAction();
  const notify = useNotify();
  const [category, setCategory] = useState<'水质' | '拥挤' | '救生服务' | '储物柜' | '教练课' | '卫生' | '其他'>('拥挤');
  const [content, setContent] = useState('');
  const notes = visibleNotifications(user, state.notifications).filter((n) => n.roles.length === 0 || n.userId === user.id);
  const mine = state.complaints.filter((c) => c.userId === user.id);

  return (
    <div className="grid cols-2">
      <Card title="泳池通告">
        {notes.length === 0 ? <Empty text="暂无通告" /> : notes.slice(0, 12).map((n) => (
          <div key={n.id} className={`notif ${n.level}`}>
            <div className="flex"><b>{n.title}</b><span className="spacer" /><span className="nt">{fmtDateTime(n.at)}</span></div>
            <div className="small" style={{ marginTop: 3 }}>{n.body}</div>
          </div>
        ))}
      </Card>
      <div className="grid">
        <Card title="我要投诉 / 建议">
          <label className="field">类别
            <select value={category} onChange={(e) => setCategory(e.target.value as any)}>
              {['水质', '拥挤', '救生服务', '储物柜', '教练课', '卫生', '其他'].map((c) => <option key={c}>{c}</option>)}
            </select>
          </label>
          <div style={{ height: 10 }} />
          <label className="field">内容<textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="例如：晚高峰儿童区拥挤、淋浴排队…" /></label>
          <div style={{ height: 10 }} />
          <button className="btn" disabled={!content.trim() || act.isPending}
            onClick={() => act.mutateAsync({ path: '/complaints', body: { category, content } }).then(() => { notify.ok('已提交，运营将回复'); setContent(''); }).catch((e) => notify.err(e))}>
            提交投诉
          </button>
        </Card>
        <Card title="我的投诉记录">
          {mine.length === 0 ? <Empty text="暂无投诉" /> : mine.map((c) => (
            <div key={c.id} className="notif info">
              <div className="flex"><b>[{c.category}]</b><span className="spacer" /><Badge tone={c.status === 'replied' ? 'ok' : 'warn'}>{c.status === 'replied' ? '已回复' : '处理中'}</Badge></div>
              <div className="small">{c.content}</div>
              {c.reply && <div className="small" style={{ marginTop: 6, padding: 8, background: 'var(--ok-bg)', borderRadius: 8 }}>运营回复：{c.reply}</div>}
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

export function ResidentPage(props: Props) {
  if (props.tab === 'book') return <BookingForm user={props.user} state={props.state} />;
  if (props.tab === 'mine') return MyBookings(props);
  if (props.tab === 'lesson') return Lessons(props);
  return NoticeComplaint(props);
}
