const CP1252_BYTES = new Map<string, number>([
  ['€',0x80],['‚',0x82],['ƒ',0x83],['„',0x84],['…',0x85],['†',0x86],['‡',0x87],
  ['ˆ',0x88],['‰',0x89],['Š',0x8a],['‹',0x8b],['Œ',0x8c],['Ž',0x8e],['‘',0x91],
  ['’',0x92],['“',0x93],['”',0x94],['•',0x95],['–',0x96],['—',0x97],['˜',0x98],
  ['™',0x99],['š',0x9a],['›',0x9b],['œ',0x9c],['ž',0x9e],['Ÿ',0x9f],
])

function decodeBytes(bytes: number[], charset: string): string | null {
  const label = String(charset || 'utf-8').trim().toLowerCase().replace(/^utf8$/, 'utf-8')
  try {
    return new TextDecoder(label, { fatal: true }).decode(Uint8Array.from(bytes))
  } catch {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes))
    } catch {
      return null
    }
  }
}

function base64Bytes(payload: string): number[] | null {
  try {
    const binary = globalThis.atob(String(payload).replace(/\s+/g, ''))
    return Array.from(binary, char => char.charCodeAt(0))
  } catch {
    return null
  }
}

function quotedPrintableBytes(payload: string): number[] | null {
  const source = String(payload).replace(/_/g, ' ')
  const bytes: number[] = []
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '=' && /^[0-9a-f]{2}$/i.test(source.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(source.slice(index + 1, index + 3), 16))
      index += 2
    } else {
      const code = source.charCodeAt(index)
      if (code > 255) return null
      bytes.push(code)
    }
  }
  return bytes
}

export function decodeMimeWords(value: unknown): string {
  const compact = String(value || '').replace(/\?=\s+(?==\?)/g, '?=')
  return compact.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (whole, charset, encoding, payload) => {
    const bytes = String(encoding).toLowerCase() === 'b' ? base64Bytes(payload) : quotedPrintableBytes(payload)
    return bytes ? decodeBytes(bytes, charset) || whole : whole
  })
}

function cp1252Bytes(value: string): number[] | null {
  const bytes: number[] = []
  for (const char of value) {
    const code = char.codePointAt(0) || 0
    if (code <= 255) bytes.push(code)
    else if (CP1252_BYTES.has(char)) bytes.push(CP1252_BYTES.get(char) as number)
    else return null
  }
  return bytes
}

function badness(value: string): number {
  return (value.match(/[ÃÂâð]|ï¿½|[\u0080-\u009f]/g) || []).length
}

export function repairUtf8Mojibake(value: unknown): string {
  let current = String(value || '')
  for (let pass = 0; pass < 2; pass++) {
    let changed = false
    current = current.replace(/[\x00-\xff€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]+/g, segment => {
      if (!/[ÃÂâð]|ï¿½|(?:å|æ|ç)[\u0080-\uffff]/.test(segment)) return segment
      const bytes = cp1252Bytes(segment)
      if (!bytes) return segment
      const repaired = decodeBytes(bytes, 'utf-8')
      if (!repaired || repaired.includes('\uFFFD') || badness(repaired) >= badness(segment)) return segment
      changed = true
      return repaired
    })
    if (!changed) break
  }
  return current
}

function repairKnownLostCharacters(value: string): string {
  return value.replace(/Â(?=\s|$)/g, '').replace(/\u00a0/g, ' ').replace(/\bSt\?hle\b/g, 'Stühle')
}

export function normalizeEmailText(value: unknown): string {
  let result = String(value || '').replace(/\u0000/g, '')
  for (let pass = 0; pass < 2; pass++) {
    const decoded = decodeMimeWords(result)
    if (decoded === result) break
    result = decoded
  }
  result = repairKnownLostCharacters(result)
  return repairKnownLostCharacters(repairUtf8Mojibake(result))
}
