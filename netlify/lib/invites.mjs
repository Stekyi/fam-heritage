import crypto from 'node:crypto';
import { hmacToken } from './db.mjs';

// 16 characters from a 32-letter alphabet (80 bits), shown once and stored only as a keyed hash.
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const INVITE_RE = /^[A-HJ-NP-Z2-9]{16}$/;
export const normCode = (c) => String(c ?? '').trim().toUpperCase().replace(/[\s-]/g, '');
export const inviteHash = (code) => hmacToken(`invite:${normCode(code)}`);
export function newInviteCode() {
  let s = '';
  for (let i = 0; i < 16; i++) s += ALPHA[crypto.randomInt(0, ALPHA.length)];
  return s;
}
export const formatCode = (c) => c.replace(/(.{4})(?=.)/g, '$1-');