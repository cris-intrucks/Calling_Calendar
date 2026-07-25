// lib/businessHours.js
//
// Horario laboral unico para todo el sistema: lunes a viernes, 8am-5pm
// hora Colombia. Colombia no tiene horario de verano, asi que el offset
// UTC-5 es fijo todo el ano -- no hace falta Intl/timezone dinamico.

const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;
const OPEN_MS = 8 * 60 * 60 * 1000;
const CLOSE_MS = 17 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ITERATIONS = 20; // seguridad contra loops infinitos

function toLocalParts(utcMs) {
  const local = new Date(utcMs - BOGOTA_OFFSET_MS);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth(),
    day: local.getUTCDate(),
    weekday: local.getUTCDay(), // 0 Dom ... 6 Sab
    msSinceMidnight:
      local.getUTCHours() * 3600000 +
      local.getUTCMinutes() * 60000 +
      local.getUTCSeconds() * 1000 +
      local.getUTCMilliseconds(),
  };
}

function isBusinessDay(weekday) {
  return weekday >= 1 && weekday <= 5;
}

function isWithinBusinessHours(date) {
  const { weekday, msSinceMidnight } = toLocalParts(date.getTime());
  return isBusinessDay(weekday) && msSinceMidnight >= OPEN_MS && msSinceMidnight < CLOSE_MS;
}

// Siguiente instante de apertura (real, en UTC) a partir de un momento dado.
function nextOpenInstant(utcMs) {
  const { year, month, day, weekday, msSinceMidnight } = toLocalParts(utcMs);

  let targetLocalMidnightUtcMs;
  if (isBusinessDay(weekday) && msSinceMidnight < OPEN_MS) {
    targetLocalMidnightUtcMs = Date.UTC(year, month, day);
  } else {
    let candidate = Date.UTC(year, month, day) + DAY_MS;
    const candidateWeekday = new Date(candidate).getUTCDay();
    if (candidateWeekday === 6) candidate += 2 * DAY_MS; // Sab -> Lun
    else if (candidateWeekday === 0) candidate += 1 * DAY_MS; // Dom -> Lun
    targetLocalMidnightUtcMs = candidate;
  }

  const openLocalMs = targetLocalMidnightUtcMs + OPEN_MS;
  return openLocalMs + BOGOTA_OFFSET_MS;
}

// Calcula el instante en que se cumplen `windowMinutes` de tiempo
// EFECTIVAMENTE laboral desde `receivedAt` -- el conteo se pausa
// exactamente al cierre y continua en la siguiente apertura, incluso
// si la llamada empezo dentro de horario y el margen se extiende
// mas alla del cierre.
function computeBusinessDeadline(receivedAt, windowMinutes) {
  let cursor = receivedAt.getTime();
  let remainingMs = windowMinutes * 60 * 1000;
  let iterations = 0;

  while (remainingMs > 0 && iterations < MAX_ITERATIONS) {
    iterations++;
    const { weekday, msSinceMidnight } = toLocalParts(cursor);

    if (isBusinessDay(weekday) && msSinceMidnight >= OPEN_MS && msSinceMidnight < CLOSE_MS) {
      const msUntilClose = CLOSE_MS - msSinceMidnight;
      if (remainingMs <= msUntilClose) {
        cursor += remainingMs;
        remainingMs = 0;
      } else {
        cursor += msUntilClose;
        remainingMs -= msUntilClose;
      }
    } else {
      cursor = nextOpenInstant(cursor);
    }
  }

  return new Date(cursor);
}

module.exports = { isWithinBusinessHours, computeBusinessDeadline };