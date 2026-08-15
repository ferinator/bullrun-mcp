import type { EtfHolding, EtfPrice, EtfProfile } from "./etfData.js";

export interface EtfSimilarityInput {
  ticker: string
  holdings: EtfHolding[]
  profile: EtfProfile | null
  prices: EtfPrice[]
}

export interface SimilarityComponent {
  key: 'holdings' | 'economic' | 'behavior'
  label: string
  score: number | null
  weight: number
  detail: string
}

export interface SharedHolding {
  key: string
  symbol: string | null
  name: string
  leftWeight: number
  rightWeight: number
  overlapWeight: number
}

export interface UniqueHolding {
  key: string
  symbol: string | null
  name: string
  weight: number
}

export interface CorrelationWindow {
  period: '10Y' | '5Y' | '1Y'
  correlation: number | null
  observations: number
  sampling: 'monthly' | 'weekly' | 'daily'
  included: boolean
}

export interface EtfSimilarityResult {
  score: number
  label: string
  insight: string
  confidence: 'High' | 'Medium' | 'Limited'
  confidenceScore: number
  weightedOverlapPct: number
  estimatedHoldingsOverlapPct: number | null
  disclosedHoldingsSimilarityPct: number | null
  economicExposureScore: number | null
  economicExposureCoveragePct: number
  sharedHoldingsCount: number
  unionHoldingsCount: number
  leftCoveragePct: number
  rightCoveragePct: number
  leftUnmatchedPct: number
  rightUnmatchedPct: number
  returnCorrelation: number | null
  trackingErrorPct: number | null
  commonReturnDays: number
  correlationWindows: CorrelationWindow[]
  leftAsOfDate: string | null
  rightAsOfDate: string | null
  sharedHoldings: SharedHolding[]
  leftUniqueHoldings: UniqueHolding[]
  rightUniqueHoldings: UniqueHolding[]
  components: SimilarityComponent[]
}

interface Position {
  key: string
  symbol: string | null
  name: string
  weight: number
  symbolAlias: string | null
  nameAlias: string | null
}

interface EconomicExposureResult {
  score: number | null
  coveragePct: number
  matched: number
  total: number
  detail: string
}

interface WindowDefinition {
  period: CorrelationWindow['period']
  years: number
  weight: number
  sampling: CorrelationWindow['sampling']
  minimumObservations: number
}

const BEHAVIOR_WINDOWS: WindowDefinition[] = [
  { period: '10Y', years: 10, weight: 50, sampling: 'monthly', minimumObservations: 60 },
  { period: '5Y', years: 5, weight: 30, sampling: 'weekly', minimumObservations: 104 },
  { period: '1Y', years: 1, weight: 20, sampling: 'daily', minimumObservations: 60 },
]

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value))

function normalizedSymbol(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') ?? ''
  return normalized && normalized !== 'NAN' && normalized !== 'NA' ? normalized : null
}

