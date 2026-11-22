import { SIGNATURE_EN, SIGNATURE_CN } from '../services/emailSignature'
/**
 * @deprecated 静态模板草稿生成器（无评分/无校验），与 tools 校验管线
 * （generate_drafts_0807 / validate_drafts_0807：score>=8、标题<=10词、禁AI词）是两套标准。
 * 仍被 server/search-api.ts（不可改动）与测试引用，暂保留不删。
 * 新草稿一律走 tools 校验管线，后续移除 search-api.ts 的依赖后再删除本文件。
 */
import type { PipelineItem, EmailLog } from '../types/item'
import { getLanguageByCountry } from '../services/translateService'
import { classifyRoleLocalPart, roleEmailClass } from '../services/emailClassification'

interface EmailDraft {
  itemId: string
  to: string
  subject: string
  body: string
  subjectCn: string
  bodyCn: string
  targetLang: string
  targetLangLabel: string
}


function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map(value => value.trim()).filter(Boolean) : []
}

function product(item: PipelineItem): string {
  const researched = textList(item.backCheck?.products || (item.backCheck as any)?.mainProducts)[0]
  if (researched) return researched
  if (item.businessLine === 'car-seat') return 'car seat covers'
  if (item.businessLine === 'lighting') return 'LED lighting products'
  if (item.businessLine === 'packaging') return 'packaging solutions'
  return 'commercial furniture'
}

function productCn(item: PipelineItem): string {
  if (item.businessLine === 'car-seat') return '汽车座椅套'
  if (item.businessLine === 'lighting') return 'LED照明产品'
  if (item.businessLine === 'packaging') return '包装方案'
  return '商用家具'
}

function indirect(item: PipelineItem): boolean {
  return /top\s*\d+|directory|yellow\s*pages?|news|blog|article|supplier\s*list/i
    .test([item.company, item.title, item.snippet, item.website].filter(Boolean).join(' '))
}

/** 背调摘要常以公司名开头，直接拼接会导致公司名重复（如 "Accor Accor"）。归一化比对后去掉重复前缀再拼接。 */
function dedupeCompanyPrefix(text: string, company: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '')
  const normCompany = norm(company)
  if (!normCompany) return text
  const leadingArticle = text.match(/^(?:the|a|an)\s+/i)?.[0] || ''
  const candidateText = leadingArticle ? text.slice(leadingArticle.length) : text
  const normText = norm(candidateText)
  // 摘要常以公司名缩写/首词开头（如全名 "Dodo Brands International" 的摘要以 "Dodo Brands is..." 开头），
  // 仅剥全名前缀剥不掉。候选前缀按从长到短：公司全名 → 前2个词 → 前1个词。
  const words = company.trim().split(/\s+/).filter(Boolean)
  const candidates = [normCompany]
  if (words.length >= 2) candidates.push(norm(words.slice(0, 2).join(' ')))
  if (words.length >= 1) candidates.push(norm(words[0]))
  for (const candidate of [...new Set(candidates)]) {
    if (!candidate || normText.indexOf(candidate) !== 0) continue
    let acc = ''
    let cut = 0
    for (let i = 0; i < candidateText.length; i++) {
      const c = candidateText[i].toLowerCase()
      if (/[a-z0-9\u4e00-\u9fa5]/.test(c)) {
        acc += c
        if (acc === candidate) {
          cut = i + 1
          break
        }
      }
    }
    return candidateText.slice(cut).replace(/^[^a-zA-Z0-9\u4e00-\u9fa5]+/, '')
  }
  return text
}

