/**
 * 地理位置解析（离线，无外部 API 依赖）
 * - 内置中国主要城市经纬度
 * - 计算真太阳时偏差（经度时差 + 均时差）
 * - 磁偏角给近似值（以当地实测为准）
 */

export interface GeoInfo {
  name: string;
  lat: number;
  lon: number;
  /** 相对北京时间的经度时差（分钟）。负值表示当地比北京时间早，即在 120°E 以西。 */
  lonOffsetMin: number;
  /** 均时差（分钟） */
  eotMin: number;
  /** 真太阳时相对北京时间的总偏差（分钟） */
  trueSolarOffsetMin: number;
  /** 磁偏角近似值（度，东偏正/西偏负） */
  declination: number;
  region: string;
  note: string;
}

/** 城市 → [纬度, 经度, 省份] */
const CITIES: Record<string, [number, number, string]> = {
  北京: [39.9042, 116.4074, "北京"],
  上海: [31.2304, 121.4737, "上海"],
  天津: [39.0842, 117.2009, "天津"],
  重庆: [29.5630, 106.5516, "重庆"],
  广州: [23.1291, 113.2644, "广东"],
  深圳: [22.5431, 114.0579, "广东"],
  珠海: [22.2707, 113.5767, "广东"],
  东莞: [23.0207, 113.7518, "广东"],
  佛山: [23.0218, 113.1219, "广东"],
  中山: [22.5176, 113.3928, "广东"],
  惠州: [23.1115, 114.4162, "广东"],
  汕头: [23.3540, 116.6819, "广东"],
  湛江: [21.2707, 110.3594, "广东"],
  韶关: [24.8102, 113.5972, "广东"],
  梅州: [24.2886, 116.1176, "广东"],
  成都: [30.5728, 104.0668, "四川"],
  绵阳: [31.4675, 104.6796, "四川"],
  德阳: [31.1270, 104.3980, "四川"],
  宜宾: [28.7513, 104.6430, "四川"],
  泸州: [28.8717, 105.4433, "四川"],
  南充: [30.8373, 106.1107, "四川"],
  乐山: [29.5521, 103.7660, "四川"],
  杭州: [30.2741, 120.1551, "浙江"],
  宁波: [29.8683, 121.5440, "浙江"],
  温州: [27.9938, 120.6994, "浙江"],
  绍兴: [30.0300, 120.5800, "浙江"],
  嘉兴: [30.7522, 120.7500, "浙江"],
  金华: [29.0784, 119.6474, "浙江"],
  台州: [28.6560, 121.4207, "浙江"],
  湖州: [30.8930, 120.0867, "浙江"],
  南京: [32.0603, 118.7969, "江苏"],
  苏州: [31.2989, 120.5853, "江苏"],
  无锡: [31.4912, 120.3119, "江苏"],
  常州: [31.8107, 119.9741, "江苏"],
  南通: [31.9802, 120.8943, "江苏"],
  徐州: [34.2044, 117.2858, "江苏"],
  扬州: [32.3942, 119.4129, "江苏"],
  盐城: [33.3496, 120.1616, "江苏"],
  镇江: [32.1878, 119.4250, "江苏"],
  泰州: [32.4555, 119.9230, "江苏"],
  武汉: [30.5928, 114.3055, "湖北"],
  宜昌: [30.6919, 111.2865, "湖北"],
  襄阳: [32.0090, 112.1220, "湖北"],
  荆州: [30.3350, 112.2397, "湖北"],
  黄石: [30.2000, 115.0389, "湖北"],
  十堰: [32.6292, 110.7980, "湖北"],
  西安: [34.3416, 108.9398, "陕西"],
  宝鸡: [34.3619, 107.2373, "陕西"],
  咸阳: [34.3299, 108.7088, "陕西"],
  渭南: [34.4994, 109.5026, "陕西"],
  延安: [36.5853, 109.4899, "陕西"],
  榆林: [38.2852, 109.7347, "陕西"],
  汉中: [33.0675, 107.0236, "陕西"],
  安康: [32.6851, 109.0292, "陕西"],
  长沙: [28.2282, 112.9388, "湖南"],
  株洲: [27.8274, 113.1340, "湖南"],
  湘潭: [27.8297, 112.9445, "湖南"],
  衡阳: [26.8933, 112.5719, "湖南"],
  岳阳: [29.3573, 113.1289, "湖南"],
  常德: [29.0316, 111.6984, "湖南"],
  郴州: [25.7706, 113.0149, "湖南"],
  郑州: [34.7466, 113.6254, "河南"],
  洛阳: [34.6197, 112.4540, "河南"],
  开封: [34.7971, 114.3076, "河南"],
  新乡: [35.3027, 113.9268, "河南"],
  南阳: [32.9908, 112.5283, "河南"],
  许昌: [34.0357, 113.8520, "河南"],
  济南: [36.6512, 117.1201, "山东"],
  青岛: [36.0671, 120.3826, "山东"],
  烟台: [37.4638, 121.4479, "山东"],
  潍坊: [36.7069, 119.1618, "山东"],
  临沂: [35.1045, 118.3564, "山东"],
  淄博: [36.8131, 118.0548, "山东"],
  济宁: [35.4150, 116.5871, "山东"],
  泰安: [36.1996, 117.0876, "山东"],
  威海: [37.5128, 122.1205, "山东"],
  沈阳: [41.8057, 123.4315, "辽宁"],
  大连: [38.9140, 121.6147, "辽宁"],
  鞍山: [41.1086, 122.9946, "辽宁"],
  抚顺: [41.8807, 123.9573, "辽宁"],
  锦州: [41.0953, 121.1270, "辽宁"],
  营口: [40.6670, 122.2350, "辽宁"],
  长春: [43.8171, 125.3235, "吉林"],
  吉林: [43.8378, 126.5496, "吉林"],
  四平: [43.1664, 124.3504, "吉林"],
  哈尔滨: [45.8038, 126.5349, "黑龙江"],
  齐齐哈尔: [47.3543, 123.9180, "黑龙江"],
  大庆: [46.5891, 125.1036, "黑龙江"],
  牡丹江: [44.5514, 129.6330, "黑龙江"],
  佳木斯: [46.7997, 130.3189, "黑龙江"],
  石家庄: [38.0428, 114.5149, "河北"],
  唐山: [39.6304, 118.1804, "河北"],
  保定: [38.8740, 115.4646, "河北"],
  邯郸: [36.6253, 114.5391, "河北"],
  廊坊: [39.5376, 116.6836, "河北"],
  秦皇岛: [39.9354, 119.6005, "河北"],
  沧州: [38.3037, 116.8388, "河北"],
  太原: [37.8706, 112.5489, "山西"],
  大同: [40.0768, 113.2950, "山西"],
  临汾: [36.0880, 111.5190, "山西"],
  运城: [35.0263, 111.0039, "山西"],
  合肥: [31.8206, 117.2272, "安徽"],
  芜湖: [31.3525, 118.4331, "安徽"],
  蚌埠: [32.9163, 117.3892, "安徽"],
  安庆: [30.5433, 117.0639, "安徽"],
  福州: [26.0745, 119.2965, "福建"],
  厦门: [24.4798, 118.0894, "福建"],
  泉州: [24.8741, 118.6757, "福建"],
  漳州: [24.5130, 117.6473, "福建"],
  莆田: [25.4310, 119.0078, "福建"],
  南昌: [28.6820, 115.8579, "江西"],
  赣州: [25.8310, 114.9350, "江西"],
  九江: [29.7050, 116.0020, "江西"],
  上饶: [28.4544, 117.9432, "江西"],
  昆明: [25.0389, 102.7183, "云南"],
  曲靖: [25.4900, 103.7961, "云南"],
  大理: [25.6065, 100.2676, "云南"],
  丽江: [26.8721, 100.2330, "云南"],
  西双版纳: [22.0017, 100.7978, "云南"],
  贵阳: [26.6470, 106.6302, "贵州"],
  遵义: [27.7256, 106.9272, "贵州"],
  南宁: [22.8170, 108.3665, "广西"],
  桂林: [25.2736, 110.2900, "广西"],
  柳州: [24.3264, 109.4281, "广西"],
  北海: [21.4813, 109.1200, "广西"],
  海口: [20.0442, 110.1999, "海南"],
  三亚: [18.2528, 109.5119, "海南"],
  兰州: [36.0611, 103.8343, "甘肃"],
  天水: [34.5809, 105.7249, "甘肃"],
  酒泉: [39.7325, 98.4941, "甘肃"],
  张掖: [38.9259, 100.4498, "甘肃"],
  武威: [37.9283, 102.6380, "甘肃"],
  嘉峪关: [39.7720, 98.2890, "甘肃"],
  西宁: [36.6171, 101.7782, "青海"],
  银川: [38.4872, 106.2309, "宁夏"],
  乌鲁木齐: [43.8256, 87.6168, "新疆"],
  克拉玛依: [45.5799, 84.8892, "新疆"],
  喀什: [39.4704, 75.9898, "新疆"],
  伊宁: [43.9169, 81.3241, "新疆"],
  库尔勒: [41.7258, 86.1746, "新疆"],
  拉萨: [29.6520, 91.1721, "西藏"],
  日喀则: [29.2690, 88.8804, "西藏"],
  林芝: [29.6489, 94.3615, "西藏"],
  呼和浩特: [40.8424, 111.7490, "内蒙古"],
  包头: [40.6574, 109.8403, "内蒙古"],
  鄂尔多斯: [39.6086, 109.7810, "内蒙古"],
  赤峰: [42.2586, 118.8880, "内蒙古"],
  香港: [22.3193, 114.1694, "香港"],
  澳门: [22.1987, 113.5439, "澳门"],
  台北: [25.0330, 121.5654, "台湾"],
  台中: [24.1477, 120.6736, "台湾"],
  高雄: [22.6273, 120.3014, "台湾"],
};

