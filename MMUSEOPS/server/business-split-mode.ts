import { existsSync,readFileSync } from 'node:fs'
import { join } from 'node:path'
export const SPLIT_MANIFEST=join(__dirname,'..','data','business-lines','migration.json')
export function businessSplitActive() {
  if(!existsSync(SPLIT_MANIFEST)) {
    const base=join(__dirname,'..','data','business-lines')
    if(existsSync(join(base,'carseat.json'))||existsSync(join(base,'holding.json')))throw new Error('BUSINESS_SPLIT_STATE_UNKNOWN')
    return false
  }
  let m:any
  try {m=JSON.parse(readFileSync(SPLIT_MANIFEST,'utf8'))} catch {throw new Error('BUSINESS_SPLIT_STATE_UNKNOWN')}
  if(m.state==='rolled_back')return false
  if(m.state==='committed'&&m.active===true)return true
  throw new Error('BUSINESS_SPLIT_STATE_UNKNOWN')
}
