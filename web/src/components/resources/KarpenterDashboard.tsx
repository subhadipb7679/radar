import { useMemo, useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Activity, AlertTriangle, BarChart3, Cpu, HardDrive, Loader2, RefreshCw, Server, Zap } from 'lucide-react'
import { clsx } from 'clsx'
import { fetchJSON, usePrometheusConnect, usePrometheusStatus, type PrometheusQueryResult, type PrometheusSeries, type PrometheusTimeRange } from '../../api/client'

type KarpenterResource = Record<string, any>

interface MetricPanel {
  key: string
  title: string
  query: string
  unit: string
  kind: 'stat' | 'chart' | 'bar'
}

const TIME_RANGES: { value: PrometheusTimeRange; label: string }[] = [
  { value: '1h', label: '1h' },
  { value: '3h', label: '3h' },
  { value: '6h', label: '6h' },
  { value: '12h', label: '12h' },
  { value: '24h', label: '24h' },
  { value: '48h', label: '2d' },
  { value: '7d', label: '7d' },
  { value: '14d', label: '14d' },
  { value: '30d', label: '30d' },
]

const INSTANT_PANELS: MetricPanel[] = [
  {
    key: 'nodepool-cpu',
    title: 'Node Pool CPU Usage',
    unit: 'cores',
    kind: 'bar',
    query: `sum by (nodepool) (karpenter_nodepools_usage{resource_type="cpu"})`,
  },
  {
    key: 'nodepool-memory',
    title: 'Node Pool Memory Usage',
    unit: 'bytes',
    kind: 'bar',
    query: `sum by (nodepool) (karpenter_nodepools_usage{resource_type="memory"})`,
  },
  {
    key: 'nodepool-nodes',
    title: 'Node Pool Nodes',
    unit: 'nodes',
    kind: 'bar',
    query: `sum by (nodepool) (karpenter_nodepools_usage{resource_type="nodes"})`,
  },
  {
    key: 'nodepool-pods',
    title: 'Node Pool Pod Capacity',
    unit: 'pods',
    kind: 'bar',
    query: `sum by (nodepool) (karpenter_nodepools_usage{resource_type="pods"})`,
  },
  {
    key: 'nodepool-cpu-limit',
    title: 'Node Pool CPU Limits',
    unit: 'cores',
    kind: 'stat',
    query: `sum by (nodepool) (karpenter_nodepools_limit{resource_type="cpu"})`,
  },
  {
    key: 'nodepool-memory-limit',
    title: 'Node Pool Memory Limits',
    unit: 'bytes',
    kind: 'stat',
    query: `sum by (nodepool) (karpenter_nodepools_limit{resource_type="memory"})`,
  },
]

const RANGE_PANELS: MetricPanel[] = [
  {
    key: 'nodes-created',
    title: 'Nodes Created',
    unit: 'nodes',
    kind: 'chart',
    query: `sum by (nodepool) (increase(karpenter_nodes_created_total[5m]))`,
  },
  {
    key: 'nodes-terminated',
    title: 'Nodes Terminated',
    unit: 'nodes',
    kind: 'chart',
    query: `sum by (nodepool) (increase(karpenter_nodes_terminated_total[5m]))`,
  },
  {
    key: 'disruptions',
    title: 'Disruption Decisions',
    unit: 'decisions',
    kind: 'chart',
    query: `sum by (reason, decision, consolidation_type) (increase(karpenter_voluntary_disruption_decisions_total{job="karpenter"}[5m]))`,
  },
  {
    key: 'interruption-messages',
    title: 'Interruption Messages',
    unit: 'messages',
    kind: 'chart',
    query: `sum by (queue) (increase(karpenter_interruption_received_messages_total[5m]))`,
  },
  {
    key: 'cloudprovider-errors',
    title: 'Cloud Provider Errors',
    unit: 'errors',
    kind: 'chart',
    query: `sum by (method) (increase(karpenter_cloudprovider_errors_total{job="karpenter"}[5m]))`,
  },
  {
    key: 'controller-reconcile',
    title: 'Controller Reconcile',
    unit: 'req/s',
    kind: 'chart',
    query: `sum by (controller, result) (rate(controller_runtime_reconcile_total{job="karpenter",namespace="karpenter"}[5m]))`,
  },
]

