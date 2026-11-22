// 客户画像优先级配置化 —— 多套可切换 Profile 的单一来源。
// 把散落硬编码的客户画像规则（搜索词/角色/评分权重/池资格/信号）收敛成 profile，
// 改 user_config.json 的 activeProfile 即可切换优先开发哪类客户，改配置不改代码。
//
// 设计原则：
//   - default profile 的每个字段 = 改动前的现有常量（零回归红线）。
//   - getActiveProfile() 惰性读 user_config.json（mtime 缓存），每次调用现读，
//     找不到/非法/异常一律回退 default。
//   - businessStrategy.ts 保留现有导出并改指向 DEFAULT_PROFILE，避免破坏旧 import。
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const CONFIG_FILE = join(__dirname, '..', '..', 'user_config.json')

export interface RiskDeductions {
  giantCompany: number
  governmentOrTender: number
  mandatoryCertification: number
  manufacturerPeer: number
  lowestPriceOnly: number
  noWebsite: number
  personalBuyer: number
  invalidEmail: number
  noEmail: number
  highRiskCountry: number
}

export interface ScoringWeights {
  authenticity: number
  businessMatch: number
  enterpriseValue: number
  riskDeductions: RiskDeductions
}

export interface MarketTier {
  keywords: string[]
  bonus: number
  riskNote?: string
}

export interface MarketTiers {
  tier1: MarketTier
  tier2: MarketTier
  tier3: MarketTier
}

export interface ProfileSignals {
  importer: RegExp
  exclusionPatterns: RegExp
  certificationSignals: RegExp
  giantCompanyKeywords: string[]
  marketTiers: MarketTiers
}

export interface TermHint {
  match: RegExp
  terms: string[]
  reason: string
}

export interface BuyerRoleSpec {
  id: string
  label: string
  query: string
  linkedinTitle: string
  reason: string
}

export interface ProfileConfig {
  /** profile 标识（与 user_config.json activeProfile 一致） */
  id: string
  label: string
  /** 业务线标记（furniture / car-seat 等，话术与业务线预留） */
  primaryBusiness: string
  /** 主攻搜索词：数组（全行业）或 Record<industry, string[]>（default 用行业区分） */
  searchTerms: string[] | Record<string, string[]>
  /** 额外排除串（在现有 giant/peer/platform 排除逻辑基础上追加，拼成 "-term"） */
  excludeTerms: string[]
  /** 搜索角色（genericRoles + 行业 roles） */
  roles: {
    genericRoles: BuyerRoleSpec[]
    industryRoles: Record<string, BuyerRoleSpec[]>
  }
  /** 角色优先级分（行业 → roleId → 分数），对应 leadQueryPlanner.roleMatchScore */
  rolePriority: Record<string, Record<string, number>>
  /** 渠道推荐顺序，对应 leadQueryPlanner.channelRecommendationOrder */
  channelsOrder: Record<string, number>
  /** 客户类型 → 优先级加分（对应 businessStrategy.TARGET_TYPE_PRIORITY，接入 leadScoring 计分） */
  targetTypePriority: Record<string, number>
  /** 是否启用客户类型加分（default 保持现状=不激活；非 default 可激活） */
  applyCustomerTypeBonus: boolean
  /** 评分权重，对应 leadScoring 四模块计分 */
  scoringWeights: ScoringWeights
  /** 允许进开发池/自动通过背调的客户类型（对应 backcheckAutoRouting ALLOWED_TYPES） */
  customerTypesAllowed: string[]
  /** 非买家实体类型，排除出开发池（对应 poolEligibility NON_BUYER_CUSTOMER_TYPES） */
  nonBuyerCustomerTypes: string[]
  /** 信号（排除/认证/进口/巨头/市场分级），default 与现有 businessStrategy 完全一致 */
  signals: ProfileSignals
  /** 行业搜索词提示（expandProductTerms 用；缺省回退 default 提示） */
  termHints?: Record<string, TermHint[]>
}

