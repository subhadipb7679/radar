import { useEffect, useMemo, useState } from 'react'
import {
  buildIngressURL,
  IngressRenderer as BaseIngressRenderer,
  type IngressURLStatus,
} from '@skyhook-io/k8s-ui/components/resources/renderers/IngressRenderer'
import { apiUrl, getAuthHeaders, getCredentialsMode } from '../../../api/config'
import { openExternal } from '../../../utils/navigation'

interface IngressRendererProps {
  data: any
  onNavigate?: (ref: { kind: string; namespace: string; name: string }) => void
}

export function IngressRenderer({ data, onNavigate }: IngressRendererProps) {
  const urls = useMemo(() => {
    const spec = data.spec || {}
    const rules = spec.rules || []
    const tls = spec.tls || []
    const seen = new Set<string>()
    for (const rule of rules) {
      const usesTLS = tls.some((t: any) => t.hosts?.includes(rule.host))
      const url = buildIngressURL(rule.host, usesTLS)
      if (url) seen.add(url)
    }
    return Array.from(seen)
  }, [data])

  const [urlStatuses, setURLStatuses] = useState<Record<string, IngressURLStatus>>({})

  useEffect(() => {
    let cancelled = false
    if (urls.length === 0) {
      setURLStatuses({})
      return
    }

    setURLStatuses(Object.fromEntries(urls.map((url) => [url, { loading: true }])))
    Promise.all(urls.map(async (url) => {
      try {
        const res = await fetch(apiUrl(`/url/status?url=${encodeURIComponent(url)}`), {
          credentials: getCredentialsMode(),
          headers: getAuthHeaders(),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return [url, await res.json()] as const
      } catch (error) {
        return [url, {
          ok: false,
          status: 'Unreachable',
          error: error instanceof Error ? error.message : String(error),
        }] as const
      }
    })).then((entries) => {
      if (!cancelled) setURLStatuses(Object.fromEntries(entries))
    })

    return () => {
      cancelled = true
    }
  }, [urls])

  return (
    <BaseIngressRenderer
      data={data}
      onNavigate={onNavigate}
      onOpenURL={openExternal}
      urlStatuses={urlStatuses}
    />
  )
}
