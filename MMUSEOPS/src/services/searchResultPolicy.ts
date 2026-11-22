export type SearchResultTag='channel'|'relevant'|'pending'|'peer'|'irrelevant'
export type SearchSourceType='official_website'|'contact_page'|'about_page'|'product_page'|'directory'|'yellow_page'|'listicle/top'|'news/blog/article'|'marketplace/platform'|'social_page'|'unknown'
/**
 * 搜索入库标准收紧（主公 2026-08-07）：
 * - 只搜精准行业公司；无行业证据/无产品词的（pending 或疑似泛词）→ 直接隔离，不再入库。
 * - 签名保持兼容：传入 context（title/snippet/url）时，pending 且无行业证据 → 不可保存；
 *   不传 context 时行为与旧版一致（channel/relevant/pending 均可保存标签）。
 */
export interface SearchAdmissionInput{url?:string;title?:string;snippet?:string;companyName?:string;tag?:unknown}
export function isSaveableSearchTag(tag:unknown,context?:SearchAdmissionInput):boolean{
  if(tag!=='channel'&&tag!=='relevant'&&tag!=='pending')return false
  if(context&&tag==='pending'&&!hasSearchIndustryEvidence(context))return false
  return true
}
export function getSearchResultScore(tag:unknown):number{if(tag==='channel')return 30;if(tag==='relevant')return 15;if(tag==='pending')return 5;return 0}
export function summarizeSearchTags(tags:unknown[]):{matched:number;pending:number;saveable:number}{const matched=tags.filter(tag=>tag==='channel'||tag==='relevant').length,pending=tags.filter(tag=>tag==='pending').length;return{matched,pending,saveable:matched+pending}}
export function canonicalDomainFrom(value:unknown):string{const raw=String(value||'').trim();if(!raw)return'';try{return new URL(raw.includes('://')?raw:`https://${raw}`).hostname.toLowerCase().replace(/^www\./,'').replace(/\.$/,'')}catch{return''}}
export function normalizeCompanyName(value:unknown):string{return String(value||'').toLowerCase().replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company|pty|plc)\b\.?/g,' ').replace(/[^a-z0-9]+/g,' ').trim()}
export function classifySearchSource(input:{url?:string;title?:string;snippet?:string}):SearchSourceType{const url=String(input.url||'').toLowerCase(),text=`${input.title||''} ${input.snippet||''}`.toLowerCase();if(/facebook|instagram|linkedin|twitter|tiktok|youtube/.test(url))return'social_page';if(/yellowpages|yelp|hotfrog/.test(url+text))return'yellow_page';if(/directory|kompass/.test(url+text))return'directory';if(/amazon|alibaba|made-in-china|houzz|etsy|ebay|marketplace/.test(url+text))return'marketplace/platform';if(/\/blog\/|\/news\/|\barticle\b|\bblog\b|\bnews\b/.test(url+text))return'news/blog/article';if(/top\s*\d+|best .*companies|list of|ranking/.test(text))return'listicle/top';if(/\/contact(?:[\/?#]|$)/.test(url))return'contact_page';if(/\/about(?:[\/?#]|$)/.test(url))return'about_page';if(/\/product|\/collections|\/category/.test(url))return'product_page';try{const parsed=new URL(url);if(parsed.pathname==='/'||parsed.pathname==='')return'official_website'}catch{}return'unknown'}
/** 行业证据词表：覆盖 furniture / car-seat 两个业务线的行业与产品上下文词 */
const INDUSTRY_EVIDENCE_PATTERN=/furniture|seating|banquette|booth|sofa|dining|restaurant|hospitality|hotel|cafe|catering|banquet|upholstery|commercial|contract|car seat|carseat|seat cover|auto seat|automotive|vehicle|interior/i
export function hasSearchIndustryEvidence(input:SearchAdmissionInput):boolean{
  const raw=`${input.title||''} ${input.snippet||''} ${input.companyName||''} ${canonicalDomainFrom(input.url)}`.toLowerCase()
  return INDUSTRY_EVIDENCE_PATTERN.test(raw)
}
export interface SearchAdmissionVerdict{saveable:boolean;shouldIsolate:boolean;isolateReason:string}
export function assessSearchAdmission(input:SearchAdmissionInput):SearchAdmissionVerdict{
  const tag=input.tag
  const hasEvidence=hasSearchIndustryEvidence(input)
  const tagSaveable=isSaveableSearchTag(tag)
  // pending/疑似泛词 且无任何行业证据 → 直接隔离（不回流补查询）
  if(!hasEvidence&&(tag==='pending'||tag==='unknown'||!tag)){
    return{saveable:false,shouldIsolate:true,isolateReason:'无行业证据(pending/疑似泛词)，直接隔离不入库'}
  }
  return{saveable:tagSaveable,shouldIsolate:false,isolateReason:''}
}
export function buildSearchAdmissionMetadata(input:SearchAdmissionInput){const sourceType=classifySearchSource(input),noise=['directory','yellow_page','listicle/top','news/blog/article','marketplace/platform','social_page'].includes(sourceType),admission=assessSearchAdmission(input);return{normalizedCompanyName:normalizeCompanyName(input.companyName||input.title),normalizedDomain:canonicalDomainFrom(input.url),canonicalDomain:canonicalDomainFrom(input.url),sourceUrl:String(input.url||''),sourceType,sourceConfidence:sourceType==='official_website'?'high':sourceType==='unknown'?'low':'medium',searchRelevance:getSearchResultScore(input.tag),suspectedNoiseReason:noise?sourceType:(admission.shouldIsolate?'no_industry_evidence':''),shouldIsolate:admission.shouldIsolate,isolateReason:admission.isolateReason,needsBackcheck:sourceType!=='official_website'||input.tag==='pending'||admission.shouldIsolate}}
