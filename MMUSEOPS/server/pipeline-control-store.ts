import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface PipelineControlState {
  running: boolean
  updatedAt: string
  updatedBy: string
  projectId?: string
  runBatchId?: string
}

export function isPipelineTrialExpired(stopAt: unknown, now = new Date()): boolean {
  const timestamp = Date.parse(String(stopAt || ''))
  return Number.isFinite(timestamp) && now.getTime() >= timestamp
}

export const PIPELINE_CONTROL_FILE = join(__dirname, '..', 'data', 'pipeline_control.json')

function stopped(): PipelineControlState {
  return { running: false, updatedAt: new Date(0).toISOString(), updatedBy: 'system' }
}

export function readPipelineControl(path = PIPELINE_CONTROL_FILE): PipelineControlState {
  if (!existsSync(path)) return stopped()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PipelineControlState>
    if (typeof parsed.running !== 'boolean') return stopped()
    return {
      running: parsed.running,
      updatedAt: String(parsed.updatedAt || new Date(0).toISOString()),
      updatedBy: String(parsed.updatedBy || 'system'),
      ...(String(parsed.projectId || '').trim() ? { projectId: String(parsed.projectId).trim().slice(0, 120) } : {}),
      ...(String(parsed.runBatchId || '').trim() ? { runBatchId: String(parsed.runBatchId).trim().slice(0, 160) } : {}),
    }
  } catch {
    return stopped()
  }
}

export function setPipelineRunning(
  running: boolean,
  updatedBy: string,
  path = PIPELINE_CONTROL_FILE,
  now = new Date(),
  scope: Pick<PipelineControlState, 'projectId' | 'runBatchId'> = {},
): PipelineControlState {
  const state: PipelineControlState = {
    running,
    updatedAt: now.toISOString(),
    updatedBy: String(updatedBy || 'operator').slice(0, 120),
    ...(String(scope.projectId || '').trim() ? { projectId: String(scope.projectId).trim().slice(0, 120) } : {}),
    ...(String(scope.runBatchId || '').trim() ? { runBatchId: String(scope.runBatchId).trim().slice(0, 160) } : {}),
  }
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${process.pid}`
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
  return state
}
