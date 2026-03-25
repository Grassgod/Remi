/**
 * Dynamic session name generator for Feishu card headers.
 *
 * Generates unique names like "好奇的 Remi·Vulpes" by combining
 * a Chinese adjective with an animal genus name.
 * Same sessionId always yields the same combination (deterministic hash).
 */

// ── Adjective pool ──────────────────────────────────────────

const ADJECTIVES = [
  // 性格/情感
  "开心", "快乐", "温柔", "勇敢", "好奇", "聪明", "善良", "活泼",
  "乐观", "自信", "热情", "认真", "可爱", "大方", "害羞", "傲娇",
  "安静", "文静", "淡定", "从容", "冷静", "沉稳", "率真", "坦率",
  "真诚", "热心", "耐心", "细心", "贴心", "暖心", "知足", "感恩",
  "坚强", "倔强", "执着", "专注", "勤奋", "努力", "拼搏", "积极",
  "向上", "阳光", "灿烂", "明朗", "爽朗", "豪爽", "洒脱", "随性",
  "幽默", "风趣", "机智", "灵活", "敏锐", "敏捷", "伶俐", "机灵",
  "调皮", "搞怪", "俏皮", "顽皮", "捣蛋", "淘气", "贪玩", "爱笑",
  "爱哭", "多愁善感", "浪漫", "文艺", "诗意", "优雅", "高雅", "端庄",
  "贤惠", "体贴", "温馨", "甜蜜", "幸福", "满足", "惬意", "悠闲",
  "慵懒", "佛系", "随缘", "潇洒", "帅气", "靓丽", "漂亮", "美丽",
  "可人", "迷人", "动人", "醉人", "销魂", "妩媚", "妖娆", "性感",

  // 状态/行为
  "忙碌", "充实", "疲惫", "困倦", "迷茫", "纠结", "犹豫", "果断",
  "坚定", "固执", "任性", "霸道", "强势", "温和", "柔和", "平和",
  "祥和", "宁静", "寂寞", "孤独", "独立", "自由", "奔放", "豁达",
  "开朗", "健谈", "话痨", "沉默", "寡言", "内向", "外向", "社恐",
  "社牛", "i人", "e人", "怕生", "大胆", "谨慎", "小心", "粗心",
  "马虎", "糊涂", "清醒", "明白", "糊里糊涂", "迷迷糊糊", "恍恍惚惚",
  "懵懵懂懂", "浑浑噩噩", "稀里糊涂", "不知所措", "手忙脚乱",
  "井井有条", "有条不紊", "一丝不苟", "兢兢业业", "勤勤恳恳",

  // 能力/特质
  "厉害", "牛逼", "强大", "无敌", "全能", "万能", "博学", "渊博",
  "睿智", "深邃", "深沉", "神秘", "高冷", "霸气", "王者", "大佬",
  "学霸", "卷王", "肝帝", "摸鱼", "划水", "躺平", "内卷", "奋斗",
  "拼命", "疯狂", "狂热", "痴迷", "沉迷", "上头", "上瘾", "着迷",
  "入迷", "专业", "靠谱", "稳重", "老练", "成熟", "稚嫩", "青涩",
  "天真", "纯真", "单纯", "简单", "朴素", "低调", "高调", "张扬",
  "嚣张", "狂妄", "谦虚", "谦逊", "有礼", "礼貌", "客气", "矜持",

  // 趣味/网络
  "吃货", "干饭", "贪吃", "嘴馋", "肥宅", "社畜", "打工", "搬砖",
  "摆烂", "躺赢", "欧皇", "非酋", "锦鲤", "幸运", "倒霉",
  "倒霉蛋", "幸运星", "小确幸", "暴躁", "炸毛", "抓狂", "崩溃",
  "无语", "震惊", "吃惊", "惊讶", "感动", "泪目", "破防", "emo",
  "丧", "致郁", "治愈", "元气", "满血", "复活", "重生", "觉醒",
  "进化", "升级", "超神", "暴走", "开挂", "无双", "绝绝子", "yyds",

  // 形象/外在
  "胖乎乎", "圆滚滚", "软绵绵", "毛茸茸", "热乎乎", "暖洋洋",
  "懒洋洋", "乐呵呵", "笑嘻嘻", "傻乎乎", "呆萌", "蠢萌", "憨憨",
  "笨笨", "萌萌", "嗲嗲", "乖乖", "怂怂", "凶凶", "酷酷", "飒飒",
  "甜甜", "软软", "糯糯", "黏黏", "粘人", "独处", "社交", "宅家",

  // 天气/自然意象
  "晴天", "多云", "微风", "暴雨", "雷电", "彩虹", "星光", "月光",
  "朝阳", "夕阳", "春天", "夏日", "秋风", "冬雪", "花开", "叶落",
  "山间", "海边", "林中", "云上", "雾里", "雨后", "风中", "日出",

  // 食物/味觉
  "酸酸", "辣辣", "苦涩", "清淡", "浓郁", "香喷喷", "热腾腾",
  "凉飕飕", "冰凉", "火热", "温热", "滚烫", "冰镇",

  // 速度/程度
  "飞速", "光速", "秒杀", "极速", "慢吞吞", "不紧不慢", "磨磨蹭蹭",
  "风驰电掣", "健步如飞", "龟速", "蜗牛", "闪电", "迅猛", "猛烈",

  // 有趣的组合词
  "怕老婆", "妻管严", "耙耳朵", "老好人", "老实人", "铁憨憨", "钢铁直",
  "恋爱脑", "工作狂", "完美主义", "强迫症", "拖延症", "选择困难",
  "路痴", "脸盲", "健忘", "话唠", "毒舌", "嘴硬", "心软", "刀子嘴豆腐心",
  "外冷内热", "闷骚", "反差萌", "腹黑", "病娇",
  "元气满满", "能量爆棚", "战斗力爆表", "满级", "初始化", "待机",
  "充电中", "满电", "低电量", "节能模式", "飞行模式", "静音模式",

  // 古风/文言
  "翩翩", "悠悠", "淡淡", "浅浅", "深深", "盈盈", "脉脉", "款款",
  "楚楚", "依依", "恋恋", "眷眷", "殷殷", "切切", "绵绵", "幽幽",
  "寥寥", "落落", "朗朗", "堂堂", "赫赫", "灼灼", "皎皎", "粲粲",

  // 动物意象
  "像猫一样", "像狗一样", "像兔子一样", "像熊一样", "像狐狸一样",
  "像猫头鹰一样", "像海豚一样", "像考拉一样", "像仓鼠一样", "像企鹅一样",

  // 更多性格
  "腼腆", "羞涩", "扭捏", "落落大方", "不拘小节", "心直口快",
  "口是心非", "表里如一", "言行一致", "说到做到", "一诺千金",
  "重情重义", "有情有义", "仗义", "义气", "讲究", "不将就",
  "挑剔", "随意", "随便", "无所谓", "都行", "听你的",
  "我不管", "哼", "嘤嘤嘤", "呜呜呜", "嘻嘻", "哈哈",
  "嘿嘿", "略略略",
] as const;

