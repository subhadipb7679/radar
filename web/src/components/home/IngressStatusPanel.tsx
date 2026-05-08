import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import { ExternalLink, Globe2, Loader2 } from 'lucide-react'
import { fetchJSON, useResources } from '../../api/client'
import type { SelectedResource } from '../../types'
import { openExternal } from '../../utils/navigation'

interface IngressStatusPanelProps {
  onNavigateToResource: (resource: SelectedResource) => void
}

interface URLStatus {
  url: string
  ok: boolean
  status: string
  statusCode?: number
  latencyMs?: number
  error?: string
}

interface IngressRoute {
  key: string
  namespace: string
  name: string
  host: string
  url: string
}

export function IngressStatusPanel({ onNavigateToResource }: IngressStatusPanelProps) {
  const { data: ingresses, isLoading, error } = useResources<any>('ingresses')

  const routes = useMemo(() => {
    const seen = new Set<string>()
    const result: IngressRoute[] = []
    for (const ingress of ingresses ?? []) {
      const namespace = ingress.metadata?.namespace ?? ''
      const name = ingress.metadata?.name ?? ''
      const tls = ingress.spec?.tls ?? []
      for (const rule of ingress.spec?.rules ?? []) {
        const host = rule.host
        const usesTLS = tls.some((t: any) => t.hosts?.includes(host))
        const url = buildIngressURL(host, usesTLS)
        if (!url) continue
        const key = `${namespace}/${name}/${url}`
        if (seen.has(key)) continue
        seen.add(key)
        result.push({ key, namespace, name, host, url })
      }
    }
    return result.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name) || a.host.localeCompare(b.host))
  }, [ingresses])

  const statusQueries = useQueries({
    queries: routes.map((route) => ({
      queryKey: ['url-status', route.url],
      queryFn: () => fetchJSON<URLStatus>(`/url/status?url=${encodeURIComponent(route.url)}`),
      enabled: Boolean(route.url),
      staleTime: 0,
      refetchOnMount: 'always' as const,
      refetchOnWindowFocus: false,
      retry: 0,
    })),
  })

  return (
    <div className="flex h-full min-h-0 flex-col rounded-xl bg-theme-surface shadow-theme-sm overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-theme-border/50">
        <div className="flex items-center gap-2">
          <Globe2 className="w-4 h-4 text-blue-400" />
          <span className="text-xs font-semibold uppercase tracking-wider text-theme-text-secondary">Ingress URL Status</span>
        </div>
        <span className="badge rounded-full bg-theme-elevated text-theme-text-secondary">{routes.length}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center gap-2 px-5 py-6 text-xs text-theme-text-tertiary">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading ingresses...
          </div>
        ) : error ? (
          <div className="px-5 py-6 text-xs text-red-400">Failed to load ingresses.</div>
        ) : routes.length === 0 ? (
          <div className="px-5 py-6 text-xs text-theme-text-tertiary">No ingress hosts found in this cluster.</div>
        ) : (
          <div className="divide-y divide-theme-border">
            {routes.map((route, index) => {
              const query = statusQueries[index]
              const status = query?.data
              const isChecking = query?.isLoading || query?.isFetching
              const ok = status?.ok === true

              return (
                <div key={route.key} className="px-4 py-2.5 hover:bg-theme-hover/60 transition-colors">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        onClick={() => openExternal(route.url)}
                        className="inline-flex max-w-full items-center gap-1 text-left text-sm font-medium text-blue-400 hover:text-blue-300 hover:underline"
                        title={`Open ${route.url}`}
                      >
                        <span className="truncate">{route.host}</span>
                        <ExternalLink className="w-3 h-3 shrink-0 opacity-70" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onNavigateToResource({ kind: 'ingresses', namespace: route.namespace, name: route.name })}
                        className="mt-1 block max-w-full truncate text-left text-[11px] text-theme-text-tertiary hover:text-theme-text-secondary"
                      >
                        {route.namespace}/{route.name}
                      </button>
                    </div>

                    <div className="shrink-0 text-right">
                      {isChecking ? (
                        <div className="inline-flex items-center gap-1.5 text-[11px] text-theme-text-tertiary">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          checking
                        </div>
                      ) : status ? (
                        <div className={`inline-flex items-center gap-1.5 text-xs font-medium ${ok ? 'text-green-400' : 'text-red-400'}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-green-400' : 'bg-red-400'}`} />
                          {status.statusCode ?? 'ERR'}
                        </div>
                      ) : (
                        <div className="text-xs text-theme-text-tertiary">-</div>
                      )}
                      {status?.latencyMs != null && (
                        <div className="text-[10px] text-theme-text-tertiary">{status.latencyMs}ms</div>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function buildIngressURL(host: string | undefined, usesTLS: boolean): string | null {
  if (!host || host === '*') return null
  return `${usesTLS ? 'https' : 'http'}://${host}`
}
