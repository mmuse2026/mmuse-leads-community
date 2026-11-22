import { useEffect, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import DailyWorkbench from './pages/DailyWorkbench'
import PipelineView from './pages/PipelineView'
import ItemDetail from './pages/ItemDetail'
import DataAdmin from './pages/DataAdmin'
import EmailBatch from './pages/EmailBatch'
import SearchWorkbench from './pages/SearchWorkbench'
import DevelopmentWorkbench from './pages/DevelopmentWorkbench'
import APoolReview from './pages/APoolReview'
import UserSettings from './pages/UserSettings'
import CsvImport from './pages/CsvImport'
import TradeDocuments from './pages/TradeDocuments'
import PlanTasks from './pages/PlanTasks'
import SmartAddCustomer from './pages/SmartAddCustomer'
import SendQueue from './pages/SendQueue'
import Replies from './pages/Replies'
import CrmCardList from './pages/CrmCardList'
import CrmFollowupWorkbench from './pages/CrmFollowupWorkbench'
import MarketingWorkbench from './pages/MarketingWorkbench'
import { loadFromDisk, db } from './store/db'
import { API_BASE } from './services/config'

function syncApiKeys() {
  fetch(`${API_BASE}/api/config`, { signal: AbortSignal.timeout(5000) })
    .then(r => r.json())
    .then((cfg: any) => {
      const keyMap: Record<string, string> = {
        serper: cfg.serperApiKey || '',
        justserp: cfg.justserpApiKey || '',
        apify: cfg.apifyApiKey || '',
      }
      try {
        const searchRaw = localStorage.getItem('mmuse_search_config')
        if (searchRaw) {
          const sc = JSON.parse(searchRaw)
          let changed = false
          for (const ch of sc.channels || []) {
            if (!ch.apiKey && keyMap[ch.id]) { ch.apiKey = keyMap[ch.id]; changed = true }
          }
          if (changed) localStorage.setItem('mmuse_search_config', JSON.stringify(sc))
        }
      } catch {}
      if (cfg.hunterApiKey) {
        try {
          const mc = JSON.parse(localStorage.getItem('mmuse_config') || '{}')
          if (!mc.hunterKey) { mc.hunterKey = cfg.hunterApiKey; localStorage.setItem('mmuse_config', JSON.stringify(mc)) }
        } catch {}
      }
    })
    .catch(() => {})
}

export default function App() {
  useEffect(() => {
    // 启动：从后端加载一次数据到 IndexedDB
    ;(async () => {
      let loaded = await loadFromDisk().catch(() => 0)
      console.log(`[startup] 已加载 ${loaded} 条数据`)

      // 迁移已收敛为一次性任务：不随每次页面加载自动重跑（每次全量遍历+写回会触发
      // 服务器全量写盘阻塞事件循环）。需要时可从数据管理页手动触发 classifyExistingItems/migrateDevStatus。
    })()
    syncApiKeys()
  }, [])

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/daily-workbench" element={<DailyWorkbench />} />
        <Route path="/pipeline/outreach" element={<Navigate to="/develop" replace />} />
        <Route path="/pipeline/:key" element={<PipelineView />} />
        <Route path="/item/:id" element={<ItemDetail />} />
        <Route path="/crm-card/:card" element={<CrmCardList />} />
        <Route path="/crm-followups" element={<CrmFollowupWorkbench />} />
        <Route path="/marketing" element={<MarketingWorkbench />} />
        <Route path="/search-workbench" element={<SearchWorkbench />} />
        <Route path="/admin" element={<DataAdmin />} />
        <Route path="/email-batch" element={<EmailBatch />} />
        <Route path="/send-queue" element={<SendQueue />} />
        <Route path="/replies" element={<Replies />} />
        <Route path="/develop" element={<DevelopmentWorkbench />} />
        <Route path="/a-review" element={<APoolReview />} />
        <Route path="/import" element={<CsvImport />} />
        <Route path="/settings" element={<UserSettings />} />
        <Route path="/smart-add" element={<SmartAddCustomer />} />
        <Route path="/keywords" element={<Navigate to="/search-workbench" replace />} />
        <Route path="/search" element={<Navigate to="/search-workbench" replace />} />
        <Route path="/discovery" element={<Navigate to="/search-workbench" replace />} />
        <Route path="/backup" element={<Navigate to="/admin" replace />} />
        <Route path="/clients" element={<Navigate to="/admin" replace />} />
        <Route path="/clients/:category" element={<Navigate to="/admin" replace />} />
        <Route path="/trade-documents" element={<TradeDocuments />} />
        <Route path="/plan-tasks" element={<PlanTasks />} />
      </Route>
    </Routes>
  )
}
