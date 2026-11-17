import type { Category } from '../src/domain/ledger.js';
import type { FixtureName } from './fixtures.js';

/**
 * 固定评测集（PRD 15.2）。基础单轮 300 条，另有 E1 查询追加 10 条和多轮样例；基础分布：财务 80、学习 60、创建与目标 40、查询 40、歧义与非事实 40、纠错与边界 40。
 * 期望由产品与测试共同审定；这里是第一版草稿，修改时请保持编号稳定。
 * 日期以 2026-10-26（周一）12:41 为“现在”。
 */

export type Group = 'finance' | 'study' | 'create_goal' | 'query' | 'ambiguous' | 'correction';
type PlanRef = 'read' | 'eng';

export interface ExpRecord {
  k: 'expense' | 'refund' | 'study';
  yuan?: number;
  minutes?: number;
  date?: string;
  plan?: PlanRef;
  category?: Category;
}

export type Expect =
  /** 一轮内保存这些记录（不多不少）。clear=false 表示不计入“一轮完成率”。 */
  | { kind: 'records'; records: ExpRecord[]; clear?: boolean }
  /** 进入待补充，什么都不保存。 */
  | { kind: 'clarify'; issue?: string; options?: string[] }
  /** 不产生任何业务写入（可以解释、追问或拒绝）。 */
  | { kind: 'no_write' }
  | { kind: 'query'; query: ('ledger_month' | 'ledger_range' | 'study_week' | 'study_range' | 'comparison' | 'overview')[]; plan?: PlanRef }
  | { kind: 'plan'; plan: { kind: 'ledger' | 'study'; budgetYuan?: number | null; days?: number | null; minutes?: number | null; name?: string; activity?: string } }
  | { kind: 'goal'; goals: { plan: 'ledger' | PlanRef; param: 'budget_cents' | 'days_per_week' | 'min_minutes'; value: number; scope?: 'current_only' | 'current_and_future' | 'next_and_future' }[] }
  | { kind: 'edit'; edits: { target: 'lunch' | 'read25'; yuan?: number; minutes?: number; category?: Category; date?: string }[] }
  | { kind: 'delete'; targets: ('lunch' | 'read25')[] }
  | { kind: 'undo'; targets: ('lunch' | 'read25')[] }
  | { kind: 'plan_update'; plan: 'ledger' | PlanRef; change: 'renamed' | 'archived' | 'view'; name?: string; order?: string[]; hidden?: string[] };

export interface EvalCase {
  id: string;
  group: Group;
  text: string;
  fixture?: FixtureName;
  inputAt?: string;
  scope?: 'ledger' | PlanRef;
  expect: Expect;
  followUps?: { text: string; expect: Expect; choiceLabel?: string; chooseOnlyOption?: true; inputAt?: string }[];
}

const T0 = '2026-10-26';
const Y = '2026-10-25';
const DBY = '2026-10-24';

const E = (yuan: number, category?: Category, date?: string): ExpRecord => ({ k: 'expense', yuan, category, date: date ?? T0 });
const R = (yuan: number, date?: string): ExpRecord => ({ k: 'refund', yuan, date: date ?? T0 });
const S = (minutes: number, plan: PlanRef = 'read', date?: string): ExpRecord => ({ k: 'study', minutes, plan, date: date ?? T0 });
const rec = (...records: ExpRecord[]): Expect => ({ kind: 'records', records });
const NO: Expect = { kind: 'no_write' };
const CL: Expect = { kind: 'clarify' };
const Q = (...query: ('ledger_month' | 'ledger_range' | 'study_week' | 'study_range' | 'comparison' | 'overview')[]): Expect => ({ kind: 'query', query });

type Row = [text: string, expect: Expect, opts?: Pick<EvalCase, 'fixture' | 'scope' | 'followUps'>];