function normalizedName(value: string | null | undefined): string | null {
  const normalized = (value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(incorporated|inc|corporation|corp|company|co|limited|ltd|plc|ordinary|shares?)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  return normalized || null
}

function positions(rows: EtfHolding[]): Position[] {
  const aggregated = new Map<string, Position>()
  for (const row of rows) {
    const weight = Number(row.weightPct)
    if (!Number.isFinite(weight) || weight <= 0) continue
    const symbolAlias = normalizedSymbol(row.holdingSymbol)
    const nameAlias = normalizedName(row.holdingName)
    const fallback = normalizedName(row.holdingKey)
    const key = symbolAlias ? `symbol:${symbolAlias}` : `name:${nameAlias ?? fallback ?? row.holdingKey}`
    const existing = aggregated.get(key)
    if (existing) {
      existing.weight += weight
      continue
    }
    aggregated.set(key, {
      key,
      symbol: row.holdingSymbol?.trim() || null,
      name: row.holdingName?.trim() || row.holdingSymbol?.trim() || 'Unnamed holding',
      weight,
      symbolAlias,
      nameAlias,
    })
  }
  return [...aggregated.values()].sort((a, b) => b.weight - a.weight)
}

function matchPositions(left: Position[], right: Position[]) {
  const unmatchedRight = new Set(right.map((_, index) => index))
  const shared: SharedHolding[] = []
  const leftOnly: UniqueHolding[] = []

  for (const leftPosition of left) {
    let matchIndex = right.findIndex((rightPosition, index) =>
      unmatchedRight.has(index)
      && leftPosition.symbolAlias != null
      && leftPosition.symbolAlias === rightPosition.symbolAlias,
    )
    if (matchIndex < 0) {
      matchIndex = right.findIndex((rightPosition, index) =>
        unmatchedRight.has(index)
        && leftPosition.nameAlias != null
        && leftPosition.nameAlias === rightPosition.nameAlias
        && (leftPosition.symbolAlias == null || rightPosition.symbolAlias == null),
      )
    }
    if (matchIndex < 0) {
      leftOnly.push({
        key: leftPosition.key,
        symbol: leftPosition.symbol,
        name: leftPosition.name,
        weight: leftPosition.weight,
      })
      continue
    }
    unmatchedRight.delete(matchIndex)
    const rightPosition = right[matchIndex]
    shared.push({
      key: `${leftPosition.key}|${rightPosition.key}`,
      symbol: leftPosition.symbol ?? rightPosition.symbol,
      name: leftPosition.name !== 'Unnamed holding' ? leftPosition.name : rightPosition.name,
      leftWeight: leftPosition.weight,
      rightWeight: rightPosition.weight,
      overlapWeight: Math.min(leftPosition.weight, rightPosition.weight),
    })
  }

  const rightOnly = right
    .filter((_, index) => unmatchedRight.has(index))
    .map(position => ({
      key: position.key,
      symbol: position.symbol,
      name: position.name,
      weight: position.weight,
    }))

  shared.sort((a, b) => b.overlapWeight - a.overlapWeight)
  leftOnly.sort((a, b) => b.weight - a.weight)
  rightOnly.sort((a, b) => b.weight - a.weight)
  return { shared, leftOnly, rightOnly }
}

function tokenSimilarity(left: string | null | undefined, right: string | null | undefined): number | null {
  const ignored = new Set(['the', 'index', 'etf', 'ucits', 'fund', 'trust'])
  const tokens = (value: string | null | undefined) => new Set(
    (normalizedName(value) ?? '').split(' ').filter(token => token && !ignored.has(token)),
  )
  const a = tokens(left)
  const b = tokens(right)
  if (a.size === 0 || b.size === 0) return null
  const intersection = [...a].filter(token => b.has(token)).length
  const union = new Set([...a, ...b]).size
  return union === 0 ? null : intersection / union * 100
}

function canonicalAssetClass(profile: EtfProfile | null): string | null {
  const value = normalizedName([profile?.assetClass, profile?.category, profile?.fundName].filter(Boolean).join(' ')) ?? ''
  if (/\b(multi asset|allocation|balanced)\b/.test(value)) return 'Multi-asset'
  if (/\b(bond|fixed income|treasur|credit|debt|mortgage|municipal)\b/.test(value)) return 'Fixed income'
  if (/\b(equity|equities|stock|large cap|mid cap|small cap|growth|value|blend)\b/.test(value)) return 'Equity'
  if (/\b(commodity|gold|silver|copper|oil|natural gas|agriculture)\b/.test(value)) return 'Commodity'
  if (/\b(real estate|reit|property)\b/.test(value)) return 'Real estate'
  if (/\b(crypto|bitcoin|ethereum|digital asset)\b/.test(value)) return 'Digital asset'
  if (/\b(cash|money market|ultra short)\b/.test(value)) return 'Cash'
  return profile?.assetClass?.trim() || null
}

function canonicalRegion(value: string | null | undefined): string | null {
  const region = normalizedName(value) ?? ''
  if (!region) return null
  if (/\b(global|world|all world)\b/.test(region)) return 'Global'
  if (/\b(united states|usa|u s)\b/.test(region)) return 'United States'
  if (/\bnorth america\b/.test(region)) return 'North America'
  if (/\b(developed markets?|developed world)\b/.test(region)) return 'Developed markets'
  if (/\bemerging markets?\b/.test(region)) return 'Emerging markets'
  if (/\beurope\b/.test(region)) return 'Europe'
  if (/\b(asia|pacific)\b/.test(region)) return 'Asia Pacific'
  if (/\bjapan\b/.test(region)) return 'Japan'
  if (/\bchina\b/.test(region)) return 'China'
  return value?.trim() || null
}

function regionSimilarity(left: string | null | undefined, right: string | null | undefined): number | null {
  const a = canonicalRegion(left)
  const b = canonicalRegion(right)
  if (!a || !b) return null
  if (a === b) return 100
  const pair = new Set([a, b])
  if (pair.has('United States') && pair.has('North America')) return 85
  if (pair.has('Developed markets') && ['United States', 'North America', 'Europe', 'Japan'].some(value => pair.has(value))) return 70
  if (pair.has('Asia Pacific') && ['Japan', 'China'].some(value => pair.has(value))) return 70
  if (pair.has('Global')) return 40
  return tokenSimilarity(a, b) ?? 0
}

function exposureSignature(profile: EtfProfile | null) {
  const rawText = [
    profile?.fundName,
    profile?.category,
    profile?.benchmark,
    profile?.description,
    profile?.productType,
  ].filter(Boolean).join(' ').toLowerCase()
  const text = normalizedName(rawText) ?? ''
  const inverse = /\b(inverse|short|bear|minus 1x)\b/.test(text) || /ultrashort|-\s*1x/.test(rawText)
  const multiple = text.match(/\b([234])x\b/)?.[1]
  const wordMultiple = /\b(triple|3 times)\b/.test(text) ? 3 : /\b(double|ultra|2 times)\b/.test(text) ? 2 : null
  const geared = profile?.productType === 'ETP_GEARED' || inverse || multiple != null || wordMultiple != null
  return {
    direction: inverse ? -1 : 1,
    leverage: multiple ? Number(multiple) : wordMultiple ?? (geared ? 2 : 1),
    geared,
  }
}

function economicExposure(left: EtfProfile | null, right: EtfProfile | null): EconomicExposureResult {
  const leftAssetClass = canonicalAssetClass(left)
  const rightAssetClass = canonicalAssetClass(right)
  const leftSignature = exposureSignature(left)
  const rightSignature = exposureSignature(right)

  if (leftSignature.direction !== rightSignature.direction) {
    return { score: 0, coveragePct: 100, matched: 0, total: 1, detail: 'Long/inverse exposure mismatch' }
  }
  if (leftAssetClass && rightAssetClass && leftAssetClass !== rightAssetClass) {
    return {
      score: 0,
      coveragePct: 100,
      matched: 0,
      total: 1,
      detail: `${leftAssetClass} vs ${rightAssetClass}: asset-class gate applied`,
    }
  }

  const benchmarkSimilarity = left?.indexKey && right?.indexKey
    ? (left.indexKey === right.indexKey ? 100 : 0)
    : tokenSimilarity(left?.benchmark, right?.benchmark)
  const dimensions: Array<{ score: number | null; weight: number }> = [
    { score: leftAssetClass && rightAssetClass ? 100 : null, weight: 40 },
    { score: tokenSimilarity(left?.category, right?.category), weight: 30 },
    { score: regionSimilarity(left?.region, right?.region), weight: 20 },
    { score: benchmarkSimilarity, weight: 10 },
  ]
  const available = dimensions.filter((dimension): dimension is { score: number; weight: number } => dimension.score != null)
  const availableWeight = available.reduce((sum, dimension) => sum + dimension.weight, 0)
  if (availableWeight === 0) {
    return { score: null, coveragePct: 0, matched: 0, total: 0, detail: 'Economic exposure fields unavailable' }
  }
  const baseScore = available.reduce((sum, dimension) => sum + dimension.score * dimension.weight, 0) / availableWeight
  const leverageSimilarity = Math.min(leftSignature.leverage, rightSignature.leverage)
    / Math.max(leftSignature.leverage, rightSignature.leverage)
  const score = clamp(baseScore * leverageSimilarity)
  const detailSuffix = leverageSimilarity < 1
    ? ` · ${leftSignature.leverage}x vs ${rightSignature.leverage}x exposure`
    : ''
  return {
    score,
    coveragePct: availableWeight,
    matched: available.filter(dimension => dimension.score >= 80).length,
    total: available.length,
    detail: `${available.length} of 4 economic dimensions available${detailSuffix}`,
  }
}

function sortedPrices(prices: EtfPrice[], start: string, end: string) {
  return prices
    .filter((price): price is EtfPrice & { closePrice: number } =>
      price.closePrice != null && price.closePrice > 0 && price.tradeDate >= start && price.tradeDate <= end)
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate))
}