// Deduplicate (some adjectives appear in multiple categories)
const ADJ_POOL: readonly string[] = [...new Set(ADJECTIVES)];

// ── Animal genus pool ─────────────────────────────────────────
// ~100 recognizable animal genus/common scientific names.
// Sorted by charisma. Each name is unique & short for card display.

const GENUS = [
  // 哺乳类
  "Vulpes",     // 狐
  "Felis",      // 猫
  "Canis",      // 犬
  "Ursus",      // 熊
  "Lynx",       // 猞猁
  "Puma",       // 美洲狮
  "Lepus",      // 兔
  "Lutra",      // 水獭
  "Meles",      // 獾
  "Cervus",     // 鹿
  "Equus",      // 马
  "Capra",      // 山羊
  "Ovis",       // 绵羊
  "Ailurus",    // 小熊猫
  "Mustela",    // 鼬
  "Martes",     // 貂
  "Nasua",      // 浣熊
  "Phoca",      // 海豹
  "Dugong",     // 儒艮
  "Koala",      // 考拉 (Phascolarctos 太长)
  "Panda",      // 大熊猫 (Ailuropoda 太长)
  "Sorex",      // 鼩鼱
  "Talpa",      // 鼹鼠
  "Castor",     // 河狸
  "Sciurus",    // 松鼠
  "Marmota",    // 旱獭
  "Myotis",     // 蝠
  "Delphi",     // 海豚 (Delphinus 缩写)
  "Orca",       // 虎鲸
  "Bison",      // 野牛
  "Tapirus",    // 貘
  "Hyena",      // 鬣狗
  "Lemur",      // 狐猴
  "Gibbon",     // 长臂猿

  // 鸟类
  "Corvus",     // 渡鸦
  "Aquila",     // 鹰
  "Falco",      // 隼
  "Pavo",       // 孔雀
  "Pica",       // 喜鹊
  "Larus",      // 鸥
  "Otus",       // 角鸮
  "Strix",      // 林鸮
  "Ardea",      // 苍鹭
  "Parus",      // 山雀
  "Turdus",     // 鸫
  "Anas",       // 鸭
  "Cygnus",     // 天鹅
  "Grus",       // 鹤
  "Apus",       // 雨燕
  "Picus",      // 啄木鸟
  "Cuculus",    // 杜鹃
  "Mergus",     // 秋沙鸭
  "Bubo",       // 雕鸮
  "Phoeni",     // 火烈鸟 (Phoenicopterus 缩写)
  "Alcedo",     // 翠鸟
  "Hirundo",    // 燕
  "Columba",    // 鸽
  "Perdix",     // 鹧鸪

  // 爬行/两栖
  "Gecko",      // 壁虎
  "Lacerta",    // 蜥蜴
  "Vipera",     // 蝰蛇
  "Testudo",    // 陆龟
  "Rana",       // 蛙
  "Salamand",   // 蝾螈 (Salamandra 缩写)
  "Triton",     // 蝾螈属
  "Iguana",     // 鬣蜥
  "Draco",      // 飞蜥
  "Anolis",     // 变色蜥

  // 鱼类
  "Salmo",      // 鲑鱼
  "Clupea",     // 鲱鱼
  "Gadus",      // 鳕鱼
  "Hippoca",    // 海马 (Hippocampus 缩写)
  "Beta",       // 斗鱼
  "Danio",      // 斑马鱼
  "Syngnath",   // 海龙 (Syngnathus 缩写)

  // 无脊椎
  "Apis",       // 蜜蜂
  "Vespa",      // 胡蜂
  "Bombyx",     // 蚕
  "Morpho",     // 闪蝶
  "Papilio",    // 凤蝶
  "Aranea",     // 蛛
  "Helix",      // 蜗牛
  "Sepia",      // 乌贼
  "Octopus",    // 章鱼
  "Asteria",    // 海星
  "Pagurus",    // 寄居蟹
  "Limulus",    // 鲎
  "Nautilus",   // 鹦鹉螺
  "Mantis",     // 螳螂
  "Gryllus",    // 蟋蟀
  "Cicada",     // 蝉
  "Lucanus",    // 锹甲
  "Dynastes",   // 独角仙
  "Lampyris",   // 萤火虫
  "Libella",    // 蜻蜓
  "Pieris",     // 粉蝶
  "Vanessa",    // 蛱蝶
  "Formica",    // 蚂蚁
  "Scarab",     // 金龟子
] as const;