/** default：严格等于改动前的现有常量（零回归）。 */
export const DEFAULT_PROFILE: ProfileConfig = {
  id: 'default',
  label: '默认（保持现状）',
  primaryBusiness: 'furniture',
  searchTerms: {
    'car-seat': ['car seat covers', 'automotive seat covers', 'custom car seat covers'],
    furniture: [
      'restaurant furniture', 'restaurant chairs', 'restaurant tables',
      'hospitality furniture', 'hotel restaurant furniture',
      'commercial furniture', 'office furniture',
      'cafe furniture', 'cafe seating', 'bistro furniture',
      'bar furniture', 'bar stools', 'bar seating',
      'banquet furniture', 'banquet chairs', 'banquet tables',
      'outdoor restaurant furniture', 'patio furniture commercial',
      'lounge seating hospitality', 'dining table commercial',
      'hotel furniture procurement', 'restaurant furniture procurement',
      'hospitality furniture buyer', 'restaurant furniture RFQ',
      'catering equipment buyer', 'FF&E hotel project',
      'restaurant fit-out furniture', 'hotel renovation furniture project',
      'commercial furniture procurement', 'banquet chairs wholesale buyer',
    ],
  },
  excludeTerms: [],
  roles: {
    genericRoles: [
      { id: 'importer', label: '进口商', query: 'importer', linkedinTitle: 'import manager', reason: '直接进口和供应链采购需求较强' },
      { id: 'distributor', label: '分销商', query: 'distributor', linkedinTitle: 'distribution manager', reason: '有本地销售网络，适合长期供货' },
      { id: 'wholesaler', label: '批发商', query: 'wholesaler', linkedinTitle: 'purchasing manager', reason: '有稳定补货和批量采购需求' },
      { id: 'buyer', label: '采购商', query: 'procurement OR purchasing', linkedinTitle: 'procurement manager', reason: '直接对应采购决策岗位' },
    ],
    industryRoles: {
      furniture: [
        { id: 'hotel-group', label: '酒店集团', query: 'hotel group renovation OR opening', linkedinTitle: 'hotel purchasing manager', reason: '酒店集团开店和翻新集中采购商用家具' },
        { id: 'restaurant-chain', label: '餐饮连锁', query: 'restaurant chain opening OR expansion', linkedinTitle: 'restaurant purchasing manager', reason: '连锁餐饮开店扩张有批量家具采购' },
        { id: 'cafe-franchise', label: '咖啡快消连锁', query: 'cafe franchise new store opening', linkedinTitle: 'cafe franchise operations manager', reason: '咖啡连锁新店开业采购座椅与餐桌' },
        { id: 'qsr', label: '快餐连锁', query: 'fast food chain renovation OR expansion', linkedinTitle: 'quick service restaurant purchasing', reason: '快餐连锁翻新和扩张持续采购耐用家具' },
        { id: 'hospitality', label: '酒店餐饮采购', query: 'hospitality procurement', linkedinTitle: 'hospitality procurement manager', reason: '商用家具常由酒店和餐饮项目集中采购' },
        { id: 'restaurant-group', label: '餐饮连锁', query: 'restaurant group purchasing', linkedinTitle: 'restaurant purchasing manager', reason: '连锁餐饮有开店和翻新采购周期' },
        { id: 'interior-contractor', label: '空间工程商', query: 'interior contractor', linkedinTitle: 'interior project manager', reason: '工程商会为餐饮和酒店项目配套采购' },
      ],
      'car-seat': [
        { id: 'auto-parts', label: '汽配分销商', query: 'automotive accessories distributor', linkedinTitle: 'automotive purchasing manager', reason: '汽车座椅套通常由汽配分销网络销售' },
        { id: 'aftermarket', label: '改装渠道', query: 'car accessories wholesaler', linkedinTitle: 'aftermarket buyer', reason: '改装和售后市场适合标准款与定制款' },
      ],
    },
  },
  rolePriority: {
    furniture: {
      'hotel-group': 98,
      'restaurant-chain': 97,
      qsr: 96,
      'cafe-franchise': 95,
      hospitality: 96,
      'restaurant-group': 93,
      'interior-contractor': 90,
      importer: 84,
      distributor: 81,
      buyer: 76,
      wholesaler: 73,
    },
    'car-seat': {
      'auto-parts': 96,
      aftermarket: 93,
      importer: 84,
      distributor: 81,
      buyer: 76,
      wholesaler: 73,
    },
  },
  channelsOrder: { web: 0, linkedin: 1, maps: 2, news: 3, gleif: 4, wikidata: 5, apify: 6 },
  targetTypePriority: {
    importer: 5,
    distributor: 5,
    wholesaler: 5,
    contract_supplier: 4,
    contractor: 4,
    restaurant_chain: 4,
    retailer: 3,
    dealer: 3,
    ecommerce: 3,
  },
  applyCustomerTypeBonus: false,
  scoringWeights: {
    authenticity: 20,
    businessMatch: 40,
    enterpriseValue: 30,
    riskDeductions: {
      giantCompany: -25,
      governmentOrTender: -50,
      mandatoryCertification: -20,
      manufacturerPeer: -8,
      lowestPriceOnly: -20,
      noWebsite: -10,
      personalBuyer: -20,
      invalidEmail: -30,
      noEmail: -12,
      highRiskCountry: -12,
    },
  },
  customerTypesAllowed: [
    'distributor', 'wholesaler', 'restaurant_supplier', 'restaurant_equipment_supplier',
    'hospitality_group', 'hospitality_customer', 'hotel_group', 'project_contractor',
    'project_procurement', 'restaurant_chain', 'retailer', 'dealer',
  ],
  nonBuyerCustomerTypes: ['directory_news_platform', 'non_buyer_entity'],
  signals: {
    importer: /\bimporter\b|\bimports?\b/i,
    exclusionPatterns: /government|municipal|public project|school district|university|\bcourts?\b|tender|bid|public procurement|auction|public facility/i,
    certificationSignals: /fsc|bifma|esg|certified|certification|iso \d+|global supplier audit|green building|leed/i,
    giantCompanyKeywords: [
      'ikea', 'walmart', 'amazon', 'costco', 'target corporation', 'home depot', 'lowes',
      'wayfair', 'ashley furniture', 'tesla', 'toyota', 'volkswagen', 'bmw', 'mercedes-benz',
      'marriott', 'hilton', 'accor', 'ihg', 'hyatt', 'wyndham', 'intercontinental',
      'four seasons', 'fairmont', 'westin', 'sheraton', 'hospitality giant',
    ],
    marketTiers: {
      tier1: { keywords: ['usa', 'united states', 'canada', 'australia'], bonus: 8 },
      tier2: { keywords: ['uae', 'united arab emirates', 'dubai', 'saudi arabia', 'saudi', 'qatar', 'malaysia'], bonus: 3 },
      tier3: { keywords: ['brazil', 'russia'], bonus: 0, riskNote: '付款/物流风险' },
    },
  },
  termHints: {
    furniture: [
      { match: /booth|banquette|sofa/, terms: ['restaurant booth seating', 'banquette seating', 'commercial booth sofa'], reason: '商用家具的餐饮卡座与酒店软体家具常用叫法' },
      { match: /chair|table|dining/, terms: ['restaurant furniture', 'hospitality furniture', 'commercial dining furniture'], reason: '餐饮、酒店和商业空间采购常用行业词' },
      { match: /restaurant|hotel|cafe|hospitality|booth|chair|table|dining|furniture/, terms: ['restaurant furniture procurement', 'hotel renovation furniture', 'restaurant opening supplies', 'hospitality FF&E procurement', 'restaurant expansion furniture', 'cafe seating order'], reason: '买家采购意图/场景词：运营方开店、翻新、扩张与FF&E采购（term不含supplier词，避免被peerExclusions排除）' },
    ],
    'car-seat': [
      { match: /seat cover|car seat|auto seat/, terms: ['car seat covers', 'automotive seat covers', 'custom car seat covers'], reason: '汽车后市场和汽配渠道常用产品词' },
    ],
  },
}