function weekKey(value: string): string {
  const date = new Date(`${value}T00:00:00Z`)
  const daysSinceMonday = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - daysSinceMonday)
  return date.toISOString().slice(0, 10)
}

function sampledReturns(
  prices: EtfPrice[],
  start: string,
  end: string,
  sampling: CorrelationWindow['sampling'],
): Map<string, number> {
  const closes = new Map<string, number>()
  for (const price of sortedPrices(prices, start, end)) {
    const key = sampling === 'monthly'
      ? price.tradeDate.slice(0, 7)
      : sampling === 'weekly' ? weekKey(price.tradeDate) : price.tradeDate
    closes.set(key, price.closePrice)
  }
  const returns = new Map<string, number>()
  const entries = [...closes.entries()].sort(([a], [b]) => a.localeCompare(b))
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1][1]
    const [key, current] = entries[index]
    if (previous > 0) returns.set(key, current / previous - 1)
  }
  return returns
}

function correlation(left: Map<string, number>, right: Map<string, number>) {
  const keys = [...left.keys()].filter(key => right.has(key)).sort()
  if (keys.length < 2) return { value: null, observations: keys.length, differences: [] as number[] }
  const a = keys.map(key => left.get(key) as number)
  const b = keys.map(key => right.get(key) as number)
  const meanA = a.reduce((sum, value) => sum + value, 0) / a.length
  const meanB = b.reduce((sum, value) => sum + value, 0) / b.length
  let covariance = 0
  let varianceA = 0
  let varianceB = 0
  const differences: number[] = []
  for (let index = 0; index < a.length; index += 1) {
    covariance += (a[index] - meanA) * (b[index] - meanB)
    varianceA += (a[index] - meanA) ** 2
    varianceB += (b[index] - meanB) ** 2
    differences.push(a[index] - b[index])
  }
  const denominator = Math.sqrt(varianceA * varianceB)
  return {
    value: denominator > 0 ? clamp(covariance / denominator, -1, 1) : null,
    observations: keys.length,
    differences,
  }
}

