// @flow

const nacl = require('tweetnacl')

// Length in bytes of random seed that is synced between devices
const SEED_SIZE = 32

// Not strictly necessary but recommended by rfc5869 section 3.1
const HKDF_SALT = new Uint8Array([72, 203, 156, 43, 64, 229, 225, 127, 214, 158, 50, 29, 130, 186, 182, 207, 6, 108, 47, 254, 245, 71, 198, 109, 44, 108, 32, 193, 221, 126, 119, 143, 112, 113, 87, 184, 239, 231, 230, 234, 28, 135, 54, 42, 9, 243, 39, 30, 179, 147, 194, 211, 212, 239, 225, 52, 192, 219, 145, 40, 95, 19, 142, 98])

/**
 * Implementation of HMAC SHA512 from https://github.com/dchest/tweetnacl-auth-js
 * @param {Uint8Array} message
 * @param {Uint8Array} key
 * @returns {Uint8Array}
 */
module.exports.hmac = function (message/* : Uint8Array */, key/* : Uint8Array */) {
  if (!(message instanceof Uint8Array) || !(key instanceof Uint8Array)) {
    throw new Error('Inputs must be Uint8Arrays.')
  }

  const BLOCK_SIZE = 128
  const HASH_SIZE = 64
  const buf = new Uint8Array(BLOCK_SIZE + Math.max(HASH_SIZE, message.length))
  var i, innerHash

  if (key.length > BLOCK_SIZE) {
    key = nacl.hash(key)
  }

  for (i = 0; i < BLOCK_SIZE; i++) buf[i] = 0x36
  for (i = 0; i < key.length; i++) buf[i] ^= key[i]
  buf.set(message, BLOCK_SIZE)
  innerHash = nacl.hash(buf.subarray(0, BLOCK_SIZE + message.length))

  for (i = 0; i < BLOCK_SIZE; i++) buf[i] = 0x5c
  for (i = 0; i < key.length; i++) buf[i] ^= key[i]
  buf.set(innerHash, BLOCK_SIZE)
  return nacl.hash(buf.subarray(0, BLOCK_SIZE + innerHash.length))
}

/**
 * Returns HKDF output according to rfc5869 using sha512
 * @param {Uint8Array} ikm input keying material
 * @param {Array} info context-specific info
 * @param {number} extractLength length of extracted output keying material in
 *   octets
 * @param {Uint8Array=} salt optional salt
 * @returns {Uint8Array}
 */
module.exports.getHKDF = function (ikm/* : Uint8Array */, info/* : Array<number> */,
  extractLen, salt/* : Uint8Array */) {
  const hashLength = 512 / 8
  var i

  if (typeof extractLen !== 'number' || extractLen < 0 ||
    extractLen > hashLength * 255) {
    throw Error('Invalid extract length.')
  }

  // Extract
  if (!(salt instanceof Uint8Array)) {
    salt = new Uint8Array(hashLength)
  }
  var prk = module.exports.hmac(ikm, salt) // Pseudorandom Key

  // Expand
  var n = Math.ceil(extractLen / hashLength)
  var t = new Array(n + 1)
  var okm = [] // Output Keying Material
  t[0] = []

  for (i = 1; i <= n; ++i) {
    let input = t[i - 1].concat(info).concat([i])
    t[i] = Array.from(module.exports.hmac(new Uint8Array(input), prk))
    okm = okm.concat(t[i])
  }
  return new Uint8Array(okm.slice(0, extractLen))
}

/**
 * Generates a random seed.
 * @returns {Uint8Array}
 */
module.exports.getSeed = function () {
  return nacl.randomBytes(SEED_SIZE)
}

/**
 * Derives Ed25519 keypair and secretbox key from a seed.
 * @param {Uint8Array} seed
 * @returns {{publicKey: <Uint8Array>, secretKey: <Uint8Array>,
 *   fingerprint: <string>, secretboxKey: <Uint8Array>}}
 */
module.exports.deriveKeys = function (seed/* : Uint8Array */) {
  if (!(seed instanceof Uint8Array)) {
    throw new Error('Seed must be Uint8Array.')
  }
  // Derive the Ed25519 signing keypair
  const output = module.exports.getHKDF(seed, [0],
    nacl.lowlevel.crypto_sign_SEEDBYTES, HKDF_SALT)
  const result = nacl.sign.keyPair.fromSeed(output)
  // Fingerprint is the 32-byte public key as a hex string
  result.fingerprint = ''
  result.publicKey.forEach((byte) => {
    let char = byte.toString(16)
    if (char.length === 1) {
      char = '0' + char
    }
    result.fingerprint += char
  })
  // Secretbox key is the NaCl symmetric encryption/authentication key
  result.secretboxKey = module.exports.getHKDF(seed, [1],
    nacl.secretbox.keyLength, HKDF_SALT)
  return result
}

/**
 * Signs a message using Ed25519 and returns the signed message.
 * This is only used for authentication by the server.
 * @param {Uint8Array} message
 * @param {Uint8Array} secretKey
 * @returns {Uint8Array}
 */
module.exports.sign = function (message/* : Uint8Array */,
  secretKey/* : Uint8Array */) {
  return nacl.sign(message, secretKey)
}

/**
 * Build a 24-byte nonce for NaCl secretbox. Nonce structure is:
 * device_id || random || timestamp || padding
 * where device_id is 1 byte, random is 4 bytes, and timestamp (ms) is
 * 6 bytes.
 * @param {number} deviceId number between 0 and 255, unique for each device
 * @returns {Uint8Array}
 */
module.exports.getNonce = function (deviceId/* : number */) {
  if (typeof deviceId !== 'number' || deviceId < 0 || deviceId > 255) {
    throw new Error('Invalid device ID')
  }

  const nonce = new Uint8Array(nacl.secretbox.nonceLength)
  const time = (new Date()).getTime()

  if (time > Math.pow(256, 6)) {
    throw new Error('Timestamp is too far in the future.')
  }

  nonce[0] = deviceId
  nonce.set(nacl.randomBytes(4), 1)

  var hexTime = time.toString(16)
  while (hexTime.length < 12) {
    hexTime = '0' + hexTime
  }
  var i = 0
  while (i < 6) {
    nonce[5 + i] = Number('0x' + hexTime[2 * i] + hexTime[2 * i + 1])
    i++
  }

  return nonce
}

/**
 * Encrypts and authenticates a message using Nacl secretbox.
 * @param {Uint8Array} message
 * @param {Uint8Array} secretboxKey
 * @param {number} deviceId number between 0 and 255, unique for each device
 * @returns {{nonce: <Uint8Array>, ciphertext: <Uint8Array>}}
 */
module.exports.encrypt = function (message/* : Uint8Array */,
  secretboxKey/* : Uint8Array */, deviceId/* : number */) {
  const nonce = module.exports.getNonce(deviceId)
  return {
    nonce,
    ciphertext: nacl.secretbox(message, nonce, secretboxKey)
  }
}

/**
 * Decrypts and verifies a message using Nacl secretbox. Returns false if
 * verification fails.
 * @param {Uint8Array} ciphertext
 * @param {Uint8Array} nonce
 * @param {Uint8Array} secretboxKey
 * @returns {Uint8Array|boolean}
 */
module.exports.decrypt = function (ciphertext/* : Uint8Array */,
  nonce/* : Uint8Array */, secretboxKey/* : Uint8Array */) {
  return nacl.secretbox.open(ciphertext, nonce, secretboxKey)
}