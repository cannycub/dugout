import type { JiraPort, Ticket } from "../ports/jira.js";

export interface FakeJiraConfig {
  tickets: Ticket[];
}

/** In-memory Jira adapter: canned assigned tickets + recorded write-back calls (#11). */
export class FakeJira implements JiraPort {
  readonly transitions: Array<{ ticketKey: string; transition: string }> = [];
  readonly subtasks: Array<{ parentKey: string; summary: string }> = [];
  readonly comments: Array<{ issueKey: string; body: string }> = [];
  readonly closedSubtasks: Array<{ subtaskKey: string; comment: string }> = [];
  /** When set, every write rejects — for proving the projection never blocks the build. */
  failWrites = false;

  constructor(private readonly config: FakeJiraConfig) {}

  async listAssignedTickets(): Promise<Ticket[]> {
    return this.config.tickets;
  }

  async transitionTicket(ticketKey: string, transition: string): Promise<void> {
    this.refuseIfFailing();
    this.transitions.push({ ticketKey, transition });
  }

  async createSubtask(parentKey: string, summary: string): Promise<{ key: string }> {
    this.refuseIfFailing();
    this.subtasks.push({ parentKey, summary });
    return { key: `${parentKey}-sub-${this.subtasks.length}` };
  }

  async addComment(issueKey: string, body: string): Promise<void> {
    this.refuseIfFailing();
    this.comments.push({ issueKey, body });
  }

  async closeSubtask(subtaskKey: string, comment: string): Promise<void> {
    this.refuseIfFailing();
    this.closedSubtasks.push({ subtaskKey, comment });
  }

  private refuseIfFailing(): void {
    if (this.failWrites) throw new Error("fake jira: writes are failing");
  }
}
