import type { JiraPort, Ticket } from "../ports/jira.js";

export interface FakeJiraConfig {
  tickets: Ticket[];
}

/** In-memory Jira adapter returning canned assigned tickets. */
export class FakeJira implements JiraPort {
  constructor(private readonly config: FakeJiraConfig) {}

  async listAssignedTickets(): Promise<Ticket[]> {
    return this.config.tickets;
  }
}
