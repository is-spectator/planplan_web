import { randomInt } from 'node:crypto';
import type { Queryable } from '../db/db.js';
import { formatYuan } from '../domain/money.js';
import { addDays, formatMonthDay, isoWeekday, nextWeek, weekDays, weekOf, type BizDate, type WeekKey } from '../domain/time.js';
import { fail } from './errors.js';
import type { RecordRow } from './repo.js';

// ───────────────────────── 规则 ─────────────────────────

/** 每天前几条新增记录各得 1 点行动力；之后正常保存，不再加分。 */
export const DAILY_CAP = 5;
export const CIRCLE_MAX = 20;
const CAPTION_MAX = 30;

export interface Choice {
  id: string;
  name: string;
  desc: string;
}

interface SlotDef {
  key: string;
  at: number;
  name: string;
  /** 回执里「再积累 N 点，就能…」 */
  goal: string;
  /** 解锁时的提示 */
  arrival: string;
  arrivalSub: string;
  choices: Choice[];
}

export const SLOTS: SlotDef[] = [
  { key: 'lamp', at: 1, name: '第一盏灯', goal: '点亮小屋的第一盏灯', arrival: '小屋亮灯了', arrivalSub: '你的第一条记录点亮了它', choices: [] },
  {
    key: 'desk', at: 5, name: '桌面摆件', goal: '选一件桌面摆件', arrival: '桌上可以放点东西了', arrivalSub: '挑一件，放到书桌上吧',
    choices: [
      { id: 'cat', name: '小猫', desc: '趴在桌上陪你' },
      { id: 'cup', name: '杯子', desc: '一直冒着热气' },
      { id: 'flower', name: '小花', desc: '插在小瓶里' },
    ],
  },
  {
    key: 'plant', at: 15, name: '一盆植物', goal: '带一盆植物回家', arrival: '你的第一盆植物到了', arrivalSub: '选一盆，放到窗边吧',
    choices: [
      { id: 'monstera', name: '龟背竹', desc: '叶子会慢慢长大' },
      { id: 'succulent', name: '多肉', desc: '小小一盆，不挑地方' },
      { id: 'pothos', name: '绿萝', desc: '藤蔓垂下来' },
    ],
  },
  { key: 'shelf', at: 30, name: '书架', goal: '解锁书架', arrival: '书架搬进来了', arrivalSub: '靠在墙边，慢慢放满它', choices: [] },
  { key: 'view', at: 60, name: '窗外风景', goal: '解锁窗外风景', arrival: '窗外有风景了', arrivalSub: '推开窗看看', choices: [] },
  {
    key: 'theme', at: 100, name: '新的房间主题', goal: '解锁新的房间主题', arrival: '小屋可以换个样子了', arrivalSub: '选一个你喜欢的主题',
    choices: [
      { id: 'warm', name: '暖阳', desc: '原来的米色小屋' },
      { id: 'dusk', name: '黄昏', desc: '傍晚的橘粉色' },
      { id: 'night', name: '夜晚', desc: '深蓝色，灯更亮' },
    ],
  },
];

export interface GrowthDelta {
  earned: number;
  total: number;
  unlocked: { key: string; name: string; arrival: string; arrivalSub: string; needsChoice: boolean }[];
  next: { key: string; at: number; need: number; goal: string } | null;
}

function nextSlot(total: number): GrowthDelta['next'] {
  const s = SLOTS.find((x) => x.at > total);
  return s ? { key: s.key, at: s.at, need: s.at - total, goal: s.goal } : null;
}

async function totalOf(q: Queryable, userId: string): Promise<number> {
  const [r] = await q.query<{ total: number }>(`SELECT COALESCE(SUM(points), 0)::int AS total FROM growth_points WHERE user_id = $1`, [userId]);
  return Number(r?.total ?? 0);
}

/** 解锁回忆只引用真实记录：哪个计划、记了什么。 */
function memoryOf(r: RecordRow, planName: string): string {
  const note = r.note.trim();
  if (r.kind === 'study') return `你在记录${planName}${note ? `「${note}」` : ''} ${r.minutes} 分钟时解锁了它。`;
  return `你在记下${note || r.category || '一笔支出'} ${formatYuan(r.amount_cents ?? 0)} 时解锁了它。`;
}

/**
 * 在新增记录的同一事务里发放行动力。只有新增的支出和学习记录计分；
 * 修改、退款、撤销不加分，已得的点数也不会因撤销而扣除。
 */