function resourceURL(name: string, group: string) {
  const params = new URLSearchParams()
  if (group) params.set('group', group)
  return `/resources/${name}?${params.toString()}`
}

function latestValue(series?: PrometheusSeries[]) {
  return series?.reduce((sum, item) => sum + latestPointValue(item), 0) || 0
}

function latestPointValue(series: PrometheusSeries) {
  return series.dataPoints.length > 0 ? series.dataPoints[series.dataPoints.length - 1].value : 0
}

function formatNumber(value: number, unit?: string) {
  if (!Number.isFinite(value)) return '-'
  if (unit === 'bytes') return formatBytes(value)
  if (unit === 'req/s') return `${value.toFixed(value >= 10 ? 1 : 3)} req/s`
  if (value >= 1000) return Intl.NumberFormat(undefined, { maximumFractionDigits: 1, notation: 'compact' }).format(value)
  if (value >= 10) return value.toFixed(1).replace(/\.0$/, '')
  return value.toFixed(2).replace(/\.00$/, '')
}

function formatBytes(value: number) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let current = value
  let index = 0
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024
    index++
  }
  return `${current.toFixed(current >= 10 ? 1 : 2).replace(/\.0$/, '')} ${units[index]}`
}

function formatAge(timestamp?: string) {
  if (!timestamp) return '-'
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function formatTimestamp(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function seriesLabel(series: PrometheusSeries, fallback = 'series') {
  return series.labels.nodepool
    || [series.labels.controller, series.labels.result].filter(Boolean).join(' / ')
    || [series.labels.reason, series.labels.decision, series.labels.consolidation_type].filter(Boolean).join(' / ')
    || series.labels.method
    || series.labels.queue
    || series.labels.instance
    || fallback
}

function conditionStatus(resource: KarpenterResource) {
  const ready = resource.status?.conditions?.find((condition: any) => condition.type === 'Ready')
  return ready?.status === 'True' ? 'Ready' : ready?.reason || ready?.status || 'Unknown'
}

function nodePoolName(resource: KarpenterResource) {
  return resource.metadata?.labels?.['karpenter.sh/nodepool'] || resource.spec?.nodePoolRef?.name || resource.spec?.nodePool || '-'
}

function useResourceList(name: string, group: string) {
  return useQuery<KarpenterResource[]>({
    queryKey: ['karpenter-dashboard-resource', group, name],
    queryFn: () => fetchJSON(resourceURL(name, group)),
    staleTime: 15000,
    refetchInterval: 30000,
  })
}

function usePrometheusPanelQueries(panels: MetricPanel[], range: PrometheusTimeRange, connected: boolean) {
  return useQueries({
    queries: panels.map(panel => {
      const params = new URLSearchParams({
        query: panel.query,
        type: panel.kind === 'stat' || panel.kind === 'bar' ? 'instant' : 'range',
        range,
      })
      return {
        queryKey: ['karpenter-dashboard-prometheus', panel.key, range],
        queryFn: () => fetchJSON<PrometheusQueryResult>(`/prometheus/query?${params.toString()}`),
        enabled: connected,
        staleTime: 30000,
        refetchInterval: 60000,
      }
    }),
  })
}

export function KarpenterDashboard() {
  const [range, setRange] = useState<PrometheusTimeRange>('24h')
  const { data: prometheusStatus, isLoading: statusLoading } = usePrometheusStatus()
  const connectMutation = usePrometheusConnect()

  const nodePoolsQuery = useResourceList('nodepools', 'karpenter.sh')
  const nodeClaimsQuery = useResourceList('nodeclaims', 'karpenter.sh')
  const ec2NodeClassesQuery = useResourceList('ec2nodeclasses', 'karpenter.k8s.aws')
  const nodesQuery = useResourceList('nodes', '')

  const connected = prometheusStatus?.connected === true
  const instantQueries = usePrometheusPanelQueries(INSTANT_PANELS, range, connected)
  const rangeQueries = usePrometheusPanelQueries(RANGE_PANELS, range, connected)

  const nodePools = nodePoolsQuery.data || []
  const nodeClaims = nodeClaimsQuery.data || []
  const ec2NodeClasses = ec2NodeClassesQuery.data || []
  const nodes = nodesQuery.data || []

  const nodesByPool = useMemo(() => {
    const counts = new Map<string, number>()
    for (const node of nodes) {
      const pool = node.metadata?.labels?.['karpenter.sh/nodepool']
      if (pool) counts.set(pool, (counts.get(pool) || 0) + 1)
    }
    return counts
  }, [nodes])

  const claimsByPool = useMemo(() => {
    const counts = new Map<string, number>()
    for (const claim of nodeClaims) {
      const pool = nodePoolName(claim)
      if (pool !== '-') counts.set(pool, (counts.get(pool) || 0) + 1)
    }
    return counts
  }, [nodeClaims])

  const nodePoolMetrics = useMemo(() => {
    const byKey = new Map<string, PrometheusQueryResult | undefined>()
    INSTANT_PANELS.forEach((panel, index) => byKey.set(panel.key, instantQueries[index]?.data))
    return byKey
  }, [instantQueries])

  const isLoadingResources = nodePoolsQuery.isLoading || nodeClaimsQuery.isLoading || ec2NodeClassesQuery.isLoading || nodesQuery.isLoading

  return (
    <div className="h-full overflow-auto bg-theme-surface">
      <div className="p-5 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm text-theme-text-tertiary">
              <BarChart3 className="w-4 h-4 text-sky-500" />
              Karpenter
            </div>
            <h2 className="mt-1 text-xl font-semibold text-theme-text-primary">Autoscaling Dashboard</h2>
            <p className="mt-1 text-sm text-theme-text-tertiary">
              NodePool capacity, NodeClaim health, provisioning activity, disruption, and controller performance.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={range}
              onChange={event => setRange(event.target.value as PrometheusTimeRange)}
              className="px-2.5 py-1.5 text-xs rounded-lg bg-theme-elevated border border-theme-border text-theme-text-secondary focus:outline-none focus:ring-1 focus:ring-sky-500"
            >
              {TIME_RANGES.map(option => <option key={option.value} value={option.value}>Last {option.label}</option>)}
            </select>
            <button
              onClick={() => {
                nodePoolsQuery.refetch()
                nodeClaimsQuery.refetch()
                ec2NodeClassesQuery.refetch()
                nodesQuery.refetch()
                instantQueries.forEach(query => query.refetch())
                rangeQueries.forEach(query => query.refetch())
              }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-theme-border text-theme-text-secondary hover:text-theme-text-primary hover:bg-theme-elevated"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          <SummaryCard icon={Server} label="NodePools" value={nodePools.length} loading={isLoadingResources} />
          <SummaryCard icon={Zap} label="NodeClaims" value={nodeClaims.length} loading={isLoadingResources} />
          <SummaryCard icon={Cpu} label="Karpenter Nodes" value={Array.from(nodesByPool.values()).reduce((sum, count) => sum + count, 0)} loading={isLoadingResources} />
          <SummaryCard icon={HardDrive} label="EC2NodeClasses" value={ec2NodeClasses.length} loading={isLoadingResources} />
        </div>

        {!connected && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 flex flex-wrap items-center gap-3">
            {prometheusStatus?.autoPortForwardOnStart ? (
              <Loader2 className="w-5 h-5 text-amber-500 animate-spin" />
            ) : (
              <AlertTriangle className="w-5 h-5 text-amber-500" />
            )}
            <div className="flex-1 min-w-64">
              <div className="text-sm font-medium text-theme-text-primary">
                {prometheusStatus?.autoPortForwardOnStart ? 'Connecting to Prometheus...' : 'Prometheus is not connected'}
              </div>
              <div className="text-xs text-theme-text-tertiary">
                {prometheusStatus?.autoPortForwardOnStart
                  ? 'Startup port-forward is enabled. Karpenter metrics will appear automatically when ready.'
                  : 'Resource inventory is visible, but Karpenter activity and performance panels need Prometheus.'}
              </div>
            </div>
            {!prometheusStatus?.autoPortForwardOnStart && (
              <button
                onClick={() => connectMutation.mutate()}
                disabled={statusLoading || connectMutation.isPending}
                className="px-3 py-1.5 rounded-lg bg-sky-500 text-white text-xs font-medium disabled:opacity-60"
              >
                {connectMutation.isPending ? 'Connecting...' : 'Discover Prometheus'}
              </button>
            )}
          </div>
        )}

        <section>
          <SectionHeader title="Node Pool Summary" />
          <div className="rounded-xl border border-theme-border bg-theme-base overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-theme-elevated text-xs text-theme-text-tertiary">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">NodePool</th>
                    <th className="text-left font-medium px-3 py-2">Status</th>
                    <th className="text-right font-medium px-3 py-2">Nodes</th>
                    <th className="text-right font-medium px-3 py-2">NodeClaims</th>
                    <th className="text-right font-medium px-3 py-2">CPU Usage</th>
                    <th className="text-right font-medium px-3 py-2">Memory Usage</th>
                    <th className="text-right font-medium px-3 py-2">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoadingResources ? (
                    <tr><td colSpan={7} className="px-3 py-8 text-center text-theme-text-tertiary"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading Karpenter resources...</td></tr>
                  ) : nodePools.length === 0 ? (
                    <tr><td colSpan={7} className="px-3 py-8 text-center text-theme-text-tertiary">No NodePools found.</td></tr>
                  ) : nodePools.map(pool => {
                    const name = pool.metadata?.name || '-'
                    return (
                      <tr key={pool.metadata?.uid || name} className="border-t border-theme-border">
                        <td className="px-3 py-2 font-medium text-theme-text-primary">{name}</td>
                        <td className="px-3 py-2"><StatusBadge status={conditionStatus(pool)} /></td>
                        <td className="px-3 py-2 text-right text-theme-text-secondary">{nodesByPool.get(name) || 0}</td>
                        <td className="px-3 py-2 text-right text-theme-text-secondary">{claimsByPool.get(name) || 0}</td>
                        <td className="px-3 py-2 text-right text-theme-text-secondary">{seriesValueForLabel(nodePoolMetrics.get('nodepool-cpu')?.series, 'nodepool', name, 'cores')}</td>
                        <td className="px-3 py-2 text-right text-theme-text-secondary">{seriesValueForLabel(nodePoolMetrics.get('nodepool-memory')?.series, 'nodepool', name, 'bytes')}</td>
                        <td className="px-3 py-2 text-right text-theme-text-tertiary">{formatAge(pool.metadata?.creationTimestamp)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section>
          <SectionHeader title="Capacity" />
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {INSTANT_PANELS.map((panel, index) => (
              <MetricCard key={panel.key} panel={panel} result={instantQueries[index]?.data} isLoading={instantQueries[index]?.isLoading} error={instantQueries[index]?.error as Error | null} />
            ))}
          </div>
        </section>

        <section>
          <SectionHeader title="Activity & Performance" />
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {RANGE_PANELS.map((panel, index) => (
              <MetricCard key={panel.key} panel={panel} result={rangeQueries[index]?.data} isLoading={rangeQueries[index]?.isLoading} error={rangeQueries[index]?.error as Error | null} />
            ))}
          </div>
        </section>

        <section>
          <SectionHeader title="Recent NodeClaims" />
          <div className="rounded-xl border border-theme-border bg-theme-base overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-theme-elevated text-xs text-theme-text-tertiary">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">NodeClaim</th>
                    <th className="text-left font-medium px-3 py-2">NodePool</th>
                    <th className="text-left font-medium px-3 py-2">Instance</th>
                    <th className="text-left font-medium px-3 py-2">Capacity</th>
                    <th className="text-left font-medium px-3 py-2">Zone</th>
                    <th className="text-left font-medium px-3 py-2">Status</th>
                    <th className="text-right font-medium px-3 py-2">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {nodeClaims.slice(0, 12).map(claim => {
                    const labels = claim.metadata?.labels || {}
                    return (
                      <tr key={claim.metadata?.uid || claim.metadata?.name} className="border-t border-theme-border">
                        <td className="px-3 py-2 font-medium text-theme-text-primary">{claim.metadata?.name || '-'}</td>
                        <td className="px-3 py-2 text-theme-text-secondary">{nodePoolName(claim)}</td>
                        <td className="px-3 py-2 text-theme-text-secondary">{claim.status?.instanceType || labels['node.kubernetes.io/instance-type'] || '-'}</td>
                        <td className="px-3 py-2 text-theme-text-secondary">{labels['karpenter.sh/capacity-type'] || '-'}</td>
                        <td className="px-3 py-2 text-theme-text-secondary">{labels['topology.kubernetes.io/zone'] || '-'}</td>
                        <td className="px-3 py-2"><StatusBadge status={conditionStatus(claim)} /></td>
                        <td className="px-3 py-2 text-right text-theme-text-tertiary">{formatAge(claim.metadata?.creationTimestamp)}</td>
                      </tr>
                    )
                  })}
                  {!isLoadingResources && nodeClaims.length === 0 && (
                    <tr><td colSpan={7} className="px-3 py-8 text-center text-theme-text-tertiary">No NodeClaims found.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

function SummaryCard({ icon: Icon, label, value, loading }: { icon: typeof Server; label: string; value: number; loading: boolean }) {
  return (
    <div className="rounded-xl border border-theme-border bg-theme-base p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-theme-text-tertiary uppercase tracking-wide">{label}</span>
        <Icon className="w-4 h-4 text-sky-500" />
      </div>
      <div className="mt-3 text-2xl font-semibold text-theme-text-primary">
        {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : value}
      </div>
    </div>
  )
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <Activity className="w-4 h-4 text-theme-text-tertiary" />
      <h3 className="text-sm font-semibold text-theme-text-primary">{title}</h3>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const healthy = status === 'Ready' || status === 'True'
  return (
    <span className={clsx(
      'inline-flex px-2 py-0.5 rounded text-xs font-medium',
      healthy ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    )}>
      {status}
    </span>
  )
}

function seriesValueForLabel(series: PrometheusSeries[] | undefined, label: string, value: string, unit: string) {
  const match = series?.find(item => item.labels[label] === value)
  if (!match) return '-'
  return formatNumber(latestPointValue(match), unit)
}

function MetricCard({ panel, result, isLoading, error }: { panel: MetricPanel; result?: PrometheusQueryResult; isLoading?: boolean; error?: Error | null }) {
  const hasData = Boolean(result?.series?.some(series => series.dataPoints.length > 0))

  return (
    <div className="rounded-xl border border-theme-border bg-theme-base p-4 min-h-56">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h4 className="text-sm font-medium text-theme-text-primary">{panel.title}</h4>
          <p className="text-xs text-theme-text-tertiary">{panel.unit}</p>
        </div>
        {hasData && (
          <div className="text-right">
            <div className="text-xl font-semibold text-emerald-500">{formatNumber(latestValue(result?.series), panel.unit)}</div>
            <div className="text-[10px] text-theme-text-tertiary">current total</div>
          </div>
        )}
      </div>
      {isLoading ? (
        <div className="h-40 flex items-center justify-center text-theme-text-tertiary">
          <Loader2 className="w-4 h-4 animate-spin mr-2" />
          Loading metrics...
        </div>
      ) : error ? (
        <div className="h-40 flex items-center justify-center text-xs text-red-500 text-center px-4">{error.message}</div>
      ) : !hasData ? (
        <div className="h-40 flex flex-col items-center justify-center text-theme-text-tertiary">
          <BarChart3 className="w-7 h-7 opacity-40 mb-2" />
          <span className="text-sm">No data</span>
        </div>
      ) : panel.kind === 'bar' || panel.kind === 'stat' ? (
        <BarList series={result!.series} unit={panel.unit} />
      ) : (
        <MiniLineChart series={result!.series} unit={panel.unit} />
      )}
    </div>
  )
}

function BarList({ series, unit }: { series: PrometheusSeries[]; unit: string }) {
  const values = series
    .map((item, index) => ({ label: seriesLabel(item, `series-${index + 1}`), value: latestPointValue(item) }))
    .sort((a, b) => b.value - a.value)
  const max = Math.max(...values.map(item => item.value), 1)

  return (
    <div className="space-y-2">
      {values.map(item => (
        <div key={item.label} className="space-y-1">
          <div className="flex justify-between gap-3 text-xs">
            <span className="text-theme-text-secondary truncate">{item.label}</span>
            <span className="text-theme-text-tertiary tabular-nums">{formatNumber(item.value, unit)}</span>
          </div>
          <div className="h-2 rounded-full bg-theme-elevated overflow-hidden">
            <div className="h-full rounded-full bg-emerald-500/70" style={{ width: `${Math.max(2, (item.value / max) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function MiniLineChart({ series, unit }: { series: PrometheusSeries[]; unit: string }) {
  const allPoints = series.flatMap(item => item.dataPoints.map(point => point.value))
  const max = Math.max(...allPoints, 1)
  const min = Math.min(...allPoints, 0)
  const span = Math.max(max - min, 1)
  const colors = ['#10b981', '#38bdf8', '#f59e0b', '#a78bfa', '#f472b6', '#94a3b8']
  const firstSeries = series.find(item => item.dataPoints.length > 0)
  const firstPoint = firstSeries?.dataPoints[0]
  const lastPoint = firstSeries?.dataPoints[firstSeries.dataPoints.length - 1]
  const width = 640
  const height = 210
  const left = 58
  const right = 16
  const top = 14
  const bottom = 38
  const plotWidth = width - left - right
  const plotHeight = height - top - bottom
  const yTicks = [max, min + span / 2, min]

  return (
    <div className="space-y-3">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-52">
        <rect x={left} y={top} width={plotWidth} height={plotHeight} fill="transparent" stroke="currentColor" className="text-theme-border" />
        {yTicks.map((tick, index) => {
          const y = top + index * (plotHeight / 2)
          return (
            <g key={index}>
              <line x1={left} y1={y} x2={left + plotWidth} y2={y} stroke="currentColor" className="text-theme-border" strokeDasharray={index === 2 ? undefined : '4 4'} opacity={0.75} />
              <text x={left - 8} y={y + 4} textAnchor="end" className="fill-theme-text-tertiary text-[11px]">{formatNumber(tick, unit)}</text>
            </g>
          )
        })}
        {firstPoint && lastPoint && (
          <>
            <text x={left} y={height - 10} textAnchor="start" className="fill-theme-text-tertiary text-[11px]">{formatTimestamp(firstPoint.timestamp)}</text>
            <text x={left + plotWidth} y={height - 10} textAnchor="end" className="fill-theme-text-tertiary text-[11px]">{formatTimestamp(lastPoint.timestamp)}</text>
          </>
        )}
        {series.map((item, index) => {
          const points = item.dataPoints
          const path = points.map((point, pointIndex) => {
            const x = left + (points.length === 1 ? 0 : (pointIndex / (points.length - 1)) * plotWidth)
            const y = top + plotHeight - ((point.value - min) / span) * plotHeight
            return `${pointIndex === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
          }).join(' ')
          return <path key={index} d={path} fill="none" stroke={colors[index % colors.length]} strokeWidth="2" />
        })}
      </svg>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {series.slice(0, 6).map((item, index) => (
          <div key={index} className="flex items-center gap-1.5 text-xs text-theme-text-tertiary">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: colors[index % colors.length] }} />
            <span className="truncate max-w-40">{seriesLabel(item, `series-${index + 1}`)}</span>
            <span className="tabular-nums">{formatNumber(latestPointValue(item), unit)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
