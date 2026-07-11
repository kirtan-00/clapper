// Best-effort haptics. navigator.vibrate is absent on iOS Safari; guard it.

function canVibrate(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

export function tap(): void {
  if (canVibrate()) navigator.vibrate(12);
}

export function thump(): void {
  if (canVibrate()) navigator.vibrate(28);
}

export function doubleThump(): void {
  if (canVibrate()) navigator.vibrate([20, 40, 40]);
}
