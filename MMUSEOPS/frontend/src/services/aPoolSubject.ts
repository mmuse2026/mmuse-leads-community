export function suggestedSubject(company: string, country: string): string {
  const name = (company || '').trim() || 'Your Company'
  const region = (country || '').trim() || 'International'
  return `${name} — Commercial Furniture Supply for ${region} Hospitality Projects`
}
