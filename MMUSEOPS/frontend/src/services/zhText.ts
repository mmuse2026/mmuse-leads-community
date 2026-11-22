/**
 * 英文界面文案 → 中文（纯展示层翻译，绝不写回数据）
 *
 * 这些英文（reviewReason/backcheckReason/note/evidenceSummary 等）几乎全是
 * 固定模板/结构化串，不是开放的自由文本，因此用静态映射表 + 少量正则即可覆盖，
 * 无需在线翻译 API。本模块是纯函数、同步、无副作用、无网络请求。
 *
 * 铁律：只在「只读展示位」调用；编辑框/表单回填的原值禁止翻译，避免把翻译写回。
 */

/** 把任意文本兜底中文化：先试背调/复核原因精确映射 → 再试验证/退信 note → 再试结构化摘要 */
export function zh(text: string | null | undefined): string {
  const value = text == null ? '' : String(text)
  if (!value.trim()) return value
  const fromReason = zhReason(value)
  if (fromReason !== value) return fromReason
  const fromNote = zhNote(value)
  if (fromNote !== value) return fromNote
  return zhSummary(value)
}

/** 背调/复核/导入商业价值原因：精确整句映射（trim 后比较，大小写不敏感），未命中原样返回 */
export function zhReason(text: string): string {
  const value = String(text ?? '')
  const key = value.trim().toLowerCase()
  const hit = REASON_MAP[key]
  return hit ?? value
}

/** 邮箱验证/退信的 evidence note：先解析结构化 DNS 串，再走精确整句映射，未命中原样返回 */
export function zhNote(text: string): string {
  const value = String(text ?? '')
  const trimmed = value.trim()
  if (!trimmed) return value
  const dnsMatch = DNS_NOTE_RE.exec(trimmed)
  if (dnsMatch) {
    return `DNS：node=【${dnsStateLabel(dnsMatch[1])}】(${dnsMatch[2]}) · 系统=【${dnsStateLabel(dnsMatch[3])}】(${dnsMatch[4]}) · Cloudflare MX=${dnsMatch[5]}条 · Google MX=${dnsMatch[6]}条；仅域名级，未验证`
  }
  const hit = NOTE_MAP[trimmed.toLowerCase()]
  return hit ?? value
}

/** stageEvidenceSummary 这类结构化串：把已知 key 换成中文标签，未识别片段保持 key：值 */
export function zhSummary(text: string): string {
  const value = String(text ?? '')
  const trimmed = value.trim()
  if (!trimmed) return value
  const asReason = zhReason(trimmed)
  if (asReason !== trimmed) return asReason
  const segments = trimmed
    .split(';')
    .map(translateSummarySegment)
    .filter(Boolean)
  if (segments.length === 0) return value
  return segments.join('；')
}

/** ---------- zhReason 映射 ---------- */

const REASON_MAP: Record<string, string> = {
  'clear furniture/hospitality match with distribution, procurement, wholesale, or project signals': '家具/酒店业匹配清晰，含分销、采购、批发或项目采购信号',
  'possible local terminal or service business; suitable only for low-cost outreach': '疑似本地终端或服务商家，仅适合低成本开发',
  'business match is clear; direct import evidence is insufficient': '业务匹配清晰，但直接进口证据不足',
  'indirect page, unclear entity, or clearly invalid source': '间接页面、实体不明或来源明显无效',
  'company identity, business match, or purchasing evidence is insufficient': '公司身份、业务匹配或采购证据不足',
  'procurement, distribution, hospitality, or project buying signals': '含采购、分销、酒店业或项目采购信号',
  'business match is clear; import evidence remains insufficient': '业务匹配清晰，但进口证据仍不足',
  'user-authorized daily validation batch: high/medium business value; email remains unverified': '用户授权每日验证批：中高商业价值；邮箱未验证',
  'user-authorized batch review: suitable for contact mining and email validation preparation; email is not verified': '用户授权批量审核：适合联系人挖掘与邮箱验证准备；邮箱未验证',
  'batch3 second-track: low-cost only outreach approved': '第3批二次通道：仅批准低成本开发',
}

