export function listboxKeyAction(key, activeIndex, itemCount) {
  const count = Math.max(0, Number(itemCount) || 0);
  const current = count > 0 && Number.isInteger(activeIndex)
    ? Math.min(Math.max(activeIndex, 0), count - 1)
    : 0;
  if (key === 'Escape') return { handled: true, close: true, nextIndex: current };
  if (count === 0) return { handled: false, nextIndex: -1 };
  if (key === 'ArrowDown') return { handled: true, nextIndex: Math.min(current + 1, count - 1) };
  if (key === 'ArrowUp') return { handled: true, nextIndex: Math.max(current - 1, 0) };
  if (key === 'Home') return { handled: true, nextIndex: 0 };
  if (key === 'End') return { handled: true, nextIndex: count - 1 };
  if (key === 'Enter' || key === ' ') return { handled: true, select: true, nextIndex: current };
  return { handled: false, nextIndex: current };
}

export function listboxOpenIndex(selectedIndex, itemCount, key = '') {
  const count = Math.max(0, Number(itemCount) || 0);
  if (count === 0) return -1;
  if (key === 'ArrowDown' || key === 'Home') return 0;
  if (key === 'ArrowUp' || key === 'End') return count - 1;
  return Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < count
    ? selectedIndex
    : 0;
}