/** contactName 只接受可打印 ASCII 名称字符，避免乱码称呼（如 "Hi ???????????"）。 */
function isValidName(name: string): boolean {
  if (!/[A-Za-z]/.test(name)) return false
  return /^[A-Za-z .'\/,-]+$/.test(name)
}

/** 从已发送邮件正文首行提取称呼（"Hi Cem," / "Hello Cordel," / "Dear Sunday,"），过滤掉团队/泛指称呼。 */
function nameFromLog(log?: EmailLog | null): string {
  const firstLine = String(log?.body || '').split(/\r?\n/)[0].trim()
  const matched = firstLine.match(/^(?:hi|hello|dear)\s+(.+?)\s*[,，]/i)
  if (!matched) return ''
  const raw = matched[1].trim()
  if (!raw || /\b(?:team|there|sir|madam)\b/i.test(raw)) return ''
  return isValidName(raw) ? raw : ''
}

function safeName(item: PipelineItem, lastLog?: EmailLog): string {
  const selectedEmail = String(item.selectedEmail || '').trim().toLowerCase()
  const contacts = Array.isArray((item as any).contacts) ? (item as any).contacts : []
  const matched = contacts.find((contact: any) => String(contact?.email || '').trim().toLowerCase() === selectedEmail)
  const fromContacts = String(matched?.name || '').trim()
  if (isValidName(fromContacts)) return fromContacts

  const fromLastLog = nameFromLog(lastLog)
  if (fromLastLog) return fromLastLog

  // Snovio 抓取的 contacts 往往只有 email；回溯该收件人最近一封能解析出有效称呼的已发送邮件。
  const logs = Array.isArray((item as any).emailLogs) ? (item as any).emailLogs as EmailLog[] : []
  const relatedLogs = logs
    .filter(log => String(log?.recipientEmail || log?.to || '').trim().toLowerCase() === selectedEmail)
    .sort((a, b) => String(b?.sentAt || '').localeCompare(String(a?.sentAt || '')))
  for (const log of relatedLogs) {
    const fromLog = nameFromLog(log)
    if (fromLog) return fromLog
  }

  if (!contacts.length) {
    const raw = String(item.contactName || '').trim()
    if (isValidName(raw)) return raw
  }
  return 'Team'
}

/** company 常是网页标题（如 "Montalbano Dubai: Premium Italian & Euro"），去掉标题尾巴后再用于主题和正文。 */
function displayCompanyName(item: PipelineItem): string {
  const raw = String(item.company || item.title || '').trim()
  if (!raw) return raw
  let name = raw.split(/\s*[|–—]\s*|\s+-\s+/)[0].trim()
  const colonIndex = name.indexOf(':')
  if (colonIndex > 0) {
    const tail = name.slice(colonIndex + 1)
    if (/premium|supplier|manufacturer|furniture|furnishings|solutions|contract|commercial|wholesale|best|top|home|store|restaurant|hotel/i.test(tail)) {
      name = name.slice(0, colonIndex).trim()
    }
  }
  return name || raw
}

function backgroundLine(item: PipelineItem): string {
  const summary = dedupeCompanyPrefix(String(item.backCheck?.summary || '').trim().replace(/\s+/g, ' '), item.company)
  const firstSentence = summary.match(/^(.+?[.!?])(?:\s|$)/)?.[1]
  const summaryLooksHardTruncated = summary.length >= 118 && firstSentence?.length === summary.length
  if (firstSentence && firstSentence.length <= 220 && !summaryLooksHardTruncated) {
    const descriptor = firstSentence.replace(/[.!?]+$/, '').trim()
    const sentenceDescriptor = descriptor.replace(/^(a|an|the|is|are|was|were|has|have|offers|supplies|provides|manufactures|speciali[sz]es|operates|serves|focuses|distributes|designs|sources|procures|purchases|buys|retails|wholesales)\b/i, value => value.toLowerCase())
    if (/^(?:is|are|was|were|has|have|offers|supplies|provides|manufactures|speciali[sz]es|operates|serves|focuses|distributes|designs|sources|procures|purchases|buys|retails|wholesales)\b/i.test(sentenceDescriptor)) {
      return `I noticed that ${item.company} ${sentenceDescriptor}.`
    }
    if (/^(?:a|an|the)\b/i.test(sentenceDescriptor)) return `I noticed that ${item.company} is ${sentenceDescriptor}.`
    const firstWord = sentenceDescriptor.split(/\s+/)[0]
    const startsWithYooSound = /^(?:u(?:k|ae|s|niversity|ser|seful)|european|euro)/i.test(firstWord)
    const startsWithSilentH = /^(?:honest|hour|heir)/i.test(firstWord)
    const article = startsWithSilentH || !startsWithYooSound && /^[aeiou]/i.test(sentenceDescriptor) ? 'an' : 'a'
    return `I noticed that ${item.company} is ${article} ${sentenceDescriptor}.`
  }
  const industry = String(item.backCheck?.industry || '').trim()
  if (industry) return `I noticed that ${item.company} works in the ${industry} sector.`
  const researchedProducts = textList(item.backCheck?.products || (item.backCheck as any)?.mainProducts).slice(0, 2)
  if (researchedProducts.length) return `I noticed that ${item.company} works with ${researchedProducts.join(' and ')}.`
  return `I came across ${item.company} while researching potential business partners.`
}

function backgroundLineCn(item: PipelineItem): string {
  const summary = dedupeCompanyPrefix(String(item.backCheck?.summary || '').trim().replace(/\s+/g, ' '), item.company)
  const firstSentence = summary.match(/^(.+?[.!?。])(?:\s|$)/)?.[1]
  const summaryLooksHardTruncated = summary.length >= 118 && firstSentence?.length === summary.length
  if (firstSentence && firstSentence.length <= 220 && !summaryLooksHardTruncated) {
    return `了解到${item.company}${firstSentence.replace(/[.!?。]+$/, '')}。`
  }
  const researchedProduct = textList(item.backCheck?.products || (item.backCheck as any)?.mainProducts)[0]
  if (researchedProduct) return `了解到${item.company}经营${researchedProduct}。`
  return `我们在寻找潜在合作伙伴时关注到${item.company}。`
}

function followupContextCn(item: PipelineItem): string {
  const industry = String(item.backCheck?.industry || '').trim()
  if (industry) return `了解到${item.company}属于${industry}领域。`
  const researchedProduct = textList(item.backCheck?.products || (item.backCheck as any)?.mainProducts)[0]
  if (researchedProduct) return `了解到${item.company}经营${researchedProduct}。`
  return `想就家具采购与${item.company}重新联系。`
}

export type BuyerSegment = 'operator' | 'channel' | 'unknown'

/** 渠道商（分销/批发/贸易/零售等）特征词 —— 更具体，判定时优先 */
const CHANNEL_PATTERN = /\b(?:distributor|wholesaler|importer|trading|dealer|retailer|reseller|agent|broker|furniture store|showroom|e-commerce|online store|store|shop|marketplace|(?:supply|supplies|supplier)\s+(?:commercial\s+|hospitality\s+|office\s+)?furniture|furnishings?\s+(?:supplier|retailer|wholesaler|distributor))\b/i
/** 运营商买家（餐厅/酒店/咖啡/连锁等实际采购方）特征词 */
const OPERATOR_PATTERN = /\b(?:restaurant|cafe|coffee shop|hotel|motel|resort|bar|pub|bistro|bakery|diner|fast food|quick service|qsr|hospitality|food service|food court|franchise|chain|group|dining|catering|stadium|arena|casino|property management)\b/i

function segmentText(item: PipelineItem): string {
  return [
    item.company,
    item.title,
    item.snippet,
    item.website,
    item.backCheck?.industry,
    item.backCheck?.summary,
    item.backCheck?.products,
    (item.backCheck as any)?.mainProducts,
  ].filter(Boolean).join(' ').toLowerCase()
}

/** 按公司/职位/摘要/网站/背调文本判断该线索是运营商买家、渠道商还是未知。backCheck 可能缺失，内部已防空。 */
export function classifySegment(item: PipelineItem): BuyerSegment {
  const text = segmentText(item)
  if (CHANNEL_PATTERN.test(text)) return 'channel'
  if (/\b(?:general contractor|design.?build|commercial construction|tenant improvement|interior fit.?out|furniture procurement|project sourcing)\b/i.test(text)) return 'unknown'
  if (OPERATOR_PATTERN.test(text)) return 'operator'
  return 'unknown'
}

function detectSector(text: string): string {
  if (/\b(?:hotel|motel|resort)\b/i.test(text)) return 'hotel'
  if (/\b(?:cafe|coffee)\b/i.test(text)) return 'cafe'
  if (/\b(?:restaurant|dining|food)\b/i.test(text)) return 'restaurant'
  return 'operations'
}

function sectorCn(sector: string): string {
  if (sector === 'hotel') return '酒店'
  if (sector === 'cafe') return '咖啡馆'
  if (sector === 'restaurant') return '餐厅'
  return '运营'
}

export function generateDraft(rawItem: PipelineItem, variant = 0): EmailDraft {
  const item = { ...rawItem, company: displayCompanyName(rawItem) }
  const to = String(item.selectedEmail || '').trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error('SELECTED_EMAIL_REQUIRED')
  const addressClass = roleEmailClass(to) || classifyRoleLocalPart(to.split('@')[0])
  const needsReferral = ['department', 'public', 'location'].includes(String(addressClass || ''))
  const name = safeName(item)
  const isIndirect = indirect(item)
  const reviewPrefix = isIndirect
    ? '[Manual review required — identify the real company before outreach]\n\n'
    : ''
  const publicCooperationAskEn = 'We would welcome a discussion about a potential business cooperation in commercial furniture. If this is not the right inbox, could you please forward this enquiry to the department manager responsible for business partnerships or furniture sourcing?'
  const publicCooperationAskCn = '我们希望与贵司探讨商用家具方面的业务合作。若您不是负责此类业务的同事，方便请您转交给相关部门负责人或告知合适联系人吗？'
  const projectAskEn = 'Are you planning any furniture projects, new openings, refurbishments or range updates where an early factory review could help?'
  const projectAskCn = '贵司近期是否有家具项目、新店开业、翻新或产品系列更新，需要工厂提前协助评估？'
  const closingAskEn = needsReferral ? publicCooperationAskEn : projectAskEn
  const closingAskCn = needsReferral ? publicCooperationAskCn : projectAskCn
  const indirectSubject = isIndirect
    ? [`[不建议直接发送] ${item.company} — 需先确认真实公司主体`]
    : null

  const segment = classifySegment(item)
  let subjectOptions: string[]
  let subjectCnOptions: string[]
  let body: string
  let bodyCn: string

  if (segment === 'operator') {
    // 运营商买家：突出耐用商用级/定制/交期/餐饮酒店项目经验
    const sector = detectSector(segmentText(item))
    subjectOptions = [
      `Commercial furniture for ${item.company}`,
      `${item.company} — durable contract furniture`,
      `Contract furniture for your ${sector}`,
    ]
    subjectCnOptions = [
      `给${item.company}的商用家具咨询`,
      `${item.company}——耐用商用级家具`,
      `为${sectorCn(sector)}场景提供商用家具`,
    ]
    body = `${reviewPrefix}Hi ${name},

${backgroundLine(item)}

We manufacture contract-grade commercial furniture — booths, banquettes, dining chairs and tables built for daily, high-volume use. ${closingAskEn}

${SIGNATURE_EN}`
    bodyCn = `${isIndirect ? '【需人工审核：发送前先确认真实公司主体】\n\n' : ''}您好${name}，

${backgroundLineCn(item)}

我们生产商用级家具——卡座、长条软座、餐椅和餐桌，适用于日常高频使用场景。${closingAskCn}

${SIGNATURE_CN}`
  } else if (segment === 'channel') {
    // 渠道商：突出工厂直供/OEM/批发价/交期
    subjectOptions = [
      `Factory-direct supply for ${item.company}`,
      `${item.company} — OEM & wholesale partner`,
      `Wholesale commercial furniture for ${item.company}`,
    ]
    subjectCnOptions = [
      `向${item.company}提供工厂直供`,
      `${item.company}——OEM与批发合作`,
      `${item.company}商用家具批发价`,
    ]
    body = `${reviewPrefix}Hi ${name},

${backgroundLine(item)}

We are a factory-direct manufacturer of commercial furniture, supplying distributors and retailers with OEM/ODM options. ${closingAskEn}

${SIGNATURE_EN}`
    bodyCn = `${isIndirect ? '【需人工审核：发送前先确认真实公司主体】\n\n' : ''}您好${name}，

${backgroundLineCn(item)}

我们是商用家具制造工厂，为分销商和零售商提供OEM/ODM合作。${closingAskCn}

${SIGNATURE_CN}`
  } else {
    // unknown：完全保留现有模板
    subjectOptions = isIndirect ? [
      `[不建议直接发送] ${item.company} — 需先确认真实公司主体`,
    ] : [
      `Quick question for ${item.company}`,
      `${item.company} — ${product(item)} sourcing`,
      `Possible supply fit for ${item.company}`,
    ]
    subjectCnOptions = [
      `给${item.company}的一个简短问题`,
      `${item.company}—${productCn(item)}采购沟通`,
      `与${item.company}探讨供应合作`,
    ]
    body = `${reviewPrefix}Hi ${name},

${backgroundLine(item)}

We manufacture contract-grade commercial furniture — booths, banquettes, dining chairs and tables — and can review a project scope with your team before sharing relevant options. ${closingAskEn}

${SIGNATURE_EN}`
    bodyCn = `${isIndirect ? '【需人工审核：发送前先确认真实公司主体】\n\n' : ''}您好${name}，

${backgroundLineCn(item)}

我们生产商用级家具——卡座、长条软座、餐椅和餐桌，可以先根据项目需求核对合适的产品方案，再提供相关资料。${closingAskCn}

${SIGNATURE_CN}`
  }

  if (indirectSubject) subjectOptions = indirectSubject
  const { lang, label } = getLanguageByCountry(item.country || '')
  return {
    itemId: item.id,
    to,
    subject: subjectOptions[variant % subjectOptions.length],
    body,
    subjectCn: subjectCnOptions[variant % subjectCnOptions.length],
    bodyCn,
    targetLang: 'en',
    targetLangLabel: lang === 'en' ? 'English' : `English（建议${label}，目标语言需人工确认）`,
  }
}

export function generateBatchDrafts(items: PipelineItem[]): EmailDraft[] {
  return items.map(item => generateDraft(item))
}

export function generateFollowUpDraft(rawItem: PipelineItem, lastLog?: EmailLog): EmailDraft {
  const item = { ...rawItem, company: displayCompanyName(rawItem) }
  const base = generateDraft(item)
  const name = safeName(item, lastLog)
  const baseSubject = String(lastLog?.subject || base.subject).replace(/^(?:\s*re\s*:\s*)+/i, '').trim()
  const subject = `Re: ${baseSubject}`
  const segment = classifySegment(item)
  const researchedIndustry = String(item.backCheck?.industry || '').trim()
  const researchedProduct = textList(item.backCheck?.products || (item.backCheck as any)?.mainProducts)[0]
  const context = researchedIndustry
    ? `I noticed ${item.company} is involved in ${researchedIndustry}.`
    : researchedProduct
      ? `I noticed ${item.company} works with ${researchedProduct}.`
      : `I wanted to reconnect with ${item.company} after my earlier email.`
  const projectAsk = 'Do you have any upcoming furniture projects, openings, refurbishments or range updates where it would help for our factory to review options early?'
  const preparationAsk = 'If you can share the item type, approximate quantity, dimensions, materials or finishes, and target timing, I can check suitable options with our factory before preparing a quote.'
  const projectAskCn = '贵司近期是否有家具项目、新店开业、翻新或产品系列更新，需要工厂提前协助评估？'
  const preparationAskCn = '如方便，您可以告知产品类型、预估数量、尺寸、材料或表面处理及计划时间，我们会先核对适合的方案，再准备报价。'
  let body: string
  let bodyCn: string
  if (segment === 'operator') {
    body = `Hi ${name},

I’m following up on my earlier email. ${context}

${projectAsk} ${preparationAsk}


${SIGNATURE_EN}`
    bodyCn = `您好${name}，

跟进一下我之前发给您的邮件。${followupContextCn(item)}

${projectAskCn} ${preparationAskCn}


${SIGNATURE_CN}`
  } else if (segment === 'channel') {
    body = `Hi ${name},

I’m following up on my earlier email. ${context}

If you are reviewing your range or suppliers, we can check whether our factory can support the product scope. Sharing the item type, approximate quantity, dimensions, materials or finishes, and target timing would help us assess it before a quotation.

Would you have a new range or sourcing project coming up that we could review?


${SIGNATURE_EN}`
    bodyCn = `您好${name}，

跟进一下我之前发给您的邮件。${followupContextCn(item)}

如果您正在规划产品系列或评估供应商，我们可以先核对工厂是否适合相关产品需求。若能提供产品类型、预估数量、尺寸、材料或表面处理及目标时间，我们就能在报价前进行评估。

您近期是否有新的产品系列或采购项目需要我们协助评估？


${SIGNATURE_CN}`
  } else {
    body = `Hi ${name},

I’m following up on my earlier email. ${context}

${projectAsk} ${preparationAsk}


${SIGNATURE_EN}`
    bodyCn = `您好${name}，

跟进一下我之前发给您的邮件。${followupContextCn(item)}

${projectAskCn} ${preparationAskCn}


${SIGNATURE_CN}`
  }
  return {
    ...base,
    subject,
    body,
    subjectCn: `回复：${base.subjectCn}`,
    bodyCn,
  }
}
