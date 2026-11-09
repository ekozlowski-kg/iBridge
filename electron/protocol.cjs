const { fileURLToPath } = require('node:url')
const { TextDecoder } = require('node:util')

const TRUSTED_EZD_HOST = 'ezd-proxy.kg.straz.gov.pl'
const EZD_SESSION_MODES = Object.freeze({
  DEFAULT: 0,
  EDIT: 0,
  PRINT: 1,
  SIGN: 2,
  SIGN_BATCH: 5,
  SIGN_BATCH_V2: 7,
})
const ezdSessionModeValues = new Set(Object.values(EZD_SESSION_MODES))
const ezdModeParameterNames = new Set(['ModeParam', 'Mode'])
const MAX_EZD_SESSION_PARAMETERS = 20
const MAX_EZD_TUNING_PARAMETER_LENGTH = 32
const ezdTuningParameterTypes = new Map([
  ['1', 'boolean'],
  ['2', 'boolean'],
  ['3', 'boolean'],
  ['4', 'boolean'],
  ['6', 'int32'],
  ['7', 'boolean'],
  ['8', 'boolean'],
  ['9', 'int32'],
  ['b', 'int32'],
  ['c', 'int64'],
  ['d', 'int32'],
  ['e', 'int32'],
  ['f', 'boolean'],
  ['i', 'boolean'],
  ['l', 'int32'],
  ['m', 'boolean'],
  ['n', 'boolean'],
  ['o', 'int32'],
  ['p', 'int32'],
])
const protocolSecrets = new WeakMap()

function invalidEzdRequest(code = 'EZD_PROTOCOL_INVALID') {
  return {
    kind: 'invalid',
    scheme: 'ezd',
    code,
    message: 'Nieprawidłowe wywołanie protokołu EZD.',
  }
}

function decodeEzdServiceUrl(encodedValue) {
  let encoded
  try {
    encoded = decodeURIComponent(encodedValue)
  } catch {
    return null
  }

  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded)) return null

  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const unpadded = normalized.replace(/=+$/, '')
  if (unpadded.length % 4 === 1) return null

  const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, '=')
  const bytes = Buffer.from(padded, 'base64')
  if (!bytes.length || bytes.toString('base64').replace(/=+$/, '') !== unpadded) return null

  let decoded
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }

  let url
  try {
    url = new URL(decoded)
  } catch {
    return null
  }

  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.hostname.toLowerCase() !== TRUSTED_EZD_HOST ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) return null

  const cleanPath = url.pathname.replace(/\/+$/, '')
  url.pathname = /\.svc$/i.test(cleanPath)
    ? cleanPath
    : `${cleanPath}/EzdProxy.svc`.replace(/^\/\//, '/')

  return url.toString()
}