const SUFFIX = /(特别行政区|自治区|自治州|地区|市辖区|新区|城区|市|县|区|镇|街道)$/;

function normalizeName(q: string): string {
  let s = q.trim().replace(/\s+/g, "");
  s = s.replace(SUFFIX, "");
  return s;
}

/** 均时差（分钟），N 为一年中的第几天 */
function equationOfTime(dayOfYear: number): number {
  const B = (360 / 364) * (dayOfYear - 81) * (Math.PI / 180);
  return 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
}

function dayOfYear(d = new Date()): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  return Math.floor((d.getTime() - start) / 86400000);
}

/** 磁偏角近似（中国区域经验拟合，误差约 ±2°，仅供提示） */
function approxDeclination(lat: number, lon: number): number {
  // 东部约 -5°~-6°，西部约 +1°~+2°，随经度变化
  const base = -6 + (lon - 120) * 0.12;
  const latAdj = (lat - 35) * 0.05;
  return Math.round((base + latAdj) * 10) / 10;
}

export function resolveLocation(query: string): GeoInfo | null {
  if (!query) return null;
  const raw = query.trim();
  const norm = normalizeName(raw);

  let name: string | null = null;
  let coords: [number, number, string] | null = null;

  // 只认自有属性。直接写 CITIES[raw] 的话，"toString" 这类输入会拿到 Object.prototype 上的函数。
  const known = (k: string) => (Object.hasOwn(CITIES, k) ? k : null);
  const direct = known(raw) ?? known(norm);
  if (direct) { name = direct; coords = CITIES[direct]; }
  else {
    // 包含匹配（"我在西安雁塔区" → 西安）
    for (const key of Object.keys(CITIES)) {
      if (raw.includes(key)) {
        if (!coords || key.length > name!.length) {
          name = key;
          coords = CITIES[key];
        }
      }
    }
  }
  if (!coords || !name) return null;
  const [lat, lon, region] = coords;
  return geoFromCoords(name, lat, lon, region);
}

