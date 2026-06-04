/**
 * Jira port — read (assigned tickets) and, later, write (transitions, subtasks, comments).
 *
 * Jira is a *projection*, never the source of truth (CONTEXT.md invariant 4): content flows
 * git → canonical and harness → Jira only. Write methods are added as later slices need them.
 */

/** A Jira ticket assigned to the developer. */
export interface Ticket {
  /** Jira issue key, e.g. "DUG-1". */
  key: string;
  title: string;
  /** Freeform description / acceptance criteria, ratified at the approval gate. */
  description: string;
}

export interface JiraPort {
  /** Tickets assigned to the current developer. */
  listAssignedTickets(): Promise<Ticket[]>;
}
