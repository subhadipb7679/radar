import { NodeRenderer as BaseNodeRenderer } from '@skyhook-io/k8s-ui/components/resources/renderers/NodeRenderer'
import { useNavigate } from 'react-router-dom'
import { useNodeMetrics, useNodeMetricsHistory } from '../../../api/client'
import { serializeColumnFilters } from '../resource-utils'

interface NodeRendererProps {
  data: any
  relationships?: { pods?: any[] }
}

export function NodeRenderer({ data, relationships }: NodeRendererProps) {
  const navigate = useNavigate()
  const nodeName = data.metadata?.name

  // Fetch node metrics
  const { data: metrics } = useNodeMetrics(nodeName)
  const { data: metricsHistory } = useNodeMetricsHistory(nodeName)

  return (
    <BaseNodeRenderer
      data={data}
      relationships={relationships}
      onViewPods={nodeName ? () => {
        const params = new URLSearchParams()
        params.set('filters', serializeColumnFilters({ node: [nodeName] }))
        navigate(`/resources/pods?${params.toString()}`)
      } : undefined}
      metrics={metrics}
      metricsHistory={metricsHistory}
      hideMetricsServer={false}
    />
  )
}
