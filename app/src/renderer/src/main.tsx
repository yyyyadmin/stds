import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// 白屏防护：阻止系统文件/图片拖入窗口时 Chromium 的默认导航（会整页替换为所拖文件）
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => e.preventDefault())

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
