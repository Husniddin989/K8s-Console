import type { IncomingMessage } from 'node:http'
import { PassThrough, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { Attach, Exec, type V1Status } from '@kubernetes/client-node'
import { WebSocket } from 'ws'
import { namespacePattern, resourceNamePattern } from './app.js'
import { kubernetesMessage } from './audit.js'
import type { AuthUser } from './auth.js'
import type { KubeClients } from './kube.js'
import type { ConsoleStore } from './store.js'

/**
 * Browser <-> console framing. Every text frame starts with a channel digit:
 *   "0" + terminal bytes (both directions)
 *   "1" + JSON control message: {type:"resize",cols,rows} from the browser;
 *       {type:"status"|"ready"|"exit"|"error", message?} from the console.
 */
export const dataChannel = '0'
export const controlChannel = '1'

/** Prefer bash, fall back to sh — the same thing people type by hand. */
export const shellCommand = ['/bin/sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi']

export type TerminalMode = 'exec' | 'attach'

interface TerminalContext {
  kube: KubeClients
  store: ConsoleStore
  user: AuthUser
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(Math.max(Math.round(number), min), max) : fallback
}

async function waitForEphemeralContainer(context: TerminalContext, namespace: string, pod: string, container: string, send: (message: object) => void, isOpen: () => boolean) {
  const deadline = Date.now() + 120_000
  let announced = false
  while (Date.now() < deadline && isOpen()) {
    const current = await context.kube.coreApi.readNamespacedPod({ name: pod, namespace })
    const status = current.status?.ephemeralContainerStatuses?.find((item) => item.name === container)
    if (status?.state?.running) return
    if (status?.state?.terminated) throw new Error('The debug container exited: ' + (status.state.terminated.reason || 'exit code ' + status.state.terminated.exitCode))
    const waiting = status?.state?.waiting?.reason
    if (waiting && /ErrImagePull|ImagePullBackOff|InvalidImageName/.test(waiting)) throw new Error('The debug image could not be pulled (' + waiting + ')')
    if (!announced || waiting) send({ type: 'status', message: 'Waiting for the debug container to start' + (waiting ? ' (' + waiting + ')' : '') + '…' })
    announced = true
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error('The debug container did not start within two minutes')
}

/** Opens a shell (exec) or attaches to a debug container and bridges it to the browser socket. */
export async function openTerminal(mode: TerminalMode, webSocket: WebSocket, request: IncomingMessage, context: TerminalContext): Promise<void> {
  const url = new URL(request.url || '/', 'http://localhost')
  const namespace = url.searchParams.get('namespace') || ''
  const pod = url.searchParams.get('pod') || ''
  const container = url.searchParams.get('container') || ''
  if (!namespacePattern.test(namespace) || !resourceNamePattern.test(pod) || !resourceNamePattern.test(container)) {
    webSocket.close(1008, 'A valid namespace, pod, and container are required')
    return
  }

  const isOpen = () => webSocket.readyState === WebSocket.OPEN
  const send = (message: object) => { if (isOpen()) webSocket.send(controlChannel + JSON.stringify(message)) }
  const decoder = new StringDecoder('utf8')
  // Exec/Attach treat an output stream with rows/columns and a "resize" event as a resizable TTY.
  const output = Object.assign(new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (isOpen()) webSocket.send(dataChannel + decoder.write(chunk), () => callback())
      else callback()
    },
  }), { rows: clamp(url.searchParams.get('rows'), 5, 300, 24), columns: clamp(url.searchParams.get('cols'), 20, 500, 80) })
  const input = new PassThrough()
  let upstream: { close: () => void; on: (event: 'close', listener: () => void) => void } | undefined
  let closed = false

  const audit = (result: 'success' | 'failure', error: string | null) => context.store.addAudit({
    username: context.user.username,
    role: context.user.role,
    ip: request.socket.remoteAddress || null,
    action: mode === 'exec' ? 'pod.shell' : 'pod.attach',
    kind: 'Pod',
    namespace,
    name: pod,
    result,
    error,
    details: { container, command: mode === 'exec' ? shellCommand.join(' ') : null },
  })

  const cleanUp = () => {
    if (closed) return
    closed = true
    input.end()
    upstream?.close()
  }
  webSocket.on('close', cleanUp)
  webSocket.on('error', cleanUp)
  webSocket.on('message', (data) => {
    const text = String(data)
    if (text.startsWith(dataChannel)) {
      input.write(text.slice(1))
    } else if (text.startsWith(controlChannel)) {
      try {
        const message = JSON.parse(text.slice(1)) as { type?: string; cols?: unknown; rows?: unknown }
        if (message.type === 'resize') {
          output.columns = clamp(message.cols, 20, 500, output.columns)
          output.rows = clamp(message.rows, 5, 300, output.rows)
          output.emit('resize')
        }
      } catch {
        // Ignore malformed control frames.
      }
    }
  })

  try {
    if (mode === 'attach') await waitForEphemeralContainer(context, namespace, pod, container, send, isOpen)
    if (!isOpen()) return
    const onStatus = (status: V1Status) => {
      send({ type: 'exit', message: status.status === 'Success' ? 'Session ended' : status.message || 'The command failed' })
    }
    upstream = mode === 'exec'
      ? await new Exec(context.kube.kubeConfig).exec(namespace, pod, container, shellCommand, output, output, input, true, onStatus)
      : await new Attach(context.kube.kubeConfig).attach(namespace, pod, container, output, output, input, true)
    if (closed) {
      upstream.close()
      return
    }
    upstream.on('close', () => {
      if (isOpen()) webSocket.close(1000, 'Session ended')
    })
    audit('success', null)
    send({ type: 'ready' })
    if (mode === 'attach') input.write('\n')
  } catch (error) {
    const message = kubernetesMessage(error)
    audit('failure', message)
    send({ type: 'error', message })
    if (isOpen()) webSocket.close(1011, 'Terminal could not be opened')
  }
}