/** channelA：A类渠道型主力（FF&E公司/工程商/设计/批发），采购决策角色优先。 */
const channelA: ProfileConfig = {
  id: 'channelA',
  label: 'A类渠道型主力（FF&E/工程/设计/批发）',
  primaryBusiness: 'furniture',
  searchTerms: [
    'FF&E company', 'hospitality procurement', 'fit-out contractor',
    'commercial interior contractor', 'hospitality interior designer', 'furniture wholesale',
  ],
  excludeTerms: [],
  roles: {
    genericRoles: DEFAULT_PROFILE.roles.genericRoles,
    industryRoles: {
      furniture: [
        { id: 'procure-manager', label: '采购经理', query: 'procurement manager OR purchasing manager', linkedinTitle: 'procurement manager', reason: '渠道型采购决策人' },
        { id: 'project-manager', label: '项目经理', query: 'project manager OR fit-out manager', linkedinTitle: 'project manager', reason: '工程/翻新项目管理采购' },
        { id: 'owner', label: '企业主', query: 'owner OR founder OR principal', linkedinTitle: 'owner', reason: '中小渠道/设计公司老板决策' },
        { id: 'ff-e-company', label: 'FF&E公司', query: 'FF&E company OR FF&E procurement', linkedinTitle: 'FF&E procurement', reason: '酒店/餐饮FF&E采购执行方' },
        { id: 'fit-out-contractor', label: '装修工程商', query: 'fit-out contractor OR commercial fit out', linkedinTitle: 'fit-out project manager', reason: '餐厅/酒店装修配套采购' },
        { id: 'interior-designer', label: '商业空间设计师', query: 'commercial interior designer', linkedinTitle: 'interior designer', reason: '设计驱动选品与采购' },
        { id: 'furniture-wholesaler', label: '家具批发商', query: 'furniture wholesaler OR wholesale distributor', linkedinTitle: 'wholesale buyer', reason: '大宗转售与项目供货' },
      ],
    },
  },
  rolePriority: {
    furniture: {
      'procure-manager': 98,
      'project-manager': 97,
      owner: 96,
      'ff-e-company': 95,
      'fit-out-contractor': 93,
      'interior-designer': 92,
      'furniture-wholesaler': 91,
      importer: 84,
      distributor: 82,
      buyer: 80,
      wholesaler: 78,
    },
  },
  channelsOrder: DEFAULT_PROFILE.channelsOrder,
  targetTypePriority: {
    procurement_consultant: 10,
    ff_e_company: 9,
    interior_design_firm: 8,
    furniture_wholesaler: 7,
    contractor: 6,
  },
  applyCustomerTypeBonus: true,
  scoringWeights: DEFAULT_PROFILE.scoringWeights,
  customerTypesAllowed: [
    ...DEFAULT_PROFILE.customerTypesAllowed,
    'procurement_consultant', 'ff_e_company', 'interior_design_firm', 'furniture_wholesaler', 'contractor',
  ],
  nonBuyerCustomerTypes: DEFAULT_PROFILE.nonBuyerCustomerTypes,
  signals: DEFAULT_PROFILE.signals,
}