const finance: Row[] = [
  ['午饭20元', rec(E(20, '餐饮'))],
  ['午饭20块', rec(E(20, '餐饮'))],
  ['中午吃饭花了二十五', rec(E(25, '餐饮'))],
  ['早餐8块', rec(E(8, '餐饮'))],
  ['买咖啡18元', rec(E(18, '餐饮'))],
  ['星巴克32', rec(E(32, '餐饮'))],
  ['晚饭外卖46.5', rec(E(46.5, '餐饮'))],
  ['奶茶15', rec(E(15, '餐饮'))],
  ['打车35', rec(E(35, '交通'))],
  ['地铁4块', rec(E(4, '交通'))],
  ['加油300元', rec(E(300, '交通'))],
  ['高铁票268', rec(E(268, '交通'))],
  ['停车费10元', rec(E(10, '交通'))],
  ['共享单车1.5元', rec(E(1.5, '交通'))],
  ['买了件衣服299', rec(E(299, '购物'))],
  ['淘宝买纸巾39.9', rec(E(39.9, '购物'))],
  ['超市买菜128', rec(E(128))],
  ['买了个充电宝89', rec(E(89, '购物'))],
  ['房租3200', rec(E(3200, '居住'))],
  ['交了电费150', rec(E(150, '居住'))],
  ['水费45', rec(E(45, '居住'))],
  ['物业费260', rec(E(260, '居住'))],
  ['买了两本书76元', rec(E(76, '学习'))],
  ['报了个网课399', rec(E(399, '学习'))],
  ['看电影60', rec(E(60, '娱乐'))],
  ['KTV唱歌120', rec(E(120, '娱乐'))],
  ['游戏充值30', rec(E(30, '娱乐'))],
  ['理发40', rec(E(40))],
  ['给朋友买生日礼物200', rec(E(200))],
  ['看病挂号25', rec(E(25))],
  ['￥58.8 晚饭', rec(E(58.8, '餐饮'))],
  ['午饭一百二', rec(E(120, '餐饮'))],
  ['花了三十五块打车', rec(E(35, '交通'))],
  ['买水果花了二十二块五', rec(E(22.5))],
  ['昨天午饭20', rec(E(20, '餐饮', Y))],
  ['昨天打车回家38', rec(E(38, '交通', Y))],
  ['前天看电影75', rec(E(75, '娱乐', DBY))],
  ['3天前买了双鞋459', rec(E(459, '购物', '2026-10-23'))],
  ['10月20日交了房租3000', rec(E(3000, '居住', '2026-10-20'))],
  ['上周五聚餐AA了150', rec(E(150, '餐饮', '2026-10-23'))],
  ['10月1日买了个台灯129', rec(E(129, '购物', '2026-10-01'))],
  ['昨晚夜宵35', rec(E(35, '餐饮', Y))],
  ['早餐8块，午饭25', rec(E(8, '餐饮'), E(25, '餐饮'))],
  ['午饭20，打车30', rec(E(20, '餐饮'), E(30, '交通'))],
  ['早上地铁4块，中午吃饭22，晚上看电影50', rec(E(4, '交通'), E(22, '餐饮'), E(50, '娱乐'))],
  ['今天：咖啡18、午饭32、打车25', rec(E(18, '餐饮'), E(32, '餐饮'), E(25, '交通'))],
  ['买菜60，水电费200', rec(E(60), E(200, '居住'))],
  ['昨天午饭25，今天午饭30', rec(E(25, '餐饮', Y), E(30, '餐饮'))],
  ['加油250，洗车40', rec(E(250, '交通'), E(40))],
  ['买书两本共88，咖啡20', rec(E(88, '学习'), E(20, '餐饮'))],
  ['耳机退了50', rec(R(50))],
  ['耳机退款199元到账了', rec(R(199))],
  ['之前买的耳机退了一部分钱，退了30', rec(R(30))],
  ['超市那单退了28块', rec(R(28))],
  ['昨天耳机退款到账60', rec(R(60, Y))],
  ['午饭20元', rec(E(20, '餐饮')), { scope: 'read' }],
  ['打车15', rec(E(15, '交通')), { scope: 'eng' }],
  ['午饭20元，刚才又读了25分钟', rec(E(20, '餐饮'), S(25))],
  ['晚饭35，英语学了40分钟', rec(E(35, '餐饮'), S(40, 'eng'))],
  ['买书50，读了半小时', rec(E(50, '学习'), S(30))],
  ['话费充值100', rec(E(100))],
  ['买药56', rec(E(56))],
  ['健身房年卡1999', rec(E(1999))],
  ['给猫买猫粮168', rec(E(168))],
  ['快递费12', rec(E(12))],
  ['早饭包子豆浆6块', rec(E(6, '餐饮'))],
  ['下午茶38', rec(E(38, '餐饮'))],
  ['打车去机场120', rec(E(120, '交通'))],
  ['机票980', rec(E(980, '交通'))],
  ['买了副耳机299', rec(E(299, '购物'))],
  ['午饭花了12.5', rec(E(12.5, '餐饮'))],
  ['喝了杯奶茶，16块', rec(E(16, '餐饮'))],
  ['刚刚吃了碗面，18元', rec(E(18, '餐饮'))],
  ['坐公交2元', rec(E(2, '交通'))],
  ['买了一束花99', rec(E(99))],
  ['交了宽带费120', rec(E(120, '居住'))],
  ['网购了一个书包159', rec(E(159, '购物'))],
  ['和同事吃火锅人均89', rec(E(89, '餐饮'))],
  ['昨天买菜花了76', rec(E(76, undefined, Y))],
  ['前天晚上打车42', rec(E(42, '交通', DBY))],
];

