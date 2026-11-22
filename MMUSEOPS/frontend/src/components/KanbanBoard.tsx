import type { PipelineDef } from '../types/pipeline'
import type { PipelineItem } from '../types/item'
import StageColumn from './StageColumn'
import { motion, AnimatePresence } from 'framer-motion'

export default function KanbanBoard({
  pipeline,
  items,
  onRefresh,
}: {
  pipeline: PipelineDef
  items: PipelineItem[]
  onRefresh: () => void
}) {
  return (
    <div className="flex-1 overflow-x-auto p-6 pt-0">
      <div className="flex gap-4 h-full min-h-0 pb-4">
        <AnimatePresence>
          {pipeline.stages.map(stage => {
            const stageItems = items.filter(i => i.currentStageId === stage.id)
            return (
              <motion.div
                key={stage.id}
                layout
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.2 }}
              >
                <StageColumn
                  stageDef={stage}
                  items={stageItems}
                  onRefresh={onRefresh}
                />
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
    </div>
  )
}
