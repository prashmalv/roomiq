import { randomBytes } from 'node:crypto';
// Crockford-ish alphabet: no 0/O/1/I, so a pass code can be read out loud.
const A = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const passCode = (n = 8) =>
  Array.from(randomBytes(n)).map((b) => A[b % A.length]).join('').replace(/(.{4})(?=.)/g, '$1-');