function periodStart(end: string, years: number): string {
  const date = new Date(`${end}T00:00:00Z`)
  date.setUTCFullYear(date.getUTCFullYear() - years)
  return date.toISOString().slice(0, 10)
}

function latestPriceDate(prices: EtfPrice[]): string | null {
  const dates = prices.filter(price => price.closePrice != null).map(price => price.tradeDate).sort()
  return dates.length > 0 ? dates[dates.length - 1] : null
}

function commonHistoryYears(left: EtfPrice[], right: EtfPrice[], start: string, end: string): number {
  const leftDates = sortedPrices(left, start, end).map(price => price.tradeDate)
  const rightDates = sortedPrices(right, start, end).map(price => price.tradeDate)
  if (leftDates.length === 0 || rightDates.length === 0) return 0
  const commonStart = leftDates[0] > rightDates[0] ? leftDates[0] : rightDates[0]
  const startTime = new Date(`${commonStart}T00:00:00Z`).getTime()
  const endTime = new Date(`${end}T00:00:00Z`).getTime()
  return Math.max(0, (endTime - startTime) / (365.25 * 86_400_000))
}

function priceBehavior(left: EtfPrice[], right: EtfPrice[]) {
  const leftEnd = latestPriceDate(left)
  const rightEnd = latestPriceDate(right)
  if (!leftEnd || !rightEnd) {
    return {
      score: null,
      correlation: null,
      trackingErrorPct: null,
      days: 0,
      coveragePct: 0,
      windows: BEHAVIOR_WINDOWS.map(window => ({ ...window, correlation: null, observations: 0, included: false })),
    }
  }
  const end = leftEnd < rightEnd ? leftEnd : rightEnd
  const measured = BEHAVIOR_WINDOWS.map(window => {
    const start = periodStart(end, window.years)
    const historyYears = commonHistoryYears(left, right, start, end)
    const result = correlation(
      sampledReturns(left, start, end, window.sampling),
      sampledReturns(right, start, end, window.sampling),
    )
    return {
      ...window,
      correlation: result.value,
      observations: result.observations,
      differences: result.differences,
      included: result.value != null
        && result.observations >= window.minimumObservations
        && historyYears >= window.years * 0.8,
    }
  })
  const included = measured.filter(window => window.included && window.correlation != null)
  const includedWeight = included.reduce((sum, window) => sum + window.weight, 0)
  const blendedCorrelation = includedWeight > 0
    ? included.reduce((sum, window) => sum + (window.correlation as number) * window.weight, 0) / includedWeight
    : null
  const oneYear = measured.find(window => window.period === '1Y')
  const differences = oneYear?.included ? oneYear.differences : []
  const meanDifference = differences.length > 0
    ? differences.reduce((sum, value) => sum + value, 0) / differences.length
    : 0
  const differenceVariance = differences.length > 1
    ? differences.reduce((sum, value) => sum + (value - meanDifference) ** 2, 0) / (differences.length - 1)
    : null
  const trackingError = differenceVariance == null ? null : Math.sqrt(differenceVariance) * Math.sqrt(252)
  const correlationScore = blendedCorrelation == null ? null : clamp(Math.max(0, blendedCorrelation) * 100)
  const trackingScore = trackingError == null ? null : Math.exp(-trackingError / 0.15) * 100
  const score = correlationScore == null
    ? null
    : trackingScore == null ? correlationScore : correlationScore * 0.7 + trackingScore * 0.3
  return {
    score,
    correlation: blendedCorrelation,
    trackingErrorPct: trackingError == null ? null : trackingError * 100,
    days: oneYear?.observations ?? 0,
    coveragePct: includedWeight,
    windows: measured.map(({ period, correlation: value, observations, sampling, included: isIncluded }) => ({
      period,
      correlation: value,
      observations,
      sampling,
      included: isIncluded,
    })),
  }
}

