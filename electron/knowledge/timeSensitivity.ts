/**
 * 问题时间敏感性识别：记忆装载后、prompt 装配前执行。
 * 相对时间 / 实时数据 / 日历类问题需要注入当前日期锚点，
 * 避免模型把“今天”当成无锚点词汇而答非所问；
 * 历史回顾类问题反而不需要锚定到今天。
 */

/** 相对时间词：需要知道“今天”是哪天才能理解。 */
const RELATIVE_TIME_KEYWORDS = [
  '今天', '今日', '明天', '明日', '后天', '昨天', '昨日', '前天',
  '本周', '这周', '上周', '下周', '本月', '这个月', '上个月', '下个月',
  '今年', '去年', '明年', '最近', '近期', '目前', '现在', '当前', '眼下',
  '这几天', '这两天', '今晚', '明晚', '昨晚',
  'today', 'tomorrow', 'yesterday', 'tonight',
  'this week', 'last week', 'next week', 'this month', 'last month',
  'this year', 'last year', 'next year',
  'now', 'currently', 'recently', 'these days',
];

/** 实时数据领域词：必须查最新数据，锚定日期的同时提示数据时效。 */
const FRESH_INFORMATION_KEYWORDS = [
  '天气', '气温', '下雨', '降雨', '降雪', '台风', '空气质量', '紫外线',
  '股价', '股票', '基金', '汇率', '行情', '油价', '金价',
  '新闻', '最新', '实时', '直播', '比分', '赛事', '榜单',
  'weather', 'forecast', 'stock', 'exchange rate', 'news', 'live', 'score', 'latest',
];

/** 日历类词：需要日期锚定但不一定要搜索。 */
const CALENDAR_KEYWORDS = [
  '星期几', '周几', '几号', '什么日子', '日期', '节假日', '假期', '放假',
  '农历', '阴历', '阳历', '节气', '周末', '除夕', '春节', '中秋', '端午', '重阳',
  'holiday', 'calendar', 'weekday', 'lunar',
];

/** 历史回顾类词：这类问题反而不需要锚定到今天。 */
const HISTORICAL_HINTS = [
  '历史上', '历史', '当年', '古代', '过去', '曾经', '回顾', '旧时',
  '那时候', '那时', '当时', '年代', 'historical', 'history', 'back then', 'in the past',
];

export type QuestionTimeSensitivityCategory =
  | 'relative-time'
  | 'fresh-information'
  | 'calendar'
  | 'historical'
  | 'none';

export interface QuestionTimeSensitivity {
  category: QuestionTimeSensitivityCategory;
  /** 是否需要在 prompt 中注入当前日期锚点。 */
  anchored: boolean;
  matchedKeywords: string[];
}

function matchKeywords(text: string, keywords: readonly string[]): string[] {
  return keywords.filter((keyword) => text.includes(keyword));
}

/**
 * 识别顺序：历史回顾且不含相对时间词 → 不锚定；
 * 否则按 相对时间 → 实时数据 → 日历 的优先级锚定。
 * “历史上的今天”同时命中历史与相对时间，仍锚定到今天。
 */
export function detectQuestionTimeSensitivity(question: string): QuestionTimeSensitivity {
  const text = question.toLocaleLowerCase('zh-Hans-CN');
  const relative = matchKeywords(text, RELATIVE_TIME_KEYWORDS);
  const fresh = matchKeywords(text, FRESH_INFORMATION_KEYWORDS);
  const calendar = matchKeywords(text, CALENDAR_KEYWORDS);
  const historical = matchKeywords(text, HISTORICAL_HINTS);
  if (historical.length > 0 && relative.length === 0) {
    return { category: 'historical', anchored: false, matchedKeywords: historical };
  }
  if (relative.length > 0) return { category: 'relative-time', anchored: true, matchedKeywords: relative };
  if (fresh.length > 0) return { category: 'fresh-information', anchored: true, matchedKeywords: fresh };
  if (calendar.length > 0) return { category: 'calendar', anchored: true, matchedKeywords: calendar };
  return { category: 'none', anchored: false, matchedKeywords: [] };
}

/**
 * 生成当前日期锚点行；非时间敏感问题返回 undefined。
 * 锚点随问题进入 Zone Q，跨轮不影响 S/M1/M2 前缀缓存。
 */
export function buildQuestionTimeAnchor(sensitivity: QuestionTimeSensitivity, now: Date = new Date()): string | undefined {
  if (!sensitivity.anchored) return undefined;
  const dateLabel = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(now);
  const hint = sensitivity.category === 'fresh-information'
    ? '如涉及天气、行情、新闻等实时信息，请基于该日期说明数据时效；无法获取实时数据时明确告知，不要编造。'
    : sensitivity.category === 'calendar'
      ? '如涉及星期、节假日或农历换算，请以该日期为准。'
      : '问题中的“今天”“本周”“最近”等相对时间表述，均以该日期为基准理解。';
  return `当前日期：${dateLabel}。${hint}`;
}
