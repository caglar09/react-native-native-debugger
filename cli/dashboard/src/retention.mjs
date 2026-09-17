export const MAX_BUFFER = 5000;

export const RETENTION_FLOORS = Object.freeze({
  fatal: 250,
  error: 1000,
  warn: 750
});

const RETENTION_PRIORITY = Object.freeze({
  fatal: 3,
  error: 2,
  warn: 1
});

function normalizedLevel(event) {
  return event?.level || 'default';
}

export function trimRetainedBuffer(buffer, maxSize = MAX_BUFFER) {
  if (!Array.isArray(buffer) || buffer.length <= maxSize) return buffer;

  const counts = new Map();
  for (const event of buffer) {
    const level = normalizedLevel(event);
    counts.set(level, (counts.get(level) || 0) + 1);
  }

  while (buffer.length > maxSize) {
    let candidateIndex = -1;
    let candidatePriority = Infinity;

    // Scan oldest -> newest. Prefer evicting the oldest record from the
    // lowest-retention class that is currently above its protected floor.
    for (let index = buffer.length - 1; index >= 0; index -= 1) {
      const level = normalizedLevel(buffer[index]);
      const floor = RETENTION_FLOORS[level] || 0;
      const count = counts.get(level) || 0;
      if (count <= floor) continue;

      const priority = RETENTION_PRIORITY[level] || 0;
      if (priority < candidatePriority) {
        candidateIndex = index;
        candidatePriority = priority;
        if (priority === 0) break;
      }
    }

    // Floors sum to less than maxSize, so this is only a defensive fallback.
    if (candidateIndex < 0) candidateIndex = buffer.length - 1;

    const [removed] = buffer.splice(candidateIndex, 1);
    const removedLevel = normalizedLevel(removed);
    counts.set(removedLevel, Math.max(0, (counts.get(removedLevel) || 1) - 1));
  }

  return buffer;
}