function decodeProtocolComponent(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function normalizeEzdStructuralSeparators(raw) {
  if (!/^ezd:/i.test(raw)) return raw

  if (/^ezd:\/\//i.test(raw)) {
    const structuralEnd = raw.search(/[?#]/)
    const structuralPart = raw.slice('ezd://'.length, structuralEnd === -1 ? undefined : structuralEnd)
    const segments = structuralPart.split('/')
    const contentSegments = segments.at(-1) === '' ? segments.slice(0, -1) : segments
    if (
      structuralPart.includes('\\') ||
      contentSegments.length < 2 ||
      contentSegments.length > 2 + MAX_EZD_SESSION_PARAMETERS ||
      contentSegments.some((segment) => !segment)
    ) return null
    return raw
  }

  if (/^ezd:\\/i.test(raw)) {
    const structuralEnd = raw.search(/[?#]/)
    const structuralPart = raw.slice('ezd:'.length, structuralEnd === -1 ? undefined : structuralEnd)
    const suffix = structuralEnd === -1 ? '' : raw.slice(structuralEnd)
    const doubledPrefix = structuralPart.startsWith('\\\\')
    // Windows converts the canonical `//` prefix to two backslashes while
    // leaving one separator between fields. The PUW client also tolerates
    // doubled field separators by reducing each pair once before splitting.
    const body = doubledPrefix
      ? structuralPart.slice(2).replaceAll('\\\\', '\\')
      : structuralPart.slice(1)
    const segments = body.split('\\')
    if (
      segments.length < 2 ||
      segments.length > 2 + MAX_EZD_SESSION_PARAMETERS ||
      segments.some((segment) => !segment || /[\\/]/.test(segment))
    ) return null
    return `ezd://${segments.join('/')}${suffix}`
  }

  if (/^ezd:[\\/]/i.test(raw)) return null
  return raw
}

function parseEzdParameter(rawParameter, allowCompact = true) {
  const compactParameter = decodeProtocolComponent(rawParameter)
  if (compactParameter === null) return null

  // ezd.AddIn.Core maps Description("a1") directly to ModeParam and strips
  // the two-character prefix before parsing the integer (for example a12).
  const compactMode = allowCompact
    ? /^a1((?:0|[1-9]\d*))$/i.exec(compactParameter)
    : null
  if (compactMode) return { name: 'ModeParam', value: compactMode[1] }

  const separatorIndex = rawParameter.indexOf('=')
  if (separatorIndex <= 0) return null

  const name = decodeProtocolComponent(rawParameter.slice(0, separatorIndex))
  const value = decodeProtocolComponent(rawParameter.slice(separatorIndex + 1))
  if (!name || value === null || !ezdModeParameterNames.has(name)) return null

  return { name, value }
}

function isCanonicalIntegerInRange(value, minimum, maximum) {
  if (!/^(?:0|-?[1-9]\d*)$/.test(value)) return false
  try {
    const number = BigInt(value)
    return number >= minimum && number <= maximum
  } catch {
    return false
  }
}

function parseEzdTuningParameter(rawParameter) {
  const decoded = decodeProtocolComponent(rawParameter)
  if (!decoded || decoded.length > MAX_EZD_TUNING_PARAMETER_LENGTH) return null

  const key = decoded[0].toLowerCase()
  const type = ezdTuningParameterTypes.get(key)
  const value = decoded.slice(1)
  if (!type || !value) return null

  if (type === 'boolean' && !/^(?:0|1|true|false)$/i.test(value)) return null
  if (type === 'int32' && !isCanonicalIntegerInRange(value, -2147483648n, 2147483647n)) return null
  if (type === 'int64' && !isCanonicalIntegerInRange(value, -9223372036854775808n, 9223372036854775807n)) return null
  return { key }
}

function parseEzdSessionParameters(pathSegments, search) {
  const rawParameters = pathSegments.map((raw) => ({ raw, source: 'path' }))
  if (search) {
    rawParameters.push(...search.slice(1).split('&').map((raw) => ({ raw, source: 'query' })))
  }
  if (!rawParameters.length) {
    return { mode: EZD_SESSION_MODES.EDIT, parameters: {} }
  }
  if (rawParameters.length > MAX_EZD_SESSION_PARAMETERS) return null

  let modeParameter = null
  const tuningKeys = new Set()
  for (const { raw, source } of rawParameters) {
    const parameter = parseEzdParameter(raw, source === 'path')
    if (parameter) {
      if (modeParameter || !/^(?:0|[1-9]\d*)$/.test(parameter.value)) return null
      const wireMode = Number(parameter.value)
      if (!Number.isSafeInteger(wireMode) || !ezdSessionModeValues.has(wireMode)) return null
      modeParameter = { name: parameter.name, mode: wireMode }
      continue
    }

    if (source !== 'path') return null
    const tuningParameter = parseEzdTuningParameter(raw)
    if (!tuningParameter || tuningKeys.has(tuningParameter.key)) return null
    tuningKeys.add(tuningParameter.key)
  }

  if (!modeParameter) return { mode: EZD_SESSION_MODES.EDIT, parameters: {} }
  return {
    mode: modeParameter.mode,
    parameters: { [modeParameter.name]: modeParameter.mode },
  }
}

function parseProtocolRequest(rawValue) {
  const raw = String(rawValue || '').trim().replace(/^"|"$/g, '')
  if (!raw) return null

  const separatorDecodedRaw = /^ezd:/i.test(raw) ? raw.replace(/%5c/gi, '\\') : raw
  const normalizedRaw = normalizeEzdStructuralSeparators(separatorDecodedRaw)
  if (normalizedRaw === null) return invalidEzdRequest('EZD_PROTOCOL_STRUCTURE')
  if (/^ezd:/i.test(normalizedRaw) && !/^ezd:\/\//i.test(normalizedRaw)) {
    return { kind: 'legacy', scheme: 'ezd' }
  }

  let parsed
  try {
    parsed = new URL(normalizedRaw)
  } catch {
    return null
  }
  if (!['most-ezd:', 'ezd:'].includes(parsed.protocol)) return null

  if (parsed.protocol === 'ezd:') {
    if (normalizedRaw.includes('#')) return invalidEzdRequest('EZD_PROTOCOL_FRAGMENT')

    const encodedProxy = parsed.pathname.split('/').filter(Boolean)[0]
    if (!parsed.hostname || !encodedProxy) return invalidEzdRequest('EZD_PROTOCOL_SHAPE')

    const tokenMatch = /^ezd:\/\/([^/?#]+)\//i.exec(normalizedRaw)
    const authToken = decodeProtocolComponent(tokenMatch?.[1] || '')
    if (!authToken || authToken.length > 512 || /[@:\\/?#\s\x00-\x1F\x7F]/.test(authToken)) {
      return invalidEzdRequest('EZD_PROTOCOL_TOKEN')
    }

    const serviceUrl = decodeEzdServiceUrl(encodedProxy)
    if (!serviceUrl) return invalidEzdRequest('EZD_PROTOCOL_SERVICE')

    const pathSegments = parsed.pathname.split('/').filter(Boolean)
    const sessionParameters = parseEzdSessionParameters(pathSegments.slice(1), parsed.search)
    if (!sessionParameters) return invalidEzdRequest('EZD_PROTOCOL_PARAMETERS')

    const request = {
      kind: 'ezd-session',
      scheme: 'ezd',
      serviceUrl,
      mode: sessionParameters.mode,
      parameters: sessionParameters.parameters,
    }
    protocolSecrets.set(request, { authToken })
    return request
  }

  const action = parsed.hostname || parsed.pathname.replace(/^\//, '') || 'open'
  if (action === 'open') {
    const file = parsed.searchParams.get('file')
    if (!file) return { kind: 'invalid', message: 'Brak parametru file.' }
    try {
      const filePath = file.startsWith('file:') ? fileURLToPath(file) : decodeURIComponent(file)
      return { kind: 'local-file', scheme: parsed.protocol.slice(0, -1), filePath }
    } catch {
      return { kind: 'invalid', message: 'Nieprawidłowa ścieżka dokumentu.' }
    }
  }

  return { kind: 'unsupported', scheme: parsed.protocol.slice(0, -1), action }
}

function findProtocolArgument(argv) {
  return argv.find((value) => /^(most-ezd|ezd):/i.test(String(value))) || null
}

function redactProtocolArguments(argv) {
  if (!Array.isArray(argv)) return
  for (let index = 0; index < argv.length; index += 1) {
    const match = /^(most-ezd|ezd):/i.exec(String(argv[index]))
    if (match) argv[index] = `${match[1].toLowerCase()}:[ukryto]`
  }
}

function takeProtocolSecret(request) {
  if (!request || typeof request !== 'object') return null
  const secret = protocolSecrets.get(request) || null
  protocolSecrets.delete(request)
  return secret
}

function createEzdSessionPlan(request, enabled) {
  if (!enabled) {
    return {
      notice: {
        type: 'warning',
        message: 'Rozpoznano wywołanie EZD, ale jego odbiór jest wyłączony w ustawieniach. Token sesji nie został zapisany.',
      },
    }
  }

  const hostname = new URL(request.serviceUrl).hostname
  return {
    settingsPatch: { serviceUrl: request.serviceUrl },
    notice: {
      type: 'success',
      message: `Rozpoznano usługę EZD (${hostname}). Pobieranie dokumentu przez SOAP…`,
    },
  }
}

function createServiceMetadataUrl(rawUrl) {
  const url = new URL(rawUrl)
  url.search = '?wsdl'
  url.hash = ''
  return url.toString()
}

module.exports = {
  EZD_SESSION_MODES,
  createEzdSessionPlan,
  createServiceMetadataUrl,
  findProtocolArgument,
  parseProtocolRequest,
  redactProtocolArguments,
  takeProtocolSecret,
}