/** enduserB：B类本地餐饮连锁（餐厅/咖啡/烘焙/快餐），业主/采购/运营角色优先。 */
const enduserB: ProfileConfig = {
  id: 'enduserB',
  label: 'B类本地餐饮连锁（餐厅/咖啡/烘焙/快餐）',
  primaryBusiness: 'furniture',
  searchTerms: [
    'restaurant chain', 'cafe chain', 'bakery chain', 'fast food chain', 'local restaurant',
  ],
  excludeTerms: [],
  roles: {
    genericRoles: DEFAULT_PROFILE.roles.genericRoles,
    industryRoles: {
      furniture: [
        { id: 'owner', label: '餐厅老板', query: 'owner OR operator', linkedinTitle: 'owner', reason: '本地餐饮业主直接采购' },
        { id: 'purchasing-manager', label: '采购经理', query: 'purchasing manager OR procurement', linkedinTitle: 'purchasing manager', reason: '连锁餐厅集中采购' },
        { id: 'operations-manager', label: '运营经理', query: 'operations manager', linkedinTitle: 'operations manager', reason: '门店开张/翻新采购执行' },
      ],
    },
  },
  rolePriority: {
    furniture: {
      owner: 98,
      'purchasing-manager': 97,
      'operations-manager': 96,
      importer: 82,
      distributor: 80,
      buyer: 78,
      wholesaler: 75,
    },
  },
  channelsOrder: DEFAULT_PROFILE.channelsOrder,
  targetTypePriority: {
    restaurant_chain: 10,
    cafe_chain: 9,
    independent_restaurant: 8,
    dealer: 6,
  },
  applyCustomerTypeBonus: true,
  scoringWeights: DEFAULT_PROFILE.scoringWeights,
  customerTypesAllowed: [
    'distributor', 'wholesaler', 'restaurant_chain', 'cafe_chain', 'independent_restaurant', 'retailer', 'dealer',
  ],
  nonBuyerCustomerTypes: DEFAULT_PROFILE.nonBuyerCustomerTypes,
  signals: DEFAULT_PROFILE.signals,
}

