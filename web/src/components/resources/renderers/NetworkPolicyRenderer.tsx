import { useMemo } from 'react'
import { ArrowRight, Boxes, Loader2, Network, Shield } from 'lucide-react'
import { NetworkPolicyRenderer as BaseNetworkPolicyRenderer } from '@skyhook-io/k8s-ui/components/resources/renderers/NetworkPolicyRenderer'
import { ResourceLink, Section } from '@skyhook-io/k8s-ui/components/ui/drawer-components'
import { useResources } from '../../../api/client'

interface NetworkPolicyRendererProps {
  data: any
  onNavigate?: (ref: { kind: string; namespace: string; name: string }) => void
}

interface ResolvedEndpoint {
  key: string
  label: string
  namespace?: string
  podName?: string
  workloadName?: string
  workloadKind?: string
  kind: 'pod' | 'workload' | 'namespace' | 'cidr' | 'all' | 'none'
}

interface ResolvedConnection {
  id: string
  direction: 'Ingress' | 'Egress'
  sources: ResolvedEndpoint[]
  targets: ResolvedEndpoint[]
  ports: string[]
}

export function NetworkPolicyRenderer({ data, onNavigate }: NetworkPolicyRendererProps) {
  const { data: pods, isLoading: podsLoading } = useResources<any>('pods')
  const { data: deployments, isLoading: deploymentsLoading } = useResources<any>('deployments')
  const { data: replicasets, isLoading: replicasetsLoading } = useResources<any>('replicasets')
  const { data: namespaces, isLoading: namespacesLoading } = useResources<any>('namespaces')

  const loading = podsLoading || deploymentsLoading || replicasetsLoading || namespacesLoading
  const connections = useMemo(() => {
    return resolveNetworkPolicyConnections(data, {
      pods: pods ?? [],
      deployments: deployments ?? [],
      replicasets: replicasets ?? [],
      namespaces: namespaces ?? [],
    })
  }, [data, deployments, namespaces, pods, replicasets])

  return (
    <>
      <ResolvedConnectionsPanel
        loading={loading}
        connections={connections}
        onNavigate={onNavigate}
      />
      <BaseNetworkPolicyRenderer data={data} />
    </>
  )
}

