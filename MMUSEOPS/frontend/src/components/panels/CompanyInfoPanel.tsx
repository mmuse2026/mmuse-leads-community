import { useState, useEffect } from 'react'
import { loadProfile, saveProfile, type UserProfile } from '../../store/userProfile'

export default function CompanyInfoPanel() {
  const [profile, setProfile] = useState<UserProfile>(loadProfile)
  const [saved, setSaved] = useState(false)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => { setProfile(loadProfile()) }, [])

  const update = (patch: Partial<UserProfile>) => {
    setProfile(prev => ({ ...prev, ...patch }))
  }

  const handleSave = () => {
    saveProfile(profile)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="stat-card">
      {/* 折叠头 */}
      <button onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between bg-transparent border-none cursor-pointer font-inherit text-left">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-surface-800">公司信息</h2>
          <span className="text-[10px] text-surface-400 font-normal">发送开发信时作为签名</span>
        </div>
        <span className={`text-surface-400 transition-transform ${collapsed ? 'rotate-0' : 'rotate-180'}`}>▼</span>
      </button>

      {!collapsed && (
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="text-[10px] text-surface-500 block mb-1">公司名称</label>
              <input type="text" value={profile.companyName}
                onChange={e => update({ companyName: e.target.value })}
                className="input text-sm" />
            </div>
            <div>
              <label className="text-[10px] text-surface-500 block mb-1">产品信息</label>
              <input type="text" value={profile.productInfo}
                onChange={e => update({ productInfo: e.target.value })}
                className="input text-sm" />
            </div>
            <div>
              <label className="text-[10px] text-surface-500 block mb-1">有无工厂</label>
              <div className="flex gap-2 h-[38px] items-center">
                <button onClick={() => update({ hasFactory: true })}
                  className={`px-4 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                    profile.hasFactory
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
                      : 'border-surface-200 text-surface-400 hover:border-surface-300'
                  }`}>有工厂</button>
                <button onClick={() => update({ hasFactory: false })}
                  className={`px-4 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                    !profile.hasFactory
                      ? 'bg-amber-50 text-amber-700 border-amber-300'
                      : 'border-surface-200 text-surface-400 hover:border-surface-300'
                  }`}>无工厂</button>
              </div>
            </div>
            <div>
              <label className="text-[10px] text-surface-500 block mb-1">工作年限</label>
              <input type="text" value={profile.yearsInBusiness}
                onChange={e => update({ yearsInBusiness: e.target.value })}
                className="input text-sm" placeholder="如: 15" />
            </div>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <div>
              <label className="text-[10px] text-surface-500 block mb-1">行业优势</label>
              <input type="text" value={profile.industryAdvantage}
                onChange={e => update({ industryAdvantage: e.target.value })}
                className="input text-sm" />
            </div>
            <div>
              <label className="text-[10px] text-surface-500 block mb-1">邮箱</label>
              <input type="email" value={profile.email}
                onChange={e => update({ email: e.target.value })}
                className="input text-sm" />
            </div>
            <div>
              <label className="text-[10px] text-surface-500 block mb-1">网站</label>
              <input type="text" value={profile.website}
                onChange={e => update({ website: e.target.value })}
                className="input text-sm" />
            </div>
          </div>
          <div className="flex justify-end">
            <button onClick={handleSave}
              className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-all border-none cursor-pointer font-inherit ${
                saved
                  ? 'bg-emerald-100 text-emerald-700'
                  : 'bg-accent-600 text-white hover:bg-accent-700'
              }`}>
              {saved ? '已保存' : '保存信息'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
