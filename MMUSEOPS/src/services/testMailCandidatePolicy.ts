import {
  FREE_DOMAINS, PLACEHOLDER_LOCAL_PARTS, isPlaceholderLocalPart, classifyRoleLocalPart,
} from './emailClassification'

export type TestCandidateTier='A'|'B'|'C'|'D1'|'D2'|'E'
export interface TestCandidateInput{email:string;businessMatch?:string;companyName?:string;canonicalDomain?:string;entityClear?:boolean;contactName?:string;title?:string;evidenceUrl?:string;source?:string;priorResults?:string[];sourceType?:string;doNotContact?:boolean;publicBusinessFallback?:boolean;sourceVerifiedBusinessEmail?:boolean}
export interface TestCandidateDecision{normalizedEmail:string;tier:TestCandidateTier;emailType:string;eligibleForAutoTest:boolean;eligibleForBackup:boolean;riskFlags:string[];blockedReasons:string[];missingEvidence:string[];domainMatchesCompany:boolean}
export function classifyTestMailCandidateWithFallback(input:TestCandidateInput):TestCandidateDecision{
 const decision=classifyTestMailCandidate(input)
 if(input.sourceVerifiedBusinessEmail===true&&classifyRoleLocalPart(decision.normalizedEmail.split('@')[0])!=='nonbusiness'&&!isNonSalesMailbox(decision.normalizedEmail)&&!getTestMailInvalidReason(decision.normalizedEmail,input.priorResults||[],input.doNotContact)&&['company_or_business_evidence_incomplete','non_personal_role_email_requires_contact_mining'].includes(decision.blockedReasons[0]||'')&&decision.blockedReasons.length===1){return{...decision,tier:'C',emailType:'source_verified_business',eligibleForAutoTest:true,eligibleForBackup:false,riskFlags:['source_verified_shared_mailbox'],blockedReasons:[]}}
 if(input.publicBusinessFallback===true&&decision.emailType==='public'&&classifyRoleLocalPart(decision.normalizedEmail.split('@')[0])!=='nonbusiness'&&['high','medium'].includes(String(input.businessMatch||'').toLowerCase())&&decision.blockedReasons.length===1&&decision.blockedReasons[0]==='non_personal_role_email_requires_contact_mining')return{...decision,tier:'C',emailType:'public_business_fallback',eligibleForAutoTest:true,riskFlags:['public_shared_mailbox'],blockedReasons:[]}
 return decision
}
export interface LayeredCandidate extends TestCandidateDecision{customerId:string;linkedCustomerIds:string[];companyName:string;companyKey:string;canonicalDomain:string;businessMatch:string;source:string;contactName:string;title:string;evidenceUrl:string;nextAction:string}
const FORMAT=/^[^@\s]+@[^@\s]+\.[^@\s]+$/
const PLACEHOLDER=PLACEHOLDER_LOCAL_PARTS
const BAD_HISTORY=/bounced|failed|suppressed|complained|do_not_contact/
const PROCESSED=/watching|test_sent|test_mail_sent|no_bounce_observed|reply_observed/
const NON_SALES_MAILBOX_SEGMENT=/^(?:media|press|pr|publicrelations|recruitment|recruiting|careers?|jobs?|rh|humanresources|accounts?|payable|receivable|billing|factures?|facturen|debiteurenbeheer|privacy|legal|abuse|noreply|no-reply)$/
function isNonSalesMailbox(email:string){return email.split('@')[0].split(/[._-]+/).some(segment=>NON_SALES_MAILBOX_SEGMENT.test(segment))}
// 主公标准处理（2026-08-09 收敛，与 emailClassification 统一）：
// 个人邮箱（真实人名 local）→ 允许自动验证；
// 公众/地名/非业务邮箱（public/location/nonbusiness，含 info@/sales@/contact@/hello@/office@/admin@/brisbane@/hr@）→
//   发信没效果，不自动发测试信、不进待发测试信，回联系人挖掘去挖个人邮箱；
// department（purchasing@/buyer@ 等）→ 放行验证，验证通过可发开发信；
// 占位符邮箱 → 一律拦截。
const FREE=FREE_DOMAINS
const NOISE=new Set(['directory','yellow_page','listicle/top','news/blog/article','marketplace/platform','social_page','directory/news/platform'])
const rank:Record<TestCandidateTier,number>={A:0,B:1,C:2,D1:3,D2:4,E:5}
export const normalizeEmail=(value:unknown)=>String(value||'').trim().toLowerCase()
export function normalizeDomain(value:unknown){const raw=String(value||'').trim().toLowerCase();if(!raw)return'';try{return new URL(raw.includes('://')?raw:`https://${raw}`).hostname.replace(/^www\./,'').replace(/\.$/,'')}catch{return raw.replace(/^www\./,'').replace(/\/$/,'')}}
function matchesDomain(emailDomain:string,companyDomain:string){return!!emailDomain&&!!companyDomain&&(emailDomain===companyDomain||emailDomain.endsWith(`.${companyDomain}`)||companyDomain.endsWith(`.${emailDomain}`))}
function sourceUrlMatchesDomain(value:unknown,domain:string){const raw=String(value||'');for(const match of raw.matchAll(/https?:\/\/[^\s<>()"']+/gi)){try{if(matchesDomain(normalizeDomain(new URL(match[0]).hostname),domain))return true}catch{}}return false}
export function hasSourceVerifiedBusinessEmail(item:any,emailValue:unknown):boolean{
 const email=normalizeEmail(emailValue),domain=normalizeDomain(item?.canonicalDomain||item?.website||item?.domain),assessment=item?.customerReassessment
 if(!FORMAT.test(email)||!domain||!item?.company||!assessment||!String(assessment?.businessRole||'').trim()||isNonSalesMailbox(email)||classifyRoleLocalPart(email.split('@')[0])==='nonbusiness')return false
 const role=String(assessment.businessRole||'').toLowerCase()
 if(/主体待映射|尚未确认.*(主体|公司)|榜单文章|来源是.*而非.*(公司|企业)|新闻媒体|目录页面|招聘页面/.test(role))return false
 const products=Array.isArray(assessment?.productLines)?assessment.productLines.map((x:any)=>String(x||'').toLowerCase()):[]
 if(!products.some((x:string)=>/餐饮|户外|办公|酒店|宴会|活动|民用|住宅|学校|礼堂|商业家具|furniture|chair|table|banquet|hospitality/.test(x))||products.some((x:string)=>/汽车|automotive|car seat|vehicle/.test(x)))return false
 const channels=Array.isArray(assessment?.contactChannels)?assessment.contactChannels:[]
 const channel=channels.find((entry:any)=>String(entry?.type||'').toLowerCase()==='email'&&normalizeEmail(entry?.value||entry?.email)===email)
 if(!channel)return false
 const refs=Array.isArray(assessment?.sourceRefs)?assessment.sourceRefs:[]
 return refs.some((ref:any)=>String(ref?.status||'').toLowerCase()==='captured'&&sourceUrlMatchesDomain(ref?.finalUrl||ref?.requestedUrl,domain))&&sourceUrlMatchesDomain(channel?.source,domain)
}
function domainCore(host: string): string {
  const parts = host.toLowerCase().split('.')
  let core = parts.length >= 2 ? parts.slice(0, -1).join('.') : host // 去 TLD
  core = core.replace(/[-_]/g, '') // 去连字符/下划线
  for (const p of ['www', 'shop', 'store', 'my', 'the', 'go', 'e']) {
    if (core.startsWith(p) && core.length > p.length + 2) { core = core.slice(p.length); break }
  }
  for (const s of ['furniture', 'furnishing', 'furnish', 'hospitality', 'procurement', 'restaurant', 'wholesale', 'outdoor', 'online', 'company', 'group', 'hotels', 'hotel', 'store', 'world', 'cafe', 'usa', 'inc', 'ltd', 'llc', 'us', 'co']) {
    if (core.endsWith(s) && core.length > s.length + 2) { core = core.slice(0, core.length - s.length); break }
  }
  return core
}
function longestCommonSubstring(a: string, b: string): number {
  const m = a.length, n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  let best = 0
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    if (a[i - 1] === b[j - 1]) { dp[i][j] = dp[i - 1][j - 1] + 1; best = Math.max(best, dp[i][j]) } else dp[i][j] = 0
  }
  return best
}
/** 判断邮箱域名是否是公司域名的"变体"（同一实体的不同域名）。免费邮箱永不视为变体。 */
function isDomainVariant(emailDomain: string, companyDomain: string): boolean {
  if (!emailDomain || !companyDomain) return false
  if (FREE.has(emailDomain)) return false
  const ea = domainCore(emailDomain), cb = domainCore(companyDomain)
  if (!ea || !cb) return false
  if (ea === cb) return true
  if (ea.length >= 3 && cb.includes(ea)) return true
  if (cb.length >= 3 && ea.includes(cb)) return true
  const l = longestCommonSubstring(ea, cb), min = Math.min(ea.length, cb.length)
  return l >= 4 && l / min >= 0.55
}
export function getTestMailInvalidReason(email:string,prior:string[]=[],doNotContact?:boolean){if(!FORMAT.test(email))return'invalid_format';const[local,domain]=email.split('@');if(doNotContact||BAD_HISTORY.test(prior.join(' ').toLowerCase()))return'blocked_history';if(['john@doe.com','jane@doe.com','name@example.com'].includes(email)||isPlaceholderLocalPart(local)||/^(?:first|last|name)(?:[\s_\-.]*(?:first|last|name))+$/.test(local))return'placeholder_email';if(/^\d+$/.test(local))return'numeric_local_part';if(/^\d{2,}(sales|info|contact|support|admin|office)$/.test(local))return'numeric_department_pollution';if(local.length>64||/^[a-z0-9]{40,}$/.test(local)||(/^[a-z0-9]{24,}$/.test(local)&&/\d/.test(local)&&/[a-z]/.test(local)))return'random_or_oversized_local_part';if(/[\uFFFD]/.test(email)||!domain)return'crawl_pollution';return''}
export function classifyTestMailCandidate(input:TestCandidateInput):TestCandidateDecision{const normalizedEmail=normalizeEmail(input.email),prior=input.priorResults||[],blocked=getTestMailInvalidReason(normalizedEmail,prior,input.doNotContact),missingEvidence:string[]=[];if(!input.contactName)missingEvidence.push('contact_name');if(!input.title)missingEvidence.push('contact_title');if(!input.evidenceUrl)missingEvidence.push('evidence_url');const emailDomain=normalizedEmail.split('@')[1]||'',canonicalDomain=normalizeDomain(input.canonicalDomain),domainMatchesCompany=matchesDomain(emailDomain,canonicalDomain),source=String(input.source||'').toLowerCase(),business=String(input.businessMatch||'unknown').toLowerCase(),entityClear=input.entityClear!==false&&Boolean(input.companyName)&&(!NOISE.has(String(input.sourceType||''))||Boolean(canonicalDomain));if(blocked||(!entityClear&&NOISE.has(String(input.sourceType||''))))return{normalizedEmail,tier:'E',emailType:FORMAT.test(normalizedEmail)?'blocked':'invalid',eligibleForAutoTest:false,eligibleForBackup:false,riskFlags:[],blockedReasons:[blocked||'noise_without_real_company'],missingEvidence,domainMatchesCompany};if(!entityClear||!['high','medium'].includes(business))return{normalizedEmail,tier:'D2',emailType:'evidence_weak',eligibleForAutoTest:false,eligibleForBackup:false,riskFlags:['evidence_gap'],blockedReasons:['company_or_business_evidence_incomplete'],missingEvidence:[...new Set([...missingEvidence,...(!entityClear?['company_entity']:[]),...(!['high','medium'].includes(business)?['business_match']:[])])],domainMatchesCompany};const[local]=normalizedEmail.split('@'),isFree=FREE.has(emailDomain),roleClass=classifyRoleLocalPart(local),isDepartment=roleClass==='department',isNonBusiness=roleClass==='nonbusiness',domainWarning=!domainMatchesCompany?['email_domain_differs_from_company_website']:[];if(isNonBusiness)return{normalizedEmail,tier:'D1',emailType:'nonbusiness',eligibleForAutoTest:false,eligibleForBackup:false,riskFlags:[],blockedReasons:['non_personal_role_email_requires_contact_mining'],missingEvidence,domainMatchesCompany};if(isDepartment)return{normalizedEmail,tier:'B',emailType:'department',eligibleForAutoTest:true,eligibleForBackup:false,riskFlags:['department_shared_mailbox',...domainWarning],blockedReasons:[],missingEvidence,domainMatchesCompany};if(source.includes('snovio'))return{normalizedEmail,tier:'C',emailType:isFree?'free_business':'personal_company',eligibleForAutoTest:true,eligibleForBackup:false,riskFlags:['snovio_unconfirmed',...(isFree?['free_email_risk']:[]),...domainWarning],blockedReasons:[],missingEvidence,domainMatchesCompany};return{normalizedEmail,tier:'A',emailType:isFree?'free_business':'personal_company',eligibleForAutoTest:true,eligibleForBackup:false,riskFlags:[...(missingEvidence.length?['contact_evidence_incomplete']:[]),...(isFree?['free_email_risk']:[]),...domainWarning],blockedReasons:[],missingEvidence,domainMatchesCompany}}
export function evaluateFormalEmailEligibility(input:{businessMatch?:string;normalizedEmail:string;priorResults?:string[];duplicate?:boolean}){const prior=(input.priorResults||[]).join(' ').toLowerCase(),blockedReasons:string[]=[];if(!['high','medium'].includes(String(input.businessMatch||'')))blockedReasons.push('business_match_not_qualified');if(BAD_HISTORY.test(prior))blockedReasons.push('blocked_history');if(!/no_bounce_observed|reply_observed/.test(prior))blockedReasons.push('formal_reachability_not_proven');if(input.duplicate)blockedReasons.push('duplicate_normalized_email');return{allowed:blockedReasons.length===0,blockedReasons}}
const list=(v:any):any[]=>Array.isArray(v)?v:[]
function emails(item:any){return[...new Set([item.email,...list(item.contacts).map((c:any)=>c?.email)].map(normalizeEmail).filter(Boolean))]}
function entityClear(item:any){const sourceType=String(item.sourceType||''),company=String(item.company||item.title||'').trim(),domain=normalizeDomain(item.canonicalDomain||item.website||item.domain);return Boolean(company)&&(!NOISE.has(sourceType)||Boolean(domain))}
function contactFor(item:any,email:string){return list(item.contacts).find((c:any)=>normalizeEmail(c?.email)===email)||{}}
function historyFor(item:any,email:string){return list(item.emailVerificationEvidence).filter((e:any)=>normalizeEmail(e?.email)===email).flatMap((e:any)=>[e?.result,e?.status,e?.providerLastEvent,e?.recoveryStatus]).filter(Boolean).map(String)}
function companyKey(item:any){return normalizeDomain(item.canonicalDomain||item.website||item.domain)||String(item.normalizedCompanyName||item.company||item.title||item.id).trim().toLowerCase()}
export function buildLayeredTestMailCandidatePool(items:any[],options:{maxPerDomain?:number}={}){const maxPerDomain=options.maxPerDomain||2,emailOccurrences=new Map<string,number>(),globalHistory=new Map<string,string[]>();for(const item of items)for(const email of emails(item)){emailOccurrences.set(email,(emailOccurrences.get(email)||0)+1);globalHistory.set(email,[...(globalHistory.get(email)||[]),...historyFor(item,email)]) }const byEmail=new Map<string,LayeredCandidate>();for(const item of items){for(const email of emails(item)){const contact=contactFor(item,email),prior=globalHistory.get(email)||[],decision=classifyTestMailCandidate({email,businessMatch:item.businessMatch,companyName:item.company||item.title,canonicalDomain:item.canonicalDomain||item.website||item.domain,entityClear:entityClear(item),contactName:contact.name||contact.contactName||item.contactName,title:contact.title||contact.jobTitle||item.contactTitle,evidenceUrl:contact.evidenceUrl||contact.sourceUrl,source:contact.source||item.source,priorResults:prior,sourceType:item.sourceType,doNotContact:item.doNotContactEmail||item.doNotDevelop}),processed=PROCESSED.test(prior.join(' ').toLowerCase()),stageBlocked=['observation_queue','developable_email_pool','pending_draft_review','scheduled_send_queue','followup_queue','replied_queue','replace_contact_queue','true_excluded'].includes(item.primaryStage),formalSent=item.developmentStatus==='sent'||item.formalBounce===true,candidate:LayeredCandidate={...decision,eligibleForAutoTest:decision.eligibleForAutoTest&&!processed&&!stageBlocked&&!formalSent,eligibleForBackup:decision.eligibleForBackup&&!processed&&!stageBlocked&&!formalSent,blockedReasons:[...decision.blockedReasons,...(processed?['already_tested_or_observed']:[]),...(stageBlocked?['primary_stage_not_testable']:[]),...(formalSent?['already_formally_sent']:[])],customerId:item.id,linkedCustomerIds:[],companyName:item.company||item.title||item.id,companyKey:companyKey(item),canonicalDomain:normalizeDomain(item.canonicalDomain||item.website||item.domain),businessMatch:item.businessMatch||'unknown',source:contact.source||item.source||'unknown',contactName:contact.name||contact.contactName||item.contactName||'',title:contact.title||contact.jobTitle||item.contactTitle||'',evidenceUrl:contact.evidenceUrl||contact.sourceUrl||'',nextAction:decision.blockedReasons.includes('non_personal_role_email_requires_contact_mining')?'contact_mining':decision.tier==='D2'?'complete_evidence':decision.tier==='E'?'blocked':decision.tier==='D1'?'manual_or_limited_test':'dns_mx'};const existing=byEmail.get(email);if(!existing||rank[candidate.tier]<rank[existing.tier]||(rank[candidate.tier]===rank[existing.tier]&&(candidate.eligibleForAutoTest||candidate.eligibleForBackup)&&!(existing.eligibleForAutoTest||existing.eligibleForBackup)))byEmail.set(email,candidate)}}for(const[email,c]of byEmail)c.linkedCustomerIds=items.filter(item=>emails(item).includes(email)).map(item=>item.id);const all=[...byEmail.values()].sort((a,b)=>rank[a.tier]-rank[b.tier]||a.companyName.localeCompare(b.companyName)),domainCounts=new Map<string,number>(),take=(candidate:LayeredCandidate)=>{const key=candidate.companyKey||candidate.normalizedEmail.split('@')[1],n=domainCounts.get(key)||0;if(n>=maxPerDomain)return false;domainCounts.set(key,n+1);return true},autoCandidates=all.filter(x=>x.eligibleForAutoTest).filter(take),backupCandidates=all.filter(x=>x.eligibleForBackup).filter(take),counts=Object.fromEntries(['A','B','C','D1','D2','E'].map(t=>[t,all.filter(x=>x.tier===t).length]));return{all,autoCandidates,backupCandidates,manualReview:all.filter(x=>x.tier==='D2'),blocked:all.filter(x=>x.tier==='E'),counts,uniqueEmailCount:all.length,duplicateEmailCount:[...emailOccurrences.values()].reduce((n,v)=>n+Math.max(0,v-1),0)}}


