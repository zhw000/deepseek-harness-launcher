import { useLayoutEffect, useRef, useState } from 'react'
import type { LogLine } from '../../../shared/types'

const RENDERED = 2000

function clock(time: number): string {
  const date = new Date(time)
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(part => String(part).padStart(2, '0')).join(':')
}

/** dsh output, following the tail unless the user scrolls up. */
export function LogView({ lines }: { lines: LogLine[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const [follow, setFollow] = useState(true)
  useLayoutEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [lines, follow])
  const shown = lines.length > RENDERED ? lines.slice(-RENDERED) : lines
  return (
    <div className="console" ref={ref} onScroll={(event) => {
      const element = event.currentTarget
      setFollow(element.scrollHeight - element.scrollTop - element.clientHeight < 24)
    }}>
      {shown.length === 0
        ? <div className="console-empty">暂无输出。启动 dsh 后，这里会显示它的日志。</div>
        : shown.map(line => (
          <div key={line.seq} className={`console-line ${line.stream}`}>
            <span className="console-time">{clock(line.time)}</span>
            <span className="console-text">{line.text || ' '}</span>
          </div>
        ))}
    </div>
  )
}
