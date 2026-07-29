export type SnapshotIdentity = {
  recordedAt: Date;
  messages: number;
};

export type SnapshotDecision =
  | { accepted: true; receiverRestarted: boolean }
  | { accepted: false; reason: "duplicate" | "out_of_order" };

/**
 * readsb's `now` is authoritative. The cumulative message count is retained to
 * identify a receiver restart but never permits an older timestamp through.
 */
export class SnapshotCursor {
  private last: SnapshotIdentity | null = null;

  constructor(initial?: SnapshotIdentity) {
    if (initial) this.last = initial;
  }

  inspect(candidate: SnapshotIdentity): SnapshotDecision {
    const previous = this.last;
    if (previous) {
      const candidateTime = candidate.recordedAt.getTime();
      const previousTime = previous.recordedAt.getTime();
      if (candidateTime < previousTime) {
        return { accepted: false, reason: "out_of_order" };
      }
      if (candidateTime === previousTime) {
        return { accepted: false, reason: "duplicate" };
      }
    }

    const receiverRestarted =
      previous !== null && candidate.messages < previous.messages;
    return { accepted: true, receiverRestarted };
  }

  commit(candidate: SnapshotIdentity): void {
    const decision = this.inspect(candidate);
    if (!decision.accepted) {
      throw new Error(`Cannot commit ${decision.reason} snapshot`);
    }
    this.last = candidate;
  }

  current(): SnapshotIdentity | null {
    return this.last;
  }
}