/** 用坐标现算真太阳时。中国境内才给磁偏角近似，境外写明未校正。 */
export function geoFromCoords(name: string, lat: number, lon: number, region = ""): GeoInfo {
  const lonOffsetMin = Math.round((lon - 120) * 4);
  const eotMin = Math.round(equationOfTime(dayOfYear()) * 10) / 10;
  const trueSolarOffsetMin = Math.round(lonOffsetMin + eotMin);
  const inChina = lat > 18 && lat < 54 && lon > 73 && lon < 135;
  const declination = inChina ? approxDeclination(lat, lon) : 0;
  const note = inChina
    ? `当地真太阳时 = 北京时间 ${trueSolarOffsetMin >= 0 ? "+" : ""}${trueSolarOffsetMin} 分钟；磁偏角约 ${declination}°（罗盘读数需按当地实测修正，此值为近似）。`
    : `当地真太阳时 = 北京时间 ${trueSolarOffsetMin >= 0 ? "+" : ""}${trueSolarOffsetMin} 分钟；此处不在中国境内，磁偏角未校正，以手机指南针实测为准。`;
  return { name, lat, lon, lonOffsetMin, eotMin, trueSolarOffsetMin, declination, region, note };
}

function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 6371;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 坐标落在某城市附近才吸附，避免把海外位置硬配到中国城市。 */
export function nearestCity(lat: number, lon: number, maxKm = 160): GeoInfo | null {
  let bestName = "";
  let bestD = Infinity;
  for (const key of Object.keys(CITIES)) {
    const [clat, clon] = CITIES[key];
    const d = distanceKm(lat, lon, clat, clon);
    if (d < bestD) {
      bestD = d;
      bestName = key;
    }
  }
  if (!bestName || bestD > maxKm) return null;
  return resolveLocation(bestName);
}

