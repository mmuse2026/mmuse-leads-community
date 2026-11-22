import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { loadProfile, saveProfile, type UserProfile } from '../store/userProfile'
import { API_BASE } from '../services/config'

interface MailIsolationForm {
  primaryBusinessEmail: string
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  imapHost: string
  imapPort: number
  imapSecure: boolean
  returnPathEmail: string
  replyToEmail: string
  forwardToEmail: string
  allowImapRecovery: boolean
}

const EMPTY_MAIL_ISOLATION: MailIsolationForm = {
  primaryBusinessEmail: '',
  smtpHost: '',
  smtpPort: 587,
  smtpSecure: false,
  imapHost: '',
  imapPort: 993,
  imapSecure: true,
  returnPathEmail: '',
  replyToEmail: '',
  forwardToEmail: '',
  allowImapRecovery: false,
}

export default function UserSettings() {
  const navigate = useNavigate()
  const [profile, setProfile] = useState<UserProfile>(loadProfile)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [mailIsolation, setMailIsolation] = useState<MailIsolationForm>(EMPTY_MAIL_ISOLATION)
  const [mailIsolationTouched, setMailIsolationTouched] = useState(false)

  const updateMailIsolation = (patch: Partial<MailIsolationForm>) => {
    setMailIsolationTouched(true)
    setMailIsolation(prev => ({ ...prev, ...patch }))
  }
  useEffect(() => {
    const p = loadProfile()
    // 从后端拉取当前配置，预填 API 密钥
    fetch(`${API_BASE}/api/config`)
      .then(r => r.json())
      .then((cfg: any) => {
        const merged = {
          ...p,
          serperApiKey: cfg.serperApiKey || p.serperApiKey || '',
          serperApiKey2: cfg.serperApiKey2 || p.serperApiKey2 || '',
          llmModel: cfg.llmModel || p.llmModel || '',
          llmApiKey: cfg.llmApiKey || p.llmApiKey || '',
          llmBaseUrl: cfg.llmBaseUrl || p.llmBaseUrl || '',
          justserpApiKey: cfg.justserpApiKey || p.justserpApiKey || '',
          justserpApiKey2: cfg.justserpApiKey2 || p.justserpApiKey2 || '',
          apifyApiKey: cfg.apifyApiKey || p.apifyApiKey || '',
          hunterApiKey: cfg.hunterApiKey || p.hunterApiKey || '',
          resendApiKey: cfg.resendApiKey || p.resendApiKey || '',
          braveApiKey: cfg.braveApiKey || p.braveApiKey || '',
          snovioUserId: cfg.snovioUserId || p.snovioUserId || '',
          snovioSecret: cfg.snovioSecret || p.snovioSecret || '',
          email: cfg.primaryBusinessEmail || p.email || '',
          zohoEmail: cfg.zohoEmail || p.zohoEmail || '',
          zohoPassword: p.zohoPassword || '',
          bankName: cfg.bankName || p.bankName || '',
          bankAccount: cfg.bankAccount || p.bankAccount || '',
          swiftCode: cfg.swiftCode || p.swiftCode || '',
          bankAddress: cfg.bankAddress || p.bankAddress || '',
        }
        setProfile(merged)
        saveProfile(merged)
      })
      .catch(() => {
        // 后端不可用时用本地配置
        setProfile(p)
      })
      .finally(() => setLoading(false))
  }, [])

  const update = (patch: Partial<UserProfile>) => {
    setProfile(prev => ({ ...prev, ...patch }))
  }

  const handleSave = async () => {
    setSaving(true)
    setSaved(false)
    setSaveError('')
    try {
      const response = await fetch(`${API_BASE}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serperApiKey: profile.serperApiKey,
          serperApiKey2: profile.serperApiKey2,
          llmApiKey: profile.llmApiKey,
          llmBaseUrl: profile.llmBaseUrl,
          llmModel: profile.llmModel,
          justserpApiKey: profile.justserpApiKey,
          justserpApiKey2: profile.justserpApiKey2,
          apifyApiKey: profile.apifyApiKey,
          hunterApiKey: profile.hunterApiKey,
          resendApiKey: profile.resendApiKey,
          braveApiKey: profile.braveApiKey,
          snovioUserId: profile.snovioUserId,
          snovioSecret: profile.snovioSecret,
          companyName: profile.companyName,
          zohoEmail: profile.zohoEmail,
          zohoPassword: profile.zohoPassword,
          bankName: profile.bankName,
          bankAccount: profile.bankAccount,
          swiftCode: profile.swiftCode,
          bankAddress: profile.bankAddress,
          ...(mailIsolationTouched ? mailIsolation : {}),
        }),
      })
      if (!response.ok) throw new Error('server configuration sync failed')
      saveProfile(profile)
      setProfile(previous => ({ ...previous, zohoPassword: '' }))
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      setSaveError('设置保存失败，请检查本地服务后重试。')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-sm text-surface-400">加载中...</div>
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-6 lg:px-8 py-3 border-b border-surface-100 flex items-center gap-3">
        <h1 className="text-lg font-bold text-surface-900">用户设置</h1>
      </div>

      <div className="max-w-4xl mx-auto p-6 lg:p-8 space-y-8">
        {/* 公司信息 */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-bold text-surface-900">公司信息</h2>
            </div>
          </div>
          <div className="bg-surface-0 border border-surface-200 rounded-xl p-5 space-y-4 shadow-card">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div>
                <label className="text-[10px] text-surface-500 block mb-1.5 font-medium">公司名称</label>
                <input type="text" value={profile.companyName}
                  onChange={e => update({ companyName: e.target.value })}
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none focus:border-surface-400 font-inherit" />
              </div>
              <div className="lg:col-span-2">
                <label className="text-[10px] text-surface-500 block mb-1.5 font-medium">业务描述（用于自动匹配客户）</label>
                <textarea value={profile.productInfo}
                  onChange={e => update({ productInfo: e.target.value })}
                  placeholder="请输入产品类别、目标市场和客户类型"
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none focus:border-surface-400 font-inherit resize-y"
                  rows={3} />
                <p className="text-[10px] text-surface-400 mt-1">用逗号分隔关键词可以提高匹配精度</p>
              </div>
              <div>
                <label className="text-[10px] text-surface-500 block mb-1.5 font-medium">有无工厂</label>
                <div className="flex gap-2 h-[38px] items-center">
                  <button onClick={() => update({ hasFactory: true })}
                    className={`px-4 py-1.5 rounded-lg text-xs font-medium border transition-all bg-transparent cursor-pointer font-inherit ${
                      profile.hasFactory
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
                        : 'border-surface-200 text-surface-400 hover:border-surface-300'
                    }`}>有工厂</button>
                  <button onClick={() => update({ hasFactory: false })}
                    className={`px-4 py-1.5 rounded-lg text-xs font-medium border transition-all bg-transparent cursor-pointer font-inherit ${
                      !profile.hasFactory
                        ? 'bg-amber-50 text-amber-700 border-amber-300'
                        : 'border-surface-200 text-surface-400 hover:border-surface-300'
                    }`}>无工厂</button>
                </div>
              </div>
              <div>
                <label className="text-[10px] text-surface-500 block mb-1.5 font-medium">工作年限</label>
                <input type="text" value={profile.yearsInBusiness}
                  onChange={e => update({ yearsInBusiness: e.target.value })}
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none focus:border-surface-400 font-inherit" placeholder="如: 15" />
              </div>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div>
                <label className="text-[10px] text-surface-500 block mb-1.5 font-medium">行业优势</label>
                <input type="text" value={profile.industryAdvantage}
                  onChange={e => update({ industryAdvantage: e.target.value })}
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none focus:border-surface-400 font-inherit" />
              </div>
              <div>
                <label className="text-[10px] text-surface-500 block mb-1.5 font-medium">邮箱</label>
                <input type="email" value={profile.email}
                  onChange={e => update({ email: e.target.value })}
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none focus:border-surface-400 font-inherit" />
              </div>
              <div>
                <label className="text-[10px] text-surface-500 block mb-1.5 font-medium">网站</label>
                <input type="text" value={profile.website}
                  onChange={e => update({ website: e.target.value })}
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none focus:border-surface-400 font-inherit" />
              </div>
            </div>
          </div>
        </section>

        {/* 收款信息 */}
        <details className="rounded-xl border border-surface-200 bg-white p-4">
          <summary className="cursor-pointer list-none text-sm font-semibold text-surface-700">收款信息</summary>
        <section className="mt-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-bold text-surface-900">收款信息</h2>
              <p className="text-[11px] text-surface-400 mt-0.5">预存银行信息，新建单据时自动填入</p>
            </div>
          </div>
          <div className="bg-surface-0 border border-surface-200 rounded-xl p-5 space-y-4 shadow-card">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div>
                <label className="text-[10px] text-surface-500 block mb-1.5 font-medium">收款银行</label>
                <input type="text" value={profile.bankName}
                  onChange={e => update({ bankName: e.target.value })}
                  placeholder="Bank of China, Tianjin Branch"
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none focus:border-surface-400 font-inherit" />
              </div>
              <div>
                <label className="text-[10px] text-surface-500 block mb-1.5 font-medium">银行账号</label>
                <input type="text" value={profile.bankAccount}
                  onChange={e => update({ bankAccount: e.target.value })}
                  placeholder="6212 1234 5678 9012"
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none focus:border-surface-400 font-inherit" />
              </div>
              <div>
                <label className="text-[10px] text-surface-500 block mb-1.5 font-medium">Swift Code</label>
                <input type="text" value={profile.swiftCode}
                  onChange={e => update({ swiftCode: e.target.value })}
                  placeholder="BKCHCNBJXXX"
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none focus:border-surface-400 font-inherit" />
              </div>
              <div>
                <label className="text-[10px] text-surface-500 block mb-1.5 font-medium">银行地址</label>
                <input type="text" value={profile.bankAddress}
                  onChange={e => update({ bankAddress: e.target.value })}
                  placeholder="请输入银行地址"
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none focus:border-surface-400 font-inherit" />
              </div>
            </div>
          </div>
        </section>
        </details>

        {/* 邮件账号 */}
        <details className="rounded-xl border border-surface-200 bg-white p-4">
          <summary className="cursor-pointer list-none text-sm font-semibold text-surface-700">邮件账号</summary>
        <section className="mt-4">
          <div className="mb-4">
            <h2 className="text-sm font-bold text-surface-900">发件与回信账号</h2>
            <label className="mt-3 block text-xs text-surface-700">发件邮箱
              <input type="email" value={profile.zohoEmail} onChange={e => update({ zohoEmail: e.target.value })}
                className="mt-1 block w-full rounded-lg border border-surface-200 px-3 py-2" />
            </label>
            <label className="mt-3 block text-xs text-surface-700">邮箱应用密码
              <input type="password" autoComplete="new-password" value={profile.zohoPassword}
                onChange={e => update({ zohoPassword: e.target.value })}
                className="mt-1 block w-full rounded-lg border border-surface-200 px-3 py-2" />
            </label>
            <p className="text-[11px] text-red-600 mt-1">请填写自己的邮件服务。保存仅更新配置。</p>
          </div>
          <div className="bg-surface-0 border border-surface-200 rounded-xl p-5 space-y-4 shadow-card">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {([
                ['primaryBusinessEmail', '主开发邮箱', 'email'],
                ['returnPathEmail', 'Return-Path 退信邮箱', 'email'],
                ['replyToEmail', 'Reply-To 回复邮箱', 'email'],
                ['forwardToEmail', '转发到主邮箱', 'email'],
                ['smtpHost', 'SMTP 主机', 'text'],
                ['imapHost', 'IMAP 主机', 'text'],
              ] as const).map(([field, label, type]) => (
                <div key={field}>
                  <label className="text-[10px] text-surface-500 block mb-1.5 font-medium">{label}</label>
                  <input type={type} value={mailIsolation[field]}
                    onChange={event => updateMailIsolation({ [field]: event.target.value })}
                    autoComplete="off"
                    className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none focus:border-surface-400 font-inherit" />
                </div>
              ))}
              <div>
                <label className="text-[10px] text-surface-500 block mb-1.5 font-medium">SMTP 端口</label>
                <input type="number" value={mailIsolation.smtpPort}
                  onChange={event => updateMailIsolation({ smtpPort: Number(event.target.value) })}
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none focus:border-surface-400 font-inherit" />
              </div>
              <div>
                <label className="text-[10px] text-surface-500 block mb-1.5 font-medium">IMAP 端口</label>
                <input type="number" value={mailIsolation.imapPort}
                  onChange={event => updateMailIsolation({ imapPort: Number(event.target.value) })}
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none focus:border-surface-400 font-inherit" />
              </div>
            </div>
            <div className="flex flex-wrap gap-4 text-xs text-surface-700">
              {([
                ['allowImapRecovery', 'IMAP回收'],
              ] as const).map(([field, label]) => (
                <label key={field} className="flex items-center gap-2">
                  <input type="checkbox" checked={mailIsolation[field]}
                    onChange={event => updateMailIsolation({ [field]: event.target.checked })} />
                  {label}授权状态（仅保存配置）
                </label>
              ))}
            </div>
            <p className="text-[11px] text-amber-700">实际发送和回信回收由对应业务页面管理。</p>
          </div>
        </section>
        </details>

        {/* API 配置 */}
        <details className="rounded-xl border border-surface-200 bg-white p-4">
          <summary className="cursor-pointer list-none text-sm font-semibold text-surface-700">API 配置</summary>
        <section className="mt-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-bold text-surface-900">API 配置</h2>
              <p className="text-[11px] text-surface-400 mt-0.5">密钥从后端加载，保存后自动同步到服务器，永久生效</p>
            </div>
          </div>
          <div className="bg-surface-0 border border-surface-200 rounded-xl p-5 space-y-4 shadow-card">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div>
                <label className="text-[10px] text-surface-500 block mb-1.5 font-medium">Serper 密钥1</label>
                <input type="password" value={profile.serperApiKey || ''}
                  onChange={e => update({ serperApiKey: e.target.value })}
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none focus:border-surface-400 font-inherit font-mono"
                  placeholder="当前使用服务器配置的密钥" />
              </div>
              <div>
                <label className="text-[10px] text-surface-500 block mb-1.5 font-medium">Serper 密钥2</label>
                <input type="password" value={profile.serperApiKey2 || ''}
                  onChange={e => update({ serperApiKey2: e.target.value })}
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none focus:border-surface-400 font-inherit font-mono"
                  placeholder="备用密钥" />
              </div>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div>
                <label className="text-[10px] text-surface-500 block mb-1.5 font-medium">本地 WebModel 访问标识</label>
                <input type="password" value={profile.llmApiKey || ''}
                  onChange={e => update({ llmApiKey: e.target.value })}
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none focus:border-surface-400 font-inherit font-mono"
                  placeholder="当前使用服务器配置的密钥" />
              </div>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div>
                <label className="text-[10px] text-surface-500 block mb-1.5 font-medium">JustSerp 密钥1</label>
                <input type="password" value={profile.justserpApiKey || ''}
                  onChange={e => update({ justserpApiKey: e.target.value })}
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none focus:border-surface-400 font-inherit font-mono" />
              </div>
              <div>
                <label className="text-[10px] text-surface-500 block mb-1.5 font-medium">JustSerp 密钥2</label>
                <input type="password" value={profile.justserpApiKey2 || ''}
                  onChange={e => update({ justserpApiKey2: e.target.value })}
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none focus:border-surface-400 font-inherit font-mono" />
              </div>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div>
                <label className="text-[10px] text-surface-500 block mb-1.5 font-medium">Apify API Key</label>
                <input type="password" value={profile.apifyApiKey || ''}
                  onChange={e => update({ apifyApiKey: e.target.value })}
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none focus:border-surface-400 font-inherit font-mono" />
              </div>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div>
                <label className="text-[10px] text-surface-500 block mb-1.5 font-medium">Hunter API Key</label>
                <input type="password" value={profile.hunterApiKey || ''}
                  onChange={e => update({ hunterApiKey: e.target.value })}
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none focus:border-surface-400 font-inherit font-mono" />
              </div>
              <div>
                <label className="text-[10px] text-surface-500 block mb-1.5 font-medium">Resend API Key</label>
                <input type="password" value={profile.resendApiKey || ''}
                  onChange={e => update({ resendApiKey: e.target.value })}
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none focus:border-surface-400 font-inherit font-mono" />
              </div>
              <div>
                <label className="text-[10px] text-surface-500 block mb-1.5 font-medium">Brave Search API Key</label>
                <input type="password" value={profile.braveApiKey || ''}
                  onChange={e => update({ braveApiKey: e.target.value })}
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none focus:border-surface-400 font-inherit font-mono" />
              </div>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div>
                <label className="text-[10px] text-surface-500 block mb-1.5 font-medium">Snov.io User ID</label>
                <input type="text" value={profile.snovioUserId || ''}
                  onChange={e => update({ snovioUserId: e.target.value })}
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none focus:border-surface-400 font-inherit font-mono"
                  placeholder="Snov.io 用户ID（邮箱搜索/验证）" />
              </div>
              <div>
                <label className="text-[10px] text-surface-500 block mb-1.5 font-medium">Snov.io Secret</label>
                <input type="password" value={profile.snovioSecret || ''}
                  onChange={e => update({ snovioSecret: e.target.value })}
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none focus:border-surface-400 font-inherit font-mono"
                  placeholder="Snov.io 密钥" />
              </div>
            </div>
            <label className="block text-xs text-surface-700">模型名称
              <input type="text" value={profile.llmModel} onChange={e => update({ llmModel: e.target.value })}
                className="mt-1 block w-full rounded-lg border border-surface-200 px-3 py-2" />
            </label>
            <div>
              <label className="text-[10px] text-surface-500 block mb-1.5 font-medium">模型服务地址</label>
              <div className="flex items-center gap-2">
                <input type="text" value={profile.llmBaseUrl}
                  onChange={e => update({ llmBaseUrl: e.target.value })}
                  className="flex-1 text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none focus:border-surface-400 font-inherit font-mono" />
                
              </div>
            </div>
          </div>
        </section>
        </details>

        {/* 保存按钮 */}
        <div className="flex justify-end pt-2">
          <button onClick={handleSave} disabled={saving}
            className={`px-6 py-2 rounded-lg text-sm font-medium transition-all border-none cursor-pointer font-inherit ${
              saved
                ? 'bg-emerald-100 text-emerald-700'
                : 'bg-surface-900 text-white hover:bg-surface-800'
            } disabled:opacity-50`}>
            {saving ? '保存中...' : saved ? '已保存' : '保存设置'}
          </button>
        </div>
        {saveError && <p className="mt-2 text-right text-xs text-red-600">{saveError}</p>}
      </div>
    </div>
  )
}
