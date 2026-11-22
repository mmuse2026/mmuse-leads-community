import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/',
  resolve: {
    alias: [
      // 浏览器没有 node:crypto。唯一正式发信门禁 formalSendGate 在 server 侧真实执行；
      // 浏览器侧只是展示镜像（经 draftReview 引用该模块），把 createHash 指到 Web 兼容垫片，
      // 保证 vite build 不因 node:crypto 失败。真实发信/门禁以后端为准。
      { find: /^node:crypto$/, replacement: fileURLToPath(new URL('./src/shims/nodeCrypto.ts', import.meta.url)) },
      // node:fs / node:path：profiles.ts 被前端工作台页面（DevelopmentWorkbench/SearchWorkbench/store/db）
      // 经 leadScoring/backcheckAutoRouting/leadQueryPlanner 间接引用，其 getActiveProfile 内部 try/catch
      // 兜底回退 default，浏览器侧抛错不崩页面。真实配置读取始终在 server 端。
      { find: /^node:fs$/, replacement: fileURLToPath(new URL('./src/shims/nodeFs.ts', import.meta.url)) },
      { find: /^node:path$/, replacement: fileURLToPath(new URL('./src/shims/nodePath.ts', import.meta.url)) },
    ],
  },
  define: {
    // 浏览器无 __dirname；profiles.ts/refillTrigger.ts 顶层用它拼 CONFIG_FILE，
    // 定义成无害字符串（真实路径只在 server 端生效）。
    __dirname: '"/"',
  },
  server: {
    port: 5274,
    host: '0.0.0.0',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})

