import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Modal } from './Modal'

export interface TerminalTarget {
  mode: 'exec' | 'attach'
  namespace: string
  pod: string
  container: string
  /** Containers to switch between (shell only). */
  containers?: string[]
}

type State = 'connecting' | 'waiting' | 'ready' | 'closed' | 'error'

/** Wire format shared with backend/src/terminal.ts: "0" + bytes, "1" + JSON control message. */
const data = '0'
const control = '1'

export function TerminalDialog({ target, onClose, onSessionExpired }: { target: TerminalTarget; onClose: () => void; onSessionExpired: () => void }) {
  const [container, setContainer] = useState(target.container)
  const [state, setState] = useState<State>('connecting')
  const [status, setStatus] = useState('Connecting…')
  const [cycle, setCycle] = useState(0)
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new XTerm({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 14,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: { background: '#0b1120', foreground: '#d6deeb', cursor: '#9db1ff', selectionBackground: '#33467a' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const params = new URLSearchParams({ namespace: target.namespace, pod: target.pod, container, cols: String(term.cols), rows: String(term.rows) })
    const socket = new WebSocket(protocol + '//' + window.location.host + '/ws/' + target.mode + '?' + params.toString())
    let finished = false

    const sendResize = () => {
      if (socket.readyState === WebSocket.OPEN) socket.send(control + JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }
    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        // The host can be detached while closing.
      }
    })
    observer.observe(host)
    const resizeListener = term.onResize(sendResize)
    const inputListener = term.onData((input) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data + input)
    })

    socket.onmessage = (event) => {
      const text = String(event.data)
      if (text.startsWith(data)) {
        term.write(text.slice(1))
        return
      }
      if (!text.startsWith(control)) return
      try {
        const message = JSON.parse(text.slice(1)) as { type: string; message?: string }
        if (message.type === 'ready') {
          setState('ready')
          setStatus('Connected')
          sendResize()
          term.focus()
        } else if (message.type === 'status') {
          setState('waiting')
          setStatus(message.message || 'Waiting…')
        } else if (message.type === 'exit') {
          finished = true
          setState('closed')
          setStatus(message.message || 'Session ended')
          term.write('\r\n\x1b[90m— ' + (message.message || 'Session ended') + ' —\x1b[0m\r\n')
        } else if (message.type === 'error') {
          finished = true
          setState('error')
          setStatus(message.message || 'The terminal could not be opened')
          term.write('\r\n\x1b[31m' + (message.message || 'The terminal could not be opened') + '\x1b[0m\r\n')
        }
      } catch {
        // Ignore malformed control frames.
      }
    }
    socket.onclose = (event) => {
      if (event.code === 4401) {
        onSessionExpired()
        return
      }
      if (finished) return
      setState(event.code === 1000 ? 'closed' : 'error')
      setStatus(event.code === 1000 ? 'Session ended' : 'Connection closed (' + event.code + '). You may lack permission, or the pod is gone.')
    }

    return () => {
      observer.disconnect()
      resizeListener.dispose()
      inputListener.dispose()
      socket.close()
      term.dispose()
    }
  }, [target.mode, target.namespace, target.pod, container, cycle, onSessionExpired])

  const title = target.mode === 'exec' ? 'Shell' : 'Debug container'
  return <Modal size="full" dark closeOnEscape={false} title={<>{title} <span className="mono modal-title-detail">{target.namespace}/{target.pod}</span></>} onClose={onClose} subtitle={<span className="terminal-status">
    <span className={'stream-state stream-' + (state === 'ready' ? 'connected' : state === 'error' ? 'error' : state === 'closed' ? 'paused' : 'connecting')}><i />{status}</span>
    {target.containers && target.containers.length > 1 && <label className="terminal-container">Container <select value={container} onChange={(event) => { setContainer(event.target.value); setState('connecting'); setStatus('Connecting…') }}>{target.containers.map((name) => <option key={name}>{name}</option>)}</select></label>}
    {target.mode === 'attach' && <span className="mono">{container}</span>}
    {(state === 'closed' || state === 'error') && target.mode === 'exec' && <button className="button button-small" onClick={() => { setState('connecting'); setStatus('Connecting…'); setCycle((current) => current + 1) }}>Reconnect</button>}
  </span>}>
    <div className="terminal-host" ref={hostRef} />
  </Modal>
}
