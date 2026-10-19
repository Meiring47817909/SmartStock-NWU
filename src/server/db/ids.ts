import 'server-only'
import { randomInt } from 'node:crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const ID_LENGTH = 20

/** A new 20-character [A-Za-z0-9] key. */
export function newId(): string {
  let id = ''
  for (let i = 0; i < ID_LENGTH; i++) id += ALPHABET[randomInt(ALPHABET.length)]
  return id
}
