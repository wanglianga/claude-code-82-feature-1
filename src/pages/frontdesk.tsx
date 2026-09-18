import { useMemo, useState } from 'react';
import type { User, Booking } from '../../shared/types.js';
import type { AppState } from '../api.js';
import { useAction } from '../api.js';
import {
  Badge, Card, Empty, KIND_LABEL, TIER_LABEL, SWIM_LEVEL_LABEL,
  BOOKING_STATUS_LABEL, BOOKING_STATUS_BADGE, fmtDateTime, useNotify,
} from '../ui.js';
import { SessionPicker, PoolStatusBanner } from '../components/common.js';
import { IncidentList, IncidentCreateForm } from '../components/incident.js';
import { visibleNotifications } from '../components/notifications.js';
import { RentalFrontline } from '../components/rental-frontline.js';

type Props = { user: User; state: AppState; tab: string };

function userName(state: AppState, id: string) {
  return state.users.find((u) => u.id === id);
}

/** 现场抽筋救援动态：前台据此联系陪同人/家属、拨打 120、取 AED，并掌握临停泳道 */
function RescueStrip({ state, sessionId }: { state: AppState; sessionId: string }) {
  const rescues = state.crampRescues.filter((r) => r.sessionId === sessionId)
    .filter((r) => r.laneSuspended || !r.reviewedAt);
  if (rescues.length === 0) return null;
  const zoneName = (z: string) => state.zones.find((x) => x.id === z)?.name ?? z;
  return (
    <div style={{ marginBottom: 12 }}>
      {rescues.map((r) => (
        <div key={r.id} className={`alert ${r.medicalAdvised ? 'danger' : 'warn'}`} style={{ marginBottom: 6 }}>
          <div className="flex">
            <b>🆘 抽筋救援 {r.code}：{zoneName(r.zoneId)} {r.lane} 号道</b>
            <span className="spacer" />
            {r.familyContacted ? <Badge tone="ok">家属已联系</Badge> : <Badge tone="warn">待联系家属/陪同人</Badge>}
            {r.medicalAdvised ? <Badge tone="danger">已建议就医/呼叫 120</Badge> : <Badge tone="gray">未建议就医</Badge>}
            {r.laneSuspended ? <Badge tone="danger">泳道临停</Badge> : <Badge tone="ok">泳道已恢复</Badge>}
          </div>
          <div className="small muted" style={{ marginTop: 4 }}>
            {fmtDateTime(r.foundAt)} 发现 · 救生员 {r.guardName} · {r.patronDesc}
            {r.familyNote ? ` · 家属：${r.familyNote}` : ''}
          </div>
        </div>
      ))}
    </div>
  );
}

