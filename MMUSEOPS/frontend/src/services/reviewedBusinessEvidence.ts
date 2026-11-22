const clean=(value:unknown)=>String(value??'').trim()
const normalize=(value:unknown)=>clean(value).toLowerCase().replace(/[^a-z0-9]+/g,'')

/** Existing company back-checks are sufficient; missing optional enrichment must not block an individually reviewed send. */
export function hasPriorBusinessBackcheck(item:any,expectedCompany?:string){
  const assessment=item?.customerReassessment||{}
  if(['确认无关或污染','暂无联系渠道隔离'].includes(clean(assessment.decision)))return false
  if(item?.qualityIsolationReason||item?.doNotContact===true)return false
  const backcheck=item?.backCheck||item?.backcheck||{}
  const site=clean(item?.website||backcheck.companyWebsite||assessment.sourceRefs?.find((ref:any)=>ref?.status==='captured')?.finalUrl)
  let siteUrl:URL
  try{siteUrl=new URL(site)}catch{return false}
  if(!['http:','https:'].includes(siteUrl.protocol)||!siteUrl.hostname||/^(localhost|example\.)/i.test(siteUrl.hostname))return false
  // A stale or alternate canonical domain is not evidence that the researched website is wrong.
  // Keep both values as context; never quarantine on hostname mismatch alone.
  const companyNames=[item?.company,backcheck.companyName,assessment.identity].map(normalize).filter(Boolean)
  const expected=normalize(expectedCompany)
  if(expected&&companyNames.length&&!companyNames.some(name=>name===expected||name.includes(expected)||expected.includes(name)))return false
  const summary=clean(backcheck.summary||item?.researchSummary||item?.backgroundSummary)
  const products=[...(Array.isArray(backcheck.mainProducts)?backcheck.mainProducts:[]),...(Array.isArray(backcheck.products)?backcheck.products:[])]
  const capturedSource=(Array.isArray(assessment.sourceRefs)?assessment.sourceRefs:[]).some((ref:any)=>ref?.status==='captured'&&/^https?:\/\//i.test(clean(ref.finalUrl||ref.url)))
  const existingAssessment=Boolean(capturedSource&&clean(assessment.businessRole)&&Array.isArray(assessment.productLines)&&assessment.productLines.length)
  // Existing screening result is itself valid prior research: do not require another set of
  // optional fields (source capture timestamp, named buyer, project, or enrichment tags).
  const priorFit=/(high|medium)/i.test(clean(item?.businessMatch||assessment.businessMatch||item?.customerTypeAssessment))
  const roleOrProducts=Boolean(clean(assessment.businessRole)||Array.isArray(assessment.productLines)&&assessment.productLines.length||products.length||clean(backcheck.industry||backcheck.customerType||backcheck.targetCustomers))
  const businessEvidence=Boolean(priorFit||summary.length>=20&&(products.length||clean(backcheck.industry||backcheck.customerType||backcheck.targetCustomers))||existingAssessment||roleOrProducts&&capturedSource)
  return businessEvidence
}
