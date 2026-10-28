/** Client timestamps more than 60 s ahead of server time are clamped to server time. */
export function clampClientTime(ts: Date | string, now = new Date()): Date {
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  return d.getTime() > now.getTime() + 60_000 ? now : d;
}