/** hotelFFE：酒店FF&E专项备用（不主攻酒店集团总部，词里避免集团采购联盟 Avendra/HRS/Procure）。 */
const hotelFFE: ProfileConfig = {
  id: 'hotelFFE',
  label: '酒店FF&E专项备用',
  primaryBusiness: 'furniture',
  searchTerms: [
    'hotel FF&E', 'hospitality furniture procurement', 'hotel renovation', 'hotel furniture project',
  ],
  excludeTerms: ['Avendra', 'HRS hotel', 'Procure'],
  roles: {
    genericRoles: DEFAULT_PROFILE.roles.genericRoles,
    industryRoles: {
      furniture: [
        { id: 'ff-e-company', label: 'FF&E公司', query: 'FF&E procurement OR FF&E company', linkedinTitle: 'FF&E procurement manager', reason: '酒店FF&E项目采购执行方' },
        { id: 'design-firm', label: '设计事务所', query: 'hospitality design firm OR interior design firm', linkedinTitle: 'interior design director', reason: '酒店设计驱动采购' },
        { id: 'hotel-operator-project', label: '酒店运营项目方', query: 'hotel renovation project OR hotel opening project', linkedinTitle: 'hotel project manager', reason: '酒店翻新/开业项目采购（非总部采购联盟）' },
      ],
    },
  },
  rolePriority: {
    furniture: {
      'ff-e-company': 98,
      'design-firm': 97,
      'hotel-operator-project': 96,
      importer: 82,
      distributor: 80,
      buyer: 76,
      wholesaler: 73,
    },
  },
  channelsOrder: DEFAULT_PROFILE.channelsOrder,
  targetTypePriority: {
    ff_e_company: 10,
    design_firm: 9,
    hotel_operator_project: 8,
  },
  applyCustomerTypeBonus: true,
  scoringWeights: DEFAULT_PROFILE.scoringWeights,
  customerTypesAllowed: [
    'distributor', 'wholesaler', 'hotel_group', 'hospitality_group', 'hospitality_customer',
    'project_contractor', 'project_procurement', 'ff_e_company', 'design_firm', 'hotel_operator_project',
  ],
  nonBuyerCustomerTypes: DEFAULT_PROFILE.nonBuyerCustomerTypes,
  signals: DEFAULT_PROFILE.signals,
}

