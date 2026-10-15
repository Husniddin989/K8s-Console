import { useEffect, useRef, useState } from 'react'
import { Copy, Maximize2, Minimize2, Pause, Play, Search } from 'lucide-react'
import { PageHeader } from '../components/ui'
import { appendLogChunk, emptyLogBuffer, markLogReconnect } from '../lib/logLines'
import type { PodItem } from '../types'

export function Logs({ pods, initialPod, onSessionExpired }: { pods: PodItem[]; initialPod: string; onSessionExpired: () => void }) {
  const [selectedKey, setSelectedKey] = useState(initialPod)
  const [container, setContainer] = useState('')
  const [buffer, setBuffer] = useState(emptyLogBuffer)
  const [connection, setConnection] = useState<'idle' | 'connecting' | 'connected' | 'error'>(() => {
    const initial = pods.find((pod) => pod.namespace + '/' + pod.name === initialPod)
    return initial?.containerNames.length ? 'connecting' : 'idle'
  })
  const [paused, setPaused] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [filter, setFilter] = useState('')
  const [streamCycle, setStreamCycle] = useState(0)
  const reconnectAttemptRef = useRef(0)

  const selectedPod = pods.find((pod) => pod.namespace + '/' + pod.name === selectedKey)
  const containers = selectedPod?.containerNames || []
  const activeContainer = containers.includes(container) ? container : containers[0] || ''
  const podNamespace = selectedPod?.namespace
  const podName = selectedPod?.name
  const messages = buffer.lines

  useEffect(() => {
    if (!podNamespace || !podName || !activeContainer || paused) return
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socketUrl = protocol + '//' + window.location.host + '/ws/logs?namespace=' + encodeURIComponent(podNamespace) + '&pod=' + encodeURIComponent(podName) + '&container=' + encodeURIComponent(activeContainer)
    let disposed = false
    let reconnectTimer: number | undefined
    const socket = new WebSocket(socketUrl)
    socket.onopen = () => {
      if (!disposed) setConnection('connected')
    }
    socket.onmessage = (event) => {
      if (disposed) return
      const chunk = String(event.data)
      if (chunk.startsWith('{')) {
        try {
          const parsed = JSON.parse(chunk) as { error?: string }
          if (parsed.error) {
            setConnection('error')
            const notice = '[stream error] ' + parsed.error
            // Repeated failures while retrying show up once instead of filling the viewer.
            setBuffer((current) => current.lines.at(-1) === notice ? current : appendLogChunk(markLogReconnect(current), notice + '\n'))
            return
          }
        } catch {
          // Not a control message; fall through to plain log text.
        }
      }
      // Only real log output proves the stream is healthy; a socket that opens and then fails keeps backing off.
      reconnectAttemptRef.current = 0
      setBuffer((current) => appendLogChunk(current, chunk))
    }
    socket.onerror = () => { if (!disposed) setConnection('error') }
    socket.onclose = (event) => {
      if (disposed) return
      setBuffer((current) => markLogReconnect(current))
      if (event.code === 4401) {
        setConnection('idle')
        onSessionExpired()
        return
      }
      if (event.code === 1008) {
        // The server rejected the request itself; retrying would fail the same way.
        setConnection('error')
        return
      }
      setConnection((current) => current === 'error' ? 'error' : 'idle')
      const delay = Math.min(1000 * (2 ** reconnectAttemptRef.current), 15000)
      reconnectTimer = window.setTimeout(() => {
        if (disposed) return
        reconnectAttemptRef.current += 1
        setConnection('connecting')
        setStreamCycle((current) => current + 1)
      }, delay)
    }
    return () => {
      disposed = true
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      socket.close()
    }
  }, [podNamespace, podName, activeContainer, paused, streamCycle, onSessionExpired])

  useEffect(() => {
    if (!expanded) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [expanded])

  const visibleMessages = messages.filter((line) => line.toLowerCase().includes(filter.toLowerCase()))
  const viewerRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)

  // Keep the newest lines in view unless the reader scrolled up to look at older output.
  useEffect(() => {
    const viewer = viewerRef.current
    if (viewer && followRef.current) viewer.scrollTop = viewer.scrollHeight
  }, [visibleMessages.length])
  const choosePod = (podKey: string) => {
    const nextPod = pods.find((pod) => pod.namespace + '/' + pod.name === podKey)
    reconnectAttemptRef.current = 0
    setBuffer(emptyLogBuffer)
    setConnection(nextPod?.containerNames.length ? 'connecting' : 'idle')
    setSelectedKey(podKey)
    setStreamCycle((current) => current + 1)
  }
  const chooseContainer = (value: string) => {
    reconnectAttemptRef.current = 0
    setBuffer(emptyLogBuffer)
    setConnection(value ? 'connecting' : 'idle')
    setContainer(value)
    setStreamCycle((current) => current + 1)
  }
  const toggleStream = () => {
    const next = !paused
    reconnectAttemptRef.current = 0
    if (next) setBuffer((current) => markLogReconnect(current))
    setPaused(next)
    setConnection(next ? 'idle' : 'connecting')
  }
  const copyLogs = async () => {
    try {
      await navigator.clipboard.writeText(visibleMessages.join('\n'))
      setCopied(true)
      setCopyFailed(false)
    } catch {
      setCopyFailed(true)
      setCopied(false)
    }
    window.setTimeout(() => { setCopied(false); setCopyFailed(false) }, 1800)
  }
  const placeholder = !selectedKey
    ? 'Select a pod to start a live log stream.'
    : !selectedPod
      ? 'This pod is no longer available in the selected namespace. Choose another pod.'
      : messages.length && filter
        ? 'No log lines match "' + filter + '".'
        : connection === 'connecting'
          ? 'Connecting to the Kubernetes log stream…'
          : connection === 'error'
            ? 'Could not connect to this pod log stream.'
            : paused
              ? 'Log stream paused.'
              : !activeContainer
                ? 'Waiting for a container to appear…'
                : 'Waiting for log output…'

  const streamLabel = paused ? 'Paused' : connection === 'connected' ? 'Streaming' : connection === 'connecting' ? 'Connecting' : connection === 'error' ? 'Stream error' : 'Waiting'

  return <>
    <PageHeader title="Pod logs" description="Live container output, streamed from the Kubernetes API with timestamps." />
    <section className={'panel log-panel' + (expanded ? ' log-panel-expanded' : '')}>
      <div className="log-controls">
        <label className="field"><span>Pod</span><select value={selectedKey} onChange={(event) => choosePod(event.target.value)}><option value="">Select a pod</option>{selectedKey && !selectedPod && <option value={selectedKey}>{selectedKey.replace('/', ' / ')} (gone)</option>}{pods.map((pod) => <option key={pod.namespace + '/' + pod.name} value={pod.namespace + '/' + pod.name}>{pod.namespace} / {pod.name}</option>)}</select></label>
        <label className="field field-narrow"><span>Container</span><select value={activeContainer} onChange={(event) => chooseContainer(event.target.value)} disabled={!containers.length}>{containers.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
        <label className="field field-grow"><span>Filter</span><span className="input-with-icon"><Search size={16} /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Show only lines containing…" aria-label="Filter log lines" /></span></label>
      </div>
      <div className="log-toolbar">
        <span className={'stream-state stream-' + (paused ? 'paused' : connection)} role="status"><i />{streamLabel}</span>
        <span className="text-muted">{filter ? visibleMessages.length + ' of ' : ''}{messages.length} lines</span>
        <span className="toolbar-spacer" />
        <button className="button button-small" onClick={toggleStream} disabled={!selectedPod}>{paused ? <Play size={15} /> : <Pause size={15} />}{paused ? 'Resume' : 'Pause'}</button>
        <button className="button button-small" onClick={() => void copyLogs()} disabled={!visibleMessages.length}><Copy size={15} />{copied ? 'Copied' : copyFailed ? 'Copy failed' : filter ? 'Copy filtered' : 'Copy'}</button>
        <button className="button button-small" onClick={() => setExpanded((current) => !current)} title={expanded ? 'Exit full screen (Esc)' : 'Full screen'}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}{expanded ? 'Exit full screen' : 'Full screen'}</button>
      </div>
      <div className="log-viewer" ref={viewerRef} onScroll={(event) => {
        const viewer = event.currentTarget
        followRef.current = viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight < 40
      }}>{visibleMessages.length
        ? <ol>{visibleMessages.map((line, index) => <li key={index}>{line}</li>)}</ol>
        : <p className="log-placeholder">{placeholder}</p>}</div>
    </section>
  </>
}