export async function awardForRecord(q: Queryable, r: RecordRow, planName: string, today: BizDate): Promise<{ earned: number; unlocked: string[] }> {
  if (r.kind !== 'expense' && r.kind !== 'study') return { earned: 0, unlocked: [] };
  const [c] = await q.query<{ n: number }>(`SELECT COALESCE(SUM(points), 0)::int AS n FROM growth_points WHERE user_id = $1 AND earned_on = $2`, [r.user_id, today]);
  const points = Number(c?.n ?? 0) < DAILY_CAP ? 1 : 0;
  const before = await totalOf(q, r.user_id);
  const awarded = await q.query(`INSERT INTO growth_points (record_id, user_id, earned_on, points) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING record_id`, [r.id, r.user_id, today, points]);
  if (!awarded.length) return { earned: 0, unlocked: [] };
  const after = before + points;
  const unlocked: string[] = [];
  for (const s of SLOTS) {
    if (s.at > before && s.at <= after) {
      // 没有可选项的物品直接摆好；有选项的等用户挑选。
      const variant = s.choices.length ? null : 'default';
      const ins = await q.query(`INSERT INTO house_items (user_id, slot, variant, unlocked_on, memory) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING slot`, [r.user_id, s.key, variant, today, memoryOf(r, planName)]);
      if (ins.length) unlocked.push(s.key);
    }
  }
  return { earned: points, unlocked };
}

export async function deltaOf(q: Queryable, userId: string, earned: number, unlockedKeys: string[]): Promise<GrowthDelta> {
  const total = await totalOf(q, userId);
  return {
    earned,
    total,
    unlocked: unlockedKeys.map((k) => {
      const s = SLOTS.find((x) => x.key === k)!;
      return { key: s.key, name: s.name, arrival: s.arrival, arrivalSub: s.arrivalSub, needsChoice: s.choices.length > 0 };
    }),
    next: nextSlot(total),
  };
}

// ───────────────────────── 小屋 ─────────────────────────

export interface HouseSlotView {
  key: string;
  at: number;
  name: string;
  unlocked: boolean;
  unlockedOn: BizDate | null;
  variant: string | null;
  variantName: string | null;
  needsChoice: boolean;
  choices: Choice[];
  memory: string | null;
  arrival: string;
  arrivalSub: string;
}

export interface WeekDays {
  week: WeekKey;
  days: boolean[];
  recordDays: number;
}

export interface GrowthView {
  total: number;
  todayEarned: number;
  dailyCap: number;
  next: GrowthDelta['next'];
  slots: HouseSlotView[];
  week: WeekDays;
  lastRecordOn: BizDate | null;
  circle: { name: string; recordDays: number; rank: number | null; members: number } | null;
}

async function recordDaysOf(q: Queryable, userIds: string[], week: WeekKey): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>(userIds.map((id) => [id, new Set<string>()]));
  if (!userIds.length) return out;
  const rows = await q.query<{ user_id: string; earned_on: string }>(
    `SELECT DISTINCT user_id, earned_on FROM growth_points WHERE user_id = ANY($1::uuid[]) AND earned_on >= $2 AND earned_on <= $3`,
    [userIds, week, addDays(week, 6)],
  );
  for (const r of rows) out.get(r.user_id)?.add(r.earned_on);
  return out;
}

export async function weekDaysOf(q: Queryable, userId: string, week: WeekKey): Promise<WeekDays> {
  const set = (await recordDaysOf(q, [userId], week)).get(userId)!;
  const days = weekDays(week).map((d) => set.has(d));
  return { week, days, recordDays: set.size };
}

export async function houseSlots(q: Queryable, userId: string): Promise<HouseSlotView[]> {
  const items = await q.query<{ slot: string; variant: string | null; unlocked_on: string; memory: string }>(`SELECT slot, variant, unlocked_on, memory FROM house_items WHERE user_id = $1`, [userId]);
  const byKey = new Map(items.map((i) => [i.slot, i]));
  return SLOTS.map((s) => {
    const it = byKey.get(s.key);
    const variant = it?.variant ?? null;
    return {
      key: s.key,
      at: s.at,
      name: s.name,
      unlocked: !!it,
      unlockedOn: it?.unlocked_on ?? null,
      variant,
      variantName: s.choices.find((c) => c.id === variant)?.name ?? null,
      needsChoice: !!it && s.choices.length > 0 && variant === null,
      choices: s.choices,
      memory: it?.memory ?? null,
      arrival: s.arrival,
      arrivalSub: s.arrivalSub,
    };
  });
}

export async function growthView(q: Queryable, userId: string, today: BizDate): Promise<GrowthView> {
  const total = await totalOf(q, userId);
  const [t] = await q.query<{ n: number }>(`SELECT COALESCE(SUM(points), 0)::int AS n FROM growth_points WHERE user_id = $1 AND earned_on = $2`, [userId, today]);
  const [last] = await q.query<{ d: string | null }>(`SELECT MAX(earned_on) AS d FROM growth_points WHERE user_id = $1`, [userId]);
  const board = await circleBoard(q, userId, today);
  const me = board?.members.find((m) => m.me);
  return {
    total,
    todayEarned: Number(t?.n ?? 0),
    dailyCap: DAILY_CAP,
    next: nextSlot(total),
    slots: await houseSlots(q, userId),
    week: await weekDaysOf(q, userId, weekOf(today)),
    lastRecordOn: last?.d ?? null,
    circle: board ? { name: board.name, recordDays: me?.recordDays ?? 0, rank: me?.rank ?? null, members: board.members.length } : null,
  };
}