const study: Row[] = [
  ['读了30分钟', rec(S(30))],
  ['看书半小时', rec(S(30))],
  ['读书1.5小时', rec(S(90))],
  ['读了一个小时书', rec(S(60))],
  ['阅读45分钟', rec(S(45))],
  ['刚读完一章，用了25分钟', rec(S(25))],
  ['睡前读了20分钟', rec({ k: 'study', minutes: 20, plan: 'read' })],
  ['昨天读了40分钟', rec(S(40, 'read', Y))],
  ['前天看书一小时', rec(S(60, 'read', DBY))],
  ['昨晚读了35分钟书', rec(S(35, 'read', Y))],
  ['10月24日读了50分钟', rec(S(50, 'read', DBY))],
  ['英语学了40分钟', rec(S(40, 'eng'))],
  ['背单词20分钟', rec(S(20, 'eng'))],
  ['练了半小时英语听力', rec(S(30, 'eng'))],
  ['英语学习1小时', rec(S(60, 'eng'))],
  ['昨天英语学了25分钟', rec(S(25, 'eng', Y))],
  ['读了20分钟，又学了30分钟英语', rec(S(20), S(30, 'eng'))],
  ['上午读书30分钟，下午英语40分钟', rec(S(30), S(40, 'eng'))],
  ['学了30分钟', rec(S(30, 'eng')), { scope: 'eng' }],
  ['又看了15分钟', rec(S(15)), { scope: 'read' }],
  ['读了30分钟', rec(S(30, 'eng')), { scope: 'eng' }],
  ['记到阅读，读了20分钟', rec(S(20)), { scope: 'eng' }],
  ['读了25分钟', rec(S(25)), { scope: 'ledger' }],
  ['阅读了两个小时', rec(S(120))],
  ['读了90分钟', rec(S(90))],
  ['读了一刻钟', rec(S(15))],
  ['看书看了四十分钟', rec(S(40))],
  ['午饭后读了半个小时', rec(S(30))],
  ['通勤路上读了25分钟', rec(S(25))],
  ['听英语播客20分钟', rec(S(20, 'eng'))],
  ['做了英语阅读理解练习35分钟', rec(S(35, 'eng'))],
  ['英语口语练习45分钟', rec(S(45, 'eng'))],
  ['学英语学了1小时20分钟', rec(S(80, 'eng'))],
  ['读了2小时15分钟', rec(S(135))],
  ['前天读了半小时', rec(S(30, 'read', DBY))],
  ['3天前读了40分钟', rec(S(40, 'read', '2026-10-23'))],
  ['今天读书了', CL],
  ['学习了一会儿', CL],
  ['读了一会儿书', CL],
  ['今天总共读了60分钟', CL],
  ['上周某天读了30分钟', CL],
  ['读了1.33小时', CL],
  ['背了一些单词', CL],
  ['英语学了好久', CL],
  ['读完一本小说花了50分钟', rec(S(50))],
  ['今早读了20分钟', rec(S(20))],
  ['中午读了10分钟', rec(S(10))],
  ['刚刚读了5分钟', rec(S(5))],
  ['英语听力30分钟，阅读20分钟', rec(S(30, 'eng'), S(20))],
  ['昨天英语和阅读各30分钟', rec(S(30, 'eng', Y), S(30, 'read', Y))],
  ['看书1小时', rec(S(60))],
  ['读了整整一小时', rec(S(60))],
  ['英语学了半小时', rec(S(30, 'eng'))],
  ['背单词15分钟，读书25分钟', rec(S(15, 'eng'), S(25))],
  ['读书四十五分钟', rec(S(45))],
  ['学英语20分钟', rec(S(20, 'eng'))],
  ['读了40分钟', rec(S(40)), { scope: 'read' }],
  ['昨天读了20分钟', rec(S(20, 'read', Y)), { scope: 'read' }],
  ['昨天学了半小时', rec(S(30, 'eng', Y)), { scope: 'eng' }],
  ['今天读书30分钟', rec(S(30))],
];

