import { randomUUID, createHmac, timingSafeEqual, hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto';

const encryptedMagic = Buffer.from('CDWS1');

const maxTicketLifetimeSeconds = 120;

export function parseEncryptionKey(value) {
  const encoded = String(value || '').trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error('DINGTALK_ENCRYPTION_KEY_INVALID');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error('DINGTALK_ENCRYPTION_KEY_INVALID');
  return key;
}

export function issuePrincipalTicket(principal, secret, now = Date.now()) {
  const payload = {
    tenantId: principal?.tenantId,
    userId: principal?.userId,
    expiresAt: Math.floor(now / 1000) + 60,
    nonce: randomUUID(),
  };
  validatePrincipal(payload);
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyPrincipalTicket(ticket, secret, now = Date.now()) {
  if (typeof ticket !== 'string' || ticket.length > 4096) throw new Error('PRINCIPAL_TICKET_INVALID');
  const [encoded, signature, extra] = ticket.split('.');
  if (!encoded || !signature || extra) throw new Error('PRINCIPAL_TICKET_INVALID');
  const expected = createHmac('sha256', secret).update(encoded).digest();
  let actual;
  try { actual = Buffer.from(signature, 'base64url'); } catch { throw new Error('PRINCIPAL_TICKET_INVALID'); }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('PRINCIPAL_TICKET_INVALID');
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { throw new Error('PRINCIPAL_TICKET_INVALID'); }
  validatePrincipal(payload);
  const secondsLeft = Number(payload.expiresAt) - Math.floor(now / 1000);
  if (!Number.isInteger(payload.expiresAt) || secondsLeft < 0 || secondsLeft > maxTicketLifetimeSeconds) throw new Error('PRINCIPAL_TICKET_EXPIRED');
  if (typeof payload.nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(payload.nonce)) throw new Error('PRINCIPAL_TICKET_INVALID');
  return { tenantId: payload.tenantId, userId: payload.userId, nonce: payload.nonce, expiresAt: payload.expiresAt };
}

function validatePrincipal(principal) {
  if (typeof principal?.tenantId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(principal.tenantId) ||
      typeof principal?.userId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(principal.userId)) {
    throw new Error('PRINCIPAL_TICKET_INVALID');
  }
}

function profileEncryptionKey(masterKey, ownerKey) {
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.from(ownerKey), Buffer.from('coke-dots-dws-profile-v1'), 32));
}

export function sealProfileBytes(plaintext, ownerKey, masterKey, nonce = randomUUID().replaceAll('-', '').slice(0, 24)) {
  const iv = Buffer.from(nonce, 'hex');
  if (iv.length !== 12) throw new Error('DINGTALK_ENCRYPTION_FAILED');
  const cipher = createCipheriv('aes-256-gcm', profileEncryptionKey(masterKey, ownerKey), iv);
  cipher.setAAD(Buffer.from(ownerKey));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([encryptedMagic, iv, cipher.getAuthTag(), encrypted]);
}

export function openProfileBytes(ciphertext, ownerKey, masterKey) {
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length < encryptedMagic.length + 12 + 16 || !ciphertext.subarray(0, encryptedMagic.length).equals(encryptedMagic)) {
    throw new Error('DINGTALK_PROFILE_CIPHERTEXT_INVALID');
  }
  const iv = ciphertext.subarray(encryptedMagic.length, encryptedMagic.length + 12);
  const tag = ciphertext.subarray(encryptedMagic.length + 12, encryptedMagic.length + 28);
  const decipher = createDecipheriv('aes-256-gcm', profileEncryptionKey(masterKey, ownerKey), iv);
  decipher.setAAD(Buffer.from(ownerKey));
  decipher.setAuthTag(tag);
  try { return Buffer.concat([decipher.update(ciphertext.subarray(encryptedMagic.length + 28)), decipher.final()]); }
  catch { throw new Error('DINGTALK_PROFILE_DECRYPT_FAILED'); }
}
