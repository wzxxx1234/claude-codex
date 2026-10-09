const ALLOWED_TRANSITIONS = {
  created: new Set(["running", "cancelled"]),
  running: new Set([
    "waiting_user",
    "needs_user",
    "failed",
    "cancelled",
    "interrupted",
    "completed"
  ]),
  waiting_user: new Set(["running", "cancelled"]),
  needs_user: new Set(["running", "cancelled"]),
  interrupted: new Set(["running", "cancelled"]),
  completed: new Set(["cancelled"]),
  failed: new Set(["cancelled"]),
  cancelled: new Set()
};

export class InvalidStateTransitionError extends Error {
  constructor(from, to) {
    super(`Invalid state transition: ${from} -> ${to}`);
    this.name = "InvalidStateTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function transitionSession(session, nextState, patch = {}) {
  const currentState = session?.state;
  const allowed = ALLOWED_TRANSITIONS[currentState];
  if (!allowed || !allowed.has(nextState)) {
    throw new InvalidStateTransitionError(currentState, nextState);
  }

  return {
    ...session,
    ...patch,
    state: nextState,
    updatedAt: new Date().toISOString()
  };
}
