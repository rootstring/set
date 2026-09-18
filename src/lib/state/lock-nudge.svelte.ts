/** The lock in the breadcrumb shakes; this is how it hears about an attempt. */
class LockNudges {
  /** Goes up by one per attempt; whoever shows the shake keys off it. */
  count = $state(0);

  nudge(): void {
    this.count += 1;
  }
}

export const lockNudges = new LockNudges();