function ResolvedConnectionsPanel({
  loading,
  connections,
  onNavigate,
}: {
  loading: boolean
  connections: ResolvedConnection[]
  onNavigate?: (ref: { kind: string; namespace: string; name: string }) => void
}) {
  return (
    <Section title="Allowed Connections" icon={Network} defaultExpanded>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-theme-text-tertiary">
          <Loader2 className="h-4 w-4 animate-spin" />
          Resolving pods, namespaces, and workloads...
        </div>
      ) : connections.length === 0 ? (
        <div className="text-sm text-theme-text-tertiary">
          No allowed pod-to-pod connections resolved for this policy.
        </div>
      ) : (
        <div className="space-y-3">
          {connections.map((connection) => (
            <div key={connection.id} className="card-inner-lg">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="flex items-center gap-1.5">
                  <Shield className={connection.direction === 'Ingress' ? 'h-3.5 w-3.5 text-blue-400' : 'h-3.5 w-3.5 text-purple-400'} />
                  <span className="text-xs font-semibold uppercase tracking-wider text-theme-text-secondary">
                    {connection.direction}
                  </span>
                </div>
                {connection.ports.length > 0 && (
                  <div className="flex flex-wrap justify-end gap-1">
                    {connection.ports.map((port) => (
                      <span key={port} className="badge bg-theme-elevated text-theme-text-secondary">{port}</span>
                    ))}
                  </div>
                )}
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)] items-start gap-2">
                <EndpointList endpoints={connection.sources} onNavigate={onNavigate} />
                <div className="flex justify-center pt-2 text-theme-text-tertiary">
                  <ArrowRight className="h-4 w-4" />
                </div>
                <EndpointList endpoints={connection.targets} onNavigate={onNavigate} />
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

function EndpointList({
  endpoints,
  onNavigate,
}: {
  endpoints: ResolvedEndpoint[]
  onNavigate?: (ref: { kind: string; namespace: string; name: string }) => void
}) {
  const visible = endpoints.slice(0, 8)
  const remaining = endpoints.length - visible.length
  return (
    <div className="min-w-0 space-y-1">
      {visible.map((endpoint) => (
        <div key={endpoint.key} className="rounded-md border border-theme-border bg-theme-elevated/40 px-2 py-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <EndpointIcon endpoint={endpoint} />
            {endpoint.podName && endpoint.namespace ? (
              <ResourceLink
                name={endpoint.podName}
                kind="pods"
                namespace={endpoint.namespace}
                label={<span className="truncate text-xs text-blue-400">{endpoint.label}</span>}
                onNavigate={onNavigate}
              />
            ) : (
              <span className="truncate text-xs font-medium text-theme-text-primary">{endpoint.label}</span>
            )}
          </div>
          {endpoint.workloadName && endpoint.namespace && (
            <div className="mt-0.5 truncate pl-5 text-[10px] text-theme-text-tertiary">
              via {endpoint.workloadKind ?? 'workload'} {endpoint.workloadName}
            </div>
          )}
          {endpoint.namespace && (
            <div className="mt-0.5 truncate pl-5 text-[10px] text-theme-text-tertiary">
              ns/{endpoint.namespace}
            </div>
          )}
        </div>
      ))}
      {remaining > 0 && (
        <div className="text-[11px] text-theme-text-tertiary">+{remaining} more</div>
      )}
    </div>
  )
}

function EndpointIcon({ endpoint }: { endpoint: ResolvedEndpoint }) {
  if (endpoint.kind === 'workload') return <Boxes className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
  if (endpoint.kind === 'namespace') return <Network className="h-3.5 w-3.5 shrink-0 text-sky-400" />
  if (endpoint.kind === 'cidr') return <Network className="h-3.5 w-3.5 shrink-0 text-amber-400" />
  return <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
}

function resolveNetworkPolicyConnections(data: any, resources: {
  pods: any[]
  deployments: any[]
  replicasets: any[]
  namespaces: any[]
}): ResolvedConnection[] {
  const spec = data.spec ?? {}
  const policyNamespace = data.metadata?.namespace ?? ''
  const policyTypes: string[] = spec.policyTypes ?? inferPolicyTypes(spec)
  const targetPods = resolvePodsBySelector(resources.pods, policyNamespace, spec.podSelector)
  const targetEndpoints = podsToEndpoints(targetPods, resources)
  const resolvedTargets = targetEndpoints.length > 0
    ? targetEndpoints
    : [{
        key: `target-selector-${policyNamespace}`,
        label: `No matching target pods (${selectorToText(spec.podSelector)})`,
        namespace: policyNamespace,
        kind: 'none' as const,
      }]
  const connections: ResolvedConnection[] = []

  if (policyTypes.includes('Ingress')) {
    const ingressRules = spec.ingress ?? []
    ingressRules.forEach((rule: any, index: number) => {
      connections.push({
        id: `ingress-${index}`,
        direction: 'Ingress',
        sources: resolvePeers(rule.from, policyNamespace, resources, 'source'),
        targets: resolvedTargets,
        ports: formatPorts(rule.ports),
      })
    })
  }

  if (policyTypes.includes('Egress')) {
    const egressRules = spec.egress ?? []
    egressRules.forEach((rule: any, index: number) => {
      connections.push({
        id: `egress-${index}`,
        direction: 'Egress',
        sources: resolvedTargets,
        targets: resolvePeers(rule.to, policyNamespace, resources, 'destination'),
        ports: formatPorts(rule.ports),
      })
    })
  }

  return connections
}

function inferPolicyTypes(spec: any): string[] {
  const types = ['Ingress']
  if (spec.egress) types.push('Egress')
  return types
}

function resolvePeers(peers: any[] | undefined, policyNamespace: string, resources: { pods: any[]; namespaces: any[]; deployments: any[]; replicasets: any[] }, role: 'source' | 'destination'): ResolvedEndpoint[] {
  if (!peers || peers.length === 0) {
    return [{ key: `${role}-all`, label: role === 'source' ? 'Any source' : 'Any destination', kind: 'all' }]
  }

  const endpoints: ResolvedEndpoint[] = []
  peers.forEach((peer, index) => {
    if (peer.ipBlock) {
      endpoints.push({
        key: `${role}-cidr-${index}`,
        label: peer.ipBlock.except?.length ? `${peer.ipBlock.cidr} except ${peer.ipBlock.except.join(', ')}` : peer.ipBlock.cidr,
        kind: 'cidr',
      })
      return
    }

    const namespaces = peer.namespaceSelector
      ? resources.namespaces.filter(ns => matchesSelector(ns.metadata?.labels ?? {}, peer.namespaceSelector)).map(ns => ns.metadata?.name).filter(Boolean)
      : [policyNamespace]

    if (peer.namespaceSelector && namespaces.length === 0) {
      endpoints.push({
        key: `${role}-no-namespace-${index}`,
        label: `No namespaces match ${selectorToText(peer.namespaceSelector)}`,
        kind: 'none',
      })
      return
    }

    if (peer.namespaceSelector && !peer.podSelector) {
      namespaces.forEach(ns => endpoints.push({ key: `${role}-ns-${ns}`, label: `All pods in ${ns}`, namespace: ns, kind: 'namespace' }))
      return
    }

    const pods = resources.pods.filter(pod => namespaces.includes(pod.metadata?.namespace) && matchesSelector(pod.metadata?.labels ?? {}, peer.podSelector))
    const podEndpoints = podsToEndpoints(pods, resources)
    if (podEndpoints.length > 0) {
      endpoints.push(...podEndpoints)
    } else {
      endpoints.push({
        key: `${role}-no-pods-${index}`,
        label: `No pods match ${selectorToText(peer.podSelector)}`,
        kind: 'none',
      })
    }
  })

  return dedupeEndpoints(endpoints)
}

function resolvePodsBySelector(pods: any[], namespace: string, selector: any): any[] {
  return pods.filter(pod => pod.metadata?.namespace === namespace && matchesSelector(pod.metadata?.labels ?? {}, selector))
}

function podsToEndpoints(pods: any[], resources: { deployments: any[]; replicasets: any[] }): ResolvedEndpoint[] {
  return pods.map((pod) => {
    const owner = resolveWorkloadOwner(pod, resources)
    return {
      key: `${pod.metadata?.namespace}/${pod.metadata?.name}`,
      label: pod.metadata?.name ?? 'pod',
      namespace: pod.metadata?.namespace,
      podName: pod.metadata?.name,
      workloadName: owner?.name,
      workloadKind: owner?.kind,
      kind: owner ? 'workload' : 'pod',
    }
  })
}

function resolveWorkloadOwner(pod: any, resources: { deployments: any[]; replicasets: any[] }): { kind: string; name: string } | null {
  const owner = pod.metadata?.ownerReferences?.[0]
  if (!owner) return null
  if (owner.kind === 'ReplicaSet') {
    const rs = resources.replicasets.find(replicaSet => replicaSet.metadata?.namespace === pod.metadata?.namespace && replicaSet.metadata?.name === owner.name)
    const deploymentOwner = rs?.metadata?.ownerReferences?.find((ref: any) => ref.kind === 'Deployment')
    if (deploymentOwner) return { kind: 'Deployment', name: deploymentOwner.name }
  }
  return { kind: owner.kind, name: owner.name }
}

function matchesSelector(labels: Record<string, string>, selector: any): boolean {
  if (!selector) return true
  const matchLabels = selector.matchLabels ?? {}
  for (const [key, value] of Object.entries(matchLabels)) {
    if (labels[key] !== value) return false
  }
  for (const expression of selector.matchExpressions ?? []) {
    const values = expression.values ?? []
    const actual = labels[expression.key]
    switch (expression.operator) {
      case 'In':
        if (!values.includes(actual)) return false
        break
      case 'NotIn':
        if (values.includes(actual)) return false
        break
      case 'Exists':
        if (actual === undefined) return false
        break
      case 'DoesNotExist':
        if (actual !== undefined) return false
        break
    }
  }
  return true
}

function selectorToText(selector: any): string {
  if (!selector) return 'all pods'
  const parts: string[] = []
  for (const [key, value] of Object.entries(selector.matchLabels ?? {})) {
    parts.push(`${key}=${value}`)
  }
  for (const expression of selector.matchExpressions ?? []) {
    const values = expression.values?.length ? ` (${expression.values.join(', ')})` : ''
    parts.push(`${expression.key} ${expression.operator}${values}`)
  }
  return parts.length > 0 ? parts.join(', ') : 'all pods'
}

function formatPorts(ports: any[] | undefined): string[] {
  if (!ports || ports.length === 0) return ['all ports']
  return ports.map((port) => {
    const protocol = port.protocol ?? 'TCP'
    const value = port.port ?? '*'
    return port.endPort ? `${protocol}/${value}-${port.endPort}` : `${protocol}/${value}`
  })
}

function dedupeEndpoints(endpoints: ResolvedEndpoint[]): ResolvedEndpoint[] {
  const seen = new Set<string>()
  return endpoints.filter((endpoint) => {
    if (seen.has(endpoint.key)) return false
    seen.add(endpoint.key)
    return true
  })
}