/** 选择或更换已解锁物品的样式。 */
export async function chooseVariant(q: Queryable, userId: string, slot: string, variant: string): Promise<HouseSlotView[]> {
  const def = SLOTS.find((s) => s.key === slot) ?? fail('not_found', '没有这件物品。');
  if (!def.choices.some((c) => c.id === variant)) fail('invalid_input', '没有这个样式。');
  const r = await q.query(`UPDATE house_items SET variant = $3 WHERE user_id = $1 AND slot = $2 RETURNING slot`, [userId, slot, variant]);
  if (!r.length) fail('not_found', '这件物品还没有解锁。');
  return houseSlots(q, userId);
}

// ───────────────────────── 同行榜 ─────────────────────────

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface BoardMember {
  nickname: string;
  initial: string;
  color: number;
  recordDays: number;
  rank: number | null;
  me: boolean;
  /** 本周还不计入排名（新成员下个完整周入榜） */
  pendingFrom: WeekKey | null;
}

export interface CircleBoard {
  name: string;
  code: string;
  week: WeekKey;
  max: number;
  members: BoardMember[];
}

function cleanNickname(s: unknown): string {
  const n = typeof s === 'string' ? s.trim().replace(/\s+/g, ' ') : '';
  if (!n || [...n].length > 12) fail('invalid_input', '昵称需要 1 到 12 个字。');
  return n;
}

/** 周一加入，本周就是完整的一周；其他日子加入，从下周开始计入排名。 */
function eligibleFrom(today: BizDate): WeekKey {
  return isoWeekday(today) === 1 ? weekOf(today) : nextWeek(weekOf(today));
}

function colorOf(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % 6;
}

async function myCircleId(q: Queryable, userId: string): Promise<string | null> {
  const [m] = await q.query<{ circle_id: string }>(`SELECT circle_id FROM circle_members WHERE user_id = $1`, [userId]);
  return m?.circle_id ?? null;
}

export async function circleBoard(q: Queryable, userId: string, today: BizDate): Promise<CircleBoard | null> {
  const circleId = await myCircleId(q, userId);
  if (!circleId) return null;
  const [c] = await q.query<{ name: string; code: string }>(`SELECT name, code FROM circles WHERE id = $1`, [circleId]);
  if (!c) return null;
  const rows = await q.query<{ user_id: string; nickname: string; eligible_from: string }>(`SELECT user_id, nickname, eligible_from FROM circle_members WHERE circle_id = $1 ORDER BY joined_at`, [circleId]);
  const week = weekOf(today);
  const days = await recordDaysOf(q, rows.map((r) => r.user_id), week);
  const members: BoardMember[] = rows.map((r) => {
    const eligible = r.eligible_from <= week;
    return {
      nickname: r.nickname,
      initial: [...r.nickname][0] ?? '?',
      color: colorOf(r.nickname),
      recordDays: days.get(r.user_id)?.size ?? 0,
      rank: null,
      me: r.user_id === userId,
      pendingFrom: eligible ? null : r.eligible_from,
    };
  });
  // 只按记录天数排名；天数相同即并列，不用金额、时长或条数打破平局。
  const ranked = members.filter((m) => m.pendingFrom === null);
  for (const m of ranked) m.rank = 1 + ranked.filter((o) => o.recordDays > m.recordDays).length;
  const order = (m: BoardMember) => (m.pendingFrom ? 1000 : m.rank!);
  members.sort((a, b) => order(a) - order(b));
  return { name: c!.name, code: c!.code, week, max: CIRCLE_MAX, members };
}

export async function createCircle(q: Queryable, userId: string, name: unknown, nickname: unknown, today: BizDate): Promise<void> {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n || [...n].length > 16) fail('invalid_input', '名称需要 1 到 16 个字。');
  const nick = cleanNickname(nickname);
  if (await myCircleId(q, userId)) fail('circle_conflict', '你已经在一个同行榜里了，先退出才能新建。');
  for (let i = 0; i < 5; i++) {
    const code = Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
    const [c] = await q.query<{ id: string }>(`INSERT INTO circles (code, name) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING RETURNING id`, [code, n]);
    if (c) {
      // 创建者从本周开始计入：榜是自己建的，不存在「拉新人刷榜」的问题。
      await q.query(`INSERT INTO circle_members (user_id, circle_id, nickname, eligible_from) VALUES ($1, $2, $3, $4)`, [userId, c.id, nick, weekOf(today)]);
      return;
    }
  }
  fail('internal', '没能生成邀请码，请重试。');
}