const G = (plan: 'ledger' | PlanRef, param: 'budget_cents' | 'days_per_week' | 'min_minutes', value: number, scope?: 'current_only' | 'current_and_future' | 'next_and_future') => ({ plan, param, value, scope });
const goal = (...goals: ReturnType<typeof G>[]): Expect => ({ kind: 'goal', goals });
const empty = { fixture: 'empty' as const };

const createGoal: Row[] = [
  ['我想省钱，帮我记账', { kind: 'plan', plan: { kind: 'ledger', budgetYuan: null } }, empty],
  ['帮我记账', { kind: 'plan', plan: { kind: 'ledger', budgetYuan: null } }, empty],
  ['帮我记账，每月预算3000', { kind: 'plan', plan: { kind: 'ledger', budgetYuan: 3000 } }, empty],
  ['每个月最多花2000，帮我管着点', { kind: 'plan', plan: { kind: 'ledger', budgetYuan: 2000 } }, empty],
  ['每周阅读5天，每天20分钟', { kind: 'plan', plan: { kind: 'study', days: 5, minutes: 20 } }, empty],
  ['我想养成阅读习惯', { kind: 'plan', plan: { kind: 'study', days: null, minutes: null } }, empty],
  ['每周读书3天', { kind: 'plan', plan: { kind: 'study', days: 3, minutes: null } }, empty],
  ['每天读书30分钟', { kind: 'plan', plan: { kind: 'study', minutes: 30 } }, empty],
  ['建一个英语学习计划，每周4天，每天30分钟', { kind: 'plan', plan: { kind: 'study', days: 4, minutes: 30, activity: '英语' } }, empty],
  ['我要学英语', { kind: 'plan', plan: { kind: 'study', activity: '英语' } }, empty],
  ['我想省钱', NO, empty],
  ['每周跑步3次', NO, empty],
  ['预算改成3500', goal(G('ledger', 'budget_cents', 350000, 'current_and_future'))],
  ['下个月起预算改成4000', goal(G('ledger', 'budget_cents', 400000, 'next_and_future'))],
  ['这个月预算先调到2500', goal(G('ledger', 'budget_cents', 250000))],
  ['只把这个月预算改成2800', goal(G('ledger', 'budget_cents', 280000, 'current_only'))],
  ['以后每月预算都是3200', goal(G('ledger', 'budget_cents', 320000, 'current_and_future'))],
  ['阅读改成每周4天', goal(G('read', 'days_per_week', 4))],
  ['阅读每天门槛改成30分钟', goal(G('read', 'min_minutes', 30))],
  ['从下周起每周读3天', goal(G('read', 'days_per_week', 3, 'next_and_future'))],
  ['英语学习每天至少25分钟', goal(G('eng', 'min_minutes', 25))],
  ['英语每周学5天', goal(G('eng', 'days_per_week', 5))],
  ['这周阅读目标改成每周6天', goal(G('read', 'days_per_week', 6))],
  ['每天30分钟', goal(G('eng', 'min_minutes', 30)), { scope: 'eng' }],
  ['改成每周4天', goal(G('read', 'days_per_week', 4)), { scope: 'read' }],
  ['帮我记账', NO],
  ['再建一个阅读计划', NO],
  ['新建一个叫睡前阅读的计划，每周7天每天15分钟', { kind: 'plan', plan: { kind: 'study', days: 7, minutes: 15, name: '睡前阅读' } }],
  ['把英语学习改名为英语听力', { kind: 'plan_update', plan: 'eng', change: 'renamed', name: '英语听力' }],
  ['归档英语学习', { kind: 'plan_update', plan: 'eng', change: 'archived' }],
  ['隐藏趋势图', { kind: 'plan_update', plan: 'ledger', change: 'view' }],
  ['把阅读计划改名叫课外阅读', { kind: 'plan_update', plan: 'read', change: 'renamed', name: '课外阅读' }],
  ['不用再统计英语学习了，先归档吧', { kind: 'plan_update', plan: 'eng', change: 'archived' }],
  ['每月预算设为5000', goal(G('ledger', 'budget_cents', 500000))],
  ['预算从下个月开始调成2600', goal(G('ledger', 'budget_cents', 260000, 'next_and_future'))],
  ['阅读目标改成每周5天每天25分钟', goal(G('read', 'min_minutes', 25))],
  ['暂停阅读计划', NO],
  ['每天提醒我读书', NO],
  ['设个预算', CL],
  ['英语学习每周3天每天20分钟', goal(G('eng', 'min_minutes', 20))],
];

