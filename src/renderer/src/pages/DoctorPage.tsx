import { CircleAlert, CircleCheck, Copy, HeartPulse, TriangleAlert } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { CheckFix, CheckStatus, DoctorReport } from '../../../shared/types'
import { api } from '../api'
import { Banner, Spinner } from '../components/ui'
import { formatDate } from '../format'
import { attempt, navigate, useAction, type Route } from '../store'

const ICON: Record<CheckStatus, ReactNode> = {
  ok: <CircleCheck size={17} className="ok" />,
  warn: <TriangleAlert size={17} style={{ color: 'var(--warning)' }} />,
  error: <CircleAlert size={17} className="bad" />,
}

const FIX: Record<CheckFix, { label: string; route: Route }> = {
  setup: { label: '去安装', route: 'home' },
  home: { label: '去启动页', route: 'home' },
  versions: { label: '去版本页', route: 'versions' },
  plugins: { label: '去插件页', route: 'plugins' },
  settings: { label: '去设置', route: 'settings' },
}

const MARK: Record<CheckStatus, string> = { ok: '✅', warn: '⚠️', error: '❌' }

function toMarkdown(report: DoctorReport): string {
  return [
    '## DSH Launcher 体检报告',
    '',
    `- 启动器：v${report.launcherVersion}（${report.platform}）`,
    `- 时间：${report.checkedAt}`,
    '',
    ...report.checks.map(check => `- ${MARK[check.status]} **${check.title}**：${check.detail}`),
  ].join('\n')
}

export function DoctorPage() {
  const [report, setReport] = useState<DoctorReport | null>(null)
  const [busy, run] = useAction()
  const check = () => void run(async () => setReport(await api.runDoctor()))
  const errors = report?.checks.filter(item => item.status === 'error').length ?? 0
  const warnings = report?.checks.filter(item => item.status === 'warn').length ?? 0

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">体检</h1>
          <p className="page-sub">检查运行时、pnpm、下载源、端口、配置与插件状态，找出启动或安装失败的原因。</p>
        </div>
        <div className="page-actions">
          {report !== null && (
            <button type="button" className="btn" title="报告会包含本机路径，粘贴前请先看一眼"
              onClick={() => void attempt(() => navigator.clipboard.writeText(toMarkdown(report)), '报告已复制，可以粘贴到 issue 里')}>
              <Copy size={15} />复制报告
            </button>
          )}
          <button type="button" className="btn primary" disabled={busy} onClick={check}>
            {busy ? <Spinner /> : <HeartPulse size={16} />}{report === null ? '开始体检' : '重新体检'}
          </button>
        </div>
      </div>

      {report === null && !busy && (
        <div className="card empty">
          <HeartPulse size={30} />
          <p>遇到启动失败、插件装不上、下载很慢时，先做一次体检。</p>
          <button type="button" className="btn primary" onClick={check}>开始体检</button>
        </div>
      )}
      {report === null && busy && <div className="card empty"><Spinner />正在检查，下载源测速需要几秒钟…</div>}

      {report !== null && (
        <>
          <div className="stack" style={{ marginBottom: 14 }}>
            {errors > 0 && <Banner level="error">{errors} 项有问题需要处理{warnings > 0 ? `，另有 ${warnings} 项提醒` : ''}。</Banner>}
            {errors === 0 && warnings > 0 && <Banner level="warning">没有阻断性问题，有 {warnings} 项值得留意。</Banner>}
            {errors === 0 && warnings === 0 && <Banner level="success">一切正常。</Banner>}
          </div>
          <div className="card list">
            {report.checks.map(item => (
              <div key={item.id} className="list-row">
                {ICON[item.status]}
                <div className="grow">
                  <div className="strong">{item.title}</div>
                  <div className="faint doctor-detail">{item.detail}</div>
                </div>
                {item.fix !== null && item.status !== 'ok' && (
                  <button type="button" className="btn sm" onClick={() => navigate(FIX[item.fix!].route)}>{FIX[item.fix].label}</button>
                )}
              </div>
            ))}
          </div>
          <p className="faint" style={{ marginTop: 10 }}>检查于 {formatDate(report.checkedAt, true)}</p>
        </>
      )}
    </div>
  )
}