const GENUS_POOL: readonly string[] = [...GENUS];

// ── Hash function ───────────────────────────────────────────

/** FNV-1a hash — deterministic for any string. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0; // ensure unsigned
}

// ── Newborn pool (for brand-new sessions without sessionId) ─

const NEWBORN = [
  "刚醒来", "初始化", "刚上线", "新生", "刚启动",
  "刚睁眼", "热身中", "准备就绪", "蓄势待发", "整装待发",
  "刚出炉", "新鲜出炉", "满血复活", "元气满满", "蠢蠢欲动",
];

// ── Public API ──────────────────────────────────────────────

/**
 * Get a deterministic session name like "好奇的 Remi·Vulpes" from a sessionId.
 * Uses different bit ranges of the hash for adjective and genus.
 */
export function getSessionName(sessionId: string): string {
  const h = hashString(sessionId);
  const adjIdx = h % ADJ_POOL.length;
  const genusIdx = Math.floor(h / ADJ_POOL.length) % GENUS_POOL.length;
  return `${ADJ_POOL[adjIdx]}的 Remi·${GENUS_POOL[genusIdx]}`;
}

/**
 * Generate a unique session name. If the default name collides with `existing`,
 * rehash with increasing salt until unique.
 */
export function generateUniqueName(sessionId: string, existing: Set<string>): string {
  let name = getSessionName(sessionId);
  if (!existing.has(name)) return name;

  // Collision — rehash with salt
  for (let salt = 1; salt <= 100; salt++) {
    const h = hashString(`${sessionId}:${salt}`);
    const adjIdx = h % ADJ_POOL.length;
    const genusIdx = Math.floor(h / ADJ_POOL.length) % GENUS_POOL.length;
    name = `${ADJ_POOL[adjIdx]}的 Remi·${GENUS_POOL[genusIdx]}`;
    if (!existing.has(name)) return name;
  }

  // Extremely unlikely fallback — append numeric suffix
  return `${getSessionName(sessionId)}#${Date.now() % 10000}`;
}

/** Get a random newborn name for brand-new sessions (no sessionId yet). */
export function getNewbornName(): string {
  const idx = Math.floor(Math.random() * NEWBORN.length);
  return `${NEWBORN[idx]}的 Remi`;
}

/** Pool sizes for debugging. */
export const ADJ_POOL_SIZE = ADJ_POOL.length;
export const GENUS_POOL_SIZE = GENUS_POOL.length;
export const COMBO_SIZE = ADJ_POOL.length * GENUS_POOL.length;