const EN_ALIAS: Record<string, string> = {
  beijing: "北京", shanghai: "上海", tianjin: "天津", chongqing: "重庆",
  guangzhou: "广州", shenzhen: "深圳", hangzhou: "杭州", ningbo: "宁波",
  nanjing: "南京", suzhou: "苏州", wuxi: "无锡", wuhan: "武汉", chengdu: "成都",
  xian: "西安", "xi'an": "西安", changsha: "长沙", zhengzhou: "郑州",
  qingdao: "青岛", jinan: "济南", dalian: "大连", shenyang: "沈阳",
  harbin: "哈尔滨", kunming: "昆明", guiyang: "贵阳", nanning: "南宁",
  haikou: "海口", sanya: "三亚", lanzhou: "兰州", xining: "西宁",
  yinchuan: "银川", urumqi: "乌鲁木齐", lhasa: "拉萨",
  hohhot: "呼和浩特", huhhot: "呼和浩特",
  "hong kong": "香港", hongkong: "香港", macau: "澳门", macao: "澳门",
  taipei: "台北", taichung: "台中", kaohsiung: "高雄",
  fuzhou: "福州", xiamen: "厦门", hefei: "合肥", nanchang: "南昌",
  shijiazhuang: "石家庄", taiyuan: "太原", changchun: "长春", wenzhou: "温州",
};

/** Cloudflare 给的英文城市名，对上表内城市。对不上就返回空。 */
export function resolveEnglishCity(name: string): GeoInfo | null {
  const key = name.trim().toLowerCase().replace(/\s+/g, " ");
  const alias = (k: string) => (Object.hasOwn(EN_ALIAS, k) ? EN_ALIAS[k] : undefined);
  const zh = alias(key) ?? alias(key.replace(/\s+/g, ""));
  return zh ? resolveLocation(zh) : null;
}

/** 给提示词用的地理描述 */
export function geoPromptBlock(g: GeoInfo): string {
  return `【地理位置】
城市：${g.name}（${g.region}）
坐标：${g.lat.toFixed(3)}°N, ${g.lon.toFixed(3)}°E
真太阳时：北京时间 ${g.trueSolarOffsetMin >= 0 ? "+" : ""}${g.trueSolarOffsetMin} 分钟（算时辰、择日要用真太阳时）
磁偏角：约 ${g.declination}°（罗盘读数的修正值，近似）
说明：经纬度只用来校方位和真太阳时，不要据此编黄历。书里写了的做法按书中原文；书里没有的生活步骤写入 daily，并标明不是书中依据。`;
}

/** 从一段文字里找出城市名（取最长匹配） */
export function findLocationInText(text: string): GeoInfo | null {
  if (!text) return null;
  let best: string | null = null;
  for (const key of Object.keys(CITIES)) {
    if (text.includes(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? resolveLocation(best) : null;
}

/** 列出可识别的城市（给前端自动补全用） */
export function listCities(): string[] {
  return Object.keys(CITIES);
}
