import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'crypto'

const VERSION = 'v1'
const KEY_LENGTH = 64
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

export function isPasswordHash(value: string): boolean {
  return value.startsWith(`scrypt$${VERSION}$`)
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await derive(password, salt, KEY_LENGTH, SCRYPT_OPTIONS)
  return [
    'scrypt',
    VERSION,
    String(SCRYPT_OPTIONS.N),
    String(SCRYPT_OPTIONS.r),
    String(SCRYPT_OPTIONS.p),
    salt.toString('base64url'),
    derived.toString('base64url')
  ].join('$')
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split('$')
  if (parts.length !== 7 || parts[0] !== 'scrypt' || parts[1] !== VERSION) return false

  const [, , n, r, p, saltText, hashText] = parts
  const nValue = Number(n)
  const rValue = Number(r)
  const pValue = Number(p)
  if (![nValue, rValue, pValue].every(Number.isFinite)) return false

  const salt = Buffer.from(saltText, 'base64url')
  const expected = Buffer.from(hashText, 'base64url')
  if (expected.length !== KEY_LENGTH) return false

  const actual = await derive(password, salt, expected.length, {
    N: nValue,
    r: rValue,
    p: pValue,
    maxmem: SCRYPT_OPTIONS.maxmem
  }) as Buffer

  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function derive(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (err, derivedKey) => {
      if (err) reject(err)
      else resolve(derivedKey)
    })
  })
}
