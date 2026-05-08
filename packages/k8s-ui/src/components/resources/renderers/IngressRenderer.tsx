import { ExternalLink, Globe, Shield, Clock } from 'lucide-react'
import type { ReactNode } from 'react'
import { Section, PropertyList, Property, AlertBanner, ResourceLink } from '../../ui/drawer-components'

interface IngressRendererProps {
  data: any
  onNavigate?: (ref: { kind: string; namespace: string; name: string }) => void
  onOpenURL?: (url: string) => void
  urlStatuses?: Record<string, IngressURLStatus | undefined>
}

export interface IngressURLStatus {
  ok?: boolean
  status?: string
  statusCode?: number
  latencyMs?: number
  error?: string
  loading?: boolean
}

export function IngressRenderer({ data, onNavigate, onOpenURL, urlStatuses }: IngressRendererProps) {
  const spec = data.spec || {}
  const rules = spec.rules || []
  const tls = spec.tls || []
  const lbIngress = data.status?.loadBalancer?.ingress || []

  // Check for issues
  const hasNoAddress = lbIngress.length === 0
  const hasNoClass = !spec.ingressClassName && !data.metadata?.annotations?.['kubernetes.io/ingress.class']
  const hasNoRules = rules.length === 0

  return (
    <>
      {/* No address warning */}
      {hasNoAddress && (
        <AlertBanner
          variant="warning"
          icon={Clock}
          title="Address Not Assigned"
          message={hasNoClass
            ? 'No ingress class specified — an ingress controller may not pick up this resource.'
            : 'Waiting for ingress controller to provision address. Check Events if this persists.'}
        />
      )}

      {/* No rules warning */}
      {hasNoRules && (
        <AlertBanner
          variant="info"
          title="No Routing Rules"
          message="This ingress has no rules defined. Traffic will not be routed."
        />
      )}

      <Section title="Ingress" icon={Globe}>
        <PropertyList>
          <Property label="Class" value={spec.ingressClassName || data.metadata?.annotations?.['kubernetes.io/ingress.class']} />
          {lbIngress.length > 0 && (
            <Property label="Address" value={lbIngress[0].ip || lbIngress[0].hostname} />
          )}
          <Property label="TLS" value={tls.length > 0 ? `${tls.length} certificate(s)` : 'None'} />
        </PropertyList>
      </Section>

      <Section title="Rules" defaultExpanded>
        <div className="space-y-3">
          {rules.map((rule: any, i: number) => {
            const usesTLS = tls.some((t: any) => t.hosts?.includes(rule.host))
            const hostURL = buildIngressURL(rule.host, usesTLS)
            const urlStatus = hostURL ? urlStatuses?.[hostURL] : undefined
            return (
            <div key={i} className="card-inner-lg">
              <div className="flex items-center gap-2 mb-2">
                {usesTLS && (
                  <Shield className="w-3.5 h-3.5 text-green-400" />
                )}
                {hostURL ? (
                  <ExternalURLLink url={hostURL} onOpenURL={onOpenURL} className="text-sm font-medium">
                    {rule.host}
                  </ExternalURLLink>
                ) : (
                  <span className="text-sm font-medium text-theme-text-primary">{rule.host || '*'}</span>
                )}
              </div>
              {hostURL && <IngressURLStatusBadge status={urlStatus} />}
              <div className="space-y-1">
                {rule.http?.paths?.map((path: any) => (
                  <div key={path.path || '/'} className="text-xs text-theme-text-secondary flex items-center gap-2">
                    <span className="text-theme-text-tertiary">{path.pathType || 'Prefix'}:</span>
                    <span>{path.path || '/'}</span>
                    <span className="text-theme-text-tertiary">→</span>
                    {path.backend?.service?.name ? (
                      <ResourceLink
                        name={path.backend.service.name}
                        kind="services"
                        namespace={data.metadata?.namespace || ''}
                        label={<span className="text-blue-400">{path.backend.service.name}:{path.backend.service.port?.number || path.backend.service.port?.name}</span>}
                        onNavigate={onNavigate}
                      />
                    ) : (
                      <span className="text-blue-400">-</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )})}
        </div>
      </Section>

      {tls.length > 0 && (
        <Section title="TLS" icon={Shield}>
          <div className="space-y-2">
            {tls.map((t: any) => (
              <div key={t.secretName} className="text-sm">
                <div className="text-theme-text-secondary">Secret: {t.secretName ? (
                  <ResourceLink name={t.secretName} kind="secrets" namespace={data.metadata?.namespace || ''} onNavigate={onNavigate} />
                ) : '-'}</div>
                <div className="text-xs text-theme-text-tertiary">Hosts: {t.hosts?.join(', ') || '*'}</div>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  )
}

export function buildIngressURL(host: string | undefined, usesTLS: boolean, path = '/'): string | null {
  if (!host || host === '*') return null
  const normalizedPath = path?.startsWith('/') ? path : `/${path || ''}`
  return `${usesTLS ? 'https' : 'http'}://${host}${normalizedPath === '/' ? '' : normalizedPath}`
}

function IngressURLStatusBadge({ status }: { status?: IngressURLStatus }) {
  if (!status) return null
  if (status.loading) {
    return (
      <div className="mb-2 flex items-center gap-1.5 text-[11px] text-theme-text-tertiary">
        <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
        Checking live status...
      </div>
    )
  }

  const ok = status.ok === true
  return (
    <div className={`mb-2 flex items-center gap-1.5 text-[11px] ${ok ? 'text-green-400' : 'text-red-400'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-green-400' : 'bg-red-400'}`} />
      <span>{ok ? 'Reachable' : 'Unreachable'}</span>
      {status.status && <span className="text-theme-text-tertiary">({status.status})</span>}
      {status.latencyMs != null && <span className="text-theme-text-tertiary">{status.latencyMs}ms</span>}
      {!ok && status.error && <span className="truncate text-theme-text-tertiary" title={status.error}>{status.error}</span>}
    </div>
  )
}

function ExternalURLLink({
  url,
  onOpenURL,
  className,
  children,
}: {
  url: string
  onOpenURL?: (url: string) => void
  className?: string
  children: ReactNode
}) {
  const content = (
    <>
      <span className="truncate">{children}</span>
      <ExternalLink className="w-3 h-3 shrink-0 opacity-70" />
    </>
  )

  if (onOpenURL) {
    return (
      <button
        type="button"
        onClick={() => onOpenURL(url)}
        title={`Open ${url}`}
        className={`inline-flex max-w-full items-center gap-1 text-left text-blue-400 hover:text-blue-300 hover:underline ${className ?? ''}`}
      >
        {content}
      </button>
    )
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={`Open ${url}`}
      className={`inline-flex max-w-full items-center gap-1 text-blue-400 hover:text-blue-300 hover:underline ${className ?? ''}`}
    >
      {content}
    </a>
  )
}
