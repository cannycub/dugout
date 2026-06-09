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

  /* Write-back (#11) — a best-effort projection, always under the developer's own identity
   * (the adapter authenticates with their personal API token, ADR-0005). */

  /** Move the ticket through a workflow transition, by transition name. */
  transitionTicket(ticketKey: string, transition: string): Promise<void>;
  /** Create a subtask under the ticket; returns its key. Callers own idempotency (one per spec). */
  createSubtask(parentKey: string, summary: string): Promise<{ key: string }>;
  /** Comment on an issue (ticket or subtask). */
  addComment(issueKey: string, body: string): Promise<void>;
  /** Close a subtask with a completion comment. */
  closeSubtask(subtaskKey: string, comment: string): Promise<void>;
}
