import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import SearchResultsPanel from '../components/panels/SearchResultsPanel'
import { countryOptions, industryOptions, loadSearchTarget, saveSearchTarget } from '../store/searchTarget'
import { getAllItems, getRecentSearchSessions, loadFromDisk, saveItems, saveSearchSession, type SearchSession, authorizedJsonPost } from '../store/db'
import { getSearchRuntime } from '../services/searchRuntime'
import { executeSearch, type SearchProgress } from '../services/searchService'
import { translateToEnglish } from '../services/translateService'
import { appliedSearchUsage } from '../services/searchBudgetPolicy'
import { isSearchPoolItem } from '../services/searchPool'
import { presentSource } from '../services/presentation'
import { PaginationBar, usePagination } from '../components/Pagination'
import type { PipelineItem } from '../types/item'
import {
  applyQueryBudget,
  expandProductTerms,
  filterRepeatedQueries,
  planLeadQueries,
  queryFingerprint,
  recommendLeadQueries,
  type LeadQueryChannel,
  type PlannedLeadQuery,
} from '../services/leadQueryPlanner'

export type BackcheckStatus = 'pending' | 'running' | 'done' | 'failed'

type Translation = { source: string; target: string }
type BudgetState = { justserpLimit: number; justserpUsed: number; apifyLimit: number; apifyUsed: number }

const BUDGET_KEY = 'mmuse_search_budgets'
const defaultBudget: BudgetState = { justserpLimit: 2000, justserpUsed: 0, apifyLimit: 1000, apifyUsed: 0 }

const keywordAliases: Record<string, string> = {
  '卡座沙发': 'banquette seating',
  '餐饮桌椅': 'restaurant tables and chairs',
  '酒店家具': 'hotel furniture',
  '商用家具': 'commercial furniture',
  '汽车座椅套': 'car seat covers',
  '定制座椅套': 'custom car seat covers',
}

const channelDefs: Array<{ id: LeadQueryChannel; label: string; provider: string; description: string }> = [
  { id: 'web', label: '网页公司搜索', provider: 'JustSerp', description: '优先找进口商、分销商、采购主体' },
  { id: 'linkedin', label: 'LinkedIn 决策人', provider: 'JustSerp', description: '补充采购与项目决策联系人' },
  { id: 'maps', label: '本地商家', provider: 'JustSerp', description: '按城市找渠道商和项目客户' },
  { id: 'news', label: '扩张信号', provider: 'JustSerp', description: '寻找开店、项目和采购机会' },
  { id: 'gleif', label: '法人补充', provider: '免费', description: '仅用于补充公开实体信息' },
  { id: 'wikidata', label: '实体补充', provider: '免费', description: '仅用于补充公开实体信息' },
]

function splitTerms(value: string): string[] {
  return value.split(/[\n,，、;]/).map(term => term.trim()).filter(Boolean)
}

function loadBudget(): BudgetState {
  try { return { ...defaultBudget, ...JSON.parse(localStorage.getItem(BUDGET_KEY) || '{}') } } catch { return defaultBudget }
}

function hasUsableTranslation(value: string, source: string): boolean {
  return Boolean(value && value !== source && !/please select two distinct languages/i.test(value))
}

