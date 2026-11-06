/**
 * Criptografia do modo emergência (WebCrypto puro — funciona no app e no Node para testes).
 *
 * Cada aparelho tem duas chaves P-256: uma para receber (ECDH) e outra para assinar (ECDSA).
 * As públicas ficam no Supabase (mesh_keys) e numa cópia local, para funcionar sem internet.
 *
 * Envio de uma mensagem para um usuário:
 *   1. sorteia uma chave AES-256 da mensagem e cifra o conteúdo (AES-GCM);
 *   2. para cada aparelho do destinatário: ECDH (chave efêmera × chave do aparelho) → HKDF → embrulha a chave AES;
 *   3. assina (ECDSA) id, remetente, destinatário, datas e o texto cifrado.
 * Quem carrega a mensagem no caminho vê só: id, para quem, de quem e validade — nunca o conteúdo.
 */

export type JWK = JsonWebKey

export type DeviceIdentity = {
  deviceId: string
  encPriv: JWK
  encPub: JWK
  signPriv: JWK
  signPub: JWK
}

export type DeviceKeys = { device_id: string; enc_key: JWK; sign_key: JWK }

/** o que viaja de celular em celular */
export type Envelope = {
  v: 1
  id: string
  /** m = mensagem, a = confirmação de entrega */
  t: 'm' | 'a'
  to: string
  from: string
  ts: number
  exp: number
  /** m: corpo cifrado (base64 de SealedBody) · a: id da mensagem confirmada */
  b: string
}

type SealedBody = {
  e: JWK // chave pública efêmera
  iv: string
  ct: string
  k: { d: string; iv: string; w: string }[] // chave da mensagem embrulhada para cada aparelho
  sd: string // aparelho que assinou
  sig: string
}

export type Plain = {
  text: string
  /** nome de quem enviou, para mostrar mesmo sem a lista de contatos */
  name?: string
  loc?: { lat: number; lng: number; acc?: number }
}

const subtle = globalThis.crypto.subtle
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const
const enc = new TextEncoder()
const dec = new TextDecoder()

export const WEEK = 7 * 24 * 3600 * 1000

export function b64(bytes: ArrayBuffer | Uint8Array) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i])
  return btoa(s)
}

export function unb64(s: string) {
  const raw = atob(s)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

const pubOnly = (j: JWK): JWK => ({ kty: j.kty, crv: j.crv, x: j.x, y: j.y })

export async function createIdentity(): Promise<DeviceIdentity> {
  const e = await subtle.generateKey(ECDH, true, ['deriveBits'])
  const s = await subtle.generateKey(ECDSA, true, ['sign', 'verify'])
  return {
    deviceId: crypto.randomUUID(),
    encPriv: await subtle.exportKey('jwk', e.privateKey),
    encPub: pubOnly(await subtle.exportKey('jwk', e.publicKey)),
    signPriv: await subtle.exportKey('jwk', s.privateKey),
    signPub: pubOnly(await subtle.exportKey('jwk', s.publicKey)),
  }
}

async function wrapKey(shared: ArrayBuffer, deviceId: string) {
  const base = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(deviceId), info: enc.encode('zap-mesh-v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function signedBytes(env: Omit<Envelope, 'b'>, iv: string, ct: string) {
  return enc.encode([env.v, env.id, env.t, env.to, env.from, env.ts, env.exp, iv, ct].join('|'))
}

/** fecha uma mensagem para todos os aparelhos do destinatário */
export async function seal(
  me: { userId: string; identity: DeviceIdentity },
  to: string,
  devices: DeviceKeys[],
  plain: Plain,
  opts: { id?: string; ts?: number; ttl?: number } = {},
): Promise<Envelope> {
  if (!devices.length) throw new Error('destinatário sem chave')
  const ts = opts.ts ?? Date.now()
  const head = { v: 1 as const, id: opts.id ?? crypto.randomUUID(), t: 'm' as const, to, from: me.userId, ts, exp: ts + (opts.ttl ?? WEEK) }

  const cek = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, cek, enc.encode(JSON.stringify(plain)))
  const rawCek = await subtle.exportKey('raw', cek)

  const eph = await subtle.generateKey(ECDH, true, ['deriveBits'])
  const k: SealedBody['k'] = []
  for (const d of devices) {
    const pub = await subtle.importKey('jwk', pubOnly(d.enc_key), ECDH, false, [])
    const shared = await subtle.deriveBits({ name: 'ECDH', public: pub }, eph.privateKey, 256)
    const kek = await wrapKey(shared, d.device_id)
    const wiv = crypto.getRandomValues(new Uint8Array(12))
    k.push({ d: d.device_id, iv: b64(wiv), w: b64(await subtle.encrypt({ name: 'AES-GCM', iv: wiv }, kek, rawCek)) })
  }

  const ivS = b64(iv)
  const ctS = b64(ct)
  const signKey = await subtle.importKey('jwk', me.identity.signPriv, ECDSA, false, ['sign'])
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signKey, signedBytes(head, ivS, ctS))

  const body: SealedBody = {
    e: pubOnly(await subtle.exportKey('jwk', eph.publicKey)),
    iv: ivS,
    ct: ctS,
    k,
    sd: me.identity.deviceId,
    sig: b64(sig),
  }
  return { ...head, b: b64(enc.encode(JSON.stringify(body))) }
}

/**
 * Abre uma mensagem endereçada a este aparelho.
 * verified = a assinatura bate com uma chave conhecida do remetente (senão, mostrar "remetente não confirmado").
 */
export async function open(
  env: Envelope,
  identity: DeviceIdentity,
  senderDevices: DeviceKeys[],
): Promise<{ plain: Plain; verified: boolean }> {
  const body = JSON.parse(dec.decode(unb64(env.b))) as SealedBody
  const mine = body.k.find((x) => x.d === identity.deviceId)
  if (!mine) throw new Error('mensagem não é para este aparelho')

  const priv = await subtle.importKey('jwk', identity.encPriv, ECDH, false, ['deriveBits'])
  const ephPub = await subtle.importKey('jwk', pubOnly(body.e), ECDH, false, [])
  const shared = await subtle.deriveBits({ name: 'ECDH', public: ephPub }, priv, 256)
  const kek = await wrapKey(shared, identity.deviceId)
  const rawCek = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(mine.iv) }, kek, unb64(mine.w))
  const cek = await subtle.importKey('raw', rawCek, 'AES-GCM', false, ['decrypt'])
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(body.iv) }, cek, unb64(body.ct))
  const plain = JSON.parse(dec.decode(pt)) as Plain

  let verified = false
  const signer = senderDevices.find((d) => d.device_id === body.sd)
  if (signer) {
    const pub = await subtle.importKey('jwk', pubOnly(signer.sign_key), ECDSA, false, ['verify'])
    verified = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64(body.sig), signedBytes(env, body.iv, body.ct))
  }
  return { plain, verified }
}

/** confirmação de entrega: não tem conteúdo, só diz "a mensagem X chegou" */
export function ack(me: string, original: Envelope): Envelope {
  const ts = Date.now()
  return { v: 1, id: `a-${original.id}`, t: 'a', to: original.from, from: me, ts, exp: ts + WEEK, b: original.id }
}

export function parseEnvelope(s: string): Envelope | null {
  try {
    const e = JSON.parse(s) as Envelope
    if (e?.v !== 1 || typeof e.id !== 'string' || typeof e.to !== 'string' || typeof e.from !== 'string') return null
    if (e.t !== 'm' && e.t !== 'a') return null
    return e
  } catch {
    return null
  }
}