function latestDate(rows: EtfHolding[]): string | null {
  const dates = rows.map(row => row.asOfDate).filter(Boolean).sort()
  return dates.length > 0 ? dates[dates.length - 1] : null
}

function freshnessScore(dates: Array<string | null>): number {
  const valid = dates
    .map(value => value ? new Date(`${value}T00:00:00Z`).getTime() : Number.NaN)
    .filter(Number.isFinite)
  if (valid.length === 0) return 0
  const oldest = Math.min(...valid)
  const ageDays = Math.max(0, (Date.now() - oldest) / 86_400_000)
  if (ageDays <= 45) return 100
  if (ageDays >= 365) return 20
  return 100 - (ageDays - 45) / 320 * 80
}

function similarityLabel(score: number): string {
  if (score >= 90) return 'Near duplicates'
  if (score >= 75) return 'Very similar'
  if (score >= 55) return 'Meaningful overlap'
  if (score >= 30) return 'Partly similar'
  return 'Distinct exposure'
}

function similarityInsight(
  score: number,
  left: string,
  right: string,
  confidence: string,
  sharedIndex: string | null,
  holdingsCoverage: number,
): string {
  if (sharedIndex && holdingsCoverage < 95) {
    return `${left} and ${right} share the same ${sharedIndex} mandate. The numerical score is conservative because the lower-coverage holdings snapshot represents ${holdingsCoverage.toFixed(0)}% of the portfolio.`
  }
  const base = score >= 90
    ? `${left} and ${right} behave like near substitutes; holding both is unlikely to add much diversification.`
    : score >= 75
      ? `${left} and ${right} deliver very similar exposure, with differences likely concentrated in weights, cost, or fund structure.`
      : score >= 55
        ? `${left} and ${right} share meaningful exposure, but each still contributes material differences.`
        : score >= 30
          ? `${left} and ${right} overlap in places, but they are not close substitutes.`
          : `${left} and ${right} provide substantially different exposure.`
  return confidence === 'Limited' ? `${base} Treat the score as indicative because source coverage is limited.` : base
}