/** restaurantChain：餐饮连锁专项备用（排除独立小店）。 */
const restaurantChain: ProfileConfig = {
  id: 'restaurantChain',
  label: '餐饮连锁专项备用（排除独立小店）',
  primaryBusiness: 'furniture',
  searchTerms: [
    'cafe chain', 'restaurant chain', 'quick service restaurant chain',
  ],
  excludeTerms: ['independent restaurant', 'mom and pop', 'single restaurant'],
  roles: {
    genericRoles: DEFAULT_PROFILE.roles.genericRoles,
    industryRoles: {
      furniture: [
        { id: 'restaurant-chain', label: '餐饮连锁', query: 'restaurant chain opening OR expansion', linkedinTitle: 'restaurant purchasing manager', reason: '连锁餐饮开店扩张批量采购' },
        { id: 'cafe-chain', label: '咖啡连锁', query: 'cafe chain new store opening', linkedinTitle: 'cafe chain purchasing manager', reason: '咖啡连锁新店开业采购' },
        { id: 'qsr-chain', label: '快餐连锁', query: 'quick service restaurant chain OR fast food chain', linkedinTitle: 'qsr purchasing manager', reason: '快餐连锁持续补货翻新' },
      ],
    },
  },
  rolePriority: {
    furniture: {
      'restaurant-chain': 98,
      'cafe-chain': 97,
      'qsr-chain': 96,
      importer: 82,
      distributor: 80,
      buyer: 76,
      wholesaler: 73,
    },
  },
  channelsOrder: DEFAULT_PROFILE.channelsOrder,
  targetTypePriority: {
    restaurant_chain: 10,
    cafe_chain: 9,
  },
  applyCustomerTypeBonus: true,
  scoringWeights: DEFAULT_PROFILE.scoringWeights,
  customerTypesAllowed: [
    'distributor', 'wholesaler', 'restaurant_chain', 'cafe_chain', 'retailer', 'dealer',
  ],
  nonBuyerCustomerTypes: ['directory_news_platform', 'non_buyer_entity', 'independent_restaurant'],
  signals: DEFAULT_PROFILE.signals,
}

/** coreAB：主公 08-18 主力搜索方向组合 —— channelA（渠道型）+ enduserB（本地餐饮连锁）的并集。
 *  主力搜索只做这两类客户，其他画像暂不开发（周期长、无有效订单）；已进池客户照常开发，不受影响。 */
