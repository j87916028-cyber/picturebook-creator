import { Component, ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  message: string
  stack: string
}

/**
 * Top-level error boundary — catches any unhandled React render/lifecycle error
 * and shows a friendly recovery screen instead of a blank white page.
 *
 * React error boundaries must be class components (no hooks equivalent).
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '', stack: '' }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      message: error?.message ?? String(error),
      stack: error?.stack ?? '',
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Log to console so developers can inspect in DevTools
    console.error('[ErrorBoundary] Uncaught error:', error, info.componentStack)
  }

  handleReload = () => {
    window.location.reload()
  }

  handleCopy = () => {
    const text = `錯誤訊息：${this.state.message}\n\n${this.state.stack}`
    navigator.clipboard.writeText(text).catch(() => {})
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div className="error-boundary-overlay" role="alert">
        <div className="error-boundary-card">
          <div className="error-boundary-icon">😵</div>
          <h2 className="error-boundary-title">哎呀，發生了一點問題</h2>
          <p className="error-boundary-desc">
            應用程式遇到了意料外的錯誤，你的作品已自動儲存至資料庫。<br />
            重新整理頁面即可恢復。
          </p>
          {this.state.message && (
            <pre className="error-boundary-detail">{this.state.message}</pre>
          )}
          <div className="error-boundary-actions">
            <button className="error-boundary-btn primary" onClick={this.handleReload}>
              🔄 重新整理頁面
            </button>
            <button className="error-boundary-btn secondary" onClick={this.handleCopy} title="複製錯誤詳情以回報問題">
              📋 複製錯誤訊息
            </button>
          </div>
        </div>
      </div>
    )
  }
}
