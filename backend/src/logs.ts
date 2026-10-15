import * as http from 'node:http'
import * as https from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { Writable } from 'node:stream'
import type { KubeConfig } from '@kubernetes/client-node'
import { WebSocket } from 'ws'
import { namespacePattern, resourceNamePattern } from './app.js'

/** Follows a container's log through the Kubernetes API and forwards it to an authorized browser socket. */
export async function streamPodLogs(webSocket: WebSocket, request: IncomingMessage, kubeConfig: KubeConfig): Promise<void> {
  const requestUrl = new URL(request.url || '/', 'http://localhost')
  const namespace = requestUrl.searchParams.get('namespace') || ''
  const pod = requestUrl.searchParams.get('pod') || ''
  const container = requestUrl.searchParams.get('container') || ''

  if (!namespacePattern.test(namespace) || !resourceNamePattern.test(pod) || !resourceNamePattern.test(container)) {
    webSocket.close(1008, 'A valid namespace, pod, and container are required')
    return
  }

  let requestToApi: ClientRequest | undefined
  let responseFromApi: IncomingMessage | undefined
  let disconnected = false
  let failed = false

  const stopStream = () => {
    if (disconnected) return
    disconnected = true
    responseFromApi?.destroy()
    requestToApi?.destroy()
    destination.destroy()
  }

  const failStream = (reason: unknown) => {
    if (failed || disconnected || webSocket.readyState !== WebSocket.OPEN) return
    failed = true
    console.error('Pod log stream for ' + namespace + '/' + pod + '/' + container + ' failed:', reason instanceof Error ? reason.message : String(reason))
    requestToApi?.destroy()
    webSocket.send(JSON.stringify({ error: 'Unable to stream pod logs' }), () => {
      if (webSocket.readyState === WebSocket.OPEN) webSocket.close(1011, 'Kubernetes log request failed')
    })
  }

  const destination = new Writable({
    write(chunk, _encoding, callback) {
      if (webSocket.readyState !== WebSocket.OPEN) {
        callback()
        return
      }
      webSocket.send(chunk.toString(), callback)
    },
  })
  destination.on('error', failStream)
  webSocket.once('close', stopStream)
  webSocket.once('error', stopStream)

  const handleResponse = (response: IncomingMessage) => {
    responseFromApi = response
    response.on('error', failStream)
    if (response.statusCode !== 200) {
      response.resume()
      failStream('Kubernetes API answered ' + response.statusCode)
      return
    }
    response.pipe(destination)
  }

  try {
    const cluster = kubeConfig.getCurrentCluster()
    if (!cluster) throw new Error('No current Kubernetes cluster is configured')

    const logUrl = new URL(`/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/log`, cluster.server)
    logUrl.searchParams.set('container', container)
    logUrl.searchParams.set('follow', 'true')
    logUrl.searchParams.set('tailLines', '200')
    logUrl.searchParams.set('timestamps', 'true')

    // Recent API servers answer 406 to `Accept: text/plain` on the log endpoint; accept anything like kubectl does.
    const requestOptions: https.RequestOptions = { method: 'GET', headers: { Accept: '*/*' } }
    await kubeConfig.applyToHTTPSOptions(requestOptions)
    if (disconnected || webSocket.readyState !== WebSocket.OPEN) return

    if (logUrl.protocol === 'https:') {
      requestToApi = https.request(logUrl, requestOptions, handleResponse)
    } else if (logUrl.protocol === 'http:') {
      delete requestOptions.agent
      requestToApi = http.request(logUrl, requestOptions, handleResponse)
    } else {
      throw new Error('Unsupported Kubernetes API URL protocol')
    }

    requestToApi.on('error', failStream)
    requestToApi.end()
  } catch (error) {
    failStream(error)
  }
}