const query: Row[] = [
  ['这个月还剩多少', Q('ledger_month')],
  ['本月花了多少', Q('ledger_month')],
  ['这个月预算用了多少', Q('ledger_month')],
  ['上个月花了多少', Q('ledger_month')],
  ['今天花了多少', Q('ledger_range')],
  ['昨天花了多少', Q('ledger_range')],
  ['最近7天花了多少', Q('ledger_range')],
  ['这周花了多少', Q('ledger_range')],
  ['这个月餐饮花了多少', Q('ledger_month')],
  ['交通花了多少', Q('ledger_month', 'ledger_range')],
  ['本月购物支出多少', Q('ledger_month')],
  ['预算还剩多少', Q('ledger_month')],
  ['我超支了吗', Q('ledger_month')],
  ['本周读了几天', Q('study_week')],
  ['这周阅读达标了吗', Q('study_week')],
  ['上周读了几天', Q('study_week')],
  ['这周英语学了多久', Q('study_week')],
  ['今天读了多久', Q('study_range')],
  ['最近怎么样', Q('overview')],
  ['我的计划进展如何', Q('overview')],
  ['帮我看看各个计划的情况', Q('overview')],
  ['10月20日花了多少', Q('ledger_range')],
  ['本月退款多少', Q('ledger_month')],
  ['这个月净支出多少', Q('ledger_month')],
  ['这个月吃饭花了多少', Q('ledger_month')],
  ['本月娱乐支出', Q('ledger_month')],
  ['上周花了多少', Q('ledger_range')],
  ['昨天读书了吗', Q('study_range')],
  ['阅读本周还差几天', Q('study_week')],
  ['英语学习这周记录了几天', Q('study_week')],
  ['最近怎么样', Q('overview', 'study_week'), { scope: 'read' }],
  ['还剩多少', Q('ledger_month'), { scope: 'ledger' }],
  ['这个月还能花多少', Q('ledger_month')],
  ['本月花销是多少', Q('ledger_month')],
  ['今天吃饭花了多少', Q('ledger_range')],
  ['本周阅读总时长', Q('study_week')],
  ['上个月预算还剩多少', Q('ledger_month')],
  ['这个月哪类花得最多', Q('ledger_month')],
  ['截至今天本月支出', Q('ledger_month')],
  ['最近读书怎么样', Q('study_week', 'overview')],
  // E1 追加，不重编号原有 Q001–Q040；比较夹具增加上月数据和跨月退款。
  ['这个月比上个月多花了多少', Q('comparison'), { fixture: 'comparison' }],
  ['本月净支出比上月多多少', Q('comparison'), { fixture: 'comparison' }],
  ['本月退款和上月相比怎么样', Q('comparison'), { fixture: 'comparison' }],
  ['本月阅读分钟数比上月多还是少', Q('comparison'), { fixture: 'comparison' }],
  ['本月购物净支出和上月比较', Q('comparison'), { fixture: 'comparison' }],
  ['10月1日至26日阅读时长，与9月1日至26日比较', Q('comparison'), { fixture: 'comparison' }],
  ['今天支出比昨天多多少', Q('comparison')],
  ['最近7天读了多少分钟', Q('study_range')],
  ['这个月阅读记录了几天，一共多久', Q('study_range')],
  ['10月24日至26日读了多久', Q('study_range')],
];

