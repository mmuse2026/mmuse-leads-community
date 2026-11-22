import { useState, useRef } from 'react'
import { getAllItems, saveItem } from '../store/db'
import { extractFromText, extractFromImage, type ExtractedCustomer } from '../services/smartCustomer'
import type { PipelineItem } from '../types/item'

const CLIENT_TYPE_OPTIONS = [
  { value: 'distributor', label: '经销商' },
  { value: 'trader', label: '贸易商' },
  { value: 'ecommerce', label: '电商' },
  { value: 'wholesaler', label: '批发商' },
  { value: 'retailer', label: '零售商' },
  { value: 'manufacturer', label: '制造商' },
]

const BIZ_LINE_OPTIONS = [
  { value: 'furniture', label: '家具' },
  { value: 'car-seat', label: '汽车座椅套' },
  { value: 'lighting', label: '照明' },
  { value: 'home', label: '家居日用' },
  { value: 'packaging', label: '包装材料' },
]

export default function SmartAddCustomer() {
  const [mode, setMode] = useState<'text' | 'image'>('text')
  const [text, setText] = useState('')
  const [imagePreview, setImagePreview] = useState('')
  const [extracting, setExtracting] = useState(false)
  const [result, setResult] = useState<ExtractedCustomer | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleExtract = async () => {
    setError('')
    setResult(null)
    setSaved(false)
    setExtracting(true)
    try {
      let r: ExtractedCustomer
      if (mode === 'text') {
        if (!text.trim()) { throw new Error('请粘贴客户信息文本') }
        r = await extractFromText(text)
      } else {
        if (!imagePreview) { throw new Error('请上传截图') }
        r = await extractFromImage(imagePreview)
      }
      setResult(r)
    } catch (e: any) {
      setError(e.message || '识别失败')
    } finally {
      setExtracting(false)
    }
  }

  const handleSave = async () => {
    if (!result) return
    setSaving(true)
    try {
      const all = await getAllItems()
      const now = new Date().toISOString()
      const newItem: PipelineItem = {
        id: crypto.randomUUID(),
        pipelineId: 'outreach',
        title: result.company || result.contactName || '新客户',
        currentStageId: 'prospecting',
        status: 'active',
        priority: 'medium',
        source: (result.source as any) || 'manual',
        contactName: result.contactName,
        company: result.company,
        email: result.email,
        phone: result.phone,
        country: result.country,
        website: result.website,
        level: 'unknown',
        clientType: (result.clientType as any) || 'unknown',
        emailVerification: 'unknown',
        emailBounced: false,
        businessLine: result.businessLine === 'furniture' ? 'furniture' : result.businessLine === 'car-seat' ? 'car-seat' : 'furniture',
        backCheck: result.summary || result.products.length > 0 ? {
          checkedAt: now,
          summary: result.summary,
          products: result.products,
          decisionMakers: result.decisionMakers.map(dm => ({ name: dm.name, title: dm.title })),
        } : undefined,
        notes: [],
        attachments: [],
        timeline: [{ stageId: 'prospecting', enteredAt: now }],
        createdAt: now,
        updatedAt: now,
        currency: 'USD',
      }
      await saveItem(newItem)
      setSaved(true)
      setResult(null)
      setText('')
      setImagePreview('')
      if (fileInputRef.current) fileInputRef.current.value = ''
    } catch (e: any) {
      setError('保存失败: ' + (e.message || '未知错误'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-6 lg:px-8 py-3 border-b border-surface-200 flex items-center gap-3">
        <h1 className="text-lg font-bold text-surface-900">智能添加客户</h1>
      </div>

      <div className="max-w-4xl mx-auto p-6 lg:p-8 space-y-6">
        {/* 模式切换 */}
        <div className="flex items-center gap-2">
          <button onClick={() => { setMode('text'); setResult(null); setError('') }}
            className={`px-4 py-2 rounded-lg text-xs font-semibold border transition-all cursor-pointer font-inherit ${
              mode === 'text'
                ? 'bg-surface-900 text-white border-surface-900'
                : 'bg-surface-0 text-surface-600 border-surface-200 hover:border-surface-400'
            }`}>
            粘贴文本
          </button>
          <button onClick={() => { setMode('image'); setResult(null); setError('') }}
            className={`px-4 py-2 rounded-lg text-xs font-semibold border transition-all cursor-pointer font-inherit ${
              mode === 'image'
                ? 'bg-surface-900 text-white border-surface-900'
                : 'bg-surface-0 text-surface-600 border-surface-200 hover:border-surface-400'
            }`}>
            上传截图
          </button>
        </div>

        {/* 输入区 */}
        {mode === 'text' ? (
          <textarea value={text} onChange={e => setText(e.target.value)}
            placeholder={`在此粘贴客户信息...\n\n可以从 LinkedIn、公司官网、展会名录等复制：\n\nCompany: ABC Furniture Co., Ltd\nContact: John Smith\nEmail: contact@example.com\nPhone: +1-555-1234\nWebsite: example.com\nCountry: USA\nProducts: Restaurant tables, dining chairs, bar stools`}
            rows={10}
            className="w-full text-sm bg-surface-50 border border-surface-200 rounded-xl px-4 py-3 outline-none focus:border-surface-400 font-inherit resize-y" />
        ) : (
          <div className="bg-surface-50 border border-surface-200 rounded-xl p-6">
            {!imagePreview ? (
              <div className="flex flex-col items-center justify-center py-12 text-surface-400">
                <label className="cursor-pointer flex flex-col items-center gap-3">
                  <input ref={fileInputRef} type="file" accept="image/*"
                    onChange={e => {
                      const file = e.target.files?.[0]
                      if (!file) return
                      const reader = new FileReader()
                      reader.onload = ev => setImagePreview(ev.target?.result as string || '')
                      reader.readAsDataURL(file)
                    }}
                    className="hidden" />
                  <span className="w-16 h-16 rounded-full bg-surface-200 flex items-center justify-center text-2xl text-surface-400">+</span>
                  <span className="text-sm font-medium text-accent-600">点击上传截图</span>
                </label>
                <p className="text-xs text-surface-400 mt-2">支持 LinkedIn 页面、公司官网、展会名录等截图</p>
              </div>
            ) : (
              <div className="relative">
                <img src={imagePreview} alt="截图预览" className="max-h-96 mx-auto rounded-lg border border-surface-200" />
                <button onClick={() => { setImagePreview(''); setResult(null) }}
                  className="absolute top-2 right-2 text-xs px-2 py-1 rounded bg-black/50 text-white hover:bg-black/70 border-none cursor-pointer font-inherit">
                  重新上传
                </button>
              </div>
            )}
          </div>
        )}

        {/* 识别按钮 */}
        <div className="flex items-center gap-3">
          <button onClick={handleExtract} disabled={extracting || (mode === 'text' && !text.trim()) || (mode === 'image' && !imagePreview)}
            className="text-sm font-bold px-6 py-2.5 rounded-xl border-none cursor-pointer font-inherit transition-all bg-surface-900 text-white hover:bg-surface-800 disabled:bg-surface-300 disabled:text-surface-500 shadow-sm">
            {extracting ? '识别中...' : '开始识别'}
          </button>
          {error && <span className="text-xs text-red-500">{error}</span>}
        </div>

        {/* 识别结果预览 */}
        {result && (
          <div className="bg-surface-0 border border-surface-200 rounded-xl p-6 shadow-card space-y-5">
            <h2 className="text-sm font-bold text-surface-900">识别结果</h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-[10px] text-surface-500 block mb-1 font-medium">公司名称</label>
                <input type="text" value={result.company} readOnly
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none font-inherit" />
              </div>
              <div>
                <label className="text-[10px] text-surface-500 block mb-1 font-medium">联系人</label>
                <input type="text" value={result.contactName} readOnly
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none font-inherit" />
              </div>
              <div>
                <label className="text-[10px] text-surface-500 block mb-1 font-medium">邮箱</label>
                <input type="text" value={result.email} readOnly
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none font-inherit" />
              </div>
              <div>
                <label className="text-[10px] text-surface-500 block mb-1 font-medium">电话</label>
                <input type="text" value={result.phone} readOnly
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none font-inherit" />
              </div>
              <div>
                <label className="text-[10px] text-surface-500 block mb-1 font-medium">网站</label>
                <input type="text" value={result.website} readOnly
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none font-inherit" />
              </div>
              <div>
                <label className="text-[10px] text-surface-500 block mb-1 font-medium">国家</label>
                <input type="text" value={result.country} readOnly
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none font-inherit" />
              </div>
              <div>
                <label className="text-[10px] text-surface-500 block mb-1 font-medium">业务线</label>
                <input type="text" value={BIZ_LINE_OPTIONS.find(o => o.value === result.businessLine)?.label || result.businessLine} readOnly
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none font-inherit" />
              </div>
              <div>
                <label className="text-[10px] text-surface-500 block mb-1 font-medium">客户类型</label>
                <input type="text" value={CLIENT_TYPE_OPTIONS.find(o => o.value === result.clientType)?.label || result.clientType} readOnly
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none font-inherit" />
              </div>
            </div>

            {/* 主营产品 */}
            {result.products.length > 0 && (
              <div>
                <label className="text-[10px] text-surface-500 block mb-1 font-medium">主营产品</label>
                <div className="flex flex-wrap gap-1.5">
                  {result.products.map((p, i) => (
                    <span key={i} className="text-[11px] px-2 py-1 rounded-full bg-surface-100 text-surface-700 border border-surface-200">
                      {p}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* 决策人 */}
            {result.decisionMakers.length > 0 && (
              <div>
                <label className="text-[10px] text-surface-500 block mb-1 font-medium">决策人</label>
                <div className="space-y-1">
                  {result.decisionMakers.map((dm, i) => (
                    <div key={i} className="text-xs text-surface-700 bg-surface-50 rounded-lg px-3 py-2 border border-surface-100">
                      <span className="font-semibold">{dm.name}</span>
                      {dm.title && <span className="text-surface-400 ml-2">- {dm.title}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 摘要 */}
            {result.summary && (
              <div>
                <label className="text-[10px] text-surface-500 block mb-1 font-medium">公司简介</label>
                <p className="text-xs text-surface-700 bg-surface-50 rounded-lg px-3 py-2 border border-surface-100 leading-relaxed whitespace-pre-wrap">
                  {result.summary}
                </p>
              </div>
            )}

            {/* 信息来源 */}
            {result.source && (
              <div className="text-[10px] text-surface-400">
                信息来源: {result.source}
              </div>
            )}

            {/* 保存按钮 */}
            {saved ? (
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
                <p className="text-xs text-emerald-700 font-medium">✓ 已保存到客户库，可在数据管理中查看</p>
              </div>
            ) : (
              <button onClick={handleSave} disabled={saving}
                className="btn-primary text-sm w-full">
                {saving ? '保存中...' : '保存到客户库'}
              </button>
            )}
          </div>
        )}

        {/* 提示 */}
        <details className="bg-surface-50 border border-surface-200 rounded-xl p-4">
          <summary className="cursor-pointer list-none text-xs font-semibold text-surface-700">支持的信息来源</summary>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px] text-surface-500">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
              LinkedIn 公司页 / 个人主页
            </div>
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
              公司官网 About/Contact 页面
            </div>
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
              展会名录 / 行业黄页
            </div>
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
              邮件签名 / 报价单
            </div>
          </div>
        </details>
      </div>
    </div>
  )
}