export async function joinCircle(q: Queryable, userId: string, code: unknown, nickname: unknown, today: BizDate): Promise<void> {
  const k = typeof code === 'string' ? code.trim().toUpperCase() : '';
  const nick = cleanNickname(nickname);
  if (await myCircleId(q, userId)) fail('circle_conflict', '你已经在一个同行榜里了，先退出才能加入别的。');
  const [c] = await q.query<{ id: string }>(`SELECT id FROM circles WHERE code = $1 FOR UPDATE`, [k]);
  if (!c) fail('not_found', '没有找到这个邀请码，请核对后再试。');
  const [n] = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM circle_members WHERE circle_id = $1`, [c!.id]);
  if (Number(n!.n) >= CIRCLE_MAX) fail('circle_conflict', `这个同行榜已经满 ${CIRCLE_MAX} 人了。`);
  await q.query(`INSERT INTO circle_members (user_id, circle_id, nickname, eligible_from) VALUES ($1, $2, $3, $4)`, [userId, c!.id, nick, eligibleFrom(today)]);
}

export async function leaveCircle(q: Queryable, userId: string): Promise<void> {
  const circleId = await myCircleId(q, userId);
  if (!circleId) return;
  await q.query(`DELETE FROM circle_members WHERE user_id = $1`, [userId]);
  await q.query(`DELETE FROM circles WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM circle_members WHERE circle_id = $1)`, [circleId]);
}

// ───────────────────────── 每周拍立得 ─────────────────────────

export interface WeeklyCard {
  week: WeekKey;
  range: string;
  available: boolean;
  recordDays: number;
  stamp: boolean;
  headline: string;
  summary: string;
  newItems: string[];
  captionOptions: string[];
  caption: string;
  slots: HouseSlotView[];
}

/** 周卡只用真实记录生成文案；不出现金额与记录内容。 */
export async function weeklyCard(q: Queryable, userId: string, week: WeekKey): Promise<WeeklyCard> {
  const end = addDays(week, 6);
  const wd = await weekDaysOf(q, userId, week);
  const slots = await houseSlots(q, userId);
  const newItems = slots.filter((s) => s.unlockedOn && s.unlockedOn >= week && s.unlockedOn <= end).map((s) => s.variantName ?? s.name);
  const kinds = await q.query<{ kind: string; name: string }>(
    `SELECT DISTINCT r.kind, p.name FROM growth_points g JOIN records r ON r.id = g.record_id JOIN plans p ON p.id = r.plan_id
     WHERE g.user_id = $1 AND g.earned_on >= $2 AND g.earned_on <= $3`,
    [userId, week, end],
  );
  const options: string[] = [];
  const study = kinds.find((k) => k.kind === 'study');
  if (study) options.push(`忙归忙，${study.name}也没落下。`);
  if (kinds.some((k) => k.kind === 'expense')) options.push('每一笔都好好记下了。');
  if (newItems.length) options.push(`小屋里多了${newItems[0]}。`);
  options.push('慢一点也没关系。');
  const [saved] = await q.query<{ caption: string }>(`SELECT caption FROM weekly_captions WHERE user_id = $1 AND week = $2`, [userId, week]);
  const summary = `记录了 ${wd.recordDays} 天` + (newItems.length ? `，新添了${newItems.join('、')}。` : '。');
  return {
    week,
    range: `${formatMonthDay(week)}–${formatMonthDay(end)}`,
    available: wd.recordDays > 0,
    recordDays: wd.recordDays,
    stamp: wd.recordDays >= 3,
    headline: '这一周，生活又往前了一点。',
    summary,
    newItems,
    captionOptions: options.slice(0, 3),
    caption: saved?.caption ?? options[0]!,
    // 卡片只画那一周结束时的小屋：之后才解锁的物品不出现；也不带解锁回忆里的记录内容。
    slots: slots.map((x) =>
      x.unlockedOn && x.unlockedOn > end
        ? { ...x, unlocked: false, unlockedOn: null, variant: null, variantName: null, needsChoice: false, memory: null }
        : { ...x, memory: null },
    ),
  };
}

export async function saveCaption(q: Queryable, userId: string, week: WeekKey, caption: unknown): Promise<void> {
  const c = typeof caption === 'string' ? caption.trim() : '';
  if (!c || [...c].length > CAPTION_MAX) fail('invalid_input', `这句话需要 1 到 ${CAPTION_MAX} 个字。`);
  await q.query(`INSERT INTO weekly_captions (user_id, week, caption) VALUES ($1, $2, $3) ON CONFLICT (user_id, week) DO UPDATE SET caption = EXCLUDED.caption`, [userId, week, c]);
}