const ambiguous: Row[] = [
  ['我准备买20元咖啡', NO],
  ['如果每天花100，一个月要多少', NO],
  ['明天读30分钟', NO],
  ['每天21点提醒我读书', NO],
  ['工资到账8000', NO],
  ['转了500到储蓄卡', NO],
  ['还信用卡2000', NO],
  ['自动同步支付宝账单', NO],
  ['我的阅读能力提升了多少', NO],
  ['花了几百块', NO],
  ['买了点东西', NO],
  ['花了20美元', NO],
  ['读到第50页', NO],
  ['你好', NO],
  ['谢谢', NO],
  ['想买个新手机', NO],
  ['要不要买那双鞋', NO],
  ['打算周末去看电影，大概80', NO],
  ['明天的午饭20元', NO],
  ['下周要交房租3000', NO],
  ['理财收益到账50', NO],
  ['中了彩票500', NO],
  ['借给朋友1000', NO],
  ['朋友还了我300', NO],
  ['收到红包88', NO],
  ['假设我每周读5天，一个月能读多少', NO],
  ['今天天气不错', NO],
  ['记账有什么用', NO],
  ['能帮我算下3000除以30吗', NO],
  ['我是不是花太多了', NO],
  ['昨天好像花了些钱', NO],
  ['读了些书', NO],
  ['想读书但没时间', NO],
  ['本来要去跑步的', NO],
  ['支付宝余额还剩多少', NO],
  ['帮我查一下股票', NO],
  ['用欧元付了30', NO],
  ['午饭大概花了几十块', NO],
  ['帮我删掉所有记录', NO],
  ['把预算设成负数', NO],
];