function CheckInDesk({ user, state }: Props) {
  const act = useAction();
  const notify = useNotify();
  const [sessionId, setSessionId] = useState(state.boards[1]?.session.id ?? state.boards[0].session.id);
  const [selected, setSelected] = useState<string | null>(null);
  const [healthCode, setHealthCode] = useState<'green' | 'expired' | 'none'>('green');
  const [medicalCert, setMedicalCert] = useState(false);
  const [companion, setCompanion] = useState('');
  const [companionPhone, setCompanionPhone] = useState('');
  const [locker, setLocker] = useState('');

  const session = state.sessions.find((s) => s.id === sessionId)!;
  const queue = state.bookings.filter((b) => b.sessionId === sessionId && b.status === 'booked');
  const inside = state.bookings.filter((b) => b.sessionId === sessionId && b.status === 'checked_in');
  const board = state.boards.find((b) => b.session.id === sessionId)!;

  const usedLockers = new Set(inside.map((b) => b.lockerNo).filter(Boolean));
  const suggestLocker = () => {
    for (let i = 1; i <= 60; i++) {
      const no = `A${String(i).padStart(2, '0')}`;
      if (!usedLockers.has(no)) return no;
    }
    return '';
  };

  const pick = (b: Booking) => {
    setSelected(b.id);
    setHealthCode(b.healthCode === 'expired' ? 'expired' : 'green');
    setMedicalCert(!!b.medicalCert);
    setCompanion(b.childCompanion ?? userName(state, b.userId)?.name ?? '');
    setCompanionPhone(b.childCompanionPhone ?? userName(state, b.userId)?.phone ?? '');
    setLocker(suggestLocker());
  };

  const current = queue.find((b) => b.id === selected);

  const confirm = () => {
    if (!current) return;
    act.mutateAsync({
      path: `/bookings/${current.id}/checkin`,
      body: { healthCode, medicalCert, childCompanion: companion, childCompanionPhone: companionPhone, lockerNo: locker },
    }).then(() => {
      notify.ok(`${current.code} 核验通过，已放行并分配储物柜 ${locker}`);
      setSelected(null);
    }).catch((e) => notify.err(e));
  };

  return (
    <div>
      <SessionPicker sessions={state.sessions} value={sessionId} onChange={(v) => { setSessionId(v); setSelected(null); }} />
      <PoolStatusBanner status={session.poolStatus} reason={session.statusReason} requireRetest={session.requireWaterRetest} closedAt={session.closedAt} reopenedAt={session.reopenedAt} />

      <RescueStrip state={state} sessionId={sessionId} />

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        {board.zones.map((z) => (
          <Card key={z.zoneId}>
            <div className="zone-head"><b>{z.name}</b>{z.deepCertRequired && <Badge tone="danger">深水证</Badge>}</div>
            <div className="stat accent"><span className="num">{z.inPool}<span className="small muted" style={{ fontSize: 13 }}>/{z.capacity - z.locked}</span></span><span className="lbl">在池 / 可用</span></div>
            <div className="small muted" style={{ marginTop: 4 }}>待核验 {z.booked} 人{z.children > 0 && ` · 儿童 ${z.children}`}</div>
          </Card>
        ))}
      </div>

      <div className="grid cols-2">
        <Card title={`待核验队列（${queue.length}）`} extra={<Badge tone="info">扫码/报码核验</Badge>}>
          {queue.length === 0 ? <Empty text="本场没有待入场预约" /> : queue.map((b) => {
            const u = userName(state, b.userId);
            return (
              <div key={b.id} className={`queue-row ${selected === b.id ? 'is-sel' : ''}`}
                style={{ ...(selected === b.id ? { background: 'var(--aqua-soft)', borderRadius: 10, padding: 10 } : {}) }}>
                <div>
                  <div className="flex">
                    <b className="code-mono">{b.code}</b>
                    <Badge tone="info">{KIND_LABEL[b.kind]}</Badge>
                    {b.healthCode === 'green' ? <Badge tone="ok">申报绿码</Badge> : <Badge tone="warn">健康码待核</Badge>}
                    {b.withChildren && <Badge tone="purple">带儿童 ×{b.childCount}</Badge>}
                  </div>
                  <div className="small muted" style={{ marginTop: 3 }}>
                    {u?.name}（{TIER_LABEL[u?.memberTier ?? 'normal']}）· {b.age} 岁 · {SWIM_LEVEL_LABEL[b.swimLevel]}
                    {u?.deepCert ? ' · 持深水证' : ''} · {state.zones.find((z) => z.id === b.zoneId)?.name}{b.lane ? ` ${b.lane}号道` : ''} · {b.partySize} 人
                  </div>
                  <div className="small">{b.healthPledge ? '✅ 已签健康承诺' : '⚠️ 未签健康承诺'}</div>
                </div>
                <button className="btn sm" onClick={() => pick(b)}>核验</button>
              </div>
            );
          })}
        </Card>

        <Card title={current ? `核验入场 · ${current.code}` : '核验操作区'}>
          {!current ? <Empty text="请从左侧队列选择一位泳客" /> : (() => {
            const u = userName(state, current.userId);
            return (
              <div>
                <dl className="kv">
                  <dt>会员身份</dt><dd>{u?.name} · {TIER_LABEL[u?.memberTier ?? 'normal']}{u?.deepCert ? ' · 深水合格证 ✓' : ''}</dd>
                  <dt>年龄/水平</dt><dd>{current.age} 岁 · {SWIM_LEVEL_LABEL[current.swimLevel]}</dd>
                  <dt>预约区域</dt><dd>{state.zones.find((z) => z.id === current.zoneId)?.name}{current.lane ? ` · ${current.lane} 号道` : ''}</dd>
                  <dt>健康承诺</dt><dd>{current.healthPledge ? '已签署' : '未签署（不得入场）'}</dd>
                  {current.withChildren && <><dt>儿童</dt><dd>{current.childCount} 名，须一对一陪同</dd></>}
                </dl>
                <div style={{ height: 12 }} />
                <div className="form-row">
                  <label className="field">现场核验健康码
                    <select value={healthCode} onChange={(e) => setHealthCode(e.target.value as any)}>
                      <option value="green">绿码有效</option>
                      <option value="expired">已过期</option>
                      <option value="none">无法出示</option>
                    </select>
                  </label>
                  <label className="field">体检证明
                    <select value={medicalCert ? 'y' : 'n'} onChange={(e) => setMedicalCert(e.target.value === 'y')}>
                      <option value="y">已出示一年内体检证明</option>
                      <option value="n">未出示</option>
                    </select>
                  </label>
                </div>
                {(current.withChildren || (current.childrenInParty ?? 0) > 0) && (
                  <>
                    <div style={{ height: 10 }} />
                    <div className="form-row">
                      <label className="field">儿童陪同人<input value={companion} onChange={(e) => setCompanion(e.target.value)} /></label>
                      <label className="field">陪同人电话<input value={companionPhone} onChange={(e) => setCompanionPhone(e.target.value)} /></label>
                    </div>
                  </>
                )}
                <div style={{ height: 10 }} />
                <label className="field">储物柜号
                  <div className="flex"><input value={locker} onChange={(e) => setLocker(e.target.value)} placeholder="如 A12" />
                    <button type="button" className="btn ghost sm" onClick={() => setLocker(suggestLocker())}>自动分配</button></div>
                </label>
                {usedLockers.has(locker) && <div className="alert danger" style={{ marginTop: 8 }}>该储物柜已被占用，请更换或先发起储物柜纠纷事件。</div>}
                <div style={{ height: 14 }} />
                <div className="flex">
                  <button className="btn" disabled={act.isPending} onClick={confirm}>✅ 核验通过，放行入场</button>
                  <button className="btn ghost danger" disabled={act.isPending}
                    onClick={() => act.mutateAsync({ path: '/incidents', body: { sessionId, type: 'locker_dispute', description: `预约 ${current.code} 储物柜分配争议，泳客 ${u?.name}` } })
                      .then(() => notify.ok('储物柜纠纷已立案，维修/运营同步收到任务')).catch((e) => notify.err(e))}>
                    储物柜纠纷立案
                  </button>
                </div>
                <div className="small muted" style={{ marginTop: 8 }}>
                  非绿码、深水无证、容量超限、闭池/限流时系统将拒绝放行并给出原因。
                </div>
              </div>
            );
          })()}
        </Card>
      </div>

      <Card title={`在场泳客（${inside.length} 单 / ${board.totalInPool} 人）`} className="section-gap">
        {inside.length === 0 ? <Empty text="暂无在场泳客" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>预约码</th><th>泳客</th><th>类型</th><th>泳区</th><th>陪同人</th><th>储物柜</th><th>入场时间</th><th>核验人</th></tr></thead>
              <tbody>
                {inside.map((b) => {
                  const u = userName(state, b.userId);
                  return <tr key={b.id}>
                    <td className="code-mono">{b.code}</td>
                    <td>{u?.name}<div className="small muted">{u?.phone}</div></td>
                    <td>{KIND_LABEL[b.kind]}{b.partySize > 1 && ` ×${b.partySize}`}</td>
                    <td>{state.zones.find((z) => z.id === b.zoneId)?.name}{b.lane ? ` ${b.lane}号道` : ''}</td>
                    <td>{b.childCompanion ?? '—'}</td>
                    <td><b>{b.lockerNo}</b></td>
                    <td className="small">{fmtDateTime(b.checkedInAt)}</td>
                    <td className="small">{b.checkedInBy}</td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function IncidentTab({ user, state }: Props) {
  return (
    <div className="grid cols-2">
      <IncidentCreateForm sessions={state.sessions} defaultSessionId={state.boards[1]?.session.id} />
      <Card title="围绕同场次的协同事件">
        <IncidentList incidents={state.incidents} user={user} />
      </Card>
    </div>
  );
}

function NoticeTab({ user, state }: Props) {
  const list = visibleNotifications(user, state.notifications);
  return (
    <Card title="现场通告（与救生、保洁、维修、运营同源同步）">
      {list.length === 0 ? <Empty text="暂无通告" /> : list.map((n) => (
        <div key={n.id} className={`notif ${n.level}`}>
          <div className="flex"><b>{n.title}</b><span className="spacer" /><span className="nt">{fmtDateTime(n.at)}</span></div>
          <div className="small" style={{ marginTop: 3 }}>{n.body}</div>
        </div>
      ))}
    </Card>
  );
}

export function FrontdeskPage(props: Props) {
  if (props.tab === 'incident') return <IncidentTab {...props} />;
  if (props.tab === 'notice') return <NoticeTab {...props} />;
  if (props.tab === 'rental') return <RentalFrontline user={props.user} state={props.state} role="frontdesk" />;
  return <CheckInDesk {...props} />;
}
