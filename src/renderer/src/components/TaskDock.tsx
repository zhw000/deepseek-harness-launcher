import { Check, ChevronDown, ChevronUp, CircleAlert, Clock, ListChecks, ScrollText, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { TaskInfo } from '../../../shared/types'
import { api } from '../api'
import { store, useAppState, useStore } from '../store'
import { Progress, Spinner } from './ui'

const RECENT_MS = 8000

function TaskLog({ id }: { id: string }) {
  const ref = useRef<HTMLPreElement>(null)
  const text = useStore(current => current.taskLog(id) ?? '')
  useEffect(() => {
    void api.getTaskLog(id).then(initial => store.seedTaskLog(id, initial))
  }, [id])
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [text])
  return <pre ref={ref} className="task-log">{text || '暂无输出'}</pre>
}

function StatusIcon({ task }: { task: TaskInfo }) {
  switch (task.status) {
    case 'running': return <Spinner size={15} />
    case 'queued': return <Clock size={15} className="faint" />
    case 'done': return <Check size={15} className="ok" />
    case 'failed': return <CircleAlert size={15} className="bad" />
    default: return <X size={15} className="faint" />
  }
}

export function TaskDock() {
  const { tasks } = useAppState()
  const [open, setOpen] = useState(true)
  const [logFor, setLogFor] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick(tick => tick + 1), 2000)
    return () => clearInterval(timer)
  }, [])

  const visible = tasks.filter((task) => {
    if (task.status === 'queued' || task.status === 'running') return true
    if (dismissed.has(task.id)) return false
    if (task.status === 'failed') return true
    return task.endedAt !== null && Date.now() - new Date(task.endedAt).getTime() < RECENT_MS
  })
  if (visible.length === 0) return null
  const active = visible.filter(task => task.status === 'queued' || task.status === 'running').length
  const dismiss = (id: string) => setDismissed(previous => new Set(previous).add(id))

  return (
    <div className="dock">
      <button type="button" className="dock-head" onClick={() => setOpen(!open)}>
        <ListChecks size={16} />
        <span className="grow">{active > 0 ? `${active} 个任务进行中` : '任务'}</span>
        {open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
      </button>
      {open && (
        <div className="dock-body">
          {visible.map(task => (
            <div key={task.id} className={`task ${task.status}`}>
              <div className="row">
                <StatusIcon task={task} />
                <div className="grow">
                  <div className="task-title ellipsis" title={task.title}>{task.title}</div>
                  <div className={`task-detail ${task.status === 'failed' ? 'bad' : ''}`}>
                    {task.status === 'failed' ? task.error : task.status === 'cancelled' ? '已取消' : task.status === 'done' ? '完成' : task.detail}
                  </div>
                </div>
                <button type="button" className="btn ghost sm icon" title="查看日志" onClick={() => setLogFor(logFor === task.id ? null : task.id)}>
                  <ScrollText size={14} />
                </button>
                {task.status === 'queued' || task.status === 'running'
                  ? <button type="button" className="btn ghost sm icon" title="取消" onClick={() => void api.cancelTask(task.id)}><X size={14} /></button>
                  : <button type="button" className="btn ghost sm icon" title="关闭" onClick={() => dismiss(task.id)}><X size={14} /></button>}
              </div>
              {task.status === 'running' && <Progress value={task.progress} />}
              {logFor === task.id && <TaskLog id={task.id} />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