async function translateKeyword(source: string): Promise<string> {
  const trimmed = source.trim()
  if (keywordAliases[trimmed]) return keywordAliases[trimmed]
  const translated = await translateToEnglish(trimmed)
  if (hasUsableTranslation(translated, trimmed)) return translated
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(trimmed)}&langpair=${encodeURIComponent('zh-CN|en')}`
    const response = await fetch(url)
    const data = await response.json() as { responseData?: { translatedText?: string } }
    const fallback = data.responseData?.translatedText || ''
    return hasUsableTranslation(fallback, trimmed) ? fallback : trimmed
  } catch {
    return trimmed
  }
}

function countryName(code: string): string {
  const names: Record<string, string> = {
    US: 'United States', CA: 'Canada', UK: 'United Kingdom', AU: 'Australia', DE: 'Germany', FR: 'France',
    AE: 'United Arab Emirates', SG: 'Singapore', JP: 'Japan', BR: 'Brazil', IN: 'India', MX: 'Mexico',
  }
  return names[code] || code
}

export default function SearchWorkbench() {
  const navigate = useNavigate()
  const location = useLocation()
  const [target] = useState(loadSearchTarget)
  const [draftSaved, setDraftSaved] = useState(true)
  const runtime = getSearchRuntime()
  const [checkpoint, setCheckpoint] = useState(runtime.read)
  const [keywords, setKeywords] = useState(target.keywords || '')
  const [country, setCountry] = useState(target.country || 'US')
  const [customCountry, setCustomCountry] = useState(target.customCountry || '')
  const [industry, setIndustry] = useState(target.industry || 'furniture')
  const [customIndustry, setCustomIndustry] = useState(target.customIndustry || '')
  const [city, setCity] = useState(target.city || '')
  const [channels, setChannels] = useState<LeadQueryChannel[]>((target.channels as LeadQueryChannel[]) || ['web'])
  const [translations, setTranslations] = useState<Translation[]>([])
  const [recommendationOffset, setRecommendationOffset] = useState(0)
  const [selectedFingerprints, setSelectedFingerprints] = useState<string[]>([])
  const [editedQueries, setEditedQueries] = useState<Record<string, string>>({})
  const [budget, setBudget] = useState<BudgetState>(loadBudget)
  const [history, setHistory] = useState<SearchSession[]>([])
  const [analyzing, setAnalyzing] = useState(false)
  const [searching, setSearching] = useState(false)
  const [searchProgress, setSearchProgress] = useState<SearchProgress | null>(null)
  const [message, setMessage] = useState('')
  const [searchPoolItems, setSearchPoolItems] = useState<PipelineItem[]>([])
  const [searchPoolLoading, setSearchPoolLoading] = useState(true)
  const [selectedSearchPoolIds, setSelectedSearchPoolIds] = useState<string[]>([])
  const [movingToBackcheck, setMovingToBackcheck] = useState(false)

  useEffect(() => {
    void getRecentSearchSessions(30).then(setHistory)
  }, [])

  useEffect(() => {
    const sync = () => {
      const next = runtime.read()
      setCheckpoint(next ? { ...next } : null)
      setSearching(next?.status === 'running')
      if (next?.progress) setSearchProgress(next.progress)
      if (next?.status === 'saved') { void loadSearchPool(); void getRecentSearchSessions(30).then(setHistory); setBudget(loadBudget()) }
    }
    sync()
    return runtime.subscribe(sync)
  }, [])

  useEffect(() => {
    try { saveSearchTarget({ country, customCountry, industry, customIndustry, keywords, city, channels }); setDraftSaved(true) }
    catch { setDraftSaved(false) }
  }, [country, customCountry, industry, customIndustry, keywords, city, channels])

  async function loadSearchPool(): Promise<void> {
    setSearchPoolLoading(true)
    try {
      await loadFromDisk()
      const items = await getAllItems()
      const next = items.filter(isSearchPoolItem)
      setSearchPoolItems(next)
      setSelectedSearchPoolIds(previous => previous.filter(id => next.some(item => item.id === id)))
    } finally {
      setSearchPoolLoading(false)
    }
  }

  useEffect(() => { void loadSearchPool() }, [])

  const industryValue = industry === 'custom' ? customIndustry.trim() || 'custom' : industry
  const countryValue = country === 'custom' ? customCountry.trim() : country
  const expandedTerms = useMemo(
    () => expandProductTerms(translations.map(item => item.target), industryValue),
    [translations, industryValue],
  )
  const matchingProduct = useMemo(
    () => translations.map(item => item.target.trim()).filter(Boolean).join(' ') || industryValue,
    [translations, industryValue],
  )
  const searchPoolPage = usePagination(searchPoolItems, 30)

  useEffect(() => {
    if (location.hash === '#pool' && !searchPoolLoading) document.getElementById('search-pool')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [location.hash, searchPoolLoading])
  const plan = useMemo(() => planLeadQueries({
    terms: expandedTerms.map(item => item.term),
    industry: industryValue,
    country: countryName(countryValue),
    city,
    channels,
  }), [expandedTerms, industryValue, countryValue, city, channels])
  const historyFingerprints = useMemo(() => history.flatMap(session => session.queryFingerprints || []), [history])
  const uniquePlan = useMemo(() => filterRepeatedQueries(plan, historyFingerprints), [plan, historyFingerprints])
  const recommendations = useMemo(
    () => recommendLeadQueries(uniquePlan, industryValue, { offset: recommendationOffset, limit: 5 }),
    [uniquePlan, industryValue, recommendationOffset],
  )
  const selectedSet = useMemo(() => new Set(selectedFingerprints), [selectedFingerprints])
  const selectedPlans = useMemo<PlannedLeadQuery[]>(() => recommendations
    .filter(item => selectedSet.has(item.fingerprint))
    .map(item => {
      const query = editedQueries[item.fingerprint]?.trim() || item.query
      return { ...item, query, fingerprint: queryFingerprint(item.channelId, countryName(countryValue), query) }
    }), [recommendations, selectedSet, editedQueries, countryValue])
  const selectedUniquePlan = useMemo(() => filterRepeatedQueries(selectedPlans, historyFingerprints), [selectedPlans, historyFingerprints])
  const budgeted = useMemo(() => applyQueryBudget(selectedUniquePlan, {
    justserp: { monthlyLimit: budget.justserpLimit, used: budget.justserpUsed },
    apify: { monthlyLimit: budget.apifyLimit, used: budget.apifyUsed },
  }), [selectedUniquePlan, budget])
  const justSerpAllowance = budgeted.dailyAllowance.justserp || 0
  const duplicateCount = plan.length - uniquePlan.length + selectedPlans.length - selectedUniquePlan.length

  useEffect(() => {
    setSelectedFingerprints(recommendations.map(item => item.fingerprint))
    setEditedQueries({})
  }, [recommendationOffset, uniquePlan])

  function updateBudget(patch: Partial<BudgetState>) {
    const next = { ...budget, ...patch }
    setBudget(next)
    localStorage.setItem(BUDGET_KEY, JSON.stringify(next))
  }

  function toggleChannel(id: LeadQueryChannel) {
    setChannels(previous => previous.includes(id) ? previous.filter(channel => channel !== id) : [...previous, id])
    setRecommendationOffset(0)
  }

  function toggleRecommendation(fingerprint: string) {
    setSelectedFingerprints(previous => previous.includes(fingerprint)
      ? previous.filter(item => item !== fingerprint)
      : [...previous, fingerprint])
  }

  async function analyzeKeywords(andStart = false) {
    const sources = splitTerms(keywords)
    if (!sources.length) {
      setMessage('请先输入中文产品关键词。')
      return
    }
    setAnalyzing(true)
    setMessage('')
    try {
      const next = await Promise.all(sources.map(async source => ({
        source,
        target: /[\u4e00-\u9fff]/.test(source) ? await translateKeyword(source) : source,
      })))
      setTranslations(next.filter(item => item.target.trim()))
      setRecommendationOffset(0)
      saveSearchTarget({ country, customCountry, industry, customIndustry, keywords, city, channels })
      if (andStart) {
        // Use the same planner, history de-duplication and credit policy as the preview.
        // Pass the computed values directly: React state has not committed yet.
        const terms = expandProductTerms(next.map(item => item.target), industryValue)
        const planned = planLeadQueries({ terms: terms.map(item => item.term), industry: industryValue, country: countryName(countryValue), city, channels })
        const recommended = recommendLeadQueries(filterRepeatedQueries(planned, historyFingerprints), industryValue, { offset: 0, limit: 5 })
        const ready = applyQueryBudget(recommended, { justserp: { monthlyLimit: budget.justserpLimit, used: budget.justserpUsed }, apify: { monthlyLimit: budget.apifyLimit, used: budget.apifyUsed } })
        await startSearch(ready.executable, next.map(item => item.target.trim()).filter(Boolean).join(' ') || industryValue)
      }
    } catch {
      setMessage('关键词分析失败，请稍后重试。')
    } finally {
      setAnalyzing(false)
    }
  }

  const selectedSearchPoolIdSet = useMemo(() => new Set(selectedSearchPoolIds), [selectedSearchPoolIds])
  const allSearchPoolPageSelected = searchPoolPage.pageItems.length > 0 && searchPoolPage.pageItems.every(item => selectedSearchPoolIdSet.has(item.id))

  function toggleSearchPoolItem(id: string) {
    setSelectedSearchPoolIds(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id])
  }

  function toggleSearchPoolPage() {
    const pageIds = searchPoolPage.pageItems.map(item => item.id)
    setSelectedSearchPoolIds(previous => allSearchPoolPageSelected
      ? previous.filter(id => !pageIds.includes(id))
      : [...new Set([...previous, ...pageIds])])
  }

  async function moveSelectedToBackcheck() {
    const selected = searchPoolItems.filter(item => selectedSearchPoolIdSet.has(item.id))
    if (!selected.length) {
      setMessage('请先勾选需要进入背调的客户。')
      return
    }
    setMovingToBackcheck(true)
    setMessage('')
    try {
      const now = new Date().toISOString()
      await saveItems(selected.map(item => ({
        ...item,
        currentStageId: 'otr-backcheck',
        backcheckStatus: 'pending' as const,
        updatedAt: now,
        timeline: [...(item.timeline || []), { stageId: 'otr-backcheck', enteredAt: now }],
      })))
      setSelectedSearchPoolIds([])
      await loadSearchPool()
      navigate('/develop')
    } catch {
      setMessage('进入背调失败，客户数据未被删除，请重试。')
    } finally {
      setMovingToBackcheck(false)
    }
  }

  async function startSearch(queries = budgeted.executable, product = matchingProduct, context = { country: countryValue || 'US', keywords, industry: industryValue }) {
    if (!queries.length && !translations.length) {
      setMessage('请先生成最高匹配推荐。')
      return
    }
    if (!queries.length) {
      setMessage('当前没有可执行查询，请保留至少一条推荐并检查额度。')
      return
    }
    if (runtime.read()?.status === 'running') return
    setSearching(true)
    setMessage('')
    setSearchProgress(null)
    const count = queries.filter(query => query.provider === 'justserp').length
    const generated = queries.map(query => ({
      channelId: query.channelId,
      channelLabel: channelDefs.find(def => def.id === query.channelId)?.label || query.channelId,
      query: query.query,
    }))
    try {
      await runtime.run({ queries, product, context }, async updateProgress => {
      const progress = await executeSearch(generated, product, updateProgress, undefined, { country: context.country })
      setSearchProgress(progress)
      const usedSearchCredits = appliedSearchUsage(count, progress.failed)
      if (usedSearchCredits > 0) updateBudget({ justserpUsed: budget.justserpUsed + usedSearchCredits })
      await saveSearchSession({
        id: crypto.randomUUID(),
        product: context.keywords,
        industry: context.industry,
        country: context.country,
        channel: queries.map(query => query.channelId).join(','),
        queries: queries.map(query => query.query),
        queryFingerprints: progress.failed > 0 || progress.saveFailures ? [] : queries.map(query => query.fingerprint),
        deferredQueries: budgeted.deferred.length + duplicateCount,
        total: progress.total,
        matched: progress.matched,
        pending: 0,
        failed: progress.failed,
        results: progress.companies.map(company => ({ ...company, url: company.url })),
        searchedAt: new Date().toISOString(),
      })
      if (progress.matched > 0) {
        // The one-click acquisition command also resumes the existing server pipeline.
        // Operator session/CSRF and all downstream eligibility checks remain server-owned.
        try { await authorizedJsonPost('/api/pipeline-control/start', { projectId: '', runBatchId: '' }) }
        catch { setMessage('客户已保存；自动流程启动失败，请从现有工作台恢复。') }
      }
      if (progress.saveFailures) setMessage(`有 ${progress.saveFailures} 条未保存，已保留重试资格；成功客户继续处理。`)
      setHistory(await getRecentSearchSessions(30))
      await loadSearchPool()
      if (progress.failed || progress.saveFailures) throw new Error('部分查询或客户保存失败；已保存客户保留，请手动重试')
      })
    } catch {
      setMessage('搜索执行失败，请检查 JustSerp 额度或网络连接。')
    } finally {
      setSearching(false)
    }
  }

  return (
    <main className="flex-1 min-h-0 overflow-y-auto bg-[#f4f5f7] p-4 md:p-6">
      <div className="mx-auto max-w-[1460px] space-y-5">
        <header className="flex flex-col gap-3 border border-white/80 bg-white/65 px-5 py-4 shadow-[0_16px_38px_-28px_rgba(15,23,42,0.28)] backdrop-blur-xl md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-[11px] font-semibold tracking-[0.08em] text-surface-400">客户发现</p>
            <h1 className="mt-1 text-xl font-bold text-surface-900">一键精准客户搜索</h1>
            <p className="mt-1 text-xs text-surface-500">输入中文产品词，系统只推荐最值得先跑的少量客户搜索方案。</p>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <span className="text-surface-500">历史搜索 {history.length} 次</span>
            <span className="border border-surface-200 bg-surface-50 px-2.5 py-1 font-medium text-surface-500">JustSerp 搜索通道 · 以执行结果为准</span>
          </div>
        </header>

        <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
          <aside className="space-y-5">
            <section className="border border-white/80 bg-white/70 p-5 shadow-[0_16px_38px_-28px_rgba(15,23,42,0.28)] backdrop-blur-xl">
              <h2 className="text-sm font-bold text-surface-900">搜索条件</h2>
              <p role="status" className="mt-2 text-xs text-surface-500">{draftSaved ? '搜索条件已保存到本浏览器' : '搜索条件保存失败，请勿关闭页面'}</p>
              {checkpoint && <div className="mt-2 text-xs" role="status">
                {checkpoint.status === 'running' ? '搜索仍在执行，切换页面后继续' : checkpoint.status === 'saved' ? '本批搜索已完成并保存' : '搜索中断或失败，已保存客户保留；待手动重试（可能再次消耗查询额度）'}
                {checkpoint.error && <p className="mt-1 text-amber-700">{checkpoint.error}</p>}
                {(checkpoint.status === 'interrupted' || checkpoint.status === 'failed') && <button className="ml-2 underline" disabled={searching} onClick={() => startSearch(checkpoint.input.queries, checkpoint.input.product, checkpoint.input.context)}>重试本批搜索</button>}
              </div>}
              <label className="mt-4 grid gap-1.5 text-xs font-semibold text-surface-500">
                中文产品关键词
                <textarea value={keywords} onChange={event => setKeywords(event.target.value)} rows={7}
                  placeholder={'卡座沙发\n餐饮桌椅\n酒店家具'}
                  className="w-full resize-y border border-surface-200 bg-white/80 px-3 py-3 text-sm font-normal text-surface-900 outline-none transition focus:border-emerald-500" />
              </label>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <label className="grid gap-1.5 text-xs font-semibold text-surface-500">目标国家
                  <select value={country} onChange={event => setCountry(event.target.value)} className="border border-surface-200 bg-white/80 px-2.5 py-2 text-sm font-medium text-surface-800 outline-none">
                    {countryOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                <label className="grid gap-1.5 text-xs font-semibold text-surface-500">行业
                  <select value={industry} onChange={event => setIndustry(event.target.value)} className="border border-surface-200 bg-white/80 px-2.5 py-2 text-sm font-medium text-surface-800 outline-none">
                    {industryOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
              </div>
              {country === 'custom' && <input value={customCountry} onChange={event => setCustomCountry(event.target.value)} placeholder="输入英文国家名或代码" className="mt-3 w-full border border-surface-200 bg-white px-2.5 py-2 text-sm outline-none" />}
              {industry === 'custom' && <input value={customIndustry} onChange={event => setCustomIndustry(event.target.value)} placeholder="输入中文行业名称" className="mt-3 w-full border border-surface-200 bg-white px-2.5 py-2 text-sm outline-none" />}
              <label className="mt-3 grid gap-1.5 text-xs font-semibold text-surface-500">目标城市（可选）
                <input value={city} onChange={event => setCity(event.target.value)} placeholder="例如 Sydney" className="border border-surface-200 bg-white/80 px-2.5 py-2 text-sm font-normal outline-none" />
              </label>
              <button onClick={() => analyzeKeywords(true)} disabled={analyzing || searching} className="mt-4 w-full bg-surface-900 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-surface-800 disabled:cursor-not-allowed disabled:bg-surface-300">
                {analyzing || searching ? '正在执行...' : '一键开始获客'}
              </button>
              {message && <p className="mt-3 border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">{message}</p>}
            </section>

            <details className="border border-white/80 bg-white/70 p-5 backdrop-blur-xl">
              <summary className="cursor-pointer list-none text-sm font-semibold text-surface-700">搜索额度设置</summary>
              <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                <label className="grid gap-1.5 text-surface-500">JustSerp 月额度
                  <input type="number" min="0" value={budget.justserpLimit} onChange={event => updateBudget({ justserpLimit: Number(event.target.value) || 0 })} className="border border-surface-200 bg-white px-2 py-1.5 text-surface-800 outline-none" />
                </label>
                <label className="grid gap-1.5 text-surface-500">已消耗
                  <input type="number" min="0" value={budget.justserpUsed} onChange={event => updateBudget({ justserpUsed: Number(event.target.value) || 0 })} className="border border-surface-200 bg-white px-2 py-1.5 text-surface-800 outline-none" />
                </label>
              </div>
              <p className="mt-3 text-xs leading-5 text-surface-500">按月剩余额度自动控制当天执行量。今日预计可执行 <strong className="text-surface-900">{justSerpAllowance}</strong> 条。</p>
            </details>
          </aside>

          <section className="space-y-5">
            <section className="border border-white/80 bg-white/70 p-5 shadow-[0_16px_38px_-28px_rgba(15,23,42,0.28)] backdrop-blur-xl">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-bold text-surface-900">最高匹配推荐</h2>
                  <p className="mt-1 text-xs text-surface-500">优先按行业采购习惯、客户身份、渠道可信度与排除规则排序。默认只选前 5 条。</p>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setRecommendationOffset(value => value + 5)} disabled={!recommendations.length} className="border border-surface-300 bg-white/80 px-3 py-2 text-xs font-semibold text-surface-700 transition hover:border-surface-500 disabled:cursor-not-allowed disabled:opacity-40">换一批</button>
                  <button onClick={() => startSearch()} disabled={searching || !budgeted.executable.length} className="bg-emerald-700 px-4 py-2 text-sm font-bold text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-surface-300">
                    {searching ? '正在搜索...' : `执行 ${budgeted.executable.length} 条精选查询`}
                  </button>
                </div>
              </div>

              {!translations.length ? <p className="mt-5 border border-dashed border-surface-300 bg-white/45 px-4 py-8 text-center text-sm text-surface-400">填写左侧中文关键词后，一键生成最精准的搜索方案。</p> : (
                <>
                  <div className="mt-4 flex flex-wrap gap-2 text-xs">
                    {translations.map(item => <span key={item.source} className="border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-emerald-800">{item.source} → {item.target}</span>)}
                    <span className="border border-surface-200 bg-white px-2.5 py-1 text-surface-500">候选池 {uniquePlan.length} 条，当前仅展示 5 条</span>
                  </div>
                  <div className="mt-4 grid gap-3 lg:grid-cols-2">
                    {recommendations.map(item => {
                      const enabled = selectedSet.has(item.fingerprint)
                      return <article key={item.fingerprint} className={`border p-4 transition ${enabled ? 'border-emerald-300 bg-emerald-50/55' : 'border-surface-200 bg-white/55 opacity-65'}`}>
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-xs font-semibold text-emerald-700">{item.score} 分匹配</p>
                            <h3 className="mt-1 text-sm font-bold text-surface-900">{item.role.label}</h3>
                            <p className="mt-1 text-xs leading-5 text-surface-500">{item.role.reason}</p>
                          </div>
                          <label className="flex items-center gap-1.5 text-xs font-semibold text-surface-600">
                            <input type="checkbox" checked={enabled} onChange={() => toggleRecommendation(item.fingerprint)} className="h-4 w-4 accent-emerald-700" /> 执行
                          </label>
                        </div>
                        <label className="mt-3 block text-[11px] font-semibold text-surface-400">搜索关键词
                          <input value={editedQueries[item.fingerprint] ?? item.query} onChange={event => setEditedQueries(previous => ({ ...previous, [item.fingerprint]: event.target.value }))} disabled={!enabled} className="mt-1 w-full border border-surface-200 bg-white/90 px-2.5 py-2 font-mono text-[11px] font-normal text-surface-700 outline-none focus:border-emerald-500 disabled:cursor-not-allowed" />
                        </label>
                      </article>
                    })}
                  </div>
                </>
              )}
              {translations.length > 0 && <div className="mt-4 border-t border-surface-200 pt-3 text-xs text-surface-500">
                已过滤历史重复 {duplicateCount} 条；本次保留 {selectedUniquePlan.length} 条；额度暂缓 {budgeted.deferred.length} 条。
              </div>}
            </section>

            <details className="border border-white/80 bg-white/70 p-5 backdrop-blur-xl">
              <summary className="cursor-pointer list-none text-sm font-semibold text-surface-700">搜索渠道</summary>
              <p className="mt-1 text-xs text-surface-500">默认网页公司搜索。需要补联系人或当地项目时，再额外勾选渠道。</p>
              <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {channelDefs.map(def => {
                  const enabled = channels.includes(def.id)
                  const unavailable = def.provider === 'JustSerp' && justSerpAllowance === 0
                  return <button key={def.id} onClick={() => !unavailable && toggleChannel(def.id)} disabled={unavailable} className={`border p-3 text-left transition ${enabled ? 'border-emerald-400 bg-emerald-50' : 'border-surface-200 bg-white/55'} ${unavailable ? 'cursor-not-allowed opacity-45' : 'hover:border-surface-400'}`}>
                    <div className="flex items-center justify-between gap-2"><span className="text-sm font-bold text-surface-800">{def.label}</span><span className="text-[10px] font-semibold text-surface-400">{unavailable ? '额度不足' : def.provider}</span></div>
                    <p className="mt-1 text-xs leading-5 text-surface-500">{def.description}</p>
                  </button>
                })}
              </div>
            </details>

            {expandedTerms.length > 0 && <details className="border border-white/80 bg-white/60 p-5 backdrop-blur-xl">
              <summary className="cursor-pointer list-none text-sm font-semibold text-surface-700">关键词扩展依据</summary>
              <div className="mt-3 grid gap-2 md:grid-cols-2">
                {expandedTerms.map(item => <div key={item.term} className="border-l-2 border-emerald-500 bg-emerald-50/60 px-3 py-2"><p className="text-sm font-semibold text-surface-800">{item.term}</p><p className="mt-1 text-xs text-surface-500">{item.reason}</p></div>)}
              </div>
            </details>}

            {searchProgress && <section className="border border-white/80 bg-white/70 p-5 shadow-[0_16px_38px_-28px_rgba(15,23,42,0.28)] backdrop-blur-xl"><SearchResultsPanel progress={searchProgress} searching={searching} /></section>}

            <section id="search-pool" className="border border-white/80 bg-white/70 p-5 shadow-[0_16px_38px_-28px_rgba(15,23,42,0.28)] backdrop-blur-xl">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-bold text-surface-900">搜索池客户</h2>
                  <p className="mt-1 text-xs text-surface-500">勾选客户后一键转入背调池，系统会保留全部原始搜索资料。</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button onClick={toggleSearchPoolPage} disabled={!searchPoolPage.pageItems.length || searchPoolLoading} className="border border-surface-300 bg-white px-3 py-2 text-xs font-semibold text-surface-700 hover:border-surface-500 disabled:opacity-50">{allSearchPoolPageSelected ? '取消全选本页' : '全选本页'}</button>
                  <button onClick={() => void moveSelectedToBackcheck()} disabled={!selectedSearchPoolIds.length || movingToBackcheck} className="bg-emerald-700 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-surface-300">{movingToBackcheck ? '正在转入...' : <>一键进入背调（{selectedSearchPoolIds.length}）</>}</button>
                  <button onClick={() => void loadSearchPool()} disabled={searchPoolLoading || movingToBackcheck} className="border border-surface-300 bg-white px-3 py-2 text-xs font-semibold text-surface-700 hover:border-surface-500 disabled:opacity-50">{searchPoolLoading ? '加载中...' : '刷新列表'}</button>
                </div>
              </div>
              <PaginationBar page={searchPoolPage.page} pageCount={searchPoolPage.pageCount} total={searchPoolItems.length} pageSize={searchPoolPage.pageSize} onPageChange={searchPoolPage.setPage} />
              {searchPoolPage.pageItems.length > 0 ? <div className="divide-y divide-surface-100 border-y border-surface-100">
                {searchPoolPage.pageItems.map(item => <div key={item.id} className="flex items-center justify-between gap-3 px-3 py-3">
                  <label className="flex shrink-0 items-center">
                    <input type="checkbox" checked={selectedSearchPoolIdSet.has(item.id)} onChange={() => toggleSearchPoolItem(item.id)} className="h-4 w-4 accent-emerald-700" aria-label={`选择 ${item.company || item.title || '客户'}`} />
                  </label>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-surface-800">{item.company || item.title || '未命名客户'}</p>
                    <p className="mt-1 truncate text-xs text-surface-500">{item.country || '未标注国家'} {'·'} <span title={presentSource(item.source).tooltip}>{presentSource(item.source).label}</span> {'·'} {item.website || '暂无网站'}</p>
                  </div>
                  <button onClick={() => { toggleSearchPoolItem(item.id) }} className="shrink-0 border border-surface-300 bg-white px-3 py-1.5 text-xs font-semibold text-surface-700 hover:border-surface-500">{selectedSearchPoolIdSet.has(item.id) ? '已选择' : '选择'}</button>
                </div>)}
              </div> : <p className="mt-4 border border-dashed border-surface-300 bg-white/45 px-4 py-8 text-center text-sm text-surface-400">{'暂无待背调的新客户。'}</p>}
              <PaginationBar page={searchPoolPage.page} pageCount={searchPoolPage.pageCount} total={searchPoolItems.length} pageSize={searchPoolPage.pageSize} onPageChange={searchPoolPage.setPage} />
            </section>

            {history.length > 0 && <details className="border border-white/80 bg-white/60 p-5 backdrop-blur-xl">
              <summary className="cursor-pointer list-none text-sm font-semibold text-surface-700">最近搜索记录</summary>
              <div className="mt-3 space-y-2">
                {history.slice(0, 6).map(session => <div key={session.id} className="flex items-center justify-between gap-4 border-b border-surface-200 py-2 text-xs"><div className="min-w-0"><p className="truncate font-semibold text-surface-700">{session.product}</p><p className="mt-1 text-surface-400">{session.country || '历史记录'} · {session.queries.length} 条查询 · 跳过 {session.deferredQueries || 0} 条</p></div><span className="shrink-0 font-semibold text-emerald-700">{session.matched} 新增</span></div>)}
              </div>
            </details>}
          </section>
        </div>
      </div>
    </main>
  )
}
