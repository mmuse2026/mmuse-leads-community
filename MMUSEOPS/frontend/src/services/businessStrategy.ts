// 商用餐饮家具外贸客户开发定位策略 —— 策略配置单一来源已迁移到 profiles.ts（default profile）。
// 本文件保留原有导出名，值 = DEFAULT_PROFILE 对应字段，保证旧 import 不变、default 零回归。
import { DEFAULT_PROFILE } from './profiles'

/** 客户类型→优先级分（dead 配置，接入计分见 leadScoring 的 profile.applyCustomerTypeBonus） */
export const TARGET_TYPE_PRIORITY: Record<string, number> = DEFAULT_PROFILE.targetTypePriority

export const IMPORTER_SIGNALS = DEFAULT_PROFILE.signals.importer

export const EXCLUSION_PATTERNS = DEFAULT_PROFILE.signals.exclusionPatterns

export const CERTIFICATION_SIGNALS = DEFAULT_PROFILE.signals.certificationSignals

// 大型国际集团总部采购（要求 FSC/BIFMA/ESG/全球供应商审核）→ 排除；不含普通餐厅/酒店客户
export const GIANT_COMPANY_KEYWORDS = DEFAULT_PROFILE.signals.giantCompanyKeywords

export const MARKET_TIERS = DEFAULT_PROFILE.signals.marketTiers

export const SCORING_WEIGHTS = DEFAULT_PROFILE.scoringWeights