export function calculateEtfSimilarity(left: EtfSimilarityInput, right: EtfSimilarityInput): EtfSimilarityResult {
  const leftPositions = positions(left.holdings)
  const rightPositions = positions(right.holdings)
  const { shared, leftOnly, rightOnly } = matchPositions(leftPositions, rightPositions)
  const leftCoverage = clamp(leftPositions.reduce((sum, position) => sum + position.weight, 0))
  const rightCoverage = clamp(rightPositions.reduce((sum, position) => sum + position.weight, 0))
  const comparableCoverage = Math.min(leftCoverage, rightCoverage)
  const weightedOverlap = clamp(shared.reduce((sum, holding) => sum + holding.overlapWeight, 0))
  const disclosedSimilarity = comparableCoverage >= 5 ? clamp(weightedOverlap / comparableCoverage * 100) : null
  // With partial snapshots, the confirmed overlap is a lower bound while
  // normalizing entirely to disclosed coverage overstates top-holdings feeds.
  // Shrink the normalized estimate toward the confirmed lower bound in direct
  // proportion to coverage. At full coverage this collapses to the exact value.
  const holdingsScore = disclosedSimilarity == null
    ? null
    : clamp(weightedOverlap + comparableCoverage / 100 * (disclosedSimilarity - weightedOverlap))

  const economic = economicExposure(left.profile, right.profile)
  const behavior = priceBehavior(left.prices, right.prices)
  const components: SimilarityComponent[] = [
    {
      key: 'holdings', label: 'Actual holdings', score: holdingsScore, weight: 70,
      detail: holdingsScore == null
        ? 'No comparable weighted holdings'
        : comparableCoverage >= 95
          ? `${weightedOverlap.toFixed(1)}% exact weighted overlap`
          : `${holdingsScore.toFixed(1)} estimated · ${weightedOverlap.toFixed(1)}% confirmed`,
    },
    {
      key: 'economic', label: 'Economic exposure', score: economic.score, weight: 20,
      detail: economic.detail,
    },
    {
      key: 'behavior', label: 'Historical behavior', score: behavior.score, weight: 10,
      detail: behavior.correlation == null
        ? 'Not enough common price history'
        : `${behavior.correlation.toFixed(2)} blended correlation · ${behavior.windows.filter(window => window.included).length} horizon${behavior.windows.filter(window => window.included).length === 1 ? '' : 's'}`,
    },
  ]
  const available = components.filter((component): component is SimilarityComponent & { score: number } => component.score != null)
  const availableWeight = available.reduce((sum, component) => sum + component.weight, 0)
  const rawScore = availableWeight > 0
    ? available.reduce((sum, component) => sum + component.score * component.weight, 0) / availableWeight
    : 1
  const score = Math.round(clamp(rawScore, 1, 100))

  const leftAsOfDate = latestDate(left.holdings)
  const rightAsOfDate = latestDate(right.holdings)
  const confidenceScore = Math.round(clamp(
    comparableCoverage * 0.55
      + economic.coveragePct * 0.15
      + behavior.coveragePct * 0.15
      + freshnessScore([leftAsOfDate, rightAsOfDate]) * 0.15,
  ))
  const confidence: EtfSimilarityResult['confidence'] = confidenceScore >= 80
    ? 'High'
    : confidenceScore >= 55 ? 'Medium' : 'Limited'
  const sharedIndex = left.profile?.indexKey && left.profile.indexKey === right.profile?.indexKey
    ? (left.profile.benchmark ?? right.profile?.benchmark ?? left.profile.indexKey)
    : null

  return {
    score,
    label: similarityLabel(score),
    insight: similarityInsight(score, left.ticker, right.ticker, confidence, sharedIndex, comparableCoverage),
    confidence,
    confidenceScore,
    weightedOverlapPct: weightedOverlap,
    estimatedHoldingsOverlapPct: holdingsScore,
    disclosedHoldingsSimilarityPct: disclosedSimilarity,
    economicExposureScore: economic.score,
    economicExposureCoveragePct: economic.coveragePct,
    sharedHoldingsCount: shared.length,
    unionHoldingsCount: leftPositions.length + rightPositions.length - shared.length,
    leftCoveragePct: leftCoverage,
    rightCoveragePct: rightCoverage,
    leftUnmatchedPct: Math.max(0, leftCoverage - weightedOverlap),
    rightUnmatchedPct: Math.max(0, rightCoverage - weightedOverlap),
    returnCorrelation: behavior.correlation,
    trackingErrorPct: behavior.trackingErrorPct,
    commonReturnDays: behavior.days,
    correlationWindows: behavior.windows,
    leftAsOfDate,
    rightAsOfDate,
    sharedHoldings: shared,
    leftUniqueHoldings: leftOnly,
    rightUniqueHoldings: rightOnly,
    components,
  }
}