const coreAB: ProfileConfig = {
  id: 'coreAB',
  label: '组合主力（渠道型A + 本地餐饮连锁B）',
  primaryBusiness: 'furniture',
  // channelA 词 + enduserB 词 合并去重（无重复，11 条）
  searchTerms: [
    // channelA 渠道型词
    'FF&E company', 'hospitality procurement', 'fit-out contractor',
    'commercial interior contractor', 'hospitality interior designer', 'furniture wholesale',
    // enduserB 本地餐饮连锁词
    'restaurant chain', 'cafe chain', 'bakery chain', 'fast food chain', 'local restaurant',
  ],
  excludeTerms: [],
  roles: {
    genericRoles: DEFAULT_PROFILE.roles.genericRoles,
    industryRoles: {
      furniture: [
        // channelA 渠道型角色
        { id: 'procure-manager', label: '采购经理', query: 'procurement manager OR purchasing manager', linkedinTitle: 'procurement manager', reason: '渠道型采购决策人' },
        { id: 'project-manager', label: '项目经理', query: 'project manager OR fit-out manager', linkedinTitle: 'project manager', reason: '工程/翻新项目管理采购' },
        { id: 'ff-e-company', label: 'FF&E公司', query: 'FF&E company OR FF&E procurement', linkedinTitle: 'FF&E procurement', reason: '酒店/餐饮FF&E采购执行方' },
        { id: 'fit-out-contractor', label: '装修工程商', query: 'fit-out contractor OR commercial fit out', linkedinTitle: 'fit-out project manager', reason: '餐厅/酒店装修配套采购' },
        { id: 'interior-designer', label: '商业空间设计师', query: 'commercial interior designer', linkedinTitle: 'interior designer', reason: '设计驱动选品与采购' },
        { id: 'furniture-wholesaler', label: '家具批发商', query: 'furniture wholesaler OR wholesale distributor', linkedinTitle: 'wholesale buyer', reason: '大宗转售与项目供货' },
        // enduserB 本地餐饮连锁角色（owner 两边共有，取 enduserB 口径：本地餐饮业主直接采购）
        { id: 'owner', label: '餐厅老板', query: 'owner OR operator', linkedinTitle: 'owner', reason: '本地餐饮业主直接采购' },
        { id: 'purchasing-manager', label: '采购经理', query: 'purchasing manager OR procurement', linkedinTitle: 'purchasing manager', reason: '连锁餐厅集中采购' },
        { id: 'operations-manager', label: '运营经理', query: 'operations manager', linkedinTitle: 'operations manager', reason: '门店开张/翻新采购执行' },
      ],
    },
  },
  // channelA + enduserB 并集去重（owner/importer/distributor/buyer/wholesaler 重叠取较高分值）
  rolePriority: {
    furniture: {
      'procure-manager': 98,
      'project-manager': 97,
      'purchasing-manager': 97,
      owner: 98,
      'operations-manager': 96,
      'ff-e-company': 95,
      'fit-out-contractor': 93,
      'interior-designer': 92,
      'furniture-wholesaler': 91,
      importer: 84,
      distributor: 82,
      buyer: 80,
      wholesaler: 78,
    },
  },
  channelsOrder: DEFAULT_PROFILE.channelsOrder,
  // 渠道型 A 档（参照 channelA，分值最高）+ 本地餐饮连锁 B 档（参照 enduserB，档位次之）
  targetTypePriority: {
    procurement_consultant: 10,
    ff_e_company: 9,
    interior_design_firm: 8,
    furniture_wholesaler: 7,
    contractor: 6,
    restaurant_chain: 9,
    cafe_chain: 8,
    independent_restaurant: 7,
    dealer: 5,
  },
  applyCustomerTypeBonus: true,
  scoringWeights: DEFAULT_PROFILE.scoringWeights,
  // default 允许类型 + channelA 扩展 + enduserB 扩展 并集去重
  customerTypesAllowed: [
    'distributor', 'wholesaler', 'restaurant_supplier', 'restaurant_equipment_supplier',
    'hospitality_group', 'hospitality_customer', 'hotel_group', 'project_contractor',
    'project_procurement', 'restaurant_chain', 'retailer', 'dealer',
    'procurement_consultant', 'ff_e_company', 'interior_design_firm', 'furniture_wholesaler', 'contractor',
    'cafe_chain', 'independent_restaurant',
  ],
  nonBuyerCustomerTypes: DEFAULT_PROFILE.nonBuyerCustomerTypes,
  signals: DEFAULT_PROFILE.signals,
}

export const PROFILES: Record<string, ProfileConfig> = {
  default: DEFAULT_PROFILE,
  channelA,
  enduserB,
  hotelFFE,
  restaurantChain,
  coreAB,
}

let cache: { mtimeMs: number; id: string } | null = null

/** 惰性读取当前生效 profile：每次调用现读 user_config.json（mtime 缓存防重复解析），
 *  找不到/非法/异常一律回退 default。 */
export function getActiveProfile(): ProfileConfig {
  try {
    const st = statSync(CONFIG_FILE)
    if (cache && cache.mtimeMs === st.mtimeMs) {
      return PROFILES[cache.id] || DEFAULT_PROFILE
    }
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as { activeProfile?: unknown }
    const id = cfg && typeof cfg.activeProfile === 'string' && cfg.activeProfile ? cfg.activeProfile : 'default'
    cache = { mtimeMs: st.mtimeMs, id }
    return PROFILES[id] || DEFAULT_PROFILE
  } catch {
    return DEFAULT_PROFILE
  }
}

/** 从 profile 解析搜索词（支持数组全行业 / Record<industry, string[]> 行业区分）。 */
export function resolveSearchTerms(profile: ProfileConfig, industry: string): string[] {
  const raw = profile.searchTerms
  if (Array.isArray(raw)) return raw
  const normalized = String(industry || '').toLowerCase()
  const key = normalized.includes('car') || normalized.includes('seat') ? 'car-seat' : 'furniture'
  return raw[key] || raw['default'] || []
}