/** ---------- zhNote 映射 ---------- */

/** 结构化 DNS 证据串（node/system/DoH 多源），尾部「domain-level only; not verified.」可有可无 */
const DNS_NOTE_RE = /^node_dns:([\w-]+):(\d+)\s*;\s*system_dns:([\w-]+):(\d+)\s*;\s*doh_cloudflare:mx_present:(\d+)\s*;\s*doh_google:mx_present:(\d+)(?:\s*;\s*domain-level only;\s*not verified\.?)?/i

function dnsStateLabel(state: string): string {
  const s = state.toLowerCase()
  if (s === 'unknown') return '未知'
  if (s === 'timeout') return '超时'
  return '正常'
}

const NOTE_MAP: Record<string, string> = {
  'timeout; mx count=0; system dns timed out': '超时；MX 记录 0 条；系统 DNS 超时',
  'mx_present; mx count=1; doh returned mx records': 'MX 存在；MX 记录 1 条（DoH 返回）',
  'dns_mx_timeout; domain-level only; not verified.': 'DNS MX 超时；仅域名级，未验证',
  'provider event: delivered; observation continues; not verified.': '服务商事件：已送达；继续观察，未验证',
  'observation window completed without a bounce event; provider event: delivered; not verified.': '观察窗口结束无退信；服务商事件：已送达；未验证',
  'provider reported bounced; provider event: bounced; not verified.': '服务商报告退信；未验证',
  'snovio candidate; address not yet verified.': 'Snovio 候选邮箱，尚未验证',
  'imported from resend history as delivered; not verified.': '从 Resend 历史导入为已送达；未验证',
  'imported from resend history as suppressed; not verified.': '从 Resend 历史导入为已抑制；未验证',
  'imported from resend history as bounced; not verified.': '从 Resend 历史导入为退信；未验证',
  'inferred after 72 hours with delivered history and no later conflicting failure; not verified.': '连续 72 小时送达无冲突失败，推断有效；未验证',
  'webhook event synchronized from cloudflare d1.': '已从 Cloudflare D1 同步事件',
  'candidatecode=none; probecode=none; catchallsuspected=false; reason=mx_resolution_failed': '候选码：无；探针码：无；疑似抓包：否；原因=MX解析失败',
}

/** ---------- zhSummary 映射 ---------- */

const EMAIL_DOMAIN_LABELS: Record<string, string> = {
  'email-domain-match': '匹配',
  'email-domain-unconfirmed': '未确认',
  'email-domain-confirmed': '已确认',
  'email-domain-missing': '缺失',
}

const CONTACT_QUALITY_LABELS: Record<string, string> = {
  personal: '个人',
  none: '无',
  public_only: '仅公开',
}

function translateSummarySegment(segment: string): string {
  const seg = segment.trim()
  if (!seg) return ''
  const lowerSeg = seg.toLowerCase()
  if (EMAIL_DOMAIN_LABELS[lowerSeg]) return `邮箱域名：${EMAIL_DOMAIN_LABELS[lowerSeg]}`
  if (lowerSeg === 'company-source') return '来源：公司官网'
  if (lowerSeg === 'indirect-platform-source') return '来源：间接平台'
  const colonIndex = seg.indexOf(':')
  if (colonIndex === -1) return seg
  const key = seg.slice(0, colonIndex).trim()
  const value = seg.slice(colonIndex + 1).trim()
  const keyLower = key.toLowerCase()
  if (keyLower === 'official-domain') return `官网域名：${value.toLowerCase() === 'missing' ? '缺失' : value}`
  if (keyLower === 'industry-signals') return `行业信号：${value}`
  if (keyLower === 'buyer-signals') return `买家信号：${value}`
  if (keyLower === 'country') return `国家：${value}`
  if (keyLower === 'contact-quality') return `联系人质量：${CONTACT_QUALITY_LABELS[value.toLowerCase()] ?? value}`
  return `${key}：${value}`
}