const correction: Row[] = [
  ['刚才不是20元，是25元', { kind: 'edit', edits: [{ target: 'lunch', yuan: 25 }] }],
  ['午饭改成30', { kind: 'edit', edits: [{ target: 'lunch', yuan: 30 }] }],
  ['刚才那笔改成交通', { kind: 'edit', edits: [{ target: 'lunch', category: '交通' }] }],
  ['刚才那笔是昨天的', { kind: 'edit', edits: [{ target: 'lunch', date: Y }] }],
  ['刚才读书改成40分钟', { kind: 'edit', edits: [{ target: 'read25', minutes: 40 }] }],
  ['阅读那条记错了，是35分钟', { kind: 'edit', edits: [{ target: 'read25', minutes: 35 }] }],
  ['删掉刚才那笔午饭', { kind: 'delete', targets: ['lunch'] }],
  ['撤销刚才', { kind: 'undo', targets: ['lunch', 'read25'] }, { fixture: 'chat_receipt' }],
  ['刚才的午饭删了吧', { kind: 'delete', targets: ['lunch'] }],
  ['刚才读书那条不要了', { kind: 'delete', targets: ['read25'] }],
  ['午饭其实是28.5', { kind: 'edit', edits: [{ target: 'lunch', yuan: 28.5 }] }],
  ['刚才那笔金额错了，应该是18', { kind: 'edit', edits: [{ target: 'lunch', yuan: 18 }] }],
  ['刚才记的阅读其实是昨天的', { kind: 'edit', edits: [{ target: 'read25', date: Y }] }],
  ['午饭那笔分类改成其他', { kind: 'edit', edits: [{ target: 'lunch', category: '其他' }] }],
  ['午饭1000000元', NO],
  ['读了1500分钟', NO],
  ['早餐5，午饭20，晚饭30，地铁4，公交2，奶茶15，咖啡20，水果10，零食8，报纸3，纸巾5', NO],
  ['午饭-20元', NO],
  ['午饭0元', NO],
  ['今天读了0分钟', NO],
  ['耳机退了500', NO],
  ['2027年1月1日午饭20', NO],
  ['读了25小时', NO],
  ['刚才那笔改成-5元', NO],
  ['把刚才的阅读改成2000分钟', NO],
  ['撤销上一次操作', { kind: 'undo', targets: ['lunch', 'read25'] }, { fixture: 'chat_receipt' }],
  ['不对，午饭是22', { kind: 'edit', edits: [{ target: 'lunch', yuan: 22 }] }],
  ['刚刚那条阅读是20分钟不是25', { kind: 'edit', edits: [{ target: 'read25', minutes: 20 }] }],
  ['刚才那顿午饭是前天的', { kind: 'edit', edits: [{ target: 'lunch', date: DBY }] }],
  ['午饭不是餐饮，是娱乐', { kind: 'edit', edits: [{ target: 'lunch', category: '娱乐' }] }],
  ['刚才记错了，删掉阅读那条', { kind: 'delete', targets: ['read25'] }],
  ['把刚才记的都撤销', { kind: 'undo', targets: ['lunch', 'read25'] }, { fixture: 'chat_receipt' }],
  ['刚才多记了一笔午饭，删掉', { kind: 'delete', targets: ['lunch'] }],
  ['午饭改成25元，阅读改成30分钟', { kind: 'edit', edits: [{ target: 'lunch', yuan: 25 }, { target: 'read25', minutes: 30 }] }],
  ['刚才的午饭金额改成20.5', { kind: 'edit', edits: [{ target: 'lunch', yuan: 20.5 }] }],
  ['刚才那笔改到10月20日', { kind: 'edit', edits: [{ target: 'lunch', date: '2026-10-20' }] }],
  ['删掉刚才的记录', CL],
  ['刚才那个改一下', CL],
  // A bare request must first display the server's receipt choice; final targets stay unchanged.
  ['撤销', { kind: 'clarify', issue: '需要选保存回执' }, { fixture: 'chat_receipt', followUps: [{ text: '确认撤销这次保存', chooseOnlyOption: true, expect: { kind: 'undo', targets: ['lunch', 'read25'] } }] }],
  ['刚才阅读那条是英语学习', NO],
];

const build = (group: Group, prefix: string, rows: Row[]): EvalCase[] =>
  rows.map(([text, expect, opts], i) => ({ id: `${prefix}${String(i + 1).padStart(3, '0')}`, group, text, expect, fixture: opts?.fixture ?? 'default', scope: opts?.scope, ...(opts?.followUps ? { followUps: opts.followUps } : {}) }));

const SAT = '2026-10-31T10:00:00+08:00';
const MON = '2026-11-02T10:00:00+08:00';
const readingPlan: Expect = { kind: 'plan', plan: { kind: 'study', days: 4, minutes: 20, activity: '阅读' } };

const DUPLICATE: Expect = { kind: 'clarify', issue: '疑似重复记录', options: ['又发生了一次，仍要保存', '取消'] };
export const CASES: EvalCase[] = [
  { id: 'D001', group: 'correction', inputAt: '2026-10-26T12:31:00+08:00', text: '午饭20元', expect: DUPLICATE, followUps: [{ text: '又发生了一次，仍要保存', choiceLabel: '又发生了一次，仍要保存', inputAt: '2026-10-28T09:00:00+08:00', expect: rec(E(20, '餐饮')) }] },
  { id: 'D002', group: 'correction', inputAt: '2026-10-26T12:31:00+08:00', text: '午饭20元', expect: DUPLICATE, followUps: [{ text: '取消', choiceLabel: '取消', expect: NO }] },
  { id: 'D003', group: 'finance', inputAt: '2026-10-26T12:33:00+08:00', text: '午饭20元', expect: rec(E(20, '餐饮')) },
  { id: 'D004', group: 'study', inputAt: '2026-10-26T12:31:00+08:00', text: '阅读25分钟', scope: 'read', expect: DUPLICATE, followUps: [{ text: '又发生了一次，仍要保存', choiceLabel: '又发生了一次，仍要保存', expect: rec(S(25)) }] },
  { id: 'W001', group: 'create_goal', fixture: 'empty', inputAt: SAT, text: '每周读书4天，每天20分钟', expect: readingPlan },
  { id: 'W002', group: 'create_goal', fixture: 'empty', inputAt: SAT, text: '本周读书4天，每天20分钟', expect: CL, followUps: [{ text: '本周按 2 天', choiceLabel: '本周按 2 天', inputAt: MON, expect: readingPlan }] },
  { id: 'W003', group: 'create_goal', fixture: 'empty', inputAt: SAT, text: '本周读书4天，每天20分钟', expect: CL, followUps: [{ text: '从下周开始', choiceLabel: '从下周开始', inputAt: MON, expect: readingPlan }] },
  { id: 'W004', group: 'create_goal', fixture: 'empty', inputAt: '2026-11-01T10:00:00+08:00', text: '本周读书2天，每天20分钟', expect: CL, followUps: [{ text: '取消', choiceLabel: '取消', expect: NO }] },
  { id: 'W005', group: 'create_goal', fixture: 'empty', inputAt: SAT, text: '本周读书2天，每天20分钟', expect: { kind: 'plan', plan: { kind: 'study', days: 2, minutes: 20, activity: '阅读' } } },
  { id: 'W006', group: 'create_goal', fixture: 'first_week', inputAt: '2026-11-01T10:00:00+08:00', text: '阅读本周改成5天，只改本周', expect: CL, followUps: [{ text: '本周按 2 天', choiceLabel: '本周按 2 天', inputAt: MON, expect: goal(G('read', 'days_per_week', 2, 'current_only')) }] },
  ...build('finance', 'F', finance),
  ...build('study', 'S', study),
  ...build('create_goal', 'G', createGoal),
  ...build('query', 'Q', query),
  ...build('ambiguous', 'A', ambiguous),
  ...build('correction', 'C', correction),
  { id: 'M001', group: 'ambiguous', text: '学习了半小时', expect: CL, followUps: [{ text: '阅读', choiceLabel: '阅读', expect: rec(S(30)) }] },
  { id: 'M002', group: 'ambiguous', text: '学习了半小时', expect: CL, followUps: [{ text: '英语学习', choiceLabel: '英语学习', expect: rec(S(30, 'eng')) }] },
  { id: 'K001', group: 'query', text: '今天午饭花了多少钱', expect: Q('ledger_range') },
  { id: 'K002', group: 'query', text: '这个月花了多少', expect: Q('ledger_month'), followUps: [{ text: '我是问地铁', expect: Q('ledger_range') }, { text: '那上周呢', expect: Q('ledger_range') }] },
  { id: 'K003', group: 'query', text: '这个月耳机花了多少钱', expect: Q('ledger_range') },
  { id: 'K004', group: 'query', text: '今天打车用了多少钱', expect: Q('ledger_range') },
  // 线上对话复现：曾答成全天支出；用户纠正后不能当成要记账，省略追问也要沿用“加油”。
  { id: 'K005', group: 'query', text: '今天加油用了多少钱', expect: Q('ledger_range'), followUps: [{ text: '我说车加油', expect: Q('ledger_range') }, { text: '花了多少钱', expect: Q('ledger_range') }] },
  { id: 'L001', group: 'create_goal', text: '日常记账的趋势放在分类前面，记录最后', expect: { kind: 'plan_update', plan: 'ledger', change: 'view', order: ['summary', 'budget', 'trend', 'categories', 'records'], hidden: [] } },
  { id: 'L002', group: 'create_goal', text: '阅读计划的记录放在时长前面', expect: { kind: 'plan_update', plan: 'read', change: 'view', order: ['goal', 'calendar', 'records', 'minutes'], hidden: [] } },
  { id: 'L003', group: 'create_goal', text: '日常记账先显示记录，再显示分类和趋势', expect: { kind: 'plan_update', plan: 'ledger', change: 'view', order: ['summary', 'budget', 'records', 'categories', 'trend'], hidden: [] } },
];
